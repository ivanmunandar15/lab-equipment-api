# Laboratory Equipment Management API

## Menjalankan
```bash
cp .env.example .env          # lalu isi secret JWT (>= 32 karakter)
npm install
docker compose up -d postgres # pgAdmin opsional: docker compose --profile tools up -d
npm run dev                   # http://localhost:3000
```
- Health: `GET http://localhost:3000/api/v1/health`
- Swagger: `http://localhost:3000/api/docs`

## Perintah
`npm run dev | build | start | test | lint | format`

## Tahap
- [x] Tahap 1: Setup & fondasi
- [x] Tahap 2: Skema Prisma dan seed
- [x] Tahap 10: Dashboard, cron, Docker, README, tinjauan keamanan

## Database
```bash
npm run db:up                              # PostgreSQL via Docker
npm run db:migrate -- --name init          # migrasi pertama (juga generate client + menjalankan seed)
npm run db:seed                            # isi ulang dengan data nyata lab (data lama dihapus)
npm run db:reset                           # drop, migrate ulang, seed
npm run db:studio
```

### Akun seed (password awal semua akun: `Password123!`, atau nilai `SEED_PASSWORD`)
| Role | Nama | Email |
|---|---|---|
| admin | Administrator Lab | admin@lab.local |
| technician | Ivan Munandar Purnama | ivan.munandar@anindya.biz |
| technician | I Putu Ary Suyasa | ary.suyasa_act@anindya.biz |
| technician | Ralphy Christian Monintja | ralphy_act@anindya.biz |
| technician | Deni Arifani Nafis | deni.arifani_act@anindya.biz |
| SPV | Ach. Effendi | ach.effendi_act@anindya.biz |
| SPV | Muhamad Ridwan Maulana | m.ridwan_act@anindya.biz |

Tidak ada akun QA (tambahkan lewat menu Pengguna jika perlu).

### Data seed (`prisma/seed.ts`, parser di `prisma/seed-data.ts`, data di `prisma/data/*.csv`)
- 13 ruangan (8 laboratorium resmi + 5 yang dipakai CSV: Temperature Rise, Vibration, Audio, Durability, Temperature & Humidity),
  kapasitas = jumlah alat + ±15%, **tanpa penanggung jawab** (belum ada data pembagian).
- 689 alat utama dari `inventaris.csv`: `Bagian` → jenis, `Type` → model, `Datang` → `purchase_date`, jadwal kalibrasi berikutnya →
  `next_calibration_date`; serial, periode, LPK, kalibrasi terakhir, dan catatan masuk ke `specifications`. Harga dan masa manfaat `null`;
  kondisi `good` (tidak ada di CSV).
- 126 alat pendukung dari `supporting.csv` (1 pcs per baris; CSV tidak memuat jumlah/satuan; lokasi di `description`).
  Dua baris tanpa nama (11-46, 11-47) diberi nama placeholder "Tanpa nama (kode)".
- Tidak ada data transaksi tiruan (peminjaman, kalibrasi, maintenance, sensor, pembacaan, notifikasi, log): mulai kosong.
  Sensor dibuat lewat API/menu Sensor; kunci API sensor demo `sk_demo_*` sudah tidak ada.
- Seed **menghapus semua data**. Di `NODE_ENV=production` ditolak kecuali `SEED_FORCE=true` dan `SEED_PASSWORD` diisi.

- [x] Tahap 3: Auth dan Users
- [x] Tahap 4: Activity log otomatis
- [x] Tahap 5: Rooms dan Equipment (CRUD, QR, ekspor/impor, label PDF)

## Auth
- Access token JWT (15 menit) dikirim di body; kirim sebagai `Authorization: Bearer <token>`.
- Refresh token (7 hari) di cookie httpOnly `refresh_token` (path `/api/v1/auth`), hash-nya disimpan di tabel `refresh_tokens`, dirotasi tiap `/auth/refresh`. Pemakaian ulang token lama memicu pencabutan semua sesi user.
- Frontend: panggil API dengan `credentials: 'include'`; saat 401 `TOKEN_EXPIRED` panggil `/auth/refresh` lalu ulangi request.
- Matriks hak akses ada di `src/config/permissions.ts`.
- Tahap 3 menambah tabel baru, jalankan: `npm run db:migrate -- --name add_refresh_tokens` (atau `--name init` jika migrasi pertama belum dibuat).

## Activity log (Tahap 4)
Tahap ini menambah index `activity_logs(action)`; jalankan `npm run db:migrate -- --name add_activity_log_action_index` (atau `--name init` jika migrasi pertama belum dibuat). Seed kini memakai action UPPERCASE (`LOGIN`, `BORROW`, `RETURN`, ...) dan entity_type lowercase (`user`, `equipment`, ...).

**Endpoint** (admin, SPV, QA; read-only)
- `GET /api/v1/activity-logs` — filter `user_id, action, entity_type, entity_id, date_from, date_to` + `page, limit, sort(created_at|action|entity_type), order, search`. `date_to` berformat `YYYY-MM-DD` berlaku sampai akhir hari UTC. List tidak memuat old/new data.
- `GET /api/v1/activity-logs/:id` — detail lengkap + `diff` (`[{field, old, new}]`).

**Pencatatan manual / bisnis** (`src/modules/activity-logs/audit.service.ts`)
```ts
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';

await db.$transaction(async (tx) => {
  const b = await tx.borrowing.create({ ... });
  // ... ubah status equipment dst.
  await audit.log(
    { ...audit.actorFrom(req), action: AUDIT_ACTIONS.BORROW, entityType: AUDIT_ENTITIES.BORROWING, entityId: b.borrowing_id, newData: b },
    tx, // di dalam transaksi: ikut commit/rollback
  );
});
```
- Dengan `tx`: error menggagalkan transaksi. Tanpa `tx`: best-effort (error hanya di-log pino).
- Konstanta tersedia: `CREATE UPDATE DELETE LOGIN CHANGE_PASSWORD RESET_PASSWORD BORROW RETURN CALIBRATE MAINTENANCE_START MAINTENANCE_COMPLETE EXPORT`.
- Field yang namanya mengandung `password`, `token`, `secret`, `api_key`, `authorization`, `cookie` dibuang otomatis (semua level nested). Catatan: `qr_token` ikut terbuang (immutable, tidak berguna untuk diff).

**Middleware otomatis** (`src/middlewares/audit.ts`) — pasang setelah `validate`, sebelum controller:
```ts
router.post('/',    validate({ body }),             auditCreate(AUDIT_ENTITIES.ROOM), c.create);
router.patch('/:id', validate({ params, body }),    auditUpdate(AUDIT_ENTITIES.ROOM, (req) => service.getById(req.params.id)), c.update);
router.delete('/:id', validate({ params }),         auditDelete(AUDIT_ENTITIES.ROOM, (req) => service.getById(req.params.id)), c.remove);
router.get('/export', validate({ query }),          auditExport(AUDIT_ENTITIES.EQUIPMENT), c.exportCsv);
```
old_data = hasil `loadOld`, new_data = `data` respons sukses; hanya respons 2xx yang dicatat. `auditRoute({ entityType, action, loadOld, idField })` untuk aksi khusus. Route yang sudah terpasang: users (create/update/delete/reset-password), `PATCH /auth/me`, serta `LOGIN` dan `CHANGE_PASSWORD` di auth service.

## Rooms & Equipment (Tahap 5)
Dependensi baru: `multer qrcode pdfkit archiver csv-parse fast-csv` (+ `@types/*`). Jalankan `npm install`.

**Env baru**: `ROOM_CAPACITY_MODE=block|warn` (default `block`: tolak 409 `ROOM_CAPACITY_EXCEEDED`; `warn`: simpan dan kembalikan `data.warnings`), `CALIBRATION_DUE_SOON_DAYS=30`.
`equipment_capacity = 0` berarti tidak dibatasi. Kapasitas dihitung dari alat **aktif**, dicek di dalam transaksi dengan `SELECT ... FOR UPDATE` pada baris ruangan (aman dari race condition) saat: create alat, pindah ruangan, aktifkan kembali alat, impor commit, dan pengecilan kapasitas ruangan.

**Rooms** `/api/v1/rooms` (baca: semua role; tulis: admin/SPV): list/detail menyertakan `active_equipment_count`, `capacity {total, used, remaining, usage_percent, is_over_capacity}`, `latest_readings` (sensor aktif + nilai terakhir + `threshold_state`). DELETE = soft delete, ditolak 409 `ROOM_NOT_EMPTY` bila masih ada alat/sensor aktif.

**Equipment** `/api/v1/equipment`
- `GET /` filter `status, condition, room_id, equipment_type, calibration_state(safe|due_soon|overdue), is_active, search` + pagination/sort. Respons memuat `qr_url`, `calibration_state` (null jika tanpa jadwal kalibrasi), `remaining_useful_life_years` (min 0). `purchase_price` berupa string desimal; tanggal `YYYY-MM-DD`.
- `GET /:id` (+ruangan, `active_borrowing`, `documents_count`), `GET /:id/{borrowings,calibrations,maintenances,documents}`.
- `POST /`, `PATCH /:id`, `DELETE /:id`. `qr_token` otomatis, tidak pernah berubah, dan diabaikan jika ada di body. `inventory_code` hanya dapat diubah role di `PERMISSIONS.equipment.changeInventoryCode`. Status `borrowed` hanya diatur oleh proses peminjaman; alat borrowed tidak bisa dihapus/diubah statusnya (409 `EQUIPMENT_BORROWED`).
- `GET /:id/qr.png?size=300` (100–1000). Butuh header Authorization, jadi di frontend ambil dengan `fetch` lalu `URL.createObjectURL(blob)`.
- `GET /export.csv`, `GET /export.zip` (ikut filter list atau `?ids=a,b,c`; streaming), `GET /labels.pdf?ids=...&layout=a4-3x8|sticker-50x30`. Semuanya dicatat sebagai `EXPORT`.
- `GET /import-template.csv`, `POST /import` (multipart `file`, opsional `dry_run`, `all_or_nothing`; juga boleh lewat query string). **Default aman: `dry_run=true`, `all_or_nothing=true`.** Ruangan diacu dengan `room_code`. Nomor baris pada laporan error: header = baris 1. Maks 2 MB / 1000 baris. Commit divalidasi ulang di dalam transaksi, lalu dicatat sebagai satu log `IMPORT`.

Uji cepat impor:
```bash
curl -b cookies.txt -H "Authorization: Bearer $TOKEN" -F file=@equipment.csv "http://localhost:3000/api/v1/equipment/import"                       # dry run
curl -b cookies.txt -H "Authorization: Bearer $TOKEN" -F file=@equipment.csv -F dry_run=false "http://localhost:3000/api/v1/equipment/import"      # commit
```

## Supporting Equipment (Tahap 6)
Tidak ada dependensi/env baru dan **tidak ada perubahan skema Prisma** (tabel & index `status` sudah ada). Opsional, pengaman di level DB (Prisma belum mendukung CHECK di schema), buat migrasi kosong `npm run db:migrate -- --create-only --name supporting_qty_check` lalu isi:
```sql
ALTER TABLE supporting_equipment ADD CONSTRAINT supporting_qty_check
  CHECK (available_quantity >= 0 AND available_quantity <= total_quantity);
```

**Endpoint** `/api/v1/supporting-equipment` (baca: semua role; tulis: admin/SPV — ubah di `permissions.ts`)
- `GET /` filter `status(available|borrowed|damaged), condition, item_type, is_active, search` + pagination/sort. Respons memuat `borrowed_quantity` (= total − available) dan `qr_url` = `${APP_URL}/scan/sp/${qr_token}` (QR mewakili **jenis item**).
- `GET /:id` — plus `active_borrowings[]`: `{borrowing_id, user, quantity_borrowed, quantity_returned, quantity_outstanding, borrowing_time, expected_return_time, purpose, usage_location, is_overdue}`.
- `POST /` — `available_quantity = total_quantity`. `qr_token`, `available_quantity`, `status` pada body diabaikan.
- `PATCH /:id` — mengubah `total_quantity` menyesuaikan `available_quantity` dengan selisih (dalam transaksi, baris dikunci `FOR UPDATE`). Ditolak 409 `QUANTITY_BELOW_BORROWED` jika total baru < jumlah yang sedang dipinjam.
- `DELETE /:id` — soft delete; 409 `ITEM_BORROWED` jika masih ada yang dipinjam (juga berlaku untuk `is_active=false` via PATCH).
- `GET /:id/qr.png`, `/export.csv`, `/export.zip`, `/labels.pdf`, `/import-template.csv`, `POST /import` — sama dengan Equipment (impor memakai kolom `item_code,item_name,item_type,brand,model,unit,total_quantity,condition,description,specifications`, tanpa ruangan).

**Status diturunkan** (`supporting-equipment.derive.ts`): `condition=major_damage` → `damaged`; `available_quantity=0` → `borrowed`; selain itu `available`. Modul peminjaman nanti WAJIB memanggil `deriveSupportingStatus()` + `assertQuantities()` saat mengubah `available_quantity`.

**Perubahan di kode Tahap 5**: logika streaming CSV/ZIP/PDF dipindah ke `src/utils/export-stream.ts` (dipakai bersama; perilaku equipment tidak berubah). Bug diperbaiki: tanggal berformat salah (mis. `31-01-2024`) pada body/impor equipment sebelumnya menyebabkan 500, kini 422.

## Peminjaman, Scan, Pengembalian (Tahap 7)
Tidak ada dependensi baru dan **tidak ada perubahan skema**. Env baru: `CALIBRATION_OVERDUE_POLICY=warn|block` (default `block`, sama dengan frontend).

**Keputusan yang dipilih (ubah bila perlu)**
- Kalibrasi terlambat: **diblokir** secara default (409 `CALIBRATION_OVERDUE`; scan tidak menawarkan `borrow`). Set `CALIBRATION_OVERDUE_POLICY=warn` untuk hanya memberi peringatan (`warnings: ["calibration_overdue"]` di scan dan `warnings[]` di respons pinjam).
- Yang boleh mengembalikan: **peminjam sendiri + role di `PERMISSIONS.borrowings.returnAny`** (default admin, SPV) — ubah di `src/config/permissions.ts` (isi `ALL` untuk membebaskan).

**Scan** `GET /api/v1/scan/eq/:qrToken`, `GET /api/v1/scan/sp/:qrToken` (login; `Cache-Control: no-store`). Data = detail alat/barang + `available_actions` (`borrow|return|report_damage`, dihitung server per user), `reason`, `warnings`, `active_borrowing` / `active_borrowings` (peminjam, waktu pinjam, batas kembali, `is_overdue`, `can_return`, `detail_id`). 404 token tak dikenal; 410 "Alat sudah dinonaktifkan".

**Pinjam** `POST /borrowings` — item `{equipment_id | qr_token}` dan `{supporting_equipment_id | qr_token, quantity}`. Satu transaksi: kunci baris (`SELECT … FOR UPDATE`, urut id) → baca ulang → validasi semua item → ubah status/stok dengan compare-and-set (`WHERE status='available'`, `WHERE available_quantity = <nilai terbaca>`) → buat borrowing + detail (initial_condition = kondisi saat ini) → activity log `BORROW`. Ada item bermasalah → 409 `BORROWING_CONFLICT` dengan `details.items[]` (`reason`: `NOT_FOUND|INACTIVE|NOT_AVAILABLE|CALIBRATION_OVERDUE|DAMAGED|INSUFFICIENT_STOCK`) dan tidak ada yang tersimpan. Item duplikat → 422.

**Kembali** `POST /borrowings/:id/return` — `items[{detail_id, final_condition, has_damage, damage_notes}]`, `supporting[{supporting_detail_id, quantity_returned, final_condition?, has_damage?, damage_notes?}]`; sebagian didukung (`quantity_returned` = jumlah pada panggilan ini). Alat dianggap sudah kembali bila `final_condition` terisi. `has_damage` atau `major_damage` → alat `damaged` (selain itu `available`, kondisi diperbarui); stok bertambah sebesar `quantity_returned`; `actual_return_time` + `borrowing_status=returned` terisi saat SEMUA item selesai; ada kerusakan → notifikasi (tipe `maintenance`) ke SPV & technician aktif; activity log `RETURN`. Semua-atau-tidak: satu item invalid → 409 `RETURN_CONFLICT`, tidak ada yang diproses. Kerusakan barang pendukung hanya dicatat pada detail + notifikasi; `condition` jenis item tidak diubah.

**Lapor rusak** `POST /equipment/:id/report-damage` `{notes, condition?}` (semua role). Hanya untuk status available/maintenance/calibration (alat yang sedang dipinjam dilaporkan lewat pengembalian → 409). Catatan disimpan di activity log (`REPORT_DAMAGE`) dan notifikasi (tabel equipment tidak punya kolom catatan).

**List** `GET /borrowings` filter `status(active|overdue|returned), user_id, equipment_id, date_from, date_to, search`; `GET /borrowings/my`; `GET /borrowings/:id` (+`can_return`).

**Test konkurensi** (`tests/borrowings.test.ts`): fake DB melepas event loop pada lock dan `updateMany` sehingga transaksi paralel benar-benar berbalapan; test GAGAL bila pengaman atomik dimatikan. Kunci `FOR UPDATE` asli hanya teruji pada PostgreSQL sungguhan — jalankan sekali di staging: dua `curl` paralel ke alat yang sama harus menghasilkan satu 201 dan satu 409.

## Kalibrasi & Maintenance (Tahap 8)
**Migrasi wajib** (1 kolom + 1 index baru di `maintenances`): `npm run db:migrate -- --name add_maintenance_prev_equipment_status`. Kolom `prev_equipment_status` diisi server saat maintenance → `in_progress` agar pembatalan mengembalikan status alat yang benar (mis. alat `damaged` yang diperbaiki lalu dibatalkan tetap `damaged`). Env baru: `CERTIFICATE_MAX_MB=5`. Tanpa dependensi baru.

**Calibrations** `/api/v1/calibrations` (baca: semua role; tulis: admin/SPV/technician — `permissions.ts`)
- `GET /` filter `equipment_id, result, state, date_from, date_to` + `search` (nomor sertifikat/penyedia), `sort`. `state` = status jadwal kalibrasi alat **saat ini** (sama dengan summary/schedule), bukan status entri riwayat.
- `GET /schedule?month=YYYY-MM[&room_id]` — alat aktif jatuh tempo bulan itu, dikelompokkan per tanggal (`days[{date, items[]}]`, tiap item ada `calibration_state` dan `days_until_due`). `GET /summary[?room_id]` — `{safe, due_soon, overdue, no_schedule}`.
- `POST /` (multipart; sertifikat opsional di field `certificate`): PDF/JPEG/PNG/WebP, maks `CERTIFICATE_MAX_MB`; header MIME **dan** isi file (magic bytes) diverifikasi, nama file dibuat server (UUID), disimpan di `${UPLOAD_DIR}/certificates/`. Satu transaksi dengan lock baris alat: `passed` → `next_calibration_date` alat diperbarui + status `calibration`→`available`; `failed` → status alat `status_after_fail` (`calibration` default | `damaged`; 409 bila alat borrowed/maintenance). `technician_id` dari token. Tanggal tidak boleh di masa depan; `next_calibration_date` harus setelah `calibration_date`. Entri bertanggal lebih lama dari kalibrasi terbaru hanya masuk riwayat (`applied_to_equipment:false`) supaya jadwal tidak mundur. File dihapus bila transaksi gagal. Log `CALIBRATE`.
- `GET /:id`, `GET /:id/certificate` (login + hak baca; butuh header Authorization → ambil via `fetch` lalu blob; lokasi file internal tidak pernah dikirim ke client). Kalibrasi tidak punya update/delete (riwayat tidak boleh diubah).
- `POST /equipment/:id/start-calibration` → status `calibration`. Ditolak 409 bila borrowed, maintenance (tambahan dari saya agar status tidak tertimpa), sudah calibration, atau nonaktif. Log `START_CALIBRATION`.

**Maintenances** `/api/v1/maintenances` (QA hanya GET)
- CRUD + filter `maintenance_type, status, equipment_id, technician_id, date_from, date_to, search`. Dibuat selalu `scheduled`; `technician_id` default user login. `equipment_id` tidak bisa diubah.
- Status lewat `PATCH {status}`: `scheduled→in_progress→completed`, `cancelled` dari scheduled/in_progress; selain itu 422 `INVALID_TRANSITION` (+`details.allowed`). `completed`/`cancelled` final: edit apa pun → 409 `MAINTENANCE_LOCKED`.
  - `in_progress`: alat → `maintenance` (dari `available`/`damaged`); 409 bila borrowed / calibration / sudah ada maintenance lain / nonaktif.
  - `completed`: `completion_date` (default sekarang), alat → `available`, atau `damaged` bila `equipment_damaged:true`. Alat yang statusnya sudah diubah manual (bukan `maintenance`) tidak ditimpa.
  - `cancelled`: dari `in_progress` alat dikembalikan ke status sebelumnya; dari `scheduled` alat tidak disentuh.
- `DELETE /:id` (admin/SPV): hanya status `scheduled` (hapus permanen, tercatat); selain itu gunakan `cancelled` (409 `MAINTENANCE_NOT_DELETABLE`).
- Log: `CREATE, UPDATE, MAINTENANCE_START, MAINTENANCE_COMPLETE, MAINTENANCE_CANCEL, DELETE`; respons PATCH memuat `equipment_status_after` bila status alat berubah.

## Sensor, Monitoring, Dokumen, Notifikasi (Tahap 9)
**Instal dependensi baru**: `npm install` (menambah `node-cron` + `@types/node-cron`). **Tidak ada perubahan skema Prisma / migrasi** (model Sensor, RoomMonitoring, Document, Notification sudah ada). Env baru (semua opsional): `MONITORING_RETENTION_DAYS=90`, `MONITORING_ALERT_COOLDOWN_MINUTES=30`, `DOCUMENT_MAX_MB=10`, `JOBS_ENABLED=true`.

**Sensors** `/api/v1/sensors` (admin/SPV — `PERMISSIONS.sensors`; sebelumnya baca = semua role, sekarang admin/SPV sesuai spesifikasi)
- CRUD + filter `room_id, sensor_type, sensor_status, is_active, search`. `min_threshold < max_threshold` (422). `sensor_code` unik (409), hanya `[A-Za-z0-9._-]`. `DELETE` = soft delete.
- `POST /` boleh `generate_api_key:true` → respons memuat `api_key` **sekali saja**. `POST /:id/api-key` membuat/memutar ulang key (key lama langsung mati). `DELETE /:id/api-key` mencabut. Disimpan hanya SHA-256-nya; respons sensor hanya `has_api_key`. Plaintext tidak masuk activity log (`ROTATE_API_KEY`, `REVOKE_API_KEY`).

**Monitoring** `/api/v1/monitoring`
- `POST /readings` — header `X-Sensor-Key` (bukan JWT; rate limit 120/menit per key). Body: objek tunggal, array, atau `{readings:[...]}` (maks 500): `{sensor_code?, value, measurement_time?}`. **Satu key = satu sensor**: `sensor_code` (jika diisi) harus milik key, jika tidak → 403 dan tidak ada yang disimpan. Sensor harus `active` (409 `SENSOR_NOT_ACTIVE`). `measurement_time` tidak boleh >5 menit di masa depan atau lebih lama dari retensi. `received_at` = waktu server. Nilai di luar min/max → notifikasi tipe `monitoring` ke `PERMISSIONS.monitoring.alertRecipients` (admin/SPV/technician) + PIC ruangan, maks sekali per `MONITORING_ALERT_COOLDOWN_MINUTES` per sensor (cache in-memory + cek tabel notifikasi, tahan restart). Respons: `{accepted, out_of_range, alert_sent}`.
- `GET /sensors/:id/readings?from&to&interval=raw|5m|1h|1d` (default 24 jam terakhir, `5m`). Agregat `{time, avg, min, max, count}` (bucket UTC); maks 1000 titik → 422 dengan `suggested_interval`. `raw`: 1000 titik terbaru + `truncated`. Rentang maks 366 hari.
- `GET /rooms/:id/latest` (per sensor: `value, threshold_state, out_of_range, is_stale`), `GET /summary` (jumlah sensor per status, out_of_range, stale, no_data, ringkasan per ruangan).
- `GET /stream?room_id&sensor_id` (SSE: `ready`, `reading`, `reconnect`; heartbeat 25 dtk; maks 5 koneksi/user; server menutup tiap ±14 menit agar klien reconnect dengan token baru). Karena butuh header Authorization, gunakan `fetch` streaming (mis. `@microsoft/fetch-event-source`), bukan `EventSource`. Bus in-process → untuk multi-instance perlu Redis pub/sub.
- **Retensi** (`src/jobs`): node-cron 02:30 UTC menghapus `room_monitoring` lebih tua dari `MONITORING_RETENTION_DAYS` per batch 10.000. Data **dihapus, tidak diringkas** (peringkasan butuh tabel rollup baru = perubahan skema; minta jika dibutuhkan). Nonaktifkan di instance tambahan dengan `JOBS_ENABLED=false`.

**Documents** `/api/v1/documents` (baca: semua role; unggah: admin/SPV/technician; hapus: admin/SPV atau pengunggah — `PERMISSIONS.documents`)
- `POST` multipart: `file`, `equipment_id`, `document_type`. Tipe: PDF/JPEG/PNG/WebP/DOCX/XLSX, maks `DOCUMENT_MAX_MB`; header MIME **dan** magic bytes dicek; `photo` harus gambar. File disimpan sebagai `${UPLOAD_DIR}/documents/<uuid><ext>`; nama asli hanya metadata (dibersihkan), `file_url` internal tidak dikirim ke client.
- `GET /` filter `equipment_id, document_type, uploaded_by, search`; `GET /:id`; `GET /:id/download[?inline=true]` (`attachment` default; inline hanya PDF/gambar; `nosniff` + CSP sandbox); `DELETE /:id` (hapus baris + file, tercatat di activity log).

**Notifications** `/api/v1/notifications` (semua role, hanya milik sendiri): `GET /` (`is_read`, `type`, `search`), `GET /unread-count` (`count` + `by_type`), `PATCH /:id/read`, `PATCH /read-all` (opsional body `{type}`). Service `createNotification(tx, {userIds?, roles?, type, title, message, borrowing_id?, calibration_id?, maintenance_id?})` di `notifications/notify.service.ts`; `notifyRoles` lama tetap bekerja.

**Uji cepat**
```bash
npm run db:seed && npm run dev
# buat sensor + key (pakai token admin/SPV)
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"room_id":"<ROOM_ID>","sensor_code":"TEMP-01","sensor_type":"temperature","min_threshold":18,"max_threshold":26,"generate_api_key":true}' \
  http://localhost:3000/api/v1/sensors
# kirim data dari perangkat
curl -H "X-Sensor-Key: lsk_..." -H 'Content-Type: application/json' \
  -d '[{"value":22.4},{"value":31.0}]' http://localhost:3000/api/v1/monitoring/readings
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/monitoring/sensors/<SENSOR_ID>/readings?interval=5m"
curl -H "Authorization: Bearer $TOKEN" -F file=@manual.pdf -F equipment_id=<EQ_ID> -F document_type=manual http://localhost:3000/api/v1/documents
npm test
```
Catatan jujur: kode ditulis tanpa `npm install` di lingkungan ini, jadi `tsc`/`vitest` belum dijalankan di sini; query agregasi SQL mentah dan `DELETE … LIMIT` hanya bisa diuji di PostgreSQL sungguhan (jalankan satu kali di dev). Tes tahap ini mencakup logika murni (threshold, bucket, skema, key, validasi file), bukan HTTP end-to-end.

## Dashboard & Cron (Tahap 10)
**Endpoint** (`/api/v1/dashboard`, semua role login; cache 30 detik per instance, `DASHBOARD_CACHE_SECONDS=0` untuk mematikan)
- `GET /stats` — total alat aktif, jumlah per status, peminjaman aktif & terlambat, biaya maintenance + kalibrasi bulan ini.
- `GET /charts` — distribusi status, tren peminjaman 12 bulan, biaya maintenance & kalibrasi per bulan.
- `GET /alerts?limit=20` — kalibrasi jatuh tempo ≤30 hari/terlambat, peminjaman terlambat, sensor di luar batas (pembacaan terbaru ≤24 jam), stok rendah (`available_quantity <= LOW_STOCK_THRESHOLD`). `total` selalu penuh; `items` dibatasi `limit`.
- `GET /recent-activity` — 10 log terakhir (admin, SPV, QA; sama dengan hak activity log).

**Cron** (zona waktu `JOBS_TIMEZONE`, default `Asia/Jakarta`; semua mati bila `JOBS_ENABLED=false`)
| Job | Jadwal | Isi |
|---|---|---|
| calibration-reminders | harian 07:00 | H-30, H-7, terlambat → admin/SPV/technician; 1 notifikasi per alat per tahap per jadwal kalibrasi |
| borrowing-overdue | tiap jam | peminjam + SPV; maks 1x per hari per peminjaman |
| low-stock | harian 07:15 | admin + SPV; 1 per item per hari |
| weekly-cleanup | Minggu 03:00 | hapus refresh token kedaluwarsa + retensi monitoring |

Anti-duplikat memakai kolom baru `notifications.dedupe_key` (+ index) → **butuh migrasi**: `npm run db:migrate -- --name add_notification_dedupe_key` (atau `--name init` bila migrasi pertama belum dibuat). Jalankan job hanya di satu instance.

## Deploy (Docker)
```bash
# sekali, di lokal: buat & commit migrasi
npm run db:migrate -- --name init        # hasilnya prisma/migrations/ (WAJIB ada di image)
docker build -t lab-equipment-api .
docker run --env-file .env -p 3000:3000 -v uploads:/data/uploads lab-equipment-api
# atau: docker compose --profile app up -d --build
```
Container menjalankan `prisma migrate deploy` saat start (`scripts/migrate-deploy.sh`; lewati dengan `RUN_MIGRATIONS=false`), lalu `node dist/server.js`. Seed demo tidak dijalankan otomatis di produksi.

## Daftar env
| Env | Default | Keterangan |
|---|---|---|
| NODE_ENV, PORT | development, 3000 | |
| DATABASE_URL | — | wajib |
| JWT_ACCESS_SECRET, JWT_REFRESH_SECRET | — | wajib, ≥32 karakter |
| JWT_ACCESS_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN | 15m / 7d | |
| COOKIE_SAME_SITE | lax | `none` hanya bila frontend beda site (cookie otomatis secure) |
| CORS_ORIGIN | — | wajib; pisahkan koma |
| APP_URL | — | base URL frontend untuk isi QR |
| UPLOAD_DIR | ./uploads | `/data/uploads` di Docker |
| CERTIFICATE_MAX_MB, DOCUMENT_MAX_MB | 5, 10 | |
| ROOM_CAPACITY_MODE | block | block / warn |
| CALIBRATION_DUE_SOON_DAYS, CALIBRATION_OVERDUE_POLICY | 30, block | |
| MONITORING_RETENTION_DAYS, MONITORING_ALERT_COOLDOWN_MINUTES | 90, 30 | |
| LOW_STOCK_THRESHOLD | 2 | |
| DASHBOARD_CACHE_SECONDS | 30 | 0 = off |
| JOBS_ENABLED, JOBS_TIMEZONE | true, Asia/Jakarta | |
| LOG_LEVEL | info | |
| RUN_MIGRATIONS | true | khusus Docker |

## Akun seed (`npm run db:seed`)
Lihat tabel "Akun seed" di bagian Database (password awal `Password123!` atau `SEED_PASSWORD`).

## Endpoint ringkas (`/api/v1`; detail & contoh di `/api/docs`)
`auth` (login, refresh, logout, me) · `users` (admin) · `rooms` · `equipment` (+qr.png, labels.pdf, export/import, report-damage, start-calibration) · `supporting-equipment` · `scan/eq|sp/:qrToken` · `borrowings` (+`/my`, `/:id/return`) · `calibrations` · `maintenances` · `sensors` · `monitoring` (readings IoT, summary, stream SSE) · `documents` · `notifications` · `activity-logs` · `dashboard` · `health`.

## Menghubungkan ke frontend Next.js
`.env` frontend: `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`. `.env` API: `CORS_ORIGIN=http://localhost:3001` (origin persis, tanpa slash akhir) dan `APP_URL` sama dengan URL frontend.
- Semua `fetch`/axios memakai `credentials: 'include'` (cookie refresh httpOnly, path `/api/v1/auth`). Access token disimpan di memori, dikirim `Authorization: Bearer`.
- Saat 401 `TOKEN_EXPIRED` → `POST /auth/refresh` lalu ulangi request sekali.
- Domain sama (mis. `app.lab.com` + `api.lab.com`): `COOKIE_SAME_SITE=lax`. Beda site: `none` + HTTPS wajib. Di belakang reverse proxy, `trust proxy` sudah aktif saat production.
- Unduhan/QR berautentikasi: ambil via fetch + header Bearer lalu `URL.createObjectURL` (tag `<img src>` tidak mengirim header).

## Tinjauan keamanan (Tahap 10)
Diverifikasi otomatis di `tests/security-openapi.test.ts`:
- **Query mentah**: hanya `$queryRaw`/`$executeRaw` bertag template atau `Prisma.sql` (semua nilai terparameter); `*Unsafe` dan `Prisma.raw` dilarang oleh test.
- **Validasi input**: body/query/params lewat Zod `validate`; env divalidasi saat startup.
- **Hak akses**: test menyapu SEMUA route tanpa token (harus 401, kecuali login/refresh/logout/health; ingest IoT memakai `X-Sensor-Key`), plus matriks 403/izin per role.
- **Upload**: memori + batas ukuran + whitelist MIME + cek magic bytes; nama file acak dari server (nama asli hanya tampilan); `resolveStoragePath` menolak path di luar `UPLOAD_DIR`; folder upload tidak disajikan statis (hanya lewat endpoint ber-auth; non-gambar/PDF selalu `attachment`).
- Lainnya: helmet, CORS whitelist, rate limit ketat di `/auth`, hpp, bcrypt, rotasi refresh token + deteksi pemakaian ulang, `password_hash`/token dibuang dari log audit, stack trace tidak bocor di production.

## Menjalankan test
`npm test` (fake DB in-memory, tanpa PostgreSQL). Test baru: `main-flow`, `dashboard-jobs`, `security-openapi`.

## Tahap 11 — Pengingat kalibrasi lewat email

- Setelah `npm install` (menambah `nodemailer`) jalankan `npx prisma migrate dev --name email_reminders` lalu `npm test`.
- Dev: `EMAIL_ENABLED=false` (default) → email tidak dikirim, isinya dicatat ke log dan EMAIL_LOG (status `sent`, provider id `dev-log`).
  Untuk melihat email nyata: `docker compose --profile tools up -d mailhog`, set `EMAIL_ENABLED=true`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`, UI di http://localhost:8025.
- Penerima diatur di `src/config/email-recipients.ts`. Antrean: dalam memori (retry 1m, 5m, 30m); email `queued` dipulihkan saat startup.
- Endpoint: `PATCH /me/email-preferences`, `GET /email-logs`, `POST /email-logs/:id/retry`, `POST /admin/email/test`, `POST /admin/jobs/calibration-reminders/run?dry_run=true`.

## Perbaikan kesesuaian dengan frontend

- **Token QR**: `generateQrToken()` kini memakai alfabet `[A-Za-z0-9]` (sama dengan `QR_ALPHABET` frontend). Sebelumnya `nanoid()` bawaan bisa menghasilkan `_`/`-` sehingga sekitar 32% QR ditolak parser frontend. Token lama yang tidak valid dibuat ulang dengan `npm run db:fix-qr` (tambahkan `-- --dry-run` untuk melihat jumlahnya dulu; label QR item terkait harus dicetak ulang).
- **Kalibrasi terlambat**: default `CALIBRATION_OVERDUE_POLICY` sekarang `block`, sama dengan `CALIBRATION_OVERDUE_BLOCKS_BORROWING = true` di frontend.
- **Nominal uang**: `purchase_price` (alat) dan `cost` (kalibrasi, maintenance) dikirim sebagai `number`, bukan string, sesuai tipe `types/erd.ts` frontend.

## Compat API untuk frontend (`/api/v1/compat`)
Lapisan kontrak yang meniru service mock frontend (bentuk data, error `ServiceError`, daftar tanpa paginasi). API utama tidak berubah.
Dokumentasi lengkap, daftar endpoint, perbedaan yang disengaja, dan panduan Next.js (BFF) ada di [`COMPAT_API.md`](./COMPAT_API.md).
Kode: `src/modules/compat/`, tes: `tests/compat.test.ts`. Perubahan di luar modul itu: `app.ts` (mount + batas JSON 16 MB khusus upload data-URL),
`auth.controller.ts` (header `X-Client: bff`), `borrowings.service.ts` (opsi `damageStatus`, default perilaku lama).
