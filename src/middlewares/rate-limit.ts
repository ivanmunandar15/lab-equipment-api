import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env';

const handler = (message: string) => ({
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message },
});

/** Limiter umum untuk seluruh API. */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: handler('Terlalu banyak permintaan, coba lagi nanti'),
});

/** Limiter ketat untuk /auth (dipasang di tahap Auth). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: handler('Terlalu banyak percobaan autentikasi, coba lagi dalam 15 menit'),
});

/** Login: hanya percobaan gagal yang dihitung. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: handler('Terlalu banyak percobaan login, coba lagi dalam 15 menit'),
});

/** Refresh token lebih longgar karena dipanggil otomatis oleh frontend. */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: handler('Terlalu banyak permintaan refresh token'),
});

/** Perangkat IoT: dihitung per X-Sensor-Key (fallback IP). */
export const iotLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: (req) => req.header('x-sensor-key') ?? req.ip ?? 'unknown',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: handler('Terlalu banyak pengiriman data sensor'),
});
