import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool);

export async function checkDb(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            await db.execute(sql`SELECT 1`);
            console.log("DB connected");
            return;
        } catch (err) {
            console.log("DB not ready, retrying...");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error("DB failed to connect");
}