# Recursos compartidos entre ambientes (ADR-0011, ADR-0033). No usan workspaces: su
# identificador de alcance es "shared" (etiqueta Scope) y viven en su propia clave de
# estado, así que un apply de dev, test o prod nunca los modifica.

# Repositorios de imágenes: la misma imagen (mismo digest) se promueve entre ambientes.
module "ecr" {
  source = "../modules/ecr"

  name_prefix  = "aegisvolt"
  repositories = var.repositories
}

# API Gateway: rol con el que el servicio escribe los logs de acceso de los stages en
# CloudWatch. Es un ajuste único por cuenta y región; por eso vive aquí y no en live/.
data "aws_iam_policy_document" "apigateway_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigateway_cloudwatch" {
  name               = "aegisvolt-apigateway-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.apigateway_trust.json
}

resource "aws_iam_role_policy_attachment" "apigateway_cloudwatch" {
  role       = aws_iam_role.apigateway_cloudwatch.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  cloudwatch_role_arn = aws_iam_role.apigateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy_attachment.apigateway_cloudwatch]
}

data "aws_partition" "current" {}
