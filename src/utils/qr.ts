import QRCode from 'qrcode';
import { env } from '../config/env';

/** URL stabil untuk isi QR: hanya bergantung pada APP_URL dan qr_token. */
export const equipmentQrUrl = (qrToken: string): string => `${env.APP_URL.replace(/\/+$/, '')}/scan/eq/${qrToken}`;

/** Render PNG QR (error correction M) langsung ke buffer; tidak disimpan ke disk. */
export const qrPng = (text: string, size = 300, margin = 2): Promise<Buffer> =>
  QRCode.toBuffer(text, { errorCorrectionLevel: 'M', type: 'png', width: size, margin });

/** QR barang pendukung mewakili JENIS ITEM (bukan satu unit fisik). */
export const supportingQrUrl = (qrToken: string): string => `${env.APP_URL.replace(/\/+$/, '')}/scan/sp/${qrToken}`;
