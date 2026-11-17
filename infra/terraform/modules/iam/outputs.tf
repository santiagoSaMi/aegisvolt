output "role_arns" {
  description = "ARN del rol de cada carga de trabajo."
  value       = { for k, r in aws_iam_role.workload : k => r.arn }
}

output "pod_identity_associations" {
  description = "Entrada para el módulo eks: rol ↔ ServiceAccount."
  value = {
    for k, w in var.workloads : k => {
      namespace       = w.namespace
      service_account = w.service_account
      role_arn        = aws_iam_role.workload[k].arn
    }
  }
}
