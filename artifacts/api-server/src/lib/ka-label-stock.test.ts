import assert from "node:assert/strict";
import test from "node:test";
import { kaLabelLane, kaLabelReferenceId, parseKaPendingLabels } from "./ka-label-stock";

test("etiqueta da KA entra no depósito certo e São Paulo não vira pool", () => {
  assert.equal(kaLabelLane("motoboy"), "motoboy");
  assert.equal(kaLabelLane("minas"), "minas");
  assert.equal(kaLabelLane("santa_catarina"), "santa_catarina");
  assert.equal(kaLabelLane("sao_paulo"), null);
  assert.equal(kaLabelLane("loja"), null);
});

test("a lista da KA ignora linha sem depósito da Yuri", () => {
  const rows = parseKaPendingLabels({
    labels: [
      {
        labelId: "pkg-1",
        orderNumber: 90,
        customerName: "Ana",
        status: "Etiqueta gerada",
        code: "AB123",
        warehouse: "santa_catarina",
        products: [{ productId: "p1", name: "Tirze", quantity: 2 }],
      },
      {
        labelId: "pkg-2",
        warehouse: "sao_paulo",
        products: [{ productId: "p1", name: "Tirze", quantity: 1 }],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.labelId, "pkg-1");
  assert.equal(rows[0]?.warehouse, "santa_catarina");
  assert.equal(rows[0]?.products[0]?.quantity, 2);
  assert.equal(kaLabelReferenceId("pkg-1"), "ka-label:pkg-1");
});
