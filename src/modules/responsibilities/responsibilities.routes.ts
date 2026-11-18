import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './responsibilities.controller';
import { createResponsibilityBody, idParams } from './responsibilities.schema';

/** /responsibilities — penanggung jawab alat (penerima email pengingat kalibrasi). */
export const responsibilitiesRouter = Router();

responsibilitiesRouter.use(authenticate);
responsibilitiesRouter.get('/', authorize(...PERMISSIONS.responsibilities.read), c.list);
responsibilitiesRouter.post('/', authorize(...PERMISSIONS.responsibilities.manage), validate({ body: createResponsibilityBody }), c.create);
responsibilitiesRouter.delete('/:id', authorize(...PERMISSIONS.responsibilities.manage), validate({ params: idParams }), c.remove);
