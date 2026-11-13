import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import type { ListSensorsQuery } from './sensors.schema';
import * as service from './sensors.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListSensorsQuery);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const create = asyncHandler(async (req, res) => {
  const data = await service.create(req.body);
  if ('api_key' in data) res.setHeader('Cache-Control', 'no-store');
  created(res, data);
});
export const update = asyncHandler(async (req, res) => ok(res, await service.update(req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id)));
export const rotateApiKey = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await service.rotateApiKey(req.params.id));
});
export const revokeApiKey = asyncHandler(async (req, res) => ok(res, await service.revokeApiKey(req.params.id)));
