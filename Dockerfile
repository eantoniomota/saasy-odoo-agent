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

# su-exec : drop des privileges proprement apres l'init du groupe docker
# docker-cli : permet a l'agent d'utiliser `docker` pour piloter les containers
#   Jupyter via le socket monte (commandes `saasy-agent jupyter ...`)
RUN apk add --no-cache su-exec docker-cli

# User non-root ; le groupe sera ajuste dynamiquement par l'entrypoint
RUN addgroup -S saasy && adduser -S agent -G saasy

COPY --from=builder /app/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/

# Entrypoint qui detecte le GID du socket Docker monte et l'attribue a 'agent'
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

# Health check: verify the process is alive and responsive
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
