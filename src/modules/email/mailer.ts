import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../../config/logger';
import { loadEmailSettings, type EmailSettingsFull } from './email-settings';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transport: Transporter | null = null;
let transportKey = '';

function createTransport(s: EmailSettingsFull): Transporter {
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port,
    secure: s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

/** Transport dibuat ulang otomatis bila pengaturan SMTP berubah (tanpa restart server). */
function getTransport(s: EmailSettingsFull): Transporter {
  const key = JSON.stringify([s.smtp_host, s.smtp_port, s.smtp_secure, s.smtp_user, s.smtp_pass]);
  if (!transport || key !== transportKey) {
    transport?.close();
    transport = createTransport(s);
    transportKey = key;
  }
  return transport;
}

/** Kirim lewat SMTP. Mengembalikan provider message id. Melempar error jika gagal. */
export async function sendMail(msg: MailMessage): Promise<string | null> {
  const s = await loadEmailSettings();
  const info = await getTransport(s).sendMail({ from: s.mail_from, ...msg });
  return (info as { messageId?: string }).messageId ?? null;
}

/** Verifikasi koneksi SMTP saat startup. Hanya peringatan jika gagal; tidak pernah melempar. */
export async function verifyMailer(): Promise<boolean> {
  const s = await loadEmailSettings();
  if (!s.email_enabled) {
    logger.info('email nonaktif: email tidak dikirim, isi hanya dicatat ke log');
    return false;
  }
  try {
    await getTransport(s).verify();
    logger.info({ host: s.smtp_host, port: s.smtp_port }, 'koneksi SMTP OK');
    return true;
  } catch (err) {
    logger.warn({ err, host: s.smtp_host, port: s.smtp_port }, 'koneksi SMTP gagal diverifikasi (email akan dicoba ulang saat pengiriman)');
    return false;
  }
}

/** Uji koneksi + login ke server SMTP dengan pengaturan tersimpan (untuk tombol "Tes koneksi"). Tidak pernah melempar. */
export async function verifySmtpConnection(): Promise<{ ok: boolean; host: string; port: number; error: string | null }> {
  const s = await loadEmailSettings();
  const t = createTransport(s);
  try {
    await t.verify();
    return { ok: true, host: s.smtp_host, port: s.smtp_port, error: null };
  } catch (err) {
    return { ok: false, host: s.smtp_host, port: s.smtp_port, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  } finally {
    t.close();
  }
}
