output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "apigateway_cloudwatch_role_arn" {
  value = aws_iam_role.apigateway_cloudwatch.arn
}
