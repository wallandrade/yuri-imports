import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { redactAuditPayload } from "./admin-audit-payload";
import { decidePreconfirm, paidSideEffectsIfClaimed, planPaymentReview, resolveApprovalClaim } from "./payment-preconfirm-logic";
import { forbidSellerStaff, sellerStaffMayAccess } from "./seller-staff-access";

const here = path.dirname(fileURLToPath(import.meta.url));

function app() {
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    (req as express.Request & { adminSession?: { role?: string } }).adminSession = {
      role: String(req.header("x-test-role") || "admin"),
    };
    next();
  });
  const gate: express.RequestHandler = (req, res, next) => {
    const role = (req as express.Request & { adminSession?: { role?: string } }).adminSession?.role;
    if (role === "vendedora" && !sellerStaffMayAccess(req.method, req.path)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Sem permissão para esta ação." });
      return;
    }
    next();
  };
  const ok: express.RequestHandler = (_req, res) => {
    res.json({ ok: true });
  };
  api.patch("/admin/products/:id", gate, forbidSellerStaff, ok);
  api.patch("/admin/orders/:id/edit", gate, forbidSellerStaff, ok);
  api.post("/admin/inventory/entries", gate, forbidSellerStaff, ok);
  api.post("/admin/coupons", gate, forbidSellerStaff, ok);
  api.put("/admin/settings/:key", gate, forbidSellerStaff, ok);
  api.patch("/admin/shipping-options/:id", gate, forbidSellerStaff, ok);
  api.get("/admin/orders", gate, ok);
  api.get("/admin/financial-summary", gate, ok);
  api.post("/admin/orders/:id/payment-preconfirm", gate, ok);
  return api;
}

async function statusOf(method: string, urlPath: string, role: string): Promise<number> {
  const server = http.createServer(app());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { "content-type": "application/json", "x-test-role": role },
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
    });
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

test("vendedora toma 403 em preço, desconto, estoque, cupom, configuração e envio", async () => {
  assert.equal(await statusOf("PATCH", "/admin/products/10", "vendedora"), 403);
  assert.equal(await statusOf("PATCH", "/admin/orders/10/edit", "vendedora"), 403);
  assert.equal(await statusOf("POST", "/admin/inventory/entries", "vendedora"), 403);
  assert.equal(await statusOf("POST", "/admin/coupons", "vendedora"), 403);
  assert.equal(await statusOf("PUT", "/admin/settings/gateway_fee_percent", "vendedora"), 403);
  assert.equal(await statusOf("PATCH", "/admin/shipping-options/10", "vendedora"), 403);
  assert.equal(sellerStaffMayAccess("PATCH", "/api/admin/users/1/password"), false);
  assert.equal(sellerStaffMayAccess("POST", "/admin/integrations/inventory/unlock"), false);
});

test("vendedora lê vendas e lucro e só pré-confirma o pagamento", async () => {
  assert.equal(await statusOf("GET", "/admin/orders", "vendedora"), 200);
  assert.equal(await statusOf("GET", "/admin/financial-summary?dateFrom=2026-11-01", "vendedora"), 200);
  assert.equal(await statusOf("POST", "/admin/orders/pedido-1/payment-preconfirm", "vendedora"), 200);
  assert.equal(await statusOf("PATCH", "/admin/products/10", "admin"), 200);
  assert.equal(sellerStaffMayAccess("POST", "/admin/orders/pedido-1/payment-preconfirm/approve"), false);
});

test("pré-confirmar não confirma; aprovar confirma; PIX já pago continua pago", () => {
  const pre = decidePreconfirm({ orderStatus: "awaiting_payment", pendingExists: false });
  assert.equal(pre.ok, true);
  if (!pre.ok) return;
  assert.equal(pre.orderStatusAfter, "awaiting_payment");
  assert.deepEqual([...pre.sideEffects], []);

  const approved = planPaymentReview({
    decision: "approve",
    orderStatus: pre.orderStatusAfter,
    preconfirmStatus: "pending_admin",
  });
  assert.equal("error" in approved, false);
  if ("error" in approved) return;
  assert.equal(approved.confirmPayment, true);
  assert.equal(approved.orderStatusAfter, "paid");
  assert.equal(approved.sideEffects.includes("whatsapp_paid"), true);
  assert.equal(approved.sideEffects.includes("commission"), true);
  assert.equal(approved.sideEffects.includes("promo_stock"), true);

  const oldPix = decidePreconfirm({ orderStatus: "paid", pendingExists: false });
  assert.equal(oldPix.ok, false);
  const completed = decidePreconfirm({ orderStatus: "completed", pendingExists: false });
  assert.equal(completed.ok, false);

  const already = planPaymentReview({
    decision: "approve",
    orderStatus: "paid",
    preconfirmStatus: "pending_admin",
  });
  assert.equal("error" in already, false);
  if ("error" in already) return;
  assert.equal(already.confirmPayment, false);
  assert.equal(already.preconfirmStatus, "rejected");
  assert.equal(already.orderStatusAfter, "paid");
  assert.equal(already.reason, "obsolete");
  assert.deepEqual([...already.sideEffects], []);

  const rejected = planPaymentReview({
    decision: "reject",
    orderStatus: "awaiting_payment",
    preconfirmStatus: "pending_admin",
  });
  assert.equal("error" in rejected, false);
  if ("error" in rejected) return;
  assert.equal(rejected.orderStatusAfter, "awaiting_payment");
  assert.equal(rejected.confirmPayment, false);
  assert.deepEqual([...rejected.sideEffects], []);

  const cancelled = planPaymentReview({
    decision: "approve",
    orderStatus: "cancelled",
    preconfirmStatus: "pending_admin",
  });
  assert.equal("error" in cancelled, false);
  if ("error" in cancelled) return;
  assert.equal(cancelled.confirmPayment, false);
  assert.equal(cancelled.preconfirmStatus, "rejected");
  assert.equal(cancelled.orderStatusAfter, "cancelled");
  assert.equal(cancelled.reason, "obsolete");
  assert.deepEqual([...cancelled.sideEffects], []);
  const cancelado = planPaymentReview({
    decision: "approve",
    orderStatus: "cancelado",
    preconfirmStatus: "pending_admin",
  });
  assert.equal("confirmPayment" in cancelado && cancelado.confirmPayment, false);

  const notAwaiting = planPaymentReview({
    decision: "approve",
    orderStatus: "pending",
    preconfirmStatus: "pending_admin",
  });
  assert.equal("error" in notAwaiting, false);
  if ("error" in notAwaiting) return;
  assert.equal(notAwaiting.confirmPayment, false);
  assert.equal(notAwaiting.orderStatusAfter, "pending");
  assert.equal(notAwaiting.reason, "obsolete");

  const lost = resolveApprovalClaim({
    decision: "approve",
    orderStatus: "awaiting_payment",
    preconfirmRowsAffected: 0,
    orderRowsAffected: 1,
  });
  assert.equal(lost.statusCode, 409);
  assert.equal(lost.runSideEffects, false);
  assert.equal(lost.reason, "lost_race");

  const orderMoved = resolveApprovalClaim({
    decision: "approve",
    orderStatus: "cancelled",
    preconfirmRowsAffected: 1,
    orderRowsAffected: 0,
  });
  assert.equal(orderMoved.statusCode, 409);
  assert.equal(orderMoved.runSideEffects, false);
  assert.equal(orderMoved.preconfirmStatus, "rejected");
  assert.equal(orderMoved.orderStatusAfter, "cancelled");
  assert.deepEqual([...paidSideEffectsIfClaimed(orderMoved.runSideEffects)], []);

  const won = resolveApprovalClaim({
    decision: "approve",
    orderStatus: "awaiting_payment",
    preconfirmRowsAffected: 1,
    orderRowsAffected: 1,
  });
  assert.equal(won.statusCode, 200);
  assert.equal(won.runSideEffects, true);
  assert.equal(won.orderStatusAfter, "paid");
  assert.equal(paidSideEffectsIfClaimed(false).includes("whatsapp_paid"), false);
  assert.equal(paidSideEffectsIfClaimed(won.runSideEffects).includes("whatsapp_paid"), true);
  assert.equal(paidSideEffectsIfClaimed(won.runSideEffects).includes("coupon_use"), true);
  assert.equal(paidSideEffectsIfClaimed(won.runSideEffects).includes("commission"), true);
  assert.equal(paidSideEffectsIfClaimed(won.runSideEffects).includes("promo_stock"), true);
});

test("auditoria não guarda senha nem token e não tem rota de editar ou apagar", () => {
  const cleaned = redactAuditPayload({
    password: "segredo",
    token: "abc",
    authorization: "Bearer abc",
    note: "comprovante ok",
    pixCode: "000201",
  }) as Record<string, unknown>;
  assert.equal(cleaned.password, "[REDACTED]");
  assert.equal(cleaned.token, "[REDACTED]");
  assert.equal(cleaned.authorization, "[REDACTED]");
  assert.equal(cleaned.pixCode, "[REDACTED]");
  assert.equal(cleaned.note, "comprovante ok");

  const route = readFileSync(path.join(here, "../routes/admin-audit.ts"), "utf8");
  assert.equal(/router\.(patch|put|delete)\(/.test(route), false);
  assert.equal(route.includes('router.get("/admin/audit-log"'), true);
});

test("migration não reescreve status de pedido", () => {
  const sql = readFileSync(
    path.join(here, "../../../../scripts/migrations/2026-11-27-vendedora-preconfirmacao-auditoria.sql"),
    "utf8",
  );
  assert.equal(/update\s+orders/i.test(sql), false);
  assert.equal(/delete\s+from\s+orders/i.test(sql), false);
  assert.equal(sql.includes("CREATE TABLE IF NOT EXISTS admin_user_roles"), true);
  assert.equal(sql.includes("CREATE TABLE IF NOT EXISTS order_payment_preconfirms"), true);
  assert.equal(sql.includes("CREATE TABLE IF NOT EXISTS admin_audit_log"), true);
  assert.equal(sql.includes("GENERATED ALWAYS AS (IF(status = 'pending_admin', order_id, NULL)) STORED"), true);
  assert.equal(sql.includes("UNIQUE KEY uniq_preconfirm_pending_order (pending_order_id)"), true);
  assert.equal(/alter\s+table\s+orders/i.test(sql), false);
});
