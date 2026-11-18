import assert from "node:assert/strict";
import test from "node:test";

import { hasShippingLabel, labelDebitAccountPool, labelDebitLane, labelDebitStockPool } from "./label-debit-queue";

const base = {
  cancelled: false,
  inventoryReserved: false,
  waived: false,
  isPackage: false,
  packageCount: 1,
  shippingType: "Frete",
  enviado: false,
  accountPool: null as null,
  packagePool: null,
  envioecomStatus: "",
  envioecomLabelUrl: "",
  trackingLabelUrl: "",
  superfreteStatus: "",
  superfreteLabelUrl: "",
  manualTrackingCode: "",
};

test("São Paulo com etiqueta entra na aba São Paulo e o saldo é Motoboy", () => {
  const lane = labelDebitLane({
    ...base,
    accountPool: "motoboy",
    envioecomStatus: "Etiqueta emitida",
  });
  assert.equal(lane, "sao_paulo");
  assert.equal(labelDebitStockPool("sao_paulo"), "motoboy");
});

test("Minas com PDF entra na aba Minas", () => {
  assert.equal(labelDebitLane({
    ...base,
    accountPool: "minas",
    envioecomLabelUrl: "https://example.com/etiqueta.pdf",
  }), "minas");
});

test("Motoboy local enviado sem etiqueta EnvioEcom entra na aba Motoboy", () => {
  assert.equal(labelDebitLane({
    ...base,
    shippingType: "Motoboy",
    enviado: true,
  }), "motoboy");
});

test("Motoboy local com etiqueta de São Paulo fica só em São Paulo", () => {
  assert.equal(labelDebitLane({
    ...base,
    shippingType: "Motoboy",
    enviado: true,
    accountPool: "motoboy",
    envioecomStatus: "Aguardando coleta",
  }), "sao_paulo");
});

test("envio criado sem PDF não entra", () => {
  assert.equal(hasShippingLabel({ ...base, envioecomStatus: "Envio criado" }), false);
  assert.equal(labelDebitLane({ ...base, accountPool: "minas", envioecomStatus: "Envio criado" }), null);
});

test("Santa Catarina com etiqueta entra na aba e o saldo é Santa Catarina", () => {
  const lane = labelDebitLane({
    ...base,
    accountPool: "santa_catarina",
    envioecomLabelUrl: "https://x",
  });
  assert.equal(lane, "santa_catarina");
  assert.equal(labelDebitStockPool("santa_catarina"), "santa_catarina");
  assert.equal(labelDebitLane({
    ...base,
    isPackage: true,
    packagePool: "santa_catarina",
    envioecomStatus: "Aguardando coleta",
  }), "santa_catarina");
});

test("depósito Santa Catarina sem nome na conta não cai em Minas", () => {
  assert.equal(labelDebitAccountPool({
    accountPool: "minas",
    savedPool: "santa_catarina",
    accountName: "conta-sc",
  }), "santa_catarina");
  assert.equal(labelDebitAccountPool({
    accountPool: "minas",
    savedPool: "santa_catarina",
    accountName: "Minas",
  }), "minas");
});

test("já baixado, dispensado ou cancelado fica de fora", () => {
  assert.equal(labelDebitLane({ ...base, accountPool: "minas", envioecomLabelUrl: "https://x", inventoryReserved: true }), null);
  assert.equal(labelDebitLane({ ...base, accountPool: "minas", envioecomLabelUrl: "https://x", waived: true }), null);
  assert.equal(labelDebitLane({ ...base, accountPool: "santa_catarina", envioecomLabelUrl: "https://x", cancelled: true }), null);
  assert.equal(labelDebitLane({ ...base, accountPool: "santa_catarina", envioecomStatus: "Envio criado" }), null);
});

test("pedido dividido não entra inteiro; o pacote Minas entra", () => {
  assert.equal(labelDebitLane({
    ...base,
    packageCount: 2,
    accountPool: "minas",
    envioecomLabelUrl: "https://x",
  }), null);
  assert.equal(labelDebitLane({
    ...base,
    isPackage: true,
    packageCount: 2,
    packagePool: "minas",
    envioecomStatus: "Etiqueta emitida",
  }), "minas");
});
