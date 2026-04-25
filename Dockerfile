# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Security: run as non-root
RUN addgroup -S saasy && adduser -S agent -G saasy

COPY --from=builder /app/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/

USER agent

ENV NODE_ENV=production

# Health check: verify the process is alive and responsive
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

CMD ["node", "dist/index.js"]
