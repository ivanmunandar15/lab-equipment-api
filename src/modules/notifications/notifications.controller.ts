import { asyncHandler } from '../../utils/async-handler';
import { ok, paginated } from '../../utils/response';
import type { ListNotificationsQuery } from './notifications.schema';
import * as service from './notifications.service';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.user!.user_id, req.query as unknown as ListNotificationsQuery);
  paginated(res, items, meta);
});
export const unreadCount = asyncHandler(async (req, res) => ok(res, await service.unreadCount(req.user!.user_id)));
export const markRead = asyncHandler(async (req, res) => ok(res, await service.markRead(req.user!.user_id, req.params.id)));
export const markAllRead = asyncHandler(async (req, res) =>
  ok(res, await service.markAllRead(req.user!.user_id, (req.body as { type?: ListNotificationsQuery['type'] }).type)),
);
