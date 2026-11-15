output "environment" {
  value = local.environment
}

output "log_group_names" {
  value = module.observability.log_group_names
}

output "metric_namespace" {
  value = module.observability.metric_namespace
}

output "alarm_names" {
  value = module.observability.alarm_names
}

output "dashboard_name" {
  value = module.observability.dashboard_name
}
