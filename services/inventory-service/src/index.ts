import express, { Request, Response } from "express";
import amqp from "amqplib";

import { db, checkDb } from "./db/db";
import { items } from "./db/schema";

import { eq, inArray } from "drizzle-orm";

import { authMiddleware, adminMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";


async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        async function startInventoryConsumer() {
            const conn = await amqp.connect(process.env.RABBITMQ_URL!);
            const consumerChannel = await conn.createChannel();

            await consumerChannel.assertExchange("app.events", "topic", { durable: true });

            const q = await consumerChannel.assertQueue("inventory.reserve");

            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.ORDER_CREATED);
            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.ORDER_FAILED);

            consumerChannel.consume(q.queue, async (msg) => {
                if (!msg) return;

                const data = JSON.parse(msg.content.toString());
                const routingKey = msg.fields.routingKey;
                console.log(`[inventory-consumer] ${routingKey}`, data);

                try {
                    if (routingKey === EVENTS.ORDER_CREATED) {
                        const itemIds = data.items.map((i: any) => i.item_id);
                        const dbItems = await db.select().from(items).where(inArray(items.id, itemIds));

                        let hasStock = true;
                        for (const orderItem of data.items) {
                            const dbItem = dbItems.find((d) => d.id === orderItem.item_id);
                            if (!dbItem || dbItem.stock < orderItem.quantity) {
                                hasStock = false;
                                break;
                            }
                        }

                        if (hasStock) {
                            for (const orderItem of data.items) {
                                const dbItem = dbItems.find((d) => d.id === orderItem.item_id)!;
                                await db.update(items).set({ stock: dbItem.stock - orderItem.quantity }).where(eq(items.id, orderItem.item_id));
                            }
                            await publishEvent(EVENTS.INVENTORY_RESERVED, { orderId: data.orderId, userId: data.userId, totalPrice: data.totalPrice });
                            console.log(`[inventory-consumer] inventory.reserved for order ${data.orderId}`);
                        } else {
                            await publishEvent(EVENTS.INVENTORY_FAILED, { orderId: data.orderId, userId: data.userId, totalPrice: data.totalPrice, reason: "insufficient stock" });
                            console.log(`[inventory-consumer] inventory.failed for order ${data.orderId}`);
                        }
                    }

                    // Compensation: restore stock on order failure
                    if (routingKey === EVENTS.ORDER_FAILED) {
                        const itemIds = data.items.map((i: any) => i.item_id);
                        const dbItems = await db.select().from(items).where(inArray(items.id, itemIds));

                        for (const orderItem of data.items) {
                            const dbItem = dbItems.find((d) => d.id === orderItem.item_id);
                            if (dbItem) {
                                await db.update(items).set({ stock: dbItem.stock + orderItem.quantity }).where(eq(items.id, orderItem.item_id));
                            }
                        }
                        console.log(`[inventory-consumer] stock restored for failed order ${data.orderId}`);
                    }
                } catch (err) {
                    console.error("[inventory-consumer] error processing event:", err);
                }

                consumerChannel.ack(msg);
            });

            console.log("inventory-consumer started");
        }

        startInventoryConsumer();

        const app = express();

        app.use(express.json());

        /**
         * GET /items
         * list inventory
         */
        app.get(
            "/items",
            authMiddleware,
            async (_, res: Response) => {
                try {
                    const data = await db
                        .select()
                        .from(items);

                    return res.json(data);
                } catch (err) {
                    return res.status(500).json({
                        message: "Failed to fetch items",
                    });
                }
            }
        );

        /**
         * POST /items
         * admin only
         */
        app.post(
            "/items",
            authMiddleware,
            adminMiddleware,
            async (req: Request, res: Response) => {
                try {
                    const { name, stock, price } = req.body;

                    const created = await db
                        .insert(items)
                        .values({
                            name,
                            stock,
                            price,
                        })
                        .returning();

                    return res.status(201).json(created);
                } catch (err) {
                    return res.status(500).json({
                        message: "Failed to create item",
                    });
                }
            }
        );

        /**
         * PATCH /items/:id/stock
         * queue consumer or admin
         */
        app.patch(
            "/items/:id/stock",
            authMiddleware,
            async (req: Request, res: Response) => {
                try {
                    const id = Number(req.params.id);

                    const { stock } = req.body;

                    const updated = await db
                        .update(items)
                        .set({
                            stock,
                        })
                        .where(eq(items.id, id))
                        .returning();

                    return res.json(updated);
                } catch (err) {
                    return res.status(500).json({
                        message: "Failed to update stock",
                    });
                }
            }
        );

        app.listen(3000, () => {
            console.log(
                "inventory-service running on port 3000"
            );
        });


        console.log("inventory-service started successfully");
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

bootstrap();
