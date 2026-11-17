# Clúster EKS de un ambiente (ADR-0012, ADR-0033): roles del plano de control y de los
# nodos, clúster en las subredes privadas, node group administrado y asociaciones de
# Pod Identity (rol IAM ↔ ServiceAccount).
#
# Floci (L-03): crea un k3s real por clúster; un solo nodo compartido; endpointPublicAccess
# y endpointPrivateAccess se guardan pero no se aplican; sin UpdateClusterConfig/Version
# (un cambio de subredes o de versión exige recrear el clúster).

data "aws_partition" "current" {}

locals {
  managed_policy = "arn:${data.aws_partition.current.partition}:iam::aws:policy"
}

# --- Rol del plano de control ------------------------------------------------------------------
data "aws_iam_policy_document" "cluster_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.cluster_name}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "${local.managed_policy}/AmazonEKSClusterPolicy"
}

# --- Rol de los nodos -----------------------------------------------------------------------------
data "aws_iam_policy_document" "node_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.cluster_name}-eks-node"
  assume_role_policy = data.aws_iam_policy_document.node_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset(["AmazonEKSWorkerNodePolicy", "AmazonEKS_CNI_Policy", "AmazonEC2ContainerRegistryReadOnly"])

  role       = aws_iam_role.node.name
  policy_arn = "${local.managed_policy}/${each.key}"
}

# --- Clúster ----------------------------------------------------------------------------------------
# Logs del plano de control: EKS los escribe en este grupo. Se declara antes que el clúster
# para fijar la retención (si no, EKS lo crea sin expiración). Floci también los emite.
resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = var.control_plane_log_retention_in_days
  tags              = var.tags
}

# Clave KMS propia del clúster para cifrar los Secrets de Kubernetes en etcd (AWS-0039).
# Rotación anual; ventana de borrado máxima.
resource "aws_kms_key" "secrets" {
  description             = "AegisVolt: Secrets de Kubernetes de ${var.cluster_name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = var.tags
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.cluster_name}-eks-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : null
  }

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  enabled_cluster_log_types = var.control_plane_log_types

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.secrets.arn
    }
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.control_plane]
}

resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.cluster_name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = var.node_instance_types
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.node_min_size
    desired_size = var.node_desired_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy_attachment.node]
}

# Agente de Pod Identity: entrega a cada pod las credenciales del rol asociado.
resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "eks-pod-identity-agent"
  tags         = var.tags
}

resource "aws_eks_pod_identity_association" "this" {
  for_each = var.pod_identity_associations

  cluster_name    = aws_eks_cluster.this.name
  namespace       = each.value.namespace
  service_account = each.value.service_account
  role_arn        = each.value.role_arn
  tags            = var.tags

  depends_on = [aws_eks_addon.pod_identity_agent]
}

# --- Security groups ------------------------------------------------------------------------------
# Los nodos de un node group administrado (y los pods, con la VPC CNI) usan el SG del clúster
# que crea EKS. Solo se añade lo necesario para la entrada: el NLB interno alcanza el puerto
# del ingress (Traefik). El resto (plano de control ↔ nodos, nodo ↔ nodo) lo gestiona EKS.
resource "aws_vpc_security_group_ingress_rule" "ingress_from" {
  for_each = var.ingress_sources

  security_group_id            = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  description                  = "Ingress del cluster desde ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.ingress_port
  to_port                      = var.ingress_port
  tags                         = var.tags
}
