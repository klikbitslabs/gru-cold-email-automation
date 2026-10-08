# --- Build stage: native modules (better-sqlite3) may need to compile from source
# when no prebuilt binary matches the Node version, which needs python3, make and g++.
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Runtime stage: same base image (same glibc/Node ABI), without the build toolchain.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# SQLite lives on a persistent volume mounted at /data. Platform volumes (Railway, Render)
# are mounted owned by root, so the process runs as root to be able to write there.
ENV DATABASE_PATH=/data/outreach.db
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "src/server.js"]
