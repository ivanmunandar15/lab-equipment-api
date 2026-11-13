# Compat API — kontrak backend yang meniru mock frontend

Prefix: `/api/v1/compat`. Dibuat agar `lib/services/*` frontend cukup diganti menjadi pemanggil `fetch` satu baris.
API utama (`/api/v1/*`, Swagger, 191 tes lama) **tidak diubah**; compat memakai ulang service-nya, sehingga aturan bisnis,
transaksi, dan penguncian baris tetap satu sumber.

## Kontrak umum
| Hal | Perilaku |
|---|---|
| Auth | `Authorization: Bearer <access_token>` (login lewat `/api/v1/auth/login`) |
| Sukses | data mentah (array/objek), tanpa amplop `{success,data}`. Hapus = `204` (rooms, documents). Angka/boolean mentah untuk `unread-count`, `read-all`, `generate`, `code-taken` |
| Gagal | `{ "error": { "code", "message", "fieldErrors?", "reason?", "details?" } }`, `code` ∈ `NOT_FOUND`(404) `VALIDATION`(422/400) `CONFLICT`(409) `FORBIDDEN`(403) `UNAUTHORIZED`(401) `INTERNAL`(500) = `ServiceError.code` frontend. `fieldErrors` = `{"equipment.0.damage_notes": "..."}` siap untuk `setError`. `reason` = kode backend asli (mis. `BORROWING_CONFLICT`) |
| Daftar | tanpa paginasi (maks 5000), filter/urut sama dengan service mock; ID bukan UUID → 404 |
| Bentuk data | persis `types/erd.ts`: snake_case, tanggal ISO, kolom `@db.Date` = `yyyy-MM-dd`, Decimal → number, `null` string → `""` |

## Endpoint (baca = semua role login kecuali dicatat)
| Mock service | Endpoint |
|---|---|
| usersService.list/getById/create/update/softDelete/restore | `GET /users?search&role&includeInactive` · `GET /users/:id` · `POST /users`† · `PATCH /users/:id`† · `DELETE /users/:id`† · `POST /users/:id/restore`† (†admin). Non-admin menerima `email: ""` |
| roomsService | `GET /rooms?search` · `GET/POST/PATCH/DELETE /rooms[/:id]` (tulis admin/SPV) |
| equipmentService | `GET /equipment?search&status=a,b&condition&room_id&calibration_state&includeInactive` · `GET /equipment/:id` · `/by-qr/:token` · `/by-code/:code` · `/code-taken?code&exceptId` · `POST /equipment` · `POST /equipment/bulk` (atomik) · `PATCH /equipment/:id` · `DELETE /equipment/:id` (soft) · `POST /equipment/:id/restore` (tulis admin/SPV) |
| supportingEquipmentService | idem di `/supporting-equipment` (`getByItemCode` = `/by-code/:code`) |
| borrowingsService | `GET /borrowings?search&status=borrowed\|returned\|overdue&user_id&equipment_id&supporting_equipment_id` · `GET /:id` · `POST /` · `PATCH /:id` · `POST /:id/return` |
| calibrationsService | `GET /calibrations?search&equipment_id&technician_id&result` · `GET /:id` · `GET /latest-passed?equipment_id` (objek/`null`) · `POST /` (JSON; sertifikat = data URL di `certificate_file_url`; `failed_status`) · `GET /:id/certificate` (stream) |
| maintenanceService | `GET /maintenance?search&equipment_id&technician_id&status&type` · `GET /:id` · `POST /` · `PATCH /:id` |
| sensorsService | `GET /sensors?room_id&type&status` · `GET/POST/PATCH/DELETE /sensors[/:id]` (tulis admin/SPV; DELETE = `sensor_status:"inactive"`) |
| monitoringService | `GET /readings?sensor_id&room_id&from&to&limit` · `GET /readings/latest?room_id` · `GET /readings/:id` · `POST /readings` (admin/SPV) |
| documentsService | `GET /documents?search&equipment_id&type` · `GET /:id` · `POST /` (JSON data URL **atau** multipart) · `GET /:id/file[?inline=true]` · `DELETE /:id` |
| notificationsService | `GET /notifications?type&unreadOnly` · `GET /unread-count` · `GET /:id` · `POST /:id/read` · `POST /read-all` · `POST /` (admin) |
| notificationGenerator.run | `POST /notifications/generate {kinds}` (admin/SPV) → jumlah baru; 1 notifikasi per entitas per hari |
| reportsService.reportEquipmentIssue | `POST /reports/equipment-issue {equipment_id, description}` → `{notified}` |
| activityLogsService | `GET /activity-logs?search&user_id&entity_type&entity_id&action&from&to` · `GET /:id` (admin/SPV/QA); `action` memakai kosakata frontend |
| dashboard-service | `GET /dashboard/equipment-status` · `/calibration-alerts` · `/active-borrowings` · `/monthly-trends?months=6` · `/room-conditions` · `/recent-activity?limit=10` |

`file_url` dokumen dan `certificate_file_url` kalibrasi berisi **path API** (`/api/v1/compat/documents/:id/file`, `/calibrations/:id/certificate`)
yang butuh Bearer; di Next.js buka lewat route proxy sisi server (lihat bawah) agar `<img>`/`<iframe>`/unduhan memakai cookie sesi.

## Perbedaan yang disengaja dari mock (aturan backend lebih ketat / berbeda)
1. **Peminjam = pengguna login.** `user_id` pada POST borrowings harus sama dengan pengguna login (403 bila beda); `borrowing_time` diabaikan (waktu server).
2. **Kapasitas ruangan** diberlakukan (409 `ROOM_CAPACITY_EXCEEDED`; ubah `ROOM_CAPACITY_MODE=warn` untuk hanya peringatan). `equipment_capacity=0` = tak terbatas.
3. **Tanggal kalibrasi tidak boleh di masa depan**; hasil `failed` ditolak bila alat dipinjam/maintenance. Teknisi = pengguna login (`technician_id` diabaikan).
4. **Kalibrasi tidak punya update** (riwayat tak boleh diubah; `useUpdateCalibration` tidak dipakai UI saat ini).
5. **Maintenance**: status mengikuti state machine backend; `scheduled→completed` dijalankan sebagai dua langkah. Bila langkah ke-2 gagal (mis. alat sedang dipinjam) data tersimpan di status terakhir yang berhasil dan error dikembalikan. `equipment_id` tidak dapat diubah.
6. **Pengembalian**: kebijakan `major_only` seperti mock (hanya rusak berat + ditandai rusak → `damaged`; rusak ringan → `available`, kondisi `minor_damage`). API utama tetap `any` (default).
7. **Password pengguna baru** wajib huruf+angka (8–72), lebih ketat dari mock (min. 8).
8. **Kode inventaris/item**: diawali huruf/angka; boleh berisi huruf, angka, `. _ - /` dan spasi tunggal di tengah (mis. `INV L-ACT 10-01`); tanpa spasi ganda/ujung. Aturan sama dengan API utama (`CODE_REGEX`).
9. **Sensor/monitoring**: tidak ada `simulateTick` — ganti `useLiveSimulation` dengan refetch berkala (`refetchInterval`). Perangkat IoT tetap `POST /api/v1/monitoring/readings` + `X-Sensor-Key`. Sensor tidak menerima API key lewat compat (kelola di API utama).
10. **Notifikasi** hanya milik pengguna login (`user_id` lain → 403). `recent-activity` untuk role tanpa hak log = `[]` (bukan 403).
11. **Lapor masalah** hanya mengirim notifikasi (status alat tidak berubah), sama dengan mock; untuk menandai rusak pakai `POST /api/v1/equipment/:id/report-damage`.
13. **Penanggung jawab ruangan opsional**: `person_in_charge` `""`/tidak dikirim = tanpa penanggung jawab (disimpan `null`, dikembalikan `""`); nilai terisi harus UUID user (selain itu 422 `fieldErrors.person_in_charge`). PATCH `""` mengosongkan.
12. **Field opsional alat**: `condition`, `purchase_date`, `purchase_price`, `useful_life_years`, `specifications`, `next_calibration_date` boleh `null` (tidak diketahui / tidak berlaku, mis. alat yang tidak perlu kalibrasi) pada POST, PATCH, dan `/equipment/bulk`; boleh juga tidak dikirim (`condition` tidak dikirim = `good`, lainnya = `null`). Respons mengembalikan `null` apa adanya, **tidak ada lagi nilai pengganti** (dulu: `purchase_date` = tanggal dibuat, `useful_life_years` = 0, `purchase_price` = 0, `specifications` = `""`). `specifications: ""` disimpan sebagai `null`. Nilai yang terisi tetap divalidasi (harga >= 0, masa manfaat bilangan bulat >= 1).

## Auth untuk Next.js (BFF)
`POST /auth/login` dengan header `X-Client: bff` juga mengembalikan `refresh_token` di body; `POST /auth/refresh` dengan header yang sama menerima
`{refresh_token}` di body (browser biasa tetap hanya memakai cookie httpOnly). Pola yang disarankan:

1. `auth.ts` → `authorize()` memanggil `POST {API}/auth/login` (`X-Client: bff`), mengembalikan `{id: user.user_id, name, email, role, accessToken, refreshToken, accessExpires}`; callback `jwt` menyimpannya di JWT NextAuth (terenkripsi, tak terbaca browser) dan memanggil `/auth/refresh` saat `accessExpires` hampir lewat.
2. Route handler `app/api/proxy/[...path]/route.ts` (GET/POST/PATCH/DELETE): `const s = await auth()`; teruskan ke `${API}/compat/${path}${search}` dengan `Authorization: Bearer ${s.accessToken}` (body & `Content-Type` diteruskan apa adanya, respons di-stream).
3. `lib/api/client.ts`: `api<T>(path, init)` → `fetch('/api/proxy/'+path)`; jika `!res.ok` lempar `ServiceError(error.code, error.message, error.fieldErrors)`; `204` → `undefined`.
4. Setiap `lib/services/*.ts` menjadi satu baris per method, mis. `list: (p) => api<Equipment[]>('equipment?'+qs(p))`. `ServiceError`, hook, dan komponen tidak perlu diubah.
5. `resolveDocumentUrl`/`downloadCertificate`: bila `file_url` diawali `/api/v1/compat/`, ganti prefix menjadi `/api/proxy/` + sisanya.
6. Hapus `setServiceActor`/`getServiceActor` (aktor berasal dari token).
