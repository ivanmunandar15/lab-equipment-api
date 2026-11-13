import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { auditCreate, auditDelete, auditRoute, auditUpdate } from '../../middlewares/audit';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as c from './users.controller';
import { getById } from './users.service';
import { createUserBody, idParams, listUsersQuery, resetPasswordBody, updateUserBody } from './users.schema';

export const usersRouter = Router();

usersRouter.use(authenticate, authorize(...PERMISSIONS.users.manage));

usersRouter.get('/', validate({ query: listUsersQuery }), c.list);
const loadOld = (req: { params: { id?: string } }) => getById(req.params.id as string);

usersRouter.post('/', validate({ body: createUserBody }), auditCreate(AUDIT_ENTITIES.USER), c.create);
usersRouter.get('/:id', validate({ params: idParams }), c.getById);
usersRouter.patch('/:id', validate({ params: idParams, body: updateUserBody }), auditUpdate(AUDIT_ENTITIES.USER, loadOld), c.update);
usersRouter.post(
  '/:id/reset-password',
  validate({ params: idParams, body: resetPasswordBody }),
  auditRoute({ entityType: AUDIT_ENTITIES.USER, action: AUDIT_ACTIONS.RESET_PASSWORD }),
  c.resetPassword,
);
usersRouter.delete('/:id', validate({ params: idParams }), auditDelete(AUDIT_ENTITIES.USER, loadOld), c.remove);
