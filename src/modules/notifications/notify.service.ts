import type { NotificationType, Prisma, Role } from '@prisma/client';

type Tx = Pick<Prisma.TransactionClient, 'user' | 'notification'>;

export interface NotifyInput {
  type: NotificationType;
  title: string;
  message: string;
  borrowing_id?: string | null;
  calibration_id?: string | null;
  maintenance_id?: string | null;
  /** Kunci anti-duplikat (notifikasi otomatis). */
  dedupe_key?: string | null;
}

export interface CreateNotificationInput extends NotifyInput {
  /** Penerima langsung (hanya user aktif yang dikirimi). */
  userIds?: string[];
  /** Kirim ke semua user AKTIF dengan salah satu role ini. */
  roles?: Role[];
}

/**
 * Buat notifikasi untuk user tertentu dan/atau semua user aktif pada role tertentu
 * (penerima digabung tanpa duplikat). Ikut transaksi pemanggil jika `tx` berupa transaction client.
 * Mengembalikan jumlah penerima.
 */
export async function createNotification(tx: Tx, input: CreateNotificationInput): Promise<number> {
  const or: Prisma.UserWhereInput[] = [];
  if (input.roles?.length) or.push({ role: { in: input.roles } });
  if (input.userIds?.length) or.push({ user_id: { in: input.userIds } });
  if (!or.length) return 0;

  const users = await tx.user.findMany({ where: { is_active: true, OR: or }, select: { user_id: true } });
  if (!users.length) return 0;
  await tx.notification.createMany({
    data: users.map((u) => ({
      user_id: u.user_id,
      borrowing_id: input.borrowing_id ?? null,
      calibration_id: input.calibration_id ?? null,
      maintenance_id: input.maintenance_id ?? null,
      dedupe_key: input.dedupe_key ?? null,
      notification_type: input.type,
      title: input.title,
      message: input.message,
    })),
  });
  return users.length;
}

/** Kirim notifikasi ke semua user AKTIF dengan salah satu role. Ikut transaksi pemanggil. Mengembalikan jumlah penerima. */
export const notifyRoles = (tx: Tx, roles: Role[], input: NotifyInput): Promise<number> =>
  createNotification(tx, { ...input, roles });

/** Penerima notifikasi kerusakan. */
export const DAMAGE_RECIPIENT_ROLES: Role[] = ['SPV', 'technician'];
