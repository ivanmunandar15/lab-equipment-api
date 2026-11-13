import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { AppError } from './errors';

export const CERTIFICATE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** Tipe sebenarnya dari isi file (magic bytes); null jika bukan PDF/JPEG/PNG/WebP. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const mimeFromKey = (key: string): string =>
  Object.entries(EXT).find(([, ext]) => key.endsWith(ext))?.[0] ?? 'application/octet-stream';

const root = () => path.resolve(env.UPLOAD_DIR);

/** Path absolut dari storage key; menolak key yang keluar dari folder upload. */
export function resolveStoragePath(key: string): string {
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw AppError.internal('Storage key tidak valid');
  return full;
}

/** Validasi isi file lalu simpan ke disk dengan nama acak (nama asli dari client tidak dipakai). Mengembalikan storage key. */
export async function saveCertificate(file: { buffer: Buffer; mimetype: string }): Promise<string> {
  const real = sniffMime(file.buffer);
  if (!real || real !== file.mimetype) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'certificate', message: 'Isi file tidak sesuai tipe PDF/JPEG/PNG/WebP' }]);
  }
  const key = `certificates/${randomUUID()}${EXT[real]}`;
  const full = resolveStoragePath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, file.buffer, { flag: 'wx' });
  return key;
}

export async function deleteStored(key: string): Promise<void> {
  try {
    await unlink(resolveStoragePath(key));
  } catch {
    /* sudah tidak ada */
  }
}

// ───────────── Dokumen alat ─────────────
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const DOCUMENT_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  [DOCX]: '.docx',
  [XLSX]: '.xlsx',
};
export const DOCUMENT_MIME = new Set(Object.keys(DOCUMENT_EXT));
export const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Hanya tipe ini yang boleh ditampilkan inline; sisanya selalu attachment. */
export const INLINE_MIME = new Set(['application/pdf', ...IMAGE_MIME]);

/** Validasi isi file terhadap tipe yang dideklarasikan. DOCX/XLSX = ZIP (PK\x03\x04); tipe pastinya mengikuti deklarasi. */
export function documentMimeMatches(buf: Buffer, declared: string): boolean {
  if (declared === DOCX || declared === XLSX) {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  }
  return sniffMime(buf) === declared;
}

export const documentMimeFromKey = (key: string): string =>
  Object.entries(DOCUMENT_EXT).find(([, ext]) => key.endsWith(ext))?.[0] ?? 'application/octet-stream';

/** Nama file asli hanya untuk tampilan: buang path, karakter kontrol, perbaiki encoding UTF-8 dari multer. */
export function cleanDisplayName(original: string): string {
  const utf8 = Buffer.from(original, 'latin1').toString('utf8');
  const name = (utf8.includes('\uFFFD') ? original : utf8)
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_')
    .trim();
  return (name || 'dokumen').slice(0, 200);
}

/** Simpan ke disk dengan nama acak (UUID + ekstensi dari MIME tervalidasi). Mengembalikan storage key. */
export async function saveDocumentFile(buf: Buffer, mime: string): Promise<string> {
  const key = `documents/${randomUUID()}${DOCUMENT_EXT[mime]}`;
  const full = resolveStoragePath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf, { flag: 'wx' });
  return key;
}
