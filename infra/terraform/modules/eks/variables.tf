variable "cluster_name" {
  description = "Nombre del clúster: aegisvolt-<env>."
  type        = string

  validation {
    condition     = can(regex("^aegisvolt-(dev|test|prod)$", var.cluster_name))
    error_message = "cluster_name debe ser aegisvolt-dev, aegisvolt-test o aegisvolt-prod."
  }
}

variable "kubernetes_version" {
  description = "Versión de Kubernetes (Floci 2.4.0 la ejecuta con k3s v1.36)."
  type        = string
  default     = "1.36"

  validation {
    condition     = can(regex("^1\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version debe tener la forma 1.NN."
  }
}

variable "subnet_ids" {
  description = "Subredes PRIVADAS del ambiente (al menos dos AZs)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "EKS exige subredes en al menos dos AZs."
  }
}

variable "endpoint_public_access" {
  description = "Exponer el API server públicamente (solo dev; test y prod: solo privado vía VPCE eks)."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  description = "CIDRs admitidos en el endpoint público (si está habilitado)."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.public_access_cidrs, "0.0.0.0/0")
    error_message = "No se admite 0.0.0.0/0: indique los CIDRs de operación."
  }
}

variable "control_plane_log_types" {
  description = "Logs del plano de control enviados a CloudWatch (/aws/eks/<clúster>/cluster)."
  type        = list(string)
  default     = ["api", "audit", "authenticator"]
}

variable "node_instance_types" {
  description = "Tipos de instancia del node group."
  type        = list(string)
  default     = ["t3.large"]
}

variable "node_min_size" {
  type    = number
  default = 1
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 3

  validation {
    condition     = var.node_max_size >= 1
    error_message = "node_max_size debe ser al menos 1."
  }
}

variable "pod_identity_associations" {
  description = "Rol IAM por ServiceAccount (salida pod_identity_associations del módulo iam)."
  type = map(object({
    namespace       = string
    service_account = string
    role_arn        = string
  }))
  default = {}
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
