# billing-wallet-service: billeteras, cobros y reembolsos (Node 26).
# Contexto de build: raíz del repositorio (usa los paquetes del workspace).
#   docker build -f services/billing-wallet/Dockerfile -t aegisvolt/billing-wallet:sha-<commit> .
# ADR-0031: multi-stage, base fijada por digest, dependencias de producción aisladas
# con `pnpm deploy --prod`, usuario no root y configuración solo por variables de entorno.

ARG NODE_IMAGE=node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

# --- 1. Dependencias: solo el lockfile (capa reutilizable mientras no cambie) ---------
FROM ${NODE_IMAGE} AS deps
ENV CI=true PNPM_STORE=/pnpm/store
RUN npm install --global --ignore-scripts pnpm@12.18.0 && npm cache clean --force \
 # Un único store para fetch, install, run y deploy (cache mount de BuildKit).
 && pnpm config set store-dir $PNPM_STORE --global
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=aegisvolt-pnpm,target=/pnpm/store \
    pnpm fetch

# --- 2. Build: paquetes del workspace + la app, y paquete de producción aislado --------
# `deploy` sin --offline: pnpm 12 vuelve a verificar las políticas de cadena de suministro
# del lockfile de /out y necesita los metadatos completos del registro (el store ya tiene
# los paquetes; solo se leen metadatos). Con --offline falla en una caché limpia (CI).
FROM deps AS build
COPY package.json tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY services/billing-wallet ./services/billing-wallet
RUN --mount=type=cache,id=aegisvolt-pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@aegisvolt/billing-wallet-service..." \
 && pnpm --filter "@aegisvolt/billing-wallet-service..." run build \
 && pnpm --filter "@aegisvolt/billing-wallet-service" deploy --prod /out \
 && rm -f /out/pnpm-lock.yaml /out/pnpm-workspace.yaml

# --- 3. Runtime: solo Node y el paquete de producción ----------------------------------
FROM ${NODE_IMAGE} AS runtime
# Sin gestores de paquetes en ejecución (menos superficie de ataque).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="billing-wallet" \
      org.opencontainers.image.source="aegisvolt" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production \
    PORT=4102 \
    SERVICE_VERSION=${GIT_SHA}
WORKDIR /app
# Archivos de root y de solo lectura para el usuario de ejecución.
COPY --from=build /out/ ./
USER node
EXPOSE 4102
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4102)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node como PID 1 recibe SIGTERM directamente: el servicio cierra el servidor HTTP
# y termina las peticiones en curso (graceful shutdown).
CMD ["node", "dist/main.js"]
