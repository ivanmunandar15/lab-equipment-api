/** Fungsi murni untuk monitoring (mudah diuji). */
export type ThresholdState = 'below_min' | 'above_max' | 'normal';
export type Interval = 'raw' | '5m' | '1h' | '1d';

export const MAX_AGG_POINTS = 1000;
export const MAX_RAW_POINTS = 1000;
export const MAX_RANGE_DAYS = 366;
export const MAX_BATCH = 500;
/** Pembacaan terbaru lebih tua dari ini dianggap basi (sensor mungkin mati). */
export const STALE_MINUTES = 15;
/** Toleransi jam perangkat yang sedikit maju. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const BUCKET_SECONDS: Record<Exclude<Interval, 'raw'>, number> = { '5m': 300, '1h': 3600, '1d': 86400 };

export function thresholdState(value: number, min: number, max: number): ThresholdState {
  return value < min ? 'below_min' : value > max ? 'above_max' : 'normal';
}

export const isOutOfRange = (value: number, min: number, max: number) => thresholdState(value, min, max) !== 'normal';

export const isStale = (measurementTime: Date | null, now = new Date()) =>
  measurementTime === null || now.getTime() - measurementTime.getTime() > STALE_MINUTES * 60_000;

/** Jumlah bucket maksimum untuk rentang waktu tertentu. */
export const bucketCount = (from: Date, to: Date, interval: Exclude<Interval, 'raw'>) =>
  Math.floor((to.getTime() - from.getTime()) / (BUCKET_SECONDS[interval] * 1000)) + 1;

/** Interval terkecil yang muat dalam batas titik, untuk saran di pesan error. */
export function suggestInterval(from: Date, to: Date): Exclude<Interval, 'raw'> {
  for (const i of ['5m', '1h', '1d'] as const) if (bucketCount(from, to, i) <= MAX_AGG_POINTS) return i;
  return '1d';
}

/** Judul dipakai juga sebagai penanda anti-spam (tabel notifikasi tidak punya kolom sensor_id). */
export const alertTitle = (sensorCode: string) => `Sensor ${sensorCode} di luar batas`;

export const round2 = (v: number) => Math.round(v * 100) / 100;
