import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} tidak ditemukan`));
};

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return AppError.unprocessable(
      'Validasi gagal',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  const e = err as { type?: string; code?: string; meta?: { target?: unknown } };

  // JSON body rusak / terlalu besar (body-parser)
  if (e?.type === 'entity.parse.failed') return AppError.badRequest('JSON tidak valid');
  if (e?.type === 'entity.too.large')
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload terlalu besar');

  // Upload (multer)
  if ((err as { name?: string })?.name === 'MulterError') {
    const mc = (err as { code?: string }).code;
    if (mc === 'LIMIT_FILE_SIZE') return new AppError(413, 'FILE_TOO_LARGE', 'Ukuran file melebihi batas');
    return AppError.badRequest('Upload tidak valid', { code: mc });
  }

  // Prisma known errors (tanpa import agar tidak butuh prisma generate)
  if (e?.code === 'P2002') return AppError.conflict('Data duplikat', { fields: e.meta?.target });
  if (e?.code === 'P2025') return AppError.notFound();
  if (e?.code === 'P2003') return AppError.conflict('Data masih terkait dengan data lain');

  return AppError.internal();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = normalize(err);

  if (appErr.statusCode >= 500) {
    logger.error({ err, path: req.originalUrl }, 'Unhandled error');
  }

  res.status(appErr.statusCode).json({
    success: false,
    error: {
      code: appErr.code,
      message:
        appErr.statusCode >= 500 && isProd ? 'Terjadi kesalahan pada server' : appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      ...(!isProd && appErr.statusCode >= 500 ? { stack: (err as Error)?.stack } : {}),
    },
  });
};
