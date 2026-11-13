# Laboratory Equipment Management API

Backend REST API untuk aplikasi **Laboratory Equipment Management**. Dibangun menggunakan Express.js, TypeScript, Prisma ORM, dan PostgreSQL.

## Teknologi

- Node.js 20+
- Express.js 4
- TypeScript
- Prisma ORM 5
- PostgreSQL 16
- JWT access token dan refresh token berbasis cookie httpOnly
- Swagger UI untuk dokumentasi API
- Vitest dan Supertest untuk pengujian

## Persyaratan

Pastikan perangkat sudah memiliki:

- Node.js versi 20 atau lebih baru
- npm
- Docker Engine/Desktop dan Docker Compose
- Git

## Struktur proyek

```text
lab-equipment-api/
├── prisma/
│   ├── data/                 # Data CSV untuk proses seed
│   ├── schema.prisma         # Skema database
│   ├── seed.ts
│   └── migrations/           # Migrasi Prisma (harus disimpan di Git)
├── scripts/
├── src/
│   ├── config/
│   ├── middlewares/
│   ├── modules/              # Modul fitur API
│   └── server.ts
├── tests/
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

## Instalasi dan menjalankan untuk development

### 1. Clone repository

```bash
git clone <URL_REPOSITORY_BACKEND>
cd lab-equipment-api
```

### 2. Install dependency

```bash
npm install
```

### 3. Siapkan environment

Salin file contoh:

```bash
cp .env.example .env
```

Di Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Sesuaikan nilai penting berikut di `.env`:

| Variabel | Keterangan |
|---|---|
| `NODE_ENV` | Gunakan `development` untuk pengembangan |
| `PORT` | Port API, default `3000` |
| `DATABASE_URL` | URL koneksi PostgreSQL |
| `JWT_ACCESS_SECRET` | Secret acak untuk access token |
| `JWT_REFRESH_SECRET` | Secret acak yang berbeda untuk refresh token |
| `CORS_ORIGIN` | Origin frontend, default `http://localhost:3001` |
| `APP_URL` | URL frontend yang digunakan untuk membentuk QR |
| `FRONTEND_URL` | URL frontend untuk tautan/notifikasi |
| `UPLOAD_DIR` | Direktori penyimpanan file upload |

Contoh koneksi database lokal:

```env
DATABASE_URL=postgresql://lab:lab_password@localhost:5432/lab_equipment?schema=public
```

Buat secret JWT yang kuat dan berbeda satu sama lain. Contoh membuat secret di Linux:

```bash
openssl rand -hex 32
```

Jangan commit file `.env` ke repository.

### 4. Jalankan PostgreSQL

Database development disediakan melalui Docker Compose:

```bash
npm run db:up
```

Perintah tersebut menjalankan service PostgreSQL dari `docker-compose.yml`.

Konfigurasi bawaan compose development:

- Database: `lab_equipment`
- User: `lab`
- Port: `5432`

Jika konfigurasi database diubah, pastikan `DATABASE_URL` pada `.env` juga disesuaikan.

### 5. Buat dan jalankan migrasi database

Untuk membuat migrasi pertama ketika folder `prisma/migrations` belum tersedia:

```bash
npm run db:migrate -- --name init
```

Perintah ini menjalankan Prisma Migrate dalam mode development dan menghasilkan folder migrasi. Simpan folder `prisma/migrations` ke Git:

```bash
git add prisma/migrations
git commit -m "Add initial Prisma migration"
git push
```

Untuk database development yang sudah memiliki migrasi:

```bash
npx prisma migrate dev
```

Untuk menerapkan migrasi yang sudah dibuat pada environment deployment:

```bash
npm run db:deploy
```

**Penting:** jangan membuat migrasi produksi secara langsung. Buat migrasi di development, commit ke repository, lalu terapkan dengan `prisma migrate deploy`.

### 6. (Opsional) Isi database dengan data seed

```bash
npm run db:seed
```

Seed menggunakan data CSV di `prisma/data/`.

> **Peringatan:** proses seed menghapus/mengganti data yang ada sebelum memasukkan data seed. Gunakan hanya pada database development atau database kosong yang memang disiapkan untuk seed. Jangan jalankan seed pada database produksi.

### 7. Jalankan API

```bash
npm run dev
```

API berjalan pada:

- Base URL: `http://localhost:3000`
- Health check: `http://localhost:3000/api/v1/health`
- Swagger UI: `http://localhost:3000/api/docs`

## Integrasi dengan frontend

Frontend Next.js berjalan secara default pada `http://localhost:3001`. Pastikan variabel backend berikut sesuai:

```env
CORS_ORIGIN=http://localhost:3001
APP_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3001
```

Frontend menggunakan `API_URL` untuk mengakses backend. Pada development lokal, nilainya:

```env
API_URL=http://localhost:3000/api/v1
```

Autentikasi menggunakan access token JWT dan refresh token pada cookie httpOnly. Request dari frontend yang membutuhkan cookie harus mengirim credentials. Detail alur autentikasi dan kontrak endpoint dapat dilihat di source code serta Swagger UI.

## Perintah npm

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Menjalankan server development dengan hot reload |
| `npm run build` | Compile TypeScript ke folder `dist` |
| `npm start` | Menjalankan hasil build |
| `npm run test` | Menjalankan test sekali |
| `npm run test:watch` | Menjalankan test dalam watch mode |
| `npm run lint` | Menjalankan ESLint |
| `npm run format` | Memformat source TypeScript |
| `npm run db:up` | Menyalakan PostgreSQL |
| `npm run db:generate` | Generate Prisma Client |
| `npm run db:migrate` | Membuat/menerapkan migrasi development |
| `npm run db:deploy` | Menerapkan migrasi yang sudah tersedia |
| `npm run db:seed` | Menjalankan seed |
| `npm run db:studio` | Membuka Prisma Studio |
| `npm run db:reset` | Reset database development dan menjalankan ulang migrasi/seed |

Gunakan `db:reset` hanya pada database development karena data database akan dihapus.

## Build dan menjalankan production

Build aplikasi:

```bash
npm ci
npm run build
```

Jalankan aplikasi hasil build:

```bash
npm run start:prod
```

Script `start:prod` menjalankan `prisma migrate deploy` terlebih dahulu, lalu menjalankan server Node.js. Pada deployment Docker yang disediakan, migrasi juga ditangani oleh entrypoint container API.

Untuk deployment lengkap bersama frontend, PostgreSQL, dan Caddy, gunakan konfigurasi pada repository/folder `lab-deploy`. Struktur direktori yang diharapkan:

```text
deployments/
├── lab-equipment-api/
├── lab-management/
└── lab-deploy/
```

## Upload dan penyimpanan file

File yang diunggah disimpan pada direktori `UPLOAD_DIR`. Pastikan direktori tersebut persisten pada deployment, misalnya menggunakan Docker volume. Sertakan data upload dalam proses backup.

## Keamanan dan catatan operasional

- Gunakan secret JWT yang panjang, acak, dan berbeda.
- Jangan commit `.env`, password, token, atau kredensial database.
- Jangan membuka port PostgreSQL ke jaringan publik.
- Batasi akses API sesuai rancangan reverse proxy deployment.
- Jangan menjalankan `db:seed` atau `db:reset` pada database produksi.
- Backup database PostgreSQL dan direktori upload secara berkala.
- Simpan seluruh file migrasi Prisma di Git agar deployment dapat menjalankan `prisma migrate deploy`.

## Troubleshooting

**API tidak dapat terhubung ke PostgreSQL**

- Pastikan container database aktif: `docker compose ps`.
- Periksa host, port, nama database, user, dan password pada `DATABASE_URL`.
- Jika API berjalan di dalam Docker Compose, gunakan hostname service database (misalnya `postgres`), bukan `localhost`.

**Prisma meminta migrasi**

- Pastikan `prisma/migrations` tersedia di repository.
- Buat migrasi di development, commit, dan push folder tersebut.
- Pada deployment jalankan `npm run db:deploy` atau gunakan mekanisme migrasi pada entrypoint container.

**Request dari frontend terkena CORS**

- Pastikan `CORS_ORIGIN` sama dengan origin frontend, termasuk skema dan port.
- Pastikan frontend berjalan pada port yang sesuai (`3001` secara default).
