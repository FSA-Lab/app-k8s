# Phase 3: Kubernetes + CI/CD Setup Guide

## Architecture

```
app-k8s (source)                  app-k8s-manifests (GitOps)
┌──────────────────┐              ┌──────────────────────┐
│ Jenkinsfile      │──build+push──→│ k8s/base/            │
│ services/*/      │              │ k8s/overlays/staging/ │
│ Dockerfile       │──update tags─→│ k8s/overlays/prod/   │
└──────────────────┘              │ argocd/               │
       │                          └──────────┬───────────┘
       │                                     │
       ▼                                     ▼
   DockerHub ──pull images──→ AKS Cluster ←── ArgoCD watches
```

**Flow:** Push to `develop` → Jenkins builds images → pushes to DockerHub → updates manifest repo → ArgoCD auto-syncs to staging. Same for `main` → prod (manual sync).

---

## Prerequisites

- Azure AKS cluster (or any K8s cluster with `kubectl` access)
- DockerHub account + access token
- GitHub account + Personal Access Tokens (PATs)
- `kubectl`, `helm`, `argocd` CLI installed locally

---

## Step 1: Create Namespaces

```bash
kubectl create namespace infra
kubectl create namespace staging
kubectl create namespace prod
kubectl create namespace jenkins
kubectl create namespace argocd
```

---

## Step 2: Create Secrets

Secrets are NOT in Git. Create them with `kubectl`.

```bash
# Shared Postgres credentials (used by all DBs)
for ns in staging prod; do
  kubectl create secret generic postgres-secrets \
    --from-literal=POSTGRES_USER='root' \
    --from-literal=POSTGRES_PASSWORD='your-postgres-password' \
    -n $ns
done

# Grafana admin password
kubectl create secret generic grafana-secrets \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD='your-grafana-password' \
  -n infra

# Per-service secrets (repeat for each namespace: staging, prod)
for ns in staging prod; do
  for svc in auth inventory order payment; do
    kubectl create secret generic ${svc}-service-secrets \
      --from-literal=DATABASE_URL="postgres://root:your-postgres-password@${svc}-db.${ns}.svc.cluster.local:5432/${svc}" \
      --from-literal=RABBITMQ_URL="amqp://rabbitmq.${ns}.svc.cluster.local:5672" \
      --from-literal=JWT_SECRET='your-jwt-secret' \
      -n $ns
  done
done
```

---

## Step 3: Deploy Jenkins

### 3a. Install Jenkins with Helm

```bash
helm repo add jenkins https://charts.jenkins.io
helm repo update

helm install jenkins jenkins/jenkins \
  --namespace jenkins \
  --set controller.adminPassword='your-jenkins-password' \
  --set controller.serviceType=LoadBalancer \
  --set controller.installPlugins[0]=kubernetes:latest \
  --set controller.installPlugins[1]=workflow-aggregator:latest \
  --set controller.installPlugins[2]=git:latest \
  --set controller.installPlugins[3]=pipeline-stage-view:latest \
  --set controller.installPlugins[4]=blueocean:latest
```

### 3b. Get Jenkins URL

```bash
kubectl get svc -n jenkins
# External IP of jenkins service → http://<EXTERNAL-IP>:8080
```

### 3c. Add Credentials in Jenkins UI

Go to **Manage Jenkins → Credentials → Add Credentials**:

| ID | Type | Value |
|---|---|---|
| `dockerhub-creds` | Username/Password | DockerHub username + access token |
| `manifest-repo-creds` | Secret text | GitHub PAT (read/write to manifests repo) |
| `sonar-token` | Secret text | SonarQube token (created in Step 5) |

### 3d. Add Global Environment Variable

**Manage Jenkins → System → Global properties → Environment variables**:

| Name | Value |
|---|---|
| `DOCKERHUB_REPO` | Your DockerHub username (e.g., `hungnv2511`) |

### 3e. Create Pipeline Job

1. **New Item → Pipeline**
2. **Definition**: Pipeline script from SCM
3. **SCM**: Git, URL: `https://github.com/FSA-Lab/app-k8s.git`, branch: `develop`
4. **Script Path**: `Jenkinsfile`
5. **Build Triggers**: GitHub hook trigger for GITScm polling

### 3f. Configure GitHub Webhook

In `app-k8s` repo → **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `http://<jenkins-url>/github-webhook/` |
| Content type | `application/json` |
| Events | Just the push event |
| Branches | `develop`, `main` |

---

## Step 4: Deploy ArgoCD

### 4a. Install ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

### 4b. Get ArgoCD URL and Password

```bash
# Get the initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d

# Port-forward for local access (or use LoadBalancer)
kubectl port-forward svc/argocd-server -n argocd 8443:443
```

Login at `https://localhost:8443` (username: `admin`).

### 4c. Add Manifest Repo

```bash
argocd repo add https://github.com/FSA-Lab/app-k8s-manifests.git \
  --username <github-username> \
  --password <github-pat>
```

### 4d. Apply ArgoCD Applications

From the `app-k8s-manifests` repo:

```bash
kubectl apply -f argocd/staging-app.yaml
kubectl apply -f argocd/prod-app.yaml
```

**Staging** — auto-sync from `develop` branch:
```yaml
# argocd/staging-app.yaml
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
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**Prod** — manual sync from `main` branch:
```yaml
# argocd/prod-app.yaml
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
    syncOptions:
      - CreateNamespace=true
```

---

## Step 5: Deploy SonarQube

```bash
helm repo add sonarqube https://SonarSource.github.io/helm-chart-sonarqube
helm repo update

helm install sonarqube sonarqube/sonarqube \
  --namespace argocd \
  --set service.type=ClusterIP \
  --set persistence.enabled=false
```

Get the SonarQube token:
1. Port-forward: `kubectl port-forward svc/sonarqube-sonarqube -n argocd 9000:9000`
2. Login at `http://localhost:9000` (default: admin/admin)
3. **My Account → Security → Generate Token**
4. Add this token as `sonar-token` credential in Jenkins

---

## Step 6: Deploy Infrastructure to Cluster

```bash
# Apply all base infra resources to the infra namespace
kubectl apply -k k8s/base/ --namespace infra

# This deploys: databases, rabbitmq, kong, otel-collector,
# jaeger, prometheus, grafana, loki
```

Verify:
```bash
kubectl get pods -n infra
# All pods should be Running
```

---

## Step 7: First Deploy (End-to-End Test)

1. Push a change to `develop` in `app-k8s`
2. Jenkins triggers → builds 4 Docker images → pushes to DockerHub → updates manifest repo `develop` branch with new image tags
3. ArgoCD detects manifest repo change → auto-syncs to `staging` namespace
4. Migration Jobs run `npx drizzle-kit push` → DB schemas created
5. App pods start → connect to DBs, RabbitMQ, OTel Collector

Verify:
```bash
kubectl get pods -n staging
# All pods should be Running

kubectl get svc kong -n staging
# External IP → test API via Kong

kubectl logs -n infra deployment/otel-collector
# Should show traces and logs being received
```

---

## Step 8: Promote to Prod

1. Create PR from `develop` to `main` in `app-k8s`
2. Merge PR → Jenkins triggers on `main` → builds images → updates manifest repo `main` branch
3. ArgoCD shows `app-prod` asOutOfSync (manual sync required)
4. In ArgoCD UI → `app-prod` → **Sync** → approve
5. Prod namespace updated

---

## Cluster Layout

```
AKS Cluster
├── infra (shared services)
│   ├── auth-db, inventory-db, order-db, payment-db (Postgres)
│   ├── rabbitmq
│   ├── kong (LoadBalancer:8000 — external API gateway)
│   ├── otel-collector (traces → Jaeger, logs → Loki)
│   ├── jaeger (NodePort:30686)
│   ├── prometheus (NodePort:30090)
│   ├── grafana (NodePort:30304)
│   └── loki
├── staging
│   ├── auth-service, inventory-service, order-service, payment-service
│   └── migration Jobs (4)
├── prod
│   ├── auth-service, inventory-service, order-service, payment-service
│   └── migration Jobs (4)
├── jenkins
│   └── jenkins controller + ephemeral build agents
└── argocd
    └── argocd server + repo-server + application-controller
```

---

## Troubleshooting

```bash
# Check pod status
kubectl get pods -n <namespace>
kubectl describe pod <pod-name> -n <namespace>
kubectl logs <pod-name> -n <namespace>

# Check ArgoCD sync status
argocd app get app-staging
argocd app get app-prod

# Check Jenkins build logs
# Jenkins UI → Pipeline → Build # → Console Output

# Force ArgoCD sync
argocd app sync app-staging
argocd app sync app-prod

# Check Kustomize renders valid YAML
kustomize build k8s/base
kustomize build k8s/overlays/staging
kustomize build k8s/overlays/prod
```
