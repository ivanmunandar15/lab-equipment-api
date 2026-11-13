import { Router } from 'express';
import { auditUpdate } from '../../middlewares/audit';
import { authenticate } from '../../middlewares/auth';
import { authLimiter, loginLimiter, refreshLimiter } from '../../middlewares/rate-limit';
import { validate } from '../../middlewares/validate';
import { AUDIT_ENTITIES } from '../activity-logs/audit.service';
import { getById as getUserById } from '../users/users.service';
import * as c from './auth.controller';
import { changePasswordBody, loginBody, updateMeBody } from './auth.schema';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginBody }), c.login);
authRouter.post('/refresh', refreshLimiter, c.refresh);
authRouter.post('/logout', c.logout);

authRouter.get('/me', authenticate, c.me);
authRouter.patch(
  '/me',
  authenticate,
  validate({ body: updateMeBody }),
  auditUpdate(AUDIT_ENTITIES.USER, (req) => getUserById(req.user!.user_id)),
  c.updateMe,
);
authRouter.patch('/me/password', authLimiter, authenticate, validate({ body: changePasswordBody }), c.changePassword);
