# Backend S3 en Floci (se configura por separado: no hereda los endpoints del provider).
# El bucket lo crea ../bootstrap. Con workspaces: env:/<workspace>/aegisvolt/terraform.tfstate.
bucket               = "aegisvolt-tfstate"
key                  = "aegisvolt/terraform.tfstate"
region               = "us-east-1"
workspace_key_prefix = "env:"

endpoints = {
  s3 = "http://localhost:4566"
}
use_path_style = true
use_lockfile   = true

access_key                  = "test"
secret_key                  = "test"
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
