import { Router } from 'express';
import { getDb } from '../../config/db';
import { PERMISSIONS } from '../../config/permissions';
import { h, send } from './compat.http';
import { compatAction, dateOnly, iso, num, readingStatus } from './compat.mappers';

/**
 * Padanan `lib/services/dashboard-service.ts` frontend: bentuk respons identik.
 * Dihitung langsung dari DB (bukan dari endpoint /dashboard API utama yang berbentuk lain).
 */
export const dashboardRouter = Router();

const DAY = 86_400_000;
const DUE_SOON_DAYS = 30;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const daysUntil = (d: Date, now: Date) => Math.round((utcDay(d) - utcDay(now)) / DAY);

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTH_FULL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/* 1. Jumlah alat aktif per status */
dashboardRouter.get('/equipment-status', h(async (_req, res) => {
  const rows = await getDb().equipment.groupBy({ by: ['status'], where: { is_active: true }, _count: { _all: true } });
  const counts = { total: 0, available: 0, borrowed: 0, damaged: 0, maintenance: 0, calibration: 0 };
  for (const r of rows) {
    counts[r.status] = r._count._all;
    counts.total += r._count._all;
  }
  send(res, counts);
}));

/* 2. Alat aktif yang kalibrasinya terlambat atau jatuh tempo <= 30 hari (paling mendesak di atas) */
dashboardRouter.get('/calibration-alerts', h(async (_req, res) => {
  const now = new Date();
  const eqs = await getDb().equipment.findMany({
    where: { is_active: true, next_calibration_date: { not: null } },
    include: { room: { select: { room_name: true } } },
  });
  const items = eqs
    .map((e) => ({ e, days: daysUntil(e.next_calibration_date as Date, now) }))
    .filter(({ days }) => days <= DUE_SOON_DAYS)
    .map(({ e, days }) => ({
      equipment_id: e.equipment_id, equipment_name: e.equipment_name, inventory_code: e.inventory_code,
      room_name: e.room?.room_name ?? '-', next_calibration_date: dateOnly(e.next_calibration_date), days_until: days,
      state: days < 0 ? ('overdue' as const) : ('due_soon' as const),
    }))
    .sort((a, b) => a.days_until - b.days_until);
  send(res, {
    items, overdue_count: items.filter((i) => i.state === 'overdue').length, due_soon_count: items.filter((i) => i.state === 'due_soon').length,
  });
}));

/* 3. Peminjaman aktif; yang terlambat di atas, lalu batas kembali terdekat */
dashboardRouter.get('/active-borrowings', h(async (_req, res) => {
  const now = new Date();
  const rows = await getDb().borrowing.findMany({
    where: { borrowing_status: 'borrowed' },
    include: {
      user: { select: { name: true } },
      details: { include: { equipment: { select: { equipment_name: true } } } },
      supporting_details: { select: { supporting_detail_id: true } },
    },
  });
  const items = rows
    .map((b) => ({
      borrowing_id: b.borrowing_id, user_id: b.user_id, user_name: b.user?.name ?? 'Pengguna',
      equipment_names: b.details.map((d) => d.equipment?.equipment_name ?? d.equipment_id),
      supporting_count: b.supporting_details.length, purpose: b.purpose, usage_location: b.usage_location ?? '',
      expected_return_time: iso(b.expected_return_time), is_overdue: b.expected_return_time < now,
    }))
    .sort((a, b) => Number(b.is_overdue) - Number(a.is_overdue) || a.expected_return_time.localeCompare(b.expected_return_time));
  send(res, { items, active_count: items.length, overdue_count: items.filter((i) => i.is_overdue).length });
}));

/* 4. Tren bulanan: peminjaman, biaya kalibrasi, biaya maintenance (selesai/berjalan) */
dashboardRouter.get('/monthly-trends', h(async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const points = new Map<string, { month: string; label: string; full_label: string; borrowings: number; calibration_cost: number; maintenance_cost: number }>();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
    points.set(monthKey(d), {
      month: monthKey(d), label: MONTH_SHORT[d.getUTCMonth()], full_label: `${MONTH_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      borrowings: 0, calibration_cost: 0, maintenance_cost: 0,
    });
  }
  const db = getDb();
  const [bs, cs, ms] = await Promise.all([
    db.borrowing.findMany({ where: { borrowing_time: { gte: first } }, select: { borrowing_time: true } }),
    db.calibration.findMany({ where: { calibration_date: { gte: first } }, select: { calibration_date: true, cost: true } }),
    db.maintenance.findMany({ where: { maintenance_date: { gte: first }, status: { in: ['completed', 'in_progress'] } }, select: { maintenance_date: true, cost: true } }),
  ]);
  for (const b of bs) { const p = points.get(monthKey(b.borrowing_time)); if (p) p.borrowings++; }
  for (const c of cs) { const p = points.get(monthKey(c.calibration_date)); if (p) p.calibration_cost += num(c.cost); }
  for (const m of ms) { const p = points.get(monthKey(m.maintenance_date)); if (p) p.maintenance_cost += num(m.cost); }
  send(res, [...points.values()]);
}));

/* 5. Pembacaan terakhir suhu & kelembapan per ruangan; yang di luar batas lebih dulu */
dashboardRouter.get('/room-conditions', h(async (_req, res) => {
  const db = getDb();
  const [rooms, sensors] = await Promise.all([
    db.room.findMany({ where: { is_active: true } }),
    db.sensor.findMany({ where: { is_active: true }, include: { monitorings: { orderBy: { measurement_time: 'desc' }, take: 1 } } }),
  ]);
  const pick = (roomId: string, type: 'temperature' | 'humidity') => {
    const candidates = sensors.filter((s) => s.room_id === roomId && s.sensor_type === type);
    const sensor = candidates.find((s) => s.sensor_status === 'active') ?? candidates[0];
    if (!sensor) return null;
    const last = sensor.monitorings[0];
    const min = num(sensor.min_threshold), max = num(sensor.max_threshold);
    return {
      sensor_id: sensor.sensor_id, sensor_code: sensor.sensor_code, sensor_type: type, unit: sensor.unit,
      value: last ? num(last.value) : null, measured_at: last ? iso(last.measurement_time) : null, min, max,
      sensor_status: sensor.sensor_status,
      status: sensor.sensor_status === 'active' && last ? readingStatus(num(last.value), min, max) : null,
    };
  };
  const out = rooms
    .map((room) => {
      const temperature = pick(room.room_id, 'temperature');
      const humidity = pick(room.room_id, 'humidity');
      const outOfRange = [temperature, humidity].some((r) => r?.status === 'low' || r?.status === 'high');
      return { room_id: room.room_id, room_code: room.room_code, room_name: room.room_name, temperature, humidity, out_of_range: outOfRange };
    })
    .sort((a, b) => Number(b.out_of_range) - Number(a.out_of_range) || a.room_code.localeCompare(b.room_code));
  send(res, out);
}));

/* 6. Aktivitas terbaru. Role tanpa hak baca activity log menerima daftar kosong (tidak 403) agar panel dashboard tetap tampil. */
dashboardRouter.get('/recent-activity', h(async (req, res) => {
  if (!PERMISSIONS.dashboard.recentActivity.includes(req.user!.role)) return send(res, []);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const db = getDb();
  const logs = await db.activityLog.findMany({ orderBy: { created_at: 'desc' }, take: limit, include: { user: { select: { name: true } } } });

  const ids = (type: string) => [...new Set(logs.filter((l) => l.entity_type === type && l.entity_id).map((l) => l.entity_id as string))];
  const uuid = /^[0-9a-f-]{36}$/i;
  const ok = (a: string[]) => a.filter((x) => uuid.test(x));
  const [eq, sp, us, rm, se, br, ca, ma, dc] = await Promise.all([
    db.equipment.findMany({ where: { equipment_id: { in: ok(ids('equipment')) } }, select: { equipment_id: true, equipment_name: true } }),
    db.supportingEquipment.findMany({ where: { supporting_equipment_id: { in: ok(ids('supporting_equipment')) } }, select: { supporting_equipment_id: true, item_name: true } }),
    db.user.findMany({ where: { user_id: { in: ok(ids('user')) } }, select: { user_id: true, name: true } }),
    db.room.findMany({ where: { room_id: { in: ok(ids('room')) } }, select: { room_id: true, room_name: true } }),
    db.sensor.findMany({ where: { sensor_id: { in: ok(ids('sensor')) } }, select: { sensor_id: true, sensor_code: true } }),
    db.borrowing.findMany({ where: { borrowing_id: { in: ok(ids('borrowing')) } }, select: { borrowing_id: true, purpose: true } }),
    db.calibration.findMany({ where: { calibration_id: { in: ok(ids('calibration')) } }, select: { calibration_id: true, equipment: { select: { equipment_name: true } } } }),
    db.maintenance.findMany({ where: { maintenance_id: { in: ok(ids('maintenance')) } }, select: { maintenance_id: true, equipment: { select: { equipment_name: true } } } }),
    db.document.findMany({ where: { document_id: { in: ok(ids('document')) } }, select: { document_id: true, file_name: true } }),
  ]);
  const labels = new Map<string, string>();
  const put = (type: string, id: string, label: string | undefined) => label && labels.set(`${type}:${id}`, label);
  eq.forEach((r) => put('equipment', r.equipment_id, r.equipment_name));
  sp.forEach((r) => put('supporting_equipment', r.supporting_equipment_id, r.item_name));
  us.forEach((r) => put('user', r.user_id, r.name));
  rm.forEach((r) => put('room', r.room_id, r.room_name));
  se.forEach((r) => put('sensor', r.sensor_id, r.sensor_code));
  br.forEach((r) => put('borrowing', r.borrowing_id, r.purpose.length > 48 ? `${r.purpose.slice(0, 47)}…` : r.purpose));
  ca.forEach((r) => put('calibration', r.calibration_id, r.equipment?.equipment_name));
  ma.forEach((r) => put('maintenance', r.maintenance_id, r.equipment?.equipment_name));
  dc.forEach((r) => put('document', r.document_id, r.file_name));

  // `action` memakai kosakata frontend (sama dengan GET /activity-logs).
  send(res, logs.map((l) => {
    const action = compatAction(l.action, l.entity_type, l.old_data, l.new_data);
    return {
      log_id: l.log_id, user_name: l.user?.name ?? 'Pengguna', action, entity_type: l.entity_type,
      target_label: action === 'login' || !l.entity_id ? '' : (labels.get(`${l.entity_type}:${l.entity_id}`) ?? l.entity_id),
      created_at: iso(l.created_at),
    };
  }));
}));

