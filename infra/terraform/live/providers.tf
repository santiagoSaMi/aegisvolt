# Provider AWS (ADR-0033). El destino lo fija config/<destino>/target.tfvars:
#   - floci: endpoints locales obligatorios (validados) y credenciales FICTICIAS;
#   - aws: sin endpoints (los de AWS) y credenciales del entorno de CI (OIDC). No hay
#     configuración aws en el repositorio: CLAUDE.md prohíbe aplicar contra AWS real.
# En ambos casos el provider NO lee ~/.aws (ni perfiles personales ni credenciales
# compartidas) y solo opera en las cuentas de allowed_account_ids.

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

  # Un endpoint por CADA servicio usado: en floci, uno omitido iría a AWS real.
  endpoints {
    apigateway = local.floci_endpoint
    cloudwatch = local.floci_endpoint
    dynamodb   = local.floci_endpoint
    ec2        = local.floci_endpoint
    eks        = local.floci_endpoint
    elbv2      = local.floci_endpoint
    iam        = local.floci_endpoint
    kms        = local.floci_endpoint
    logs       = local.floci_endpoint
    s3         = local.floci_endpoint
    sts        = local.floci_endpoint
  }

  default_tags {
    tags = {
      Project     = "aegisvolt"
      Environment = var.environment
      ManagedBy   = "terraform"
      Workspace   = terraform.workspace
    }
  }
}
