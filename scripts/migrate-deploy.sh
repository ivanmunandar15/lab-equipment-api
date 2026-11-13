#!/bin/sh
# Terapkan migrasi yang SUDAH ada di prisma/migrations (tidak membuat migrasi baru, tidak mereset data).
set -eu
if [ ! -d prisma/migrations ] || [ -z "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "ERROR: prisma/migrations kosong. Jalankan 'npm run db:migrate -- --name init' di lokal, commit folder prisma/migrations, lalu build ulang image." >&2
  exit 1
fi
echo "Menjalankan prisma migrate deploy..."
npx prisma migrate deploy
