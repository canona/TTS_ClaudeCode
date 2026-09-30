# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js standalone output.
# Final image: node:22-alpine + server.js + traced node_modules (~200 MB).

ARG NODE_VERSION=22-alpine

# ── 1. Dependencies ────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── 2. Build ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── 3. Runtime ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3102 \
    HOSTNAME=0.0.0.0 \
    CACHE_DIR=/app/.tts-cache \
    VOICES_DIR=/app/.voices \
    CLIENTS_FILE=/app/.clients/clients.json \
    USAGE_DIR=/app/.usage

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# Standalone server + static assets (standalone doesn't include them by design)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Partner API client management: docker compose exec tts node scripts/clients.mjs …
COPY --from=builder --chown=nextjs:nodejs /app/scripts/clients.mjs ./scripts/clients.mjs

# Persistent chunk cache: mount a volume at /app/.tts-cache to keep it across deploys.
# (No VOLUME instruction on purpose – Railway rejects Dockerfiles that use it.)
RUN mkdir -p /app/.tts-cache /app/.voices /app/.clients /app/.usage \
 && chown nextjs:nodejs /app/.tts-cache /app/.voices /app/.clients /app/.usage

USER nextjs
EXPOSE 3102

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "server.js"]
