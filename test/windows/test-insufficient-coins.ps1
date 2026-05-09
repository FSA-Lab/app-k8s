# Test Case 3: Insufficient Coins (with stock rollback)
# Stock is sufficient but user can't afford it. Stock gets deducted then rolled back.

$BASE_URL = "http://localhost:8000"
$passed = $true

function Invoke-Api {
    param([string]$Method, [string]$Uri, $Body, [switch]$NoAuth)
    $headers = @{ "Content-Type" = "application/json" }
    if (-not $NoAuth -and $script:token) {
        $headers["Authorization"] = "Bearer $($script:token)"
    }
    try {
        $params = @{ Method = $Method; Uri = $Uri; Headers = $headers }
        if ($Body) { $params.Body = $Body }
        return Invoke-RestMethod @params
    } catch {
        $errBody = $_.ErrorDetails.Message
        if ($errBody) {
            try { return ($errBody | ConvertFrom-Json) }
            catch { return @{ error = $errBody } }
        }
        throw
    }
}

function Assert {
    param([string]$Name, [bool]$Condition, [string]$Actual)
    if ($Condition) {
        Write-Host "  PASS: $Name" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: $Name (got: $Actual)" -ForegroundColor Red
        $script:passed = $false
    }
}

Write-Host "=== Case 3: Insufficient Coins ===" -ForegroundColor Cyan
Write-Host ""

# Seed admin
Write-Host "[1] Setup" -ForegroundColor Yellow
Invoke-Api -Method POST -Uri "$BASE_URL/auth/seed-admin" -NoAuth `
  -Body '{"name": "Admin3", "email": "admin3@test.com", "password": "password"}' | Out-Null

$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "admin3@test.com", "password": "password"}'
$script:token = $resp.token

# Create item and capture ID from response directly
Write-Host "  Creating Sword with stock=10..."
$created = Invoke-Api -Method POST -Uri "$BASE_URL/items" `
  -Body '{"name": "Sword", "stock": 10, "price": 500}'
$swordId = if ($created -is [array]) { $created[0].id } else { $created.id }
Write-Host "  Created Sword (id=$swordId, stock=10)"

# Signup user with 1000 coins
Invoke-Api -Method POST -Uri "$BASE_URL/auth/signup" -NoAuth `
  -Body '{"name": "Broke", "email": "broke3@test.com", "password": "password123"}' | Out-Null
$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "broke3@test.com", "password": "password123"}'
$script:token = $resp.token

# Order 3 Swords = 1500 total, user only has 1000 coins
Write-Host "[2] Ordering 3 Swords (total=1500, user has 1000 coins)" -ForegroundColor Yellow
$orderResp = Invoke-Api -Method POST -Uri "$BASE_URL/orders" `
  -Body "{`"items`": [{`"item_id`": $swordId, `"quantity`": 3, `"price`": 500}]}"
$orderId = $orderResp.orderId
Assert "Order created" ($orderResp.message -eq "Order created") $orderResp.message

Write-Host "  Waiting for saga + compensation..."
Start-Sleep -Seconds 3

# Verify
Write-Host "[3] Verifying" -ForegroundColor Yellow

$order = Invoke-Api -Method GET -Uri "$BASE_URL/orders/$orderId"
Assert "Order status = failed" ($order.order.status -eq "failed") $order.order.status

$items = Invoke-Api -Method GET -Uri "$BASE_URL/items"
$sword = @($items | Where-Object { $_.id -eq $swordId })[0]
Assert "Stock restored = 10" ($sword.stock -eq 10) $sword.stock

$me = Invoke-Api -Method GET -Uri "$BASE_URL/auth/me"
Assert "User coins unchanged = 1000" ($me.coin -eq 1000) $me.coin

$payments = Invoke-Api -Method GET -Uri "$BASE_URL/payments"
$payment = @($payments | Where-Object { $_.order_id -eq $orderId })[0]
Assert "Payment status = failed" ($payment.status -eq "failed") $payment.status

Write-Host ""
if ($passed) {
    Write-Host "=== Case 3: PASSED ===" -ForegroundColor Green
} else {
    Write-Host "=== Case 3: FAILED ===" -ForegroundColor Red
}
