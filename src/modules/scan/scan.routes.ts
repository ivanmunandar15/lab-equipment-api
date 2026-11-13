import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import { qrTokenParams } from '../borrowings/borrowings.schema';
import * as c from './scan.controller';

export const scanRouter = Router();

scanRouter.use(authenticate);
scanRouter.get('/eq/:qrToken', authorize(...PERMISSIONS.equipment.read), validate({ params: qrTokenParams }), c.equipment);
scanRouter.get('/sp/:qrToken', authorize(...PERMISSIONS.supportingEquipment.read), validate({ params: qrTokenParams }), c.supporting);
