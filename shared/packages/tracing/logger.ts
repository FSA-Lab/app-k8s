import pino from "pino";
import { trace } from "@opentelemetry/api";

export function createLogger(serviceName: string) {
    return pino({
        name: serviceName,
        level: process.env.LOG_LEVEL || "info",
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
