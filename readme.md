# Microservice CICD lab project

The app is microservice app that has these services:

- auth-service: for user authentication
- inventory-service: for item inventory
- order-service: for order management
- payment-service: for payment processing (fake this one)

each has its own db and all is drizzle with js node. the app run in k8s microservice. lets assume i have frontend static page that call api to k8s kong gateway 

## Phase 1:
docker compose locally

### Data schema:
**(inventory-service)**

item:
- id
- name
- stock
- price
- created_at

**(order-service)**

order_item:
- id
- order_id (FK → orders)
- item_id
- quantity
- price_at_purchase

order:
- id
- user_id
- total_price
- status(done, ongoing, failed)
- created_at

**(payment-service)**

payment:
- id
- order_id (unique, one to one)
- price
- status(paid, failed)
- created_at

**(auth-service)**

user:
- id
- name
- email
- password_hash
- role(user, admin)
- coin
- created_at

### Folder structure:

/kong (gateway routing config)
/services
    /auth-service (user auth, internal endpoints)
    /inventory-service (items CRUD, stock reservation)
    /order-service (orders CRUD, saga orchestrator)
    /payment-service (payment processing, saga participant)
/shared/packages
    /auth (JWT, middleware)
    /events (saga event constants + types)
    /tracing (OpenTelemetry, Prometheus metrics, pino logger)

### Routes

**Auth**

POST /signup
- user sign up (user default has 1000 coins)

POST /login
- user login

GET /me (require auth)
- get current user

POST /logout
- user logout

POST /seed-admin
- admin seed user(script)

GET /users/:id (internal)
- get user by id (used by payment-service)

PATCH /users/:id/coins (internal)
- update user coins (used by payment-service)

**Inventory**

GET /items (require auth)
- list inventory

POST /items (admin only)
- create item

PATCH /items/:id/stock (require auth)
- update the stock (for queue to consume and update the stock)

**Order**

GET /orders (require auth)
- list current user's orders

GET /orders/:id (require auth)
- get single order with items

POST /orders (require auth)
- create order (saga start)

**Payment**

GET /payments (require auth)
- list payments

POST /payments (require auth)
- manual payment (for testing)

**rabbitmq event**

ORDER_CREATED: "order.created"
ORDER_FAILED: "order.failed" (compensation — triggers stock rollback)
INVENTORY_RESERVED: "inventory.reserved"
INVENTORY_FAILED: "inventory.failed"
PAYMENT_COMPLETED: "payment.completed"
PAYMENT_FAILED: "payment.failed"

## Phase 2: Observability (OpenTelemetry + Prometheus + Grafana)

Add distributed tracing, metrics collection, and dashboards to all 4 services.

### Architecture

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

### What's Added

**Tracing (OpenTelemetry)**
- Shared `@shared/tracing` package — initializes OTel SDK with auto-instrumentation for HTTP, Express, PostgreSQL (pg), RabbitMQ (amqplib), and inter-service fetch
- Each service imports `@shared/tracing` as the first line of `index.ts`
- Traces exported via OTLP to OTel Collector → Jaeger
- Full saga trace visible: order-service → inventory-service → payment-service

**Metrics (Prometheus)**
- Each service exposes `GET /metrics` using `prom-client`
- Default Node.js metrics: GC, event loop lag, memory usage, active handles
- Custom metrics:
  - `http_request_duration_seconds` (histogram) — request latency by method, route, status
  - `saga_events_total` (counter) — RabbitMQ events published per service
- Prometheus scrapes all 4 services every 15 seconds

**Dashboards (Grafana)**
- Auto-provisioned Prometheus datasource
- Pre-built dashboard with panels:
  - Request rate (QPS) per service
  - Request latency p50/p95/p99 per service
  - Error rate (4xx/5xx) per service
  - Saga event flow rate
  - Active connections

**Traces UI (Jaeger)**
- Search traces by service, operation, duration
- View full request lifecycle across services
- See RabbitMQ message spans linked to HTTP spans via trace context propagation
- **How to use:** In Jaeger UI, select an app service (`auth-service`, `inventory-service`, `order-service`, `payment-service`) from the Service dropdown — NOT `jaeger-all-in-one`. Make an API call first, then click "Find Traces".

### New Dependencies (per service)

```
@opentelemetry/sdk-node
@opentelemetry/auto-instrumentations-node
@opentelemetry/exporter-trace-otlp-http
@opentelemetry/resources
@opentelemetry/semantic-conventions
prom-client
pino
```

### Access Points

| UI | URL | Credentials |
|---|---|---|
| Kong Gateway | http://localhost:8000 | — |
| Grafana | http://localhost:3004 | admin / admin |
| Prometheus | http://localhost:9090 | — |
| Jaeger | http://localhost:16686 | — |
| RabbitMQ | http://localhost:15672 | guest / guest |

### New Files

```
shared/packages/tracing/       # @shared/tracing package
  package.json
  index.ts                     # OTel SDK init
  metrics.ts                   # prom-client setup
  logger.ts                    # pino logger with trace correlation

otel/
  otel-config.yml              # OTel Collector config

prometheus/
  prometheus.yml               # Scrape targets

grafana/
  provisioning/
    datasources/prometheus.yml # Auto-configure datasource
    dashboards/dashboards.yml  # Auto-load dashboards
  dashboards/
    microservices.json         # Pre-built dashboard
```

### Run

```bash
docker-compose up --build
```

Then open Grafana at http://localhost:3004 and explore the "Microservices" dashboard.

## Phase 3: Kubernetes CI/CD (Azure AKS + Jenkins + ArgoCD)

Deploy the microservices to Azure AKS using a two-repo GitOps workflow.

### Architecture

```
app-k8s (this repo)                app-k8s-manifests (separate repo)
┌──────────────────────┐          ┌──────────────────────────┐
│ services/            │          │ k8s/base/                │
│ shared/              │          │ k8s/overlays/staging/    │
│ Jenkinsfile          │          │ k8s/overlays/prod/       │
│ docker-compose.yml   │          │ argocd/                  │
└─────────┬────────────┘          └────────────┬─────────────┘
          │                                    ▲
          │ Jenkins builds                     │ ArgoCD syncs
          │ & pushes images                    │ to K8s
          ▼                                    │
    ┌───────────┐   push images   ┌────────────┘
    │  Jenkins   │───────────────→│ DockerHub
    │            │  update tags   │
    │            │───────────────→ manifest repo
    └───────────┘
```

### Branch Strategy

| Branch | Jenkins | ArgoCD | Target |
|---|---|---|---|
| `develop` | Builds + pushes images | Auto-sync | staging namespace |
| `main` | Builds + pushes images | Manual sync | prod namespace |

### What's in This Repo

- `Jenkinsfile` — CI pipeline (checkout → build → push → update manifests)
- `jenkins/pod-template.yaml` — ephemeral build agent (node + docker + kustomize)
- `plan-phase-3.md` — full implementation plan and configuration guide

### What's in the Manifest Repo

- `k8s/base/` — Kustomize base (4 services, 4 DBs, Kong, RabbitMQ, OTel, Jaeger, Prometheus, Grafana, migration jobs)
- `k8s/overlays/staging/` and `prod/` — environment-specific image tags and namespaces
- `argocd/` — ArgoCD Application manifests

### Configuration

See `plan-phase-3.md` for:
- GitHub access tokens (Jenkins + ArgoCD)
- DockerHub setup
- K8s Secrets creation (`kubectl create secret`)
- Jenkins credentials
- ArgoCD repo configuration
- Branch protection rules