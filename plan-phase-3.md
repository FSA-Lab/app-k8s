# Phase 3: Kubernetes + CI/CD on Azure AKS

## Overview

Deploy the microservice app to Azure AKS with Jenkins CI and ArgoCD CD using two repos.

### Status

| Phase | Description | Status |
|---|---|---|
| A1 | Create manifest repo + branches | DONE |
| A2 | GitHub PATs | MANUAL |
| A3 | DockerHub account + token | MANUAL |
| A4 | Deploy Jenkins to AKS | MANUAL |
| A5 | Deploy ArgoCD to AKS | MANUAL |
| A6 | Deploy SonarQube to AKS | MANUAL |
| B | Kustomize manifests (base + overlays + patches) | DONE |
| C | App repo changes (Dockerfiles, Jenkinsfile, pod template, branches) | DONE |
| D | Infrastructure deployment (secrets, namespaces, infra resources) | MANUAL |
| E | End-to-end test | MANUAL |

**What's done:** All code and configuration. Both repos have `main` and `develop` branches pushed.
**What's left:** Manual setup — credentials, infrastructure deployment, ArgoCD configuration.

---

## Two-Repo Architecture

```
app-k8s (this repo)              manifest repo (separate)
┌─────────────────────┐          ┌─────────────────────────┐
│ services/           │          │ k8s/                    │
│   └── */Dockerfile  │          │   base/                 │
│ shared/             │          │   overlays/staging/     │
│ Jenkinsfile         │          │   overlays/prod/        │
│ docker-compose.yml  │          │ argocd/                 │
└────────┬────────────┘          └────────────┬────────────┘
         │                                    ▲
         │ Jenkins reads                      │ ArgoCD reads
         │                                    │
         ▼                                    │
   ┌───────────┐    push images    ┌─────────┴──┐
   │  Jenkins   │──────────────────→│  DockerHub  │
   │   (CI)     │                   └────────────┘
   │            │    push updated
   │            │    image tags
   │            │──────────────────→ manifest repo
   └───────────┘
```

**Why two repos?**
- No infinite loop: Jenkins pushes to manifest repo, not app repo
- Clean separation: source code vs infrastructure config
- Standard GitOps pattern

---

## Branch Strategy

```
app-k8s repo:
  feature/*  → no CI trigger
  develop    → Jenkins builds → pushes to DockerHub + updates manifest repo (staging overlay)
  main       → Jenkins builds → pushes to DockerHub + updates manifest repo (prod overlay)

manifest repo:
  develop    → ArgoCD watches → auto-syncs to staging namespace
  main       → ArgoCD watches → manual sync to prod namespace
```

Both repos have `develop` and `main` branches. They stay in sync:
- App `develop` → Jenkins → manifest `develop` → ArgoCD → staging
- App `main` → Jenkins → manifest `main` → ArgoCD → prod

---

## K8s Cluster Layout

```
┌─────────────────────────────────────────────────────────┐
│  Azure AKS Cluster                                       │
│                                                          │
│  infra namespace (shared)                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ auth-db (Postgres, ClusterIP:5432)               │    │
│  │ inventory-db (Postgres, ClusterIP:5432)          │    │
│  │ order-db (Postgres, ClusterIP:5432)              │    │
│  │ payment-db (Postgres, ClusterIP:5432)            │    │
│  │ rabbitmq (ClusterIP:5672)                        │    │
│  │ kong (LoadBalancer:8000)                         │    │
│  │ otel-collector (ClusterIP:4318)                  │    │
│  │ jaeger (NodePort:16686)                          │    │
│  │ prometheus (NodePort:9090)                       │    │
│  │ grafana (NodePort:3004)                          │    │
│  └─────────────────────────────────────────────────┘    │
│           ▲                           ▲                  │
│           │                           │                  │
│  ┌────────┴──────────┐      ┌────────┴──────────┐      │
│  │ staging namespace  │      │ prod namespace    │      │
│  │                    │      │                   │      │
│  │ auth-service       │      │ auth-service      │      │
│  │ inventory-service  │      │ inventory-service │      │
│  │ order-service      │      │ order-service     │      │
│  │ payment-service    │      │ payment-service   │      │
│  │ migration jobs (4) │      │ migration jobs (4)│      │
│  └───────────────────┘      └───────────────────┘      │
│                                                          │
│  jenkins namespace                                       │
│  ┌─────────────────────────────────────────────────┐    │
│  │ jenkins controller                               │    │
│  │ ephemeral build agent pods (created per build)   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  argocd namespace                                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │ argocd server + repo-server + application-controller│ │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Networking

| Component | Service Type | Port | Why |
|---|---|---|---|
| Kong | LoadBalancer | 8000 | External access, Azure LB with public IP |
| App services (×4) | ClusterIP | 3000 | Internal only, Kong routes to them |
| DBs (×4) | ClusterIP | 5432 | Internal only |
| RabbitMQ | ClusterIP | 5672 | Internal only |
| OTel Collector | ClusterIP | 4318 | Internal only |
| Jaeger | NodePort | 16686 | Debug UI, access via node IP |
| Prometheus | NodePort | 9090 | Debug UI |
| Grafana | NodePort | 3004 | Dashboard UI |

---

## Repo 1: app-k8s (this repo) — Changes

### New files to create

```
app-k8s/
├── Jenkinsfile                    # CI pipeline definition
└── jenkins/
    └── pod-template.yaml          # Ephemeral build agent pod spec
```

### Jenkinsfile (actual implementation)

See `Jenkinsfile` in this repo. Key features:
- **Init stage** — detects which services changed, sets `BUILD_*` flags for conditional builds
- **Install** — `npm ci` (clean install, respects lockfile)
- **SonarQube** — via `npx sonar-scanner` in node container
- **Docker Build & Push** — parallel per-service, conditional on `BUILD_*` flags, pushes to DockerHub with git SHORT_SHA tag
- **Update Manifest Repo** — clones manifest repo, runs `kustomize edit set image` per service, commits and pushes
- **Post block** — failure logging + docker image cleanup

### Jenkins pod template (jenkins/pod-template.yaml)

See `jenkins/pod-template.yaml` in this repo. Three containers:
- **node** (node:24-slim) — install deps, run sonar-scanner
- **docker** (docker:24-dind) — build and push images, privileged with host docker socket
- **kustomize** (kustomize/kustomize:latest) — update image tags in manifest repo

### Dockerfile fixes

`COPY package-lock.json* ./` added to all four service Dockerfiles (auth, inventory, order, payment).

---

## Repo 2: app-k8s-manifests (new repo) — Full Structure

```
app-k8s-manifests/
├── k8s/
│   ├── base/
│   │   ├── kustomization.yaml
│   │   │
│   │   ├── auth-service/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   ├── inventory-service/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   ├── order-service/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   ├── payment-service/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   │
│   │   ├── auth-db/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── pvc.yaml
│   │   ├── inventory-db/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── pvc.yaml
│   │   ├── order-db/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── pvc.yaml
│   │   ├── payment-db/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── pvc.yaml
│   │   │
│   │   ├── rabbitmq/
│   │   │   ├── deployment.yaml
│   │   │   └── service.yaml
│   │   │
│   │   ├── kong/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   │
│   │   ├── otel-collector/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   │
│   │   ├── jaeger/
│   │   │   ├── deployment.yaml
│   │   │   └── service.yaml
│   │   │
│   │   ├── prometheus/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   │
│   │   ├── grafana/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   │
│   │   └── migrations/
│   │       ├── auth-migration.yaml
│   │       ├── inventory-migration.yaml
│   │       ├── order-migration.yaml
│   │       └── payment-migration.yaml
│   │
│   └── overlays/
│       ├── staging/
│       │   ├── kustomization.yaml
│       │   ├── kong-patch.yaml           # Kong URLs → staging.svc.cluster.local
│       │   ├── prometheus-patch.yaml     # Prometheus scrape targets → staging
│       │   └── payment-service-patch.yaml # AUTH_SERVICE_URL → staging
│       └── prod/
│           ├── kustomization.yaml
│           ├── kong-patch.yaml           # Kong URLs → prod.svc.cluster.local
│           ├── prometheus-patch.yaml     # Prometheus scrape targets → prod
│           └── payment-service-patch.yaml # AUTH_SERVICE_URL → prod
│
└── argocd/
    ├── staging-app.yaml
    └── prod-app.yaml
```

---

## Secrets and Environment Variables

### Environment Variables Per Service

**App services (auth, inventory, order, payment) — common:**

| Variable | Source | Example Value |
|---|---|---|
| `DATABASE_URL` | Secret | `postgres://root:password@auth-db.infra.svc.cluster.local:5432/auth` |
| `RABBITMQ_URL` | Secret | `amqp://rabbitmq.infra.svc.cluster.local:5672` |
| `JWT_SECRET` | Secret | `your-jwt-secret-here` |
| `OTEL_SERVICE_NAME` | ConfigMap | `auth-service` (varies per service) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ConfigMap | `http://otel-collector.infra.svc.cluster.local:4318` |

**payment-service additional:**

| Variable | Source | Example Value |
|---|---|---|
| `AUTH_SERVICE_URL` | ConfigMap | `http://auth-service.staging.svc.cluster.local:3000` |

**Infrastructure:**

| Component | Variable | Source | Example |
|---|---|---|---|
| All Postgres | `POSTGRES_USER` | Secret | `root` |
| All Postgres | `POSTGRES_PASSWORD` | Secret | `postgrespassword` |
| Each Postgres | `POSTGRES_DB` | ConfigMap | `auth` / `inventory` / `order` / `payment` |
| Grafana | `GF_SECURITY_ADMIN_PASSWORD` | Secret | `admin` |

### Creating Secrets (run once per environment)

Secrets are created manually with `kubectl`. They are NOT in any Git repo.

```bash
# Auth service secret
kubectl create secret generic auth-service-secrets \
  --from-literal=DATABASE_URL='postgres://root:password@auth-db.infra.svc.cluster.local:5432/auth' \
  --from-literal=RABBITMQ_URL='amqp://rabbitmq.infra.svc.cluster.local:5672' \
  --from-literal=JWT_SECRET='your-jwt-secret' \
  -n staging

# Inventory service secret
kubectl create secret generic inventory-service-secrets \
  --from-literal=DATABASE_URL='postgres://root:password@inventory-db.infra.svc.cluster.local:5432/inventory' \
  --from-literal=RABBITMQ_URL='amqp://rabbitmq.infra.svc.cluster.local:5672' \
  --from-literal=JWT_SECRET='your-jwt-secret' \
  -n staging

# Order service secret
kubectl create secret generic order-service-secrets \
  --from-literal=DATABASE_URL='postgres://root:password@order-db.infra.svc.cluster.local:5432/order' \
  --from-literal=RABBITMQ_URL='amqp://rabbitmq.infra.svc.cluster.local:5672' \
  --from-literal=JWT_SECRET='your-jwt-secret' \
  -n staging

# Payment service secret
kubectl create secret generic payment-service-secrets \
  --from-literal=DATABASE_URL='postgres://root:password@payment-db.infra.svc.cluster.local:5432/payment' \
  --from-literal=RABBITMQ_URL='amqp://rabbitmq.infra.svc.cluster.local:5672' \
  --from-literal=JWT_SECRET='your-jwt-secret' \
  -n staging

# Postgres secrets (shared across all DBs)
kubectl create secret generic postgres-secrets \
  --from-literal=POSTGRES_USER='root' \
  --from-literal=POSTGRES_PASSWORD='postgrespassword' \
  -n infra

# Grafana secret
kubectl create secret generic grafana-secrets \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD='admin' \
  -n infra
```

Repeat for `prod` namespace with different passwords.

### ConfigMaps (in Git, non-sensitive)

ConfigMaps are committed to the manifest repo. Each app service gets:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: auth-service-config
data:
  OTEL_SERVICE_NAME: "auth-service"
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector.infra.svc.cluster.local:4318"
```

---

## GitHub Access Configuration

### Step 1: Create GitHub Personal Access Tokens

**For Jenkins (needs read + write to both repos):**

1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create token with access to:
   - `app-k8s` repo: Contents (Read/Write), Webhooks (Read)
   - `app-k8s-manifests` repo: Contents (Read/Write)
3. Copy the token

**For ArgoCD (needs read access to manifest repo only):**

1. Create another token (or use a deploy key)
2. Access to `app-k8s-manifests` repo: Contents (Read)
3. Copy the token

### Step 2: Configure Jenkins Credentials

In Jenkins UI → Manage Jenkins → Credentials → Add:

| ID | Type | Value |
|---|---|---|
| `dockerhub-creds` | Username/Password | DockerHub username + password/token |
| `manifest-repo-creds` | Secret text | GitHub PAT for manifest repo |
| `sonar-token` | Secret text | SonarQube token |
| `app-repo-creds` | Username/Password | GitHub PAT (for cloning app repo — configured in Jenkins pipeline job SCM settings, not in Jenkinsfile) |

### Step 3: Configure GitHub Webhook for Jenkins

In `app-k8s` repo → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `http://<jenkins-url>/github-webhook/` |
| Content type | `application/json` |
| Events | Just the push event |
| Branches | Select "Let me select individual branches" → `develop`, `main` |

This makes Jenkins trigger only on pushes to `develop` or `main`.

### Step 4: Configure ArgoCD Access to Manifest Repo

In ArgoCD UI (or CLI):

```bash
# Add the manifest repo
argocd repo add https://github.com/FSA-Lab/app-k8s-manifests.git \
  --username <github-username> \
  --password <github-pat>
```

Or via the ArgoCD Application YAML (the `repoURL` field), ArgoCD will prompt for credentials on first sync.

---

## DockerHub Configuration

### Step 1: Create DockerHub Account

1. Sign up at https://hub.docker.com
2. Note your username (this becomes your image prefix: `yourusername/auth-service:tag`)

### Step 2: Create Access Token (recommended over password)

1. DockerHub → Account Settings → Security → New Access Token
2. Permissions: Read, Write, Delete
3. Copy the token
4. Use this as the password in Jenkins `dockerhub-creds` credential

### Step 3: Image Naming Convention

```
yourusername/auth-service:abc1234
yourusername/inventory-service:abc1234
yourusername/order-service:abc1234
yourusername/payment-service:abc1234
```

Where `abc1234` is the git short SHA of the commit being built.

---

## ArgoCD Application Configuration

### staging-app.yaml

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: app-staging
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/FSA-Lab/app-k8s-manifests.git
    targetRevision: develop
    path: k8s/overlays/staging
  destination:
    server: https://kubernetes.default.svc
    namespace: staging
  syncPolicy:
    automated:
      prune: true       # delete resources removed from Git
      selfHeal: true    # revert manual changes in cluster
    syncOptions:
      - CreateNamespace=true
```

### prod-app.yaml

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: app-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/FSA-Lab/app-k8s-manifests.git
    targetRevision: main
    path: k8s/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: prod
  syncPolicy:
    # No automated sync — manual approval required
    syncOptions:
      - CreateNamespace=true
```

---

## Branch Protection Rules

### app-k8s repo (GitHub)

**`main` branch:**
- Require pull request reviews before merging (1 reviewer minimum)
- Require status checks to pass: Jenkins build
- Require branches to be up to date before merging
- Do not allow force pushes
- Do not allow deletions

**`develop` branch:**
- Require status checks to pass: Jenkins build
- Do not allow force pushes

### app-k8s-manifests repo (GitHub)

**`main` branch:**
- Require pull request reviews before merging
- Do not allow force pushes

**`develop` branch:**
- Do not allow force pushes
- Jenkins needs direct push access (no PR required for image tag updates)

---

## Implementation Steps

### Phase A: Setup (manual, one-time)

**A1. Create manifest repo** — DONE
- `FSA-Lab/app-k8s-manifests` created on GitHub
- `develop` and `main` branches pushed

**A2. Create GitHub PATs**
- Jenkins PAT: read/write to both repos
- ArgoCD PAT: read to manifest repo
- Store them securely

**A3. Create DockerHub account + access token**

**A4. Deploy Jenkins to AKS**
- Helm chart or YAML in `jenkins` namespace
- Install Kubernetes plugin
- Add credentials (DockerHub, GitHub PATs, SonarQube token)
- Create pipeline job pointing to `app-k8s` repo

**A5. Deploy ArgoCD to AKS**
- Install ArgoCD in `argocd` namespace
- Add manifest repo as a repository
- Apply staging and prod Application manifests

**A6. Deploy SonarQube to AKS**
- In `argocd` namespace (same as ArgoCD for simplicity; the Jenkinsfile references `sonarqube-service.argocd.svc.cluster.local:9000`)
- Create project `app-k8s`
- Generate token, add to Jenkins credentials

### Phase B: Kustomize Manifests (in manifest repo) — DONE

All manifests created and validated. Includes cross-namespace patches for Kong, Prometheus, and payment-service configmaps.

**B1. Create Kustomize base — App services**

For each service (auth, inventory, order, payment), create in `k8s/base/<service>/`:

deployment.yaml:
- Image: `<service>:latest` (placeholder, Kustomize overrides)
- Container port: 3000
- `envFrom`: configMapRef + secretRef
- Liveness probe: HTTP GET /metrics:3000
- Readiness probe: HTTP GET /metrics:3000
- Resources: requests 64Mi/100m, limits 256Mi/500m

service.yaml:
- Type: ClusterIP
- Port: 3000 → targetPort: 3000

configmap.yaml:
- OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT
- AUTH_SERVICE_URL (payment only)

**B2. Create Kustomize base — Infrastructure**

For each DB (auth-db, inventory-db, order-db, payment-db), create in `k8s/base/<db>/`:
- deployment.yaml: Postgres 15, envFrom secret + configmap (POSTGRES_DB)
- service.yaml: ClusterIP:5432
- pvc.yaml: 1Gi storage

For rabbitmq:
- deployment.yaml: rabbitmq:3-management, ports 5672/15672
- service.yaml: ClusterIP:5672

For kong:
- deployment.yaml: kong:latest, KONG_DATABASE=off, volume mount for config
- service.yaml: LoadBalancer:8000
- configmap.yaml: kong.yml content (adapt from existing kong/kong.yml)

For otel-collector:
- deployment.yaml: otel/opentelemetry-collector, port 4318
- service.yaml: ClusterIP:4318
- configmap.yaml: otel-config.yml content (adapt from existing otel/otel-config.yml)

For jaeger:
- deployment.yaml: jaegertracing/all-in-one, COLLECTOR_OTLP_ENABLED=true
- service.yaml: NodePort:16686

For prometheus:
- deployment.yaml: prom/prometheus, port 9090
- service.yaml: NodePort:9090
- configmap.yaml: prometheus.yml content (adapt from existing prometheus/prometheus.yml)

For grafana:
- deployment.yaml: grafana/grafana, port 3000, envFrom secret
- service.yaml: NodePort:3004→3000
- configmap.yaml: provisioning configs + dashboard JSON (adapt from existing grafana/)

**B3. Create Kustomize base — Migrations**

For each service, create a Job in `k8s/base/migrations/`:
- Uses same image as the service
- Command: `npx drizzle-kit push`
- envFrom: same as the service (needs DATABASE_URL)
- restartPolicy: Never, backoffLimit: 3
- ArgoCD annotations:
  ```yaml
  annotations:
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
  ```

**B4. Create root kustomization.yaml**

`k8s/base/kustomization.yaml`:
- List all resources
- `images:` section with placeholder names that Kustomize overrides

**B5. Create overlays**

`k8s/overlays/staging/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: staging
resources:
  - ../../base
images:
  - name: auth-service
    newName: yourdockerhub/auth-service
    newTag: "latest"
  - name: inventory-service
    newName: yourdockerhub/inventory-service
    newTag: "latest"
  - name: order-service
    newName: yourdockerhub/order-service
    newTag: "latest"
  - name: payment-service
    newName: yourdockerhub/payment-service
    newTag: "latest"
```

`k8s/overlays/prod/kustomization.yaml`: same structure, namespace: prod, replicas patched to 2.

**B6. Validate**
```bash
kustomize build k8s/base
kustomize build k8s/overlays/staging
kustomize build k8s/overlays/prod
```

### Phase C: App Repo Changes (in app-k8s) — DONE

- C1. Dockerfiles fixed (COPY package-lock.json* added)
- C2. Jenkinsfile created with conditional builds + GitOps manifest update
- C3. jenkins/pod-template.yaml created
- C4. `develop` branch created and pushed

### Phase D: Infrastructure Deployment (manual, one-time)

**D1. Deploy infra namespace resources**
```bash
kubectl create namespace infra
kubectl apply -k k8s/base/ --namespace infra
kubectl create secret generic postgres-secrets ... -n infra
kubectl create secret generic grafana-secrets ... -n infra
```

**D2. Create staging namespace + secrets**
```bash
kubectl create namespace staging
kubectl create secret generic auth-service-secrets ... -n staging
kubectl create secret generic inventory-service-secrets ... -n staging
kubectl create secret generic order-service-secrets ... -n staging
kubectl create secret generic payment-service-secrets ... -n staging
```

**D3. Create prod namespace + secrets** (same as D2 but with `prod` namespace and different passwords)

**D4. Apply ArgoCD Applications**
```bash
kubectl apply -f argocd/staging-app.yaml
kubectl apply -f argocd/prod-app.yaml
```

### Phase E: End-to-End Test

1. Push a change to `develop` in app-k8s
2. Jenkins triggers: builds images, pushes to DockerHub, updates manifest repo
3. ArgoCD detects manifest repo change, syncs to staging namespace
4. Verify: all pods running, services communicating, API accessible via Kong
5. Merge `develop` into `main`, verify prod flow (manual ArgoCD sync)

---

## Validation Commands

```bash
# Check Kustomize renders valid YAML
kustomize build k8s/base
kustomize build k8s/overlays/staging
kustomize build k8s/overlays/prod

# Check cluster resources
kubectl get pods -n infra
kubectl get pods -n staging
kubectl get pods -n prod
kubectl get svc -n infra    # find Kong external IP

# Check ArgoCD sync status
argocd app get app-staging
argocd app get app-prod

# Check Jenkins
# Open Jenkins UI, trigger build, watch console output
```
