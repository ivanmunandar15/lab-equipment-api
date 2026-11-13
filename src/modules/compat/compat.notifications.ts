import { Router } from 'express';
import type { NotificationType, Role } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { authorize } from '../../middlewares/rbac';
import { AppError } from '../../utils/errors';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import { calibrationState } from '../equipment/equipment.derive';
import { createNotification } from '../notifications/notify.service';
import { log } from './compat.audit';
import { LIST_CAP, flag, h, idParam, isUuid, parse, send, str } from './compat.http';
import { toNotification } from './compat.mappers';
import { createNotificationSchema, generateNotificationsSchema, reportIssueSchema } from './compat.schemas';

const DAY = 86_400_000;
const NTYPES = ['borrowing', 'calibration', 'maintenance', 'monitoring', 'system'];

/** Notifikasi selalu milik pengguna yang login; `user_id` pada query hanya boleh diri sendiri. */
function ownerOf(req: { user?: { user_id: string }; query: Record<string, unknown> }): string {
  const me = req.user!.user_id;
  const asked = str(req.query.user_id);
  if (asked && asked !== me) throw AppError.forbidden('Notifikasi hanya dapat dilihat oleh pemiliknya');
  return me;
}

async function findOwn(userId: string, id: string) {
  const row = await getDb().notification.findFirst({ where: { notification_id: id, user_id: userId } });
  if (!row) throw AppError.notFound(`Notifikasi dengan ID "${id}" tidak ditemukan`);
  return row;
}

export const notificationsRouter = Router();

notificationsRouter.get('/', h(async (req, res) => {
  const me = ownerOf(req);
  const type = str(req.query.type);
  const rows = await getDb().notification.findMany({
    where: { user_id: me, ...(type && NTYPES.includes(type) ? { notification_type: type as NotificationType } : {}), ...(flag(req.query.unreadOnly) ? { is_read: false } : {}) },
    orderBy: { created_at: 'desc' },
    take: LIST_CAP,
  });
  send(res, rows.map(toNotification));
}));

/** Jumlah belum dibaca: angka mentah. */
notificationsRouter.get('/unread-count', h(async (req, res) => {
  send(res, await getDb().notification.count({ where: { user_id: ownerOf(req), is_read: false } }));
}));

/** Tandai semua dibaca; respons = jumlah yang diubah. */
notificationsRouter.post('/read-all', h(async (req, res) => {
  const r = await getDb().notification.updateMany({ where: { user_id: req.user!.user_id, is_read: false }, data: { is_read: true, read_at: new Date() } });
  send(res, r.count);
}));

/** Generator notifikasi dari kondisi data saat ini (padanan `notificationGenerator.run`). Tidak membuat duplikat pada hari yang sama. */
notificationsRouter.post('/generate', authorize('admin', 'SPV'), h(async (req, res) => {
  const { kinds } = parse(generateNotificationsSchema, req.body);
  const created = await generate(new Set(kinds));
  if (created > 0) await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: 'notification', entityId: 'generator', newData: { kinds, created } });
  send(res, created);
}));

/** Hanya admin (padanan hak `create` notification di frontend). */
notificationsRouter.post('/', authorize('admin'), h(async (req, res) => {
  const d = parse(createNotificationSchema, req.body);
  if (!isUuid(d.user_id)) throw AppError.notFound(`Pengguna dengan ID "${d.user_id}" tidak ditemukan`);
  const user = await getDb().user.findUnique({ where: { user_id: d.user_id }, select: { user_id: true } });
  if (!user) throw AppError.notFound(`Pengguna dengan ID "${d.user_id}" tidak ditemukan`);
  const row = await getDb().notification.create({
    data: {
      user_id: d.user_id, borrowing_id: d.borrowing_id, calibration_id: d.calibration_id, maintenance_id: d.maintenance_id,
      notification_type: d.notification_type, title: d.title, message: d.message,
    },
  });
  send(res, toNotification(row), 201);
}));

notificationsRouter.get('/:id', h(async (req, res) => send(res, toNotification(await findOwn(req.user!.user_id, idParam(req, 'id', 'Notifikasi'))))));

notificationsRouter.post('/:id/read', h(async (req, res) => {
  const me = req.user!.user_id;
  const id = idParam(req, 'id', 'Notifikasi');
  await findOwn(me, id);
  await getDb().notification.updateMany({ where: { notification_id: id, user_id: me, is_read: false }, data: { is_read: true, read_at: new Date() } });
  send(res, toNotification(await findOwn(me, id)));
}));

/* ---------------- Generator ---------------- */

interface Draft {
  key: string; type: NotificationType; title: string; message: string; roles: Role[]; userIds?: string[];
  calibration_id?: string; borrowing_id?: string;
}

const dayDiff = (d: Date, now: Date) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);

async function buildDrafts(kinds: Set<string>, now: Date): Promise<Draft[]> {
  const db = getDb();
  const drafts: Draft[] = [];
  const today = now.toISOString().slice(0, 10);

  if (kinds.has('calibration')) {
    const eqs = await db.equipment.findMany({ where: { is_active: true, next_calibration_date: { not: null } } });
    for (const e of eqs) {
      const state = calibrationState(e.next_calibration_date, now, env.CALIBRATION_DUE_SOON_DAYS);
      if (!state || state === 'safe') continue;
      const days = dayDiff(e.next_calibration_date!, now);
      const latest = await db.calibration.findFirst({ where: { equipment_id: e.equipment_id }, orderBy: { calibration_date: 'desc' }, select: { calibration_id: true } });
      drafts.push({
        key: `gen:calibration:${e.equipment_id}:${today}`, type: 'calibration', roles: ['admin', 'SPV', 'technician'], calibration_id: latest?.calibration_id,
        title: days < 0 ? `Kalibrasi terlambat: ${e.equipment_name}` : `Kalibrasi H-${days}: ${e.equipment_name}`,
        message: days < 0
          ? `${e.equipment_name} (${e.inventory_code}) terlambat dikalibrasi ${Math.abs(days)} hari.`
          : `${e.equipment_name} (${e.inventory_code}) jatuh tempo kalibrasi ${days === 0 ? 'hari ini' : `${days} hari lagi`}.`,
      });
    }
  }
  if (kinds.has('overdue')) {
    const rows = await db.borrowing.findMany({ where: { borrowing_status: 'borrowed', expected_return_time: { lt: now } }, include: { user: { select: { name: true } } } });
    for (const b of rows) {
      drafts.push({
        key: `gen:overdue:${b.borrowing_id}:${today}`, type: 'borrowing', roles: ['admin', 'SPV'], userIds: [b.user_id], borrowing_id: b.borrowing_id,
        title: 'Peminjaman terlambat', message: `Peminjaman oleh ${b.user?.name ?? 'Peminjam'} (${b.purpose}) melewati batas kembali.`,
      });
    }
  }
  if (kinds.has('temperature')) {
    const sensors = await db.sensor.findMany({
      where: { is_active: true, sensor_status: 'active' },
      include: { room: { select: { room_name: true } }, monitorings: { orderBy: { measurement_time: 'desc' }, take: 1 } },
    });
    for (const s of sensors) {
      const last = s.monitorings[0];
      if (!last) continue;
      const v = Number(last.value), min = Number(s.min_threshold), max = Number(s.max_threshold);
      if (v >= min && v <= max) continue;
      const label = s.sensor_type === 'temperature' ? 'Suhu' : 'Kelembapan';
      drafts.push({
        key: `gen:temperature:${s.sensor_id}:${today}`, type: 'monitoring', roles: ['admin', 'SPV', 'technician'],
        title: `${label} ${v > max ? 'di atas' : 'di bawah'} batas: ${s.room?.room_name ?? s.sensor_code}`,
        message: `${s.sensor_code} membaca ${v} ${s.unit} (batas ${min}–${max} ${s.unit}).`,
      });
    }
  }
  if (kinds.has('damaged')) {
    const eqs = await db.equipment.findMany({ where: { is_active: true, OR: [{ status: 'damaged' }, { condition: 'major_damage' }] } });
    for (const e of eqs) {
      drafts.push({
        key: `gen:damaged:${e.equipment_id}:${today}`, type: 'system', roles: ['admin', 'SPV', 'technician'],
        title: `Alat dilaporkan rusak: ${e.equipment_name}`,
        message: `${e.equipment_name} (${e.inventory_code}) berstatus ${e.status === 'damaged' ? 'rusak' : 'rusak berat'} dan perlu ditangani.`,
      });
    }
  }
  return drafts;
}

/** Mengembalikan jumlah baris notifikasi baru (per penerima). Satu `dedupe_key` per entitas per hari. */
async function generate(kinds: Set<string>): Promise<number> {
  const db = getDb();
  let created = 0;
  for (const d of await buildDrafts(kinds, new Date())) {
    const dup = await db.notification.findFirst({ where: { dedupe_key: d.key }, select: { notification_id: true } });
    if (dup) continue;
    created += await createNotification(db, {
      type: d.type, title: d.title, message: d.message, roles: d.roles, userIds: d.userIds,
      calibration_id: d.calibration_id, borrowing_id: d.borrowing_id, dedupe_key: d.key,
    });
  }
  return created;
}

/* ---------------- Laporan masalah alat ---------------- */

export const reportsRouter = Router();

/**
 * Lapor kerusakan / minta bantuan teknisi: hanya notifikasi ke technician & SPV (selain pelapor), status alat TIDAK berubah
 * (sama dengan mock). Untuk menandai alat rusak gunakan `POST /api/v1/equipment/:id/report-damage` pada API utama.
 */
reportsRouter.post('/equipment-issue', h(async (req, res) => {
  const d = parse(reportIssueSchema, req.body);
  if (!isUuid(d.equipment_id)) throw AppError.notFound(`Alat dengan ID "${d.equipment_id}" tidak ditemukan`);
  const db = getDb();
  const eq = await db.equipment.findUnique({ where: { equipment_id: d.equipment_id }, select: { equipment_id: true, equipment_name: true, inventory_code: true } });
  if (!eq) throw AppError.notFound(`Alat dengan ID "${d.equipment_id}" tidak ditemukan`);
  const me = req.user!;
  const candidates = await db.user.findMany({ where: { is_active: true, role: { in: ['technician', 'SPV'] } }, select: { user_id: true } });
  const recipients = candidates.filter((u) => u.user_id !== me.user_id);
  let notified = 0;
  if (recipients.length) {
    notified = await createNotification(db, {
      type: 'maintenance', userIds: recipients.map((r) => r.user_id),
      title: `Laporan masalah: ${eq.equipment_name}`,
      message: `${me.name} melaporkan masalah pada ${eq.equipment_name} (${eq.inventory_code}): ${d.description}`,
    });
  }
  await log(req, { action: 'REPORT', entityType: AUDIT_ENTITIES.EQUIPMENT, entityId: eq.equipment_id, newData: { description: d.description, notified } });
  send(res, { notified });
}));

