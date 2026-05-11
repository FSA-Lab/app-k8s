import { channel } from "./connection";
import { sagaEventCounter } from "@shared/tracing/metrics";
import { propagation, context } from "@opentelemetry/api";

export async function publishEvent(
    routingKey: string,
    payload: unknown
) {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);

    channel.publish(
        "app.events",
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { headers }
    );
    sagaEventCounter.inc({ event_name: routingKey, service: "order-service" });
}
