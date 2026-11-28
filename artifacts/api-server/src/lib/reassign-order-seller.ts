/** Troca o vendedor de um pedido já criado. A comissão passa a usar a taxa do vendedor novo. */

export function normalizeReassignSellerCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

export function commissionRateSnapshotForSeller(seller: {
  hasCommission?: boolean | null;
  commissionRate?: string | number | null;
}): number {
  if (!seller.hasCommission) return 0;
  const rate = Number(seller.commissionRate ?? 0);
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return Math.round(rate * 100) / 100;
}

export function orderCommissionAmount(total: number | string | null | undefined, rate: number | string | null | undefined): number {
  const amount = (Number(total) || 0) * ((Number(rate) || 0) / 100);
  return Math.round(amount * 100) / 100;
}

export function parseBatchOrderIds(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry || "").trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function commissionAlreadyPaid(input: {
  paidAt?: unknown;
  batchStatus?: string | null;
}): boolean {
  if (input.paidAt) return true;
  return String(input.batchStatus || "").trim().toLowerCase() === "paid";
}

/** Tira o pedido do lote aberto e recalcula o total com a taxa de cada pedido que ficou. Lote vazio vira null (apagar). */
export function openBatchAfterRemovingOrder(input: {
  batchOrderIds: unknown;
  removedOrderId: string;
  remainingOrders: Array<{ id: string; total: number | string | null; rate: number | string | null }>;
}): { orderIds: string[]; orderCount: number; totalAmount: number } | null {
  const removed = String(input.removedOrderId || "").trim();
  const leftover = parseBatchOrderIds(input.batchOrderIds).filter((id) => id !== removed);
  const byId = new Map(input.remainingOrders.map((row) => [row.id, row]));
  const orderIds = leftover.filter((id) => byId.has(id));
  if (orderIds.length === 0) return null;
  const totalAmount = orderIds.reduce((sum, id) => {
    const row = byId.get(id);
    if (!row) return sum;
    return sum + orderCommissionAmount(row.total, row.rate);
  }, 0);
  return {
    orderIds,
    orderCount: orderIds.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}
