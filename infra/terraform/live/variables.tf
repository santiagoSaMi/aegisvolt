# --- Destino (config/<destino>/target.tfvars) ---------------------------------------------------

variable "target" {
  description = "Destino del despliegue: floci (local) o aws."
  type        = string

  validation {
    condition     = contains(["floci", "aws"], var.target)
    error_message = "target debe ser floci o aws."
  }
}

variable "floci_endpoint" {
  description = "Endpoint de Floci. Obligatorio y local con target=floci; null con target=aws."
  type        = string
  default     = null

  validation {
    condition = (
      var.target == "floci"
      ? var.floci_endpoint != null && can(regex("^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?$", var.floci_endpoint))
      : var.floci_endpoint == null
    )
    error_message = "Con target=floci, floci_endpoint debe ser http://localhost:<puerto> (nunca AWS real); con target=aws debe ser null."
  }
}

variable "aws_region" {
  description = "Región del despliegue."
  type        = string
  default     = "us-east-1"
}

variable "allowed_account_ids" {
  description = "Cuentas en las que el provider acepta operar (en AWS: una cuenta por ambiente)."
  type        = list(string)

  validation {
    condition     = length(var.allowed_account_ids) > 0 && alltrue([for a in var.allowed_account_ids : can(regex("^[0-9]{12}$", a))])
    error_message = "allowed_account_ids debe tener al menos un ID de cuenta de 12 dígitos."
  }
}

variable "floci_ingress_host" {
  description = "Host con el que API Gateway de Floci alcanza el listener del NLB (L-01: el DNS *.elb no resuelve). Solo con target=floci."
  type        = string
  default     = null

  validation {
    condition     = var.floci_ingress_host == null || (var.target == "floci" && can(regex("^[a-z0-9.-]+$", var.floci_ingress_host)))
    error_message = "floci_ingress_host solo se admite con target=floci y debe ser un nombre de host."
  }
}

variable "ingress_target_port" {
  description = "Puerto de los targets del NLB: 8000 (pods de Traefik) en AWS; en Floci, el NodePort de Traefik en el contenedor k3s."
  type        = number
  default     = 8000

  validation {
    condition     = var.ingress_target_port > 0 && var.ingress_target_port < 65536
    error_message = "ingress_target_port debe ser un puerto TCP válido."
  }
}

# --- Ambiente (envs/<env>.tfvars) ----------------------------------------------------------------

variable "environment" {
  description = "Ambiente del archivo envs/<env>.tfvars. Debe coincidir con el workspace."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment debe ser dev, test o prod."
  }
}

variable "vpc_cidr" {
  description = "CIDR /16 de la VPC del ambiente."
  type        = string
}

variable "single_nat_gateway" {
  description = "Un NAT compartido (true) o uno por AZ (false)."
  type        = bool
}

variable "eks" {
  description = "Clúster del ambiente. enabled=false: no se crea (memoria de Floci, L-11)."
  type = object({
    enabled                = bool
    kubernetes_version     = optional(string, "1.36")
    endpoint_public_access = bool
    public_access_cidrs    = optional(list(string), [])
    node_instance_types    = list(string)
    node_min_size          = number
    node_desired_size      = number
    node_max_size          = number
  })
}

variable "dynamodb" {
  description = "Protección de las tablas del ambiente."
  type = object({
    point_in_time_recovery = bool
    deletion_protection    = bool
  })
}

variable "observability" {
  description = "Retención de logs y umbral de las alarmas de errores."
  type = object({
    retention_in_days       = number
    service_error_threshold = number
  })
}

variable "api" {
  description = "Entrada: puerto del listener del NLB y throttling por stage."
  type = object({
    listener_port          = number
    throttling_rate_limit  = number
    throttling_burst_limit = number
  })
}
