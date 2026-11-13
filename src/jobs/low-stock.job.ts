import { getDb } from '../config/db';
import { lowStockWhere } from '../modules/dashboard/dashboard.service';
import { createNotification } from '../modules/notifications/notify.service';
import { localDayKey } from './runner';

/** Harian: notifikasi stok rendah (admin + SPV). Satu notifikasi per item per hari. */
export async function runLowStockReminders(now: Date = new Date()) {
  const db = getDb();
  const day = localDayKey(now);
  const items = await db.supportingEquipment.findMany({
    where: lowStockWhere(),
    select: { supporting_equipment_id: true, item_code: true, item_name: true, unit: true, available_quantity: true, total_quantity: true },
  });
  let created = 0;
  for (const it of items) {
    const key = `lowstock:${it.supporting_equipment_id}:${day}`;
    if (await db.notification.findFirst({ where: { dedupe_key: key }, select: { notification_id: true } })) continue;
    const n = await db.$transaction((tx) =>
      createNotification(tx, {
        roles: ['admin', 'SPV'],
        type: 'system',
        title: 'Stok rendah',
        message: `Stok ${it.item_code} — ${it.item_name} tinggal ${it.available_quantity} dari ${it.total_quantity} ${it.unit}.`,
        dedupe_key: key,
      }),
    );
    if (n > 0) created++;
  }
  return { low_stock_items: items.length, notified: created };
}
