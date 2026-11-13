import type { CookieOptions, Response } from 'express';
import { env, isProd } from '../../config/env';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import * as service from './auth.service';

export const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

const baseCookie: CookieOptions = {
  httpOnly: true,
  secure: isProd || env.COOKIE_SAME_SITE === 'none',
  sameSite: env.COOKIE_SAME_SITE,
  path: COOKIE_PATH,
};

const setRefreshCookie = (res: Response, token: string, expires: Date) =>
  res.cookie(REFRESH_COOKIE, token, { ...baseCookie, expires });
const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, baseCookie);

const meta = (req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

/**
 * Klien server-side (BFF, mis. NextAuth di Next.js) tidak memegang cookie browser: dengan header `X-Client: bff`
 * refresh token juga dikirim di body dan boleh dikirim balik di body `/auth/refresh`. Browser biasa tetap hanya memakai cookie httpOnly.
 */
const isBff = (req: { get(name: string): string | undefined }) => req.get('x-client') === 'bff';

export const login = asyncHandler(async (req, res) => {
  const r = await service.login(req.body.email, req.body.password, meta(req));
  setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt);
  ok(res, {
    access_token: r.accessToken, token_type: 'Bearer', expires_in: r.expiresIn, user: r.user,
    ...(isBff(req) ? { refresh_token: r.refreshToken } : {}),
  });
});

export const refresh = asyncHandler(async (req, res) => {
  try {
    const bodyToken = isBff(req) && typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : undefined;
    const r = await service.refresh(req.cookies?.[REFRESH_COOKIE] ?? bodyToken, meta(req));
    setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt);
    ok(res, {
      access_token: r.accessToken, token_type: 'Bearer', expires_in: r.expiresIn, user: r.user,
      ...(isBff(req) ? { refresh_token: r.refreshToken } : {}),
    });
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

export const logout = asyncHandler(async (req, res) => {
  await service.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  ok(res, { message: 'Logout berhasil' });
});

export const me = asyncHandler(async (req, res) => {
  ok(res, req.user);
});

export const updateMe = asyncHandler(async (req, res) => {
  ok(res, await service.updateProfile(req.user!.user_id, req.body));
});

export const changePassword = asyncHandler(async (req, res) => {
  await service.changePassword(
    req.user!.user_id,
    req.body.current_password,
    req.body.new_password,
    req.cookies?.[REFRESH_COOKIE],
    { ip: req.ip },
  );
  ok(res, { message: 'Password berhasil diubah' });
});
