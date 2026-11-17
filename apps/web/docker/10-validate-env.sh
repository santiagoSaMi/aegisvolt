#!/bin/sh
# Falla el arranque si falta configuración obligatoria o es inválida (antes de envsubst).
set -eu
fail() { echo "{\"level\":\"fatal\",\"service_name\":\"web\",\"operation\":\"Startup\",\"message\":\"$1\"}" >&2; exit 1; }
case "${APP_ENV:-}" in local|dev|test|prod) ;; *) fail "APP_ENV debe ser local, dev, test o prod";; esac
[ -n "${COGNITO_CLIENT_ID:-}" ] || fail "Falta COGNITO_CLIENT_ID"
case "${COGNITO_CLIENT_ID}" in *[!A-Za-z0-9_-]*) fail "COGNITO_CLIENT_ID inválido";; esac
case "${GRAPHQL_UPSTREAM:-}" in http://*|https://*) ;; *) fail "GRAPHQL_UPSTREAM debe ser una URL http(s)";; esac
case "${COGNITO_UPSTREAM:-}" in http://*|https://*) ;; *) fail "COGNITO_UPSTREAM debe ser una URL http(s)";; esac
case "${WEB_POLLING_INTERVAL_MS}" in ''|*[!0-9]*) fail "WEB_POLLING_INTERVAL_MS debe ser un entero";; esac
case "${WEB_CITIES_JSON}" in \[*\]) ;; *) fail "WEB_CITIES_JSON debe ser un arreglo JSON";; esac
case "${WEB_CITIES_JSON}" in *\'*) fail "WEB_CITIES_JSON no puede contener comillas simples";; esac
echo "{\"level\":\"info\",\"service_name\":\"web\",\"environment\":\"${APP_ENV}\",\"operation\":\"Startup\",\"message\":\"Configuración válida\"}"
