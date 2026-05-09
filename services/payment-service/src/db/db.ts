import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("payment-service");
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

export async function checkDb(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query("SELECT 1");
            logger.info("Database connected");
            return;
        } catch (err) {
            logger.warn(`Database not ready, retrying... (${i + 1})`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw new Error("Database failed to connect");
}
