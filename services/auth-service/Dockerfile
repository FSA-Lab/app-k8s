FROM node:24-slim

WORKDIR /app

# Copy root package.json and workspace definition
COPY package.json package-lock.json* ./

# Copy packages
COPY services/auth-service ./services/auth-service
COPY shared/packages ./shared/packages

# Install dependencies for workspaces
RUN npm install

WORKDIR /app/services/auth-service

EXPOSE 3000

CMD ["npm", "run", "start"]
