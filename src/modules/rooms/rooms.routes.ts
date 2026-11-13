import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { auditCreate, auditDelete, auditUpdate } from '../../middlewares/audit';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import { AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as c from './rooms.controller';
import { createRoomBody, idParams, listRoomsQuery, updateRoomBody } from './rooms.schema';
import { getById } from './rooms.service';

export const roomsRouter = Router();

const read = authorize(...PERMISSIONS.rooms.read);
const write = authorize(...PERMISSIONS.rooms.write);
const loadOld = (req: { params: { id?: string } }) => getById(req.params.id as string);

roomsRouter.use(authenticate);

roomsRouter.get('/', read, validate({ query: listRoomsQuery }), c.list);
roomsRouter.post('/', write, validate({ body: createRoomBody }), auditCreate(AUDIT_ENTITIES.ROOM), c.create);
roomsRouter.get('/:id', read, validate({ params: idParams }), c.getById);
roomsRouter.patch(
  '/:id',
  write,
  validate({ params: idParams, body: updateRoomBody }),
  auditUpdate(AUDIT_ENTITIES.ROOM, loadOld),
  c.update,
);
roomsRouter.delete('/:id', write, validate({ params: idParams }), auditDelete(AUDIT_ENTITIES.ROOM, loadOld), c.remove);
