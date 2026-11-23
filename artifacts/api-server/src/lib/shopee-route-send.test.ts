import assert from "node:assert/strict";
import test from "node:test";
import { sendCustomerWhatsapp } from "./whatsapp-dispatch";
import { whatsappRateLimitedError } from "./whatsapp-outbound-policy";

const PHONE = "5500000000000";

function deps(settings = new Map<string, string>()) {
  const queued: string[] = [];
  let sentNow = 0;
  let sendError = "";
  const base = {
    readSetting: async (key: string) => settings.get(key) || "",
    enqueue: async (draft: { origin: string; phone: string }) => {
      queued.push(`${draft.origin}:${draft.phone}`);
      return { ok: true };
    },
    sendNow: async () => {
      sentNow += 1;
      return sendError ? { ok: false, error: sendError } : { ok: true };
    },
    postJson: async () => ({ ok: true }),
    zapiReady: () => true,
    get queued() { return queued; },
    sentCount: () => sentNow,
    failWith(error: string) { sendError = error; },
  };
  return base;
}

test("Rota Shopee sai na hora quando a trava deixa", async () => {
  const io = deps();
  const result = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: "main",
    phone: PHONE,
    message: "link",
    preferImmediate: true,
  }, { ...io, pace: async () => ({ ok: true }) });
  assert.deepEqual(result, { ok: true, queued: false });
  assert.equal(io.sentCount(), 1);
  assert.deepEqual(io.queued, []);
});

test("Rota Shopee só entra na fila se bate na trava", async () => {
  const blocked = deps();
  const queued = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: "main",
    phone: PHONE,
    message: "link",
    preferImmediate: true,
  }, { ...blocked, pace: async () => ({ ok: false, reason: "gap" }) });
  assert.deepEqual(queued, { ok: true, queued: true });
  assert.equal(blocked.sentCount(), 0);
  assert.deepEqual(blocked.queued, [`shopee_route:${PHONE}`]);

  const refused = deps();
  refused.failWith("HTTP 429 limite");
  const again = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: "main",
    phone: PHONE,
    message: "link",
    preferImmediate: true,
  }, { ...refused, pace: async () => ({ ok: true }) });
  assert.equal(again.queued, true);
  assert.equal(refused.sentCount(), 1);
  assert.equal(refused.queued.length, 1);

  const down = deps();
  down.failWith("HTTP 500");
  const failed = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: "main",
    phone: PHONE,
    message: "link",
    preferImmediate: true,
  }, { ...down, pace: async () => ({ ok: true }) });
  assert.equal(failed.ok, false);
  assert.deepEqual(down.queued, []);
  assert.equal(whatsappRateLimitedError("HTTP 500"), false);
  assert.equal(whatsappRateLimitedError("HTTP 429"), true);
});

test("chave n8n da Rota Shopee não dispara sem URL", async () => {
  const io = deps(new Map([["zapi_channel_shopee_route", "n8n"]]));
  const result = await sendCustomerWhatsapp({
    origin: "shopee_route",
    instance: "main",
    phone: PHONE,
    message: "link",
    preferImmediate: true,
  }, io);
  assert.deepEqual(result, { ok: false, error: "not_configured" });
  assert.equal(io.sentCount(), 0);
  assert.deepEqual(io.queued, []);
});
