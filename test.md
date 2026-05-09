# API & Saga Testing Guide

## Overview

This app is a microservices e-commerce system with an event-driven saga pattern. All HTTP requests go through the **Kong API Gateway** on port `8000`.

**Base URL:** `http://localhost:8000`

## Services

| Service | Prefix | Port (internal) | Description |
|---|---|---|---|
| auth-service | `/auth` | 3000 | User auth, JWT tokens, coins |
| inventory-service | `/items` | 3000 | Item catalog, stock |
| order-service | `/orders` | 3000 | Order creation, saga orchestration |
| payment-service | `/payments` | 3000 | Coin-based payment processing |

## Starting the Stack

```bash
docker-compose up --build
```

Wait for all services to log `started successfully`.

**RabbitMQ Management UI:** http://localhost:15672 (guest/guest)

---

## API Reference

### Auth Service

#### POST /auth/signup
Create a new user (default 1000 coins, role "user").

```json
// Request
{ "name": "John", "email": "john@test.com", "password": "password123" }

// Response (201)
{ "id": 1, "name": "John", "email": "john@test.com", "coin": 1000, "role": "user" }
```

#### POST /auth/login
Returns a JWT token.

```json
// Request
{ "email": "john@test.com", "password": "password123" }

// Response (200)
{ "token": "eyJhbGciOi..." }
```

#### GET /auth/me
Returns current user profile. Requires `Authorization: Bearer <token>`.

```json
// Response (200)
{ "id": 1, "name": "John", "email": "john@test.com", "coin": 1000, "role": "user" }
```

#### POST /auth/logout
Client-side logout (discard token).

```json
// Response (200)
{ "message": "Logged out successfully" }
```

#### POST /auth/seed-admin
Create an admin user (99999 coins). No auth required.

```json
// Request
{ "name": "Admin", "email": "admin@test.com", "password": "password" }

// Response (201)
{ "id": 2, "name": "Admin", "email": "admin@test.com", "role": "admin" }
```

---

### Inventory Service

#### GET /items
List all items. Requires auth.

```json
// Response (200)
[
  { "id": 1, "name": "Sword", "stock": 10, "price": 500, "created_at": "..." },
  { "id": 2, "name": "Shield", "stock": 5, "price": 300, "created_at": "..." }
]
```

#### POST /items
Create an item. Requires admin auth.

```json
// Request
{ "name": "Sword", "stock": 10, "price": 500 }

// Response (201)
[{ "id": 1, "name": "Sword", "stock": 10, "price": 500, "created_at": "..." }]
```

#### PATCH /items/:id/stock
Update stock quantity. Requires auth.

```json
// Request
{ "stock": 8 }

// Response (200)
[{ "id": 1, "name": "Sword", "stock": 8, "price": 500 }]
```

---

### Order Service

#### GET /orders
List current user's orders. Requires auth.

```json
// Response (200)
[
  { "id": 1, "user_id": 1, "total_price": 800, "status": "done", "created_at": "..." }
]
```

#### GET /orders/:id
Get single order with items. Requires auth. Ownership enforced (403 if not yours).

```json
// Response (200)
{
  "order": { "id": 1, "user_id": 1, "total_price": 800, "status": "done", "created_at": "..." },
  "items": [
    { "id": 1, "order_id": 1, "item_id": 1, "quantity": 1, "price_at_purchase": 500 },
    { "id": 2, "order_id": 1, "item_id": 2, "quantity": 1, "price_at_purchase": 300 }
  ]
}
```

#### POST /orders
Create an order. Requires auth. Triggers the saga.

```json
// Request
{
  "items": [
    { "item_id": 1, "quantity": 1, "price": 500 },
    { "item_id": 2, "quantity": 1, "price": 300 }
  ]
}

// Response (201)
{ "message": "Order created", "orderId": 1, "status": "ongoing" }
```

**Important:** The response returns immediately with `"ongoing"` status. The saga runs asynchronously. Poll `GET /orders/:id` to check when status changes to `"done"` or `"failed"`.

---

### Payment Service

#### GET /payments
List all payment records. Requires auth.

```json
// Response (200)
[
  { "id": 1, "order_id": 1, "price": 800, "status": "paid", "created_at": "..." }
]
```

#### POST /payments
Manually create a payment (for testing). Requires auth.

```json
// Request
{ "order_id": 1, "price": 800 }

// Response (201)
{ "id": 1, "order_id": 1, "price": 800, "status": "paid", "created_at": "..." }
```

---

## Saga Flow

When `POST /orders` is called, the following async saga runs:

```
POST /orders → order created (status: ongoing)
    │
    ▼
order-service publishes "order.created"
    │
    ▼
inventory-service consumes
    ├── Stock OK → deduct stock → publish "inventory.reserved"
    │                               │
    │                               ▼
    │                   payment-service consumes
    │                       ├── Coins OK → deduct coins → publish "payment.completed"
    │                       │                               │
    │                       │                               ▼
    │                       │                   order-service: status = "done"
    │                       │
    │                       └── Coins FAIL → publish "payment.failed"
    │                                               │
    │                                               ▼
    │                                   order-service: status = "failed"
    │                                   order-service publishes "order.failed" (compensation)
    │                                               │
    │                                               ▼
    │                                   inventory-service: stock restored (rollback)
    │
    └── Stock FAIL → publish "inventory.failed"
                            │
                            ▼
                order-service: status = "failed"
                (no stock deducted, no compensation needed)
```

### Order Status Values

| Status | Meaning |
|---|---|
| `ongoing` | Saga in progress |
| `done` | Payment successful, order complete |
| `failed` | Stock insufficient or payment failed |

---

## Frontend Integration Notes

### Authentication
- Store the JWT token from `POST /auth/login` in memory or localStorage
- Send it as `Authorization: Bearer <token>` on all protected requests
- On 401 response, redirect to login

### Order Flow (React Example)

```typescript
// 1. Create order
const res = await fetch("/orders", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  },
  body: JSON.stringify({
    items: [
      { item_id: 1, quantity: 2, price: 500 },
    ],
  }),
});
const { orderId } = await res.json();

// 2. Poll for order status (saga is async)
const poll = setInterval(async () => {
  const orderRes = await fetch(`/orders/${orderId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const { order } = await orderRes.json();

  if (order.status === "done") {
    clearInterval(poll);
    // Show success, refresh user coins, refresh inventory
  } else if (order.status === "failed") {
    clearInterval(poll);
    // Show failure message
  }
}, 1000);
```

### User Coins
- New users start with **1000 coins**
- Coins are deducted on successful payment
- Display remaining coins from `GET /auth/me`
- Show total price before confirming order so user knows if they can afford it

### Stock Display
- Fetch items with `GET /items` to show current stock
- Stock changes in real-time as orders are processed
- After an order completes or fails, re-fetch items to show updated stock

---

## Testing Cases

### Case 1: Normal Flow (Happy Path)

Order has sufficient stock AND user has enough coins.

1. Seed admin → Login admin → Create items (Sword stock=10 price=500, Shield stock=5 price=300)
2. Signup user (1000 coins) → Login user
3. Create order: 1 Sword + 1 Shield = 800 total
4. Verify:
   - Order status = `done`
   - Stock: Sword 10→9, Shield 5→4
   - User coins: 1000→200
   - Payment status = `paid`

### Case 2: Insufficient Stock

Order requests more items than available.

1. Create item with stock=2
2. Order 5 units of that item
3. Verify:
   - Order status = `failed`
   - Stock unchanged (still 2)
   - No payment created
   - User coins unchanged

### Case 3: Insufficient Coins (Stock Rollback)

Stock is sufficient but user can't afford it.

1. User has 1000 coins
2. Order 3 Swords (1500 total)
3. Verify:
   - Order status = `failed`
   - Stock deducted then **restored** (rollback)
   - User coins unchanged (1000)
   - Payment status = `failed`

---

## Quick Reference

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
| POST | /orders | Yes | Create order (triggers saga) |
| GET | /payments | Yes | List payments |
| POST | /payments | Yes | Manual payment |
