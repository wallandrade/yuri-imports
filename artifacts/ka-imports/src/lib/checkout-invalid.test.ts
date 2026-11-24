import assert from "node:assert/strict";
import test from "node:test";

import { CHECKOUT_INVALID_TOAST, firstInvalidCheckoutField } from "./checkout-invalid";

test("o primeiro erro segue a ordem da tela, de cima para baixo", () => {
  assert.equal(
    firstInvalidCheckoutField({ city: { message: "Cidade" }, phone: { message: "Telefone" } }),
    "phone",
  );
  assert.equal(firstInvalidCheckoutField({ cep: { message: "CEP" } }), "cep");
  assert.equal(firstInvalidCheckoutField({}), null);
});

test("o aviso do checkout pede para preencher os dados de cima", () => {
  assert.equal(CHECKOUT_INVALID_TOAST, "Preencha os dados de cima para finalizar");
});
