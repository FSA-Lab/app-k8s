import pino from "pino";
import { trace } from "@opentelemetry/api";

export function createLogger(serviceName: string) {
    return pino({
        name: serviceName,
        level: process.env.LOG_LEVEL || "info",
        transport: {
            targets: [
                {
                    target: "pino-opentelemetry-transport",
                    level: process.env.LOG_LEVEL || "info",
                    options: {
                        resourceAttributes: {
                            "service.name": serviceName,
                        },
                    },
                },
                {
                    target: "pino/file",
                    options: { destination: 1 },
                },
            ],
        },
        formatters: {
            log(object) {
                const span = trace.getActiveSpan();
                if (span) {
                    const ctx = span.spanContext();
                    object.trace_id = ctx.traceId;
                    object.span_id = ctx.spanId;
                }
                return object;
            },
        },
    });
}
