import assert from "node:assert/strict";
import test from "node:test";
import { preconfirmListProducts } from "./payment-preconfirm-logic";

test("miniatura da pré-confirmação guarda nome e URL http curta", () => {
  const products = preconfirmListProducts([
    { id: "p1", name: "Tirzepatida", image: "https://cdn.example/tirze.jpg" },
    { id: "p2", name: "Sem foto" },
    { id: "p3", name: "Base64", image: "data:image/png;base64,AAAA" },
    { id: "p4", name: "Texto", image: "não é url" },
    { id: "p5", name: "Quinta", image: "https://cdn.example/extra.jpg" },
  ]);
  assert.equal(products.length, 4);
  assert.deepEqual(products[0], { id: "p1", name: "Tirzepatida", image: "https://cdn.example/tirze.jpg" });
  assert.equal(products[1]?.image, null);
  assert.equal(products[2]?.image, null);
  assert.equal(products[3]?.image, null);
  assert.equal(products.some((item) => item.id === "p5"), false);
  assert.equal(JSON.stringify(products).includes("base64"), false);
});

test("miniatura ignora JSON inválido e corta URL longa", () => {
  assert.deepEqual(preconfirmListProducts("não-json"), []);
  assert.deepEqual(preconfirmListProducts({ name: "objeto" }), []);
  const long = `https://cdn.example/${"a".repeat(400)}.jpg`;
  const products = preconfirmListProducts([{ id: "p", name: "Longa", image: long }]);
  assert.equal(products[0]?.name, "Longa");
  assert.equal(products[0]?.image, null);
});
