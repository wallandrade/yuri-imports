import { json, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

/** Append-only. Não há coluna de edição nem rota de apagar. */
export const adminAuditLogTable = mysqlTable("admin_audit_log", {
  id: varchar("id", { length: 64 }).primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  actorUsername: varchar("actor_username", { length: 255 }).notNull(),
  actorRole: varchar("actor_role", { length: 32 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  entityType: varchar("entity_type", { length: 64 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  beforeJson: json("before_json"),
  afterJson: json("after_json"),
  ip: varchar("ip", { length: 64 }),
});

export type AdminAuditLog = typeof adminAuditLogTable.$inferSelect;
