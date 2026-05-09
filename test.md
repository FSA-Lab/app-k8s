# Auth, Inventory, and Kong Gateway Setup Complete

I've completed the implementation based on the approved plan. Here's a summary of what was done and how you can test it locally.

## What Was Changed

### 1. NPM Workspaces
Set up a root `package.json` with NPM Workspaces enabled. This allows the microservices to easily import code from `shared/packages` without publishing them to an npm registry.

### 2. Shared Auth Package (`@shared/auth`)
Created a shared package with the following features:
- `generateToken(payload)`: Helper to sign a JWT.
- `authMiddleware`: Express middleware that extracts the `Authorization: Bearer <token>` header and verifies it, injecting the decoded `req.user`.
- `adminMiddleware`: Express middleware that checks if `req.user.role === 'admin'`.

### 3. Auth Service
- Implemented `/signup` to create users.
- Implemented `/login` to generate JWT tokens.
- Implemented `/seed-admin` to easily create an admin account for testing.
- Implemented `/me` using the shared `authMiddleware`.
- Created a `Dockerfile` that installs the workspace dependencies and runs the service.

### 4. Inventory Service
- Updated the existing mock middlewares to use `@shared/auth`. Now the `GET /items`, `POST /items`, and `PATCH /items/:id/stock` routes are fully secured by actual JWTs.
- Created a `Dockerfile`.

### 5. Kong Gateway
Created `kong/kong.yml` in DB-less mode. It maps:
- `http://localhost:8000/auth/*` -> `http://auth-service:3000/*`
- `http://localhost:8000/items/*` -> `http://inventory-service:3000/items/*`

### 6. Docker Compose
Updated `docker-compose.yml` with the full stack required for these two services:
- **kong** on port 8000
- **auth-service** (and its Postgres DB)
- **inventory-service** (and its Postgres DB)
- **rabbitmq**

## How to Test Locally

You can test the entire stack by following these steps:

**Admin**

1. **Start the environment:**
   ```bash
   docker-compose up --build
   ```

2. **Wait for services to start:**
   Ensure Kong, RabbitMQ, and the two node services are fully initialized. It might take a few seconds on the first run as it builds the Docker images and connects to the databases.

3. **Test Kong Routing and Auth Service:**
   Use a tool like `curl` or Postman to hit the API Gateway (port 8000).
   ```bash
   # Seed an admin user
   curl -X POST http://localhost:8000/auth/seed-admin \
     -H "Content-Type: application/json" \
     -d '{"name": "Admin", "email": "admin@test.com", "password": "password"}'

   # Login
   curl -X POST http://localhost:8000/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "admin@test.com", "password": "password"}'
   ```
   *Copy the token returned from the login request.*

4. **Test Inventory Service:**
   Use the token to access the protected inventory routes via Kong.
   ```bash
   # Create an item (requires admin token)
   curl -X POST http://localhost:8000/items \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <YOUR_TOKEN_HERE>" \
     -d '{"name": "Sword", "stock": 10, "price": 500}'

   # List items
   curl -X GET http://localhost:8000/items \
     -H "Authorization: Bearer <YOUR_TOKEN_HERE>"
   ```

**User**

```bash
# Signup
curl -X POST http://localhost:8000/auth/signup `
     -H "Content-Type: application/json" `
     -d '{
       "name": "John Doe",
       "email": "john@example.com",
       "password": "securepassword123"
     }'

# Login
curl -X POST http://localhost:8000/auth/login `
     -H "Content-Type: application/json" `
     -d '{
       "email": "john@example.com",
       "password": "securepassword123"
     }'

curl -X GET http://localhost:8000/auth/me `
    -H "Authorization: Bearer <YOUR_TOKEN_HERE>"
```
