#!/bin/bash
# Test Case 2: Insufficient Stock
# Order requests more items than available. Inventory rejects, stock is never deducted.

set -e
BASE_URL="${1:-http://localhost:8000}"
PASSED=true

assert() {
    local name="$1" condition="$2" actual="$3"
    if [ "$condition" = "true" ]; then
        echo "  PASS: $name"
    else
        echo "  FAIL: $name (got: $actual)"
        PASSED=false
    fi
}

echo "=== Case 2: Insufficient Stock ==="
echo ""

# Setup
echo "[1] Setup"
curl -s -X POST "$BASE_URL/auth/seed-admin" -H "Content-Type: application/json" -d '{"name":"Admin2","email":"admin2@test.com","password":"password"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"admin2@test.com","password":"password"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Create item with stock=2 and capture ID from response
GEM_ID=$(curl -s -X POST "$BASE_URL/items" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"name":"Rare Gem","stock":2,"price":100}' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  Created Rare Gem (id=$GEM_ID, stock=2)"

curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" -d '{"name":"User2","email":"user2@test.com","password":"password123"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"user2@test.com","password":"password123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Order 5 — exceeds stock of 2
echo "[2] Ordering 5 Rare Gems (stock=2, should fail)"
ORDER_RESP=$(curl -s -X POST "$BASE_URL/orders" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"items\":[{\"item_id\":$GEM_ID,\"quantity\":5,\"price\":100}]}")
ORDER_ID=$(echo "$ORDER_RESP" | grep -o '"orderId":[0-9]*' | cut -d: -f2)
echo "  Order ID: $ORDER_ID"
echo "  Waiting for saga..."
sleep 2

# Verify
echo "[3] Verifying"
ORDER=$(curl -s -X GET "$BASE_URL/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN")
STATUS=$(echo "$ORDER" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
assert "Order status = failed" "$([ "$STATUS" = "failed" ] && echo true || echo false)" "$STATUS"

STOCK=$(curl -s -X GET "$BASE_URL/items" -H "Authorization: Bearer $TOKEN" | sed -n "s/.*\"id\":$GEM_ID,\"name\":\"Rare Gem\",\"stock\":\([0-9]*\).*/\1/p")
assert "Stock unchanged = 2" "$([ "$STOCK" = "2" ] && echo true || echo false)" "$STOCK"

COINS=$(curl -s -X GET "$BASE_URL/auth/me" -H "Authorization: Bearer $TOKEN" | grep -o '"coin":[0-9]*' | cut -d: -f2)
assert "User coins unchanged = 1000" "$([ "$COINS" = "1000" ] && echo true || echo false)" "$COINS"

echo ""
if [ "$PASSED" = "true" ]; then
    echo "=== Case 2: PASSED ==="
else
    echo "=== Case 2: FAILED ==="
fi
