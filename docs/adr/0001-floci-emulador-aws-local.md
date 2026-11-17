# ADR-0001: Floci como emulador AWS local, ejecutado con Docker Compose fijado

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

La especificación (§2.4) permite AWS real o un entorno compatible como Floci. Floci es la herramienta indicada por el profesor y el proyecto la adopta como emulador **obligatorio**. Las reglas del repositorio prohíben `terraform apply` y credenciales reales contra AWS.

Hay tres formas de ejecutar Floci:
- Floci CLI (`floci start`);
- `docker run` / Docker Compose;
- binario nativo `floci-aws`.

La imagen publicada usa por defecto `FLOCI_STORAGE_MODE=memory`, que no persiste estado entre reinicios. EKS, ECR, EC2 y Lambda necesitan el socket de Docker para crear contenedores hermanos.

## Decisión

1. Ejecutar Floci con un **`docker-compose.yml` versionado** en `infra/local/floci/`. Se elige frente al CLI por estas razones:
   - fija la imagen con su versión exacta (`floci/floci:2.4.0`);
   - publica el puerto solo en `127.0.0.1:4566`;
   - fija `FLOCI_STORAGE_MODE=persistent` con bind mount a `infra/local/floci/data`;
   - monta `/var/run/docker.sock`;
   - ejecuta el contenedor con el UID/GID del usuario.
   Es reproducible en otro equipo y en CI. El CLI 0.4.0 queda como herramienta auxiliar (`floci doctor`).
2. Usar el modo **`persistent`** en lugar de `hybrid`, porque escribe de forma síncrona y no pierde lotes pendientes al reiniciar. El coste de rendimiento es irrelevante en desarrollo local.
3. Acceder siempre a través de **scripts idempotentes** (`scripts/floci/*.sh`):
   - nunca ejecutan `down -v` ni borran `data/`;
   - abortan si el endpoint no es local o si la credencial no es la ficticia.
4. Configurar Terraform con un **provider con `endpoints` explícitos por servicio** y un **backend S3 configurado aparte** (`-backend-config`): `endpoints.s3`, `use_path_style` y `use_lockfile`.

## Consecuencias

- **Positivas:**
  - Entorno local reproducible y sin costo, con el estado conservado entre sesiones.
  - Versión de Floci auditable en Git.
  - S3 con versionado, DynamoDB con escrituras condicionales, CloudWatch Logs, API Gateway REST, ECR y EKS (k3s) verificados con smoke tests.
- **Negativas / riesgos:**
  - El networking privado (VPC, VPC Endpoints, API Gateway `PRIVATE`) es **solo metadatos**: no hay aislamiento de red real. Ver [`docs/limitations.md`](../limitations.md).
  - EKS es k3s, no un plano de control administrado.
  - Montar el socket de Docker da a Floci control sobre el daemon del host. Se acepta porque solo es para desarrollo local y el puerto 4566 está limitado a loopback.
  - Actualizar Floci requiere cambiar el tag, volver a ejecutar los smoke tests y actualizar la matriz del README.
