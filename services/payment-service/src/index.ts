import "@shared/tracing";
import express, { Request, Response } from "express";
import amqp from "amqplib";
import { propagation, context } from "@opentelemetry/api";

import { db, checkDb } from "./db/db";
import { payments } from "./db/schema";
import { eq } from "drizzle-orm";

import { authMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";
import { register, metricsMiddleware } from "@shared/tracing/metrics";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("payment-service");
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://auth-service:3000";

async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        async function startPaymentConsumer() {
            const conn = await amqp.connect(process.env.RABBITMQ_URL!);
            const consumerChannel = await conn.createChannel();

            await consumerChannel.assertExchange("app.events", "topic", { durable: true });

            const q = await consumerChannel.assertQueue("payment.process");

            await consumerChannel.bindQueue(q.queue, "app.events", EVENTS.INVENTORY_RESERVED);

            consumerChannel.consume(q.queue, async (msg) => {
                if (!msg) return;

                const extractedContext = propagation.extract(
                    context.active(),
                    msg.properties?.headers ?? {}
                );

                context.with(extractedContext, async () => {
                    const data = JSON.parse(msg.content.toString());
                    logger.info({ orderId: data.orderId }, "inventory.reserved received");

                    try {
                        const userRes = await fetch(`${AUTH_SERVICE_URL}/users/${data.userId}`);
                        if (!userRes.ok) {
                            throw new Error("Failed to fetch user");
                        }
                        const user = await userRes.json() as { id: number; coin: number };

                        const totalPrice = data.totalPrice;

                        if (user.coin >= totalPrice) {
                            const deductRes = await fetch(`${AUTH_SERVICE_URL}/users/${data.userId}/coins`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ coin: user.coin - totalPrice }),
                            });

                            if (!deductRes.ok) {
                                throw new Error("Failed to deduct coins");
                            }

                            await db.insert(payments).values({
                                order_id: data.orderId,
                                price: totalPrice,
                                status: "paid",
                            });

                            await publishEvent(EVENTS.PAYMENT_COMPLETED, { orderId: data.orderId, userId: data.userId });
                            logger.info({ orderId: data.orderId }, "payment.completed");
                        } else {
                            await db.insert(payments).values({
                                order_id: data.orderId,
                                price: totalPrice,
                                status: "failed",
                            });

                            await publishEvent(EVENTS.PAYMENT_FAILED, { orderId: data.orderId, userId: data.userId, reason: "insufficient coins" });
                            logger.warn({ orderId: data.orderId }, "payment.failed — insufficient coins");
                        }
                    } catch (err) {
                        logger.error(err, "error processing payment");
                        await publishEvent(EVENTS.PAYMENT_FAILED, { orderId: data.orderId, userId: data.userId, reason: "payment processing error" });
                    }

                    consumerChannel.ack(msg);
                });
            });

            logger.info("payment-consumer started");
        }

        startPaymentConsumer();

        const app = express();
        app.use(metricsMiddleware);
        app.use(express.json());

        app.get("/metrics", async (_req: Request, res: Response) => {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        });

        /**
         * GET /payments
         * list all payments
         */
        app.get("/payments", authMiddleware, async (_: Request, res: Response) => {
            try {
                const data = await db.select().from(payments);
                return res.json(data);
            } catch (err) {
                logger.error(err, "fetch payments failed");
                return res.status(500).json({ message: "Failed to fetch payments" });
            }
        });

        /**
         * POST /payments
         * manual payment (for testing)
         */
        app.post("/payments", authMiddleware, async (req: Request, res: Response) => {
            try {
                const { order_id, price } = req.body;

                if (!order_id || !price) {
                    return res.status(400).json({ message: "order_id and price are required" });
                }

                const [created] = await db.insert(payments).values({
                    order_id,
                    price,
                    status: "paid",
                }).returning();

                logger.info({ orderId: order_id }, "manual payment created");

                return res.status(201).json(created);
            } catch (err) {
                logger.error(err, "create payment failed");
                return res.status(500).json({ message: "Failed to create payment" });
            }
        });

        app.listen(3000, () => {
            logger.info("payment-service running on port 3000");
        });
    } catch (err) {
        logger.error(err, "Failed to start payment-service");
        process.exit(1);
    }
}

bootstrap();
