terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }

  # Recursos compartidos por los tres ambientes. Estado propio (global/terraform.tfstate),
  # sin workspaces: no pertenecen a ningún ambiente.
  backend "s3" {}
}
