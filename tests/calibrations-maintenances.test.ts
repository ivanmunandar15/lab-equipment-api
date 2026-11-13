/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  const fake = createFakeDb();
  return { getDb: () => fake, disconnectDb: async () => undefined, __fake: fake };
});

import * as dbModule from '../src/config/db';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { canTransition } from '../src/modules/maintenances/maintenances.state';
import { DEMO_PASSWORD, ROOM_B } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const binary = (res: any, cb: (e: Error | null, b?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const certDir = () => path.resolve(env.UPLOAD_DIR, 'certificates');
const storedFiles = () => (existsSync(certDir()) ? readdirSync(certDir()) : []);

async function login(email: string, password = DEMO_PASSWORD) {
  return (await request(app).post(`${API}/auth/login`).send({ email, password })).body.data.access_token as string;
}

let admin: string, spv: string, tech: string, qa: string;
let techId: string;

beforeEach(async () => {
  await rm(path.resolve(env.UPLOAD_DIR), { recursive: true, force: true });
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
afterAll(() => rm(path.resolve(env.UPLOAD_DIR), { recursive: true, force: true }));

let seq = 0;
async function mkEq(over: Record<string, unknown> = {}) {
  seq++;
  return (await request(app).post(`${API}/equipment`).set(bearer(spv)).send({ inventory_code: `EQ-${seq}`, equipment_name: `Alat ${seq}`, equipment_type: 'Oven', room_id: ROOM_B, ...over })).body.data;
}
const eqRow = (id: string) => fake.equipment.rows.find((r: any) => r.equipment_id === id);

type CalFields = Record<string, string>;
function postCal(token: string, fields: CalFields, file?: { buf: Buffer; name?: string; type?: string }) {
  let r = request(app).post(`${API}/calibrations`).set(bearer(token));
  for (const [k, v] of Object.entries({ calibration_date: day(0), next_calibration_date: day(365), calibration_result: 'passed', ...fields })) r = r.field(k, v);
  if (file) r = r.attach('certificate', file.buf, { filename: file.name ?? 'sertifikat.pdf', contentType: file.type ?? 'application/pdf' });
  return r;
}

describe('Kalibrasi — RBAC & POST passed', () => {
  it('QA hanya baca; technician/SPV/admin boleh catat', async () => {
    const e = await mkEq();
    expect((await postCal(qa, { equipment_id: e.equipment_id })).status).toBe(403);
    expect((await request(app).post(`${API}/equipment/${e.equipment_id}/start-calibration`).set(bearer(qa))).status).toBe(403);
    for (const t of [tech, spv, admin]) expect((await postCal(t, { equipment_id: e.equipment_id })).status).toBe(201);
    for (const t of [qa, tech, spv, admin]) expect((await request(app).get(`${API}/calibrations`).set(bearer(t))).status).toBe(200);
    expect((await request(app).get(`${API}/calibrations`)).status).toBe(401);
  });

  it('passed: next_calibration_date alat diperbarui, status calibration → available, technician dari token, sertifikat tersimpan', async () => {
    const e = await mkEq({ next_calibration_date: day(-10) });
    await request(app).post(`${API}/equipment/${e.equipment_id}/start-calibration`).set(bearer(tech));
    expect(eqRow(e.equipment_id).status).toBe('calibration');

    const res = await postCal(tech, { equipment_id: e.equipment_id, next_calibration_date: day(180), calibration_provider: 'PT Kalibrasi', certificate_number: 'CERT/001', cost: '1500000.50', notes: '' }, { buf: PDF });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({
      technician_id: techId, calibration_result: 'passed', cost: 1500000.5, has_certificate: true, applied_to_equipment: true,
      next_calibration_date: day(180), technician: { name: 'Teknisi' }, equipment: { calibration_state: 'safe', status: 'available' },
    });
    expect(d.certificate_file_url).toBeUndefined(); // lokasi internal tidak bocor
    expect(eqRow(e.equipment_id)).toMatchObject({ status: 'available' });
    expect(eqRow(e.equipment_id).next_calibration_date.toISOString().slice(0, 10)).toBe(day(180));
    expect(storedFiles()).toHaveLength(1);
    expect(storedFiles()[0]).toMatch(/^[0-9a-f-]{36}\.pdf$/); // nama dari server, bukan dari client
    const log = fake.activityLog.rows.find((l: any) => l.action === 'CALIBRATE');
    expect(log).toMatchObject({ entity_type: 'calibration', entity_id: d.calibration_id });
    expect(log.new_data.equipment_status).toBe('available');
  });

  it('passed tidak mengubah status alat selain calibration (mis. borrowed tetap borrowed)', async () => {
    const e = await mkEq();
    eqRow(e.equipment_id).status = 'borrowed';
    const res = await postCal(tech, { equipment_id: e.equipment_id });
    expect(res.status).toBe(201);
    expect(eqRow(e.equipment_id).status).toBe('borrowed');
  });

  it('entri bertanggal lebih lama dari kalibrasi terbaru hanya masuk riwayat', async () => {
    const e = await mkEq();
    await postCal(tech, { equipment_id: e.equipment_id, calibration_date: day(-1), next_calibration_date: day(300) });
    const old = await postCal(tech, { equipment_id: e.equipment_id, calibration_date: day(-100), next_calibration_date: day(-10) });
    expect(old.status).toBe(201);
    expect(old.body.data.applied_to_equipment).toBe(false);
    expect(eqRow(e.equipment_id).next_calibration_date.toISOString().slice(0, 10)).toBe(day(300));
  });
});

describe('Kalibrasi — failed', () => {
  it('default status calibration; pilihan damaged; dipinjam/maintenance → 409 tanpa jejak', async () => {
    const e1 = await mkEq();
    const r1 = await postCal(tech, { equipment_id: e1.equipment_id, calibration_result: 'failed' });
    expect(r1.status).toBe(201);
    expect(eqRow(e1.equipment_id).status).toBe('calibration');
    expect(eqRow(e1.equipment_id).next_calibration_date).toBeNull(); // failed tidak mengubah jadwal

    const e2 = await mkEq();
    await postCal(tech, { equipment_id: e2.equipment_id, calibration_result: 'failed', status_after_fail: 'damaged' });
    expect(eqRow(e2.equipment_id).status).toBe('damaged');

    const e3 = await mkEq();
    eqRow(e3.equipment_id).status = 'borrowed';
    const before = fake.calibration.rows.length;
    const blocked = await postCal(tech, { equipment_id: e3.equipment_id, calibration_result: 'failed' }, { buf: PDF });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EQUIPMENT_BORROWED');
    expect(fake.calibration.rows).toHaveLength(before);
    expect(storedFiles()).toHaveLength(0); // file dibersihkan saat transaksi gagal

    const e4 = await mkEq();
    eqRow(e4.equipment_id).status = 'maintenance';
    expect((await postCal(tech, { equipment_id: e4.equipment_id, calibration_result: 'failed' })).body.error.code).toBe('EQUIPMENT_IN_MAINTENANCE');
    expect((await postCal(tech, { equipment_id: e4.equipment_id, calibration_result: 'failed', status_after_fail: 'x' })).status).toBe(422);
  });
});

describe('Kalibrasi — validasi & upload', () => {
  it('422/409: tanggal, alat, field wajib', async () => {
    const e = await mkEq();
    const base = { equipment_id: e.equipment_id };
    expect((await postCal(tech, { ...base, next_calibration_date: day(0) })).status).toBe(422); // next <= date
    expect((await postCal(tech, { ...base, calibration_date: day(2), next_calibration_date: day(100) })).status).toBe(422); // masa depan
    expect((await postCal(tech, { ...base, calibration_date: '30-10-2026' })).status).toBe(422);
    expect((await postCal(tech, { ...base, calibration_result: 'lulus' })).status).toBe(422);
    expect((await postCal(tech, { ...base, cost: '-5' })).status).toBe(422);
    expect((await postCal(tech, { equipment_id: 'bukan-uuid' })).status).toBe(422);
    expect((await postCal(tech, { equipment_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(422);
    await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    expect((await postCal(tech, base)).body.error.code).toBe('EQUIPMENT_INACTIVE');
    expect(fake.calibration.rows).toHaveLength(0);
  });

  it('sertifikat: gambar PNG diterima; MIME salah, isi palsu, terlalu besar ditolak; tanpa sertifikat boleh', async () => {
    const e = await mkEq();
    const base = { equipment_id: e.equipment_id };
    expect((await postCal(tech, base, { buf: PNG, name: 'x.png', type: 'image/png' })).status).toBe(201);
    expect(storedFiles().filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect((await postCal(tech, base)).body.data.has_certificate).toBe(false);

    const n = storedFiles().length;
    const txt = await postCal(tech, base, { buf: Buffer.from('halo'), name: 'a.txt', type: 'text/plain' });
    expect(txt.status).toBe(422);
    const exe = await postCal(tech, base, { buf: Buffer.from('MZ-malware-bukan-pdf'), name: 'a.pdf', type: 'application/pdf' }); // MIME dipalsukan
    expect(exe.status).toBe(422);
    expect(exe.body.error.details[0].path).toBe('certificate');
    const big = await postCal(tech, base, { buf: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(env.CERTIFICATE_MAX_MB * 1024 * 1024 + 10)]) });
    expect(big.status).toBe(413);
    expect(storedFiles()).toHaveLength(n); // tidak ada file baru
    const wrongField = await request(app).post(`${API}/calibrations`).set(bearer(tech)).field('equipment_id', e.equipment_id).attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(wrongField.status).toBe(400);
  });

  it('GET :id/certificate: unduh sesuai tipe; 404 tanpa sertifikat / id asing; wajib login', async () => {
    const e = await mkEq();
    const withCert = (await postCal(tech, { equipment_id: e.equipment_id, certificate_number: 'C/9' }, { buf: PDF })).body.data;
    const without = (await postCal(tech, { equipment_id: e.equipment_id })).body.data;
    const dl = await request(app).get(`${API}/calibrations/${withCert.calibration_id}/certificate`).set(bearer(qa)).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toContain('sertifikat-C_9.pdf');
    expect((dl.body as Buffer).equals(PDF)).toBe(true);
    expect(withCert.certificate_download_path).toBe(`/api/v1/calibrations/${withCert.calibration_id}/certificate`);
    expect((await request(app).get(`${API}/calibrations/${without.calibration_id}/certificate`).set(bearer(qa))).status).toBe(404);
    expect((await request(app).get(`${API}/calibrations/99999999-9999-4999-8999-999999999999/certificate`).set(bearer(qa))).status).toBe(404);
    expect((await request(app).get(`${API}/calibrations/${withCert.calibration_id}/certificate`)).status).toBe(401);
    // file hilang dari disk → 404 (bukan 500)
    await rm(certDir(), { recursive: true, force: true });
    expect((await request(app).get(`${API}/calibrations/${withCert.calibration_id}/certificate`).set(bearer(qa))).status).toBe(404);
  });
});

describe('start-calibration', () => {
  const start = (token: string, id: string) => request(app).post(`${API}/equipment/${id}/start-calibration`).set(bearer(token));
  it('available → calibration (tercatat); ditolak: borrowed, sudah calibration, maintenance, nonaktif, 404', async () => {
    const e = await mkEq();
    const ok = await start(tech, e.equipment_id);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'calibration', previous_status: 'available' });
    expect(fake.activityLog.rows.some((l: any) => l.action === 'START_CALIBRATION' && l.entity_id === e.equipment_id)).toBe(true);
    expect((await start(tech, e.equipment_id)).body.error.code).toBe('ALREADY_IN_CALIBRATION');
    const b = await mkEq();
    eqRow(b.equipment_id).status = 'borrowed';
    expect((await start(tech, b.equipment_id)).body.error.code).toBe('EQUIPMENT_BORROWED');
    expect(eqRow(b.equipment_id).status).toBe('borrowed');
    const m = await mkEq({ status: 'maintenance' });
    expect((await start(tech, m.equipment_id)).body.error.code).toBe('EQUIPMENT_IN_MAINTENANCE');
    const off = await mkEq();
    await request(app).delete(`${API}/equipment/${off.equipment_id}`).set(bearer(spv));
    expect((await start(tech, off.equipment_id)).body.error.code).toBe('EQUIPMENT_INACTIVE');
    expect((await start(tech, '99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });
});

describe('Kalibrasi — list, schedule, summary', () => {
  async function seed() {
    const safe = await mkEq({ next_calibration_date: day(200) });
    const soon = await mkEq({ next_calibration_date: day(10) });
    const late = await mkEq({ next_calibration_date: day(-5) });
    const none = await mkEq();
    const off = await mkEq({ next_calibration_date: day(-50) });
    await request(app).delete(`${API}/equipment/${off.equipment_id}`).set(bearer(spv));
    return { safe, soon, late, none, off };
  }

  it('summary: jumlah safe / due_soon / overdue (alat aktif) + tanpa jadwal', async () => {
    await seed();
    const res = await request(app).get(`${API}/calibrations/summary`).set(bearer(qa));
    expect(res.body.data).toMatchObject({ safe: 1, due_soon: 1, overdue: 1, no_schedule: 1, total_scheduled: 3, due_soon_days: 30 });
    expect((await request(app).get(`${API}/calibrations/summary?room_id=bukan`).set(bearer(qa))).status).toBe(422);
  });

  it('schedule?month=: alat jatuh tempo bulan itu, dikelompokkan per tanggal; validasi format', async () => {
    const { soon, safe } = await seed();
    const m = (d: string) => d.slice(0, 7);
    const target = soon.next_calibration_date;
    await request(app).patch(`${API}/equipment/${safe.equipment_id}`).set(bearer(spv)).send({ next_calibration_date: target }); // 2 alat di tanggal sama
    const res = await request(app).get(`${API}/calibrations/schedule?month=${m(target)}`).set(bearer(qa));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.month).toBe(m(target));
    const bucket = d.days.find((x: any) => x.date === target);
    expect(bucket.items.map((i: any) => i.equipment_id).sort()).toEqual([soon.equipment_id, safe.equipment_id].sort());
    expect(bucket.items[0]).toMatchObject({ calibration_state: 'due_soon', days_until_due: 10, room: { room_code: 'LAB-B' } });
    expect(d.total).toBeGreaterThanOrEqual(2);
    const dates = d.days.map((x: any) => x.date);
    expect([...dates].sort()).toEqual(dates);
    const empty = await request(app).get(`${API}/calibrations/schedule?month=2020-02`).set(bearer(qa));
    expect(empty.body.data).toMatchObject({ total: 0, days: [], from: '2020-02-01', to: '2020-02-29' });
    for (const bad of ['2026-13', '2026-1', 'abc', '']) expect((await request(app).get(`${API}/calibrations/schedule?month=${bad}`).set(bearer(qa))).status).toBe(422);
    expect((await request(app).get(`${API}/calibrations/schedule`).set(bearer(qa))).status).toBe(422);
  });

  it('list: filter equipment_id, result, date range, state; detail; pagination', async () => {
    const a = await mkEq();
    const b = await mkEq();
    await postCal(tech, { equipment_id: a.equipment_id, calibration_date: day(-30), next_calibration_date: day(5), calibration_provider: 'Alpha Lab' });
    await postCal(tech, { equipment_id: a.equipment_id, calibration_date: day(-3), calibration_result: 'failed', next_calibration_date: day(20) });
    await postCal(tech, { equipment_id: b.equipment_id, calibration_date: day(-1), next_calibration_date: day(400) });
    const get = (qs: string) => request(app).get(`${API}/calibrations${qs}`).set(bearer(qa));
    expect((await get('')).body.meta.total).toBe(3);
    expect((await get(`?equipment_id=${a.equipment_id}`)).body.meta.total).toBe(2);
    expect((await get('?result=failed')).body.meta.total).toBe(1);
    expect((await get(`?date_from=${day(-5)}&date_to=${day(0)}`)).body.meta.total).toBe(2);
    expect((await get('?state=safe')).body.data.every((r: any) => r.equipment.calibration_state === 'safe')).toBe(true);
    expect((await get('?state=overdue')).body.meta.total).toBe(0);
    expect((await get('?search=alpha')).body.meta.total).toBe(1);
    const first = (await get('?limit=1&sort=calibration_date&order=asc')).body;
    expect(first.meta).toMatchObject({ total: 3, totalPages: 3 });
    expect(first.data[0]).toMatchObject({ calibration_date: day(-30), equipment: { inventory_code: expect.any(String) } });
    expect((await get('?state=lain')).status).toBe(422);
    expect((await get(`?date_from=${day(0)}&date_to=${day(-5)}`)).status).toBe(422);
    expect((await get(`/${first.data[0].calibration_id}`)).body.data.calibration_provider).toBe('Alpha Lab');
    expect((await get('/99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });
});

// ───────────────────────── MAINTENANCES ─────────────────────────

const mkM = (token: string, e: any, over: Record<string, unknown> = {}) =>
  request(app).post(`${API}/maintenances`).set(bearer(token)).send({ equipment_id: e.equipment_id, maintenance_type: 'routine', maintenance_date: day(3), ...over });
const patchM = (token: string, id: string, body: Record<string, unknown>) => request(app).patch(`${API}/maintenances/${id}`).set(bearer(token)).send(body);
const actions = () => fake.activityLog.rows.filter((l: any) => l.entity_type === 'maintenance').map((l: any) => l.action);

describe('Mesin status maintenance', () => {
  it('tabel transisi', () => {
    expect(canTransition('scheduled', 'in_progress')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
    for (const [a, b] of [['scheduled', 'completed'], ['in_progress', 'scheduled'], ['completed', 'in_progress'], ['completed', 'cancelled'], ['cancelled', 'scheduled']] as const) {
      expect(canTransition(a, b)).toBe(false);
    }
  });

  it('alur lengkap: scheduled → in_progress (alat maintenance) → completed (alat available, completion_date terisi)', async () => {
    const e = await mkEq();
    const m = (await mkM(tech, e, { description: 'Ganti filter', cost: 250000 })).body.data;
    expect(m).toMatchObject({ status: 'scheduled', technician_id: techId, cost: 250000, equipment: { inventory_code: e.inventory_code } });
    expect(eqRow(e.equipment_id).status).toBe('available');

    const st = await patchM(tech, m.maintenance_id, { status: 'in_progress' });
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ status: 'in_progress', equipment_status_after: 'maintenance' });
    expect(eqRow(e.equipment_id).status).toBe('maintenance');

    const done = await patchM(tech, m.maintenance_id, { status: 'completed', replaced_spare_parts: 'Filter', notes: 'OK' });
    expect(done.body.data).toMatchObject({ status: 'completed', equipment_status_after: 'available', replaced_spare_parts: 'Filter' });
    expect(done.body.data.completion_date).toBeTruthy();
    expect(eqRow(e.equipment_id).status).toBe('available');
    expect(actions()).toEqual(['CREATE', 'MAINTENANCE_START', 'MAINTENANCE_COMPLETE']);

    const locked = await patchM(spv, m.maintenance_id, { notes: 'ubah' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('MAINTENANCE_LOCKED');
  });

  it('completed dengan equipment_damaged=true → alat damaged; completion_date manual', async () => {
    const e = await mkEq();
    const m = (await mkM(tech, e, { maintenance_type: 'repair' })).body.data;
    await patchM(tech, m.maintenance_id, { status: 'in_progress' });
    const done = await patchM(tech, m.maintenance_id, { status: 'completed', equipment_damaged: true, completion_date: '2026-10-30T08:00:00Z' });
    expect(done.body.data).toMatchObject({ equipment_status_after: 'damaged', completion_date: '2026-10-30T08:00:00.000Z' });
    expect(eqRow(e.equipment_id).status).toBe('damaged');
  });

  it('cancelled: dari in_progress mengembalikan status SEBELUMNYA (damaged tetap damaged); dari scheduled alat tidak disentuh', async () => {
    const dmg = await mkEq({ status: 'damaged' });
    const m1 = (await mkM(tech, dmg, { maintenance_type: 'repair' })).body.data;
    await patchM(tech, m1.maintenance_id, { status: 'in_progress' });
    expect(eqRow(dmg.equipment_id).status).toBe('maintenance');
    expect(m1.prev_equipment_status).toBeNull();
    const c1 = await patchM(tech, m1.maintenance_id, { status: 'cancelled' });
    expect(c1.body.data).toMatchObject({ status: 'cancelled', equipment_status_after: 'damaged', prev_equipment_status: null });
    expect(eqRow(dmg.equipment_id).status).toBe('damaged');

    const ok = await mkEq();
    const m2 = (await mkM(tech, ok)).body.data;
    const c2 = await patchM(tech, m2.maintenance_id, { status: 'cancelled' });
    expect(c2.body.data.status).toBe('cancelled');
    expect(c2.body.data.equipment_status_after).toBeUndefined();
    expect(eqRow(ok.equipment_id).status).toBe('available');
    expect(actions()).toContain('MAINTENANCE_CANCEL');
  });

  it('transisi tidak sah → 422 INVALID_TRANSITION + daftar yang diizinkan', async () => {
    const e = await mkEq();
    const m = (await mkM(tech, e)).body.data;
    const bad = await patchM(tech, m.maintenance_id, { status: 'completed' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'scheduled', to: 'completed', allowed: ['in_progress', 'cancelled'] } });
    expect((await patchM(tech, m.maintenance_id, { status: 'bebas' })).status).toBe(422);
    expect(eqRow(e.equipment_id).status).toBe('available');

    await patchM(tech, m.maintenance_id, { status: 'in_progress' });
    expect((await patchM(tech, m.maintenance_id, { status: 'scheduled' })).body.error.code).toBe('INVALID_TRANSITION');
    // completion_date / equipment_damaged hanya saat completed
    expect((await patchM(tech, m.maintenance_id, { completion_date: day(0) })).status).toBe(422);
    expect((await patchM(tech, m.maintenance_id, { equipment_damaged: true })).status).toBe(422);
    expect((await patchM(tech, m.maintenance_id, { status: 'completed', completion_date: '2099-01-01T00:00:00Z' })).status).toBe(422);
    expect((await patchM(tech, m.maintenance_id, {})).status).toBe(422);
  });

  it('in_progress ditolak jika alat borrowed / calibration / sudah maintenance lain / nonaktif; tidak ada perubahan', async () => {
    const mk = async (status: string) => {
      const e = await mkEq();
      eqRow(e.equipment_id).status = status;
      return { e, m: (await mkM(tech, e)).body.data };
    };
    const cases: [string, string][] = [['borrowed', 'EQUIPMENT_BORROWED'], ['calibration', 'EQUIPMENT_IN_CALIBRATION'], ['maintenance', 'EQUIPMENT_IN_MAINTENANCE']];
    for (const [status, code] of cases) {
      const { e, m } = await mk(status);
      const r = await patchM(tech, m.maintenance_id, { status: 'in_progress' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe(code);
      expect(eqRow(e.equipment_id).status).toBe(status);
      expect(fake.maintenance.rows.find((x: any) => x.maintenance_id === m.maintenance_id).status).toBe('scheduled');
    }
    const e = await mkEq();
    const m = (await mkM(tech, e)).body.data;
    await request(app).delete(`${API}/equipment/${e.equipment_id}`).set(bearer(spv));
    expect((await patchM(tech, m.maintenance_id, { status: 'in_progress' })).body.error.code).toBe('EQUIPMENT_INACTIVE');
  });

  it('completed ketika admin sudah mengubah status alat manual → alat tidak ditimpa', async () => {
    const e = await mkEq();
    const m = (await mkM(tech, e)).body.data;
    await patchM(tech, m.maintenance_id, { status: 'in_progress' });
    eqRow(e.equipment_id).status = 'calibration';
    const done = await patchM(tech, m.maintenance_id, { status: 'completed' });
    expect(done.body.data.equipment_status_after).toBe('calibration');
    expect(eqRow(e.equipment_id).status).toBe('calibration');
  });
});

describe('Maintenances — CRUD, RBAC, filter', () => {
  it('QA hanya GET; technician buat/ubah; hapus hanya admin/SPV dan hanya scheduled', async () => {
    const e = await mkEq();
    expect((await mkM(qa, e)).status).toBe(403);
    const m = (await mkM(tech, e)).body.data;
    expect((await patchM(qa, m.maintenance_id, { notes: 'x' })).status).toBe(403);
    expect((await request(app).delete(`${API}/maintenances/${m.maintenance_id}`).set(bearer(qa))).status).toBe(403);
    expect((await request(app).delete(`${API}/maintenances/${m.maintenance_id}`).set(bearer(tech))).status).toBe(403);
    for (const t of [qa, tech, spv, admin]) expect((await request(app).get(`${API}/maintenances/${m.maintenance_id}`).set(bearer(t))).status).toBe(200);

    expect((await patchM(tech, m.maintenance_id, { description: 'baru', maintenance_type: 'repair', cost: null })).body.data).toMatchObject({ description: 'baru', maintenance_type: 'repair', cost: null });
    const del = await request(app).delete(`${API}/maintenances/${m.maintenance_id}`).set(bearer(spv));
    expect(del.status).toBe(200);
    expect(fake.maintenance.rows).toHaveLength(0);
    expect(actions()).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect((await request(app).get(`${API}/maintenances/${m.maintenance_id}`).set(bearer(qa))).status).toBe(404);

    const m2 = (await mkM(tech, e)).body.data;
    await patchM(tech, m2.maintenance_id, { status: 'in_progress' });
    const nope = await request(app).delete(`${API}/maintenances/${m2.maintenance_id}`).set(bearer(admin));
    expect(nope.status).toBe(409);
    expect(nope.body.error.code).toBe('MAINTENANCE_NOT_DELETABLE');
  });

  it('validasi create & penugasan teknisi', async () => {
    const e = await mkEq();
    expect((await mkM(tech, e, { maintenance_type: 'lain' })).status).toBe(422);
    expect((await mkM(tech, e, { maintenance_date: 'kemarin' })).status).toBe(422);
    expect((await mkM(tech, e, { maintenance_date: '2026-11-01T10:00:00' })).status).toBe(422); // tanpa zona waktu
    expect((await mkM(tech, e, { cost: -1 })).status).toBe(422);
    expect((await mkM(tech, { equipment_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(422);
    expect((await mkM(tech, e, { technician_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(422);
    const spvId = fake.user.rows.find((u: any) => u.email === 'spv@x.local').user_id;
    const assigned = await mkM(spv, e, { technician_id: techId, maintenance_date: '2026-11-05' });
    expect(assigned.body.data).toMatchObject({ technician_id: techId, maintenance_date: '2026-11-05T00:00:00.000Z' });
    expect(spvId).toBeTruthy();
    const off = await mkEq();
    await request(app).delete(`${API}/equipment/${off.equipment_id}`).set(bearer(spv));
    expect((await mkM(tech, off)).body.error.code).toBe('EQUIPMENT_INACTIVE');
    expect((await request(app).post(`${API}/maintenances`).send({})).status).toBe(401);
  });

  it('list: filter maintenance_type, status, equipment_id, tanggal, search + pagination', async () => {
    const a = await mkEq();
    const b = await mkEq();
    const m1 = (await mkM(tech, a, { maintenance_type: 'routine', maintenance_date: '2026-11-01T08:00:00Z', description: 'Servis rutin oven' })).body.data;
    await mkM(tech, a, { maintenance_type: 'repair', maintenance_date: '2026-11-10T08:00:00Z' });
    await mkM(tech, b, { maintenance_type: 'repair', maintenance_date: '2026-12-01T08:00:00Z' });
    await patchM(tech, m1.maintenance_id, { status: 'in_progress' });
    const get = (qs: string) => request(app).get(`${API}/maintenances${qs}`).set(bearer(qa));
    expect((await get('')).body.meta.total).toBe(3);
    expect((await get('?maintenance_type=repair')).body.meta.total).toBe(2);
    expect((await get('?status=in_progress')).body.data[0].maintenance_id).toBe(m1.maintenance_id);
    expect((await get(`?equipment_id=${b.equipment_id}`)).body.meta.total).toBe(1);
    expect((await get('?date_from=2026-11-01&date_to=2026-11-10')).body.meta.total).toBe(2); // date_to inklusif
    expect((await get('?date_from=2026-11-02&date_to=2026-11-30')).body.meta.total).toBe(1);
    expect((await get('?search=rutin')).body.meta.total).toBe(1);
    const page = (await get('?limit=2&sort=maintenance_date&order=asc')).body;
    expect(page.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect(page.data[0]).toMatchObject({ equipment: { inventory_code: a.inventory_code }, technician: { name: 'Teknisi' } });
    expect((await get('?status=lain')).status).toBe(422);
    expect((await get('?date_from=2026-12-01&date_to=2026-11-01')).status).toBe(422);
    expect((await get('?limit=500')).status).toBe(422);
  });
});
