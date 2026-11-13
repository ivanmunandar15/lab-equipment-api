import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { compatErrorHandler, compatNotFound } from './compat.http';
import { activityRouter } from './compat.activity';
import { borrowingsRouter } from './compat.borrowings';
import { dashboardRouter } from './compat.dashboard';
import { roomsRouter, usersRouter } from './compat.directory';
import { documentsRouter } from './compat.documents';
import { equipmentRouter, supportingRouter } from './compat.inventory';
import { readingsRouter, sensorsRouter } from './compat.monitoring';
import { notificationsRouter, reportsRouter } from './compat.notifications';
import { calibrationsRouter, maintenanceRouter } from './compat.records';

/**
 * `/api/v1/compat` — kontrak API yang meniru service mock frontend (`lib/services/*`).
 * Semua route butuh `Authorization: Bearer <access token>`; hak akses per role mengikuti matriks frontend (`lib/rbac.ts`)
 * yang dipetakan ke `config/permissions.ts`. Endpoint API utama (`/api/v1/*`) tidak berubah.
 */
export const compatRouter = Router();

compatRouter.use(authenticate);
compatRouter.use('/users', usersRouter);
compatRouter.use('/rooms', roomsRouter);
compatRouter.use('/equipment', equipmentRouter);
compatRouter.use('/supporting-equipment', supportingRouter);
compatRouter.use('/borrowings', borrowingsRouter);
compatRouter.use('/calibrations', calibrationsRouter);
compatRouter.use('/maintenance', maintenanceRouter);
compatRouter.use('/sensors', sensorsRouter);
compatRouter.use('/readings', readingsRouter);
compatRouter.use('/documents', documentsRouter);
compatRouter.use('/notifications', notificationsRouter);
compatRouter.use('/reports', reportsRouter);
compatRouter.use('/activity-logs', activityRouter);
compatRouter.use('/dashboard', dashboardRouter);
compatRouter.use(compatNotFound);
compatRouter.use(compatErrorHandler);
