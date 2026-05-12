#!/bin/bash
# Test Case 1: Normal Flow (Happy Path)
# Order has sufficient stock AND user has enough coins. Order completes successfully.

set -e
BASE_URL="http://localhost:8000"
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

echo "=== Case 1: Normal Flow ==="
echo ""

# Setup
echo "[1] Setup"
curl -s -X POST "$BASE_URL/auth/seed-admin" -H "Content-Type: application/json" -d '{"name":"Admin1","email":"admin1@test.com","password":"password"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"admin1@test.com","password":"password"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Create items and capture IDs from responses
SWORD_ID=$(curl -s -X POST "$BASE_URL/items" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"name":"Sword","stock":10,"price":500}' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
SHIELD_ID=$(curl -s -X POST "$BASE_URL/items" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"name":"Shield","stock":5,"price":300}' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')

curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" -d '{"name":"User1","email":"user1@test.com","password":"password123"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"user1@test.com","password":"password123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Create order: 1 Sword + 1 Shield = 800
echo "[2] Creating order (total=800, user has 1000 coins)"
ORDER_RESP=$(curl -s -X POST "$BASE_URL/orders" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"items\":[{\"item_id\":$SWORD_ID,\"quantity\":1,\"price\":500},{\"item_id\":$SHIELD_ID,\"quantity\":1,\"price\":300}]}")
ORDER_ID=$(echo "$ORDER_RESP" | grep -o '"orderId":[0-9]*' | cut -d: -f2)
echo "  Order ID: $ORDER_ID"
echo "  Waiting for saga..."
sleep 2

# Verify
echo "[3] Verifying"
ORDER=$(curl -s -X GET "$BASE_URL/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN")
STATUS=$(echo "$ORDER" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
assert "Order status = done" "$([ "$STATUS" = "done" ] && echo true || echo false)" "$STATUS"

ITEMS=$(curl -s -X GET "$BASE_URL/items" -H "Authorization: Bearer $TOKEN")
SWORD_STOCK=$(echo "$ITEMS" | sed -n "s/.*\"id\":$SWORD_ID,\"name\":\"Sword\",\"stock\":\([0-9]*\).*/\1/p")
SHIELD_STOCK=$(echo "$ITEMS" | sed -n "s/.*\"id\":$SHIELD_ID,\"name\":\"Shield\",\"stock\":\([0-9]*\).*/\1/p")
assert "Sword stock = 9" "$([ "$SWORD_STOCK" = "9" ] && echo true || echo false)" "$SWORD_STOCK"
assert "Shield stock = 4" "$([ "$SHIELD_STOCK" = "4" ] && echo true || echo false)" "$SHIELD_STOCK"

COINS=$(curl -s -X GET "$BASE_URL/auth/me" -H "Authorization: Bearer $TOKEN" | grep -o '"coin":[0-9]*' | cut -d: -f2)
assert "User coins = 200" "$([ "$COINS" = "200" ] && echo true || echo false)" "$COINS"

PAY_STATUS=$(curl -s -X GET "$BASE_URL/payments" -H "Authorization: Bearer $TOKEN" | sed -n "s/.*\"order_id\":$ORDER_ID,\"price\":800,\"status\":\"\([^\"]*\)\".*/\1/p" | head -1)
assert "Payment status = paid" "$([ "$PAY_STATUS" = "paid" ] && echo true || echo false)" "$PAY_STATUS"

echo ""
if [ "$PASSED" = "true" ]; then
    echo "=== Case 1: PASSED ==="
else
    echo "=== Case 1: FAILED ==="
fi
