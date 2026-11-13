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
import { DEMO_PASSWORD } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';

async function loginAs(email: string, password = DEMO_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).send({ email, password });
  return { agent, res, token: res.body?.data?.access_token as string };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  await fake.reset();
});

describe('POST /auth/login', () => {
  it('sukses: mengembalikan access token, set cookie httpOnly, tanpa password_hash', async () => {
    const { res } = await loginAs('admin@lab.local');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user.email).toBe('admin@lab.local');
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toContain('refresh_token=');
    expect(cookie).toContain('HttpOnly');
  });

  it('gagal: password salah dan email tidak dikenal memberi pesan yang sama (401)', async () => {
    const a = await loginAs('admin@lab.local', 'SalahBanget1');
    const b = await loginAs('tidakada@lab.local', 'SalahBanget1');
    expect(a.res.status).toBe(401);
    expect(b.res.status).toBe(401);
    expect(a.res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(a.res.body.error.message).toBe(b.res.body.error.message);
  });

  it('gagal: user tidak aktif ditolak (403)', async () => {
    const { res } = await loginAs('inactive@lab.local');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('gagal: body tidak valid (422)', async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ email: 'bukan-email' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('refresh, logout, me', () => {
  it('GET /me tanpa token 401, dengan token 200', async () => {
    expect((await request(app).get(`${API}/auth/me`)).status).toBe(401);
    const { token } = await loginAs('technician@lab.local');
    const res = await request(app).get(`${API}/auth/me`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('technician');
  });

  it('refresh merotasi token; token lama tidak bisa dipakai lagi', async () => {
    const { agent, res } = await loginAs('admin@lab.local');
    const oldCookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    const r1 = await agent.post(`${API}/auth/refresh`);
    expect(r1.status).toBe(200);
    expect(r1.body.data.access_token).toBeTruthy();
    const newCookie = (r1.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect(newCookie).not.toBe(oldCookie);

    const reuse = await request(app).post(`${API}/auth/refresh`).set('Cookie', oldCookie);
    expect(reuse.status).toBe(401);
  });

  it('refresh tanpa cookie 401', async () => {
    expect((await request(app).post(`${API}/auth/refresh`)).status).toBe(401);
  });

  it('logout mencabut refresh token', async () => {
    const { agent, res } = await loginAs('admin@lab.local');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect((await agent.post(`${API}/auth/logout`)).status).toBe(200);
    const after = await request(app).post(`${API}/auth/refresh`).set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('PATCH /me/password: password lama salah 400; benar berhasil dan login baru jalan', async () => {
    const { agent, token } = await loginAs('technician@lab.local');
    const bad = await agent.patch(`${API}/auth/me/password`).set(bearer(token)).send({ current_password: 'Salah12345', new_password: 'BaruAman123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

    const good = await agent.patch(`${API}/auth/me/password`).set(bearer(token)).send({ current_password: DEMO_PASSWORD, new_password: 'BaruAman123' });
    expect(good.status).toBe(200);
    expect((await loginAs('technician@lab.local', 'BaruAman123')).res.status).toBe(200);
    expect((await loginAs('technician@lab.local')).res.status).toBe(401);
  });
});

describe('/users (admin saja)', () => {
  it('tanpa token 401; technician 403; admin 200 tanpa password_hash', async () => {
    expect((await request(app).get(`${API}/users`)).status).toBe(401);

    const tech = await loginAs('technician@lab.local');
    const forbidden = await request(app).get(`${API}/users`).set(bearer(tech.token));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const admin = await loginAs('admin@lab.local');
    const res = await request(app).get(`${API}/users?limit=2&sort=name&order=asc`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });

  it('filter role dan search', async () => {
    const { token } = await loginAs('admin@lab.local');
    const r = await request(app).get(`${API}/users?role=QA&is_active=false`).set(bearer(token));
    expect(r.body.data).toHaveLength(1);
    const s = await request(app).get(`${API}/users?search=tekni`).set(bearer(token));
    expect(s.body.data[0].email).toBe('technician@lab.local');
  });

  it('POST tanpa password → password sementara, user bisa login; email duplikat 409', async () => {
    const { token } = await loginAs('admin@lab.local');
    const res = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'User Baru', email: 'Baru@Lab.Local', role: 'QA' });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('baru@lab.local');
    expect(res.body.data.temporary_password).toBeTruthy();
    expect(res.body.data.password_hash).toBeUndefined();
    expect((await loginAs('baru@lab.local', res.body.data.temporary_password)).res.status).toBe(200);

    const dup = await request(app).post(`${API}/users`).set(bearer(token)).send({ name: 'Dobel', email: 'baru@lab.local', role: 'QA' });
    expect(dup.status).toBe(409);
  });

  it('admin tidak boleh menonaktifkan diri sendiri (DELETE dan PATCH)', async () => {
    const { token, res } = await loginAs('admin@lab.local');
    const id = res.body.data.user.user_id;
    const del = await request(app).delete(`${API}/users/${id}`).set(bearer(token));
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe('SELF_DEACTIVATION');
    const patch = await request(app).patch(`${API}/users/${id}`).set(bearer(token)).send({ is_active: false });
    expect(patch.status).toBe(400);
  });

  it('DELETE menonaktifkan user lain: login ditolak dan token lama tidak berlaku', async () => {
    const admin = await loginAs('admin@lab.local');
    const tech = await loginAs('technician@lab.local');
    const techId = tech.res.body.data.user.user_id;

    const del = await request(app).delete(`${API}/users/${techId}`).set(bearer(admin.token));
    expect(del.status).toBe(200);
    expect(del.body.data.is_active).toBe(false);

    expect((await loginAs('technician@lab.local')).res.status).toBe(403);
    expect((await request(app).get(`${API}/auth/me`).set(bearer(tech.token))).status).toBe(401);
    expect((await tech.agent.post(`${API}/auth/refresh`)).status).toBe(401);
  });

  it('reset-password: password sementara berlaku, password lama tidak', async () => {
    const admin = await loginAs('admin@lab.local');
    const id = (await loginAs('technician@lab.local')).res.body.data.user.user_id;
    const res = await request(app).post(`${API}/users/${id}/reset-password`).set(bearer(admin.token)).send({});
    expect(res.status).toBe(200);
    expect((await loginAs('technician@lab.local', res.body.data.temporary_password)).res.status).toBe(200);
    expect((await loginAs('technician@lab.local')).res.status).toBe(401);
  });

  it('GET :id tidak valid 422, tidak ada 404', async () => {
    const { token } = await loginAs('admin@lab.local');
    expect((await request(app).get(`${API}/users/abc`).set(bearer(token))).status).toBe(422);
    expect((await request(app).get(`${API}/users/00000000-0000-4000-8000-000000000000`).set(bearer(token))).status).toBe(404);
  });
});
