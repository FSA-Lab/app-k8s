# Build stage
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/auth-service/package.json ./services/auth-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN npm install
COPY services/auth-service ./services/auth-service
COPY shared/packages ./shared/packages
RUN npx esbuild services/auth-service/src/index.ts \
    --bundle --platform=node --format=cjs \
    --outfile=services/auth-service/dist/bundle.js \
    --external:bcrypt --external:pg --external:pg-native

# Production stage
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/auth-service/package.json ./services/auth-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN npm ci --omit=dev
COPY --from=build /app/services/auth-service/dist/bundle.js ./services/auth-service/dist/bundle.js
COPY --from=build /app/services/auth-service/drizzle.config.ts ./services/auth-service/drizzle.config.ts
COPY --from=build /app/services/auth-service/src/db/schema.ts ./services/auth-service/src/db/schema.ts
WORKDIR /app/services/auth-service
EXPOSE 3000
CMD ["node", "dist/bundle.js"]
