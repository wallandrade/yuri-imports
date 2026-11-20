import assert from "node:assert/strict";
import test from "node:test";

import { FILMAGEM_DELIVERY_TEXT } from "./order-filmagem-whatsapp";
import { planFilmagemDeliveryNotice } from "./order-filmagem-whatsapp";
import { shouldAnnounceOutForDelivery } from "./order-out-for-delivery-whatsapp";

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

test("na saída para entrega o cliente recebe só o texto 2, sem o aviso antigo", () => {
  const plan = planFilmagemDeliveryNotice({
    orderId: "pedido1",
    phone: "5500000000000",
    sellerCode: "yuri",
    now: new Date("2026-11-20T18:00:00.000Z"),
    videoUrl: "https://projeto.vercel.app/filmagem/como-abrir-caixa.mp4",
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.drafts[0]?.message, FILMAGEM_DELIVERY_TEXT);
  assert.equal(plan.drafts[0]?.phone, "5500000000000");
  const joined = plan.drafts.map((draft) => `${draft.message || ""} ${draft.image || ""}`).join("\n");
  assert.equal(joined.includes("Fique de olho para receber"), false);
  assert.equal(joined.includes("🛵"), false);
  assert.equal(joined.includes("Pedido #"), false);
  assert.match(FILMAGEM_DELIVERY_TEXT, /SEU PEDIDO SAIU PARA ENTREGA/);
});
