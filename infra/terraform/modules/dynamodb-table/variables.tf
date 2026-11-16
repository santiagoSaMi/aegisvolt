variable "name" {
  description = "Nombre completo de la tabla. Debe terminar en el ambiente: aegisvolt-<dominio>-<env>."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)*-(dev|test|prod)$", var.name)) && length(var.name) <= 255
    error_message = "name debe ser kebab-case y terminar en -dev, -test o -prod (p. ej. aegisvolt-billing-dev)."
  }
}

variable "hash_key" {
  description = "Atributo de partición (String)."
  type        = string
  default     = "PK"
}

variable "range_key" {
  description = "Atributo de ordenación (String). null si la tabla no tiene."
  type        = string
  default     = "SK"
}

variable "global_secondary_indexes" {
  description = "GSIs con proyección ALL; claves de tipo String."
  type = list(object({
    name      = string
    hash_key  = string
    range_key = optional(string)
  }))
  default = []

  validation {
    condition     = length(var.global_secondary_indexes) == length(distinct([for g in var.global_secondary_indexes : g.name]))
    error_message = "Los nombres de los GSIs deben ser únicos."
  }
}

variable "ttl_attribute" {
  description = "Atributo epoch (segundos) con el que DynamoDB expira ítems. null: sin TTL."
  type        = string
  default     = null
}

variable "point_in_time_recovery" {
  description = "Habilita PITR (backups continuos)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Impide borrar la tabla (DeleteTable falla) hasta desactivarla explícitamente."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
