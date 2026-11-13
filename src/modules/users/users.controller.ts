import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import type { ListUsersQuery } from './users.schema';
import * as service from './users.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListUsersQuery);
  paginated(res, items, meta);
});

export const getById = asyncHandler(async (req, res) => {
  ok(res, await service.getById(req.params.id));
});

export const create = asyncHandler(async (req, res) => {
  const { user, temporary_password } = await service.create(req.body);
  created(res, { ...user, ...(temporary_password ? { temporary_password } : {}) });
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await service.update(req.params.id, req.body, req.user!.user_id));
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { temporary_password } = await service.resetPassword(req.params.id, req.body.new_password);
  ok(res, { message: 'Password berhasil direset', ...(temporary_password ? { temporary_password } : {}) });
});

export const remove = asyncHandler(async (req, res) => {
  ok(res, await service.deactivate(req.params.id, req.user!.user_id));
});
