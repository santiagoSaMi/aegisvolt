import { useMemo, useState } from 'react';

import type { Viewer } from '../../shared/api/viewer.ts';
import { chargingFormSchema, type ChargingFormValues, type ChargingInput } from './model.ts';

type Field = keyof ChargingFormValues;

/**
 * Estado del formulario de carga: valores, errores por campo (validación de
 * formato) y la entrada válida para pedir la estimación al backend.
 */
export function useChargingForm(viewer: Viewer) {
  const schema = useMemo(() => chargingFormSchema(viewer.isAdmin), [viewer.isAdmin]);
  const [values, setValues] = useState<ChargingFormValues>({
    fleetId: viewer.fleetId ?? '',
    stationId: '',
    connectorId: '',
    energyKwh: '30',
  });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});

  const parsed = schema.safeParse(values);
  const errors: Partial<Record<Field, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as Field;
      errors[field] ??= issue.message;
    }
  }

  const setField = (field: Field, value: string) => {
    setValues((current) => ({
      ...current,
      [field]: value,
      // Cambiar de estación invalida el conector elegido.
      ...(field === 'stationId' ? { connectorId: '' } : {}),
    }));
    setTouched((current) => ({ ...current, [field]: true }));
  };

  const touchAll = () => {
    setTouched({ fleetId: true, stationId: true, connectorId: true, energyKwh: true });
  };

  const input: ChargingInput | undefined = parsed.success ? parsed.data : undefined;
  return {
    values,
    /** Solo se muestran errores de campos ya tocados. */
    errors: Object.fromEntries(
      Object.entries(errors).filter(([field]) => touched[field as Field] === true),
    ) as Partial<Record<Field, string>>,
    input,
    setField,
    touchAll,
  };
}
