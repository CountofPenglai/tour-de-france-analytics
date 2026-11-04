#!/bin/sh
set -eu
# This setting does not support Metabase's _FILE suffix. Read it at startup;
# keep the value out of Compose, source control and the image layers.
MB_ENCRYPTION_SECRET_KEY="$(cat /run/secrets/metabase_encryption_key)"
export MB_ENCRYPTION_SECRET_KEY
exec /app/run_metabase.sh "$@"
