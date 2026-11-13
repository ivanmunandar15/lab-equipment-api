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
import { compatAction, conditionLabel, parseCondition, toBorrowingWithDetails, toEquipment, toNotification, toReading, toSensor } from '../src/modules/compat/compat.mappers';
import { toFieldErrors } from '../src/modules/compat/compat.http';
import { DEMO_PASSWORD, ROOM_A, ROOM_B } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const C = `${API}/compat`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const future = (h = 24) => new Date(Date.now() + h * 3_600_000).toISOString();

async function login(email: string, password = DEMO_PASSWORD) {
  return (await request(app).post(`${API}/auth/login`).send({ email, password })).body.data.access_token as string;
}
let admin: string, tech: string, spv: string, qa: string;

beforeEach(async () => {
  await fake.reset();
  admin = await login('admin@lab.local');
  tech = await login('technician@lab.local');
  for (const role of ['SPV', 'QA']) {
    await request(app).post(`${API}/users`).set(bearer(admin)).send({ name: role, email: `${role.toLowerCase()}@x.local`, role, password: 'Password123' });
  }
  spv = await login('spv@x.local', 'Password123');
  qa = await login('qa@x.local', 'Password123');
});

const eqBody = (over: Record<string, unknown> = {}) => ({
  inventory_code: `EQ-${Math.random().toString(36).slice(2, 8)}`, equipment_name: 'Oven Lab', equipment_type: 'Oven', brand: 'Memmert', model: 'UN55',
  room_id: ROOM_B, status: 'available', condition: 'good', purchase_date: '2024-01-31', purchase_price: 15000000, useful_life_years: 10,
  specifications: '', next_calibration_date: null, ...over,
});
const mkEq = (over: Record<string, unknown> = {}, token = spv) => request(app).post(`${C}/equipment`).set(bearer(token)).send(eqBody(over));

describe('mapper murni', () => {
  it('label kondisi dua arah', () => {
    expect(conditionLabel('good')).toBe('Baik');
    expect(conditionLabel(null)).toBeNull();
    expect(parseCondition('Rusak berat')).toBe('major_damage');
    expect(parseCondition('major_damage')).toBe('major_damage');
    expect(parseCondition('???')).toBeNull();
  });
  it('aksi activity log -> kosakata frontend', () => {
    expect(compatAction('BORROW', 'borrowing')).toBe('create');
    expect(compatAction('DELETE', 'equipment')).toBe('soft_delete');
    expect(compatAction('DELETE', 'document')).toBe('delete');
    expect(compatAction('UPDATE', 'equipment', { is_active: false }, { is_active: true })).toBe('restore');
    expect(compatAction('UPDATE', 'equipment', { is_active: true }, { is_active: false })).toBe('soft_delete');
    expect(compatAction('LOGIN', 'user')).toBe('login');
    expect(compatAction('MAINTENANCE_START', 'maintenance')).toBe('update');
    expect(compatAction('SOMETHING_NEW', 'x')).toBe('something_new');
  });
  it('equipment: null -> string kosong, Decimal -> number, tanggal date-only', () => {
    const e = toEquipment({
      equipment_id: 'a', inventory_code: 'X', qr_token: 't', equipment_name: 'n', equipment_type: 't', brand: null, model: null, room_id: 'r',
      status: 'available', condition: 'good', purchase_date: new Date('2024-02-03T00:00:00Z'), purchase_price: { toString: () => '1500.50' },
      useful_life_years: null, specifications: null, next_calibration_date: null, is_active: true,
      created_at: new Date('2025-01-01T00:00:00Z'), updated_at: new Date('2025-01-01T00:00:00Z'),
    });
    expect(e).toMatchObject({ brand: '', model: '', purchase_date: '2024-02-03', purchase_price: 1500.5, useful_life_years: null, specifications: null, next_calibration_date: null });
  });
  it('semua field opsional alat dikembalikan null apa adanya (tanpa nilai pengganti)', () => {
    const e = toEquipment({ equipment_id: 'a', inventory_code: 'X', qr_token: 't', equipment_name: 'n', equipment_type: 't', brand: null, model: null, room_id: 'r', status: 'available', condition: 'good', purchase_date: null, purchase_price: null, useful_life_years: 5, specifications: null, next_calibration_date: null, is_active: true, created_at: new Date('2025-03-04T10:00:00Z'), updated_at: new Date() });
    expect(e).toMatchObject({ purchase_date: null, purchase_price: null, useful_life_years: 5, specifications: null, condition: 'good' });
    const e2 = toEquipment({ equipment_id: 'a', inventory_code: 'X', qr_token: 't', equipment_name: 'n', equipment_type: 't', brand: null, model: null, room_id: 'r', status: 'available', condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: '', next_calibration_date: null, is_active: true, created_at: new Date(), updated_at: new Date() });
    expect(e2).toMatchObject({ condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
  });
  it('peminjaman: overdue dihitung, label kondisi pada detail', () => {
    const b = { borrowing_id: 'b', user_id: 'u', borrowing_time: new Date(), expected_return_time: new Date(Date.now() - 3_600_000), actual_return_time: null, purpose: 'p', usage_location: null, borrowing_status: 'borrowed', notes: null, created_at: new Date(), updated_at: new Date() };
    const d = toBorrowingWithDetails(b, [{ detail_id: 'd', borrowing_id: 'b', equipment_id: 'e', initial_condition: 'good', final_condition: null, has_damage: false, damage_notes: null }], []);
    expect(d.is_overdue).toBe(true);
    expect(d.display_status).toBe('overdue');
    expect(d.usage_location).toBe('');
    expect(d.equipment_details[0]).toMatchObject({ initial_condition: 'Baik', final_condition: null });
  });
  it('sensor/reading: Decimal -> number', () => {
    expect(toSensor({ sensor_id: 's', room_id: 'r', sensor_code: 'c', sensor_type: 'temperature', unit: '°C', sensor_location: null, sensor_status: 'active', min_threshold: { toString: () => '18.00' }, max_threshold: '26.5' as any, created_at: new Date(), updated_at: new Date() })).toMatchObject({ min_threshold: 18, max_threshold: 26.5, sensor_location: '' });
    expect(toReading({ monitoring_id: 'm', sensor_id: 's', value: { toString: () => '22.40' }, measurement_time: new Date(), received_at: new Date() }).value).toBe(22.4);
  });
  it('notifikasi: link_url diturunkan', () => {
    const n = toNotification({ notification_id: 'n', user_id: 'u', borrowing_id: 'b', calibration_id: null, maintenance_id: null, notification_type: 'borrowing', title: 't', message: 'm', is_read: false, created_at: new Date(), read_at: null });
    expect(n.link_url).toBe('/borrowing');
  });
  it('fieldErrors: path bertitik + unrecognized_keys', () => {
    expect(toFieldErrors([{ path: ['equipment', 0, 'damage_notes'], message: 'wajib' }, { path: [], message: 'x', code: 'unrecognized_keys', keys: ['qr_token'] }]))
      .toEqual({ 'equipment.0.damage_notes': 'wajib', qr_token: 'Field "qr_token" tidak dikenali atau tidak dapat diubah' });
  });
});

describe('kontrak respons & error', () => {
  it('tanpa token: 401 UNAUTHORIZED', async () => {
    const res = await request(app).get(`${C}/rooms`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
  it('daftar = array mentah (tanpa amplop success/data)', async () => {
    const res = await request(app).get(`${C}/rooms`).set(bearer(qa));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((r: any) => r.room_code)).toEqual(['LAB-A', 'LAB-B']); // ruangan nonaktif disembunyikan, urut kode
    expect(res.body[0]).toMatchObject({ room_id: ROOM_A, person_in_charge: '', description: '' });
  });
  it('ID bukan UUID = 404 NOT_FOUND (bukan 422)', async () => {
    const res = await request(app).get(`${C}/equipment/abc`).set(bearer(admin));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
  it('route tak dikenal: 404 berbentuk compat', async () => {
    const res = await request(app).get(`${C}/nope`).set(bearer(admin));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('users', () => {
  it('semua role membaca direktori; email hanya untuk admin', async () => {
    const asAdmin = await request(app).get(`${C}/users`).set(bearer(admin));
    const asTech = await request(app).get(`${C}/users`).set(bearer(tech));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body[0].email).toContain('@');
    expect(asAdmin.body[0].password_hash).toBeUndefined();
    expect(asTech.body.every((u: any) => u.email === '')).toBe(true);
    expect(asAdmin.body.some((u: any) => u.role === 'QA' && !u.is_active)).toBe(false); // nonaktif disembunyikan
    const all = await request(app).get(`${C}/users?includeInactive=true`).set(bearer(admin));
    expect(all.body.some((u: any) => !u.is_active)).toBe(true);
  });
  it('create: validasi fieldErrors + 409 email ganda + 403 non-admin', async () => {
    const bad = await request(app).post(`${C}/users`).set(bearer(admin)).send({ name: 'A', email: 'x', password: 'short', role: 'admin' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION');
    expect(Object.keys(bad.body.error.fieldErrors)).toEqual(expect.arrayContaining(['email', 'password']));
    const ok = await request(app).post(`${C}/users`).set(bearer(admin)).send({ name: 'Budi', email: 'Budi@Lab.Local', password: 'Password123', role: 'QA' });
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe('budi@lab.local');
    const dup = await request(app).post(`${C}/users`).set(bearer(admin)).send({ name: 'Budi2', email: 'budi@lab.local', password: 'Password123', role: 'QA' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    expect((await request(app).post(`${C}/users`).set(bearer(spv)).send({})).status).toBe(403);
  });
  it('update email, soft delete, restore, dan admin terakhir dilindungi', async () => {
    const created = (await request(app).post(`${C}/users`).set(bearer(admin)).send({ name: 'Budi', email: 'b@lab.local', password: 'Password123', role: 'QA' })).body;
    const upd = await request(app).patch(`${C}/users/${created.user_id}`).set(bearer(admin)).send({ email: 'baru@lab.local', name: 'Budi B' });
    expect(upd.body).toMatchObject({ email: 'baru@lab.local', name: 'Budi B' });
    const del = await request(app).delete(`${C}/users/${created.user_id}`).set(bearer(admin));
    expect(del.body.is_active).toBe(false);
    const res = await request(app).post(`${C}/users/${created.user_id}/restore`).set(bearer(admin));
    expect(res.body.is_active).toBe(true);
    const me = (await request(app).get(`${C}/users?search=admin@lab.local`).set(bearer(admin))).body[0];
    const last = await request(app).patch(`${C}/users/${me.user_id}`).set(bearer(admin)).send({ role: 'QA' });
    expect(last.status).toBe(409);
    expect(last.body.error.message).toMatch(/admin terakhir/);
  });
  it('activity log memakai kosakata frontend', async () => {
    const created = (await request(app).post(`${C}/users`).set(bearer(admin)).send({ name: 'Budi', email: 'b@lab.local', password: 'Password123', role: 'QA' })).body;
    await request(app).delete(`${C}/users/${created.user_id}`).set(bearer(admin));
    const rows = fake.activityLog.rows.map((r: any) => r.action);
    expect(rows).toEqual(expect.arrayContaining(['CREATE', 'DELETE']));
  });
});

describe('rooms', () => {
  it('create/update/delete + 409 kode ganda + soft delete (204)', async () => {
    const mk = (code: string) => request(app).post(`${C}/rooms`).set(bearer(spv)).send({ room_code: code, room_name: 'Lab Baru', equipment_capacity: 5, person_in_charge: '', description: '' });
    // penanggung jawab opsional: "" = tanpa penanggung jawab (null di DB, "" di respons)
    const noPic = await mk('LAB-NP');
    expect(noPic.status).toBe(201);
    expect(noPic.body).toMatchObject({ room_code: 'LAB-NP', person_in_charge: '' });
    expect((await request(app).post(`${C}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-NP2', room_name: 'Tanpa Field', equipment_capacity: 5, description: '' })).status).toBe(201);
    // nilai terisi harus UUID user yang valid
    const bad = await request(app).post(`${C}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-N', room_name: 'Lab Baru', equipment_capacity: 5, person_in_charge: 'bukan-uuid', description: '' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fieldErrors.person_in_charge).toBeDefined();
    const adminId = (await request(app).get(`${C}/users?search=admin@lab.local`).set(bearer(admin))).body[0].user_id;
    const ok = await request(app).post(`${C}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-N', room_name: 'Lab Baru', equipment_capacity: 5, person_in_charge: adminId, description: 'x' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ room_code: 'LAB-N', person_in_charge: adminId, description: 'x' });
    expect((await request(app).post(`${C}/rooms`).set(bearer(spv)).send({ room_code: 'LAB-N', room_name: 'Dup', equipment_capacity: 1, person_in_charge: adminId, description: '' })).status).toBe(409);
    const up = await request(app).patch(`${C}/rooms/${ok.body.room_id}`).set(bearer(spv)).send({ room_name: 'Lab Ganti' });
    expect(up.body.room_name).toBe('Lab Ganti');
    const cleared = await request(app).patch(`${C}/rooms/${ok.body.room_id}`).set(bearer(spv)).send({ person_in_charge: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.person_in_charge).toBe('');
    expect((await request(app).delete(`${C}/rooms/${ok.body.room_id}`).set(bearer(spv))).status).toBe(204);
    expect((await request(app).post(`${C}/rooms`).set(bearer(qa)).send({})).status).toBe(403);
  });
});

describe('equipment', () => {
  it('create: bentuk frontend, qr_token 12 alfanumerik, tanggal date-only, harga number', async () => {
    const res = await mkEq({ inventory_code: 'EQ-100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ inventory_code: 'EQ-100', purchase_date: '2024-01-31', purchase_price: 15000000, brand: 'Memmert', is_active: true, next_calibration_date: null });
    expect(res.body.qr_token).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(res.body.equipment_id).toBeDefined();
  });
  it('create/patch: condition, purchase_*, useful_life_years, specifications, next_calibration_date boleh null atau tidak dikirim', async () => {
    const nulls = await mkEq({ inventory_code: 'EQ-N1', condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    expect(nulls.status).toBe(201);
    expect(nulls.body).toMatchObject({ condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    // "" pada specifications juga disimpan null
    const blank = await mkEq({ inventory_code: 'EQ-N2', specifications: '' });
    expect(blank.body.specifications).toBeNull();
    // field tidak dikirim: condition default good, sisanya null
    const { condition, purchase_date, purchase_price, useful_life_years, specifications, next_calibration_date, ...minimal } = eqBody({ inventory_code: 'EQ-N3' }) as Record<string, unknown>;
    void [condition, purchase_date, purchase_price, useful_life_years, specifications, next_calibration_date];
    const omitted = await request(app).post(`${C}/equipment`).set(bearer(spv)).send(minimal);
    expect(omitted.status).toBe(201);
    expect(omitted.body).toMatchObject({ condition: 'good', purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    // PATCH ke null mengosongkan nilai; dibaca ulang tetap null
    const full = (await mkEq({ inventory_code: 'EQ-N4', next_calibration_date: '2030-01-01' })).body;
    const cleared = await request(app).patch(`${C}/equipment/${full.equipment_id}`).set(bearer(spv)).send({ condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ condition: null, purchase_date: null, purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null });
    expect((await request(app).get(`${C}/equipment/${full.equipment_id}`).set(bearer(qa))).body).toMatchObject({ condition: null, next_calibration_date: null });
    // nilai tidak valid tetap ditolak
    const bad = await mkEq({ inventory_code: 'EQ-N5', purchase_price: -1, useful_life_years: 0, condition: 'unknown' });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fieldErrors).sort()).toEqual(['condition', 'purchase_price', 'useful_life_years']);
  });
  it('validasi: fieldErrors, status borrowed ditolak, qr_token di body ditolak', async () => {
    const bad = await mkEq({ equipment_name: '', purchase_date: '31-01-2024' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fieldErrors).toMatchObject({ equipment_name: expect.any(String), purchase_date: expect.any(String) });
    expect((await mkEq({ status: 'borrowed' })).body.error.fieldErrors.status).toBeDefined();
    expect((await mkEq({ qr_token: 'abcdefghijkl' })).body.error.fieldErrors.qr_token).toBeDefined();
  });
  it('409 kode ganda; code-taken; by-code; by-qr', async () => {
    const a = (await mkEq({ inventory_code: 'EQ-DUP' })).body;
    expect((await mkEq({ inventory_code: 'EQ-DUP' })).status).toBe(409);
    expect((await request(app).get(`${C}/equipment/code-taken?code=eq-dup`).set(bearer(tech))).body).toBe(true);
    expect((await request(app).get(`${C}/equipment/code-taken?code=eq-dup&exceptId=${a.equipment_id}`).set(bearer(tech))).body).toBe(false);
    expect((await request(app).get(`${C}/equipment/by-code/eq-dup`).set(bearer(tech))).body.equipment_id).toBe(a.equipment_id);
    expect((await request(app).get(`${C}/equipment/by-qr/${a.qr_token}`).set(bearer(tech))).body.equipment_id).toBe(a.equipment_id);
    expect((await request(app).get(`${C}/equipment/by-qr/zzzzzzzzzzzz`).set(bearer(tech))).status).toBe(404);
  });
  it('update: qr_token/is_active ditolak; field lain berhasil; log hanya field berubah', async () => {
    const a = (await mkEq({ inventory_code: 'EQ-U' })).body;
    const bad = await request(app).patch(`${C}/equipment/${a.equipment_id}`).set(bearer(spv)).send({ qr_token: 'x', equipment_name: 'Baru' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fieldErrors.qr_token).toMatch(/tidak dapat diubah/);
    const ok = await request(app).patch(`${C}/equipment/${a.equipment_id}`).set(bearer(spv)).send({ equipment_name: 'Oven Baru', purchase_price: 10 });
    expect(ok.body).toMatchObject({ equipment_name: 'Oven Baru', purchase_price: 10, qr_token: a.qr_token });
    const last = fake.activityLog.rows.at(-1);
    expect(last.action).toBe('UPDATE');
    expect(Object.keys(last.new_data).sort()).toEqual(['equipment_name', 'purchase_price']);
  });
  it('list: filter + includeInactive + soft delete/restore; RBAC tulis', async () => {
    const a = (await mkEq({ inventory_code: 'EQ-L1', equipment_name: 'Timbangan', brand: 'Ohaus' })).body;
    await mkEq({ inventory_code: 'EQ-L2', status: 'damaged' });
    expect((await request(app).get(`${C}/equipment?search=ohaus`).set(bearer(qa))).body.map((e: any) => e.inventory_code)).toEqual(['EQ-L1']);
    expect((await request(app).get(`${C}/equipment?status=damaged,maintenance`).set(bearer(qa))).body).toHaveLength(1);
    expect((await request(app).get(`${C}/equipment?room_id=bukan-uuid`).set(bearer(qa))).body).toEqual([]);
    const del = await request(app).delete(`${C}/equipment/${a.equipment_id}`).set(bearer(spv));
    expect(del.body.is_active).toBe(false);
    expect((await request(app).get(`${C}/equipment`).set(bearer(qa))).body).toHaveLength(1);
    expect((await request(app).get(`${C}/equipment?includeInactive=true`).set(bearer(qa))).body).toHaveLength(2);
    expect((await request(app).post(`${C}/equipment/${a.equipment_id}/restore`).set(bearer(spv))).body.is_active).toBe(true);
    expect((await mkEq({}, tech)).status).toBe(403);
  });
  it('bulk: semua-atau-tidak sama sekali', async () => {
    const rows = [eqBody({ inventory_code: 'B-1' }), eqBody({ inventory_code: 'B-2' })];
    const ok = await request(app).post(`${C}/equipment/bulk`).set(bearer(spv)).send(rows);
    expect(ok.status).toBe(201);
    expect(ok.body).toHaveLength(2);
    const dupInFile = await request(app).post(`${C}/equipment/bulk`).set(bearer(spv)).send([eqBody({ inventory_code: 'C-1' }), eqBody({ inventory_code: 'c-1' })]);
    expect(dupInFile.status).toBe(409);
    const dupInDb = await request(app).post(`${C}/equipment/bulk`).set(bearer(spv)).send([eqBody({ inventory_code: 'C-2' }), eqBody({ inventory_code: 'B-1' })]);
    expect(dupInDb.status).toBe(409);
    expect((await request(app).get(`${C}/equipment?search=C-2`).set(bearer(spv))).body).toHaveLength(0);
    expect(fake.activityLog.rows.some((r: any) => r.action === 'IMPORT')).toBe(true);
  });
});

describe('supporting equipment', () => {
  const spBody = (over: Record<string, unknown> = {}) => ({ item_code: 'SP-1', item_name: 'Sarung Tangan', item_type: 'APD', brand: 'X', model: '', unit: 'box', total_quantity: 10, condition: 'good', description: '', specifications: '', ...over });
  it('create + stok turunan; total_quantity menggeser available; available_quantity tak boleh diubah', async () => {
    const c = await request(app).post(`${C}/supporting-equipment`).set(bearer(spv)).send(spBody());
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ available_quantity: 10, status: 'available', model: '' });
    const up = await request(app).patch(`${C}/supporting-equipment/${c.body.supporting_equipment_id}`).set(bearer(spv)).send({ total_quantity: 15 });
    expect(up.body).toMatchObject({ total_quantity: 15, available_quantity: 15 });
    const bad = await request(app).patch(`${C}/supporting-equipment/${c.body.supporting_equipment_id}`).set(bearer(spv)).send({ available_quantity: 1 });
    expect(bad.body.error.fieldErrors.available_quantity).toMatch(/tidak dapat diubah/);
    expect((await request(app).get(`${C}/supporting-equipment/by-code/sp-1`).set(bearer(qa))).body.item_code).toBe('SP-1');
    expect((await request(app).get(`${C}/supporting-equipment/code-taken?code=SP-1`).set(bearer(qa))).body).toBe(true);
  });
});

describe('peminjaman & pengembalian', () => {
  const adminId = async () => (await request(app).get(`${C}/users?search=admin@lab.local`).set(bearer(admin))).body[0].user_id as string;
  const techId = async () => (await request(app).get(`${C}/users?search=technician@lab.local`).set(bearer(admin))).body[0].user_id as string;
  const borrow = async (token: string, userId: string, equipment_ids: string[], supporting_items: any[] = [], over: Record<string, unknown> = {}) =>
    request(app).post(`${C}/borrowings`).set(bearer(token)).send({
      user_id: userId, borrowing_time: new Date().toISOString(), expected_return_time: future(), purpose: 'Praktikum', usage_location: 'Lab A', notes: '',
      equipment_ids, supporting_items, ...over,
    });

  it('pinjam: bentuk BorrowingWithDetails, status alat -> borrowed, stok berkurang, label kondisi', async () => {
    const eq = (await mkEq({ inventory_code: 'EQ-B1' })).body;
    const sp = (await request(app).post(`${C}/supporting-equipment`).set(bearer(spv)).send({ item_code: 'SP-B', item_name: 'Pipet', item_type: 'x', brand: 'x', model: '', unit: 'pcs', total_quantity: 5, condition: 'good', description: '', specifications: '' })).body;
    const res = await borrow(tech, await techId(), [eq.equipment_id], [{ supporting_equipment_id: sp.supporting_equipment_id, quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ borrowing_status: 'borrowed', display_status: 'borrowed', is_overdue: false, usage_location: 'Lab A', actual_return_time: null });
    expect(res.body.equipment_details[0]).toMatchObject({ equipment_id: eq.equipment_id, initial_condition: 'Baik', final_condition: null });
    expect(res.body.supporting_details[0]).toMatchObject({ quantity_borrowed: 2, quantity_returned: 0 });
    expect((await request(app).get(`${C}/equipment/${eq.equipment_id}`).set(bearer(qa))).body.status).toBe('borrowed');
    expect((await request(app).get(`${C}/supporting-equipment/${sp.supporting_equipment_id}`).set(bearer(qa))).body.available_quantity).toBe(3);
  });
  it('konflik: alat tidak tersedia -> 409 dengan pesan per item; peminjam harus diri sendiri; waktu kembali di masa lalu', async () => {
    const eq = (await mkEq({ inventory_code: 'EQ-B2', status: 'damaged' })).body;
    const conflict = await borrow(tech, await techId(), [eq.equipment_id]);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CONFLICT');
    expect(conflict.body.error.message).toMatch(/Oven Lab: Alat tidak tersedia/);
    const ok = (await mkEq({ inventory_code: 'EQ-B3' })).body;
    expect((await borrow(tech, await adminId(), [ok.equipment_id])).status).toBe(403);
    const past = await borrow(tech, await techId(), [ok.equipment_id], [], { expected_return_time: new Date(Date.now() - 3600_000).toISOString() });
    expect(past.status).toBe(422);
    expect(past.body.error.fieldErrors.expected_return_time).toBeDefined();
    const none = await borrow(tech, await techId(), []);
    expect(none.status).toBe(422);
    expect(none.body.error.fieldErrors.equipment_ids).toBeDefined();
  });
  it('kembali: kerusakan ringan -> alat available (kondisi minor_damage); rusak berat -> damaged; peminjaman selesai', async () => {
    const a = (await mkEq({ inventory_code: 'EQ-R1' })).body;
    const b = (await mkEq({ inventory_code: 'EQ-R2' })).body;
    const created = (await borrow(tech, await techId(), [a.equipment_id, b.equipment_id])).body;
    const dA = created.equipment_details.find((d: any) => d.equipment_id === a.equipment_id).detail_id;
    const dB = created.equipment_details.find((d: any) => d.equipment_id === b.equipment_id).detail_id;
    const noNotes = await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(tech)).send({ equipment: [{ detail_id: dA, final_condition: 'Rusak ringan', has_damage: true, new_condition: 'minor_damage' }], supporting: [] });
    expect(noNotes.status).toBe(422);
    expect(noNotes.body.error.fieldErrors['equipment.0.damage_notes']).toBeDefined();

    const part = await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(tech)).send({
      equipment: [{ detail_id: dA, final_condition: 'Rusak ringan', has_damage: true, damage_notes: 'Goresan', new_condition: 'minor_damage' }], supporting: [],
    });
    expect(part.status).toBe(200);
    expect(part.body.borrowing_status).toBe('borrowed'); // sebagian
    expect(part.body.equipment_details.find((d: any) => d.detail_id === dA)).toMatchObject({ final_condition: 'Rusak ringan', has_damage: true, damage_notes: 'Goresan' });
    expect((await request(app).get(`${C}/equipment/${a.equipment_id}`).set(bearer(qa))).body).toMatchObject({ status: 'available', condition: 'minor_damage' });

    const done = await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(tech)).send({
      equipment: [{ detail_id: dB, final_condition: 'Rusak berat', has_damage: true, damage_notes: 'Patah', new_condition: 'major_damage' }], supporting: [],
    });
    expect(done.body.borrowing_status).toBe('returned');
    expect(done.body.actual_return_time).not.toBeNull();
    expect((await request(app).get(`${C}/equipment/${b.equipment_id}`).set(bearer(qa))).body).toMatchObject({ status: 'damaged', condition: 'major_damage' });
    expect((await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(tech)).send({ equipment: [{ detail_id: dB, final_condition: 'Baik', has_damage: false }], supporting: [] })).status).toBe(409);
  });
  it('kembali: hanya peminjam/admin/SPV (403); update metadata', async () => {
    const a = (await mkEq({ inventory_code: 'EQ-R3' })).body;
    const created = (await borrow(tech, await techId(), [a.equipment_id])).body;
    const d = created.equipment_details[0].detail_id;
    const line = { equipment: [{ detail_id: d, final_condition: 'Baik', has_damage: false }], supporting: [] };
    expect((await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(qa)).send(line)).status).toBe(403);
    const upd = await request(app).patch(`${C}/borrowings/${created.borrowing_id}`).set(bearer(tech)).send({ purpose: 'Tujuan baru', notes: 'catatan' });
    expect(upd.body).toMatchObject({ purpose: 'Tujuan baru', notes: 'catatan' });
    expect((await request(app).post(`${C}/borrowings/${created.borrowing_id}/return`).set(bearer(spv)).send(line)).body.borrowing_status).toBe('returned');
    expect((await request(app).patch(`${C}/borrowings/${created.borrowing_id}`).set(bearer(tech)).send({ purpose: 'x' })).status).toBe(409);
  });
});

describe('notifikasi', () => {
  it('hanya milik sendiri; unread-count angka mentah; read & read-all', async () => {
    const techUser = (await request(app).get(`${C}/users?search=technician@lab.local`).set(bearer(admin))).body[0];
    const mk = (title: string) => request(app).post(`${C}/notifications`).set(bearer(admin)).send({ user_id: techUser.user_id, borrowing_id: null, calibration_id: null, maintenance_id: null, notification_type: 'system', title, message: 'm' });
    const n1 = (await mk('Satu')).body;
    await mk('Dua');
    expect((await request(app).post(`${C}/notifications`).set(bearer(tech)).send({})).status).toBe(403);
    expect((await request(app).get(`${C}/notifications/unread-count`).set(bearer(tech))).body).toBe(2);
    expect((await request(app).get(`${C}/notifications?user_id=${techUser.user_id}`).set(bearer(admin))).status).toBe(403);
    expect((await request(app).get(`${C}/notifications`).set(bearer(admin))).body).toHaveLength(0);
    expect((await request(app).get(`${C}/notifications/${n1.notification_id}`).set(bearer(admin))).status).toBe(404);
    const read = await request(app).post(`${C}/notifications/${n1.notification_id}/read`).set(bearer(tech));
    expect(read.body).toMatchObject({ is_read: true });
    expect(read.body.read_at).not.toBeNull();
    expect((await request(app).get(`${C}/notifications?unreadOnly=true`).set(bearer(tech))).body).toHaveLength(1);
    expect((await request(app).post(`${C}/notifications/read-all`).set(bearer(tech))).body).toBe(1);
  });
  it('lapor masalah alat: notifikasi ke technician & SPV selain pelapor; status alat tidak berubah', async () => {
    const eq = (await mkEq({ inventory_code: 'EQ-REP' })).body;
    const res = await request(app).post(`${C}/reports/equipment-issue`).set(bearer(qa)).send({ equipment_id: eq.equipment_id, description: 'Layar mati total' });
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(2);
    expect((await request(app).get(`${C}/equipment/${eq.equipment_id}`).set(bearer(qa))).body.status).toBe('available');
    const short = await request(app).post(`${C}/reports/equipment-issue`).set(bearer(qa)).send({ equipment_id: eq.equipment_id, description: 'x' });
    expect(short.status).toBe(422);
    expect(short.body.error.fieldErrors.description).toBeDefined();
  });
});

describe('endpoint utama tidak berubah + BFF auth', () => {
  it('API utama tetap memakai amplop success/data', async () => {
    const res = await request(app).get(`${API}/rooms`).set(bearer(admin));
    expect(res.body.success).toBe(true);
    expect(res.body.meta).toBeDefined();
  });
  it('X-Client: bff mengembalikan refresh_token di body dan menerimanya kembali; tanpa header tidak bocor', async () => {
    const plain = await request(app).post(`${API}/auth/login`).send({ email: 'admin@lab.local', password: DEMO_PASSWORD });
    expect(plain.body.data.refresh_token).toBeUndefined();
    const bff = await request(app).post(`${API}/auth/login`).set('X-Client', 'bff').send({ email: 'admin@lab.local', password: DEMO_PASSWORD });
    expect(typeof bff.body.data.refresh_token).toBe('string');
    const next = await request(app).post(`${API}/auth/refresh`).set('X-Client', 'bff').send({ refresh_token: bff.body.data.refresh_token });
    expect(next.status).toBe(200);
    expect(next.body.data.refresh_token).not.toBe(bff.body.data.refresh_token);
    // tanpa header bff, refresh_token di body diabaikan
    const denied = await request(app).post(`${API}/auth/refresh`).send({ refresh_token: next.body.data.refresh_token });
    expect(denied.status).toBe(401);
  });
});
