import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { PERMISSIONS } from '../../config/permissions';
import { authorize } from '../../middlewares/rbac';
import type { DeviceSensor } from '../../types/device-sensor';
import { AppError } from '../../utils/errors';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as monitoring from '../monitoring/monitoring.service';
import * as sensors from '../sensors/sensors.service';
import { diffFields, log } from './compat.audit';
import { LIST_CAP, emptyToNull, h, idParam, isUuid, parse, send, str } from './compat.http';
import { readingStatus, toReading, toSensor } from './compat.mappers';
import { createReadingSchema, createSensorSchema, updateSensorSchema } from './compat.schemas';

const S = AUDIT_ENTITIES.SENSOR;
const invalid = (path: string, message: string) => AppError.unprocessable('Validasi gagal', [{ path, message }]);
/** Frontend: admin & SPV mengelola sensor (matriks `lib/rbac.ts`); semua role boleh melihat. */
const manage = authorize(...PERMISSIONS.sensors.write);

async function findSensor(id: string) {
  const row = await getDb().sensor.findUnique({ where: { sensor_id: id } });
  if (!row) throw AppError.notFound(`Sensor dengan ID "${id}" tidak ditemukan`);
  return row;
}

export const sensorsRouter = Router();

sensorsRouter.get('/', h(async (req, res) => {
  const room = str(req.query.room_id);
  const type = str(req.query.type);
  const status = str(req.query.status);
  if (room && !isUuid(room)) return send(res, []);
  const rows = await getDb().sensor.findMany({
    where: {
      is_active: true,
      ...(room ? { room_id: room } : {}),
      ...(type === 'temperature' || type === 'humidity' ? { sensor_type: type } : {}),
      ...(status === 'active' || status === 'inactive' || status === 'damaged' ? { sensor_status: status } : {}),
    },
    orderBy: { sensor_code: 'asc' },
    take: LIST_CAP,
  });
  send(res, rows.map(toSensor));
}));

sensorsRouter.get('/:id', h(async (req, res) => send(res, toSensor(await findSensor(idParam(req, 'id', 'Sensor'))))));

sensorsRouter.post('/', manage, h(async (req, res) => {
  const d = parse(createSensorSchema, req.body);
  if (!isUuid(d.room_id)) throw invalid('room_id', 'Ruangan tidak ditemukan');
  const created = await sensors.create({
    room_id: d.room_id, sensor_code: d.sensor_code, sensor_type: d.sensor_type, unit: d.unit,
    sensor_location: emptyToNull(d.sensor_location), sensor_status: d.sensor_status,
    min_threshold: d.min_threshold, max_threshold: d.max_threshold, generate_api_key: false,
  });
  await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: S, entityId: created.sensor_id, newData: { sensor_code: created.sensor_code } });
  send(res, toSensor(await findSensor(created.sensor_id)), 201);
}));

sensorsRouter.patch('/:id', manage, h(async (req, res) => {
  const id = idParam(req, 'id', 'Sensor');
  const p = parse(updateSensorSchema, req.body);
  if (p.room_id !== undefined && !isUuid(p.room_id)) throw invalid('room_id', 'Ruangan tidak ditemukan');
  const before = await findSensor(id);
  await sensors.update(id, {
    ...(p.room_id !== undefined ? { room_id: p.room_id } : {}),
    ...(p.sensor_code !== undefined ? { sensor_code: p.sensor_code } : {}),
    ...(p.sensor_type !== undefined ? { sensor_type: p.sensor_type } : {}),
    ...(p.unit !== undefined ? { unit: p.unit } : {}),
    ...(p.sensor_location !== undefined ? { sensor_location: emptyToNull(p.sensor_location) } : {}),
    ...(p.sensor_status !== undefined ? { sensor_status: p.sensor_status } : {}),
    ...(p.min_threshold !== undefined ? { min_threshold: p.min_threshold } : {}),
    ...(p.max_threshold !== undefined ? { max_threshold: p.max_threshold } : {}),
  });
  const after = await findSensor(id);
  const { oldData, newData } = diffFields(toSensor(before), toSensor(after));
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: S, entityId: id, oldData, newData });
  send(res, toSensor(after));
}));

/** Seperti mock: "soft delete" = sensor_status "inactive"; riwayat pembacaan tetap ada dan sensor ditolak saat kirim data. */
sensorsRouter.delete('/:id', manage, h(async (req, res) => {
  const id = idParam(req, 'id', 'Sensor');
  const before = await findSensor(id);
  await sensors.update(id, { sensor_status: 'inactive' });
  await log(req, { action: AUDIT_ACTIONS.DELETE, entityType: S, entityId: id, oldData: { sensor_status: before.sensor_status }, newData: { sensor_status: 'inactive' } });
  send(res, toSensor(await findSensor(id)));
}));

/* =========================== PEMBACAAN =========================== */

export const readingsRouter = Router();

/** Urut naik menurut waktu; `limit` = N pembacaan TERBARU (hasil tetap naik), sama dengan mock. */
readingsRouter.get('/', h(async (req, res) => {
  const sensorId = str(req.query.sensor_id);
  const roomId = str(req.query.room_id);
  const from = str(req.query.from);
  const to = str(req.query.to);
  if ((sensorId && !isUuid(sensorId)) || (roomId && !isUuid(roomId))) return send(res, []);
  if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) throw invalid('from', 'Tanggal dan waktu tidak valid');
  const limit = Math.min(Math.max(Number(req.query.limit) || LIST_CAP, 1), LIST_CAP);

  const where: Prisma.RoomMonitoringWhereInput = {
    ...(sensorId ? { sensor_id: sensorId } : {}),
    ...(roomId ? { sensor: { room_id: roomId } } : {}),
    ...(from || to ? { measurement_time: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
  };
  const rows = await getDb().roomMonitoring.findMany({ where, orderBy: { measurement_time: 'desc' }, take: limit });
  send(res, rows.reverse().map(toReading));
}));

/** Pembacaan terakhir tiap sensor + status terhadap batas normal (`SensorWithLatest[]`). */
readingsRouter.get('/latest', h(async (req, res) => {
  const roomId = str(req.query.room_id);
  if (roomId && !isUuid(roomId)) return send(res, []);
  const rows = await getDb().sensor.findMany({
    where: { is_active: true, ...(roomId ? { room_id: roomId } : {}) },
    orderBy: { sensor_code: 'asc' },
    take: LIST_CAP,
    include: { monitorings: { orderBy: { measurement_time: 'desc' }, take: 1 } },
  });
  send(res, rows.map(({ monitorings, ...sensor }) => {
    const last = monitorings[0];
    const s = toSensor(sensor);
    const latest = last ? toReading(last) : null;
    return { sensor: s, latest, reading_status: latest ? readingStatus(latest.value, s.min_threshold, s.max_threshold) : null };
  }));
}));

readingsRouter.get('/:id', h(async (req, res) => {
  const row = await getDb().roomMonitoring.findUnique({ where: { monitoring_id: idParam(req, 'id', 'Pembacaan') } });
  if (!row) throw AppError.notFound(`Pembacaan dengan ID "${req.params.id}" tidak ditemukan`);
  send(res, toReading(row));
}));

/**
 * Input pembacaan manual dari UI (login JWT, admin/SPV). Perangkat IoT tetap memakai
 * `POST /api/v1/monitoring/readings` + header X-Sensor-Key. Aturan backend berlaku
 * (sensor harus active, waktu tidak di masa depan, notifikasi bila di luar batas).
 */
readingsRouter.post('/', manage, h(async (req, res) => {
  const d = parse(createReadingSchema, req.body);
  if (!isUuid(d.sensor_id)) throw AppError.notFound(`Sensor dengan ID "${d.sensor_id}" tidak ditemukan`);
  const row = await getDb().sensor.findUnique({
    where: { sensor_id: d.sensor_id },
    select: { sensor_id: true, sensor_code: true, room_id: true, sensor_type: true, unit: true, sensor_status: true, min_threshold: true, max_threshold: true, room: { select: { room_code: true, room_name: true, person_in_charge: true } } },
  });
  if (!row) throw AppError.notFound(`Sensor dengan ID "${d.sensor_id}" tidak ditemukan`);
  const device = { ...row, min_threshold: Number(row.min_threshold), max_threshold: Number(row.max_threshold) } as DeviceSensor;
  await monitoring.ingest(device, [{ value: d.value, measurement_time: new Date(d.measurement_time) }]);
  const saved = await getDb().roomMonitoring.findFirst({ where: { sensor_id: d.sensor_id }, orderBy: { received_at: 'desc' } });
  send(res, toReading(saved!), 201);
}));
