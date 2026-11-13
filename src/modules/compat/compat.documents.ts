import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { PERMISSIONS } from '../../config/permissions';
import { authorize } from '../../middlewares/rbac';
import { documentUpload } from '../../middlewares/upload';
import { AppError } from '../../utils/errors';
import * as documents from '../documents/documents.service';
import { actorOf } from './compat.audit';
import { parseDataUrl } from './compat.files';
import { LIST_CAP, h, idParam, isUuid, parse, send, str } from './compat.http';
import { toDocument } from './compat.mappers';
import { createDocumentSchema } from './compat.schemas';

async function find(id: string) {
  const row = await getDb().document.findUnique({ where: { document_id: id } });
  if (!row) throw AppError.notFound(`Dokumen dengan ID "${id}" tidak ditemukan`);
  return row;
}

export const documentsRouter = Router();

documentsRouter.get('/', h(async (req, res) => {
  const search = str(req.query.search);
  const eq = str(req.query.equipment_id);
  const type = str(req.query.type);
  if (eq && !isUuid(eq)) return send(res, []);
  const where: Prisma.DocumentWhereInput = {
    ...(eq ? { equipment_id: eq } : {}),
    ...(type && ['manual', 'certificate', 'procedure', 'photo', 'other'].includes(type) ? { document_type: type as never } : {}),
    ...(search ? { file_name: { contains: search, mode: 'insensitive' } } : {}),
  };
  const rows = await getDb().document.findMany({ where, orderBy: { uploaded_at: 'desc' }, take: LIST_CAP });
  send(res, rows.map(toDocument));
}));

documentsRouter.get('/:id', h(async (req, res) => send(res, toDocument(await find(idParam(req, 'id', 'Dokumen'))))));

/** Unduh / pratinjau (`?inline=true` untuk PDF & gambar). Butuh login; lokasi file di server tidak pernah dikirim. */
documentsRouter.get('/:id/file', authorize(...PERMISSIONS.documents.read), h(async (req, res) => {
  const f = await documents.openDownload(idParam(req, 'id', 'Dokumen'), actorOf(req), req.query.inline === 'true');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', `${f.disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  f.stream.on('error', (e) => (res.headersSent ? res.destroy(e) : res.status(500).end()));
  f.stream.pipe(res);
}));

/**
 * Dua bentuk didukung:
 *  1) JSON seperti UI saat ini: `{ equipment_id, document_type, file_name, file_url: "data:...;base64,..." }`
 *  2) multipart: field `file`, `equipment_id`, `document_type`.
 * Pengunggah = pengguna yang login. Isi file diverifikasi (magic bytes) oleh service backend.
 */
documentsRouter.post('/', authorize(...PERMISSIONS.documents.upload), documentUpload, h(async (req, res) => {
  const actor = actorOf(req);
  let file: Express.Multer.File;
  let equipmentId: string;
  let documentType: 'manual' | 'certificate' | 'procedure' | 'photo' | 'other';

  if (req.file) {
    const body = req.body as { equipment_id?: string; document_type?: string };
    const d = parse(createDocumentSchema.pick({ equipment_id: true, document_type: true }), body);
    file = req.file;
    equipmentId = d.equipment_id;
    documentType = d.document_type;
  } else {
    const d = parse(createDocumentSchema, req.body);
    const parsed = parseDataUrl(d.file_url, 'file_url', env.DOCUMENT_MAX_MB * 1024 * 1024);
    file = { buffer: parsed.buffer, mimetype: parsed.mimetype, originalname: d.file_name, size: parsed.buffer.length } as Express.Multer.File;
    equipmentId = d.equipment_id;
    documentType = d.document_type;
  }
  if (!isUuid(equipmentId)) throw AppError.notFound(`Alat dengan ID "${equipmentId}" tidak ditemukan`);

  const created = await documents.create({ equipment_id: equipmentId, document_type: documentType }, file, actor);
  send(res, toDocument(await find(created.document_id)), 201);
}));

/** Hapus permanen (admin/SPV atau pengunggah). Respons 204. */
documentsRouter.delete('/:id', authorize(...PERMISSIONS.documents.read), h(async (req, res) => {
  await documents.remove(idParam(req, 'id', 'Dokumen'), actorOf(req));
  res.status(204).end();
}));
