# Build stage
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/order-service/package.json ./services/order-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN npm install
COPY services/order-service ./services/order-service
COPY shared/packages ./shared/packages
RUN npx esbuild services/order-service/src/index.ts \
    --bundle --platform=node --format=cjs \
    --outfile=services/order-service/dist/bundle.js \
    --external:bcrypt --external:pg --external:pg-native

# Production stage
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/order-service/package.json ./services/order-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN npm ci --omit=dev
COPY --from=build /app/services/order-service/dist/bundle.js ./services/order-service/dist/bundle.js
WORKDIR /app/services/order-service
EXPOSE 3000
CMD ["node", "dist/bundle.js"]
