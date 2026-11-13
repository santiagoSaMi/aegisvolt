import { sagaOrchestratorV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import {
  ABANDON_REASONS,
  BUSINESS_REJECTIONS,
  GENERIC_REJECTION,
  COMPENSATION_STEPS,
  FORWARD_STEPS,
  SAGA_EVENT_TYPES,
  SAGA_STATUSES,
  STEP_STATUSES,
  TERMINAL_STATUSES,
} from '../../src/domain/index.ts';

/**
 * El dominio no importa el contrato (regla de capas); esta prueba evita que
 * diverjan el vocabulario interno y el publicado en @aegisvolt/contracts.
 */
describe('alineación dominio ↔ contrato saga-orchestrator v1', () => {
  it('estados, pasos y eventos coinciden', () => {
    expect([...SAGA_STATUSES].sort()).toEqual([...sagaOrchestratorV1.SAGA_STATUSES].sort());
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      [...sagaOrchestratorV1.TERMINAL_SAGA_STATUSES].sort(),
    );
    expect([...FORWARD_STEPS, ...COMPENSATION_STEPS].sort()).toEqual(
      [...sagaOrchestratorV1.SAGA_STEPS].sort(),
    );
    expect([...STEP_STATUSES].sort()).toEqual([...sagaOrchestratorV1.SAGA_STEP_STATUSES].sort());
    expect([...SAGA_EVENT_TYPES].sort()).toEqual([...sagaOrchestratorV1.SAGA_EVENT_TYPES].sort());
  });

  it('los motivos de fallo del dominio son los publicados', () => {
    const domainReasons = [
      ...Object.values(BUSINESS_REJECTIONS).flat(),
      GENERIC_REJECTION,
      ...ABANDON_REASONS,
    ];
    expect(domainReasons.sort()).toEqual([...sagaOrchestratorV1.SAGA_FAILURE_REASONS].sort());
  });
});
