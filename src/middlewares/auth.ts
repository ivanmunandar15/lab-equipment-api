import { getDb } from '../config/db';
import { verifyAccessToken } from '../modules/auth/auth.tokens';
import { USER_PUBLIC_SELECT } from '../modules/users/users.select';
import type { AuthUser } from '../types/auth-user';
import { asyncHandler } from '../utils/async-handler';
import { AppError } from '../utils/errors';

/** Verifikasi JWT access token, lalu muat user terbaru dari DB ke req.user. */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw AppError.unauthorized('Token tidak ditemukan');

  const payload = verifyAccessToken(header.slice(7));
  const user = await getDb().user.findUnique({
    where: { user_id: payload.sub },
    select: USER_PUBLIC_SELECT,
  });
  if (!user || !user.is_active) throw AppError.unauthorized('Akun tidak valid atau tidak aktif');

  req.user = user as AuthUser;
  next();
});
