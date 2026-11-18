import { eq } from "drizzle-orm";
import type { InventoryPoolKind } from "./order-inventory-debit";

export type KaLabelWarehouse = "motoboy" | "minas" | "santa_catarina";
export type KaLabelStockResult = "baixou_estoque" | "saiu_sem_abater";

export type KaPendingLabel = {
  labelId: string;
  orderNumber: number | null;
  customerName: string;
  status: string;
  code: string;
  warehouse: KaLabelWarehouse;
  products: Array<{ productId: string; name: string; quantity: number }>;
};

const WAREHOUSES = new Set<KaLabelWarehouse>(["motoboy", "minas", "santa_catarina"]);
const TIMEOUT_MS = 8000;

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

export function kaLabelPeerBaseUrl(): string {
  return env("LABEL_STOCK_PEER_BASE_URL").replace(/\/+$/, "");
}

export function kaLabelSyncToken(): string {
  return env("LABEL_STOCK_SYNC_TOKEN");
}

export function kaLabelPeerConfigured(): boolean {
  return Boolean(kaLabelPeerBaseUrl() && kaLabelSyncToken());
}

export function kaLabelReferenceId(labelId: string): string {
  return `ka-label:${String(labelId || "").trim()}`;
}

export function kaLabelLane(warehouse: string): KaLabelWarehouse | null {
  const value = String(warehouse || "").trim();
  return WAREHOUSES.has(value as KaLabelWarehouse) ? value as KaLabelWarehouse : null;
}

function productLine(raw: unknown): KaPendingLabel["products"][number] | null {
  const rec = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const quantity = Math.trunc(Number(rec.quantity) || 0);
  if (quantity <= 0) return null;
  const name = String(rec.name || rec.productName || "Produto").trim() || "Produto";
  return {
    productId: String(rec.productId || "").trim(),
    name,
    quantity,
  };
}

export function parseKaPendingLabels(body: unknown): KaPendingLabel[] {
  const labels = body && typeof body === "object"
    ? (body as { labels?: unknown }).labels
    : null;
  if (!Array.isArray(labels)) return [];
  const rows: KaPendingLabel[] = [];
  for (const raw of labels) {
    const rec = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const labelId = String(rec.labelId || "").trim();
    const warehouse = kaLabelLane(String(rec.warehouse || ""));
    if (!labelId || !warehouse) continue;
    const orderNumber = Number(rec.orderNumber);
    const products = Array.isArray(rec.products)
      ? rec.products.flatMap((item) => {
        const line = productLine(item);
        return line ? [line] : [];
      })
      : [];
    rows.push({
      labelId,
      orderNumber: Number.isFinite(orderNumber) && orderNumber > 0 ? orderNumber : null,
      customerName: String(rec.customerName || "").trim(),
      status: String(rec.status || "").trim() || "Etiqueta",
      code: String(rec.code || "").trim(),
      warehouse,
      products,
    });
  }
  return rows;
}

function listUrl(): string {
  return `${kaLabelPeerBaseUrl()}/api/integrations/labels/pending-stock`;
}

function resultUrl(labelId: string): string {
  return `${kaLabelPeerBaseUrl()}/api/integrations/labels/${encodeURIComponent(labelId)}/stock-result`;
}

async function kaFetch(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${kaLabelSyncToken()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Lista vazia se a KA não estiver configurada ou não responder. A fila da Yuri continua. */
export async function fetchKaPendingLabels(fetchImpl: typeof fetch = fetch): Promise<KaPendingLabel[]> {
  if (!kaLabelPeerConfigured()) return [];
  try {
    const response = await kaFetch(listUrl(), { method: "GET" }, fetchImpl);
    if (!response.ok) {
      console.warn("[LabelStock KA] lista", response.status);
      return [];
    }
    return parseKaPendingLabels(await response.json());
  } catch (err) {
    console.warn("[LabelStock KA] lista", err instanceof Error ? err.message.slice(0, 160) : "falha");
    return [];
  }
}

export async function postKaLabelStockResult(
  labelId: string,
  result: KaLabelStockResult,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!kaLabelPeerConfigured()) return { ok: false, error: "Lista da KA não configurada." };
  try {
    const response = await kaFetch(resultUrl(labelId), {
      method: "POST",
      body: JSON.stringify({ result }),
    }, fetchImpl);
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: String(data.error || `http_${response.status}`) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request_failed" };
  }
}

export async function kaLabelAlreadyDebited(pool: KaLabelWarehouse, labelId: string): Promise<boolean> {
  const {
    db,
    inventoryMinasMovementsTable,
    inventoryMotoboyMovementsTable,
    inventorySantaCatarinaMovementsTable,
  } = await import("@workspace/db");
  const table = pool === "minas"
    ? inventoryMinasMovementsTable
    : pool === "santa_catarina"
      ? inventorySantaCatarinaMovementsTable
      : inventoryMotoboyMovementsTable;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.referenceId, kaLabelReferenceId(labelId)))
    .limit(1);
  return rows.length > 0;
}

export function kaWarehousePool(warehouse: KaLabelWarehouse): InventoryPoolKind {
  return warehouse;
}
