# Raíz única de los ambientes (ADR-0011, ADR-0033): el workspace (dev | test | prod) ES
# el ambiente. Cada workspace tiene su propio estado (env:/<ws>/aegisvolt/terraform.tfstate)
# y todos los nombres llevan el ambiente, así que aplicar en test no puede tocar prod.

locals {
  environment = terraform.workspace
  name        = "aegisvolt-${local.environment}"
  tags        = { Environment = local.environment }

  # Database-per-service (§2.4): una tabla por servicio y ambiente,
  # aegisvolt-<dominio>-<env>. Mismo esquema que el tableDefinition de cada servicio.
  tables = {
    reservations  = { owner = "station-reservation-service", gsis = ["GSI1", "GSI2"], ttl = null }
    billing       = { owner = "billing-wallet-service", gsis = ["GSI1"], ttl = null }
    dispatch      = { owner = "energy-dispatch-service", gsis = ["GSI1", "GSI2"], ttl = "ttl" } # telemetría
    sagas         = { owner = "saga-orchestrator-service", gsis = ["GSI1", "GSI2"], ttl = null }
    feature-flags = { owner = "graphql-api", gsis = [], ttl = null }
  }

  eks_enabled = coalesce(var.eks_enabled_override, var.eks.enabled)

  feature_flags = { for f in jsondecode(file("${path.module}/feature-flags.json")).flags : f.key => f }

  log_group_arn_prefix = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aegisvolt/${local.environment}"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# --- Guardas ------------------------------------------------------------------------------------
# 1. Solo dev, test o prod (nunca `default`).
# 2. El archivo envs/<env>.tfvars debe ser el del workspace: un `-var-file` equivocado
#    (p. ej. envs/prod.tfvars en el workspace test) hace fallar el plan.
resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["dev", "test", "prod"], terraform.workspace)
      error_message = "Seleccione el workspace dev, test o prod (actual: ${terraform.workspace})."
    }
    precondition {
      condition     = var.environment == terraform.workspace
      error_message = "envs/${var.environment}.tfvars no corresponde al workspace ${terraform.workspace}."
    }
  }
}

# --- DynamoDB ------------------------------------------------------------------------------------
module "tables" {
  source   = "../modules/dynamodb-table"
  for_each = local.tables

  name                     = "aegisvolt-${each.key}-${local.environment}"
  global_secondary_indexes = [for g in each.value.gsis : { name = g, hash_key = "${g}PK", range_key = "${g}SK" }]
  ttl_attribute            = each.value.ttl
  point_in_time_recovery   = var.dynamodb.point_in_time_recovery
  deletion_protection      = var.dynamodb.deletion_protection
  tags                     = merge(local.tags, { Service = each.value.owner })

  depends_on = [terraform_data.workspace_guard]
}

# Semilla de flags con el valor inicial de ESTE ambiente (ADR-0025). ignore_changes:
# después de crearse, el valor lo gobierna la operación (UpdateFeatureFlag, auditada),
# no Terraform; un apply nunca revierte un cambio de flag hecho en caliente.
resource "aws_dynamodb_table_item" "feature_flag" {
  for_each = local.feature_flags

  table_name = module.tables["feature-flags"].name
  hash_key   = "PK"
  range_key  = "SK"
  item = jsonencode({
    PK          = { S = "FLAG#${each.key}" }
    SK          = { S = "META" }
    key         = { S = each.key }
    enabled     = { BOOL = each.value.initial[local.environment] }
    description = { S = each.value.description }
    version     = { N = "1" }
    updatedAt   = { S = "1970-01-01T00:00:00.000Z" }
    updatedBy   = { S = "terraform-seed" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# --- Red ------------------------------------------------------------------------------------------
module "network" {
  source = "../modules/network"

  environment        = local.environment
  vpc_cidr           = var.vpc_cidr
  single_nat_gateway = var.single_nat_gateway

  dynamodb_endpoint_policy_resources = flatten([
    for t in module.tables : [t.arn, "${t.arn}/index/*"]
  ])
  # Las capas de las imágenes de ECR se descargan de este bucket de AWS.
  s3_endpoint_policy_resources = ["arn:${data.aws_partition.current.partition}:s3:::prod-${var.aws_region}-starport-layer-bucket/*"]

  tags = local.tags
}

# --- IAM (Pod Identity) -----------------------------------------------------------------------------
module "iam" {
  source = "../modules/iam"

  environment             = local.environment
  cluster_name            = local.name
  feature_flags_table_arn = module.tables["feature-flags"].arn

  workloads = {
    station-reservation = { namespace = "aegisvolt", service_account = "station-reservation-service", table_arn = module.tables["reservations"].arn, feature_flags = "read" }
    billing-wallet      = { namespace = "aegisvolt", service_account = "billing-wallet-service", table_arn = module.tables["billing"].arn, feature_flags = "read" }
    energy-dispatch     = { namespace = "aegisvolt", service_account = "energy-dispatch-service", table_arn = module.tables["dispatch"].arn, feature_flags = "read" }
    saga-orchestrator   = { namespace = "aegisvolt", service_account = "saga-orchestrator-service", table_arn = module.tables["sagas"].arn }
    graphql-api         = { namespace = "aegisvolt", service_account = "graphql-api", feature_flags = "read_write" }
    fluent-bit = {
      namespace       = "logging"
      service_account = "fluent-bit"
      extra_statements = [{
        sid       = "WriteEnvironmentLogs"
        actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        resources = ["${local.log_group_arn_prefix}/*"]
      }]
    }
    argo-rollouts = {
      namespace       = "argo-rollouts"
      service_account = "argo-rollouts"
      extra_statements = [{
        sid       = "ReadCanaryMetrics"
        actions   = ["cloudwatch:GetMetricData"] # sin permisos a nivel de recurso
        resources = ["*"]
      }]
    }
  }

  tags = local.tags
}

# --- EKS ------------------------------------------------------------------------------------------
module "eks" {
  source = "../modules/eks"
  count  = local.eks_enabled ? 1 : 0

  cluster_name                        = local.name
  kubernetes_version                  = var.eks.kubernetes_version
  control_plane_log_retention_in_days = var.observability.retention_in_days
  subnet_ids                          = module.network.private_subnet_ids
  endpoint_public_access              = var.eks.endpoint_public_access
  public_access_cidrs                 = var.eks.public_access_cidrs
  node_instance_types                 = var.eks.node_instance_types
  node_min_size                       = var.eks.node_min_size
  node_desired_size                   = var.eks.node_desired_size
  node_max_size                       = var.eks.node_max_size
  pod_identity_associations           = module.iam.pod_identity_associations

  # El NLB interno es el único origen autorizado hacia el ingress del clúster.
  ingress_sources     = { nlb = module.api_gateway.nlb_security_group_id }
  ingress_port        = var.ingress_target_port
  kubeconfig_exec_env = local.floci ? { AWS_ENDPOINT_URL = var.floci_endpoint } : {}

  tags = local.tags
}

# --- Entrada: API Gateway → VPC Link → NLB interno --------------------------------------------------
module "api_gateway" {
  source = "../modules/api-gateway"

  environment                 = local.environment
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  private_subnet_cidrs        = module.network.private_subnet_cidrs
  listener_port               = var.api.listener_port
  target_port                 = var.ingress_target_port
  integration_base_url        = var.floci_ingress_host == null ? null : "http://${var.floci_ingress_host}:${var.api.listener_port}"
  execute_api_vpc_endpoint_id = module.network.execute_api_endpoint_id
  throttling_rate_limit       = var.api.throttling_rate_limit
  throttling_burst_limit      = var.api.throttling_burst_limit
  log_retention_in_days       = var.observability.retention_in_days
  tags                        = local.tags
}

# --- CloudWatch ---------------------------------------------------------------------------------------
module "cloudwatch" {
  source = "../modules/cloudwatch"

  environment             = local.environment
  retention_in_days       = var.observability.retention_in_days
  service_error_threshold = var.observability.service_error_threshold

  depends_on = [terraform_data.workspace_guard]
}
