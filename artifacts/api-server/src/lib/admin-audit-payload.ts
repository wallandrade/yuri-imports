const SENSITIVE_KEY = /password|token|secret|authorization|cookie|pix|hash|salt|cvv|cardnumber|api[_-]?key/i;

export function clientIpFromRequest(req: {
  ip?: string;
  headers?: Record<string, unknown>;
}): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? String(forwarded[0] || "") : String(forwarded || "");
  const first = raw.split(",")[0]?.trim() || String(req.ip || "").trim();
  return first.replace(/^::ffff:/, "").slice(0, 64);
}

/** Tira senha, token e PIX do que vai para o log. String longa vira um recorte. */
export function redactAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 500) return `${value.slice(0, 120)}…`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactAuditPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = redactAuditPayload(item, depth + 1);
    }
    return out;
  }
  return null;
}
