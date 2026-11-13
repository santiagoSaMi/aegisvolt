/** Reloj inyectable: las reglas de vencimiento se evalúan con el `now` de la petición. */
export interface Clock {
  now(): Date;
}

/** Flags que evalúa este servicio (contrato featureFlagsV1, ADR-0007). */
export type StationReservationFlag = 'ENABLE_FAST_CHARGE_BOOST';

export interface FeatureFlagReader {
  isEnabled(flag: StationReservationFlag): Promise<boolean>;
}
