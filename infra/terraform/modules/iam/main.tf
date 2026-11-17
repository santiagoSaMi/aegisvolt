# Roles de las cargas de trabajo de un ambiente (EKS Pod Identity, ADR-0033).
#
# - Un rol por ServiceAccount con la política mínima que necesita: su propia tabla (e
#   índices), la tabla de flags del ambiente (lectura o escritura) y, para los
#   componentes de plataforma, CloudWatch.
# - Confianza en `pods.eks.amazonaws.com` (Pod Identity): sin proveedor OIDC por
#   clúster. La asociación rol ↔ ServiceAccount la crea el módulo eks.
# - Floci no evalúa IAM (L-08): las políticas se crean y se verifican con get-*, pero
#   el aislamiento efectivo en local lo dan la tabla por ambiente y APP_ENV.

locals {
  name = "aegisvolt-${var.environment}"

  dynamodb_read  = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:DescribeTable"]
  dynamodb_write = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  cluster_arn = "arn:${data.aws_partition.current.partition}:eks:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:cluster/${var.cluster_name}"
}

# Confianza de Pod Identity limitada a la cuenta y al clúster del propio ambiente:
# el rol de dev no lo puede asumir un pod del clúster de prod (y al revés).
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    sid     = "EksPodIdentityOwnCluster"
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.cluster_arn]
    }
  }
}

data "aws_iam_policy_document" "workload" {
  for_each = var.workloads

  # Tabla propia: lectura y escritura (el servicio es su único dueño).
  dynamic "statement" {
    for_each = each.value.table_arn == null ? [] : [each.value.table_arn]
    content {
      sid       = "OwnTable"
      effect    = "Allow"
      actions   = concat(local.dynamodb_read, local.dynamodb_write)
      resources = [statement.value, "${statement.value}/index/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.feature_flags == "none" ? [] : [each.value.feature_flags]
    content {
      sid       = "FeatureFlags"
      effect    = "Allow"
      actions   = statement.value == "read_write" ? concat(local.dynamodb_read, local.dynamodb_write) : local.dynamodb_read
      resources = [var.feature_flags_table_arn]
    }
  }

  dynamic "statement" {
    for_each = length(each.value.extra_statements) == 0 ? [] : each.value.extra_statements
    content {
      sid       = statement.value.sid
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role" "workload" {
  for_each = var.workloads

  name                 = "${local.name}-${each.key}"
  description          = "AegisVolt ${var.environment}: ${each.value.namespace}/${each.value.service_account}"
  assume_role_policy   = data.aws_iam_policy_document.pod_identity_trust.json
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_iam_role_policy" "workload" {
  for_each = var.workloads

  name   = "least-privilege"
  role   = aws_iam_role.workload[each.key].id
  policy = data.aws_iam_policy_document.workload[each.key].json
}
