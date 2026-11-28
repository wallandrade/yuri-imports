import assert from "node:assert/strict";
import test from "node:test";

import { buildOutForDeliveryWhatsappMessage, shouldAnnounceOutForDelivery } from "./order-out-for-delivery-whatsapp";

test("postado, etiqueta, aguardando coleta e entregue não avisam saiu para entrega", () => {
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "Coletado", nextStatus: "Em trânsito", packageKey: "p1" }), false);
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "Envio criado", nextStatus: "Aguardando coleta", packageKey: "p1" }), false);
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "Envio criado", nextStatus: "Etiqueta emitida", packageKey: "p1" }), false);
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "Em trânsito", nextStatus: "Entregue", packageKey: "p1" }), false);
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "released", nextStatus: "posted", packageKey: "p1" }), false);
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "posted", nextStatus: "delivered", packageKey: "p1" }), false);
});

test("saiu para entrega avisa uma vez", () => {
  assert.equal(shouldAnnounceOutForDelivery({ previousStatus: "Em trânsito", nextStatus: "Saiu para entrega", packageKey: "p1" }), true);
  assert.equal(shouldAnnounceOutForDelivery({
    previousStatus: "Postado",
    nextStatus: "Objeto saiu para entrega ao destinatário",
    packageKey: "p1",
  }), true);
  assert.equal(shouldAnnounceOutForDelivery({
    previousStatus: "Saiu para entrega",
    nextStatus: "Saiu para entrega",
    packageKey: "p1",
  }), false);
  assert.equal(shouldAnnounceOutForDelivery({
    previousStatus: "Em trânsito",
    nextStatus: "Saiu para entrega",
    packageKey: "p1",
    alreadySent: ["p1"],
  }), false);
});

test("Fique de olho fica igual ao texto da main", () => {
  const withCode = buildOutForDeliveryWhatsappMessage({
    clientName: "Cliente",
    orderNumber: 10,
    trackingCode: "AB123456789BR",
  });
  assert.equal(withCode, [
    "🛵 *Cliente, seu pedido saiu para entrega!*",
    "",
    "Pedido #10",
    "Código: *AB123456789BR*",
    "",
    "Fique de olho para receber. 📦",
  ].join("\n"));
  assert.equal(withCode.includes("**"), false);

  const withEc = buildOutForDeliveryWhatsappMessage({
    clientName: "Cliente",
    orderNumber: 10,
    trackingCode: "EC123",
  });
  assert.equal(withEc, [
    "🛵 *Cliente, seu pedido saiu para entrega!*",
    "",
    "Pedido #10",
    "",
    "Fique de olho para receber. 📦",
  ].join("\n"));
  assert.equal(withEc.includes("EC123"), false);
});
