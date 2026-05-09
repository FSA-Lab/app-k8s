import express, { Request, Response } from "express";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";

import { db, checkDb } from "./db/db";
import { users } from "./db/schema";
import { connectRabbitMQ } from "./rabbitmq/connection";

import { generateToken, authMiddleware, adminMiddleware } from "@shared/auth";

async function bootstrap() {
    try {
        await checkDb();
        await connectRabbitMQ();

        const app = express();
        app.use(express.json());

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

                return res.status(201).json({
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    coin: newUser.coin,
                    role: newUser.role
                });
            } catch (err) {
                console.error(err);
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

                return res.json({ token });
            } catch (err) {
                console.error(err);
                return res.status(500).json({ message: "Internal server error" });
            }
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
                console.error(err);
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

                return res.status(201).json({
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role
                });
            } catch (err) {
                console.error(err);
                return res.status(500).json({ message: "Internal server error" });
            }
        });

        app.listen(3000, () => {
            console.log("auth-service running on port 3000");
        });

        console.log("auth-service started successfully");
    } catch (err) {
        console.error("Failed to start auth-service:", err);
        process.exit(1);
    }
}

bootstrap();