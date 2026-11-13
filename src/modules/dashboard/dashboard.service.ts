import type { EquipmentStatus, Prisma } from '@prisma/client';
import { Prisma as P } from '@prisma/client';
import { env } from '../../config/env';
import { getDb } from '../../config/db';
import { cached } from '../../utils/ttl-cache';
import * as activityLogs from '../activity-logs/activity-logs.service';
import { addUtcDays, calibrationState, dateOnly, startOfUtcDay } from '../equipment/equipment.derive';

export const EQUIPMENT_STATUSES: EquipmentStatus[] = ['available', 'borrowed', 'damaged', 'maintenance', 'calibration'];
/** Batas hari alert kalibrasi (sesuai spesifikasi dashboard). */
export const CALIBRATION_ALERT_DAYS = 30;
/** Pembacaan sensor lebih lama dari ini dianggap basi dan tidak memicu alert. */
const SENSOR_STALE_HOURS = 24;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────── Helper waktu (UTC) ─────────────
export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** 12 bulan terakhir (termasuk bulan ini), urut lama → baru. */
export function last12Months(now: Date = new Date()): string[] {
  const start = addMonths(monthStart(now), -11);
  return Array.from({ length: 12 }, (_, i) => monthKey(addMonths(start, i)));
}

// ───────────── Query dasar ─────────────
async function equipmentByStatus(): Promise<Record<EquipmentStatus, number>> {
  const db = getDb();
  const counts = await Promise.all(EQUIPMENT_STATUSES.map((status) => db.equipment.count({ where: { is_active: true, status } })));
  return Object.fromEntries(EQUIPMENT_STATUSES.map((s, i) => [s, counts[i]])) as Record<EquipmentStatus, number>;
}

/** Biaya per bulan (YYYY-MM) dari maintenance selesai (completion_date) dan kalibrasi (calibration_date). */
async function costsByMonth(from: Date, to: Date) {
  const db = getDb();
  const [maint, cal] = await Promise.all([
    db.maintenance.findMany({
      where: { status: 'completed', completion_date: { gte: from, lt: to } },
      select: { cost: true, completion_date: true },
    }),
    db.calibration.findMany({
      where: { calibration_date: { gte: from, lt: to } },
      select: { cost: true, calibration_date: true },
    }),
  ]);
  const maintenance = new Map<string, number>();
  const calibration = new Map<string, number>();
  for (const m of maint) {
    if (m.completion_date) maintenance.set(monthKey(m.completion_date), (maintenance.get(monthKey(m.completion_date)) ?? 0) + num(m.cost));
  }
  for (const c of cal) calibration.set(monthKey(c.calibration_date), (calibration.get(monthKey(c.calibration_date)) ?? 0) + num(c.cost));
  return { maintenance, calibration };
}

export const lowStockWhere = (): Prisma.SupportingEquipmentWhereInput => ({
  is_active: true,
  total_quantity: { gt: 0 },
  available_quantity: { lte: env.LOW_STOCK_THRESHOLD },
});

// ───────────── GET /stats ─────────────
export async function getStats(now: Date = new Date()) {
  return cached('dashboard:stats', async () => {
    const db = getDb();
    const from = monthStart(now);
    const to = addMonths(from, 1);
    const [byStatus, activeBorrowings, overdueBorrowings, costs] = await Promise.all([
      equipmentByStatus(),
      db.borrowing.count({ where: { borrowing_status: 'borrowed' } }),
      db.borrowing.count({ where: { borrowing_status: 'borrowed', expected_return_time: { lt: now } } }),
      costsByMonth(from, to),
    ]);
    const key = monthKey(from);
    const maintenance_cost = round2(costs.maintenance.get(key) ?? 0);
    const calibration_cost = round2(costs.calibration.get(key) ?? 0);
    return {
      equipment: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        by_status: byStatus,
      },
      borrowings: { active: activeBorrowings, overdue: overdueBorrowings },
      costs_this_month: {
        month: key,
        maintenance: maintenance_cost,
        calibration: calibration_cost,
        total: round2(maintenance_cost + calibration_cost),
      },
      generated_at: now.toISOString(),
    };
  });
}

// ───────────── GET /charts ─────────────
export async function getCharts(now: Date = new Date()) {
  return cached('dashboard:charts', async () => {
    const db = getDb();
    const months = last12Months(now);
    const from = addMonths(monthStart(now), -11);
    const to = addMonths(monthStart(now), 1);
    const [byStatus, borrowings, costs] = await Promise.all([
      equipmentByStatus(),
      db.borrowing.findMany({ where: { borrowing_time: { gte: from, lt: to } }, select: { borrowing_time: true } }),
      costsByMonth(from, to),
    ]);
    const trend = new Map<string, number>(months.map((m) => [m, 0]));
    for (const b of borrowings) {
      const k = monthKey(b.borrowing_time);
      if (trend.has(k)) trend.set(k, (trend.get(k) ?? 0) + 1);
    }
    return {
      equipment_status_distribution: EQUIPMENT_STATUSES.map((status) => ({ status, count: byStatus[status] })),
      borrowing_trend: months.map((month) => ({ month, count: trend.get(month) ?? 0 })),
      cost_per_month: months.map((month) => {
        const maintenance = round2(costs.maintenance.get(month) ?? 0);
        const calibration = round2(costs.calibration.get(month) ?? 0);
        return { month, maintenance, calibration, total: round2(maintenance + calibration) };
      }),
    };
  });
}

// ───────────── GET /alerts ─────────────
interface SensorAlertRow {
  sensor_id: string;
  sensor_code: string;
  sensor_type: string;
  unit: string;
  room_id: string;
  room_name: string;
  min_threshold: unknown;
  max_threshold: unknown;
  value: unknown;
  measurement_time: Date;
}

/** Pembacaan TERBARU tiap sensor aktif yang di luar batas. Query terparameter (Prisma.sql), memakai index (sensor_id, measurement_time). */
async function sensorsOutOfRange(now: Date): Promise<SensorAlertRow[]> {
  const cutoff = new Date(now.getTime() - SENSOR_STALE_HOURS * 3_600_000);
  const rows = await getDb().$queryRaw<SensorAlertRow[]>(P.sql`
    SELECT s.sensor_id, s.sensor_code, s.sensor_type::text AS sensor_type, s.unit, s.room_id, r.room_name,
           s.min_threshold, s.max_threshold, m.value, m.measurement_time
    FROM sensors s
    JOIN rooms r ON r.room_id = s.room_id
    JOIN LATERAL (
      SELECT value, measurement_time FROM room_monitoring
      WHERE sensor_id = s.sensor_id
      ORDER BY measurement_time DESC LIMIT 1
    ) m ON true
    WHERE s.is_active = true AND s.sensor_status = 'active'
      AND m.measurement_time >= ${cutoff}
      AND (m.value < s.min_threshold OR m.value > s.max_threshold)
    ORDER BY m.measurement_time DESC`);
  return Array.isArray(rows) ? rows : [];
}

export async function getAlerts(limit = 20, now: Date = new Date()) {
  return cached(`dashboard:alerts:${limit}`, async () => {
    const db = getDb();
    const today = startOfUtcDay(now);
    const calWhere = { is_active: true, next_calibration_date: { lte: addUtcDays(today, CALIBRATION_ALERT_DAYS) } };
    const overdueWhere = { borrowing_status: 'borrowed' as const, expected_return_time: { lt: now } };

    const [calTotal, calRows, borTotal, borRows, sensorRows, stockTotal, stockRows] = await Promise.all([
      db.equipment.count({ where: calWhere }),
      db.equipment.findMany({
        where: calWhere,
        orderBy: { next_calibration_date: 'asc' },
        take: limit,
        select: { equipment_id: true, inventory_code: true, equipment_name: true, status: true, next_calibration_date: true },
      }),
      db.borrowing.count({ where: overdueWhere }),
      db.borrowing.findMany({
        where: overdueWhere,
        orderBy: { expected_return_time: 'asc' },
        take: limit,
        select: {
          borrowing_id: true,
          user_id: true,
          purpose: true,
          expected_return_time: true,
          user: { select: { name: true } },
        },
      }),
      sensorsOutOfRange(now),
      db.supportingEquipment.count({ where: lowStockWhere() }),
      db.supportingEquipment.findMany({
        where: lowStockWhere(),
        orderBy: { available_quantity: 'asc' },
        take: limit,
        select: { supporting_equipment_id: true, item_code: true, item_name: true, unit: true, total_quantity: true, available_quantity: true },
      }),
    ]);

    const calibration = calRows.map((e) => {
      const state = calibrationState(e.next_calibration_date, now);
      const next = e.next_calibration_date as Date;
      return {
        equipment_id: e.equipment_id,
        inventory_code: e.inventory_code,
        equipment_name: e.equipment_name,
        status: e.status,
        next_calibration_date: dateOnly(next),
        calibration_state: state === 'overdue' ? 'overdue' : 'due_soon',
        days_remaining: Math.round((next.getTime() - today.getTime()) / 86_400_000),
      };
    });

    return {
      calibration: {
        total: calTotal,
        overdue: calibration.filter((c) => c.calibration_state === 'overdue').length,
        threshold_days: CALIBRATION_ALERT_DAYS,
        items: calibration,
      },
      overdue_borrowings: {
        total: borTotal,
        items: borRows.map((b) => ({
          borrowing_id: b.borrowing_id,
          borrower: { user_id: b.user_id, name: b.user?.name ?? null },
          purpose: b.purpose,
          expected_return_time: b.expected_return_time.toISOString(),
          hours_overdue: Math.floor((now.getTime() - b.expected_return_time.getTime()) / 3_600_000),
        })),
      },
      sensors_out_of_range: {
        total: sensorRows.length,
        items: sensorRows.slice(0, limit).map((s) => {
          const value = num(s.value);
          return {
            sensor_id: s.sensor_id,
            sensor_code: s.sensor_code,
            sensor_type: s.sensor_type,
            room: { room_id: s.room_id, room_name: s.room_name },
            unit: s.unit,
            value,
            min_threshold: num(s.min_threshold),
            max_threshold: num(s.max_threshold),
            direction: value < num(s.min_threshold) ? 'below_min' : 'above_max',
            measurement_time: new Date(s.measurement_time).toISOString(),
          };
        }),
      },
      low_stock: {
        total: stockTotal,
        threshold: env.LOW_STOCK_THRESHOLD,
        items: stockRows,
      },
    };
  });
}

// ───────────── GET /recent-activity ─────────────
export async function getRecentActivity() {
  return cached('dashboard:recent-activity', async () => {
    const { items } = await activityLogs.list({ page: 1, limit: 10, order: 'desc', sort: 'created_at' } as Parameters<typeof activityLogs.list>[0]);
    return items;
  });
}
