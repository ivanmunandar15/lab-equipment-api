import type { RoleName } from './permissions';

/**
 * Penerima email pengingat kalibrasi — ubah di file ini saja.
 * Penerima sebuah alat = (opsional) penanggung jawab ruangan alat + semua user aktif dengan role di `roles`.
 * User dengan email_notifications = false selalu dilewati (notifikasi di aplikasi tetap dibuat oleh job in-app).
 */
export const EMAIL_RECIPIENTS: { roomPersonInCharge: boolean; roles: RoleName[] } = {
  roomPersonInCharge: true,
  roles: ['SPV'],
};
