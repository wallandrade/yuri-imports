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

/**
 * Digitado: só corta em 11 dígitos.
 * Código 55 sai se o texto começa com +55 ou 0055, ou no blur/autofill
 * quando há 13 dígitos começando em 55. O 0 de tronco sai só nesse blur.
 */
export function nationalCheckoutPhoneDigits(raw: string, fromAutofill = false): string {
  const text = String(raw || "").trim();
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("+55") && digits.startsWith("55")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0055")) {
    digits = digits.slice(4);
  } else if (fromAutofill) {
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
  }
  return digits.slice(0, 11);
}

export function firstInvalidCheckoutField(
  errors: Partial<Record<CheckoutFieldName, unknown>>,
): CheckoutFieldName | null {
  return CHECKOUT_FIELD_ORDER.find((field) => errors[field]) ?? null;
}
