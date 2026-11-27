import assert from "node:assert/strict";
import test from "node:test";
import { preconfirmPendingPath, shouldRefreshPreconfirmQueue } from "./preconfirm-queue.ts";

test("aprovar e recusar recarregam no sucesso, no 409 e no 404", () => {
  assert.equal(shouldRefreshPreconfirmQueue(200), true);
  assert.equal(shouldRefreshPreconfirmQueue(409), true);
  assert.equal(shouldRefreshPreconfirmQueue(404), true);
  assert.equal(shouldRefreshPreconfirmQueue(401), false);
  assert.equal(shouldRefreshPreconfirmQueue(403), false);
  assert.equal(shouldRefreshPreconfirmQueue(500), false);
});

test("o card pede a fila sem o comprovante", () => {
  assert.equal(
    preconfirmPendingPath(false),
    "/api/admin/orders/payment-preconfirms?status=pending_admin&includeProof=0",
  );
  assert.equal(preconfirmPendingPath(true).includes("includeProof"), false);
});
