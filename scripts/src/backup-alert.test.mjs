import assert from "node:assert/strict";
import test from "node:test";

import { backupAlertText, notifyOwnerBackupAlert, ownerAlertPhone, redactAlertDetail } from "./backup-alert.mjs";

const ENV = {
  BACKUP_ALERT_PHONE: "5535999999999",
  ZAPI_MAIN_INSTANCE_ID: "instanciaMain1",
  ZAPI_MAIN_TOKEN: "token-de-teste",
  ZAPI_CLIENT_TOKEN: "client-de-teste",
};

test("o destino é um celular com DDI 55, nunca um grupo", () => {
  assert.deepEqual(ownerAlertPhone("5535999999999"), { ok: true, phone: "5535999999999" });
  assert.deepEqual(ownerAlertPhone("+55 (35) 999999999"), { ok: true, phone: "5535999999999" });
  assert.equal(ownerAlertPhone("553591710559-1525960254").ok, false);
  assert.equal(ownerAlertPhone("553591710559-1525960254").reason, "group");
  assert.equal(ownerAlertPhone("120363123@g.us").reason, "group");
  assert.equal(ownerAlertPhone("11999999999").reason, "phone");
  assert.equal(ownerAlertPhone("").reason, "empty");
});

test("a mensagem tira senha e URL da Z-API", () => {
  const text = backupAlertText({
    title: "O backup do MySQL falhou.",
    lines: ["Motivo: connect mysql://user:segredo@host/db token=abc"],
  });
  assert.match(text, /Yuri Import — backup/);
  assert.equal(text.includes("segredo"), false);
  assert.equal(text.includes("token=abc"), false);
  assert.match(redactAlertDetail("https://api.z-api.io/instances/abc/token/segredo/send-text"), /redacted/);
});

test("grupo e destino vazio não chamam a Z-API", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  const group = await notifyOwnerBackupAlert({
    title: "falhou",
    env: { ...ENV, BACKUP_ALERT_PHONE: "553591710559-1525960254" },
    fetchImpl,
  });
  assert.equal(group.ok, false);
  assert.equal(group.error, "destino é grupo");
  const missing = await notifyOwnerBackupAlert({
    title: "falhou",
    env: { ...ENV, BACKUP_ALERT_PHONE: "" },
    fetchImpl,
  });
  assert.equal(missing.ok, false);
  assert.equal(called, false);
});

test("o aviso sai em send-text para o número do dono", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const result = await notifyOwnerBackupAlert({
    title: "O backup da mídia falhou.",
    lines: ["Job: media-backup-r2"],
    env: ENV,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/instances\/instanciaMain1\/token\/token-de-teste\/send-text$/);
  assert.equal(calls[0].init.headers["Client-Token"], "client-de-teste");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.phone, "5535999999999");
  assert.match(body.message, /mídia falhou/);
  assert.equal(JSON.stringify(calls[0].init).includes("group"), false);
});
