import { pool } from "@workspace/db";
import { isSellerStaffRole, type AdminRoleName } from "./seller-staff-access";

export type AdminAccess = {
  role: AdminRoleName;
  active: boolean;
  schemaReady: boolean;
};

export function isMissingSchemaError(err: unknown): boolean {
  const record = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = String(record?.code || record?.cause?.code || "");
  const message = String(record?.message || record?.cause?.message || err || "");
  return code === "ER_NO_SUCH_TABLE"
    || code === "ER_BAD_FIELD_ERROR"
    || /doesn't exist/i.test(message)
    || /unknown column/i.test(message)
    || /no such table/i.test(message);
}

export function isActiveFlag(value: unknown): boolean {
  return !(value === false || value === 0 || value === "0");
}

let roleTableMissing = false;

/** Sem a tabela nova, todo mundo segue admin ativo. O login atual não quebra. */
export async function readAdminAccess(userId: string): Promise<AdminAccess> {
  if (roleTableMissing) return { role: "admin", active: true, schemaReady: false };
  try {
    const [rows] = await pool.query(
      "SELECT role, active FROM admin_user_roles WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const list = Array.isArray(rows) ? rows : [];
    const row = list[0] as { role?: unknown; active?: unknown } | undefined;
    if (!row) return { role: "admin", active: true, schemaReady: true };
    return {
      role: isSellerStaffRole(row.role) ? "vendedora" : "admin",
      active: isActiveFlag(row.active),
      schemaReady: true,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      roleTableMissing = true;
      console.error("[admin-access] Tabela admin_user_roles ausente. O login segue como admin até a migration e o reinício da API.");
      return { role: "admin", active: true, schemaReady: false };
    }
    throw err;
  }
}
