# web: consola SPA (React + Vite) servida por nginx sin privilegios.
# Contexto de build: raíz del repositorio.
#   docker build -f apps/web/Dockerfile -t aegisvolt/web:sha-<commit> .
# ADR-0031: el bundle no contiene configuración; config.json, el ambiente y los
# upstreams llegan por variables de entorno al arrancar (misma imagen en dev/test/prod).

ARG NODE_IMAGE=node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

# --- 1. Dependencias (lockfile) -----------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV CI=true PNPM_STORE=/pnpm/store
RUN npm install --global --ignore-scripts pnpm@12.18.0 && npm cache clean --force \
 # Un único store para fetch, install, run y deploy (cache mount de BuildKit).
 && pnpm config set store-dir $PNPM_STORE --global
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=aegisvolt-pnpm,target=/pnpm/store \
    pnpm fetch

# --- 2. Build del bundle estático -----------------------------------------------------
FROM deps AS build
COPY package.json tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN --mount=type=cache,id=aegisvolt-pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@aegisvolt/web..." \
 && pnpm --filter "@aegisvolt/web..." run build \
 # config.json lo genera nginx desde el entorno: no se publica el de desarrollo.
 && rm -f apps/web/dist/config.json

# --- 3. Runtime: nginx sin privilegios (uid 101), puerto 8080 --------------------------
FROM ${NGINX_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="web" \
      org.opencontainers.image.source="aegisvolt" \
      org.opencontainers.image.revision="${GIT_SHA}"
# Parche de seguridad sobre la base fijada (gate CRITICAL de trivy-images, ADR-0035):
# brotli-libs 1.2.1-r0 corrige CVE-2026-111497 (escritura fuera de límites en el decodificador)
# y se publicó en Alpine 3.24 el 2026-10-22. La última nginx-unprivileged:1.30-alpine
# (1.30.6, 2026-10-19) aún trae 1.2.0-r1. Retirar cuando una base nueva lo incluya.
# La restricción >= hace fallar el build si el repositorio no ofrece la versión corregida.
USER root
RUN apk add --no-cache --upgrade 'brotli-libs>=1.2.1-r0'
# Valores por defecto NO sensibles; APP_ENV, COGNITO_CLIENT_ID y los upstreams son obligatorios.
ENV WEB_POLLING_INTERVAL_MS=5000 \
    WEB_CITIES_JSON='["bogota"]' \
    SERVICE_VERSION=${GIT_SHA}
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/docker/10-validate-env.sh /docker-entrypoint.d/10-validate-env.sh
COPY apps/web/docker/nginx.conf /etc/nginx/nginx.conf
USER 101
EXPOSE 8080
# nginx termina las conexiones en curso al recibir SIGQUIT (apagado ordenado).
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
