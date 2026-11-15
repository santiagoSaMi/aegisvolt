variable "environment" {
  description = "Ambiente (coincide con el workspace): dev, test o prod."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment debe ser dev, test o prod."
  }
}

variable "services" {
  description = "Unidades desplegables (valor de service_name en los logs y de la etiqueta app.kubernetes.io/name)."
  type        = list(string)
  default = [
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
    "saga-orchestrator-service",
    "graphql-api",
    # Consola (nginx): logs de acceso en JSON con el mismo esquema (ADR-0028, ADR-0031).
    "web",
  ]
}

variable "saga_service" {
  description = "Servicio cuyos logs contienen los eventos de la SAGA."
  type        = string
  default     = "saga-orchestrator-service"
}

variable "fallback_group" {
  description = "Grupo de respaldo del colector para logs de pods sin etiqueta de servicio."
  type        = string
  default     = "unclassified"
}

variable "retention_in_days" {
  description = "Retención de los log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.retention_in_days)
    error_message = "retention_in_days debe ser un valor admitido por CloudWatch Logs."
  }
}

variable "service_error_threshold" {
  description = "Errores (level error/fatal) de un servicio en el período que disparan su alarma."
  type        = number
  default     = 5
}

variable "alarm_period_seconds" {
  description = "Período de evaluación de las alarmas de errores."
  type        = number
  default     = 300
}

variable "alarm_actions" {
  description = "ARNs a notificar (p. ej. un tópico SNS). Vacío: solo cambia el estado."
  type        = list(string)
  default     = []
}
