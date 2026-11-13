import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
  }
  return transport;
}

/** Kirim lewat SMTP. Mengembalikan provider message id. Melempar error jika gagal. */
export async function sendMail(msg: MailMessage): Promise<string | null> {
  const info = await getTransport().sendMail({ from: env.MAIL_FROM, ...msg });
  return (info as { messageId?: string }).messageId ?? null;
}

/** Verifikasi koneksi SMTP saat startup. Hanya peringatan jika gagal; tidak pernah melempar. */
export async function verifyMailer(): Promise<boolean> {
  if (!env.EMAIL_ENABLED) {
    logger.info('EMAIL_ENABLED=false: email tidak dikirim, isi hanya dicatat ke log');
    return false;
  }
  try {
    await getTransport().verify();
    logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'koneksi SMTP OK');
    return true;
  } catch (err) {
    logger.warn({ err, host: env.SMTP_HOST, port: env.SMTP_PORT }, 'koneksi SMTP gagal diverifikasi (email akan dicoba ulang saat pengiriman)');
    return false;
  }
}
