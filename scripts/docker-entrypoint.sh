#!/bin/sh
set -eu
# RUN_MIGRATIONS=false untuk melewati migrasi (mis. replika tambahan atau migrasi dijalankan job terpisah).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  /app/scripts/migrate-deploy.sh
fi
exec "$@"
