import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool);

export async function checkDb() {
    try {
        const result = await db.execute(sql`SELECT 1`);
        console.log('Database connected successfully!');
    } catch (error) {
        console.error('Database connection failed:', error);
    }
}