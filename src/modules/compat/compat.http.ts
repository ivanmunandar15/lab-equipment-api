import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { isProd } from '../../config/env';
import { logger } from '../../config/logger';
import { asyncHandler } from '../../utils/async-handler';
import { AppError } from '../../utils/errors';

/**
 * Lapisan kompatibilitas frontend (`/api/v1/compat`).
 *
 * Kontrak yang ditiru dari mock frontend (`lib/services/*`):
 *  - Respons sukses = data mentah (array/objek), TANPA amplop `{success, data}`.
 *  - Respons gagal = `{ error: { code, message, fieldErrors? } }` dengan kode
 *    NOT_FOUND | VALIDATION | CONFLICT | FORBIDDEN (+ UNAUTHORIZED | INTERNAL),
 *    persis `ServiceError` di frontend. `fieldErrors` = peta "path.field" -> pesan
 *    (cocok dengan `setError` React Hook Form).
 *  - Daftar tidak dipaginasi (frontend memfilter/mengurutkan di sisi klien).
 */
export type CompatErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'INTERNAL';

export const h = asyncHandler;

/** Batas pengaman untuk daftar tanpa paginasi. Inventaris lab jauh di bawah angka ini. */
export const LIST_CAP = 5000;

export const send = <T>(res: Response, data: T, status = 200) => res.status(status).json(data);

/** Validasi + coerce memakai zod; ZodError diubah menjadi respons VALIDATION oleh `compatErrorHandler`. */
export const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

type Issue = { path: (string | number)[] | string; message: string; code?: string; keys?: string[] };

export function toFieldErrors(issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys' && issue.keys?.length) {
      for (const k of issue.keys) out[k] ??= `Field "${k}" tidak dikenali atau tidak dapat diubah`;
      continue;
    }
    const path = Array.isArray(issue.path) ? issue.path.join('.') : issue.path;
    out[path || '_form'] ??= issue.message;
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/**
 * ID tidak valid (bukan UUID) diperlakukan sebagai "tidak ditemukan" seperti mock
 * (mock melempar NOT_FOUND untuk ID apa pun yang tidak ada), bukan 422.
 */
export function idParam(req: Request, name = 'id', label = 'Data'): string {
  const v = req.params[name];
  if (!isUuid(v)) throw AppError.notFound(`${label} dengan ID "${v}" tidak ditemukan`);
  return v;
}

/** Buang field bernilai undefined dari objek (agar tidak menimpa kolom saat update). */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** '' -> null (kolom opsional di DB), selain itu apa adanya. */
export const emptyToNull = (v: string | null | undefined): string | null | undefined => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v);

/** 'yyyy-MM-dd' -> Date UTC (kolom @db.Date). */
export const toDateOnly = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

/** Seperti toDateOnly, tetapi null/undefined/"" -> null (kolom tanggal nullable). */
export const toDateOnlyOrNull = (v: string | null | undefined): Date | null => (v ? toDateOnly(v) : null);

/** Query boolean: 'true' | '1'. */
export const flag = (v: unknown): boolean => v === true || v === 'true' || v === '1';

/** Query string -> string[] (koma atau ulang param). */
export function csv(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return arr.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function normalize(err: unknown): { status: number; code: CompatErrorCode; message: string; fieldErrors?: Record<string, string>; reason?: string; details?: unknown } {
  if (err instanceof ZodError) {
    return { status: 422, code: 'VALIDATION', message: 'Data tidak valid', fieldErrors: toFieldErrors(err.issues as Issue[]) };
  }
  if (err instanceof AppError) {
    const base = { status: err.statusCode, message: err.message, reason: err.code };
    if (err.statusCode === 422) {
      const list = Array.isArray(err.details) ? (err.details as Issue[]) : [];
      return { ...base, code: 'VALIDATION', message: 'Data tidak valid', fieldErrors: list.length ? toFieldErrors(list) : { _form: err.message } };
    }
    if (err.statusCode === 404) return { ...base, code: 'NOT_FOUND' };
    if (err.statusCode === 403) return { ...base, code: 'FORBIDDEN' };
    if (err.statusCode === 401) return { ...base, code: 'UNAUTHORIZED' };
    if (err.statusCode === 409) return { ...base, code: 'CONFLICT', details: err.details };
    if (err.statusCode === 400 || err.statusCode === 413) return { ...base, code: 'VALIDATION', fieldErrors: { _form: err.message } };
    return { ...base, code: 'INTERNAL' };
  }
  const e = err as { type?: string; code?: string; name?: string };
  if (e?.type === 'entity.parse.failed') return { status: 400, code: 'VALIDATION', message: 'JSON tidak valid', fieldErrors: { _form: 'JSON tidak valid' } };
  if (e?.type === 'entity.too.large') return { status: 413, code: 'VALIDATION', message: 'Payload terlalu besar', fieldErrors: { _form: 'Payload terlalu besar' } };
  if (e?.name === 'MulterError') return { status: 413, code: 'VALIDATION', message: 'Ukuran file melebihi batas', fieldErrors: { file: 'Ukuran file melebihi batas' } };
  if (e?.code === 'P2002') return { status: 409, code: 'CONFLICT', message: 'Data duplikat' };
  if (e?.code === 'P2025') return { status: 404, code: 'NOT_FOUND', message: 'Data tidak ditemukan' };
  if (e?.code === 'P2003') return { status: 409, code: 'CONFLICT', message: 'Data masih terkait dengan data lain' };
  return { status: 500, code: 'INTERNAL', message: 'Terjadi kesalahan pada server' };
}

/** Pasang di AKHIR router compat: ubah error apa pun ke bentuk `ServiceError` frontend. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const compatErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const n = normalize(err);
  if (n.status >= 500) logger.error({ err, path: req.originalUrl }, 'Unhandled error (compat)');
  res.status(n.status).json({
    error: {
      code: n.code,
      message: n.status >= 500 && isProd ? 'Terjadi kesalahan pada server' : n.message,
      ...(n.fieldErrors ? { fieldErrors: n.fieldErrors } : {}),
      ...(n.reason ? { reason: n.reason } : {}),
      ...(n.details !== undefined ? { details: n.details } : {}),
    },
  });
};

export const compatNotFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} tidak ditemukan`));
};
