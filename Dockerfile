# syntax=docker/dockerfile:1

# ── 1) deps: semua dependency (untuk build) ──
FROM node:20-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── 2) build: generate Prisma client + compile TypeScript ──
FROM deps AS build
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ── 3) prod-deps: hanya dependency produksi (prisma CLI ada di dependencies untuk migrate deploy) ──
FROM node:20-bookworm-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

# ── 4) runtime ──
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prisma ./prisma
COPY scripts/docker-entrypoint.sh scripts/migrate-deploy.sh ./scripts/
RUN chmod +x scripts/*.sh && mkdir -p /data/uploads && chown -R node:node /data /app
USER node
VOLUME ["/data/uploads"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
