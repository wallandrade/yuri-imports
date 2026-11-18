import assert from "node:assert/strict";
import test from "node:test";

import {
  commissionAlreadyPaid,
  commissionRateSnapshotForSeller,
  normalizeReassignSellerCode,
  openBatchAfterRemovingOrder,
  orderCommissionAmount,
} from "./reassign-order-seller";

test("código do vendedor fica minúsculo", () => {
  assert.equal(normalizeReassignSellerCode("  Yuri "), "yuri");
  assert.equal(normalizeReassignSellerCode("   "), null);
});

test("taxa do vendedor novo zera quando não tem comissão", () => {
  assert.equal(commissionRateSnapshotForSeller({ hasCommission: false, commissionRate: 5 }), 0);
  assert.equal(commissionRateSnapshotForSeller({ hasCommission: true, commissionRate: "3.00" }), 3);
});

test("comissão do pedido usa o total e a taxa", () => {
  assert.equal(orderCommissionAmount(705, 3), 21.15);
  assert.equal(orderCommissionAmount(100, 0), 0);
});

test("comissão já paga bloqueia a troca", () => {
  assert.equal(commissionAlreadyPaid({ paidAt: null, batchStatus: "open" }), false);
  assert.equal(commissionAlreadyPaid({ paidAt: "2026-11-01", batchStatus: "open" }), true);
  assert.equal(commissionAlreadyPaid({ paidAt: null, batchStatus: "paid" }), true);
});

test("lote aberto perde o pedido e recalcula o que sobrou", () => {
  const next = openBatchAfterRemovingOrder({
    batchOrderIds: ["pedido-poly", "pedido-b"],
    removedOrderId: "pedido-poly",
    remainingOrders: [{ id: "pedido-b", total: 200, rate: 5 }],
  });
  assert.deepEqual(next, { orderIds: ["pedido-b"], orderCount: 1, totalAmount: 10 });
});

test("lote que fica vazio é apagado", () => {
  const next = openBatchAfterRemovingOrder({
    batchOrderIds: ["pedido-poly"],
    removedOrderId: "pedido-poly",
    remainingOrders: [],
  });
  assert.equal(next, null);
});
