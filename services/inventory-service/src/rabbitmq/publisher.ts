import { channel } from "./connection";
import { sagaEventCounter } from "@shared/tracing/metrics";

export async function publishEvent(
    routingKey: string,
    payload: unknown
) {
    channel.publish(
        "app.events",
        routingKey,
        Buffer.from(JSON.stringify(payload))
    );
    sagaEventCounter.inc({ event_name: routingKey, service: "inventory-service" });
}
