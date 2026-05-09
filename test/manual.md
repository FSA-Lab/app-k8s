# Manual Testing Guide

Step-by-step curl commands to test each saga scenario. Run `docker-compose up --build` first.

---

## Case 1: Normal Flow

Order has sufficient stock AND user has enough coins. Order completes successfully.

### 1. Seed admin and login

```bash
curl -X POST http://localhost:8000/auth/seed-admin \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@test.com", "password": "password"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@test.com", "password": "password"}'
# Copy the token from the response
```

### 2. Create items

```bash
# Replace <ADMIN_TOKEN> with the token from step 1

curl -X POST http://localhost:8000/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name": "Sword", "stock": 10, "price": 500}'

curl -X POST http://localhost:8000/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name": "Shield", "stock": 5, "price": 300}'
```

### 3. Signup user and login

```bash
curl -X POST http://localhost:8000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@test.com", "password": "password123"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "john@test.com", "password": "password123"}'
# Copy the user token
```

### 4. Create order (1 Sword + 1 Shield = 800 total, user has 1000 coins)

```bash
curl -X POST http://localhost:8000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{
    "items": [
      {"item_id": 1, "quantity": 1, "price": 500},
      {"item_id": 2, "quantity": 1, "price": 300}
    ]
  }'
# Expected: {"message":"Order created","orderId":1,"status":"ongoing"}
```

Wait 2-3 seconds for the saga to complete, then verify:

### 5. Verify results

```bash
# Order status should be "done"
curl -X GET http://localhost:8000/orders/1 \
  -H "Authorization: Bearer <USER_TOKEN>"

# Stock reduced: Sword 10->9, Shield 5->4
curl -X GET http://localhost:8000/items \
  -H "Authorization: Bearer <USER_TOKEN>"

# Coins reduced: 1000 - 800 = 200
curl -X GET http://localhost:8000/auth/me \
  -H "Authorization: Bearer <USER_TOKEN>"

# Payment record with status "paid"
curl -X GET http://localhost:8000/payments \
  -H "Authorization: Bearer <USER_TOKEN>"
```

### Expected results

| Check | Expected |
|---|---|
| Order status | `done` |
| Sword stock | 9 |
| Shield stock | 4 |
| User coins | 200 |
| Payment status | `paid` |

---

## Case 2: Insufficient Stock

Order requests more items than available. Inventory rejects, stock is never deducted.

### 1. Seed admin and create item with stock=2

```bash
curl -X POST http://localhost:8000/auth/seed-admin \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@test.com", "password": "password"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@test.com", "password": "password"}'
# Copy admin token

curl -X POST http://localhost:8000/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name": "Rare Gem", "stock": 2, "price": 100}'
# Note the item id from the response (e.g. id=3)
```

### 2. Signup user

```bash
curl -X POST http://localhost:8000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@test.com", "password": "password123"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "john@test.com", "password": "password123"}'
# Copy user token
```

### 3. Order 5 units (exceeds stock of 2)

```bash
curl -X POST http://localhost:8000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{
    "items": [
      {"item_id": 3, "quantity": 5, "price": 100}
    ]
  }'
# Note the orderId from the response
```

Wait 2-3 seconds, then verify:

### 4. Verify results

```bash
# Order status should be "failed"
curl -X GET http://localhost:8000/orders/<ORDER_ID> \
  -H "Authorization: Bearer <USER_TOKEN>"

# Stock should be UNCHANGED (still 2)
curl -X GET http://localhost:8000/items \
  -H "Authorization: Bearer <USER_TOKEN>"

# User coins should be UNCHANGED (1000)
curl -X GET http://localhost:8000/auth/me \
  -H "Authorization: Bearer <USER_TOKEN>"
```

### Expected results

| Check | Expected |
|---|---|
| Order status | `failed` |
| Rare Gem stock | 2 (unchanged) |
| User coins | 1000 (unchanged) |

---

## Case 3: Insufficient Coins (with stock rollback)

Stock is sufficient but user can't afford it. Stock gets deducted then rolled back.

### 1. Seed admin and create item

```bash
curl -X POST http://localhost:8000/auth/seed-admin \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@test.com", "password": "password"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@test.com", "password": "password"}'
# Copy admin token

curl -X POST http://localhost:8000/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name": "Sword", "stock": 10, "price": 500}'
# Note the item id (e.g. id=1)
```

### 2. Signup user (1000 coins)

```bash
curl -X POST http://localhost:8000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "Broke", "email": "broke@test.com", "password": "password123"}'

curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "broke@test.com", "password": "password123"}'
# Copy user token
```

### 3. Order 3 Swords (1500 total, user has 1000 coins)

```bash
curl -X POST http://localhost:8000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{
    "items": [
      {"item_id": 1, "quantity": 3, "price": 500}
    ]
  }'
# Note the orderId from the response
```

Wait 3-4 seconds (saga + compensation takes longer), then verify:

### 4. Verify results

```bash
# Order status should be "failed"
curl -X GET http://localhost:8000/orders/<ORDER_ID> \
  -H "Authorization: Bearer <USER_TOKEN>"

# Stock should be RESTORED to 10 (rolled back after payment failure)
curl -X GET http://localhost:8000/items \
  -H "Authorization: Bearer <USER_TOKEN>"

# Coins should be UNCHANGED (1000)
curl -X GET http://localhost:8000/auth/me \
  -H "Authorization: Bearer <USER_TOKEN>"

# Payment record with status "failed"
curl -X GET http://localhost:8000/payments \
  -H "Authorization: Bearer <USER_TOKEN>"
```

### Expected results

| Check | Expected |
|---|---|
| Order status | `failed` |
| Sword stock | 10 (restored) |
| User coins | 1000 (unchanged) |
| Payment status | `failed` |

---

## Event Flow Summary

### Happy path
```
order.created → inventory.reserved → payment.completed → order done
```

### Insufficient stock
```
order.created → inventory.failed → order failed (no stock deducted)
```

### Insufficient coins
```
order.created → inventory.reserved → payment.failed → order.failed → stock restored
```

---

## All Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /auth/signup | No | Register user |
| POST | /auth/login | No | Login, get token |
| POST | /auth/logout | No | Logout |
| GET | /auth/me | Yes | Get profile |
| POST | /auth/seed-admin | No | Create admin |
| GET | /items | Yes | List items |
| POST | /items | Admin | Create item |
| PATCH | /items/:id/stock | Yes | Update stock |
| GET | /orders | Yes | List my orders |
| GET | /orders/:id | Yes | Get order detail |
| POST | /orders | Yes | Create order |
| GET | /payments | Yes | List payments |
| POST | /payments | Yes | Manual payment |
