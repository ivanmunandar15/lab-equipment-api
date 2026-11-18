import type { RoleName } from './permissions';

/**
 * Penerima email pengingat kalibrasi — ubah di file ini saja.
 *
 * Penerima sebuah alat =
 *   1. user dari aturan penanggung jawab yang cocok dengan alat (tabel equipment_responsibility; kelola di menu
 *      "Penanggung Jawab"): awalan kode inventaris dan/atau ruangan,
 *   2. (opsional) penanggung jawab ruangan alat,
 *   3. (opsional, lama) semua user aktif ber-role di `roles`. Default KOSONG: SPV tidak otomatis menerima semua alat.
 * Alat yang tidak punya penerima TIDAK mengirim email ke siapa pun (muncul sebagai "tanpa penanggung jawab" di pratinjau).
 * User dengan email_notifications = false atau nonaktif selalu dilewati (notifikasi di aplikasi tetap dibuat oleh job in-app).
 */
export const EMAIL_RECIPIENTS: { roomPersonInCharge: boolean; byResponsibility: boolean; roles: RoleName[] } = {
  roomPersonInCharge: true,
  byResponsibility: true,
  roles: [],
};
