import { index, int, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/** Fila de WhatsApp da Z-API. Não guarda token, URL com segredo nem o Client-Token. */
export const whatsappOutboundQueueTable = mysqlTable("whatsapp_outbound_queue", {
  id: varchar("id", { length: 64 }).primaryKey(),
  instance: varchar("instance", { length: 16 }).notNull(),
  phone: varchar("phone", { length: 64 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  message: text("message"),
  caption: text("caption"),
  /** URL da foto. Quando kind é gif, é o MP4. */
  image: text("image"),
  optionList: text("option_list"),
  origin: varchar("origin", { length: 40 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  attempts: int("attempts").notNull().default(0),
  lastError: varchar("last_error", { length: 400 }),
  nextAttemptAt: timestamp("next_attempt_at"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  instanceStatusCreated: index("whatsapp_outbound_queue_instance_status").on(table.instance, table.status, table.createdAt),
  instanceSent: index("whatsapp_outbound_queue_instance_sent").on(table.instance, table.sentAt),
}));
