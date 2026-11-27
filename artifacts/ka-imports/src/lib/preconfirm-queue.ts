/** Depois de aprovar ou recusar, inclusive 409 e 404, o card e a fila pedem a lista de novo. */
export function shouldRefreshPreconfirmQueue(status: number): boolean {
  return status === 200 || status === 409 || status === 404;
}

/** O card não pede o comprovante. A aba Pré-confirmações continua com a URL. */
export function preconfirmPendingPath(includeProof: boolean): string {
  const proof = includeProof ? "" : "&includeProof=0";
  return `/api/admin/orders/payment-preconfirms?status=pending_admin${proof}`;
}
