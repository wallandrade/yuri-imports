import assert from "node:assert/strict";
import test from "node:test";
import {
  cellTechGestaoFailureCounts,
  mergeCellTechConnection,
  noteCellTechCall,
  parseCellTechConnectionState,
  parseSituationLabels,
  peekCellTechConnectionMemory,
  publicCellTechConnection,
  recordCellTechWhatsapp,
  resetCellTechConnectionMemory,
  serializeSituationLabels,
  emptyCellTechConnectionState,
} from "./cell-tech-status";
import { CELL_TECH_GROUP_SEND_FROM_MINUTES_DEFAULT, CELL_TECH_GROUP_SEND_UNTIL_MINUTES, joinIdList } from "./cell-tech-logic";

const ACCESS = "access-token-completo-abcdefghij";
const SECRET = "secret-token-completo-ZZZZzzzz";

test("o status não devolve o token inteiro", () => {
  const view = publicCellTechConnection(ACCESS, SECRET, emptyCellTechConnectionState());
  const json = JSON.stringify(view);
  assert.equal(view.accessConfigured, true);
  assert.equal(view.secretConfigured, true);
  assert.equal(view.accessHint, "••••ghij");
  assert.equal(view.secretHint, "••••zzzz");
  assert.equal(json.includes(ACCESS), false);
  assert.equal(json.includes(SECRET), false);
  assert.equal(json.includes("access-token-completo"), false);
});

test("token vazio não finge que está configurado", () => {
  const view = publicCellTechConnection("", "abcd", emptyCellTechConnectionState());
  assert.equal(view.accessConfigured, false);
  assert.equal(view.accessHint, "");
  assert.equal(view.secretHint, "••••");
});

test("chamada recusada guarda a frase e o horário, sem o segredo longo", () => {
  const at = "2026-11-17T15:04:00.000Z";
  const next = noteCellTechCall(
    emptyCellTechConnectionState(),
    "gestao",
    false,
    `O Gestão Click recusou o access token ou o secret. ${ACCESS}`,
    at,
  );
  const view = publicCellTechConnection("tok", "sec", next);
  assert.equal(view.gestao.outcome, "recusado");
  assert.equal(view.gestao.at, at);
  assert.equal(view.gestao.message.includes(ACCESS), false);
  assert.match(view.gestao.message, /recusou/);
  assert.equal(view.whatsapp.outcome, null);
});

test("envio ao grupo com HTTP 500 fica como falhou", () => {
  resetCellTechConnectionMemory();
  recordCellTechWhatsapp(false, "O n8n respondeu 500.", "2026-11-17T16:10:00.000Z");
  const state = peekCellTechConnectionMemory();
  resetCellTechConnectionMemory();
  const view = publicCellTechConnection("", "", state);
  assert.equal(view.whatsapp.outcome, "falhou");
  assert.equal(view.whatsapp.message, "O n8n respondeu 500.");
  assert.equal(view.whatsapp.at, "2026-11-17T16:10:00.000Z");
  assert.equal(JSON.stringify(state).includes("webhook"), false);
});

test("sucesso do grupo zera a mensagem de erro", () => {
  const failed = noteCellTechCall(emptyCellTechConnectionState(), "whatsapp", false, "O n8n respondeu 500.", "2026-11-17T10:00:00.000Z");
  const ok = noteCellTechCall(failed, "whatsapp", true, "não usar", "2026-11-17T11:00:00.000Z");
  assert.equal(ok.whatsapp?.outcome, "ok");
  assert.equal(ok.whatsapp?.message, "");
  assert.equal(ok.whatsapp?.at, "2026-11-17T11:00:00.000Z");
});

test("a gravação ignora campo de token e fica com o horário mais novo", () => {
  const stored = parseCellTechConnectionState(JSON.stringify({
    accessToken: ACCESS,
    secretAccessToken: SECRET,
    gestao: { outcome: "ok", message: "ignorada", at: "2026-11-17T12:00:00.000Z" },
    whatsapp: { outcome: "falhou", message: "O n8n respondeu 500.", at: "2026-11-17T12:05:00.000Z" },
  }));
  const json = JSON.stringify(stored);
  assert.equal(json.includes(ACCESS), false);
  assert.equal(stored.gestao?.message, "");
  const merged = mergeCellTechConnection(
    { gestao: { outcome: "recusado", message: "O Gestão Click recusou o access token ou o secret.", at: "2026-11-17T18:00:00.000Z" }, whatsapp: null },
    stored,
  );
  assert.equal(merged.gestao?.outcome, "recusado");
  assert.equal(merged.whatsapp?.message, "O n8n respondeu 500.");
});

test("400 e 404 não contam como recusa do token", () => {
  assert.equal(cellTechGestaoFailureCounts(400), false);
  assert.equal(cellTechGestaoFailureCounts(404), false);
  assert.equal(cellTechGestaoFailureCounts(401), true);
  assert.equal(cellTechGestaoFailureCounts(403), true);
  assert.equal(cellTechGestaoFailureCounts(500), true);
});

test("rótulo de situação não entra na lista de IDs fechados", () => {
  const labels = parseSituationLabels({ "12": "Finalizado", "0": "ignora", " 7 ": "  Sem reparo  " });
  assert.deepEqual(labels, { "12": "Finalizado", "7": "Sem reparo" });
  assert.equal(serializeSituationLabels(labels).includes("Finalizado"), true);
  assert.equal(joinIdList(["12", "30"]), "12,30");
});

test("a janela do grupo continua das 8h às 19h", () => {
  assert.equal(CELL_TECH_GROUP_SEND_FROM_MINUTES_DEFAULT, 8 * 60);
  assert.equal(CELL_TECH_GROUP_SEND_UNTIL_MINUTES, 19 * 60);
});
