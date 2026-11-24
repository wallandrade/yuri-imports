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
 * Tecla a tecla: só corta em 11 dígitos.
 * Colagem, autofill ou blur: +55, 0055, 13 dígitos com 55 e o 0 de tronco saem antes do corte.
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

export function isBulkCheckoutPhoneChange(input: {
  inputType?: string;
  previousValue: string;
  nextValue: string;
}): boolean {
  if (
    input.inputType === undefined
    || input.inputType === "insertFromPaste"
    || input.inputType === "insertReplacementText"
  ) {
    return true;
  }
  const previousDigits = input.previousValue.replace(/\D/g, "").length;
  const nextDigits = input.nextValue.replace(/\D/g, "").length;
  return nextDigits - previousDigits > 1;
}

export function checkoutPhoneDigitsFromChange(input: {
  inputType?: string;
  previousValue: string;
  nextValue: string;
}): string {
  return nationalCheckoutPhoneDigits(input.nextValue, isBulkCheckoutPhoneChange(input));
}

export function firstInvalidCheckoutField(
  errors: Partial<Record<CheckoutFieldName, unknown>>,
): CheckoutFieldName | null {
  return CHECKOUT_FIELD_ORDER.find((field) => errors[field]) ?? null;
}
