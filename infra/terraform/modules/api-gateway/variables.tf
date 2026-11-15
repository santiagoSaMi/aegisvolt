variable "environment" {
  description = "Ambiente (dev, test o prod): nombre de los recursos y del stage."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment debe ser dev, test o prod."
  }
}

variable "vpc_id" {
  description = "VPC del ambiente."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subredes privadas donde vive el NLB interno."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "El NLB interno necesita subredes en al menos dos AZs."
  }
}

variable "listener_port" {
  description = "Puerto del listener del NLB."
  type        = number
  default     = 80
}

variable "target_port" {
  description = "Puerto del ingress del clúster en los targets ip (Traefik)."
  type        = number
  default     = 8000
}

variable "health_check_path" {
  description = "Ruta HTTP de salud del ingress para el target group."
  type        = string
  default     = "/healthz"
}

variable "integration_base_url" {
  description = "Base de la URI de integración. null: el DNS del NLB. En Floci: http://floci:<puerto> (L-01)."
  type        = string
  default     = null

  validation {
    condition     = var.integration_base_url == null || can(regex("^https?://[a-z0-9.-]+(:[0-9]+)?$", var.integration_base_url))
    error_message = "integration_base_url debe ser una URL http(s)://host[:puerto] sin ruta."
  }
}

variable "integration_timeout_ms" {
  description = "Timeout de la integración (máximo 29000 en REST)."
  type        = number
  default     = 29000

  validation {
    condition     = var.integration_timeout_ms >= 50 && var.integration_timeout_ms <= 29000
    error_message = "integration_timeout_ms debe estar entre 50 y 29000."
  }
}

variable "create_private_api" {
  description = "Crear la API PRIVATE (/ops) accesible solo por el VPCE execute-api."
  type        = bool
  default     = true
}

variable "execute_api_vpc_endpoint_id" {
  description = "Interface VPCE execute-api del ambiente (obligatorio si create_private_api)."
  type        = string
  default     = null
}

variable "throttling_rate_limit" {
  description = "Peticiones por segundo sostenidas por stage."
  type        = number
  default     = 100
}

variable "throttling_burst_limit" {
  description = "Ráfaga máxima por stage."
  type        = number
  default     = 200
}

variable "log_retention_in_days" {
  description = "Retención del log group de acceso."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
