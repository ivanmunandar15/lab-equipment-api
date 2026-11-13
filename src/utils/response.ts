import type { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ok<T>(res: Response, data: T, meta?: PageMeta, status = 200) {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, undefined, 201);
}

export function paginated<T>(res: Response, data: T[], meta: PageMeta) {
  return ok(res, data, meta);
}
