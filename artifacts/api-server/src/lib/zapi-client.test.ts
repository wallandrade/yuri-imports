import assert from "node:assert/strict";
import test from "node:test";
import {
  redactZapiSecret,
  sendZapiMessage,
  zapiCredentials,
  zapiMessageAccepted,
  zapiOutboundRequest,
} from "./zapi-client";

const PHONE = "5500000000000";
const TOKEN = "token-de-teste-123456";
const CLIENT = "client-token-de-teste-99";

function withEnv(run: () => Promise<void>): Promise<void> {
  const previous = {
    ZAPI_MAIN_INSTANCE_ID: process.env.ZAPI_MAIN_INSTANCE_ID,
    ZAPI_MAIN_TOKEN: process.env.ZAPI_MAIN_TOKEN,
    ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
    ZAPI_POLY_INSTANCE_ID: process.env.ZAPI_POLY_INSTANCE_ID,
    ZAPI_POLY_TOKEN: process.env.ZAPI_POLY_TOKEN,
    ZAPI_POLY_CLIENT_TOKEN: process.env.ZAPI_POLY_CLIENT_TOKEN,
  };
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("pedido de texto, imagem e lista segue o n8n", () => {
  const text = zapiOutboundRequest({ phone: PHONE, kind: "text", message: "oi" });
  assert.deepEqual(text, { suffix: "/send-text", body: { phone: PHONE, message: "oi" } });
  const image = zapiOutboundRequest({
    phone: PHONE,
    kind: "image",
    image: "https://exemplo.test/foto.jpg",
    caption: "legenda",
  });
  assert.deepEqual(image, {
    suffix: "/send-image",
    body: { phone: PHONE, image: "https://exemplo.test/foto.jpg", caption: "legenda" },
  });
  const list = zapiOutboundRequest({
    phone: PHONE,
    kind: "option_list",
    message: "escolha",
    optionList: { title: "Menu", buttonLabel: "Ver", options: [] },
  });
  assert.equal("error" in list, false);
  if (!("error" in list)) {
    assert.equal(list.suffix, "/send-option-list");
    assert.equal(list.body.phone, PHONE);
  }
});

test("sucesso da Z-API exige 2xx sem erro, ou messageId", () => {
  assert.equal(zapiMessageAccepted(200, { messageId: "abc", zaapId: "z" }), true);
  assert.equal(zapiMessageAccepted(200, { error: "falhou" }), false);
  assert.equal(zapiMessageAccepted(500, { messageId: "abc" }), true);
  assert.equal(zapiMessageAccepted(500, {}), false);
});

test("envio usa a instância pedida e não devolve o token", async () => {
  await withEnv(async () => {
    process.env.ZAPI_MAIN_INSTANCE_ID = "instanciaMain1";
    process.env.ZAPI_MAIN_TOKEN = TOKEN;
    process.env.ZAPI_CLIENT_TOKEN = CLIENT;
    process.env.ZAPI_POLY_INSTANCE_ID = "instanciaPoly1";
    process.env.ZAPI_POLY_TOKEN = "poly-token-de-teste";
    delete process.env.ZAPI_POLY_CLIENT_TOKEN;
    assert.equal(zapiCredentials("poly")?.clientToken, CLIENT);
    assert.equal(zapiCredentials("main")?.instanceId, "instanciaMain1");

    let called = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      called = String(input);
      const header = new Headers(init?.headers);
      assert.equal(header.get("Client-Token"), CLIENT);
      assert.equal(JSON.parse(String(init?.body)).phone, PHONE);
      return new Response(JSON.stringify({ error: `recusou ${TOKEN} ${CLIENT}` }), { status: 403 });
    };
    const sent = await sendZapiMessage({
      instance: "main",
      phone: PHONE,
      kind: "text",
      message: "teste",
      fetchImpl,
    });
    assert.equal(sent.ok, false);
    assert.match(called, /\/instances\/instanciaMain1\/token\/token-de-teste-123456\/send-text$/);
    assert.equal(sent.error?.includes(TOKEN), false);
    assert.equal(sent.error?.includes(CLIENT), false);
    assert.equal(redactZapiSecret(TOKEN).includes(TOKEN), false);
  });
});
