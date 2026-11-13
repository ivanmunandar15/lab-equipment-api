/* eslint-disable @typescript-eslint/no-explicit-any */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gte' in v || 'lte' in v || 'gt' in v || 'lt' in v) {
        const t = +row[k];
        if (row[k] === null || row[k] === undefined) return false;
        return (
          (!('gte' in v) || t >= +v.gte) && (!('lte' in v) || t <= +v.lte) &&
          (!('gt' in v) || t > +v.gt) && (!('lt' in v) || t < +v.lt)
        );
      }
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('equals' in v) {
        return v.mode === 'insensitive'
          ? String(row[k] ?? '').toLowerCase() === String(v.equals).toLowerCase()
          : row[k] === v.equals;
      }
      if ('contains' in v) return String(row[k] ?? '').toLowerCase().includes(String(v.contains).toLowerCase());
      if ('not' in v) return row[k] !== v.not;
    }
    return (row[k] ?? null) === (v ?? null);
  });
}

const pickFields = (row: Row, sel?: Row) =>
  sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, row[k]])) : { ...row };

function makeTable(pk: string, unique: string[], defaults: () => Row) {
  const rows: Row[] = [];
  return {
    rows,
    async create({ data, select }: any) {
      for (const u of unique) {
        if (rows.some((r) => r[u] === data[u])) throw Object.assign(new Error('unique'), { code: 'P2002', meta: { target: [u] } });
      }
      const row = { ...defaults(), ...data };
      rows.push(row);
      return pickFields(row, select);
    },
    async findUnique({ where, select }: any) {
      const r = rows.find((x) => matches(x, where));
      return r ? pickFields(r, select) : null;
    },
    async findMany({ where, orderBy, skip = 0, take, select }: any = {}) {
      let out = rows.filter((r) => matches(r, where));
      const ob = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (ob) {
        const [f, dir] = Object.entries(ob)[0] as [string, string];
        out = [...out].sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return out.slice(skip, take ? skip + take : undefined).map((r) => pickFields(r, select));
    },
    async count({ where }: any = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update({ where, data, select }: any) {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(r, data, { updated_at: new Date() });
      return pickFields(r, select);
    },
    async updateMany({ where, data }: any) {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    async createMany({ data }: any) {
      for (const d of data) await (this as any).create({ data: d });
      return { count: data.length };
    },
    async findFirst(args: any = {}) {
      return (await (this as any).findMany({ ...args, take: 1 }))[0] ?? null;
    },
    async delete({ where }: any) {
      const i = rows.findIndex((x) => matches(x, where));
      if (i < 0) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return rows.splice(i, 1)[0];
    },
    async deleteMany({ where }: any = {}) {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
    pk,
  };
}

export const DEMO_PASSWORD = 'Password123!';
export const ROOM_A = '11111111-1111-4111-8111-111111111111'; // kapasitas 2
export const ROOM_B = '22222222-2222-4222-8222-222222222222'; // tak terbatas
export const ROOM_OFF = '33333333-3333-4333-8333-333333333333'; // nonaktif

export function createFakeDb() {
  const user = makeTable('user_id', ['email'], () => ({
    user_id: randomUUID(),
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  }));
  const refreshToken = makeTable('token_id', ['token_hash'], () => ({
    token_id: randomUUID(),
    revoked_at: null,
    replaced_by: null,
    created_at: new Date(),
  }));
  const activityLog: any = makeTable('log_id', [], () => ({ log_id: randomUUID(), created_at: new Date() }));
  const shapeLog = (row: Row, sel?: Row) => {
    if (!sel) return row;
    const { user: userSel, ...rest } = sel;
    const out = pickFields(row, rest);
    if (userSel) {
      const u = user.rows.find((x) => x.user_id === row.user_id);
      out.user = u ? pickFields(u, userSel.select) : null;
    }
    return out;
  };
  const baseFind = activityLog.findMany;
  const baseUnique = activityLog.findUnique;
  activityLog.findMany = async (args: any = {}) =>
    (await baseFind({ ...args, select: undefined })).map((r: Row) => shapeLog(r, args.select));
  activityLog.findUnique = async (args: any) => {
    const r = await baseUnique({ ...args, select: undefined });
    return r ? shapeLog(r, args.select) : null;
  };

  // relasi sederhana yang dipakai service (room.pic/_count/sensors, equipment.room/_count)
  const wrap = (table: any, shape: (row: Row, sel: Row) => Row) => {
    const b = { create: table.create, update: table.update, findUnique: table.findUnique, findMany: table.findMany };
    table.create = async (a: any) => shape(await b.create({ ...a, select: undefined }), a.select);
    table.update = async (a: any) => shape(await b.update({ ...a, select: undefined }), a.select);
    table.findUnique = async (a: any) => {
      const r = await b.findUnique({ ...a, select: undefined });
      return r ? shape(r, a.select) : null;
    };
    table.findMany = async (a: any = {}) => (await b.findMany({ ...a, select: undefined })).map((r: Row) => shape(r, a.select));
  };
  const room: any = makeTable('room_id', ['room_code'], () => ({
    room_id: randomUUID(), equipment_capacity: 0, person_in_charge: null, description: null, is_active: true,
    created_at: new Date(), updated_at: new Date(),
  }));
  const equipment: any = makeTable('equipment_id', ['inventory_code', 'qr_token'], () => ({
    equipment_id: randomUUID(), brand: null, model: null, status: 'available', condition: 'good', purchase_date: null,
    purchase_price: null, useful_life_years: null, specifications: null, next_calibration_date: null, is_active: true,
    created_at: new Date(), updated_at: new Date(),
  }));
  const borrowingDetail: any = makeTable('detail_id', [], () => ({
    detail_id: randomUUID(), initial_condition: null, final_condition: null, has_damage: false, damage_notes: null,
  }));
  const supportingEquipment: any = makeTable('supporting_equipment_id', ['item_code', 'qr_token'], () => ({
    supporting_equipment_id: randomUUID(), item_type: null, brand: null, model: null, unit: 'pcs', total_quantity: 0,
    available_quantity: 0, condition: 'good', status: 'available', description: null, specifications: null, is_active: true,
    created_at: new Date(), updated_at: new Date(),
  }));
  // Baris peminjaman pendukung menyertakan objek `borrowing` (status + user) agar filter relasi bisa diuji.
  const supportingBorrowingDetail: any = makeTable('supporting_detail_id', [], () => ({
    supporting_detail_id: randomUUID(), quantity_returned: 0, initial_condition: null, final_condition: null, has_damage: false, damage_notes: null,
  }));
  const borrowing: any = makeTable('borrowing_id', [], () => ({
    borrowing_id: randomUUID(), actual_return_time: null, usage_location: null, notes: null, borrowing_status: 'borrowed',
    created_at: new Date(), updated_at: new Date(),
  }));
  const notification: any = makeTable('notification_id', [], () => ({
    notification_id: randomUUID(), borrowing_id: null, is_read: false, created_at: new Date(), read_at: null,
  }));
  // Filter/relasi `borrowing` untuk tabel detail: where.borrowing.{borrowing_status}, lampirkan `borrowing` + `user`.
  const withBorrowingRel = (table: any) => {
    const base = table.findMany;
    table.findMany = async ({ where = {}, orderBy, skip, take }: any = {}) => {
      const { borrowing: rel, ...own } = where;
      let out = (await base({ where: own })).map((r: Row) => {
        if (r.borrowing) return r;
        const b = borrowing.rows.find((x: Row) => x.borrowing_id === r.borrowing_id);
        const u = b ? user.rows.find((x: Row) => x.user_id === b.user_id) : null;
        return b ? { ...r, borrowing: { ...b, user: u ? { user_id: u.user_id, name: u.name, email: u.email } : null } } : r;
      });
      if (rel) out = out.filter((r: Row) => r.borrowing && matches(r.borrowing, rel));
      if (orderBy?.borrowing) out = [...out].sort((a: Row, b: Row) => +a.borrowing.borrowing_time - +b.borrowing.borrowing_time);
      return out.slice(skip ?? 0, take ? (skip ?? 0) + take : undefined);
    };
    table.count = async (a: any = {}) => (await table.findMany({ where: a.where })).length;
  };
  withBorrowingRel(supportingBorrowingDetail);
  withBorrowingRel(borrowingDetail);
  // borrowing.findMany/count: dukung where.details.some.equipment_id
  const bFind = borrowing.findMany;
  borrowing.findMany = async ({ where = {}, ...rest }: any = {}) => {
    const { details, ...own } = where;
    let out = await bFind({ where: own, ...{ orderBy: rest.orderBy } });
    if (details?.some) {
      const ids = new Set(borrowingDetail.rows.filter((d: Row) => matches(d, details.some)).map((d: Row) => d.borrowing_id));
      out = out.filter((b: Row) => ids.has(b.borrowing_id));
    }
    return out.slice(rest.skip ?? 0, rest.take ? (rest.skip ?? 0) + rest.take : undefined);
  };
  borrowing.count = async ({ where }: any = {}) => (await borrowing.findMany({ where })).length;
  // Latensi jaringan DB pada updateMany: jendela antara BACA dan TULIS tempat transaksi paralel bisa berbalapan.
  for (const t of [equipment, supportingEquipment]) {
    const um = t.updateMany;
    t.updateMany = async (a: any) => {
      await new Promise((r) => setImmediate(r));
      return um(a);
    };
  }
  const calibration: any = makeTable('calibration_id', [], () => ({
    calibration_id: randomUUID(), calibration_provider: null, certificate_number: null, certificate_file_url: null, cost: null,
    notes: null, created_at: new Date(),
  }));
  const maintenance: any = makeTable('maintenance_id', [], () => ({
    maintenance_id: randomUUID(), completion_date: null, description: null, cost: null, status: 'scheduled',
    replaced_spare_parts: null, notes: null, prev_equipment_status: null, created_at: new Date(), updated_at: new Date(),
  }));
  // calibration.findMany/count: dukung where.equipment (relasi) dan pengurutan dasar
  const calFind = calibration.findMany;
  calibration.findMany = async ({ where = {}, ...rest }: any = {}) => {
    const { equipment: rel, ...own } = where;
    let out = await calFind({ where: own, orderBy: rest.orderBy });
    if (rel) out = out.filter((c: Row) => { const e = equipment.rows.find((x: Row) => x.equipment_id === c.equipment_id); return e && matches(e, rel); });
    return out.slice(rest.skip ?? 0, rest.take ? (rest.skip ?? 0) + rest.take : undefined);
  };
  calibration.count = async ({ where }: any = {}) => (await calibration.findMany({ where })).length;
  const sensor: any = makeTable('sensor_id', ['sensor_code'], () => ({ sensor_id: randomUUID(), is_active: true }));
  wrap(room, (row, sel) => {
    if (!sel) return row;
    const { pic, _count, sensors, ...rest } = sel;
    const out: Row = pickFields(row, rest);
    if (pic) {
      const u = user.rows.find((x) => x.user_id === row.person_in_charge);
      out.pic = u ? pickFields(u, pic.select) : null;
    }
    if (_count) {
      const w = _count.select.equipment.where ?? {};
      out._count = { equipment: equipment.rows.filter((e: Row) => e.room_id === row.room_id && matches(e, w)).length };
    }
    if (sensors) out.sensors = [];
    return out;
  });
  wrap(equipment, (row, sel) => {
    if (!sel) return row;
    const { room: roomSel, _count, ...rest } = sel;
    const out: Row = pickFields(row, rest);
    if (roomSel) {
      const r = room.rows.find((x: Row) => x.room_id === row.room_id);
      out.room = r ? pickFields(r, roomSel.select) : null;
    }
    if (_count) out._count = { documents: 0 };
    return out;
  });

  const db: any = {
    user,
    refreshToken,
    activityLog,
    room,
    equipment,
    borrowingDetail,
    borrowing,
    notification,
    calibration,
    maintenance,
    supportingEquipment,
    supportingBorrowingDetail,
    sensor,
    // Lock palsu: hanya melepas event loop agar transaksi paralel benar-benar berbalapan (pengaman atomik service yang diuji).
    $queryRaw: async () => {
      await new Promise((r) => setImmediate(r));
      return [];
    },
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
    async reset() {
      user.rows.length = 0;
      refreshToken.rows.length = 0;
      activityLog.rows.length = 0;
      room.rows.length = 0;
      equipment.rows.length = 0;
      borrowingDetail.rows.length = 0;
      supportingEquipment.rows.length = 0;
      supportingBorrowingDetail.rows.length = 0;
      borrowing.rows.length = 0;
      calibration.rows.length = 0;
      maintenance.rows.length = 0;
      notification.rows.length = 0;
      await room.create({ data: { room_id: ROOM_A, room_code: 'LAB-A', room_name: 'Lab A', equipment_capacity: 2 } });
      await room.create({ data: { room_id: ROOM_B, room_code: 'LAB-B', room_name: 'Lab B', equipment_capacity: 0 } });
      await room.create({ data: { room_id: ROOM_OFF, room_code: 'LAB-OFF', room_name: 'Lab Nonaktif', is_active: false } });
      const password_hash = bcrypt.hashSync(DEMO_PASSWORD, 4);
      await user.create({ data: { name: 'Admin', email: 'admin@lab.local', role: 'admin', password_hash } });
      await user.create({ data: { name: 'Teknisi', email: 'technician@lab.local', role: 'technician', password_hash } });
      await user.create({ data: { name: 'Nonaktif', email: 'inactive@lab.local', role: 'QA', password_hash, is_active: false } });
    },
  };
  return db;
}
