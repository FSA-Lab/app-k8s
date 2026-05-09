#!/bin/bash
# Run all 3 test cases sequentially
# Make sure docker-compose up --build is running first

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "Running all saga test cases"
echo "Make sure 'docker-compose up --build' is running!"
echo "============================================"
echo ""

echo "--- Test 1: Normal Flow ---"
bash "$SCRIPT_DIR/test-normal.sh"
echo ""

echo "--- Test 2: Insufficient Stock ---"
bash "$SCRIPT_DIR/test-insufficient-stock.sh"
echo ""

echo "--- Test 3: Insufficient Coins ---"
bash "$SCRIPT_DIR/test-insufficient-coins.sh"
echo ""

echo "============================================"
echo "All test cases complete!"
echo "============================================"
