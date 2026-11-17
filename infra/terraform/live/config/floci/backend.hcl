# Backend S3 en Floci (destino local). Se configura APARTE del provider: el backend no
# hereda sus endpoints ni sus credenciales. El bucket lo crea ../../bootstrap.
# Con workspaces: env:/<workspace>/aegisvolt/terraform.tfstate (+ .tflock al bloquear).
bucket               = "aegisvolt-tfstate"
key                  = "aegisvolt/terraform.tfstate"
region               = "us-east-1"
workspace_key_prefix = "env:"
# false: no forzar SSE-S3; el bucket cifra por defecto con su clave KMS (bootstrap, AWS-0132).
encrypt              = false

endpoints = {
  s3  = "http://localhost:4566"
  sts = "http://localhost:4566"
}
use_path_style = true

# Bloqueo nativo de S3 (escritura condicional If-None-Match, verificada en Floci 2.4.0).
# Sin tabla DynamoDB: dynamodb_table está deprecado desde Terraform 1.11.
use_lockfile = true

# Credenciales FICTICIAS de Floci. Nunca ~/.aws: ni perfiles ni credenciales compartidas.
access_key                  = "test"
secret_key                  = "test"
shared_config_files         = ["/dev/null"]
shared_credentials_files    = ["/dev/null"]
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
