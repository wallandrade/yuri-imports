export const CHECKOUT_FIELD_ORDER = [
  "name",
  "email",
  "phone",
  "document",
  "cep",
  "street",
  "number",
  "neighborhood",
  "city",
  "state",
] as const;

export type CheckoutFieldName = (typeof CHECKOUT_FIELD_ORDER)[number];

export const CHECKOUT_INVALID_TOAST = "Preencha os dados de cima para finalizar";

export function firstInvalidCheckoutField(
  errors: Partial<Record<CheckoutFieldName, unknown>>,
): CheckoutFieldName | null {
  return CHECKOUT_FIELD_ORDER.find((field) => errors[field]) ?? null;
}
