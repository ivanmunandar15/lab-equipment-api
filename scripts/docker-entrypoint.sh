#!/bin/sh
set -eu
# RUN_MIGRATIONS=false untuk melewati migrasi (mis. replika tambahan atau migrasi dijalankan job terpisah).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  /app/scripts/migrate-deploy.sh
fi
# SEED_ON_START=true: isi data awal (personil, ruangan, alat) HANYA jika database masih kosong. Tidak pernah menghapus data.
# Aman pada setiap start; setelah database berisi, langkah ini otomatis dilewati. Gagal = container berhenti (tidak setengah terisi).
if [ "${SEED_ON_START:-false}" = "true" ]; then
  echo "Menjalankan seed (SEED_MODE=if-empty)..."
  SEED_MODE=if-empty node dist-seed/prisma/seed.js
fi
exec "$@"
