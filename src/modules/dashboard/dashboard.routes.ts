import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './dashboard.controller';
import { alertsQuery } from './dashboard.schema';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

dashboardRouter.get('/stats', authorize(...PERMISSIONS.dashboard.read), c.stats);
dashboardRouter.get('/charts', authorize(...PERMISSIONS.dashboard.read), c.charts);
dashboardRouter.get('/alerts', authorize(...PERMISSIONS.dashboard.read), validate({ query: alertsQuery }), c.alerts);
// Mengikuti hak activity log (technician tidak boleh melihat log).
dashboardRouter.get('/recent-activity', authorize(...PERMISSIONS.dashboard.recentActivity), c.recentActivity);
