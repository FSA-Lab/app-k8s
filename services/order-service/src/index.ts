import "@shared/tracing";
import express, { Request, Response } from "express";
import amqp from "amqplib";
import { propagation, context } from "@opentelemetry/api";

import { db, checkDb } from "./db/db";
import { orders, orderItems } from "./db/schema";
import { eq } from "drizzle-orm";

import { authMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";
import { register, metricsMiddleware } from "@shared/tracing/metrics";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("order-service");

async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        const app = express();
        app.use(metricsMiddleware);
        app.use(express.json());

        app.get("/metrics", async (_req: Request, res: Response) => {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        });


        async function startOrderConsumer() {
            const conn = await amqp.connect(process.env.RABBITMQ_URL!);
            const consumerChannel = await conn.createChannel();

            await consumerChannel.assertExchange("app.events", "topic", { durable: true });

            const q = await consumerChannel.assertQueue("order.status");

            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.INVENTORY_RESERVED);
            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.INVENTORY_FAILED);
            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.PAYMENT_COMPLETED);
            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.PAYMENT_FAILED);

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

                    if (routingKey === EVENTS.INVENTORY_FAILED) {
                        await db.update(orders).set({ status: "failed" }).where(eq(orders.id, data.orderId));
                        logger.info({ orderId: data.orderId }, "order failed (inventory)");
                    }

                    if (routingKey === EVENTS.PAYMENT_FAILED) {
                        await db.update(orders).set({ status: "failed" }).where(eq(orders.id, data.orderId));

                        const orderItemsList = await db.select().from(orderItems).where(eq(orderItems.order_id, data.orderId));
                        await publishEvent(EVENTS.ORDER_FAILED, {
                            orderId: data.orderId,
                            userId: data.userId,
                            items: orderItemsList.map(i => ({ item_id: i.item_id, quantity: i.quantity })),
                        });
                        logger.info({ orderId: data.orderId }, "order failed (payment) — stock rollback published");
                    }

                    if (routingKey === EVENTS.PAYMENT_COMPLETED) {
                        await db.update(orders).set({ status: "done" }).where(eq(orders.id, data.orderId));
                        logger.info({ orderId: data.orderId }, "order completed");
                    }

                    consumerChannel.ack(msg);
                });
            });

            logger.info("order-consumer started");
        }

        startOrderConsumer();

        /**
         * GET /orders
         * current user's orders
         */
        app.get("/orders", authMiddleware, async (req: Request, res: Response) => {
            try {
                const userId = req.user!.id;

                const data = await db
                    .select()
                    .from(orders)
                    .where(eq(orders.user_id, userId));

                return res.json(data);
            } catch (err) {
                logger.error(err, "fetch orders failed");
                return res.status(500).json({
                    message: "Failed to fetch orders",
                });
            }
        });

        /**
         * GET /orders/:id
         * single order
         */
        app.get("/orders/:id", authMiddleware, async (req: Request, res: Response) => {
            try {
                const orderId = Number(req.params.id);
                const userId = req.user!.id;

                const order = await db
                    .select()
                    .from(orders)
                    .where(eq(orders.id, orderId));

                if (!order[0]) {
                    return res.status(404).json({
                        message: "Order not found",
                    });
                }

                if (order[0].user_id !== userId) {
                    return res.status(403).json({
                        message: "Forbidden",
                    });
                }

                const items = await db
                    .select()
                    .from(orderItems)
                    .where(eq(orderItems.order_id, orderId));

                return res.json({
                    order: order[0],
                    items,
                });
            } catch (err) {
                logger.error(err, "fetch order failed");
                return res.status(500).json({
                    message: "Failed to fetch order",
                });
            }
        });

        /**
         * POST /orders
         * create order — saga start
         */
        app.post(
            "/orders",
            authMiddleware,
            async (req: Request, res: Response) => {
                try {
                    const userId = req.user!.id;

                    const {
                        items,
                    }: {
                        items: {
                            item_id: number;
                            quantity: number;
                            price: number;
                        }[];
                    } = req.body;

                    const totalPrice =
                        items.reduce(
                            (acc, item) =>
                                acc +
                                item.price *
                                item.quantity,
                            0
                        );

                    const createdOrder =
                        await db
                            .insert(orders)
                            .values({
                                user_id: userId,
                                total_price:
                                    totalPrice,
                                status: "ongoing",
                            })
                            .returning();

                    const orderId =
                        createdOrder[0].id;

                    await db
                        .insert(orderItems)
                        .values(
                            items.map((item) => ({
                                order_id: orderId,
                                item_id: item.item_id,
                                quantity: item.quantity,
                                price_at_purchase: item.price,
                            }))
                        );

                    const event = {
                        event: EVENTS.ORDER_CREATED,
                        orderId,
                        userId,
                        totalPrice,
                        items,
                    };

                    await publishEvent(EVENTS.ORDER_CREATED, event);

                    logger.info({ orderId, userId, totalPrice }, "order created — saga started");

                    return res.status(201).json({
                        message: "Order created",
                        orderId,
                        status: "ongoing",
                    });
                } catch (err) {
                    logger.error(err, "create order failed");
                    return res.status(500).json({
                        message: "Failed to create order",
                    });
                }
            }
        );

        app.listen(3000, () => {
            logger.info("order-service running on 3000");
        });
    } catch (err) {
        logger.error(err, "Failed to start order-service");
        process.exit(1);
    }

}

bootstrap();
