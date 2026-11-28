// R2 reads and writes for the media backup. Every write is checked against the
// source bucket before the request goes out. Listing and GetObject are the only
// calls that may name the store bucket.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertDeletableBackupKey,
  assertDestWrite,
  encodeCopySource,
  lockObjectKey,
  manifestObjectKey,
  parseManifest,
  type MediaManifest,
} from "./policy";

const PART_BYTES = 8 * 1024 * 1024;
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

export type ObjectLayout = {
  sourceBucket: string;
  destBucket: string;
  destPrefix: string;
};

export type ListedBackupObject = {
  key: string;
  etag: string;
  size: number;
  lastModified: Date | null;
};

export type R2Settings = {
  endpoint?: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

export function createR2Client(settings: R2Settings): S3Client {
  const endpoint = settings.endpoint || `https://${settings.accountId}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: settings.region || "auto",
    endpoint,
    forcePathStyle: Boolean(settings.endpoint),
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function httpStatus(err: unknown): number {
  if (!err || typeof err !== "object" || !("$metadata" in err)) return 0;
  const metadata = err.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata)) return 0;
  return Number(metadata.httpStatusCode);
}

export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const status = httpStatus(err);
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

export function isPreconditionFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  return name === "PreconditionFailed" || httpStatus(err) === 412;
}

export async function listBackupObjects(client: S3Client, bucket: string, prefix: string): Promise<ListedBackupObject[]> {
  const objects: ListedBackupObject[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key) continue;
      objects.push({
        key: item.Key,
        etag: item.ETag || "",
        size: item.Size ?? 0,
        lastModified: item.LastModified ?? null,
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

export async function readBackupText(client: S3Client, bucket: string, key: string): Promise<string> {
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await got.Body?.transformToString()) || "";
}

export async function loadManifest(client: S3Client, layout: ObjectLayout): Promise<MediaManifest> {
  const key = manifestObjectKey(layout.destPrefix);
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: layout.destBucket, Key: key }));
    const text = await got.Body?.transformToString();
    return parseManifest(text || "");
  } catch (err) {
    if (isNotFound(err)) return { version: 1, objects: {} };
    throw err;
  }
}

export async function putBackupJson(client: S3Client, layout: ObjectLayout, key: string, value: unknown): Promise<void> {
  assertDestWrite({ bucket: layout.destBucket, key, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  const body = Buffer.from(JSON.stringify(value));
  await client.send(new PutObjectCommand({
    Bucket: layout.destBucket,
    Key: key,
    Body: body,
    ContentType: "application/json",
    ContentLength: body.length,
  }));
}

export async function deleteBackupKeys(
  client: S3Client,
  layout: ObjectLayout,
  keys: readonly string[],
  reason: "retention" | "journal" | "release-lock",
): Promise<void> {
  for (const key of keys) {
    assertDeletableBackupKey({
      bucket: layout.destBucket,
      key,
      sourceBucket: layout.sourceBucket,
      destPrefix: layout.destPrefix,
      reason,
    });
  }
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const chunk = keys.slice(offset, offset + 1000);
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: layout.destBucket,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }));
    if (result.Errors?.length) throw new Error(`falha ao apagar ${result.Errors.length} objetos de backup`);
  }
}

async function* partsOf(body: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    pending.push(buf);
    pendingBytes += buf.length;
    while (pendingBytes >= PART_BYTES) {
      const all = Buffer.concat(pending, pendingBytes);
      yield all.subarray(0, PART_BYTES);
      const rest = all.subarray(PART_BYTES);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  }
  if (pendingBytes) yield Buffer.concat(pending, pendingBytes);
}

/** Reads with the source token and writes with the destination token. One 8 MiB part at a time. */
export async function copyFromSource(
  sourceClient: S3Client,
  destClient: S3Client,
  layout: ObjectLayout,
  fromKey: string,
  toKey: string,
): Promise<void> {
  assertDestWrite({ bucket: layout.destBucket, key: toKey, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  const got = await sourceClient.send(new GetObjectCommand({ Bucket: layout.sourceBucket, Key: fromKey }));
  if (!got.Body) throw new Error(`sem corpo para copiar: ${fromKey}`);
  const contentType = got.ContentType || "application/octet-stream";
  const iterator = got.Body as AsyncIterable<Uint8Array>;
  let uploadId = "";
  let partNumber = 0;
  const parts: { ETag: string; PartNumber: number }[] = [];
  let first: Buffer | null = null;
  try {
    for await (const part of partsOf(iterator)) {
      if (partNumber === 0 && part.length < PART_BYTES) {
        first = part;
        break;
      }
      if (!uploadId) {
        const created = await destClient.send(new CreateMultipartUploadCommand({
          Bucket: layout.destBucket,
          Key: toKey,
          ContentType: contentType,
        }));
        uploadId = created.UploadId || "";
        if (!uploadId) throw new Error("upload multipart sem id");
      }
      partNumber += 1;
      const uploaded = await destClient.send(new UploadPartCommand({
        Bucket: layout.destBucket,
        Key: toKey,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: part,
      }));
      if (!uploaded.ETag) throw new Error(`parte ${partNumber} sem ETag`);
      parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
    }
    if (!uploadId) {
      const body = first ?? Buffer.alloc(0);
      await destClient.send(new PutObjectCommand({
        Bucket: layout.destBucket,
        Key: toKey,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }));
      return;
    }
    await destClient.send(new CompleteMultipartUploadCommand({
      Bucket: layout.destBucket,
      Key: toKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
    uploadId = "";
  } catch (err) {
    if (uploadId) {
      await destClient.send(new AbortMultipartUploadCommand({
        Bucket: layout.destBucket,
        Key: toKey,
        UploadId: uploadId,
      })).catch(() => undefined);
    }
    throw err;
  }
}

/** Copies inside the backup bucket. If-None-Match avoids overwriting history. */
export async function copyWithinBackup(
  destClient: S3Client,
  layout: ObjectLayout,
  fromKey: string,
  toKey: string,
): Promise<void> {
  assertDestWrite({ bucket: layout.destBucket, key: toKey, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  try {
    await destClient.send(new CopyObjectCommand({
      Bucket: layout.destBucket,
      Key: toKey,
      CopySource: encodeCopySource(layout.destBucket, fromKey),
      IfNoneMatch: "*",
    }));
  } catch (err) {
    if (isPreconditionFailed(err)) return;
    if (isNotFound(err)) return;
    throw err;
  }
}

export async function acquireBackupLock(client: S3Client, layout: ObjectLayout): Promise<boolean> {
  const key = lockObjectKey(layout.destPrefix);
  assertDestWrite({ bucket: layout.destBucket, key, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  const fresh = Buffer.from(JSON.stringify({ startedAt: new Date().toISOString() }));
  try {
    await client.send(new PutObjectCommand({
      Bucket: layout.destBucket,
      Key: key,
      Body: fresh,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
    return true;
  } catch (err) {
    if (!isPreconditionFailed(err)) throw err;
  }
  const existing = await client.send(new GetObjectCommand({ Bucket: layout.destBucket, Key: key }));
  const text = await existing.Body?.transformToString();
  let startedAt = Number.NaN;
  try {
    const parsed = JSON.parse(text || "") as { startedAt?: string };
    startedAt = Date.parse(String(parsed.startedAt || ""));
  } catch {
    startedAt = Number.NaN;
  }
  if (Number.isFinite(startedAt) && Date.now() - startedAt < LOCK_TTL_MS) return false;
  await client.send(new PutObjectCommand({
    Bucket: layout.destBucket,
    Key: key,
    Body: fresh,
    ContentType: "application/json",
  }));
  return true;
}

export async function releaseBackupLock(client: S3Client, layout: ObjectLayout): Promise<void> {
  await deleteBackupKeys(client, layout, [lockObjectKey(layout.destPrefix)], "release-lock");
}

export async function alertMarkerExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
