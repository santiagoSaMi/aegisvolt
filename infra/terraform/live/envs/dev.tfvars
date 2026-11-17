# Ambiente dev: debe usarse con el workspace dev (la guarda del plan lo comprueba).
environment        = "dev"
vpc_cidr           = "10.10.0.0/16"
single_nat_gateway = true

eks = {
  enabled                = true
  endpoint_public_access = false # API server solo privado (VPCE eks); L-03: Floci no lo aplica
  node_instance_types    = ["t3.large"]
  node_min_size          = 1
  node_desired_size      = 1
  node_max_size          = 2
}

dynamodb = {
  point_in_time_recovery = false
  deletion_protection    = false
}

observability = {
  retention_in_days       = 7
  service_error_threshold = 5
}

api = {
  listener_port          = 18081 # distinto por ambiente: en Floci los listeners comparten contenedor
  throttling_rate_limit  = 50
  throttling_burst_limit = 100
}
