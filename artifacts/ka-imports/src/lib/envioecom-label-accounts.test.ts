import assert from "node:assert/strict";
import test from "node:test";

import { envioecomAccountsForLabelPicker } from "./envioecom-label-accounts";

test("o seletor de etiqueta esconde a conta do servidor quando há conta salva", () => {
  const env = { id: "env", fromEnv: true, configured: true, name: "São Paulo (servidor)" };
  const sao = { id: "sp", fromEnv: false, configured: true, name: "Sao paulo" };
  const minas = { id: "mg", fromEnv: false, configured: true, name: "Minas" };
  const incomplete = { id: "x", fromEnv: false, configured: false, name: "Incompleta" };
  assert.deepEqual(
    envioecomAccountsForLabelPicker([env, sao, minas, incomplete]).map((account) => account.id),
    ["sp", "mg"],
  );
  assert.deepEqual(
    envioecomAccountsForLabelPicker([env]).map((account) => account.id),
    ["env"],
  );
  assert.deepEqual(envioecomAccountsForLabelPicker([incomplete, env]).map((account) => account.id), ["env"]);
});
