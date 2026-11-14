import type { useFleetScope } from '../hooks/useFleetScope.ts';
import { TextField } from './components.tsx';

/** Campo de flota: editable para administradores, informativo para operadores. */
export function FleetScopeField({ scope }: { scope: ReturnType<typeof useFleetScope> }) {
  return scope.editable ? (
    <TextField
      label="Flota"
      placeholder="fleet_…"
      value={scope.draft}
      error={scope.error}
      hint="Como administrador puede consultar cualquier flota."
      onChange={(event) => {
        scope.setDraft(event.target.value);
      }}
    />
  ) : (
    <TextField label="Flota" value={scope.fleetId ?? ''} readOnly />
  );
}
