import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, orderPaymentPreconfirmsTable, ordersTable } from "@workspace/db";
import { getAdminScope, requireAdminAuth, requirePrimaryAdmin } from "./admin-auth";
import { isSellerStaffRole } from "../lib/seller-staff-access";
import {
  APPROVAL_ELIGIBLE_STATUSES,
  decidePreconfirm,
  isApprovalEligibleStatus,
  preconfirmListIncludesProof,
  preconfirmListProducts,
  preconfirmListProofFields,
  resolveApprovalClaim,
} from "../lib/payment-preconfirm-logic";
import { mysqlAffectedRows } from "../lib/mysql-affected-rows";
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

function isDuplicateKeyError(err: unknown): boolean {
  const record = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = String(record?.code || record?.cause?.code || "");
  const message = String(record?.message || record?.cause?.message || "");
  return code === "ER_DUP_ENTRY" || /duplicate/i.test(message);
}

function schemaFailure(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): boolean {
  if (!isMissingSchemaError(err)) return false;
  res.status(503).json({
    error: "MIGRATION_REQUIRED",
    message: "Falta aplicar a migration da vendedora. Nenhum pedido foi alterado.",
  });
  return true;
}

type PaidOrderSnapshot = {
  couponCode: string | null;
  total: string;
  clientName: string;
  shippingType: string;
};

/**
 * Efeitos da confirmação real. Só é chamada depois do commit, e só quando
 * o UPDATE do pedido afetou 1 linha. A pré-confirmação não chama isto.
 * Ponto de extensão: um aviso extra pela Z-API poderia entrar depois da aprovação.
 * Esta versão não envia mensagem nenhuma na pré-confirmação.
 */
async function runPaidSideEffects(orderId: string, order: PaidOrderSnapshot): Promise<void> {
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
}

router.get("/admin/orders/payment-preconfirms", requirePrimaryAdmin, async (req, res) => {
  try {
    getAdminScope(req);
    const status = String(req.query.status || "pending_admin");
    const includeProof = preconfirmListIncludesProof(req.query.includeProof);
    const allowed = status === "all" ? null : (status === "approved" || status === "rejected" ? status : "pending_admin");
    const columns = {
      id: orderPaymentPreconfirmsTable.id,
      orderId: orderPaymentPreconfirmsTable.orderId,
      status: orderPaymentPreconfirmsTable.status,
      confirmedBy: orderPaymentPreconfirmsTable.confirmedBy,
      confirmedAt: orderPaymentPreconfirmsTable.confirmedAt,
      note: orderPaymentPreconfirmsTable.note,
      reviewedBy: orderPaymentPreconfirmsTable.reviewedBy,
      reviewedAt: orderPaymentPreconfirmsTable.reviewedAt,
      reviewNote: orderPaymentPreconfirmsTable.reviewNote,
      createdAt: orderPaymentPreconfirmsTable.createdAt,
      hasProof: sql<number>`(${orderPaymentPreconfirmsTable.proofUrl} IS NOT NULL)`.as("has_proof"),
      proofUrl: includeProof
        ? orderPaymentPreconfirmsTable.proofUrl
        : sql<string | null>`NULL`.as("proof_url"),
    };
    const rows = allowed
      ? await db
        .select(columns)
        .from(orderPaymentPreconfirmsTable)
        .where(eq(orderPaymentPreconfirmsTable.status, allowed))
        .orderBy(asc(orderPaymentPreconfirmsTable.createdAt))
        .limit(200)
      : await db
        .select(columns)
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
          createdAt: ordersTable.createdAt,
          products: ordersTable.products,
        })
        .from(ordersTable)
        .where(inArray(ordersTable.id, orderIds))
      : [];
    const byId = new Map(orders.map((order) => [order.id, order]));

    res.json({
      items: rows.map((row) => {
        const order = byId.get(row.orderId);
        const proof = preconfirmListProofFields(includeProof, row.proofUrl, Boolean(Number(row.hasProof)));
        return {
          id: row.id,
          orderId: row.orderId,
          status: row.status,
          confirmedBy: row.confirmedBy,
          confirmedAt: row.confirmedAt,
          note: row.note,
          hasProof: proof.hasProof,
          proofUrl: proof.proofUrl,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          reviewNote: row.reviewNote,
          orderNumber: order?.orderNumber ?? null,
          clientName: order?.clientName ?? null,
          total: order?.total ?? null,
          orderStatus: order?.status ?? null,
          orderCreatedAt: order?.createdAt ?? null,
          products: preconfirmListProducts(order?.products),
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
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "ALREADY_PENDING", message: "Já existe uma pré-confirmação aguardando o admin." });
      return;
    }
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

    const order = orderRows[0];
    const beforeStatus = order.status;
    const reviewedAt = new Date();
    const eligible = decision === "approve" && isApprovalEligibleStatus(order.status);
    const obsoleteNote = "Pedido não está pendente de pagamento. Pré-confirmação obsoleta.";
    const nextPreconfirmStatus = decision === "reject" || !eligible ? "rejected" : "approved";

    const claim = await db.transaction(async (tx) => {
      const preResult = await tx.update(orderPaymentPreconfirmsTable).set({
        status: nextPreconfirmStatus,
        reviewedBy: scope.username,
        reviewedAt,
        reviewNote: reviewNote || (eligible ? null : obsoleteNote),
      }).where(and(
        eq(orderPaymentPreconfirmsTable.id, pending[0].id),
        eq(orderPaymentPreconfirmsTable.status, "pending_admin"),
      ));
      const preconfirmRowsAffected = mysqlAffectedRows(preResult);
      if (preconfirmRowsAffected !== 1 || !eligible) {
        return { preconfirmRowsAffected, orderRowsAffected: 0 };
      }

      const currentTotal = Number(order.total ?? 0);
      const currentPaid = Number(order.paidAmount ?? 0);
      const reconciled = Math.max(currentPaid, currentTotal);
      const updates: Record<string, unknown> = { status: "paid", updatedAt: new Date() };
      if (reconciled > 0) updates.paidAmount = String(reconciled);
      if (pending[0].proofUrl && !order.proofUrl) updates.proofUrl = pending[0].proofUrl;

      const orderResult = await tx.update(ordersTable).set(updates).where(and(
        eq(ordersTable.id, orderId),
        inArray(ordersTable.status, [...APPROVAL_ELIGIBLE_STATUSES]),
      ));
      const orderRowsAffected = mysqlAffectedRows(orderResult);
      if (orderRowsAffected !== 1) {
        await tx.update(orderPaymentPreconfirmsTable).set({
          status: "rejected",
          reviewNote: reviewNote || obsoleteNote,
        }).where(eq(orderPaymentPreconfirmsTable.id, pending[0].id));
      }
      return { preconfirmRowsAffected, orderRowsAffected };
    });

    const resolution = resolveApprovalClaim({
      decision,
      orderStatus: beforeStatus,
      preconfirmRowsAffected: claim.preconfirmRowsAffected,
      orderRowsAffected: claim.orderRowsAffected,
    });

    if (resolution.runSideEffects) {
      await runPaidSideEffects(orderId, order);
      recordAdminActivity(req, orderId, "status", "Aprovou a pré-confirmação e marcou como pago", `De ${beforeStatus} para paid`);
    } else if (resolution.reason === "rejected") {
      recordAdminActivity(req, orderId, "payment_preconfirm", "Rejeitou a pré-confirmação", reviewNote || "Sem observação");
    } else if (resolution.reason === "obsolete") {
      recordAdminActivity(req, orderId, "payment_preconfirm", "Encerrou a pré-confirmação sem confirmar", obsoleteNote);
    }

    if (resolution.reason !== "lost_race") {
      await writeAdminAuditFromRequest(req, {
        actorUsername: scope.username,
        actorRole: "admin",
        action: resolution.reason === "confirm"
          ? "payment_preconfirm_approve"
          : resolution.reason === "rejected"
            ? "payment_preconfirm_reject"
            : "payment_preconfirm_obsolete",
        entityType: "order",
        entityId: orderId,
        ip: clientIpFromRequest(req),
        before: { orderStatus: beforeStatus, preconfirmStatus: "pending_admin" },
        after: {
          orderStatus: resolution.orderStatusAfter,
          preconfirmStatus: resolution.preconfirmStatus,
          confirmPayment: resolution.runSideEffects,
          reason: resolution.reason,
        },
      });
    }

    res.status(resolution.statusCode).json({
      ok: resolution.statusCode === 200,
      error: resolution.statusCode === 409
        ? (resolution.reason === "lost_race" ? "NOT_PENDING" : "NOT_ELIGIBLE")
        : undefined,
      orderId,
      message: resolution.message,
      preconfirmStatus: resolution.preconfirmStatus,
      orderStatus: resolution.orderStatusAfter,
      confirmPayment: resolution.runSideEffects,
      reason: resolution.reason,
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
