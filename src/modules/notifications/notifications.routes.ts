import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import * as c from './notifications.controller';
import { idParams, listNotificationsQuery, readAllBody } from './notifications.schema';

export const notificationsRouter = Router();

// Semua role yang login boleh; data selalu dibatasi ke user sendiri di service.
notificationsRouter.use(authenticate);

notificationsRouter.get('/', validate({ query: listNotificationsQuery }), c.list);
notificationsRouter.get('/unread-count', c.unreadCount);
notificationsRouter.patch('/read-all', validate({ body: readAllBody }), c.markAllRead);
notificationsRouter.patch('/:id/read', validate({ params: idParams }), c.markRead);
