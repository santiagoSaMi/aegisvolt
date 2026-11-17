output "name" {
  value = aws_dynamodb_table.this.name
}

output "arn" {
  value = aws_dynamodb_table.this.arn
}

output "index_arns" {
  description = "ARN de cada GSI (para políticas IAM de mínimo privilegio)."
  value       = ["${aws_dynamodb_table.this.arn}/index/*"]
}
