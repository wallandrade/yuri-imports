import { mediumtext, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Fila da vendedora. Não é status do pedido.
 * pending_admin | approved | rejected
 *
 * A unicidade da pendência fica na coluna gerada pending_order_id
 * (só no SQL da migration). O INSERT não grava essa coluna.
 */
export const orderPaymentPreconfirmsTable = mysqlTable("order_payment_preconfirms", {
  id: varchar("id", { length: 64 }).primaryKey(),
  orderId: varchar("order_id", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  confirmedBy: varchar("confirmed_by", { length: 255 }).notNull(),
  confirmedAt: timestamp("confirmed_at").notNull(),
  note: text("note"),
  proofUrl: mediumtext("proof_url"),
  reviewedBy: varchar("reviewed_by", { length: 255 }),
  reviewedAt: timestamp("reviewed_at"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OrderPaymentPreconfirm = typeof orderPaymentPreconfirmsTable.$inferSelect;
