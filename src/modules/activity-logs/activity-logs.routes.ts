import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './activity-logs.controller';
import { idParams, listActivityLogsQuery } from './activity-logs.schema';

export const activityLogsRouter = Router();

// Read-only: log tidak punya endpoint tulis/ubah/hapus.
activityLogsRouter.use(authenticate, authorize(...PERMISSIONS.activityLogs.read));

activityLogsRouter.get('/', validate({ query: listActivityLogsQuery }), c.list);
activityLogsRouter.get('/:id', validate({ params: idParams }), c.getById);
