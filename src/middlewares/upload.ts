import multer from 'multer';
import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { CERTIFICATE_MIME, DOCUMENT_MIME } from '../utils/storage';

const CSV_MIME = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream']);

/** Upload CSV kecil (maks 2 MB) ke memori; field file bernama `file`. */
export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) && CSV_MIME.has(file.mimetype);
    if (ok) cb(null, true);
    else cb(AppError.unprocessable('File harus berformat .csv'));
  },
}).single('file');

/** Sertifikat kalibrasi (PDF/gambar) ke memori; field `certificate`. Isi file diverifikasi lagi lewat magic bytes di service. */
export const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.CERTIFICATE_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (CERTIFICATE_MIME.has(file.mimetype)) cb(null, true);
    else cb(AppError.unprocessable('Sertifikat harus berupa PDF, JPEG, PNG, atau WebP'));
  },
}).single('certificate');

/** Dokumen alat (PDF/gambar/DOCX/XLSX) ke memori; field `file`. Isi file diverifikasi lagi (magic bytes) di service. */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DOCUMENT_MAX_MB * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (DOCUMENT_MIME.has(file.mimetype)) cb(null, true);
    else cb(AppError.unprocessable('File harus berupa PDF, JPEG, PNG, WebP, DOCX, atau XLSX'));
  },
}).single('file');
