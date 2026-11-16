/** Teto da J&T quando a cotação não informa o limite. Outras transportadoras não usam isto. */
export const JT_DECLARED_CAP = 1000;

/** Teto absoluto aceito se a opção da cotação trouxer um limite. Acima disso o campo é ignorado. */
export const DECLARED_LIMIT_ABS_MAX = 3000;

const LIMIT_KEYS = [
  "max_declared_value",
  "declared_value_limit",
  "declaredValueLimit",
  "max_insurance_value",
  "insurance_limit",
  "insured_value_limit",
  "valor_maximo_declarado",
  "limite_valor_declarado",
];

export type DeclaredCap = {
  value: number;
  from: number;
  capped: boolean;
  limit: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `1.000,00`, `2.500,00` e `1.000`. `19.85` continua decimal. */
export function parseDeclaredLimitAmount(value: unknown): number {
  if (typeof value === "number") return value;
  const raw = String(value ?? "").trim().replace(/[R$\s]/gi, "");
  if (!raw) return NaN;
  if (!raw.includes(",") && /^\d{1,3}(\.\d{3})+$/.test(raw)) {
    return Number(raw.replace(/\./g, ""));
  }
  const normalized = raw.includes(",") && raw.includes(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function normalizeDeclaredLimit(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = parseDeclaredLimitAmount(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > DECLARED_LIMIT_ABS_MAX) return null;
  return roundMoney(parsed);
}

export function isJtCarrier(name: string | null | undefined): boolean {
  const text = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return text.includes("j&t") || text.includes("jandt") || /\bjt\b/.test(text);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Se a opção da cotação trouxer um teto conhecido, usa ele. Senão, null. */
export function carrierDeclaredLimitFromQuote(quote: unknown): number | null {
  const row = asRecord(quote);
  if (!row) return null;
  for (const key of LIMIT_KEYS) {
    const found = normalizeDeclaredLimit(row[key]);
    if (found) return found;
  }
  const nested = asRecord(row.limits) || asRecord(row.limit);
  if (!nested || nested === row) return null;
  return carrierDeclaredLimitFromQuote(nested);
}

export function capJtDeclaredValue(amount: number, limit?: unknown): DeclaredCap {
  const from = roundMoney(Number.isFinite(amount) ? amount : 0);
  const cap = normalizeDeclaredLimit(limit) ?? JT_DECLARED_CAP;
  if (from > cap) return { value: cap, from, capped: true, limit: cap };
  return { value: from, from, capped: false, limit: cap };
}

type DeclaredItem = { quantity: number; unit_cost: number };

function itemQuantity(item: DeclaredItem): number {
  const qty = Math.trunc(Number(item.quantity));
  return Number.isFinite(qty) && qty >= 1 ? qty : 1;
}

function itemsTotal(items: DeclaredItem[]): number {
  return roundMoney(items.reduce((sum, item) => sum + itemQuantity(item) * Number(item.unit_cost || 0), 0));
}

function unitForTotal(quantity: number, total: number): number {
  const qty = Math.max(1, quantity);
  let unit = Math.floor((total / qty) * 100) / 100;
  if (unit < 0.01) unit = 0.01;
  while (roundMoney(unit * qty) > total && unit > 0.01) {
    unit = roundMoney(unit - 0.01);
  }
  return unit;
}

/** Só corta quando a transportadora é J&T. PAC e Sedex voltam iguais. */
export function fitDeclaredShipmentItems<T extends DeclaredItem>(
  items: T[],
  declaredCost: number,
  carrier: string | null | undefined,
  limit?: unknown,
): { items: T[]; declaredCost: number; capped: boolean; limit: number | null; from: number } {
  const from = roundMoney(Math.max(itemsTotal(items), Number.isFinite(declaredCost) ? declaredCost : 0));
  if (!isJtCarrier(carrier)) {
    return { items, declaredCost: roundMoney(declaredCost), capped: false, limit: null, from };
  }
  const capped = capJtDeclaredValue(from, limit);
  if (!capped.capped || items.length === 0) {
    return { items, declaredCost: roundMoney(declaredCost), capped: false, limit: capped.limit, from };
  }
  const qty = itemQuantity(items[0]);
  const unit = unitForTotal(qty, capped.value);
  const next = items.map((item, index) => index === 0
    ? { ...item, quantity: qty, unit_cost: unit }
    : item);
  return {
    items: next,
    declaredCost: roundMoney(unit * qty),
    capped: true,
    limit: capped.limit,
    from,
  };
}

export function capQuoteProductPrice(price: number, carriers: string[] | null | undefined): number {
  if (!carriers || carriers.length === 0 || !carriers.every(isJtCarrier)) return price;
  return capJtDeclaredValue(price).value;
}

const envioecomCreateGuard = new Map<string, { inflight: boolean; until: number }>();

/** Evita dois creates do mesmo pedido. Sucesso segura a trava por 15s. Falha solta na hora. */
export function claimEnvioEcomCreateSlot(key: string, now = Date.now()): string | null {
  const current = envioecomCreateGuard.get(key);
  if (current?.inflight) return "Já existe uma criação de envio em andamento para este pedido.";
  if (current && current.until > now) return "Este pedido acabou de gerar um envio. Aguarde alguns segundos antes de criar outro.";
  envioecomCreateGuard.set(key, { inflight: true, until: 0 });
  return null;
}

export function releaseEnvioEcomCreateSlot(key: string, created: boolean, now = Date.now()): void {
  if (!key) return;
  if (created) envioecomCreateGuard.set(key, { inflight: false, until: now + 15_000 });
  else envioecomCreateGuard.delete(key);
}
