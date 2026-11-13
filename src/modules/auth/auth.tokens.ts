import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'crypto';
import { env } from '../../config/env';
import type { RoleName } from '../../config/permissions';
import { AppError } from '../../utils/errors';
import { parseDurationMs } from '../../utils/duration';

export const ACCESS_TTL_SECONDS = parseDurationMs(env.JWT_ACCESS_EXPIRES_IN) / 1000;
export const REFRESH_TTL_MS = parseDurationMs(env.JWT_REFRESH_EXPIRES_IN);

export interface AccessPayload {
  sub: string;
  role: RoleName;
}

export function signAccessToken(userId: string, role: RoleName): string {
  return jwt.sign({ role }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub) throw AppError.unauthorized('Token tidak valid');
    return { sub: p.sub, role: p.role };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Access token kedaluwarsa');
    }
    throw AppError.unauthorized('Token tidak valid');
  }
}

/** Refresh token = string acak opaque; hanya hash-nya (HMAC-SHA256) yang disimpan di DB. */
export const generateRefreshToken = (): string => randomBytes(48).toString('base64url');
export const hashRefreshToken = (raw: string): string =>
  createHmac('sha256', env.JWT_REFRESH_SECRET).update(raw).digest('hex');
