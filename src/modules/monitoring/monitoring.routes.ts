import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authenticateDevice } from '../../middlewares/device-auth';
import { iotLimiter } from '../../middlewares/rate-limit';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './monitoring.controller';
import { idParams, ingestBody, readingsQuery, streamQuery } from './monitoring.schema';
import { stream } from './monitoring.stream';

export const monitoringRouter = Router();

const read = authorize(...PERMISSIONS.monitoring.read);

// Perangkat IoT: X-Sensor-Key, bukan JWT. Limiter dipasang sebelum lookup DB.
monitoringRouter.post('/readings', iotLimiter, authenticateDevice, validate({ body: ingestBody }), c.ingest);

// Pengguna (JWT)
monitoringRouter.get('/summary', authenticate, read, c.summary);
monitoringRouter.get('/stream', authenticate, read, validate({ query: streamQuery }), stream);
monitoringRouter.get('/sensors/:id/readings', authenticate, read, validate({ params: idParams, query: readingsQuery }), c.sensorReadings);
monitoringRouter.get('/rooms/:id/latest', authenticate, read, validate({ params: idParams }), c.roomLatest);
