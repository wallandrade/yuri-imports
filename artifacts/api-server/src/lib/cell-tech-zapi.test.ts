import assert from "node:assert/strict";
import test from "node:test";
import { cellTechDirectQueueDraft, cellTechOutboundReady } from "./cell-tech-zapi";

test("o rascunho da Cell Tech só usa a instância celltech", () => {
  const missing = cellTechDirectQueueDraft({ configured: false, phone: "grupo-teste", message: "oi" });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.log, "[Cell Tech] instância Z-API da Cell Tech não configurada");
    assert.match(missing.message, /não configurada/);
    assert.equal(missing.log.includes("main"), false);
    assert.equal(missing.log.includes("poly"), false);
  }
  const ready = cellTechDirectQueueDraft({ configured: true, phone: "grupo-teste", message: "oi" });
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.draft.instance, "celltech");
    assert.equal(ready.draft.origin, "cell_tech");
    assert.equal(ready.draft.kind, "text");
    assert.equal(ready.draft.phone, "grupo-teste");
    assert.equal(JSON.stringify(ready).includes("main"), false);
    assert.equal(JSON.stringify(ready).includes("poly"), false);
  }
});

test("a Cell Tech não sai sem instância ou fora da janela", () => {
  assert.equal(cellTechOutboundReady({ configured: false, windowOpen: true }), false);
  assert.equal(cellTechOutboundReady({ configured: true, windowOpen: false }), false);
  assert.equal(cellTechOutboundReady({ configured: true, windowOpen: true }), true);
});
