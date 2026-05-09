import { pgTable, serial, varchar, text, integer, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password_hash: text("password_hash").notNull(),
    role: varchar("role", { enum: ["user", "admin"], length: 20 }).default("user").notNull(),
    coin: integer("coin").default(1000).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
});