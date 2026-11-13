import { createHash, randomBytes } from 'node:crypto';

export const SENSOR_KEY_PREFIX = 'lsk_';

/** API key perangkat: 256-bit acak. Hanya dikembalikan sekali ke admin; yang disimpan hanya hash-nya. */
export const generateSensorKey = (): string => SENSOR_KEY_PREFIX + randomBytes(32).toString('base64url');

/** SHA-256 cukup untuk secret berentropi tinggi (bukan password) dan memungkinkan lookup langsung. */
export const hashSensorKey = (key: string): string => createHash('sha256').update(key).digest('hex');
