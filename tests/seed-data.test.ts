import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_REGEX } from '../src/modules/equipment/equipment.schema';
import { LAB_ROOMS, PERSONNEL, parseCsv, parseDMY, parseDatang, parseEquipmentCsv, parseSupportingCsv, roomCapacity } from '../prisma/seed-data';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'prisma/data', f), 'utf8');
const eq = parseEquipmentCsv(read('inventaris.csv'));
const sup = parseSupportingCsv(read('supporting.csv'));

describe('seed-data: personil & ruangan', () => {
  it('4 technician + 2 SPV, email valid dan unik', () => {
    expect(PERSONNEL.filter((p) => p.role === 'technician')).toHaveLength(4);
    expect(PERSONNEL.filter((p) => p.role === 'SPV')).toHaveLength(2);
    const emails = PERSONNEL.map((p) => p.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) expect(e).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it('kode dan nama ruangan unik; 8 laboratorium resmi + 5 dari CSV', () => {
    expect(new Set(LAB_ROOMS.map((r) => r.room_code)).size).toBe(LAB_ROOMS.length);
    expect(new Set(LAB_ROOMS.map((r) => r.room_name)).size).toBe(LAB_ROOMS.length);
    expect(LAB_ROOMS.filter((r) => r.listed)).toHaveLength(8);
    expect(LAB_ROOMS.filter((r) => !r.listed)).toHaveLength(5);
  });

  it('roomCapacity: jumlah + 15%, kelipatan 10, minimal 10', () => {
    expect([0, 4, 8, 14, 18, 159, 228].map(roomCapacity)).toEqual([10, 10, 10, 20, 30, 190, 270]);
  });
});

describe('seed-data: parser', () => {
  it('parseCsv menangani kutip, koma, dan baris baru di dalam kutip', () => {
    expect(parseCsv('a,"b,c","d ""x""\ne"\r\n1,2,3')).toEqual([['a', 'b,c', 'd "x"\ne'], ['1', '2', '3']]);
  });
  it('parseDMY / parseDatang', () => {
    expect(parseDMY('14/10/2026')).toBe('2026-10-14');
    expect(parseDMY('-')).toBeNull();
    expect(parseDMY('')).toBeNull();
    expect(parseDMY('31/02/2026')).toBeUndefined();
    expect(parseDatang('2025-08-21 0:00:00')).toBe('2025-08-21');
    expect(parseDatang('-')).toBeNull();
    expect(parseDatang('2025-13-40 0:00:00')).toBeUndefined();
    expect(parseDatang('1850-01-01 0:00:00')).toBeUndefined();
  });
});

describe('seed-data: inventaris.csv', () => {
  it('689 alat terurai tanpa masalah dan semua kode lolos aturan backend', () => {
    expect(eq.problems).toEqual([]);
    expect(eq.items).toHaveLength(689);
    for (const e of eq.items) {
      expect(e.inventory_code).toMatch(CODE_REGEX);
      expect(e.inventory_code.length).toBeLessThanOrEqual(50);
    }
    expect(new Set(eq.items.map((e) => e.inventory_code.toLowerCase())).size).toBe(689);
  });

  it('setiap alat punya ruangan yang dikenal dan tidak melebihi kapasitas', () => {
    const codes = new Set(LAB_ROOMS.map((r) => r.room_code));
    const count = new Map<string, number>();
    for (const e of eq.items) {
      expect(codes.has(e.room_code)).toBe(true);
      count.set(e.room_code, (count.get(e.room_code) ?? 0) + 1);
    }
    for (const [code, n] of count) expect(roomCapacity(n)).toBeGreaterThanOrEqual(n);
    expect(count.get('R-HAA')).toBe(228);
    expect(count.get('R-ELC')).toBe(210);
    expect(count.get('R-LUM')).toBe(159);
  });

  it('memetakan kolom dengan benar (Datang → purchase_date, kalibrasi, spesifikasi)', () => {
    const main = eq.items.find((e) => e.inventory_code === 'INV L-ACT 10-01');
    expect(main).toMatchObject({ equipment_name: 'Optical Radiation Test System', equipment_type: 'Utama', brand: 'Everfine', model: 'BSQ_VS_MQT 01', room_code: 'R-DRK', purchase_date: '2025-08-21', next_calibration_date: null, specifications: null });
    const sub = eq.items.find((e) => e.inventory_code === 'INV L-ACT 10-01.01');
    expect(sub).toMatchObject({ equipment_type: 'Sub Bagian', model: null, purchase_date: null, next_calibration_date: '2027-10-14' });
    expect(sub?.specifications).toBe('Periode kalibrasi: 1 Tahun; LPK: PT. Sentral Tehnologi Managemen; Kalibrasi terakhir: 2026-10-14');
    expect(eq.items.filter((e) => e.next_calibration_date)).toHaveLength(283);
    expect(eq.items.filter((e) => e.purchase_date)).toHaveLength(166);
  });
});

describe('seed-data: supporting.csv', () => {
  it('126 item (nomor 1-126), kode valid dan unik, tidak bentrok dengan alat utama', () => {
    expect(sup.items).toHaveLength(126);
    for (const s of sup.items) expect(s.item_code).toMatch(CODE_REGEX);
    const all = new Set([...eq.items.map((e) => e.inventory_code), ...sup.items.map((s) => s.item_code)].map((c) => c.toLowerCase()));
    expect(all.size).toBe(689 + 126);
  });

  it('baris tanpa nama diberi placeholder dan dilaporkan', () => {
    const blank = sup.items.filter((s) => s.item_name.startsWith('Tanpa nama'));
    expect(blank.map((s) => s.item_code)).toEqual(['INV L-ACT 11-46', 'INV L-ACT 11-47']);
    expect(sup.problems).toHaveLength(2);
  });

  it('satuan pcs, jumlah 1, lokasi di deskripsi', () => {
    const s = sup.items.find((x) => x.item_code === 'INV L-ACT 11-6');
    expect(s).toMatchObject({ item_name: 'Blower Uap station + Solder', brand: 'Yihua', model: '878D', unit: 'pcs', total_quantity: 1, description: 'Lokasi: Home App & Auvi Room' });
  });
});
