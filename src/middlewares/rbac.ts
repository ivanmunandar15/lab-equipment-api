import type { RequestHandler } from 'express';
import type { RoleName } from '../config/permissions';
import { AppError } from '../utils/errors';

/** Pasang setelah authenticate. Balas 403 jika role tidak termasuk daftar. */
export const authorize =
  (...roles: RoleName[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(AppError.forbidden('Anda tidak memiliki akses ke sumber daya ini'));
    }
    next();
  };
