import { Router, type IRouter } from "express";
import { getAdminScope, requireAdminAuth } from "./admin-auth";
import { listOrderShipments } from "../lib/order-shipments";
import { isSplitShipmentList } from "../lib/order-shipments-logic";
import {
  composeShopeeRouteMessage,
  creditShopeeRouteWallet,
  loadShopeeRouteOrder,
  markShopeeRouteRequested,
  saveAdminShopeeOrderId,
  sendShopeeRouteWhatsapp,
  shopeeRouteAdminFields,
  shopeeRoutePhone,
} from "../lib/shopee-route";
import { parseAdminShopeeOrderId, selectShopeeRouteProducts } from "../lib/shopee-route-core";

const router: IRouter = Router();

function orderIdFromParams(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").trim();
}

router.post("/admin/orders/:id/shopee-route", requireAdminAuth, async (req, res) => {
  try {
    const scope = getAdminScope(req);
    if (!scope) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sessão inválida." });
      return;
    }
    const order = await loadShopeeRouteOrder(orderIdFromParams(req.params.id), scope);
    if (!order) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }
    const alreadySent = Boolean(order.shopeeRouteRequestedAt) || Boolean(String(order.shopeeOrderId || "").trim());
    if (alreadySent && req.body?.confirm !== true) {
      res.status(409).json({
        error: "CONFIRM_REQUIRED",
        message: "Este pedido já entrou na Rota Shopee. Confirme para enviar de novo.",
      });
      return;
    }
    const phone = shopeeRoutePhone(order.clientPhone);
    if (!phone) {
      res.status(400).json({ error: "INVALID_PHONE", message: "Pedido sem telefone válido para o WhatsApp." });
      return;
    }
    const packages = await listOrderShipments(order.id);
    const selected = selectShopeeRouteProducts({
      split: isSplitShipmentList(packages),
      packageId: req.body?.packageId,
      orderProducts: order.products,
      packages: packages.map((row) => ({ id: row.id, items: row.items })),
    });
    if (!selected.ok) {
      res.status(selected.status).json({ error: selected.error, message: selected.message });
      return;
    }
    const composed = await composeShopeeRouteMessage(order, selected.products);
    if ("error" in composed) {
      res.status(400).json({ error: "SHOPEE_LINK_REQUIRED", message: composed.error });
      return;
    }
    let posted: { ok: true; queued: boolean } | { ok: false; error: string };
    try {
      posted = await sendShopeeRouteWhatsapp({
        order,
        phone,
        message: composed.message,
      });
    } catch {
      console.error("[ShopeeRoute] WhatsApp não respondeu", { orderId: order.id });
      res.status(502).json({ error: "WHATSAPP_FAILED", message: "O WhatsApp não confirmou o envio." });
      return;
    }
    if (!posted.ok) {
      const missing = posted.error === "zapi_not_configured" || posted.error === "not_configured";
      console.warn("[ShopeeRoute] WhatsApp recusou", { orderId: order.id, error: posted.error });
      res.status(missing ? 503 : 502).json({
        error: missing ? "NOT_CONFIGURED" : "WHATSAPP_FAILED",
        message: posted.error === "not_configured"
          ? "Deixe a chave da Rota Shopee em direto. Este envio não usa o n8n."
          : posted.error === "zapi_not_configured"
            ? "Rota Shopee sem a instância do WhatsApp no servidor."
            : "O WhatsApp não confirmou o envio.",
      });
      return;
    }
    const saved = await markShopeeRouteRequested(order, req, {
      packageId: selected.packageId,
      summary: composed.summary,
    });
    res.json({
      ok: true,
      queued: posted.queued,
      order: shopeeRouteAdminFields(saved),
      packageId: selected.packageId,
      shopeeRouteSentAt: saved.shopeeRouteRequestedAt ? saved.shopeeRouteRequestedAt.toISOString() : null,
    });
  } catch {
    console.error("[ShopeeRoute] disparo falhou");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao enviar a Rota Shopee." });
  }
});

router.patch("/admin/orders/:id/shopee-order-id", requireAdminAuth, async (req, res) => {
  try {
    const scope = getAdminScope(req);
    if (!scope) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sessão inválida." });
      return;
    }
    const order = await loadShopeeRouteOrder(orderIdFromParams(req.params.id), scope);
    if (!order) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }
    const parsed = parseAdminShopeeOrderId(req.body?.shopeeOrderId);
    if (!parsed.ok) {
      res.status(400).json({ error: "INVALID_INPUT", message: parsed.message });
      return;
    }
    const saved = await saveAdminShopeeOrderId(order, parsed.id, req);
    res.json({ ok: true, order: shopeeRouteAdminFields(saved) });
  } catch {
    console.error("[ShopeeRoute] ID manual falhou");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao salvar o ID da Shopee." });
  }
});

router.post("/admin/orders/:id/shopee-wallet-credit", requireAdminAuth, async (req, res) => {
  try {
    const scope = getAdminScope(req);
    if (!scope) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sessão inválida." });
      return;
    }
    if (!scope.hasGlobalAccess) {
      res.status(403).json({ error: "FORBIDDEN", message: "Sem permissão para lançar crédito na carteira." });
      return;
    }
    const order = await loadShopeeRouteOrder(orderIdFromParams(req.params.id), scope);
    if (!order) {
      res.status(404).json({ error: "NOT_FOUND", message: "Pedido não encontrado." });
      return;
    }
    const result = await creditShopeeRouteWallet(order, req);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, message: result.message });
      return;
    }
    res.json({
      ok: true,
      already: result.already,
      amount: result.amount,
      userId: result.userId,
      availableCredit: result.availableCredit,
      order: shopeeRouteAdminFields(result.order),
    });
  } catch {
    console.error("[ShopeeRoute] crédito falhou");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro ao lançar o crédito na carteira." });
  }
});

export default router;
