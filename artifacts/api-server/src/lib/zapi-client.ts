export type ZapiInstanceName = "main" | "poly" | "celltech";
export type ZapiOutboundKind = "text" | "image" | "option_list" | "gif";

export type ZapiCredentials = {
  instanceId: string;
  token: string;
  clientToken: string;
};

const ZAPI_HOST = "https://api.z-api.io";

export function readZapiEnv(name: string): string {
  return String(process.env[name] || "").trim().replace(/^['"]|['"]$/g, "");
}

function validPart(value: string): boolean {
  return Boolean(value) && !/[/?#\s]/.test(value);
}

function credentialsFrom(instanceId: string, token: string, clientToken: string): ZapiCredentials | null {
  if (!validPart(instanceId) || !validPart(token) || !validPart(clientToken)) return null;
  return { instanceId, token, clientToken };
}

/** Credencial da instância. Poly e Cell Tech podem repetir o Client-Token da conta. Não logar o retorno. */
export function zapiCredentials(instance: ZapiInstanceName): ZapiCredentials | null {
  if (instance === "poly") {
    return credentialsFrom(
      readZapiEnv("ZAPI_POLY_INSTANCE_ID"),
      readZapiEnv("ZAPI_POLY_TOKEN"),
      readZapiEnv("ZAPI_POLY_CLIENT_TOKEN") || readZapiEnv("ZAPI_CLIENT_TOKEN"),
    );
  }
  if (instance === "celltech") {
    return credentialsFrom(
      readZapiEnv("ZAPI_CELL_TECH_INSTANCE_ID"),
      readZapiEnv("ZAPI_CELL_TECH_TOKEN"),
      readZapiEnv("ZAPI_CELL_TECH_CLIENT_TOKEN") || readZapiEnv("ZAPI_CLIENT_TOKEN"),
    );
  }
  return credentialsFrom(
    readZapiEnv("ZAPI_MAIN_INSTANCE_ID"),
    readZapiEnv("ZAPI_MAIN_TOKEN"),
    readZapiEnv("ZAPI_CLIENT_TOKEN"),
  );
}

export function zapiInstancePath(creds: ZapiCredentials, suffix: string): string {
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `/instances/${encodeURIComponent(creds.instanceId)}/token/${encodeURIComponent(creds.token)}${path}`;
}

export function redactZapiSecret(value: string): string {
  return String(value || "")
    .replace(/https?:\/\/api\.z-api\.io\/instances\/\S+/gi, "https://api.z-api.io/instances/…")
    .replace(/[A-Za-z0-9_-]{12,}/g, "…");
}

export function zapiMessageAccepted(status: number, json: unknown): boolean {
  const body = json && typeof json === "object" ? json as Record<string, unknown> : null;
  const hasError = Boolean(body && (body.error || body.erro));
  const looksSuccess = Boolean(body && (body.messageId || body.zaapId) && !hasError);
  const httpOk = status >= 200 && status < 300;
  return !hasError && (httpOk || looksSuccess);
}

/** Apagar mensagem e tirar participante: 2xx, e `value: true` quando a Z-API manda esse campo. */
export function zapiActionAccepted(status: number, raw: string): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    if (parsed && typeof parsed === "object" && "value" in parsed) return parsed.value === true;
  } catch {
    return true;
  }
  return true;
}

export function zapiOutboundRequest(input: {
  phone: string;
  kind: ZapiOutboundKind;
  message?: string;
  caption?: string;
  image?: string;
  optionList?: unknown;
}): { suffix: string; body: Record<string, unknown> } | { error: string } {
  const phone = String(input.phone || "").trim();
  if (!phone) return { error: "missing_phone" };
  if (input.kind === "option_list") {
    let optionList: unknown = input.optionList ?? "";
    if (typeof optionList === "string" && optionList.trim()) {
      try {
        optionList = JSON.parse(optionList) as unknown;
      } catch {
        optionList = input.optionList;
      }
    }
    return {
      suffix: "/send-option-list",
      body: { phone, message: String(input.message || ""), optionList },
    };
  }
  if (input.kind === "image") {
    const image = String(input.image || "").trim();
    if (!image) return { error: "missing_image" };
    return {
      suffix: "/send-image",
      body: { phone, image, caption: String(input.caption || input.message || "") },
    };
  }
  if (input.kind === "gif") {
    const gif = String(input.image || "").trim();
    if (!gif) return { error: "missing_gif" };
    return { suffix: "/send-gif", body: { phone, gif } };
  }
  return { suffix: "/send-text", body: { phone, message: String(input.message || "") } };
}

export type ZapiCallResult = {
  ok: boolean;
  status: number;
  json: unknown;
  raw: string;
  error: string;
};

export async function zapiCall(input: {
  instance: ZapiInstanceName;
  method: "GET" | "POST" | "DELETE";
  suffix: string;
  body?: unknown;
  timeoutMs?: number;
  accept?: "http" | "message" | "action";
  fetchImpl?: typeof fetch;
}): Promise<ZapiCallResult> {
  const creds = zapiCredentials(input.instance);
  if (!creds) return { ok: false, status: 0, json: null, raw: "", error: "zapi_not_configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20000);
  try {
    const response = await (input.fetchImpl ?? fetch)(`${ZAPI_HOST}${zapiInstancePath(creds, input.suffix)}`, {
      method: input.method,
      headers: {
        Accept: "application/json",
        "Client-Token": creds.clientToken,
        ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const mode = input.accept ?? "http";
    const ok = mode === "action"
      ? zapiActionAccepted(response.status, raw)
      : mode === "message"
        ? zapiMessageAccepted(response.status, json)
        : response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      json,
      raw,
      error: ok ? "" : redactZapiSecret(`HTTP ${response.status} ${raw}`.slice(0, 400)),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: 0, json: null, raw: "", error: aborted ? "timeout" : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Lista que a Z-API recusa vira o texto simples, no mesmo envio. */
export async function sendZapiMessageWithFallback(input: {
  instance: ZapiInstanceName;
  phone: string;
  kind: ZapiOutboundKind;
  message?: string;
  caption?: string;
  image?: string;
  optionList?: unknown;
  fallbackMessage?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; error?: string; usedFallback?: boolean }> {
  const sent = await sendZapiMessage(input);
  const fallback = String(input.fallbackMessage || "").trim();
  if (sent.ok || input.kind !== "option_list" || !fallback) return sent;
  const text = await sendZapiMessage({
    instance: input.instance,
    phone: input.phone,
    kind: "text",
    message: fallback,
    fetchImpl: input.fetchImpl,
  });
  return text.ok ? { ok: true, usedFallback: true } : text;
}

export async function sendZapiMessage(input: {
  instance: ZapiInstanceName;
  phone: string;
  kind: ZapiOutboundKind;
  message?: string;
  caption?: string;
  image?: string;
  optionList?: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; error?: string }> {
  const request = zapiOutboundRequest(input);
  if ("error" in request) return { ok: false, error: request.error };
  const result = await zapiCall({
    instance: input.instance,
    method: "POST",
    suffix: request.suffix,
    body: request.body,
    timeoutMs: 20000,
    accept: "message",
    fetchImpl: input.fetchImpl,
  });
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error || "request_failed" };
}
