#!/bin/bash
# Test Case 3: Insufficient Coins (with stock rollback)
# Stock is sufficient but user can't afford it. Stock gets deducted then rolled back.

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

echo "=== Case 3: Insufficient Coins ==="
echo ""

# Setup
echo "[1] Setup"
curl -s -X POST "$BASE_URL/auth/seed-admin" -H "Content-Type: application/json" -d '{"name":"Admin3","email":"admin3@test.com","password":"password"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"admin3@test.com","password":"password"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Create item with stock=10 and capture ID from response
SWORD_ID=$(curl -s -X POST "$BASE_URL/items" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"name":"Sword","stock":10,"price":500}' | grep -oP '"id":\K\d+')
echo "  Created Sword (id=$SWORD_ID, stock=10)"

curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" -d '{"name":"Broke","email":"broke3@test.com","password":"password123"}' > /dev/null 2>&1 || true
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" -d '{"email":"broke3@test.com","password":"password123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Order 3 Swords = 1500, user has 1000 coins
echo "[2] Ordering 3 Swords (total=1500, user has 1000 coins)"
ORDER_RESP=$(curl -s -X POST "$BASE_URL/orders" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"items\":[{\"item_id\":$SWORD_ID,\"quantity\":3,\"price\":500}]}")
ORDER_ID=$(echo "$ORDER_RESP" | grep -o '"orderId":[0-9]*' | cut -d: -f2)
echo "  Order ID: $ORDER_ID"
echo "  Waiting for saga + compensation..."
sleep 3

# Verify
echo "[3] Verifying"
ORDER=$(curl -s -X GET "$BASE_URL/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN")
STATUS=$(echo "$ORDER" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
assert "Order status = failed" "$([ "$STATUS" = "failed" ] && echo true || echo false)" "$STATUS"

STOCK=$(curl -s -X GET "$BASE_URL/items" -H "Authorization: Bearer $TOKEN" | grep -oP "\"id\":$SWORD_ID,\"name\":\"Sword\",\"stock\":\K[0-9]+")
assert "Stock restored = 10" "$([ "$STOCK" = "10" ] && echo true || echo false)" "$STOCK"

COINS=$(curl -s -X GET "$BASE_URL/auth/me" -H "Authorization: Bearer $TOKEN" | grep -o '"coin":[0-9]*' | cut -d: -f2)
assert "User coins unchanged = 1000" "$([ "$COINS" = "1000" ] && echo true || echo false)" "$COINS"

PAY_STATUS=$(curl -s -X GET "$BASE_URL/payments" -H "Authorization: Bearer $TOKEN" | grep -o "\"order_id\":$ORDER_ID,\"price\":1500,\"status\":\"[^\"]*\"" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
assert "Payment status = failed" "$([ "$PAY_STATUS" = "failed" ] && echo true || echo false)" "$PAY_STATUS"

echo ""
if [ "$PASSED" = "true" ]; then
    echo "=== Case 3: PASSED ==="
else
    echo "=== Case 3: FAILED ==="
fi
