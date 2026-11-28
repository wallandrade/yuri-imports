// R2 reads and writes for the media backup. Every write is checked against the
// source bucket before the request goes out. Listing and GetObject are the only
// calls that may name the store bucket.

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertDeletableBackupKey,
  assertDestWrite,
  encodeCopySource,
  manifestObjectKey,
  parseManifest,
  type MediaManifest,
} from "./policy";

const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

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

export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const metadata = "$metadata" in err ? err.$metadata : null;
  const status = metadata && typeof metadata === "object" && "httpStatusCode" in metadata
    ? Number(metadata.httpStatusCode)
    : 0;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
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
  reason: "retention" | "drop-mirror",
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

async function copyByDownload(
  client: S3Client,
  layout: ObjectLayout,
  fromBucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  const got = await client.send(new GetObjectCommand({ Bucket: fromBucket, Key: fromKey }));
  const length = Number(got.ContentLength || 0);
  if (length > MAX_BUFFER_BYTES) throw new Error(`arquivo maior que 256 MiB: ${fromKey}`);
  if (!got.Body) throw new Error(`sem corpo para copiar: ${fromKey}`);
  const bytes = await got.Body.transformToByteArray();
  if (bytes.byteLength > MAX_BUFFER_BYTES) throw new Error(`arquivo maior que 256 MiB: ${fromKey}`);
  assertDestWrite({ bucket: layout.destBucket, key: toKey, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  await client.send(new PutObjectCommand({
    Bucket: layout.destBucket,
    Key: toKey,
    Body: bytes,
    ContentType: got.ContentType || "application/octet-stream",
    ContentLength: bytes.byteLength,
  }));
}

/** Copies into the backup bucket. The destination bucket is always layout.destBucket. */
export async function copyBackupObject(
  client: S3Client,
  layout: ObjectLayout,
  fromBucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  if (fromBucket !== layout.sourceBucket && fromBucket !== layout.destBucket) {
    throw new Error("origem da cópia não é um bucket deste backup");
  }
  assertDestWrite({ bucket: layout.destBucket, key: toKey, sourceBucket: layout.sourceBucket, destPrefix: layout.destPrefix });
  try {
    await client.send(new CopyObjectCommand({
      Bucket: layout.destBucket,
      Key: toKey,
      CopySource: encodeCopySource(fromBucket, fromKey),
    }));
    return;
  } catch (err) {
    if (isNotFound(err)) throw err;
  }
  await copyByDownload(client, layout, fromBucket, fromKey, toKey);
}
