import type {
  ChargerAdapter,
  ChargerCommand,
  ChargerHardwareStatus,
  Clock,
  DispatchFlag,
  FeatureFlagReader,
  StartChargingCommand,
} from '../../src/application/index.ts';
import { ChargerUnavailableError } from '../../src/application/index.ts';
import type { ChargerActivationResult } from '../../src/domain/index.ts';

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Flags en memoria: simulan el almacén del ambiente (se cambian en caliente). */
export class InMemoryFlags implements FeatureFlagReader {
  private readonly values = new Map<DispatchFlag, boolean>();

  set(flag: DispatchFlag, enabled: boolean): void {
    this.values.set(flag, enabled);
  }

  isEnabled(flag: DispatchFlag): Promise<boolean> {
    return Promise.resolve(this.values.get(flag) ?? false);
  }
}

/**
 * Cargador falso que registra las órdenes. Por defecto activa; se puede hacer
 * que reporte una falla física o que no responda (fallo técnico).
 */
export class RecordingCharger implements ChargerAdapter {
  readonly started: StartChargingCommand[] = [];
  readonly stopped: ChargerCommand[] = [];
  nextActivation: ChargerActivationResult = { kind: 'ACTIVATED' };
  status: ChargerHardwareStatus = { kind: 'ONLINE' };
  unavailable = false;

  getStatus(): Promise<ChargerHardwareStatus> {
    return this.unavailable ? this.fail() : Promise.resolve(this.status);
  }

  startCharging(command: StartChargingCommand): Promise<ChargerActivationResult> {
    if (this.unavailable) {
      return this.fail();
    }
    this.started.push(command);
    return Promise.resolve(this.nextActivation);
  }

  stopCharging(command: ChargerCommand): Promise<void> {
    if (this.unavailable) {
      return this.fail();
    }
    this.stopped.push(command);
    return Promise.resolve();
  }

  private fail(): Promise<never> {
    return Promise.reject(new ChargerUnavailableError('Sin comunicación con el cargador'));
  }
}
