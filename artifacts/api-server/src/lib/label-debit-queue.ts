import { isInTransitStatus, isLabelReadyStatus } from "./envioecom";
import { isMotoboyShippingType } from "./free-shipping";

/** Fila da aba Baixa de etiqueta. São Paulo usa o saldo Motoboy. Santa Catarina usa o próprio saldo. */
export type LabelDebitLane = "motoboy" | "sao_paulo" | "minas" | "santa_catarina";

export type LabelDebitAccountPool = "motoboy" | "minas" | "santa_catarina" | null;

export type LabelDebitCandidate = {
  cancelled: boolean;
  inventoryReserved: boolean;
  waived: boolean;
  isPackage: boolean;
  /** Pedido com 2+ pacotes: a fila mostra o pacote, não o pedido inteiro. */
  packageCount: number;
  shippingType?: string | null;
  enviado?: boolean | null;
  /** Pool da conta EnvioEcom. São Paulo entra como motoboy. */
  accountPool?: LabelDebitAccountPool;
  /** Pool gravado no pacote, quando a linha é um pacote. */
  packagePool?: string | null;
  envioecomStatus?: string | null;
  envioecomLabelUrl?: string | null;
  trackingLabelUrl?: string | null;
  superfreteStatus?: string | null;
  superfreteLabelUrl?: string | null;
  manualTrackingCode?: string | null;
};

const SUPERFRETE_LABEL = new Set(["released", "posted", "delivered", "generated"]);

/**
 * Conta sem nome “Santa Catarina” cai em Minas pelo id.
 * Se o pedido/pacote já está nesse depósito, a fila usa Santa Catarina,
 * salvo conta cujo nome é São Paulo ou Minas.
 */
export function labelDebitAccountPool(params: {
  accountPool: LabelDebitAccountPool;
  savedPool?: string | null;
  accountName?: string | null;
}): LabelDebitAccountPool {
  const saved = String(params.savedPool || "").trim();
  if (saved !== "santa_catarina") return params.accountPool;
  if (params.accountPool === "santa_catarina" || params.accountPool === "motoboy") return params.accountPool;
  const name = String(params.accountName || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\bminas\b|\bmg\b/.test(name)) return params.accountPool;
  return "santa_catarina";
}

export function labelDebitStockPool(lane: LabelDebitLane): "motoboy" | "minas" | "santa_catarina" {
  if (lane === "minas") return "minas";
  if (lane === "santa_catarina") return "santa_catarina";
  return "motoboy";
}

export function hasShippingLabel(row: Pick<
  LabelDebitCandidate,
  "envioecomStatus" | "envioecomLabelUrl" | "trackingLabelUrl" | "superfreteStatus" | "superfreteLabelUrl" | "manualTrackingCode"
>): boolean {
  if (String(row.envioecomLabelUrl || "").trim()) return true;
  if (String(row.trackingLabelUrl || "").trim()) return true;
  if (String(row.superfreteLabelUrl || "").trim()) return true;
  if (String(row.manualTrackingCode || "").trim()) return true;
  const superfrete = String(row.superfreteStatus || "").trim().toLowerCase();
  if (SUPERFRETE_LABEL.has(superfrete)) return true;
  const status = String(row.envioecomStatus || "").trim();
  if (!status) return false;
  return isLabelReadyStatus(status) || isInTransitStatus(status);
}

/** Onde a etiqueta entra na fila. Null = não aparece. */
export function labelDebitLane(row: LabelDebitCandidate): LabelDebitLane | null {
  if (row.cancelled || row.inventoryReserved || row.waived) return null;
  if (!row.isPackage && row.packageCount >= 2) return null;

  const labeled = hasShippingLabel(row);
  const localMotoboy = isMotoboyShippingType(row.shippingType) || String(row.packagePool || "") === "motoboy";
  const dispatched = labeled || (localMotoboy && !!row.enviado);
  if (!dispatched) return null;

  const account = row.accountPool || null;
  if (account === "santa_catarina" && labeled) return "santa_catarina";
  if (account === "motoboy" && labeled) return "sao_paulo";
  if (account === "minas" && labeled) return "minas";

  const packagePool = String(row.packagePool || "").trim();
  if (packagePool === "santa_catarina" && labeled) return "santa_catarina";
  if (packagePool === "minas" && labeled) return "minas";
  if (localMotoboy) return "motoboy";
  return null;
}
