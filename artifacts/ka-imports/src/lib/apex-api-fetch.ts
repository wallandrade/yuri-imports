const APEX_HOSTS = new Set(["yury-imports.com", "imports-py.com", "yuri-imports-py.com", "compras-yu.com"]);
const API_ORIGIN = "https://yuri-imports-9483v.ondigitalocean.app";

/**
 * O domínio sem www responde 307 para www antes do rewrite da API.
 * O Safari devolve esse 307 no POST, sem a mensagem da rota.
 * Só a Rota Shopee usa isto. O restante do /api fica no mesmo host, com o cookie.
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
