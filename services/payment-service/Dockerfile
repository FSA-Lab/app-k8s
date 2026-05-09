FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
COPY services/payment-service ./services/payment-service
COPY shared/packages ./shared/packages

RUN npm install

WORKDIR /app/services/payment-service

EXPOSE 3000

CMD ["npm", "run", "start"]
