import amqp from "amqplib";
import { createLogger } from "@shared/tracing/logger";

const logger = createLogger("order-service");
export let channel: amqp.Channel;

export async function connectRabbitMQ(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            const conn = await amqp.connect(process.env.RABBITMQ_URL!);
            channel = await conn.createChannel();
            await channel.assertExchange("app.events", "topic", { durable: true });
            logger.info("RabbitMQ connected");
            return conn;
        } catch (err) {
            logger.warn(`RabbitMQ not ready, retrying... (${i + 1})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error("RabbitMQ failed to connect");
}
