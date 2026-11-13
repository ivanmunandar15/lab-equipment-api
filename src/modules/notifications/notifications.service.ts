import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import type { ListNotificationsQuery } from './notifications.schema';

const SORTABLE = ['created_at', 'is_read', 'notification_type'];

const SELECT = {
  notification_id: true,
  notification_type: true,
  title: true,
  message: true,
  is_read: true,
  read_at: true,
  created_at: true,
  borrowing_id: true,
  calibration_id: true,
  maintenance_id: true,
} satisfies Prisma.NotificationSelect;

/** Semua query selalu dibatasi user_id pemilik: user hanya melihat notifikasinya sendiri. */
export async function list(userId: string, q: ListNotificationsQuery) {
  const db = getDb();
  const where: Prisma.NotificationWhereInput = {
    user_id: userId,
    ...(q.is_read !== undefined ? { is_read: q.is_read } : {}),
    ...(q.type ? { notification_type: q.type } : {}),
    ...(q.search
      ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { message: { contains: q.search, mode: 'insensitive' } }] }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sort = resolveSort(q.sort, SORTABLE, 'created_at');
  const [items, total] = await Promise.all([
    db.notification.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: SELECT }),
    db.notification.count({ where }),
  ]);
  return { items, meta: buildMeta(page, limit, total) };
}

export async function unreadCount(userId: string) {
  const db = getDb();
  const [total, byType] = await Promise.all([
    db.notification.count({ where: { user_id: userId, is_read: false } }),
    db.notification.groupBy({ by: ['notification_type'], where: { user_id: userId, is_read: false }, _count: { _all: true } }),
  ]);
  const by_type: Record<string, number> = {};
  for (const r of byType) by_type[r.notification_type] = r._count._all;
  return { count: total, by_type };
}

export async function markRead(userId: string, id: string) {
  const db = getDb();
  // Filter user_id di WHERE: notifikasi milik user lain diperlakukan sebagai tidak ada (404).
  await db.notification.updateMany({ where: { notification_id: id, user_id: userId, is_read: false }, data: { is_read: true, read_at: new Date() } });
  const row = await db.notification.findFirst({ where: { notification_id: id, user_id: userId }, select: SELECT });
  if (!row) throw AppError.notFound('Notifikasi tidak ditemukan');
  return row;
}

export async function markAllRead(userId: string, type?: ListNotificationsQuery['type']) {
  const res = await getDb().notification.updateMany({
    where: { user_id: userId, is_read: false, ...(type ? { notification_type: type } : {}) },
    data: { is_read: true, read_at: new Date() },
  });
  return { updated: res.count };
}
