import { and, eq, isNull } from "drizzle-orm";
import { mysqlAffectedRows } from "./mysql-affected-rows";
import { normalizeN8nWebhookUrl, toWhatsappPhone, type PaidWhatsappOrder } from "./order-paid-whatsapp";
import { dispatchWhatsappNotice, whatsappNoticeConfigured } from "./whatsapp-dispatch";
import { FILMAGEM_ZAPI_IMAGE_URL, whatsappInstanceForSeller } from "./whatsapp-outbound-policy";

export const N8N_FILMAGEM_WEBHOOK_SETTING = "n8n_filmagem_webhook_url";
/** Produção do nó Filmagem. Vale quando a Configuração está vazia. */
export const DEFAULT_N8N_FILMAGEM_WEBHOOK_URL = "https://wallandrade.app.n8n.cloud/webhook/filmagem";

/** Legenda longa com foto. O pagamento não manda mais isto. O aviso curto fica no texto do pedido pago. */
export const FILMAGEM_PAID_CAPTION = [
  "🚨🚨 *COMUNICADO OFICIAL – LEITURA OBRIGATÓRIA!* 🚨🚨",
  "",
  "⚠️ *A filmagem completa da abertura é obrigatória* para comprovar qualquer problema, *com seguro ou sem seguro*.",
  "",
  "📦 *Como filmar, sem pausa e sem corte:*",
  "1️⃣ Caixa ainda lacrada, com os lacres intactos",
  "2️⃣ Todos os lados: cima, baixo e laterais",
  "3️⃣ Abertura contínua, até o fim",
  "4️⃣ Todo o conteúdo recebido",
  "5️⃣ Nome e lote de cada produto, legíveis no frasco",
  "",
  "❌ Não vale: vídeo que já começa com a caixa aberta, vídeo com corte, ou só foto.",
  "",
  "🛡️ O seguro é opcional e *não dispensa* essa filmagem. Sem ela, a ocorrência pode ficar sem comprovação.",
  "",
  "*YURY IMPORTS 🇵🇾🇧🇷*",
].join("\n");

/** Lembrete quando a EnvioEcom marca saiu para entrega. */
export const FILMAGEM_DELIVERY_CAPTION = [
  "🚨 *LEMBRETE: SEU PEDIDO SAIU PARA ENTREGA!* 🚨",
  "",
  "Quando a caixa chegar, filme a abertura do início ao fim, sem pausa e sem corte, com a caixa ainda lacrada.",
  "",
  "⚠️ *A filmagem completa da abertura é obrigatória*, *com seguro ou sem seguro*.",
  "",
  "📦 *Sem pausa e sem corte:*",
  "1️⃣ Caixa ainda lacrada, com os lacres intactos",
  "2️⃣ Todos os lados: cima, baixo e laterais",
  "3️⃣ Abertura contínua, até o fim",
  "4️⃣ Todo o conteúdo recebido",
  "5️⃣ Nome e lote de cada produto, legíveis no frasco",
  "",
  "❌ Não vale: vídeo que já começa com a caixa aberta, vídeo com corte, ou só foto.",
  "",
  "*YURY IMPORTS 🇵🇾🇧🇷*",
].join("\n");

/** Monta phone e caption. Sem caption, usa a legenda longa. A saída para entrega passa o lembrete. */
export function orderFilmagemWhatsappPayload(
  order: PaidWhatsappOrder,
  caption = FILMAGEM_PAID_CAPTION,
): { phone: string; caption: string } | null {
  const phone = toWhatsappPhone(order.clientPhone);
  if (!phone) return null;
  return { phone, caption };
}

async function webhookUrl(sellerCode?: string | null): Promise<string> {
  const { resolveWhatsappWebhookUrl } = await import("./whatsapp-line");
  const configured = await resolveWhatsappWebhookUrl({
    sellerCode,
    env: "N8N_FILMAGEM_WEBHOOK_URL",
    setting: N8N_FILMAGEM_WEBHOOK_SETTING,
    envPoly: "N8N_FILMAGEM_WEBHOOK_URL_POLY",
    settingPoly: "n8n_filmagem_webhook_url_poly",
  });
  if (configured) return configured;
  return normalizeN8nWebhookUrl(DEFAULT_N8N_FILMAGEM_WEBHOOK_URL);
}

type FilmagemKind = "paid" | "delivery";

async function claimSend(orderId: string, kind: FilmagemKind): Promise<boolean> {
  const { db, ordersTable } = await import("@workspace/db");
  const stamp = kind === "delivery" ? ordersTable.filmagemDeliveryWhatsappSentAt : ordersTable.filmagemWhatsappSentAt;
  const result = await db
    .update(ordersTable)
    .set(kind === "delivery" ? { filmagemDeliveryWhatsappSentAt: new Date() } : { filmagemWhatsappSentAt: new Date() })
    .where(and(eq(ordersTable.id, orderId), isNull(stamp)));
  return mysqlAffectedRows(result) > 0;
}

async function releaseClaim(orderId: string, kind: FilmagemKind): Promise<void> {
  const { db, ordersTable } = await import("@workspace/db");
  await db
    .update(ordersTable)
    .set(kind === "delivery" ? { filmagemDeliveryWhatsappSentAt: null } : { filmagemWhatsappSentAt: null })
    .where(eq(ordersTable.id, orderId));
}

async function sendFilmagem(orderId: string, kind: FilmagemKind): Promise<{ sent: boolean; error?: string }> {
  const id = String(orderId || "").trim();
  if (!id) return { sent: false, error: "missing_id" };
  try {
    const { db, ordersTable } = await import("@workspace/db");
    const rows = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    const order = rows[0];
    if (!order) return { sent: false, error: "not_found" };

    const url = await webhookUrl(order.sellerCode);
    if (!(await whatsappNoticeConfigured("filmagem", url))) return { sent: false, error: "not_configured" };

    const payload = orderFilmagemWhatsappPayload(
      order,
      kind === "delivery" ? FILMAGEM_DELIVERY_CAPTION : FILMAGEM_PAID_CAPTION,
    );
    if (!payload) return { sent: false, error: "missing_phone" };

    const claimed = await claimSend(id, kind);
    if (!claimed) return { sent: false, error: "already_sent" };

    const result = await dispatchWhatsappNotice({
      origin: "filmagem",
      instance: whatsappInstanceForSeller(order.sellerCode),
      phone: payload.phone,
      kind: "image",
      caption: payload.caption,
      image: FILMAGEM_ZAPI_IMAGE_URL,
      n8nUrl: url,
      n8nBody: payload,
    });
    if (result.ok) return { sent: true };

    await releaseClaim(id, kind).catch(() => {});
    console.warn("[WhatsApp filmagem] falha", kind, id, result.error || "request_failed");
    return { sent: false, error: result.error || "request_failed" };
  } catch (err) {
    console.error("[WhatsApp filmagem] sync", kind, id, err instanceof Error ? err.message : err);
    return { sent: false, error: "exception" };
  }
}

/** Legenda longa com foto. O pagamento não chama mais isto: o aviso curto fica no texto do pedido pago. */
export async function sendOrderFilmagemWhatsapp(orderId: string): Promise<{ sent: boolean; error?: string }> {
  return sendFilmagem(orderId, "paid");
}

/** Lembrete da filmagem quando a EnvioEcom marca saiu para entrega. Uma vez por pedido. */
export async function sendOrderFilmagemDeliveryWhatsapp(orderId: string): Promise<{ sent: boolean; error?: string }> {
  return sendFilmagem(orderId, "delivery");
}

export function queueOrderFilmagemWhatsapp(orderId: string | null | undefined): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  void sendOrderFilmagemWhatsapp(id);
}

export function queueOrderFilmagemDeliveryWhatsapp(orderId: string | null | undefined): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  void sendOrderFilmagemDeliveryWhatsapp(id);
}
