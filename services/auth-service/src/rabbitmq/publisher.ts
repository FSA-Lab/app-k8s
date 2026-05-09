import { channel } from "./connection";

export async function publishEvent(
    routingKey: string,
    payload: unknown
) {
    channel.publish(
        "app.events",
        routingKey,
        Buffer.from(JSON.stringify(payload))
    );
}