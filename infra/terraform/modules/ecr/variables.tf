variable "name_prefix" {
  description = "Prefijo de los repositorios (<prefijo>/<app>)."
  type        = string
  default     = "aegisvolt"

  validation {
    condition     = can(regex("^[a-z0-9]+([._-][a-z0-9]+)*$", var.name_prefix))
    error_message = "name_prefix debe ser un nombre de repositorio ECR válido en minúsculas."
  }
}

variable "repositories" {
  description = "Una imagen por unidad desplegable."
  type        = list(string)

  validation {
    condition     = length(var.repositories) > 0 && length(var.repositories) == length(distinct(var.repositories))
    error_message = "repositories no puede estar vacío ni tener duplicados."
  }
}

variable "untagged_expiration_days" {
  description = "Días tras los que se expiran las imágenes sin etiqueta."
  type        = number
  default     = 7
}

variable "max_tagged_images" {
  description = "Imágenes sha-* que se conservan por repositorio."
  type        = number
  default     = 30

  validation {
    condition     = var.max_tagged_images >= 5
    error_message = "Conserve al menos 5 imágenes para poder hacer rollback."
  }
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
