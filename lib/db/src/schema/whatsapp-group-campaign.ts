import { boolean, int, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/** Aviso avulso para os grupos. Imagem e link podem ficar vazios. `active` desliga sem apagar. */
export const whatsappGroupCustomPostsTable = mysqlTable("whatsapp_group_custom_posts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  imageUrl: text("image_url").notNull(),
  caption: text("caption"),
  linkUrl: varchar("link_url", { length: 500 }).notNull(),
  scheduledAt: varchar("scheduled_at", { length: 16 }).notNull(),
  scheduleMode: varchar("schedule_mode", { length: 16 }).notNull().default("once"),
  scheduleTimes: text("schedule_times"),
  intervalHours: int("interval_hours"),
  durationDays: int("duration_days"),
  active: boolean("active").notNull().default(true),
  targetChats: text("target_chats"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Marca o grupo que já recebeu aquele horário, para não mandar de novo. */
export const whatsappGroupSendLogTable = mysqlTable("whatsapp_group_send_log", {
  id: varchar("id", { length: 191 }).primaryKey(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});
