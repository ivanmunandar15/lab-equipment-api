/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  const fake = createFakeDb();
  return { getDb: () => fake, disconnectDb: async () => undefined, __fake: fake };
});

import * as dbModule from '../src/config/db';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { assertQuantities, deriveSupportingStatus } from '../src/modules/supporting-equipment/supporting-equipment.derive';
import { DEMO_PASSWORD } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1/supporting-equipment';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const binary = (res: any, cb: (e: Error | null, b?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function login(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
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
    await request(app).post('/api/v1/users').set(bearer(admin)).send({ name, email: `${role.toLowerCase()}@x.local`, role, password: 'Password123' });
  }
  spv = await login('spv@x.local', 'Password123');
  qa = await login('qa@x.local', 'Password123');
});

let seq = 0;
const mk = (over: Record<string, unknown> = {}, token = spv) => {
  seq++;
  return request(app).post(API).set(bearer(token)).send({ item_code: `SP-${seq}`, item_name: `Item ${seq}`, total_quantity: 10, ...over });
};

/** Pinjaman aktif langsung ke fake DB: menyesuaikan available_quantity seperti proses peminjaman. */
function lend(itemId: string, qty: number, returned = 0, status = 'borrowed') {
  const item = fake.supportingEquipment.rows.find((r: any) => r.supporting_equipment_id === itemId);
  if (status === 'borrowed') item.available_quantity -= qty - returned;
  fake.supportingBorrowingDetail.rows.push({
    supporting_equipment_id: itemId,
    borrowing_id: `b-${fake.supportingBorrowingDetail.rows.length}`,
    quantity_borrowed: qty,
    quantity_returned: returned,
    borrowing: {
      borrowing_id: `b-${fake.supportingBorrowingDetail.rows.length}`,
      borrowing_status: status,
      borrowing_time: new Date(Date.now() - 3_600_000),
      expected_return_time: new Date(Date.now() - 60_000), // sudah lewat → overdue
      purpose: 'Praktikum',
      usage_location: 'Lab A',
      user: { user_id: 'u1', name: 'Teknisi', email: 'technician@lab.local' },
    },
  });
}

describe('perhitungan turunan', () => {
  it('status: major_damage → damaged, 0 → borrowed, selain itu available', () => {
    expect(deriveSupportingStatus('good', 5)).toBe('available');
    expect(deriveSupportingStatus('minor_damage', 1)).toBe('available');
    expect(deriveSupportingStatus('good', 0)).toBe('borrowed');
    expect(deriveSupportingStatus('major_damage', 5)).toBe('damaged');
    expect(deriveSupportingStatus('major_damage', 0)).toBe('damaged');
  });
  it('invarian 0 <= available <= total', () => {
    expect(() => assertQuantities(5, 0)).not.toThrow();
    expect(() => assertQuantities(5, 5)).not.toThrow();
    expect(() => assertQuantities(5, -1)).toThrow();
    expect(() => assertQuantities(5, 6)).toThrow();
  });
});

describe('RBAC', () => {
  it('semua role boleh baca; hanya admin/SPV boleh tulis', async () => {
    const item = (await mk()).body.data;
    for (const t of [admin, spv, tech, qa]) expect((await request(app).get(API).set(bearer(t))).status).toBe(200);
    expect((await request(app).get(API)).status).toBe(401);
    for (const t of [tech, qa]) {
      expect((await mk({}, t)).status).toBe(403);
      expect((await request(app).patch(`${API}/${item.supporting_equipment_id}`).set(bearer(t)).send({ item_name: 'Baru' })).status).toBe(403);
      expect((await request(app).delete(`${API}/${item.supporting_equipment_id}`).set(bearer(t))).status).toBe(403);
      expect((await request(app).get(`${API}/import-template.csv`).set(bearer(t))).status).toBe(403);
    }
    expect((await mk({}, admin)).status).toBe(201);
  });
});

describe('CRUD', () => {
  it('create: available = total, status available, qr_url /scan/sp/{token}, field terlarang diabaikan', async () => {
    const res = await mk({ qr_token: 'HACKHACKHACK', available_quantity: 1, status: 'borrowed', total_quantity: 12 });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({ total_quantity: 12, available_quantity: 12, borrowed_quantity: 0, status: 'available', unit: 'pcs', condition: 'good', is_active: true });
    expect(d.qr_token).toHaveLength(12);
    expect(d.qr_token).not.toBe('HACKHACKHACK');
    expect(d.qr_url).toBe(`${env.APP_URL.replace(/\/+$/, '')}/scan/sp/${d.qr_token}`);
    expect(d.password_hash).toBeUndefined();
    expect(fake.activityLog.rows.some((l: any) => l.action === 'CREATE' && l.entity_type === 'supporting_equipment')).toBe(true);
  });

  it('create: kondisi major_damage → status damaged; validasi 422; item_code ganda 409', async () => {
    expect((await mk({ condition: 'major_damage' })).body.data.status).toBe('damaged');
    for (const bad of [{ total_quantity: 0 }, { total_quantity: -3 }, { total_quantity: 1.5 }, { total_quantity: '5' }, { item_name: 'x' }, { condition: 'rusak' }, { item_code: 'a  b' }, { item_code: '-ab' }]) {
      expect((await mk(bad)).status).toBe(422);
    }
    const first = (await mk({ item_code: 'DUP-1' })).body.data;
    expect(first.item_code).toBe('DUP-1');
    const dup = await mk({ item_code: 'DUP-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({ field: 'item_code' });
  });

  it('list: pagination, filter status/kondisi/is_active, search, sort', async () => {
    await mk({ item_code: 'A-1', item_name: 'Beaker', item_type: 'Glassware', total_quantity: 5 });
    await mk({ item_code: 'A-2', item_name: 'Spatula', item_type: 'Tool', total_quantity: 20 });
    await mk({ item_code: 'A-3', item_name: 'Pipet Rusak', item_type: 'Glassware', condition: 'major_damage' });
    const get = (qs: string) => request(app).get(`${API}?${qs}`).set(bearer(qa));

    const all = await get('limit=2&sort=total_quantity&order=asc');
    expect(all.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(all.body.data[0].item_code).toBe('A-1');
    expect((await get('status=damaged')).body.meta.total).toBe(1);
    expect((await get('item_type=glassware')).body.meta.total).toBe(2);
    expect((await get('search=spat')).body.data[0].item_code).toBe('A-2');
    expect((await get('is_active=false')).body.meta.total).toBe(0);
    expect((await get('limit=101')).status).toBe(422);
    expect((await get('status=maintenance')).status).toBe(422);
  });

  it('update total_quantity: available ikut selisih; status mengikuti', async () => {
    const id = (await mk({ total_quantity: 10 })).body.data.supporting_equipment_id;
    lend(id, 4); // available 6
    const up = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ total_quantity: 15, qr_token: 'XXXXXXXXXXXX', available_quantity: 1 });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ total_quantity: 15, available_quantity: 11, borrowed_quantity: 4, status: 'available' });
    const down = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ total_quantity: 8 });
    expect(down.body.data).toMatchObject({ total_quantity: 8, available_quantity: 4 });
    // total == jumlah dipinjam → available 0 → borrowed
    const edge = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ total_quantity: 4 });
    expect(edge.status).toBe(200);
    expect(edge.body.data).toMatchObject({ total_quantity: 4, available_quantity: 0, status: 'borrowed' });
    // qr_token tidak pernah berubah
    const row = fake.supportingEquipment.rows[0];
    expect(row.qr_token).not.toBe('XXXXXXXXXXXX');
  });

  it('update total_quantity < jumlah dipinjam → 409 QUANTITY_BELOW_BORROWED, data tidak berubah', async () => {
    const id = (await mk({ total_quantity: 10 })).body.data.supporting_equipment_id;
    lend(id, 6); // available 4
    lend(id, 2, 1); // outstanding 1 lagi → total dipinjam 7, available 3
    const res = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ total_quantity: 6 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUANTITY_BELOW_BORROWED');
    expect(res.body.error.details).toMatchObject({ borrowed_quantity: 7, total_quantity: 6 });
    expect(fake.supportingEquipment.rows[0]).toMatchObject({ total_quantity: 10, available_quantity: 3 });
    expect((await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ total_quantity: 7 })).status).toBe(200);
  });

  it('update kondisi menurunkan status; kembali normal → available/borrowed sesuai stok', async () => {
    const id = (await mk({ total_quantity: 3 })).body.data.supporting_equipment_id;
    const bad = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ condition: 'major_damage' });
    expect(bad.body.data.status).toBe('damaged');
    const good = await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ condition: 'good' });
    expect(good.body.data.status).toBe('available');
    expect((await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({})).status).toBe(422);
    expect((await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ status: 'borrowed' })).status).toBe(422); // field diabaikan → body kosong
    expect((await request(app).patch(`${API}/99999999-9999-4999-8999-999999999999`).set(bearer(spv)).send({ item_name: 'Zzz' })).status).toBe(404);
    expect((await request(app).patch(`${API}/xyz`).set(bearer(spv)).send({ item_name: 'Zzz' })).status).toBe(422);
  });

  it('update item_code ganda → 409', async () => {
    await mk({ item_code: 'X-1' });
    const id = (await mk({ item_code: 'X-2' })).body.data.supporting_equipment_id;
    expect((await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ item_code: 'X-1' })).status).toBe(409);
  });

  it('detail: menyertakan daftar pinjaman aktif (siapa, berapa); pinjaman selesai tidak ikut', async () => {
    const id = (await mk({ total_quantity: 10 })).body.data.supporting_equipment_id;
    lend(id, 3, 1);
    lend(id, 2, 0, 'returned');
    lend(id, 2, 2); // aktif tapi sudah kembali penuh → tidak ditampilkan
    const res = await request(app).get(`${API}/${id}`).set(bearer(qa));
    expect(res.status).toBe(200);
    expect(res.body.data.borrowed_quantity).toBe(2);
    expect(res.body.data.active_borrowings).toHaveLength(1);
    expect(res.body.data.active_borrowings[0]).toMatchObject({
      quantity_borrowed: 3,
      quantity_returned: 1,
      quantity_outstanding: 2,
      is_overdue: true,
      user: { name: 'Teknisi' },
    });
    expect((await request(app).get(`${API}/99999999-9999-4999-8999-999999999999`).set(bearer(qa))).status).toBe(404);
  });

  it('soft delete: ditolak 409 saat masih dipinjam; berhasil jika tidak; data tetap ada', async () => {
    const id = (await mk()).body.data.supporting_equipment_id;
    lend(id, 2);
    const blocked = await request(app).delete(`${API}/${id}`).set(bearer(spv));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ITEM_BORROWED');
    expect((await request(app).patch(`${API}/${id}`).set(bearer(spv)).send({ is_active: false })).status).toBe(409);

    const free = (await mk()).body.data.supporting_equipment_id;
    const del = await request(app).delete(`${API}/${free}`).set(bearer(spv));
    expect(del.status).toBe(200);
    expect(del.body.data.is_active).toBe(false);
    expect(fake.supportingEquipment.rows.some((r: any) => r.supporting_equipment_id === free && !r.is_active)).toBe(true);
    expect(fake.activityLog.rows.some((l: any) => l.action === 'DELETE' && l.entity_type === 'supporting_equipment')).toBe(true);
    expect((await request(app).get(`${API}?is_active=false`).set(bearer(qa))).body.meta.total).toBe(1);
  });
});

describe('QR, ekspor, label', () => {
  beforeEach(async () => {
    await mk({ item_code: 'X-1', item_name: 'Beaker, "250"' });
    await mk({ item_code: '=SUM(1)', item_name: 'Formula' }); // item_code ditolak regex → 422, tidak masuk
    await mk({ item_code: 'X-2', item_name: '=HYPERLINK("x")' });
  });

  it('qr.png: PNG valid; size divalidasi', async () => {
    const id = fake.supportingEquipment.rows[0].supporting_equipment_id;
    const res = await request(app).get(`${API}/${id}/qr.png?size=400`).set(bearer(qa)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((res.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    expect((await request(app).get(`${API}/${id}/qr.png?size=10`).set(bearer(qa))).status).toBe(422);
    expect((await request(app).get(`${API}/99999999-9999-4999-8999-999999999999/qr.png`).set(bearer(qa))).status).toBe(404);
  });

  it('export.csv: BOM, kolom lengkap, anti formula injection, filter ids, tercatat EXPORT', async () => {
    const res = await request(app).get(`${API}/export.csv`).set(bearer(qa));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    for (const c of ['item_code', 'total_quantity', 'available_quantity', 'borrowed_quantity', 'qr_url']) expect(res.text).toContain(c);
    expect(res.text).toContain("'=HYPERLINK");
    const id = fake.supportingEquipment.rows[0].supporting_equipment_id;
    const one = await request(app).get(`${API}/export.csv?ids=${id}`).set(bearer(qa));
    expect(one.text).toContain('X-1');
    expect(one.text).not.toContain('X-2');
    expect((await request(app).get(`${API}/export.csv?ids=bukan-uuid`).set(bearer(qa))).status).toBe(422);
    expect(fake.activityLog.rows.some((l: any) => l.action === 'EXPORT' && l.entity_type === 'supporting_equipment')).toBe(true);
  });

  it('export.zip: berisi supporting-equipment.csv dan qr/{item_code}.png', async () => {
    const res = await request(app).get(`${API}/export.zip`).set(bearer(qa)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    const buf: Buffer = res.body;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    for (const name of ['supporting-equipment.csv', 'qr/X-1.png', 'qr/X-2.png']) expect(buf.includes(Buffer.from(name))).toBe(true);
  });

  it('labels.pdf: kedua layout PDF; id tak dikenal 404; tanpa ids / layout salah 422', async () => {
    const ids = fake.supportingEquipment.rows.map((r: any) => r.supporting_equipment_id).join(',');
    for (const layout of ['a4-3x8', 'sticker-50x30']) {
      const res = await request(app).get(`${API}/labels.pdf?ids=${ids}&layout=${layout}`).set(bearer(qa)).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await request(app).get(`${API}/labels.pdf?ids=99999999-9999-4999-8999-999999999999`).set(bearer(qa))).status).toBe(404);
    expect((await request(app).get(`${API}/labels.pdf`).set(bearer(qa))).status).toBe(422);
    expect((await request(app).get(`${API}/labels.pdf?ids=${ids}&layout=a5`).set(bearer(qa))).status).toBe(422);
  });
});

describe('Impor CSV', () => {
  const HEAD = 'item_code,item_name,item_type,unit,total_quantity,condition';
  const csv = (...rows: string[]) => [HEAD, ...rows].join('\r\n');
  const upload = (content: string, fields: Record<string, string> = {}, token = spv) => {
    let r = request(app).post(`${API}/import`).set(bearer(token)).attach('file', Buffer.from(content), { filename: 'sp.csv', contentType: 'text/csv' });
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r;
  };
  const MIXED = csv(
    'I-1,Beaker,Glassware,pcs,40,good', // 2 valid
    'I-2,Spatula,,,25,', // 3 valid (kolom opsional kosong)
    'I-3,Pipet,Glassware,pcs,0,good', // 4: jumlah 0
    'I-1,Duplikat,,,5,', // 5: duplikat di file
    'I-5,Rusak,,pcs,abc,good', // 6: jumlah bukan angka
    'I-6,Aneh,,pcs,5,rusak', // 7: kondisi salah
  );

  it('dry_run (default): laporan error per baris, tidak menyimpan', async () => {
    const res = await upload(MIXED);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ dry_run: true, total_rows: 6, valid_rows: 2, invalid_rows: 4, would_create: 2 });
    const find = (row: number) => d.errors.find((e: any) => e.row === row);
    expect(find(4)).toMatchObject({ field: 'total_quantity' });
    expect(find(5)).toMatchObject({ field: 'item_code' });
    expect(find(6)).toMatchObject({ field: 'total_quantity' });
    expect(find(7)).toMatchObject({ field: 'condition' });
    expect(fake.supportingEquipment.rows).toHaveLength(0);
  });

  it('all_or_nothing (default) menolak seluruh impor jika ada baris salah', async () => {
    const res = await upload(MIXED, { dry_run: 'false' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(fake.supportingEquipment.rows).toHaveLength(0);
  });

  it('commit parsial (all_or_nothing=false): hanya baris valid; available = total; status turunan', async () => {
    const res = await upload(MIXED + '\r\nI-9,Rusak Berat,,pcs,3,major_damage', { dry_run: 'false', all_or_nothing: 'false' }, admin);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ created_count: 3, skipped_count: 4 });
    expect(res.body.data.created[0].qr_url).toContain('/scan/sp/');
    const rows = fake.supportingEquipment.rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.available_quantity).toBe(r.total_quantity);
      expect(r.qr_token).toHaveLength(12);
    }
    expect(rows.find((r: any) => r.item_code === 'I-9').status).toBe('damaged');
    expect(rows.find((r: any) => r.item_code === 'I-2')).toMatchObject({ unit: 'pcs', condition: 'good', status: 'available' });
    expect(fake.activityLog.rows.filter((l: any) => l.action === 'IMPORT')).toHaveLength(1);

    const again = await upload(csv('I-1,Beaker,,pcs,5,good'));
    expect(again.body.data.errors[0]).toMatchObject({ row: 2, field: 'item_code' });
  });

  it('header/file tidak valid → 422; file wajib; template memuat semua kolom', async () => {
    expect((await upload('item_code,item_name\r\nA,B')).body.error.code).toBe('INVALID_CSV_HEADER');
    expect((await upload(HEAD)).body.error.code).toBe('CSV_EMPTY');
    expect((await request(app).post(`${API}/import`).set(bearer(spv))).status).toBe(422);
    const tpl = await request(app).get(`${API}/import-template.csv`).set(bearer(spv));
    expect(tpl.status).toBe(200);
    for (const c of ['item_code', 'item_name', 'total_quantity', 'condition']) expect(tpl.text).toContain(c);
  });
});
