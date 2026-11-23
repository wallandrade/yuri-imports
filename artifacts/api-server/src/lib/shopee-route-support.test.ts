import assert from "node:assert/strict";
import test from "node:test";
import {
  executeShopeeRouteInbound,
  handleShopeeOnSupportMessage,
  type ShopeeRouteInboundOrder,
  type ShopeeRouteInboundStore,
} from "./shopee-route-support";

const PHONE = "5500000000000";

function blank(id: string, phone = PHONE): ShopeeRouteInboundOrder {
  return {
    id,
    orderNumber: 10,
    clientPhone: phone,
    shopeeRouteRequestedAt: new Date("2026-11-23T12:00:00Z"),
    shopeeOrderId: null,
    shopeeRouteReviewReason: null,
    shopeeWalletCreditedAt: null,
    enviado: false,
    inventoryReserved: false,
  };
}

function memoryStore(seed: ShopeeRouteInboundOrder[]): ShopeeRouteInboundStore & { rows: ShopeeRouteInboundOrder[]; events: string[] } {
  const rows = seed.map((row) => ({ ...row }));
  const events: string[] = [];
  return {
    rows,
    events,
    async listAwaiting() {
      return rows.filter((row) => row.shopeeRouteRequestedAt && !String(row.shopeeOrderId || "").trim());
    },
    async listByShopeeOrderId(id) {
      return rows.filter((row) => row.shopeeOrderId === id);
    },
    async reload(id) {
      return rows.find((row) => row.id === id) || null;
    },
    async assignShopeeOrderId(id, shopeeOrderId) {
      const row = rows.find((item) => item.id === id);
      if (!row) return;
      row.shopeeOrderId = shopeeOrderId;
      row.shopeeRouteReviewReason = null;
    },
    async markReview(id, motivo) {
      const row = rows.find((item) => item.id === id);
      if (!row || row.shopeeRouteReviewReason === motivo) return { changed: false };
      row.shopeeRouteReviewReason = motivo;
      return { changed: true };
    },
    async markEnviado(id) {
      const row = rows.find((item) => item.id === id);
      if (!row || row.enviado) return { already: true };
      row.enviado = true;
      return { already: false };
    },
    async addEvent(event) {
      events.push(`${event.orderId}:${event.action}`);
    },
  };
}

test("ID válido marca enviado sem mexer no estoque", async () => {
  const store = memoryStore([blank("a")]);
  const result = await executeShopeeRouteInbound({ telefone: "5500000000000", texto: "241116ABCDEFGH" }, store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ja_processado, false);
  assert.equal(store.rows[0]?.enviado, true);
  assert.equal(store.rows[0]?.inventoryReserved, false);
  assert.equal(store.rows[0]?.shopeeOrderId, "241116ABCDEFGH");
  assert.match(result.mensagem_para_cliente, /241116ABCDEFGH/);
});

test("o mesmo ID de novo não pede outra resposta", async () => {
  const row = blank("a");
  row.shopeeOrderId = "241116ABCDEFGH";
  row.shopeeRouteRequestedAt = null;
  row.enviado = true;
  const store = memoryStore([row]);
  const result = await executeShopeeRouteInbound({ telefone: PHONE, texto: "241116ABCDEFGH" }, store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ja_processado, true);
  assert.equal(store.rows[0]?.inventoryReserved, false);
});

test("dois pedidos no mesmo telefone vão para revisão", async () => {
  const store = memoryStore([blank("a", "11999990000"), blank("b", "5511999990000")]);
  const result = await executeShopeeRouteInbound({ telefone: "5511999990000", texto: "241116ABCDEFGH" }, store);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.motivo, "varios_pedidos");
  assert.equal(store.rows[0]?.shopeeRouteReviewReason, "varios_pedidos");
  assert.equal(store.rows[0]?.enviado, false);
  assert.equal(store.rows[0]?.inventoryReserved, false);
});

test("telefone com e sem o 9 casa o pedido que espera o ID", async () => {
  const store = memoryStore([blank("a", "1188887777")]);
  const result = await executeShopeeRouteInbound({ telefone: "5511988887777", texto: "241116123456789012" }, store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.rows[0]?.shopeeOrderId, "241116123456789012");
});

test("ID repetido no atendimento não responde de novo", async () => {
  let sent = 0;
  const outcome = await handleShopeeOnSupportMessage({
    phone: PHONE,
    text: { message: "241116ABCDEFGH" },
  }, {
    hasAwaiting: async () => true,
    receive: async () => ({ ok: true, ja_processado: true, mensagem_para_cliente: "nao" }),
    send: async () => {
      sent += 1;
      return true;
    },
  });
  assert.equal(outcome, "stop");
  assert.equal(sent, 0);
});

test("confirmação sai e, se o envio falha, o menu segue", async () => {
  const sent: string[] = [];
  const ok = await handleShopeeOnSupportMessage({
    phone: PHONE,
    text: { message: "241116ABCDEFGH" },
  }, {
    hasAwaiting: async () => true,
    receive: async () => ({ ok: true, ja_processado: false, mensagem_para_cliente: "recebido" }),
    send: async (message) => {
      sent.push(message);
      return true;
    },
  });
  assert.equal(ok, "stop");
  assert.deepEqual(sent, ["recebido"]);

  const failed = await handleShopeeOnSupportMessage({
    phone: PHONE,
    text: { message: "241116ABCDEFGH" },
  }, {
    hasAwaiting: async () => true,
    receive: async () => ({ ok: true, ja_processado: false, mensagem_para_cliente: "recebido" }),
    send: async () => false,
  });
  assert.equal(failed, "continue");
});

test("mensagem da loja e clique de menu não gravam ID", async () => {
  let looked = 0;
  const outcome = await handleShopeeOnSupportMessage({
    fromMe: true,
    phone: PHONE,
    text: { message: "241116ABCDEFGH" },
  }, {
    hasAwaiting: async () => {
      looked += 1;
      return true;
    },
    receive: async () => ({ ok: true, ja_processado: false, mensagem_para_cliente: "nao" }),
    send: async () => true,
  });
  const click = await handleShopeeOnSupportMessage({
    phone: PHONE,
    text: { message: "241116ABCDEFGH" },
    listResponseMessage: { selectedRowId: "menu" },
  }, {
    hasAwaiting: async () => {
      looked += 1;
      return true;
    },
    receive: async () => ({ ok: true, ja_processado: false, mensagem_para_cliente: "nao" }),
    send: async () => true,
  });
  assert.equal(outcome, "continue");
  assert.equal(click, "continue");
  assert.equal(looked, 0);
});
