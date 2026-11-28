import assert from "node:assert/strict";
import test from "node:test";

import {
  addCalendarDays,
  applyPlanToManifest,
  assessFreshness,
  assertDeletableBackupKey,
  assertDestWrite,
  datedKeysToDelete,
  emptyManifest,
  encodeCopySource,
  mediaRunObjects,
  mirrorObjectKey,
  mysqlBackupObjects,
  parseKeyedInstant,
  parseManifest,
  planMediaBackup,
  readMediaBackupConfig,
  readRetentionDays,
  readStaleWindowMs,
  stripMirrorKey,
  type MediaManifest,
  type MediaObject,
} from "./policy";
import { mysqlDumpKeysToDelete } from "../mysql-retention.mjs";

const PREFIXES = ["products/", "tracking-labels/", "admin-images/"];
const DAY = "2026-11-28";
const STALE_MS = 26 * 60 * 60 * 1000;

function obj(key: string, etag: string, size = 10): MediaObject {
  return { key, etag, size };
}

test("a configuração padrão separa a loja do bucket de backup", () => {
  const config = readMediaBackupConfig({});
  assert.equal(config.sourceBucket, "clayton-assets");
  assert.equal(config.destBucket, "yuri-imports-db-backups");
  assert.equal(config.destPrefix, "media/");
  assert.equal(config.retentionDays, null);
  assert.ok(config.prefixes.includes("products/"));
  assert.ok(config.prefixes.includes("admin-images/"));
  assert.ok(config.prefixes.includes("tracking-labels/"));
  assert.equal(config.dryRun, false);
});

test("recusa gravar o backup em cima do bucket da loja", () => {
  assert.throws(
    () => readMediaBackupConfig({ MEDIA_BACKUP_DEST_BUCKET: "clayton-assets" }),
    /não alterar o bucket da loja/,
  );
  assert.throws(
    () => assertDestWrite({
      bucket: "clayton-assets",
      key: "media/mirror/products/a.jpg",
      sourceBucket: "clayton-assets",
      destPrefix: "media/",
    }),
    /origem/,
  );
});

test("só apaga histórico, marca ou o espelho de um arquivo que saiu da origem", () => {
  const base = { bucket: "yuri-imports-db-backups", sourceBucket: "clayton-assets", destPrefix: "media/" };
  assert.doesNotThrow(() => assertDeletableBackupKey({
    ...base,
    key: "media/history/2026-10-01/products/a.jpg",
    reason: "retention",
  }));
  assert.doesNotThrow(() => assertDeletableBackupKey({
    ...base,
    key: "media/mirror/products/a.jpg",
    reason: "drop-mirror",
  }));
  assert.throws(
    () => assertDeletableBackupKey({ ...base, key: "media/state/manifest.json", reason: "retention" }),
    /recusa apagar/,
  );
  assert.throws(
    () => assertDeletableBackupKey({ ...base, key: "mysql/2026-11-01_0300.sql.gz", reason: "retention" }),
    /recusa/,
  );
  assert.throws(
    () => assertDeletableBackupKey({ ...base, key: "media/mirror/products/a.jpg", reason: "retention" }),
    /recusa apagar/,
  );
});

test("o plano copia só o que mudou e guarda exclusão para a retenção", () => {
  const manifest: MediaManifest = {
    version: 1,
    objects: {
      "products/igual.jpg": { etag: "aaa", size: 10 },
      "products/trocou.jpg": { etag: "old", size: 10 },
      "products/sumiu.jpg": { etag: "gone", size: 4 },
      "products/espelho-sumiu.jpg": { etag: "bbb", size: 8 },
      "fora/do-prefixo.jpg": { etag: "zzz", size: 1 },
    },
  };
  const actions = planMediaBackup({
    prefixes: PREFIXES,
    manifest,
    source: [
      obj("products/igual.jpg", "\"aaa\""),
      obj("products/trocou.jpg", "new", 11),
      obj("products/novo.jpg", "ccc", 3),
      obj("products/espelho-sumiu.jpg", "bbb", 8),
      obj("admin-images/banner.png", "ddd", 9),
      obj("outro/ignorado.jpg", "eee", 1),
    ],
    mirror: [
      obj("products/igual.jpg", "aaa"),
      obj("products/trocou.jpg", "old"),
      obj("products/sumiu.jpg", "gone", 4),
      obj("fora/do-prefixo.jpg", "zzz", 1),
    ],
  });
  const byKey = new Map(actions.map((action) => [action.key, action.type]));
  assert.equal(byKey.get("products/igual.jpg"), "skip");
  assert.equal(byKey.get("products/trocou.jpg"), "archive-then-copy");
  assert.equal(byKey.get("products/novo.jpg"), "copy");
  assert.equal(byKey.get("products/espelho-sumiu.jpg"), "copy");
  assert.equal(byKey.get("admin-images/banner.png"), "copy");
  assert.equal(byKey.get("products/sumiu.jpg"), "archive-then-drop");
  assert.equal(byKey.has("outro/ignorado.jpg"), false);
  const unsafe = planMediaBackup({
    prefixes: PREFIXES,
    manifest: emptyManifest(),
    source: [obj("products/a.jpg", "abc", 1), obj("products/../mysql/x.jpg", "zzz", 1)],
    mirror: [],
  });
  assert.deepEqual(unsafe.map((action) => action.key), ["products/a.jpg"]);
  assert.equal(byKey.has("fora/do-prefixo.jpg"), false);

  const next = applyPlanToManifest(
    manifest,
    new Map([
      ["products/trocou.jpg", obj("products/trocou.jpg", "new", 11)],
      ["products/novo.jpg", obj("products/novo.jpg", "ccc", 3)],
    ]),
    actions.filter((action) => action.key === "products/trocou.jpg" || action.key === "products/novo.jpg" || action.key === "products/sumiu.jpg"),
  );
  assert.equal(next.objects["products/trocou.jpg"]?.etag, "new");
  assert.equal(next.objects["products/novo.jpg"]?.etag, "ccc");
  assert.equal(next.objects["products/igual.jpg"]?.etag, "aaa");
  assert.equal(next.objects["products/sumiu.jpg"], undefined);
  assert.equal(next.objects["fora/do-prefixo.jpg"]?.etag, "zzz");
});

test("espelho com o mesmo etag e sem manifesto é adotado, sem copiar de novo", () => {
  const actions = planMediaBackup({
    prefixes: PREFIXES,
    manifest: emptyManifest(),
    source: [obj("products/a.jpg", "abc", 5)],
    mirror: [obj("products/a.jpg", "W/\"abc\"", 5)],
  });
  assert.deepEqual(actions, [{ type: "adopt", key: "products/a.jpg" }]);
});

test("listagem vazia da origem não apaga um espelho que já existe", () => {
  assert.throws(
    () => planMediaBackup({
      prefixes: PREFIXES,
      manifest: { version: 1, objects: { "products/a.jpg": { etag: "abc", size: 1 } } },
      source: [],
      mirror: [obj("products/a.jpg", "abc", 1)],
    }),
    /não apagar o espelho/,
  );
});

test("a retenção guarda o dia do corte e não mexe no dump nem no espelho", () => {
  assert.equal(addCalendarDays("2026-11-28", -30), "2026-10-29");
  assert.equal(addCalendarDays("2026-01-05", -10), "2025-12-26");
  assert.equal(readRetentionDays(undefined), null);
  assert.equal(readRetentionDays(""), null);
  assert.equal(readRetentionDays("none"), null);
  assert.equal(readRetentionDays("0"), null);
  assert.equal(readRetentionDays("30"), 30);
  assert.throws(() => readRetentionDays("abc"), /inválido/);
  const keys = [
    "media/history/2026-10-28/products/velho.jpg",
    "media/history/2026-10-29/products/no-corte.jpg",
    "media/history/2026-11-27/products/recente.jpg",
    "media/history/sem-data/products/a.jpg",
    "media/mirror/products/2020-01-01_old.jpg",
    "media/state/manifest.json",
    "mysql/2020-01-01_0300.sql.gz",
    "media/runs/2026-10-01_0330.json",
    "media/runs/2026-11-27_0330.json",
  ];
  assert.deepEqual(
    datedKeysToDelete(keys, "media/history/", DAY, 30),
    ["media/history/2026-10-28/products/velho.jpg"],
  );
  assert.deepEqual(
    datedKeysToDelete(keys, "media/runs/", DAY, 30),
    ["media/runs/2026-10-01_0330.json"],
  );
});

test("26h sem arquivo novo é atraso; backup das 3h ainda vale às 5h", () => {
  assert.equal(readStaleWindowMs(undefined), STALE_MS);
  assert.throws(() => readStaleWindowMs("1"), /20 e 48/);
  const freshAtFive = assessFreshness({
    now: new Date("2026-11-13T08:00:00.000Z"),
    maxAgeMs: STALE_MS,
    timeZone: "America/Sao_Paulo",
    objects: [{ key: "mysql/2026-11-13_0300.sql.gz", lastModified: null }],
  });
  assert.equal(freshAtFive.ok, true);
  assert.equal(freshAtFive.reason, "fresh");
  assert.equal(parseKeyedInstant("mysql/2026-11-13_0300.sql.gz", "America/Sao_Paulo")?.toISOString(), "2026-11-13T06:00:00.000Z");

  const missedNextMorning = assessFreshness({
    now: new Date("2026-11-14T09:00:00.000Z"),
    maxAgeMs: STALE_MS,
    timeZone: "America/Sao_Paulo",
    objects: [{ key: "media/runs/2026-11-13_0330.json" }],
  });
  assert.equal(missedNextMorning.ok, false);
  assert.equal(missedNextMorning.reason, "stale");

  const exactly = assessFreshness({
    now: new Date("2026-11-14T08:00:00.000Z"),
    maxAgeMs: STALE_MS,
    timeZone: "America/Sao_Paulo",
    objects: [{ key: "mysql/older.sql.gz", lastModified: new Date("2026-11-13T06:00:00.000Z") }],
  });
  assert.equal(exactly.reason, "stale");

  const missing = assessFreshness({
    now: new Date("2026-11-14T09:00:00.000Z"),
    maxAgeMs: STALE_MS,
    timeZone: "America/Sao_Paulo",
    objects: [],
  });
  assert.equal(missing.reason, "missing");

  const newest = assessFreshness({
    now: new Date("2026-11-13T12:00:00.000Z"),
    maxAgeMs: STALE_MS,
    timeZone: "America/Sao_Paulo",
    objects: [
      { key: "mysql/2026-11-12_0300.sql.gz", lastModified: new Date("2026-11-12T06:00:00.000Z") },
      { key: "mysql/2026-11-13_0300.sql.gz", lastModified: new Date("2026-11-13T06:05:00.000Z") },
    ],
  });
  assert.equal(newest.sampleKey, "mysql/2026-11-13_0300.sql.gz");
  assert.equal(newest.ok, true);
});

test("a limpeza do bucket só apaga mysql/*.sql.gz com mais de 30 dias", () => {
  const keys = [
    "mysql/2026-10-28_0300.sql.gz",
    "mysql/2026-10-29_0300.sql.gz",
    "mysql/2026-11-27_0300.sql.gz",
    "mysql/notes.txt",
    "media/mirror/products/a.jpg",
    "media/history/2020-01-01/products/a.jpg",
    "media/runs/2020-01-01_0300.json",
    "media/mysql/2020-01-01_0300.sql.gz",
  ];
  assert.deepEqual(mysqlDumpKeysToDelete(keys, DAY), ["mysql/2026-10-28_0300.sql.gz"]);
});

test("o vigilante só olha dump .sql.gz e marca de execução da mídia", () => {
  const listed = [
    { key: "mysql/2026-11-13_0300.sql.gz" },
    { key: "mysql/notes.txt" },
    { key: "media/runs/2026-11-13_0330.json" },
    { key: "media/mirror/products/a.jpg" },
  ];
  assert.deepEqual(mysqlBackupObjects(listed, "mysql/").map((item) => item.key), ["mysql/2026-11-13_0300.sql.gz"]);
  assert.deepEqual(mediaRunObjects(listed, "media/").map((item) => item.key), ["media/runs/2026-11-13_0330.json"]);
});

test("chaves de espelho e cópia não apontam para o bucket da loja", () => {
  assert.equal(mirrorObjectKey("media/", "products/a b.jpg"), "media/mirror/products/a b.jpg");
  assert.equal(stripMirrorKey("media/mirror/products/a b.jpg", "media/"), "products/a b.jpg");
  assert.equal(stripMirrorKey("media/history/2026-11-28/products/a.jpg", "media/"), null);
  assert.equal(encodeCopySource("clayton-assets", "products/a b.jpg"), "clayton-assets/products/a%20b.jpg");
  const parsed = parseManifest(JSON.stringify({
    version: 1,
    objects: { "products/a.jpg": { etag: "\"abc\"", size: 4 } },
  }));
  assert.equal(parsed.objects["products/a.jpg"]?.etag, "abc");
  assert.throws(() => parseManifest("{"), /inválido/);
});
