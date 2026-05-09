import { integer, pgTable, serial, varchar, timestamp } from "drizzle-orm/pg-core";

export const items = pgTable("items", {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    stock: integer().notNull(),
    price: integer().notNull(),
    created_at: timestamp().defaultNow().notNull(),
});
