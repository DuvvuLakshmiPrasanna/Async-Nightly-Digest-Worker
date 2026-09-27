# Shared image for the api, worker, and migrate services.
# Which process runs is decided by docker-compose.yml's `command:`
# override for each service - this keeps one build for the whole stack.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source.
COPY src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production

EXPOSE 3000

# Default command (overridden for worker/migrate in docker-compose.yml).
CMD ["node", "src/api/server.js"]
