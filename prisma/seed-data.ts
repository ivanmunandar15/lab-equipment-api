/**
 * Data master untuk seed: personil, ruangan, dan parser CSV inventaris (prisma/data/*.csv).
 * Murni (tanpa Prisma/DB) supaya bisa dites (tests/seed-data.test.ts).
 */
import { CODE_REGEX } from '../src/modules/equipment/equipment.schema';

/* ───────── Personil ───────── */
export type SeedRole = 'technician' | 'SPV';
export interface SeedPerson { name: string; email: string; role: SeedRole }

/** Personil laboratorium (technician) dan SPV. Akun admin sistem dibuat terpisah di seed.ts. */
export const PERSONNEL: SeedPerson[] = [
  { name: 'Ivan Munandar Purnama', email: 'ivan.munandar@anindya.biz', role: 'technician' },
  { name: 'I Putu Ary Suyasa', email: 'ary.suyasa_act@anindya.biz', role: 'technician' },
  { name: 'Ralphy Christian Monintja', email: 'ralphy_act@anindya.biz', role: 'technician' },
  { name: 'Deni Arifani Nafis', email: 'deni.arifani_act@anindya.biz', role: 'technician' },
  { name: 'Ach. Effendi', email: 'ach.effendi_act@anindya.biz', role: 'SPV' },
  { name: 'Muhamad Ridwan Maulana', email: 'm.ridwan_act@anindya.biz', role: 'SPV' },
];

/* ───────── Ruangan ───────── */
export interface SeedRoom {
  room_code: string;
  room_name: string;
  /** Nilai kolom "Posisi Alat" di CSV yang dipetakan ke ruangan ini. */
  csv_position: string;
  /** false = tidak ada di daftar laboratorium resmi, tetapi dipakai oleh CSV inventaris. */
  listed: boolean;
}

export const LAB_ROOMS: SeedRoom[] = [
  { room_code: 'R-HAA', room_name: 'Home App & Auvi Laboratory', csv_position: 'Home App & Auvi Room', listed: true },
  { room_code: 'R-LUM', room_name: 'Luminer Laboratory', csv_position: 'Luminer Room', listed: true },
  { room_code: 'R-CMB', room_name: 'Combus Laboratory', csv_position: 'Combustion Room', listed: true },
  { room_code: 'R-ELC', room_name: 'Elcon Laboratory', csv_position: 'Elcon Room', listed: true },
  { room_code: 'R-DRK', room_name: 'Dark Laboratory', csv_position: 'Dark Room', listed: true },
  { room_code: 'R-IPX', room_name: 'IPX Laboratory', csv_position: 'IPX Room', listed: true },
  { room_code: 'R-DST', room_name: 'Dust Laboratory', csv_position: 'Dust Room', listed: true },
  { room_code: 'R-SPH', room_name: 'Sphere Laboratory', csv_position: 'Sphere Room', listed: true },
  // Dipakai CSV inventaris tetapi tidak ada di daftar laboratorium:
  { room_code: 'R-TRS', room_name: 'Temperature Rise Laboratory', csv_position: 'Temperature Rise', listed: false },
  { room_code: 'R-VIB', room_name: 'Vibration Laboratory', csv_position: 'Vibration Room', listed: false },
  { room_code: 'R-AUD', room_name: 'Audio Laboratory', csv_position: 'Audio Room', listed: false },
  { room_code: 'R-DUR', room_name: 'Durability Laboratory', csv_position: 'Durability Room', listed: false },
  { room_code: 'R-THM', room_name: 'Temperature & Humidity Laboratory', csv_position: 'Temperature & Humidity Room', listed: false },
];

/** Jumlah alat + cadangan ±15%, dibulatkan ke atas kelipatan 10 (minimal 10). */
export const roomCapacity = (equipmentCount: number) => Math.max(10, Math.ceil((equipmentCount * 1.15) / 10) * 10);

/* ───────── CSV ───────── */
/** Parser RFC 4180 sederhana (kutip ganda, koma, baris baru di dalam kutip). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
/** "" dan "-" berarti tidak ada data. */
const orNull = (s: string | undefined) => { const v = clean(s); return v === '' || v === '-' ? null : v; };

function isRealDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "14/10/2026" → "2026-10-14"; null jika kosong/"-"; `undefined` jika formatnya tidak valid. */
export function parseDMY(raw: string | undefined): string | null | undefined {
  const v = orNull(raw);
  if (v === null) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m || !isRealDate(+m[3], +m[2], +m[1])) return undefined;
  return iso(+m[3], +m[2], +m[1]);
}

/** "2025-08-21 0:00:00" (kolom Datang) → "2025-08-21"; null jika kosong/"-"; `undefined` jika tidak valid/tidak masuk akal. */
export function parseDatang(raw: string | undefined): string | null | undefined {
  const v = orNull(raw);
  if (v === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(v);
  if (!m || !isRealDate(+m[1], +m[2], +m[3]) || +m[1] < 1990 || +m[1] > new Date().getUTCFullYear() + 1) return undefined;
  return iso(+m[1], +m[2], +m[3]);
}

function columns(header: string[], required: string[]) {
  const names = header.map((h) => clean(h));
  const idx = (name: string) => names.indexOf(name);
  const missing = required.filter((r) => idx(r) < 0);
  if (missing.length) throw new Error(`Kolom CSV tidak ditemukan: ${missing.join(', ')}`);
  return idx;
}

/* ───────── Alat utama ───────── */
export interface EquipmentSeed {
  inventory_code: string;
  equipment_name: string;
  /** Kolom "Bagian": Utama / Sub Bagian. */
  equipment_type: string;
  brand: string | null;
  model: string | null;
  room_code: string;
  /** Dari kolom "Datang" (tanggal kedatangan alat). */
  purchase_date: string | null;
  /** Serial, periode/penyedia/tanggal kalibrasi terakhir, dan catatan (tidak ada kolom khusus di database). */
  specifications: string | null;
  next_calibration_date: string | null;
}

export interface ParseResult<T> { items: T[]; problems: string[] }

export function parseEquipmentCsv(text: string): ParseResult<EquipmentSeed> {
  const [header = [], ...data] = parseCsv(text);
  const col = columns(header, ['No Inventaris', 'Nama Alat', 'Bagian', 'Type', 'Serial No', 'Brand', 'Posisi Alat', 'Periode Kalibrasi', 'Program Kalibrasi', 'LPK', 'Datang', 'Note']);
  // Kolom "Program Kalibrasi" = kalibrasi terakhir; kolom berikutnya (header kosong, sub-header "Kalibrasi Berikutnya") = jadwal berikutnya.
  const iLast = col('Program Kalibrasi');
  const iNext = iLast + 1;
  const roomByPosition = new Map(LAB_ROOMS.map((r) => [r.csv_position.toLowerCase(), r.room_code]));

  const items: EquipmentSeed[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const r of data) {
    const code = clean(r[col('No Inventaris')]);
    if (!code.startsWith('INV')) continue; // sub-header / baris kosong
    const skip = (why: string) => problems.push(`${code}: ${why} (dilewati)`);

    const name = clean(r[col('Nama Alat')]);
    const type = clean(r[col('Bagian')]);
    const position = clean(r[col('Posisi Alat')]);
    const room = roomByPosition.get(position.toLowerCase());
    if (!CODE_REGEX.test(code) || code.length > 50) { skip('kode tidak valid'); continue; }
    if (seen.has(code.toLowerCase())) { skip('kode ganda'); continue; }
    if (name.length < 2 || name.length > 150) { skip('nama alat kosong/terlalu panjang'); continue; }
    if (type.length < 2) { skip('kolom Bagian kosong'); continue; }
    if (!room) { skip(`posisi alat tidak dikenal '${position}'`); continue; }

    let purchase = parseDatang(r[col('Datang')]);
    if (purchase === undefined) { problems.push(`${code}: tanggal Datang '${clean(r[col('Datang')])}' tidak valid (diabaikan)`); purchase = null; }
    let last = parseDMY(r[iLast]);
    if (last === undefined) { problems.push(`${code}: kalibrasi terakhir '${clean(r[iLast])}' tidak valid (diabaikan)`); last = null; }
    let next = parseDMY(r[iNext]);
    if (next === undefined) { problems.push(`${code}: kalibrasi berikutnya '${clean(r[iNext])}' tidak valid (diabaikan)`); next = null; }
    if (last && next && next <= last) problems.push(`${code}: kalibrasi berikutnya (${next}) tidak setelah kalibrasi terakhir (${last})`);

    const serial = orNull(r[col('Serial No')]);
    const period = orNull(r[col('Periode Kalibrasi')]);
    const lpk = orNull(r[col('LPK')]);
    const note = orNull(r[col('Note')]);
    const spec = [
      serial && `S/N: ${serial}`,
      period && `Periode kalibrasi: ${period}`,
      lpk && `LPK: ${lpk}`,
      last && `Kalibrasi terakhir: ${last}`,
      note && `Catatan: ${note}`,
    ].filter(Boolean).join('; ');

    seen.add(code.toLowerCase());
    items.push({
      inventory_code: code,
      equipment_name: name,
      equipment_type: type,
      brand: orNull(r[col('Brand')]),
      model: orNull(r[col('Type')]),
      room_code: room,
      purchase_date: purchase,
      specifications: spec || null,
      next_calibration_date: next,
    });
  }
  return { items, problems };
}

/* ───────── Alat pendukung ───────── */
export interface SupportingSeed {
  item_code: string;
  item_name: string;
  brand: string | null;
  model: string | null;
  /** Lokasi dari kolom "Room" (tabel supporting_equipment tidak punya kolom ruangan). */
  description: string | null;
  /** CSV tidak memuat jumlah/satuan: tiap baris = 1 pcs. */
  unit: 'pcs';
  total_quantity: 1;
}

export function parseSupportingCsv(text: string): ParseResult<SupportingSeed> {
  const [header = [], ...data] = parseCsv(text);
  const col = columns(header, ['No Inventaris', 'Nama', 'Brand', 'Type', 'Room']);
  const items: SupportingSeed[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    const code = clean(r[col('No Inventaris')]);
    if (!code.startsWith('INV')) continue;
    const skip = (why: string) => problems.push(`${code}: ${why} (dilewati)`);
    let name = clean(r[col('Nama')]);
    if (!CODE_REGEX.test(code) || code.length > 50) { skip('kode tidak valid'); continue; }
    if (seen.has(code.toLowerCase())) { skip('kode ganda'); continue; }
    if (name === '') {
      // Nomor inventaris tetap dipertahankan agar urutan tidak bolong; nama dilengkapi lewat aplikasi.
      name = `Tanpa nama (${code})`;
      problems.push(`${code}: nama kosong di CSV, diisi placeholder "${name}"`);
    }
    if (name.length < 2 || name.length > 150) { skip('nama terlalu panjang'); continue; }
    const room = orNull(r[col('Room')]);
    seen.add(code.toLowerCase());
    items.push({
      item_code: code,
      item_name: name,
      brand: orNull(r[col('Brand')]),
      model: orNull(r[col('Type')]),
      description: room ? `Lokasi: ${room}` : null,
      unit: 'pcs',
      total_quantity: 1,
    });
  }
  return { items, problems };
}
