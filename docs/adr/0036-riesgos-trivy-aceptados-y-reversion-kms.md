# ADR-0036: Riesgos de Trivy aceptados y reversión del endurecimiento con KMS

- **Estado:** Aceptado
- **Fecha:** 2026-11-16
- **Relacionado:** [ADR-0033](0033-terraform-modular-backend-s3-floci.md) (bucket de estado), [ADR-0034](0034-red-eks-api-gateway-terraform-floci.md) (EKS), [ADR-0035](0035-cicd-github-actions-runners-hospedados-floci-efimero.md) (job `trivy-config`)

## Contexto

En la primera promoción, el job `trivy-config` del workflow `security` (Trivy 0.76.1, `trivy config`) reportó tres hallazgos de configuración:

| Id | Archivo | Hallazgo |
| --- | --- | --- |
| KSV-0118 | `infra/k8s/base/logging/daemonset.yaml` | El pod de Fluent Bit no declara un `securityContext` a nivel de pod |
| AWS-0132 | `infra/terraform/bootstrap/main.tf` | El bucket de estado no cifra con una CMK de KMS propia |
| AWS-0039 | `infra/terraform/modules/eks/main.tf` | El clúster EKS no cifra los Secrets de Kubernetes con KMS (`encryption_config`) |

Primero se intentó corregirlos (commit `ffcd784`):

- una CMK para el bucket de estado (SSE-KMS por defecto);
- otra CMK para los Secrets de EKS;
- un `securityContext` de pod para Fluent Bit.

El despliegue de `dev` en el runner falló, y la verificación contra Floci 2.4.0 mostró:

- **EKS:** Floci no implementa `AssociateEncryptionConfig`. Agregar `encryption_config` a un clúster existente no puede aplicarse; habría que recrearlo. Aunque se creara así, el k3s de Floci no se integra con KMS: el cifrado sería solo un metadato.
- **S3:** Floci guarda la configuración SSE-KMS por defecto del bucket, pero **no la aplica** a los objetos nuevos. El cifrado no es verificable en local.
- **Fluent Bit:** necesita correr como root para leer los logs del nodo (`/var/log`, archivos `0640` de root). Su contenedor ya declara un `securityContext` restrictivo.

El autor decidió volver al estado previo (`136d88d`) y aceptar los tres riesgos documentándolos (commit `4e6e269`, PR #18).

## Decisión

1. **Revertir** el endurecimiento con KMS y el `securityContext` de pod de Fluent Bit. Se eliminaron las claves KMS locales creadas durante el intento. La infraestructura vuelve a la de `136d88d`, que se había desplegado y verificado.
2. **Aceptar los tres hallazgos** en [`.trivyignore.yaml`](../../.trivyignore.yaml). Cada excepción cumple tres condiciones:
   - está **acotada a su archivo** (`paths`): el mismo hallazgo en otro archivo sí se reporta;
   - tiene una **justificación** (`statement`) que dice por qué el riesgo es aceptable aquí y qué faltaría en AWS real;
   - **vence el 2027-05-16** (`expired_at`): después, Trivy vuelve a reportarlo y el riesgo debe revisarse.
3. **Mitigaciones vigentes:**
   - **Bucket de estado:** cifrado SSE-S3 (AES256), versionado, bloqueo de acceso público, *ownership controls* y política que niega el transporte sin TLS y el acceso de otras cuentas. Floci guarda la política pero no la evalúa (L-12).
   - **Secrets de EKS:** en este proyecto solo contienen credenciales **ficticias** del emulador. No hay secretos reales.
   - **Fluent Bit:** contenedor sin capacidades (`drop: ALL`), sin escalada de privilegios, raíz de solo lectura y `seccomp: RuntimeDefault`.

## Consecuencias

- `trivy-config` sigue siendo informativo, no un check obligatorio. Sin embargo, ya no reporta estos tres hallazgos mientras las excepciones estén vigentes. Cualquier hallazgo nuevo aparece.
- **Pendiente para AWS real** (no implementado):
  - CMK propia para el bucket de estado, con política de clave limitada al rol `aegisvolt-terraform-admin`;
  - `encryption_config` en la **creación** del clúster EKS, antes de guardar secretos reales.
- La limitación de Floci queda registrada en [limitations.md](../limitations.md):
  - L-16: riesgos aceptados;
  - L-17: KMS en Floci.

## Alternativas descartadas

- **Mantener KMS aunque Floci no lo aplique.** El despliegue fallaba en EKS, y el cifrado de S3 habría quedado como una afirmación no verificable. Las reglas del proyecto prohíben simular que funciona.
- **Recrear el clúster con `encryption_config`.** Es destructivo en cada ambiente, y en k3s el cifrado seguiría sin efecto.
- **Suprimir los hallazgos sin caducidad ni alcance** (por ejemplo, `--skip-check` global). Ocultaría el mismo problema en archivos futuros y nunca obligaría a revisarlo.
