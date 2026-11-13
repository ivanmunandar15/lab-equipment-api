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
import { DEMO_PASSWORD, ROOM_B } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function login(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password });
  return res.body.data.access_token as string;
}

let admin: string, spv: string, tech: string, qa: string;
let techId: string;

beforeEach(async () => {
  await fake.reset();
  admin = await login('admin@lab.local');
  tech = await login('technician@lab.local');
  for (const [name, role] of [['SPV', 'SPV'], ['QA', 'QA']] as const) {
    await request(app).post(`${API}/users`).set(bearer(admin)).send({ name, email: `${role.toLowerCase()}@x.local`, role, password: 'Password123' });
  }
  spv = await login('spv@x.local', 'Password123');
  qa = await login('qa@x.local', 'Password123');
  techId = fake.user.rows.find((u: any) => u.email === 'technician@lab.local').user_id;
});

afterEach(() => {
  (env as any).CALIBRATION_OVERDUE_POLICY = 'warn';
});

let seq = 0;
async function mkEq(over: Record<string, unknown> = {}) {
  seq++;
  const res = await request(app).post(`${API}/equipment`).set(bearer(spv)).send({ inventory_code: `EQ-${seq}`, equipment_name: `Alat ${seq}`, equipment_type: 'Oven', room_id: ROOM_B, ...over });
  return res.body.data;
}
async function mkSp(over: Record<string, unknown> = {}) {
  seq++;
  const res = await request(app).post(`${API}/supporting-equipment`).set(bearer(spv)).send({ item_code: `SP-${seq}`, item_name: `Barang ${seq}`, total_quantity: 10, ...over });
  return res.body.data;
}
const borrow = (token: string, body: Record<string, unknown>) =>
  request(app).post(`${API}/borrowings`).set(bearer(token)).send({ purpose: 'Praktikum kimia', expected_return_time: inHours(24), ...body });
const eqRow = (id: string) => fake.equipment.rows.find((r: any) => r.equipment_id === id);
const spRow = (id: string) => fake.supportingEquipment.rows.find((r: any) => r.supporting_equipment_id === id);

describe('POST /borrowings', () => {
  it('sukses: alat → borrowed, stok berkurang, detail + initial_condition, user dari token, activity log', async () => {
    const e1 = await mkEq({ condition: 'minor_damage' });
    const e2 = await mkEq();
    const s1 = await mkSp({ total_quantity: 10 });
    const s2 = await mkSp({ total_quantity: 4 });
    const res = await borrow(tech, {
      usage_location: 'Lab A',
      equipment: [{ equipment_id: e1.equipment_id }, { qr_token: e2.qr_token }],
      supporting: [{ supporting_equipment_id: s1.supporting_equipment_id, quantity: 3 }, { qr_token: s2.qr_token, quantity: 4 }],
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({ borrowing_status: 'borrowed', user_id: techId, is_overdue: false, can_return: true });
    expect(d.summary).toMatchObject({ equipment_total: 2, supporting_total: 2, supporting_units_outstanding: 7 });
    expect(d.equipment.map((i: any) => i.initial_condition).sort()).toEqual(['good', 'minor_damage']);
    expect(eqRow(e1.equipment_id).status).toBe('borrowed');
    expect(eqRow(e2.equipment_id).status).toBe('borrowed');
    expect(spRow(s1.supporting_equipment_id)).toMatchObject({ available_quantity: 7, status: 'available' });
    expect(spRow(s2.supporting_equipment_id)).toMatchObject({ available_quantity: 0, status: 'borrowed' }); // habis → borrowed
    expect(fake.activityLog.rows.some((l: any) => l.action === 'BORROW' && l.entity_type === 'borrowing' && l.entity_id === d.borrowing_id)).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it('semua-atau-tidak-sama-sekali: satu item bermasalah → 409 + daftar item, tidak ada perubahan', async () => {
    const ok1 = await mkEq();
    const busy = await mkEq();
    const damaged = await mkEq({ status: 'damaged' });
    const sp = await mkSp({ total_quantity: 2 });
    const first = await borrow(qa, { equipment: [{ equipment_id: busy.equipment_id }] });
    expect(first.status).toBe(201);

    const res = await borrow(tech, {
      equipment: [{ equipment_id: ok1.equipment_id }, { equipment_id: busy.equipment_id }, { equipment_id: damaged.equipment_id }, { qr_token: 'TidakAda1234' }],
      supporting: [{ supporting_equipment_id: sp.supporting_equipment_id, quantity: 5 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BORROWING_CONFLICT');
    const items = res.body.error.details.items;
    const reasons = Object.fromEntries(items.map((i: any) => [`${i.type}:${i.index}`, i.reason]));
    expect(reasons).toEqual({ 'equipment:1': 'NOT_AVAILABLE', 'equipment:2': 'NOT_AVAILABLE', 'equipment:3': 'NOT_FOUND', 'supporting:0': 'INSUFFICIENT_STOCK' });
    expect(items.find((i: any) => i.type === 'supporting').available).toBe(2);
    expect(eqRow(ok1.equipment_id).status).toBe('available'); // tidak ikut terpinjam
    expect(spRow(sp.supporting_equipment_id).available_quantity).toBe(2);
    expect(fake.borrowing.rows).toHaveLength(1);
  });

  it('alat nonaktif ditolak; kalibrasi terlambat: warn → boleh + warnings, block → 409', async () => {
    const off = await mkEq();
    await request(app).delete(`${API}/equipment/${off.equipment_id}`).set(bearer(spv));
    const r1 = await borrow(tech, { equipment: [{ equipment_id: off.equipment_id }] });
    expect(r1.body.error.details.items[0].reason).toBe('INACTIVE');

    const late = await mkEq({ next_calibration_date: day(-3) });
    const warn = await borrow(tech, { equipment: [{ equipment_id: late.equipment_id }] });
    expect(warn.status).toBe(201);
    expect(warn.body.data.warnings[0]).toMatchObject({ code: 'calibration_overdue', equipment_id: late.equipment_id });

    const late2 = await mkEq({ next_calibration_date: day(-3) });
    (env as any).CALIBRATION_OVERDUE_POLICY = 'block';
    const blocked = await borrow(tech, { equipment: [{ equipment_id: late2.equipment_id }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.items[0].reason).toBe('CALIBRATION_OVERDUE');
  });

  it('validasi 422: kosong, duplikat, id+token bersamaan, waktu lampau, quantity <= 0', async () => {
    const e = await mkEq();
    const s = await mkSp();
    const post = (b: Record<string, unknown>) => borrow(tech, b);
    expect((await post({})).status).toBe(422);
    expect((await post({ equipment: [{ equipment_id: e.equipment_id }, { qr_token: e.qr_token }] })).status).toBe(422); // duplikat
    expect((await post({ equipment: [{ equipment_id: e.equipment_id, qr_token: e.qr_token }] })).status).toBe(422);
    expect((await post({ equipment: [{}] })).status).toBe(422);
    expect((await post({ equipment: [{ equipment_id: e.equipment_id }], expected_return_time: inHours(-1) })).status).toBe(422);
    expect((await post({ equipment: [{ equipment_id: e.equipment_id }], expected_return_time: 'besok' })).status).toBe(422);
    expect((await post({ supporting: [{ supporting_equipment_id: s.supporting_equipment_id, quantity: 0 }] })).status).toBe(422);
    expect((await post({ supporting: [{ qr_token: s.qr_token, quantity: 1 }, { supporting_equipment_id: s.supporting_equipment_id, quantity: 1 }] })).status).toBe(422);
    expect(eqRow(e.equipment_id).status).toBe('available');
    expect((await request(app).post(`${API}/borrowings`).send({})).status).toBe(401);
  });

  it('KONKURENSI: dua permintaan serentak untuk alat yang sama → hanya satu berhasil', async () => {
    const e = await mkEq();
    const [a, b] = await Promise.all([
      borrow(tech, { equipment: [{ equipment_id: e.equipment_id }] }),
      borrow(qa, { equipment: [{ qr_token: e.qr_token }] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('BORROWING_CONFLICT');
    expect(fake.borrowing.rows).toHaveLength(1);
    expect(fake.borrowingDetail.rows).toHaveLength(1);
    expect(eqRow(e.equipment_id).status).toBe('borrowed');
  });

  it('KONKURENSI: stok barang pendukung tidak pernah negatif (6 + 6 dari stok 10)', async () => {
    const s = await mkSp({ total_quantity: 10 });
    const req = (t: string) => borrow(t, { supporting: [{ supporting_equipment_id: s.supporting_equipment_id, quantity: 6 }] });
    const [a, b] = await Promise.all([req(tech), req(qa)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(spRow(s.supporting_equipment_id).available_quantity).toBe(4);
    expect(fake.supportingBorrowingDetail.rows).toHaveLength(1);
  });

  it('KONKURENSI: 5 permintaan serentak, alat sama → tepat satu sukses', async () => {
    const e = await mkEq();
    const tokens = [admin, spv, tech, qa, admin];
    const results = await Promise.all(tokens.map((t) => borrow(t, { equipment: [{ equipment_id: e.equipment_id }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(fake.borrowing.rows).toHaveLength(1);
  });
});

describe('Pengembalian', () => {
  async function setup() {
    const e1 = await mkEq();
    const e2 = await mkEq();
    const s1 = await mkSp({ total_quantity: 10 });
    const b = (await borrow(tech, {
      equipment: [{ equipment_id: e1.equipment_id }, { equipment_id: e2.equipment_id }],
      supporting: [{ supporting_equipment_id: s1.supporting_equipment_id, quantity: 6 }],
    })).body.data;
    const d1 = b.equipment.find((i: any) => i.equipment.equipment_id === e1.equipment_id).detail_id;
    const d2 = b.equipment.find((i: any) => i.equipment.equipment_id === e2.equipment_id).detail_id;
    return { e1, e2, s1, b, d1, d2, sd: b.supporting[0].supporting_detail_id };
  }
  const ret = (token: string, id: string, body: Record<string, unknown>) => request(app).post(`${API}/borrowings/${id}/return`).set(bearer(token)).send(body);

  it('sebagian: alat 1 + sebagian stok → belum selesai; sisanya → selesai + actual_return_time', async () => {
    const { e1, e2, s1, b, d1, d2, sd } = await setup();
    const p1 = await ret(tech, b.borrowing_id, { items: [{ detail_id: d1, final_condition: 'minor_damage' }], supporting: [{ supporting_detail_id: sd, quantity_returned: 2 }] });
    expect(p1.status).toBe(200);
    expect(p1.body.data).toMatchObject({ completed: false, borrowing_status: 'borrowed', actual_return_time: null, damage_reported: false });
    expect(eqRow(e1.equipment_id)).toMatchObject({ status: 'available', condition: 'minor_damage' });
    expect(eqRow(e2.equipment_id).status).toBe('borrowed');
    expect(spRow(s1.supporting_equipment_id).available_quantity).toBe(6); // 4 + 2
    expect(p1.body.data.supporting[0]).toMatchObject({ quantity_returned: 2, quantity_outstanding: 4, is_returned: false });

    const p2 = await ret(tech, b.borrowing_id, { items: [{ detail_id: d2, final_condition: 'good' }], supporting: [{ supporting_detail_id: sd, quantity_returned: 4 }] });
    expect(p2.body.data).toMatchObject({ completed: true, borrowing_status: 'returned', can_return: false });
    expect(p2.body.data.actual_return_time).toBeTruthy();
    expect(spRow(s1.supporting_equipment_id)).toMatchObject({ available_quantity: 10, status: 'available' });
    expect(fake.activityLog.rows.filter((l: any) => l.action === 'RETURN')).toHaveLength(2);
    expect(fake.notification.rows).toHaveLength(0);

    const again = await ret(tech, b.borrowing_id, { items: [{ detail_id: d1, final_condition: 'good' }] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BORROWING_ALREADY_RETURNED');
  });

  it('kerusakan: alat → damaged, notifikasi hanya ke SPV & technician aktif, stok tetap bertambah', async () => {
    const { e1, e2, s1, b, d1, d2, sd } = await setup();
    const res = await ret(tech, b.borrowing_id, {
      items: [{ detail_id: d1, final_condition: 'major_damage', damage_notes: 'Layar pecah' }, { detail_id: d2, final_condition: 'minor_damage', has_damage: true }],
      supporting: [{ supporting_detail_id: sd, quantity_returned: 6, final_condition: 'minor_damage', has_damage: true, damage_notes: '2 pecah' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ completed: true, damage_reported: true });
    expect(eqRow(e1.equipment_id)).toMatchObject({ status: 'damaged', condition: 'major_damage' });
    expect(eqRow(e2.equipment_id)).toMatchObject({ status: 'damaged', condition: 'minor_damage' });
    expect(spRow(s1.supporting_equipment_id).available_quantity).toBe(10);
    const detail = res.body.data.equipment.find((i: any) => i.detail_id === d1);
    expect(detail).toMatchObject({ has_damage: true, damage_notes: 'Layar pecah', is_returned: true });
    const rcpt = fake.notification.rows.map((n: any) => fake.user.rows.find((u: any) => u.user_id === n.user_id).role).sort();
    expect(rcpt).toEqual(['SPV', 'technician']);
    expect(fake.notification.rows[0]).toMatchObject({ notification_type: 'maintenance', borrowing_id: b.borrowing_id, is_read: false });
  });

  it('siapa yang boleh: peminjam, admin, SPV; QA (bukan peminjam) 403', async () => {
    const { b, d1 } = await setup();
    const body = { items: [{ detail_id: d1, final_condition: 'good' }] };
    expect((await ret(qa, b.borrowing_id, body)).status).toBe(403);
    expect((await ret(spv, b.borrowing_id, body)).status).toBe(200);
    const s2 = await setup();
    expect((await ret(admin, s2.b.borrowing_id, { items: [{ detail_id: s2.d1, final_condition: 'good' }] })).status).toBe(200);
    const detail = await request(app).get(`${API}/borrowings/${s2.b.borrowing_id}`).set(bearer(qa));
    expect(detail.body.data.can_return).toBe(false);
  });

  it('penolakan: detail asing, sudah kembali, jumlah melebihi sisa, kondisi tidak konsisten, kosong → tidak ada perubahan', async () => {
    const { e2, s1, b, d1, d2, sd } = await setup();
    await ret(tech, b.borrowing_id, { items: [{ detail_id: d1, final_condition: 'good' }] });

    const bad = await ret(tech, b.borrowing_id, {
      items: [{ detail_id: d1, final_condition: 'good' }, { detail_id: '99999999-9999-4999-8999-999999999999', final_condition: 'good' }, { detail_id: d2, final_condition: 'good' }],
      supporting: [{ supporting_detail_id: sd, quantity_returned: 7 }],
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('RETURN_CONFLICT');
    expect(bad.body.error.details.items.map((i: any) => i.reason).sort()).toEqual(['ALREADY_RETURNED', 'NOT_IN_BORROWING', 'QUANTITY_EXCEEDS_OUTSTANDING']);
    expect(eqRow(e2.equipment_id).status).toBe('borrowed'); // d2 valid tapi tidak ikut diproses
    expect(spRow(s1.supporting_equipment_id).available_quantity).toBe(4);

    expect((await ret(tech, b.borrowing_id, { items: [{ detail_id: d2, final_condition: 'good', has_damage: true }] })).status).toBe(422);
    expect((await ret(tech, b.borrowing_id, {})).status).toBe(422);
    expect((await ret(tech, '99999999-9999-4999-8999-999999999999', { items: [{ detail_id: d2, final_condition: 'good' }] })).status).toBe(404);
  });
});

describe('POST /equipment/:id/report-damage', () => {
  const report = (token: string, id: string, body: Record<string, unknown> = { notes: 'Kabel terkelupas' }) =>
    request(app).post(`${API}/equipment/${id}/report-damage`).set(bearer(token)).send(body);

  it('semua role boleh; status → damaged, kondisi, notifikasi ke SPV/technician, activity log', async () => {
    const e = await mkEq();
    const res = await report(qa, e.equipment_id, { notes: 'Kabel terkelupas', condition: 'minor_damage' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'damaged', condition: 'minor_damage' });
    expect(fake.notification.rows).toHaveLength(2);
    expect(fake.notification.rows[0].message).toContain('Kabel terkelupas');
    const log = fake.activityLog.rows.find((l: any) => l.action === 'REPORT_DAMAGE');
    expect(log).toMatchObject({ entity_type: 'equipment', entity_id: e.equipment_id });
    expect(log.old_data.status).toBe('available');
  });

  it('ditolak: sedang dipinjam (409), sudah rusak (409), nonaktif (409), catatan kosong (422), tidak ada (404)', async () => {
    const e = await mkEq();
    await borrow(tech, { equipment: [{ equipment_id: e.equipment_id }] });
    expect((await report(qa, e.equipment_id)).body.error.code).toBe('EQUIPMENT_BORROWED');
    const d = await mkEq({ status: 'damaged' });
    expect((await report(qa, d.equipment_id)).body.error.code).toBe('ALREADY_DAMAGED');
    const off = await mkEq();
    await request(app).delete(`${API}/equipment/${off.equipment_id}`).set(bearer(spv));
    expect((await report(qa, off.equipment_id)).body.error.code).toBe('EQUIPMENT_INACTIVE');
    const ok = await mkEq();
    expect((await report(qa, ok.equipment_id, { notes: '' })).status).toBe(422);
    expect((await report(qa, '99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect(fake.notification.rows).toHaveLength(0);
  });
});

describe('GET /scan', () => {
  const scanEq = (token: string, qr: string) => request(app).get(`${API}/scan/eq/${qr}`).set(bearer(token));
  const scanSp = (token: string, qr: string) => request(app).get(`${API}/scan/sp/${qr}`).set(bearer(token));

  it('alat tersedia: borrow + report_damage, tanpa cache, wajib login', async () => {
    const e = await mkEq({ next_calibration_date: day(100) });
    const res = await scanEq(qa, e.qr_token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ type: 'equipment', status: 'available', condition: 'good', calibration_state: 'safe', reason: null, warnings: [], active_borrowing: null });
    expect(res.body.data.available_actions).toEqual(['borrow', 'report_damage']);
    expect(res.body.data.qr_token).toBe(e.qr_token);
    expect((await request(app).get(`${API}/scan/eq/${e.qr_token}`)).status).toBe(401);
  });

  it('data selalu terbaru (tidak di-cache): status berubah setelah dipinjam', async () => {
    const e = await mkEq();
    expect((await scanEq(tech, e.qr_token)).body.data.status).toBe('available');
    await borrow(tech, { equipment: [{ equipment_id: e.equipment_id }] });
    expect((await scanEq(tech, e.qr_token)).body.data.status).toBe('borrowed');
  });

  it('alat dipinjam: peminjam & admin/SPV dapat return; role lain [] + reason; overdue ditandai', async () => {
    const e = await mkEq();
    await borrow(tech, { equipment: [{ equipment_id: e.equipment_id }] });
    const mine = (await scanEq(tech, e.qr_token)).body.data;
    expect(mine.available_actions).toEqual(['return']);
    expect(mine.active_borrowing).toMatchObject({ user: { name: 'Teknisi' }, is_overdue: false, can_return: true });
    expect(mine.active_borrowing.detail_id).toBeTruthy();
    expect((await scanEq(spv, e.qr_token)).body.data.available_actions).toEqual(['return']);
    const other = (await scanEq(qa, e.qr_token)).body.data;
    expect(other.available_actions).toEqual([]);
    expect(other.reason).toContain('Teknisi');
    expect(other.active_borrowing.can_return).toBe(false);

    fake.borrowing.rows[0].expected_return_time = new Date(Date.now() - 3_600_000);
    expect((await scanEq(tech, e.qr_token)).body.data.active_borrowing.is_overdue).toBe(true);
  });

  it('status lain: damaged/maintenance/calibration → reason; kalibrasi terlambat → warnings; policy block', async () => {
    const dmg = await mkEq({ status: 'damaged' });
    const r1 = (await scanEq(tech, dmg.qr_token)).body.data;
    expect(r1.available_actions).toEqual([]);
    expect(r1.reason).toBeTruthy();
    const mt = await mkEq({ status: 'maintenance' });
    const r2 = (await scanEq(tech, mt.qr_token)).body.data;
    expect(r2.available_actions).toEqual(['report_damage']);
    expect(r2.reason).toContain('maintenance');

    const late = await mkEq({ next_calibration_date: day(-5) });
    const r3 = (await scanEq(tech, late.qr_token)).body.data;
    expect(r3).toMatchObject({ calibration_state: 'overdue', warnings: ['calibration_overdue'] });
    expect(r3.available_actions).toContain('borrow');
    (env as any).CALIBRATION_OVERDUE_POLICY = 'block';
    const r4 = (await scanEq(tech, late.qr_token)).body.data;
    expect(r4.available_actions).toEqual(['report_damage']);
    expect(r4.reason).toContain('Kalibrasi');
  });

  it('404 token tidak dikenal; 410 nonaktif; 422 token tak valid', async () => {
    expect((await scanEq(tech, 'TidakAda1234')).status).toBe(404);
    expect((await scanSp(tech, 'TidakAda1234')).status).toBe(404);
    const e = await mkEq();
    await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    const gone = await scanEq(tech, e.qr_token);
    expect(gone.status).toBe(410);
    expect(gone.body.error.message).toBe('Alat sudah dinonaktifkan');
    const s = await mkSp();
    await request(app).delete(`${API}/supporting-equipment/${s.supporting_equipment_id}`).set(bearer(spv));
    expect((await scanSp(tech, s.qr_token)).status).toBe(410);
    expect((await scanEq(tech, 'a b!')).status).toBe(422);
  });

  it('barang pendukung: stok, peminjam aktif, borrow/return, stok habis', async () => {
    const s = await mkSp({ total_quantity: 5 });
    const fresh = (await scanSp(qa, s.qr_token)).body.data;
    expect(fresh).toMatchObject({ type: 'supporting', available_quantity: 5, max_borrow_quantity: 5, available_actions: ['borrow'], active_borrowings: [] });

    await borrow(tech, { supporting: [{ supporting_equipment_id: s.supporting_equipment_id, quantity: 5 }] });
    const mine = (await scanSp(tech, s.qr_token)).body.data;
    expect(mine.available_actions).toEqual(['return']);
    expect(mine.max_borrow_quantity).toBe(0);
    expect(mine.active_borrowings[0]).toMatchObject({ quantity_outstanding: 5, can_return: true, user: { name: 'Teknisi' } });
    expect(mine.active_borrowings[0].supporting_detail_id).toBeTruthy();
    const other = (await scanSp(qa, s.qr_token)).body.data;
    expect(other.available_actions).toEqual([]);
    expect(other.reason).toBe('Stok habis');
    expect((await scanSp(admin, s.qr_token)).body.data.available_actions).toEqual(['return']);
  });
});

describe('Daftar & detail', () => {
  async function seedLoans() {
    const e1 = await mkEq();
    const e2 = await mkEq();
    const s = await mkSp();
    const a = (await borrow(tech, { purpose: 'Praktikum A', equipment: [{ equipment_id: e1.equipment_id }] })).body.data;
    const b = (await borrow(qa, { purpose: 'Riset B', equipment: [{ equipment_id: e2.equipment_id }], supporting: [{ supporting_equipment_id: s.supporting_equipment_id, quantity: 2 }] })).body.data;
    // a: lewat batas → overdue; b: selesai
    fake.borrowing.rows.find((r: any) => r.borrowing_id === a.borrowing_id).expected_return_time = new Date(Date.now() - 3_600_000);
    await request(app).post(`${API}/borrowings/${b.borrowing_id}/return`).set(bearer(qa)).send({
      items: [{ detail_id: b.equipment[0].detail_id, final_condition: 'good' }],
      supporting: [{ supporting_detail_id: b.supporting[0].supporting_detail_id, quantity_returned: 2 }],
    });
    return { e1, e2, s, a, b };
  }
  const get = (qs: string, token = qa) => request(app).get(`${API}/borrowings${qs}`).set(bearer(token));

  it('filter status active | overdue | returned, user_id, equipment_id, tanggal, search', async () => {
    const { e1, e2, a, b } = await seedLoans();
    const ids = (r: any) => r.body.data.map((x: any) => x.borrowing_id);
    expect((await get('')).body.meta.total).toBe(2);
    expect(ids(await get('?status=active'))).toEqual([a.borrowing_id]);
    expect(ids(await get('?status=overdue'))).toEqual([a.borrowing_id]);
    expect((await get('?status=overdue')).body.data[0].is_overdue).toBe(true);
    expect(ids(await get('?status=returned'))).toEqual([b.borrowing_id]);
    expect(ids(await get(`?user_id=${b.user_id}`))).toEqual([b.borrowing_id]);
    expect(ids(await get(`?equipment_id=${e1.equipment_id}`))).toEqual([a.borrowing_id]);
    expect(ids(await get(`?equipment_id=${e2.equipment_id}`))).toEqual([b.borrowing_id]);
    expect((await get(`?date_from=${day(0)}&date_to=${day(0)}`)).body.meta.total).toBe(2);
    expect((await get(`?date_to=${day(-2)}`)).body.meta.total).toBe(0);
    expect((await get(`?date_from=${day(1)}`)).body.meta.total).toBe(0);
    expect(ids(await get('?search=riset'))).toEqual([b.borrowing_id]);
    const row = (await get('?status=returned')).body.data[0];
    expect(row).toMatchObject({ equipment_count: 1, supporting_count: 1, user: { name: 'QA' } });
    expect((await get('?status=lain')).status).toBe(422);
    expect((await get(`?date_from=${day(2)}&date_to=${day(1)}`)).status).toBe(422);
    expect((await get('?limit=101')).status).toBe(422);
    expect((await request(app).get(`${API}/borrowings`)).status).toBe(401);
  });

  it('/my: hanya milik user login; /:id detail lengkap + 404', async () => {
    const { a, b } = await seedLoans();
    const mine = await get('/my', tech);
    expect(mine.body.data.map((x: any) => x.borrowing_id)).toEqual([a.borrowing_id]);
    expect((await get('/my?user_id=' + b.user_id, tech)).body.data.map((x: any) => x.borrowing_id)).toEqual([a.borrowing_id]); // user_id diabaikan
    expect((await get('/my?status=returned', tech)).body.meta.total).toBe(0);

    const d = (await get(`/${b.borrowing_id}`)).body.data;
    expect(d).toMatchObject({ borrowing_status: 'returned', user: { name: 'QA' }, can_return: false });
    expect(d.equipment[0]).toMatchObject({ is_returned: true, final_condition: 'good', equipment: { equipment_name: expect.any(String) } });
    expect(d.supporting[0]).toMatchObject({ quantity_borrowed: 2, quantity_returned: 2, is_returned: true, item: { item_name: expect.any(String) } });
    expect((await get('/99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect((await get('/bukan-uuid')).status).toBe(422);
  });
});
