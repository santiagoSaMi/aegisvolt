# Bootstrap del estado remoto (ADR-0011, ADR-0033): el bucket S3 que guarda el estado de
# live/ (env:/<workspace>/...), de global/ y de este mismo bootstrap.
#
# Problema del huevo y la gallina: el bucket no existe cuando este código se aplica por
# primera vez. scripts/floci/terraform-bootstrap.sh lo aplica entonces con estado local
# y después migra ese estado al bucket (terraform init -migrate-state).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket

  # El historial de estados de los tres ambientes vive aquí.
  lifecycle {
    prevent_destroy = true
  }
}

# Versionado: cada escritura del estado conserva la anterior (restauración, §6.1).
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Clave KMS propia del estado (AWS-0132): control de acceso a la clave y auditoría de su uso,
# además del cifrado. Rotación anual; ventana de borrado máxima (30 días).
resource "aws_kms_key" "state" {
  description             = "AegisVolt: cifrado del estado de Terraform (${var.state_bucket})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/aegisvolt-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

# Cifrado por defecto del bucket con esa clave (bucket key: menos llamadas a KMS). Los backends
# usan encrypt = false para NO forzar SSE-S3 en cada escritura: así el estado queda cifrado con
# esta clave por el cifrado por defecto del bucket.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Sin ACLs: el acceso lo deciden solo las políticas.
resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Política mínima compatible con Floci (que la guarda pero no la evalúa sin
# FLOCI_SERVICES_S3_ENFORCE_AUTH, L-12):
# - solo la propia cuenta, y solo por TLS;
# - nadie borra el bucket ni desactiva su versionado por API.
data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyOtherAccounts"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "ProtectBucketAndHistory"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration"]
    resources = [aws_s3_bucket.state.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    # Solo el rol de administración de Terraform (en AWS real) puede cambiarlos.
    condition {
      test     = "StringNotLike"
      variable = "aws:PrincipalArn"
      values   = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/aegisvolt-terraform-admin"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  # La política se aplica después del bloqueo de acceso público (que no la considera pública).
  depends_on = [aws_s3_bucket_public_access_block.state]
}

# Retención de versiones anteriores: N días, conservando siempre las 10 más recientes.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "state-history"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = var.noncurrent_version_retention_days
      newer_noncurrent_versions = 10
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}
