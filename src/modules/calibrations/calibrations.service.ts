import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { deleteStored, mimeFromKey, resolveStoragePath, saveCertificate } from '../../utils/storage';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { calibrationState, calibrationWhere, dateOnly } from '../equipment/equipment.derive';
import { EQUIPMENT_SELECT } from '../equipment/equipment.service';
import type { CreateCalibrationBody, ListCalibrationsQuery } from './calibrations.schema';

export interface Actor {
  userId: string;
  ip: string | null;
}

const DAY_MS = 86_400_000;
const SORTABLE = ['calibration_date', 'next_calibration_date', 'created_at', 'calibration_result'];
/** Decimal Prisma -> number (kontrak frontend: number). Decimal(15,2) masih aman di dalam presisi double. */
const money = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));

const CAL_SELECT = {
  calibration_id: true, equipment_id: true, technician_id: true, calibration_date: true, next_calibration_date: true,
  calibration_provider: true, certificate_number: true, certificate_file_url: true, calibration_result: true,
  cost: true, notes: true, created_at: true,
} satisfies Prisma.CalibrationSelect;
type CalRow = Prisma.CalibrationGetPayload<{ select: typeof CAL_SELECT }>;

/** Bentuk respons: tanggal YYYY-MM-DD, biaya string, lokasi file internal TIDAK dibocorkan. */
function presentCalibration(r: CalRow) {
  const { certificate_file_url, ...rest } = r;
  return {
    ...rest,
    calibration_date: dateOnly(r.calibration_date),
    next_calibration_date: dateOnly(r.next_calibration_date),
    cost: money(r.cost),
    has_certificate: certificate_file_url !== null,
    certificate_download_path: certificate_file_url !== null ? `/api/v1/calibrations/${r.calibration_id}/certificate` : null,
  };
}

/** Lengkapi dengan ringkasan alat + teknisi (batch, tanpa N+1). */
async function hydrate(rows: CalRow[]) {
  const db = getDb();
  const eqIds = [...new Set(rows.map((r) => r.equipment_id))];
  const userIds = [...new Set(rows.map((r) => r.technician_id))];
  const [eq, users] = rows.length
    ? await Promise.all([
        db.equipment.findMany({ where: { equipment_id: { in: eqIds } }, select: EQUIPMENT_SELECT }),
        db.user.findMany({ where: { user_id: { in: userIds } }, select: { user_id: true, name: true } }),
      ])
    : [[], []];
  const eqMap = new Map(eq.map((e) => [e.equipment_id, e]));
  const uMap = new Map(users.map((u) => [u.user_id, u]));
  const now = new Date();
  return rows.map((r) => {
    const e = eqMap.get(r.equipment_id);
    return {
      ...presentCalibration(r),
      technician: uMap.get(r.technician_id) ?? null,
      equipment: e
        ? {
            equipment_id: e.equipment_id, inventory_code: e.inventory_code, equipment_name: e.equipment_name, status: e.status,
            room: e.room ? { room_id: e.room.room_id, room_code: e.room.room_code, room_name: e.room.room_name } : null,
            next_calibration_date: dateOnly(e.next_calibration_date),
            calibration_state: calibrationState(e.next_calibration_date, now),
          }
        : null,
    };
  });
}

// ───────── baca ─────────

export async function list(q: ListCalibrationsQuery) {
  const db = getDb();
  const where: Prisma.CalibrationWhereInput = {
    ...(q.equipment_id ? { equipment_id: q.equipment_id } : {}),
    ...(q.result ? { calibration_result: q.result } : {}),
    // state = status jadwal kalibrasi alat SAAT INI (konsisten dengan /summary dan /schedule)
    ...(q.state ? { equipment: { is_active: true, next_calibration_date: calibrationWhere(q.state) } } : {}),
    ...(q.date_from || q.date_to
      ? { calibration_date: { ...(q.date_from ? { gte: q.date_from } : {}), ...(q.date_to ? { lte: q.date_to } : {}) } }
      : {}),
    ...(q.search
      ? {
          OR: [
            { certificate_number: { contains: q.search, mode: 'insensitive' } },
            { calibration_provider: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const sort = resolveSort(q.sort, SORTABLE, 'calibration_date');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.calibration.findMany({ where, orderBy: [{ [sort]: q.order }, { calibration_id: 'asc' }], skip, take, select: CAL_SELECT }),
    db.calibration.count({ where }),
  ]);
  return { items: await hydrate(rows), meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().calibration.findUnique({ where: { calibration_id: id }, select: CAL_SELECT });
  if (!row) throw AppError.notFound('Kalibrasi tidak ditemukan');
  return (await hydrate([row]))[0];
}

/** Alat aktif yang jatuh tempo pada bulan `YYYY-MM` (UTC), dikelompokkan per tanggal untuk kalender. */
export async function schedule(month: string, roomId?: string) {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const rows = await getDb().equipment.findMany({
    where: { is_active: true, ...(roomId ? { room_id: roomId } : {}), next_calibration_date: { gte: from, lt: to } },
    orderBy: [{ next_calibration_date: 'asc' }, { inventory_code: 'asc' }],
    select: EQUIPMENT_SELECT,
  });
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const items = rows
    .map((e) => ({
      equipment_id: e.equipment_id, inventory_code: e.inventory_code, equipment_name: e.equipment_name, equipment_type: e.equipment_type,
      status: e.status, room: { room_id: e.room.room_id, room_code: e.room.room_code, room_name: e.room.room_name },
      next_calibration_date: dateOnly(e.next_calibration_date) as string,
      calibration_state: calibrationState(e.next_calibration_date, now),
      days_until_due: Math.round(((e.next_calibration_date as Date).getTime() - today) / DAY_MS),
    }))
    .sort((a, b) => a.next_calibration_date.localeCompare(b.next_calibration_date) || a.inventory_code.localeCompare(b.inventory_code));
  const days: { date: string; items: typeof items }[] = [];
  for (const it of items) {
    const last = days[days.length - 1];
    if (last && last.date === it.next_calibration_date) last.items.push(it);
    else days.push({ date: it.next_calibration_date, items: [it] });
  }
  return { month, from: dateOnly(from), to: dateOnly(new Date(to.getTime() - DAY_MS)), total: items.length, days };
}

/** Jumlah alat aktif per calibration_state (+ yang belum punya jadwal). */
export async function summary(roomId?: string) {
  const db = getDb();
  const base: Prisma.EquipmentWhereInput = { is_active: true, ...(roomId ? { room_id: roomId } : {}) };
  const now = new Date();
  const cnt = (state: 'safe' | 'due_soon' | 'overdue') => db.equipment.count({ where: { ...base, next_calibration_date: calibrationWhere(state, now) } });
  const [safe, due_soon, overdue, no_schedule] = await Promise.all([
    cnt('safe'), cnt('due_soon'), cnt('overdue'),
    db.equipment.count({ where: { ...base, next_calibration_date: null } }),
  ]);
  return { safe, due_soon, overdue, no_schedule, total_scheduled: safe + due_soon + overdue, due_soon_days: env.CALIBRATION_DUE_SOON_DAYS };
}

// ───────── tulis ─────────

const lockEquipment = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT equipment_id FROM equipment WHERE equipment_id = ${id}::uuid FOR UPDATE`;

export async function create(body: CreateCalibrationBody, file: { buffer: Buffer; mimetype: string } | undefined, actor: Actor) {
  // Validasi isi file + simpan SEBELUM transaksi; dihapus lagi bila transaksi gagal (tidak ada file yatim).
  const key = file ? await saveCertificate(file) : null;
  try {
    return await getDb().$transaction(async (tx) => {
      await lockEquipment(tx, body.equipment_id);
      const eq = await tx.equipment.findUnique({
        where: { equipment_id: body.equipment_id },
        select: { equipment_id: true, inventory_code: true, status: true, is_active: true, next_calibration_date: true },
      });
      if (!eq) throw AppError.unprocessable('Validasi gagal', [{ path: 'equipment_id', message: 'Alat tidak ditemukan' }]);
      if (!eq.is_active) throw new AppError(409, 'EQUIPMENT_INACTIVE', 'Alat sudah dinonaktifkan');

      // Entri bertanggal lebih lama dari kalibrasi terbaru hanya masuk riwayat; jadwal & status alat tidak diubah.
      const newer = await tx.calibration.findFirst({
        where: { equipment_id: eq.equipment_id, calibration_date: { gt: body.calibration_date } },
        select: { calibration_id: true },
      });
      const applied = !newer;
      let nextStatus = eq.status;
      let nextDate = eq.next_calibration_date;

      if (applied) {
        const data: Prisma.EquipmentUpdateInput = {};
        if (body.calibration_result === 'passed') {
          data.next_calibration_date = body.next_calibration_date;
          nextDate = body.next_calibration_date;
          if (eq.status === 'calibration') data.status = nextStatus = 'available';
        } else {
          const target = body.status_after_fail ?? 'calibration';
          if (eq.status === 'borrowed') throw new AppError(409, 'EQUIPMENT_BORROWED', 'Alat sedang dipinjam; kembalikan dulu sebelum mencatat kalibrasi gagal');
          if (eq.status === 'maintenance') throw new AppError(409, 'EQUIPMENT_IN_MAINTENANCE', 'Alat sedang dalam maintenance; selesaikan/batalkan dulu');
          if (eq.status !== target) data.status = nextStatus = target;
        }
        if (Object.keys(data).length) await tx.equipment.update({ where: { equipment_id: eq.equipment_id }, data });
      }

      const row = await tx.calibration.create({
        data: {
          equipment_id: eq.equipment_id,
          technician_id: actor.userId,
          calibration_date: body.calibration_date,
          next_calibration_date: body.next_calibration_date,
          calibration_provider: body.calibration_provider ?? null,
          certificate_number: body.certificate_number ?? null,
          certificate_file_url: key,
          calibration_result: body.calibration_result,
          cost: body.cost ?? null,
          notes: body.notes ?? null,
        },
        select: CAL_SELECT,
      });

      await audit.log(
        {
          ...actor,
          action: AUDIT_ACTIONS.CALIBRATE,
          entityType: AUDIT_ENTITIES.CALIBRATION,
          entityId: row.calibration_id,
          oldData: { equipment_status: eq.status, next_calibration_date: dateOnly(eq.next_calibration_date) },
          newData: {
            ...presentCalibration(row),
            equipment_id: eq.equipment_id,
            applied_to_equipment: applied,
            equipment_status: nextStatus,
            equipment_next_calibration_date: dateOnly(nextDate),
          },
        },
        tx,
      );

      const [full] = await hydrate([row]);
      return { ...full, applied_to_equipment: applied };
    });
  } catch (err) {
    if (key) await deleteStored(key);
    throw err;
  }
}

/** POST /equipment/:id/start-calibration */
export async function startCalibration(id: string, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    await lockEquipment(tx, id);
    const cur = await tx.equipment.findUnique({ where: { equipment_id: id }, select: EQUIPMENT_SELECT });
    if (!cur) throw AppError.notFound('Equipment tidak ditemukan');
    if (!cur.is_active) throw new AppError(409, 'EQUIPMENT_INACTIVE', 'Alat sudah dinonaktifkan');
    if (cur.status === 'borrowed') throw new AppError(409, 'EQUIPMENT_BORROWED', 'Alat sedang dipinjam; tidak dapat dikalibrasi');
    if (cur.status === 'calibration') throw new AppError(409, 'ALREADY_IN_CALIBRATION', 'Alat sudah berstatus calibration');
    if (cur.status === 'maintenance') throw new AppError(409, 'EQUIPMENT_IN_MAINTENANCE', 'Alat sedang dalam maintenance');

    const res = await tx.equipment.updateMany({
      where: { equipment_id: id, status: { in: ['available', 'damaged'] }, is_active: true },
      data: { status: 'calibration' },
    });
    if (res.count !== 1) throw new AppError(409, 'EQUIPMENT_STATUS_CHANGED', 'Status alat baru saja berubah, coba lagi');
    await audit.log(
      {
        ...actor,
        action: AUDIT_ACTIONS.START_CALIBRATION,
        entityType: AUDIT_ENTITIES.EQUIPMENT,
        entityId: id,
        oldData: { status: cur.status },
        newData: { status: 'calibration' },
      },
      tx,
    );
    return { equipment_id: id, inventory_code: cur.inventory_code, previous_status: cur.status, status: 'calibration' as const };
  });
}

/** Buka stream sertifikat. Hak akses (login + role baca) sudah dicek di route. */
export async function openCertificate(id: string) {
  const row = await getDb().calibration.findUnique({
    where: { calibration_id: id },
    select: { calibration_id: true, certificate_number: true, certificate_file_url: true },
  });
  if (!row) throw AppError.notFound('Kalibrasi tidak ditemukan');
  if (!row.certificate_file_url) throw AppError.notFound('Kalibrasi ini tidak memiliki sertifikat');
  const full = resolveStoragePath(row.certificate_file_url);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw AppError.notFound('File sertifikat tidak ditemukan di penyimpanan');
  const mime = mimeFromKey(row.certificate_file_url);
  const ext = row.certificate_file_url.slice(row.certificate_file_url.lastIndexOf('.'));
  const base = (row.certificate_number ?? row.calibration_id).replace(/[^\w.-]+/g, '_');
  return { stream: createReadStream(full), mime, size: info.size, filename: `sertifikat-${base}${ext}` };
}
