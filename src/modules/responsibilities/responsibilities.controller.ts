import { asyncHandler } from '../../utils/async-handler';
import { created, ok } from '../../utils/response';
import * as service from './responsibilities.service';

export const list = asyncHandler(async (_req, res) => ok(res, await service.list()));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body)));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id)));
