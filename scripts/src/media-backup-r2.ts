#!/usr/bin/env node
// Daily incremental copy of store media from clayton-assets into the private
// backup bucket. The store bucket is only listed and read, with its own token.
// The mirror is never deleted. History keys include the minute and etag and
// refuse overwrite. Default source scope is the whole bucket.

import { redactAlertDetail } from "./backup-alert.mjs";
import { notifyOwnerOnce } from "./alert-once.mjs";
import {
  applyPlanToManifest,
  calendarDay,
  datedKeysToDelete,
  emptyManifest,
  historyObjectKey,
  journalObjectKey,
  manifestObjectKey,
  mergeManifest,
  mirrorObjectKey,
  normalizeEtag,
  parseManifest,
  planMediaBackup,
  readMediaBackupConfig,
  runMarkerObjectKey,
  stampMinute,
  stripMirrorKey,
  summarizeActions,
  unknownRootPrefixes,
  type MediaAction,
  type MediaObject,
} from "./backup/policy";
import {
  acquireBackupLock,
  copyFromSource,
  copyWithinBackup,
  createR2Client,
  deleteBackupKeys,
  listBackupObjects,
  loadManifest,
  putBackupJson,
  readBackupText,
  releaseBackupLock,
  type ObjectLayout,
} from "./backup/r2io";

const log = (...parts: unknown[]) => console.log(`[media-backup] ${new Date().toISOString()}`, ...parts);
const CHUNK = 200;
const COPIES_AT_ONCE = 2;
let alertClient: ReturnType<typeof createR2Client> | null = null;
let alertBucket = "yuri-imports-db-backups";
let alertPrefix = "media/";
let alertZone = "America/Sao_Paulo";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

async function alertFailure(detail: string, client: ReturnType<typeof createR2Client> | null, bucket: string, prefix: string, timeZone: string): Promise<void> {
  try {
    const result = await notifyOwnerOnce({
      client: client ?? undefined,
      bucket,
      destPrefix: prefix,
      timeZone,
      title: "O backup da mídia falhou.",
      lines: [
        "Job: media-backup-r2",
        `Motivo: ${detail}`,
        "Nada foi apagado nem alterado no bucket clayton-assets. O espelho não é apagado.",
      ],
      record: Boolean(client),
    });
    if (!result.ok) log(`aviso não enviado: ${result.error}`);
    else if (result.skipped) log("aviso já enviado hoje");
  } catch (err) {
    log(`aviso não enviado: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const cfg = readMediaBackupConfig(process.env);
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const accountId = endpoint ? "" : requireEnv("CLOUDFLARE_R2_ACCOUNT_ID");
  const sourceClient = createR2Client({
    endpoint: endpoint || undefined,
    accountId,
    accessKeyId: requireEnv("MEDIA_BACKUP_SOURCE_R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("MEDIA_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY"),
    region: process.env.BACKUP_S3_REGION,
  });
  const destClient = createR2Client({
    endpoint: endpoint || undefined,
    accountId,
    accessKeyId: requireEnv("MEDIA_BACKUP_DEST_R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("MEDIA_BACKUP_DEST_R2_SECRET_ACCESS_KEY"),
    region: process.env.BACKUP_S3_REGION,
  });
  alertClient = destClient;
  alertBucket = cfg.destBucket;
  alertPrefix = cfg.destPrefix;
  alertZone = cfg.timeZone;
  const layout: ObjectLayout = {
    sourceBucket: cfg.sourceBucket,
    destBucket: cfg.destBucket,
    destPrefix: cfg.destPrefix,
  };
  log(`origem ${cfg.sourceBucket} (${cfg.prefixes ? cfg.prefixes.join(",") : "bucket inteiro"}) → ${cfg.destBucket}/${cfg.destPrefix}`);

  const sourceListed = await listBackupObjects(sourceClient, cfg.sourceBucket, "");
  const unknown = unknownRootPrefixes(sourceListed.map((item) => item.key), cfg.prefixes);
  if (unknown.length) {
    throw new Error(`prefixo desconhecido na origem, fora de MEDIA_BACKUP_SOURCE_PREFIXES: ${unknown.join(", ")}`);
  }
  const source: MediaObject[] = sourceListed
    .filter((item) => !cfg.prefixes || cfg.prefixes.some((prefix) => item.key.startsWith(prefix)))
    .map((item) => ({ key: item.key, etag: item.etag, size: item.size }));
  const mirrorListed = await listBackupObjects(destClient, cfg.destBucket, `${cfg.destPrefix}mirror/`);
  const mirror: MediaObject[] = [];
  for (const item of mirrorListed) {
    const key = stripMirrorKey(item.key, cfg.destPrefix);
    if (!key) continue;
    mirror.push({ key, etag: item.etag, size: item.size });
  }
  const mirrorByKey = new Map(mirror.map((item) => [item.key, item]));
  let manifest = await loadManifest(destClient, layout);
  const journals = await listBackupObjects(destClient, cfg.destBucket, `${cfg.destPrefix}state/journal/`);
  for (const journal of journals) {
    const text = await readBackupText(destClient, cfg.destBucket, journal.key);
    try {
      manifest = mergeManifest(manifest, parseManifest(text));
    } catch (err) {
      log(`diário ignorado ${journal.key}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const plan = planMediaBackup({ source, mirror, manifest, prefixes: cfg.prefixes });
  const summary = summarizeActions(plan.actions);
  log(
    `plano: ${summary.skip} iguais, ${summary.copy} novos ou repostos, ${summary.changed} trocados, ` +
      `${summary.dropped} saíram da origem (espelho mantido), ${summary.adopt} adotados, ${summary.forget} só no manifesto`,
  );
  if (plan.emptyPrefixes.length) log(`listagem vazia, espelho mantido: ${plan.emptyPrefixes.join(", ")}`);
  if (cfg.dryRun) {
    log("DRY RUN: nenhuma escrita");
    if (plan.emptyPrefixes.length) throw new Error(`listagem vazia em ${plan.emptyPrefixes.join(", ")}`);
    return;
  }

  const locked = await acquireBackupLock(destClient, layout);
  if (!locked) {
    throw new Error("lock de media-backup-r2 ainda preso; a cópia desta execução não rodou");
  }

  try {
    const sourceByKey = new Map(source.map((item) => [item.key, { key: item.key, etag: normalizeEtag(item.etag), size: item.size }]));
    const day = calendarDay(new Date(), cfg.timeZone);
    const stamp = stampMinute(new Date(), cfg.timeZone);
    const minute = stamp.slice(-4);
    let current = manifest;
    const work = plan.actions.filter((action) => action.type !== "skip");
    const journalKeys: string[] = [];
    for (let offset = 0, part = 0; offset < work.length; offset += CHUNK, part += 1) {
      const chunk = work.slice(offset, offset + CHUNK);
      await mapPool(chunk, COPIES_AT_ONCE, (action) => perform(sourceClient, destClient, layout, cfg.destPrefix, day, minute, mirrorByKey, action));
      const delta = applyPlanToManifest(emptyManifest(), sourceByKey, chunk);
      const key = journalObjectKey(cfg.destPrefix, stamp, part);
      await putBackupJson(destClient, layout, key, delta);
      journalKeys.push(key);
      current = mergeManifest(current, delta);
      log(`  lote ${part + 1}: ${Math.min(offset + chunk.length, work.length)}/${work.length}`);
    }
    await putBackupJson(destClient, layout, manifestObjectKey(cfg.destPrefix), current);
    if (journalKeys.length) await deleteBackupKeys(destClient, layout, journalKeys, "journal");

    const expired = cfg.retentionDays === null ? [] : await expiredMediaKeys(destClient, layout, cfg.destPrefix, day, cfg.retentionDays);
    if (cfg.retentionDays === null) log("mídia sem prazo de expiração");
    else if (expired.length) {
      await deleteBackupKeys(destClient, layout, expired, "retention");
      log(`retenção da mídia: ${expired.length} objetos de histórico com mais de ${cfg.retentionDays} dias`);
    }

    if (plan.emptyPrefixes.length) {
      throw new Error(`listagem vazia em ${plan.emptyPrefixes.join(", ")}; espelho desses prefixos foi mantido`);
    }

    const marker = {
      ok: true,
      component: "media-backup-r2",
      finishedAt: new Date().toISOString(),
      sourceCount: source.length,
      ...summary,
      purged: expired.length,
    };
    await putBackupJson(destClient, layout, runMarkerObjectKey(cfg.destPrefix, stamp), marker);
    log(`OK ${cfg.destBucket}/${cfg.destPrefix}runs/${stamp}.json em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await releaseBackupLock(destClient, layout).catch((err: unknown) => {
      log(`não soltei o lock: ${err instanceof Error ? err.message : err}`);
    });
  }
}

async function expiredMediaKeys(
  client: ReturnType<typeof createR2Client>,
  layout: ObjectLayout,
  destPrefix: string,
  day: string,
  retentionDays: number,
): Promise<string[]> {
  const historyListed = await listBackupObjects(client, layout.destBucket, `${destPrefix}history/`);
  const runsListed = await listBackupObjects(client, layout.destBucket, `${destPrefix}runs/`);
  return [
    ...datedKeysToDelete(historyListed.map((item) => item.key), `${destPrefix}history/`, day, retentionDays),
    ...datedKeysToDelete(runsListed.map((item) => item.key), `${destPrefix}runs/`, day, retentionDays),
  ];
}

async function perform(
  sourceClient: ReturnType<typeof createR2Client>,
  destClient: ReturnType<typeof createR2Client>,
  layout: ObjectLayout,
  destPrefix: string,
  day: string,
  minute: string,
  mirrorByKey: ReadonlyMap<string, MediaObject>,
  action: MediaAction,
): Promise<void> {
  if (action.type === "adopt" || action.type === "forget" || action.type === "skip") return;
  if (action.type === "archive-then-copy" || action.type === "archive-gone") {
    const mirror = mirrorByKey.get(action.key);
    const etag = normalizeEtag(mirror?.etag || "noetag");
    await copyWithinBackup(
      destClient,
      layout,
      mirrorObjectKey(destPrefix, action.key),
      historyObjectKey(destPrefix, day, minute, etag, action.key),
    );
  }
  if (action.type === "copy" || action.type === "archive-then-copy") {
    await copyFromSource(sourceClient, destClient, layout, action.key, mirrorObjectKey(destPrefix, action.key));
  }
}

let failed = false;

process.exitCode = 1;
main().then(
  () => process.exit(0),
  async (err: unknown) => {
    if (failed) process.exit(1);
    failed = true;
    const message = redactAlertDetail(err instanceof Error ? err.message : err);
    console.error(`[media-backup] FAILED: ${message}`);
    const cfg = (() => {
      try {
        return readMediaBackupConfig(process.env);
      } catch {
        return null;
      }
    })();
    await alertFailure(message, alertClient, alertBucket, alertPrefix, alertZone);
    process.exit(1);
  },
);
