# ── Build: compila el panel (Vite) y el servidor (tsup) ─────────────
FROM node:22-slim AS build
WORKDIR /app
# Herramientas por si better-sqlite3 no encuentra binario precompilado para la plataforma.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ── Runtime ─────────────────────────────────────────────────────────
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=America/El_Salvador
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Base de datos SQLite y tarjetas generadas: montar como volumen persistente en Dokploy.
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
