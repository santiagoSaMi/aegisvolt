# Bootstrap del estado remoto (ADR-0011): bucket S3 versionado para el estado de
# `live/`. Usa estado LOCAL (no puede guardarse en el bucket que crea) y se
# aplica una sola vez por cuenta. En local apunta SIEMPRE a Floci.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
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

variable "state_bucket" {
  description = "Nombre del bucket del estado remoto."
  type        = string
  default     = "aegisvolt-tfstate"
}

provider "aws" {
  region = "us-east-1"

  # Credenciales FICTICIAS, solo válidas en Floci.
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3  = var.floci_endpoint
    sts = var.floci_endpoint
  }

  default_tags {
    tags = {
      Project   = "aegisvolt"
      ManagedBy = "terraform"
      Purpose   = "tfstate"
    }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket
}

# Versionado obligatorio: permite recuperar cualquier versión previa del estado.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
