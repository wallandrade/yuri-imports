import { runWhatsappOutboundTick } from "./lib/whatsapp-outbound-queue";

const TICK_MS = 30 * 1000;

export function startWhatsappOutboundJob(): void {
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    void runWhatsappOutboundTick()
      .catch((err: unknown) => {
        console.warn("[WhatsApp fila]", err instanceof Error ? err.message.slice(0, 180) : "falha");
      })
      .finally(() => {
        ticking = false;
      });
  };
  setInterval(tick, TICK_MS);
  console.log("[WhatsApp fila] conferência a cada 30s. No máximo 1 envio a cada 6 min e 10 por hora, por instância.");
}
