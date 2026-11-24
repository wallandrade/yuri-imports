import { mysqlAffectedRows } from "./mysql-affected-rows";
import {
  DEFAULT_GROUP_CHATS,
  GROUP_CHATS_SETTING,
  GROUP_STAGGER_MINUTES,
  SEND_WINDOW_CLOSE_MINUTES,
  SEND_WINDOW_OPEN_MINUTES,
  isGroupPhone,
  parseStoredGroupChats,
  saoPauloInstant,
  saoPauloParts,
  type GroupChat,
} from "./whatsapp-group-campaign";

export const CUSTOM_REMINDER_POST_ID = "seed-filmagem-abertura";
export const REMINDER_DAILY_TIME = "10:00";
export const REMINDER_EXTRA_GROUP_NAME = "Yuri imports 7";
/** Folga para o job de 60s pegar o primeiro envio depois que a linha existe. */
export const REMINDER_FIRST_LEAD_MS = 3 * 60 * 1000;

export const CUSTOM_REMINDER_TEXT = [
  "⚠️ Lembrete importante: filme toda a abertura da caixa, desde o lacre até a conferência dos produtos. Sem essa filmagem, fica muito difícil solicitar ressarcimento à transportadora.",
  "",
  "🤝 Faça a sua parte, que faremos a nossa da melhor forma possível!",
].join("\n");

export type ReminderSeedRow = {
  id: string;
  imageUrl: string;
  caption: string;
  linkUrl: string;
  scheduledAt: string;
  scheduleMode: "daily";
  scheduleTimes: string;
  intervalHours: null;
  durationDays: null;
  active: 1;
  targetChats: string;
};

type CustomAudience =
  | { kind: "configured" }
  | { kind: "default-plus-named"; name: string };

function foldGroupName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sameGroupName(left: string, right: string): boolean {
  return foldGroupName(left) === foldGroupName(right);
}

function addDayKey(dayKey: string, days: number): string {
  const base = saoPauloInstant(`${dayKey}T12:00`);
  if (!base) return dayKey;
  return saoPauloParts(new Date(base.getTime() + days * 24 * 60 * 60 * 1000)).dayKey;
}

function clockMinutes(date: Date): number {
  const parts = saoPauloParts(date);
  return parts.hour * 60 + parts.minute;
}

/**
 * Próximo envio do grupo 0.
 * Antes das 10:00 (mesmo antes das 08:00) fica para as 10:00 do mesmo dia.
 * Depois das 10:00 e ainda dentro de 08:00–19:00, sai cerca de 3 minutos à frente,
 * se todos os grupos cabem antes das 19:00. Senão, no dia seguinte às 10:00.
 * Depois das 19:00, no dia seguinte às 10:00 — não às 08:00, porque o horário do lembrete é 10:00.
 */
export function reminderFirstLocal(now: Date, groupCount: number, dailyTime = REMINDER_DAILY_TIME): string {
  const parts = saoPauloParts(now);
  const minutes = clockMinutes(now);
  if (minutes >= SEND_WINDOW_CLOSE_MINUTES) {
    return `${addDayKey(parts.dayKey, 1)}T${dailyTime}`;
  }
  const dailyToday = saoPauloInstant(`${parts.dayKey}T${dailyTime}`);
  if (dailyToday && now.getTime() < dailyToday.getTime() + 2 * 60 * 1000) {
    return `${parts.dayKey}T${dailyTime}`;
  }
  const soon = new Date(now.getTime() + REMINDER_FIRST_LEAD_MS);
  const soonParts = saoPauloParts(soon);
  const soonMinutes = clockMinutes(soon);
  const stagger = Math.max(0, groupCount - 1) * GROUP_STAGGER_MINUTES;
  const fits = soonParts.dayKey === parts.dayKey
    && soonMinutes >= SEND_WINDOW_OPEN_MINUTES
    && soonMinutes + stagger < SEND_WINDOW_CLOSE_MINUTES;
  if (!fits) return `${addDayKey(parts.dayKey, 1)}T${dailyTime}`;
  const hour = String(soonParts.hour).padStart(2, "0");
  const minute = String(soonParts.minute).padStart(2, "0");
  return `${soonParts.dayKey}T${hour}:${minute}`;
}

/** Grupos 1 a 6 do código, mais o nome pedido se o telefone já estiver na lista gravada. */
export function reminderTargetChats(stored: readonly GroupChat[], extraName = REMINDER_EXTRA_GROUP_NAME): GroupChat[] {
  const base = DEFAULT_GROUP_CHATS.map((chat) => ({ name: chat.name, phone: chat.phone }));
  const extra = stored.find((chat) => sameGroupName(chat.name, extraName));
  if (!extra) return base;
  const phone = extra.phone.trim();
  if (!isGroupPhone(phone) || base.some((chat) => chat.phone === phone)) return base;
  return [...base, { name: (extra.name.trim() || extraName).slice(0, 80), phone }];
}

export function parseCustomAudience(raw: string | null | undefined): CustomAudience {
  const text = String(raw || "").trim();
  if (!text) return { kind: "configured" };
  try {
    const parsed = JSON.parse(text) as { kind?: unknown; name?: unknown };
    if (parsed && parsed.kind === "default-plus-named") {
      const name = String(parsed.name || "").trim();
      if (name) return { kind: "default-plus-named", name };
    }
  } catch {
    return { kind: "configured" };
  }
  return { kind: "configured" };
}

/** Sem regra, usa os grupos da campanha. A regra do lembrete resolve o 7º na hora. */
export function chatsForCustomPost(
  raw: string | null | undefined,
  stored: readonly GroupChat[],
  configured: readonly GroupChat[],
): GroupChat[] {
  const audience = parseCustomAudience(raw);
  if (audience.kind === "default-plus-named") return reminderTargetChats(stored, audience.name);
  return configured.map((chat) => ({ name: chat.name, phone: chat.phone }));
}

export function reminderAudienceRule(): string {
  return JSON.stringify({ kind: "default-plus-named", name: REMINDER_EXTRA_GROUP_NAME });
}

export function buildReminderSeed(input: {
  alreadyExists: boolean;
  storedChats: readonly GroupChat[];
  now: Date;
}): { action: "skip" } | { action: "insert"; row: ReminderSeedRow } {
  if (input.alreadyExists) return { action: "skip" };
  const targets = reminderTargetChats(input.storedChats);
  return {
    action: "insert",
    row: {
      id: CUSTOM_REMINDER_POST_ID,
      imageUrl: "",
      caption: CUSTOM_REMINDER_TEXT,
      linkUrl: "",
      scheduledAt: reminderFirstLocal(input.now, targets.length),
      scheduleMode: "daily",
      scheduleTimes: JSON.stringify([REMINDER_DAILY_TIME]),
      intervalHours: null,
      durationDays: null,
      active: 1,
      targetChats: reminderAudienceRule(),
    },
  };
}

/** Insere o lembrete uma vez. Não chama a Z-API. Se o id já existe, não mexe na linha. */
export async function ensureCustomGroupReminder(now = new Date()): Promise<void> {
  const { pool } = await import("@workspace/db");
  const [found] = await pool.query(
    "SELECT id FROM whatsapp_group_custom_posts WHERE id = ? LIMIT 1",
    [CUSTOM_REMINDER_POST_ID],
  );
  const exists = Array.isArray(found) && found.length > 0;
  let stored: GroupChat[] = [];
  if (!exists) {
    const [settings] = await pool.query(
      "SELECT value FROM site_settings WHERE `key` = ? LIMIT 1",
      [GROUP_CHATS_SETTING],
    );
    const rows = Array.isArray(settings) ? settings as Array<{ value?: string }> : [];
    stored = parseStoredGroupChats(String(rows[0]?.value || ""));
  }
  const plan = buildReminderSeed({ alreadyExists: exists, storedChats: stored, now });
  if (plan.action === "skip") return;
  const inserted = await pool.query(
    `INSERT IGNORE INTO whatsapp_group_custom_posts
      (id, image_url, caption, link_url, scheduled_at, schedule_mode, schedule_times, interval_hours, duration_days, active, target_chats)
     VALUES (?, ?, ?, ?, ?, 'daily', ?, NULL, NULL, 1, ?)`,
    [
      plan.row.id,
      plan.row.imageUrl,
      plan.row.caption,
      plan.row.linkUrl,
      plan.row.scheduledAt,
      plan.row.scheduleTimes,
      plan.row.targetChats,
    ],
  );
  if (mysqlAffectedRows(inserted) > 0) {
    console.log("[Grupos WhatsApp] lembrete diário cadastrado");
  }
}
