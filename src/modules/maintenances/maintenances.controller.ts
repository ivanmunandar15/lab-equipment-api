import type { Request } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import * as service from './maintenances.service';

const actorOf = (req: Request): service.Actor => ({ userId: req.user!.user_id, ip: req.ip ?? null });

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as never);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body, actorOf(req))));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(req.params.id, req.body, actorOf(req))));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id, actorOf(req))));
