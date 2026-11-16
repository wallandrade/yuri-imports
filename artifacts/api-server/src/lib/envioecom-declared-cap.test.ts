import assert from "node:assert/strict";
import test from "node:test";

import { envioEcomCreateResultError } from "./envioecom";
import {
  capJtDeclaredValue,
  capQuoteProductPrice,
  carrierDeclaredLimitFromQuote,
  claimEnvioEcomCreateSlot,
  fitDeclaredShipmentItems,
  parseDeclaredLimitAmount,
  quoteProductsForCarriers,
  releaseEnvioEcomCreateSlot,
} from "./envioecom-declared-cap";

test("parser aceita 1.000,00 e 19.85", () => {
  assert.equal(parseDeclaredLimitAmount("1.000,00"), 1000);
  assert.equal(parseDeclaredLimitAmount("R$ 1.000,00"), 1000);
  assert.equal(parseDeclaredLimitAmount("1.000"), 1000);
  assert.equal(parseDeclaredLimitAmount("19.85"), 19.85);
  assert.equal(parseDeclaredLimitAmount("500,00"), 500);
});

test("J&T corta em 1000 e PAC/Sedex ficam iguais", () => {
  const jt = fitDeclaredShipmentItems(
    [{ name: "Peça", quantity: 1, unit_cost: 1800 }],
    1800,
    "J&T Express envioEcom",
  );
  assert.equal(jt.capped, true);
  assert.equal(jt.declaredCost, 1000);
  assert.equal(jt.items[0].unit_cost, 1000);

  const pac = fitDeclaredShipmentItems(
    [{ name: "Peça", quantity: 1, unit_cost: 1800 }],
    1800,
    "PAC",
  );
  assert.equal(pac.capped, false);
  assert.equal(pac.declaredCost, 1800);
  assert.equal(pac.items[0].unit_cost, 1800);

  const sedex = capQuoteProductPrice(1800, ["Sedex"]);
  assert.equal(sedex, 1800);
  assert.equal(capQuoteProductPrice(1800, ["J&T Express envioEcom"]), 1000);
  assert.equal(capQuoteProductPrice(1800, ["J&T Express envioEcom", "PAC"]), 1800);
  assert.equal(capJtDeclaredValue(89.9).capped, false);

  const quoted = quoteProductsForCarriers(
    [{ price: 1800, quantity: 1 }],
    ["J&T Express envioEcom"],
    ["PAC", "Sedex"],
  );
  assert.deepEqual(quoted.carriers, ["J&T Express envioEcom"]);
  assert.equal(quoted.products[0]?.price, 1000);

  const fallback = quoteProductsForCarriers([{ price: 1800, quantity: 1 }], undefined, ["PAC", "J&T Express envioEcom"]);
  assert.equal(fallback.products[0]?.price, 1800);
  assert.deepEqual(fallback.carriers, ["PAC", "J&T Express envioEcom"]);
});

test("limite da opção substitui o teto padrão da J&T", () => {
  assert.equal(carrierDeclaredLimitFromQuote({ carrier: "J&T Express envioEcom", price: 19.85 }), null);
  assert.equal(carrierDeclaredLimitFromQuote({ max_declared_value: "1.000,00" }), 1000);
  assert.equal(carrierDeclaredLimitFromQuote({ limits: { declared_value_limit: "750,00" } }), 750);
  assert.equal(carrierDeclaredLimitFromQuote({ max_declared_value: 9000 }), null);
  const tighter = fitDeclaredShipmentItems(
    [{ name: "Peça", quantity: 1, unit_cost: 800 }],
    800,
    "J&T",
    500,
  );
  assert.equal(tighter.declaredCost, 500);
});

test("create HTTP 200 sem envio ou com erro no corpo é recusa", () => {
  const refused = envioEcomCreateResultError({
    shipping_create: {
      success: false,
      created: 0,
      results: [{
        error: "Valor segurado ultrapassa o limite máximo de R$ 1.000,00",
      }],
    },
  });
  assert.equal(refused?.code, "CREATE_REJECTED");
  assert.match(refused?.message || "", /1\.000,00/);

  const empty = envioEcomCreateResultError({
    shipping_create: { success: false, created: 0, results: [] },
  });
  assert.equal(empty?.code, "CREATE_REJECTED");

  const ok = envioEcomCreateResultError({
    shipping_create: {
      success: true,
      created: 1,
      results: [{ shipping_id: 726270, barcode: "888012345678" }],
    },
  });
  assert.equal(ok, null);
});

test("trava de create impede o segundo clique e solta se falhar", () => {
  const key = `pedido-teste-${Date.now()}`;
  assert.equal(claimEnvioEcomCreateSlot(key, 1_000), null);
  assert.match(claimEnvioEcomCreateSlot(key, 1_100) || "", /andamento/);
  releaseEnvioEcomCreateSlot(key, false, 1_200);
  assert.equal(claimEnvioEcomCreateSlot(key, 1_300), null);
  releaseEnvioEcomCreateSlot(key, true, 2_000);
  assert.match(claimEnvioEcomCreateSlot(key, 2_100) || "", /alguns segundos/);
  assert.equal(claimEnvioEcomCreateSlot(key, 2_000 + 15_000), null);
  releaseEnvioEcomCreateSlot(key, false, 20_000);
});
