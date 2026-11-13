import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logger } from '../config/logger';
import { csvStream } from './csv';
import { qrPng } from './qr';

type Rows = AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;

export const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
export const safeName = (code: string) => code.replace(/[^\w.-]+/g, '_');

/** Error saat streaming tidak bisa lagi dibalas JSON (header sudah terkirim) → putuskan koneksi. */
export async function finishStream(res: Writable, label: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (err) {
    logger.error({ err }, `Gagal streaming ${label}`);
    res.destroy(err as Error);
  }
}

export async function streamCsvDownload(res: Response, label: string, filename: string, columns: string[], rows: Rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await finishStream(res, label, () => pipeline(csvStream(columns, rows), res));
}

/** Stream QR PNG per entri secara lazy; satu per satu sehingga memori tetap kecil. */
function lazyQr(text: string): Readable {
  let started = false;
  return new Readable({
    read() {
      if (started) return;
      started = true;
      qrPng(text, 300, 2).then(
        (buf) => {
          this.push(buf);
          this.push(null);
        },
        (e) => this.destroy(e),
      );
    },
  });
}

export interface ZipEntry {
  code: string;
  qr_url: string;
}

/** ZIP berisi `csvName` + `qr/<code>.png` per entri. Streaming dengan backpressure (~20 entri antre). */
export async function streamQrZip(
  res: Response,
  o: { label: string; filename: string; csvName: string; columns: string[]; rows: Rows; entries: AsyncIterable<ZipEntry> },
) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${o.filename}"`);

  await finishStream(res, o.label, async () => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    let appended = 0;
    let done = 0;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    archive.on('entry', () => {
      done++;
      notify();
    });
    archive.on('error', (e) => {
      failure = e;
      notify();
      res.destroy(e);
    });
    archive.on('warning', (e) => logger.warn({ err: e }, 'archiver warning'));
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });
    archive.pipe(res);

    archive.append(csvStream(o.columns, o.rows), { name: o.csvName });
    appended++;

    const used = new Set<string>();
    for await (const e of o.entries) {
      while (appended - done >= 20 && !failure) await new Promise<void>((resolve) => (wake = resolve));
      if (failure) throw failure;
      let name = safeName(e.code);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${safeName(e.code)}_${n}`;
      used.add(name.toLowerCase());
      archive.append(lazyQr(e.qr_url), { name: `qr/${name}.png` });
      appended++;
    }
    await archive.finalize();
  });
}

// ───────── Label PDF ─────────

export type LabelLayout = 'a4-3x8' | 'sticker-50x30';
export interface LabelItem {
  title: string;
  code: string;
  qr_url: string;
}

const MM = 72 / 25.4;

function drawLabel(
  doc: PDFKit.PDFDocument,
  png: Buffer,
  item: LabelItem,
  x: number,
  y: number,
  w: number,
  h: number,
  o: { qr: number; name: number; code: number; border: boolean },
) {
  const pad = 5;
  if (o.border) doc.lineWidth(0.25).strokeColor('#bbbbbb').rect(x, y, w, h).stroke();
  const qr = Math.min(h - pad * 2, o.qr);
  doc.image(png, x + pad, y + (h - qr) / 2, { width: qr, height: qr });
  const tx = x + pad * 2 + qr;
  const tw = w - (tx - x) - pad;
  doc
    .fillColor('#000000')
    .font('Helvetica-Bold')
    .fontSize(o.name)
    .text(item.title, tx, y + pad, { width: tw, height: h - pad * 2 - o.code * 1.6, ellipsis: true });
  doc
    .font('Courier')
    .fontSize(o.code)
    .text(item.code, tx, y + h - pad - o.code * 1.2, { width: tw, lineBreak: false, ellipsis: true });
}

export async function streamLabelsPdf(
  res: Response,
  o: { label: string; filename: string; docTitle: string; layout: LabelLayout; items: LabelItem[] },
) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${o.filename}"`);

  await finishStream(res, o.label, async () => {
    const sticker = o.layout === 'sticker-50x30';
    const doc = new PDFDocument({
      size: sticker ? [50 * MM, 30 * MM] : 'A4',
      margin: 0,
      info: { Title: o.docTitle },
    });
    doc.pipe(res);
    const closed = new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      doc.on('error', reject);
    });

    const M = 20;
    const cw = (doc.page.width - M * 2) / 3;
    const ch = (doc.page.height - M * 2) / 8;
    for (let i = 0; i < o.items.length; i++) {
      const png = await qrPng(o.items[i].qr_url, 300, 1);
      if (sticker) {
        if (i > 0) doc.addPage();
        drawLabel(doc, png, o.items[i], 0, 0, doc.page.width, doc.page.height, { qr: 26 * MM, name: 6.5, code: 6, border: false });
      } else {
        const pos = i % 24;
        if (i > 0 && pos === 0) doc.addPage();
        drawLabel(doc, png, o.items[i], M + (pos % 3) * cw, M + Math.floor(pos / 3) * ch, cw, ch, { qr: 80, name: 8, code: 7, border: true });
      }
    }
    doc.end();
    await closed;
  });
}
