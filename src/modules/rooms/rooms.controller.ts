import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import type { ListRoomsQuery } from './rooms.schema';
import * as service from './rooms.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListRoomsQuery);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id)));
