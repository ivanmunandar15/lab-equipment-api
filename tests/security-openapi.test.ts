/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  const fake = createFakeDb();
  return { getDb: () => fake, disconnectDb: async () => undefined, __fake: fake };
});

import * as dbModule from '../src/config/db';
import { createApp } from '../src/app';
import { openapiSpec } from '../src/docs/openapi';
import { documentMimeMatches, resolveStoragePath, saveCertificate } from '../src/utils/storage';
import { DEMO_PASSWORD } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const UUID = '11111111-1111-4111-8111-111111111111';
const ROOT = process.cwd();

// ───────────── Ekstraksi route dari source ─────────────
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
function collectRoutes(): { method: Method; path: string }[] {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8');
  const mounts: Record<string, string> = {};
  for (const m of appSrc.matchAll(/api\.use\('([^']+)',\s*(\w+)\)/g)) mounts[m[2]] = m[1];
  const out: { method: Method; path: string }[] = [];
  const modules = path.join(ROOT, 'src/modules');
  for (const dir of fs.readdirSync(modules)) {
    for (const f of fs.readdirSync(path.join(modules, dir)).filter((x) => x.endsWith('.routes.ts'))) {
      const src = fs.readFileSync(path.join(modules, dir, f), 'utf8');
      for (const m of src.matchAll(/(\w+Router)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
        const prefix = mounts[m[1]];
        if (prefix === undefined) throw new Error(`Router ${m[1]} tidak terdaftar di app.ts`);
        out.push({ method: m[2] as Method, path: prefix + (m[3] === '/' ? '' : m[3]) });
      }
    }
  }
  return out;
}
const routes = collectRoutes();
const norm = (p: string) => p.replace(/:\w+/g, '{}').replace(/\{[^}]+\}/g, '{}');

/** Satu-satunya endpoint tanpa JWT: health, login/refresh/logout (cookie), ingest perangkat IoT (X-Sensor-Key). */
const PUBLIC = new Set(['GET /health', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout']);
const DEVICE = new Set(['POST /monitoring/readings']);

describe('OpenAPI', () => {
  it('terdeteksi route yang cukup (sanity)', () => {
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.some((r) => r.path === '/dashboard/stats')).toBe(true);
  });

  it('setiap route terdaftar di OpenAPI dan sebaliknya', () => {
    const doc = new Set<string>();
    for (const [p, ops] of Object.entries(openapiSpec.paths as Record<string, Record<string, unknown>>)) {
      for (const m of Object.keys(ops)) doc.add(`${m.toUpperCase()} ${norm(p)}`);
    }
    const code = new Set(routes.map((r) => `${r.method.toUpperCase()} ${norm(r.path)}`));
    expect([...code].filter((r) => !doc.has(r))).toEqual([]);
    expect([...doc].filter((r) => !code.has(r))).toEqual([]);
  });

  it('setiap operasi punya responses, dan operasi terproteksi mendeklarasikan security', () => {
    for (const [p, ops] of Object.entries(openapiSpec.paths as Record<string, Record<string, any>>)) {
      for (const [m, op] of Object.entries(ops)) {
        const key = `${m.toUpperCase()} ${p}`;
        expect(Object.keys(op.responses ?? {}).length, key).toBeGreaterThan(0);
        if (!PUBLIC.has(key) && !DEVICE.has(key)) expect(op.security, key).toBeTruthy();
      }
    }
  });
});

describe('Keamanan: source', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'prisma'));

  it('tidak ada API raw "Unsafe" maupun Prisma.raw', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\$(queryRawUnsafe|executeRawUnsafe)|Prisma\.raw\(/);
    }
  });

  it('semua $queryRaw/$executeRaw memakai tagged template atau Prisma.sql (terparameter)', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const all = (src.match(/\$(?:queryRaw|executeRaw)\b/g) ?? []).length;
      const safe = (src.match(/\$(?:queryRaw|executeRaw)(?:<[\s\S]*?>)?(?:\(\s*(?:Prisma|P)\.sql)?`/g) ?? []).length;
      expect(safe, f).toBe(all);
    }
  });

  it('tidak ada folder upload yang disajikan statis (file hanya lewat endpoint ber-autentikasi)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8')).not.toMatch(/express\.static/);
  });
});

describe('Keamanan: file upload', () => {
  it('storage key yang keluar dari folder upload ditolak (path traversal)', () => {
    for (const k of ['../secret.txt', '../../etc/passwd', 'certificates/../../x', '/etc/passwd']) {
      expect(() => resolveStoragePath(k), k).toThrow();
    }
    expect(resolveStoragePath('certificates/ok.pdf')).toContain(path.join('certificates', 'ok.pdf'));
  });

  it('isi file dicek (magic bytes): executable berkedok PDF ditolak', async () => {
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 bukan pdf');
    await expect(saveCertificate({ buffer: exe, mimetype: 'application/pdf' })).rejects.toMatchObject({ statusCode: 422 });
    expect(documentMimeMatches(exe, 'application/pdf')).toBe(false);
    expect(documentMimeMatches(Buffer.from('%PDF-1.7\n'), 'application/pdf')).toBe(true);
  });
});

describe('Keamanan: autentikasi tiap route', () => {
  it('tanpa token → 401 di semua route non-publik', async () => {
    const targets = routes.filter((r) => !PUBLIC.has(`${r.method.toUpperCase()} ${r.path}`));
    expect(targets.length).toBeGreaterThan(70);
    const failures: string[] = [];
    for (const r of targets) {
      const url = API + r.path.replace(/:\w+/g, UUID);
      const res = await (request(app) as any)[r.method](url);
      if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe('Keamanan: RBAC per role', () => {
  let admin: string, spv: string, tech: string, qa: string;
  const login = async (email: string, password = DEMO_PASSWORD) =>
    (await request(app).post(`${API}/auth/login`).send({ email, password })).body.data.access_token as string;
  const call = (method: Method, url: string, token: string, body: object = {}) => (request(app) as any)[method](API + url).set(bearer(token)).send(body);

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

  const FORBIDDEN: [string, Method, string, 'admin' | 'SPV' | 'technician' | 'QA'][] = [
    ['users dikelola admin saja (SPV)', 'get', '/users', 'SPV'],
    ['users dikelola admin saja (technician)', 'get', '/users', 'technician'],
    ['users dikelola admin saja (QA)', 'post', '/users', 'QA'],
    ['activity log: technician dilarang', 'get', '/activity-logs', 'technician'],
    ['dashboard recent-activity: technician dilarang', 'get', '/dashboard/recent-activity', 'technician'],
    ['alat: QA tidak boleh membuat', 'post', '/equipment', 'QA'],
    ['alat: technician tidak boleh membuat', 'post', '/equipment', 'technician'],
    ['alat: QA tidak boleh menghapus', 'delete', `/equipment/${UUID}`, 'QA'],
    ['ruangan: technician tidak boleh membuat', 'post', '/rooms', 'technician'],
    ['barang pendukung: QA tidak boleh membuat', 'post', '/supporting-equipment', 'QA'],
    ['sensor: technician tidak boleh melihat/kelola', 'get', '/sensors', 'technician'],
    ['sensor: QA tidak boleh membuat', 'post', '/sensors', 'QA'],
    ['kalibrasi: QA hanya lihat', 'post', '/calibrations', 'QA'],
    ['maintenance: QA hanya lihat', 'post', '/maintenances', 'QA'],
    ['dokumen: QA tidak boleh unggah', 'post', `/documents`, 'QA'],
  ];
  it.each(FORBIDDEN)('403 — %s', async (_n, method, url, role) => {
    const token = { admin, SPV: spv, technician: tech, QA: qa }[role];
    const res = await call(method, url, token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBeTruthy();
  });

  const ALLOWED: [string, Method, string, 'admin' | 'SPV' | 'technician' | 'QA'][] = [
    ['admin: users', 'get', '/users', 'admin'],
    ['SPV: activity log', 'get', '/activity-logs', 'SPV'],
    ['QA: activity log', 'get', '/activity-logs', 'QA'],
    ['technician: lihat alat', 'get', '/equipment', 'technician'],
    ['QA: lihat kalibrasi', 'get', '/calibrations', 'QA'],
    ['QA: lihat maintenance', 'get', '/maintenances', 'QA'],
    ['technician: dashboard stats', 'get', '/dashboard/stats', 'technician'],
    ['QA: dashboard recent-activity', 'get', '/dashboard/recent-activity', 'QA'],
  ];
  it.each(ALLOWED)('diizinkan — %s', async (_n, method, url, role) => {
    const token = { admin, SPV: spv, technician: tech, QA: qa }[role];
    const res = await call(method, url, token);
    expect([401, 403]).not.toContain(res.status);
  });
});
