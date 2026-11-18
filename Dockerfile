# -------------------------------------------------------------
# Stage 1: Base with system build tools
# -------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl python3 make g++
COPY package*.json tsconfig.json ./

# -------------------------------------------------------------
# Stage 2: Development (Hot-reloading with tsx for local demo)
# -------------------------------------------------------------
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY src ./src
COPY public ./public
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

# -------------------------------------------------------------
# Stage 3: Builder (Compiles TypeScript & packages migrations)
# -------------------------------------------------------------
FROM base AS builder
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --production

# -------------------------------------------------------------
# Stage 4: Production Runtime (Minimal, Non-Root, Hardened)
# -------------------------------------------------------------
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Copy production artifacts with unprivileged node ownership
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public

# Switch to non-root user (UID 1000)
USER node

EXPOSE 3000

# Container healthcheck using Node.js built-in HTTP client
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/api/server.js"]
