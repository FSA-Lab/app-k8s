FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/inventory-service/package.json ./services/inventory-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
COPY services/inventory-service ./services/inventory-service
COPY shared/packages ./shared/packages
RUN npx esbuild services/inventory-service/src/index.ts \
    --bundle --platform=node --format=cjs \
    --outfile=services/inventory-service/dist/bundle.js \
    --external:bcrypt --external:pg --external:pg-native \
    --external:pino --external:pino-opentelemetry-transport \
    --external:thread-stream
WORKDIR /app/services/inventory-service
EXPOSE 3000
CMD ["node", "dist/bundle.js"]
