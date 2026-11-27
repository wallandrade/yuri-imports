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
  if (orderStatus.trim().toLowerCase() === "cancelled") {
    return { ok: false, error: "CANCELLED", message: "Pedido cancelado." };
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
  reason: "confirm" | "already_paid" | "rejected";
};

export function planPaymentReview(input: {
  decision: "approve" | "reject";
  orderStatus: string;
  preconfirmStatus: string;
}): ReviewPlan | { error: "NOT_PENDING"; message: string } {
  if (input.preconfirmStatus !== "pending_admin") {
    return { error: "NOT_PENDING", message: "Esta pré-confirmação já foi revisada." };
  }
  const orderStatus = String(input.orderStatus || "");
  if (input.decision === "reject") {
    return {
      preconfirmStatus: "rejected",
      confirmPayment: false,
      orderStatusAfter: orderStatus,
      sideEffects: [],
      reason: "rejected",
    };
  }
  if (isConfirmedPaidStatus(orderStatus)) {
    return {
      preconfirmStatus: "approved",
      confirmPayment: false,
      orderStatusAfter: orderStatus,
      sideEffects: [],
      reason: "already_paid",
    };
  }
  return {
    preconfirmStatus: "approved",
    confirmPayment: true,
    orderStatusAfter: "paid",
    sideEffects: PAID_CONFIRMATION_SIDE_EFFECTS,
    reason: "confirm",
  };
}
