import amqp from "amqplib";

export let channel: amqp.Channel;

export async function connectRabbitMQ(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            const conn = await amqp.connect(process.env.RABBITMQ_URL!);
            console.log("RabbitMQ connected");
            return conn;
        } catch (err) {
            console.log(`RabbitMQ not ready, retrying... (${i + 1})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error("RabbitMQ failed to connect");
}