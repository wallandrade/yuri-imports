export function redactAlertDetail(detail: unknown): string;

export function ownerAlertPhone(
  raw: unknown,
): { ok: true; phone: string } | { ok: false; reason: "empty" | "group" | "phone" };

export function backupAlertText(input: { title?: string; lines?: readonly unknown[] }): string;

export function backupAlertConfigured(
  env?: Record<string, string | undefined>,
): { ok: boolean; error: string };

export function notifyOwnerBackupAlert(input: {
  title: string;
  lines?: readonly unknown[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; error: string }>;
