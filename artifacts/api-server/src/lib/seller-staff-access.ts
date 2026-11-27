import type { NextFunction, Request, Response } from "express";

/** Papel da vendedora. Não é filial e não é o admin principal. */
export const SELLER_STAFF_ROLE = "vendedora";

export type AdminRoleName = "admin" | "vendedora";

type SessionLike = { role?: string };

/**
 * Leituras de venda e a pré-confirmação. Qualquer outra rota de admin fica de fora.
 * A confirmação real (status pago) não entra aqui.
 */
const SELLER_STAFF_GET = [
  /^\/admin\/verify$/,
  /^\/admin\/orders$/,
  /^\/admin\/orders\/[^/]+\/activity$/,
  /^\/admin\/financial-summary$/,
];

const SELLER_STAFF_WRITES: Array<{ method: string; re: RegExp }> = [
  { method: "POST", re: /^\/admin\/orders\/[^/]+\/payment-preconfirm$/ },
];

export function normalizeAdminApiPath(raw: string): string {
  const withoutQuery = String(raw || "").split("?")[0].split("#")[0];
  const stripped = withoutQuery.startsWith("/api/") ? withoutQuery.slice(4) : withoutQuery;
  if (stripped.length > 1 && stripped.endsWith("/")) return stripped.slice(0, -1);
  return stripped || "/";
}

export function isSellerStaffRole(role: unknown): boolean {
  return String(role || "").trim().toLowerCase() === SELLER_STAFF_ROLE;
}

/** true só no que a vendedora pode chamar. O resto é 403. */
export function sellerStaffMayAccess(method: string, rawPath: string): boolean {
  const verb = String(method || "").toUpperCase();
  const path = normalizeAdminApiPath(rawPath);
  if (verb === "GET" || verb === "HEAD") {
    return SELLER_STAFF_GET.some((re) => re.test(path));
  }
  return SELLER_STAFF_WRITES.some((rule) => rule.method === verb && rule.re.test(path));
}

export function requestAdminRole(req: Request): string {
  const session = (req as Request & { adminSession?: SessionLike }).adminSession;
  return String(session?.role || "");
}

/**
 * Bloqueio explícito nas rotas de preço, desconto, estoque, produto, cupom,
 * configuração, usuário e envio. Não consulta a allowlist: a vendedora sempre toma 403.
 */
export function forbidSellerStaff(req: Request, res: Response, next: NextFunction): void {
  if (isSellerStaffRole(requestAdminRole(req))) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Sem permissão para esta ação.",
    });
    return;
  }
  next();
}
