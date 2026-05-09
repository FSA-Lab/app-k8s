# Run all 3 test cases sequentially
# Make sure docker-compose up --build is running first

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Running all saga test cases"
Write-Host "Make sure 'docker-compose up --build' is running!"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "--- Test 1: Normal Flow ---" -ForegroundColor Magenta
& "$scriptDir\test-normal.ps1"
Write-Host ""

Write-Host "--- Test 2: Insufficient Stock ---" -ForegroundColor Magenta
& "$scriptDir\test-insufficient-stock.ps1"
Write-Host ""

Write-Host "--- Test 3: Insufficient Coins ---" -ForegroundColor Magenta
& "$scriptDir\test-insufficient-coins.ps1"
Write-Host ""

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "All test cases complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
