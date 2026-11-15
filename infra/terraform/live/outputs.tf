output "environment" {
  value = local.environment
}

output "table_names" {
  description = "Tablas DynamoDB del ambiente (database-per-service)."
  value       = { for k, t in module.tables : k => t.name }
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "vpc_endpoints" {
  value = merge(module.network.gateway_endpoint_ids, module.network.interface_endpoint_ids)
}

output "eks_cluster_name" {
  value = try(module.eks[0].cluster_name, null)
}

output "workload_role_arns" {
  value = module.iam.role_arns
}

output "api_invoke_urls" {
  value = module.api_gateway.invoke_urls
}

output "api_target_group_arn" {
  value = module.api_gateway.target_group_arn
}

output "log_group_names" {
  value = module.cloudwatch.log_group_names
}

output "metric_namespace" {
  value = module.cloudwatch.metric_namespace
}

output "alarm_names" {
  value = module.cloudwatch.alarm_names
}

output "dashboard_name" {
  value = module.cloudwatch.dashboard_name
}
