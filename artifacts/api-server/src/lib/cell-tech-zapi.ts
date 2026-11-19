import {
  CELL_TECH_ZAPI_MISSING_LOG,
  CELL_TECH_ZAPI_MISSING_MESSAGE,
} from "./cell-tech-status";

export const CELL_TECH_ZAPI_INSTANCE = "celltech" as const;

export type CellTechQueueDraft = {
  instance: typeof CELL_TECH_ZAPI_INSTANCE;
  phone: string;
  kind: "text";
  message: string;
  origin: "cell_tech";
};

/** Sem credencial, não há rascunho. A instância do rascunho é só celltech. */
export function cellTechDirectQueueDraft(input: {
  configured: boolean;
  phone: string;
  message: string;
}): { ok: true; draft: CellTechQueueDraft } | { ok: false; log: string; message: string } {
  if (!input.configured) {
    return { ok: false, log: CELL_TECH_ZAPI_MISSING_LOG, message: CELL_TECH_ZAPI_MISSING_MESSAGE };
  }
  const phone = String(input.phone || "").trim();
  if (!phone) {
    return { ok: false, log: "[Cell Tech] grupo da Cell Tech inválido", message: "Grupo da Cell Tech inválido." };
  }
  return {
    ok: true,
    draft: {
      instance: CELL_TECH_ZAPI_INSTANCE,
      phone,
      kind: "text",
      message: String(input.message || ""),
      origin: "cell_tech",
    },
  };
}

/** A Z-API da Cell Tech só é chamada com a instância configurada e dentro da janela. */
export function cellTechOutboundReady(input: { configured: boolean; windowOpen: boolean }): boolean {
  return input.configured && input.windowOpen;
}
