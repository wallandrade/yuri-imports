import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, orderPaymentPreconfirmsTable, ordersTable } from "@workspace/db";
import { getAdminScope, requireAdminAuth, requirePrimaryAdmin } from "./admin-auth";
import { isSellerStaffRole } from "../lib/seller-staff-access";
import { decidePreconfirm, planPaymentReview } from "../lib/payment-preconfirm-logic";
import { isMissingSchemaError } from "../lib/admin-user-access";
import { writeAdminAuditFromRequest } from "../lib/admin-audit";
import { clientIpFromRequest } from "../lib/admin-audit-payload";
import { incrementCouponUse } from "./coupons";
import { ensureOrderCommission } from "../lib/affiliates";
import { consumePromoStockForPaidOrder } from "../lib/promo-stock";
import { allocateShippingSlot, isStandardShipping } from "../lib/shipping-queue-allocator";
import { broadcastNotification } from "./notifications";
import { sendOutboundWebhook } from "../lib/outbound-webhook";
import { queueOrderPaidWhatsapp } from "../lib/order-paid-whatsapp";
import { queueReportanaOrderSync } from "../lib/reportana";
import { recordAdminActivity } from "../lib/order-activity";

const router: IRouter = Router();
const NOTE_MAX = 2000;
const PROOF_MAX = 1_500_000;

function routeId(value: string | string[]): string {
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function schemaFailure(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): boolean {
  if (!isMissingSchemaError(err)) return false;
  res.status(503).json({
    error: "MIGRATION_REQUIRED",
    message: "Falta aplicar a migration da vendedora. Nenhum pedido foi alterado.",
  });
  return true;
}

/**
 * Efeitos da confirmação real. Só roda quando o admin principal aprova
 * um pedido que ainda não está pago. A pré-confirmação não chama isto.
 * Ponto de extensão: um aviso extra pela Z-API poderia entrar depois da aprovação.
 * Esta versão não envia mensagem nenhuma na pré-confirmação.
 */
async function confirmOrderPaidByAdmin(orderId: string, order: {
  status: string;
  couponCode: string | null;
  total: string;
  paidAmount: string | null;
  clientName: string;
  shippingType: string;
  proofUrl: string | null;
}, proofUrl: string | null): Promise<{ alreadyPaid: boolean }> {
  const current = String(order.status || "").trim().toLowerCase();
  if (current === "paid" || current === "completed") return { alreadyPaid: true };

  const currentTotal = Number(order.total ?? 0);
  const currentPaid = Number(order.paidAmount ?? 0);
  const reconciled = Math.max(currentPaid, currentTotal);
  const updates: Record<string, unknown> = { status: "paid", updatedAt: new Date() };
  if (reconciled > 0) updates.paidAmount = String(reconciled);
  if (proofUrl && !order.proofUrl) updates.proofUrl = proofUrl;

  await db.update(ordersTable).set(updates).where(eq(ordersTable.id, orderId));

  if (order.couponCode) await incrementCouponUse(order.couponCode);
  await ensureOrderCommission(orderId);
  await consumePromoStockForPaidOrder(orderId);
  if (isStandardShipping(String(order.shippingType || ""))) {
    void allocateShippingSlot(orderId);
  }
  broadcastNotification({ type: "order_status_updated", data: { id: orderId, status: "paid" } });
  void sendOutboundWebhook("order_paid", {
    id: orderId,
    status: "paid",
    clientName: order.clientName,
    total: order.total,
    source: "admin_preconfirm_approval",
  });
  await queueOrderPaidWhatsapp(orderId, true);
  queueReportanaOrderSync(orderId);
  return { alreadyPaid: false };
}

router.get("/admin/orders/payment-preconfirms", requirePrimaryAdmin, async (req, res) => {
  try {
    getAdminScope(req);
    const status = String(req.query.status || "pending_admin");
    const allowed = status === "all" ? null : (status === "approved" || status === "rejected" ? status : "pending_admin");
    const rows = allowed
      ? await db
        .select()
        .from(orderPaymentPreconfirmsTable)
        .where(eq(orderPaymentPreconfirmsTable.status, allowed))
        .orderBy(asc(orderPaymentPreconfirmsTable.createdAt))
        .limit(200)
      : await db
        .select()
        .from(orderPaymentPreconfirmsTable)
        .orderBy(desc(orderPaymentPreconfirmsTable.createdAt))
        .limit(200);

    const orderIds = Array.from(new Set(rows.map((row) => row.orderId)));
    const orders = orderIds.length
      ? await db
        .select({
          id: ordersTable.id,
          orderNumber: ordersTable.orderNumber,
          clientName: ordersTable.clientName,
          total: ordersTable.total,
          status: ordersTable.status,
        })
        .from(ordersTable)
        .where(inArray(ordersTable.id, orderIds))
      : [];
    const byId = new Map(orders.map((order) => [order.id, order]));

    res.json({
      items: rows.map((row) => {
        const order = byId.get(row.orderId);
        return {
          id: row.id,
          orderId: row.orderId,
          status: row.status,
          confirmedBy: row.confirmedBy,
          confirmedAt: row.confirmedAt,
          note: row.note,
          hasProof: Boolean(row.proofUrl),
          proofUrl: row.proofUrl,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          reviewNote: row.reviewNote,
          orderNumber: order?.orderNumber ?? null,
          clientName: order?.clientName ?? null,
          total: order?.total ?? null,
          orderStatus: order?.status ?? null,
        };
      }),
    });
  } catch (err) {
    if (schemaFailure(res, err)) return;
    console.error("[preconfirm] list error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao listar pré-confirmações." });
  }
});

router.post("/admin/orders/:id/payment-preconfirm", requireAdminAuth, async (req, res) => {
  const scope = getAdminScope(req);
  if (!scope || !isSellerStaffRole(scope.role)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Só a vendedora pode pré-confirmar." });
    return;
  }

  const orderId = routeId(req.params.id);
  const body = (req.body || {}) as { note?: string; proofUrl?: string };
  const note = String(body.note || "").trim();
  const proofUrl = String(body.proofUrl || "").trim();
  if (note.length > NOTE_MAX) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Observação longa demais." });
    return;
  }
  if (proofUrl.length > PROOF_MAX) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Comprovante grande demais." });
    return;
  }

  try {
    const existingOrder = await db
      .select({
        id: ordersTable.id,
        status: ordersTable.status,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (!existingOrder[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }

    const pending = await db
      .select({ id: orderPaymentPreconfirmsTable.id })
      .from(orderPaymentPreconfirmsTable)
      .where(and(
        eq(orderPaymentPreconfirmsTable.orderId, orderId),
        eq(orderPaymentPreconfirmsTable.status, "pending_admin"),
      ))
      .limit(1);

    const decision = decidePreconfirm({
      orderStatus: existingOrder[0].status,
      pendingExists: Boolean(pending[0]),
    });
    if (!decision.ok) {
      res.status(409).json({ error: decision.error, message: decision.message });
      return;
    }

    const id = crypto.randomBytes(16).toString("hex");
    const confirmedAt = new Date();
    await db.insert(orderPaymentPreconfirmsTable).values({
      id,
      orderId,
      status: "pending_admin",
      confirmedBy: scope.username,
      confirmedAt,
      note: note || null,
      proofUrl: proofUrl || null,
    });

    const audit = await writeAdminAuditFromRequest(req, {
      actorUsername: scope.username,
      actorRole: "vendedora",
      action: "payment_preconfirm",
      entityType: "order",
      entityId: orderId,
      before: { orderStatus: existingOrder[0].status, preconfirm: null },
      after: {
        orderStatus: existingOrder[0].status,
        preconfirm: { id, status: "pending_admin", note: note || null, hasProof: Boolean(proofUrl) },
      },
    });
    if (audit !== "ok") {
      await db.delete(orderPaymentPreconfirmsTable).where(eq(orderPaymentPreconfirmsTable.id, id));
      res.status(503).json({
        error: "AUDIT_FAILED",
        message: "Não foi possível registrar a auditoria. Nada foi pré-confirmado.",
      });
      return;
    }

    recordAdminActivity(
      req,
      orderId,
      "payment_preconfirm",
      "Pré-confirmou o pagamento",
      note || "Aguardando o admin principal",
    );
    res.status(201).json({
      ok: true,
      id,
      orderId,
      status: "pending_admin",
      orderStatus: existingOrder[0].status,
      confirmedBy: scope.username,
      confirmedAt,
    });
  } catch (err) {
    if (schemaFailure(res, err)) return;
    console.error("[preconfirm] create error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao pré-confirmar." });
  }
});

async function review(req: Request, res: Response, decision: "approve" | "reject") {
  const scope = getAdminScope(req);
  if (!scope?.isPrimary) {
    res.status(403).json({ error: "FORBIDDEN", message: "Apenas o administrador principal pode revisar." });
    return;
  }
  const orderId = routeId(req.params.id);
  const reviewNote = String((req.body as { note?: string } | undefined)?.note || "").trim().slice(0, NOTE_MAX);

  try {
    const pending = await db
      .select()
      .from(orderPaymentPreconfirmsTable)
      .where(and(
        eq(orderPaymentPreconfirmsTable.orderId, orderId),
        eq(orderPaymentPreconfirmsTable.status, "pending_admin"),
      ))
      .orderBy(desc(orderPaymentPreconfirmsTable.createdAt))
      .limit(1);
    if (!pending[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Não há pré-confirmação pendente neste pedido." });
      return;
    }

    const orderRows = await db
      .select({
        id: ordersTable.id,
        status: ordersTable.status,
        couponCode: ordersTable.couponCode,
        total: ordersTable.total,
        paidAmount: ordersTable.paidAmount,
        clientName: ordersTable.clientName,
        shippingType: ordersTable.shippingType,
        proofUrl: ordersTable.proofUrl,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (!orderRows[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }

    const plan = planPaymentReview({
      decision,
      orderStatus: orderRows[0].status,
      preconfirmStatus: pending[0].status,
    });
    if ("error" in plan) {
      res.status(409).json({ error: plan.error, message: plan.message });
      return;
    }

    const before = {
      orderStatus: orderRows[0].status,
      preconfirmStatus: pending[0].status,
    };

    if (plan.confirmPayment) {
      await confirmOrderPaidByAdmin(orderId, orderRows[0], pending[0].proofUrl);
      recordAdminActivity(req, orderId, "status", "Aprovou a pré-confirmação e marcou como pago", `De ${orderRows[0].status} para paid`);
    } else if (plan.reason === "rejected") {
      recordAdminActivity(req, orderId, "payment_preconfirm", "Rejeitou a pré-confirmação", reviewNote || "Sem observação");
    } else {
      recordAdminActivity(req, orderId, "payment_preconfirm", "A pré-confirmação encontrou o pedido já pago", "Status do pedido não foi alterado");
    }

    const reviewedAt = new Date();
    await db.update(orderPaymentPreconfirmsTable).set({
      status: plan.preconfirmStatus,
      reviewedBy: scope.username,
      reviewedAt,
      reviewNote: reviewNote || (plan.reason === "already_paid" ? "Pedido já estava pago. Nada foi reconfirmado." : null),
    }).where(eq(orderPaymentPreconfirmsTable.id, pending[0].id));

    await writeAdminAuditFromRequest(req, {
      actorUsername: scope.username,
      actorRole: "admin",
      action: decision === "approve" ? "payment_preconfirm_approve" : "payment_preconfirm_reject",
      entityType: "order",
      entityId: orderId,
      ip: clientIpFromRequest(req),
      before,
      after: {
        orderStatus: plan.orderStatusAfter,
        preconfirmStatus: plan.preconfirmStatus,
        confirmPayment: plan.confirmPayment,
        reason: plan.reason,
      },
    });

    res.json({
      ok: true,
      orderId,
      preconfirmStatus: plan.preconfirmStatus,
      orderStatus: plan.orderStatusAfter,
      confirmPayment: plan.confirmPayment,
      reason: plan.reason,
    });
  } catch (err) {
    if (schemaFailure(res, err)) return;
    console.error("[preconfirm] review error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao revisar a pré-confirmação." });
  }
}

router.post("/admin/orders/:id/payment-preconfirm/approve", requirePrimaryAdmin, async (req, res) => {
  await review(req, res, "approve");
});

router.post("/admin/orders/:id/payment-preconfirm/reject", requirePrimaryAdmin, async (req, res) => {
  await review(req, res, "reject");
});

export default router;
