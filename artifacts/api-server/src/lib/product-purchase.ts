export type OrderProductAvailability = {
  isActive?: boolean | null;
  isSoldOut?: boolean | null;
};

/**
 * Compra de produto esgotado segue. A recusa UNAVAILABLE_PRODUCT fica para
 * produto ausente ou inativo.
 */
export function isOrderProductBlocked(product: OrderProductAvailability | null | undefined): boolean {
  if (!product) return true;
  return product.isActive === false;
}
