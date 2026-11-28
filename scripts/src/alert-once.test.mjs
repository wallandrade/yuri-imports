import assert from "node:assert/strict";
import test from "node:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { notifyOwnerOnce } from "./alert-once.mjs";

const ENV = {
  BACKUP_ALERT_PHONE: "5535999999999",
  ZAPI_MAIN_INSTANCE_ID: "instanciaMain1",
  ZAPI_MAIN_TOKEN: "token-de-teste",
  ZAPI_CLIENT_TOKEN: "client-de-teste",
};

function bucket() {
  let stored = false;
  const puts = [];
  return {
    puts,
    send: async (cmd) => {
      if (cmd instanceof PutObjectCommand) {
        puts.push(cmd.input.Key);
        stored = true;
        return {};
      }
      if (!stored) {
        const err = new Error("missing");
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    },
  };
}

const sent = () => ({ ok: true, status: 200, json: async () => ({ messageId: "1" }) });

test("falha da limpeza do mysql não grava a marca e não cala o aviso seguinte", async () => {
  const store = bucket();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return sent();
  };
  const cleanup = await notifyOwnerOnce({
    client: store,
    bucket: "yuri-imports-db-backups",
    destPrefix: "media/",
    timeZone: "America/Sao_Paulo",
    title: "A limpeza dos dumps mysql/ falhou.",
    lines: ["Job: db-backup-r2"],
    env: ENV,
    fetchImpl,
    record: false,
  });
  const media = await notifyOwnerOnce({
    client: store,
    bucket: "yuri-imports-db-backups",
    destPrefix: "media/",
    timeZone: "America/Sao_Paulo",
    title: "O backup da mídia falhou.",
    lines: ["Job: media-backup-r2"],
    env: ENV,
    fetchImpl,
    record: true,
  });
  const again = await notifyOwnerOnce({
    client: store,
    bucket: "yuri-imports-db-backups",
    destPrefix: "media/",
    timeZone: "America/Sao_Paulo",
    title: "Backup atrasado ou ausente.",
    lines: ["Job: backup-watchdog"],
    env: ENV,
    fetchImpl,
    record: true,
  });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.skipped, false);
  assert.equal(media.ok, true);
  assert.equal(media.skipped, false);
  assert.equal(again.skipped, true);
  assert.equal(calls, 2);
  assert.equal(store.puts.length, 1);
  assert.match(store.puts[0], /^media\/state\/alerts\/\d{4}-\d{2}-\d{2}\.json$/);
});
