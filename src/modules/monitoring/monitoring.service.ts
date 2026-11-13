import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { getDb } from '../../config/db';
import { logger } from '../../config/logger';
import type { DeviceSensor } from '../../types/device-sensor';
import { AppError } from '../../utils/errors';
import { createNotification } from '../notifications/notify.service';
import { PERMISSIONS } from '../../config/permissions';
import {
  alertTitle,
  BUCKET_SECONDS,
  bucketCount,
  isOutOfRange,
  isStale,
  MAX_AGG_POINTS,
  MAX_FUTURE_SKEW_MS,
  MAX_RANGE_DAYS,
  MAX_RAW_POINTS,
  round2,
  suggestInterval,
  thresholdState,
} from './monitoring.logic';
import { publishReading } from './monitoring.events';
import type { IngestItem, ReadingsQuery } from './monitoring.schema';

const DAY = 86_400_000;
/** Fast-path anti-spam dalam satu proses; sumber kebenaran tetap tabel notifikasi (tahan restart/multi-instance). */
const lastAlertAt = new Map<string, number>();

// ───────────── Ingest (perangkat IoT) ─────────────
export async function ingest(sensor: DeviceSensor, items: IngestItem[]) {
  if (sensor.sensor_status !== 'active') {
    throw AppError.conflict('Sensor tidak berstatus active', { code: 'SENSOR_NOT_ACTIVE', sensor_status: sensor.sensor_status });
  }

  const now = new Date();
  const oldest = now.getTime() - env.MONITORING_RETENTION_DAYS * DAY;
  const problems: Array<{ path: string; message: string }> = [];
  const foreign: number[] = [];

  const rows = items.map((it, i) => {
    if (it.sensor_code !== undefined && it.sensor_code !== sensor.sensor_code) foreign.push(i);
    const t = it.measurement_time ?? now;
    if (t.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) problems.push({ path: `readings.${i}.measurement_time`, message: 'Waktu pengukuran di masa depan' });
    if (t.getTime() < oldest) problems.push({ path: `readings.${i}.measurement_time`, message: `Lebih lama dari retensi ${env.MONITORING_RETENTION_DAYS} hari` });
    return { sensor_id: sensor.sensor_id, value: round2(it.value), measurement_time: t, received_at: now };
  });

  // Key hanya sah untuk sensornya sendiri; batch campuran ditolak seluruhnya (tidak ada yang disimpan).
  if (foreign.length) {
    throw AppError.forbidden('X-Sensor-Key tidak berwenang untuk sensor_code pada pembacaan tersebut', {
      indexes: foreign.slice(0, 20),
      expected_sensor_code: sensor.sensor_code,
    });
  }
  if (problems.length) throw AppError.unprocessable('Validasi gagal', problems.slice(0, 50));

  await getDb().roomMonitoring.createMany({ data: rows }); // satu statement = atomik

  const outs = rows.filter((r) => isOutOfRange(r.value, sensor.min_threshold, sensor.max_threshold));
  let alertSent = false;
  if (outs.length) {
    const worst = outs.reduce((a, b) => (b.measurement_time > a.measurement_time ? b : a));
    try {
      alertSent = await maybeAlert(sensor, worst.value, worst.measurement_time, now);
    } catch (err) {
      // Kegagalan notifikasi tidak boleh membuat data sensor hilang/ditolak.
      logger.error({ err, sensor: sensor.sensor_code }, 'gagal membuat notifikasi monitoring');
    }
  }

  // Realtime (SSE): kirim pembacaan terbaru dari batch ini.
  const latest = rows.reduce((a, b) => (b.measurement_time > a.measurement_time ? b : a));
  const state = thresholdState(latest.value, sensor.min_threshold, sensor.max_threshold);
  publishReading({
    sensor_id: sensor.sensor_id,
    sensor_code: sensor.sensor_code,
    room_id: sensor.room_id,
    sensor_type: sensor.sensor_type,
    unit: sensor.unit,
    value: latest.value,
    measurement_time: latest.measurement_time.toISOString(),
    received_at: now.toISOString(),
    threshold_state: state,
    out_of_range: state !== 'normal',
  });

  return {
    sensor_code: sensor.sensor_code,
    accepted: rows.length,
    out_of_range: outs.length,
    alert_sent: alertSent,
    received_at: now.toISOString(),
  };
}

async function maybeAlert(sensor: DeviceSensor, value: number, at: Date, now: Date): Promise<boolean> {
  const cooldownMs = env.MONITORING_ALERT_COOLDOWN_MINUTES * 60_000;
  const prev = lastAlertAt.get(sensor.sensor_id);
  if (prev !== undefined && now.getTime() - prev < cooldownMs) return false;
  // Tandai dulu (sebelum await) agar request paralel pada proses yang sama tidak ikut mengirim.
  lastAlertAt.set(sensor.sensor_id, now.getTime());

  const db = getDb();
  const title = alertTitle(sensor.sensor_code);
  const recent = await db.notification.findFirst({
    where: { notification_type: 'monitoring', title, created_at: { gte: new Date(now.getTime() - cooldownMs) } },
    select: { notification_id: true },
  });
  if (recent) return false;

  const state = thresholdState(value, sensor.min_threshold, sensor.max_threshold);
  const dir = state === 'below_min' ? `di bawah batas minimum (${sensor.min_threshold})` : `di atas batas maksimum (${sensor.max_threshold})`;
  const n = await createNotification(db, {
    type: 'monitoring',
    title,
    message: `Ruangan ${sensor.room.room_name} (${sensor.room.room_code}): sensor ${sensor.sensor_code} mencatat ${value} ${sensor.unit}, ${dir}, pada ${at.toISOString()}.`,
    roles: PERMISSIONS.monitoring.alertRecipients,
    userIds: sensor.room.person_in_charge ? [sensor.room.person_in_charge] : [],
  });
  if (n === 0) lastAlertAt.delete(sensor.sensor_id);
  return n > 0;
}

/** Hanya untuk test. */
export const __resetAlertCache = () => lastAlertAt.clear();

// ───────────── Deret waktu ─────────────
export async function sensorReadings(sensorId: string, q: ReadingsQuery) {
  const db = getDb();
  const sensor = await db.sensor.findUnique({
    where: { sensor_id: sensorId },
    select: { sensor_id: true, sensor_code: true, sensor_type: true, unit: true, min_threshold: true, max_threshold: true, room_id: true },
  });
  if (!sensor) throw AppError.notFound('Sensor tidak ditemukan');

  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - DAY);
  if (from >= to) throw AppError.unprocessable('Validasi gagal', [{ path: 'from', message: 'from harus sebelum to' }]);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'from', message: `Rentang maksimal ${MAX_RANGE_DAYS} hari` }]);
  }

  const head = {
    sensor: {
      sensor_id: sensor.sensor_id,
      sensor_code: sensor.sensor_code,
      sensor_type: sensor.sensor_type,
      unit: sensor.unit,
      min_threshold: Number(sensor.min_threshold),
      max_threshold: Number(sensor.max_threshold),
    },
    from: from.toISOString(),
    to: to.toISOString(),
    interval: q.interval,
  };

  if (q.interval === 'raw') {
    // Ambil yang terbaru lebih dulu agar grafik "sekarang" tetap lengkap bila terpotong.
    const rows = await db.roomMonitoring.findMany({
      where: { sensor_id: sensorId, measurement_time: { gte: from, lte: to } },
      orderBy: { measurement_time: 'desc' },
      take: MAX_RAW_POINTS + 1,
      select: { value: true, measurement_time: true },
    });
    const truncated = rows.length > MAX_RAW_POINTS;
    const points = rows
      .slice(0, MAX_RAW_POINTS)
      .reverse()
      .map((r) => ({ time: r.measurement_time.toISOString(), value: Number(r.value) }));
    return { ...head, points, truncated, max_points: MAX_RAW_POINTS };
  }

  const interval = q.interval;
  if (bucketCount(from, to, interval) > MAX_AGG_POINTS) {
    throw AppError.unprocessable('Terlalu banyak titik data untuk interval ini', {
      max_points: MAX_AGG_POINTS,
      suggested_interval: suggestInterval(from, to),
    });
  }
  const step = BUCKET_SECONDS[interval];
  // Parameter waktu dikirim sebagai string ISO lalu di-cast ke timestamp (kolom Prisma = timestamp tanpa zona, UTC).
  const rows = await db.$queryRaw<Array<{ bucket: Date; avg: number; min: number; max: number; count: number }>>(Prisma.sql`
    SELECT
      (timestamp 'epoch' + floor(extract(epoch FROM measurement_time) / ${step}::int) * ${step}::int * interval '1 second') AS bucket,
      avg(value)::float8 AS avg,
      min(value)::float8 AS min,
      max(value)::float8 AS max,
      count(*)::int AS count
    FROM room_monitoring
    WHERE sensor_id = ${sensorId}::uuid
      AND measurement_time >= ${from.toISOString()}::timestamp
      AND measurement_time <= ${to.toISOString()}::timestamp
    GROUP BY 1
    ORDER BY 1 ASC`);
  const points = rows.map((r) => ({
    time: r.bucket.toISOString(),
    avg: round2(Number(r.avg)),
    min: Number(r.min),
    max: Number(r.max),
    count: Number(r.count),
  }));
  return { ...head, points, truncated: false, max_points: MAX_AGG_POINTS };
}

// ───────────── Terbaru per ruangan & ringkasan ─────────────
const LATEST_SENSOR_SELECT = {
  sensor_id: true,
  sensor_code: true,
  sensor_type: true,
  unit: true,
  sensor_location: true,
  sensor_status: true,
  min_threshold: true,
  max_threshold: true,
  room_id: true,
  monitorings: { orderBy: { measurement_time: 'desc' }, take: 1, select: { value: true, measurement_time: true, received_at: true } },
} satisfies Prisma.SensorSelect;

type LatestRow = Prisma.SensorGetPayload<{ select: typeof LATEST_SENSOR_SELECT }>;

function presentLatest(s: LatestRow, now: Date) {
  const last = s.monitorings[0];
  const min = Number(s.min_threshold);
  const max = Number(s.max_threshold);
  const value = last ? Number(last.value) : null;
  const state = value === null ? null : thresholdState(value, min, max);
  return {
    sensor_id: s.sensor_id,
    sensor_code: s.sensor_code,
    sensor_type: s.sensor_type,
    unit: s.unit,
    sensor_location: s.sensor_location,
    sensor_status: s.sensor_status,
    min_threshold: min,
    max_threshold: max,
    value,
    measurement_time: last?.measurement_time ?? null,
    received_at: last?.received_at ?? null,
    threshold_state: state,
    out_of_range: state !== null && state !== 'normal',
    is_stale: isStale(last?.measurement_time ?? null, now),
  };
}

export async function roomLatest(roomId: string) {
  const db = getDb();
  const room = await db.room.findUnique({ where: { room_id: roomId }, select: { room_id: true, room_code: true, room_name: true, is_active: true } });
  if (!room) throw AppError.notFound('Ruangan tidak ditemukan');
  const now = new Date();
  const sensors = await db.sensor.findMany({
    where: { room_id: roomId, is_active: true },
    orderBy: { sensor_code: 'asc' },
    select: LATEST_SENSOR_SELECT,
  });
  const items = sensors.map((s) => presentLatest(s, now));
  return { room, sensors: items, has_out_of_range: items.some((i) => i.out_of_range), server_time: now.toISOString() };
}

export async function summary() {
  const db = getDb();
  const now = new Date();
  const sensors = await db.sensor.findMany({
    where: { is_active: true },
    select: { ...LATEST_SENSOR_SELECT, room: { select: { room_code: true, room_name: true } } },
  });
  const by_status = { active: 0, inactive: 0, damaged: 0 };
  const rooms = new Map<string, { room_id: string; room_code: string; room_name: string; sensor_count: number; out_of_range_count: number }>();
  let out_of_range = 0;
  let stale = 0;
  let no_data = 0;
  const alerts: Array<ReturnType<typeof presentLatest> & { room_code: string; room_name: string }> = [];

  for (const s of sensors) {
    by_status[s.sensor_status] += 1;
    const p = presentLatest(s, now);
    const r = rooms.get(s.room_id) ?? { room_id: s.room_id, room_code: s.room.room_code, room_name: s.room.room_name, sensor_count: 0, out_of_range_count: 0 };
    r.sensor_count += 1;
    rooms.set(s.room_id, r);
    if (s.sensor_status !== 'active') continue; // hanya sensor aktif yang dinilai
    if (p.value === null) no_data += 1;
    else if (p.is_stale) stale += 1;
    if (p.out_of_range) {
      out_of_range += 1;
      r.out_of_range_count += 1;
      alerts.push({ ...p, room_code: s.room.room_code, room_name: s.room.room_name });
    }
  }

  return {
    sensors_total: sensors.length,
    by_status,
    out_of_range,
    stale,
    no_data,
    rooms_with_sensors: rooms.size,
    rooms: [...rooms.values()].sort((a, b) => b.out_of_range_count - a.out_of_range_count || a.room_code.localeCompare(b.room_code)),
    out_of_range_sensors: alerts,
    stale_after_minutes: 15,
    server_time: now.toISOString(),
  };
}
