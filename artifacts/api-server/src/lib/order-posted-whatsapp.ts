import { eq } from "drizzle-orm";
import { isDeliveredStatus, isInTransitStatus } from "./envioecom";
import { toWhatsappMarkup, toWhatsappPhone } from "./order-paid-whatsapp";
import { isCustomerTrackingCode } from "./reportana-payload";
import { isSuperfreteDelivered, isSuperfretePosted } from "./superfrete-status";
import { dispatchWhatsappNotice, whatsappNoticeConfigured } from "./whatsapp-dispatch";
import { whatsappInstanceForSeller } from "./whatsapp-outbound-policy";

export const N8N_POSTED_WEBHOOK_SETTING = "n8n_posted_webhook_url";

async function database() {
  const { db, ordersTable } = await import("@workspace/db");
  return { db, ordersTable };
}

export function parsePostedWhatsappKeys(raw: string | null | undefined): string[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function statusEnteredTransit(previous: string | null | undefined, next: string | null | undefined): boolean {
  const nextStatus = String(next || "").trim();
  const previousStatus = String(previous || "").trim();
  const nextPosted = isInTransitStatus(nextStatus) || (isSuperfretePosted(nextStatus) && !isSuperfreteDelivered(nextStatus));
  if (!nextPosted || isDeliveredStatus(nextStatus)) return false;
  if (isInTransitStatus(previousStatus) || isDeliveredStatus(previousStatus) || isSuperfretePosted(previousStatus)) return false;
  return true;
}

/** Etiqueta pronta e Aguardando coleta não entram. O pacote avisa uma vez. */
export function shouldAnnouncePosted(input: {
  previousStatus?: string | null;
  nextStatus?: string | null;
  packageKey?: string | null;
  alreadySent?: string[];
}): boolean {
  const key = String(input.packageKey || "").trim();
  if (!key) return false;
  if (!statusEnteredTransit(input.previousStatus, input.nextStatus)) return false;
  const sent = new Set((input.alreadySent || []).map((item) => item.trim()));
  return !sent.has(key);
}

export function buildPostedWhatsappMessage(input: {
  clientName?: string | null;
  orderNumber?: number | null;
  orderId?: string | null;
  trackingCode?: string | null;
}): string {
  const firstName = String(input.clientName || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const reference = input.orderNumber != null && Number(input.orderNumber) > 0
    ? String(input.orderNumber)
    : String(input.orderId || "").trim() || "-";
  const code = String(input.trackingCode || "").trim();
  const lines = [
    `🚚 **${firstName}, seu pedido foi postado!**`,
    "",
    `Pedido #${reference}`,
  ];
  if (isCustomerTrackingCode(code)) lines.push(`Código: **${code}**`);
  lines.push("", "Você já pode acompanhar a movimentação do seu pedido. 📲");
  return toWhatsappMarkup(lines.join("\n"));
}

async function webhookUrl(sellerCode?: string | null): Promise<string> {
  const { resolveWhatsappWebhookUrl } = await import("./whatsapp-line");
  return resolveWhatsappWebhookUrl({
    sellerCode,
    env: "N8N_POSTED_WEBHOOK_URL",
    setting: N8N_POSTED_WEBHOOK_SETTING,
    envPoly: "N8N_POSTED_WEBHOOK_URL_POLY",
    settingPoly: "n8n_posted_webhook_url_poly",
  });
}

/** Avisa uma vez por pacote quando ele entra em trânsito. Falha não segura etiqueta nem sync. */
export async function sendPostedWhatsapp(
  orderId: string,
  packageKey: string,
  trackingCode?: string | null,
): Promise<{ sent: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  const key = String(packageKey || "").trim();
  if (!id || !key) return { sent: false, error: "missing_id" };
  try {
    const { db, ordersTable } = await database();
    const rows = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    const order = rows[0];
    if (!order) return { sent: false, error: "not_found" };

    const url = await webhookUrl(order.sellerCode);
    if (!(await whatsappNoticeConfigured("postado", url))) return { sent: false, error: "not_configured" };
    const phone = toWhatsappPhone(order.clientPhone);
    if (!phone) return { sent: false, error: "missing_phone" };

    const already = parsePostedWhatsappKeys(order.postedWhatsappKeys);
    if (already.includes(key)) return { sent: false, error: "already_sent" };

    await db
      .update(ordersTable)
      .set({ postedWhatsappKeys: JSON.stringify([...already, key]) })
      .where(eq(ordersTable.id, id));

    const message = buildPostedWhatsappMessage({
      clientName: order.clientName,
      orderNumber: order.orderNumber,
      orderId: order.id,
      trackingCode,
    });
    const result = await dispatchWhatsappNotice({
      origin: "postado",
      instance: whatsappInstanceForSeller(order.sellerCode),
      phone,
      kind: "text",
      message,
      n8nUrl: url,
      n8nBody: { phone, message },
    });
    if (result.ok) return { sent: true };

    await db
      .update(ordersTable)
      .set({ postedWhatsappKeys: JSON.stringify(already) })
      .where(eq(ordersTable.id, id));
    console.warn("[WhatsApp postado] falha", id, result.error || "request_failed");
    return { sent: false, error: result.error || "request_failed" };
  } catch (err) {
    console.error("[WhatsApp postado] sync", id, err instanceof Error ? err.message : err);
    return { sent: false, error: "exception" };
  }
}

export function queuePostedWhatsapp(orderId: string | null | undefined, packageKey: string, trackingCode?: string | null): void {
  const id = String(orderId || "").trim();
  const key = String(packageKey || "").trim();
  if (!id || !key) return;
  void sendPostedWhatsapp(id, key, trackingCode);
}

export function announcePosted(input: {
  orderId: string | null | undefined;
  packageKey: string | null | undefined;
  previousStatus?: string | null;
  nextStatus?: string | null;
  trackingCode?: string | null;
}): void {
  const key = String(input.packageKey || "").trim() || "order";
  if (!shouldAnnouncePosted({
    previousStatus: input.previousStatus,
    nextStatus: input.nextStatus,
    packageKey: key,
  })) return;
  queuePostedWhatsapp(input.orderId, key, input.trackingCode);
}
