# Destino LOCAL: Floci. Solo endpoints locales y la cuenta ficticia de Floci.
target              = "floci"
floci_endpoint      = "http://localhost:4566"
aws_region          = "us-east-1"
allowed_account_ids = ["000000000000"] # cuenta única de Floci (L-08, L-11)
floci_ingress_host  = "floci"
ingress_target_port = 30080 # NodePort de Traefik en el contenedor k3s (platform/local); en AWS: 8000 en los pods
