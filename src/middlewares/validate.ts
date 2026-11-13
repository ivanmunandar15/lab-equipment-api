import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** Validasi body/query/params. Hasil parse (sudah di-coerce) menggantikan nilai asli. */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(
          AppError.unprocessable(
            'Validasi gagal',
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      }
      next(err);
    }
  };
