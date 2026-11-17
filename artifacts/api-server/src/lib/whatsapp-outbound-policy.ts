import { isPolyWhatsappSeller, type WhatsappLine } from "./whatsapp-line";

/** Uma mensagem a cada 6 minutos e no máximo 10 por hora, por instância. Igual à fila do n8n. */
export const WHATSAPP_SEND_GAP_MS = 6 * 60 * 1000;
export const WHATSAPP_HOURLY_CAP = 10;
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
} as const;

export const WHATSAPP_CHANNEL_SETTING_KEYS = [
  ...Object.values(WHATSAPP_CHANNEL_SETTING),
  WHATSAPP_SUPPORT_DELIVERY_SETTING,
] as const;

export type WhatsappNoticeOrigin = keyof typeof WHATSAPP_CHANNEL_SETTING;
export type WhatsappChannel = "direto" | "n8n";
export type WhatsappSupportDelivery = "fila" | "na_hora";
export type WhatsappZapiInstance = "main" | "poly";
export type WhatsappOutboundKind = "text" | "image" | "option_list";

/** Foto fixa do nó Filmagem. A legenda continua a que a loja monta. */
export const FILMAGEM_ZAPI_IMAGE_URL = "https://pub-f5d30eebc4f5447c8dbace71b8e690f3.r2.dev/admin-images/1792175200919-75b3fa2b745d.jpg";

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

export function cellTechZapiGroupId(raw = process.env.ZAPI_CELL_TECH_GROUP_ID): string {
  const value = String(raw || "").trim();
  if (/^\d{6,20}-\d{6,20}$/.test(value)) return value;
  return CELL_TECH_ZAPI_GROUP_ID;
}

export function whatsappBackoffMs(attempts: number): number {
  const step = Math.min(Math.max(1, Math.floor(attempts) || 1), 5);
  return Math.min(WHATSAPP_SEND_GAP_MS * 2 ** (step - 1), 60 * 60 * 1000);
}

export function whatsappInstanceCanSend(input: {
  sentInLastHour: number;
  sentInLastGap: boolean;
}): { ok: true } | { ok: false; reason: "gap" | "hourly" } {
  if (input.sentInLastHour >= WHATSAPP_HOURLY_CAP) return { ok: false, reason: "hourly" };
  if (input.sentInLastGap) return { ok: false, reason: "gap" };
  return { ok: true };
}

export function maskWhatsappPhone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  const tail = (digits || String(phone || "")).slice(-4);
  return tail ? `••••${tail}` : "••••";
}
