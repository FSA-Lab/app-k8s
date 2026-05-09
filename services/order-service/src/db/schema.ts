import {
    pgTable,
    serial,
    integer,
    timestamp,
    pgEnum,
} from "drizzle-orm/pg-core";

/**
 * enum
 */
export const orderStatusEnum = pgEnum(
    "order_status",
    [
        "ongoing",
        "done",
        "failed",
    ]
);

/**
 * orders
 */
export const orders = pgTable(
    "orders",
    {
        id: serial("id").primaryKey(),
        user_id: integer("user_id").notNull(),
        total_price: integer("total_price").notNull(),
        status: orderStatusEnum("status").default("ongoing").notNull(),
        created_at: timestamp("created_at").defaultNow().notNull(),
    }
);

/**
 * order_items
 */
export const orderItems = pgTable(
    "order_items",
    {
        id: serial("id").primaryKey(),
        order_id: integer("order_id").references(() => orders.id).notNull(),
        item_id: integer("item_id").notNull(),
        quantity: integer("quantity").notNull(),
        price_at_purchase: integer("price_at_purchase").notNull(),
    }
);