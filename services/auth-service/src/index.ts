import express, { Request, Response } from "express";

import { db } from "./db/db";
import { users } from "./db/schema";
import { checkDb } from "./db/db";

import { eq } from "drizzle-orm";

import { authMiddleware } from "./middleware/auth";
import { adminMiddleware } from "./middleware/admin";
import { connectRabbitMQ } from "./rabbitmq/connection";

// Check 
await checkDb();
await connectRabbitMQ();

const app = express();



app.listen(3000, () => {
    console.log(
        "auth-service running on port 3000"
    );
});