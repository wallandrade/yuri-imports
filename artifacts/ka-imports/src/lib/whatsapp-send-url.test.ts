import assert from "node:assert/strict";
import test from "node:test";

import { whatsAppSendUrl } from "./utils";

test("link com texto usa api.whatsapp.com e preserva emoji", () => {
  const url = whatsAppSendUrl("5535999768759", "🛵 ENTREGAS DE HOJE\n📦 Pedido");
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://api.whatsapp.com");
  assert.equal(parsed.pathname, "/send");
  assert.equal(parsed.searchParams.get("phone"), "5535999768759");
  assert.equal(parsed.searchParams.get("text"), "🛵 ENTREGAS DE HOJE\n📦 Pedido");
  assert.equal(url.includes("wa.me"), false);
  assert.equal(url.includes("%EF%BF%BD"), false);
});
