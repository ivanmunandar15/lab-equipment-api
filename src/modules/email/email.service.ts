import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { getDb } from '../../config/db';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { emailQueue } from './email.queue';
import { sendMail } from './mailer';
import { renderDigest, renderTest, type DigestPayload, type Rendered } from './templates/digest';
import type { ListEmailLogsQuery } from './email.schema';

const ERR_MAX = 500;

function renderFor(row: { payload: unknown; subject: string }, userName: string): Rendered {
  const p = row.payload as { kind?: string } | null;
  if (p?.kind === 'digest') return renderDigest(p as DigestPayload);
  return renderTest(userName);
}

/**
 * Kirim satu email dari EMAIL_LOG. TIDAK PERNAH melempar: kegagalan dicatat (status failed, attempts+1, error_message).
 * Idempoten: baris yang sudah `sent` tidak dikirim ulang.
 */
export async function deliverEmail(emailLogId: string): Promise<{ ok: boolean; status: 'sent' | 'failed' | 'missing'; error?: string }> {
  const db = getDb();
  try {
    const row = await db.emailLog.findUnique({
      where: { email_log_id: emailLogId },
      select: { email_log_id: true, status: true, attempts: true, recipient_email: true, subject: true, payload: true, user: { select: { name: true } } },
    });
    if (!row) return { ok: false, status: 'missing' };
    if (row.status === 'sent') return { ok: true, status: 'sent' };

    const rendered = renderFor(row, row.user?.name ?? row.recipient_email);
    try {
      let messageId: string | null;
      if (!env.EMAIL_ENABLED) {
        logger.info({ to: row.recipient_email, subject: rendered.subject, text: rendered.text }, 'EMAIL_ENABLED=false — email tidak dikirim (isi dicatat)');
        messageId = 'dev-log';
      } else {
        messageId = await sendMail({ to: row.recipient_email, subject: rendered.subject, html: rendered.html, text: rendered.text });
      }
      const sent_at = new Date();
      await db.emailLog.update({
        where: { email_log_id: emailLogId },
        data: { status: 'sent', attempts: row.attempts + 1, error_message: null, provider_message_id: messageId, sent_at, subject: rendered.subject },
      });
      await db.emailLog.updateMany({ where: { parent_id: emailLogId }, data: { status: 'sent', sent_at, provider_message_id: messageId } });
      return { ok: true, status: 'sent' };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, ERR_MAX);
      logger.warn({ emailLogId, err: message }, 'pengiriman email gagal');
      await db.emailLog.update({ where: { email_log_id: emailLogId }, data: { status: 'failed', attempts: row.attempts + 1, error_message: message } });
      await db.emailLog.updateMany({ where: { parent_id: emailLogId }, data: { status: 'failed', error_message: message } });
      return { ok: false, status: 'failed', error: message };
    }
  } catch (err) {
    logger.error({ err, emailLogId }, 'deliverEmail error tak terduga');
    return { ok: false, status: 'failed', error: 'internal' };
  }
}

emailQueue.setHandler(async (id) => ({ ok: (await deliverEmail(id)).ok }));

/** Saat startup: masukkan kembali email `queued` yang tertinggal (mis. server restart). Tidak pernah melempar. */
export async function recoverQueuedEmails(): Promise<number> {
  try {
    const rows = await getDb().emailLog.findMany({ where: { status: 'queued', parent_id: null }, select: { email_log_id: true }, take: 500 });
    rows.forEach((r) => emailQueue.enqueue(r.email_log_id));
    return rows.length;
  } catch (err) {
    logger.warn({ err }, 'gagal memulihkan antrean email');
    return 0;
  }
}

const LIST_SELECT = {
  email_log_id: true, user_id: true, equipment_id: true, parent_id: true, reminder_type: true, next_calibration_date: true,
  recipient_email: true, subject: true, status: true, attempts: true, error_message: true, provider_message_id: true,
  created_at: true, sent_at: true,
} as const;

export async function list(q: ListEmailLogsQuery) {
  const db = getDb();
  const where: Prisma.EmailLogWhereInput = {};
  if (!q.include_markers) where.parent_id = null;
  if (q.status) where.status = q.status;
  if (q.reminder_type) where.reminder_type = q.reminder_type;
  if (q.user_id) where.user_id = q.user_id;
  if (q.date_from || q.date_to) where.created_at = { ...(q.date_from ? { gte: q.date_from } : {}), ...(q.date_to ? { lte: q.date_to } : {}) };
  if (q.search) where.OR = [{ recipient_email: { contains: q.search, mode: 'insensitive' } }, { subject: { contains: q.search, mode: 'insensitive' } }];
  const sort = resolveSort(q.sort, ['created_at', 'sent_at', 'status', 'attempts', 'recipient_email'], 'created_at');
  const { page, limit, skip, take } = getPagination(q);
  const [items, total] = await Promise.all([
    db.emailLog.findMany({ where, select: LIST_SELECT, orderBy: { [sort]: q.order }, skip, take }),
    db.emailLog.count({ where }),
  ]);
  return { items, meta: buildMeta(page, limit, total) };
}

/** Kirim ulang email gagal (admin). Jika yang dipilih penanda per-alat, yang dikirim ulang adalah email induknya. */
export async function retry(id: string) {
  const db = getDb();
  const row = await db.emailLog.findUnique({ where: { email_log_id: id }, select: { email_log_id: true, parent_id: true, status: true } });
  if (!row) throw AppError.notFound('Log email tidak ditemukan');
  const targetId = row.parent_id ?? row.email_log_id;
  const target = row.parent_id
    ? await db.emailLog.findUnique({ where: { email_log_id: targetId }, select: { email_log_id: true, status: true } })
    : row;
  if (!target) throw AppError.notFound('Email induk tidak ditemukan');
  if (target.status !== 'failed') throw new AppError(409, 'EMAIL_NOT_FAILED', 'Hanya email berstatus failed yang bisa dikirim ulang');
  await db.$transaction(async (tx) => {
    await tx.emailLog.update({ where: { email_log_id: targetId }, data: { status: 'queued', error_message: null } });
    await tx.emailLog.updateMany({ where: { parent_id: targetId }, data: { status: 'queued', error_message: null } });
  });
  emailQueue.enqueue(targetId);
  return { email_log_id: targetId, status: 'queued' as const };
}

/** Email uji ke alamat user yang login (sinkron, agar hasil SMTP langsung terlihat). */
export async function sendTest(user: { user_id: string; email: string; name: string }) {
  const db = getDb();
  const r = renderTest(user.name);
  const row = await db.emailLog.create({
    data: { user_id: user.user_id, reminder_type: 'digest', recipient_email: user.email, subject: r.subject, status: 'queued', payload: { kind: 'test' } },
    select: { email_log_id: true },
  });
  const res = await deliverEmail(row.email_log_id);
  return { email_log_id: row.email_log_id, to: user.email, status: res.status, error_message: res.error ?? null, email_enabled: env.EMAIL_ENABLED };
}

export async function setPreference(userId: string, email_notifications: boolean) {
  return getDb().user.update({ where: { user_id: userId }, data: { email_notifications }, select: { user_id: true, email_notifications: true } });
}
