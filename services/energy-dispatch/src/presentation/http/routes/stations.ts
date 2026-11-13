import { energyDispatchV1 as api, connectorIdSchema, stationIdSchema } from '@aegisvolt/contracts';
import { Router } from 'express';
import { z } from 'zod';

import type { GetChargerStatus, ListStationSessions } from '../../../application/index.ts';
import { sendJson } from '../problem.ts';
import { parseRequest } from '../validation.ts';
import { toChargerStatusView, toSessionView } from '../views.ts';
import { ROUTES } from './route-patterns.ts';

export interface StationUseCases {
  readonly listStationSessions: ListStationSessions;
  readonly getChargerStatus: GetChargerStatus;
}

const stationParamsSchema = z.object({ stationId: stationIdSchema });
const chargerParamsSchema = stationParamsSchema.extend({ connectorId: connectorIdSchema });

/** Consultas por estación: sesiones activas o históricas y estado de cada cargador. */
export function stationRoutes(useCases: StationUseCases): Router {
  const router = Router();

  router.get(ROUTES.stationSessions, async (req, res) => {
    const { stationId } = parseRequest(stationParamsSchema, req.params, 'params');
    const query = parseRequest(api.listStationSessionsQuerySchema, req.query, 'query');
    const page = await useCases.listStationSessions.execute({ stationId, ...query });
    sendJson(res, 200, {
      items: page.items.map(toSessionView),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  router.get(ROUTES.chargerStatus, async (req, res) => {
    const params = parseRequest(chargerParamsSchema, req.params, 'params');
    sendJson(res, 200, toChargerStatusView(await useCases.getChargerStatus.execute(params)));
  });

  return router;
}
