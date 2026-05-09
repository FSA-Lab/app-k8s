# Implementation Plan: Complete Microservice App

## Context

The project is a microservices e-commerce lab app with 3 active services (auth, inventory, order) and a planned payment service. The readme defines a saga-based event flow using RabbitMQ, but several pieces are broken or unfinished. This plan covers completing all features, fixing bugs, wiring up the full event-driven saga, implementing the missing payment-service, and writing a comprehensive RabbitMQ testing guide.

---

## Gap Analysis: Readme Spec vs Current Code

### What's Done
- auth-service: signup, login, me, seed-admin (but missing `POST /logout`)
- inventory-service: GET /items, POST /items (admin), PATCH /items/:id/stock
- order-service: GET /orders, GET /orders/:id, POST /orders (creates order but doesn't publish event)
- Shared `@shared/auth` package works correctly
- Shared `@shared/events` constants/types defined (but unused)
- RabbitMQ connection/publisher boilerplate in each service
- Kong gateway routing for auth, inventory, order
- Docker Compose with all infra + 3 services + migration jobs

### What's Missing or Broken

1. `@shared/events` package has no `package.json` — cannot be imported as a workspace dep
2. `@shared/events` is not imported by any service — all event strings are inline literals
3. `connectRabbitMQ()` doesn't store the channel — `channel` export stays undefined, so `publishEvent()` will crash
4. order-service `POST /orders` never calls `publishEvent()` — event object is built but not sent
5. order-service `startOrderConsumer()` has bugs:
   - Uses undefined `amqp` import (should use `amqplib`)
   - Hardcoded `amqp://rabbitmq-service` instead of `amqp://rabbitmq:5672`
   - Uses exchange name `"orders"` instead of `"app.events"`
6. inventory-service has no consumer — should listen for `order.created` to reserve stock
7. payment-service doesn't exist — needs full implementation
8. auth-service missing `POST /logout` route per readme
9. Kong config missing payment-service route
10. Docker Compose payment-service section is commented out

---

## Task List

### Task 1: Fix `@shared/events` package
- Create `shared/packages/events/package.json` (name: `@shared/events`)
- Create `shared/packages/events/index.ts` barrel export

### Task 2: Fix RabbitMQ connection pattern across all 3 services
- `connectRabbitMQ()` must create a channel and assign to exported `channel` variable
- Assert `app.events` topic exchange on connection
- Files: `services/*/src/rabbitmq/connection.ts`

### Task 3: Wire `@shared/events` into all services
- Add `@shared/events` dependency to each service's `package.json`
- Replace inline event string literals with `EVENTS.*` constants

### Task 4: Fix order-service saga — publish `order.created` event
- Import `publishEvent` and `EVENTS`, call `publishEvent()` after order creation
- Rewrite `startOrderConsumer()`: fix amqp import, use correct URL/exchange, use EVENTS constants

### Task 5: Implement inventory-service consumer (saga step 2)
- Add `startInventoryConsumer()` that listens for `order.created`
- Check stock, deduct if sufficient → publish `inventory.reserved`
- If insufficient stock → publish `inventory.failed`

### Task 6: Implement payment-service (saga step 3)
- Create full service: schema, routes, consumer, Dockerfile
- Schema: `payments` table (id, order_id, price, status, created_at)
- Routes: GET /payments, POST /payments
- Consumer: listen for `inventory.reserved`, deduct coins, publish `payment.completed` or `payment.failed`

### Task 7: Add internal endpoint to auth-service for coin deduction
- Add `PATCH /users/:id/coins` (no auth — internal service-to-service)
- Payment-service calls this to deduct coins

### Task 8: Add `POST /logout` to auth-service
- Simple 200 response (JWT is stateless, client discards token)

### Task 9: Update Kong config for payment-service
- Add `/payments` → `http://payment-service:3000/payments`

### Task 10: Update Docker Compose for payment-service
- Uncomment payment-db, payment-service, migrate-payment
- Add payment-service to kong depends_on

### Task 11: Write RabbitMQ testing guide
- Full saga flow test (happy path)
- Failure scenario tests (stock fail, payment fail)
- RabbitMQ Management UI verification
- Curl commands for every step

---

## Saga Flow (end-to-end with compensation)

```
POST /orders
  → order-service: create order (ongoing), publish "order.created"
    → inventory-service: consume, check stock
      → OK: deduct stock, publish "inventory.reserved"
        → payment-service: consume, deduct coins
          → OK: payment (paid), publish "payment.completed"
            → order-service: consume, status = done
          → FAIL: payment (failed), publish "payment.failed"
            → order-service: consume, status = failed
            → order-service: publish "order.failed" (compensation)
              → inventory-service: consume, restore stock (rollback)
      → FAIL: publish "inventory.failed"
        → order-service: consume, status = failed
        → order-service: publish "order.failed" (no stock to rollback)
```

---

## Verification

1. `docker-compose up --build` — all services start without errors
2. Seed admin, create items, signup user
3. Create order → verify full saga completes (status = `done`)
4. Create order with excessive quantity → status = `failed` (inventory.failed)
5. Create order with insufficient coins → status = `failed` (payment.failed)
6. Check RabbitMQ Management UI at `http://localhost:15672`
7. Verify all events flow through the saga
