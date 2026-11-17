variable "environment" {
  description = "Ambiente (dev, test o prod): forma parte de los nombres de los roles."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment debe ser dev, test o prod."
  }
}

variable "cluster_name" {
  description = "Clúster EKS del ambiente: el único que puede asumir los roles."
  type        = string
}

variable "feature_flags_table_arn" {
  description = "ARN de la tabla de feature flags del ambiente."
  type        = string
}

variable "workloads" {
  description = <<-EOT
    Rol por carga de trabajo, con clave = nombre corto del rol.
    - namespace/service_account: ServiceAccount de Kubernetes asociado (Pod Identity).
    - table_arn: tabla propia (lectura y escritura) o null.
    - feature_flags: none | read | read_write.
    - extra_statements: permisos adicionales explícitos (p. ej. CloudWatch).
  EOT
  type = map(object({
    namespace       = string
    service_account = string
    table_arn       = optional(string)
    feature_flags   = optional(string, "none")
    extra_statements = optional(list(object({
      sid       = string
      actions   = list(string)
      resources = list(string)
    })), [])
  }))

  validation {
    condition     = alltrue([for w in values(var.workloads) : contains(["none", "read", "read_write"], w.feature_flags)])
    error_message = "feature_flags debe ser none, read o read_write."
  }

  validation {
    condition = alltrue(flatten([
      for w in values(var.workloads) : [
        for st in w.extra_statements :
        length(st.actions) > 0 && alltrue([for a in st.actions : a != "*" && !endswith(a, ":*")])
      ]
    ]))
    error_message = "extra_statements no admite acciones comodín (\"*\" o \"servicio:*\"). El recurso \"*\" solo para acciones sin permisos a nivel de recurso (p. ej. cloudwatch:GetMetricData)."
  }
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
