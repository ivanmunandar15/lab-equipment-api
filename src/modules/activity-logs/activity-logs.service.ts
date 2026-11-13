import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { computeDiff } from '../../utils/diff';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import type { ListActivityLogsQuery } from './activity-logs.schema';

const SORTABLE = ['created_at', 'action', 'entity_type'];
const USER_BRIEF = { select: { user_id: true, name: true, email: true, role: true } } as const;

/** List sengaja tanpa old_data/new_data agar ringan; detail memuatnya beserta diff. */
const LIST_SELECT = {
  log_id: true,
  user_id: true,
  action: true,
  entity_type: true,
  entity_id: true,
  ip_address: true,
  created_at: true,
  user: USER_BRIEF,
} as const;

export async function list(q: ListActivityLogsQuery) {
  const db = getDb();
  const createdAt = {
    ...(q.date_from ? { gte: q.date_from } : {}),
    ...(q.date_to ? { lte: q.date_to } : {}),
  };
  const where: Prisma.ActivityLogWhereInput = {
    ...(q.user_id ? { user_id: q.user_id } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.entity_type ? { entity_type: q.entity_type } : {}),
    ...(q.entity_id ? { entity_id: q.entity_id } : {}),
    ...(Object.keys(createdAt).length ? { created_at: createdAt } : {}),
    ...(q.search
      ? {
          OR: [
            { action: { contains: q.search, mode: 'insensitive' } },
            { entity_type: { contains: q.search, mode: 'insensitive' } },
            { entity_id: { contains: q.search, mode: 'insensitive' } },
            { user: { name: { contains: q.search, mode: 'insensitive' } } },
            { user: { email: { contains: q.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sortField = resolveSort(q.sort, SORTABLE, 'created_at');
  const [items, total] = await Promise.all([
    db.activityLog.findMany({ where, orderBy: { [sortField]: q.order }, skip, take, select: LIST_SELECT }),
    db.activityLog.count({ where }),
  ]);
  return { items, meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().activityLog.findUnique({
    where: { log_id: id },
    select: { ...LIST_SELECT, old_data: true, new_data: true },
  });
  if (!row) throw AppError.notFound('Activity log tidak ditemukan');
  return { ...row, diff: computeDiff(row.old_data, row.new_data) };
}
