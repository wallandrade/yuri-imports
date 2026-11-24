import assert from "node:assert/strict";
import test from "node:test";

import { isOrderProductBlocked } from "./product-purchase";

test("produto esgotado e ativo não gera recusa de compra", () => {
  assert.equal(isOrderProductBlocked({ isActive: true, isSoldOut: true }), false);
});

test("produto inativo continua recusado, mesmo esgotado", () => {
  assert.equal(isOrderProductBlocked({ isActive: false, isSoldOut: true }), true);
  assert.equal(isOrderProductBlocked({ isActive: false, isSoldOut: false }), true);
});

test("produto ausente continua recusado", () => {
  assert.equal(isOrderProductBlocked(null), true);
  assert.equal(isOrderProductBlocked(undefined), true);
});
