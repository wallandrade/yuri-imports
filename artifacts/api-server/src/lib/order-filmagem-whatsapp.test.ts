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
} from "./order-filmagem-whatsapp";
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
