const APEX_HOSTS = new Set(["yury-imports.com", "imports-py.com", "yuri-imports-py.com"]);
const API_ORIGIN = "https://yuri-imports-9483v.ondigitalocean.app";

/**
 * O domínio sem www responde 307 para www antes do rewrite da API.
 * O Safari devolve esse 307 no POST, sem a mensagem da rota.
 * www também fica de fora do connect-src. A API direta já está liberada.
 */
export function rewriteApexApiUrl(raw: string, hostname: string): string | null {
  if (!APEX_HOSTS.has(hostname)) return null;
  if (raw === "/api" || raw.startsWith("/api/") || raw.startsWith("/api?")) {
    return `${API_ORIGIN}${raw}`;
  }
  const absolute = `https://${hostname}`;
  if (raw === `${absolute}/api` || raw.startsWith(`${absolute}/api/`) || raw.startsWith(`${absolute}/api?`)) {
    return `${API_ORIGIN}${raw.slice(absolute.length)}`;
  }
  return null;
}

export function installApexApiFetch(): void {
  if (typeof window === "undefined" || !APEX_HOSTS.has(window.location.hostname)) return;
  const native = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const next = rewriteApexApiUrl(raw, window.location.hostname);
    if (!next) return native(input, init);
    if (typeof input === "string" || input instanceof URL) return native(next, init);
    return native(new Request(next, input), init);
  };
}
