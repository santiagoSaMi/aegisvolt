variable "floci_endpoint" {
  description = "Endpoint de Floci. Solo se aceptan endpoints locales (CLAUDE.md: nunca AWS real)."
  type        = string
  default     = "http://localhost:4566"

  validation {
    condition     = can(regex("^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?$", var.floci_endpoint))
    error_message = "floci_endpoint debe ser local (http://localhost:<puerto>). No se permite AWS real."
  }
}
