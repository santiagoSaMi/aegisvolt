output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_arn" {
  value = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_security_group_id" {
  value = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "node_group_name" {
  value = aws_eks_node_group.this.node_group_name
}

output "node_role_arn" {
  value = aws_iam_role.node.arn
}

output "cluster_certificate_authority_data" {
  description = "CA del API server (base64), para validar TLS."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "endpoint_access" {
  value = {
    private = aws_eks_cluster.this.vpc_config[0].endpoint_private_access
    public  = aws_eks_cluster.this.vpc_config[0].endpoint_public_access
  }
}

# kubeconfig sin secretos: el token lo genera `aws eks get-token` con las credenciales de
# quien ejecuta kubectl (en AWS, su rol; en Floci, la access key emitida por Floci).
output "kubeconfig" {
  value = yamlencode({
    apiVersion      = "v1"
    kind            = "Config"
    current-context = aws_eks_cluster.this.name
    clusters = [{
      name    = aws_eks_cluster.this.name
      cluster = { server = aws_eks_cluster.this.endpoint, certificate-authority-data = aws_eks_cluster.this.certificate_authority[0].data }
    }]
    contexts = [{ name = aws_eks_cluster.this.name, context = { cluster = aws_eks_cluster.this.name, user = aws_eks_cluster.this.name } }]
    users = [{
      name = aws_eks_cluster.this.name
      user = {
        exec = {
          apiVersion = "client.authentication.k8s.io/v1beta1"
          command    = "aws"
          args       = ["eks", "get-token", "--cluster-name", aws_eks_cluster.this.name, "--output", "json"]
          env        = [for k, v in var.kubeconfig_exec_env : { name = k, value = v }]
        }
      }
    }]
  })
}
