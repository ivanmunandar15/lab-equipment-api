import { getDb } from '../config/db';
import { createNotification } from '../modules/notifications/notify.service';
import { localDayKey } from './runner';

/**
 * Setiap jam: notifikasi peminjaman terlambat ke peminjam dan SPV.
 * Maksimal sekali per hari per peminjaman (dedupe_key memuat tanggal lokal JOBS_TIMEZONE).
 */
export async function runBorrowingOverdueReminders(now: Date = new Date()) {
  const db = getDb();
  const day = localDayKey(now);
  const rows = await db.borrowing.findMany({
    where: { borrowing_status: 'borrowed', expected_return_time: { lt: now } },
    select: { borrowing_id: true, user_id: true, expected_return_time: true, purpose: true },
  });

  let created = 0;
  let skipped = 0;
  for (const b of rows) {
    const key = `bor-overdue:${b.borrowing_id}:${day}`;
    if (await db.notification.findFirst({ where: { dedupe_key: key }, select: { notification_id: true } })) {
      skipped++;
      continue;
    }
    const hours = Math.max(1, Math.floor((now.getTime() - b.expected_return_time.getTime()) / 3_600_000));
    const borrower = await db.user.findUnique({ where: { user_id: b.user_id }, select: { name: true } });
    const late = hours >= 48 ? `${Math.floor(hours / 24)} hari` : `${hours} jam`;
    const sent = await db.$transaction(async (tx) => {
      const base = { type: 'borrowing' as const, borrowing_id: b.borrowing_id, dedupe_key: key };
      const a = await createNotification(tx, {
        ...base,
        userIds: [b.user_id],
        title: 'Peminjaman terlambat',
        message: `Peminjaman Anda ("${b.purpose}") terlambat ${late}. Segera kembalikan alat.`,
      });
      // SPV selain peminjam sendiri (peminjam sudah menerima notifikasi pribadi di atas)
      const spvs = (await tx.user.findMany({ where: { is_active: true, role: 'SPV' }, select: { user_id: true } })).filter((u) => u.user_id !== b.user_id);
      const s = spvs.length
        ? await createNotification(tx, {
            ...base,
            userIds: spvs.map((u) => u.user_id),
            title: 'Peminjaman terlambat',
            message: `Peminjaman oleh ${borrower?.name ?? 'pengguna'} ("${b.purpose}") terlambat ${late}.`,
          })
        : 0;
      return a + s;
    });
    if (sent > 0) created++;
  }
  return { overdue: rows.length, notified: created, skipped };
}
