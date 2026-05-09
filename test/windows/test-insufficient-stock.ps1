# Test Case 2: Insufficient Stock
# Order requests more items than available. Inventory rejects, stock is never deducted.

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

Write-Host "=== Case 2: Insufficient Stock ===" -ForegroundColor Cyan
Write-Host ""

# Setup
Write-Host "[1] Setup" -ForegroundColor Yellow
Invoke-Api -Method POST -Uri "$BASE_URL/auth/seed-admin" -NoAuth `
  -Body '{"name": "Admin2", "email": "admin2@test.com", "password": "password"}' | Out-Null

$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "admin2@test.com", "password": "password"}'
$script:token = $resp.token

# Create item with stock=2 and capture ID from response
$created = Invoke-Api -Method POST -Uri "$BASE_URL/items" `
  -Body '{"name": "Rare Gem", "stock": 2, "price": 100}'
$gemId = if ($created -is [array]) { $created[0].id } else { $created.id }
Write-Host "  Created Rare Gem (id=$gemId, stock=2)"

# Signup user
Invoke-Api -Method POST -Uri "$BASE_URL/auth/signup" -NoAuth `
  -Body '{"name": "User2", "email": "user2@test.com", "password": "password123"}' | Out-Null
$resp = Invoke-Api -Method POST -Uri "$BASE_URL/auth/login" -NoAuth `
  -Body '{"email": "user2@test.com", "password": "password123"}'
$script:token = $resp.token

# Order 5 units — exceeds stock of 2
Write-Host "[2] Ordering 5 Rare Gems (stock=2, should fail)" -ForegroundColor Yellow
$orderResp = Invoke-Api -Method POST -Uri "$BASE_URL/orders" `
  -Body "{`"items`": [{`"item_id`": $gemId, `"quantity`": 5, `"price`": 100}]}"
$orderId = $orderResp.orderId
Assert "Order created" ($orderResp.message -eq "Order created") $orderResp.message

Write-Host "  Waiting for saga..."
Start-Sleep -Seconds 2

# Verify
Write-Host "[3] Verifying" -ForegroundColor Yellow

$order = Invoke-Api -Method GET -Uri "$BASE_URL/orders/$orderId"
Assert "Order status = failed" ($order.order.status -eq "failed") $order.order.status

$items = Invoke-Api -Method GET -Uri "$BASE_URL/items"
$gem = @($items | Where-Object { $_.id -eq $gemId })[0]
Assert "Stock unchanged = 2" ($gem.stock -eq 2) $gem.stock

$me = Invoke-Api -Method GET -Uri "$BASE_URL/auth/me"
Assert "User coins unchanged = 1000" ($me.coin -eq 1000) $me.coin

Write-Host ""
if ($passed) {
    Write-Host "=== Case 2: PASSED ===" -ForegroundColor Green
} else {
    Write-Host "=== Case 2: FAILED ===" -ForegroundColor Red
}
