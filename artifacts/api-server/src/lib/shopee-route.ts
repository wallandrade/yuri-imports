import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { customerUsersTable, db, orderShipmentsTable, ordersTable } from "@workspace/db";
import type { Request } from "express";
import { recordAdminActivity, recordOrderActivity } from "./order-activity";
import { mysqlAffectedRows } from "./mysql-affected-rows";
import { toWhatsappPhone } from "./order-paid-whatsapp";
import { applyStoreCredit, getStoreCreditBalance } from "./store-credits";
import { sendCustomerWhatsapp } from "./whatsapp-dispatch";
import { whatsappInstanceForSeller } from "./whatsapp-outbound-policy";
import { readSiteSetting } from "./whatsapp-outbound-queue";
import {
  effectiveShopeeRouteMessage,
  firstClientName,
  formatBrl,
  normalizeShopeeProductUrl,
  phonesMatch,
  renderShopeeRouteMessage,
  SHOPEE_ROUTE_MESSAGE_KEY,
  SHOPEE_ROUTE_PRODUCT_URL_KEY,
  shopeeCreditAmount,
  shopeeRouteCreditKey,
  summarizeOrderProducts,
  type ShopeeInboundMotivo,
} from "./shopee-route-core";
import {
  executeShopeeRouteInbound,
  type ShopeeRouteInboundOrder,
  type ShopeeRouteInboundStore,
} from "./shopee-route-support";

export type ShopeeRouteOrderRow = {
  id: string;
  orderNumber: number | null;
  userId: string | null;
  sellerCode: string | null;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  products: unknown;
  total: string | number | null;
  paidAmount: string | number | null;
  enviado: boolean | null;
  inventoryReserved: boolean | null;
  status: string;
  shopeeRouteRequestedAt: Date | null;
  shopeeOrderId: string | null;
  shopeeRouteReviewReason: string | null;
  shopeeWalletCreditedAt: Date | null;
};

type AdminScope = {
  hasGlobalAccess: boolean;
  sellerCode: string | null;
};

const orderColumns = {
  id: ordersTable.id,
  orderNumber: ordersTable.orderNumber,
  userId: ordersTable.userId,
  sellerCode: ordersTable.sellerCode,
  clientName: ordersTable.clientName,
  clientEmail: ordersTable.clientEmail,
  clientPhone: ordersTable.clientPhone,
  products: ordersTable.products,
  total: ordersTable.total,
  paidAmount: ordersTable.paidAmount,
  enviado: ordersTable.enviado,
  inventoryReserved: ordersTable.inventoryReserved,
  status: ordersTable.status,
  shopeeRouteRequestedAt: ordersTable.shopeeRouteRequestedAt,
  shopeeOrderId: ordersTable.shopeeOrderId,
  shopeeRouteReviewReason: ordersTable.shopeeRouteReviewReason,
  shopeeWalletCreditedAt: ordersTable.shopeeWalletCreditedAt,
};

function adminOrderWhere(orderId: string, scope: AdminScope) {
  const base = eq(ordersTable.id, orderId);
  if (scope.hasGlobalAccess) return base;
  return and(base, eq(ordersTable.sellerCode, scope.sellerCode || ""));
}

function isoTimestamp(value: Date | null | undefined): string | null {
  if (!value) return null;
  const time = value instanceof Date ? value : new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

export function shopeeRouteAdminFields(order: {
  id: string;
  shopeeRouteRequestedAt?: Date | null;
  shopeeOrderId?: string | null;
  shopeeRouteReviewReason?: string | null;
  shopeeWalletCreditedAt?: Date | null;
  enviado?: boolean | null;
}) {
  return {
    id: order.id,
    shopeeRouteRequestedAt: isoTimestamp(order.shopeeRouteRequestedAt),
    shopeeOrderId: String(order.shopeeOrderId || "").trim() || null,
    shopeeRouteReviewReason: String(order.shopeeRouteReviewReason || "").trim() || null,
    shopeeWalletCreditedAt: isoTimestamp(order.shopeeWalletCreditedAt),
    enviado: Boolean(order.enviado),
  };
}

export function shopeeRoutePhone(value: unknown): string | null {
  const phone = toWhatsappPhone(String(value ?? ""));
  return phone || null;
}

export async function loadShopeeRouteOrder(orderId: string, scope: AdminScope): Promise<ShopeeRouteOrderRow | null> {
  const rows = await db
    .select(orderColumns)
    .from(ordersTable)
    .where(adminOrderWhere(orderId, scope))
    .limit(1);
  return rows[0] || null;
}

async function reloadOrder(orderId: string): Promise<ShopeeRouteOrderRow | null> {
  const rows = await db.select(orderColumns).from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  return rows[0] || null;
}

function orderLabel(order: { orderNumber: number | null; id: string }): string {
  return order.orderNumber != null ? String(order.orderNumber) : order.id;
}

export async function composeShopeeRouteMessage(
  order: ShopeeRouteOrderRow,
  products: unknown = order.products,
): Promise<{ link: string; message: string; summary: string } | { error: string }> {
  const link = normalizeShopeeProductUrl(await readSiteSetting(SHOPEE_ROUTE_PRODUCT_URL_KEY));
  if (!link) return { error: "Salve o link do produto da Shopee em Configurações." };
  const template = effectiveShopeeRouteMessage(await readSiteSetting(SHOPEE_ROUTE_MESSAGE_KEY));
  const summary = summarizeOrderProducts(products);
  const total = shopeeCreditAmount(order.total, order.paidAmount);
  const message = renderShopeeRouteMessage(template, {
    nome: firstClientName(order.clientName),
    pedido: orderLabel(order),
    resumoPedido: summary.texto,
    linkShopee: link,
    valor: formatBrl(total),
  });
  return { link, message, summary: summary.texto };
}

export async function sendShopeeRouteWhatsapp(input: {
  order: ShopeeRouteOrderRow;
  phone: string;
  message: string;
}): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  const sent = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: whatsappInstanceForSeller(input.order.sellerCode),
    phone: input.phone,
    message: input.message,
    preferImmediate: true,
  });
  if (!sent.ok) return { ok: false, error: sent.error || "request_failed" };
  return { ok: true, queued: Boolean(sent.queued) };
}

export async function markShopeeRouteRequested(
  order: ShopeeRouteOrderRow,
  req: Request,
  notice?: { packageId?: string | null; summary?: string | null },
): Promise<ShopeeRouteOrderRow> {
  const now = new Date();
  await db.update(ordersTable).set({
    shopeeRouteRequestedAt: now,
    shopeeRouteReviewReason: null,
    shippingVia: "shopee",
    updatedAt: now,
  }).where(eq(ordersTable.id, order.id));
  const packageId = String(notice?.packageId || "").trim();
  if (packageId) {
    await db.update(orderShipmentsTable).set({
      shopeeRouteSentAt: now,
      updatedAt: now,
    }).where(and(eq(orderShipmentsTable.id, packageId), eq(orderShipmentsTable.orderId, order.id)));
  }
  const summary = String(notice?.summary || "").trim() || "Aguardando ID Shopee";
  recordAdminActivity(
    req,
    order.id,
    "shopee_route_sent",
    "Rota Shopee enviada",
    packageId ? `${summary} · pacote ${packageId}` : summary,
  );
  return (await reloadOrder(order.id)) || { ...order, shopeeRouteRequestedAt: now, shopeeRouteReviewReason: null };
}

function toInboundOrder(row: ShopeeRouteOrderRow): ShopeeRouteInboundOrder {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    clientPhone: row.clientPhone,
    shopeeRouteRequestedAt: row.shopeeRouteRequestedAt,
    shopeeOrderId: row.shopeeOrderId,
    shopeeRouteReviewReason: row.shopeeRouteReviewReason,
    shopeeWalletCreditedAt: row.shopeeWalletCreditedAt,
    enviado: row.enviado,
    inventoryReserved: row.inventoryReserved,
  };
}

const awaitingShopeeRouteWhere = and(
  isNotNull(ordersTable.shopeeRouteRequestedAt),
  or(isNull(ordersTable.shopeeOrderId), eq(ordersTable.shopeeOrderId, "")),
);

export async function phoneHasAwaitingShopeeRoute(telefone: string): Promise<boolean> {
  if (!phonesMatch(telefone, telefone)) return false;
  const rows = await db
    .select({ clientPhone: ordersTable.clientPhone })
    .from(ordersTable)
    .where(awaitingShopeeRouteWhere);
  return rows.some((row) => phonesMatch(row.clientPhone, telefone));
}

/** Marca enviado sem mexer em inventory_reserved nem no saldo dos depósitos. */
export async function markOrderEnviadoWithoutInventory(orderId: string): Promise<{ already: boolean }> {
  const now = new Date();
  const result = await db
    .update(ordersTable)
    .set({ enviado: true, enviadoAt: now, updatedAt: now })
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.enviado, false)));
  return { already: mysqlAffectedRows(result) === 0 };
}

const shopeeRouteInboundStore: ShopeeRouteInboundStore = {
  async listAwaiting() {
    const rows = await db.select(orderColumns).from(ordersTable).where(awaitingShopeeRouteWhere);
    return rows.map(toInboundOrder);
  },
  async listByShopeeOrderId(id) {
    const rows = await db.select(orderColumns).from(ordersTable).where(eq(ordersTable.shopeeOrderId, id));
    return rows.map(toInboundOrder);
  },
  async reload(id) {
    const row = await reloadOrder(id);
    return row ? toInboundOrder(row) : null;
  },
  async assignShopeeOrderId(id, shopeeOrderId) {
    await db.update(ordersTable).set({
      shopeeOrderId,
      shopeeRouteReviewReason: null,
      updatedAt: new Date(),
    }).where(eq(ordersTable.id, id));
  },
  async markReview(id, motivo) {
    const rows = await db
      .select({
        id: ordersTable.id,
        shopeeRouteReviewReason: ordersTable.shopeeRouteReviewReason,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.shopeeRouteReviewReason === motivo) return { changed: false };
    await db.update(ordersTable).set({
      shopeeRouteReviewReason: motivo,
      updatedAt: new Date(),
    }).where(eq(ordersTable.id, id));
    return { changed: true };
  },
  async markEnviado(id) {
    return markOrderEnviadoWithoutInventory(id);
  },
  async addEvent(event) {
    const summary = String(event.payload.summary || "").trim();
    await recordOrderActivity({
      orderId: event.orderId,
      type: event.action,
      label: summary || "Rota Shopee",
      actorType: "webhook",
      actorName: "whatsapp",
      detail: summary || null,
    });
  },
};

export async function receiveShopeeRouteInbound(
  input: { telefone: string; texto: string },
): Promise<
  | { ok: true; ja_processado: boolean; pedido: ReturnType<typeof shopeeRouteAdminFields> & { numero: number | null }; mensagem_para_cliente: string }
  | { ok: false; motivo: ShopeeInboundMotivo }
> {
  const result = await executeShopeeRouteInbound(input, shopeeRouteInboundStore);
  if (!result.ok) return result;
  return {
    ok: true,
    ja_processado: result.ja_processado,
    pedido: {
      ...shopeeRouteAdminFields(result.order),
      numero: result.order.orderNumber ?? null,
    },
    mensagem_para_cliente: result.mensagem_para_cliente,
  };
}

export async function saveAdminShopeeOrderId(
  order: ShopeeRouteOrderRow,
  shopeeOrderId: string | null,
  req: Request,
): Promise<ShopeeRouteOrderRow> {
  const now = new Date();
  await db.update(ordersTable).set({
    shopeeOrderId,
    shopeeRouteReviewReason: shopeeOrderId ? null : order.shopeeRouteReviewReason,
    updatedAt: now,
  }).where(eq(ordersTable.id, order.id));
  recordAdminActivity(
    req,
    order.id,
    "shopee_order_id",
    shopeeOrderId ? `ID Shopee ${shopeeOrderId}` : "ID Shopee apagado",
  );
  return (await reloadOrder(order.id)) || { ...order, shopeeOrderId };
}

async function customerIdForOrder(order: ShopeeRouteOrderRow): Promise<string> {
  const userId = String(order.userId || "").trim();
  if (userId) {
    const rows = await db
      .select({ id: customerUsersTable.id })
      .from(customerUsersTable)
      .where(eq(customerUsersTable.id, userId))
      .limit(1);
    if (rows[0]?.id) return rows[0].id;
  }
  const email = String(order.clientEmail || "").trim().toLowerCase();
  if (!email) return "";
  const rows = await db
    .select({ id: customerUsersTable.id })
    .from(customerUsersTable)
    .where(sql`LOWER(${customerUsersTable.email}) = ${email}`)
    .limit(1);
  return rows[0]?.id || "";
}

export async function creditShopeeRouteWallet(order: ShopeeRouteOrderRow, req: Request): Promise<
  | { ok: true; already: boolean; amount: number; userId: string; availableCredit: number; order: ShopeeRouteOrderRow }
  | { ok: false; status: number; error: string; message: string }
> {
  const userId = await customerIdForOrder(order);
  if (!userId) {
    return {
      ok: false,
      status: 400,
      error: "NO_CUSTOMER",
      message: "Pedido sem conta de cliente para lançar o crédito na carteira.",
    };
  }
  const amount = shopeeCreditAmount(order.total, order.paidAmount);
  if (amount <= 0) {
    return { ok: false, status: 400, error: "INVALID_AMOUNT", message: "Este pedido não tem valor para creditar." };
  }
  if (order.shopeeWalletCreditedAt) {
    const availableCredit = await getStoreCreditBalance(userId);
    return { ok: true, already: true, amount, userId, availableCredit, order };
  }
  const note = `Crédito da rota Shopee do pedido ${orderLabel(order)}`;
  const key = shopeeRouteCreditKey(order.id);
  const credited = await applyStoreCredit({
    userId,
    amount,
    type: "shopee_route_credit",
    orderId: order.id,
    note,
    id: key.length <= 255 ? key : undefined,
  });
  if (credited.duplicate && Math.abs(credited.applied - amount) > 0.009) {
    return {
      ok: false,
      status: 409,
      error: "IDEMPOTENCY_CONFLICT",
      message: "Este pedido já teve crédito com outro valor.",
    };
  }
  const already = credited.duplicate;
  let saved = order;
  if (!order.shopeeWalletCreditedAt) {
    const now = new Date();
    await db.update(ordersTable).set({
      shopeeWalletCreditedAt: now,
      updatedAt: now,
    }).where(eq(ordersTable.id, order.id));
    saved = (await reloadOrder(order.id)) || { ...order, shopeeWalletCreditedAt: now };
  }
  if (!already) {
    recordAdminActivity(req, order.id, "shopee_wallet_credit", `Crédito de ${formatBrl(amount)}`);
  }
  const availableCredit = await getStoreCreditBalance(userId);
  return { ok: true, already, amount, userId, availableCredit, order: saved };
}
