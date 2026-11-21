import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { mysqlAffectedRows } from "./mysql-affected-rows";
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

export function filmagemOrderRef(orderId: string): { filmagemOrderId: string } {
  return { filmagemOrderId: orderId };
}

export function filmagemOrderIdFromOptionList(raw: unknown): string {
  let value = raw;
  if (typeof value === "string" && value.trim()) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return "";
    }
  }
  if (!value || typeof value !== "object") return "";
  return String((value as { filmagemOrderId?: unknown }).filmagemOrderId || "").trim();
}

/** Cancelado ou desfeito no meio das 2h não recebe "pagamento confirmado". */
export function filmagemOutboundStillAllowed(status: string | null | undefined): boolean {
  const value = String(status || "").trim().toLowerCase();
  return value === "paid" || value === "completed";
}

export function filmagemSiblingQueueIds(orderId: string, origin: string): string[] {
  if (origin === FILMAGEM_QUEUE_ORIGIN) {
    return [filmagemQueueId(orderId, "paid-text"), filmagemQueueId(orderId, "paid-gif")];
  }
  if (origin === FILMAGEM_DELIVERY_QUEUE_ORIGIN) {
    return [filmagemQueueId(orderId, "delivery-text"), filmagemQueueId(orderId, "delivery-gif")];
  }
  return [];
}

function textDraft(input: {
  orderId: string;
  slot: "paid-text" | "delivery-text";
  phone: string;
  instance: WhatsappZapiInstance;
  message: string;
  origin: string;
  nextAttemptAt: Date | null;
  createdAt?: Date | null;
}): WhatsappOutboundDraft {
  return {
    id: filmagemQueueId(input.orderId, input.slot),
    instance: input.instance,
    phone: input.phone,
    kind: "text",
    message: input.message,
    origin: input.origin,
    optionList: filmagemOrderRef(input.orderId),
    nextAttemptAt: input.nextAttemptAt,
    createdAt: input.createdAt,
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
  createdAt?: Date | null;
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
    optionList: filmagemOrderRef(input.orderId),
    nextAttemptAt: input.nextAttemptAt,
    createdAt: input.createdAt,
  };
}

/** Tira texto e GIF pendentes da fila. Não mexe em linha já enviada. */
export function filmagemCancelQueueSql(ids: string[]): { sql: string; params: string[] } {
  const marks = ids.map(() => "?").join(", ");
  return {
    sql: `UPDATE whatsapp_outbound_queue
     SET status = 'failed', attempts = 0, last_error = 'pedido_nao_pago',
         next_attempt_at = NULL, sent_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id IN (${marks}) AND status IN ('pending', 'sending')`,
    params: ids,
  };
}

export type FilmagemDropIo = {
  loadStatus(orderId: string): Promise<string | null>;
  failPending(ids: string[]): Promise<void>;
};

/** Número visível do pedido. Nunca o telefone. */
export function filmagemLogRef(order: { orderNumber?: number | null; id?: string | null } | null, fallback = ""): string {
  const number = Number(order?.orderNumber);
  if (Number.isFinite(number) && number > 0) return `#${number}`;
  return String(order?.id || fallback || "").trim() || "-";
}

/** Tira sequências longas de dígito (telefone) e tokens. Sobram no máximo os 4 finais. */
export function redactFilmagemLog(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text
    .replace(/\d{8,}/g, (digits) => `****${digits.slice(-4)}`)
    .replace(/(token|client-token|authorization|whsec)[=:]\s*\S+/gi, "$1=***")
    .slice(0, 160);
}

export type FilmagemLogger = {
  warn(code: string, ref: string, detail?: string): void;
  info(origin: string, ref: string): void;
};

function defaultFilmagemLogger(): FilmagemLogger {
  return {
    warn(code, ref, detail = "") {
      const extra = redactFilmagemLog(detail);
      if (extra) console.warn("[WhatsApp filmagem]", code, ref, extra);
      else console.warn("[WhatsApp filmagem]", code, ref);
    },
    info(origin, ref) {
      console.log("[WhatsApp filmagem] na fila", origin, ref);
    },
  };
}

function warnFilmagem(log: FilmagemLogger, code: string, ref: string, detail = ""): void {
  log.warn(code, ref, redactFilmagemLog(detail));
}

function defaultFilmagemDropIo(): FilmagemDropIo {
  return {
    async loadStatus(orderId) {
      const { db, ordersTable } = await import("@workspace/db");
      const rows = await db
        .select({ status: ordersTable.status })
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .limit(1);
      return rows[0]?.status ?? null;
    },
    async failPending(ids) {
      if (ids.length === 0) return;
      const { pool } = await import("@workspace/db");
      const statement = filmagemCancelQueueSql(ids);
      await pool.query(statement.sql, statement.params);
    },
  };
}

/** Tira texto e GIF da fila se o pedido saiu de pago. Sem id, a fila segue. */
export async function dropFilmagemIfOrderLeftPaid(input: {
  origin: string;
  optionList: unknown;
}, io?: FilmagemDropIo): Promise<boolean> {
  if (input.origin !== FILMAGEM_QUEUE_ORIGIN && input.origin !== FILMAGEM_DELIVERY_QUEUE_ORIGIN) return false;
  const orderId = filmagemOrderIdFromOptionList(input.optionList);
  if (!orderId) return false;
  const port = io ?? defaultFilmagemDropIo();
  const status = await port.loadStatus(orderId);
  if (filmagemOutboundStillAllowed(status)) return false;
  const ids = filmagemSiblingQueueIds(orderId, input.origin);
  if (ids.length === 0) return true;
  await port.failPending(ids);
  return true;
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

/** Texto 2 um segundo depois do aviso da main, e o GIF mais um segundo atrás. */
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
  const textAt = new Date(input.now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS);
  const gifAt = new Date(input.now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS * 2);
  const drafts: WhatsappOutboundDraft[] = [
    textDraft({
      orderId: input.orderId,
      slot: "delivery-text",
      phone,
      instance,
      message: FILMAGEM_DELIVERY_TEXT,
      origin: FILMAGEM_DELIVERY_QUEUE_ORIGIN,
      nextAttemptAt: textAt,
      createdAt: textAt,
    }),
  ];
  const gif = gifDraft({
    orderId: input.orderId,
    slot: "delivery-gif",
    phone,
    instance,
    videoUrl: String(input.videoUrl || ""),
    origin: FILMAGEM_DELIVERY_QUEUE_ORIGIN,
    nextAttemptAt: gifAt,
    createdAt: gifAt,
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

export type FilmagemOrderSnapshot = {
  id: string;
  orderNumber: number | null;
  status: string | null;
  clientPhone: string | null;
  sellerCode: string | null;
  filmagemWhatsappDueAt: Date | null;
  filmagemWhatsappSentAt: Date | null;
};

export type FilmagemPaidIo = {
  stampDue(orderId: string): Promise<number>;
  load(orderId: string): Promise<FilmagemOrderSnapshot | null>;
  claimPaid(orderId: string): Promise<void>;
  enqueue(draft: WhatsappOutboundDraft): Promise<{ ok: boolean; error?: string; duplicate?: boolean }>;
  videoUrl(): string;
  log?: FilmagemLogger;
};

async function stampFilmagemDue(orderId: string): Promise<number> {
  const { pool } = await import("@workspace/db");
  const result = await pool.query(
    `UPDATE orders
     SET filmagem_whatsapp_due_at = CURRENT_TIMESTAMP + INTERVAL ${FILMAGEM_NOTICE_DELAY_SECONDS} SECOND
     WHERE id = ?
       AND filmagem_whatsapp_due_at IS NULL
       AND filmagem_whatsapp_sent_at IS NULL
       AND status IN ('paid', 'completed')`,
    [orderId],
  );
  return mysqlAffectedRows(result);
}

async function loadFilmagemOrder(orderId: string): Promise<FilmagemOrderSnapshot | null> {
  const { db, ordersTable } = await import("@workspace/db");
  const rows = await db
    .select({
      id: ordersTable.id,
      orderNumber: ordersTable.orderNumber,
      status: ordersTable.status,
      clientPhone: ordersTable.clientPhone,
      sellerCode: ordersTable.sellerCode,
      filmagemWhatsappDueAt: ordersTable.filmagemWhatsappDueAt,
      filmagemWhatsappSentAt: ordersTable.filmagemWhatsappSentAt,
    })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .limit(1);
  const order = rows[0];
  if (!order) return null;
  return {
    id: order.id,
    orderNumber: order.orderNumber ?? null,
    status: order.status,
    clientPhone: order.clientPhone,
    sellerCode: order.sellerCode,
    filmagemWhatsappDueAt: asDate(order.filmagemWhatsappDueAt),
    filmagemWhatsappSentAt: asDate(order.filmagemWhatsappSentAt),
  };
}

function defaultFilmagemPaidIo(): FilmagemPaidIo {
  return {
    stampDue: stampFilmagemDue,
    load: loadFilmagemOrder,
    claimPaid: (orderId) => claimSend(orderId, "paid"),
    enqueue: enqueueWhatsappOutbound,
    videoUrl: () => filmagemVideoUrl(),
  };
}

async function claimSend(orderId: string, kind: "paid" | "delivery"): Promise<void> {
  const { db, ordersTable } = await import("@workspace/db");
  const stamp = kind === "delivery" ? ordersTable.filmagemDeliveryWhatsappSentAt : ordersTable.filmagemWhatsappSentAt;
  await db
    .update(ordersTable)
    .set(kind === "delivery" ? { filmagemDeliveryWhatsappSentAt: new Date() } : { filmagemWhatsappSentAt: new Date() })
    .where(and(eq(ordersTable.id, orderId), isNull(stamp)));
}

async function enqueueDrafts(
  drafts: WhatsappOutboundDraft[],
  ref: string,
  enqueue: FilmagemPaidIo["enqueue"],
  log: FilmagemLogger,
): Promise<{ ok: boolean; error?: string }> {
  let textQueued = false;
  for (const draft of drafts) {
    const result = await enqueue(draft);
    if (!result.ok) {
      warnFilmagem(log, "erro de insert", ref, `${draft.origin} ${result.error || "fila_indisponivel"}`);
      if (textQueued) return { ok: true };
      return { ok: false, error: result.error || "fila_indisponivel" };
    }
    if (draft.kind === "text") textQueued = true;
  }
  return { ok: true };
}

/** Coloca o texto (e o GIF, se a URL existir) na fila. Não grava o prazo. */
export async function enqueueFilmagemPaidNotice(orderId: string, io?: FilmagemPaidIo): Promise<{ queued: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { queued: false, error: "missing_id" };
  const port = io ?? defaultFilmagemPaidIo();
  const log = port.log ?? defaultFilmagemLogger();
  try {
    const order = await port.load(id);
    if (!order) {
      warnFilmagem(log, "not_eligible", id);
      return { queued: false, error: "not_found" };
    }
    const ref = filmagemLogRef(order, id);
    const plan = planFilmagemPaidNotice({
      orderId: order.id,
      status: order.status,
      phone: order.clientPhone,
      sellerCode: order.sellerCode,
      dueAt: order.filmagemWhatsappDueAt,
      alreadySent: order.filmagemWhatsappSentAt != null,
      videoUrl: port.videoUrl(),
    });
    if (!plan.ok) {
      if (plan.error === "not_eligible" || plan.error === "not_paid") warnFilmagem(log, "not_eligible", ref);
      else if (plan.error === "missing_phone") warnFilmagem(log, "missing_phone", ref);
      return { queued: false, error: plan.error };
    }
    const queued = await enqueueDrafts(plan.drafts, ref, port.enqueue, log);
    if (!queued.ok) return { queued: false, error: queued.error };
    await port.claimPaid(id);
    log.info(plan.drafts[0]?.origin || FILMAGEM_QUEUE_ORIGIN, ref);
    return { queued: true };
  } catch (err) {
    if (schemaMissing(err)) {
      warnFilmagem(log, "column_missing", id);
      return { queued: false, error: "column_missing" };
    }
    warnFilmagem(log, "fila", id, redactFilmagemLog(err));
    return { queued: false, error: "exception" };
  }
}

/**
 * Grava o prazo só no pedido que acabou de ficar pago e coloca o aviso na fila
 * com `next_attempt_at` daqui a 2h. Quem chama precisa já ter gravado o status.
 * Pedido antigo, sem esta chamada, continua com a coluna nula.
 */
export async function scheduleFilmagemPaidNotice(orderId: string, io?: FilmagemPaidIo): Promise<{ queued: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { queued: false, error: "missing_id" };
  const port = io ?? defaultFilmagemPaidIo();
  const log = port.log ?? defaultFilmagemLogger();
  try {
    try {
      await port.stampDue(id);
    } catch (err) {
      if (schemaMissing(err)) {
        warnFilmagem(log, "column_missing", id);
        return { queued: false, error: "column_missing" };
      }
      throw err;
    }
    let order = await port.load(id);
    if (!order) {
      warnFilmagem(log, "not_eligible", id, "stamp 0 linhas");
      return { queued: false, error: "not_found" };
    }
    const ref = filmagemLogRef(order, id);
    if (!filmagemOutboundStillAllowed(order.status)) {
      warnFilmagem(log, "not_eligible", ref, "stamp 0 linhas");
      return { queued: false, error: "not_eligible" };
    }
    if (!order.filmagemWhatsappDueAt && !order.filmagemWhatsappSentAt) {
      await port.stampDue(id);
      order = await port.load(id);
    }
    if (!order || !filmagemOutboundStillAllowed(order.status)) {
      warnFilmagem(log, "not_eligible", ref, "stamp 0 linhas");
      return { queued: false, error: "not_eligible" };
    }
    if (order.filmagemWhatsappSentAt && !order.filmagemWhatsappDueAt) {
      warnFilmagem(log, "not_eligible", ref, "already_sent");
      return { queued: false, error: "already_sent" };
    }
    if (!order.filmagemWhatsappDueAt) {
      warnFilmagem(log, "stamp 0 linhas", ref);
      return { queued: false, error: "stamp_zero" };
    }
    return enqueueFilmagemPaidNotice(id, port);
  } catch (err) {
    if (schemaMissing(err)) {
      warnFilmagem(log, "column_missing", id);
      return { queued: false, error: "column_missing" };
    }
    warnFilmagem(log, "prazo", id, redactFilmagemLog(err));
    return { queued: false, error: "exception" };
  }
}

export function queueOrderFilmagemPaidNotice(orderId: string | null | undefined): Promise<{ queued: boolean; error?: string }> {
  return scheduleFilmagemPaidNotice(String(orderId || ""));
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
    if (schemaMissing(err)) {
      warnFilmagem(defaultFilmagemLogger(), "column_missing", "varredura");
      return;
    }
    const message = err instanceof Error ? err.message : String(err || "");
    if (message.includes("orders") && message.includes("ER_NO_SUCH_TABLE")) return;
    console.warn("[WhatsApp filmagem] varredura", redactFilmagemLog(message));
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
    const queued = await enqueueDrafts(plan.drafts, order.id, enqueueWhatsappOutbound, defaultFilmagemLogger());
    if (!queued.ok) return { sent: false, error: queued.error };
    await claimSend(id, "delivery");
    return { sent: true };
  } catch (err) {
    console.warn("[WhatsApp filmagem] entrega", id, redactFilmagemLog(err));
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
