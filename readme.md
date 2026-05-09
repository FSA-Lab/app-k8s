# This ia project that is not production grade but lab

The app is microservice app that has these services:

- auth-service: for user authentication
- inventory-service: for item inventory
- order-service: for order management
- payment-service: for payment processing (fake this one)

each has its own db and all is drizzle with js node. the app run in k8s microservice. lets assume i have frontend static page that call api to k8s kong gateway 

## Phase 1:
i want an example for this app that can run docker compose locally

### Data schema:
**(inventory-service)**
item:
-id
-name
-stock
-price

**(order-service)**
order_item:
-id
-order_id (one to one)
-item_id (one to one)
-quantity
-price_at_purchase

order:
-id
-user_id (one to one)
-total_price
-status(done, ongoing, failed)

**(payment-service)**
payment:
-id
-order_id (one to one)
-price
-status(paid, failed)

**(auth-service)**
user:
-id
-name
-email
-password_hash
-role(user, admin)
-coin

### Folder structure:
/kong (for routing the endpoint)
/auth (user sign up, admin seed)
/inventory (crud)
/order (crud)
/payment (crud)
/rabbitmq
/shared/packages
    /auth
    /events


### Routes

**Auth**
POST /signup
- user sign up (user default has 1000 coins)

POST /login
- user login

GET /me
- get current user

POST /logout
- user logout

POST /seed-admin
- admin seed user(script)

**Inventory**
GET /items
- list inventory 

POST /items (admin only)
- create item

PATCH /items/:id 
- update the stock (for queue to consume and update the stock)


**Order**
GET /order
- list order (include order items)

GET /order/:id
- get single order (include order items)

POST /order (require auth)
- create order (saga)

**Payment**
GET /payment
- list payment

POST /payment (require auth)
- pay (fake, coin deduct from user coins)

**rabbitmq event**
ORDER_CREATED: "order.created",
INVENTORY_RESERVED: "inventory.reserved",
INVENTORY_FAILED: "inventory.failed",
PAYMENT_COMPLETED: "payment.completed",

## phase 2: (todo later)