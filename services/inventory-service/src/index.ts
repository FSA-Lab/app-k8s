import express, { Request, Response } from "express";

import { db, checkDb } from "./db/db";
import { items } from "./db/schema";

import { eq } from "drizzle-orm";

import { authMiddleware, adminMiddleware } from "@shared/auth";
import { connectRabbitMQ } from "./rabbitmq/connection";


async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

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
