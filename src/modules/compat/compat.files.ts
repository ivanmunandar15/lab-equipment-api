import { AppError } from '../../utils/errors';

/**
 * Data URL (`data:<mime>;base64,<data>`) -> Buffer. UI frontend mengirim file sebagai data URL
 * (hasil FileReader.readAsDataURL) di body JSON. Validasi isi file (magic bytes) tetap dilakukan
 * oleh service backend yang dipakai ulang.
 */
export function parseDataUrl(value: string, field: string, maxBytes: number): { buffer: Buffer; mimetype: string } {
  const m = /^data:([\w.+-]+\/[\w.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!m) throw AppError.unprocessable('Validasi gagal', [{ path: field, message: 'File harus berupa data URL base64' }]);
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0) throw AppError.unprocessable('Validasi gagal', [{ path: field, message: 'File kosong' }]);
  if (buffer.length > maxBytes) {
    throw AppError.unprocessable('Validasi gagal', [{ path: field, message: `Ukuran file maksimal ${Math.round(maxBytes / 1048576)} MB` }]);
  }
  return { buffer, mimetype: m[1].toLowerCase() };
}
