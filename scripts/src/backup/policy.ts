// Pure backup rules: incremental media plan, retention and stale detection.
// No network. Jobs and unit tests both use this module.

export const DEFAULT_SOURCE_PREFIXES = [
  "products/",
  "tracking-labels/",
  "admin-images/",
  "envioecom-labels/",
  "whatsapp-groups/",
  "site-settings/",
  "uploads/",
] as const;

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
export const DEFAULT_STALE_HOURS = 26;

const NO_MEDIA_EXPIRATION = new Set(["", "0", "none", "off", "never", "sem", "infinito"]);

export type Env = Record<string, string | undefined>;

export type MediaObject = {
  key: string;
  etag: string;
  size: number;
};

export type MediaManifest = {
  version: 1;
  objects: Record<string, { etag: string; size: number }>;
};

export type MediaAction =
  | { type: "skip"; key: string }
  | { type: "adopt"; key: string }
  | { type: "copy"; key: string }
  | { type: "archive-then-copy"; key: string }
  | { type: "archive-then-drop"; key: string }
  | { type: "forget"; key: string };

export type Freshness = {
  ok: boolean;
  latest: Date | null;
  ageMs: number | null;
  sampleKey: string | null;
  reason: "fresh" | "missing" | "stale";
};

export type DatedObject = {
  key: string;
  lastModified?: Date | null;
};

export function emptyManifest(): MediaManifest {
  return { version: 1, objects: {} };
}

export function normalizeEtag(etag: string): string {
  return String(etag || "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
}

export function normalizeSourcePrefixes(raw: string | undefined): string[] {
  const source = raw === undefined ? DEFAULT_SOURCE_PREFIXES.join(",") : raw;
  const prefixes = source
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.endsWith("/") ? part : `${part}/`));
  if (!prefixes.length) throw new Error("MEDIA_BACKUP_SOURCE_PREFIXES vazio");
  if (prefixes.some((prefix) => prefix.includes("..") || prefix.startsWith("/"))) {
    throw new Error("MEDIA_BACKUP_SOURCE_PREFIXES inválido");
  }
  return prefixes;
}

export function normalizeDestPrefix(raw: string | undefined): string {
  const trimmed = (raw ?? "media/").trim() || "media/";
  if (trimmed !== "media" && !trimmed.startsWith("media/")) {
    throw new Error("MEDIA_BACKUP_DEST_PREFIX tem que começar com media/");
  }
  if (trimmed.includes("..") || trimmed.includes("//")) throw new Error("MEDIA_BACKUP_DEST_PREFIX inválido");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function normalizeMysqlPrefix(raw: string | undefined): string {
  const trimmed = (raw ?? "mysql/").trim() || "mysql/";
  if (trimmed.includes("..") || trimmed.startsWith("/")) throw new Error("BACKUP_KEY_PREFIX inválido");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function keyInPrefixes(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

/** null = keep media forever. A positive integer expires only history/ and runs/, never the mirror. */
export function readRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (NO_MEDIA_EXPIRATION.has(trimmed)) return null;
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("MEDIA_BACKUP_RETENTION_DAYS inválido");
  return days;
}

export function readStaleWindowMs(raw: string | undefined): number {
  const hours = raw === undefined || raw.trim() === "" ? DEFAULT_STALE_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours < 20 || hours > 48) {
    throw new Error("BACKUP_STALE_HOURS tem que ficar entre 20 e 48");
  }
  return Math.round(hours * 60 * 60 * 1000);
}

export type MediaBackupConfig = {
  sourceBucket: string;
  destBucket: string;
  destPrefix: string;
  prefixes: string[];
  retentionDays: number | null;
  timeZone: string;
  dryRun: boolean;
};

export function assertDestLayout(input: { sourceBucket: string; destBucket: string; destPrefix: string }): void {
  if (!input.sourceBucket || !input.destBucket) throw new Error("bucket ausente");
  if (input.sourceBucket === input.destBucket) {
    throw new Error("bucket de destino igual ao de origem; recusando para não alterar o bucket da loja");
  }
  if (!input.destPrefix.startsWith("media/") || input.destPrefix.includes("..")) {
    throw new Error("prefixo de destino tem que começar com media/");
  }
}

export function readMediaBackupConfig(env: Env): MediaBackupConfig {
  const sourceBucket = (env.MEDIA_BACKUP_SOURCE_BUCKET || "clayton-assets").trim();
  const destBucket = (env.MEDIA_BACKUP_DEST_BUCKET || env.BACKUP_R2_BUCKET || "yuri-imports-db-backups").trim();
  const destPrefix = normalizeDestPrefix(env.MEDIA_BACKUP_DEST_PREFIX);
  const prefixes = normalizeSourcePrefixes(env.MEDIA_BACKUP_SOURCE_PREFIXES);
  const retentionDays = readRetentionDays(env.MEDIA_BACKUP_RETENTION_DAYS);
  const timeZone = (env.BACKUP_TIME_ZONE || env.TZ || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  const dryRun = env.MEDIA_BACKUP_DRY_RUN === "1";
  const config = { sourceBucket, destBucket, destPrefix, prefixes, retentionDays, timeZone, dryRun };
  assertDestLayout(config);
  return config;
}

export type WatchdogConfig = {
  destBucket: string;
  destPrefix: string;
  mysqlPrefix: string;
  timeZone: string;
  maxAgeMs: number;
};

export function readWatchdogConfig(env: Env): WatchdogConfig {
  const destBucket = (env.MEDIA_BACKUP_DEST_BUCKET || env.BACKUP_R2_BUCKET || "yuri-imports-db-backups").trim();
  if (!destBucket) throw new Error("bucket de backup ausente");
  return {
    destBucket,
    destPrefix: normalizeDestPrefix(env.MEDIA_BACKUP_DEST_PREFIX),
    mysqlPrefix: normalizeMysqlPrefix(env.BACKUP_KEY_PREFIX),
    timeZone: (env.BACKUP_TIME_ZONE || env.TZ || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE,
    maxAgeMs: readStaleWindowMs(env.BACKUP_STALE_HOURS),
  };
}

export function assertDestWrite(input: {
  bucket: string;
  key: string;
  sourceBucket: string;
  destPrefix: string;
}): void {
  assertDestLayout({ sourceBucket: input.sourceBucket, destBucket: input.bucket, destPrefix: input.destPrefix });
  if (input.bucket === input.sourceBucket) throw new Error("recusa escrita no bucket de origem");
  if (!input.key || input.key.includes("..")) throw new Error("chave de backup inválida");
  if (!input.key.startsWith(input.destPrefix)) throw new Error("recusa escrita fora do prefixo de backup");
  if (input.key.startsWith("mysql/")) throw new Error("recusa escrita no prefixo mysql/");
}

export function assertDeletableBackupKey(input: {
  bucket: string;
  key: string;
  sourceBucket: string;
  destPrefix: string;
  reason: "retention" | "drop-mirror";
}): void {
  assertDestWrite(input);
  const history = `${input.destPrefix}history/`;
  const runs = `${input.destPrefix}runs/`;
  const mirror = `${input.destPrefix}mirror/`;
  if (input.reason === "retention" && (input.key.startsWith(history) || input.key.startsWith(runs))) return;
  if (input.reason === "drop-mirror" && input.key.startsWith(mirror)) return;
  throw new Error("recusa apagar essa chave de backup");
}

export function mirrorObjectKey(destPrefix: string, key: string): string {
  return `${destPrefix}mirror/${key}`;
}

export function historyObjectKey(destPrefix: string, day: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("dia do histórico inválido");
  return `${destPrefix}history/${day}/${key}`;
}

export function runMarkerObjectKey(destPrefix: string, stamp: string): string {
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(stamp)) throw new Error("marca de execução inválida");
  return `${destPrefix}runs/${stamp}.json`;
}

export function manifestObjectKey(destPrefix: string): string {
  return `${destPrefix}state/manifest.json`;
}

export function stripMirrorKey(listedKey: string, destPrefix: string): string | null {
  const prefix = `${destPrefix}mirror/`;
  if (!listedKey.startsWith(prefix)) return null;
  const rest = listedKey.slice(prefix.length);
  if (!rest || rest.endsWith("/")) return null;
  return rest;
}

export function encodeCopySource(bucket: string, key: string): string {
  if (!bucket || bucket.includes("/") || bucket.includes("..")) throw new Error("bucket inválido");
  const encoded = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${bucket}/${encoded}`;
}

function sameVersion(
  stored: { etag: string; size: number } | undefined,
  source: MediaObject,
): boolean {
  if (!stored || !source.etag) return false;
  return normalizeEtag(stored.etag) === source.etag && stored.size === source.size;
}

export function planMediaBackup(input: {
  source: MediaObject[];
  mirror: MediaObject[];
  manifest: MediaManifest;
  prefixes: readonly string[];
}): MediaAction[] {
  const sourceByKey = new Map<string, MediaObject>();
  for (const obj of input.source) {
    if (!obj.key || obj.key.endsWith("/") || obj.key.includes("..") || obj.key.startsWith("/")) continue;
    if (!keyInPrefixes(obj.key, input.prefixes)) continue;
    sourceByKey.set(obj.key, { key: obj.key, etag: normalizeEtag(obj.etag), size: obj.size });
  }
  const mirrorByKey = new Map<string, MediaObject>();
  for (const obj of input.mirror) {
    if (!obj.key || obj.key.endsWith("/") || obj.key.includes("..") || obj.key.startsWith("/")) continue;
    mirrorByKey.set(obj.key, { key: obj.key, etag: normalizeEtag(obj.etag), size: obj.size });
  }
  const mirrorTracksPrefix = [...mirrorByKey.keys()].some((key) => keyInPrefixes(key, input.prefixes));
  const manifestTracksPrefix = Object.keys(input.manifest.objects).some((key) => keyInPrefixes(key, input.prefixes));
  if (sourceByKey.size === 0) {
    if (mirrorTracksPrefix || manifestTracksPrefix) {
      throw new Error("listagem da origem veio vazia com backup já existente; recusando para não apagar o espelho");
    }
    throw new Error("nenhum objeto da mídia nos prefixos configurados");
  }

  const actions: MediaAction[] = [];
  for (const [key, src] of sourceByKey) {
    const prev = input.manifest.objects[key];
    const mirror = mirrorByKey.get(key);
    if (sameVersion(prev, src) && mirror) {
      actions.push({ type: "skip", key });
    } else if (sameVersion(prev, src) && !mirror) {
      actions.push({ type: "copy", key });
    } else if (!prev && sameVersion(mirror, src)) {
      actions.push({ type: "adopt", key });
    } else if (mirror) {
      actions.push({ type: "archive-then-copy", key });
    } else {
      actions.push({ type: "copy", key });
    }
  }

  const tracked = new Set<string>([...Object.keys(input.manifest.objects), ...mirrorByKey.keys()]);
  for (const key of tracked) {
    if (sourceByKey.has(key)) continue;
    if (key.includes("..") || key.startsWith("/")) continue;
    if (!keyInPrefixes(key, input.prefixes)) continue;
    if (mirrorByKey.has(key)) actions.push({ type: "archive-then-drop", key });
    else if (input.manifest.objects[key]) actions.push({ type: "forget", key });
  }
  return actions;
}

export function applyPlanToManifest(
  manifest: MediaManifest,
  sourceByKey: ReadonlyMap<string, MediaObject>,
  actions: readonly MediaAction[],
): MediaManifest {
  const objects = { ...manifest.objects };
  for (const action of actions) {
    if (action.type === "archive-then-drop" || action.type === "forget") {
      delete objects[action.key];
      continue;
    }
    if (action.type === "skip") continue;
    const src = sourceByKey.get(action.key);
    if (!src?.etag) continue;
    objects[action.key] = { etag: src.etag, size: src.size };
  }
  return { version: 1, objects };
}

export function summarizeActions(actions: readonly MediaAction[]): {
  skip: number;
  adopt: number;
  copy: number;
  changed: number;
  dropped: number;
  forget: number;
} {
  const summary = { skip: 0, adopt: 0, copy: 0, changed: 0, dropped: 0, forget: 0 };
  for (const action of actions) {
    if (action.type === "skip") summary.skip += 1;
    else if (action.type === "adopt") summary.adopt += 1;
    else if (action.type === "copy") summary.copy += 1;
    else if (action.type === "archive-then-copy") summary.changed += 1;
    else if (action.type === "archive-then-drop") summary.dropped += 1;
    else summary.forget += 1;
  }
  return summary;
}

export function parseManifest(text: string): MediaManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("manifesto de mídia inválido");
  }
  if (!parsed || typeof parsed !== "object" || !("objects" in parsed)) throw new Error("manifesto de mídia inválido");
  const raw = (parsed as { objects?: unknown }).objects;
  if (!raw || typeof raw !== "object") throw new Error("manifesto de mídia inválido");
  const objects: MediaManifest["objects"] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const etag = "etag" in value ? normalizeEtag(String(value.etag || "")) : "";
    const size = "size" in value ? Number((value as { size?: unknown }).size) : Number.NaN;
    if (!etag || !Number.isFinite(size) || size < 0) continue;
    objects[key] = { etag, size };
  }
  return { version: 1, objects };
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guessed = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = timeZoneOffsetMs(new Date(guessed), timeZone);
  let utc = guessed - offset;
  const offset2 = timeZoneOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) utc = guessed - offset2;
  return new Date(utc);
}

export function calendarDay(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function stampMinute(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  let hour = parts.hour;
  if (hour === "24") hour = "00";
  return `${parts.year}-${parts.month}-${parts.day}_${hour}${parts.minute}`;
}

export function addCalendarDays(day: string, delta: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("dia inválido");
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + delta);
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Apaga só o histórico e as marcas mais velhos que a retenção. O dia exato do corte fica. */
export function datedKeysToDelete(keys: readonly string[], prefix: string, today: string, retentionDays: number): string[] {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("retenção inválida");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("dia inválido");
  const cutoff = addCalendarDays(today, -retentionDays);
  const expired: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const day = key.slice(prefix.length, prefix.length + 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day < cutoff) expired.push(key);
  }
  return expired;
}

export function parseKeyedInstant(key: string, timeZone: string): Date | null {
  const match = key.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  if (!match) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  return zonedWallTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]), hour, minute, timeZone);
}

export function assessFreshness(input: {
  now: Date;
  maxAgeMs: number;
  timeZone: string;
  objects: readonly DatedObject[];
}): Freshness {
  let latest: Date | null = null;
  let sampleKey: string | null = null;
  for (const obj of input.objects) {
    const when = obj.lastModified ?? parseKeyedInstant(obj.key, input.timeZone);
    if (!when || Number.isNaN(when.getTime())) continue;
    if (!latest || when.getTime() > latest.getTime()) {
      latest = when;
      sampleKey = obj.key;
    }
  }
  if (!latest) return { ok: false, latest: null, ageMs: null, sampleKey: null, reason: "missing" };
  const ageMs = input.now.getTime() - latest.getTime();
  if (ageMs >= input.maxAgeMs) return { ok: false, latest, ageMs, sampleKey, reason: "stale" };
  return { ok: true, latest, ageMs, sampleKey, reason: "fresh" };
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "sem arquivo";
  const hours = Math.max(0, ageMs) / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} dias`;
}

export function freshnessLine(label: string, result: Freshness, maxAgeMs: number): string {
  if (result.reason === "missing" || !result.latest) {
    return `${label}: nenhum backup encontrado (limite ${formatAge(maxAgeMs)}).`;
  }
  const state = result.ok ? "ok" : "atrasado";
  return `${label}: ${state}, último ${result.sampleKey} há ${formatAge(result.ageMs)} (limite ${formatAge(maxAgeMs)}).`;
}

export function mysqlBackupObjects<T extends { key: string }>(objects: readonly T[], mysqlPrefix: string): T[] {
  return objects.filter((obj) => obj.key.startsWith(mysqlPrefix) && obj.key.endsWith(".sql.gz"));
}

export function mediaRunObjects<T extends { key: string }>(objects: readonly T[], destPrefix: string): T[] {
  const prefix = `${destPrefix}runs/`;
  return objects.filter((obj) => obj.key.startsWith(prefix) && obj.key.endsWith(".json"));
}
