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
import { DEMO_PASSWORD, ROOM_B } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function login(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password });
  return res.body.data.access_token as string;
}

let admin: string, spv: string, tech: string;

beforeEach(async () => {
  await fake.reset();
  admin = await login('admin@lab.local');
  tech = await login('technician@lab.local');
  await request(app).post(`${API}/users`).set(bearer(admin)).send({ name: 'SPV', email: 'spv@x.local', role: 'SPV', password: 'Password123' });
  spv = await login('spv@x.local', 'Password123');
});

describe('Alur utama: tambah alat → QR → scan → pinjam → kembalikan rusak', () => {
  it('status & notifikasi berubah, QR tetap valid setelah alat diedit', async () => {
    // 1. tambah alat
    const created = await request(app)
      .post(`${API}/equipment`)
      .set(bearer(spv))
      .send({ inventory_code: 'EQ-FLOW-1', equipment_name: 'Oven Lab', equipment_type: 'Oven', room_id: ROOM_B });
    expect(created.status).toBe(201);
    const { equipment_id, qr_token } = created.body.data;
    expect(qr_token).toHaveLength(12);

    // 2. ambil QR (PNG)
    const png = await request(app).get(`${API}/equipment/${equipment_id}/qr.png`).set(bearer(tech)).buffer(true).parse(binary);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');

    // 3. scan → boleh dipinjam
    const scan1 = await request(app).get(`${API}/scan/eq/${qr_token}`).set(bearer(tech));
    expect(scan1.status).toBe(200);
    expect(scan1.body.data).toMatchObject({ status: 'available', equipment_id });
    expect(scan1.body.data.available_actions).toContain('borrow');

    // 4. pinjam via qr_token
    const borrowed = await request(app)
      .post(`${API}/borrowings`)
      .set(bearer(tech))
      .send({ purpose: 'Praktikum', expected_return_time: inHours(24), equipment: [{ qr_token }] });
    expect(borrowed.status).toBe(201);
    const b = borrowed.body.data;
    expect(fake.equipment.rows.find((r: any) => r.equipment_id === equipment_id).status).toBe('borrowed');
    expect((await request(app).get(`${API}/scan/eq/${qr_token}`).set(bearer(tech))).body.data.available_actions).toEqual(['return']);

    // 5. kembalikan dengan kerusakan
    const detailId = b.equipment[0].detail_id;
    const returned = await request(app)
      .post(`${API}/borrowings/${b.borrowing_id}/return`)
      .set(bearer(tech))
      .send({ items: [{ detail_id: detailId, final_condition: 'major_damage', damage_notes: 'Elemen pemanas putus' }] });
    expect(returned.status).toBe(200);
    expect(returned.body.data).toMatchObject({ completed: true, borrowing_status: 'returned', damage_reported: true });

    // 6. status alat + notifikasi
    expect(fake.equipment.rows.find((r: any) => r.equipment_id === equipment_id)).toMatchObject({ status: 'damaged', condition: 'major_damage' });
    const roles = fake.notification.rows.map((n: any) => fake.user.rows.find((u: any) => u.user_id === n.user_id).role).sort();
    expect(roles).toEqual(['SPV', 'technician']);
    expect(fake.notification.rows[0]).toMatchObject({ borrowing_id: b.borrowing_id, is_read: false });
    const spvNotifs = await request(app).get(`${API}/notifications`).set(bearer(spv));
    expect(spvNotifs.status).toBe(200);
    expect(spvNotifs.body.data.length).toBeGreaterThan(0);

    // 7. edit alat → QR tetap valid & tidak berubah
    const patched = await request(app)
      .patch(`${API}/equipment/${equipment_id}`)
      .set(bearer(spv))
      .send({ equipment_name: 'Oven Lab (rev)', qr_token: 'HACKED000000' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.qr_token).toBe(qr_token);
    const scan2 = await request(app).get(`${API}/scan/eq/${qr_token}`).set(bearer(tech));
    expect(scan2.status).toBe(200);
    expect(scan2.body.data).toMatchObject({ equipment_id, equipment_name: 'Oven Lab (rev)', status: 'damaged', qr_token });
    expect([404, 422]).toContain((await request(app).get(`${API}/scan/eq/HACKED000000`).set(bearer(tech))).status);
  });
});
