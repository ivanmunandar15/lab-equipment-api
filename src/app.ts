import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import hpp from 'hpp';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { corsOrigins, isProd } from './config/env';
import { logger } from './config/logger';
import { globalLimiter } from './middlewares/rate-limit';
import { errorHandler, notFound } from './middlewares/error-handler';
import { openapiSpec } from './docs/openapi';
import { healthRouter } from './modules/health/health.routes';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { roomsRouter } from './modules/rooms/rooms.routes';
import { equipmentRouter } from './modules/equipment/equipment.routes';
import { supportingEquipmentRouter } from './modules/supporting-equipment/supporting-equipment.routes';
import { borrowingsRouter } from './modules/borrowings/borrowings.routes';
import { scanRouter } from './modules/scan/scan.routes';
import { calibrationsRouter } from './modules/calibrations/calibrations.routes';
import { maintenancesRouter } from './modules/maintenances/maintenances.routes';
import { activityLogsRouter } from './modules/activity-logs/activity-logs.routes';
import { sensorsRouter } from './modules/sensors/sensors.routes';
import { monitoringRouter } from './modules/monitoring/monitoring.routes';
import { documentsRouter } from './modules/documents/documents.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { adminRouter, emailLogsRouter, meRouter } from './modules/email/email.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { compatRouter } from './modules/compat/compat.routes';

export function createApp() {
  const app = express();

  if (isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(globalLimiter);
  // Unggahan file lewat JSON (data URL base64, ±1,37x ukuran file) butuh batas lebih besar; hanya untuk dua route ini.
  // Harus sebelum parser global: body-parser melewati request yang sudah ter-parse.
  app.use(['/api/v1/compat/documents', '/api/v1/compat/calibrations'], express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(hpp());

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  // Router modul didaftarkan di sini pada tahap berikutnya
  const api = express.Router();
  api.use('/health', healthRouter);
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/rooms', roomsRouter);
  api.use('/equipment', equipmentRouter);
  api.use('/supporting-equipment', supportingEquipmentRouter);
  api.use('/scan', scanRouter);
  api.use('/borrowings', borrowingsRouter);
  api.use('/calibrations', calibrationsRouter);
  api.use('/maintenances', maintenancesRouter);
  api.use('/activity-logs', activityLogsRouter);
  api.use('/sensors', sensorsRouter);
  api.use('/monitoring', monitoringRouter);
  api.use('/documents', documentsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/me', meRouter);
  api.use('/email-logs', emailLogsRouter);
  api.use('/admin', adminRouter);
  api.use('/compat', compatRouter);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
