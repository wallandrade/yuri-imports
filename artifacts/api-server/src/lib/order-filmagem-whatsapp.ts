import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { toWhatsappPhone, type PaidWhatsappOrder } from "./order-paid-whatsapp";
import { whatsappInstanceForSeller, type WhatsappZapiInstance } from "./whatsapp-outbound-policy";
import { enqueueWhatsappOutbound, type WhatsappOutboundDraft } from "./whatsapp-outbound-queue";

export const N8N_FILMAGEM_WEBHOOK_SETTING = "n8n_filmagem_webhook_url";
/** A URL continua salva no admin. Estes dois avisos não chamam o n8n. */
export const DEFAULT_N8N_FILMAGEM_WEBHOOK_URL = "https://wallandrade.app.n8n.cloud/webhook/filmagem";

/** Texto 1. Entra na fila 2h depois do pagamento confirmado. */
export const FILMAGEM_PAID_TEXT = [
  "🚨 *ATENÇÃO: LEIA ANTES DE RECEBER SEU PEDIDO* 🚨",
  "",
  "Seu pagamento foi confirmado ✅ Agora é muito importante você saber como abrir sua caixa.",
  "",
  "🎥 *FILME A ABERTURA DO COMEÇO AO FIM, SEM CORTES.*",
  "Vale *com seguro ou sem seguro*. Se a transportadora extraviar, trocar ou violar algo, é só com o seu vídeo que conseguimos provar e resolver.",
  "",
  "📦 *Como filmar:*",
  "1️⃣ Mostre a caixa ainda lacrada, todos os lados",
  "2️⃣ Abra sem pausar e sem cortar",
  "3️⃣ Mostre todo o conteúdo e o nome e lote de cada produto",
  "",
  "🛡️ Quem fez o seguro só consegue acionar com esse vídeo.",
  "",
  "❌ *SEM FILMAGEM, NÃO ADIANTA NOS CHAMAR.* Infelizmente, sem o vídeo não conseguimos fazer nada.",
  "",
  "*YURY IMPORTS 🇵🇾🇧🇷*",
].join("\n");

/** Texto 2. Sai quando a transportadora marca saiu para entrega. Uma vez por pedido. */
export const FILMAGEM_DELIVERY_TEXT = [
  "🚚 *SEU PEDIDO SAIU PARA ENTREGA!*",
  "",
  "⚠️ *Pela segunda vez:* filme a abertura da caixa do começo ao fim, *sem cortes*. Sem o vídeo, você não terá direito a reclamação futura.",
  "",
  "Faça sua parte 🎥📦",
  "",
  "*YURY IMPORTS 🇵🇾🇧🇷*",
].join("\n");

export const FILMAGEM_NOTICE_DELAY_MS = 2 * 60 * 60 * 1000;
export const FILMAGEM_NOTICE_DELAY_SECONDS = 2 * 60 * 60;
/** O GIF fica 1s atrás do texto para a fila pegar o texto primeiro. A trava de 6 min separa o envio. */
export const FILMAGEM_GIF_AFTER_TEXT_MS = 1000;
export const FILMAGEM_QUEUE_ORIGIN = "filmagem";
export const FILMAGEM_DELIVERY_QUEUE_ORIGIN = "filmagem_entrega";
export const FILMAGEM_VIDEO_ENV = "FILMAGEM_ZAPI_VIDEO_URL";
/** Arquivo em `artifacts/ka-imports/public`. A URL pública vem só da env. */
export const FILMAGEM_VIDEO_PUBLIC_PATH = "/filmagem/como-abrir-caixa.mp4";

const SUSPENDED_VIDEO_HOSTS = new Set([
  "yury-imports.com",
  "www.yury-imports.com",
  "api.yury-imports.com",
]);

export type FilmagemPlan =
  | { ok: true; drafts: WhatsappOutboundDraft[] }
  | { ok: false; error: string };

/** 2h depois do instante em que o pagamento foi confirmado. */
export function filmagemNoticeDueAt(paidAt: Date, delayMs = FILMAGEM_NOTICE_DELAY_MS): Date {
  return new Date(paidAt.getTime() + delayMs);
}

/** Pedido que já estava pago não entra. Cobrança de diferença de pedido antigo também não. */
export function filmagemNoticeEligibleOnTransition(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  const next = String(nextStatus || "").trim().toLowerCase();
  if (next !== "paid" && next !== "completed") return false;
  const previous = String(previousStatus || "").trim().toLowerCase();
  return previous !== "paid" && previous !== "completed";
}

export function filmagemQueueId(orderId: string, slot: "paid-text" | "paid-gif" | "delivery-text" | "delivery-gif"): string {
  return crypto.createHash("sha256").update(`yury-filmagem:${slot}:${orderId}`).digest("hex").slice(0, 32);
}

/** URL https do MP4. Sem env, URL inválida ou o domínio suspenso: só o texto. */
export function filmagemVideoUrl(raw = process.env[FILMAGEM_VIDEO_ENV]): string {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 900) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (SUSPENDED_VIDEO_HOSTS.has(url.hostname.toLowerCase())) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function orderFilmagemWhatsappPayload(
  order: Pick<PaidWhatsappOrder, "clientPhone">,
  message = FILMAGEM_PAID_TEXT,
): { phone: string; message: string } | null {
  const phone = toWhatsappPhone(order.clientPhone);
  if (!phone) return null;
  return { phone, message };
}

function textDraft(input: {
  orderId: string;
  slot: "paid-text" | "delivery-text";
  phone: string;
  instance: WhatsappZapiInstance;
  message: string;
  origin: string;
  nextAttemptAt: Date | null;
}): WhatsappOutboundDraft {
  return {
    id: filmagemQueueId(input.orderId, input.slot),
    instance: input.instance,
    phone: input.phone,
    kind: "text",
    message: input.message,
    origin: input.origin,
    nextAttemptAt: input.nextAttemptAt,
  };
}

function gifDraft(input: {
  orderId: string;
  slot: "paid-gif" | "delivery-gif";
  phone: string;
  instance: WhatsappZapiInstance;
  videoUrl: string;
  origin: string;
  nextAttemptAt: Date;
}): WhatsappOutboundDraft | null {
  const videoUrl = filmagemVideoUrl(input.videoUrl);
  if (!videoUrl) return null;
  return {
    id: filmagemQueueId(input.orderId, input.slot),
    instance: input.instance,
    phone: input.phone,
    kind: "gif",
    image: videoUrl,
    origin: input.origin,
    nextAttemptAt: input.nextAttemptAt,
  };
}

/** Texto na hora marcada e, se houver URL, o GIF um segundo depois. */
export function planFilmagemPaidNotice(input: {
  orderId: string;
  status?: string | null;
  phone?: string | null;
  sellerCode?: string | null;
  dueAt?: Date | null;
  alreadySent?: boolean;
  videoUrl?: string | null;
}): FilmagemPlan {
  if (input.alreadySent) return { ok: false, error: "already_sent" };
  const status = String(input.status || "").trim().toLowerCase();
  if (status !== "paid" && status !== "completed") return { ok: false, error: "not_paid" };
  if (!input.dueAt || Number.isNaN(input.dueAt.getTime())) return { ok: false, error: "not_eligible" };
  const phone = toWhatsappPhone(input.phone);
  if (!phone) return { ok: false, error: "missing_phone" };
  const instance = whatsappInstanceForSeller(input.sellerCode);
  const drafts: WhatsappOutboundDraft[] = [
    textDraft({
      orderId: input.orderId,
      slot: "paid-text",
      phone,
      instance,
      message: FILMAGEM_PAID_TEXT,
      origin: FILMAGEM_QUEUE_ORIGIN,
      nextAttemptAt: input.dueAt,
    }),
  ];
  const gif = gifDraft({
    orderId: input.orderId,
    slot: "paid-gif",
    phone,
    instance,
    videoUrl: String(input.videoUrl || ""),
    origin: FILMAGEM_QUEUE_ORIGIN,
    nextAttemptAt: new Date(input.dueAt.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS),
  });
  if (gif) drafts.push(gif);
  return { ok: true, drafts };
}

/** Texto 2 na hora em que a fila puder, e o GIF logo atrás. */
export function planFilmagemDeliveryNotice(input: {
  orderId: string;
  phone?: string | null;
  sellerCode?: string | null;
  now: Date;
  alreadySent?: boolean;
  videoUrl?: string | null;
}): FilmagemPlan {
  if (input.alreadySent) return { ok: false, error: "already_sent" };
  const phone = toWhatsappPhone(input.phone);
  if (!phone) return { ok: false, error: "missing_phone" };
  const instance = whatsappInstanceForSeller(input.sellerCode);
  const drafts: WhatsappOutboundDraft[] = [
    textDraft({
      orderId: input.orderId,
      slot: "delivery-text",
      phone,
      instance,
      message: FILMAGEM_DELIVERY_TEXT,
      origin: FILMAGEM_DELIVERY_QUEUE_ORIGIN,
      nextAttemptAt: null,
    }),
  ];
  const gif = gifDraft({
    orderId: input.orderId,
    slot: "delivery-gif",
    phone,
    instance,
    videoUrl: String(input.videoUrl || ""),
    origin: FILMAGEM_DELIVERY_QUEUE_ORIGIN,
    nextAttemptAt: new Date(input.now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS),
  });
  if (gif) drafts.push(gif);
  return { ok: true, drafts };
}

function schemaMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  return message.includes("filmagem_whatsapp_due_at")
    || message.includes("ER_BAD_FIELD_ERROR")
    || message.includes("Unknown column");
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function stampFilmagemDue(orderId: string): Promise<void> {
  const { pool } = await import("@workspace/db");
  await pool.query(
    `UPDATE orders
     SET filmagem_whatsapp_due_at = CURRENT_TIMESTAMP + INTERVAL ${FILMAGEM_NOTICE_DELAY_SECONDS} SECOND
     WHERE id = ?
       AND filmagem_whatsapp_due_at IS NULL
       AND filmagem_whatsapp_sent_at IS NULL
       AND status IN ('paid', 'completed')`,
    [orderId],
  );
}

async function claimSend(orderId: string, kind: "paid" | "delivery"): Promise<void> {
  const { db, ordersTable } = await import("@workspace/db");
  const stamp = kind === "delivery" ? ordersTable.filmagemDeliveryWhatsappSentAt : ordersTable.filmagemWhatsappSentAt;
  await db
    .update(ordersTable)
    .set(kind === "delivery" ? { filmagemDeliveryWhatsappSentAt: new Date() } : { filmagemWhatsappSentAt: new Date() })
    .where(and(eq(ordersTable.id, orderId), isNull(stamp)));
}

async function enqueueDrafts(drafts: WhatsappOutboundDraft[]): Promise<{ ok: boolean; error?: string }> {
  let textQueued = false;
  for (const draft of drafts) {
    const result = await enqueueWhatsappOutbound(draft);
    if (!result.ok) {
      if (textQueued) {
        console.warn("[WhatsApp filmagem] gif não entrou na fila", draft.origin);
        return { ok: true };
      }
      return { ok: false, error: result.error || "fila_indisponivel" };
    }
    if (draft.kind === "text") textQueued = true;
  }
  return { ok: true };
}

/** Coloca o texto (e o GIF, se a URL existir) na fila. Não grava o prazo. */
export async function enqueueFilmagemPaidNotice(orderId: string): Promise<{ queued: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { queued: false, error: "missing_id" };
  try {
    const { db, ordersTable } = await import("@workspace/db");
    const rows = await db
      .select({
        id: ordersTable.id,
        status: ordersTable.status,
        clientPhone: ordersTable.clientPhone,
        sellerCode: ordersTable.sellerCode,
        filmagemWhatsappDueAt: ordersTable.filmagemWhatsappDueAt,
        filmagemWhatsappSentAt: ordersTable.filmagemWhatsappSentAt,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .limit(1);
    const order = rows[0];
    if (!order) return { queued: false, error: "not_found" };
    const plan = planFilmagemPaidNotice({
      orderId: order.id,
      status: order.status,
      phone: order.clientPhone,
      sellerCode: order.sellerCode,
      dueAt: asDate(order.filmagemWhatsappDueAt),
      alreadySent: order.filmagemWhatsappSentAt != null,
      videoUrl: filmagemVideoUrl(),
    });
    if (!plan.ok) return { queued: false, error: plan.error };
    const queued = await enqueueDrafts(plan.drafts);
    if (!queued.ok) return { queued: false, error: queued.error };
    await claimSend(id, "paid");
    return { queued: true };
  } catch (err) {
    if (schemaMissing(err)) return { queued: false, error: "column_missing" };
    console.warn("[WhatsApp filmagem] fila", id, err instanceof Error ? err.message.slice(0, 160) : "falha");
    return { queued: false, error: "exception" };
  }
}

/**
 * Grava o prazo só no pedido que acabou de ficar pago e coloca o aviso na fila
 * com `next_attempt_at` daqui a 2h. Pedido antigo não tem essa coluna preenchida.
 */
export async function scheduleFilmagemPaidNotice(orderId: string): Promise<{ queued: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { queued: false, error: "missing_id" };
  try {
    await stampFilmagemDue(id);
  } catch (err) {
    if (schemaMissing(err)) return { queued: false, error: "column_missing" };
    console.warn("[WhatsApp filmagem] prazo", id, err instanceof Error ? err.message.slice(0, 160) : "falha");
    return { queued: false, error: "exception" };
  }
  return enqueueFilmagemPaidNotice(id);
}

export function queueOrderFilmagemPaidNotice(orderId: string | null | undefined): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  void scheduleFilmagemPaidNotice(id);
}

/** Rede de segurança: se a fila não recebeu o aviso na hora do pagamento, pega quando o prazo vence. */
export async function enqueueDueFilmagemNotices(): Promise<void> {
  try {
    const { pool } = await import("@workspace/db");
    const [rows] = await pool.query(
      `SELECT id FROM orders
       WHERE filmagem_whatsapp_due_at IS NOT NULL
         AND filmagem_whatsapp_due_at <= CURRENT_TIMESTAMP
         AND filmagem_whatsapp_sent_at IS NULL
         AND status IN ('paid', 'completed')
       ORDER BY filmagem_whatsapp_due_at ASC
       LIMIT 20`,
    );
    if (!Array.isArray(rows)) return;
    for (const row of rows as Array<{ id?: string }>) {
      const id = String(row.id || "").trim();
      if (!id) continue;
      await enqueueFilmagemPaidNotice(id);
    }
  } catch (err) {
    if (schemaMissing(err)) return;
    const message = err instanceof Error ? err.message : String(err || "");
    if (message.includes("orders") && message.includes("ER_NO_SUCH_TABLE")) return;
    console.warn("[WhatsApp filmagem] varredura", message.slice(0, 160));
  }
}

async function sendDelivery(orderId: string): Promise<{ sent: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { sent: false, error: "missing_id" };
  try {
    const { db, ordersTable } = await import("@workspace/db");
    const rows = await db
      .select({
        id: ordersTable.id,
        clientPhone: ordersTable.clientPhone,
        sellerCode: ordersTable.sellerCode,
        filmagemDeliveryWhatsappSentAt: ordersTable.filmagemDeliveryWhatsappSentAt,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .limit(1);
    const order = rows[0];
    if (!order) return { sent: false, error: "not_found" };
    const plan = planFilmagemDeliveryNotice({
      orderId: order.id,
      phone: order.clientPhone,
      sellerCode: order.sellerCode,
      now: new Date(),
      alreadySent: order.filmagemDeliveryWhatsappSentAt != null,
      videoUrl: filmagemVideoUrl(),
    });
    if (!plan.ok) return { sent: false, error: plan.error };
    const queued = await enqueueDrafts(plan.drafts);
    if (!queued.ok) return { sent: false, error: queued.error };
    await claimSend(id, "delivery");
    return { sent: true };
  } catch (err) {
    console.warn("[WhatsApp filmagem] entrega", id, err instanceof Error ? err.message.slice(0, 160) : "falha");
    return { sent: false, error: "exception" };
  }
}

export async function sendOrderFilmagemDeliveryWhatsapp(orderId: string): Promise<{ sent: boolean; error?: string }> {
  return sendDelivery(orderId);
}

export function queueOrderFilmagemDeliveryWhatsapp(orderId: string | null | undefined): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  void sendOrderFilmagemDeliveryWhatsapp(id);
}
