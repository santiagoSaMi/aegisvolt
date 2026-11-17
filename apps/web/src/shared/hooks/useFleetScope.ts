import { useState } from 'react';

import type { Viewer } from '../api/viewer.ts';

const FLEET = /^fleet_[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Flota de las consultas: la del token para operadores (no editable); para
 * administradores, la que escriban (validada). `fleetId` es undefined mientras
 * un administrador no indique una flota válida.
 */
export function useFleetScope(viewer: Viewer) {
  const [draft, setDraft] = useState(viewer.fleetId ?? '');
  const valid = FLEET.test(draft.trim());
  return {
    editable: viewer.isAdmin,
    draft,
    setDraft,
    error: viewer.isAdmin && draft !== '' && !valid ? 'Flota inválida (fleet_…)' : undefined,
    fleetId: viewer.isAdmin ? (valid ? draft.trim() : undefined) : (viewer.fleetId ?? undefined),
  };
}
