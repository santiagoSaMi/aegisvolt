# Observabilidad de un ambiente (ADR-0014, ADR-0029):
# - un log group por servicio: /aegisvolt/<env>/<service_name>;
# - metric filters sobre los logs JSON (ADR-0028) → namespace AegisVolt/<env>;
# - alarmas de una sola métrica (las que Floci evalúa) y un dashboard.
# Los log groups los crea Terraform; el colector (Fluent Bit) no los auto-crea.

locals {
  prefix    = "/aegisvolt/${var.environment}"
  namespace = "AegisVolt/${var.environment}"
  groups    = toset(concat(var.services, [var.fallback_group]))

  # Resultado terminal de la SAGA → métrica (contador).
  saga_outcomes = {
    SagaCompleted          = "SAGA_COMPLETED"
    SagaCompensated        = "SAGA_COMPENSATED"
    SagaFailed             = "SAGA_FAILED"
    SagaCompensationFailed = "SAGA_COMPENSATION_FAILED"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each = local.groups

  name              = "${local.prefix}/${each.value}"
  retention_in_days = var.retention_in_days

  tags = {
    Service = each.value
  }
}

# --- SAGA: completadas, compensadas, fallidas, compensación fallida ---------------

resource "aws_cloudwatch_log_metric_filter" "saga_outcome" {
  for_each = local.saga_outcomes

  name           = each.key
  log_group_name = aws_cloudwatch_log_group.this[var.saga_service].name
  pattern        = "{ ($.component = \"saga\") && ($.event = \"${each.value}\") }"

  metric_transformation {
    name      = each.key
    namespace = local.namespace
    value     = "1"
    unit      = "Count"
  }
}

# Duración de extremo a extremo (creación → estado terminal). El orquestador solo
# añade duration_ms a los eventos terminales.
resource "aws_cloudwatch_log_metric_filter" "saga_duration" {
  name           = "SagaDuration"
  log_group_name = aws_cloudwatch_log_group.this[var.saga_service].name
  pattern        = "{ ($.component = \"saga\") && ($.duration_ms >= 0) }"

  metric_transformation {
    name      = "SagaDuration"
    namespace = local.namespace
    value     = "$.duration_ms"
    unit      = "Milliseconds"
  }
}

# --- Errores por servicio -----------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "service_errors" {
  for_each = toset(var.services)

  name           = "ServiceErrors"
  log_group_name = aws_cloudwatch_log_group.this[each.value].name
  pattern        = "{ ($.level = \"error\") || ($.level = \"fatal\") }"

  metric_transformation {
    name       = "ServiceErrors"
    namespace  = local.namespace
    value      = "1"
    unit       = "Count"
    dimensions = { ServiceName = "$.service_name" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "http_5xx" {
  for_each = toset(var.services)

  name           = "Http5xx"
  log_group_name = aws_cloudwatch_log_group.this[each.value].name
  pattern        = "{ ($.event = \"http_request\") && ($.http_status >= 500) }"

  metric_transformation {
    name       = "Http5xx"
    namespace  = local.namespace
    value      = "1"
    unit       = "Count"
    dimensions = { ServiceName = "$.service_name" }
  }
}

# --- Alarmas (una sola métrica: Floci no evalúa metric math) ------------------------

resource "aws_cloudwatch_metric_alarm" "saga_compensation_failed" {
  alarm_name          = "aegisvolt-${var.environment}-saga-compensation-failed"
  alarm_description   = "Una compensación de la SAGA falló: requiere reintento controlado (runbook saga-demo)."
  namespace           = local.namespace
  metric_name         = "SagaCompensationFailed"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.saga_outcome]
}

resource "aws_cloudwatch_metric_alarm" "service_errors" {
  for_each = toset(var.services)

  alarm_name          = "aegisvolt-${var.environment}-${each.value}-errors"
  alarm_description   = "Errores (level error/fatal) de ${each.value} por encima del umbral."
  namespace           = local.namespace
  metric_name         = "ServiceErrors"
  dimensions          = { ServiceName = each.value }
  statistic           = "Sum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = var.service_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.service_errors]
}

# --- Dashboard (en Floci se guarda, no se renderiza) ---------------------------------

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = "aegisvolt-${var.environment}"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title   = "SAGA por resultado"
          region  = data.aws_region.current.region
          stat    = "Sum"
          period  = 300
          metrics = [for name in keys(local.saga_outcomes) : [local.namespace, name]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title   = "Duración de la SAGA (ms)"
          region  = data.aws_region.current.region
          period  = 300
          metrics = [[local.namespace, "SagaDuration", { stat = "Average" }], [local.namespace, "SagaDuration", { stat = "p90" }]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title   = "Errores por servicio"
          region  = data.aws_region.current.region
          stat    = "Sum"
          period  = 300
          metrics = [for s in var.services : [local.namespace, "ServiceErrors", "ServiceName", s]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title   = "HTTP 5xx por servicio"
          region  = data.aws_region.current.region
          stat    = "Sum"
          period  = 300
          metrics = [for s in var.services : [local.namespace, "Http5xx", "ServiceName", s]]
        }
      },
    ]
  })
}

data "aws_region" "current" {}
