# Observability Architecture

## Overview

The application uses the **three pillars of observability**: traces, metrics, and logs — all fully instrumented and centrally collected.

```
                    +-------------+
                    |   Grafana   |  <-- Visualize everything
                    +------+------+
                           | queries
              +------------+------------+
              |            |            |
        +-----+-----+ +---+----+ +-----+-----+
        | Prometheus  | | Jaeger | |    Loki    |
        |  (metrics)  | |(traces)| |   (logs)   |
        +-----+------+ +---+----+ +-----+------+
              |            |            |
              | scrape     | OTLP       | otlphttp
              | /metrics   | gRPC       | /otlp
        +-----+------------+------------+------+
        |         OTel Collector (:4318)       |
        +-----+-------------------------------+
              | OTLP
   +----------+----------+----------+
   |          |          |          |
auth-svc  order-svc  inv-svc  pay-svc
   |          |          |          |
   +----------+----------+----------+
     pino logs -> stdout + OTel Collector -> Loki
```

---

## 1. OpenTelemetry Tracing — "What happened and where?"

### How It Starts

Each service's `index.ts` line 1 runs `import "@shared/tracing"`, which executes `shared/packages/tracing/index.ts`. This initializes the OTel SDK before any other application code runs.

### What Gets Traced Automatically

Zero code changes needed per-request. Auto-instrumentations capture:

- **Incoming HTTP requests** — method, path, status, duration (Express instrumentation)
- **Outgoing HTTP calls** — like payment-service calling auth-service (fetch instrumentation)
- **Database queries** — the actual SQL, duration (pg instrumentation)
- **RabbitMQ messages** — publish and consume (amqplib instrumentation)

### How Traces Propagate Across Services

The saga spans multiple services connected by RabbitMQ. OpenTelemetry propagates context through message headers:

1. When order-service publishes `order.created`, the OTel SDK injects the current `trace_id` and `span_id` into the RabbitMQ message headers via `propagation.inject()`
2. When inventory-service consumes that message, it extracts the context via `propagation.extract()` and continues the same trace
3. This means a single order creates **one trace that spans the entire saga**:
   - order-service HTTP request -> RabbitMQ publish -> inventory-service consume -> RabbitMQ publish -> payment-service consume -> HTTP call to auth-service

### Where Traces Go

```
Service (OTLP HTTP :4318) -> OTel Collector -> Jaeger (OTLP gRPC :4317)
```

### Why This Matters

In Jaeger, searching for a `trace_id` shows the entire saga as a waterfall — every HTTP call, every DB query, every RabbitMQ message, with precise timing. If an order fails, the trace shows exactly which step was slow or errored.

---

## 2. Prometheus Metrics — "How is the system performing over time?"

### How Metrics Are Collected

Each service exposes a `/metrics` endpoint via `prom-client`. Prometheus scrapes these endpoints every 15 seconds.

**Service wiring (same pattern in all 4 services):**

```typescript
import { register, metricsMiddleware } from "@shared/tracing/metrics";

app.use(metricsMiddleware);              // records latency for every request
app.get("/metrics", async (_req, res) => // exposes metrics for Prometheus
    res.end(await register.metrics())
);
```

### What Metrics Exist

| Metric | Type | Source | What It Tells You |
|--------|------|--------|-------------------|
| `http_request_duration_seconds` | Histogram | `metricsMiddleware` | Per-request latency, broken down by method/route/status_code |
| `saga_events_total` | Counter | `publishEvent()` in each service's rabbitmq publisher | How many saga events each service has published, by event name |
| `nodejs_*` (default metrics) | Various | `collectDefaultMetrics()` | GC pauses, event loop lag, memory usage, active handles |

### Where the Histogram Gets Recorded

The `metricsMiddleware` starts a timer on request start, and on `res.finish` records the duration with labels `{method, route, status_code}`.

### Where the Saga Counter Gets Recorded

Each `publishEvent()` call increments `saga_events_total` with labels `{event_name, service}`.

### Where Metrics Go

```
Service /metrics -> Prometheus scrapes (15s) -> Grafana queries
```

---

## 3. Logging — "What were the details?"

### How It Works

Each service creates a pino logger via `createLogger("service-name")` from `@shared/tracing/logger`.

The logger automatically injects `trace_id` and `span_id` from the active OpenTelemetry span into every log entry. This means log lines can be correlated with traces in Jaeger.

### Current State

Logs are collected centrally via **Loki**. Each service sends logs two ways:
1. **stdout** — for `docker logs` / `kubectl logs`
2. **OTel Collector** — via `pino-opentelemetry-transport`, exported to Loki over OTLP HTTP

To view logs: Grafana → Explore → Loki datasource. Use LogQL queries like `{service_name="auth-service"}`.

### Log Format (JSON)

```json
{
  "level": 30,
  "time": 1715000000000,
  "msg": "Order created",
  "trace_id": "abc123...",
  "span_id": "def456...",
  "orderId": 42
}
```

### Trace-Log Correlation

The Loki datasource in Grafana has derived fields configured:
- `trace_id` extracted from log entries via regex `trace_id":"([a-f0-9]+)"`
- Clickable **"View in Jaeger"** link opens the corresponding trace directly

This means from any log entry in Loki, you can jump to the full trace in Jaeger with one click.

---

## 4. Grafana Dashboard — "What does it all mean?"

The `microservices.json` dashboard has 8 panels across 4 rows.

### Row 1 — Traffic & Latency

**Request Rate (QPS) per Service**
- PromQL: `sum(rate(http_request_duration_seconds_count[1m])) by (job)`
- Shows requests/second for each service over time
- Use case: See traffic patterns, spot if one service is overloaded, detect if traffic drops (service is down)

**Request Latency p50 / p95 / p99**
- PromQL: `histogram_quantile(0.5/0.95/0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))`
- Shows median, 95th, and 99th percentile response times
- Use case: p50 shows normal performance. p95/p99 catch tail latency — if p99 spikes but p50 is fine, a few requests are very slow (cold DB connection, retry, etc.)

### Row 2 — Errors & Business Events

**Error Rate (5xx) per Service**
- PromQL: `sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[1m])) by (job)`
- Shows 5xx errors per service over time
- Use case: The most important alert signal. If this goes up, something is broken.

**Saga Events Published**
- PromQL: `sum(rate(saga_events_total[1m])) by (event_name, service)`
- Bar chart showing event flow through the saga
- Use case: Business-level monitoring. If `order.created` is high but `payment.completed` is zero, something broke in the saga. If `inventory.failed` spikes, stock issues are causing order failures.

### Row 3 — System Health

**Active Connections**
- PromQL: `sum(nodejs_active_handles_total) by (job)`
- Gauge showing open handles (DB connections, sockets, timers)
- Use case: Detects connection leaks. If active handles grow forever, something isn't cleaning up.

**Memory Usage per Service**
- PromQL: `process_resident_memory_bytes`
- Memory over time per service
- Use case: Detects memory leaks. If memory grows linearly and never drops, there's a problem.

### Row 4 — Distribution & Performance

**HTTP Status Code Distribution**
- PromQL: `sum(increase(http_request_duration_seconds_count[1h])) by (status_code)`
- Pie chart of all status codes in the last hour
- Use case: Quick visual — if red (5xx) or orange (4xx) slices grow, something is wrong.

**Event Loop Lag**
- PromQL: `nodejs_eventloop_lag_seconds`
- How far behind the Node.js event loop is
- Use case: Node.js is single-threaded. If lag grows, the service is overloaded — requests queue up. This is the earliest signal of capacity problems.

---

## 5. How the Three Pillars Work Together

| Pillar | Answers | Tool |
|--------|---------|------|
| **Traces** | "What happened to THIS specific request?" | Jaeger |
| **Metrics** | "How is the system performing OVER TIME?" | Prometheus + Grafana |
| **Logs** | "What were the DETAILS at this point?" | Loki (via Grafana) |

**Incident debugging flow:**

1. **Grafana dashboard** shows latency p99 spiked at 14:32 -> you know **WHEN**
2. **Jaeger trace** for a slow request shows the DB query in order-service took 3 seconds -> you know **WHERE**
3. **Grafana → Loki** logs with matching `trace_id` show the actual error message or query details -> you know **WHY**

Logs include `trace_id` and `span_id`, so Loki datasource derived fields link directly to Jaeger traces.

---

## 6. Configuration Files

| File | Purpose |
|------|---------|
| `shared/packages/tracing/index.ts` | OTel SDK initialization, auto-instrumentations |
| `shared/packages/tracing/metrics.ts` | Prometheus metrics definitions and middleware |
| `shared/packages/tracing/logger.ts` | Pino logger with trace context injection + OTel transport |
| `otel/otel-config.yml` | OTel Collector config (receives OTLP, exports to Jaeger + Loki) |
| `loki/loki-config.yml` | Loki storage config (filesystem, TSDB schema) |
| `prometheus/prometheus.yml` | Prometheus scrape targets (4 services) |
| `grafana/provisioning/datasources/prometheus.yml` | Prometheus datasource config |
| `grafana/provisioning/datasources/jaeger.yml` | Jaeger datasource config (uid: jaeger) |
| `grafana/provisioning/datasources/loki.yml` | Loki datasource config with trace_id derived fields |
| `grafana/dashboards/microservices.json` | Pre-built dashboard with 8 panels |
| `grafana/provisioning/dashboards/dashboards.yml` | Dashboard auto-provisioning config |
