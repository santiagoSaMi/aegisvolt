import { describe, expect, it } from 'vitest';

import { StationAlreadyExistsError, StationNotFoundError } from '../../src/application/index.ts';
import { InvalidValueError } from '../../src/domain/index.ts';
import { STATION, STATION_ID, createTestContext } from '../support/fixtures.ts';

describe('RegisterStation', () => {
  it('registra la estación con sus conectores AVAILABLE', async () => {
    const { useCases } = createTestContext();
    const result = await useCases.registerStation.execute(STATION);

    expect(result.outcome).toBe('CREATED');
    expect(result.entry.connectors.map((connector) => connector.status)).toEqual([
      'AVAILABLE',
      'AVAILABLE',
    ]);
  });

  it('es idempotente con los mismos datos y rechaza datos distintos', async () => {
    const { useCases } = createTestContext();
    await useCases.registerStation.execute(STATION);

    await expect(useCases.registerStation.execute(STATION)).resolves.toMatchObject({
      outcome: 'UNCHANGED',
    });
    await expect(
      useCases.registerStation.execute({ ...STATION, name: 'Otro nombre' }),
    ).rejects.toBeInstanceOf(StationAlreadyExistsError);
  });

  it('valida conectores repetidos y datos fuera de rango', async () => {
    const { useCases } = createTestContext();
    const [first] = STATION.connectors;
    if (first === undefined) throw new Error('fixture');
    await expect(
      useCases.registerStation.execute({ ...STATION, connectors: [first, first] }),
    ).rejects.toBeInstanceOf(InvalidValueError);
    await expect(
      useCases.registerStation.execute({ ...STATION, location: { latitude: 91, longitude: 0 } }),
    ).rejects.toBeInstanceOf(InvalidValueError);
  });
});

describe('GetStation / ListStations', () => {
  it('consulta por id y por ciudad', async () => {
    const { useCases } = createTestContext();
    await useCases.registerStation.execute(STATION);

    expect((await useCases.getStation.execute(STATION_ID)).entry.station.name).toBe(
      'Electrolinera Norte',
    );
    expect((await useCases.listStations.execute('bogota')).entries).toHaveLength(1);
    expect((await useCases.listStations.execute('medellin')).entries).toHaveLength(0);
    await expect(useCases.getStation.execute('st_no-existe')).rejects.toBeInstanceOf(
      StationNotFoundError,
    );
  });
});
