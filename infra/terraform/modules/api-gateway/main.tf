# Entrada de un ambiente (ADR-0010, ADR-0033).
#
#   Internet → API REST REGIONAL (stage <env>) ─┐
#   VPC (Prefect, operación) → VPCE execute-api → API REST PRIVATE ─┤
#                                                 └→ VPC Link → NLB interno (subredes
#                                                    privadas) → Traefik en EKS → pods
#
# - Las integraciones son HTTP_PROXY por VPC_LINK: el tráfico de API Gateway al clúster
#   entra a la VPC por el VPC Link y no recorre internet.
# - La API PRIVATE solo acepta llamadas que llegan por el VPCE execute-api del ambiente
#   (resource policy aws:SourceVpce).
# - Floci (L-01, L-02): el DNS del NLB no resuelve, así que la URI de integración local
#   se sobreescribe con integration_base_url; la resource policy se guarda pero no se evalúa.

locals {
  name             = "aegisvolt-${var.environment}"
  integration_base = coalesce(var.integration_base_url, "http://${aws_lb.internal.dns_name}:${var.listener_port}")
}

# --- NLB interno y VPC Link ------------------------------------------------------------------------
resource "aws_lb" "internal" {
  name               = "${local.name}-ingress"
  load_balancer_type = "network"
  internal           = true
  subnets            = var.private_subnet_ids

  enable_cross_zone_load_balancing = true
  tags                             = var.tags
}

# Destino: el ingress del clúster (Traefik, ADR-0032). En AWS lo registra el AWS Load
# Balancer Controller (TargetGroupBinding); por eso el tipo es ip.
resource "aws_lb_target_group" "ingress" {
  name        = "${local.name}-ingress"
  port        = var.target_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    protocol = "HTTP"
    path     = var.health_check_path
    port     = "traffic-port"
  }

  tags = var.tags
}

resource "aws_lb_listener" "ingress" {
  load_balancer_arn = aws_lb.internal.arn
  port              = var.listener_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ingress.arn
  }

  tags = var.tags
}

resource "aws_api_gateway_vpc_link" "this" {
  name        = "${local.name}-ingress"
  target_arns = [aws_lb.internal.arn]
  tags        = var.tags
}

# --- Logs de acceso ----------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "access" {
  name              = "/aegisvolt/${var.environment}/api-gateway"
  retention_in_days = var.log_retention_in_days
  tags              = var.tags
}

locals {
  # Mismo esquema base que el resto de logs (ADR-0028): JSON con correlation_id.
  access_log_format = jsonencode({
    timestamp      = "$context.requestTime"
    service_name   = "api-gateway"
    environment    = var.environment
    correlation_id = "$context.requestId"
    operation      = "$context.httpMethod $context.resourcePath"
    status         = "$context.status"
    latency_ms     = "$context.responseLatency"
    integration    = "$context.integration.status"
    source_ip      = "$context.identity.sourceIp"
    vpce_id        = "$context.identity.vpceId"
  })

  apis = merge(
    { public = { type = "REGIONAL", path_prefix = "" } },
    var.create_private_api ? { private = { type = "PRIVATE", path_prefix = "ops/" } } : {},
  )
}

# --- APIs REST ----------------------------------------------------------------------------------------
resource "aws_api_gateway_rest_api" "this" {
  for_each = local.apis

  name        = "${local.name}-${each.key}"
  description = "AegisVolt ${var.environment} (${each.value.type})"

  endpoint_configuration {
    types            = [each.value.type]
    vpc_endpoint_ids = each.value.type == "PRIVATE" ? [var.execute_api_vpc_endpoint_id] : null
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = each.value.type != "PRIVATE" || var.execute_api_vpc_endpoint_id != null
      error_message = "La API PRIVATE requiere el Interface VPCE execute-api del ambiente."
    }
  }
}

# Solo se puede invocar la API privada a través del VPCE del ambiente.
data "aws_iam_policy_document" "private" {
  count = var.create_private_api ? 1 : 0

  statement {
    sid       = "AllowFromEnvironmentVpce"
    effect    = "Allow"
    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.this["private"].execution_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "DenyOutsideEnvironmentVpce"
    effect    = "Deny"
    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.this["private"].execution_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:SourceVpce"
      values   = [var.execute_api_vpc_endpoint_id]
    }
  }
}

resource "aws_api_gateway_rest_api_policy" "private" {
  count = var.create_private_api ? 1 : 0

  rest_api_id = aws_api_gateway_rest_api.this["private"].id
  policy      = data.aws_iam_policy_document.private[0].json
}

# ANY /{proxy+} → VPC Link → NLB → ingress del clúster (que enruta /graphql y la web).
resource "aws_api_gateway_resource" "proxy" {
  for_each = local.apis

  rest_api_id = aws_api_gateway_rest_api.this[each.key].id
  parent_id   = aws_api_gateway_rest_api.this[each.key].root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  for_each = local.apis

  rest_api_id   = aws_api_gateway_rest_api.this[each.key].id
  resource_id   = aws_api_gateway_resource.proxy[each.key].id
  http_method   = "ANY"
  authorization = "NONE" # la autenticación (JWT de Cognito) la valida graphql-api (ADR-0026)

  request_parameters = { "method.request.path.proxy" = true }
}

resource "aws_api_gateway_integration" "proxy" {
  for_each = local.apis

  rest_api_id             = aws_api_gateway_rest_api.this[each.key].id
  resource_id             = aws_api_gateway_resource.proxy[each.key].id
  http_method             = aws_api_gateway_method.proxy[each.key].http_method
  type                    = "HTTP_PROXY"
  integration_http_method = "ANY"
  uri                     = "${local.integration_base}/${each.value.path_prefix}{proxy}"
  connection_type         = "VPC_LINK"
  connection_id           = aws_api_gateway_vpc_link.this.id
  timeout_milliseconds    = var.integration_timeout_ms

  request_parameters = { "integration.request.path.proxy" = "method.request.path.proxy" }
}

resource "aws_api_gateway_deployment" "this" {
  for_each = local.apis

  rest_api_id = aws_api_gateway_rest_api.this[each.key].id

  # Nuevo deployment cuando cambia la definición de la API.
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.proxy[each.key].id,
      aws_api_gateway_method.proxy[each.key].id,
      aws_api_gateway_integration.proxy[each.key].uri,
      aws_api_gateway_integration.proxy[each.key].connection_id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.proxy, aws_api_gateway_rest_api_policy.private]
}

resource "aws_api_gateway_stage" "this" {
  for_each = local.apis

  rest_api_id   = aws_api_gateway_rest_api.this[each.key].id
  deployment_id = aws_api_gateway_deployment.this[each.key].id
  stage_name    = var.environment

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format          = local.access_log_format
  }

  tags = var.tags
}

resource "aws_api_gateway_method_settings" "all" {
  for_each = local.apis

  rest_api_id = aws_api_gateway_rest_api.this[each.key].id
  stage_name  = aws_api_gateway_stage.this[each.key].stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = var.throttling_rate_limit
    throttling_burst_limit = var.throttling_burst_limit
    metrics_enabled        = true
    logging_level          = "ERROR"
  }
}
