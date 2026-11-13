/**
 * Matriks hak akses (RBAC) — ubah di file ini saja.
 * Dipakai di route: authorize(...PERMISSIONS.<modul>.<aksi>)
 */
export type RoleName = 'QA' | 'admin' | 'technician' | 'SPV';

const ALL: RoleName[] = ['admin', 'SPV', 'technician', 'QA'];

export const PERMISSIONS = {
  users: { manage: ['admin'] as RoleName[] },
  dashboard: { read: ALL, /** Aktivitas terakhir mengikuti hak activity log. */ recentActivity: ['admin', 'SPV', 'QA'] as RoleName[] },
  activityLogs: { read: ['admin', 'SPV', 'QA'] as RoleName[] },
  rooms: { read: ALL, write: ['admin', 'SPV'] as RoleName[] },
  equipment: {
    read: ALL,
    write: ['admin', 'SPV'] as RoleName[],
    /** Siapa yang boleh mengubah inventory_code. qr_token tidak pernah bisa diubah siapa pun. */
    changeInventoryCode: ['admin', 'SPV'] as RoleName[],
    /** Lapor kerusakan dari halaman scan. */
    reportDamage: ALL,
  },
  supportingEquipment: { read: ALL, write: ['admin', 'SPV'] as RoleName[] },
  borrowings: {
    read: ALL,
    write: ALL,
    /** Selain peminjam sendiri, siapa yang boleh memproses pengembalian. Ubah ke ALL untuk membebaskan. */
    returnAny: ['admin', 'SPV'] as RoleName[],
  },
  calibrations: { read: ALL, write: ['admin', 'SPV', 'technician'] as RoleName[] },
  maintenances: {
    read: ALL,
    write: ['admin', 'SPV', 'technician'] as RoleName[],
    /** Hapus permanen (hanya yang masih scheduled). */
    delete: ['admin', 'SPV'] as RoleName[],
  },
  /** Kelola sensor & API key perangkat. */
  sensors: { read: ['admin', 'SPV'] as RoleName[], write: ['admin', 'SPV'] as RoleName[] },
  monitoring: {
    read: ALL,
    /** Penerima notifikasi bila nilai sensor di luar batas (ditambah PIC ruangan). */
    alertRecipients: ['admin', 'SPV', 'technician'] as RoleName[],
  },
  documents: {
    read: ALL,
    upload: ['admin', 'SPV', 'technician'] as RoleName[],
    /** Selain pengunggah, siapa yang boleh menghapus dokumen. */
    deleteAny: ['admin', 'SPV'] as RoleName[],
  },
  /** Log email pengingat. */
  emailLogs: { read: ['admin', 'SPV'] as RoleName[], retry: ['admin'] as RoleName[] },
  /** Alat admin: email uji & jalankan job manual. */
  adminTools: { emailTest: ['admin'] as RoleName[], runJobs: ['admin'] as RoleName[] },
};
