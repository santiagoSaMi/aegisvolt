# Entrada de un ambiente (ADR-0010, ADR-0034).
#
#   Cliente en internet ──HTTPS──▶ API REST REGIONAL (stage <env>) ──┐
#   Cliente en la VPC ──▶ Interface VPCE execute-api ──▶ API REST PRIVATE ──┤
#                                                                       ▼
#                VPC Link ──▶ NLB interno (subredes privadas) ──▶ ingress del clúster
#                (Traefik, ADR-0032) ──▶ Service graphql-api ──▶ pods
#
# - El cliente consume el endpoint de API Gateway (https://<id>.execute-api.<región>
#   .amazonaws.com/<env>). El Interface VPCE execute-api es otra cosa: la puerta por la
#   que un cliente DENTRO de la VPC invoca la API PRIVATE.
# - API Gateway llega al clúster por el VPC Link (PrivateLink hacia el NLB), no por un VPCE.
# - El NLB no alcanza pods por sí mismo: reenvía a los targets registrados (IP de los pods
#   de Traefik, que registra el AWS Load Balancer Controller en AWS; en Floci, la IP del
#   contenedor k3s y el NodePort de Traefik, registrados por k8s-deploy.sh).
# - Floci (L-01, L-02): el DNS del NLB no resuelve, así que la integración local usa
#   integration_base_url; la resource policy y los SG se guardan pero no se aplican.

locals {
  name             = "aegisvolt-${var.environment}"
  integration_base = coalesce(var.integration_base_url, "http://${aws_lb.internal.dns_name}:${var.listener_port}")

  apis = merge(
    { public = { type = "REGIONAL" } },
    var.create_private_api ? { private = { type = "PRIVATE" } } : {},
  )

  # Rutas: path null = raíz de la API. proxy = pasa {proxy} al backend.
  routes = merge(
    {
      public-graphql = { api = "public", path = "graphql", method = "POST", backend = "/graphql", proxy = false }
      public-root    = { api = "public", path = null, method = "GET", backend = "/", proxy = false }
      public-spa     = { api = "public", path = "{proxy+}", method = "ANY", backend = "/{proxy}", proxy = true }
    },
    var.create_private_api ? {
      private-graphql = { api = "private", path = "graphql", method = "POST", backend = "/graphql", proxy = false }
    } : {},
  )
  resource_routes = { for k, r in local.routes : k => r if r.path != null }
}

# --- NLB interno ----------------------------------------------------------------------------------
# Sin reglas de entrada: el único camino al NLB es el VPC Link (PrivateLink), al que no se
# aplican las reglas de entrada (enforce_security_group_inbound_rules_on_private_link_traffic
# = off). Ningún otro recurso de la VPC puede llamarlo directamente.
resource "aws_security_group" "nlb" {
  name        = "${local.name}-ingress-nlb"
  description = "NLB interno: entrada solo por VPC Link; salida al ingress del cluster"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${local.name}-ingress-nlb" })
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_ingress" {
  for_each = toset(var.private_subnet_cidrs)

  security_group_id = aws_security_group.nlb.id
  description       = "Hacia el ingress (y su health check) en ${each.key}"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = var.target_port
  to_port           = var.target_port
}

resource "aws_lb" "internal" {
  name               = "${local.name}-ingress"
  load_balancer_type = "network"
  internal           = true
  subnets            = var.private_subnet_ids
  security_groups    = [aws_security_group.nlb.id]

  enforce_security_group_inbound_rules_on_private_link_traffic = "off"
  enable_cross_zone_load_balancing                             = true

  tags = var.tags

  lifecycle {
    # Floci 2.4.0 no devuelve este atributo (deriva permanente en el plan). El valor se
    # fija al crear el NLB; ver ADR-0034 y L-14.
    ignore_changes = [enforce_security_group_inbound_rules_on_private_link_traffic]
  }
}

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
  # Mismo esquema base que el resto de logs (ADR-0028).
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

resource "aws_api_gateway_resource" "route" {
  for_each = local.resource_routes

  rest_api_id = aws_api_gateway_rest_api.this[each.value.api].id
  parent_id   = aws_api_gateway_rest_api.this[each.value.api].root_resource_id
  path_part   = each.value.path
}

locals {
  resource_id = {
    for k, r in local.routes : k => (
      r.path == null ? aws_api_gateway_rest_api.this[r.api].root_resource_id : aws_api_gateway_resource.route[k].id
    )
  }
}

resource "aws_api_gateway_method" "route" {
  for_each = local.routes

  rest_api_id   = aws_api_gateway_rest_api.this[each.value.api].id
  resource_id   = local.resource_id[each.key]
  http_method   = each.value.method
  authorization = "NONE" # el JWT de Cognito lo valida graphql-api (ADR-0026); ver ADR-0034

  request_parameters = each.value.proxy ? { "method.request.path.proxy" = true } : {}
}

resource "aws_api_gateway_integration" "route" {
  for_each = local.routes

  rest_api_id             = aws_api_gateway_rest_api.this[each.value.api].id
  resource_id             = local.resource_id[each.key]
  http_method             = aws_api_gateway_method.route[each.key].http_method
  type                    = "HTTP_PROXY"
  integration_http_method = each.value.method
  uri                     = "${local.integration_base}${each.value.backend}"
  connection_type         = "VPC_LINK"
  connection_id           = aws_api_gateway_vpc_link.this.id
  timeout_milliseconds    = var.integration_timeout_ms

  request_parameters = each.value.proxy ? { "integration.request.path.proxy" = "method.request.path.proxy" } : {}
}

resource "aws_api_gateway_deployment" "this" {
  for_each = local.apis

  rest_api_id = aws_api_gateway_rest_api.this[each.key].id

  # Nuevo deployment cuando cambia cualquier ruta de la API.
  triggers = {
    redeployment = sha1(jsonencode([
      for k, r in local.routes : [
        k, r, aws_api_gateway_integration.route[k].uri, aws_api_gateway_integration.route[k].connection_id,
      ] if r.api == each.key
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.route, aws_api_gateway_rest_api_policy.private]
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
