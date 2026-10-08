FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# SQLite lives on a persistent volume mounted at /data. Platform volumes (Railway, Render)
# are mounted owned by root, so the process runs as root to be able to write there.
ENV DATABASE_PATH=/data/outreach.db
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "src/server.js"]
