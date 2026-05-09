FROM node:24-slim

WORKDIR /app

# Copy root package.json and workspace definition
COPY package.json ./

# Copy packages
COPY services/inventory-service ./services/inventory-service
COPY shared/packages ./shared/packages

# Install dependencies for workspaces
RUN npm install

WORKDIR /app/services/inventory-service

EXPOSE 3000

CMD ["npm", "run", "start"]
