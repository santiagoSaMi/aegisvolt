# Refactorizaciones sin recrear recursos: Terraform mueve las direcciones en el estado.

# El módulo observability pasó a llamarse cloudwatch (ADR-0033). Sin este bloque, el plan
# destruiría y recrearía los log groups (y sus logs) de los tres ambientes.
moved {
  from = module.observability
  to   = module.cloudwatch
}
