# Ambiente prod: debe usarse con el workspace prod (la guarda del plan lo comprueba).
environment        = "prod"
vpc_cidr           = "10.30.0.0/16"
single_nat_gateway = false # un NAT por AZ: sin punto único de falla

# EKS apagado en Floci: no caben tres k3s en la memoria de la máquina local (L-11).
eks = {
  enabled                = false
  endpoint_public_access = false # API server solo privado (VPCE eks); L-03: Floci no lo aplica
  node_instance_types    = ["t3.large"]
  node_min_size          = 2
  node_desired_size      = 3
  node_max_size          = 6
}

dynamodb = {
  point_in_time_recovery = true
  deletion_protection    = true
}

observability = {
  retention_in_days       = 30
  service_error_threshold = 3
}

api = {
  listener_port          = 18083 # distinto por ambiente: en Floci los listeners comparten contenedor
  throttling_rate_limit  = 500
  throttling_burst_limit = 1000
}
