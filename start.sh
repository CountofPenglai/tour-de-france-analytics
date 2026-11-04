#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
command -v docker >/dev/null || { echo 'Install Docker Desktop or Docker Engine with Compose first.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker and try again.' >&2; exit 1; }
docker compose version >/dev/null
[[ -f .env ]] || cp .env.example .env
mkdir -p .runtime
export LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)"
# Persist host ownership so later direct Compose tool commands can read the
# private runtime directory on Linux, including users whose UID is not 1000.
tdf_env_tmp="$(mktemp .env.local.XXXXXX)"
trap 'rm -f "$tdf_env_tmp"' EXIT
awk -v uid="$LOCAL_UID" -v gid="$LOCAL_GID" '
  /^[[:space:]]*(export[[:space:]]+)?LOCAL_(UID|GID)[[:space:]]*=/ { next }
  { print }
  END { print "LOCAL_UID=" uid; print "LOCAL_GID=" gid }
' .env > "$tdf_env_tmp"
mv "$tdf_env_tmp" .env
trap - EXIT
echo 'Building the portal from pinned official Python/PyPI sources…'
docker compose build portal
docker compose run --rm --no-deps setup
echo 'Starting PostgreSQL and Metabase. First startup may take several minutes…'
docker compose up -d --wait --wait-timeout 480 postgres metabase
docker compose run --rm --no-deps bootstrap
docker compose up -d --wait --wait-timeout 120 portal
echo 'Ready. Open the loopback ports shown below (default Dashboard :8000, Metabase :3000).'
docker compose ps
echo 'Metabase login: .runtime/admin-credentials.json (keep private).'
