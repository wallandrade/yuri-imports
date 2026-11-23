import { isPolyWhatsappSeller, type WhatsappLine } from "./whatsapp-line";

/** Uma mensagem a cada 6 minutos e no máximo 10 por hora, por instância. Igual à fila do n8n. */
export const WHATSAPP_SEND_GAP_MS = 6 * 60 * 1000;
export const WHATSAPP_HOURLY_CAP = 10;
/** Pedido pago não fica atrás da trava de 6 minutos. */
export const WHATSAPP_PAID_MAX_WAIT_MS = 2 * 60 * 1000;
/** O job olha a fila neste intervalo. A saída do pago antecipa um ciclo para caber nos 2 minutos. */
export const WHATSAPP_TICK_MS = 30 * 1000;
export const WHATSAPP_PAID_ORIGIN = "pedido_pago";
export const WHATSAPP_MAX_ATTEMPTS = 8;
export const WHATSAPP_STALE_SENDING_MS = 15 * 60 * 1000;

export const WHATSAPP_SUPPORT_DELIVERY_SETTING = "zapi_support_delivery";

export const WHATSAPP_CHANNEL_SETTING = {
  pedido_pago: "zapi_channel_order_paid",
  rastreio: "zapi_channel_tracking",
  postado: "zapi_channel_posted",
  saiu: "zapi_channel_out_for_delivery",
  entregue: "zapi_channel_delivered",
  filmagem: "zapi_channel_filmagem",
  corrigir_dados: "zapi_channel_delivery_correction",
  atendimento: "zapi_channel_support",
  atendimento_menu: "zapi_channel_support_menu",
  cell_tech: "zapi_channel_cell_tech",
  shopee_route: "zapi_channel_shopee_route",
} as const;

export const WHATSAPP_CHANNEL_SETTING_KEYS = [
  ...Object.values(WHATSAPP_CHANNEL_SETTING),
  WHATSAPP_SUPPORT_DELIVERY_SETTING,
] as const;

export type WhatsappNoticeOrigin = keyof typeof WHATSAPP_CHANNEL_SETTING;
export type WhatsappChannel = "direto" | "n8n";
export type WhatsappSupportDelivery = "fila" | "na_hora";
/** Cada nome tem a própria trava de 6 minutos e de 10 por hora. Cell Tech não usa main nem poly. */
export const WHATSAPP_ZAPI_INSTANCES = ["main", "poly", "celltech"] as const;
export type WhatsappZapiInstance = (typeof WHATSAPP_ZAPI_INSTANCES)[number];
export type WhatsappOutboundKind = "text" | "image" | "option_list" | "gif";

/** Grupo do fluxo Cell Tech. O campo phone da Z-API recebe esse id. */
export const CELL_TECH_ZAPI_GROUP_ID = "553591710559-1525960254";

export function parseWhatsappChannel(raw: string | null | undefined): WhatsappChannel {
  return String(raw || "").trim().toLowerCase() === "n8n" ? "n8n" : "direto";
}

export function parseSupportDelivery(raw: string | null | undefined): WhatsappSupportDelivery {
  return String(raw || "").trim().toLowerCase() === "na_hora" ? "na_hora" : "fila";
}

export function whatsappChannelSaveError(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "direto" || normalized === "n8n") return null;
  return "Escolha direto ou n8n.";
}

export function whatsappSupportDeliverySaveError(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fila" || normalized === "na_hora") return null;
  return "Escolha fila ou na hora.";
}

export function normalizeWhatsappChannel(value: string): WhatsappChannel {
  return value.trim().toLowerCase() === "n8n" ? "n8n" : "direto";
}

export function normalizeSupportDelivery(value: string): WhatsappSupportDelivery {
  return value.trim().toLowerCase() === "na_hora" ? "na_hora" : "fila";
}

/** Pedido da Poly ou da Bruna sai só pela instância da Poly. Sem cair no número de hoje. */
export function whatsappInstanceForSeller(sellerCode: string | null | undefined): WhatsappZapiInstance {
  return isPolyWhatsappSeller(sellerCode) ? "poly" : "main";
}

/** O menu da Poly continua desligado. A instância dela não responde o cliente. */
export function supportLineCanReply(line: WhatsappLine): boolean {
  return line !== "poly";
}

function cellTechGroupIdShape(value: string): boolean {
  if (value.length < 8 || value.length > 80) return false;
  if (/[/?#\s]/.test(value) || /https?:/i.test(value)) return false;
  return /^[0-9A-Za-z@._-]+$/.test(value);
}

/** Vazio usa o grupo do fluxo. Valor preenchido e inválido não cai no grupo antigo. */
export function cellTechZapiGroupId(raw = process.env.ZAPI_CELL_TECH_GROUP_ID): string {
  const value = String(raw || "").trim();
  if (!value) return CELL_TECH_ZAPI_GROUP_ID;
  if (!cellTechGroupIdShape(value)) throw new Error("ZAPI_CELL_TECH_GROUP_ID inválido.");
  return value;
}

export function whatsappBackoffMs(attempts: number, origin?: string): number {
  const gap = origin === WHATSAPP_PAID_ORIGIN ? WHATSAPP_PAID_MAX_WAIT_MS : WHATSAPP_SEND_GAP_MS;
  const step = Math.min(Math.max(1, Math.floor(attempts) || 1), 5);
  return Math.min(gap * 2 ** (step - 1), 60 * 60 * 1000);
}

/** Pedido pago sai na frente. Aos 90s fura a trava de 6 minutos, para o ciclo de 30s ainda cair dentro de 2 minutos. */
export function whatsappTickChoice(input: {
  sentInLastHour: number;
  gapBlocked: boolean;
  paidAgeMs: number | null;
  hasOther: boolean;
}): "paid" | "other" | "none" {
  if (input.sentInLastHour >= WHATSAPP_HOURLY_CAP) return "none";
  const paidReady = input.paidAgeMs != null;
  const paidJumps = paidReady && input.paidAgeMs! >= WHATSAPP_PAID_MAX_WAIT_MS - WHATSAPP_TICK_MS;
  if (paidJumps) return "paid";
  if (input.gapBlocked) return "none";
  if (paidReady) return "paid";
  if (input.hasOther) return "other";
  return "none";
}

export function whatsappInstanceCanSend(input: {
  sentInLastHour: number;
  sentInLastGap: boolean;
}): { ok: true } | { ok: false; reason: "gap" | "hourly" } {
  if (input.sentInLastHour >= WHATSAPP_HOURLY_CAP) return { ok: false, reason: "hourly" };
  if (input.sentInLastGap) return { ok: false, reason: "gap" };
  return { ok: true };
}

/** Tentativa que falhou também ocupa a trava. Sem isso, a próxima mensagem sai no ciclo de 30s. */
export function whatsappAttemptCountsForPace(row: {
  status: string;
  attempts: number;
  sentAt: number | null;
  updatedAt: number;
}, now: number): { hour: boolean; gap: boolean } {
  const hourAgo = now - 60 * 60 * 1000;
  const gapAgo = now - WHATSAPP_SEND_GAP_MS;
  const sentInHour = row.sentAt != null && row.sentAt >= hourAgo;
  const sentInGap = row.sentAt != null && row.sentAt >= gapAgo;
  const triedInHour = row.attempts > 0 && row.updatedAt >= hourAgo && !sentInHour;
  const triedInGap = row.attempts > 0 && row.updatedAt >= gapAgo;
  const sendingInGap = row.status === "sending" && row.updatedAt >= gapAgo;
  return {
    hour: sentInHour || triedInHour,
    gap: sentInGap || triedInGap || sendingInGap,
  };
}

/** Recusa da Z-API por ritmo. Outra falha não entra na fila. */
export function whatsappRateLimitedError(error: string | undefined): boolean {
  const text = String(error || "").toLowerCase();
  return /\b429\b/.test(text) || text.includes("rate") || text.includes("too many") || text.includes("limite");
}

export function maskWhatsappPhone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  const tail = (digits || String(phone || "")).slice(-4);
  return tail ? `••••${tail}` : "••••";
}
