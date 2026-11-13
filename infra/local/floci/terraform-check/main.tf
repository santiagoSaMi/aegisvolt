# Configuración MÍNIMA para verificar la integración Terraform <-> Floci.
# No es la infraestructura de AegisVolt (eso se construye en la fase de IaC).
# Ref: https://floci.io/floci/getting-started/terraform/

terraform {
  # use_lockfile (bloqueo nativo en S3) requiere Terraform >= 1.10.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Configuración parcial: los valores están en backend.floci.hcl
  # (terraform init -backend-config=backend.floci.hcl).
  backend "s3" {}
}

variable "floci_endpoint" {
  description = "Endpoint de Floci. Solo se aceptan endpoints locales."
  type        = string
  default     = "http://localhost:4566"

  validation {
    condition     = can(regex("^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?$", var.floci_endpoint))
    error_message = "floci_endpoint debe ser local (http://localhost:<puerto>). No se permite AWS real."
  }
}

provider "aws" {
  region = "us-east-1"

  # Credenciales FICTICIAS, solo válidas en Floci.
  access_key = "test"
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  # Debe declararse un endpoint por CADA servicio usado; un servicio omitido
  # iría al endpoint real de AWS (y fallaría por las credenciales ficticias).
  endpoints {
    dynamodb = var.floci_endpoint
    logs     = var.floci_endpoint
    s3       = var.floci_endpoint
    sts      = var.floci_endpoint
  }

  default_tags {
    tags = {
      Project     = "aegisvolt"
      Environment = terraform.workspace
      ManagedBy   = "terraform"
      Purpose     = "floci-check"
    }
  }
}

locals {
  name = "aegisvolt-floci-check-${terraform.workspace}"
}

resource "aws_dynamodb_table" "check" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}

resource "aws_cloudwatch_log_group" "check" {
  name              = "/aegisvolt/${terraform.workspace}/floci-check"
  retention_in_days = 7
}

output "dynamodb_table" {
  value = aws_dynamodb_table.check.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.check.name
}
