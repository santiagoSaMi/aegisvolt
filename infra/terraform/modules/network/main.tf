# Red de un ambiente (ADR-0010): VPC dedicada, subredes públicas (NAT, balanceadores
# públicos) y privadas (EKS, NLB interno, VPCE), y VPC Endpoints para que el tráfico
# hacia los servicios AWS no salga a internet.
#
# Floci (L-01): todo se crea y queda `available`, pero no enruta paquetes; el
# aislamiento es declarativo y se verifica con describe-* por ambiente.

data "aws_region" "current" {}

locals {
  name = "aegisvolt-${var.environment}"
  azs  = slice(var.availability_zones, 0, var.az_count)

  # /16 → públicas /24 en 10.x.0-1, privadas /20 en 10.x.16-47 (espacio para pods).
  public_subnets  = { for i, az in local.azs : az => cidrsubnet(var.vpc_cidr, 8, i) }
  private_subnets = { for i, az in local.azs : az => cidrsubnet(var.vpc_cidr, 4, i + 1) }

  nat_azs = var.single_nat_gateway ? [local.azs[0]] : local.azs

  service_prefix = "com.amazonaws.${data.aws_region.current.region}"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # requerido por los Interface VPCE con DNS privado

  tags = merge(var.tags, { Name = local.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = local.name })
}

# --- Subredes ------------------------------------------------------------------------------
resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value
  # Sin IP pública automática: solo NAT y balanceadores viven aquí.
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name                     = "${local.name}-public-${each.key}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = merge(var.tags, {
    Name                              = "${local.name}-private-${each.key}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

# --- Salida a internet: IGW (públicas) y NAT (privadas) ---------------------------------------
resource "aws_eip" "nat" {
  for_each = toset(local.nat_azs)

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${local.name}-nat-${each.key}" })
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_azs)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = merge(var.tags, { Name = "${local.name}-${each.key}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${local.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = local.public_subnets

  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

# Una tabla por AZ privada: cada una sale por el NAT de su AZ (o el único NAT).
resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${local.name}-private-${each.key}" })
}

resource "aws_route" "private_nat" {
  for_each = local.private_subnets

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? local.azs[0] : each.key].id
}

resource "aws_route_table_association" "private" {
  for_each = local.private_subnets

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

# --- VPC Endpoints -----------------------------------------------------------------------------
# Gateway (S3, DynamoDB): rutas de prefix list en las tablas privadas. Las políticas solo
# permiten los recursos del ambiente (ver variables *_endpoint_policy_resources).
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "${local.service_prefix}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.private : rt.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyThisEnvironmentTables"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["dynamodb:*"]
      Resource  = var.dynamodb_endpoint_policy_resources
    }]
  })

  tags = merge(var.tags, { Name = "${local.name}-dynamodb" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "${local.service_prefix}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.private : rt.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyAllowedBuckets"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = var.s3_endpoint_policy_resources
    }]
  })

  tags = merge(var.tags, { Name = "${local.name}-s3" })
}

resource "aws_security_group" "endpoints" {
  name        = "${local.name}-vpce"
  description = "Interface VPC endpoints: HTTPS desde la VPC del ambiente"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${local.name}-vpce" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS desde la VPC"
  cidr_ipv4         = aws_vpc.this.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Interface: CloudWatch (logs, monitoring), API Gateway (execute-api), Kubernetes (eks),
# ECR, STS y ELB. Una ENI por subred privada y DNS privado: los SDK no cambian de URL.
resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoints)

  vpc_id              = aws_vpc.this.id
  service_name        = "${local.service_prefix}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(var.tags, { Name = "${local.name}-${each.key}" })
}
