/** Depois de aprovar ou recusar, inclusive 409 e 404, o card e a fila pedem a lista de novo. */
export function shouldRefreshPreconfirmQueue(status: number): boolean {
  return status === 200 || status === 409 || status === 404;
}
