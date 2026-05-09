import { pgTable, serial, integer, varchar, timestamp } from "drizzle-orm/pg-core";

export const payments = pgTable("payments", {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().unique(),
    price: integer("price").notNull(),
    status: varchar("status", { enum: ["paid", "failed"], length: 20 }).notNull().default("paid"),
    created_at: timestamp("created_at").defaultNow().notNull(),
});
