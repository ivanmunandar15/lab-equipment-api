import { customAlphabet } from 'nanoid';

export const QR_TOKEN_LENGTH = 12;

/**
 * Alfabet HARUS sama dengan frontend (`QR_ALPHABET` di lib/domain.ts): hanya [A-Za-z0-9].
 * nanoid() bawaan juga memakai `_` dan `-`, yang ditolak parser QR frontend (`/scan/(eq|sp)/[A-Za-z0-9]{12}`).
 */
export const QR_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const isValidQrToken = (value: string): boolean => new RegExp(`^[A-Za-z0-9]{${QR_TOKEN_LENGTH}}$`).test(value);

const nextToken = customAlphabet(QR_ALPHABET, QR_TOKEN_LENGTH);

/** Token QR publik 12 karakter. Pemanggil bertanggung jawab mengulang jika bentrok (unique). */
export const generateQrToken = (): string => nextToken();
