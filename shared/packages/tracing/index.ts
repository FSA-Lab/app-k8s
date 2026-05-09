import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const serviceName = process.env.OTEL_SERVICE_NAME || "unknown-service";
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";

const sdk = new NodeSDK({
    resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
    }),
    instrumentations: [
        getNodeAutoInstrumentations({
            "@opentelemetry/instrumentation-http": { enabled: true },
            "@opentelemetry/instrumentation-express": { enabled: true },
            "@opentelemetry/instrumentation-pg": { enabled: true },
            "@opentelemetry/instrumentation-amqplib": { enabled: true },
            "@opentelemetry/instrumentation-fetch": { enabled: true },
            "@opentelemetry/instrumentation-undici": { enabled: true },
        }),
    ],
});

sdk.start();
console.log(`[otel] tracing initialized for ${serviceName} → ${otlpEndpoint}`);

process.on("SIGTERM", () => {
    sdk.shutdown().then(() => process.exit(0));
});
