import { randomBytes } from "crypto";
import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getR2MissingConfig, isR2Configured, uploadWhatsappGroupImageToR2 } from "../lib/r2";
import { requirePrimaryAdmin } from "./admin-auth";
import {
  DEFAULT_GROUP_CHATS,
  GROUP_CAMPAIGN_ENABLED_SETTING,
  GROUP_CHATS_SETTING,
  GROUP_PEPTIDE_ENABLED_SETTING,
  GROUP_PEPTIDE_HOUR_SETTING,
  GROUP_PEPTIDE_PRODUCT_IDS_SETTING,
  GROUP_PRODUCT_IDS_SETTING,
  customCaptionError,
  dailyScheduledAt,
  customImageError,
  customLink,
  customLinkFieldError,
  customPostActive,
  groupChatsSaveError,
  normalizeScheduleMode,
  parseGroupChats,
  parseScheduleTimes,
  peptideAdminLines,
  peptideDailyCaption,
  peptideSendHours,
  peptideSendPlan,
  parsePeptideLineSelection,
  pickDailyPeptide,
  saoPauloParts,
  scheduleLocal,
  schedulePlanError,
  schedulePlanSignature,
  type SchedulePlan,
} from "../lib/whatsapp-group-campaign";

const router: IRouter = Router();

async function settingValue(key: string): Promise<string> {
  const { db, siteSettingsTable } = await import("@workspace/db");
  const rows = await db.select({ value: siteSettingsTable.value }).from(siteSettingsTable).where(eq(siteSettingsTable.key, key)).limit(1);
  return String(rows[0]?.value || "");
}

async function saveSetting(key: string, value: string): Promise<void> {
  const { db, siteSettingsTable } = await import("@workspace/db");
  const existing = await db.select({ key: siteSettingsTable.key }).from(siteSettingsTable).where(eq(siteSettingsTable.key, key)).limit(1);
  if (existing.length > 0) {
    await db.update(siteSettingsTable).set({ value, updatedAt: new Date() }).where(eq(siteSettingsTable.key, key));
    return;
  }
  await db.insert(siteSettingsTable).values({ key, value, updatedAt: new Date() });
}

router.get("/admin/whatsapp/groups", requirePrimaryAdmin, async (_req, res) => {
  const [enabledRaw, productsRaw, chatsRaw, peptideRaw, hourRaw, peptideProductsRaw] = await Promise.all([
    settingValue(GROUP_CAMPAIGN_ENABLED_SETTING),
    settingValue(GROUP_PRODUCT_IDS_SETTING),
    settingValue(GROUP_CHATS_SETTING),
    settingValue(GROUP_PEPTIDE_ENABLED_SETTING),
    settingValue(GROUP_PEPTIDE_HOUR_SETTING),
    settingValue(GROUP_PEPTIDE_PRODUCT_IDS_SETTING),
  ]);
  let productIds: string[] = [];
  try {
    const parsed = JSON.parse(productsRaw) as unknown;
    if (Array.isArray(parsed)) productIds = parsed.map((id) => String(id));
  } catch {
    productIds = [];
  }
  const { db, productsTable, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  const { peptideBriefs } = await import("../lib/peptide-group-daily");
  const [recentPosts, dailyPosts, catalog] = await Promise.all([
    db.select().from(whatsappGroupCustomPostsTable).orderBy(desc(whatsappGroupCustomPostsTable.createdAt)).limit(30),
    db.select().from(whatsappGroupCustomPostsTable).where(eq(whatsappGroupCustomPostsTable.scheduleMode, "daily")),
    db.select({
      id: productsTable.id,
      name: productsTable.name,
      image: productsTable.image,
      isSoldOut: productsTable.isSoldOut,
      isActive: productsTable.isActive,
    }).from(productsTable),
  ]);
  const seenPosts = new Set<string>();
  const posts = [...dailyPosts, ...recentPosts].filter((post) => {
    if (seenPosts.has(post.id)) return false;
    seenPosts.add(post.id);
    return true;
  });
  const peptideCatalog = catalog.filter((row) => row.isActive !== false).map((row) => ({
    id: String(row.id),
    name: String(row.name || "").trim(),
    image: row.image ? String(row.image) : null,
    soldOut: Boolean(row.isSoldOut),
  }));
  const briefs = peptideBriefs();
  const selection = parsePeptideLineSelection(peptideProductsRaw);
  const plan = peptideSendPlan(briefs, peptideCatalog, selection);
  const hours = peptideSendHours(hourRaw);
  const dayKey = saoPauloParts(new Date()).dayKey;
  const peptideSlots = hours.flatMap((hour, slot) => {
    const pick = pickDailyPeptide(plan, dayKey, slot);
    if (!pick) return [];
    return [{
      hour,
      slug: pick.brief.slug,
      name: pick.brief.name,
      productNames: pick.products.map((product) => product.name),
      preview: peptideDailyCaption(pick.brief, pick.products[0]?.id || ""),
    }];
  });
  res.json({
    enabled: enabledRaw === "1",
    peptideEnabled: peptideRaw === "1",
    peptideHours: hours,
    peptideLines: peptideAdminLines(briefs, peptideCatalog, selection),
    peptideSlots,
    productIds,
    groups: chatsRaw ? parseGroupChats(chatsRaw) : DEFAULT_GROUP_CHATS,
    posts: posts.map((post) => ({
      id: post.id,
      imageUrl: post.imageUrl,
      caption: post.caption || "",
      linkUrl: post.linkUrl,
      scheduledAt: post.scheduledAt,
      scheduleMode: normalizeScheduleMode(post.scheduleMode),
      times: parseScheduleTimes(safeJson(post.scheduleTimes)),
      intervalHours: Number(post.intervalHours) || 0,
      durationDays: Number(post.durationDays) || 1,
      active: customPostActive(post.active),
    })),
  });
});

router.put("/admin/whatsapp/groups", requirePrimaryAdmin, async (req, res) => {
  const savedGroups = groupChatsSaveError(req.body?.groups);
  if ("error" in savedGroups) {
    res.status(400).json({ error: savedGroups.error });
    return;
  }
  const productIds = Array.isArray(req.body?.productIds)
    ? req.body.productIds.map((id: unknown) => String(id).trim()).filter(Boolean).slice(0, 200)
    : [];
  await saveSetting(GROUP_CAMPAIGN_ENABLED_SETTING, req.body?.enabled === true ? "1" : "0");
  await saveSetting(GROUP_PRODUCT_IDS_SETTING, JSON.stringify(productIds));
  await saveSetting(GROUP_CHATS_SETTING, JSON.stringify(savedGroups.chats));
  if (typeof req.body?.peptideEnabled === "boolean") {
    await saveSetting(GROUP_PEPTIDE_ENABLED_SETTING, req.body.peptideEnabled === true ? "1" : "0");
    await saveSetting(GROUP_PEPTIDE_HOUR_SETTING, JSON.stringify(peptideSendHours(
      JSON.stringify(Array.isArray(req.body?.peptideHours) ? req.body.peptideHours : req.body?.peptideHour),
    )));
    if (req.body?.peptideProductMap && typeof req.body.peptideProductMap === "object" && !Array.isArray(req.body.peptideProductMap)) {
      const bySlug: Record<string, string[]> = {};
      for (const [slug, ids] of Object.entries(req.body.peptideProductMap as Record<string, unknown>)) {
        if (!/^[a-z0-9-]{1,80}$/.test(slug) || !Array.isArray(ids)) continue;
        const clean = ids.map((id) => String(id).trim()).filter(Boolean).slice(0, 30);
        if (clean.length > 0) bySlug[slug] = clean;
      }
      await saveSetting(GROUP_PEPTIDE_PRODUCT_IDS_SETTING, JSON.stringify(bySlug));
    } else if (Array.isArray(req.body?.peptideProductIds)) {
      const peptideProductIds = req.body.peptideProductIds
        .map((id: unknown) => String(id).trim())
        .filter(Boolean)
        .slice(0, 200);
      await saveSetting(GROUP_PEPTIDE_PRODUCT_IDS_SETTING, JSON.stringify(peptideProductIds));
    }
  }
  res.json({ ok: true });
});

router.post("/admin/whatsapp/groups/upload-image", requirePrimaryAdmin, async (req, res) => {
  const imageData = String(req.body?.imageData || "");
  if (!imageData.startsWith("data:image/")) {
    res.status(400).json({ error: "Envie uma imagem JPG, PNG, WebP ou GIF." });
    return;
  }
  if (!isR2Configured()) {
    res.status(503).json({ error: "O armazenamento de imagens não está configurado.", missing: getR2MissingConfig() });
    return;
  }
  try {
    const imageUrl = await uploadWhatsappGroupImageToR2({ dataUrl: imageData });
    res.status(201).json({ imageUrl });
  } catch (err) {
    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    if (code === "INVALID_IMAGE_DATA_URL" || code === "UNSUPPORTED_IMAGE_TYPE" || code === "EMPTY_IMAGE") {
      res.status(400).json({ error: "Imagem inválida para upload." });
      return;
    }
    console.error("[WhatsApp grupos] upload:", code);
    res.status(500).json({ error: "Não consegui salvar a imagem." });
  }
});

function safeJson(raw: string | null | undefined): unknown {
  try {
    return JSON.parse(String(raw || "null"));
  } catch {
    return null;
  }
}

function readCustomPost(
  body: {
    imageUrl?: unknown;
    caption?: unknown;
    linkUrl?: unknown;
    scheduledAt?: unknown;
    scheduleDate?: unknown;
    scheduleMode?: unknown;
    times?: unknown;
    intervalHours?: unknown;
    durationDays?: unknown;
    active?: unknown;
  },
  previous: SchedulePlan | null = null,
):
  | { imageUrl: string; caption: string; linkUrl: string; scheduledAt: string; scheduleMode: string; scheduleTimes: string | null; intervalHours: number | null; durationDays: number | null; active: boolean }
  | { error: string } {
  const imageUrl = String(body.imageUrl || "").trim();
  const caption = String(body.caption || "").trim().slice(0, 1000);
  const linkUrl = customLink(caption, String(body.linkUrl || ""), imageUrl) || "";
  const mode = normalizeScheduleMode(body.scheduleMode);
  const times = parseScheduleTimes(body.times);
  const intervalHours = Math.min(12, Math.max(0, Math.round(Number(body.intervalHours) || 0)));
  const durationDays = Math.min(30, Math.max(1, Math.round(Number(body.durationDays) || 1)));
  const typedAt = scheduleLocal(String(body.scheduledAt || ""));
  const today = saoPauloParts(new Date()).dayKey;
  const date = String(body.scheduleDate || typedAt || previous?.scheduledAt || "").slice(0, 10);
  const previousDay = previous?.mode === "daily" ? previous.scheduledAt.slice(0, 10) : "";
  const dailyStart = /^\d{4}-\d{2}-\d{2}$/.test(previousDay) ? previousDay : today;
  const scheduledAt = mode === "times"
    ? scheduleLocal(`${date}T${times[0] || "00:00"}`)
    : mode === "daily"
      ? dailyScheduledAt({
        time: times[0] || "",
        startDay: dailyStart,
        previousAt: previous?.mode === "daily" ? previous.scheduledAt : "",
        previousTime: previous?.mode === "daily" ? (previous.times[0] || "") : "",
      })
      : typedAt || (previous?.scheduledAt || "");
  const plan: SchedulePlan = {
    mode,
    scheduledAt,
    times: mode === "daily" ? times.slice(0, 1) : times,
    intervalHours: mode === "interval" ? intervalHours : 0,
    durationDays: mode === "once" || mode === "daily" ? 1 : durationDays,
  };
  const imageError = customImageError(imageUrl);
  const captionError = customCaptionError(caption);
  const linkError = customLinkFieldError(linkUrl);
  if (imageError || captionError || linkError) return { error: imageError || captionError || linkError || "Confira o aviso." };
  const keepPast = Boolean(previous) && schedulePlanSignature(plan) === schedulePlanSignature(previous as SchedulePlan);
  const timeError = schedulePlanError(plan, new Date(), keepPast);
  if (timeError) return { error: timeError };
  return {
    imageUrl,
    caption,
    linkUrl,
    scheduledAt,
    scheduleMode: mode,
    scheduleTimes: mode === "times" || mode === "daily" ? JSON.stringify(plan.times) : null,
    intervalHours: mode === "interval" ? intervalHours : null,
    durationDays: mode === "once" || mode === "daily" ? null : durationDays,
    active: customPostActive(body.active),
  };
}

router.post("/admin/whatsapp/groups/custom", requirePrimaryAdmin, async (req, res) => {
  const parsed = readCustomPost(req.body || {});
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { db, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  const id = randomBytes(12).toString("hex");
  await db.insert(whatsappGroupCustomPostsTable).values({ id, ...parsed });
  res.json({ ok: true, id });
});

router.put("/admin/whatsapp/groups/custom/:id", requirePrimaryAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  const { db, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  const existing = await db.select({
    id: whatsappGroupCustomPostsTable.id,
    scheduledAt: whatsappGroupCustomPostsTable.scheduledAt,
    scheduleMode: whatsappGroupCustomPostsTable.scheduleMode,
    scheduleTimes: whatsappGroupCustomPostsTable.scheduleTimes,
    intervalHours: whatsappGroupCustomPostsTable.intervalHours,
    durationDays: whatsappGroupCustomPostsTable.durationDays,
  }).from(whatsappGroupCustomPostsTable).where(eq(whatsappGroupCustomPostsTable.id, id)).limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Aviso não encontrado." });
    return;
  }
  const previousMode = normalizeScheduleMode(existing[0].scheduleMode);
  const parsed = readCustomPost(req.body || {}, {
    mode: previousMode,
    scheduledAt: existing[0].scheduledAt,
    times: parseScheduleTimes(safeJson(existing[0].scheduleTimes)),
    intervalHours: Number(existing[0].intervalHours) || 0,
    durationDays: Number(existing[0].durationDays) || 1,
  });
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  await db.update(whatsappGroupCustomPostsTable).set(parsed).where(eq(whatsappGroupCustomPostsTable.id, id));
  res.json({ ok: true });
});

router.put("/admin/whatsapp/groups/custom/:id/active", requirePrimaryAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  const active = req.body?.active === true;
  const { db, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  const existing = await db.select({ id: whatsappGroupCustomPostsTable.id })
    .from(whatsappGroupCustomPostsTable)
    .where(eq(whatsappGroupCustomPostsTable.id, id))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Aviso não encontrado." });
    return;
  }
  await db.update(whatsappGroupCustomPostsTable).set({ active }).where(eq(whatsappGroupCustomPostsTable.id, id));
  res.json({ ok: true, active });
});

router.delete("/admin/whatsapp/groups/custom/:id", requirePrimaryAdmin, async (req, res) => {
  const { db, whatsappGroupCustomPostsTable } = await import("@workspace/db");
  await db.delete(whatsappGroupCustomPostsTable).where(eq(whatsappGroupCustomPostsTable.id, String(req.params.id || "")));
  res.json({ ok: true });
});

export default router;
