/**
 * Mapper baris DB / hasil service backend -> bentuk `types/erd.ts` frontend.
 * Aturan umum:
 *  - tanggal waktu = string ISO 8601; kolom `@db.Date` = 'yyyy-MM-dd'
 *  - Decimal -> number (frontend bertipe number)
 *  - kolom opsional di DB (null) -> '' untuk field string wajib di frontend
 *  - tidak ada field internal (password_hash, api_key_hash, lokasi file di disk) yang bocor
 */
type Dec = { toString(): string } | number | null | undefined;
type DateLike = Date | string | null | undefined;

export const iso = (d: DateLike): string => (d instanceof Date ? d.toISOString() : (d ?? ''));
export const isoOrNull = (d: DateLike): string | null => (d === null || d === undefined || d === '' ? null : iso(d));
export const dateOnly = (d: DateLike): string => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ?? '').slice(0, 10));
export const dateOnlyOrNull = (d: DateLike): string | null => (d === null || d === undefined || d === '' ? null : dateOnly(d));
export const num = (v: Dec, fallback = 0): number => (v === null || v === undefined ? fallback : Number(v.toString()));
export const text = (v: string | null | undefined): string => v ?? '';

/* ---------- Kondisi (label Indonesia dipakai frontend di initial/final_condition) ---------- */
export const CONDITION_LABEL = { good: 'Baik', minor_damage: 'Rusak ringan', major_damage: 'Rusak berat' } as const;
export type ConditionKey = keyof typeof CONDITION_LABEL;
export const isCondition = (v: unknown): v is ConditionKey => typeof v === 'string' && v in CONDITION_LABEL;

/** Nilai enum di DB -> label untuk UI. Nilai tak dikenal dikembalikan apa adanya. */
export const conditionLabel = (v: string | null | undefined): string | null =>
  v === null || v === undefined ? null : isCondition(v) ? CONDITION_LABEL[v] : v;

/** Label ("Baik") atau enum ("good") -> enum; null jika tidak dikenali. */
export function parseCondition(v: string | null | undefined): ConditionKey | null {
  if (!v) return null;
  if (isCondition(v)) return v;
  const hit = (Object.entries(CONDITION_LABEL) as [ConditionKey, string][]).find(([, label]) => label.toLowerCase() === v.trim().toLowerCase());
  return hit ? hit[0] : null;
}

/* ---------- User ---------- */
export interface UserLike { user_id: string; name: string; email: string; role: string; is_active: boolean; created_at: Date | string; updated_at: Date | string }
export const toUser = (u: UserLike) => ({
  user_id: u.user_id, name: u.name, email: u.email, role: u.role, is_active: u.is_active,
  created_at: iso(u.created_at), updated_at: iso(u.updated_at),
});

/* ---------- Room ---------- */
export interface RoomLike { room_id: string; room_code: string; room_name: string; equipment_capacity: number; person_in_charge: string | null; description: string | null; created_at: Date | string; updated_at: Date | string }
export const toRoom = (r: RoomLike) => ({
  room_id: r.room_id, room_code: r.room_code, room_name: r.room_name, equipment_capacity: r.equipment_capacity,
  person_in_charge: text(r.person_in_charge), description: text(r.description),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

/* ---------- Equipment ---------- */
export interface EquipmentLike {
  equipment_id: string; inventory_code: string; qr_token: string; equipment_name: string; equipment_type: string;
  brand: string | null; model: string | null; room_id: string; status: string; condition: string | null;
  purchase_date: DateLike; purchase_price: Dec; useful_life_years: number | null; specifications: string | null;
  next_calibration_date: DateLike; is_active: boolean; created_at: Date | string; updated_at: Date | string;
}
export const toEquipment = (e: EquipmentLike) => ({
  equipment_id: e.equipment_id, inventory_code: e.inventory_code, qr_token: e.qr_token,
  equipment_name: e.equipment_name, equipment_type: e.equipment_type, brand: text(e.brand), model: text(e.model),
  room_id: e.room_id, status: e.status, condition: e.condition,
  // condition, purchase_*, useful_life_years, specifications, next_calibration_date dikembalikan null apa adanya
  // (tidak diketahui / tidak berlaku); frontend yang menampilkan "-" (tidak ada lagi nilai pengganti).
  purchase_date: dateOnlyOrNull(e.purchase_date),
  purchase_price: e.purchase_price === null || e.purchase_price === undefined ? null : num(e.purchase_price),
  useful_life_years: e.useful_life_years ?? null,
  specifications: e.specifications === null || e.specifications === '' ? null : e.specifications,
  next_calibration_date: dateOnlyOrNull(e.next_calibration_date),
  is_active: e.is_active, created_at: iso(e.created_at), updated_at: iso(e.updated_at),
});

/* ---------- Supporting equipment ---------- */
export interface SupportingLike {
  supporting_equipment_id: string; item_code: string; qr_token: string; item_name: string; item_type: string | null;
  brand: string | null; model: string | null; unit: string; total_quantity: number; available_quantity: number;
  condition: string; status: string; description: string | null; specifications: string | null;
  is_active: boolean; created_at: Date | string; updated_at: Date | string;
}
export const toSupporting = (s: SupportingLike) => ({
  supporting_equipment_id: s.supporting_equipment_id, item_code: s.item_code, qr_token: s.qr_token,
  item_name: s.item_name, item_type: text(s.item_type), brand: text(s.brand), model: text(s.model), unit: s.unit,
  total_quantity: s.total_quantity, available_quantity: s.available_quantity, condition: s.condition, status: s.status,
  description: text(s.description), specifications: text(s.specifications),
  is_active: s.is_active, created_at: iso(s.created_at), updated_at: iso(s.updated_at),
});

/* ---------- Borrowing ---------- */
export interface BorrowingLike {
  borrowing_id: string; user_id: string; borrowing_time: Date | string; expected_return_time: Date | string;
  actual_return_time: DateLike; purpose: string; usage_location: string | null; borrowing_status: string;
  notes: string | null; created_at: Date | string; updated_at: Date | string;
}
export const toBorrowing = (b: BorrowingLike) => ({
  borrowing_id: b.borrowing_id, user_id: b.user_id, borrowing_time: iso(b.borrowing_time),
  expected_return_time: iso(b.expected_return_time), actual_return_time: isoOrNull(b.actual_return_time),
  purpose: b.purpose, usage_location: text(b.usage_location), borrowing_status: b.borrowing_status,
  notes: text(b.notes), created_at: iso(b.created_at), updated_at: iso(b.updated_at),
});

export interface BorrowingDetailLike { detail_id: string; borrowing_id: string; equipment_id: string; initial_condition: string | null; final_condition: string | null; has_damage: boolean; damage_notes: string | null }
export const toBorrowingDetail = (d: BorrowingDetailLike) => ({
  detail_id: d.detail_id, borrowing_id: d.borrowing_id, equipment_id: d.equipment_id,
  initial_condition: conditionLabel(d.initial_condition) ?? '', final_condition: conditionLabel(d.final_condition),
  has_damage: d.has_damage, damage_notes: d.damage_notes ?? null,
});

export interface SupportingDetailLike { supporting_detail_id: string; borrowing_id: string; supporting_equipment_id: string; quantity_borrowed: number; quantity_returned: number; initial_condition: string | null; final_condition: string | null; has_damage: boolean; damage_notes: string | null }
export const toSupportingDetail = (d: SupportingDetailLike) => ({
  supporting_detail_id: d.supporting_detail_id, borrowing_id: d.borrowing_id, supporting_equipment_id: d.supporting_equipment_id,
  quantity_borrowed: d.quantity_borrowed, quantity_returned: d.quantity_returned,
  initial_condition: conditionLabel(d.initial_condition) ?? '', final_condition: conditionLabel(d.final_condition),
  has_damage: d.has_damage, damage_notes: d.damage_notes ?? null,
});

/** "overdue" tidak disimpan: dihitung (sama dengan `lib/domain.ts` frontend). */
export const isBorrowingOverdue = (status: string, expected: Date | string, now: Date = new Date()) =>
  status === 'borrowed' && new Date(expected) < now;

export function toBorrowingWithDetails(b: BorrowingLike, eq: BorrowingDetailLike[], sp: SupportingDetailLike[], now: Date = new Date()) {
  const overdue = isBorrowingOverdue(b.borrowing_status, b.expected_return_time, now);
  return {
    ...toBorrowing(b),
    equipment_details: eq.map(toBorrowingDetail),
    supporting_details: sp.map(toSupportingDetail),
    is_overdue: overdue,
    display_status: overdue ? 'overdue' : b.borrowing_status,
  };
}

/* ---------- Calibration ---------- */
export interface CalibrationLike {
  calibration_id: string; equipment_id: string; technician_id: string; calibration_date: DateLike; next_calibration_date: DateLike;
  calibration_provider: string | null; certificate_number: string | null; certificate_file_url: string | null;
  calibration_result: string; cost: Dec; notes: string | null; created_at: Date | string;
}
/** `certificate_file_url` = path unduhan ber-auth (bukan lokasi file di server); '' bila tidak ada sertifikat. */
export const certificatePath = (id: string) => `/api/v1/compat/calibrations/${id}/certificate`;
export const toCalibration = (c: CalibrationLike) => ({
  calibration_id: c.calibration_id, equipment_id: c.equipment_id, technician_id: c.technician_id,
  calibration_date: dateOnly(c.calibration_date), next_calibration_date: dateOnly(c.next_calibration_date),
  calibration_provider: text(c.calibration_provider), certificate_number: text(c.certificate_number),
  certificate_file_url: c.certificate_file_url ? certificatePath(c.calibration_id) : '',
  calibration_result: c.calibration_result, cost: num(c.cost), notes: text(c.notes), created_at: iso(c.created_at),
});

/* ---------- Maintenance ---------- */
export interface MaintenanceLike {
  maintenance_id: string; equipment_id: string; technician_id: string; maintenance_type: string; maintenance_date: Date | string;
  completion_date: DateLike; description: string | null; cost: Dec; status: string; replaced_spare_parts: string | null;
  notes: string | null; created_at: Date | string; updated_at: Date | string;
}
export const toMaintenance = (m: MaintenanceLike) => ({
  maintenance_id: m.maintenance_id, equipment_id: m.equipment_id, technician_id: m.technician_id,
  maintenance_type: m.maintenance_type, maintenance_date: iso(m.maintenance_date), completion_date: isoOrNull(m.completion_date),
  description: text(m.description), cost: num(m.cost), status: m.status,
  replaced_spare_parts: text(m.replaced_spare_parts), notes: text(m.notes),
  created_at: iso(m.created_at), updated_at: iso(m.updated_at),
});

/* ---------- Sensor & pembacaan ---------- */
export interface SensorLike {
  sensor_id: string; room_id: string; sensor_code: string; sensor_type: string; unit: string; sensor_location: string | null;
  sensor_status: string; min_threshold: Dec; max_threshold: Dec; created_at: Date | string; updated_at: Date | string;
}
export const toSensor = (s: SensorLike) => ({
  sensor_id: s.sensor_id, room_id: s.room_id, sensor_code: s.sensor_code, sensor_type: s.sensor_type, unit: s.unit,
  sensor_location: text(s.sensor_location), sensor_status: s.sensor_status,
  min_threshold: num(s.min_threshold), max_threshold: num(s.max_threshold),
  created_at: iso(s.created_at), updated_at: iso(s.updated_at),
});

export interface ReadingLike { monitoring_id: string; sensor_id: string; value: Dec; measurement_time: Date | string; received_at: Date | string }
export const toReading = (r: ReadingLike) => ({
  monitoring_id: r.monitoring_id, sensor_id: r.sensor_id, value: num(r.value),
  measurement_time: iso(r.measurement_time), received_at: iso(r.received_at),
});

/** Sama dengan `getReadingStatus` frontend. */
export const readingStatus = (value: number, min: number, max: number): 'low' | 'high' | 'normal' =>
  value < min ? 'low' : value > max ? 'high' : 'normal';

/* ---------- Document ---------- */
export interface DocumentLike {
  document_id: string; equipment_id: string; uploaded_by: string; document_type: string; file_name: string;
  file_type: string | null; file_size: bigint | number | null; uploaded_at: Date | string;
}
/** `file_url` = path unduhan ber-auth. Tambahkan `?inline=true` untuk pratinjau (PDF/gambar). */
export const documentPath = (id: string) => `/api/v1/compat/documents/${id}/file`;
export const toDocument = (d: DocumentLike) => ({
  document_id: d.document_id, equipment_id: d.equipment_id, uploaded_by: d.uploaded_by, document_type: d.document_type,
  file_name: d.file_name, file_url: documentPath(d.document_id), file_type: d.file_type ?? 'application/octet-stream',
  file_size: d.file_size === null ? 0 : Number(d.file_size), uploaded_at: iso(d.uploaded_at),
});

/* ---------- Notification ---------- */
export interface NotificationLike {
  notification_id: string; user_id: string; borrowing_id: string | null; calibration_id: string | null; maintenance_id: string | null;
  notification_type: string; title: string; message: string; is_read: boolean; created_at: Date | string; read_at: DateLike;
}
/** Tautan UI untuk notifikasi (frontend memakai `link_url` opsional). Null bila tidak ada entitas terkait. */
export function notificationLink(n: Pick<NotificationLike, 'notification_type' | 'borrowing_id' | 'calibration_id' | 'maintenance_id'>): string | null {
  if (n.borrowing_id) return '/borrowing';
  if (n.calibration_id) return '/calibration';
  if (n.maintenance_id) return '/maintenance';
  if (n.notification_type === 'calibration') return '/calibration';
  if (n.notification_type === 'borrowing') return '/borrowing';
  if (n.notification_type === 'maintenance') return '/maintenance';
  if (n.notification_type === 'monitoring') return '/monitoring';
  return null;
}
export const toNotification = (n: NotificationLike) => ({
  notification_id: n.notification_id, user_id: n.user_id, borrowing_id: n.borrowing_id, calibration_id: n.calibration_id,
  maintenance_id: n.maintenance_id, notification_type: n.notification_type, title: n.title, message: n.message,
  is_read: n.is_read, created_at: iso(n.created_at), read_at: isoOrNull(n.read_at), link_url: notificationLink(n),
});

/* ---------- Activity log ---------- */
export interface ActivityLike {
  log_id: string; user_id: string | null; action: string; entity_type: string; entity_id: string | null;
  old_data?: unknown; new_data?: unknown; ip_address: string | null; created_at: Date | string;
}

/** Entitas yang di backend dihapus secara soft (is_active=false) -> frontend menyebutnya `soft_delete`. */
const SOFT_DELETE_ENTITIES = new Set(['equipment', 'supporting_equipment', 'user', 'sensor', 'room']);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Aksi backend (UPPERCASE) -> kosakata frontend (`lib/activity-text.ts`):
 * create | update | soft_delete | restore | delete | return | report | login | import | export.
 */
export function compatAction(action: string, entityType: string, oldData?: unknown, newData?: unknown): string {
  const o = obj(oldData);
  const n = obj(newData);
  switch (action) {
    case 'CREATE': case 'BORROW': case 'CALIBRATE': return 'create';
    case 'UPDATE':
      if (o?.is_active === false && n?.is_active === true) return 'restore';
      if (o?.is_active === true && n?.is_active === false) return 'soft_delete';
      return 'update';
    case 'DELETE': return SOFT_DELETE_ENTITIES.has(entityType) ? 'soft_delete' : 'delete';
    case 'LOGIN': return 'login';
    case 'RETURN': return 'return';
    case 'REPORT_DAMAGE': case 'REPORT': return 'report';
    case 'IMPORT': return 'import';
    case 'EXPORT': return 'export';
    case 'START_CALIBRATION': case 'MAINTENANCE_START': case 'MAINTENANCE_COMPLETE': case 'MAINTENANCE_CANCEL':
    case 'CHANGE_PASSWORD': case 'RESET_PASSWORD': case 'ROTATE_API_KEY': case 'REVOKE_API_KEY':
      return 'update';
    default: return action.toLowerCase();
  }
}

export const toActivityLog = (l: ActivityLike) => ({
  log_id: l.log_id, user_id: text(l.user_id),
  action: compatAction(l.action, l.entity_type, l.old_data, l.new_data),
  entity_type: l.entity_type, entity_id: text(l.entity_id),
  old_data: obj(l.old_data), new_data: obj(l.new_data),
  ip_address: text(l.ip_address), created_at: iso(l.created_at),
});
