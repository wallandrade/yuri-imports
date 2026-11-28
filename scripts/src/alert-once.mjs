// One WhatsApp per calendar day in America/Sao_Paulo. The marker lives in the
// backup bucket. A read-only caller can look and skip, but does not write it.

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { notifyOwnerBackupAlert } from "./backup-alert.mjs";
import { calendarDay } from "./mysql-retention.mjs";

export function dailyAlertKey(destPrefix, day) {
  return `${destPrefix}state/alerts/${day}.json`;
}

function missing(err) {
  const name = err && err.name;
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

export async function dailyAlertExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}

export async function notifyOwnerOnce({
  client,
  bucket,
  destPrefix = "media/",
  timeZone = "America/Sao_Paulo",
  title,
  lines,
  env = process.env,
  fetchImpl = fetch,
  record = true,
}) {
  const day = calendarDay(new Date(), timeZone);
  const key = dailyAlertKey(destPrefix, day);
  if (client && await dailyAlertExists(client, bucket, key)) {
    console.error("[backup-alert] aviso já enviado hoje; WhatsApp não repetido");
    return { ok: true, skipped: true, error: "" };
  }
  const result = await notifyOwnerBackupAlert({ title, lines, env, fetchImpl });
  if (!result.ok || !record || !client) return { ...result, skipped: false };
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify({ day, sentAt: new Date().toISOString() }),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
  } catch (err) {
    if (!missing(err) && err?.name !== "PreconditionFailed" && err?.$metadata?.httpStatusCode !== 412) {
      console.error("[backup-alert] não gravei a marca do aviso de hoje");
    }
  }
  return { ...result, skipped: false };
}
