# Backend S3 apuntando a Floci. Se configura POR SEPARADO del provider:
# el backend no hereda `endpoints` ni `s3_use_path_style` del bloque provider.
# Ref: https://developer.hashicorp.com/terraform/language/backend/s3
bucket = "aegisvolt-tfstate-floci-check"
key    = "floci-check/terraform.tfstate"
region = "us-east-1"

# Con workspaces, el estado queda en env:/<workspace>/<key>.
workspace_key_prefix = "env:"

endpoints = {
  s3 = "http://localhost:4566"
}
use_path_style = true

# Bloqueo nativo con archivo .tflock en S3 (sin tabla DynamoDB).
use_lockfile = true

access_key                  = "test"
secret_key                  = "test"
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
