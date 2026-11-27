import { boolean, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

/** Papel extra do login do admin. Quem não tem linha continua admin ativo. */
export const adminUserRolesTable = mysqlTable("admin_user_roles", {
  userId: varchar("user_id", { length: 255 }).primaryKey(),
  role: varchar("role", { length: 32 }).notNull(),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AdminUserRole = typeof adminUserRolesTable.$inferSelect;
