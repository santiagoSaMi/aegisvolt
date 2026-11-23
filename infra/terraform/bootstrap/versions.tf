terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }

  # El estado de bootstrap también vive en el bucket que crea (clave bootstrap/...),
  # migrado desde el estado local inicial (scripts/floci/terraform-bootstrap.sh).
  backend "s3" {}
}
