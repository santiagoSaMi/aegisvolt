# Repositorios de imágenes (ADR-0011, ADR-0031). Compartidos entre ambientes: la misma
# imagen (mismo digest) se promueve de dev a test y prod sin recompilar. Etiquetas
# inmutables (sha-<commit>), escaneo al subir y retención acotada.

resource "aws_ecr_repository" "this" {
  for_each = toset(var.repositories)

  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}/${each.key}" })
}

# Retención: imágenes sin etiqueta tras N días y como máximo M etiquetas sha-*.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expira imágenes sin etiqueta"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_expiration_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Conserva las últimas imágenes sha-*"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = var.max_tagged_images
        }
        action = { type = "expire" }
      },
    ]
  })
}
