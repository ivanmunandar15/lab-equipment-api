import { env } from '../../../config/env';
import { STAGE_COLOR, STAGE_LABEL, STAGE_ORDER, type CalibrationEmailStage } from '../reminder-stage';
import { escapeHtml as h } from './escape';

export interface DigestItem {
  equipment_id: string;
  equipment_name: string;
  inventory_code: string;
  room_name: string;
  due_date: string; // YYYY-MM-DD
  days_left: number; // negatif = terlambat
  stage: CalibrationEmailStage;
}

export interface DigestPayload {
  kind: 'digest';
  recipient_name: string;
  items: DigestItem[];
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const base = () => env.FRONTEND_URL.replace(/\/+$/, '');
const equipmentUrl = (id: string) => `${base()}/equipment/${encodeURIComponent(id)}`;
const calibrationUrl = () => `${base()}/calibration`;

export function digestSubject(items: Pick<DigestItem, 'stage'>[]): string {
  const urgent = items.some((i) => i.stage === 'calibration_overdue');
  return `${urgent ? 'PENTING: ' : ''}[Lab] ${items.length} alat mendekati jatuh tempo kalibrasi`;
}

export const remainingText = (days: number): string =>
  days < 0 ? `Terlambat ${Math.abs(days)} hari` : days === 0 ? 'Hari ini' : `${days} hari lagi`;

const group = (items: DigestItem[]) =>
  STAGE_ORDER.map((stage) => ({ stage, rows: items.filter((i) => i.stage === stage) })).filter((g) => g.rows.length);

export function renderDigest(p: DigestPayload): Rendered {
  const subject = digestSubject(p.items);
  const groups = group(p.items);

  const sections = groups
    .map(({ stage, rows }) => {
      const color = STAGE_COLOR[stage];
      const body = rows
        .map(
          (r) => `<tr>
<td style="padding:8px;border-bottom:1px solid #e5e7eb"><a href="${h(equipmentUrl(r.equipment_id))}" style="color:#111827;text-decoration:underline">${h(r.equipment_name)}</a></td>
<td style="padding:8px;border-bottom:1px solid #e5e7eb">${h(r.inventory_code)}</td>
<td style="padding:8px;border-bottom:1px solid #e5e7eb">${h(r.room_name)}</td>
<td style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${h(r.due_date)}</td>
<td style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;color:${color};font-weight:bold">${h(remainingText(r.days_left))}</td>
</tr>`,
        )
        .join('');
      return `<h3 style="margin:24px 0 8px;color:${color};font-size:16px">${h(STAGE_LABEL[stage])} (${rows.length})</h3>
<div style="overflow-x:auto"><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;border-left:4px solid ${color}">
<thead><tr style="background:#f3f4f6;text-align:left"><th style="padding:8px">Alat</th><th style="padding:8px">Kode inventaris</th><th style="padding:8px">Ruangan</th><th style="padding:8px">Jatuh tempo</th><th style="padding:8px">Sisa</th></tr></thead>
<tbody>${body}</tbody></table></div>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(subject)}</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:680px;margin:0 auto;padding:16px">
<div style="background:#ffffff;border-radius:8px;padding:24px">
<p style="margin:0 0 12px;font-size:16px">Halo ${h(p.recipient_name)},</p>
<p style="margin:0 0 8px;font-size:14px">Berikut ${p.items.length} alat yang perlu perhatian terkait jadwal kalibrasi:</p>
${sections}
<p style="margin:28px 0"><a href="${h(calibrationUrl())}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-size:14px">Lihat di aplikasi</a></p>
<p style="margin:0;font-size:12px;color:#6b7280">Tidak ingin menerima email ini? Matikan di Pengaturan &rarr; Notifikasi email. Notifikasi di aplikasi tetap aktif.</p>
</div></div></body></html>`;

  const lines = [`Halo ${p.recipient_name},`, '', `Berikut ${p.items.length} alat yang perlu perhatian terkait jadwal kalibrasi:`];
  for (const { stage, rows } of groups) {
    lines.push('', `== ${STAGE_LABEL[stage]} (${rows.length}) ==`);
    for (const r of rows) {
      lines.push(`- ${r.equipment_name} [${r.inventory_code}] — ${r.room_name} — jatuh tempo ${r.due_date} — ${remainingText(r.days_left)}`);
      lines.push(`  ${equipmentUrl(r.equipment_id)}`);
    }
  }
  lines.push('', `Lihat di aplikasi: ${calibrationUrl()}`, '', 'Untuk berhenti menerima email ini, matikan di Pengaturan > Notifikasi email.');
  return { subject, html, text: lines.join('\n') };
}

export function renderTest(name: string): Rendered {
  const subject = '[Lab] Email uji konfigurasi SMTP';
  return {
    subject,
    html: `<!doctype html><html lang="id"><body style="font-family:Arial,sans-serif"><p>Halo ${h(name)},</p><p>Ini email uji dari Laboratory Equipment Management. Jika Anda menerimanya, konfigurasi SMTP sudah benar.</p></body></html>`,
    text: `Halo ${name},\n\nIni email uji dari Laboratory Equipment Management. Jika Anda menerimanya, konfigurasi SMTP sudah benar.`,
  };
}
