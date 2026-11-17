# Especificaciones OpenAPI

Aquí vivirá un `openapi.yaml` (OpenAPI 3.1) por servicio, como contrato entre unidades desplegables ([ADR-0004](../../../docs/adr/0004-comunicacion-sincrona-http-contratos-openapi.md)). Cada especificación se valida en dos lados ([ADR-0016](../../../docs/adr/0016-estrategia-de-pruebas.md)):

- **Proveedor:** las respuestas reales del servicio cumplen el esquema.
- **Consumidor:** los fixtures y stubs de las pruebas del orquestador y del GraphQL API cumplen el mismo esquema.

Este directorio no contiene entidades ni reglas de negocio: solo la forma de los mensajes HTTP.
