import assert from "node:assert/strict";
import test from "node:test";
import { rewriteApexApiUrl } from "./apex-api-fetch";

const API = "https://yuri-imports-9483v.ondigitalocean.app";

test("apex manda /api direto para a API e não segue o 307 para www", () => {
  assert.equal(
    rewriteApexApiUrl("/api/admin/orders/1/shopee-route", "yury-imports.com"),
    `${API}/api/admin/orders/1/shopee-route`,
  );
  assert.equal(
    rewriteApexApiUrl("https://yury-imports.com/api/settings", "yury-imports.com"),
    `${API}/api/settings`,
  );
  assert.equal(
    rewriteApexApiUrl("/api/admin/orders/1/shopee-route", "imports-py.com"),
    `${API}/api/admin/orders/1/shopee-route`,
  );
  assert.equal(rewriteApexApiUrl("/api/admin/orders/1/shopee-route", "www.yury-imports.com"), null);
  assert.equal(rewriteApexApiUrl("/api/admin/orders/1/shopee-route", "www.imports-py.com"), null);
  assert.equal(rewriteApexApiUrl("/assets/index.js", "yury-imports.com"), null);
});
