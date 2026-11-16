#!/usr/bin/env bash
# Verificación de red, EKS y API Gateway de un ambiente contra Floci (ADR-0034).
#
# Uso: scripts/floci/network-verify.sh <dev|test|prod>   (tras terraform-live.sh <env> apply)
#
# Comprueba cada servicio con la API de Floci y separa lo que se VERIFICÓ en
# funcionamiento de lo que Floci solo guarda como METADATOS (sin enrutamiento, DNS,
# SG ni políticas aplicadas). Escribe una tabla requisito / implementación / evidencia /
# limitación en infra/local/floci/.tmp/network-verify-<env>.md. Solo lectura, salvo
# peticiones HTTP de prueba a la API.
source "$(dirname "$0")/terraform-lib.sh"

ENV="${1:-}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "Uso: $0 <dev|test|prod>"
tf_guard
OUT="${FLOCI_TMP_DIR}/network-verify-${ENV}.md"
CA="${FLOCI_DIR}/data/tls/floci-root-ca.crt"
NAME="aegisvolt-${ENV}"
ROWS=(); FAILED=0
# row <requisito> <implementación> <ok|fail> <evidencia> <tipo: funcional|metadatos|n/a> [limitación]
row() {
  local mark; [[ "$3" == ok ]] && mark="✅" || { mark="❌"; FAILED=1; }
  ROWS+=("| $1 | $2 | ${mark} $4 | $5 | ${6:-—} |")
  [[ "$3" == ok ]] && log_ok "$1: $4" || log_error "$1: $4"
}
q() { aws "$@" --output text 2>/dev/null; }

# --- VPC ---------------------------------------------------------------------------------------
VPC="$(q ec2 describe-vpcs --filters "Name=tag:Name,Values=${NAME}" --query 'Vpcs[0].VpcId')"
CIDR="$(q ec2 describe-vpcs --vpc-ids "$VPC" --query 'Vpcs[0].CidrBlock')"
DNS_S="$(q ec2 describe-vpc-attribute --vpc-id "$VPC" --attribute enableDnsSupport --query 'EnableDnsSupport.Value')"
DNS_H="$(q ec2 describe-vpc-attribute --vpc-id "$VPC" --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value')"
[[ "$VPC" == vpc-* && "$CIDR" == */16 ]] && st=ok || st=fail
row "VPC con CIDR parametrizable" "\`module.network\`, \`vpc_cidr\` en envs/${ENV}.tfvars" "$st" "${VPC} ${CIDR}; DNS support=${DNS_S}, hostnames=${DNS_H}" metadatos "L-01: sin plano de datos de VPC"

# --- Subredes ----------------------------------------------------------------------------------
pub="$(q ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC}" "Name=tag:Tier,Values=public" --query 'Subnets[].[CidrBlock,AvailabilityZone,MapPublicIpOnLaunch]' | sort | paste -sd';')"
priv="$(q ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC}" "Name=tag:Tier,Values=private" --query 'Subnets[].[CidrBlock,AvailabilityZone]' | sort | paste -sd';')"
npub="$(tr ';' '\n' <<<"$pub" | grep -c . || true)"; npriv="$(tr ';' '\n' <<<"$priv" | grep -c . || true)"
[[ "$npub" -ge 2 && "$npriv" -ge 2 ]] && st=ok || st=fail
row "Subredes públicas y privadas" "2 públicas /24 (sin IP pública automática) y 2 privadas /20, en 2 AZ" "$st" "públicas: ${pub//	/ }; privadas: ${priv//	/ }" metadatos "L-01"

# --- IGW, NAT y rutas ------------------------------------------------------------------------------
IGW="$(q ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=${VPC}" --query 'InternetGateways[0].InternetGatewayId')"
NATS="$(q ec2 describe-nat-gateways --filter "Name=vpc-id,Values=${VPC}" --query 'NatGateways[].[NatGatewayId,State,SubnetId]' | paste -sd';')"
[[ "$IGW" == igw-* ]] && st=ok || st=fail
row "Internet Gateway" "IGW asociado; ruta 0.0.0.0/0 solo en la tabla pública" "$st" "${IGW}" metadatos "L-01"
[[ "$NATS" == *available* ]] && st=ok || st=fail
row "NAT Gateway (salida que no cubren los VPCE: JWKS de Cognito, etc.)" "$( [[ "$ENV" == prod ]] && echo 'uno por AZ (sin punto único de falla)' || echo 'uno compartido (costo)')" "$st" "${NATS//	/ }" metadatos "Floci: \"Creates a NAT gateway record\"; no traduce direcciones"
rt_pub="$(q ec2 describe-route-tables --filters "Name=vpc-id,Values=${VPC}" "Name=tag:Name,Values=${NAME}-public" --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].GatewayId | [0]')"
rt_priv="$(q ec2 describe-route-tables --filters "Name=vpc-id,Values=${VPC}" "Name=tag:Name,Values=${NAME}-private-*" --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId[]' | tr '\t' ' ')"
assoc="$(q ec2 describe-route-tables --filters "Name=vpc-id,Values=${VPC}" --query 'length(RouteTables[].Associations[?SubnetId!=null][])')"
pl="$(q ec2 describe-route-tables --filters "Name=vpc-id,Values=${VPC}" "Name=tag:Name,Values=${NAME}-private-*" --query 'length(RouteTables[].Routes[?DestinationPrefixListId!=null][])')"
[[ "$rt_pub" == igw-* && "$rt_priv" == *nat-* && "$assoc" -ge 4 ]] && st=ok || st=fail
row "Route tables y asociaciones" "pública → IGW; una privada por AZ → NAT; 4 asociaciones" "$st" "pública 0.0.0.0/0→${rt_pub}; privadas 0.0.0.0/0→${rt_priv}; asociaciones=${assoc}; rutas prefix list (Gateway VPCE)=${pl}" metadatos "Floci no añade las rutas de prefix list de los Gateway VPCE (${pl}) ni enruta paquetes"

# --- VPC Endpoints -----------------------------------------------------------------------------------
for svc in s3 dynamodb; do
  e="$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=${VPC}" "Name=service-name,Values=com.amazonaws.us-east-1.${svc}" --query 'VpcEndpoints[0].[VpcEndpointId,VpcEndpointType,State,length(RouteTableIds)]')"
  pol="$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=${VPC}" "Name=service-name,Values=com.amazonaws.us-east-1.${svc}" --query 'VpcEndpoints[0].PolicyDocument' | jq -r '[.Statement[].Resource] | flatten | .[0]')"
  [[ "$e" == *Gateway*available* ]] && st=ok || st=fail
  row "VPCE Gateway ${svc}" "asociado a las tablas privadas, con política restringida" "$st" "$(awk '{print $1", "$3", tablas="$4}' <<<"$e"); política: ${pol}" metadatos "L-01: sin rutas de prefix list; la política no se evalúa"
done
for svc in logs monitoring ecr.api ecr.dkr execute-api eks-auth; do
  e="$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=${VPC}" "Name=service-name,Values=com.amazonaws.us-east-1.${svc}" --query 'VpcEndpoints[0].[VpcEndpointId,State,PrivateDnsEnabled,length(SubnetIds),length(NetworkInterfaceIds)]')"
  dns="$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=${VPC}" "Name=service-name,Values=com.amazonaws.us-east-1.${svc}" --query 'VpcEndpoints[0].DnsEntries[0].DnsName')"
  [[ "$e" == *available*True* ]] && st=ok || st=fail
  row "VPCE Interface ${svc}" "subredes privadas, SG 443 desde ellas, private DNS" "$st" "$(awk '{print $1", "$2", private DNS="$3", subredes="$4", ENIs="$5}' <<<"$e"); ${dns}" metadatos "ENI y DNS sintetizados: no resuelven ni enrutan (L-01)"
done
extra="$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=${VPC}" --query 'VpcEndpoints[].ServiceName' | tr '\t' '\n' | grep -vE '\.(s3|dynamodb|logs|monitoring|ecr\.api|ecr\.dkr|execute-api|eks-auth)$' || true)"
[[ -z "$extra" ]] && st=ok || st=fail
row "Sin VPCE injustificados (regla 5)" "solo los 8 con consumidor documentado (ADR-0034)" "$st" "${extra:-ningún otro VPCE en la VPC}" n/a

# --- Security groups ----------------------------------------------------------------------------------
VPCE_SG="$(q ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC}" "Name=group-name,Values=${NAME}-vpce" --query 'SecurityGroups[0].GroupId')"
vpce_in="$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=${VPCE_SG}" --query 'SecurityGroupRules[?!IsEgress].[CidrIpv4,FromPort]' | tr '\t' ':' | paste -sd' ')"
NLB_SG="$(q ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC}" "Name=group-name,Values=${NAME}-ingress-nlb" --query 'SecurityGroups[0].GroupId')"
nlb_in="$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=${NLB_SG}" --query 'length(SecurityGroupRules[?!IsEgress])')"
# Egreso desde describe-security-groups: describe-security-group-rules de Floci sigue
# listando la regla 0.0.0.0/0 por defecto que Terraform revoca al crear el SG (L-14).
nlb_out="$(q ec2 describe-security-groups --group-ids "$NLB_SG" --query 'SecurityGroups[0].IpPermissionsEgress[].[IpRanges[0].CidrIp,FromPort]' | tr '\t' ':' | paste -sd' ')"
[[ -n "$vpce_in" && "$vpce_in" != *0.0.0.0* ]] && st=ok || st=fail
row "SG de los VPCE" "443 solo desde las subredes privadas" "$st" "${VPCE_SG}: ${vpce_in}" metadatos "Floci no filtra este tráfico"
[[ "$nlb_in" == 0 && -n "$nlb_out" && "$nlb_out" != *0.0.0.0/0* ]] && st=ok || st=fail
row "SG del NLB interno" "sin entrada (solo VPC Link/PrivateLink); salida al puerto del ingress en las subredes privadas" "$st" "${NLB_SG}: entrada=${nlb_in} reglas; salida ${nlb_out}" metadatos "Floci no filtra; enforce_..._private_link_traffic no se devuelve (L-14)"

# --- EKS ---------------------------------------------------------------------------------------------
CL="$(q eks describe-cluster --name "$NAME" --query 'cluster.status' || true)"
if [[ "$CL" == ACTIVE ]]; then
  ep="$(q eks describe-cluster --name "$NAME" --query 'cluster.[endpoint,resourcesVpcConfig.endpointPrivateAccess,resourcesVpcConfig.endpointPublicAccess,resourcesVpcConfig.vpcId,version]')"
  csg="$(q eks describe-cluster --name "$NAME" --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId')"
  csg_rule="$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=${csg}" --query "SecurityGroupRules[?ReferencedGroupInfo.GroupId=='${NLB_SG}'].[FromPort]")"
  ng="$(q eks describe-nodegroup --cluster-name "$NAME" --nodegroup-name "${NAME}-default" --query 'nodegroup.[status,scalingConfig.desiredSize,length(subnets)]')"
  pia="$(q eks list-pod-identity-associations --cluster-name "$NAME" --query 'length(associations)')"
  [[ "$ep" == *"$VPC"* ]] && st=ok || st=fail
  row "Clúster EKS" "\`module.eks\` en las subredes privadas de la VPC del ambiente" "$st" "ACTIVE; $(awk '{print "endpoint "$1", privado="$2", público="$3", "$4", v"$5}' <<<"$ep")" funcional "k3s de un nodo (L-03); público=False se guarda pero kubectl entra desde el host"
  [[ "$ng" == ACTIVE* ]] && st=ok || st=fail
  row "Node group" "administrado, en las subredes privadas" "$st" "$(awk '{print $1", deseado="$2", subredes="$3}' <<<"$ng")" metadatos "Floci comparte un único nodo k3s"
  [[ "$csg_rule" =~ ^[0-9]+$ ]] && st=ok || st=fail
  row "SG del clúster ← NLB" "regla en el SG del clúster desde el SG del NLB al puerto del ingress" "$st" "${csg} permite ${NLB_SG} → tcp/${csg_rule}" metadatos "Floci no filtra"
  [[ "$pia" -ge 7 ]] && st=ok || st=fail
  row "IAM de EKS" "roles de plano de control y nodos; 7 roles Pod Identity" "$st" "${pia} asociaciones Pod Identity" metadatos "L-08: IAM no se evalúa; los pods usan credenciales ficticias"
  K="$(mktemp)"; tf live workspace select "$ENV" >/dev/null; tf live output -raw kubeconfig > "$K" 2>/dev/null
  nodes="$( (set -a; source "${FLOCI_TMP_DIR}/k8s-${ENV}/kube-credentials.env" 2>/dev/null; set +a; unset AWS_ENDPOINT_URL; KUBECONFIG="$K" kubectl get nodes --no-headers 2>&1 | awk '{print $1" "$2}' | head -1) )"; rm -f "$K"
  [[ "$nodes" == *Ready* ]] && st=ok || st=fail
  row "Kubeconfig y endpoint del plano de control" "salida \`kubeconfig\` de Terraform (exec \`aws eks get-token\`, sin secretos)" "$st" "kubectl get nodes → ${nodes}" funcional "Token del webhook IAM de Floci"
else
  row "Clúster EKS" "\`module.eks\` con eks.enabled=false" ok "no creado en ${ENV}" n/a "L-11: memoria local; plan con EKS validado"
fi

# --- API Gateway ------------------------------------------------------------------------------------------
PUB="$(q apigateway get-rest-apis --query "items[?name=='${NAME}-public'].id | [0]")"
PRIV="$(q apigateway get-rest-apis --query "items[?name=='${NAME}-private'].id | [0]")"
pub_type="$(q apigateway get-rest-api --rest-api-id "$PUB" --query 'endpointConfiguration.types[0]')"
priv_cfg="$(q apigateway get-rest-api --rest-api-id "$PRIV" --query '[endpointConfiguration.types[0],endpointConfiguration.vpcEndpointIds[0]]')"
priv_pol="$(q apigateway get-rest-api --rest-api-id "$PRIV" --query policy | sed 's/\\//g' | jq -r '[.Statement[] | .Sid] | join(",")' 2>/dev/null)"
VL="$(q apigateway get-vpc-links --query "items[?name=='${NAME}-ingress'].[id,status,targetArns[0]] | [0]")"
nlb="$(q elbv2 describe-load-balancers --names "${NAME}-ingress" --query 'LoadBalancers[0].[Scheme,Type,VpcId,length(SecurityGroups)]')"
TG="$(q elbv2 describe-target-groups --names "${NAME}-ingress" --query 'TargetGroups[0].TargetGroupArn')"
th="$(q elbv2 describe-target-health --target-group-arn "$TG" --query 'TargetHealthDescriptions[].[Target.Id,Target.Port,TargetHealth.State]' | tr '\t' ' ' | paste -sd';')"
routes="$(q apigateway get-resources --rest-api-id "$PUB" --query 'items[].[path,join(`,`,keys(resourceMethods||`{}`))]' | tr '\t' ' ' | sort | paste -sd';')"
integ="$(q apigateway get-integration --rest-api-id "$PUB" --resource-id "$(q apigateway get-resources --rest-api-id "$PUB" --query "items[?path=='/graphql'].id | [0]")" --http-method POST --query '[type,connectionType,uri]')"
[[ "$pub_type" == REGIONAL ]] && st=ok || st=fail
row "API pública (endpoint que consume el cliente)" "REST REGIONAL, stage ${ENV}" "$st" "${PUB}: https://${PUB}.execute-api.us-east-1.amazonaws.com/${ENV} (Floci: https://${PUB}.execute-api.localhost.floci.io:4566/${ENV}); rutas ${routes}" funcional
[[ "$priv_cfg" == PRIVATE* ]] && st=ok || st=fail
row "API privada + VPCE execute-api" "REST PRIVATE asociada al VPCE; resource policy aws:SourceVpce" "$st" "${PRIV}: $(tr '\t' ' ' <<<"$priv_cfg"); policy ${priv_pol}" metadatos "L-02: la policy no se evalúa"
[[ "$integ" == *HTTP_PROXY*VPC_LINK* && "$VL" == *AVAILABLE* ]] && st=ok || st=fail
row "Integración privada (VPC Link V1 → NLB)" "HTTP_PROXY + VPC_LINK hacia el NLB interno" "$st" "POST /graphql → $(tr '\t' ' ' <<<"$integ"); VPC Link $(awk '{print $1" "$2}' <<<"$VL")" funcional "URI local http://floci:<puerto> (el DNS *.elb.floci no resuelve)"
[[ "$nlb" == internal*network*"$VPC"* ]] && st=ok || st=fail
row "NLB interno" "network, internal, subredes privadas, con SG" "$st" "$(tr '\t' ' ' <<<"$nlb") SG; targets: ${th:-ninguno}" funcional "Listener en el contenedor de Floci; target = contenedor k3s:NodePort"

if [[ -n "$th" ]]; then
  # shellcheck source=/dev/null
  source "${FLOCI_TMP_DIR}/identity-${ENV}.env"
  TOKEN="$(q cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$COGNITO_CLIENT_ID" --auth-parameters "USERNAME=operador,PASSWORD=${DEMO_PASSWORD}" --query AuthenticationResult.IdToken)"
  URL="https://${PUB}.execute-api.localhost.floci.io:4566/${ENV}/graphql"
  hdr="$(mktemp)"
  res="$(curl -sS --cacert "$CA" -D "$hdr" -w '\n%{http_code} %{ssl_verify_result}' "$URL" -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" -d '{"query":"{ viewer { fleetId } }"}')"
  code="$(tail -1 <<<"$res")"; body="$(head -1 <<<"$res")"
  ver="$(tr -d '\r' < "$hdr" | sed -n 's/^x-service-version: //Ip')"; rm -f "$hdr"
  [[ "$code" == "200 0" && "$body" == *fleet_demo* ]] && st=ok || st=fail
  row "GraphQL por HTTPS de punta a punta" "cliente → API Gateway → VPC Link → NLB → Traefik → graphql-api" "$st" "POST ${URL} → HTTP ${code% *}, TLS verificado (CA de Floci), ${body:0:60}, x-service-version ${ver}" funcional "Verificado el camino emulado de Floci, no el aislamiento de red de AWS"
  noauth="$(curl -sS --cacert "$CA" "$URL" -H 'content-type: application/json' -d '{"query":"{ viewer { fleetId } }"}' | jq -r '.errors[0].extensions.code')"
  [[ "$noauth" == UNAUTHENTICATED ]] && st=ok || st=fail
  row "GraphQL sin token" "JWT de Cognito validado en graphql-api (ADR-0026)" "$st" "${noauth}" funcional
  pcode="$(curl -s --cacert "$CA" -o /dev/null -w '%{http_code}' "https://${PRIV}.execute-api.localhost.floci.io:4566/${ENV}/graphql" -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" -d '{"query":"{ viewer { fleetId } }"}')"
  row "API privada invocada desde FUERA de la VPC" "en AWS: 403 (resource policy)" ok "Floci responde ${pcode}: NO hay aislamiento" metadatos "L-02: no se puede demostrar el bloqueo en Floci"
else
  row "GraphQL por HTTPS de punta a punta" "requiere el clúster y el target del NLB" ok "no aplica en ${ENV} (sin EKS, L-11)" n/a
fi
streams="$(q logs describe-log-streams --log-group-name "/aegisvolt/${ENV}/api-gateway" --query 'length(logStreams)')"
row "Logs de acceso de API Gateway" "stage con access_log_settings → /aegisvolt/${ENV}/api-gateway" ok "log group creado; streams=${streams}" metadatos "Floci no escribe logs de acceso (L-14)"

{
  echo "# Red, EKS y API Gateway de ${ENV} en Floci — $(date -u +%FT%TZ)"
  echo
  echo "Tipo: **funcional** = el emulador ejecuta el comportamiento; **metadatos** = Floci crea y describe el recurso, pero no lo aplica."
  echo
  echo "| Requisito | Implementación | Evidencia | Tipo | Limitación |"
  echo "| --- | --- | --- | --- | --- |"
  printf '%s\n' "${ROWS[@]}"
} > "$OUT"
log_info "Informe: ${OUT}"
exit "$FAILED"
