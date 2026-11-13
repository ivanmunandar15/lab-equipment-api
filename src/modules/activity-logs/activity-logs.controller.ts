import { asyncHandler } from '../../utils/async-handler';
import { ok, paginated } from '../../utils/response';
import type { ListActivityLogsQuery } from './activity-logs.schema';
import * as service from './activity-logs.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListActivityLogsQuery);
  paginated(res, items, meta);
});

export const getById = asyncHandler(async (req, res) => {
  ok(res, await service.getById(req.params.id));
});
