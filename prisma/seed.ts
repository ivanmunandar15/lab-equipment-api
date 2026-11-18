/**
 * Seed data nyata laboratorium: personil (technician & SPV), ruangan, alat utama, dan alat pendukung dari
 * prisma/data/inventaris.csv dan prisma/data/supporting.csv. Logika parsing ada di prisma/seed-data.ts.
 *
 * Dua mode (SEED_MODE):
 *   reset (default)  development: MENGHAPUS semua data lalu mengisi ulang.   npm run db:seed
 *   if-empty         deploy: mengisi HANYA jika database masih kosong (tidak pernah menghapus; aman dijalankan berulang
 *                    pada setiap start container). Dipakai scripts/docker-entrypoint.sh saat SEED_ON_START=true.
 *
 * Semuanya berjalan dalam SATU transaksi: gagal di tengah = tidak ada yang tersimpan.
 *
 * Env: SEED_PASSWORD (password awal semua akun; default Password123! hanya di development; di produksi wajib, min. 12 karakter),
 *      SEED_ADMIN_EMAIL / SEED_ADMIN_NAME (akun admin; default admin@lab.local), SEED_FORCE=true (izinkan mode reset di produksi),
 *      SEED_DATA_DIR (default <cwd>/prisma/data).
 * Tidak ada data transaksi tiruan (peminjaman, kalibrasi, maintenance, sensor, notifikasi): semuanya mulai kosong.
 */
import { PrismaClient, Prisma, Role, EquipmentStatus, ItemCondition, SupportingStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateQrToken } from '../src/utils/qr-token';
import { LAB_ROOMS, PERSONNEL, parseEquipmentCsv, parseSupportingCsv, roomCapacity } from './seed-data';

const prisma = new PrismaClient();

const IS_PROD = process.env.NODE_ENV === 'production';
const DEFAULT_DEV_PASSWORD = 'Password123!';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const die = (msg: string): never => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

type Mode = 'reset' | 'if-empty';

function resolveConfig() {
  // Variabel kosong (mis. dari docker compose `${VAR:-}`) dianggap tidak diisi, makanya `||`, bukan `??`.
  const rawMode = process.env.SEED_MODE || 'reset';
  if (rawMode !== 'reset' && rawMode !== 'if-empty') die(`SEED_MODE tidak dikenal: '${rawMode}' (pilih reset atau if-empty)`);
  const mode = rawMode as Mode;
  if (IS_PROD && mode === 'reset' && process.env.SEED_FORCE !== 'true') {
    die('Mode reset menghapus SEMUA data dan ditolak saat NODE_ENV=production. Pakai SEED_MODE=if-empty (hanya mengisi database kosong), atau paksa dengan SEED_FORCE=true.');
  }

  if (IS_PROD && !process.env.SEED_PASSWORD) die('Di produksi SEED_PASSWORD wajib diisi (jangan memakai password default).');
  const password = process.env.SEED_PASSWORD || DEFAULT_DEV_PASSWORD;
  // Aturan backend (utils/password.ts): 8-72 karakter, ada huruf dan angka. Di produksi minimal 12.
  const minLen = IS_PROD ? 12 : 8;
  if (password.length < minLen || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    die(`SEED_PASSWORD harus ${minLen}-72 karakter dan mengandung huruf serta angka.`);
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@lab.local').trim().toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) die(`SEED_ADMIN_EMAIL tidak valid: '${adminEmail}'`);
  if (PERSONNEL.some((p) => p.email.toLowerCase() === adminEmail)) die('SEED_ADMIN_EMAIL tidak boleh sama dengan email personil.');
  const adminName = (process.env.SEED_ADMIN_NAME || 'Administrator Lab').trim();
  if (adminName.length < 2) die('SEED_ADMIN_NAME minimal 2 karakter.');

  return { mode, password, admin: { name: adminName, email: adminEmail }, dataDir: process.env.SEED_DATA_DIR || join(process.cwd(), 'prisma', 'data') };
}

/** Date-only (kolom @db.Date): "2026-10-14" → 2026-10-14T00:00:00Z. */
const toDate = (isoDate: string | null) => (isoDate ? new Date(`${isoDate}T00:00:00.000Z`) : null);

async function main() {
  const cfg = resolveConfig();

  // ───────── Baca & validasi data CSV sebelum menyentuh database ─────────
  const eqParsed = parseEquipmentCsv(readFileSync(join(cfg.dataDir, 'inventaris.csv'), 'utf8'));
  const supParsed = parseSupportingCsv(readFileSync(join(cfg.dataDir, 'supporting.csv'), 'utf8'));
  const problems = [...eqParsed.problems, ...supParsed.problems];

  const countByRoom = new Map<string, number>();
  for (const e of eqParsed.items) countByRoom.set(e.room_code, (countByRoom.get(e.room_code) ?? 0) + 1);

  const password_hash = await bcrypt.hash(cfg.password, IS_PROD ? 12 : 10);

  // ───────── Rakit semua baris di memori ─────────
  const users: Prisma.UserCreateManyInput[] = [
    { user_id: randomUUID(), name: cfg.admin.name, email: cfg.admin.email, password_hash, role: Role.admin, is_active: true },
    ...PERSONNEL.map((p) => ({
      user_id: randomUUID(),
      name: p.name,
      email: p.email,
      password_hash,
      role: p.role === 'SPV' ? Role.SPV : Role.technician,
      is_active: true,
    })),
  ];

  // Penanggung jawab alat (penerima email pengingat kalibrasi): per awalan kode inventaris.
  const userIdByEmail = new Map(users.map((u) => [u.email, u.user_id as string]));
  const responsibilities: Prisma.EquipmentResponsibilityCreateManyInput[] = PERSONNEL.flatMap((p) =>
    (p.responsible_for ?? []).map((code_prefix) => ({ user_id: userIdByEmail.get(p.email) as string, code_prefix, room_id: null })),
  );

  // Penanggung jawab ruangan dikosongkan: belum ada data pembagian ruangan.
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

  // ───────── Tulis ke database: satu transaksi, semua atau tidak sama sekali ─────────
  const written = await prisma.$transaction(
    async (tx) => {
      if (cfg.mode === 'if-empty') {
        const existing = (await tx.user.count()) + (await tx.room.count()) + (await tx.equipment.count()) + (await tx.supportingEquipment.count());
        if (existing > 0) return false;
      } else {
        console.log('🧹 Membersihkan data lama...');
        await tx.activityLog.deleteMany();
        await tx.notification.deleteMany();
        await tx.emailLog.deleteMany();
        await tx.document.deleteMany();
        await tx.roomMonitoring.deleteMany();
        await tx.sensor.deleteMany();
        await tx.maintenance.deleteMany();
        await tx.calibration.deleteMany();
        await tx.supportingBorrowingDetail.deleteMany();
        await tx.borrowingDetail.deleteMany();
        await tx.borrowing.deleteMany();
        await tx.supportingEquipment.deleteMany();
        await tx.equipment.deleteMany();
        await tx.room.deleteMany();
        await tx.equipmentResponsibility.deleteMany();
        await tx.refreshToken.deleteMany();
        await tx.user.deleteMany();
      }
      await tx.user.createMany({ data: users });
      await tx.equipmentResponsibility.createMany({ data: responsibilities });
      await tx.room.createMany({ data: rooms });
      await tx.equipment.createMany({ data: equipment });
      await tx.supportingEquipment.createMany({ data: supporting });
      return true;
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  if (!written) {
    console.log('⏭️  Seed dilewati: database sudah berisi data (SEED_MODE=if-empty tidak mengubah apa pun).');
    return;
  }

  // ───────── Ringkasan ─────────
  const withCal = equipment.filter((e) => e.next_calibration_date).length;
  console.log(
    `✅ Seed selesai (${cfg.mode}): ${users.length} user, ${responsibilities.length} aturan penanggung jawab, ${rooms.length} ruangan, ${equipment.length} alat utama ` +
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
  console.log(`🔑 Admin: ${cfg.admin.email}. Password awal semua akun: ${process.env.SEED_PASSWORD ? '(dari SEED_PASSWORD)' : DEFAULT_DEV_PASSWORD}. Segera ganti di lingkungan yang dipakai bersama.`);
}

main()
  .catch((e: unknown) => {
    // Dua instance yang start bersamaan: yang kalah melanggar unique constraint. Datanya sudah diisi pihak lain.
    if (process.env.SEED_MODE === 'if-empty' && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      console.log('⏭️  Seed dilewati: data baru saja diisi oleh proses lain.');
      return;
    }
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
