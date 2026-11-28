/**
 * Pré-confirmação da vendedora. Não muda o status do pedido e não dispara
 * WhatsApp de pago, baixa, separação nem comissão. Isso só entra no plano
 * quando o admin principal aprova um pedido que ainda não está pago.
 */

export const PAID_CONFIRMATION_SIDE_EFFECTS = [
  "status_paid",
  "coupon_use",
  "commission",
  "promo_stock",
  "shipping_slot",
  "paid_notification",
  "whatsapp_paid",
  "outbound_webhook_paid",
] as const;

export type PaidConfirmationSideEffect = (typeof PAID_CONFIRMATION_SIDE_EFFECTS)[number];

export function isConfirmedPaidStatus(status: unknown): boolean {
  const value = String(status || "").trim().toLowerCase();
  return value === "paid" || value === "completed";
}

export function isCancelledOrderStatus(status: unknown): boolean {
  const value = String(status || "").trim().toLowerCase();
  return value === "cancelled" || value === "cancelado" || value === "canceled";
}

/** PIX nasce pending. Aguardando pagamento também entra. Pago, concluído e cancelado nunca. */
export const APPROVAL_ELIGIBLE_STATUSES = ["pending", "awaiting_payment"] as const;

export function isApprovalEligibleStatus(status: unknown): boolean {
  const value = String(status || "").trim().toLowerCase();
  return (APPROVAL_ELIGIBLE_STATUSES as readonly string[]).includes(value);
}

/** Efeitos de pago só quando o UPDATE condicional afetou exatamente uma linha. */
export function paidSideEffectsIfClaimed(claimed: boolean): readonly PaidConfirmationSideEffect[] {
  return claimed ? PAID_CONFIRMATION_SIDE_EFFECTS : [];
}

export type ApprovalResolution = {
  statusCode: 200 | 409;
  runSideEffects: boolean;
  preconfirmStatus: "approved" | "rejected" | "pending_admin";
  orderStatusAfter: string;
  reason: "confirm" | "obsolete" | "lost_race" | "rejected";
  message: string;
};

/**
 * preconfirmRowsAffected vem do UPDATE ... WHERE status = 'pending_admin'.
 * orderRowsAffected vem do UPDATE ... WHERE status IN ('pending', 'awaiting_payment').
 * Efeito colateral de pago só com os dois em 1.
 */
export function resolveApprovalClaim(input: {
  decision: "approve" | "reject";
  orderStatus: string;
  preconfirmRowsAffected: number;
  orderRowsAffected: number;
}): ApprovalResolution {
  const orderStatus = String(input.orderStatus || "");
  if (input.preconfirmRowsAffected !== 1) {
    return {
      statusCode: 409,
      runSideEffects: false,
      preconfirmStatus: "pending_admin",
      orderStatusAfter: orderStatus,
      reason: "lost_race",
      message: "Esta pré-confirmação já foi revisada.",
    };
  }
  if (input.decision === "reject") {
    return {
      statusCode: 200,
      runSideEffects: false,
      preconfirmStatus: "rejected",
      orderStatusAfter: orderStatus,
      reason: "rejected",
      message: "Pré-confirmação rejeitada.",
    };
  }
  if (!isApprovalEligibleStatus(orderStatus) || input.orderRowsAffected !== 1) {
    return {
      statusCode: 409,
      runSideEffects: false,
      preconfirmStatus: "rejected",
      orderStatusAfter: orderStatus,
      reason: "obsolete",
      message: "Pedido não está pendente de pagamento. A pré-confirmação foi encerrada sem confirmar.",
    };
  }
  return {
    statusCode: 200,
    runSideEffects: true,
    preconfirmStatus: "approved",
    orderStatusAfter: "paid",
    reason: "confirm",
    message: "Pagamento confirmado.",
  };
}

export type PreconfirmDecision =
  | { ok: true; orderStatusAfter: string; sideEffects: readonly PaidConfirmationSideEffect[] }
  | { ok: false; error: string; message: string };

export function decidePreconfirm(input: {
  orderStatus: string;
  pendingExists: boolean;
}): PreconfirmDecision {
  const orderStatus = String(input.orderStatus || "");
  if (isConfirmedPaidStatus(orderStatus)) {
    return {
      ok: false,
      error: "ALREADY_PAID",
      message: "Este pedido já está confirmado. A pré-confirmação não altera pagamento confirmado.",
    };
  }
  if (isCancelledOrderStatus(orderStatus)) {
    return { ok: false, error: "CANCELLED", message: "Pedido cancelado." };
  }
  if (!isApprovalEligibleStatus(orderStatus)) {
    return {
      ok: false,
      error: "NOT_ELIGIBLE",
      message: "Só dá para pré-confirmar um pedido pendente de pagamento.",
    };
  }
  if (input.pendingExists) {
    return {
      ok: false,
      error: "ALREADY_PENDING",
      message: "Já existe uma pré-confirmação aguardando o admin.",
    };
  }
  return { ok: true, orderStatusAfter: orderStatus, sideEffects: [] };
}

export type ReviewPlan = {
  preconfirmStatus: "approved" | "rejected";
  confirmPayment: boolean;
  orderStatusAfter: string;
  sideEffects: readonly PaidConfirmationSideEffect[];
  reason: "confirm" | "obsolete" | "rejected";
};

const PRECONFIRM_CARD_PRODUCTS = 4;
const PRECONFIRM_CARD_NAME_MAX = 120;
const PRECONFIRM_CARD_IMAGE_MAX = 400;

export type PreconfirmListProduct = {
  id: string;
  name: string;
  image: string | null;
};

/** O card do painel pede `includeProof=0`. A aba continua recebendo o comprovante. */
export function preconfirmListIncludesProof(value: unknown): boolean {
  return String(value ?? "").trim() !== "0";
}

/** Sem o comprovante, a resposta não leva o base64. `hasProof` vem do banco. */
export function preconfirmListProofFields(
  includeProof: boolean,
  proofUrl: string | null | undefined,
  hasProofFlag?: boolean,
): { hasProof: boolean; proofUrl: string | null } {
  if (!includeProof) return { hasProof: Boolean(hasProofFlag), proofUrl: null };
  const url = proofUrl ? String(proofUrl) : null;
  return { hasProof: Boolean(url), proofUrl: url };
}

/** Miniaturas do card. Só URL http(s) curta. Base64, data: e texto longo ficam de fora. */
export function preconfirmListProducts(raw: unknown): PreconfirmListProduct[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: PreconfirmListProduct[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = String(row.name || "").trim().slice(0, PRECONFIRM_CARD_NAME_MAX) || "Produto";
    const id = String(row.id || "").trim().slice(0, 64);
    const imageRaw = String(row.image || "").trim();
    const image = /^https?:\/\/\S+$/i.test(imageRaw) && imageRaw.length <= PRECONFIRM_CARD_IMAGE_MAX
      ? imageRaw
      : null;
    out.push({ id, name, image });
    if (out.length >= PRECONFIRM_CARD_PRODUCTS) break;
  }
  return out;
}

export function planPaymentReview(input: {
  decision: "approve" | "reject";
  orderStatus: string;
  preconfirmStatus: string;
}): ReviewPlan | { error: "NOT_PENDING"; message: string } {
  if (input.preconfirmStatus !== "pending_admin") {
    return { error: "NOT_PENDING", message: "Esta pré-confirmação já foi revisada." };
  }
  const orderStatus = String(input.orderStatus || "");
  const resolved = resolveApprovalClaim({
    decision: input.decision,
    orderStatus,
    preconfirmRowsAffected: 1,
    orderRowsAffected: input.decision === "approve" && isApprovalEligibleStatus(orderStatus) ? 1 : 0,
  });
  return {
    preconfirmStatus: resolved.preconfirmStatus === "pending_admin" ? "rejected" : resolved.preconfirmStatus,
    confirmPayment: resolved.runSideEffects,
    orderStatusAfter: resolved.orderStatusAfter,
    sideEffects: paidSideEffectsIfClaimed(resolved.runSideEffects),
    reason: resolved.reason === "lost_race" ? "obsolete" : resolved.reason,
  };
}
