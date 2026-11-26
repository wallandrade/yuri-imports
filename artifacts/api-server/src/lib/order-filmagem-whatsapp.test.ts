import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FILMAGEM_DELIVERY_QUEUE_ORIGIN,
  FILMAGEM_DELIVERY_TEXT,
  FILMAGEM_GIF_AFTER_TEXT_MS,
  FILMAGEM_NOTICE_DELAY_MS,
  FILMAGEM_PAID_TEXT,
  FILMAGEM_QUEUE_ORIGIN,
  filmagemCancelQueueSql,
  filmagemLogRef,
  filmagemOrderIdFromOptionList,
  filmagemOutboundStillAllowed,
  filmagemSiblingQueueIds,
  FILMAGEM_VIDEO_PUBLIC_PATH,
  filmagemNoticeDueAt,
  filmagemNoticeEligibleOnTransition,
  filmagemQueueId,
  filmagemVideoUrl,
  orderFilmagemWhatsappPayload,
  planFilmagemDeliveryNotice,
  planFilmagemPaidNotice,
  redactFilmagemLog,
  dropFilmagemIfOrderLeftPaid,
  scheduleFilmagemPaidNotice,
  type FilmagemLogger,
  type FilmagemOrderSnapshot,
  type FilmagemPaidIo,
} from "./order-filmagem-whatsapp";
import type { WhatsappOutboundDraft } from "./whatsapp-outbound-queue";
import { WHATSAPP_PAID_ORIGIN } from "./whatsapp-outbound-policy";
import { zapiOutboundRequest } from "./zapi-client";

const PHONE = "5500000000000";
const VIDEO = "https://projeto.vercel.app/filmagem/como-abrir-caixa.mp4";
const DUE = new Date("2026-11-20T17:00:00.000Z");

test("texto 1 sai 2h depois do pagamento e o texto 2 é o lembrete curto", () => {
  const paidAt = new Date("2026-11-20T15:00:00.000Z");
  assert.equal(filmagemNoticeDueAt(paidAt).toISOString(), DUE.toISOString());
  assert.equal(FILMAGEM_NOTICE_DELAY_MS, 2 * 60 * 60 * 1000);
  assert.equal(filmagemNoticeEligibleOnTransition("pending", "paid"), true);
  assert.equal(filmagemNoticeEligibleOnTransition("awaiting_payment", "completed"), true);
  assert.equal(filmagemNoticeEligibleOnTransition("paid", "paid"), false);
  assert.equal(filmagemNoticeEligibleOnTransition("completed", "completed"), false);
  assert.equal(filmagemNoticeEligibleOnTransition("paid", "completed"), false);
  assert.equal(filmagemNoticeEligibleOnTransition("pending", "cancelled"), false);

  const payload = orderFilmagemWhatsappPayload({ clientPhone: PHONE });
  assert.equal(payload?.phone, PHONE);
  assert.equal(payload?.message, FILMAGEM_PAID_TEXT);
  assert.match(FILMAGEM_PAID_TEXT, /ATENÇÃO: LEIA ANTES DE RECEBER SEU PEDIDO/);
  assert.match(FILMAGEM_PAID_TEXT, /FILME A ABERTURA DO COMEÇO AO FIM, SEM CORTES/);
  assert.match(FILMAGEM_PAID_TEXT, /SEM FILMAGEM, NÃO ADIANTA NOS CHAMAR/);
  assert.equal(FILMAGEM_PAID_TEXT.includes("COMUNICADO OFICIAL"), false);
  assert.equal(FILMAGEM_PAID_TEXT.includes("direitos do consumidor"), false);
  assert.equal(FILMAGEM_DELIVERY_TEXT, [
    "🚚 *SEU PEDIDO SAIU PARA ENTREGA!*",
    "",
    "⚠️ *Pela segunda vez:* filme a abertura da caixa do começo ao fim, *sem cortes*. Sem o vídeo, você não terá direito a reclamação futura.",
    "",
    "Faça sua parte 🎥📦",
    "",
    "*YURY IMPORTS 🇵🇾🇧🇷*",
  ].join("\n"));
  assert.equal(orderFilmagemWhatsappPayload({ clientPhone: "" }), null);
});

test("pedido pago entra na fila no prazo, com GIF atrás do texto, uma vez", () => {
  const plan = planFilmagemPaidNotice({
    orderId: "pedido1",
    status: "paid",
    phone: PHONE,
    sellerCode: "poly",
    dueAt: DUE,
    videoUrl: VIDEO,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.drafts.length, 2);
  assert.equal(plan.drafts[0]?.kind, "text");
  assert.equal(plan.drafts[0]?.message, FILMAGEM_PAID_TEXT);
  assert.equal(plan.drafts[0]?.phone, PHONE);
  assert.equal(plan.drafts[0]?.instance, "poly");
  assert.equal(plan.drafts[0]?.origin, FILMAGEM_QUEUE_ORIGIN);
  assert.notEqual(plan.drafts[0]?.origin, WHATSAPP_PAID_ORIGIN);
  assert.equal(plan.drafts[0]?.nextAttemptAt?.toISOString(), DUE.toISOString());
  assert.equal(plan.drafts[1]?.kind, "gif");
  assert.equal(plan.drafts[1]?.image, VIDEO);
  assert.equal(plan.drafts[1]?.instance, "poly");
  assert.equal(plan.drafts[1]?.phone, PHONE);
  assert.equal(plan.drafts[1]?.nextAttemptAt?.getTime(), DUE.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS);
  assert.equal(filmagemOrderIdFromOptionList(plan.drafts[0]?.optionList), "pedido1");
  assert.equal(filmagemOrderIdFromOptionList(plan.drafts[1]?.optionList), "pedido1");
  assert.equal(filmagemOutboundStillAllowed("paid"), true);
  assert.equal(filmagemOutboundStillAllowed("completed"), true);
  assert.equal(filmagemOutboundStillAllowed("cancelled"), false);
  assert.equal(filmagemOutboundStillAllowed("pending"), false);
  assert.deepEqual(filmagemSiblingQueueIds("pedido1", FILMAGEM_QUEUE_ORIGIN), [
    plan.drafts[0]?.id,
    plan.drafts[1]?.id,
  ]);
  assert.equal(plan.drafts[0]?.id, filmagemQueueId("pedido1", "paid-text"));
  assert.equal(plan.drafts[1]?.id, filmagemQueueId("pedido1", "paid-gif"));
  assert.notEqual(plan.drafts[0]?.id, plan.drafts[1]?.id);
  assert.equal(filmagemQueueId("pedido1", "paid-text"), filmagemQueueId("pedido1", "paid-text"));

  const wire = zapiOutboundRequest({
    phone: plan.drafts[1]?.phone || "",
    kind: "gif",
    image: plan.drafts[1]?.image,
  });
  assert.deepEqual(wire, { suffix: "/send-gif", body: { phone: PHONE, gif: VIDEO } });

  assert.deepEqual(planFilmagemPaidNotice({
    orderId: "antigo",
    status: "paid",
    phone: PHONE,
    dueAt: null,
  }), { ok: false, error: "not_eligible" });
  assert.deepEqual(planFilmagemPaidNotice({
    orderId: "pedido1",
    status: "paid",
    phone: PHONE,
    dueAt: DUE,
    alreadySent: true,
  }), { ok: false, error: "already_sent" });
  assert.deepEqual(planFilmagemPaidNotice({
    orderId: "pedido1",
    status: "pending",
    phone: PHONE,
    dueAt: DUE,
  }), { ok: false, error: "not_paid" });
});

test("sem URL pública o aviso fica só no texto e o domínio suspenso não entra", () => {
  const plan = planFilmagemPaidNotice({
    orderId: "pedido1",
    status: "completed",
    phone: PHONE,
    sellerCode: "yuri",
    dueAt: DUE,
    videoUrl: "",
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.drafts.length, 1);
  assert.equal(plan.drafts[0]?.kind, "text");
  assert.equal(plan.drafts[0]?.instance, "main");
  assert.equal(filmagemVideoUrl(""), "");
  assert.equal(filmagemVideoUrl("http://projeto.vercel.app/filmagem/como-abrir-caixa.mp4"), "");
  assert.equal(filmagemVideoUrl("https://www.yury-imports.com/filmagem/como-abrir-caixa.mp4"), "");
  assert.equal(filmagemVideoUrl("https://api.yury-imports.com/filmagem/como-abrir-caixa.mp4"), "");
  assert.equal(filmagemVideoUrl("https://www.imports-py.com/filmagem/como-abrir-caixa.mp4"), "");
  assert.equal(filmagemVideoUrl("https://www.yuri-imports-py.com/filmagem/como-abrir-caixa.mp4"), "");
  assert.equal(filmagemVideoUrl("https://www.compras-yu.com/filmagem/como-abrir-caixa.mp4"), "https://www.compras-yu.com/filmagem/como-abrir-caixa.mp4");
  assert.equal(filmagemVideoUrl("nota-e-url"), "");
  assert.equal(filmagemVideoUrl(VIDEO), VIDEO);
});

test("saída para entrega manda o texto 2 e o GIF, sem furar a fila do pago", () => {
  const now = new Date("2026-11-20T18:00:00.000Z");
  const plan = planFilmagemDeliveryNotice({
    orderId: "pedido1",
    phone: PHONE,
    sellerCode: "yuri",
    now,
    videoUrl: VIDEO,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.drafts[0]?.message, FILMAGEM_DELIVERY_TEXT);
  assert.equal(plan.drafts[0]?.kind, "text");
  assert.equal(plan.drafts[0]?.nextAttemptAt?.getTime(), now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS);
  assert.equal(plan.drafts[0]?.createdAt?.getTime(), now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS);
  assert.equal(plan.drafts[0]?.origin, FILMAGEM_DELIVERY_QUEUE_ORIGIN);
  assert.notEqual(plan.drafts[0]?.origin, WHATSAPP_PAID_ORIGIN);
  assert.equal(plan.drafts[0]?.phone, PHONE);
  assert.equal(plan.drafts[1]?.kind, "gif");
  assert.equal(plan.drafts[1]?.nextAttemptAt?.getTime(), now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS * 2);
  assert.equal(plan.drafts[1]?.createdAt?.getTime(), now.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS * 2);
  assert.equal(plan.drafts[0]?.id, filmagemQueueId("pedido1", "delivery-text"));
  assert.notEqual(plan.drafts[0]?.id, filmagemQueueId("pedido1", "paid-text"));
  assert.deepEqual(planFilmagemDeliveryNotice({
    orderId: "pedido1",
    phone: PHONE,
    now,
    alreadySent: true,
  }), { ok: false, error: "already_sent" });
  assert.deepEqual(planFilmagemDeliveryNotice({
    orderId: "pedido1",
    phone: "",
    now,
  }), { ok: false, error: "missing_phone" });
});

test("o MP4 público existe e a Vercel não devolve o HTML no lugar dele", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const video = path.resolve(here, "../../../ka-imports/public/filmagem/como-abrir-caixa.mp4");
  const stat = fs.statSync(video);
  assert.equal(FILMAGEM_VIDEO_PUBLIC_PATH, "/filmagem/como-abrir-caixa.mp4");
  assert.ok(stat.size > 10_000);
  assert.ok(stat.size < 1_500_000);
  for (const file of [
    path.resolve(here, "../../../ka-imports/vercel.json"),
    path.resolve(here, "../../../../vercel.json"),
  ]) {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    const spa = json.rewrites.find((item) => item.destination === "/index.html");
    assert.match(spa?.source || "", /filmagem/);
  }
});

const STAMPED_DUE = new Date("2026-11-21T14:00:00.000Z");

function captureLog(): { lines: string[]; log: FilmagemLogger } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      warn(code, ref, detail = "") {
        lines.push(["warn", code, ref, detail].filter((part) => part !== "").join(" "));
      },
      info(origin, ref) {
        lines.push(["info", origin, ref].join(" "));
      },
    },
  };
}

function paidHarness(status: string, video: string) {
  const row: FilmagemOrderSnapshot = {
    id: "pedido1",
    orderNumber: 2813,
    status,
    clientPhone: PHONE,
    sellerCode: "poly",
    filmagemWhatsappDueAt: null,
    filmagemWhatsappSentAt: null,
  };
  const queue: WhatsappOutboundDraft[] = [];
  const captured = captureLog();
  const io: FilmagemPaidIo = {
    async stampDue() {
      if (row.filmagemWhatsappDueAt || row.filmagemWhatsappSentAt) return 0;
      if (row.status !== "paid" && row.status !== "completed") return 0;
      row.filmagemWhatsappDueAt = new Date(STAMPED_DUE);
      return 1;
    },
    async load() {
      return {
        ...row,
        filmagemWhatsappDueAt: row.filmagemWhatsappDueAt ? new Date(row.filmagemWhatsappDueAt) : null,
        filmagemWhatsappSentAt: row.filmagemWhatsappSentAt ? new Date(row.filmagemWhatsappSentAt) : null,
      };
    },
    async claimPaid() {
      row.filmagemWhatsappSentAt = new Date("2026-11-21T14:00:01.000Z");
    },
    async enqueue(draft) {
      if (queue.some((item) => item.id === draft.id)) return { ok: true, duplicate: true, id: draft.id };
      queue.push(draft);
      return { ok: true, id: draft.id };
    },
    videoUrl: () => video,
    log: captured.log,
  };
  return { row, queue, io, lines: captured.lines };
}

test("log da filmagem fica com o número do pedido e sem telefone nem token", () => {
  assert.equal(filmagemLogRef({ orderNumber: 2813, id: "pedido1" }), "#2813");
  assert.equal(redactFilmagemLog(`falha ${PHONE} token=abc123`), "falha ****0000 token=***");
  assert.equal(redactFilmagemLog("whsec=segredo").includes("segredo"), false);
});

test("virar pago carimba o prazo e enfileira texto e GIF, sem duplicar", async () => {
  const pending = paidHarness("pending", VIDEO);
  const before = await scheduleFilmagemPaidNotice("pedido1", pending.io);
  assert.deepEqual(before, { queued: false, error: "not_eligible" });
  assert.equal(pending.row.filmagemWhatsappDueAt === null, true);
  assert.equal(pending.queue.length, 0);
  assert.match(pending.lines.join("\n"), /not_eligible/);
  assert.match(pending.lines.join("\n"), /stamp 0 linhas/);
  assert.equal(pending.lines.join("\n").includes(PHONE), false);

  pending.row.status = "paid";
  pending.lines.length = 0;
  const queued = await scheduleFilmagemPaidNotice("pedido1", pending.io);
  assert.equal(queued.queued, true);
  assert.equal(pending.row.filmagemWhatsappDueAt?.toISOString(), STAMPED_DUE.toISOString());
  assert.equal(pending.queue.length, 2);
  assert.equal(pending.queue[0]?.kind, "text");
  assert.equal(pending.queue[0]?.message, FILMAGEM_PAID_TEXT);
  assert.equal(pending.queue[0]?.origin, FILMAGEM_QUEUE_ORIGIN);
  assert.equal(pending.queue[0]?.phone, PHONE);
  assert.equal(pending.queue[0]?.instance, "poly");
  assert.equal(pending.queue[0]?.nextAttemptAt?.toISOString(), STAMPED_DUE.toISOString());
  assert.equal(pending.queue[0]?.id, filmagemQueueId("pedido1", "paid-text"));
  assert.equal(pending.queue[1]?.kind, "gif");
  assert.equal(pending.queue[1]?.image, VIDEO);
  assert.equal(pending.queue[1]?.id, filmagemQueueId("pedido1", "paid-gif"));
  assert.equal(pending.queue[1]?.nextAttemptAt?.getTime(), STAMPED_DUE.getTime() + FILMAGEM_GIF_AFTER_TEXT_MS);
  assert.match(pending.lines.join("\n"), /info filmagem #2813/);
  assert.equal(pending.lines.join("\n").includes(PHONE), false);
  assert.equal(/token/i.test(pending.lines.join("\n")), false);

  pending.lines.length = 0;
  const again = await scheduleFilmagemPaidNotice("pedido1", pending.io);
  assert.deepEqual(again, { queued: false, error: "already_sent" });
  assert.equal(pending.queue.length, 2);
  assert.equal(pending.lines.join("\n").includes("info"), false);

  pending.row.filmagemWhatsappSentAt = null;
  await scheduleFilmagemPaidNotice("pedido1", pending.io);
  assert.equal(pending.queue.length, 2);
  assert.equal(pending.queue[0]?.id, filmagemQueueId("pedido1", "paid-text"));
});

test("sem a URL do vídeo o pago enfileira só o texto", async () => {
  const onlyText = paidHarness("completed", "");
  const result = await scheduleFilmagemPaidNotice("pedido1", onlyText.io);
  assert.equal(result.queued, true);
  assert.equal(onlyText.queue.length, 1);
  assert.equal(onlyText.queue[0]?.kind, "text");
  assert.equal(onlyText.row.filmagemWhatsappDueAt?.toISOString(), STAMPED_DUE.toISOString());
});

test("coluna ausente, carimbo sem linha e erro de insert ficam no log", async () => {
  const missing = paidHarness("paid", VIDEO);
  missing.io.stampDue = async () => {
    throw new Error("Unknown column 'filmagem_whatsapp_due_at'");
  };
  const missingResult = await scheduleFilmagemPaidNotice("pedido1", missing.io);
  assert.deepEqual(missingResult, { queued: false, error: "column_missing" });
  assert.match(missing.lines.join("\n"), /column_missing/);
  assert.equal(missing.queue.length, 0);
  assert.equal(missing.lines.join("\n").includes(PHONE), false);

  const zero = paidHarness("paid", VIDEO);
  zero.io.stampDue = async () => 0;
  const zeroResult = await scheduleFilmagemPaidNotice("pedido1", zero.io);
  assert.equal(zeroResult.error, "stamp_zero");
  assert.match(zero.lines.join("\n"), /stamp 0 linhas/);
  assert.equal(zero.row.filmagemWhatsappDueAt, null);
  assert.equal(zero.queue.length, 0);

  const broken = paidHarness("paid", VIDEO);
  broken.io.enqueue = async () => ({ ok: false, error: "fila_indisponivel" });
  const insertResult = await scheduleFilmagemPaidNotice("pedido1", broken.io);
  assert.deepEqual(insertResult, { queued: false, error: "fila_indisponivel" });
  assert.match(broken.lines.join("\n"), /erro de insert/);
  assert.equal(broken.lines.join("\n").includes(PHONE), false);
  assert.equal(broken.row.filmagemWhatsappSentAt, null);
  assert.ok(broken.row.filmagemWhatsappDueAt);
});

test("se o primeiro carimbo não vê o pago, o segundo grava e enfileira", async () => {
  const late = paidHarness("paid", VIDEO);
  let calls = 0;
  late.io.stampDue = async () => {
    calls += 1;
    if (calls === 1) return 0;
    late.row.filmagemWhatsappDueAt = new Date(STAMPED_DUE);
    return 1;
  };
  const result = await scheduleFilmagemPaidNotice("pedido1", late.io);
  assert.equal(result.queued, true);
  assert.equal(calls, 2);
  assert.equal(late.queue.length, 2);
  assert.equal(late.queue[1]?.kind, "gif");
});

test("pedido que deixa de ser pago antes do envio tira texto e GIF da fila", async () => {
  const paid = paidHarness("paid", VIDEO);
  await scheduleFilmagemPaidNotice("pedido1", paid.io);
  assert.equal(paid.queue.length, 2);
  paid.row.status = "cancelled";
  const failed: string[] = [];
  const dropped = await dropFilmagemIfOrderLeftPaid({
    origin: FILMAGEM_QUEUE_ORIGIN,
    optionList: paid.queue[0]?.optionList,
  }, {
    loadStatus: async () => paid.row.status,
    failPending: async (ids) => {
      failed.push(...ids);
    },
  });
  assert.equal(dropped, true);
  assert.deepEqual(failed, [
    filmagemQueueId("pedido1", "paid-text"),
    filmagemQueueId("pedido1", "paid-gif"),
  ]);
  const sql = filmagemCancelQueueSql(failed);
  assert.match(sql.sql, /status = 'failed'/);
  assert.match(sql.sql, /pedido_nao_pago/);
  assert.match(sql.sql, /status IN \('pending', 'sending'\)/);
  assert.deepEqual(sql.params, failed);

  const kept = await dropFilmagemIfOrderLeftPaid({
    origin: FILMAGEM_QUEUE_ORIGIN,
    optionList: { filmagemOrderId: "pedido1" },
  }, {
    loadStatus: async () => "paid",
    failPending: async () => {
      throw new Error("pedido pago não sai da fila");
    },
  });
  assert.equal(kept, false);
});
