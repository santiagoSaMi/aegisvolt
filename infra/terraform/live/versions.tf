terraform {
  # use_lockfile (bloqueo nativo en S3) requiere Terraform >= 1.10.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }

  # Configuración parcial: backend.floci.hcl (terraform init -backend-config=...).
  # Estado por workspace en env:/<workspace>/aegisvolt/terraform.tfstate.
  backend "s3" {}
}
