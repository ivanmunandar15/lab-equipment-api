import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './maintenances.controller';
import { createMaintenanceBody, idParams, listMaintenancesQuery, updateMaintenanceBody } from './maintenances.schema';

export const maintenancesRouter = Router();

const read = authorize(...PERMISSIONS.maintenances.read);
const write = authorize(...PERMISSIONS.maintenances.write);
const del = authorize(...PERMISSIONS.maintenances.delete);

maintenancesRouter.use(authenticate);

maintenancesRouter.get('/', read, validate({ query: listMaintenancesQuery }), c.list);
maintenancesRouter.post('/', write, validate({ body: createMaintenanceBody }), c.create);
maintenancesRouter.get('/:id', read, validate({ params: idParams }), c.getById);
maintenancesRouter.patch('/:id', write, validate({ params: idParams, body: updateMaintenanceBody }), c.update);
maintenancesRouter.delete('/:id', del, validate({ params: idParams }), c.remove);
