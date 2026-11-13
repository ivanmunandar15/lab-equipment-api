import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { uniqueViolation } from '../../utils/prisma-errors';
import { generateSensorKey, hashSensorKey } from '../../utils/sensor-key';
import { thresholdState } from '../monitoring/monitoring.logic';
import { DEFAULT_UNIT, type CreateSensorBody, type ListSensorsQuery, type UpdateSensorBody } from './sensors.schema';

const SORTABLE = ['sensor_code', 'sensor_type', 'sensor_status', 'is_active', 'created_at', 'updated_at'];

// api_key_hash dibaca hanya untuk menghitung has_api_key; tidak pernah dikembalikan.
const SENSOR_SELECT = {
  sensor_id: true,
  room_id: true,
  sensor_code: true,
  sensor_type: true,
  unit: true,
  sensor_location: true,
  sensor_status: true,
  min_threshold: true,
  max_threshold: true,
  api_key_hash: true,
  is_active: true,
  created_at: true,
  updated_at: true,
  room: { select: { room_id: true, room_code: true, room_name: true } },
  monitorings: { orderBy: { measurement_time: 'desc' }, take: 1, select: { value: true, measurement_time: true } },
} satisfies Prisma.SensorSelect;

type Row = Prisma.SensorGetPayload<{ select: typeof SENSOR_SELECT }>;

function present(r: Row) {
  const { api_key_hash, monitorings, ...rest } = r;
  const last = monitorings[0];
  const min = Number(r.min_threshold);
  const max = Number(r.max_threshold);
  const value = last ? Number(last.value) : null;
  return {
    ...rest,
    min_threshold: min,
    max_threshold: max,
    has_api_key: api_key_hash !== null,
    latest: last ? { value, measurement_time: last.measurement_time, threshold_state: thresholdState(value!, min, max) } : null,
  };
}

async function assertActiveRoom(roomId: string) {
  const room = await getDb().room.findUnique({ where: { room_id: roomId }, select: { room_id: true, is_active: true } });
  if (!room) throw AppError.unprocessable('Validasi gagal', [{ path: 'room_id', message: 'Ruangan tidak ditemukan' }]);
  if (!room.is_active) throw AppError.conflict('Ruangan nonaktif', { code: 'ROOM_INACTIVE' });
}

const dupCode = () => AppError.conflict('Kode sensor sudah dipakai', { field: 'sensor_code' });

export async function list(q: ListSensorsQuery) {
  const db = getDb();
  const where: Prisma.SensorWhereInput = {
    ...(q.room_id ? { room_id: q.room_id } : {}),
    ...(q.sensor_type ? { sensor_type: q.sensor_type } : {}),
    ...(q.sensor_status ? { sensor_status: q.sensor_status } : {}),
    ...(q.is_active !== undefined ? { is_active: q.is_active } : {}),
    ...(q.search
      ? { OR: [{ sensor_code: { contains: q.search, mode: 'insensitive' } }, { sensor_location: { contains: q.search, mode: 'insensitive' } }] }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sort = resolveSort(q.sort, SORTABLE, 'sensor_code');
  const [rows, total] = await Promise.all([
    db.sensor.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: SENSOR_SELECT }),
    db.sensor.count({ where }),
  ]);
  return { items: rows.map(present), meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().sensor.findUnique({ where: { sensor_id: id }, select: SENSOR_SELECT });
  if (!row) throw AppError.notFound('Sensor tidak ditemukan');
  return present(row);
}

export async function create(body: CreateSensorBody) {
  await assertActiveRoom(body.room_id);
  const { generate_api_key, unit, ...data } = body;
  const apiKey = generate_api_key ? generateSensorKey() : null;
  try {
    const row = await getDb().sensor.create({
      data: { ...data, unit: unit ?? DEFAULT_UNIT[data.sensor_type], api_key_hash: apiKey ? hashSensorKey(apiKey) : null },
      select: SENSOR_SELECT,
    });
    // api_key plaintext hanya ada di respons ini.
    return { ...present(row), ...(apiKey ? { api_key: apiKey } : {}) };
  } catch (e) {
    if (uniqueViolation(e) !== null) throw dupCode();
    throw e;
  }
}

export async function update(id: string, body: UpdateSensorBody) {
  const db = getDb();
  const cur = await db.sensor.findUnique({
    where: { sensor_id: id },
    select: { sensor_id: true, room_id: true, min_threshold: true, max_threshold: true },
  });
  if (!cur) throw AppError.notFound('Sensor tidak ditemukan');

  const min = body.min_threshold ?? Number(cur.min_threshold);
  const max = body.max_threshold ?? Number(cur.max_threshold);
  if (min >= max) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'min_threshold', message: 'min_threshold harus lebih kecil dari max_threshold' }]);
  }
  if (body.room_id && body.room_id !== cur.room_id) await assertActiveRoom(body.room_id);

  try {
    const row = await db.sensor.update({ where: { sensor_id: id }, data: body, select: SENSOR_SELECT });
    return present(row);
  } catch (e) {
    if (uniqueViolation(e) !== null) throw dupCode();
    throw e;
  }
}

/** Soft delete. Data pembacaan dipertahankan; sensor nonaktif ditolak saat mengirim data. */
export async function remove(id: string) {
  const db = getDb();
  const cur = await db.sensor.findUnique({ where: { sensor_id: id }, select: { sensor_id: true } });
  if (!cur) throw AppError.notFound('Sensor tidak ditemukan');
  return present(await db.sensor.update({ where: { sensor_id: id }, data: { is_active: false }, select: SENSOR_SELECT }));
}

/** Buat/putar ulang API key. Key lama langsung tidak berlaku. Plaintext dikembalikan sekali. */
export async function rotateApiKey(id: string) {
  const db = getDb();
  const cur = await db.sensor.findUnique({ where: { sensor_id: id }, select: { sensor_id: true, sensor_code: true, is_active: true } });
  if (!cur) throw AppError.notFound('Sensor tidak ditemukan');
  if (!cur.is_active) throw AppError.conflict('Sensor nonaktif', { code: 'SENSOR_INACTIVE' });
  const key = generateSensorKey();
  await db.sensor.update({ where: { sensor_id: id }, data: { api_key_hash: hashSensorKey(key) }, select: { sensor_id: true } });
  return {
    sensor_id: cur.sensor_id,
    sensor_code: cur.sensor_code,
    api_key: key,
    rotated_at: new Date().toISOString(),
    note: 'Simpan sekarang. API key tidak dapat ditampilkan lagi.',
  };
}

export async function revokeApiKey(id: string) {
  const db = getDb();
  const cur = await db.sensor.findUnique({ where: { sensor_id: id }, select: { sensor_id: true } });
  if (!cur) throw AppError.notFound('Sensor tidak ditemukan');
  return present(await db.sensor.update({ where: { sensor_id: id }, data: { api_key_hash: null }, select: SENSOR_SELECT }));
}
