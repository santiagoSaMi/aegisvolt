# Estado de bootstrap en el bucket que él mismo crea (sin workspaces).
bucket       = "aegisvolt-tfstate"
key          = "bootstrap/terraform.tfstate"
region       = "us-east-1"
encrypt      = true
use_lockfile = true

endpoints = {
  s3  = "http://localhost:4566"
  sts = "http://localhost:4566"
}
use_path_style = true

access_key                  = "test"
secret_key                  = "test"
shared_config_files         = ["/dev/null"]
shared_credentials_files    = ["/dev/null"]
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
