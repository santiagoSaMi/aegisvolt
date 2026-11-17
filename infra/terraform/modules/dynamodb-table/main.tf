# Tabla DynamoDB genérica (patrón database-per-service, ADR-0011/0020).
# Clave PK/SK de tipo String, GSIs opcionales, TTL, PITR y protección contra borrado.
# El esquema debe coincidir con el `tableDefinition` del servicio dueño de la tabla.

locals {
  key_attributes = toset(compact(concat(
    [var.hash_key, var.range_key],
    flatten([for gsi in var.global_secondary_indexes : [gsi.hash_key, gsi.range_key]]),
  )))
}

resource "aws_dynamodb_table" "this" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = var.hash_key
  range_key    = var.range_key

  # Solo se declaran los atributos de clave (tabla e índices): DynamoDB no admite otros.
  dynamic "attribute" {
    for_each = local.key_attributes
    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "global_secondary_index" {
    for_each = var.global_secondary_indexes
    content {
      name            = global_secondary_index.value.name
      projection_type = "ALL"

      # key_schema (provider >= 6.x): hash_key/range_key del GSI están deprecados.
      key_schema {
        attribute_name = global_secondary_index.value.hash_key
        key_type       = "HASH"
      }

      dynamic "key_schema" {
        for_each = global_secondary_index.value.range_key == null ? [] : [global_secondary_index.value.range_key]
        content {
          attribute_name = key_schema.value
          key_type       = "RANGE"
        }
      }
    }
  }

  dynamic "ttl" {
    for_each = var.ttl_attribute == null ? [] : [var.ttl_attribute]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  # Cifrado en reposo: el predeterminado de DynamoDB (clave propiedad de AWS, siempre
  # activo). Una CMK propia (server_side_encryption) es una evolución para prod.

  deletion_protection_enabled = var.deletion_protection

  tags = merge(var.tags, { Name = var.name })
}
