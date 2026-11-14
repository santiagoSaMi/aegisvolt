/**
 * Esquema GraphQL unificado de AegisVolt (schema-first). Cada tipo y campo está
 * documentado: la documentación es visible por introspección (en los ambientes
 * que la habilitan) y en `docs/graphql/README.md`.
 *
 * Convenciones:
 * - Ningún campo recibe el ambiente: el ambiente es el del despliegue que responde.
 * - Los importes son enteros en unidades menores (`SafeInt`, hasta 2^53 − 1).
 * - Listas paginadas por cursor opaco: `first` (1–50) y `after`.
 * - Errores en `errors[].extensions`: `code` (UNAUTHENTICATED, FORBIDDEN,
 *   BAD_USER_INPUT, NOT_FOUND, CONFLICT, UPSTREAM_REJECTED, SERVICE_UNAVAILABLE,
 *   INTERNAL_SERVER_ERROR), `reason` (código de negocio) y `correlationId`.
 */
export const typeDefs = /* GraphQL */ `
  """
  Fecha y hora UTC en ISO 8601 (p. ej. 2026-11-13T15:00:00.000Z).
  """
  scalar DateTime

  """
  Entero seguro en JavaScript (|n| ≤ 2^53 − 1). Se usa para importes en unidades
  menores, que pueden superar el rango de Int (32 bits).
  """
  scalar SafeInt

  "Importe en unidades menores enteras de una moneda ISO 4217 (p. ej. centavos de COP)."
  type Money {
    "Importe en unidades menores (entero; sin coma flotante)."
    amountMinor: SafeInt!
    "Moneda ISO 4217."
    currency: String!
  }

  "Información de paginación por cursor."
  type PageInfo {
    "Cursor opaco para pedir la página siguiente (argumento after); null si no hay más."
    endCursor: String
    "true si hay más resultados."
    hasNextPage: Boolean!
  }

  # --- Estaciones y conectores ---------------------------------------------

  "Tipo físico de conector."
  enum ConnectorType {
    CCS2
    CHADEMO
    TYPE2
    GBT
  }

  "Estado efectivo de un conector en el momento de la consulta."
  enum ConnectorStatus {
    "Libre para reservar."
    AVAILABLE
    "Bloqueado temporalmente por una reserva (hold que vence)."
    RESERVED
    "Carga en curso."
    OCCUPIED
    "Mantenimiento o avería."
    OUT_OF_SERVICE
  }

  "Punto de carga dentro de una estación."
  type Connector {
    connectorId: ID!
    type: ConnectorType!
    "Potencia máxima en kW."
    maxPowerKw: Float!
    "true si es ultra rápido (≥ 150 kW; requiere fastChargeBoost)."
    ultraFast: Boolean!
    status: ConnectorStatus!
    "true si se puede reservar ahora (incluye holds vencidos)."
    availableForReservation: Boolean!
  }

  "Coordenadas geográficas."
  type Location {
    latitude: Float!
    longitude: Float!
  }

  "Estación de carga con sus conectores."
  type Station {
    stationId: ID!
    name: String!
    "Ciudad como slug en minúsculas (p. ej. bogota)."
    city: String!
    location: Location!
    connectors: [Connector!]!
  }

  "Conector disponible para reservar, con datos de su estación."
  type AvailableConnector {
    stationId: ID!
    stationName: String!
    city: String!
    connector: Connector!
  }

  # --- Reservas --------------------------------------------------------------

  "Estado de una reserva."
  enum ReservationStatus {
    "Conector retenido temporalmente (vence en holdExpiresAt)."
    HELD
    "Confirmada: la carga está en curso."
    CONFIRMED
    "Liberada (compensación, parada o liberación manual)."
    RELEASED
    "El hold venció sin confirmarse."
    EXPIRED
    "Compensada antes de crearse (tombstone)."
    VOIDED
  }

  "Reserva de un conector por una flota (la crea la SAGA)."
  type Reservation {
    reservationId: ID!
    "SAGA dueña de la reserva."
    sagaId: ID!
    fleetId: ID!
    stationId: ID!
    connectorId: ID!
    status: ReservationStatus!
    fastChargeBoost: Boolean!
    holdExpiresAt: DateTime!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type ReservationConnection {
    items: [Reservation!]!
    pageInfo: PageInfo!
  }

  # --- Billetera ---------------------------------------------------------------

  "Saldo de la billetera de una flota."
  type Wallet {
    fleetId: ID!
    balance: Money!
    updatedAt: DateTime!
  }

  "Tipo de movimiento del libro mayor."
  enum TransactionType {
    "Cobro del importe estimado de una carga."
    DEBIT
    "Reembolso de un cobro (compensación de la SAGA)."
    REFUND
    "Recarga de saldo."
    TOP_UP
  }

  "Movimiento del libro mayor (auditable)."
  type Transaction {
    transactionId: ID!
    fleetId: ID!
    type: TransactionType!
    amount: Money!
    "Saldo resultante tras el movimiento."
    balanceAfter: Money!
    sagaId: ID
    debitId: ID
    refundId: ID
    topUpId: ID
    "correlation_id de la operación que lo originó."
    correlationId: String!
    occurredAt: DateTime!
  }

  type TransactionConnection {
    items: [Transaction!]!
    pageInfo: PageInfo!
  }

  # --- Sesiones de carga -----------------------------------------------------

  "Estado de una sesión de carga."
  enum ChargingSessionStatus {
    ACTIVE
    "Falla física del cargador (real o simulada)."
    FAILED
    "Abortada por una compensación."
    ABORTED
    "Abortada antes de activarse (tombstone)."
    VOIDED
    "Detenida normalmente."
    COMPLETED
  }

  "Falla reportada por el cargador."
  type ChargerFault {
    "Código de falla (p. ej. E-HW-001)."
    code: String!
    "true si la produjo la flag SIMULATE_CHARGER_HARDWARE_FAULT."
    simulated: Boolean!
  }

  "Lectura de telemetría del cargador."
  type TelemetryReading {
    timestamp: DateTime!
    voltageV: Float!
    currentA: Float!
    powerKw: Float!
    "Energía acumulada en la sesión (kWh)."
    energyKwh: Float!
    temperatureC: Float
  }

  "Sesión de carga (despacho de energía)."
  type ChargingSession {
    sessionId: ID!
    sagaId: ID!
    stationId: ID!
    connectorId: ID!
    status: ChargingSessionStatus!
    requestedEnergyKwh: Float!
    "Energía entregada según la última lectura."
    energyDeliveredKwh: Float
    fault: ChargerFault
    stopReason: String
    startedAt: DateTime!
    endedAt: DateTime
    updatedAt: DateTime!
    "Últimas lecturas de telemetría (más reciente primero)."
    telemetry("Número de lecturas (1–100)." last: Int = 10): [TelemetryReading!]!
  }

  type ChargingSessionConnection {
    items: [ChargingSession!]!
    pageInfo: PageInfo!
  }

  # --- SAGA ----------------------------------------------------------------------

  "Estado de la SAGA Reservar y Activar Carga."
  enum SagaStatus {
    STARTED
    RESERVATION_COMPLETED
    BILLING_COMPLETED
    DISPATCH_COMPLETED
    COMPLETED
    COMPENSATING
    "Todas las compensaciones se verificaron."
    COMPENSATED
    "Falló sin efectos que compensar (p. ej. conector no disponible)."
    FAILED
    "Una compensación falló; se reintenta de forma automática o controlada."
    COMPENSATION_FAILED
  }

  "Paso de la SAGA (avance o compensación)."
  type SagaStep {
    step: String!
    status: String!
    attempts: Int!
    lastErrorCode: String
    updatedAt: DateTime!
  }

  "Evento del historial de la SAGA (panel de compensaciones)."
  type SagaEvent {
    sequence: Int!
    type: String!
    step: String
    status: SagaStatus!
    attempt: Int
    errorCode: String
    occurredAt: DateTime!
  }

  "Compensación fallida pendiente de reintento."
  type CompensationFailure {
    step: String!
    errorCode: String!
    round: Int!
    failedAt: DateTime!
    nextAttemptAt: DateTime
  }

  "Transacción distribuida Reservar y Activar Carga (orquestada; compensaciones, no ACID)."
  type Saga {
    sagaId: ID!
    status: SagaStatus!
    "true si COMPLETED, COMPENSATED o FAILED."
    terminal: Boolean!
    fleetId: ID!
    stationId: ID!
    connectorId: ID!
    requestedEnergyKwh: Float!
    fastChargeBoost: Boolean!
    correlationId: String!
    reservationId: ID!
    debitId: ID!
    sessionId: ID!
    "Motivo del fallo (p. ej. INSUFFICIENT_FUNDS, CHARGER_HARDWARE_FAULT)."
    failureReason: String
    compensationPlan: [String!]!
    compensationFailure: CompensationFailure
    steps: [SagaStep!]!
    "Historial completo de eventos."
    events: [SagaEvent!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  # --- Feature flags -------------------------------------------------------------

  "Origen del valor de una flag."
  enum FeatureFlagSource {
    "Leído de la tabla del ambiente."
    STORE
    "La tabla no respondió: último valor conocido."
    LAST_KNOWN
    "La tabla no respondió o la flag no existe: valor seguro (false)."
    DEFAULT
  }

  "Feature flag del ambiente del despliegue."
  type FeatureFlag {
    key: String!
    enabled: Boolean!
    description: String!
    source: FeatureFlagSource!
    version: Int
    updatedAt: DateTime
    updatedBy: String
  }

  "Ambiente del despliegue que responde."
  enum Environment {
    local
    dev
    test
    prod
  }

  "Estado de las flags del ambiente."
  type FeatureFlags {
    environment: Environment!
    flags: [FeatureFlag!]!
    "true si algún valor no viene de la tabla (fuente no disponible)."
    degraded: Boolean!
    readAt: DateTime!
  }

  "Registro de auditoría de un cambio de flag."
  type FeatureFlagChange {
    key: String!
    from: Boolean!
    to: Boolean!
    version: Int!
    changedBy: String!
    changedAt: DateTime!
    correlationId: String!
    environment: Environment!
  }

  # --- Consola (identidad, estimación, estado del sistema) ----------------------

  "Identidad de quien usa la consola (claims verificados del token)."
  type Viewer {
    subject: String!
    groups: [String!]!
    "Flota del operador (custom:fleet_id); null para administradores."
    fleetId: ID
    isAdmin: Boolean!
    "Ambiente del despliegue que responde (APP_ENV); el cliente no puede elegirlo."
    environment: Environment!
  }

  "Estimación previa de una carga, calculada por billing (tarifa, surge y flags)."
  type ChargingEstimate {
    fleetId: ID!
    "Potencia del conector elegido (kW)."
    connectorPowerKw: Float!
    requestedEnergyKwh: Float!
    "Importe que se cobraría ahora."
    estimated: Money!
    "Saldo disponible de la billetera."
    available: Money!
    "true si el saldo alcanza."
    sufficient: Boolean!
    tariffMinorPerKwh: SafeInt!
    "true si se aplica el recargo de hora pico (flag ENABLE_DYNAMIC_SURGE_PRICING)."
    surgeApplied: Boolean!
    "Multiplicador en puntos básicos (10000 = 1×)."
    surgeMultiplierBasisPoints: Int!
  }

  "Disponibilidad (readiness) de un servicio interno."
  type ServiceStatus {
    service: String!
    ready: Boolean!
    latencyMs: Int!
  }

  "Estado del sistema visto desde el graphql-api."
  type SystemStatus {
    environment: Environment!
    services: [ServiceStatus!]!
    checkedAt: DateTime!
  }

  # --- Consultas -----------------------------------------------------------------

  type Query {
    "Estaciones de una ciudad (slug en minúsculas, p. ej. bogota)."
    stations(city: String!): [Station!]!
    "Estación por id; null si no existe."
    stationById(stationId: ID!): Station
    "Conectores disponibles ahora en una ciudad O en una estación (exactamente uno de los dos)."
    availableConnectors(city: String, stationId: ID): [AvailableConnector!]!
    "Saldo de la billetera. Operadores: su flota (fleetId opcional). Administradores: fleetId obligatorio."
    walletBalance(fleetId: ID): Wallet!
    "Movimientos de la billetera, el más reciente primero."
    transactions(fleetId: ID, first: Int = 20, after: String): TransactionConnection!
    "Reservas de la flota, la más reciente primero."
    reservations(fleetId: ID, first: Int = 20, after: String): ReservationConnection!
    "Sesiones de carga de una estación: activas (active: true) o histórico."
    chargingSessions(
      stationId: ID!
      active: Boolean = false
      first: Int = 20
      after: String
    ): ChargingSessionConnection!
    "Sesión de carga por id; null si no existe."
    chargingSessionById(sessionId: ID!): ChargingSession
    "Estado de una SAGA de la flota; null si no existe o no es visible."
    sagaStatus(sagaId: ID!): Saga
    "Feature flags del ambiente del despliegue."
    featureFlags: FeatureFlags!
    "Identidad de quien llama: flota, rol y ambiente."
    viewer: Viewer!
    "Importe estimado de una carga (lo calcula billing). Operadores: su flota; administradores: fleetId."
    chargingEstimate(
      fleetId: ID
      stationId: ID!
      connectorId: ID!
      requestedEnergyKwh: Float!
    ): ChargingEstimate!
    "SAGAs de la flota, la más reciente primero (historial, errores y compensaciones)."
    sagas(fleetId: ID, status: SagaStatus, first: Int = 20): [Saga!]!
    "Readiness de los servicios internos."
    systemStatus: SystemStatus!
  }

  # --- Mutaciones ----------------------------------------------------------------

  input ReserveAndActivateChargingInput {
    "Clave idempotente de la acción del usuario (UUID generado por el cliente). Repetirla devuelve la misma SAGA."
    idempotencyKey: ID!
    "Flota (obligatoria para administradores; los operadores usan la de su token)."
    fleetId: ID
    stationId: ID!
    connectorId: ID!
    "Energía solicitada en kWh (0 < kWh ≤ 500, resolución de 1 Wh)."
    requestedEnergyKwh: Float!
    "Carga rápida reforzada (depende de la flag ENABLE_FAST_CHARGE_BOOST)."
    fastChargeBoost: Boolean = false
  }

  type ReserveAndActivateChargingPayload {
    saga: Saga!
    "false si la SAGA sigue en curso: consultar sagaStatus."
    finished: Boolean!
  }

  type ReleaseReservationPayload {
    reservation: Reservation!
    "RELEASED · ALREADY_RELEASED · VOIDED."
    outcome: String!
  }

  type StopChargingSessionPayload {
    session: ChargingSession!
    "STOPPED · ALREADY_STOPPED."
    outcome: String!
    "Resultado de liberar la reserva (el conector vuelve a AVAILABLE)."
    reservationOutcome: String
  }

  input UpdateFeatureFlagInput {
    key: String!
    enabled: Boolean!
    "Versión esperada (concurrencia optimista); si no coincide → CONFLICT."
    expectedVersion: Int
  }

  type UpdateFeatureFlagPayload {
    flag: FeatureFlag!
    "false si la flag ya tenía ese valor (sin cambio ni auditoría)."
    changed: Boolean!
    change: FeatureFlagChange
  }

  type Mutation {
    "Inicia la SAGA Reservar y Activar Carga (reserva → cobro → activación) para la flota."
    reserveAndActivateCharging(
      input: ReserveAndActivateChargingInput!
    ): ReserveAndActivateChargingPayload!
    "Libera una reserva de la flota (no permitido mientras su SAGA está en curso o la carga está activa)."
    releaseReservation(reservationId: ID!): ReleaseReservationPayload!
    "Detiene una carga de la flota y libera su conector."
    stopChargingSession(sessionId: ID!): StopChargingSessionPayload!
    "Cambia una feature flag del ambiente (solo platform-admins; auditado)."
    updateFeatureFlag(input: UpdateFeatureFlagInput!): UpdateFeatureFlagPayload!
  }
`;
