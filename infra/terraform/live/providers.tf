provider "aws" {
  region = "us-east-1"

  # Credenciales FICTICIAS, solo válidas en Floci.
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  # Un endpoint por CADA servicio usado: uno omitido iría a AWS real.
  endpoints {
    cloudwatch = var.floci_endpoint
    logs       = var.floci_endpoint
    sts        = var.floci_endpoint
  }

  default_tags {
    tags = {
      Project     = "aegisvolt"
      Environment = terraform.workspace
      ManagedBy   = "terraform"
    }
  }
}
