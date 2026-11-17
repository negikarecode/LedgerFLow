FROM node:22-alpine

WORKDIR /app

# Install dependencies required for any native builds
RUN apk add --no-cache curl python3 make g++

# Install project dependencies
COPY package*.json ./
RUN npm install

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build TypeScript to dist
RUN npm run build

# Expose API port
EXPOSE 3000

# Default to development hot-reload mode with tsx
CMD ["npm", "run", "dev"]
