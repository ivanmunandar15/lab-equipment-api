import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { auditCreate, auditDelete, auditRoute, auditUpdate } from '../../middlewares/audit';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as c from './sensors.controller';
import { createSensorBody, idParams, listSensorsQuery, updateSensorBody } from './sensors.schema';
import { getById } from './sensors.service';

export const sensorsRouter = Router();

const read = authorize(...PERMISSIONS.sensors.read);
const write = authorize(...PERMISSIONS.sensors.write);
const loadOld = (req: { params: { id?: string } }) => getById(req.params.id as string);
const E = AUDIT_ENTITIES.SENSOR;

sensorsRouter.use(authenticate);

sensorsRouter.get('/', read, validate({ query: listSensorsQuery }), c.list);
sensorsRouter.post('/', write, validate({ body: createSensorBody }), auditCreate(E), c.create);
sensorsRouter.get('/:id', read, validate({ params: idParams }), c.getById);
sensorsRouter.patch('/:id', write, validate({ params: idParams, body: updateSensorBody }), auditUpdate(E, loadOld), c.update);
sensorsRouter.delete('/:id', write, validate({ params: idParams }), auditDelete(E, loadOld), c.remove);
// API key perangkat. Plaintext tidak masuk activity log (sanitizer membuang field *api_key*).
sensorsRouter.post(
  '/:id/api-key',
  write,
  validate({ params: idParams }),
  auditRoute({ entityType: E, action: AUDIT_ACTIONS.ROTATE_API_KEY, idField: 'sensor_id' }),
  c.rotateApiKey,
);
sensorsRouter.delete(
  '/:id/api-key',
  write,
  validate({ params: idParams }),
  auditRoute({ entityType: E, action: AUDIT_ACTIONS.REVOKE_API_KEY, idField: 'sensor_id' }),
  c.revokeApiKey,
);
