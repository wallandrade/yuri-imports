import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_REMINDER_POST_ID,
  CUSTOM_REMINDER_TEXT,
  buildReminderSeed,
  chatsForCustomPost,
  reminderAlreadySeeded,
  reminderFirstLocal,
  reminderTargetChats,
} from "./custom-group-reminder";
import { DEFAULT_GROUP_CHATS, parseStoredGroupChats } from "./whatsapp-group-campaign";

const TEXT = "⚠️ Lembrete importante: filme toda a abertura da caixa, desde o lacre até a conferência dos produtos. Sem essa filmagem, fica muito difícil solicitar ressarcimento à transportadora.\n\n🤝 Faça a sua parte, que faremos a nossa da melhor forma possível!";

test("o lembrete diário não duplica e não grava telefone do grupo 7", () => {
  const now = new Date("2026-10-12T18:00:30.000Z");
  const phone = "120363999000000007-group";
  const stored = [{ name: "Yuri imports 7", phone }];
  const first = buildReminderSeed({ alreadyExists: false, storedChats: stored, now });
  const again = buildReminderSeed({ alreadyExists: true, storedChats: stored, now });
  const nextDay = buildReminderSeed({
    alreadyExists: true,
    storedChats: [],
    now: new Date("2026-10-13T18:00:30.000Z"),
  });
  assert.equal(CUSTOM_REMINDER_TEXT, TEXT);
  assert.equal(first.action, "insert");
  assert.equal(again.action, "skip");
  assert.equal(reminderAlreadySeeded(false, true), true);
  assert.equal(reminderAlreadySeeded(true, false), true);
  assert.equal(reminderAlreadySeeded(false, false), false);
  assert.equal(nextDay.action, "skip");
  if (first.action !== "insert") return;
  const repeat = buildReminderSeed({ alreadyExists: false, storedChats: stored, now });
  assert.equal(repeat.action, "insert");
  if (repeat.action !== "insert") return;
  assert.equal(repeat.row.id, first.row.id);
  assert.equal(first.row.id, CUSTOM_REMINDER_POST_ID);
  assert.equal(first.row.imageUrl, "");
  assert.equal(first.row.linkUrl, "");
  assert.equal(first.row.scheduleMode, "daily");
  assert.equal(first.row.active, 1);
  assert.equal(first.row.durationDays, null);
  assert.deepEqual(JSON.parse(first.row.scheduleTimes), ["10:00"]);
  assert.equal(first.row.caption, TEXT);
  assert.equal(first.row.targetChats.includes(phone), false);
  assert.equal(JSON.parse(first.row.targetChats).kind, "default-plus-named");
  assert.equal(JSON.parse(first.row.targetChats).name, "Yuri imports 7");
});

test("o grupo 7 entra só quando o nome já está na lista gravada", () => {
  const phone = "120363999000000007-group";
  const raw = JSON.stringify([
    ...DEFAULT_GROUP_CHATS,
    { name: "Yuri  imports   7", phone },
    { name: "Cell Tech", phone: "5511888888888-group" },
  ]);
  const stored = parseStoredGroupChats(raw);
  assert.equal(stored.length, 8);
  const withSeven = chatsForCustomPost(
    JSON.stringify({ kind: "default-plus-named", name: "Yuri imports 7" }),
    stored,
    DEFAULT_GROUP_CHATS.slice(0, 2),
  );
  assert.equal(withSeven.length, 7);
  assert.deepEqual(withSeven.slice(0, 6).map((chat) => chat.phone), DEFAULT_GROUP_CHATS.map((chat) => chat.phone));
  assert.equal(withSeven[6]?.name, "Yuri  imports   7");
  assert.equal(withSeven[6]?.phone, phone);
  const without = reminderTargetChats([
    { name: "Yuri imports 8", phone: "120363999000000008-group" },
    { name: "Cell Tech", phone: "5511888888888-group" },
  ]);
  assert.equal(without.length, 6);
  assert.equal(without.some((chat) => chat.phone === "120363999000000008-group"), false);
  const invalid = reminderTargetChats([{ name: "Yuri imports 7", phone: "nao-e-telefone" }]);
  assert.equal(invalid.length, 6);
  const configured = chatsForCustomPost(null, stored, DEFAULT_GROUP_CHATS.slice(0, 2));
  assert.equal(configured.length, 2);
});

test("o primeiro envio do lembrete cabe na janela e, depois das 19h, fica para as 10:00", () => {
  assert.equal(reminderFirstLocal(new Date("2026-10-12T10:00:00.000Z"), 7), "2026-10-12T10:00");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T11:30:00.000Z"), 7), "2026-10-12T10:00");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T13:00:30.000Z"), 7), "2026-10-12T10:00");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T18:00:30.000Z"), 7), "2026-10-12T15:03");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T21:10:00.000Z"), 7), "2026-10-13T10:00");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T22:30:00.000Z"), 7), "2026-10-13T10:00");
  assert.equal(reminderFirstLocal(new Date("2026-10-12T22:30:00.000Z"), 7).endsWith("T08:00"), false);
});
