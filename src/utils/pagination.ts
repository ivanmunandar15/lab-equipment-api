import { z } from 'zod';
import type { PageMeta } from './response';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sort: z.string().trim().min(1).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function getPagination({ page, limit }: Pick<PaginationQuery, 'page' | 'limit'>) {
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function buildMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Validasi `sort` terhadap whitelist kolom; fallback ke default. */
export function resolveSort(sort: string | undefined, allowed: string[], fallback: string) {
  return sort && allowed.includes(sort) ? sort : fallback;
}
