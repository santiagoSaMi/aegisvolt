output "rest_api_ids" {
  value = { for k, a in aws_api_gateway_rest_api.this : k => a.id }
}

output "invoke_urls" {
  value = { for k, s in aws_api_gateway_stage.this : k => s.invoke_url }
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
  description = "Target group del ingress (lo enlaza el AWS Load Balancer Controller en EKS)."
  value       = aws_lb_target_group.ingress.arn
}

output "access_log_group" {
  value = aws_cloudwatch_log_group.access.name
}
