import type { Logger } from '@aegisvolt/logger';

import type {
  ChargerAdapter,
  ChargerCommand,
  ChargerHardwareStatus,
  FeatureFlagReader,
  StartChargingCommand,
} from '../../application/index.ts';
import { ChargerFault, type ChargerActivationResult } from '../../domain/index.ts';

/** Flag que induce la falla física simulada (§2.2 de la especificación). */
const FAULT_FLAG = 'SIMULATE_CHARGER_HARDWARE_FAULT';

/**
 * Cargador SIMULADO: no hay hardware ni OCPP. Activa y detiene la carga de
 * inmediato, salvo cuando la flag `SIMULATE_CHARGER_HARDWARE_FAULT` está activa
 * en el ambiente: entonces la activación devuelve una falla FÍSICA controlada
 * (`E-HW-001`, `simulated: true`) y el estado del cargador es FAULTED.
 *
 * La flag se lee en cada orden desde el almacén del ambiente (con la caché de
 * ADR-0007), nunca de una constante: cambiarla no requiere redesplegar.
 * El adaptador no guarda estado (la ocupación la registra el servicio), así
 * que funciona igual con varias réplicas.
 */
export class SimulatedChargerAdapter implements ChargerAdapter {
  private readonly flags: FeatureFlagReader;
  private readonly logger: Logger;

  constructor(deps: { flags: FeatureFlagReader; logger: Logger }) {
    this.flags = deps.flags;
    this.logger = deps.logger.child({ component: 'simulated-charger' });
  }

  /** El simulador no distingue conectores: todos comparten el estado de la flag. */
  async getStatus(): Promise<ChargerHardwareStatus> {
    const fault = await this.simulatedFault();
    return fault === undefined ? { kind: 'ONLINE' } : { kind: 'FAULTED', fault };
  }

  async startCharging(command: StartChargingCommand): Promise<ChargerActivationResult> {
    const fault = await this.simulatedFault();
    const fields = {
      session_id: command.sessionId,
      station_id: command.stationId,
      connector_id: command.connectorId,
    };
    if (fault !== undefined) {
      // Falla física simulada: clasificable (código de falla) y trazable
      // (correlation_id/saga_id los añade el contexto de logs).
      this.logger.warn('Falla de hardware del cargador (simulada)', {
        ...fields,
        event: 'charger_fault',
        fault_class: 'PHYSICAL',
        fault_code: fault.code,
        simulated: true,
        cause: `feature_flag:${FAULT_FLAG}`,
      });
      return { kind: 'FAULT', fault };
    }
    this.logger.info('Cargador activado (simulado)', {
      ...fields,
      event: 'charger_started',
      requested_wh: command.requestedEnergy.wattHours,
    });
    return { kind: 'ACTIVATED' };
  }

  stopCharging(command: ChargerCommand): Promise<void> {
    this.logger.info('Cargador detenido (simulado)', {
      event: 'charger_stopped',
      session_id: command.sessionId,
      station_id: command.stationId,
      connector_id: command.connectorId,
    });
    return Promise.resolve();
  }

  private async simulatedFault(): Promise<ChargerFault | undefined> {
    return (await this.flags.isEnabled(FAULT_FLAG))
      ? ChargerFault.simulatedHardwareFault()
      : undefined;
  }
}
