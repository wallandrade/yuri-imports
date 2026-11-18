import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, ordersTable, orderShipmentsTable } from "@workspace/db";
import { getAdminScope, requireAdminAuth } from "./admin-auth";
import { inventoryPoolForEnvioEcomAccount } from "../lib/envioecom";
import { listEnvioEcomAccountsPublic } from "../lib/envioecom-accounts";
import { labelDebitLane, labelDebitStockPool, type LabelDebitCandidate, type LabelDebitLane } from "../lib/label-debit-queue";
import { ensureOrderInventoryDebited } from "../lib/order-inventory-debit";
import { ensurePackageInventoryDebited, getOrderShipment, updateOrderShipment } from "../lib/order-shipments";
import { authorizeInventoryExit } from "../lib/inventory-exit-access";
import { inventoryExitPasswordApplies, readPasswordFromBody } from "../lib/inventory-exit-access-logic";
import { recordAdminActivity } from "../lib/order-activity";

const router: IRouter = Router();
const CANCELLED = new Set(["cancelled", "cancelado", "canceled"]);

type ItemLine = { id: string; name: string; quantity: number };

function parseItems(raw: unknown): ItemLine[] {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const rec = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const quantity = Number(rec.quantity) || 0;
    if (quantity <= 0) return [];
    return [{
      id: String(rec.id || rec.productId || ""),
      name: String(rec.variantOption || rec.name || rec.productName || "Produto"),
      quantity,
    }];
  });
}

function scopeOf(req: Request, res: Response) {
  const scope = getAdminScope(req);
  if (!scope) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Sessão inválida." });
    return null;
  }
  return scope;
}

function sellerMatches(scope: { hasGlobalAccess: boolean; sellerCode: string | null }, sellerCode: string | null | undefined): boolean {
  if (scope.hasGlobalAccess) return true;
  return String(sellerCode || "") === String(scope.sellerCode || "");
}

router.get("/admin/inventory/label-debits", requireAdminAuth, async (req, res) => {
  try {
    const scope = scopeOf(req, res);
    if (!scope) return;

    const accounts = await listEnvioEcomAccountsPublic();
    const accountName = new Map(accounts.map((account) => [account.id, account.name]));

    const orders = await db
      .select({
        id: ordersTable.id,
        orderNumber: ordersTable.orderNumber,
        clientName: ordersTable.clientName,
        status: ordersTable.status,
        sellerCode: ordersTable.sellerCode,
        shippingType: ordersTable.shippingType,
        enviado: ordersTable.enviado,
        inventoryReserved: ordersTable.inventoryReserved,
        labelDebitWaived: ordersTable.labelDebitWaived,
        envioecomAccountId: ordersTable.envioecomAccountId,
        envioecomStatus: ordersTable.envioecomStatus,
        envioecomLabelUrl: ordersTable.envioecomLabelUrl,
        envioecomBarcode: ordersTable.envioecomBarcode,
        trackingCode: ordersTable.trackingCode,
        trackingLabelUrl: ordersTable.trackingLabelUrl,
        superfreteStatus: ordersTable.superfreteStatus,
        superfreteLabelUrl: ordersTable.superfreteLabelUrl,
        superfreteTracking: ordersTable.superfreteTracking,
        products: ordersTable.products,
      })
      .from(ordersTable)
      .where(and(
        eq(ordersTable.inventoryReserved, false),
        eq(ordersTable.labelDebitWaived, false),
        or(
          sql`${ordersTable.envioecomLabelUrl} is not null and ${ordersTable.envioecomLabelUrl} <> ''`,
          sql`${ordersTable.trackingLabelUrl} is not null and ${ordersTable.trackingLabelUrl} <> ''`,
          sql`${ordersTable.superfreteLabelUrl} is not null and ${ordersTable.superfreteLabelUrl} <> ''`,
          sql`${ordersTable.envioecomStatus} is not null and ${ordersTable.envioecomStatus} <> ''`,
          sql`${ordersTable.superfreteStatus} is not null and ${ordersTable.superfreteStatus} <> ''`,
          eq(ordersTable.enviado, true),
          sql`lower(${ordersTable.shippingType}) like 'motoboy%'`,
        ),
      ))
      .orderBy(desc(ordersTable.updatedAt))
      .limit(400);

    const packages = await db
      .select()
      .from(orderShipmentsTable)
      .where(eq(orderShipmentsTable.inventoryReserved, false))
      .orderBy(desc(orderShipmentsTable.updatedAt))
      .limit(400);

    const missingOrderIds = [...new Set(packages.map((pkg) => pkg.orderId))]
      .filter((id) => !orders.some((order) => order.id === id));
    const extraOrders = missingOrderIds.length === 0
      ? []
      : await db
        .select({
          id: ordersTable.id,
          orderNumber: ordersTable.orderNumber,
          clientName: ordersTable.clientName,
          status: ordersTable.status,
          sellerCode: ordersTable.sellerCode,
          shippingType: ordersTable.shippingType,
          enviado: ordersTable.enviado,
          inventoryReserved: ordersTable.inventoryReserved,
          labelDebitWaived: ordersTable.labelDebitWaived,
          envioecomAccountId: ordersTable.envioecomAccountId,
          envioecomStatus: ordersTable.envioecomStatus,
          envioecomLabelUrl: ordersTable.envioecomLabelUrl,
          envioecomBarcode: ordersTable.envioecomBarcode,
          trackingCode: ordersTable.trackingCode,
          trackingLabelUrl: ordersTable.trackingLabelUrl,
          superfreteStatus: ordersTable.superfreteStatus,
          superfreteLabelUrl: ordersTable.superfreteLabelUrl,
          superfreteTracking: ordersTable.superfreteTracking,
          products: ordersTable.products,
        })
        .from(ordersTable)
        .where(inArray(ordersTable.id, missingOrderIds));
    const allOrders = [...orders, ...extraOrders];

    const countedIds = allOrders.map((order) => order.id);
    const packageTotals = countedIds.length === 0
      ? []
      : await db
        .select({ orderId: orderShipmentsTable.orderId, total: count() })
        .from(orderShipmentsTable)
        .where(inArray(orderShipmentsTable.orderId, countedIds))
        .groupBy(orderShipmentsTable.orderId);
    const countByOrder = new Map(packageTotals.map((row) => [row.orderId, Number(row.total) || 0]));
    const orderById = new Map(allOrders.map((order) => [order.id, order]));

    const rows: Array<{
      lane: LabelDebitLane;
      orderId: string;
      orderNumber: number | null;
      clientName: string;
      packageId: string | null;
      statusLabel: string;
      code: string;
      items: ItemLine[];
    }> = [];

    const push = (lane: LabelDebitLane | null, row: (typeof rows)[number]) => {
      if (!lane) return;
      rows.push({ ...row, lane });
    };

    for (const order of orders) {
      if (!sellerMatches(scope, order.sellerCode)) continue;
      const accountId = String(order.envioecomAccountId || "");
      const candidate: LabelDebitCandidate = {
        cancelled: CANCELLED.has(String(order.status || "").toLowerCase()),
        inventoryReserved: !!order.inventoryReserved,
        waived: !!order.labelDebitWaived,
        isPackage: false,
        packageCount: countByOrder.get(order.id) || 0,
        shippingType: order.shippingType,
        enviado: order.enviado,
        accountPool: inventoryPoolForEnvioEcomAccount(accountId, accountName.get(accountId)),
        envioecomStatus: order.envioecomStatus,
        envioecomLabelUrl: order.envioecomLabelUrl,
        trackingLabelUrl: order.trackingLabelUrl,
        superfreteStatus: order.superfreteStatus,
        superfreteLabelUrl: order.superfreteLabelUrl,
      };
      push(labelDebitLane(candidate), {
        lane: "motoboy",
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        clientName: order.clientName,
        packageId: null,
        statusLabel: String(order.envioecomStatus || order.superfreteStatus || (order.enviado ? "Enviado" : "Etiqueta")),
        code: String(order.envioecomBarcode || order.superfreteTracking || order.trackingCode || ""),
        items: parseItems(order.products),
      });
    }

    for (const pkg of packages) {
      const order = orderById.get(pkg.orderId);
      if (!order || !sellerMatches(scope, order.sellerCode)) continue;
      const accountId = String(pkg.envioecomAccountId || order.envioecomAccountId || "");
      const candidate: LabelDebitCandidate = {
        cancelled: CANCELLED.has(String(order.status || "").toLowerCase()),
        inventoryReserved: !!pkg.inventoryReserved,
        waived: !!pkg.labelDebitWaived,
        isPackage: true,
        packageCount: countByOrder.get(pkg.orderId) || 1,
        shippingType: order.shippingType,
        enviado: pkg.enviado || order.enviado,
        accountPool: inventoryPoolForEnvioEcomAccount(accountId, accountName.get(accountId)),
        packagePool: pkg.inventoryPool,
        envioecomStatus: pkg.envioecomStatus,
        envioecomLabelUrl: pkg.envioecomLabelUrl,
        superfreteStatus: pkg.superfreteStatus,
        superfreteLabelUrl: pkg.superfreteLabelUrl,
        manualTrackingCode: pkg.manualTrackingCode,
      };
      push(labelDebitLane(candidate), {
        lane: "motoboy",
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        clientName: order.clientName,
        packageId: pkg.id,
        statusLabel: String(pkg.envioecomStatus || pkg.superfreteStatus || pkg.manualTrackingCode || "Pacote"),
        code: String(pkg.envioecomBarcode || pkg.superfreteTracking || pkg.manualTrackingCode || ""),
        items: parseItems(pkg.items),
      });
    }

    const coveredByPackage = new Set(rows.filter((row) => row.packageId).map((row) => row.orderId));
    res.json({
      rows: rows.filter((row) => row.packageId || !coveredByPackage.has(row.orderId)),
    });
  } catch (err) {
    console.error("List label debits error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao listar etiquetas sem baixa." });
  }
});

router.post("/admin/inventory/label-debits", requireAdminAuth, async (req, res) => {
  try {
    const scope = scopeOf(req, res);
    if (!scope) return;

    const body = req.body as { orderId?: string; packageId?: string; mode?: string; password?: string; senha?: string };
    const orderId = String(body.orderId || "").trim();
    const packageId = String(body.packageId || "").trim();
    const mode = body.mode === "waive" ? "waive" : body.mode === "debit" ? "debit" : "";
    const lane = body && (req.body as { lane?: LabelDebitLane }).lane;
    if (!orderId || (mode !== "debit" && mode !== "waive") || (lane !== "motoboy" && lane !== "sao_paulo" && lane !== "minas")) {
      res.status(400).json({ error: "INVALID_INPUT", message: "Informe o pedido, a aba e se a baixa abate o estoque." });
      return;
    }

    const where = scope.hasGlobalAccess
      ? eq(ordersTable.id, orderId)
      : and(eq(ordersTable.id, orderId), eq(ordersTable.sellerCode, scope.sellerCode || ""));
    const found = await db.select().from(ordersTable).where(where).limit(1);
    const order = found[0];
    if (!order) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }

    const pool = labelDebitStockPool(lane);
    if (mode === "waive") {
      if (packageId) {
        const pkg = await getOrderShipment(order.id, packageId);
        if (!pkg) {
          res.status(404).json({ error: "NOT_FOUND", message: "Pacote não encontrado neste pedido." });
          return;
        }
        await updateOrderShipment(pkg.id, { labelDebitWaived: true });
      } else {
        await db.update(ordersTable).set({
          labelDebitWaived: true,
          updatedAt: new Date(),
        }).where(eq(ordersTable.id, order.id));
      }
      recordAdminActivity(req, order.id, "inventory", "Baixa de etiqueta sem abater estoque", lane);
      res.json({ ok: true, waived: true });
      return;
    }

    if (inventoryExitPasswordApplies(pool)) {
      const access = await authorizeInventoryExit(readPasswordFromBody(body));
      if (!access.ok) {
        res.status(403).json({
          error: access.error,
          message: access.message,
          passwordRequired: true,
        });
        return;
      }
    }

    if (packageId) {
      const pkg = await getOrderShipment(order.id, packageId);
      if (!pkg) {
        res.status(404).json({ error: "NOT_FOUND", message: "Pacote não encontrado neste pedido." });
        return;
      }
      const debit = await ensurePackageInventoryDebited(order, pkg, { forcePool: pool });
      if (!debit.ok) {
        res.status(400).json({
          error: "INSUFFICIENT_STOCK",
          message: debit.details || "Não há estoque suficiente para esta baixa.",
        });
        return;
      }
    } else {
      const debit = await ensureOrderInventoryDebited(order, { forcePool: pool });
      if (!debit.ok) {
        res.status(400).json({
          error: "INSUFFICIENT_STOCK",
          message: debit.details || "Não há estoque suficiente para esta baixa.",
        });
        return;
      }
    }

    recordAdminActivity(req, order.id, "inventory", "Baixa de etiqueta abatendo estoque", lane);
    res.json({ ok: true, reserved: true });
  } catch (err) {
    console.error("Label debit action error:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao registrar a baixa da etiqueta." });
  }
});

export default router;
