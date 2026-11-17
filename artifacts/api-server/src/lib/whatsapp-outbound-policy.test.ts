import assert from "node:assert/strict";
import test from "node:test";
import { FILMAGEM_DELIVERY_CAPTION, FILMAGEM_PAID_CAPTION } from "./order-filmagem-whatsapp";
import {
  CELL_TECH_ZAPI_GROUP_ID,
  FILMAGEM_ZAPI_IMAGE_URL,
  WHATSAPP_HOURLY_CAP,
  cellTechZapiGroupId,
  maskWhatsappPhone,
  parseSupportDelivery,
  parseWhatsappChannel,
  supportLineCanReply,
  whatsappBackoffMs,
  whatsappInstanceCanSend,
  whatsappInstanceForSeller,
} from "./whatsapp-outbound-policy";
import { zapiOutboundRequest } from "./zapi-client";

test("canal vazio é direto e a resposta vazia fica na fila", () => {
  assert.equal(parseWhatsappChannel(""), "direto");
  assert.equal(parseWhatsappChannel("n8n"), "n8n");
  assert.equal(parseSupportDelivery(""), "fila");
  assert.equal(parseSupportDelivery("na_hora"), "na_hora");
});

test("Poly sai pela instância dela e o menu dela não responde", () => {
  assert.equal(whatsappInstanceForSeller("poly"), "poly");
  assert.equal(whatsappInstanceForSeller("123"), "poly");
  assert.equal(whatsappInstanceForSeller("bruna"), "poly");
  assert.equal(whatsappInstanceForSeller("yuri"), "main");
  assert.equal(supportLineCanReply("poly"), false);
  assert.equal(supportLineCanReply("main"), true);
});

test("fila segura 6 minutos e 10 por hora", () => {
  assert.deepEqual(whatsappInstanceCanSend({ sentInLastHour: 0, sentInLastGap: false }), { ok: true });
  assert.deepEqual(whatsappInstanceCanSend({ sentInLastHour: 3, sentInLastGap: true }), { ok: false, reason: "gap" });
  assert.deepEqual(
    whatsappInstanceCanSend({ sentInLastHour: WHATSAPP_HOURLY_CAP, sentInLastGap: false }),
    { ok: false, reason: "hourly" },
  );
  assert.equal(whatsappBackoffMs(1), 6 * 60 * 1000);
  assert.equal(whatsappBackoffMs(2), 12 * 60 * 1000);
  assert.equal(whatsappBackoffMs(8), 60 * 60 * 1000);
});

test("filmagem usa a foto do n8n e a legenda da loja", () => {
  assert.equal(
    FILMAGEM_ZAPI_IMAGE_URL,
    "https://pub-f5d30eebc4f5447c8dbace71b8e690f3.r2.dev/admin-images/1792175200919-75b3fa2b745d.jpg",
  );
  const paid = zapiOutboundRequest({
    phone: "5500000000000",
    kind: "image",
    image: FILMAGEM_ZAPI_IMAGE_URL,
    caption: FILMAGEM_PAID_CAPTION,
  });
  const delivery = zapiOutboundRequest({
    phone: "5500000000000",
    kind: "image",
    image: FILMAGEM_ZAPI_IMAGE_URL,
    caption: FILMAGEM_DELIVERY_CAPTION,
  });
  assert.equal("error" in paid, false);
  assert.equal("error" in delivery, false);
  if (!("error" in paid) && !("error" in delivery)) {
    assert.match(String(paid.body.caption), /COMUNICADO OFICIAL/);
    assert.equal(String(paid.body.caption).includes("direitos do consumidor"), false);
    assert.match(String(delivery.body.caption), /SEU PEDIDO SAIU PARA ENTREGA/);
  }
});

test("Cell Tech fala com o grupo do fluxo", () => {
  assert.equal(CELL_TECH_ZAPI_GROUP_ID, "553591710559-1525960254");
  assert.equal(cellTechZapiGroupId(""), CELL_TECH_ZAPI_GROUP_ID);
  assert.equal(cellTechZapiGroupId("553591710559-1525960254"), CELL_TECH_ZAPI_GROUP_ID);
  assert.equal(cellTechZapiGroupId("120363012345678901@g.us"), "120363012345678901@g.us");
  assert.throws(() => cellTechZapiGroupId("123"), /inválido/);
  assert.equal(maskWhatsappPhone("5500000000000"), "••••0000");
});
