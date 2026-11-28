#!/usr/bin/env node
// Downloads one backed-up media object to a local file. Does not write to R2
// and does not touch the live bucket.
//
//   MEDIA_RESTORE_KEY=products/abc/foto.jpg \
//   MEDIA_RESTORE_OUTPUT=/tmp/foto.jpg \
//   pnpm --filter @workspace/scripts restore:media:r2
//
// A previous version, from the day it was overwritten or deleted:
//   MEDIA_RESTORE_DAY=2026-11-20

import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { mirrorObjectKey, normalizeDestPrefix } from "./backup/policy";
import { createR2Client, listBackupObjects } from "./backup/r2io";

const log = (...parts: unknown[]) => console.log(`[media-restore] ${new Date().toISOString()}`, ...parts);

function envValue(name: string): string {
  return process.env[name]?.trim() || "";
}

function requireAny(names: string[]): string {
  for (const name of names) {
    const value = envValue(name);
    if (value) return value;
  }
  throw new Error(`Missing env var ${names.join(" ou ")}`);
}

async function main(): Promise<void> {
  const originalKey = envValue("MEDIA_RESTORE_KEY");
  const output = envValue("MEDIA_RESTORE_OUTPUT");
  const day = envValue("MEDIA_RESTORE_DAY");
  if (!originalKey || originalKey.startsWith("/") || originalKey.includes("..")) {
    throw new Error("MEDIA_RESTORE_KEY inválido");
  }
  if (!output || output.includes("\0")) throw new Error("MEDIA_RESTORE_OUTPUT ausente");
  const destPrefix = normalizeDestPrefix(process.env.MEDIA_BACKUP_DEST_PREFIX);
  const bucket = envValue("MEDIA_BACKUP_DEST_BUCKET") || envValue("BACKUP_R2_BUCKET") || "yuri-imports-db-backups";
  const endpoint = envValue("BACKUP_S3_ENDPOINT");
  const client = createR2Client({
    endpoint: endpoint || undefined,
    accountId: endpoint ? "" : requireAny(["CLOUDFLARE_R2_ACCOUNT_ID"]),
    accessKeyId: requireAny(["MEDIA_BACKUP_DEST_R2_ACCESS_KEY_ID", "BACKUP_WATCHDOG_R2_ACCESS_KEY_ID", "BACKUP_R2_ACCESS_KEY_ID"]),
    secretAccessKey: requireAny(["MEDIA_BACKUP_DEST_R2_SECRET_ACCESS_KEY", "BACKUP_WATCHDOG_R2_SECRET_ACCESS_KEY", "BACKUP_R2_SECRET_ACCESS_KEY"]),
    region: process.env.BACKUP_S3_REGION,
  });
  let backupKey = mirrorObjectKey(destPrefix, originalKey);
  if (day) {
    const listed = await listBackupObjects(client, bucket, `${destPrefix}history/${day}/`);
    const matches = listed
      .map((item) => item.key)
      .filter((key) => key.endsWith(`/${originalKey}`))
      .sort();
    const found = matches[matches.length - 1];
    if (!found) throw new Error("versão não encontrada nesse dia");
    backupKey = found;
  }
  log(`baixando ${bucket}/${backupKey}`);
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: backupKey }));
  if (!got.Body) throw new Error("R2 devolveu objeto vazio");
  await pipeline(got.Body as NodeJS.ReadableStream, createWriteStream(output));
  log(`salvo em ${output}. Nada foi escrito no R2.`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[media-restore] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
