/** Última chamada ao Gestão Click e último envio ao grupo. Sem token. */

export type CellTechGestaoOutcome = "ok" | "recusado";
export type CellTechWhatsappOutcome = "ok" | "falhou" | "fila";

export const CELL_TECH_ZAPI_MISSING_LOG = "[Cell Tech] instância Z-API da Cell Tech não configurada";
export const CELL_TECH_ZAPI_MISSING_MESSAGE = "Instância Z-API da Cell Tech não configurada.";

export type CellTechCallRecord = {
  outcome: CellTechGestaoOutcome | CellTechWhatsappOutcome;
  message: string;
  at: string;
};

export type CellTechConnectionState = {
  gestao: CellTechCallRecord | null;
  whatsapp: CellTechCallRecord | null;
};

export type CellTechConnectionPublic = {
  accessConfigured: boolean;
  secretConfigured: boolean;
  accessHint: string;
  secretHint: string;
  gestao: {
    outcome: CellTechGestaoOutcome | null;
    message: string;
    at: string | null;
  };
  whatsapp: {
    outcome: CellTechWhatsappOutcome | null;
    message: string;
    at: string | null;
  };
};

const EMPTY: CellTechConnectionState = { gestao: null, whatsapp: null };
const GESTAO = new Set<CellTechGestaoOutcome>(["ok", "recusado"]);
const WHATSAPP = new Set<CellTechWhatsappOutcome>(["ok", "falhou", "fila"]);

let memory: CellTechConnectionState = { gestao: null, whatsapp: null };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

export function emptyCellTechConnectionState(): CellTechConnectionState {
  return { gestao: null, whatsapp: null };
}

/** Tira trechos longos que possam ser token. A frase curta do n8n fica. */
/** 400 e 404 são caminho ou filtro, não recusa do token. Não apagam a última chamada. */
export function cellTechGestaoFailureCounts(status: number): boolean {
  return status !== 400 && status !== 404;
}

export function cellTechStatusMessage(raw: unknown, fallback: string): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^fetch failed$/i.test(text) || /^failed to fetch$/i.test(text)) return fallback;
  return text.replace(/[A-Za-z0-9+/=_-]{24,}/g, "••••").slice(0, 180);
}

export function maskCellTechSecret(secret: string): { configured: boolean; hint: string } {
  if (!secret) return { configured: false, hint: "" };
  if (secret.length <= 4) return { configured: true, hint: "••••" };
  return { configured: true, hint: `••••${secret.slice(-4)}` };
}

function callFrom(raw: unknown, allowed: ReadonlySet<string>): CellTechCallRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const outcome = String(record.outcome || "");
  const at = String(record.at || "");
  if (!allowed.has(outcome) || !at) return null;
  const message = outcome === "ok" ? "" : cellTechStatusMessage(record.message, "");
  return { outcome: outcome as CellTechCallRecord["outcome"], message, at };
}

export function parseCellTechConnectionState(raw: unknown): CellTechConnectionState {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return emptyCellTechConnectionState();
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      return emptyCellTechConnectionState();
    }
  }
  if (!data || typeof data !== "object") return emptyCellTechConnectionState();
  const record = data as Record<string, unknown>;
  return {
    gestao: callFrom(record.gestao, GESTAO),
    whatsapp: callFrom(record.whatsapp, WHATSAPP),
  };
}

function newerCall(left: CellTechCallRecord | null, right: CellTechCallRecord | null): CellTechCallRecord | null {
  if (!left) return right;
  if (!right) return left;
  return left.at >= right.at ? left : right;
}

export function mergeCellTechConnection(
  left: CellTechConnectionState,
  right: CellTechConnectionState | null,
): CellTechConnectionState {
  if (!right) return { gestao: left.gestao, whatsapp: left.whatsapp };
  return {
    gestao: newerCall(left.gestao, right.gestao),
    whatsapp: newerCall(left.whatsapp, right.whatsapp),
  };
}

export function cellTechQueueDeliveryOutcome(input: {
  accepted: boolean;
  attempts: number;
  maxAttempts: number;
  error?: string;
}): { outcome: CellTechWhatsappOutcome; message: string } | null {
  if (input.accepted) return { outcome: "ok", message: "" };
  if (input.attempts >= input.maxAttempts) {
    return {
      outcome: "falhou",
      message: cellTechStatusMessage(input.error, "A Z-API não enviou a mensagem."),
    };
  }
  return null;
}

/** Sem a instância da Cell Tech, o card não pode dizer que o grupo recebeu. */
export function presentCellTechConnection(
  view: CellTechConnectionPublic,
  zapiConfigured: boolean,
  channel: "direto" | "n8n",
): CellTechConnectionPublic & { zapiConfigured: boolean } {
  if (channel === "direto" && !zapiConfigured) {
    return {
      ...view,
      zapiConfigured: false,
      whatsapp: {
        outcome: "falhou",
        message: CELL_TECH_ZAPI_MISSING_MESSAGE,
        at: view.whatsapp.at,
      },
    };
  }
  return { ...view, zapiConfigured };
}

export function noteCellTechCall(
  state: CellTechConnectionState,
  channel: "gestao" | "whatsapp",
  ok: boolean,
  message: string,
  at: string,
): CellTechConnectionState {
  const fallback = channel === "gestao"
    ? "O Gestão Click recusou a consulta."
    : "O n8n não recebeu a mensagem.";
  const record: CellTechCallRecord = {
    outcome: channel === "gestao" ? (ok ? "ok" : "recusado") : (ok ? "ok" : "falhou"),
    message: ok ? "" : cellTechStatusMessage(message, fallback),
    at,
  };
  return { ...state, [channel]: record };
}

export function publicCellTechConnection(
  accessToken: string,
  secretAccessToken: string,
  state: CellTechConnectionState,
): CellTechConnectionPublic {
  const access = maskCellTechSecret(accessToken);
  const secret = maskCellTechSecret(secretAccessToken);
  const gestao = state.gestao;
  const whatsapp = state.whatsapp;
  return {
    accessConfigured: access.configured,
    secretConfigured: secret.configured,
    accessHint: access.hint,
    secretHint: secret.hint,
    gestao: {
      outcome: gestao && GESTAO.has(gestao.outcome as CellTechGestaoOutcome) ? gestao.outcome as CellTechGestaoOutcome : null,
      message: gestao && gestao.outcome !== "ok" ? gestao.message : "",
      at: gestao?.at ?? null,
    },
    whatsapp: {
      outcome: whatsapp && WHATSAPP.has(whatsapp.outcome as CellTechWhatsappOutcome) ? whatsapp.outcome as CellTechWhatsappOutcome : null,
      message: whatsapp && whatsapp.outcome !== "ok" ? whatsapp.message : "",
      at: whatsapp?.at ?? null,
    },
  };
}

function remember(next: CellTechConnectionState): void {
  memory = next;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = memory;
    persistChain = persistChain.then(async () => {
      try {
        const store = await import("./cell-tech-store");
        await store.writeCellTechConnectionStored(snapshot);
      } catch (error) {
        console.error("[Cell Tech] status:", error instanceof Error ? error.message : "falha ao gravar");
      }
    });
  }, 400);
  persistTimer.unref?.();
}

export function recordCellTechGestao(ok: boolean, message = "", at = new Date().toISOString()): void {
  memory = noteCellTechCall(memory, "gestao", ok, message, at);
  remember(memory);
}

export function recordCellTechWhatsappOutcome(
  outcome: CellTechWhatsappOutcome,
  message = "",
  at = new Date().toISOString(),
): void {
  const fallback = outcome === "fila"
    ? "Na fila da Z-API. O grupo ainda não recebeu."
    : "A Z-API não enviou a mensagem.";
  const record: CellTechCallRecord = {
    outcome,
    message: outcome === "ok" ? "" : cellTechStatusMessage(message, fallback),
    at,
  };
  memory = { ...memory, whatsapp: record };
  remember(memory);
}

export function recordCellTechWhatsapp(ok: boolean, message = "", at = new Date().toISOString()): void {
  recordCellTechWhatsappOutcome(ok ? "ok" : "falhou", message, at);
}

export function applyCellTechQueueDelivery(input: {
  accepted: boolean;
  attempts: number;
  maxAttempts: number;
  error?: string;
  at?: string;
}): void {
  const next = cellTechQueueDeliveryOutcome(input);
  if (!next) return;
  recordCellTechWhatsappOutcome(next.outcome, next.message, input.at);
}

export async function readCellTechConnectionState(): Promise<CellTechConnectionState> {
  let stored: CellTechConnectionState | null = null;
  try {
    const store = await import("./cell-tech-store");
    stored = await store.readCellTechConnectionStored();
  } catch {
    stored = null;
  }
  memory = mergeCellTechConnection(memory, stored);
  return memory;
}

export function parseSituationLabels(raw: unknown): Record<string, string> {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return {};
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const id = key.trim().slice(0, 40);
    const name = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!id || id === "0" || !name) continue;
    labels[id] = name;
    if (Object.keys(labels).length >= 80) break;
  }
  return labels;
}

export function serializeSituationLabels(raw: unknown): string {
  return JSON.stringify(parseSituationLabels(raw));
}

export function peekCellTechConnectionMemory(): CellTechConnectionState {
  return { gestao: memory.gestao, whatsapp: memory.whatsapp };
}

/** Só para teste. Cancela a gravação pendente e não chama o Gestão Click. */
export function resetCellTechConnectionMemory(state: CellTechConnectionState = EMPTY): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  memory = { gestao: state.gestao, whatsapp: state.whatsapp };
}
