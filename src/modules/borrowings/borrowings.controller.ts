import type { Request } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import * as service from './borrowings.service';
import type { Actor } from './borrowings.service';

export const actorOf = (req: Request): Actor => ({ userId: req.user!.user_id, role: req.user!.role, ip: req.ip ?? null });

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as never);
  paginated(res, items, meta);
});
export const my = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as never, req.user!.user_id);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id, actorOf(req))));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body, actorOf(req))));
export const returnItems = asyncHandler(async (req, res) => ok(res, await service.returnItems(req.params.id, req.body, actorOf(req))));
