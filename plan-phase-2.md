# Phase 2 Plan: OpenTelemetry, Prometheus & Grafana

## Context

Phase 1 is complete — 4 services (auth, inventory, order, payment) with RabbitMQ saga, Kong gateway, Docker Compose. Phase 2 adds observability: distributed tracing, metrics, structured logging, and dashboards.

---

## Architecture

```
                    ┌──────────┐
                    │  Kong    │ :8000
                    └────┬─────┘
         ┌───────┬───────┼───────┐
         ▼       ▼       ▼       ▼
      auth    inventory  order  payment    ← each exports /metrics
         │       │       │       │
         └───────┴───────┴───────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
        OTel Collector   Prometheus      ← scrapes /metrics every 15s
              │             │
              ▼             ▼
           Jaeger        Grafana         ← dashboards + traces UI
          :16686        :3004
```

**Three observability signals:**
1. **Traces** — OpenTelemetry SDK in each service → OTel Collector → Jaeger
2. **Metrics** — prom-client in each service (exposed at `/metrics`) → Prometheus scrapes
3. **Logs** — Structured JSON logs via pino, correlated with trace_id/span_id

---

## Implementation Tasks

### Task 1: Create `@shared/tracing` package

Create a shared OpenTelemetry initialization module so all 4 services use the same config.

**New files:**
- `shared/packages/tracing/package.json` — name: `@shared/tracing`, deps: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `prom-client`, `pino`
- `shared/packages/tracing/index.ts` — Initializes `NodeSDK` with:
  - Service name from `OTEL_SERVICE_NAME` env var
  - `OTLPSpanExporter` pointing to `OTEL_EXPORTER_OTLP_ENDPOINT` (default: `http://otel-collector:4318`)
  - `getNodeAutoInstrumentations()` — auto-instruments http, express, pg, amqplib, fetch/undici
  - Calls `sdk.start()` on import
- `shared/packages/tracing/metrics.ts` — Sets up `prom-client` with:
  - Default metrics (GC, event loop, memory, etc.)
  - Custom histogram: `http_request_duration_seconds` (labels: method, route, status_code)
  - Custom counter: `saga_events_total` (labels: event_name, service)
  - Exports `register` (prom-client Registry) and `recordRequest()` helper
- `shared/packages/tracing/logger.ts` — pino logger factory:
  - `createLogger(serviceName)` returns a pino instance
  - Automatically includes `trace_id` and `span_id` in every log line via OTel context
  - JSON format for structured logging

**Why shared:** Avoids duplicating OTel setup across 4 services. Each service just does `import "@shared/tracing"` as its first import.

### Task 2: Add tracing + metrics to all 4 services

For each service (`auth-service`, `inventory-service`, `order-service`, `payment-service`):

**Modify `package.json`:**
- Add dependency: `"@shared/tracing": "^1.0.0"`

**Modify `src/index.ts`:**
- Add as first line: `import "@shared/tracing"`
- Add `/metrics` endpoint:
  ```ts
  import { register } from "@shared/tracing/metrics";
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
  ```
- Replace `console.log` with `logger.info` / `logger.error` from `@shared/tracing/logger`

**Modify `src/rabbitmq/publisher.ts`:**
- Add saga event counter increment after each publish:
  ```ts
  import { sagaEventCounter } from "@shared/tracing/metrics";
  sagaEventCounter.inc({ event_name: routingKey, service: "order-service" });
  ```

**Dockerfile — no changes needed** (already copies `shared/packages`)

**docker-compose.yml — add env vars to each service:**
```yaml
environment:
  - OTEL_SERVICE_NAME=auth-service  # unique per service
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
depends_on:
  - otel-collector
```

**Files per service (×4):**
- `services/*/package.json` — add `@shared/tracing` dep
- `services/*/src/index.ts` — add tracing import + `/metrics` route + pino logger
- `services/*/src/rabbitmq/publisher.ts` — add saga event counter

### Task 3: Add OTel Collector + Jaeger to Docker Compose

**Modify `docker-compose.yml`:**

```yaml
jaeger:
  image: jaegertracing/all-in-one:latest
  ports:
    - "16686:16686"
  environment:
    - COLLECTOR_OTLP_ENABLED=true

otel-collector:
  image: otel/opentelemetry-collector:latest
  command: ["--config=/etc/otel-config.yml"]
  volumes:
    - ./otel/otel-config.yml:/etc/otel-config.yml:ro
  ports:
    - "4318:4318"
  depends_on:
    - jaeger
```

**New file: `otel/otel-config.yml`:**
```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [jaeger]
```

### Task 4: Add Prometheus to Docker Compose

**New file: `prometheus/prometheus.yml`:**
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: "auth-service"
    static_configs:
      - targets: ["auth-service:3000"]
  - job_name: "inventory-service"
    static_configs:
      - targets: ["inventory-service:3000"]
  - job_name: "order-service"
    static_configs:
      - targets: ["order-service:3000"]
  - job_name: "payment-service"
    static_configs:
      - targets: ["payment-service:3000"]
```

**Add to `docker-compose.yml`:**
```yaml
prometheus:
  image: prom/prometheus:latest
  ports:
    - "9090:9090"
  volumes:
    - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  depends_on:
    - auth-service
    - inventory-service
    - order-service
    - payment-service
```

### Task 5: Add Grafana to Docker Compose

**New file: `grafana/provisioning/datasources/prometheus.yml`:**
```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

**New file: `grafana/provisioning/dashboards/dashboards.yml`:**
```yaml
apiVersion: 1
providers:
  - name: default
    folder: "Microservices"
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

**New file: `grafana/dashboards/microservices.json`:**
Pre-built Grafana dashboard JSON with panels:
- Request rate per service (QPS)
- Request latency p50/p95/p99 per service
- Error rate (4xx, 5xx) per service
- Saga event flow rate (order.created → inventory.reserved → payment.completed)
- Active request count

**Add to `docker-compose.yml`:**
```yaml
grafana:
  image: grafana/grafana:latest
  ports:
    - "3004:3000"
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
    - GF_AUTH_ANONYMOUS_ENABLED=true
  volumes:
    - ./grafana/provisioning:/etc/grafana/provisioning:ro
    - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
  depends_on:
    - prometheus
```

### Task 6: Update readme.md Phase 2 section

Already done — Phase 2 section in readme.md has architecture diagram, feature descriptions, access points, and new file listing.

---

## New Files Summary

| File | Purpose |
|---|---|
| `shared/packages/tracing/package.json` | OTel + metrics + logging shared package |
| `shared/packages/tracing/index.ts` | OTel SDK initialization |
| `shared/packages/tracing/metrics.ts` | prom-client setup + custom metrics |
| `shared/packages/tracing/logger.ts` | pino logger factory with trace correlation |
| `otel/otel-config.yml` | OTel Collector config |
| `prometheus/prometheus.yml` | Prometheus scrape targets |
| `grafana/provisioning/datasources/prometheus.yml` | Auto-configure Prometheus datasource |
| `grafana/provisioning/dashboards/dashboards.yml` | Auto-load dashboards |
| `grafana/dashboards/microservices.json` | Pre-built dashboard |

## Modified Files Summary

| File | Change |
|---|---|
| `services/*/package.json` | Add `@shared/tracing` dependency |
| `services/*/src/index.ts` | Import tracing, add `/metrics`, use pino logger |
| `services/*/src/rabbitmq/publisher.ts` | Add saga event counter |
| `docker-compose.yml` | Add jaeger, otel-collector, prometheus, grafana + env vars |

---

## Access Points (after `docker-compose up`)

| UI | URL | Purpose |
|---|---|---|
| Kong Gateway | http://localhost:8000 | API gateway |
| Grafana | http://localhost:3004 | Dashboards (admin/admin) |
| Prometheus | http://localhost:9090 | Metrics query |
| Jaeger | http://localhost:16686 | Distributed traces |
| RabbitMQ | http://localhost:15672 | Message queue (guest/guest) |

---

## Verification

1. `docker-compose up --build` — all services + observability stack starts
2. Hit any API endpoint: `curl http://localhost:8000/auth/seed-admin -X POST -H "Content-Type: application/json" -d '{"name":"Admin","email":"admin@test.com","password":"pass"}'`
3. Check Prometheus targets up: http://localhost:9090/targets — all 4 services should be green
4. Check Grafana dashboard: http://localhost:3004 — "Microservices" folder should have the pre-built dashboard
5. Check Jaeger traces: http://localhost:16686 — select any service, find traces for the API call
6. Run a full saga (create order) and verify the trace shows the full chain: order-service → inventory-service → payment-service
7. Check `/metrics` on each service: `curl http://localhost:3000/metrics`
