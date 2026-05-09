import "@shared/tracing";
import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";

import { db, checkDb } from "./db/db";
import { users } from "./db/schema";
import { connectRabbitMQ } from "./rabbitmq/connection";

import { generateToken, authMiddleware } from "@shared/auth";
import { register, metricsMiddleware } from "@shared/tracing/metrics";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("auth-service");

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

        // POST /signup
        app.post("/signup", async (req: Request, res: Response) => {
            try {
                const { name, email, password } = req.body;

                if (!name || !email || !password) {
                    return res.status(400).json({ message: "Name, email, and password are required" });
                }

                const existingUser = await db.select().from(users).where(eq(users.email, email));
                if (existingUser.length > 0) {
                    return res.status(400).json({ message: "Email already in use" });
                }

                const password_hash = await bcrypt.hash(password, 10);

                const [newUser] = await db.insert(users).values({
                    name,
                    email,
                    password_hash,
                    coin: 1000,
                    role: "user"
                }).returning();

                logger.info({ userId: newUser.id }, "user signed up");

                return res.status(201).json({
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    coin: newUser.coin,
                    role: newUser.role
                });
            } catch (err) {
                logger.error(err, "signup failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        // POST /login
        app.post("/login", async (req: Request, res: Response) => {
            try {
                const { email, password } = req.body;

                if (!email || !password) {
                    return res.status(400).json({ message: "Email and password are required" });
                }

                const result = await db.select().from(users).where(eq(users.email, email));
                if (result.length === 0) {
                    return res.status(401).json({ message: "Invalid credentials" });
                }

                const user = result[0];
                const isValid = await bcrypt.compare(password, user.password_hash);
                if (!isValid) {
                    return res.status(401).json({ message: "Invalid credentials" });
                }

                const token = generateToken({
                    id: user.id,
                    email: user.email,
                    role: user.role
                });

                logger.info({ userId: user.id }, "user logged in");

                return res.json({ token });
            } catch (err) {
                logger.error(err, "login failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        // POST /logout
        app.post("/logout", (_req: Request, res: Response) => {
            return res.json({ message: "Logged out successfully" });
        });

        // GET /me
        app.get("/me", authMiddleware, async (req: Request, res: Response) => {
            try {
                if (!req.user) {
                    return res.status(401).json({ message: "Unauthorized" });
                }

                const result = await db.select().from(users).where(eq(users.id, req.user.id));
                if (result.length === 0) {
                    return res.status(404).json({ message: "User not found" });
                }

                const user = result[0];
                return res.json({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    coin: user.coin,
                    role: user.role
                });
            } catch (err) {
                logger.error(err, "fetch /me failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        // POST /seed-admin
        app.post("/seed-admin", async (req: Request, res: Response) => {
            try {
                const { name, email, password } = req.body;

                if (!name || !email || !password) {
                    return res.status(400).json({ message: "Name, email, and password are required" });
                }

                const existingUser = await db.select().from(users).where(eq(users.email, email));
                if (existingUser.length > 0) {
                    return res.status(400).json({ message: "Email already in use" });
                }

                const password_hash = await bcrypt.hash(password, 10);

                const [newUser] = await db.insert(users).values({
                    name,
                    email,
                    password_hash,
                    coin: 99999,
                    role: "admin"
                }).returning();

                logger.info({ userId: newUser.id }, "admin seeded");

                return res.status(201).json({
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role
                });
            } catch (err) {
                logger.error(err, "seed-admin failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        // GET /users/:id (internal)
        app.get("/users/:id", async (req: Request, res: Response) => {
            try {
                const id = Number(req.params.id);
                const result = await db.select().from(users).where(eq(users.id, id));
                if (result.length === 0) {
                    return res.status(404).json({ message: "User not found" });
                }
                const user = result[0];
                return res.json({ id: user.id, name: user.name, email: user.email, coin: user.coin, role: user.role });
            } catch (err) {
                logger.error(err, "fetch user failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        // PATCH /users/:id/coins (internal - for payment-service)
        app.patch("/users/:id/coins", async (req: Request, res: Response) => {
            try {
                const id = Number(req.params.id);
                const { coin } = req.body;

                if (coin === undefined || coin === null) {
                    return res.status(400).json({ message: "coin is required" });
                }

                const [updated] = await db.update(users).set({ coin }).where(eq(users.id, id)).returning();
                if (!updated) {
                    return res.status(404).json({ message: "User not found" });
                }

                logger.info({ userId: id, coin }, "coins updated");

                return res.json({ id: updated.id, coin: updated.coin });
            } catch (err) {
                logger.error(err, "update coins failed");
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        app.listen(3000, () => {
            logger.info("auth-service running on port 3000");
        });
    } catch (err) {
        logger.error(err, "Failed to start auth-service");
        process.exit(1);
    }
}

bootstrap();
