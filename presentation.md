# Microservices E-Commerce Platform — Technical Overview

## 1. JWT (JSON Web Token) Authentication

### What is JWT?

A JWT is a digitally signed token that proves a user's identity. It's a string with 3 parts separated by dots:

```
eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjEsInJvbGUiOiJ1c2VyIn0.signature
     Header              Payload                        Signature
```

- **Header** — algorithm used (HS256)
- **Payload** — user data (userId, role, email)
- **Signature** — HMAC-SHA256 hash of header+payload using a secret key

### How It Works

```
Client                          Server
  │                                │
  │  POST /auth/login              │
  │  {email, password}             │
  │ ──────────────────────────────→│
  │                                │ 1. Verify credentials against DB
  │                                │ 2. Generate JWT with userId + role
  │  ←────────────────────────────│ 3. Return JWT
  │  {token: "eyJ..."}            │
  │                                │
  │  GET /orders                   │
  │  Authorization: Bearer eyJ...  │
  │ ──────────────────────────────→│
  │                                │ 4. Verify signature with secret key
  │                                │ 5. Extract userId from payload
  │  ←────────────────────────────│ 6. Return user's orders
  │  [{order1}, {order2}]         │
```

### Why JWT?

- **Stateless** — no session stored on server. The token itself carries the user identity. This is critical in microservices because any service can verify the token without calling a central auth server.
- **Cross-service** — when the Order Service needs to check user coins, it reads the userId from the JWT and calls the Auth Service. No shared session store needed.
- **Signed, not encrypted** — the signature prevents tampering. If someone modifies the payload, the signature won't match and the server rejects it.

### In This App

- **Auth Service** issues JWTs on login/signup
- All other services (Inventory, Order, Payment) receive the JWT in the `Authorization` header
- The `userId` from the JWT payload is used to look up user data (coins, orders, payments)
- Secret key: `JWT_SECRET` environment variable (same across all services)

---

## 2. RabbitMQ — Message Queue & Event Flow

### What is RabbitMQ?

RabbitMQ is a message broker. Instead of services calling each other directly (synchronous HTTP), they publish events to a queue. Other services consume those events asynchronously.

```
Direct Call (synchronous):          Message Queue (asynchronous):
Order → Inventory                   Order → [Queue] → Inventory
       (blocks, waits for reply)           (fire and forget)
```

### Why a Message Queue?

- **Decoupling** — Order Service doesn't need to know about Inventory Service's API. It just publishes an event.
- **Resilience** — if Inventory Service is down, messages wait in the queue and get processed when it comes back.
- **Saga pattern** — the order flow requires coordination across 3 services. RabbitMQ carries the saga events between them.

### Event Flow — Happy Path (Order Succeeds)

```
Order Service                    RabbitMQ                    Inventory Service    Payment Service
     │                              │                              │                    │
     │  1. Create order (pending)   │                              │                    │
     │                              │                              │                    │
     │  2. Publish                  │                              │                    │
     │     order.created ──────────→│                              │                    │
     │                              │  3. Consume order.created    │                    │
     │                              │ ────────────────────────────→│                    │
     │                              │                              │                    │
     │                              │  4. Check stock, deduct      │                    │
     │                              │     Publish                  │                    │
     │                              │     stock.reserved ──────────────────────────────→│
     │                              │                              │                    │
     │                              │                              │  5. Deduct coins   │
     │                              │                              │     Publish        │
     │                              │←─────────────────────────────────────────────────│
     │                              │     payment.completed        │                    │
     │                              │                              │                    │
     │  6. Consume                  │                              │                    │
     │     payment.completed        │                              │                    │
     │ ←────────────────────────────│                              │                    │
     │                              │                              │                    │
     │  7. Update order → "done"    │                              │                    │
```

### Event Flow — Failure (Insufficient Coins)

```
Order Service              RabbitMQ              Inventory Service       Payment Service
     │                        │                        │                      │
     │  order.created ───────→│──→ [deduct stock]      │                      │
     │                        │    stock.reserved ──────────────────────────→│
     │                        │                        │    [not enough coins]│
     │                        │                        │    payment.failed ───│
     │                        │←─────────────────────────────────────────────│
     │  payment.failed ←──────│                        │                      │
     │                        │                        │                      │
     │  order.failed          │                        │                      │
     │  order.cancelled ─────→│──→ [restore stock]     │                      │
```

### Queues Used

| Queue | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `order.created` | Order Service | Inventory Service | Trigger stock check & deduction |
| `stock.reserved` | Inventory Service | Payment Service | Stock confirmed, process payment |
| `stock.rejected` | Inventory Service | Order Service | Not enough stock, fail order |
| `payment.completed` | Payment Service | Order Service | Payment done, complete order |
| `payment.failed` | Payment Service | Order Service | Payment failed, trigger rollback |
| `order.cancelled` | Order Service | Inventory Service | Restore stock (compensation) |

### In This App

- All services connect to `RABBITMQ_URL` (e.g., `amqp://rabbitmq:5672`)
- Each service has a dedicated consumer listening on its queue
- The Order Service orchestrates the saga — it tracks the order status and handles compensations

---

## 3. Observability — Traces, Metrics, Logs

### Architecture

```
App Services ──OTLP──→ OTel Collector ──→ Jaeger  (traces)
                                   ──→ Prometheus (metrics)
                                   ──→ Loki       (logs)
                                               │
                                               ▼
                                           Grafana
                                      (dashboards + explore)
```

### 3a. Distributed Tracing (OpenTelemetry + Jaeger)

**What it does:** Tracks a request as it flows through multiple services.

When a user places an order, the request goes: Kong → Order Service → (RabbitMQ) → Inventory Service → Payment Service. A **trace** records every hop with timing.

```
Trace: abc123
├── Order Service: POST /orders (250ms)
│   ├── Create order in DB (15ms)
│   └── Publish order.created to RabbitMQ (3ms)
├── Inventory Service: consume order.created (45ms)
│   ├── Check stock (8ms)
│   ├── Deduct stock (12ms)
│   └── Publish stock.reserved (2ms)
└── Payment Service: consume stock.reserved (30ms)
    ├── Deduct coins (10ms)
    └── Publish payment.completed (2ms)
```

**How it works:**
1. Each service has the `@opentelemetry/sdk-node` package
2. On every HTTP request or RabbitMQ message, the SDK creates a **span** (a timed operation)
3. Spans are linked by a **trace ID** that propagates through headers (`traceparent`)
4. All spans are sent via OTLP to the **OTel Collector**
5. Collector exports traces to **Jaeger** for visualization

**Justification:** Without tracing, debugging a failed order across 4 services means checking 4 separate log files. With tracing, you see the entire request flow in one view — where it failed, how long each step took.

### 3b. Metrics (Prometheus)

**What it does:** Collects numerical measurements over time.

Each service exposes a `/metrics` endpoint with:
- `http_request_duration_seconds` — request latency histogram
- `http_requests_total` — request count by status code
- Custom business metrics (orders created, payments processed)

**How it works:**
1. Services use `prom-client` to expose metrics on `/metrics`
2. **Prometheus** scrapes (pulls) these endpoints every 15 seconds
3. Metrics are stored in Prometheus's time-series database
4. **Grafana** queries Prometheus to build dashboards

**Justification:** Metrics answer "how is the system performing?" — request rates, error rates, latency percentiles. Essential for detecting issues before users report them.

### 3c. Logs (Loki)

**What it does:** Centralized log aggregation from all services.

**How it works:**
1. Services use `winston` with an OTLP transport to send logs to the OTel Collector
2. Collector forwards logs to **Loki**
3. Loki indexes labels (service name, log level) but not full text (cheap storage)
4. **Grafana Explore** queries Loki with LogQL

**Justification:** Logs answer "what happened?" — error messages, stack traces, business logic decisions. Loki is lightweight compared to Elasticsearch and integrates natively with Grafana.

### 3d. Grafana — The Unified View

Grafana connects to all 3 backends:
- **Prometheus datasource** — service health dashboards (latency, error rate, throughput)
- **Jaeger datasource** — trace waterfall views, search by trace ID
- **Loki datasource** — log search with trace ID linking (click a log → jump to the trace in Jaeger)

**Derived fields** in the Loki datasource automatically parse `trace_id` from log entries and create clickable links to Jaeger.

### How It All Connects

A single user request generates:
- **Traces** — the full request path across services (Jaeger)
- **Metrics** — latency and error counters per endpoint (Prometheus)
- **Logs** — detailed text output from each service (Loki)

All three share the same **trace ID**, so you can go from a metric spike → to the slow trace → to the error log, all in Grafana.

---

## 4. ArgoCD & GitOps with Kustomize

### GitOps Principle

**Git is the single source of truth.** The desired state of the Kubernetes cluster lives in a Git repository. ArgoCD watches that repo and automatically applies changes to the cluster.

```
Developer → Git Push → ArgoCD detects change → kubectl apply → Cluster matches Git
```

No manual `kubectl apply`. No SSH into clusters. Everything is declarative and version-controlled.

### Two-Repo Architecture

```
app-k8s (source code)                app-k8s-manifests (GitOps)
┌──────────────────┐                 ┌──────────────────────┐
│ Jenkinsfile      │                 │ k8s/base/            │ ← shared resources
│ services/*/      │                 │ k8s/overlays/staging/│ ← staging patches
│ Dockerfile       │                 │ k8s/overlays/prod/   │ ← prod patches
└──────┬───────────┘                 │ argocd/              │ ← ArgoCD apps
       │                             └──────────┬───────────┘
       ▼                                        │
   DockerHub                                    ▼
   (images) ──────────────────→ AKS Cluster ←── ArgoCD
```

**Why two repos?**
- `app-k8s` — developers work here (code, tests, Dockerfiles)
- `app-k8s-manifests` — infrastructure team manages here (K8s resources, scaling, config)
- Separation of concerns: developers don't need to know K8s, infra team doesn't touch app code

### Kustomize — Layered Configuration

Kustomize lets you define a **base** configuration and **overlays** that patch it for different environments.

```
k8s/
├── base/                          # Shared resources
│   ├── kustomization.yaml         # Lists all resources
│   ├── auth-service/
│   │   ├── deployment.yaml        # image: auth-service:latest
│   │   ├── service.yaml
│   │   └── configmap.yaml
│   ├── order-service/
│   ├── inventory-service/
│   ├── payment-service/
│   ├── auth-db/
│   ├── order-db/
│   ├── rabbitmq/
│   ├── kong/
│   ├── grafana/
│   └── ...
│
├── overlays/
│   ├── staging/                   # Staging-specific patches
│   │   ├── kustomization.yaml     # References ../../base + patches
│   │   ├── kong-patch.yaml        # Service URLs → .staging.svc.cluster.local
│   │   └── ...
│   └── prod/                      # Prod-specific patches
│       ├── kustomization.yaml
│       ├── kong-patch.yaml        # Service URLs → .prod.svc.cluster.local
│       └── ...
```

**Base** defines what the app looks like generically:
```yaml
# k8s/base/kustomization.yaml
resources:
  - auth-service/deployment.yaml
  - auth-service/service.yaml
  - order-service/deployment.yaml
  - ...
images:
  - name: auth-service
    newName: hungnv2511/auth-service
    newTag: "latest"              # ← overridden by overlay
```

**Staging overlay** patches the base:
```yaml
# k8s/overlays/staging/kustomization.yaml
resources:
  - ../../base                     # Include everything from base
namespace: staging                 # Deploy to staging namespace
images:
  - name: auth-service
    newTag: "47ca2ef"             # Pin to specific commit SHA
patches:
  - path: kong-patch.yaml         # Override Kong service URLs
  - target:
      kind: Deployment
    patch: |                       # Add tolerations for node pool
      - op: add
        path: /spec/template/spec/tolerations
        value: [...]
```

**How Kustomize merges:** Base defines the full resource → overlay patches are applied on top → final YAML is what gets deployed. No templating, no variables — just strategic merge patches.

### ArgoCD Application CRDs

ArgoCD uses `Application` custom resources to define what to deploy:

```yaml
# argocd/staging-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: app-staging
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/FSA-Lab/app-k8s-manifests.git
    targetRevision: develop          # Watch this branch
    path: k8s/overlays/staging       # Build this kustomize overlay
  destination:
    namespace: staging               # Deploy to this namespace
  syncPolicy:
    automated:
      prune: true                    # Delete resources removed from Git
      selfHeal: true                 # Revert manual changes in cluster
```

### The Full Deploy Flow

```
1. Developer pushes to `develop` branch in app-k8s
          │
          ▼
2. Jenkins webhook triggers build
   - Builds 4 Docker images (auth, inventory, order, payment)
   - Pushes to DockerHub with git SHA tag (e.g., :47ca2ef)
   - Clones app-k8s-manifests repo
   - Updates image tags in k8s/overlays/staging/kustomization.yaml
   - Commits and pushes to `develop` branch
          │
          ▼
3. ArgoCD detects change in app-k8s-manifests develop branch
   - Runs `kustomize build k8s/overlays/staging`
   - Compares desired state (Git) vs live state (cluster)
   - Applies differences (new image tags → rolling update)
          │
          ▼
4. Staging namespace updated
   - Migration Jobs run (DB schema changes)
   - App pods restart with new images
   - ArgoCD status → Synced + Healthy
```

### Staging vs Prod

| | Staging | Prod |
|---|---|---|
| **Branch** | `develop` | `main` |
| **Sync** | Automatic (on every push) | Manual (click Sync in ArgoCD UI) |
| **Image tag** | Latest commit SHA | Same, but promoted via PR |
| **Namespace** | `staging` | `prod` |

**Promotion flow:** Merge `develop` → `main` via PR. Jenkins builds on `main` push. ArgoCD shows `app-prod` as out-of-sync. Someone manually clicks Sync to approve the production deployment.
