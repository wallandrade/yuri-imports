/** Contas que o modal de etiqueta pode oferecer. A do servidor fica só no prazo do frete. */

export const ENVIOECOM_ENV_ACCOUNT_ID = "env";

export function envioecomAccountsForLabelPicker<T extends {
  id: string;
  fromEnv?: boolean;
  configured?: boolean;
}>(accounts: T[]): T[] {
  const usable = accounts.filter((account) => account.configured !== false);
  const saved = usable.filter((account) => account.id !== ENVIOECOM_ENV_ACCOUNT_ID && account.fromEnv !== true);
  if (saved.length > 0) return saved;
  return usable.filter((account) => account.id === ENVIOECOM_ENV_ACCOUNT_ID || account.fromEnv === true);
}
