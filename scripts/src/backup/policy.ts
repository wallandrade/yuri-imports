// Pure backup rules: incremental media plan, retention and stale detection.
// No network. Jobs and unit tests both use this module.

export const STORE_BUCKET = "clayton-assets";
export const BACKUP_BUCKET = "yuri-imports-db-backups";

/** Pastas que a API grava hoje. O padrão do job é o bucket inteiro, não esta lista. */
export const KNOWN_SOURCE_PREFIXES = [
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

export type MediaManifestEntry = { etag: string; size: number; gone?: boolean };

export type MediaManifest = {
  version: 1;
  objects: Record<string, MediaManifestEntry>;
};

export type MediaAction =
  | { type: "skip"; key: string }
  | { type: "adopt"; key: string }
  | { type: "copy"; key: string }
  | { type: "archive-then-copy"; key: string }
  | { type: "archive-gone"; key: string }
  | { type: "forget"; key: string };

export type MediaPlan = {
  actions: MediaAction[];
  /** Prefixo listado vazio embora o backup já tivesse arquivo. O espelho desse prefixo fica. */
  emptyPrefixes: string[];
};

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

/** null = todos os objetos do bucket. Lista explícita restringe e recusa prefixo desconhecido. */
export function normalizeSourcePrefixes(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "*") return null;
  const prefixes = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.endsWith("/") ? part : `${part}/`));
  if (!prefixes.length) return null;
  if (prefixes.some((prefix) => prefix.includes("..") || prefix.startsWith("/"))) {
    throw new Error("MEDIA_BACKUP_SOURCE_PREFIXES inválido");
  }
  return prefixes;
}

export function rootPrefixOf(key: string): string {
  const slash = key.indexOf("/");
  if (slash <= 0) return "";
  return key.slice(0, slash + 1);
}

export function unknownRootPrefixes(keys: readonly string[], allowed: readonly string[] | null): string[] {
  if (!allowed) return [];
  const found = new Set<string>();
  for (const key of keys) {
    if (!key || key.endsWith("/") || key.includes("..")) continue;
    const root = rootPrefixOf(key);
    if (!root || allowed.includes(root)) continue;
    found.add(root);
  }
  return [...found].sort();
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

export function keyInPrefixes(key: string, prefixes: readonly string[] | null): boolean {
  if (!prefixes) return true;
  return prefixes.some((prefix) => key.startsWith(prefix));
}

/** null = keep media forever. A positive integer expires only history/ and runs/, never the mirror. */
export function readRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (NO_MEDIA_EXPIRATION.has(trimmed)) return null;
  if (!/^\d+$/.test(trimmed)) throw new Error("MEDIA_BACKUP_RETENTION_DAYS inválido");
  const days = Number(trimmed);
  if (days < 1 || days > 3650) throw new Error("MEDIA_BACKUP_RETENTION_DAYS inválido");
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
  prefixes: string[] | null;
  retentionDays: number | null;
  timeZone: string;
  dryRun: boolean;
};

export function assertExpectedBuckets(sourceBucket: string, destBucket: string): void {
  if (destBucket === STORE_BUCKET) throw new Error("recusa destino clayton-assets");
  if (sourceBucket !== STORE_BUCKET || destBucket !== BACKUP_BUCKET) {
    throw new Error("buckets fora da lista permitida");
  }
}

export function assertDestLayout(input: { sourceBucket: string; destBucket: string; destPrefix: string }): void {
  if (!input.sourceBucket || !input.destBucket) throw new Error("bucket ausente");
  assertExpectedBuckets(input.sourceBucket, input.destBucket);
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
  if (input.bucket === STORE_BUCKET || input.bucket === input.sourceBucket) {
    throw new Error("recusa escrita no bucket de origem");
  }
  if (input.bucket !== BACKUP_BUCKET) throw new Error("recusa escrita fora do bucket de backup");
  if (!input.key || input.key.includes("..")) throw new Error("chave de backup inválida");
  if (!input.key.startsWith(input.destPrefix)) throw new Error("recusa escrita fora do prefixo de backup");
  if (input.key.startsWith("mysql/")) throw new Error("recusa escrita no prefixo mysql/");
}

export function assertDeletableBackupKey(input: {
  bucket: string;
  key: string;
  sourceBucket: string;
  destPrefix: string;
  reason: "retention" | "journal" | "release-lock";
}): void {
  assertDestWrite(input);
  const history = `${input.destPrefix}history/`;
  const runs = `${input.destPrefix}runs/`;
  const journal = `${input.destPrefix}state/journal/`;
  const lock = `${input.destPrefix}state/lock.json`;
  if (input.reason === "retention" && (input.key.startsWith(history) || input.key.startsWith(runs))) return;
  if (input.reason === "journal" && input.key.startsWith(journal)) return;
  if (input.reason === "release-lock" && input.key === lock) return;
  throw new Error("recusa apagar essa chave de backup");
}

export function mirrorObjectKey(destPrefix: string, key: string): string {
  return `${destPrefix}mirror/${key}`;
}

export function historyObjectKey(destPrefix: string, day: string, minute: string, etag: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("dia do histórico inválido");
  if (!/^\d{4}$/.test(minute)) throw new Error("minuto do histórico inválido");
  const safeEtag = etag.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || "noetag";
  return `${destPrefix}history/${day}/${minute}/${safeEtag}/${key}`;
}

export function journalObjectKey(destPrefix: string, stamp: string, index: number): string {
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(stamp)) throw new Error("marca de execução inválida");
  return `${destPrefix}state/journal/${stamp}-${String(index).padStart(4, "0")}.json`;
}

export function alertMarkerObjectKey(destPrefix: string, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("dia inválido");
  return `${destPrefix}state/alerts/${day}.json`;
}

export function lockObjectKey(destPrefix: string): string {
  return `${destPrefix}state/lock.json`;
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

function underRoot(key: string, root: string): boolean {
  return root === "" ? !key.includes("/") : key.startsWith(root);
}

export function planMediaBackup(input: {
  source: MediaObject[];
  mirror: MediaObject[];
  manifest: MediaManifest;
  prefixes: readonly string[] | null;
}): MediaPlan {
  const sourceByKey = new Map<string, MediaObject>();
  for (const obj of input.source) {
    if (!obj.key || obj.key.endsWith("/") || obj.key.includes("..") || obj.key.startsWith("/")) continue;
    if (!keyInPrefixes(obj.key, input.prefixes)) continue;
    sourceByKey.set(obj.key, { key: obj.key, etag: normalizeEtag(obj.etag), size: obj.size });
  }
  const mirrorByKey = new Map<string, MediaObject>();
  for (const obj of input.mirror) {
    if (!obj.key || obj.key.endsWith("/") || obj.key.includes("..") || obj.key.startsWith("/")) continue;
    if (!keyInPrefixes(obj.key, input.prefixes)) continue;
    mirrorByKey.set(obj.key, { key: obj.key, etag: normalizeEtag(obj.etag), size: obj.size });
  }

  const roots = new Set<string>();
  if (input.prefixes) {
    for (const prefix of input.prefixes) roots.add(prefix);
  }
  for (const key of sourceByKey.keys()) roots.add(rootPrefixOf(key));
  for (const key of mirrorByKey.keys()) roots.add(rootPrefixOf(key));
  for (const key of Object.keys(input.manifest.objects)) {
    if (keyInPrefixes(key, input.prefixes)) roots.add(rootPrefixOf(key));
  }

  const emptyPrefixes: string[] = [];
  const protectedRoots = new Set<string>();
  for (const root of roots) {
    const listed = [...sourceByKey.keys()].some((key) => underRoot(key, root));
    const had = [...mirrorByKey.keys(), ...Object.keys(input.manifest.objects)].some((key) => underRoot(key, root));
    if (!listed && had) {
      emptyPrefixes.push(root || "(raiz)");
      protectedRoots.add(root);
    }
  }
  if (sourceByKey.size === 0 && emptyPrefixes.length === 0) {
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
    if (protectedRoots.has(rootPrefixOf(key))) continue;
    if (input.manifest.objects[key]?.gone) continue;
    if (mirrorByKey.has(key)) actions.push({ type: "archive-gone", key });
    else if (input.manifest.objects[key]) actions.push({ type: "forget", key });
  }
  return { actions, emptyPrefixes };
}

export function applyPlanToManifest(
  manifest: MediaManifest,
  sourceByKey: ReadonlyMap<string, MediaObject>,
  actions: readonly MediaAction[],
): MediaManifest {
  const objects = { ...manifest.objects };
  for (const action of actions) {
    if (action.type === "forget") {
      delete objects[action.key];
      continue;
    }
    if (action.type === "archive-gone") {
      const prev = objects[action.key];
      objects[action.key] = { etag: prev?.etag || "gone", size: prev?.size ?? 0, gone: true };
      continue;
    }
    if (action.type === "skip") continue;
    const src = sourceByKey.get(action.key);
    if (!src?.etag) continue;
    objects[action.key] = { etag: src.etag, size: src.size };
  }
  return { version: 1, objects };
}

export function mergeManifest(base: MediaManifest, extra: MediaManifest): MediaManifest {
  return { version: 1, objects: { ...base.objects, ...extra.objects } };
}

export type ManifestDelta = {
  version: 1;
  upserts: Record<string, MediaManifestEntry>;
  deletes: string[];
};

/** Delta against the current manifest so a journal keeps etag/size and records deletes. */
export function manifestDelta(
  base: MediaManifest,
  sourceByKey: ReadonlyMap<string, MediaObject>,
  actions: readonly MediaAction[],
): ManifestDelta {
  const next = applyPlanToManifest(base, sourceByKey, actions);
  const upserts: ManifestDelta["upserts"] = {};
  const deletes: string[] = [];
  for (const action of actions) {
    if (action.type === "skip") continue;
    if (action.type === "forget") {
      deletes.push(action.key);
      continue;
    }
    const entry = next.objects[action.key];
    if (entry) upserts[action.key] = entry;
  }
  return { version: 1, upserts, deletes };
}

export function applyManifestDelta(base: MediaManifest, delta: ManifestDelta): MediaManifest {
  const objects = { ...base.objects, ...delta.upserts };
  for (const key of delta.deletes) delete objects[key];
  return { version: 1, objects };
}

/** Journals already folded into a newer manifest must not be applied again. */
export function journalsToReplay(
  journals: readonly { key: string; lastModified: number | null }[],
  manifestLastModified: number | null,
): string[] {
  const cutoff = manifestLastModified ?? 0;
  return journals.filter((journal) => (journal.lastModified ?? 0) > cutoff).map((journal) => journal.key);
}

export function journalKeysToDrop(existing: readonly string[], writtenThisRun: readonly string[]): string[] {
  return [...new Set([...existing, ...writtenThisRun])];
}

export function applyStoredJournal(base: MediaManifest, text: string): MediaManifest {
  const parsed = JSON.parse(text) as { upserts?: unknown; deletes?: unknown; objects?: unknown };
  if (parsed && parsed.upserts && typeof parsed.upserts === "object") {
    const deletes = Array.isArray(parsed.deletes) ? parsed.deletes.filter((key): key is string => typeof key === "string") : [];
    return applyManifestDelta(base, { version: 1, upserts: parsed.upserts as ManifestDelta["upserts"], deletes });
  }
  return mergeManifest(base, parseManifest(text));
}

/** Original key stored after history/DAY/HHMM/etag/. Suffix-only matches do not count. */
export function historyOriginalKey(listedKey: string, historyDayPrefix: string): string | null {
  if (!listedKey.startsWith(historyDayPrefix)) return null;
  const rest = listedKey.slice(historyDayPrefix.length);
  const match = /^(\d{4})\/([^/]+)\/(.+)$/.exec(rest);
  return match ? match[3] : null;
}

export function historyKeysForOriginal(keys: readonly string[], historyDayPrefix: string, originalKey: string): string[] {
  return keys.filter((key) => historyOriginalKey(key, historyDayPrefix) === originalKey).sort();
}

export const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

export function lockCanBeTaken(input: { startedAt: number | null; released: boolean; now: number; ttlMs: number }): boolean {
  if (input.released) return true;
  if (input.startedAt === null || !Number.isFinite(input.startedAt)) return false;
  return input.now - input.startedAt >= input.ttlMs;
}

export function sameLockOwner(storedRunId: string | undefined, ourRunId: string): boolean {
  return Boolean(storedRunId) && storedRunId === ourRunId;
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
    else if (action.type === "archive-gone") summary.dropped += 1;
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
    const gone = "gone" in value && (value as { gone?: unknown }).gone === true;
    objects[key] = gone ? { etag, size, gone: true } : { etag, size };
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
