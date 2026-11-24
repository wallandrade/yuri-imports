import { eq } from "drizzle-orm";
import { chatsForCustomPost } from "./lib/custom-group-reminder";
import { zapiCall, zapiCredentials } from "./lib/zapi-client";
import { pool } from "@workspace/db";
import {
  GROUP_CAMPAIGN_ENABLED_SETTING,
  GROUP_CHATS_SETTING,
  GROUP_PEPTIDE_ENABLED_SETTING,
  GROUP_PEPTIDE_HOUR_SETTING,
  GROUP_PEPTIDE_PRODUCT_IDS_SETTING,
  GROUP_PRODUCT_IDS_SETTING,
  customCaption,
  customGroupSend,
  customPostActive,
  customSlotKey,
  normalizeScheduleMode,
  parseScheduleTimes,
  parseStoredGroupChats,
  groupSlotDue,
  groupImageSendAllowed,
  GROUP_IMAGE_HOURLY_LIMIT,
  RECENT_GROUP_IMAGE_SENDS_SQL,
  parseGroupChats,
  peptideDailyCaption,
  peptideDailyDue,
  peptideGroupProduct,
  peptideSendHours,
  peptideSendPlan,
  parsePeptideLineSelection,
  pickDailyPeptide,
  pickGroupProduct,
  productCaption,
  saoPauloParts,
  type CampaignProduct,
} from "./lib/whatsapp-group-campaign";

const TICK_MS = 60 * 1000;

function sendImage(phone: string, image: string, caption: string): Promise<boolean> {
  return zapiCall({
    instance: "main",
    method: "POST",
    suffix: "/send-image",
    body: { phone, image, caption },
    timeoutMs: 20000,
    accept: "http",
  }).then((result) => result.ok);
}

async function settingValue(key: string): Promise<string> {
  const { db, siteSettingsTable } = await import("@workspace/db");
  const rows = await db.select({ value: siteSettingsTable.value }).from(siteSettingsTable).where(eq(siteSettingsTable.key, key)).limit(1);
  return String(rows[0]?.value || "");
}

async function claim(id: string): Promise<boolean> {
  const [header] = await pool.query("INSERT IGNORE INTO whatsapp_group_send_log (id) VALUES (?)", [id.slice(0, 191)]);
  const affected = header && typeof header === "object" && "affectedRows" in header
    ? Number((header as { affectedRows?: number }).affectedRows || 0)
    : 0;
  return affected > 0;
}

async function release(id: string): Promise<void> {
  await pool.query("DELETE FROM whatsapp_group_send_log WHERE id = ?", [id.slice(0, 191)]);
}

async function catalog(): Promise<CampaignProduct[]> {
  const { db, productsTable } = await import("@workspace/db");
  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      image: productsTable.image,
      isSoldOut: productsTable.isSoldOut,
    })
    .from(productsTable)
    .where(eq(productsTable.isActive, true));
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name || "").trim(),
    image: row.image ? String(row.image) : null,
    soldOut: Boolean(row.isSoldOut),
  }));
}

async function recentImageSends(): Promise<number> {
  try {
    const [rows] = await pool.query(RECENT_GROUP_IMAGE_SENDS_SQL);
    const list = Array.isArray(rows) ? rows as Array<{ total?: number }> : [];
    return Number(list[0]?.total || 0);
  } catch (err) {
    console.warn("[Grupos WhatsApp] limite", err instanceof Error ? err.message : err);
    return GROUP_IMAGE_HOURLY_LIMIT;
  }
}

async function deliverCustom(baseId: string, phone: string, image: string, caption: string, label: string): Promise<void> {
  const request = customGroupSend({ phone, imageUrl: image, caption });
  if ("error" in request) return;
  const text = request.suffix === "/send-text";
  if (!text) {
    const sentInHour = await recentImageSends();
    if (!groupImageSendAllowed(sentInHour)) {
      console.log("[Grupos WhatsApp] adiado pelo limite", label);
      return;
    }
  }
  const claimId = `${text ? "t" : "c"}:${baseId}`.slice(0, 191);
  if (!await claim(claimId)) return;
  const result = await zapiCall({
    instance: "main",
    method: "POST",
    suffix: request.suffix,
    body: request.body,
    timeoutMs: 20000,
    accept: "http",
  });
  if (!result.ok) {
    await release(claimId);
    console.warn("[Grupos WhatsApp] falha", label);
    return;
  }
  console.log("[Grupos WhatsApp] enviado", label);
}

async function deliver(claimId: string, phone: string, image: string, caption: string, label: string): Promise<void> {
  const sentInHour = await recentImageSends();
  if (!groupImageSendAllowed(sentInHour)) {
    console.log("[Grupos WhatsApp] adiado pelo limite", label);
    return;
  }
  if (!await claim(claimId)) return;
  const sent = await sendImage(phone, image, caption);
  if (!sent) {
    await release(claimId);
    console.warn("[Grupos WhatsApp] falha", label);
    return;
  }
  console.log("[Grupos WhatsApp] enviado", label);
}

export async function runWhatsappGroupTick(now = new Date()): Promise<void> {
  if (!zapiCredentials("main")) return;
  const rawChats = await settingValue(GROUP_CHATS_SETTING);
  const chats = parseGroupChats(rawChats);
  const storedChats = parseStoredGroupChats(rawChats);
  const parts = saoPauloParts(now);
  const products = await catalog();
  if ((await settingValue(GROUP_CAMPAIGN_ENABLED_SETTING)) === "1") {
    let allowed: string[] = [];
    try {
      const parsed = JSON.parse(await settingValue(GROUP_PRODUCT_IDS_SETTING)) as unknown;
      if (Array.isArray(parsed)) allowed = parsed.map((id) => String(id));
    } catch {
      allowed = [];
    }
    for (let index = 0; index < chats.length; index += 1) {
      const slot = groupSlotDue(parts.hour, parts.minute, index);
      const chat = chats[index];
      if (slot == null || !chat) continue;
      const product = pickGroupProduct(products, allowed, parts.dayKey, slot);
      if (!product?.image) continue;
      await deliver(
        `p:${parts.dayKey}:${slot}:${chat.phone}`,
        chat.phone,
        product.image,
        productCaption(product.name, product.id),
        chat.name,
      );
    }
  }

  if ((await settingValue(GROUP_PEPTIDE_ENABLED_SETTING)) === "1") {
    const { peptideBriefs } = await import("./lib/peptide-group-daily");
    const selection = parsePeptideLineSelection(await settingValue(GROUP_PEPTIDE_PRODUCT_IDS_SETTING));
    const hours = peptideSendHours(await settingValue(GROUP_PEPTIDE_HOUR_SETTING));
    const slot = hours.indexOf(parts.hour);
    const pick = slot < 0 ? null : pickDailyPeptide(peptideSendPlan(peptideBriefs(), products, selection), parts.dayKey, slot);
    if (pick) {
      for (let index = 0; index < chats.length; index += 1) {
        const chat = chats[index];
        const product = peptideGroupProduct(pick.products, index);
        if (!chat || !product?.image || !peptideDailyDue(parts.hour, parts.minute, index, parts.hour)) continue;
        await deliver(
          `e:${parts.dayKey}:${parts.hour}:${chat.phone}`,
          chat.phone,
          product.image,
          peptideDailyCaption(pick.brief, product.id),
          `${chat.name} peptídeo`,
        );
      }
    }
  }

  const { db, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  const posts = await db.select().from(whatsappGroupCustomPostsTable);
  for (const post of posts) {
    if (!customPostActive(post.active)) continue;
    const targets = chatsForCustomPost(post.targetChats, storedChats, chats);
    for (let index = 0; index < targets.length; index += 1) {
      const chat = targets[index];
      const mode = normalizeScheduleMode(post.scheduleMode);
      let times: string[] = [];
      try {
        times = parseScheduleTimes(JSON.parse(post.scheduleTimes || "null"));
      } catch {
        times = [];
      }
      const slot = !chat ? null : customSlotKey({
        mode,
        scheduledAt: post.scheduledAt,
        times,
        intervalHours: Number(post.intervalHours) || 0,
        durationDays: Number(post.durationDays) || 1,
        active: true,
      }, now, index);
      if (!chat || !slot) continue;
      const caption = customCaption(post.caption || "", post.linkUrl || "", post.imageUrl || "");
      if (!caption) continue;
      const baseId = slot === "once" ? `${post.id}:${chat.phone}` : `${post.id}:${slot}:${chat.phone}`;
      await deliverCustom(baseId, chat.phone, post.imageUrl || "", caption, `${chat.name} avulso`);
    }
  }
}

export function startWhatsappGroupJob(): void {
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    void runWhatsappGroupTick()
      .catch((err: unknown) => {
        console.warn("[Grupos WhatsApp]", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        ticking = false;
      });
  };
  setInterval(tick, TICK_MS);
  console.log("[Grupos WhatsApp] conferência a cada 60s. A campanha nasce desligada.");
}
