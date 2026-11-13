#!/usr/bin/env bash
# Smoke tests de Floci con AWS CLI.
#
# Uso: scripts/floci/smoke-test.sh [--with-eks] [--keep] [--only <test>]
#   --with-eks  incluye EKS (crea un clúster k3s temporal; ~1-2 min, ~1 GB RAM)
#   --keep      no elimina los recursos temporales (para inspección manual)
#   --only      ejecuta una sola prueba: s3|dynamodb|logs|apigw|vpc|ecr|eks
#
# Todos los recursos llevan el prefijo "aegisvolt-smoke-<id>" y SOLO esos se
# eliminan al final (trap). Nunca se tocan otros recursos ni infra/local/floci/data.
# Exit 0 si todas las pruebas ejecutadas pasan.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set +e  # cada prueba gestiona sus errores; el resultado se agrega en la matriz

WITH_EKS=false; KEEP=false; ONLY=""
while (( $# > 0 )); do
  case "$1" in
    --with-eks) WITH_EKS=true ;;
    --keep) KEEP=true ;;
    --only) shift; ONLY="${1:?--only requiere un valor: s3|dynamodb|logs|apigw|vpc|ecr|eks}" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "Argumento desconocido: $1" ;;
  esac
  shift
done
[[ "$ONLY" == "eks" ]] && WITH_EKS=true

require_docker; require_cmd aws; require_cmd jq; require_cmd curl
$WITH_EKS && require_cmd kubectl
load_aws_local_env
ensure_usable_docker_config
floci_is_healthy || die "Floci no responde en ${FLOCI_HEALTH_URL}. Ejecuta scripts/floci/start.sh"

RUN_ID="$(date +%s)-$RANDOM"
P="aegisvolt-smoke-${RUN_ID}"
WORK="${FLOCI_TMP_DIR}/smoke-${RUN_ID}"
mkdir -p "$WORK"
FLOCI_VERSION="$(curl -fsS "${FLOCI_HEALTH_URL}" | jq -r .version)"

# ---------- registro de resultados y limpieza ----------
RESULTS=()
FAILED=0
record() {  # record <servicio> <estado> <evidencia>
  RESULTS+=("$1|$2|$3")
  case "$2" in
    funcional) log_ok "$1: $3" ;;
    fallido) FAILED=$((FAILED + 1)); log_error "$1: $3" ;;
    *) log_warn "$1 [$2]: $3" ;;
  esac
}

CLEANUP=()
on_cleanup() { CLEANUP+=("$*"); }
run_cleanup() {
  if $KEEP; then log_warn "--keep: recursos conservados con prefijo ${P}"; return; fi
  local i
  for (( i=${#CLEANUP[@]}-1; i>=0; i-- )); do
    eval "${CLEANUP[$i]}" >/dev/null 2>&1 || log_warn "limpieza falló: ${CLEANUP[$i]}"
  done
  rm -rf "$WORK"
  log_info "Limpieza de recursos temporales ${P}* completada."
}
trap run_cleanup EXIT

section() { printf '\n%s== %s ==%s\n' "$C_BLU" "$*" "$C_RST"; }

# ---------- S3 ----------
test_s3() {
  section "S3"
  local b="${P}-bucket"
  aws s3api create-bucket --bucket "$b" >/dev/null || { record S3 fallido "create-bucket"; return; }
  on_cleanup "aws s3api list-object-versions --bucket '$b' --output json | jq -c '.Versions[]?, .DeleteMarkers[]? | {k:.Key,v:.VersionId}' | while read -r o; do aws s3api delete-object --bucket '$b' --key \"\$(jq -r .k <<<\"\$o\")\" --version-id \"\$(jq -r .v <<<\"\$o\")\"; done; aws s3api delete-bucket --bucket '$b'"
  aws s3api list-buckets --query "Buckets[?Name=='$b'].Name" --output text | grep -qx "$b" \
    || { record S3 fallido "bucket no listado"; return; }
  aws s3api put-bucket-versioning --bucket "$b" --versioning-configuration Status=Enabled
  local vs; vs="$(aws s3api get-bucket-versioning --bucket "$b" --query Status --output text)"
  echo '{"v":1}' > "$WORK/state.json"; aws s3api put-object --bucket "$b" --key env:/dev/terraform.tfstate --body "$WORK/state.json" >/dev/null
  echo '{"v":2}' > "$WORK/state.json"; aws s3api put-object --bucket "$b" --key env:/dev/terraform.tfstate --body "$WORK/state.json" >/dev/null
  local nv old
  nv="$(aws s3api list-object-versions --bucket "$b" --prefix env:/dev/ --query 'length(Versions)' --output text)"
  old="$(aws s3api list-object-versions --bucket "$b" --prefix env:/dev/ --query 'Versions[?IsLatest==`false`].VersionId | [0]' --output text)"
  aws s3api get-object --bucket "$b" --key env:/dev/terraform.tfstate --version-id "$old" "$WORK/old.json" >/dev/null
  if [[ "$vs" == "Enabled" && "$nv" == "2" && "$(cat "$WORK/old.json")" == '{"v":1}' ]]; then
    record S3 funcional "create/list bucket, versioning=Enabled, 2 versiones de env:/dev/terraform.tfstate, versión previa recuperada"
  else
    record S3 fallido "versioning=$vs versiones=$nv"
  fi
}

# ---------- DynamoDB ----------
test_dynamodb() {
  section "DynamoDB"
  local t="${P}-table"
  aws dynamodb create-table --table-name "$t" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null \
    || { record DynamoDB fallido "create-table"; return; }
  on_cleanup "aws dynamodb delete-table --table-name '$t'"
  aws dynamodb wait table-exists --table-name "$t"
  local item='{"pk":{"S":"SAGA#c-1"},"sk":{"S":"STEP#REFUND"},"status":{"S":"DONE"}}'
  aws dynamodb put-item --table-name "$t" --item "$item" --condition-expression 'attribute_not_exists(pk)' \
    || { record DynamoDB fallido "put-item"; return; }
  # Segunda escritura idéntica: debe fallar por la condición (base de la idempotencia de la SAGA).
  local err; err="$(aws dynamodb put-item --table-name "$t" --item "$item" --condition-expression 'attribute_not_exists(pk)' 2>&1)"
  local got; got="$(aws dynamodb get-item --table-name "$t" --key '{"pk":{"S":"SAGA#c-1"},"sk":{"S":"STEP#REFUND"}}' --query Item.status.S --output text)"
  local q; q="$(aws dynamodb query --table-name "$t" --key-condition-expression 'pk = :p' --expression-attribute-values '{":p":{"S":"SAGA#c-1"}}' --query Count --output text)"
  if [[ "$err" == *ConditionalCheckFailedException* && "$got" == "DONE" && "$q" == "1" ]]; then
    record DynamoDB funcional "create-table, put/get/query, escritura condicional duplicada rechazada (ConditionalCheckFailedException)"
  else
    record DynamoDB fallido "cond='${err:0:80}' get=$got query=$q"
  fi
}

# ---------- CloudWatch Logs ----------
test_logs() {
  section "CloudWatch Logs"
  local g="/aegisvolt/smoke/${RUN_ID}" s="station-reservation-service"
  aws logs create-log-group --log-group-name "$g" || { record "CloudWatch Logs" fallido "create-log-group"; return; }
  on_cleanup "aws logs delete-log-group --log-group-name '$g'"
  aws logs put-retention-policy --log-group-name "$g" --retention-in-days 7
  aws logs create-log-stream --log-group-name "$g" --log-stream-name "$s"
  local now; now="$(($(date +%s) * 1000))"
  local msg="{\\\"level\\\":\\\"info\\\",\\\"service\\\":\\\"$s\\\",\\\"environment\\\":\\\"smoke\\\",\\\"correlation_id\\\":\\\"corr-${RUN_ID}\\\",\\\"message\\\":\\\"connector reserved\\\"}"
  aws logs put-log-events --log-group-name "$g" --log-stream-name "$s" \
    --log-events "[{\"timestamp\":$now,\"message\":\"$msg\"}]" >/dev/null || { record "CloudWatch Logs" fallido "put-log-events"; return; }
  local got filt ret
  got="$(aws logs get-log-events --log-group-name "$g" --log-stream-name "$s" --start-from-head --query 'length(events)' --output text)"
  filt="$(aws logs filter-log-events --log-group-name "$g" --filter-pattern "\"corr-${RUN_ID}\"" --query 'length(events)' --output text)"
  ret="$(aws logs describe-log-groups --log-group-name-prefix "$g" --query 'logGroups[0].retentionInDays' --output text)"
  if [[ "$got" == "1" && "$filt" == "1" && "$ret" == "7" ]]; then
    record "CloudWatch Logs" funcional "log group /aegisvolt/<env>/..., retención 7d, put/get, filter-log-events por correlation_id"
  else
    record "CloudWatch Logs" fallido "get=$got filter=$filt retention=$ret"
  fi
}

# helper: método GET con integración MOCK sobre un recurso
apigw_mock_get() {  # <api> <resource> <json-body>
  aws apigateway put-method --rest-api-id "$1" --resource-id "$2" --http-method GET --authorization-type NONE >/dev/null &&
  aws apigateway put-integration --rest-api-id "$1" --resource-id "$2" --http-method GET --type MOCK \
    --request-templates '{"application/json":"{\"statusCode\": 200}"}' >/dev/null &&
  aws apigateway put-method-response --rest-api-id "$1" --resource-id "$2" --http-method GET --status-code 200 >/dev/null &&
  aws apigateway put-integration-response --rest-api-id "$1" --resource-id "$2" --http-method GET --status-code 200 \
    --response-templates "{\"application/json\":\"$3\"}" >/dev/null
}

# ---------- API Gateway (REST v1) ----------
test_apigw() {
  section "API Gateway"
  local api root res code body
  api="$(aws apigateway create-rest-api --name "${P}-api" --endpoint-configuration types=REGIONAL --query id --output text)" \
    || { record "API Gateway (REST)" fallido "create-rest-api"; return; }
  on_cleanup "aws apigateway delete-rest-api --rest-api-id '$api'"
  root="$(aws apigateway get-resources --rest-api-id "$api" --query 'items[?path==`/`].id' --output text)"
  res="$(aws apigateway create-resource --rest-api-id "$api" --parent-id "$root" --path-part health --query id --output text)"
  apigw_mock_get "$api" "$res" '{\"status\":\"ok\"}' || { record "API Gateway (REST)" fallido "método/integración MOCK"; return; }
  aws apigateway create-deployment --rest-api-id "$api" --stage-name smoke >/dev/null
  body="$(curl -s -o - -w '|%{http_code}' "${AWS_ENDPOINT_URL}/execute-api/${api}/smoke/health")"
  code="${body##*|}"; body="${body%|*}"
  if [[ "$code" == "200" && "$body" == '{"status":"ok"}' ]]; then
    record "API Gateway (REST)" funcional "REST API + recurso + MOCK + deployment/stage; invocación data-plane /execute-api/{id}/smoke/health -> 200"
  else
    record "API Gateway (REST)" fallido "invocación -> $code $body"
  fi

  # HTTP API (v2): solo control plane (integración HTTP_PROXY hacia backend real fuera del alcance del smoke).
  local v2
  v2="$(aws apigatewayv2 create-api --name "${P}-httpapi" --protocol-type HTTP --query ApiId --output text)"
  if [[ -n "$v2" && "$v2" != "None" ]]; then
    on_cleanup "aws apigatewayv2 delete-api --api-id '$v2'"
    record "API Gateway (HTTP v2)" "no probado" "create-api OK; integraciones/invocación no probadas en este smoke"
  else
    record "API Gateway (HTTP v2)" fallido "create-api"
  fi
}

# ---------- EC2 / VPC / VPC Endpoints + API PRIVATE ----------
test_vpc() {
  section "VPC / VPC Endpoints"
  local vpc sub rt vpce gw api root code routes
  vpc="$(aws ec2 create-vpc --cidr-block 10.250.0.0/16 --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${P}}]" --query Vpc.VpcId --output text)" \
    || { record "VPC/VPCE" fallido "create-vpc"; return; }
  on_cleanup "aws ec2 delete-vpc --vpc-id '$vpc'"
  sub="$(aws ec2 create-subnet --vpc-id "$vpc" --cidr-block 10.250.1.0/24 --query Subnet.SubnetId --output text)"
  on_cleanup "aws ec2 delete-subnet --subnet-id '$sub'"
  rt="$(aws ec2 create-route-table --vpc-id "$vpc" --query RouteTable.RouteTableId --output text)"
  on_cleanup "aws ec2 delete-route-table --route-table-id '$rt'"
  vpce="$(aws ec2 create-vpc-endpoint --vpc-id "$vpc" --vpc-endpoint-type Interface --service-name com.amazonaws.us-east-1.execute-api --subnet-ids "$sub" --query VpcEndpoint.VpcEndpointId --output text)"
  gw="$(aws ec2 create-vpc-endpoint --vpc-id "$vpc" --vpc-endpoint-type Gateway --service-name com.amazonaws.us-east-1.dynamodb --route-table-ids "$rt" --query VpcEndpoint.VpcEndpointId --output text)"
  on_cleanup "aws ec2 delete-vpc-endpoints --vpc-endpoint-ids '$vpce' '$gw'"
  local states; states="$(aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$vpce" "$gw" --query 'VpcEndpoints[].State' --output text)"
  routes="$(aws ec2 describe-route-tables --route-table-ids "$rt" --query 'length(RouteTables[0].Routes[?DestinationPrefixListId!=null])' --output text)"

  api="$(aws apigateway create-rest-api --name "${P}-private" --endpoint-configuration "types=PRIVATE,vpcEndpointIds=$vpce" --query id --output text)"
  on_cleanup "aws apigateway delete-rest-api --rest-api-id '$api'"
  root="$(aws apigateway get-resources --rest-api-id "$api" --query 'items[0].id' --output text)"
  apigw_mock_get "$api" "$root" '{\"private\":true}'
  aws apigateway create-deployment --rest-api-id "$api" --stage-name s >/dev/null
  code="$(curl -s -o /dev/null -w '%{http_code}' "${AWS_ENDPOINT_URL}/execute-api/${api}/s/")"

  if [[ "$states" == $'available\tavailable' || "$states" == $'available\navailable' ]]; then
    record "VPC/VPCE" "solo metadatos" "VPC, subnet, route table, VPCE Interface(execute-api) y Gateway(dynamodb) en 'available'; rutas prefix-list del Gateway VPCE=$routes (no programa rutas)"
  else
    record "VPC/VPCE" fallido "estados VPCE='$states'"
  fi
  if [[ "$code" == "200" ]]; then
    record "API Gateway PRIVATE" parcial "API PRIVATE asociada a $vpce se crea, pero responde $code desde el host (fuera de la VPC): el aislamiento de red NO se aplica"
  else
    record "API Gateway PRIVATE" parcial "API PRIVATE creada; invocación desde host -> $code"
  fi
}

# ---------- ECR ----------
test_ecr() {
  section "ECR"
  local repo="${P}/busybox" uri
  uri="$(aws ecr create-repository --repository-name "$repo" --query repository.repositoryUri --output text)" \
    || { record ECR fallido "create-repository"; return; }
  on_cleanup "aws ecr delete-repository --repository-name '$repo' --force"
  local reg="${uri%%/*}"
  # DOCKER_CONFIG dedicado: el login a ECR local no se guarda en ~/.docker.
  local saved_cfg="${DOCKER_CONFIG:-}"
  export DOCKER_CONFIG="$WORK/docker"; mkdir -p "$DOCKER_CONFIG"; echo '{}' > "$DOCKER_CONFIG/config.json"
  if aws ecr get-login-password | docker login --username AWS --password-stdin "$reg" >/dev/null 2>&1 \
     && docker pull -q busybox:1.37 >/dev/null && docker tag busybox:1.37 "${uri}:smoke" \
     && docker push -q "${uri}:smoke" >/dev/null 2>&1; then
    on_cleanup "docker rmi '${uri}:smoke'"
    local n; n="$(aws ecr describe-images --repository-name "$repo" --query 'length(imageDetails)' --output text)"
    if [[ "$n" == "1" ]]; then
      record ECR funcional "create-repository, login, docker push ${uri}:smoke, describe-images=1"
    else
      record ECR fallido "describe-images=$n tras push"
    fi
  else
    record ECR fallido "login/pull/push hacia $reg"
  fi
  if [[ -n "$saved_cfg" ]]; then export DOCKER_CONFIG="$saved_cfg"; else unset DOCKER_CONFIG; fi
}

# ---------- EKS (opcional) ----------
test_eks() {
  section "EKS"
  local c="${P}-eks" role user ak sk subs kc="$WORK/eks.kubeconfig" st
  role="$(aws iam create-role --role-name "${P}-eks-role" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"eks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' --query Role.Arn --output text)"
  on_cleanup "aws iam delete-role --role-name '${P}-eks-role'"
  subs="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')"
  aws eks create-cluster --name "$c" --kubernetes-version 1.36 --role-arn "$role" \
    --resources-vpc-config "subnetIds=$subs" >/dev/null || { record EKS fallido "create-cluster"; return; }
  # En modo persistent Floci conserva el volumen k3s tras delete-cluster: se elimina explícitamente.
  on_cleanup "aws eks delete-cluster --name '$c'; for i in \$(seq 1 30); do aws eks describe-cluster --name '$c' >/dev/null 2>&1 || break; sleep 2; done; docker rm -f 'floci-aws-eks-$c'; docker volume rm 'floci-aws-eks-$c'"
  for _ in $(seq 1 60); do
    st="$(aws eks describe-cluster --name "$c" --query cluster.status --output text)"
    [[ "$st" == "ACTIVE" ]] && break; sleep 5
  done
  [[ "$st" == "ACTIVE" ]] || { record EKS fallido "cluster en estado $st"; return; }

  # test/test es rechazado por el webhook IAM de Floci: se usa una access key IAM emitida por Floci.
  user="${P}-kube"
  aws iam create-user --user-name "$user" >/dev/null
  read -r ak sk < <(aws iam create-access-key --user-name "$user" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  on_cleanup "aws iam delete-user --user-name '$user'"
  on_cleanup "aws iam delete-access-key --user-name '$user' --access-key-id '$ak'"
  AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" aws eks update-kubeconfig --name "$c" --kubeconfig "$kc" >/dev/null
  k() { AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" KUBECONFIG="$kc" kubectl "$@"; }

  local nodes; nodes="$(k get nodes --no-headers 2>&1)"
  [[ "$nodes" == *" Ready "* ]] || { record EKS fallido "kubectl get nodes: ${nodes:0:120}"; return; }
  # Tras ACTIVE, k3s aún puede estar creando el ServiceAccount "default" y CoreDNS.
  for _ in $(seq 1 60); do k get serviceaccount default >/dev/null 2>&1 && break; sleep 2; done
  k -n kube-system rollout status deploy/coredns --timeout=180s >/dev/null 2>&1

  k create deployment web --image=nginx:1.27-alpine --port=80 >/dev/null
  k expose deployment web --port=80 >/dev/null
  if ! k rollout status deploy/web --timeout=240s >"$WORK/eks-rollout.log" 2>&1; then
    record EKS fallido "rollout deploy/web: $(tail -n1 "$WORK/eks-rollout.log")"
    k get pods -A -o wide >&2; k describe deploy/web | tail -n 15 >&2
    return
  fi
  k run probe --image=busybox:1.37 --restart=Never -- wget -qO- -T 10 http://web >/dev/null
  for _ in $(seq 1 60); do
    st="$(k get pod probe -o jsonpath='{.status.phase}' 2>/dev/null)"
    [[ "$st" == "Succeeded" || "$st" == "Failed" ]] && break; sleep 3
  done
  if [[ "$st" == "Succeeded" ]] && k logs probe 2>/dev/null | grep -q 'Welcome to nginx'; then
    record EKS funcional "cluster ACTIVE (k3s $(k version -o json | jq -r .serverVersion.gitVersion)), update-kubeconfig con access key IAM, nodo Ready, Deployment+Service alcanzable por DNS"
  else
    record EKS fallido "pod probe=$st; Service web no alcanzable"
    k describe pod probe | tail -n 15 >&2; k logs probe >&2
  fi
}

# ---------- ejecución ----------
log_info "Floci ${FLOCI_VERSION} @ ${AWS_ENDPOINT_URL} | prefijo de recursos: ${P}"
selected() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }
selected s3       && test_s3
selected dynamodb && test_dynamodb
selected logs     && test_logs
selected apigw    && test_apigw
selected vpc      && test_vpc
selected ecr      && test_ecr
if selected eks; then
  if $WITH_EKS; then test_eks; else record EKS "no probado" "usar --with-eks"; fi
fi

section "Matriz de resultados (Floci ${FLOCI_VERSION})"
printf '%-24s | %-15s | %s\n' "Servicio" "Estado" "Evidencia"
printf '%s\n' "------------------------------------------------------------------------------------------"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r s e ev <<<"$r"
  printf '%-24s | %-15s | %s\n' "$s" "$e" "$ev"
done

if (( FAILED > 0 )); then log_error "${FAILED} prueba(s) fallida(s)."; exit 1; fi
log_ok "Todas las pruebas ejecutadas pasaron."
