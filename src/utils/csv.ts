import { format } from 'fast-csv';
import { parse } from 'csv-parse/sync';
import { PassThrough, Readable } from 'node:stream';
import { AppError } from './errors';

export const BOM = '\uFEFF';

/** Cegah formula injection di Excel/Sheets: sel teks berawalan = + - @ diberi tanda kutip. */
export function csvSafe(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * Stream CSV UTF-8 dengan BOM dari async iterable baris (objek). Tidak memuat semua data ke memori.
 */
export function csvStream(columns: string[], rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>): Readable {
  const out = new PassThrough();
  out.write(BOM);
  const fmt = format({ headers: columns, writeHeaders: true });
  const src = Readable.from(rows, { objectMode: true });
  src.on('error', (e) => out.destroy(e));
  fmt.on('error', (e) => out.destroy(e));
  src.pipe(fmt).pipe(out);
  return out;
}

/** Teks CSV kecil (mis. template) dengan BOM. */
export function csvText(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = String(csvSafe(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return BOM + [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parse CSV (BOM, header case-insensitive, baris kosong diabaikan). Melempar 422 INVALID_CSV jika rusak. */
export function parseCsv(buf: Buffer, maxRows: number): ParsedCsv {
  let headers: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parse(buf, {
      bom: true,
      columns: (h: string[]) => {
        headers = h.map((x) => x.trim().toLowerCase());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new AppError(422, 'INVALID_CSV', `CSV tidak dapat dibaca: ${(err as Error).message}`);
  }
  if (rows.length > maxRows) {
    throw new AppError(422, 'CSV_TOO_MANY_ROWS', `Maksimal ${maxRows} baris data per impor`, { rows: rows.length });
  }
  return { headers, rows };
}
