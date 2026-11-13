/**
 * Seed data nyata laboratorium: personil (technician & SPV), ruangan, alat utama, dan alat pendukung dari
 * prisma/data/inventaris.csv dan prisma/data/supporting.csv. Logika parsing ada di prisma/seed-data.ts.
 *
 *   npm run db:seed                       # development: MENGHAPUS semua data lalu mengisi ulang
 *   SEED_PASSWORD='...' npm run db:seed   # password awal semua akun (default Password123!, hanya untuk development)
 *
 * Tidak ada data transaksi tiruan (peminjaman, kalibrasi, maintenance, sensor, notifikasi): semuanya mulai kosong.
 * Di produksi seed DITOLAK kecuali SEED_FORCE=true dan SEED_PASSWORD diisi, karena seed menghapus seluruh tabel.
 */
import { PrismaClient, Prisma, Role, EquipmentStatus, ItemCondition, SupportingStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateQrToken } from '../src/utils/qr-token';
import { LAB_ROOMS, PERSONNEL, parseEquipmentCsv, parseSupportingCsv, roomCapacity } from './seed-data';

const prisma = new PrismaClient();

const DEFAULT_DEV_PASSWORD = 'Password123!';
const ADMIN = { name: 'Administrator Lab', email: 'admin@lab.local' };

const die = (msg: string): never => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

/** Date-only (kolom @db.Date): "2026-10-14" → 2026-10-14T00:00:00Z. */
const toDate = (isoDate: string | null) => (isoDate ? new Date(`${isoDate}T00:00:00.000Z`) : null);

function resolvePassword(): string {
  const prod = process.env.NODE_ENV === 'production';
  if (prod && process.env.SEED_FORCE !== 'true') {
    die('Seed menghapus SEMUA data dan ditolak saat NODE_ENV=production. Untuk admin pertama di produksi pakai lab-deploy/create-admin.mjs. (Paksa: SEED_FORCE=true)');
  }
  if (prod && !process.env.SEED_PASSWORD) die('Di produksi SEED_PASSWORD wajib diisi (jangan memakai password default).');
  const password = process.env.SEED_PASSWORD ?? DEFAULT_DEV_PASSWORD;
  // Aturan yang sama dengan backend (utils/password.ts): 8-72 karakter, ada huruf dan angka.
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    die('SEED_PASSWORD harus 8-72 karakter dan mengandung huruf serta angka.');
  }
  return password;
}

async function main() {
  const password = resolvePassword();

  // ───────── Baca & validasi data CSV sebelum menyentuh database ─────────
  const dataDir = join(__dirname, 'data');
  const eqParsed = parseEquipmentCsv(readFileSync(join(dataDir, 'inventaris.csv'), 'utf8'));
  const supParsed = parseSupportingCsv(readFileSync(join(dataDir, 'supporting.csv'), 'utf8'));
  const problems = [...eqParsed.problems, ...supParsed.problems];

  console.log('🧹 Membersihkan data lama...');
  await prisma.activityLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.emailLog.deleteMany();
  await prisma.document.deleteMany();
  await prisma.roomMonitoring.deleteMany();
  await prisma.sensor.deleteMany();
  await prisma.maintenance.deleteMany();
  await prisma.calibration.deleteMany();
  await prisma.supportingBorrowingDetail.deleteMany();
  await prisma.borrowingDetail.deleteMany();
  await prisma.borrowing.deleteMany();
  await prisma.supportingEquipment.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.room.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  // ───────── Users ─────────
  const password_hash = await bcrypt.hash(password, 10);
  const users: Prisma.UserCreateManyInput[] = [
    { user_id: randomUUID(), name: ADMIN.name, email: ADMIN.email, password_hash, role: Role.admin, is_active: true },
    ...PERSONNEL.map((p) => ({
      user_id: randomUUID(),
      name: p.name,
      email: p.email,
      password_hash,
      role: p.role === 'SPV' ? Role.SPV : Role.technician,
      is_active: true,
    })),
  ];
  await prisma.user.createMany({ data: users });

  // ───────── Rooms (penanggung jawab dikosongkan: belum ada data pembagian ruangan) ─────────
  const countByRoom = new Map<string, number>();
  for (const e of eqParsed.items) countByRoom.set(e.room_code, (countByRoom.get(e.room_code) ?? 0) + 1);
  const roomIdByCode = new Map<string, string>();
  const rooms: Prisma.RoomCreateManyInput[] = LAB_ROOMS.map((r) => {
    const room_id = randomUUID();
    roomIdByCode.set(r.room_code, room_id);
    return {
      room_id,
      room_code: r.room_code,
      room_name: r.room_name,
      equipment_capacity: roomCapacity(countByRoom.get(r.room_code) ?? 0),
      person_in_charge: null,
      description: null,
      is_active: true,
    };
  });
  await prisma.room.createMany({ data: rooms });

  // ───────── Equipment ─────────
  const usedTokens = new Set<string>();
  const uniqueToken = () => {
    let t = generateQrToken();
    while (usedTokens.has(t)) t = generateQrToken();
    usedTokens.add(t);
    return t;
  };

  const equipment: Prisma.EquipmentCreateManyInput[] = eqParsed.items.map((e) => ({
    equipment_id: randomUUID(),
    inventory_code: e.inventory_code,
    qr_token: uniqueToken(),
    equipment_name: e.equipment_name,
    equipment_type: e.equipment_type,
    brand: e.brand,
    model: e.model,
    room_id: roomIdByCode.get(e.room_code) as string,
    status: EquipmentStatus.available,
    condition: ItemCondition.good, // CSV tidak memuat kondisi; sama dengan default database
    purchase_date: toDate(e.purchase_date),
    purchase_price: null,
    useful_life_years: null,
    specifications: e.specifications,
    next_calibration_date: toDate(e.next_calibration_date),
    is_active: true,
  }));
  await prisma.equipment.createMany({ data: equipment });

  // ───────── Supporting equipment ─────────
  const supporting: Prisma.SupportingEquipmentCreateManyInput[] = supParsed.items.map((s) => ({
    supporting_equipment_id: randomUUID(),
    item_code: s.item_code,
    qr_token: uniqueToken(),
    item_name: s.item_name,
    item_type: null,
    brand: s.brand,
    model: s.model,
    unit: s.unit,
    total_quantity: s.total_quantity,
    available_quantity: s.total_quantity,
    condition: ItemCondition.good,
    status: SupportingStatus.available,
    description: s.description,
    specifications: null,
    is_active: true,
  }));
  await prisma.supportingEquipment.createMany({ data: supporting });

  // ───────── Ringkasan ─────────
  const withCal = equipment.filter((e) => e.next_calibration_date).length;
  console.log(
    `✅ Seed selesai: ${users.length} user, ${rooms.length} ruangan, ${equipment.length} alat utama ` +
      `(${withCal} dengan jadwal kalibrasi), ${supporting.length} alat pendukung`,
  );
  console.table(
    LAB_ROOMS.map((r) => ({
      kode: r.room_code,
      ruangan: r.room_name,
      alat: countByRoom.get(r.room_code) ?? 0,
      kapasitas: roomCapacity(countByRoom.get(r.room_code) ?? 0),
      'di daftar lab': r.listed ? 'ya' : 'TIDAK (dari CSV)',
    })),
  );
  if (problems.length) {
    console.log(`⚠️  ${problems.length} catatan data:`);
    for (const p of problems) console.log(`   - ${p}`);
  }
  console.log(`🔑 Password awal semua akun: ${process.env.SEED_PASSWORD ? '(dari SEED_PASSWORD)' : DEFAULT_DEV_PASSWORD}. Segera ganti di lingkungan yang dipakai bersama.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
