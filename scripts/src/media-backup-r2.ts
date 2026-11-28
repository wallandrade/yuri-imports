#!/usr/bin/env node
// Daily incremental copy of store media from the live R2 bucket into the private
// backup bucket. The live bucket is only listed and read. Deletes stay under
// media/history, media/runs and, for files removed at the source, media/mirror.
//
// Layout in the backup bucket:
//   media/mirror/<chave original>                 last good copy
//   media/history/YYYY-MM-DD/<chave original>     previous bytes, or the last copy of a deleted file
//   media/state/manifest.json                     source etag of what the mirror should hold
//   media/runs/YYYY-MM-DD_HHmm.json               success marker for the watchdog
//
// Unchanged files are not copied again. A changed or deleted file keeps the
// previous bytes under history/ until MEDIA_BACKUP_RETENTION_DAYS (default 30).

import { notifyOwnerBackupAlert } from "./backup-alert.mjs";
import {
  applyPlanToManifest,
  calendarDay,
  datedKeysToDelete,
  historyObjectKey,
  manifestObjectKey,
  mirrorObjectKey,
  normalizeEtag,
  planMediaBackup,
  readMediaBackupConfig,
  runMarkerObjectKey,
  stampMinute,
  stripMirrorKey,
  summarizeActions,
  type MediaAction,
  type MediaObject,
} from "./backup/policy";
import {
  copyBackupObject,
  createR2Client,
  deleteBackupKeys,
  isNotFound,
  listBackupObjects,
  loadManifest,
  putBackupJson,
  type ObjectLayout,
} from "./backup/r2io";

const log = (...parts: unknown[]) => console.log(`[media-backup] ${new Date().toISOString()}`, ...parts);
const CHUNK = 40;
const COPIES_AT_ONCE = 4;

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

async function alertFailure(detail: string): Promise<void> {
  try {
    const result = await notifyOwnerBackupAlert({
      title: "O backup da mídia falhou.",
      lines: [
        "Job: media-backup-r2",
        `Motivo: ${detail}`,
        "Nada foi apagado nem alterado no bucket clayton-assets.",
      ],
    });
    if (!result.ok) log(`aviso não enviado: ${result.error}`);
  } catch (err) {
    log(`aviso não enviado: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const cfg = readMediaBackupConfig(process.env);
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const client = createR2Client({
    endpoint: endpoint || undefined,
    accountId: endpoint ? "" : requireEnv("CLOUDFLARE_R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("MEDIA_BACKUP_R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("MEDIA_BACKUP_R2_SECRET_ACCESS_KEY"),
    region: process.env.BACKUP_S3_REGION,
  });
  const layout: ObjectLayout = {
    sourceBucket: cfg.sourceBucket,
    destBucket: cfg.destBucket,
    destPrefix: cfg.destPrefix,
  };
  log(`origem ${cfg.sourceBucket} prefixos ${cfg.prefixes.join(",")} → ${cfg.destBucket}/${cfg.destPrefix}`);

  const sourceListed = [];
  for (const prefix of cfg.prefixes) {
    sourceListed.push(...await listBackupObjects(client, cfg.sourceBucket, prefix));
  }
  const source: MediaObject[] = sourceListed.map((item) => ({ key: item.key, etag: item.etag, size: item.size }));
  const mirrorListed = await listBackupObjects(client, cfg.destBucket, `${cfg.destPrefix}mirror/`);
  const mirror: MediaObject[] = [];
  for (const item of mirrorListed) {
    const key = stripMirrorKey(item.key, cfg.destPrefix);
    if (!key) continue;
    mirror.push({ key, etag: item.etag, size: item.size });
  }
  const manifest = await loadManifest(client, layout);
  const actions = planMediaBackup({ source, mirror, manifest, prefixes: cfg.prefixes });
  const summary = summarizeActions(actions);
  log(
    `plano: ${summary.skip} iguais, ${summary.copy} novos ou repostos, ${summary.changed} trocados, ` +
      `${summary.dropped} apagados na origem, ${summary.adopt} adotados, ${summary.forget} só no manifesto`,
  );
  if (cfg.dryRun) {
    log("DRY RUN: nenhuma escrita");
    return;
  }

  const sourceByKey = new Map(source.map((item) => [item.key, { key: item.key, etag: normalizeEtag(item.etag), size: item.size }]));
  const day = calendarDay(new Date(), cfg.timeZone);
  let current = manifest;
  const work = actions.filter((action) => action.type !== "skip");
  for (let offset = 0; offset < work.length; offset += CHUNK) {
    const chunk = work.slice(offset, offset + CHUNK);
    await mapPool(chunk, COPIES_AT_ONCE, (action) => perform(client, layout, cfg.destPrefix, day, action));
    current = applyPlanToManifest(current, sourceByKey, chunk);
    await putBackupJson(client, layout, manifestObjectKey(cfg.destPrefix), current);
    log(`  manifesto ${Math.min(offset + chunk.length, work.length)}/${work.length}`);
  }

  const historyListed = await listBackupObjects(client, cfg.destBucket, `${cfg.destPrefix}history/`);
  const runsListed = await listBackupObjects(client, cfg.destBucket, `${cfg.destPrefix}runs/`);
  const expired = [
    ...datedKeysToDelete(historyListed.map((item) => item.key), `${cfg.destPrefix}history/`, day, cfg.retentionDays),
    ...datedKeysToDelete(runsListed.map((item) => item.key), `${cfg.destPrefix}runs/`, day, cfg.retentionDays),
  ];
  if (expired.length) {
    await deleteBackupKeys(client, layout, expired, "retention");
    log(`retenção: ${expired.length} objetos com mais de ${cfg.retentionDays} dias`);
  }

  const stamp = stampMinute(new Date(), cfg.timeZone);
  const marker = {
    ok: true,
    component: "media-backup-r2",
    finishedAt: new Date().toISOString(),
    sourceCount: source.length,
    ...summary,
    purged: expired.length,
  };
  await putBackupJson(client, layout, runMarkerObjectKey(cfg.destPrefix, stamp), marker);
  log(`OK ${cfg.destBucket}/${cfg.destPrefix}runs/${stamp}.json em ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function perform(
  client: ReturnType<typeof createR2Client>,
  layout: ObjectLayout,
  destPrefix: string,
  day: string,
  action: MediaAction,
): Promise<void> {
  if (action.type === "adopt" || action.type === "forget" || action.type === "skip") return;
  if (action.type === "copy" || action.type === "archive-then-copy") {
    if (action.type === "archive-then-copy") await archiveMirror(client, layout, destPrefix, day, action.key);
    await copyBackupObject(client, layout, layout.sourceBucket, action.key, mirrorObjectKey(destPrefix, action.key));
    return;
  }
  await archiveMirror(client, layout, destPrefix, day, action.key);
  await deleteBackupKeys(client, layout, [mirrorObjectKey(destPrefix, action.key)], "drop-mirror");
}

async function archiveMirror(
  client: ReturnType<typeof createR2Client>,
  layout: ObjectLayout,
  destPrefix: string,
  day: string,
  key: string,
): Promise<void> {
  try {
    await copyBackupObject(
      client,
      layout,
      layout.destBucket,
      mirrorObjectKey(destPrefix, key),
      historyObjectKey(destPrefix, day, key),
    );
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

process.exitCode = 1;
main().then(
  () => process.exit(0),
  async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[media-backup] FAILED: ${err instanceof Error ? err.stack : err}`);
    await alertFailure(message);
    process.exit(1);
  },
);
