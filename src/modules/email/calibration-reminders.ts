import type { Prisma } from '@prisma/client';
import { EMAIL_RECIPIENTS } from '../../config/email-recipients';
import { env } from '../../config/env';
import { getDb } from '../../config/db';
import { logger } from '../../config/logger';
import { localDayKey } from '../../jobs/runner';
import { addUtcDays, dateOnly } from '../equipment/equipment.derive';
import { emailQueue } from './email.queue';
import { daysUntil, emailStageFor, lookaheadLimit, DAY_MS, type CalibrationEmailStage } from './reminder-stage';
import { digestSubject, type DigestItem, type DigestPayload } from './templates/digest';

interface RecipientUser {
  user_id: string;
  name: string;
  email: string;
  is_active: boolean;
  email_notifications: boolean;
}

interface Candidate {
  equipment_id: string;
  equipment_name: string;
  inventory_code: string;
  next: Date;
  stage: CalibrationEmailStage;
  days_left: number;
  room_name: string;
  pic: RecipientUser | null;
}

interface Marker {
  email_log_id: string;
  user_id: string;
  equipment_id: string | null;
  reminder_type: string;
  next_calibration_date: Date | null;
  status: string;
  sent_at: Date | null;
  created_at: Date;
}

export interface PlannedEmail {
  user: RecipientUser;
  items: DigestItem[];
  newMarkers: { equipment_id: string; type: CalibrationEmailStage; next: Date }[];
  reuseMarkerIds: string[];
}

const eligible = (u: RecipientUser | null | undefined): u is RecipientUser => !!u && u.is_active && u.email_notifications && !!u.email;

/**
 * Penerima sebuah alat = PIC ruangan + user aktif ber-role di EMAIL_RECIPIENTS.roles (tanpa duplikat),
 * hanya yang email_notifications = true. Dipisah agar mudah diuji.
 */
export function recipientsForEquipment(pic: RecipientUser | null, roleUsers: RecipientUser[]): RecipientUser[] {
  const map = new Map<string, RecipientUser>();
  if (EMAIL_RECIPIENTS.roomPersonInCharge && eligible(pic)) map.set(pic.user_id, pic);
  for (const u of roleUsers) if (eligible(u)) map.set(u.user_id, u);
  return [...map.values()];
}

const USER_SELECT = { user_id: true, name: true, email: true, is_active: true, email_notifications: true } as const;

/** Susun rencana email (tanpa efek samping). `today` = tanggal lokal (UTC 00:00). */
export async function planCalibrationEmails(now: Date = new Date()): Promise<PlannedEmail[]> {
  const db = getDb();
  const today = new Date(`${localDayKey(now)}T00:00:00.000Z`);

  const rows = (await db.equipment.findMany({
    where: { is_active: true, status: { not: 'calibration' }, next_calibration_date: { lte: lookaheadLimit(today) } },
    select: {
      equipment_id: true, equipment_name: true, inventory_code: true, is_active: true, status: true, next_calibration_date: true,
      room: { select: { room_name: true, pic: { select: USER_SELECT } } },
    },
  })) as unknown as Array<{
    equipment_id: string; equipment_name: string; inventory_code: string; is_active: boolean; status: string;
    next_calibration_date: Date | null; room: { room_name: string; pic: RecipientUser | null } | null;
  }>;

  const candidates: Candidate[] = [];
  for (const e of rows) {
    if (!e.is_active || e.status === 'calibration' || !e.next_calibration_date) continue;
    const days = daysUntil(e.next_calibration_date, today);
    const stage = emailStageFor(days);
    if (!stage) continue;
    candidates.push({
      equipment_id: e.equipment_id, equipment_name: e.equipment_name, inventory_code: e.inventory_code,
      next: e.next_calibration_date, stage, days_left: days, room_name: e.room?.room_name ?? '-', pic: e.room?.pic ?? null,
    });
  }
  if (!candidates.length) return [];

  const roleUsers = (await db.user.findMany({
    where: { is_active: true, email_notifications: true, role: { in: EMAIL_RECIPIENTS.roles } },
    select: USER_SELECT,
  })) as RecipientUser[];

  // Penanda yang sudah ada (idempotensi).
  const markers = (await db.emailLog.findMany({
    where: { equipment_id: { in: candidates.map((c) => c.equipment_id) } },
    select: { email_log_id: true, user_id: true, equipment_id: true, reminder_type: true, next_calibration_date: true, status: true, sent_at: true, created_at: true },
  })) as Marker[];
  const keyOf = (u: string, e: string | null, t: string, d: Date | null) => `${u}|${e}|${t}|${d ? dateOnly(d) : ''}`;
  const existing = new Map<string, Marker>();
  for (const m of markers) if (m.reminder_type !== 'digest') existing.set(keyOf(m.user_id, m.equipment_id, m.reminder_type, m.next_calibration_date), m);

  const repeatMs = env.OVERDUE_REMINDER_REPEAT_DAYS * DAY_MS;
  const plans = new Map<string, PlannedEmail>();

  for (const c of candidates) {
    for (const user of recipientsForEquipment(c.pic, roleUsers)) {
      const marker = existing.get(keyOf(user.user_id, c.equipment_id, c.stage, c.next));
      let reuseId: string | null = null;
      if (marker) {
        if (c.stage !== 'calibration_overdue') continue; // tahap ini sudah pernah dibuat untuk jadwal ini
        if (marker.status === 'queued') continue; // masih dalam proses
        const base = marker.sent_at ?? marker.created_at;
        if (now.getTime() - base.getTime() < repeatMs) continue; // belum waktunya ulang
        reuseId = marker.email_log_id;
      }
      let plan = plans.get(user.user_id);
      if (!plan) plans.set(user.user_id, (plan = { user, items: [], newMarkers: [], reuseMarkerIds: [] }));
      plan.items.push({
        equipment_id: c.equipment_id, equipment_name: c.equipment_name, inventory_code: c.inventory_code, room_name: c.room_name,
        due_date: dateOnly(c.next) as string, days_left: c.days_left, stage: c.stage,
      });
      if (reuseId) plan.reuseMarkerIds.push(reuseId);
      else plan.newMarkers.push({ equipment_id: c.equipment_id, type: c.stage, next: c.next });
    }
  }
  return [...plans.values()];
}

/**
 * Email pengingat kalibrasi (digest per penerima). Idempoten: tahap yang sama untuk jadwal kalibrasi yang sama tidak
 * dikirim dua kali (unique EMAIL_LOG). Kegagalan tidak pernah melempar ke pemanggil.
 */
export async function runCalibrationEmailReminders(now: Date = new Date(), opts: { dryRun?: boolean } = {}) {
  const plans = await planCalibrationEmails(now);

  if (opts.dryRun) {
    return {
      dry_run: true,
      emails: plans.map((p) => ({
        to: p.user.email, user_id: p.user.user_id, subject: digestSubject(p.items), item_count: p.items.length, items: p.items,
      })),
    };
  }

  const db = getDb();
  let queued = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of plans) {
    try {
      const subject = digestSubject(p.items);
      const payload: DigestPayload = { kind: 'digest', recipient_name: p.user.name, items: p.items };
      const digest = await db.$transaction(async (tx) => {
        const d = await tx.emailLog.create({
          data: { user_id: p.user.user_id, reminder_type: 'digest', recipient_email: p.user.email, subject, status: 'queued', payload: payload as unknown as Prisma.InputJsonValue },
          select: { email_log_id: true },
        });
        if (p.newMarkers.length) {
          await tx.emailLog.createMany({
            data: p.newMarkers.map((m) => ({
              user_id: p.user.user_id, equipment_id: m.equipment_id, reminder_type: m.type, next_calibration_date: m.next,
              recipient_email: p.user.email, subject, status: 'queued' as const, parent_id: d.email_log_id,
            })),
          });
        }
        if (p.reuseMarkerIds.length) {
          await tx.emailLog.updateMany({
            where: { email_log_id: { in: p.reuseMarkerIds } },
            data: { status: 'queued', parent_id: d.email_log_id, error_message: null, sent_at: null },
          });
        }
        return d;
      });
      emailQueue.enqueue(digest.email_log_id);
      queued++;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') skipped++; // sudah dibuat proses lain
      else {
        failed++;
        logger.error({ err, user_id: p.user.user_id }, 'gagal menyiapkan email pengingat kalibrasi');
      }
    }
  }
  return { dry_run: false, recipients: plans.length, queued, skipped, failed };
}

export { addUtcDays };
