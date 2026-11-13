import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { PERMISSIONS } from '../../config/permissions';
import { authorize } from '../../middlewares/rbac';
import { AppError } from '../../utils/errors';
import * as calibrations from '../calibrations/calibrations.service';
import * as maintenances from '../maintenances/maintenances.service';
import { TRANSITIONS } from '../maintenances/maintenances.state';
import { actorOf } from './compat.audit';
import { parseDataUrl } from './compat.files';
import { LIST_CAP, emptyToNull, h, idParam, isUuid, parse, send, str, toDateOnly } from './compat.http';
import { toCalibration, toMaintenance } from './compat.mappers';
import { createCalibrationSchema, createMaintenanceSchema, updateMaintenanceSchema } from './compat.schemas';

const insensitive = (v: string): Prisma.StringFilter => ({ contains: v, mode: 'insensitive' });
const invalid = (path: string, message: string) => AppError.unprocessable('Validasi gagal', [{ path, message }]);

/* =========================== CALIBRATION =========================== */

async function findCalibration(id: string) {
  const row = await getDb().calibration.findUnique({ where: { calibration_id: id } });
  if (!row) throw AppError.notFound(`Kalibrasi dengan ID "${id}" tidak ditemukan`);
  return row;
}

export const calibrationsRouter = Router();

calibrationsRouter.get('/', h(async (req, res) => {
  const search = str(req.query.search);
  const equipmentId = str(req.query.equipment_id);
  const techId = str(req.query.technician_id);
  const result = str(req.query.result);
  if ((equipmentId && !isUuid(equipmentId)) || (techId && !isUuid(techId))) return send(res, []);
  const rows = await getDb().calibration.findMany({
    where: {
      ...(equipmentId ? { equipment_id: equipmentId } : {}),
      ...(techId ? { technician_id: techId } : {}),
      ...(result === 'passed' || result === 'failed' ? { calibration_result: result } : {}),
      ...(search
        ? { OR: [{ certificate_number: insensitive(search) }, { calibration_provider: insensitive(search) }, { equipment: { equipment_name: insensitive(search) } }] }
        : {}),
    },
    orderBy: { calibration_date: 'desc' },
    take: LIST_CAP,
  });
  send(res, rows.map(toCalibration));
}));

/** Kalibrasi `passed` terbaru suatu alat, atau `null`. Statis: sebelum '/:id'. */
calibrationsRouter.get('/latest-passed', h(async (req, res) => {
  const eq = str(req.query.equipment_id);
  if (!eq || !isUuid(eq)) return send(res, null);
  const row = await getDb().calibration.findFirst({
    where: { equipment_id: eq, calibration_result: 'passed' },
    orderBy: { calibration_date: 'desc' },
  });
  send(res, row ? toCalibration(row) : null);
}));

calibrationsRouter.get('/:id', h(async (req, res) => send(res, toCalibration(await findCalibration(idParam(req, 'id', 'Kalibrasi'))))));

/** Unduh/pratinjau sertifikat (butuh login). */
calibrationsRouter.get('/:id/certificate', h(async (req, res) => {
  const f = await calibrations.openCertificate(idParam(req, 'id', 'Kalibrasi'));
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  f.stream.on('error', (e) => (res.headersSent ? res.destroy(e) : res.status(500).end()));
  f.stream.pipe(res);
}));

/**
 * JSON (bukan multipart). Sertifikat opsional lewat `certificate_file_url` berupa data URL.
 * Teknisi = pengguna yang login. Aturan backend tetap berlaku (mis. tanggal kalibrasi tidak boleh di masa depan,
 * hasil "failed" ditolak bila alat sedang dipinjam/maintenance).
 */
calibrationsRouter.post('/', authorize(...PERMISSIONS.calibrations.write), h(async (req, res) => {
  const d = parse(createCalibrationSchema, req.body);
  if (!isUuid(d.equipment_id)) throw invalid('equipment_id', 'Alat tidak ditemukan');
  const file = d.certificate_file_url ? parseDataUrl(d.certificate_file_url, 'certificate_file_url', env.CERTIFICATE_MAX_MB * 1024 * 1024) : undefined;

  const created = await calibrations.create(
    {
      equipment_id: d.equipment_id, calibration_date: toDateOnly(d.calibration_date), next_calibration_date: toDateOnly(d.next_calibration_date),
      calibration_provider: emptyToNull(d.calibration_provider), certificate_number: emptyToNull(d.certificate_number),
      calibration_result: d.calibration_result, status_after_fail: d.failed_status, cost: d.cost, notes: emptyToNull(d.notes),
    },
    file,
    { userId: req.user!.user_id, ip: req.ip ?? null },
  );
  send(res, toCalibration(await findCalibration(created.calibration_id)), 201);
}));

/* =========================== MAINTENANCE =========================== */

async function findMaintenance(id: string) {
  const row = await getDb().maintenance.findUnique({ where: { maintenance_id: id } });
  if (!row) throw AppError.notFound(`Maintenance dengan ID "${id}" tidak ditemukan`);
  return row;
}

type MStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
/** Jalur transisi legal menuju status tujuan (mock membolehkan lompat, mis. scheduled -> completed). */
function pathTo(from: MStatus, to: MStatus): MStatus[] {
  if (from === to) return [];
  if (TRANSITIONS[from].includes(to)) return [to];
  if (from === 'scheduled' && to === 'completed') return ['in_progress', 'completed'];
  throw new AppError(422, 'INVALID_TRANSITION', `Transisi ${from} → ${to} tidak diizinkan`, [{ path: 'status', message: `Transisi ${from} → ${to} tidak diizinkan` }]);
}

export const maintenanceRouter = Router();
const mWrite = authorize(...PERMISSIONS.maintenances.write);

maintenanceRouter.get('/', h(async (req, res) => {
  const search = str(req.query.search);
  const eq = str(req.query.equipment_id);
  const tech = str(req.query.technician_id);
  const status = str(req.query.status);
  const type = str(req.query.type);
  if ((eq && !isUuid(eq)) || (tech && !isUuid(tech))) return send(res, []);
  const rows = await getDb().maintenance.findMany({
    where: {
      ...(eq ? { equipment_id: eq } : {}),
      ...(tech ? { technician_id: tech } : {}),
      ...(status === 'scheduled' || status === 'in_progress' || status === 'completed' || status === 'cancelled' ? { status } : {}),
      ...(type === 'routine' || type === 'repair' ? { maintenance_type: type } : {}),
      ...(search ? { OR: [{ description: insensitive(search) }, { equipment: { equipment_name: insensitive(search) } }] } : {}),
    },
    orderBy: { maintenance_date: 'desc' },
    take: LIST_CAP,
  });
  send(res, rows.map(toMaintenance));
}));

maintenanceRouter.get('/:id', h(async (req, res) => send(res, toMaintenance(await findMaintenance(idParam(req, 'id', 'Maintenance'))))));

/**
 * Backend selalu membuat jadwal `scheduled`; status awal lain (in_progress/completed/cancelled) dicapai lewat
 * transisi berurutan. Bila transisi gagal (mis. alat sedang dipinjam), jadwal tetap tersimpan sebagai `scheduled`
 * dan error dikembalikan.
 */
maintenanceRouter.post('/', mWrite, h(async (req, res) => {
  const d = parse(createMaintenanceSchema, req.body);
  if (!isUuid(d.equipment_id)) throw invalid('equipment_id', 'Alat tidak ditemukan');
  if (!isUuid(d.technician_id)) throw invalid('technician_id', 'Teknisi tidak ditemukan');
  const actor = actorOf(req);
  const created = await maintenances.create(
    {
      equipment_id: d.equipment_id, technician_id: d.technician_id, maintenance_type: d.maintenance_type,
      maintenance_date: new Date(d.maintenance_date), description: d.description, cost: d.cost,
      replaced_spare_parts: emptyToNull(d.replaced_spare_parts), notes: emptyToNull(d.notes),
    },
    actor,
  );
  for (const next of pathTo('scheduled', d.status)) {
    await maintenances.update(
      created.maintenance_id,
      { status: next, ...(next === 'completed' && d.completion_date ? { completion_date: new Date(d.completion_date) } : {}) },
      actor,
    );
  }
  send(res, toMaintenance(await findMaintenance(created.maintenance_id)), 201);
}));

maintenanceRouter.patch('/:id', mWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Maintenance');
  const p = parse(updateMaintenanceSchema, req.body);
  const cur = await findMaintenance(id);
  if (p.equipment_id !== undefined && p.equipment_id !== cur.equipment_id) throw invalid('equipment_id', 'Alat tidak dapat diubah setelah dibuat');
  if (p.technician_id !== undefined && !isUuid(p.technician_id)) throw invalid('technician_id', 'Teknisi tidak ditemukan');
  if (p.completion_date && Date.parse(p.completion_date) < Date.parse(p.maintenance_date ?? cur.maintenance_date.toISOString())) {
    throw AppError.conflict('Tanggal selesai tidak boleh sebelum tanggal maintenance');
  }

  const actor = actorOf(req);
  const fields = {
    ...(p.technician_id !== undefined ? { technician_id: p.technician_id } : {}),
    ...(p.maintenance_type !== undefined ? { maintenance_type: p.maintenance_type } : {}),
    ...(p.maintenance_date !== undefined ? { maintenance_date: new Date(p.maintenance_date) } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.cost !== undefined ? { cost: p.cost } : {}),
    ...(p.replaced_spare_parts !== undefined ? { replaced_spare_parts: emptyToNull(p.replaced_spare_parts) } : {}),
    ...(p.notes !== undefined ? { notes: emptyToNull(p.notes) } : {}),
  };
  const steps = p.status ? pathTo(cur.status as MStatus, p.status) : [];
  if (!steps.length) {
    if (Object.keys(fields).length) await maintenances.update(id, fields, actor);
  } else {
    for (const [i, next] of steps.entries()) {
      await maintenances.update(
        id,
        {
          ...(i === 0 ? fields : {}),
          status: next,
          ...(next === 'completed' && p.completion_date ? { completion_date: new Date(p.completion_date) } : {}),
        },
        actor,
      );
    }
  }
  send(res, toMaintenance(await findMaintenance(id)));
}));
