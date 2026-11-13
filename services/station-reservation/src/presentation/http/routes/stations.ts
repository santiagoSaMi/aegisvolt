import { stationIdSchema, stationReservationV1 as api } from '@aegisvolt/contracts';
import { Router } from 'express';
import { z } from 'zod';

import type {
  GetAvailableConnectors,
  GetStation,
  ListStations,
  RegisterStation,
} from '../../../application/index.ts';
import { sendJson } from '../problem.ts';
import { ROUTES } from './route-patterns.ts';
import { RequestValidationError, parseRequest } from '../validation.ts';
import { toAvailableConnectorView, toStationView } from '../views.ts';

export interface StationUseCases {
  readonly registerStation: RegisterStation;
  readonly getStation: GetStation;
  readonly listStations: ListStations;
  readonly getAvailableConnectors: GetAvailableConnectors;
}

const stationParamsSchema = z.object({ stationId: stationIdSchema });

/** Controllers delgados: validan con el contrato, delegan y mapean la respuesta. */
export function stationRoutes(useCases: StationUseCases): Router {
  const router = Router();

  router.put(ROUTES.station, async (req, res) => {
    const { stationId } = parseRequest(stationParamsSchema, req.params, 'params');
    const body = parseRequest(api.registerStationRequestSchema, req.body, 'body');
    const { outcome, entry } = await useCases.registerStation.execute({ stationId, ...body });
    sendJson(res, outcome === 'CREATED' ? 201 : 200, toStationView(entry, new Date()));
  });

  router.get(ROUTES.stations, async (req, res) => {
    const { city } = parseRequest(api.listStationsQuerySchema, req.query, 'query');
    const { entries, now } = await useCases.listStations.execute(city);
    sendJson(res, 200, { items: entries.map((entry) => toStationView(entry, now)) });
  });

  router.get(ROUTES.station, async (req, res) => {
    const { stationId } = parseRequest(stationParamsSchema, req.params, 'params');
    const { entry, now } = await useCases.getStation.execute(stationId);
    sendJson(res, 200, toStationView(entry, now));
  });

  router.get(ROUTES.availableConnectors, async (req, res) => {
    const query = parseRequest(api.listAvailableConnectorsQuerySchema, req.query, 'query');
    // El esquema garantiza exactamente uno de city o stationId.
    const filter =
      query.city !== undefined
        ? { city: query.city }
        : query.stationId !== undefined
          ? { stationId: query.stationId }
          : undefined;
    if (filter === undefined) {
      throw new RequestValidationError([{ path: 'query', message: 'Indique city o stationId' }]);
    }
    const { items, now } = await useCases.getAvailableConnectors.execute(filter);
    sendJson(res, 200, { items: items.map((item) => toAvailableConnectorView(item, now)) });
  });

  return router;
}
