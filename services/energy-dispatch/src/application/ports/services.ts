import type {
  ChargerActivationResult,
  ChargerFault,
  ConnectorId,
  RequestedEnergy,
  SessionId,
  StationId,
} from '../../domain/index.ts';

/** Reloj inyectable (instantes de las transiciones). */
export interface Clock {
  now(): Date;
}

/** Flags que evalúa este servicio (contrato featureFlagsV1, ADR-0007). */
export type DispatchFlag = 'SIMULATE_CHARGER_HARDWARE_FAULT';

/**
 * Lectura de flags del ambiente. El adaptador de producción es el lector con
 * caché de `@aegisvolt/feature-flags`, que nunca falla (usa el último valor
 * conocido o `false`).
 */
export interface FeatureFlagReader {
  isEnabled(flag: DispatchFlag): Promise<boolean>;
}

/** Conector físico al que se dirige una orden. */
export interface ChargerTarget {
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
}

/**
 * Orden al cargador, identificada por la sesión (como el `transactionId` de
 * OCPP): repetir una orden con la misma sesión no tiene efecto adicional, y
 * parar una sesión que el cargador no está atendiendo es un no-op.
 */
export interface ChargerCommand extends ChargerTarget {
  readonly sessionId: SessionId;
}

export interface StartChargingCommand extends ChargerCommand {
  readonly requestedEnergy: RequestedEnergy;
}

/** Estado del hardware según el propio cargador. */
export type ChargerHardwareStatus =
  { readonly kind: 'ONLINE' } | { readonly kind: 'FAULTED'; readonly fault: ChargerFault };

/**
 * Puerto hacia el cargador físico. La aplicación no conoce la implementación
 * concreta (simulada en este proyecto; un adaptador OCPP en un despliegue real).
 *
 * Contrato de errores:
 * - falla FÍSICA del equipo → se DEVUELVE `{ kind: 'FAULT', fault }` (resultado de negocio);
 * - fallo TÉCNICO (sin comunicación, timeout) → se LANZA `ChargerUnavailableError`.
 */
export interface ChargerAdapter {
  getStatus(target: ChargerTarget): Promise<ChargerHardwareStatus>;
  startCharging(command: StartChargingCommand): Promise<ChargerActivationResult>;
  stopCharging(command: ChargerCommand): Promise<void>;
}
