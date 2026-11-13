import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import type { AlertsQuery } from './dashboard.schema';
import * as service from './dashboard.service';

export const stats = asyncHandler(async (_req, res) => ok(res, await service.getStats()));
export const charts = asyncHandler(async (_req, res) => ok(res, await service.getCharts()));
export const alerts = asyncHandler(async (req, res) => {
  ok(res, await service.getAlerts((req.query as unknown as AlertsQuery).limit));
});
export const recentActivity = asyncHandler(async (_req, res) => ok(res, await service.getRecentActivity()));
