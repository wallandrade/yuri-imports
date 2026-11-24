import assert from "node:assert/strict";
import test from "node:test";

import { CHECKOUT_INVALID_TOAST, firstInvalidCheckoutField, nationalCheckoutPhoneDigits } from "./checkout-invalid";

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

test("telefone com 12 ou 13 dígitos e 55 vira o número nacional", () => {
  assert.equal(nationalCheckoutPhoneDigits("+55 11 99999-9999"), "11999999999");
  assert.equal(nationalCheckoutPhoneDigits("+55 11 3333-4444"), "1133334444");
  assert.equal(nationalCheckoutPhoneDigits("+55 (55) 99999-9999"), "55999999999");
});

test("telefone com 0 de tronco perde só esse 0", () => {
  assert.equal(nationalCheckoutPhoneDigits("011988887777"), "11988887777");
  assert.equal(nationalCheckoutPhoneDigits("05511999999999"), "11999999999");
});

test("DDD 55 com 11 dígitos não perde o DDD", () => {
  assert.equal(nationalCheckoutPhoneDigits("(55) 99999-9999"), "55999999999");
  assert.equal(nationalCheckoutPhoneDigits("11988887777"), "11988887777");
});
