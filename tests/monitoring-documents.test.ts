import { describe, expect, it } from 'vitest';
import {
  alertTitle,
  bucketCount,
  isOutOfRange,
  isStale,
  MAX_AGG_POINTS,
  round2,
  suggestInterval,
  thresholdState,
} from '../src/modules/monitoring/monitoring.logic';
import { ingestBody, readingsQuery } from '../src/modules/monitoring/monitoring.schema';
import { createSensorBody, updateSensorBody } from '../src/modules/sensors/sensors.schema';
import { generateSensorKey, hashSensorKey } from '../src/utils/sensor-key';
import { cleanDisplayName, documentMimeMatches } from '../src/utils/storage';

describe('threshold & bucket', () => {
  it('thresholdState / isOutOfRange', () => {
    expect(thresholdState(10, 15, 25)).toBe('below_min');
    expect(thresholdState(30, 15, 25)).toBe('above_max');
    expect(thresholdState(15, 15, 25)).toBe('normal'); // batas inklusif
    expect(isOutOfRange(25.01, 15, 25)).toBe(true);
  });
  it('isStale', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date('2026-01-01T11:50:00Z'), now)).toBe(false);
    expect(isStale(new Date('2026-01-01T11:30:00Z'), now)).toBe(true);
  });
  it('bucketCount & suggestInterval menjaga batas titik', () => {
    const to = new Date('2026-01-31T00:00:00Z');
    const from = new Date('2026-01-01T00:00:00Z');
    expect(bucketCount(from, to, '5m')).toBeGreaterThan(MAX_AGG_POINTS);
    expect(suggestInterval(from, to)).toBe('1h');
    expect(bucketCount(from, to, suggestInterval(from, to))).toBeLessThanOrEqual(MAX_AGG_POINTS);
  });
  it('round2 & alertTitle', () => {
    expect(round2(21.456)).toBe(21.46);
    expect(alertTitle('T-1')).toBe('Sensor T-1 di luar batas');
  });
});

describe('ingest body', () => {
  it('menerima objek tunggal, array, dan {readings}', () => {
    expect(ingestBody.parse({ value: 20 })).toHaveLength(1);
    expect(ingestBody.parse([{ value: 1 }, { value: 2 }])).toHaveLength(2);
    expect(ingestBody.parse({ readings: [{ value: 1, sensor_code: 'A' }] })).toHaveLength(1);
  });
  it('mengubah measurement_time ke Date & menolak format salah / NaN / batch kosong', () => {
    const [r] = ingestBody.parse({ value: 1, measurement_time: '2026-01-01T00:00:00Z' });
    expect(r.measurement_time).toBeInstanceOf(Date);
    expect(ingestBody.safeParse({ value: 1, measurement_time: '01/01/2026' }).success).toBe(false);
    expect(ingestBody.safeParse({ value: 'abc' }).success).toBe(false);
    expect(ingestBody.safeParse([]).success).toBe(false);
    expect(ingestBody.safeParse(Array.from({ length: 501 }, () => ({ value: 1 }))).success).toBe(false);
  });
  it('readingsQuery: default interval 5m, from harus sebelum to', () => {
    expect(readingsQuery.parse({}).interval).toBe('5m');
    expect(readingsQuery.safeParse({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success).toBe(false);
  });
});

describe('sensor schema & key', () => {
  const ok = { room_id: '11111111-1111-4111-8111-111111111111', sensor_code: 'T-01', sensor_type: 'temperature', min_threshold: 15, max_threshold: 25 };
  it('min harus < max', () => {
    expect(createSensorBody.safeParse(ok).success).toBe(true);
    expect(createSensorBody.safeParse({ ...ok, min_threshold: 30 }).success).toBe(false);
    expect(updateSensorBody.safeParse({ min_threshold: 30, max_threshold: 20 }).success).toBe(false);
    expect(updateSensorBody.safeParse({}).success).toBe(false);
  });
  it('sensor_code hanya karakter aman', () => {
    expect(createSensorBody.safeParse({ ...ok, sensor_code: 'a b/c' }).success).toBe(false);
  });
  it('API key acak, berprefix, hash deterministik & tidak sama dengan plaintext', () => {
    const a = generateSensorKey();
    const b = generateSensorKey();
    expect(a).toMatch(/^lsk_[\w-]{40,}$/);
    expect(a).not.toBe(b);
    expect(hashSensorKey(a)).toBe(hashSensorKey(a));
    expect(hashSensorKey(a)).not.toContain(a);
    expect(hashSensorKey(a)).toHaveLength(64);
  });
});

describe('dokumen: validasi file', () => {
  const pdf = Buffer.from('%PDF-1.7 ...');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  it('magic bytes harus cocok dengan MIME deklarasi', () => {
    expect(documentMimeMatches(pdf, 'application/pdf')).toBe(true);
    expect(documentMimeMatches(pdf, 'image/png')).toBe(false);
    expect(documentMimeMatches(Buffer.from('<script>alert(1)</script>'), 'application/pdf')).toBe(false);
    expect(documentMimeMatches(zip, DOCX)).toBe(true);
    expect(documentMimeMatches(pdf, DOCX)).toBe(false);
  });
  it('nama tampilan dibersihkan (path traversal, karakter kontrol, UTF-8)', () => {
    expect(cleanDisplayName('../../etc/passwd')).toBe('passwd');
    expect(cleanDisplayName('C:\\evil\\a"b.pdf')).toBe('a_b.pdf');
    expect(cleanDisplayName('')).toBe('dokumen');
    expect(cleanDisplayName(Buffer.from('Manual Alat é.pdf', 'utf8').toString('latin1'))).toBe('Manual Alat é.pdf');
    expect(cleanDisplayName('a'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(200);
  });
});
