import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type RoleName } from '../../config/permissions';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import {
  cleanDisplayName,
  deleteStored,
  documentMimeFromKey,
  documentMimeMatches,
  DOCUMENT_MIME,
  IMAGE_MIME,
  INLINE_MIME,
  resolveStoragePath,
  saveDocumentFile,
} from '../../utils/storage';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import type { CreateDocumentBody, ListDocumentsQuery } from './documents.schema';

export interface Actor {
  userId: string;
  role: RoleName;
  ip: string | null;
}

const SORTABLE = ['uploaded_at', 'file_name', 'file_size', 'document_type'];

// file_url (storage key) sengaja tidak dikembalikan ke client.
const SELECT = {
  document_id: true,
  equipment_id: true,
  uploaded_by: true,
  document_type: true,
  file_name: true,
  file_type: true,
  file_size: true,
  uploaded_at: true,
  equipment: { select: { equipment_id: true, inventory_code: true, equipment_name: true } },
  uploader: { select: { user_id: true, name: true } },
} satisfies Prisma.DocumentSelect;

type Row = Prisma.DocumentGetPayload<{ select: typeof SELECT }>;

const present = (r: Row) => ({
  ...r,
  file_size: r.file_size === null ? null : Number(r.file_size), // BigInt tidak bisa di-JSON
  download_path: `/api/v1/documents/${r.document_id}/download`,
});

export async function list(q: ListDocumentsQuery) {
  const db = getDb();
  const where: Prisma.DocumentWhereInput = {
    ...(q.equipment_id ? { equipment_id: q.equipment_id } : {}),
    ...(q.document_type ? { document_type: q.document_type } : {}),
    ...(q.uploaded_by ? { uploaded_by: q.uploaded_by } : {}),
    ...(q.search
      ? {
          OR: [
            { file_name: { contains: q.search, mode: 'insensitive' } },
            { equipment: { equipment_name: { contains: q.search, mode: 'insensitive' } } },
            { equipment: { inventory_code: { contains: q.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sort = resolveSort(q.sort, SORTABLE, 'uploaded_at');
  const [rows, total] = await Promise.all([
    db.document.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: SELECT }),
    db.document.count({ where }),
  ]);
  return { items: rows.map(present), meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().document.findUnique({ where: { document_id: id }, select: SELECT });
  if (!row) throw AppError.notFound('Dokumen tidak ditemukan');
  return present(row);
}

export async function create(body: CreateDocumentBody, file: Express.Multer.File | undefined, actor: Actor) {
  if (!file) throw AppError.unprocessable('Validasi gagal', [{ path: 'file', message: 'File wajib diunggah (field "file")' }]);
  if (!DOCUMENT_MIME.has(file.mimetype) || !documentMimeMatches(file.buffer, file.mimetype)) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'file', message: 'Isi file tidak sesuai tipe yang dideklarasikan' }]);
  }
  if (body.document_type === 'photo' && !IMAGE_MIME.has(file.mimetype)) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'file', message: 'Dokumen bertipe photo harus berupa gambar (JPEG/PNG/WebP)' }]);
  }

  const db = getDb();
  const eq = await db.equipment.findUnique({ where: { equipment_id: body.equipment_id }, select: { equipment_id: true } });
  if (!eq) throw AppError.notFound('Alat tidak ditemukan');

  const key = await saveDocumentFile(file.buffer, file.mimetype);
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.document.create({
        data: {
          equipment_id: body.equipment_id,
          uploaded_by: actor.userId,
          document_type: body.document_type,
          file_name: cleanDisplayName(file.originalname),
          file_url: key,
          file_type: file.mimetype,
          file_size: BigInt(file.size),
        },
        select: SELECT,
      });
      const out = present(row);
      await audit.log(
        { userId: actor.userId, action: AUDIT_ACTIONS.CREATE, entityType: AUDIT_ENTITIES.DOCUMENT, entityId: row.document_id, newData: out, ip: actor.ip },
        tx,
      );
      return out;
    });
  } catch (e) {
    await deleteStored(key); // jangan tinggalkan file yatim bila DB gagal
    throw e;
  }
}

export async function openDownload(id: string, actor: Actor, inline: boolean) {
  // Defense in depth: route sudah memakai authorize(), dicek lagi di sini.
  if (!PERMISSIONS.documents.read.includes(actor.role)) throw AppError.forbidden('Anda tidak memiliki akses ke dokumen ini');

  const row = await getDb().document.findUnique({
    where: { document_id: id },
    select: { document_id: true, file_name: true, file_url: true, file_type: true },
  });
  if (!row) throw AppError.notFound('Dokumen tidak ditemukan');

  const full = resolveStoragePath(row.file_url); // menolak key di luar folder upload
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw AppError.notFound('File dokumen tidak ditemukan di penyimpanan');

  const mime = row.file_type && DOCUMENT_MIME.has(row.file_type) ? row.file_type : documentMimeFromKey(row.file_url);
  return {
    stream: createReadStream(full),
    mime,
    size: info.size,
    filename: row.file_name,
    disposition: inline && INLINE_MIME.has(mime) ? 'inline' : 'attachment',
  };
}

export async function remove(id: string, actor: Actor) {
  const db = getDb();
  const row = await db.document.findUnique({ where: { document_id: id }, select: { ...SELECT, file_url: true } });
  if (!row) throw AppError.notFound('Dokumen tidak ditemukan');

  const allowed = PERMISSIONS.documents.deleteAny.includes(actor.role) || row.uploaded_by === actor.userId;
  if (!allowed) throw AppError.forbidden('Hanya admin/SPV atau pengunggah yang boleh menghapus dokumen');

  const { file_url, ...meta } = row;
  await db.$transaction(async (tx) => {
    await tx.document.delete({ where: { document_id: id } });
    await audit.log(
      { userId: actor.userId, action: AUDIT_ACTIONS.DELETE, entityType: AUDIT_ENTITIES.DOCUMENT, entityId: id, oldData: present(meta), ip: actor.ip },
      tx,
    );
  });
  await deleteStored(file_url); // setelah commit; kegagalan hapus file tidak mengubah hasil
  return { document_id: id, deleted: true };
}
