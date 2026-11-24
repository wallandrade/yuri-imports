import assert from "node:assert/strict";
import test from "node:test";

import { isCatalogSoldOut, isProductUnavailable } from "./product-availability";

test("produto esgotado e ativo pode ser comprado", () => {
  const product = { isActive: true, isSoldOut: true };
  assert.equal(isProductUnavailable(product), false);
  assert.equal(isCatalogSoldOut(product), true);
});

test("produto inativo continua fora da compra", () => {
  assert.equal(isProductUnavailable({ isActive: false, isSoldOut: false }), true);
  assert.equal(isProductUnavailable({ isActive: false, isSoldOut: true }), true);
});

test("sem a marca de esgotado o selo fica oculto", () => {
  assert.equal(isCatalogSoldOut({ isSoldOut: false }), false);
  assert.equal(isCatalogSoldOut({}), false);
});
