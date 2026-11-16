output "rest_api_ids" {
  value = { for k, a in aws_api_gateway_rest_api.this : k => a.id }
}

output "invoke_urls" {
  description = "Endpoint HTTPS de cada API (stage del ambiente): lo que consume el cliente."
  value       = { for k, s in aws_api_gateway_stage.this : k => s.invoke_url }
}

output "graphql_urls" {
  value = { for k, s in aws_api_gateway_stage.this : k => "${s.invoke_url}/graphql" }
}

output "vpc_link_id" {
  value = aws_api_gateway_vpc_link.this.id
}

output "nlb_arn" {
  value = aws_lb.internal.arn
}

output "nlb_dns_name" {
  value = aws_lb.internal.dns_name
}

output "target_group_arn" {
  description = "Target group del ingress. Targets: en AWS, IPs de los pods de Traefik (AWS Load Balancer Controller, TargetGroupBinding); en Floci, el contenedor k3s (k8s-deploy.sh)."
  value       = aws_lb_target_group.ingress.arn
}

output "access_log_group" {
  value = aws_cloudwatch_log_group.access.name
}

output "nlb_security_group_id" {
  value = aws_security_group.nlb.id
}
