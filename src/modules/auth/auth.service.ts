import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import type { RoleName } from '../../config/permissions';
import { AppError } from '../../utils/errors';
import { BCRYPT_ROUNDS, hashPassword, verifyPassword } from '../../utils/password';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { USER_PUBLIC_SELECT } from '../users/users.select';
import { loginThrottle } from './login-throttle';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from './auth.tokens';

interface Meta {
  ip?: string;
  userAgent?: string;
}

// Hash palsa agar waktu respons sama untuk email yang tidak terdaftar.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);
// Token yang baru dirotasi masih ditoleransi sebentar (request paralel dari frontend).
const REUSE_GRACE_MS = 10_000;

type Tx = Prisma.TransactionClient;

async function issueRefreshToken(client: Tx | ReturnType<typeof getDb>, userId: string, meta: Meta) {
  const raw = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const row = await client.refreshToken.create({
    data: {
      user_id: userId,
      token_hash: hashRefreshToken(raw),
      expires_at: expiresAt,
      user_agent: meta.userAgent?.slice(0, 255),
      ip_address: meta.ip,
    },
    select: { token_id: true },
  });
  return { raw, expiresAt, tokenId: row.token_id };
}

const revokeAllForUser = (userId: string, exceptHash?: string) =>
  getDb().refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null, ...(exceptHash ? { token_hash: { not: exceptHash } } : {}) },
    data: { revoked_at: new Date() },
  });

function session(user: { user_id: string; role: RoleName }, refresh: { raw: string; expiresAt: Date }) {
  return {
    accessToken: signAccessToken(user.user_id, user.role),
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: refresh.raw,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export async function login(email: string, password: string, meta: Meta) {
  const key = `${email}|${meta.ip ?? ''}`;
  await loginThrottle.wait(key);

  const db = getDb();
  const user = await db.user.findUnique({
    where: { email },
    select: { ...USER_PUBLIC_SELECT, password_hash: true },
  });
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) {
    loginThrottle.fail(key);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email atau password salah');
  }
  if (!user.is_active) throw new AppError(403, 'ACCOUNT_INACTIVE', 'Akun tidak aktif, hubungi administrator');

  loginThrottle.reset(key);
  const refresh = await db.$transaction(async (tx) => {
    const issued = await issueRefreshToken(tx, user.user_id, meta);
    await audit.log(
      {
        userId: user.user_id,
        action: AUDIT_ACTIONS.LOGIN,
        entityType: AUDIT_ENTITIES.USER,
        entityId: user.user_id,
        newData: { email: user.email, role: user.role, user_agent: meta.userAgent?.slice(0, 255) },
        ip: meta.ip,
      },
      tx,
    );
    return issued;
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash, ...publicUser } = user;
  return { user: publicUser, ...session(user as { user_id: string; role: RoleName }, refresh) };
}

export async function refresh(rawToken: string | undefined, meta: Meta) {
  if (!rawToken) throw AppError.unauthorized('Refresh token tidak ditemukan');
  const db = getDb();
  const row = await db.refreshToken.findUnique({ where: { token_hash: hashRefreshToken(rawToken) } });
  if (!row) throw AppError.unauthorized('Refresh token tidak valid');

  if (row.revoked_at) {
    // Token lama dipakai lagi di luar masa toleransi → indikasi pencurian, cabut semua sesi.
    if (Date.now() - row.revoked_at.getTime() > REUSE_GRACE_MS) await revokeAllForUser(row.user_id);
    throw AppError.unauthorized('Refresh token tidak valid');
  }
  if (row.expires_at.getTime() <= Date.now()) throw AppError.unauthorized('Refresh token kedaluwarsa');

  const user = await db.user.findUnique({ where: { user_id: row.user_id }, select: USER_PUBLIC_SELECT });
  if (!user || !user.is_active) throw AppError.unauthorized('Akun tidak valid atau tidak aktif');

  const next = await db.$transaction(async (tx) => {
    const created = await issueRefreshToken(tx, user.user_id, meta);
    const { count } = await tx.refreshToken.updateMany({
      where: { token_id: row.token_id, revoked_at: null },
      data: { revoked_at: new Date(), replaced_by: created.tokenId },
    });
    if (count === 0) throw AppError.unauthorized('Refresh token tidak valid');
    return created;
  });

  return { user, ...session(user as { user_id: string; role: RoleName }, next) };
}

export async function logout(rawToken: string | undefined) {
  if (!rawToken) return;
  await getDb().refreshToken.updateMany({
    where: { token_hash: hashRefreshToken(rawToken), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function updateProfile(userId: string, data: { name: string }) {
  return getDb().user.update({ where: { user_id: userId }, data, select: USER_PUBLIC_SELECT });
}

export async function changePassword(userId: string, current: string, next: string, currentRefreshRaw?: string, meta?: { ip?: string }) {
  const db = getDb();
  const user = await db.user.findUnique({ where: { user_id: userId }, select: { password_hash: true } });
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Password lama salah');
  }
  const password_hash = await hashPassword(next);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { user_id: userId }, data: { password_hash } });
    // Cabut semua sesi lain; sesi saat ini tetap berjalan.
    await tx.refreshToken.updateMany({
      where: {
        user_id: userId,
        revoked_at: null,
        ...(currentRefreshRaw ? { token_hash: { not: hashRefreshToken(currentRefreshRaw) } } : {}),
      },
      data: { revoked_at: new Date() },
    });
    await audit.log(
      { userId, action: AUDIT_ACTIONS.CHANGE_PASSWORD, entityType: AUDIT_ENTITIES.USER, entityId: userId, ip: meta?.ip },
      tx,
    );
  });
}
