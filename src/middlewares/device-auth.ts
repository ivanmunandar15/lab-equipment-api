import { getDb } from '../config/db';
import { asyncHandler } from '../utils/async-handler';
import { AppError } from '../utils/errors';
import { hashSensorKey, SENSOR_KEY_PREFIX } from '../utils/sensor-key';
import type { DeviceSensor } from '../types/device-sensor';

/** Autentikasi perangkat IoT lewat header X-Sensor-Key (bukan JWT). Key mengidentifikasi satu sensor. */
export const authenticateDevice = asyncHandler(async (req, _res, next) => {
  const key = req.header('x-sensor-key');
  if (!key || !key.startsWith(SENSOR_KEY_PREFIX) || key.length > 128) {
    throw AppError.unauthorized('X-Sensor-Key tidak valid');
  }
  const row = await getDb().sensor.findFirst({
    where: { api_key_hash: hashSensorKey(key), is_active: true },
    select: {
      sensor_id: true,
      sensor_code: true,
      room_id: true,
      sensor_type: true,
      unit: true,
      sensor_status: true,
      min_threshold: true,
      max_threshold: true,
      room: { select: { room_code: true, room_name: true, person_in_charge: true } },
    },
  });
  // Pesan sama untuk key salah / dicabut / sensor nonaktif agar tidak membocorkan informasi.
  if (!row) throw AppError.unauthorized('X-Sensor-Key tidak valid');

  req.sensor = { ...row, min_threshold: Number(row.min_threshold), max_threshold: Number(row.max_threshold) } as DeviceSensor;
  next();
});
