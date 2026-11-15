#!/usr/bin/env bash
# Despliega AegisVolt en el clúster EKS (k3s) de Floci de un ambiente (ADR-0012, ADR-0031).
#
# Uso: scripts/floci/k8s-deploy.sh <dev|test|prod> [--tag <tag>] [--no-smoke]
#   --tag       usa imágenes ya construidas (aegisvolt/<app>:<tag>) en lugar de construir
#   --no-smoke  no ejecuta la prueba de humo final
#
# Pasos (idempotentes): imágenes con tag inmutable → ECR de Floci → clúster aegisvolt-<env>
# → tablas y Cognito del ambiente → kustomize (overlay + imágenes del commit) → rollout
# → prueba de humo (salud, login real con Cognito vía la web, consulta GraphQL).
# Requiere `scripts/floci/terraform-live.sh <env> apply` (log groups de CloudWatch).
# Nunca destruye nada; para borrar el clúster ver docs/runbooks/k8s-floci.md.
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"; shift || true
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "Uso: $0 <dev|test|prod> [--tag <tag>] [--no-smoke]"
TAG=""; SMOKE=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) shift; TAG="${1:?--tag requiere un valor}" ;;
    --no-smoke) SMOKE=false ;;
    *) die "Opción desconocida: $1" ;;
  esac
  shift
done

require_docker
require_cmd aws
require_cmd jq
require_cmd kubectl
load_aws_local_env
ensure_usable_docker_config
curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde en ${FLOCI_ENDPOINT}"
FLOCI_CA="${FLOCI_DATA_DIR}/tls/floci-root-ca.crt"
[[ -f "$FLOCI_CA" ]] || die "Falta ${FLOCI_CA}: Floci debe correr con FLOCI_TLS_ENABLED=true"
aws logs describe-log-groups --log-group-name-prefix "/aegisvolt/${ENV}/graphql-api" --query 'logGroups[0].logGroupName' --output text \
  | grep -q "/aegisvolt/${ENV}/graphql-api" || die "Faltan los log groups de ${ENV}: scripts/floci/terraform-live.sh ${ENV} apply"

APPS=(station-reservation billing-wallet energy-dispatch saga-orchestrator graphql-api web)
CLUSTER="aegisvolt-${ENV}"
STATE="${FLOCI_TMP_DIR}/k8s-${ENV}"
mkdir -p "$STATE"
ACCOUNT="000000000000"; REGION="us-east-1"
REGISTRY="localhost:4566/${ACCOUNT}/${REGION}"

# --- 1. Imágenes ----------------------------------------------------------------------
if [[ -z "$TAG" ]]; then
  log_info "Construyendo imágenes"
  "${REPO_ROOT}/scripts/docker/build-images.sh" --tag-file "${STATE}/tag" >/dev/null
  TAG="$(cat "${STATE}/tag")"
fi
for app in "${APPS[@]}"; do
  docker image inspect "aegisvolt/${app}:${TAG}" >/dev/null 2>&1 || die "No existe la imagen aegisvolt/${app}:${TAG}"
done
log_ok "Imágenes aegisvolt/*:${TAG}"

# --- 2. ECR de Floci ------------------------------------------------------------------------
aws ecr get-login-password | docker login --username AWS --password-stdin localhost:4566 >/dev/null
for app in "${APPS[@]}"; do
  aws ecr describe-repositories --repository-names "aegisvolt/${app}" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "aegisvolt/${app}" --image-tag-mutability IMMUTABLE >/dev/null
  if aws ecr describe-images --repository-name "aegisvolt/${app}" --image-ids "imageTag=${TAG}" >/dev/null 2>&1; then
    continue  # tag inmutable ya publicado
  fi
  docker tag "aegisvolt/${app}:${TAG}" "${REGISTRY}/aegisvolt/${app}:${TAG}"
  docker push -q "${REGISTRY}/aegisvolt/${app}:${TAG}" >/dev/null
done
log_ok "Imágenes en ECR (${REGISTRY}/aegisvolt/*:${TAG})"

# --- 3. Clúster EKS (k3s) ---------------------------------------------------------------
if ! aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
  log_info "Creando el clúster ${CLUSTER}"
  ROLE_ARN="$(aws iam get-role --role-name "${CLUSTER}-cluster" --query Role.Arn --output text 2>/dev/null \
    || aws iam create-role --role-name "${CLUSTER}-cluster" --query Role.Arn --output text \
         --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"eks.amazonaws.com"},"Action":"sts:AssumeRole"}]}')"
  SUBNETS="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')"
  aws eks create-cluster --name "$CLUSTER" --kubernetes-version 1.36 --role-arn "$ROLE_ARN" \
    --resources-vpc-config "subnetIds=${SUBNETS}" >/dev/null
fi
for _ in $(seq 1 60); do
  [[ "$(aws eks describe-cluster --name "$CLUSTER" --query cluster.status --output text)" == ACTIVE ]] && break
  sleep 5
done
# test/test es rechazado por el webhook IAM de Floci: access key emitida por Floci (ficticia).
KUBE_CREDS="${STATE}/kube-credentials.env"
if [[ ! -f "$KUBE_CREDS" ]]; then
  aws iam get-user --user-name "${CLUSTER}-kube" >/dev/null 2>&1 || aws iam create-user --user-name "${CLUSTER}-kube" >/dev/null
  read -r AK SK < <(aws iam create-access-key --user-name "${CLUSTER}-kube" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  (umask 077; printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$AK" "$SK" > "$KUBE_CREDS")
fi
k() { (set -a; source "$KUBE_CREDS"; set +a; KUBECONFIG="${STATE}/kubeconfig" kubectl "$@"); }
(set -a; source "$KUBE_CREDS"; set +a; aws eks update-kubeconfig --name "$CLUSTER" --kubeconfig "${STATE}/kubeconfig" >/dev/null)
for _ in $(seq 1 60); do k get serviceaccount default >/dev/null 2>&1 && break; sleep 2; done
log_ok "Clúster ${CLUSTER} ACTIVE ($(k version -o json | jq -r .serverVersion.gitVersion)); kubeconfig: ${STATE}/kubeconfig"

# --- 4. Datos e identidad del ambiente ---------------------------------------------------
"${REPO_ROOT}/scripts/floci/bootstrap-env.sh" "$ENV" >/dev/null
IDENTITY="${FLOCI_TMP_DIR}/identity-${ENV}.env"
# shellcheck source=/dev/null
source "$IDENTITY"
log_ok "Tablas y Cognito de ${ENV} (pool ${COGNITO_POOL_ID})"

# --- 5. Manifiestos: overlay + imágenes del commit + IP de Floci -------------------------
FLOCI_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "aegisvolt-floci").IPAddress}}' "$FLOCI_CONTAINER")"
RENDER="${STATE}/kustomize"
mkdir -p "$RENDER"
{
  echo "apiVersion: kustomize.config.k8s.io/v1beta1"
  echo "kind: Kustomization"
  echo "resources:"
  echo "  - $(realpath --relative-to="$RENDER" "${REPO_ROOT}/infra/k8s/overlays/${ENV}")"
  echo "images:"
  for app in "${APPS[@]}"; do
    printf '  - name: aegisvolt/%s\n    newName: %s/aegisvolt/%s\n    newTag: %s\n' "$app" "$REGISTRY" "$app" "$TAG"
  done
} > "${RENDER}/kustomization.yaml"
kubectl kustomize "$RENDER" | sed "s/FLOCI_IP/${FLOCI_IP}/g" > "${STATE}/manifests.yaml"

k apply -f "${STATE}/manifests.yaml" >/dev/null 2>&1 || true   # crea los namespaces
# Identidad del ambiente (no secreta) y CA de Floci: los publica el despliegue.
k -n aegisvolt create configmap aegisvolt-identity --dry-run=client -o yaml \
  --from-literal=COGNITO_ISSUER="$COGNITO_ISSUER" --from-literal=COGNITO_JWKS_URL="$COGNITO_JWKS_URL" \
  --from-literal=COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" | k apply -f - >/dev/null
k -n logging create configmap floci-ca --from-file=floci-root-ca.crt="$FLOCI_CA" --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f "${STATE}/manifests.yaml" >/dev/null
log_ok "Manifiestos aplicados (${STATE}/manifests.yaml)"

for app in station-reservation-service billing-wallet-service energy-dispatch-service saga-orchestrator-service graphql-api web; do
  if ! k -n aegisvolt rollout status "deploy/${app}" --timeout=300s >/dev/null; then
    k -n aegisvolt get pods -o wide >&2
    k -n aegisvolt describe "deploy/${app}" | tail -n 20 >&2
    die "Rollout de ${app} fallido"
  fi
done
k -n logging rollout status ds/fluent-bit --timeout=300s >/dev/null
log_ok "Rollouts completos en ${CLUSTER}"
k -n aegisvolt get deploy,svc,pods -o wide

# --- 6. Prueba de humo ----------------------------------------------------------------------
$SMOKE || exit 0
PF_LOG="${STATE}/port-forward.log"
k -n aegisvolt port-forward svc/web 18080:80 >"$PF_LOG" 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:18080/healthz 2>/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:18080/healthz >/dev/null || die "web /healthz no responde por port-forward"
CONFIG_ENV="$(curl -fsS http://127.0.0.1:18080/config.json | jq -r .environment)"
[[ "$CONFIG_ENV" == "$ENV" ]] || die "config.json informa ${CONFIG_ENV}, se esperaba ${ENV}"
TOKEN="$(curl -fsS http://127.0.0.1:18080/auth/cognito -H 'content-type: application/x-amz-json-1.1' \
  -H 'x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"ClientId\":\"${COGNITO_CLIENT_ID}\",\"AuthParameters\":{\"USERNAME\":\"operador\",\"PASSWORD\":\"${DEMO_PASSWORD}\"}}" \
  | jq -r .AuthenticationResult.IdToken)"
[[ -n "$TOKEN" && "$TOKEN" != null ]] || die "Login de Cognito vía la web fallido"
VIEWER="$(curl -fsS http://127.0.0.1:18080/graphql -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" \
  -d '{"query":"{ viewer { environment fleetId isAdmin } systemStatus { services { service ready } } }"}')"
echo "$VIEWER" | jq -e ".data.viewer.environment == \"${ENV}\" and .data.viewer.fleetId == \"${DEMO_FLEET}\" and ([.data.systemStatus.services[].ready] | all)" >/dev/null \
  || die "GraphQL respondió: ${VIEWER}"
log_ok "Humo: web /healthz, config.json (${CONFIG_ENV}), login Cognito vía web, GraphQL viewer y 4 servicios listos"
log_info "Consola: kubectl port-forward (KUBECONFIG=${STATE}/kubeconfig) -n aegisvolt svc/web 8080:80"
