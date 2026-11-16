output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = [for s in aws_subnet.public : s.id]
}

output "private_subnet_ids" {
  value = [for s in aws_subnet.private : s.id]
}

output "private_route_table_ids" {
  value = [for rt in aws_route_table.private : rt.id]
}

output "nat_gateway_ids" {
  value = [for n in aws_nat_gateway.this : n.id]
}

output "gateway_endpoint_ids" {
  value = { dynamodb = aws_vpc_endpoint.dynamodb.id, s3 = aws_vpc_endpoint.s3.id }
}

output "interface_endpoint_ids" {
  value = { for k, e in aws_vpc_endpoint.interface : k => e.id }
}

output "execute_api_endpoint_id" {
  description = "Interface VPCE de API Gateway (para la resource policy aws:SourceVpce de la API privada)."
  value       = try(aws_vpc_endpoint.interface["execute-api"].id, null)
}

output "endpoints_security_group_id" {
  value = aws_security_group.endpoints.id
}

output "private_subnet_cidrs" {
  description = "CIDR de cada subred privada (origen o destino de las reglas de SG)."
  value       = [for s in aws_subnet.private : s.cidr_block]
}
