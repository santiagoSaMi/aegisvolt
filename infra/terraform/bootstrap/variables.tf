variable "target" {
  description = "Destino: floci (local) o aws."
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
  type    = string
  default = "us-east-1"
}

variable "allowed_account_ids" {
  description = "Cuentas en las que el provider acepta operar."
  type        = list(string)

  validation {
    condition     = length(var.allowed_account_ids) > 0 && alltrue([for a in var.allowed_account_ids : can(regex("^[0-9]{12}$", a))])
    error_message = "allowed_account_ids debe tener al menos un ID de cuenta de 12 dígitos."
  }
}

variable "state_bucket" {
  description = "Nombre del bucket del estado remoto."
  type        = string
  default     = "aegisvolt-tfstate"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket))
    error_message = "state_bucket debe ser un nombre de bucket S3 válido."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Días que se conservan las versiones anteriores del estado (además de las últimas 10)."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Conserve al menos 30 días de versiones anteriores del estado."
  }
}
