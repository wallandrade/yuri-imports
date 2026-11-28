import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWhatsappNotice, whatsappNoticeConfigured } from "./whatsapp-dispatch";

const PHONE = "5500000000000";

test("direto enfileira e não chama o n8n", async () => {
  const settings = new Map<string, string>();
  const queued: string[] = [];
  let posted = 0;
  const deps = {
    readSetting: async (key: string) => settings.get(key) || "",
    enqueue: async (draft: { phone: string; origin: string; instance: string }) => {
      queued.push(`${draft.instance}:${draft.origin}:${draft.phone}`);
      return { ok: true };
    },
    sendNow: async () => ({ ok: false, error: "nao-devia" }),
    postJson: async () => {
      posted += 1;
      return { ok: true };
    },
  };
  assert.equal(await whatsappNoticeConfigured("pedido_pago", "", deps.readSetting), true);
  const result = await dispatchWhatsappNotice({
    origin: "pedido_pago",
    instance: "poly",
    phone: PHONE,
    kind: "text",
    message: "pago",
    n8nUrl: "https://n8n.example/webhook/pago",
  }, deps);
  assert.equal(result.queued, true);
  assert.deepEqual(queued, [`poly:pedido_pago:${PHONE}`]);
  assert.equal(posted, 0);
});

test("n8n sem URL não dispara e com URL manda o corpo", async () => {
  const settings = new Map<string, string>([["zapi_channel_order_paid", "n8n"]]);
  let body: unknown = null;
  const deps = {
    readSetting: async (key: string) => settings.get(key) || "",
    enqueue: async () => ({ ok: true }),
    sendNow: async () => ({ ok: true }),
    postJson: async (_url: string, payload: unknown) => {
      body = payload;
      return { ok: true };
    },
  };
  assert.equal(await whatsappNoticeConfigured("pedido_pago", "", deps.readSetting), false);
  const missing = await dispatchWhatsappNotice({
    origin: "pedido_pago",
    instance: "main",
    phone: PHONE,
    kind: "text",
    message: "pago",
  }, deps);
  assert.equal(missing.error, "not_configured");
  const sent = await dispatchWhatsappNotice({
    origin: "pedido_pago",
    instance: "main",
    phone: PHONE,
    kind: "text",
    message: "pago",
    n8nUrl: "https://n8n.example/webhook/pago",
    n8nBody: { phone: PHONE, message: "pago" },
  }, deps);
  assert.equal(sent.ok, true);
  assert.deepEqual(body, { phone: PHONE, message: "pago" });
});

test("na hora manda a resposta sem entrar na fila", async () => {
  const settings = new Map<string, string>([["zapi_support_delivery", "na_hora"]]);
  let sentNow = 0;
  let queued = 0;
  const deps = {
    readSetting: async (key: string) => settings.get(key) || "",
    enqueue: async () => {
      queued += 1;
      return { ok: true };
    },
    sendNow: async () => {
      sentNow += 1;
      return { ok: true };
    },
    postJson: async () => ({ ok: true }),
  };
  const reply = await dispatchWhatsappNotice({
    origin: "atendimento",
    instance: "main",
    phone: PHONE,
    kind: "text",
    message: "oi",
  }, deps);
  const notice = await dispatchWhatsappNotice({
    origin: "postado",
    instance: "main",
    phone: PHONE,
    kind: "text",
    message: "postado",
  }, deps);
  assert.equal(reply.ok, true);
  assert.equal(sentNow, 1);
  assert.equal(notice.queued, true);
  assert.equal(queued, 1);
});
