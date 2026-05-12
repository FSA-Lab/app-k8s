FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/order-service/package.json ./services/order-service/
COPY shared/packages/auth/package.json ./shared/packages/auth/
COPY shared/packages/events/package.json ./shared/packages/events/
COPY shared/packages/tracing/package.json ./shared/packages/tracing/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
COPY services/order-service ./services/order-service
COPY shared/packages ./shared/packages
RUN npx esbuild services/order-service/src/index.ts \
    --bundle --platform=node --format=cjs \
    --outfile=services/order-service/dist/bundle.js \
    --external:bcrypt --external:pg --external:pg-native \
    --external:pino --external:pino-opentelemetry-transport \
    --external:thread-stream
WORKDIR /app/services/order-service
EXPOSE 3000
CMD ["node", "dist/bundle.js"]
