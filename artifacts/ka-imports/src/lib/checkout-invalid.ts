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

/** Tira o 0 de tronco e o 55 do país (12 ou 13 dígitos). DDD 55 com 11 dígitos fica. */
export function nationalCheckoutPhoneDigits(raw: string): string {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = digits.slice(1);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  return digits.slice(0, 11);
}

export function firstInvalidCheckoutField(
  errors: Partial<Record<CheckoutFieldName, unknown>>,
): CheckoutFieldName | null {
  return CHECKOUT_FIELD_ORDER.find((field) => errors[field]) ?? null;
}
