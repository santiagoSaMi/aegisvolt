output "log_group_names" {
  description = "Log group por servicio (incluido el de respaldo del colector)."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.name }
}

output "log_group_prefix" {
  value = local.prefix
}

output "metric_namespace" {
  value = local.namespace
}

output "alarm_names" {
  value = concat(
    [aws_cloudwatch_metric_alarm.saga_compensation_failed.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.service_errors : a.alarm_name],
  )
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}
