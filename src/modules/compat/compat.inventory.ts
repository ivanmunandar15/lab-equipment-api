import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { PERMISSIONS } from '../../config/permissions';
import { authorize } from '../../middlewares/rbac';
import { AppError } from '../../utils/errors';
import { generateQrToken } from '../../utils/qr-token';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { calibrationWhere, type CalibrationState } from '../equipment/equipment.derive';
import * as equipment from '../equipment/equipment.service';
import { assertRoomCapacity, lockRooms } from '../rooms/room-capacity';
import * as supporting from '../supporting-equipment/supporting-equipment.service';
import { deriveSupportingStatus } from '../supporting-equipment/supporting-equipment.derive';
import { actorOf, diffFields, log } from './compat.audit';
import { LIST_CAP, csv, emptyToNull, flag, h, idParam, isUuid, parse, send, str, toDateOnlyOrNull } from './compat.http';
import { toEquipment, toSupporting } from './compat.mappers';
import {
  bulkEquipmentSchema, bulkSupportingSchema, createEquipmentSchema, createSupportingSchema,
  updateEquipmentSchema, updateSupportingSchema,
} from './compat.schemas';

const insensitive = (v: string): Prisma.StringFilter => ({ contains: v, mode: 'insensitive' });
const invalid = (path: string, message: string) => AppError.unprocessable('Validasi gagal', [{ path, message }]);

/** Tolak field yang tidak boleh diubah (padanan `assertNoKeys` di mock). */
function assertNoKeys(input: unknown, keys: string[]) {
  if (input && typeof input === 'object') {
    for (const k of keys) if (k in input) throw invalid(k, `Field "${k}" tidak dapat diubah`);
  }
}

/* ====================================================================== */
/*                               EQUIPMENT                                 */
/* ====================================================================== */

const EQUIPMENT_STATUSES = ['available', 'borrowed', 'damaged', 'maintenance', 'calibration'] as const;
const CONDITIONS = ['good', 'minor_damage', 'major_damage'] as const;
type EqStatus = (typeof EQUIPMENT_STATUSES)[number];
const EQ_IMMUTABLE = ['qr_token', 'equipment_id', 'is_active', 'created_at'];
const E = AUDIT_ENTITIES.EQUIPMENT;
const write = authorize(...PERMISSIONS.equipment.write);

function equipmentWhere(q: Record<string, unknown>): Prisma.EquipmentWhereInput {
  const statuses = csv(q.status).filter((s): s is EqStatus => (EQUIPMENT_STATUSES as readonly string[]).includes(s));
  const condition = str(q.condition);
  const roomId = str(q.room_id);
  const state = str(q.calibration_state);
  const search = str(q.search);
  return {
    ...(flag(q.includeInactive) ? {} : { is_active: true }),
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(condition && (CONDITIONS as readonly string[]).includes(condition) ? { condition: condition as (typeof CONDITIONS)[number] } : {}),
    ...(roomId ? { room_id: roomId } : {}),
    ...(state === 'not_required' ? { next_calibration_date: null } : {}),
    ...(state === 'safe' || state === 'due_soon' || state === 'overdue' ? { next_calibration_date: calibrationWhere(state as CalibrationState) } : {}),
    ...(search
      ? {
          OR: [
            { equipment_name: insensitive(search) }, { inventory_code: insensitive(search) }, { brand: insensitive(search) },
            { model: insensitive(search) }, { equipment_type: insensitive(search) },
          ],
        }
      : {}),
  };
}

async function findEquipment(id: string) {
  const row = await getDb().equipment.findUnique({ where: { equipment_id: id }, select: equipment.EQUIPMENT_SELECT });
  if (!row) throw AppError.notFound(`Alat dengan ID "${id}" tidak ditemukan`);
  return row;
}

const roomIdOrThrow = (v: string | undefined) => {
  if (v !== undefined && !isUuid(v)) throw invalid('room_id', 'Ruangan tidak valid');
  return v;
};
const noBorrowedStatus = (s: string | undefined) => {
  if (s === 'borrowed') throw invalid('status', 'Status "borrowed" diatur otomatis oleh proses peminjaman');
};

export const equipmentRouter = Router();

equipmentRouter.get('/', h(async (req, res) => {
  const roomId = str(req.query.room_id);
  if (roomId && !isUuid(roomId)) return send(res, []);
  const rows = await getDb().equipment.findMany({ where: equipmentWhere(req.query), orderBy: { inventory_code: 'asc' }, take: LIST_CAP, select: equipment.EQUIPMENT_SELECT });
  send(res, rows.map(toEquipment));
}));

/** Rute statis HARUS sebelum '/:id'. Halaman scan memakai ini; data nonaktif ikut dikembalikan agar UI bisa menampilkan statusnya. */
equipmentRouter.get('/by-qr/:token', h(async (req, res) => {
  const row = await getDb().equipment.findUnique({ where: { qr_token: req.params.token }, select: equipment.EQUIPMENT_SELECT });
  if (!row) throw AppError.notFound(`Alat dengan ID "${req.params.token}" tidak ditemukan`);
  send(res, toEquipment(row));
}));

equipmentRouter.get('/by-code/:code', h(async (req, res) => {
  const row = await getDb().equipment.findFirst({ where: { inventory_code: { equals: req.params.code.trim(), mode: 'insensitive' } }, select: equipment.EQUIPMENT_SELECT });
  if (!row) throw AppError.notFound(`Alat dengan ID "${req.params.code}" tidak ditemukan`);
  send(res, toEquipment(row));
}));

/** Respons: boolean mentah (`true`/`false`), sama dengan `isInventoryCodeTaken` di mock. */
equipmentRouter.get('/code-taken', h(async (req, res) => {
  const code = str(req.query.code);
  if (!code) return send(res, false);
  const except = str(req.query.exceptId);
  const hit = await getDb().equipment.findFirst({ where: { inventory_code: { equals: code, mode: 'insensitive' } }, select: { equipment_id: true } });
  send(res, !!hit && hit.equipment_id !== except);
}));

equipmentRouter.post('/bulk', write, h(async (req, res) => {
  const rows = parse(bulkEquipmentSchema, req.body);
  const db = getDb();
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    noBorrowedStatus(r.status);
    roomIdOrThrow(r.room_id);
    const k = r.inventory_code.toLowerCase();
    if (seen.has(k)) throw AppError.conflict(`Baris ${i + 1}: kode inventaris ganda di file`);
    seen.add(k);
  });
  const existing = await db.equipment.findMany({ where: { inventory_code: { in: rows.map((r) => r.inventory_code) } }, select: { inventory_code: true } });
  if (existing.length) throw AppError.conflict(`Kode inventaris sudah digunakan: ${existing.map((e) => e.inventory_code).join(', ')}`);

  const created = await db.$transaction(async (tx) => {
    const roomIds = [...new Set(rows.map((r) => r.room_id))];
    const rooms = await tx.room.findMany({ where: { room_id: { in: roomIds } }, select: { room_id: true, room_code: true, equipment_capacity: true, is_active: true } });
    for (const id of roomIds) {
      const room = rooms.find((r) => r.room_id === id);
      if (!room || !room.is_active) throw AppError.notFound(`Ruangan dengan ID "${id}" tidak ditemukan`);
    }
    await lockRooms(tx, roomIds);
    for (const room of rooms) await assertRoomCapacity(tx, room, rows.filter((r) => r.room_id === room.room_id).length);
    const out = [];
    for (const r of rows) {
      out.push(
        await tx.equipment.create({
          data: {
            inventory_code: r.inventory_code, qr_token: generateQrToken(), equipment_name: r.equipment_name, equipment_type: r.equipment_type,
            brand: emptyToNull(r.brand) ?? null, model: emptyToNull(r.model) ?? null, room_id: r.room_id,
            status: r.status as Exclude<EqStatus, 'borrowed'>, condition: r.condition, // undefined = default good; null = tidak diketahui
            purchase_date: toDateOnlyOrNull(r.purchase_date), purchase_price: r.purchase_price ?? null, useful_life_years: r.useful_life_years ?? null,
            specifications: emptyToNull(r.specifications) ?? null,
            next_calibration_date: toDateOnlyOrNull(r.next_calibration_date),
          },
          select: equipment.EQUIPMENT_SELECT,
        }),
      );
    }
    await audit.log({ ...audit.actorFrom(req), action: AUDIT_ACTIONS.IMPORT, entityType: E, entityId: 'bulk', newData: { count: out.length } }, tx);
    return out;
  });
  send(res, created.map(toEquipment), 201);
}));

equipmentRouter.get('/:id', h(async (req, res) => send(res, toEquipment(await findEquipment(idParam(req, 'id', 'Alat'))))));

equipmentRouter.post('/', write, h(async (req, res) => {
  const d = parse(createEquipmentSchema, req.body);
  noBorrowedStatus(d.status);
  const created = await equipment.create({
    inventory_code: d.inventory_code, equipment_name: d.equipment_name, equipment_type: d.equipment_type,
    brand: emptyToNull(d.brand), model: emptyToNull(d.model), room_id: roomIdOrThrow(d.room_id) as string,
    status: d.status as Exclude<EqStatus, 'borrowed'>, condition: d.condition === undefined ? 'good' : d.condition,
    purchase_date: toDateOnlyOrNull(d.purchase_date), purchase_price: d.purchase_price ?? null, useful_life_years: d.useful_life_years ?? null,
    specifications: emptyToNull(d.specifications) ?? null, next_calibration_date: toDateOnlyOrNull(d.next_calibration_date),
  });
  await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: E, entityId: created.equipment_id, newData: { inventory_code: created.inventory_code, equipment_name: created.equipment_name } });
  send(res, toEquipment(created), 201);
}));

equipmentRouter.patch('/:id', write, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat');
  assertNoKeys(req.body, EQ_IMMUTABLE);
  const p = parse(updateEquipmentSchema, req.body);
  noBorrowedStatus(p.status);
  const before = await findEquipment(id);
  const updated = await equipment.update(
    id,
    {
      ...(p.inventory_code !== undefined ? { inventory_code: p.inventory_code } : {}),
      ...(p.equipment_name !== undefined ? { equipment_name: p.equipment_name } : {}),
      ...(p.equipment_type !== undefined ? { equipment_type: p.equipment_type } : {}),
      ...(p.brand !== undefined ? { brand: emptyToNull(p.brand) } : {}),
      ...(p.model !== undefined ? { model: emptyToNull(p.model) } : {}),
      ...(p.room_id !== undefined ? { room_id: roomIdOrThrow(p.room_id) } : {}),
      ...(p.status !== undefined ? { status: p.status as Exclude<EqStatus, 'borrowed'> } : {}),
      ...(p.condition !== undefined ? { condition: p.condition } : {}),
      ...(p.purchase_date !== undefined ? { purchase_date: toDateOnlyOrNull(p.purchase_date) } : {}),
      ...(p.purchase_price !== undefined ? { purchase_price: p.purchase_price } : {}),
      ...(p.useful_life_years !== undefined ? { useful_life_years: p.useful_life_years } : {}),
      ...(p.specifications !== undefined ? { specifications: emptyToNull(p.specifications) } : {}),
      ...(p.next_calibration_date !== undefined ? { next_calibration_date: toDateOnlyOrNull(p.next_calibration_date) } : {}),
    },
    actorOf(req).role,
  );
  const { oldData, newData } = diffFields(toEquipment(before), toEquipment(updated));
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: E, entityId: id, oldData, newData });
  send(res, toEquipment(updated));
}));

equipmentRouter.delete('/:id', write, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat');
  await findEquipment(id);
  const updated = await equipment.remove(id);
  await log(req, { action: AUDIT_ACTIONS.DELETE, entityType: E, entityId: id, oldData: { is_active: true }, newData: { is_active: false } });
  send(res, toEquipment(updated));
}));

equipmentRouter.post('/:id/restore', write, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat');
  await findEquipment(id);
  const updated = await equipment.update(id, { is_active: true }, actorOf(req).role);
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: E, entityId: id, oldData: { is_active: false }, newData: { is_active: true } });
  send(res, toEquipment(updated));
}));

/* ====================================================================== */
/*                          SUPPORTING EQUIPMENT                           */
/* ====================================================================== */

const SP = AUDIT_ENTITIES.SUPPORTING_EQUIPMENT;
const SP_IMMUTABLE = ['qr_token', 'supporting_equipment_id', 'available_quantity', 'status', 'is_active', 'created_at'];
const spWrite = authorize(...PERMISSIONS.supportingEquipment.write);

async function findSupporting(id: string) {
  const row = await getDb().supportingEquipment.findUnique({ where: { supporting_equipment_id: id }, select: supporting.SUPPORTING_SELECT });
  if (!row) throw AppError.notFound(`Alat pendukung dengan ID "${id}" tidak ditemukan`);
  return row;
}

export const supportingRouter = Router();

supportingRouter.get('/', h(async (req, res) => {
  const status = str(req.query.status);
  const condition = str(req.query.condition);
  const search = str(req.query.search);
  const rows = await getDb().supportingEquipment.findMany({
    where: {
      ...(flag(req.query.includeInactive) ? {} : { is_active: true }),
      ...(status === 'available' || status === 'borrowed' || status === 'damaged' ? { status } : {}),
      ...(condition && (CONDITIONS as readonly string[]).includes(condition) ? { condition: condition as (typeof CONDITIONS)[number] } : {}),
      ...(search
        ? { OR: [{ item_name: insensitive(search) }, { item_code: insensitive(search) }, { brand: insensitive(search) }, { model: insensitive(search) }, { item_type: insensitive(search) }] }
        : {}),
    },
    orderBy: { item_code: 'asc' },
    take: LIST_CAP,
    select: supporting.SUPPORTING_SELECT,
  });
  send(res, rows.map(toSupporting));
}));

supportingRouter.get('/by-qr/:token', h(async (req, res) => {
  const row = await getDb().supportingEquipment.findUnique({ where: { qr_token: req.params.token }, select: supporting.SUPPORTING_SELECT });
  if (!row) throw AppError.notFound(`Alat pendukung dengan ID "${req.params.token}" tidak ditemukan`);
  send(res, toSupporting(row));
}));

supportingRouter.get('/by-code/:code', h(async (req, res) => {
  const row = await getDb().supportingEquipment.findFirst({ where: { item_code: { equals: req.params.code.trim(), mode: 'insensitive' } }, select: supporting.SUPPORTING_SELECT });
  if (!row) throw AppError.notFound(`Alat pendukung dengan ID "${req.params.code}" tidak ditemukan`);
  send(res, toSupporting(row));
}));

supportingRouter.get('/code-taken', h(async (req, res) => {
  const code = str(req.query.code);
  if (!code) return send(res, false);
  const except = str(req.query.exceptId);
  const hit = await getDb().supportingEquipment.findFirst({ where: { item_code: { equals: code, mode: 'insensitive' } }, select: { supporting_equipment_id: true } });
  send(res, !!hit && hit.supporting_equipment_id !== except);
}));

supportingRouter.post('/bulk', spWrite, h(async (req, res) => {
  const rows = parse(bulkSupportingSchema, req.body);
  const db = getDb();
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const k = r.item_code.toLowerCase();
    if (seen.has(k)) throw AppError.conflict(`Baris ${i + 1}: kode item ganda di file`);
    seen.add(k);
  });
  const existing = await db.supportingEquipment.findMany({ where: { item_code: { in: rows.map((r) => r.item_code) } }, select: { item_code: true } });
  if (existing.length) throw AppError.conflict(`Kode item sudah digunakan: ${existing.map((e) => e.item_code).join(', ')}`);

  const created = await db.$transaction(async (tx) => {
    const out = [];
    for (const r of rows) {
      out.push(
        await tx.supportingEquipment.create({
          data: {
            item_code: r.item_code, qr_token: generateQrToken(), item_name: r.item_name, item_type: emptyToNull(r.item_type) ?? null,
            brand: emptyToNull(r.brand) ?? null, model: emptyToNull(r.model) ?? null, unit: r.unit,
            total_quantity: r.total_quantity, available_quantity: r.total_quantity, condition: r.condition,
            status: deriveSupportingStatus(r.condition, r.total_quantity),
            description: emptyToNull(r.description) ?? null, specifications: emptyToNull(r.specifications) ?? null,
          },
          select: supporting.SUPPORTING_SELECT,
        }),
      );
    }
    await audit.log({ ...audit.actorFrom(req), action: AUDIT_ACTIONS.IMPORT, entityType: SP, entityId: 'bulk', newData: { count: out.length } }, tx);
    return out;
  });
  send(res, created.map(toSupporting), 201);
}));

supportingRouter.get('/:id', h(async (req, res) => send(res, toSupporting(await findSupporting(idParam(req, 'id', 'Alat pendukung'))))));

supportingRouter.post('/', spWrite, h(async (req, res) => {
  const d = parse(createSupportingSchema, req.body);
  const created = await supporting.create({
    item_code: d.item_code, item_name: d.item_name, item_type: emptyToNull(d.item_type), brand: emptyToNull(d.brand), model: emptyToNull(d.model),
    unit: d.unit, total_quantity: d.total_quantity, condition: d.condition,
    description: emptyToNull(d.description), specifications: emptyToNull(d.specifications),
  });
  await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: SP, entityId: created.supporting_equipment_id, newData: { item_code: created.item_code, item_name: created.item_name, total_quantity: created.total_quantity } });
  send(res, toSupporting(created), 201);
}));

/** Mengubah total_quantity menggeser available_quantity dengan selisih yang sama (ditolak 409 bila di bawah jumlah yang sedang dipinjam). */
supportingRouter.patch('/:id', spWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat pendukung');
  assertNoKeys(req.body, SP_IMMUTABLE);
  const p = parse(updateSupportingSchema, req.body);
  const before = await findSupporting(id);
  const updated = await supporting.update(id, {
    ...(p.item_code !== undefined ? { item_code: p.item_code } : {}),
    ...(p.item_name !== undefined ? { item_name: p.item_name } : {}),
    ...(p.item_type !== undefined ? { item_type: emptyToNull(p.item_type) } : {}),
    ...(p.brand !== undefined ? { brand: emptyToNull(p.brand) } : {}),
    ...(p.model !== undefined ? { model: emptyToNull(p.model) } : {}),
    ...(p.unit !== undefined ? { unit: p.unit } : {}),
    ...(p.total_quantity !== undefined ? { total_quantity: p.total_quantity } : {}),
    ...(p.condition !== undefined ? { condition: p.condition } : {}),
    ...(p.description !== undefined ? { description: emptyToNull(p.description) } : {}),
    ...(p.specifications !== undefined ? { specifications: emptyToNull(p.specifications) } : {}),
  });
  const { oldData, newData } = diffFields(toSupporting(before), toSupporting(updated));
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: SP, entityId: id, oldData, newData });
  send(res, toSupporting(updated));
}));

supportingRouter.delete('/:id', spWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat pendukung');
  await findSupporting(id);
  const updated = await supporting.remove(id);
  await log(req, { action: AUDIT_ACTIONS.DELETE, entityType: SP, entityId: id, oldData: { is_active: true }, newData: { is_active: false } });
  send(res, toSupporting(updated));
}));

supportingRouter.post('/:id/restore', spWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Alat pendukung');
  await findSupporting(id);
  const updated = await supporting.update(id, { is_active: true });
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: SP, entityId: id, oldData: { is_active: false }, newData: { is_active: true } });
  send(res, toSupporting(updated));
}));
