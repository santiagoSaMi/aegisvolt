# Mismo esquema que live/providers.tf: destino validado, credenciales ficticias en
# Floci y nunca ~/.aws.
locals {
  floci          = var.target == "floci"
  floci_endpoint = local.floci ? var.floci_endpoint : null
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.allowed_account_ids

  shared_config_files      = ["/dev/null"]
  shared_credentials_files = ["/dev/null"]

  access_key                  = local.floci ? "test" : null
  secret_key                  = local.floci ? "test" : null
  skip_credentials_validation = local.floci
  skip_metadata_api_check     = local.floci
  s3_use_path_style           = local.floci

  endpoints {
    kms = local.floci_endpoint
    s3  = local.floci_endpoint
    sts = local.floci_endpoint
  }

  default_tags {
    tags = {
      Project   = "aegisvolt"
      ManagedBy = "terraform"
      Purpose   = "tfstate"
    }
  }
}
