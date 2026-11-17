import crypto from "node:crypto";
import { mysqlAffectedRows } from "./mysql-affected-rows";
import { sendZapiMessageWithFallback } from "./zapi-client";
import {
  WHATSAPP_MAX_ATTEMPTS,
  maskWhatsappPhone,
  whatsappBackoffMs,
  whatsappInstanceCanSend,
  type WhatsappOutboundKind,
  type WhatsappZapiInstance,
} from "./whatsapp-outbound-policy";

export type WhatsappOutboundDraft = {
  instance: WhatsappZapiInstance;
  phone: string;
  kind: WhatsappOutboundKind;
  message?: string;
  caption?: string;
  image?: string;
  optionList?: unknown;
  /** Texto simples se a lista do menu for recusada. */
  fallbackMessage?: string;
  origin: string;
};

type QueueRow = {
  id: string;
  instance: WhatsappZapiInstance;
  phone: string;
  kind: WhatsappOutboundKind;
  message: string | null;
  caption: string | null;
  image: string | null;
  option_list: string | null;
  origin: string;
  status: string;
  attempts: number;
};

export type WhatsappQueueView = {
  counts: { pending: number; sending: number; sent: number; failed: number };
  rows: Array<{
    id: string;
    instance: string;
    origin: string;
    kind: string;
    status: string;
    attempts: number;
    phoneMask: string;
    preview: string;
    lastError: string;
    createdAt: string | null;
    sentAt: string | null;
    nextAttemptAt: string | null;
  }>;
};

function optionListText(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") return value.slice(0, 20000);
  try {
    return JSON.stringify(value).slice(0, 20000);
  } catch {
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  const text = String(value || "");
  if (!text) return null;
  return text.slice(0, max);
}

async function database() {
  const { pool } = await import("@workspace/db");
  return pool;
}

export async function readSiteSetting(key: string): Promise<string> {
  const { db, siteSettingsTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ value: siteSettingsTable.value })
    .from(siteSettingsTable)
    .where(eq(siteSettingsTable.key, key))
    .limit(1);
  return String(rows[0]?.value || "").trim();
}

export async function enqueueWhatsappOutbound(draft: WhatsappOutboundDraft): Promise<{ ok: boolean; id?: string; error?: string }> {
  const phone = String(draft.phone || "").trim();
  if (!phone) return { ok: false, error: "missing_phone" };
  const id = crypto.randomBytes(16).toString("hex");
  try {
    const pool = await database();
    await pool.query(
      `INSERT INTO whatsapp_outbound_queue
        (id, instance, phone, kind, message, caption, image, option_list, origin, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [
        id,
        draft.instance,
        phone.slice(0, 64),
        draft.kind,
        clip(draft.message, 20000),
        clip(draft.caption || draft.fallbackMessage, 20000),
        clip(draft.image, 1000),
        optionListText(draft.optionList),
        String(draft.origin || "aviso").slice(0, 40),
      ],
    );
    return { ok: true, id };
  } catch (err) {
    console.warn("[WhatsApp fila] não entrou", draft.instance, draft.origin, err instanceof Error ? err.message.slice(0, 160) : "falha");
    return { ok: false, error: "fila_indisponivel" };
  }
}

export async function sendWhatsappImmediately(draft: WhatsappOutboundDraft): Promise<{ ok: boolean; error?: string }> {
  const sent = await sendZapiMessageWithFallback(draft);
  const recorded = sent.usedFallback
    ? { ...draft, kind: "text" as const, message: draft.fallbackMessage, optionList: undefined }
    : draft;
  await rememberImmediate(recorded, sent).catch(() => undefined);
  return sent;
}

async function rememberImmediate(draft: WhatsappOutboundDraft, sent: { ok: boolean; error?: string }): Promise<void> {
  const pool = await database();
  const id = crypto.randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO whatsapp_outbound_queue
      (id, instance, phone, kind, message, caption, image, option_list, origin, status, attempts, last_error, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ${sent.ok ? "CURRENT_TIMESTAMP" : "NULL"})`,
    [
      id,
      draft.instance,
      String(draft.phone || "").slice(0, 64),
      draft.kind,
      clip(draft.message, 20000),
      clip(draft.caption, 20000),
      clip(draft.image, 1000),
      optionListText(draft.optionList),
      String(draft.origin || "aviso").slice(0, 40),
      sent.ok ? "sent" : "failed",
      sent.ok ? null : clip(sent.error, 400),
    ],
  );
}

async function pace(instance: WhatsappZapiInstance): Promise<{ ok: true } | { ok: false; reason: "gap" | "hourly" }> {
  const pool = await database();
  const [rows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM whatsapp_outbound_queue
         WHERE instance = ? AND status = 'sent' AND sent_at >= CURRENT_TIMESTAMP - INTERVAL 1 HOUR) AS sent_hour,
       (SELECT COUNT(*) FROM whatsapp_outbound_queue
         WHERE instance = ? AND status = 'sent' AND sent_at >= CURRENT_TIMESTAMP - INTERVAL 6 MINUTE) AS sent_gap`,
    [instance, instance],
  );
  const row = Array.isArray(rows) ? rows[0] as { sent_hour?: number; sent_gap?: number } : {};
  return whatsappInstanceCanSend({
    sentInLastHour: Number(row?.sent_hour || 0),
    sentInLastGap: Number(row?.sent_gap || 0) > 0,
  });
}

async function claimNext(instance: WhatsappZapiInstance): Promise<QueueRow | null> {
  const pool = await database();
  const [found] = await pool.query(
    `SELECT id FROM whatsapp_outbound_queue
     WHERE instance = ?
       AND (
         (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
         OR (status = 'sending' AND updated_at <= CURRENT_TIMESTAMP - INTERVAL 15 MINUTE)
       )
     ORDER BY created_at ASC
     LIMIT 1`,
    [instance],
  );
  const id = Array.isArray(found) ? String((found[0] as { id?: string } | undefined)?.id || "") : "";
  if (!id) return null;
  const [header] = await pool.query(
    `UPDATE whatsapp_outbound_queue
     SET status = 'sending', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (
         status = 'pending'
         OR (status = 'sending' AND updated_at <= CURRENT_TIMESTAMP - INTERVAL 15 MINUTE)
       )`,
    [id],
  );
  if (mysqlAffectedRows(header) !== 1) return null;
  const [rows] = await pool.query(
    `SELECT id, instance, phone, kind, message, caption, image, option_list, origin, status, attempts
     FROM whatsapp_outbound_queue WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = Array.isArray(rows) ? rows[0] as QueueRow | undefined : undefined;
  return row?.id ? row : null;
}

async function markResult(row: QueueRow, sent: { ok: boolean; error?: string }): Promise<void> {
  const pool = await database();
  const attempts = Number(row.attempts || 0) + 1;
  if (sent.ok) {
    await pool.query(
      `UPDATE whatsapp_outbound_queue
       SET status = 'sent', attempts = ?, last_error = NULL, sent_at = CURRENT_TIMESTAMP,
           next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [attempts, row.id],
    );
    return;
  }
  const failed = attempts >= WHATSAPP_MAX_ATTEMPTS;
  const waitSeconds = Math.max(1, Math.round(whatsappBackoffMs(attempts) / 1000));
  await pool.query(
    `UPDATE whatsapp_outbound_queue
     SET status = ?, attempts = ?, last_error = ?,
         sent_at = NULL,
         next_attempt_at = ${failed ? "NULL" : "CURRENT_TIMESTAMP + INTERVAL ? SECOND"},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    failed
      ? ["failed", attempts, clip(sent.error, 400), row.id]
      : ["pending", attempts, clip(sent.error, 400), waitSeconds, row.id],
  );
}

async function sendNextForInstance(instance: WhatsappZapiInstance): Promise<void> {
  const gate = await pace(instance);
  if (!gate.ok) return;
  const row = await claimNext(instance);
  if (!row) return;
  let optionList: unknown = row.option_list;
  if (typeof optionList === "string" && optionList.trim()) {
    try {
      optionList = JSON.parse(optionList) as unknown;
    } catch {
      optionList = row.option_list;
    }
  }
  const fallback = row.kind === "option_list" ? String(row.caption || "").trim() : "";
  const sent = await sendZapiMessageWithFallback({
    instance,
    phone: row.phone,
    kind: row.kind === "image" || row.kind === "option_list" ? row.kind : "text",
    message: row.message || "",
    caption: row.kind === "option_list" ? "" : (row.caption || ""),
    image: row.image || "",
    optionList,
    fallbackMessage: fallback,
  });
  if (sent.usedFallback || (!sent.ok && fallback)) {
    await (await database()).query(
      `UPDATE whatsapp_outbound_queue
       SET kind = 'text', message = ?, option_list = NULL, caption = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [fallback, row.id],
    );
    row.kind = "text";
    row.message = fallback;
  }
  await markResult(row, sent);
  if (!sent.ok) {
    console.warn("[WhatsApp fila]", instance, row.origin, "falha", (sent.error || "").slice(0, 120));
  }
}

function missingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  return message.includes("whatsapp_outbound_queue") || message.includes("ER_NO_SUCH_TABLE");
}

/** Uma mensagem por instância, se a trava de 6 minutos e a de 10 por hora deixarem. */
export async function runWhatsappOutboundTick(): Promise<void> {
  const pool = await database();
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [rows] = await conn.query("SELECT GET_LOCK(?, 0) AS locked", ["yuri_whatsapp_outbound"]);
    locked = Array.isArray(rows) && Number((rows[0] as { locked?: number } | undefined)?.locked) === 1;
    if (!locked) return;
    await sendNextForInstance("main");
    await sendNextForInstance("poly");
  } catch (err) {
    if (missingTable(err)) return;
    throw err;
  } finally {
    if (locked) {
      await conn.query("SELECT RELEASE_LOCK(?)", ["yuri_whatsapp_outbound"]).catch(() => undefined);
    }
    conn.release();
  }
}

function stamp(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text || null;
}

export async function listWhatsappOutboundQueue(): Promise<WhatsappQueueView> {
  const empty: WhatsappQueueView = {
    counts: { pending: 0, sending: 0, sent: 0, failed: 0 },
    rows: [],
  };
  try {
    const pool = await database();
    const [counts] = await pool.query(
      `SELECT status, COUNT(*) AS total FROM whatsapp_outbound_queue GROUP BY status`,
    );
    const view = { ...empty, counts: { ...empty.counts } };
    if (Array.isArray(counts)) {
      for (const row of counts as Array<{ status?: string; total?: number }>) {
        const status = String(row.status || "");
        if (status === "pending" || status === "sending" || status === "sent" || status === "failed") {
          view.counts[status] = Number(row.total || 0);
        }
      }
    }
    const [rows] = await pool.query(
      `SELECT id, instance, origin, kind, status, attempts, phone, message, caption, last_error, created_at, sent_at, next_attempt_at
       FROM whatsapp_outbound_queue
       ORDER BY created_at DESC
       LIMIT 60`,
    );
    if (Array.isArray(rows)) {
      view.rows = (rows as Array<Record<string, unknown>>).map((row) => {
        const preview = String(row.message || row.caption || "").replace(/\s+/g, " ").trim().slice(0, 80);
        return {
          id: String(row.id || ""),
          instance: String(row.instance || ""),
          origin: String(row.origin || ""),
          kind: String(row.kind || ""),
          status: String(row.status || ""),
          attempts: Number(row.attempts || 0),
          phoneMask: maskWhatsappPhone(String(row.phone || "")),
          preview,
          lastError: String(row.last_error || "").slice(0, 180),
          createdAt: stamp(row.created_at),
          sentAt: stamp(row.sent_at),
          nextAttemptAt: stamp(row.next_attempt_at),
        };
      });
    }
    return view;
  } catch (err) {
    if (missingTable(err)) return empty;
    throw err;
  }
}
