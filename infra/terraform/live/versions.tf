terraform {
  # use_lockfile (bloqueo nativo en S3) requiere >= 1.10; import con identity, >= 1.12.
  # Verificado con 1.17.1 (ADR-0033).
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }

  # Configuración parcial: el destino se elige al inicializar
  #   terraform init -backend-config=config/<destino>/backend.hcl
  # Estado por workspace: env:/<workspace>/aegisvolt/terraform.tfstate.
  backend "s3" {}
}
