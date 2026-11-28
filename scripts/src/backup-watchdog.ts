#!/usr/bin/env node
// Checks that the MySQL dump and the media backup each produced a new object
// inside the last BACKUP_STALE_HOURS (default 26). One WhatsApp to the owner
// when either is missing or late. Exits 1 so the App Platform job shows failed.
// Reads the backup bucket only.

import { backupAlertConfigured, notifyOwnerBackupAlert } from "./backup-alert.mjs";
import {
  assessFreshness,
  freshnessLine,
  mediaRunObjects,
  mysqlBackupObjects,
  readWatchdogConfig,
} from "./backup/policy";
import { createR2Client, listBackupObjects } from "./backup/r2io";

const log = (...parts: unknown[]) => console.log(`[backup-watchdog] ${new Date().toISOString()}`, ...parts);
let notified = false;

async function alertFailure(title: string, lines: string[]): Promise<void> {
  notified = true;
  try {
    const result = await notifyOwnerBackupAlert({ title, lines });
    if (!result.ok) log(`aviso não enviado: ${result.error}`);
  } catch (err) {
    log(`aviso não enviado: ${err instanceof Error ? err.message : err}`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const cfg = readWatchdogConfig(process.env);
  const endpoint = process.env.BACKUP_S3_ENDPOINT?.trim();
  const client = createR2Client({
    endpoint: endpoint || undefined,
    accountId: endpoint ? "" : requireEnv("CLOUDFLARE_R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("BACKUP_R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("BACKUP_R2_SECRET_ACCESS_KEY"),
    region: process.env.BACKUP_S3_REGION,
  });
  const now = new Date();
  const mysqlListed = await listBackupObjects(client, cfg.destBucket, cfg.mysqlPrefix);
  const mediaListed = await listBackupObjects(client, cfg.destBucket, `${cfg.destPrefix}runs/`);
  const mysql = assessFreshness({
    now,
    maxAgeMs: cfg.maxAgeMs,
    timeZone: cfg.timeZone,
    objects: mysqlBackupObjects(mysqlListed, cfg.mysqlPrefix),
  });
  const media = assessFreshness({
    now,
    maxAgeMs: cfg.maxAgeMs,
    timeZone: cfg.timeZone,
    objects: mediaRunObjects(mediaListed, cfg.destPrefix),
  });
  const mysqlLine = freshnessLine("MySQL", mysql, cfg.maxAgeMs);
  const mediaLine = freshnessLine("Mídia", media, cfg.maxAgeMs);
  log(mysqlLine);
  log(mediaLine);

  if (!mysql.ok || !media.ok) {
    await alertFailure("Backup atrasado ou ausente.", [
      mysqlLine,
      mediaLine,
      "Jobs: db-backup-r2 (3h) e media-backup-r2 (3h30), horário de Brasília.",
    ]);
    throw new Error("backup atrasado ou ausente");
  }

  const ready = backupAlertConfigured(process.env);
  if (!ready.ok) {
    log(`backups em dia, mas o aviso não está configurado: ${ready.error}`);
    notified = true;
    throw new Error(ready.error);
  }
  log("OK");
}

process.exitCode = 1;
main().then(
  () => process.exit(0),
  async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backup-watchdog] FAILED: ${message}`);
    if (!notified) {
      await alertFailure("Não consegui conferir os backups.", [
        "Job: backup-watchdog",
        `Motivo: ${message}`,
      ]);
    }
    process.exit(1);
  },
);
