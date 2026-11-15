# Raíz única por ambiente (ADR-0011): el workspace (dev | test | prod) ES el
# ambiente. Por ahora solo contiene la observabilidad (Parte B); la fase de IaC
# añade red, DynamoDB, EKS, edge, identidad e IAM.

locals {
  environment = terraform.workspace

  settings = {
    dev  = { retention_in_days = 7, service_error_threshold = 5 }
    test = { retention_in_days = 14, service_error_threshold = 5 }
    prod = { retention_in_days = 30, service_error_threshold = 3 }
  }
}

# Impide aplicar en el workspace `default` o en uno con otro nombre.
resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["dev", "test", "prod"], terraform.workspace)
      error_message = "Seleccione el workspace dev, test o prod (actual: ${terraform.workspace})."
    }
  }
}

module "observability" {
  source = "../modules/observability"

  environment             = local.environment
  retention_in_days       = local.settings[local.environment].retention_in_days
  service_error_threshold = local.settings[local.environment].service_error_threshold
}
