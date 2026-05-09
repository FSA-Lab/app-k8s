import express, { Request, Response } from "express";

import { db, checkDb } from "./db/db";
import { orders, orderItems } from "./db/schema";
import { eq } from "drizzle-orm";

import { authMiddleware, adminMiddleware } from "@shared/auth";
import { connectRabbitMQ } from "./rabbitmq/connection";

async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        const app = express();

        app.use(express.json());


        async function startOrderConsumer() {
            const conn =
                await amqp.connect(
                    "amqp://rabbitmq-service"
                );

            const channel =
                await conn.createChannel();

            await channel.assertExchange(
                "orders",
                "topic",
                {
                    durable: true,
                }
            );

            const q =
                await channel.assertQueue(
                    "order.status"
                );

            await channel.bindQueue(
                q.queue,
                "orders",
                "inventory.reserved"
            );

            await channel.bindQueue(
                q.queue,
                "orders",
                "inventory.failed"
            );

            await channel.bindQueue(
                q.queue,
                "orders",
                "payment.success"
            );

            await channel.bindQueue(
                q.queue,
                "orders",
                "payment.failed"
            );

            channel.consume(
                q.queue,
                async (msg) => {
                    if (!msg) return;

                    const data = JSON.parse(
                        msg.content.toString()
                    );

                    console.log(data);

                    /**
                     * inventory failed
                     */
                    if (
                        msg.fields.routingKey ===
                        "inventory.failed"
                    ) {
                        await db
                            .update(orders)
                            .set({
                                status: "failed",
                            })
                            .where(
                                eq(
                                    orders.id,
                                    data.orderId
                                )
                            );
                    }

                    /**
                     * payment failed
                     */
                    if (
                        msg.fields.routingKey ===
                        "payment.failed"
                    ) {
                        await db
                            .update(orders)
                            .set({
                                status: "failed",
                            })
                            .where(
                                eq(
                                    orders.id,
                                    data.orderId
                                )
                            );
                    }

                    /**
                     * payment success
                     * simplistic version
                     */
                    if (
                        msg.fields.routingKey ===
                        "payment.success"
                    ) {
                        await db
                            .update(orders)
                            .set({
                                status: "done",
                            })
                            .where(
                                eq(
                                    orders.id,
                                    data.orderId
                                )
                            );
                    }

                    channel.ack(msg);
                }
            );
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
                        event: "order.created",
                        orderId,
                        userId,
                        totalPrice,
                        items,
                    };


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