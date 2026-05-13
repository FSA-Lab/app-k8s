# Test Case 1: Normal Flow (Happy Path)
# Order has sufficient stock AND user has enough coins. Order completes successfully.

param(
    [string]$BaseUrl = "http://localhost:8000"
)
$BASE_URL = $BaseUrl
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

Write-Host "=== Case 1: Normal Flow ===" -ForegroundColor Cyan
Write-Host ""

# Setup
Write-Host "[1] Setup" -ForegroundColor Yellow
Invoke-Api -Method POST -Uri "$BASE_URL/auth/seed-admin" -NoAuth `
  -Body '{"name": "Admin1", "email": "admin1@test.com", "password": "password"}' | Out-Null

$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "admin1@test.com", "password": "password"}'
$script:token = $resp.token

# Create items and capture IDs from responses
$swordResp = Invoke-Api -Method POST -Uri "$BASE_URL/items" `
  -Body '{"name": "Sword", "stock": 10, "price": 500}'
$swordId = if ($swordResp -is [array]) { $swordResp[0].id } else { $swordResp.id }

$shieldResp = Invoke-Api -Method POST -Uri "$BASE_URL/items" `
  -Body '{"name": "Shield", "stock": 5, "price": 300}'
$shieldId = if ($shieldResp -is [array]) { $shieldResp[0].id } else { $shieldResp.id }

# Signup user
Invoke-Api -Method POST -Uri "$BASE_URL/auth/signup" -NoAuth `
  -Body '{"name": "User1", "email": "user1@test.com", "password": "password123"}' | Out-Null
$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "user1@test.com", "password": "password123"}'
$script:token = $resp.token

# Create order: 1 Sword (500) + 1 Shield (300) = 800, user has 1000 coins
Write-Host "[2] Creating order (total=800, user has 1000 coins)" -ForegroundColor Yellow
$orderResp = Invoke-Api -Method POST -Uri "$BASE_URL/orders" `
  -Body "{`"items`": [{`"item_id`": $swordId, `"quantity`": 1, `"price`": 500}, {`"item_id`": $shieldId, `"quantity`": 1, `"price`": 300}]}"
$orderId = $orderResp.orderId
Assert "Order created" ($orderResp.message -eq "Order created") $orderResp.message

Write-Host "  Waiting for saga..."
Start-Sleep -Seconds 2

# Verify
Write-Host "[3] Verifying" -ForegroundColor Yellow

$order = Invoke-Api -Method GET -Uri "$BASE_URL/orders/$orderId"
Assert "Order status = done" ($order.order.status -eq "done") $order.order.status
Assert "Total price = 800" ($order.order.total_price -eq 800) $order.order.total_price

$items = Invoke-Api -Method GET -Uri "$BASE_URL/items"
$sword = @($items | Where-Object { $_.id -eq $swordId })[0]
$shield = @($items | Where-Object { $_.id -eq $shieldId })[0]
Assert "Sword stock = 9" ($sword.stock -eq 9) $sword.stock
Assert "Shield stock = 4" ($shield.stock -eq 4) $shield.stock

$me = Invoke-Api -Method GET -Uri "$BASE_URL/auth/me"
Assert "User coins = 200" ($me.coin -eq 200) $me.coin

$payments = Invoke-Api -Method GET -Uri "$BASE_URL/payments"
$payment = @($payments | Where-Object { $_.order_id -eq $orderId })[0]
Assert "Payment status = paid" ($payment.status -eq "paid") $payment.status

Write-Host ""
if ($passed) {
    Write-Host "=== Case 1: PASSED ===" -ForegroundColor Green
} else {
    Write-Host "=== Case 1: FAILED ===" -ForegroundColor Red
}
