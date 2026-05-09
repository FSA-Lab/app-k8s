import amqp from "amqplib";

export let channel: amqp.Channel;

export async function connectRabbitMQ() {
    const conn =
        await amqp.connect(
            "amqp://rabbitmq-service"
        );

    channel =
        await conn.createChannel();

    await channel.assertExchange(
        "orders",
        "topic",
        {
            durable: true,
        }
    );

    console.log("RabbitMQ connected");
}

