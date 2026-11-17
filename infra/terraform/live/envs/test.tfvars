# Ambiente test: debe usarse con el workspace test (la guarda del plan lo comprueba).
environment        = "test"
vpc_cidr           = "10.20.0.0/16"
single_nat_gateway = true

# EKS apagado en Floci: no caben tres k3s en la memoria de la máquina local (L-11).
# El módulo se valida con: terraform plan -var-file=... -var 'eks={...enabled=true...}'.
eks = {
  enabled                = false
  endpoint_public_access = false # API server solo privado (VPCE eks); L-03: Floci no lo aplica
  node_instance_types    = ["t3.large"]
  node_min_size          = 1
  node_desired_size      = 2
  node_max_size          = 3
}

dynamodb = {
  point_in_time_recovery = true
  deletion_protection    = false
}

observability = {
  retention_in_days       = 14
  service_error_threshold = 5
}

api = {
  listener_port          = 18082 # distinto por ambiente: en Floci los listeners comparten contenedor
  throttling_rate_limit  = 100
  throttling_burst_limit = 200
}
