import "@shared/tracing";
import express, { Request, Response } from "express";
import amqp from "amqplib";
import { propagation, context } from "@opentelemetry/api";

import { db, checkDb } from "./db/db";
import { items } from "./db/schema";

import { eq, inArray } from "drizzle-orm";

import { authMiddleware, adminMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";
import { register, metricsMiddleware } from "@shared/tracing/metrics";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("inventory-service");

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

                const extractedContext = propagation.extract(
                    context.active(),
                    msg.properties?.headers ?? {}
                );

                context.with(extractedContext, async () => {
                    const data = JSON.parse(msg.content.toString());
                    const routingKey = msg.fields.routingKey;
                    logger.info({ routingKey, orderId: data.orderId }, "event received");

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
                                logger.info({ orderId: data.orderId }, "inventory.reserved");
                            } else {
                                await publishEvent(EVENTS.INVENTORY_FAILED, { orderId: data.orderId, userId: data.userId, totalPrice: data.totalPrice, reason: "insufficient stock" });
                                logger.warn({ orderId: data.orderId }, "inventory.failed — insufficient stock");
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
                            logger.info({ orderId: data.orderId }, "stock restored for failed order");
                        }
                    } catch (err) {
                        logger.error(err, "error processing event");
                    }

                    consumerChannel.ack(msg);
                });
            });

            logger.info("inventory-consumer started");
        }

        startInventoryConsumer();

        const app = express();
        app.use(metricsMiddleware);
        app.use(express.json());

        app.get("/metrics", async (_req: Request, res: Response) => {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        });

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
                    logger.error(err, "fetch items failed");
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

                    logger.info({ item: created[0] }, "item created");

                    return res.status(201).json(created);
                } catch (err) {
                    logger.error(err, "create item failed");
                    return res.status(500).json({
                        message: "Failed to create item",
                    });
                }
            }
        );

        /**
         * DELETE /items/:id
         * admin only
         */
        app.delete(
            "/items/:id",
            authMiddleware,
            adminMiddleware,
            async (req: Request, res: Response) => {
                try {
                    const id = Number(req.params.id);

                    const deleted = await db
                        .delete(items)
                        .where(eq(items.id, id))
                        .returning();

                    if (deleted.length === 0) {
                        return res.status(404).json({ message: "Item not found" });
                    }

                    logger.info({ item: deleted[0] }, "item deleted");
                    return res.json({ message: "Item deleted", item: deleted[0] });
                } catch (err) {
                    logger.error(err, "delete item failed");
                    return res.status(500).json({ message: "Failed to delete item" });
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
                    logger.error(err, "update stock failed");
                    return res.status(500).json({
                        message: "Failed to update stock",
                    });
                }
            }
        );

        app.listen(3000, () => {
            logger.info("inventory-service running on port 3000");
        });
    } catch (err) {
        logger.error(err, "Failed to start inventory-service");
        process.exit(1);
    }
}

bootstrap();
