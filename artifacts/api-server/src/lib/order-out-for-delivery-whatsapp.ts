import { queueOrderFilmagemDeliveryWhatsapp } from "./order-filmagem-whatsapp";

/** Só a frase da transportadora. Postado, trânsito e Entregue ficam de fora. */
export function isOutForDeliveryStatus(status: string | null | undefined): boolean {
  const value = String(status || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /saiu\s+para\s+entrega/.test(value);
}

/** Só na passagem para saiu para entrega. Cada pacote dispara o texto 2 uma vez; a filmagem em si é uma vez por pedido. */
export function shouldAnnounceOutForDelivery(input: {
  previousStatus?: string | null;
  nextStatus?: string | null;
  packageKey?: string | null;
  alreadySent?: string[];
}): boolean {
  const key = String(input.packageKey || "").trim();
  if (!key) return false;
  if (!isOutForDeliveryStatus(input.nextStatus) || isOutForDeliveryStatus(input.previousStatus)) return false;
  const sent = new Set((input.alreadySent || []).map((item) => item.trim()));
  return !sent.has(key);
}

/** Na saída para entrega sai só o texto 2 e o vídeo. O aviso antigo da moto não entra. */
export function announceOutForDelivery(input: {
  orderId: string | null | undefined;
  packageKey: string | null | undefined;
  previousStatus?: string | null;
  nextStatus?: string | null;
  trackingCode?: string | null;
}): void {
  const key = String(input.packageKey || "").trim() || "order";
  if (!shouldAnnounceOutForDelivery({
    previousStatus: input.previousStatus,
    nextStatus: input.nextStatus,
    packageKey: key,
  })) return;
  queueOrderFilmagemDeliveryWhatsapp(input.orderId);
}
