import express, { Request, Response } from "express";
import amqp from "amqplib";

import { db, checkDb } from "./db/db";
import { orders, orderItems } from "./db/schema";
import { eq } from "drizzle-orm";

import { authMiddleware } from "@shared/auth";
import { EVENTS } from "@shared/events";
import { connectRabbitMQ } from "./rabbitmq/connection";
import { publishEvent } from "./rabbitmq/publisher";

async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        const app = express();

        app.use(express.json());


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

                const data = JSON.parse(msg.content.toString());
                const routingKey = msg.fields.routingKey;

                console.log(`[order-consumer] ${routingKey}`, data);

                if (routingKey === EVENTS.INVENTORY_FAILED) {
                    // Stock was never deducted, no compensation needed
                    await db.update(orders).set({ status: "failed" }).where(eq(orders.id, data.orderId));
                    console.log(`[order-consumer] order ${data.orderId} failed (inventory)`);
                }

                if (routingKey === EVENTS.PAYMENT_FAILED) {
                    // Stock was deducted, need compensation rollback
                    await db.update(orders).set({ status: "failed" }).where(eq(orders.id, data.orderId));

                    const orderItemsList = await db.select().from(orderItems).where(eq(orderItems.order_id, data.orderId));
                    await publishEvent(EVENTS.ORDER_FAILED, {
                        orderId: data.orderId,
                        userId: data.userId,
                        items: orderItemsList.map(i => ({ item_id: i.item_id, quantity: i.quantity })),
                    });
                    console.log(`[order-consumer] order ${data.orderId} failed (payment) — stock rollback published`);
                }

                if (routingKey === EVENTS.PAYMENT_COMPLETED) {
                    await db.update(orders).set({ status: "done" }).where(eq(orders.id, data.orderId));
                }

                consumerChannel.ack(msg);
            });

            console.log("order-consumer started");
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
                return res.status(500).json({
                    message:
                        "Failed to fetch orders",
                });
            }
        }
        );

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

                /**
                 * ownership check
                 */
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
                return res.status(500).json({
                    message: "Failed to fetch order",
                });
            }
        });

        /**
         * POST /orders
         * create order
         * saga start
         */
        app.post(
            "/orders",
            authMiddleware,
            async (req: Request, res: Response) => {
                try {
                    const userId = req.user!.id;

                    /**
                     * frontend sends:
                     * items: [
                     *   {
                     *     item_id,
                     *     quantity,
                     *     price
                     *   }
                     * ]
                     */
                    const {
                        items,
                    }: {
                        items: {
                            item_id: number;
                            quantity: number;
                            price: number;
                        }[];
                    } = req.body;

                    /**
                     * calculate total
                     */
                    const totalPrice =
                        items.reduce(
                            (acc, item) =>
                                acc +
                                item.price *
                                item.quantity,
                            0
                        );

                    /**
                     * create order
                     */
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

                    /**
                     * create order items
                     */
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

                    /**
                     * publish saga event
                     */
                    const event = {
                        event: EVENTS.ORDER_CREATED,
                        orderId,
                        userId,
                        totalPrice,
                        items,
                    };

                    await publishEvent(EVENTS.ORDER_CREATED, event);


                    return res.status(201).json({
                        message:
                            "Order created",
                        orderId,
                        status: "ongoing",
                    });
                } catch (err) {
                    console.error(err);

                    return res.status(500).json({
                        message:
                            "Failed to create order",
                    });
                }
            }
        );

        app.listen(3000, () => {
            console.log(
                "order-service running on 3000"
            );
        });

        console.log("order-service started successfully");
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

}

bootstrap();