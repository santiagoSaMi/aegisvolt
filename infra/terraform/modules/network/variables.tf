variable "environment" {
  description = "Ambiente (dev, test o prod): forma parte de todos los nombres."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment debe ser dev, test o prod."
  }
}

variable "vpc_cidr" {
  description = "CIDR /16 de la VPC del ambiente; distinto en cada ambiente (10.10/10.20/10.30)."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && endswith(var.vpc_cidr, "/16")
    error_message = "vpc_cidr debe ser un CIDR /16 válido."
  }
}

variable "availability_zones" {
  description = "AZs candidatas de la región."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "az_count" {
  description = "Cuántas AZs usar (2 o 3)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count debe ser 2 o 3 (EKS exige al menos dos AZs)."
  }
}

variable "single_nat_gateway" {
  description = "true: un NAT compartido (dev/test, menor costo); false: un NAT por AZ (prod, sin punto único de falla)."
  type        = bool
  default     = true
}

variable "interface_endpoints" {
  description = "Servicios con Interface VPC Endpoint (sufijo de com.amazonaws.<región>.)."
  type        = list(string)
  default     = ["logs", "monitoring", "execute-api", "eks", "eks-auth", "ecr.api", "ecr.dkr", "sts", "elasticloadbalancing"]
}

variable "dynamodb_endpoint_policy_resources" {
  description = "ARNs de DynamoDB alcanzables por el Gateway VPCE (tablas e índices del ambiente)."
  type        = list(string)

  validation {
    condition     = length(var.dynamodb_endpoint_policy_resources) > 0
    error_message = "Debe indicarse al menos un ARN: la política del endpoint no puede quedar abierta."
  }
}

variable "s3_endpoint_policy_resources" {
  description = "Objetos S3 alcanzables por el Gateway VPCE (p. ej. las capas de ECR)."
  type        = list(string)

  validation {
    condition     = length(var.s3_endpoint_policy_resources) > 0
    error_message = "Debe indicarse al menos un ARN: la política del endpoint no puede quedar abierta."
  }
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
