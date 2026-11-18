import { runWhatsappOutboundTick } from "./lib/whatsapp-outbound-queue";
import { WHATSAPP_TICK_MS } from "./lib/whatsapp-outbound-policy";

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
  setInterval(tick, WHATSAPP_TICK_MS);
  console.log("[WhatsApp fila] conferência a cada 30s. Pedido pago sai em até 2 min. Os outros avisos: 1 a cada 6 min e 10 por hora.");
}
