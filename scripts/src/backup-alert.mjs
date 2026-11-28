// WhatsApp alert for backup jobs. Direct Z-API send-text to one owner phone.
// Never a group, never n8n. Safe to import from the MySQL dump (plain Node, no tsx).

export function redactAlertDetail(detail) {
  return String(detail || "")
    .replace(/mysql:\/\/\S+/gi, "mysql://[redacted]")
    .replace(/https?:\/\/api\.z-api\.io\/\S+/gi, "https://api.z-api.io/[redacted]")
    .replace(/(secret|password|token|access[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Personal Brazilian number only. A Z-API group id contains "-" or "@g.us" and is refused. */
export function ownerAlertPhone(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (/@|group|g\.us/i.test(trimmed) || trimmed.includes("-")) return { ok: false, reason: "group" };
  if (!/^\+?[\d\s()]+$/.test(trimmed)) return { ok: false, reason: "phone" };
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 13 || !digits.startsWith("55")) return { ok: false, reason: "phone" };
  return { ok: true, phone: digits };
}

export function backupAlertText({ title, lines }) {
  const safeLines = (Array.isArray(lines) ? lines : []).map((line) => redactAlertDetail(line)).filter(Boolean);
  return ["Yuri Import — backup", String(title || "").trim(), ...safeLines].filter(Boolean).join("\n").slice(0, 1500);
}

function readEnv(env, key) {
  return String(env?.[key] || "").trim().replace(/^['"]|['"]$/g, "");
}

function zapiReady(instanceId, token, clientToken) {
  const valid = (value) => Boolean(value) && !/[/?#\s]/.test(value);
  return valid(instanceId) && valid(token) && valid(clientToken);
}

export function backupAlertConfigured(env = process.env) {
  const phone = ownerAlertPhone(readEnv(env, "BACKUP_ALERT_PHONE"));
  if (!phone.ok) return { ok: false, error: phone.reason === "group" ? "destino é grupo" : "BACKUP_ALERT_PHONE ausente ou inválido" };
  const instanceId = readEnv(env, "ZAPI_MAIN_INSTANCE_ID");
  const token = readEnv(env, "ZAPI_MAIN_TOKEN");
  const clientToken = readEnv(env, "ZAPI_CLIENT_TOKEN");
  if (!zapiReady(instanceId, token, clientToken)) return { ok: false, error: "zapi_not_configured" };
  return { ok: true, error: "" };
}

/**
 * Sends one text to BACKUP_ALERT_PHONE through the main Z-API instance.
 * Does not throw. Does not log the token, the URL, or the phone.
 */
export async function notifyOwnerBackupAlert({ title, lines, env = process.env, fetchImpl = fetch }) {
  const ready = backupAlertConfigured(env);
  if (!ready.ok) return ready;
  const phone = ownerAlertPhone(readEnv(env, "BACKUP_ALERT_PHONE"));
  if (!phone.ok) return { ok: false, error: "BACKUP_ALERT_PHONE ausente ou inválido" };
  const instanceId = readEnv(env, "ZAPI_MAIN_INSTANCE_ID");
  const token = readEnv(env, "ZAPI_MAIN_TOKEN");
  const clientToken = readEnv(env, "ZAPI_CLIENT_TOKEN");
  const message = backupAlertText({ title, lines });
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(token)}/send-text`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Client-Token": clientToken,
      },
      body: JSON.stringify({ phone: phone.phone, message }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = `HTTP ${response.status}`;
      console.error(`[backup-alert] Z-API não enviou o aviso: ${error}`);
      return { ok: false, error };
    }
    return { ok: true, error: "" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const error = name === "TimeoutError" || name === "AbortError" ? "timeout" : "request_failed";
    console.error(`[backup-alert] Z-API não enviou o aviso: ${error}`);
    return { ok: false, error };
  }
}
