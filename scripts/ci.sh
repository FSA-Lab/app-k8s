#!/bin/bash
# Local CI: build Docker images, push to DockerHub, update manifest repo
# ArgoCD will auto-sync the staging namespace after manifest repo is updated
#
# Usage:
#   ./scripts/ci.sh                          # build all services
#   ./scripts/ci.sh auth-service             # build only auth-service
#   DOCKERHUB_REPO=myuser ./scripts/ci.sh    # override DockerHub username
#
# Env vars:
#   DOCKERHUB_REPO  - DockerHub username (default: hungnv2511)
#   BRANCH          - Manifest repo branch (default: develop)
#   SKIP_PUSH       - Set to "true" to skip Docker push and manifest update

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKERHUB_REPO="${DOCKERHUB_REPO:-hungnv2511}"
MANIFEST_REPO="git@github.com:FSA-Lab/app-k8s-manifests.git"
BRANCH="${BRANCH:-develop}"
OVERLAY="staging"
ALL_SERVICES="auth-service inventory-service order-service payment-service"

# If specific service(s) passed as args, build only those
if [ $# -gt 0 ]; then
    SERVICES="$@"
else
    SERVICES="$ALL_SERVICES"
fi

cd "$APP_DIR"

# Get git short SHA
SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
echo "============================================"
echo "CI Pipeline"
echo "  DockerHub: $DOCKERHUB_REPO"
echo "  Tag:       $SHORT_SHA"
echo "  Services:  $SERVICES"
echo "  Branch:    $BRANCH"
echo "============================================"
echo ""

# Step 1: Build and push images
for svc in $SERVICES; do
    echo "[BUILD] $svc..."
    docker build -t "$DOCKERHUB_REPO/$svc:$SHORT_SHA" -f "services/$svc/Dockerfile" .

    if [ "$SKIP_PUSH" = "true" ]; then
        echo "[SKIP]  Push disabled (SKIP_PUSH=true)"
    else
        echo "[PUSH]  $DOCKERHUB_REPO/$svc:$SHORT_SHA"
        docker push "$DOCKERHUB_REPO/$svc:$SHORT_SHA"
        docker tag "$DOCKERHUB_REPO/$svc:$SHORT_SHA" "$DOCKERHUB_REPO/$svc:latest"
        docker push "$DOCKERHUB_REPO/$svc:latest"
    fi
    echo ""
done

# Step 2: Update manifest repo
if [ "$SKIP_PUSH" = "true" ]; then
    echo "[SKIP] Manifest update disabled (SKIP_PUSH=true)"
    echo "Done! Images built locally only."
    exit 0
fi

command -v kustomize &>/dev/null || { echo "Error: kustomize not found. Install: https://kustomize.io/"; exit 1; }

echo "[MANIFEST] Cloning manifest repo..."
TMPDIR=$(mktemp -d)
git clone --depth 1 -b "$BRANCH" "$MANIFEST_REPO" "$TMPDIR/manifests"

cd "$TMPDIR/manifests"
cd "k8s/overlays/$OVERLAY"

for svc in $SERVICES; do
    echo "[MANIFEST] Setting $svc=$DOCKERHUB_REPO/$svc:$SHORT_SHA"
    kustomize edit set image "$svc=$DOCKERHUB_REPO/$svc:$SHORT_SHA"
done

cd "$TMPDIR/manifests"
git add k8s/overlays/
if git diff --cached --quiet; then
    echo "[MANIFEST] No changes to commit"
else
    git config user.email "ci@local"
    git config user.name "Local CI"
    git commit -m "ci: update image tags to $SHORT_SHA"
    git push origin "$BRANCH"
    echo "[MANIFEST] Pushed to $BRANCH"
fi

rm -rf "$TMPDIR"

echo ""
echo "============================================"
echo "Done! ArgoCD will auto-sync staging namespace."
echo "  Watch: kubectl get pods -n staging"
echo "  Test:  bash test/linux/run-all.sh"
echo "============================================"
