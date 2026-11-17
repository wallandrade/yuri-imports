import {
  WHATSAPP_CHANNEL_SETTING,
  WHATSAPP_SUPPORT_DELIVERY_SETTING,
  parseSupportDelivery,
  parseWhatsappChannel,
  type WhatsappChannel,
  type WhatsappNoticeOrigin,
  type WhatsappOutboundKind,
  type WhatsappZapiInstance,
} from "./whatsapp-outbound-policy";
import type { WhatsappOutboundDraft } from "./whatsapp-outbound-queue";

type DispatchDeps = {
  readSetting: (key: string) => Promise<string>;
  enqueue: (draft: WhatsappOutboundDraft) => Promise<{ ok: boolean; error?: string }>;
  sendNow: (draft: WhatsappOutboundDraft) => Promise<{ ok: boolean; error?: string }>;
  postJson: (url: string, body: unknown) => Promise<{ ok: boolean; error?: string }>;
};

async function productionDeps(fetchImpl?: typeof fetch): Promise<DispatchDeps> {
  const queue = await import("./whatsapp-outbound-queue");
  return {
    readSetting: queue.readSiteSetting,
    enqueue: queue.enqueueWhatsappOutbound,
    sendNow: queue.sendWhatsappImmediately,
    postJson: (url, body) => postN8nJson(url, body, fetchImpl),
  };
}

async function postN8nOnce(url: string, body: unknown, fetchImpl: typeof fetch): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: text.slice(0, 180) || `http_${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function postN8nJson(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  let lastError = "request_failed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await postN8nOnce(url, body, fetchImpl);
    if (result.ok) return result;
    lastError = result.error || lastError;
  }
  return { ok: false, error: lastError };
}

export async function readWhatsappChannel(origin: WhatsappNoticeOrigin, readSetting?: DispatchDeps["readSetting"]): Promise<WhatsappChannel> {
  const read = readSetting ?? (await productionDeps()).readSetting;
  return parseWhatsappChannel(await read(WHATSAPP_CHANNEL_SETTING[origin]));
}

export async function whatsappNoticeConfigured(
  origin: WhatsappNoticeOrigin,
  n8nUrl: string,
  readSetting?: DispatchDeps["readSetting"],
): Promise<boolean> {
  const channel = await readWhatsappChannel(origin, readSetting);
  if (channel === "direto") return true;
  return Boolean(String(n8nUrl || "").trim());
}

export async function dispatchWhatsappNotice(input: {
  origin: WhatsappNoticeOrigin;
  instance: WhatsappZapiInstance;
  phone: string;
  kind: WhatsappOutboundKind;
  message?: string;
  caption?: string;
  image?: string;
  optionList?: unknown;
  n8nUrl?: string;
  n8nBody?: unknown;
  immediate?: boolean;
  fetchImpl?: typeof fetch;
}, deps?: Partial<DispatchDeps>): Promise<{ ok: boolean; error?: string; queued?: boolean }> {
  const resolved = deps?.readSetting && deps.enqueue && deps.sendNow && deps.postJson
    ? deps as DispatchDeps
    : { ...(await productionDeps(input.fetchImpl)), ...deps };
  const channel = parseWhatsappChannel(await resolved.readSetting(WHATSAPP_CHANNEL_SETTING[input.origin]));
  if (channel === "n8n") {
    const url = String(input.n8nUrl || "").trim();
    if (!url) return { ok: false, error: "not_configured" };
    const body = input.n8nBody ?? {
      phone: input.phone,
      message: input.message,
      caption: input.caption,
      optionList: input.optionList,
    };
    return resolved.postJson(url, body);
  }
  const draft: WhatsappOutboundDraft = {
    instance: input.instance,
    phone: input.phone,
    kind: input.kind,
    message: input.message,
    caption: input.caption,
    image: input.image,
    optionList: input.optionList,
    origin: input.origin,
  };
  const support = input.origin === "atendimento" || input.origin === "atendimento_menu";
  const immediate = input.immediate === true
    || (support && parseSupportDelivery(await resolved.readSetting(WHATSAPP_SUPPORT_DELIVERY_SETTING)) === "na_hora");
  if (immediate) return resolved.sendNow(draft);
  const queued = await resolved.enqueue(draft);
  return queued.ok ? { ok: true, queued: true } : { ok: false, error: queued.error || "fila_indisponivel" };
}
