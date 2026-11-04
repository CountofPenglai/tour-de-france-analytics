#!/usr/bin/env bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v mb_password="$(cat /run/secrets/metabase_password)" \
  -v owner_password="$(cat /run/secrets/owner_password)" \
  -v reader_password="$(cat /run/secrets/reader_password)" <<'SQL'
CREATE ROLE metabase_app LOGIN PASSWORD :'mb_password';
CREATE ROLE tdf_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE tdf_reader LOGIN PASSWORD :'reader_password';
CREATE DATABASE metabase_app OWNER metabase_app;
CREATE DATABASE tour_de_france OWNER tdf_owner;
REVOKE ALL ON DATABASE metabase_app FROM PUBLIC;
REVOKE ALL ON DATABASE tour_de_france FROM PUBLIC;
GRANT CONNECT ON DATABASE tour_de_france TO tdf_reader;
ALTER ROLE tdf_reader SET default_transaction_read_only = on;
ALTER ROLE tdf_reader IN DATABASE tour_de_france SET search_path = tdf, dw, public;
\connect tour_de_france
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA tdf AUTHORIZATION tdf_owner;
CREATE SCHEMA dw AUTHORIZATION tdf_owner;
GRANT USAGE ON SCHEMA tdf, dw TO tdf_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE tdf_owner IN SCHEMA tdf
  GRANT SELECT ON TABLES TO tdf_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE tdf_owner IN SCHEMA dw
  GRANT SELECT ON TABLES TO tdf_reader;
SQL
