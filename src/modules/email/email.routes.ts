import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './email.controller';
import { emailPreferencesBody, idParams, listEmailLogsQuery, runJobQuery } from './email.schema';

/** /me */
export const meRouter = Router();
meRouter.patch('/email-preferences', authenticate, validate({ body: emailPreferencesBody }), c.updatePreferences);

/** /email-logs */
export const emailLogsRouter = Router();
emailLogsRouter.use(authenticate);
emailLogsRouter.get('/', authorize(...PERMISSIONS.emailLogs.read), validate({ query: listEmailLogsQuery }), c.list);
emailLogsRouter.post('/:id/retry', authorize(...PERMISSIONS.emailLogs.retry), validate({ params: idParams }), c.retry);

/** /admin */
export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.post('/email/test', authorize(...PERMISSIONS.adminTools.emailTest), c.sendTest);
adminRouter.post('/jobs/calibration-reminders/run', authorize(...PERMISSIONS.adminTools.runJobs), validate({ query: runJobQuery }), c.runCalibrationReminders);
