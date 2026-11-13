import { asyncHandler } from '../../utils/async-handler';
import { created, ok } from '../../utils/response';
import type { ReadingsQuery } from './monitoring.schema';
import * as service from './monitoring.service';

export const ingest = asyncHandler(async (req, res) => created(res, await service.ingest(req.sensor!, req.body)));
export const sensorReadings = asyncHandler(async (req, res) =>
  ok(res, await service.sensorReadings(req.params.id, req.query as unknown as ReadingsQuery)),
);
export const roomLatest = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.roomLatest(req.params.id));
});
export const summary = asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.summary());
});
