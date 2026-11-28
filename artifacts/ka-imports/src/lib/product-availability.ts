type ProductAvailability = {
  isActive?: boolean | null;
  isSoldOut?: boolean | null;
};

/** Inativo sai da compra. O selo esgotado não bloqueia. */
export function isProductUnavailable(product: object): boolean {
  return (product as ProductAvailability).isActive === false;
}

export function isCatalogSoldOut(product: object): boolean {
  return (product as ProductAvailability).isSoldOut === true;
}
