# AegisVolt en docker compose (integrado con Floci)

Las seis imágenes en la red Docker de Floci (`aegisvolt-floci`). Dentro de la red, los contenedores usan `http://floci:4566` y los nombres de servicio, nunca `localhost`. Decisión: [ADR-0031](../../../docs/adr/0031-contenedores-kubernetes-floci.md). Comandos y troubleshooting: [runbook](../../../docs/runbooks/kubernetes.md#2-ejecución-local-con-docker-compose).

```bash
scripts/floci/start.sh
scripts/local/compose.sh up      # bootstrap del ambiente `local`, build (tag inmutable) y arranque
scripts/local/compose.sh seed
scripts/local/compose.sh down
```

Consola en http://127.0.0.1:8080. Los puertos se publican solo en loopback.
