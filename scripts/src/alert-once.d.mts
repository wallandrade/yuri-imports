import type { S3Client } from "@aws-sdk/client-s3";

export function dailyAlertKey(destPrefix: string, day: string): string;

export function dailyAlertExists(client: S3Client, bucket: string, key: string): Promise<boolean>;

export function notifyOwnerOnce(input: {
  client?: S3Client;
  bucket?: string;
  destPrefix?: string;
  timeZone?: string;
  title: string;
  lines?: readonly unknown[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  record?: boolean;
}): Promise<{ ok: boolean; skipped: boolean; error: string }>;
