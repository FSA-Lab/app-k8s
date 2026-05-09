import express, { Request, Response } from "express";
import amqp from "amqplib";

import { db, checkDb } from "./db/db";
import { payments } from "./db/schema";
import { eq } from "drizzle-orm";

import { authMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";

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

                const data = JSON.parse(msg.content.toString());
                console.log(`[payment-consumer] ${EVENTS.INVENTORY_RESERVED}`, data);

                try {
                    // Get user's coin balance from auth-service
                    const userRes = await fetch(`${AUTH_SERVICE_URL}/users/${data.userId}`);
                    if (!userRes.ok) {
                        throw new Error("Failed to fetch user");
                    }
                    const user = await userRes.json() as { id: number; coin: number };

                    // Get order total from order-service (we have orderId and totalPrice in event)
                    // The event includes totalPrice from the order creation
                    const totalPrice = data.totalPrice;

                    if (user.coin >= totalPrice) {
                        // Deduct coins
                        const deductRes = await fetch(`${AUTH_SERVICE_URL}/users/${data.userId}/coins`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ coin: user.coin - totalPrice }),
                        });

                        if (!deductRes.ok) {
                            throw new Error("Failed to deduct coins");
                        }

                        // Create payment record
                        await db.insert(payments).values({
                            order_id: data.orderId,
                            price: totalPrice,
                            status: "paid",
                        });

                        await publishEvent(EVENTS.PAYMENT_COMPLETED, { orderId: data.orderId, userId: data.userId });
                        console.log(`[payment-consumer] payment.completed for order ${data.orderId}`);
                    } else {
                        // Insufficient coins
                        await db.insert(payments).values({
                            order_id: data.orderId,
                            price: totalPrice,
                            status: "failed",
                        });

                        await publishEvent(EVENTS.PAYMENT_FAILED, { orderId: data.orderId, userId: data.userId, reason: "insufficient coins" });
                        console.log(`[payment-consumer] payment.failed for order ${data.orderId}`);
                    }
                } catch (err) {
                    console.error("[payment-consumer] error processing payment:", err);
                    // Publish payment failed on error
                    await publishEvent(EVENTS.PAYMENT_FAILED, { orderId: data.orderId, userId: data.userId, reason: "payment processing error" });
                }

                consumerChannel.ack(msg);
            });

            console.log("payment-consumer started");
        }

        startPaymentConsumer();

        const app = express();
        app.use(express.json());

        /**
         * GET /payments
         * list all payments
         */
        app.get("/payments", authMiddleware, async (_: Request, res: Response) => {
            try {
                const data = await db.select().from(payments);
                return res.json(data);
            } catch (err) {
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

                return res.status(201).json(created);
            } catch (err) {
                return res.status(500).json({ message: "Failed to create payment" });
            }
        });

        app.listen(3000, () => {
            console.log("payment-service running on port 3000");
        });

        console.log("payment-service started successfully");
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

bootstrap();
