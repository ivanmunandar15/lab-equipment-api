/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  const fake = createFakeDb();
  return { getDb: () => fake, disconnectDb: async () => undefined, __fake: fake };
});

import * as dbModule from '../src/config/db';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { calibrationState, remainingUsefulLifeYears } from '../src/modules/equipment/equipment.derive';
import { equipmentQrUrl } from '../src/utils/qr';
import { DEMO_PASSWORD, ROOM_A, ROOM_B, ROOM_OFF } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const binary = (res: any, cb: (e: Error | null, b?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function login(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password });
  return res.body.data.access_token as string;
}

let admin: string;
let spv: string;
let tech: string;
let qa: string;

beforeEach(async () => {
  await fake.reset();
  admin = await login('admin@lab.local');
  tech = await login('technician@lab.local');
  for (const [name, role] of [['SPV', 'SPV'], ['QA', 'QA']] as const) {
    await request(app).post(`${API}/users`).set(bearer(admin)).send({ name, email: `${role.toLowerCase()}@x.local`, role, password: 'Password123' });
  }
  spv = await login('spv@x.local', 'Password123');
  qa = await login('qa@x.local', 'Password123');
});

afterEach(() => {
  (env as any).ROOM_CAPACITY_MODE = 'block';
});

let seq = 0;
async function mkEq(over: Record<string, unknown> = {}, token = spv) {
  seq++;
  return request(app)
    .post(`${API}/equipment`)
    .set(bearer(token))
    .send({ inventory_code: `EQ-${seq}`, equipment_name: `Alat ${seq}`, equipment_type: 'Oven', room_id: ROOM_B, ...over });
}

describe('perhitungan turunan', () => {
  const now = new Date('2026-10-30T10:00:00Z');
  it('calibrationState: overdue / due_soon / safe / null', () => {
    expect(calibrationState(new Date('2026-10-29'), now, 30)).toBe('overdue');
    expect(calibrationState(new Date('2026-10-30'), now, 30)).toBe('due_soon');
    expect(calibrationState(new Date('2026-11-29'), now, 30)).toBe('due_soon');
    expect(calibrationState(new Date('2026-11-30'), now, 30)).toBe('safe');
    expect(calibrationState(null, now, 30)).toBeNull();
  });
  it('remainingUsefulLifeYears: sisa tahun, min 0, null jika data kosong', () => {
    expect(remainingUsefulLifeYears(new Date('2024-10-30'), 10, now)).toBeCloseTo(8, 1);
    expect(remainingUsefulLifeYears(new Date('2000-01-01'), 5, now)).toBe(0);
    expect(remainingUsefulLifeYears(null, 5, now)).toBeNull();
    expect(remainingUsefulLifeYears(new Date('2024-01-01'), null, now)).toBeNull();
  });
});

describe('RBAC', () => {
  it('technician & QA boleh lihat, tidak boleh tulis; SPV boleh; tanpa token 401', async () => {
    expect((await request(app).get(`${API}/equipment`)).status).toBe(401);
    expect((await request(app).get(`${API}/equipment`).set(bearer(tech))).status).toBe(200);
    expect((await request(app).get(`${API}/rooms`).set(bearer(qa))).status).toBe(200);
    expect((await mkEq({}, tech)).status).toBe(403);
    expect((await mkEq({}, qa)).status).toBe(403);
    expect((await mkEq({}, spv)).status).toBe(201);
    expect((await request(app).post(`${API}/rooms`).set(bearer(tech)).send({ room_code: 'X', room_name: 'Xx' })).status).toBe(403);
    expect((await request(app).get(`${API}/equipment/import-template.csv`).set(bearer(tech))).status).toBe(403);
  });
});

describe('Equipment CRUD', () => {
  it('POST: qr_token 12 karakter + qr_url + turunan; qr_token dari body diabaikan', async () => {
    const res = await mkEq({
      qr_token: 'HACKED000000',
      purchase_date: '2024-10-30',
      purchase_price: 45000000,
      useful_life_years: 10,
      next_calibration_date: day(10),
      is_active: false,
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.qr_token).toHaveLength(12);
    expect(d.qr_token).not.toBe('HACKED000000');
    expect(d.qr_url).toBe(`http://localhost:3001/scan/eq/${d.qr_token}`);
    expect(d.calibration_state).toBe('due_soon');
    expect(d.remaining_useful_life_years).toBeGreaterThan(7);
    expect(d.is_active).toBe(true);
    expect(d.room.room_code).toBe('LAB-B');
    expect(d.purchase_date).toBe('2024-10-30');
  });

  it('POST: inventory_code ganda 409; validasi 422; ruangan tidak aktif/tidak ada 422', async () => {
    await mkEq({ inventory_code: 'DUP-1' });
    const dup = await mkEq({ inventory_code: 'DUP-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('inventory_code');
    expect((await mkEq({ inventory_code: '=SUM(1)' })).status).toBe(422); // awalan non-alfanumerik (injeksi rumus CSV)
    expect((await mkEq({ inventory_code: 'kode  salah' })).status).toBe(422); // spasi ganda
    expect((await mkEq({ inventory_code: 'kode;salah' })).status).toBe(422);
    expect((await mkEq({ purchase_date: '30-10-2026' })).status).toBe(422);
    expect((await mkEq({ status: 'borrowed' })).status).toBe(422);
    expect((await mkEq({ room_id: ROOM_OFF })).status).toBe(422);
    expect((await mkEq({ room_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(422);
  });

  it('POST/PATCH: condition boleh null (tidak diketahui); tidak dikirim = good', async () => {
    const unknown = await mkEq({ condition: null });
    expect(unknown.status).toBe(201);
    expect(unknown.body.data.condition).toBeNull();
    const dflt = await request(app).post(`${API}/equipment`).set(bearer(spv)).send({ inventory_code: 'DEF-1', equipment_name: 'Alat Default', equipment_type: 'Umum', room_id: ROOM_B });
    expect(dflt.status).toBe(201);
    expect(dflt.body.data).toMatchObject({ condition: 'good', purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    const upd = await request(app).patch(`${API}/equipment/${dflt.body.data.equipment_id}`).set(bearer(spv)).send({ condition: null });
    expect(upd.status).toBe(200);
    expect(upd.body.data.condition).toBeNull();
    expect((await mkEq({ condition: 'rusak' })).status).toBe(422);
  });

  it('POST/PATCH: inventory_code boleh berspasi tunggal (mis. "INV L-ACT 10-01"); ujung/ganda/awalan salah ditolak', async () => {
    const created = await mkEq({ inventory_code: 'INV L-ACT 10-01' });
    expect(created.status).toBe(201);
    expect(created.body.data.inventory_code).toBe('INV L-ACT 10-01');
    const trimmed = await mkEq({ inventory_code: '  INV L-ACT 10-02  ' }); // di-trim, bukan ditolak
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.data.inventory_code).toBe('INV L-ACT 10-02');
    const dup = await mkEq({ inventory_code: 'INV L-ACT 10-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('inventory_code');
    const upd = await request(app).patch(`${API}/equipment/${created.body.data.equipment_id}`).set(bearer(spv)).send({ inventory_code: 'INV L-ACT 10-09' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.inventory_code).toBe('INV L-ACT 10-09');
    expect((await request(app).patch(`${API}/equipment/${created.body.data.equipment_id}`).set(bearer(spv)).send({ inventory_code: 'INV  L' })).status).toBe(422);
  });

  it('qr_token tidak berubah setelah update dan QR URL stabil', async () => {
    const created = (await mkEq()).body.data;
    const { qr_token, qr_url, equipment_id } = created;

    const upd = await request(app)
      .patch(`${API}/equipment/${equipment_id}`)
      .set(bearer(spv))
      .send({ equipment_name: 'Nama Baru', qr_token: 'HACKED000000', qr_url: 'http://evil' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.qr_token).toBe(qr_token);
    expect(upd.body.data.qr_url).toBe(qr_url);

    // ubah inventory_code & pindah ruangan pun tidak mengubah token/URL
    const upd2 = await request(app).patch(`${API}/equipment/${equipment_id}`).set(bearer(admin)).send({ inventory_code: 'BARU-1', room_id: ROOM_A });
    expect(upd2.status).toBe(200);
    expect(upd2.body.data.inventory_code).toBe('BARU-1');
    expect(upd2.body.data.qr_token).toBe(qr_token);
    expect(upd2.body.data.qr_url).toBe(qr_url);

    const detail = await request(app).get(`${API}/equipment/${equipment_id}`).set(bearer(tech));
    expect(detail.body.data.qr_token).toBe(qr_token);
    expect(detail.body.data.qr_url).toBe(equipmentQrUrl(qr_token));
    expect(fake.equipment.rows.find((r: any) => r.equipment_id === equipment_id).qr_token).toBe(qr_token);

    const a = await request(app).get(`${API}/equipment/${equipment_id}/qr.png`).set(bearer(tech)).buffer(true).parse(binary);
    const b = await request(app).get(`${API}/equipment/${equipment_id}/qr.png`).set(bearer(tech)).buffer(true).parse(binary);
    expect(Buffer.compare(a.body, b.body)).toBe(0);
  });

  it('PATCH: inventory_code ganda 409; body kosong 422; tidak ditemukan 404', async () => {
    const a = (await mkEq({ inventory_code: 'A-1' })).body.data;
    await mkEq({ inventory_code: 'A-2' });
    expect((await request(app).patch(`${API}/equipment/${a.equipment_id}`).set(bearer(spv)).send({ inventory_code: 'A-2' })).status).toBe(409);
    expect((await request(app).patch(`${API}/equipment/${a.equipment_id}`).set(bearer(spv)).send({})).status).toBe(422);
    expect((await request(app).patch(`${API}/equipment/${'99999999-9999-4999-8999-999999999999'}`).set(bearer(spv)).send({ brand: 'X' })).status).toBe(404);
  });

  it('DELETE: soft delete; ditolak jika sedang borrowed (juga ganti status manual)', async () => {
    const e = (await mkEq()).body.data;
    const row = fake.equipment.rows.find((r: any) => r.equipment_id === e.equipment_id);

    row.status = 'borrowed';
    const rejected = await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('EQUIPMENT_BORROWED');
    expect((await request(app).patch(`${API}/equipment/${e.equipment_id}`).set(bearer(spv)).send({ status: 'available' })).status).toBe(409);

    row.status = 'available';
    const ok = await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    expect(ok.status).toBe(200);
    expect(ok.body.data.is_active).toBe(false);
    expect(row).toBeTruthy(); // data tetap ada
    expect((await request(app).get(`${API}/equipment/${e.equipment_id}`).set(bearer(spv))).body.data.is_active).toBe(false);
  });

  it('GET :id: detail (ruangan, active_borrowing null, documents_count); sub-resource 404 untuk id tak dikenal', async () => {
    const e = (await mkEq()).body.data;
    const d = (await request(app).get(`${API}/equipment/${e.equipment_id}`).set(bearer(qa))).body.data;
    expect(d.room.room_id).toBe(ROOM_B);
    expect(d.active_borrowing).toBeNull();
    expect(d.documents_count).toBe(0);
    const ghost = '99999999-9999-4999-8999-999999999999';
    for (const sub of ['borrowings', 'calibrations', 'maintenances', 'documents']) {
      expect((await request(app).get(`${API}/equipment/${ghost}/${sub}`).set(bearer(qa))).status).toBe(404);
    }
  });

  it('aksi tercatat di activity log (CREATE, UPDATE, DELETE)', async () => {
    const e = (await mkEq()).body.data;
    await request(app).patch(`${API}/equipment/${e.equipment_id}`).set(bearer(spv)).send({ brand: 'Memmert' });
    await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    const actions = fake.activityLog.rows.filter((l: any) => l.entity_type === 'equipment').map((l: any) => l.action);
    expect(actions).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });
});

describe('Equipment list & filter', () => {
  beforeEach(async () => {
    await mkEq({ inventory_code: 'F-1', equipment_name: 'Oven Satu', equipment_type: 'Oven', next_calibration_date: day(-1) });
    await mkEq({ inventory_code: 'F-2', equipment_name: 'Oven Dua', equipment_type: 'Oven', status: 'damaged', next_calibration_date: day(10) });
    await mkEq({ inventory_code: 'F-3', equipment_name: 'Timbangan Tiga', equipment_type: 'Timbangan', next_calibration_date: day(100) });
    await mkEq({ inventory_code: 'F-4', equipment_name: 'Timbangan Empat', equipment_type: 'Timbangan' });
  });
  const get = (qs: string) => request(app).get(`${API}/equipment?${qs}`).set(bearer(qa));
  const codes = (r: any) => r.body.data.map((x: any) => x.inventory_code).sort();

  it('filter calibration_state, status, equipment_type, search, is_active', async () => {
    expect(codes(await get('calibration_state=overdue'))).toEqual(['F-1']);
    expect(codes(await get('calibration_state=due_soon'))).toEqual(['F-2']);
    expect(codes(await get('calibration_state=safe'))).toEqual(['F-3']);
    expect(codes(await get('status=damaged'))).toEqual(['F-2']);
    expect(codes(await get('equipment_type=oven'))).toEqual(['F-1', 'F-2']);
    expect(codes(await get('search=timbangan'))).toEqual(['F-3', 'F-4']);
    expect(codes(await get('search=f-2'))).toEqual(['F-2']);
    expect(codes(await get(`room_id=${ROOM_A}`))).toEqual([]);
    expect(codes(await get('is_active=false'))).toEqual([]);
    const f4 = fake.equipment.rows.find((r: any) => r.inventory_code === 'F-4');
    f4.is_active = false;
    expect(codes(await get('is_active=false'))).toEqual(['F-4']);
  });

  it('derived field di list, pagination, sort, validasi query', async () => {
    const r = await get('limit=2&sort=inventory_code&order=asc');
    expect(r.body.meta).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(r.body.data.map((x: any) => x.inventory_code)).toEqual(['F-1', 'F-2']);
    expect(r.body.data[0].calibration_state).toBe('overdue');
    expect((await get('limit=101')).status).toBe(422);
    expect((await get('calibration_state=foo')).status).toBe(422);
    expect((await get('status=rusak')).status).toBe(422);
  });
});

describe('Kapasitas ruangan', () => {
  it('mode block: menolak melebihi kapasitas; kapasitas lepas setelah alat dinonaktifkan', async () => {
    const e1 = (await mkEq({ room_id: ROOM_A })).body.data;
    expect((await mkEq({ room_id: ROOM_A })).status).toBe(201);
    const full = await mkEq({ room_id: ROOM_A });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('ROOM_CAPACITY_EXCEEDED');
    expect(full.body.error.details).toMatchObject({ capacity: 2, used: 2 });

    // ruangan tak terbatas (kapasitas 0) tidak dibatasi
    for (let i = 0; i < 5; i++) expect((await mkEq({ room_id: ROOM_B })).status).toBe(201);

    // pindah ke ruangan penuh ditolak
    const other = (await mkEq({ room_id: ROOM_B })).body.data;
    expect((await request(app).patch(`${API}/equipment/${other.equipment_id}`).set(bearer(spv)).send({ room_id: ROOM_A })).status).toBe(409);

    await request(app).delete(`${API}/equipment/${e1.equipment_id}`).set(bearer(spv));
    expect((await mkEq({ room_id: ROOM_A })).status).toBe(201);

    // mengaktifkan kembali alat di ruangan yang sudah penuh juga ditolak
    expect((await request(app).patch(`${API}/equipment/${e1.equipment_id}`).set(bearer(spv)).send({ is_active: true })).status).toBe(409);
  });

  it('mode warn: tetap tersimpan + peringatan di data.warnings', async () => {
    (env as any).ROOM_CAPACITY_MODE = 'warn';
    await mkEq({ room_id: ROOM_A });
    await mkEq({ room_id: ROOM_A });
    const res = await mkEq({ room_id: ROOM_A });
    expect(res.status).toBe(201);
    expect(res.body.data.warnings[0]).toMatchObject({ code: 'ROOM_CAPACITY_EXCEEDED', capacity: 2, used: 2 });
    const room = await request(app).get(`${API}/rooms/${ROOM_A}`).set(bearer(qa));
    expect(room.body.data.capacity).toMatchObject({ total: 2, used: 3, is_over_capacity: true });
  });
});

describe('Rooms', () => {
  it('CRUD oleh SPV: create, duplikat 409, list dengan kapasitas & sensor, patch, delete', async () => {
    const created = await request(app).post(`${API}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-N', room_name: 'Lab Baru', equipment_capacity: 5 });
    expect(created.status).toBe(201);
    expect(created.body.data.capacity).toMatchObject({ total: 5, used: 0, remaining: 5, is_unlimited: false });
    expect(created.body.data.latest_readings).toEqual([]);
    expect((await request(app).post(`${API}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-N', room_name: 'Lagi' })).status).toBe(409);
    expect((await request(app).post(`${API}/rooms`).set(bearer(spv)).send({ room_code: 'Z', room_name: 'Zz', person_in_charge: '99999999-9999-4999-8999-999999999999' })).status).toBe(422);

    await mkEq({ room_id: created.body.data.room_id });
    const list = await request(app).get(`${API}/rooms?search=lab-n`).set(bearer(tech));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ active_equipment_count: 1 });
    expect(list.body.data[0].capacity).toMatchObject({ used: 1, remaining: 4, usage_percent: 20 });
    expect(list.body.meta.total).toBe(1);

    const id = created.body.data.room_id;
    // kapasitas dikecilkan di bawah jumlah alat aktif → blokir; boleh jika cukup
    await mkEq({ room_id: id });
    expect((await request(app).patch(`${API}/rooms/${id}`).set(bearer(spv)).send({ equipment_capacity: 1 })).status).toBe(409);
    expect((await request(app).patch(`${API}/rooms/${id}`).set(bearer(spv)).send({ equipment_capacity: 3, room_name: 'Lab Baru 2' })).status).toBe(200);

    // ruangan berisi tidak bisa dinonaktifkan
    const del = await request(app).delete(`${API}/rooms/${id}`).set(bearer(spv));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('ROOM_NOT_EMPTY');
  });

  it('ruangan kosong dapat dinonaktifkan (soft delete) dan tersaring is_active', async () => {
    const del = await request(app).delete(`${API}/rooms/${ROOM_B}`).set(bearer(admin));
    expect(del.status).toBe(200);
    expect(del.body.data.is_active).toBe(false);
    const inactive = await request(app).get(`${API}/rooms?is_active=false`).set(bearer(admin));
    expect(inactive.body.data.map((r: any) => r.room_code).sort()).toEqual(['LAB-B', 'LAB-OFF']);
  });
});

describe('Ekspor', () => {
  beforeEach(async () => {
    await mkEq({ inventory_code: 'X-1', equipment_name: '=HYPERLINK("http://x")', status: 'damaged' });
    await mkEq({ inventory_code: 'X-2', equipment_name: 'Alat, dengan koma' });
  });

  it('export.csv: BOM, kolom qr_token & qr_url, filter, ids, sel formula diamankan', async () => {
    const all = await request(app).get(`${API}/equipment/export.csv`).set(bearer(qa));
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toContain('text/csv');
    expect(all.text.charCodeAt(0)).toBe(0xfeff);
    const lines = all.text.slice(1).trim().split('\n');
    expect(lines[0].split(',')).toEqual(expect.arrayContaining(['inventory_code', 'qr_token', 'qr_url', 'room_code']));
    expect(lines).toHaveLength(3);
    expect(all.text).toContain("'=HYPERLINK");
    expect(all.text).toContain('"Alat, dengan koma"');
    expect(all.text).toContain('http://localhost:3001/scan/eq/');

    const damaged = await request(app).get(`${API}/equipment/export.csv?status=damaged`).set(bearer(qa));
    expect(damaged.text.slice(1).trim().split('\n')).toHaveLength(2);

    const id = fake.equipment.rows.find((r: any) => r.inventory_code === 'X-2').equipment_id;
    const one = await request(app).get(`${API}/equipment/export.csv?ids=${id}`).set(bearer(qa));
    expect(one.text).toContain('X-2');
    expect(one.text).not.toContain('X-1');
    expect((await request(app).get(`${API}/equipment/export.csv?ids=bukan-uuid`).set(bearer(qa))).status).toBe(422);
    expect(fake.activityLog.rows.some((l: any) => l.action === 'EXPORT' && l.entity_type === 'equipment')).toBe(true);
  });

  it('export.zip: berisi equipment.csv dan qr/{inventory_code}.png', async () => {
    const res = await request(app).get(`${API}/equipment/export.zip`).set(bearer(qa)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    const buf: Buffer = res.body;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    for (const name of ['equipment.csv', 'qr/X-1.png', 'qr/X-2.png']) expect(buf.includes(Buffer.from(name))).toBe(true);
  });

  it('labels.pdf: kedua layout menghasilkan PDF; id tak dikenal 404; tanpa ids 422', async () => {
    const ids = fake.equipment.rows.map((r: any) => r.equipment_id).join(',');
    for (const layout of ['a4-3x8', 'sticker-50x30']) {
      const res = await request(app).get(`${API}/equipment/labels.pdf?ids=${ids}&layout=${layout}`).set(bearer(qa)).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const ghost = await request(app).get(`${API}/equipment/labels.pdf?ids=99999999-9999-4999-8999-999999999999`).set(bearer(qa));
    expect(ghost.status).toBe(404);
    expect((await request(app).get(`${API}/equipment/labels.pdf`).set(bearer(qa))).status).toBe(422);
    expect((await request(app).get(`${API}/equipment/labels.pdf?ids=${ids}&layout=a5`).set(bearer(qa))).status).toBe(422);
  });

  it('qr.png: PNG valid, ukuran mengikuti ?size, validasi size', async () => {
    const id = fake.equipment.rows[0].equipment_id;
    const res = await request(app).get(`${API}/equipment/${id}/qr.png?size=400`).set(bearer(qa)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const png: Buffer = res.body;
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeGreaterThan(380);
    expect(png.readUInt32BE(16)).toBeLessThanOrEqual(400);
    expect((await request(app).get(`${API}/equipment/${id}/qr.png?size=10`).set(bearer(qa))).status).toBe(422);
  });
});

describe('Impor CSV', () => {
  const HEAD = 'inventory_code,equipment_name,equipment_type,room_code,status,purchase_date,purchase_price';
  const csv = (...rows: string[]) => [HEAD, ...rows].join('\r\n');
  const upload = (content: string, fields: Record<string, string> = {}, token = spv, filename = 'eq.csv') => {
    let r = request(app).post(`${API}/equipment/import`).set(bearer(token)).attach('file', Buffer.from(content), { filename, contentType: 'text/csv' });
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r;
  };
  const MIXED = csv(
    'I-1,Alat Satu,Oven,LAB-B,available,2024-01-31,15000000', // baris 2 valid
    'I-2,Alat Dua,Oven,LAB-B,,,', // baris 3 valid (kolom opsional kosong)
    'I-3,Alat Tiga,Oven,LAB-B,available,31-01-2024,100', // baris 4: tanggal salah
    'I-1,Duplikat,Oven,LAB-B,,,', // baris 5: duplikat di file
    'I-5,Ruang Hantu,Oven,LAB-ZZZ,,,', // baris 6: ruangan tidak ada
    'I-6,Status Aneh,Oven,LAB-B,rusak,,', // baris 7: status tidak valid
  );

  it('kode berspasi (format CSV inventaris nyata) valid; awalan "=" ditolak', async () => {
    const res = await upload(csv(
      'INV L-ACT 10-01,Optical Radiation Test System,Utama,LAB-B,,,', // baris 2
      'INV L-ACT 10-01.01,Goniophotometer,Sub Bagian,LAB-B,,,', // baris 3
      '=INV 1,Formula,Utama,LAB-B,,,', // baris 4
    ), { dry_run: 'false', all_or_nothing: 'false' });
    expect(res.status).toBe(201);
    expect(res.body.data.created.map((c: any) => c.inventory_code)).toEqual(['INV L-ACT 10-01', 'INV L-ACT 10-01.01']);
    expect(res.body.data.errors.find((e: any) => e.row === 4)).toMatchObject({ field: 'inventory_code' });
  });

  it('dry_run (default): melaporkan error per baris, tidak menyimpan apa pun', async () => {
    const res = await upload(MIXED);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ dry_run: true, total_rows: 6, valid_rows: 2, invalid_rows: 4, would_create: 2 });
    const find = (row: number) => d.errors.find((e: any) => e.row === row);
    expect(find(4)).toMatchObject({ field: 'purchase_date' });
    expect(find(5)).toMatchObject({ field: 'inventory_code' });
    expect(find(5).message).toContain('baris 2');
    expect(find(6)).toMatchObject({ field: 'room_code' });
    expect(find(7)).toMatchObject({ field: 'status' });
    expect(fake.equipment.rows).toHaveLength(0);
  });

  it('commit all_or_nothing (default) dengan error → 422, tidak ada data tersimpan', async () => {
    const res = await upload(MIXED, { dry_run: 'false' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(res.body.error.details.errors.length).toBe(4);
    expect(fake.equipment.rows).toHaveLength(0);
  });

  it('commit all_or_nothing=false: simpan baris valid, tiap baris dapat qr_token unik; tercatat di log', async () => {
    const res = await upload(MIXED, { dry_run: 'false', all_or_nothing: 'false' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ created_count: 2, skipped_count: 4, invalid_rows: 4 });
    const tokens = res.body.data.created.map((c: any) => c.qr_token);
    expect(new Set(tokens).size).toBe(2);
    tokens.forEach((t: string) => expect(t).toHaveLength(12));
    expect(res.body.data.created[0].qr_url).toBe(`http://localhost:3001/scan/eq/${tokens[0]}`);
    expect(fake.equipment.rows.map((r: any) => r.inventory_code).sort()).toEqual(['I-1', 'I-2']);
    expect(fake.equipment.rows.find((r: any) => r.inventory_code === 'I-1')).toMatchObject({ status: 'available', purchase_price: 15000000 });
    expect(fake.activityLog.rows.some((l: any) => l.action === 'IMPORT')).toBe(true);

    // impor ulang → kode sudah terdaftar
    const again = await upload(csv('I-1,Alat Satu,Oven,LAB-B'));
    expect(again.body.data.errors[0]).toMatchObject({ row: 2, field: 'inventory_code' });
  });

  it('commit file bersih → 201 (query string juga diterima); BOM didukung', async () => {
    const content = '\uFEFF' + csv('C-1,Satu,Oven,LAB-B', 'C-2,Dua,Oven,LAB-B');
    const res = await request(app)
      .post(`${API}/equipment/import?dry_run=false`)
      .set(bearer(admin))
      .attach('file', Buffer.from(content), { filename: 'x.csv', contentType: 'text/csv' });
    expect(res.status).toBe(201);
    expect(res.body.data.created_count).toBe(2);
    expect(fake.equipment.rows).toHaveLength(2);
  });

  it('kapasitas: block menolak baris yang melebihi; warn memberi peringatan', async () => {
    const three = csv('K-1,Satu,Oven,LAB-A', 'K-2,Dua,Oven,LAB-A', 'K-3,Tiga,Oven,LAB-A');
    const strict = await upload(three, { dry_run: 'false' });
    expect(strict.status).toBe(422);
    expect(fake.equipment.rows).toHaveLength(0);

    const partial = await upload(three, { dry_run: 'false', all_or_nothing: 'false' });
    expect(partial.body.data.created_count).toBe(2);
    expect(partial.body.data.errors[0]).toMatchObject({ row: 4, field: 'room_code' });

    (env as any).ROOM_CAPACITY_MODE = 'warn';
    const warn = await upload(csv('W-1,Satu,Oven,LAB-A'));
    expect(warn.body.data.valid_rows).toBe(1);
    expect(warn.body.data.warnings[0]).toMatchObject({ code: 'ROOM_CAPACITY_EXCEEDED', room_code: 'LAB-A' });
  });

  it('input tidak valid: tanpa file, bukan .csv, header kurang, kosong → 422', async () => {
    expect((await request(app).post(`${API}/equipment/import`).set(bearer(spv))).status).toBe(422);
    expect((await upload('a,b', {}, spv, 'data.txt')).status).toBe(422);
    const noHeader = await upload('inventory_code,equipment_name\r\nA,B');
    expect(noHeader.status).toBe(422);
    expect(noHeader.body.error.code).toBe('INVALID_CSV_HEADER');
    expect((await upload(HEAD)).body.error.code).toBe('CSV_EMPTY');
    expect((await upload(csv('A-1,Satu,Oven,LAB-B'), {}, tech)).status).toBe(403);
  });

  it('import-template.csv memuat semua kolom impor', async () => {
    const res = await request(app).get(`${API}/equipment/import-template.csv`).set(bearer(spv));
    expect(res.status).toBe(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text.slice(1).split('\r\n')[0]).toBe(
      'inventory_code,equipment_name,equipment_type,brand,model,room_code,status,condition,purchase_date,purchase_price,useful_life_years,specifications,next_calibration_date',
    );
  });
});
