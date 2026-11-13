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
import { audit } from '../src/modules/activity-logs/audit.service';
import { computeDiff } from '../src/utils/diff';
import { sanitizeForAudit } from '../src/utils/sanitize';
import { DEMO_PASSWORD } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function loginAs(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password });
  return res.body?.data?.access_token as string;
}
const logs = (action?: string) =>
  fake.activityLog.rows.filter((r: any) => !action || r.action === action) as any[];

beforeEach(async () => {
  await fake.reset();
});

describe('sanitizeForAudit & computeDiff', () => {
  it('membuang field sensitif di semua level, mengubah BigInt/Date ke JSON', () => {
    const out: any = sanitizeForAudit({
      name: 'A',
      password_hash: 'x',
      refresh_token: 'y',
      nested: { api_key_hash: 'z', ok: 1n, at: new Date('2026-01-01T00:00:00Z') },
      list: [{ access_token: 't', keep: true }],
    });
    expect(out).toEqual({ name: 'A', nested: { ok: '1', at: '2026-01-01T00:00:00.000Z' }, list: [{ keep: true }] });
    expect(sanitizeForAudit(null)).toBeUndefined();
  });

  it('computeDiff hanya mengembalikan field yang berubah', () => {
    expect(computeDiff({ a: 1, b: 2, c: { x: 1 } }, { a: 1, b: 3, c: { x: 1 }, d: 4 })).toEqual([
      { field: 'b', old: 2, new: 3 },
      { field: 'd', old: null, new: 4 },
    ]);
    expect(computeDiff(null, { a: 1 })).toEqual([{ field: 'a', old: null, new: 1 }]);
  });
});

describe('audit.log', () => {
  it('memakai tx yang diberikan (bukan getDb) dan membuang field sensitif', async () => {
    const create = vi.fn().mockResolvedValue({});
    await audit.log(
      { userId: 'u1', action: 'BORROW', entityType: 'borrowing', entityId: 'b1', newData: { token: 'x', ok: true }, ip: '1.1.1.1' },
      { activityLog: { create } } as any,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({ action: 'BORROW', new_data: { ok: true }, ip_address: '1.1.1.1' });
    expect(logs()).toHaveLength(0);
  });

  it('di dalam tx, error menjalar (agar transaksi rollback)', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(audit.log({ action: 'X', entityType: 'y' }, { activityLog: { create } } as any)).rejects.toThrow('db down');
  });

  it('di luar tx, kegagalan tidak menggagalkan request bisnis', async () => {
    const token = await loginAs('admin@lab.local');
    const failing = vi.spyOn(fake.activityLog, 'create').mockRejectedValue(new Error('db down'));
    const res = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'Baru', email: 'baru@lab.local', role: 'QA' });
    failing.mockRestore();
    expect(res.status).toBe(201);
  });
});

describe('pencatatan otomatis', () => {
  it('LOGIN tercatat dengan user & ip, tanpa data sensitif', async () => {
    await loginAs('admin@lab.local');
    const [l] = logs('LOGIN');
    expect(l).toMatchObject({ entity_type: 'user', action: 'LOGIN' });
    expect(l.user_id).toBeTruthy();
    expect(l.entity_id).toBe(l.user_id);
    expect(l.ip_address).toBeTruthy();
    expect(JSON.stringify(l)).not.toMatch(/password|token/i);
  });

  it('create user → CREATE; password_hash & temporary_password tidak tersimpan', async () => {
    const token = await loginAs('admin@lab.local');
    const res = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'Baru', email: 'baru@lab.local', role: 'QA' });
    expect(res.body.data.temporary_password).toBeTruthy();
    const [l] = logs('CREATE');
    expect(l.entity_type).toBe('user');
    expect(l.entity_id).toBe(res.body.data.user_id);
    expect(l.old_data).toBeUndefined();
    expect(l.new_data).toMatchObject({ email: 'baru@lab.local', role: 'QA' });
    expect(JSON.stringify(l)).not.toMatch(/password|temporary/i);
  });

  it('update user → UPDATE dengan old_data & new_data; gagal (422/404) tidak tercatat', async () => {
    const token = await loginAs('admin@lab.local');
    const created = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'Baru', email: 'baru@lab.local', role: 'QA' });
    const id = created.body.data.user_id;

    expect((await request(app).patch(`${API}/users/${id}`).set(bearer(token)).send({ role: 'bukan-role' })).status).toBe(422);
    expect((await request(app).patch(`${API}/users/00000000-0000-4000-8000-000000000000`).set(bearer(token)).send({ name: 'Zz' })).status).toBe(404);
    expect(logs('UPDATE')).toHaveLength(0);

    const res = await request(app).patch(`${API}/users/${id}`).set(bearer(token)).send({ role: 'SPV' });
    expect(res.status).toBe(200);
    const [l] = logs('UPDATE');
    expect(l.entity_id).toBe(id);
    expect(l.old_data.role).toBe('QA');
    expect(l.new_data.role).toBe('SPV');
  });

  it('delete (soft) → DELETE; reset-password → RESET_PASSWORD tanpa password', async () => {
    const token = await loginAs('admin@lab.local');
    const created = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'Baru', email: 'baru@lab.local', role: 'QA' });
    const id = created.body.data.user_id;

    await request(app).post(`${API}/users/${id}/reset-password`).set(bearer(token)).send({});
    const [reset] = logs('RESET_PASSWORD');
    expect(reset.entity_id).toBe(id);
    expect(JSON.stringify(reset)).not.toMatch(/temporary|password_hash/i);

    await request(app).delete(`${API}/users/${id}`).set(bearer(token));
    const [del] = logs('DELETE');
    expect(del.old_data.is_active).toBe(true);
    expect(del.new_data.is_active).toBe(false);
  });

  it('PATCH /auth/me → UPDATE; change password → CHANGE_PASSWORD', async () => {
    const token = await loginAs('technician@lab.local');
    await request(app).patch(`${API}/auth/me`).set(bearer(token)).send({ name: 'Teknisi Baru' });
    const [u] = logs('UPDATE');
    expect(u.old_data.name).toBe('Teknisi');
    expect(u.new_data.name).toBe('Teknisi Baru');

    await request(app).patch(`${API}/auth/me/password`).set(bearer(token)).send({ current_password: DEMO_PASSWORD, new_password: 'BaruAman123' });
    expect(logs('CHANGE_PASSWORD')).toHaveLength(1);
  });
});

describe('GET /activity-logs', () => {
  async function seedTraffic() {
    const adminToken = await loginAs('admin@lab.local');
    const created = await request(app).post(`${API}/users`).set(bearer(adminToken)).send({ name: 'Auditor', email: 'qa2@lab.local', role: 'QA', password: 'QaPassword123' });
    const spv = await request(app).post(`${API}/users`).set(bearer(adminToken)).send({ name: 'Spv', email: 'spv2@lab.local', role: 'SPV', password: 'SpvPassword123' });
    await request(app).patch(`${API}/users/${created.body.data.user_id}`).set(bearer(adminToken)).send({ name: 'Auditor 2' });
    return { adminToken, qaId: created.body.data.user_id as string, spvId: spv.body.data.user_id as string };
  }

  it('RBAC: tanpa token 401, technician 403, admin/SPV/QA 200', async () => {
    const { adminToken } = await seedTraffic();
    expect((await request(app).get(`${API}/activity-logs`)).status).toBe(401);
    expect((await request(app).get(`${API}/activity-logs`).set(bearer(await loginAs('technician@lab.local')))).status).toBe(403);
    expect((await request(app).get(`${API}/activity-logs`).set(bearer(adminToken))).status).toBe(200);
    expect((await request(app).get(`${API}/activity-logs`).set(bearer(await loginAs('qa2@lab.local', 'QaPassword123')))).status).toBe(200);
    expect((await request(app).get(`${API}/activity-logs`).set(bearer(await loginAs('spv2@lab.local', 'SpvPassword123')))).status).toBe(200);
  });

  it('log bersifat read-only (tidak ada POST/PATCH/DELETE)', async () => {
    const { adminToken } = await seedTraffic();
    const id = logs()[0].log_id;
    expect((await request(app).post(`${API}/activity-logs`).set(bearer(adminToken)).send({})).status).toBe(404);
    expect((await request(app).delete(`${API}/activity-logs/${id}`).set(bearer(adminToken))).status).toBe(404);
  });

  it('pagination, user ringkas di list, tanpa old_data/new_data', async () => {
    const { adminToken } = await seedTraffic();
    const res = await request(app).get(`${API}/activity-logs?limit=2&page=1`).set(bearer(adminToken));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(4);
    expect(res.body.data[0].user).toHaveProperty('email');
    expect(res.body.data[0]).not.toHaveProperty('new_data');
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });

  it('filter action (tidak peka huruf), entity_type, entity_id, user_id', async () => {
    const { adminToken, qaId } = await seedTraffic();
    const get = (qs: string) => request(app).get(`${API}/activity-logs?${qs}`).set(bearer(adminToken));

    const a = await get('action=create');
    expect(a.body.data).toHaveLength(2);
    expect(a.body.data.every((x: any) => x.action === 'CREATE')).toBe(true);

    expect((await get('entity_type=USER&action=UPDATE')).body.data).toHaveLength(1);
    expect((await get('entity_type=equipment')).body.data).toHaveLength(0);
    expect((await get(`entity_id=${qaId}`)).body.data).toHaveLength(2); // CREATE + UPDATE

    const adminId = fake.user.rows.find((u: any) => u.email === 'admin@lab.local').user_id;
    const byUser = await get(`user_id=${adminId}&action=LOGIN`);
    expect(byUser.body.data).toHaveLength(1);
  });

  it('filter date_from/date_to (date-only sampai akhir hari)', async () => {
    const { adminToken } = await seedTraffic();
    const today = new Date().toISOString().slice(0, 10);
    const get = (qs: string) => request(app).get(`${API}/activity-logs?${qs}`).set(bearer(adminToken));

    const all = (await get('limit=100')).body.meta.total;
    expect((await get(`date_from=${today}&date_to=${today}&limit=100`)).body.meta.total).toBe(all);
    expect((await get('date_to=2000-01-01')).body.data).toHaveLength(0);
    expect((await get('date_from=2999-01-01')).body.data).toHaveLength(0);
  });

  it('validasi query: tanggal salah, rentang terbalik, user_id bukan uuid → 422', async () => {
    const { adminToken } = await seedTraffic();
    const get = (qs: string) => request(app).get(`${API}/activity-logs?${qs}`).set(bearer(adminToken));
    expect((await get('date_from=kemarin')).status).toBe(422);
    expect((await get('date_from=2026-10-10&date_to=2026-10-01')).status).toBe(422);
    expect((await get('user_id=abc')).status).toBe(422);
    expect((await get('limit=101')).status).toBe(422);
  });

  it('GET /:id mengembalikan old_data, new_data, dan diff; 404 & 422 untuk id salah', async () => {
    const { adminToken, qaId } = await seedTraffic();
    const list = await request(app).get(`${API}/activity-logs?action=UPDATE&entity_id=${qaId}`).set(bearer(adminToken));
    const id = list.body.data[0].log_id;

    const res = await request(app).get(`${API}/activity-logs/${id}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.old_data.name).toBe('Auditor');
    expect(res.body.data.new_data.name).toBe('Auditor 2');
    const nameChange = res.body.data.diff.find((d: any) => d.field === 'name');
    expect(nameChange).toEqual({ field: 'name', old: 'Auditor', new: 'Auditor 2' });
    expect(res.body.data.diff.some((d: any) => d.field === 'role')).toBe(false);

    expect((await request(app).get(`${API}/activity-logs/00000000-0000-4000-8000-000000000000`).set(bearer(adminToken))).status).toBe(404);
    expect((await request(app).get(`${API}/activity-logs/xyz`).set(bearer(adminToken))).status).toBe(422);
  });
});
