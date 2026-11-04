-- =============================================================================
-- Project 3: Tour de France 2025 Normalized Relational Schema (tdf)
-- and Star-Schema Data Warehouse (dw)
-- Execution role: tdf_owner
-- Read-only role: tdf_reader
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS tdf;
CREATE SCHEMA IF NOT EXISTS dw;

-- -----------------------------------------------------------------------------
-- Phase 1: Normalized Relational Schema (tdf)
-- Preserves Project 2 relational schema with only approved SPEC deviations:
--   1. Nullable rider.country_code (bib 78 has NULL nationality in source CSV)
--   2. Tied finish_rank values permitted in tdf.result
--   3. Same-city start/finish endpoints permitted in tdf.stage
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tdf.country (
    country_code CHAR(3) PRIMARY KEY
        CHECK (country_code ~ '^[A-Z]{3}$' AND country_code NOT IN ('UNK', 'NULL')),
    country_name VARCHAR(100) NOT NULL UNIQUE
        CHECK (btrim(country_name) <> '')
);

CREATE TABLE IF NOT EXISTS tdf.team (
    team_name VARCHAR(120) PRIMARY KEY
        CHECK (btrim(team_name) <> ''),
    country_code CHAR(3) NOT NULL
        REFERENCES tdf.country (country_code)
);

CREATE TABLE IF NOT EXISTS tdf.rider (
    bib_number INTEGER PRIMARY KEY
        CHECK (bib_number > 0),
    rider_name VARCHAR(120) NOT NULL
        CHECK (btrim(rider_name) <> ''),
    date_of_birth DATE NOT NULL,
    team_name VARCHAR(120) NOT NULL
        REFERENCES tdf.team (team_name),
    country_code CHAR(3) NULL
        REFERENCES tdf.country (country_code),
    UNIQUE (team_name, bib_number)
);

-- Empty table preserved from Project 2; composite FK enforces leader is on the same team.
CREATE TABLE IF NOT EXISTS tdf.team_leader (
    team_name VARCHAR(120) PRIMARY KEY
        REFERENCES tdf.team (team_name),
    bib_number INTEGER NOT NULL UNIQUE,
    FOREIGN KEY (team_name, bib_number)
        REFERENCES tdf.rider (team_name, bib_number)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS tdf.location (
    country_code CHAR(3) NOT NULL
        REFERENCES tdf.country (country_code),
    location_name VARCHAR(120) NOT NULL
        CHECK (btrim(location_name) <> ''),
    PRIMARY KEY (country_code, location_name)
);

-- Same-city start and finish locations are permitted (e.g. Stages 1, 5, 11).
CREATE TABLE IF NOT EXISTS tdf.stage (
    stage_id INTEGER PRIMARY KEY
        CHECK (stage_id BETWEEN 1 AND 21),
    stage_order INTEGER NOT NULL UNIQUE
        CHECK (stage_order BETWEEN 1 AND 21 AND stage_order = stage_id),
    stage_date DATE NOT NULL UNIQUE,
    start_country_code CHAR(3) NOT NULL,
    start_location_name VARCHAR(120) NOT NULL,
    finish_country_code CHAR(3) NOT NULL,
    finish_location_name VARCHAR(120) NOT NULL,
    distance_km NUMERIC(6, 2) NOT NULL
        CHECK (distance_km > 0),
    stage_type VARCHAR(30) NOT NULL
        CHECK (stage_type IN ('flat', 'hilly', 'mountain', 'individual time-trial')),
    FOREIGN KEY (start_country_code, start_location_name)
        REFERENCES tdf.location (country_code, location_name),
    FOREIGN KEY (finish_country_code, finish_location_name)
        REFERENCES tdf.location (country_code, location_name)
);

-- Tied finish_rank values within a stage are permitted; each (bib_number, stage_id) has at most one result.
CREATE TABLE IF NOT EXISTS tdf.result (
    bib_number INTEGER NOT NULL
        REFERENCES tdf.rider (bib_number),
    stage_id INTEGER NOT NULL
        REFERENCES tdf.stage (stage_id),
    finish_rank INTEGER NOT NULL
        CHECK (finish_rank > 0),
    finish_time_seconds INTEGER NOT NULL
        CHECK (finish_time_seconds > 0),
    time_bonus_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (time_bonus_seconds >= 0),
    time_penalty_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (time_penalty_seconds >= 0),
    PRIMARY KEY (bib_number, stage_id),
    CHECK (finish_time_seconds - time_bonus_seconds + time_penalty_seconds > 0)
);

CREATE TABLE IF NOT EXISTS tdf.exit (
    bib_number INTEGER PRIMARY KEY
        REFERENCES tdf.rider (bib_number),
    stage_id INTEGER NOT NULL
        REFERENCES tdf.stage (stage_id),
    exit_reason VARCHAR(255) NOT NULL
        CHECK (btrim(exit_reason) <> '')
);

-- Empty award tables preserved from Project 2 relational schema (no fabricated records).
CREATE TABLE IF NOT EXISTS tdf.classification_award (
    award_id INTEGER PRIMARY KEY,
    award_name VARCHAR(120) NOT NULL
        CHECK (btrim(award_name) <> ''),
    recipient_type VARCHAR(10) NOT NULL
        CHECK (recipient_type IN ('RIDER', 'TEAM')),
    UNIQUE (award_id, recipient_type)
);

CREATE TABLE IF NOT EXISTS tdf.rider_award (
    award_id INTEGER PRIMARY KEY,
    recipient_type VARCHAR(10) NOT NULL DEFAULT 'RIDER'
        CHECK (recipient_type = 'RIDER'),
    bib_number INTEGER NOT NULL
        REFERENCES tdf.rider (bib_number),
    FOREIGN KEY (award_id, recipient_type)
        REFERENCES tdf.classification_award (award_id, recipient_type)
);

CREATE TABLE IF NOT EXISTS tdf.team_award (
    award_id INTEGER PRIMARY KEY,
    recipient_type VARCHAR(10) NOT NULL DEFAULT 'TEAM'
        CHECK (recipient_type = 'TEAM'),
    team_name VARCHAR(120) NOT NULL
        REFERENCES tdf.team (team_name),
    FOREIGN KEY (award_id, recipient_type)
        REFERENCES tdf.classification_award (award_id, recipient_type)
);

CREATE OR REPLACE VIEW tdf.v_result_adjusted AS
SELECT
    bib_number,
    stage_id,
    finish_rank,
    finish_time_seconds,
    time_bonus_seconds,
    time_penalty_seconds,
    finish_time_seconds - time_bonus_seconds + time_penalty_seconds AS adjusted_time_seconds
FROM tdf.result;

CREATE INDEX IF NOT EXISTS idx_tdf_team_country ON tdf.team (country_code);
CREATE INDEX IF NOT EXISTS idx_tdf_rider_team ON tdf.rider (team_name);
CREATE INDEX IF NOT EXISTS idx_tdf_rider_country ON tdf.rider (country_code);
CREATE INDEX IF NOT EXISTS idx_tdf_location_country ON tdf.location (country_code);
CREATE INDEX IF NOT EXISTS idx_tdf_stage_start_location ON tdf.stage (start_country_code, start_location_name);
CREATE INDEX IF NOT EXISTS idx_tdf_stage_finish_location ON tdf.stage (finish_country_code, finish_location_name);
CREATE INDEX IF NOT EXISTS idx_tdf_stage_type ON tdf.stage (stage_type);
CREATE INDEX IF NOT EXISTS idx_tdf_result_bib ON tdf.result (bib_number);
CREATE INDEX IF NOT EXISTS idx_tdf_result_stage_rank ON tdf.result (stage_id, finish_rank);
CREATE INDEX IF NOT EXISTS idx_tdf_exit_stage ON tdf.exit (stage_id);

-- -----------------------------------------------------------------------------
-- Phase 2: Star-Schema / Fact Constellation Warehouse (dw)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dw.dim_country (
    country_key INTEGER PRIMARY KEY
        CHECK (country_key >= 0),
    country_code VARCHAR(3) NOT NULL UNIQUE
        CHECK (char_length(btrim(country_code)) = 3),
    country_name TEXT NOT NULL UNIQUE
        CHECK (btrim(country_name) <> ''),
    CHECK (
        (country_key = 0 AND country_code = 'UNK' AND country_name = 'Unknown / Unspecified')
        OR (country_key > 0 AND country_code <> 'UNK')
    )
);

INSERT INTO dw.dim_country (country_key, country_code, country_name)
VALUES (0, 'UNK', 'Unknown / Unspecified')
ON CONFLICT (country_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS dw.dim_team (
    team_key INTEGER PRIMARY KEY
        CHECK (team_key > 0),
    team_name TEXT NOT NULL UNIQUE
        CHECK (btrim(team_name) <> '')
);

CREATE TABLE IF NOT EXISTS dw.dim_rider (
    rider_key INTEGER PRIMARY KEY
        CHECK (rider_key > 0),
    bib_number INTEGER NOT NULL UNIQUE
        CHECK (bib_number > 0),
    rider_name TEXT NOT NULL
        CHECK (btrim(rider_name) <> ''),
    date_of_birth DATE NOT NULL,
    age_at_race INTEGER NOT NULL
        CHECK (age_at_race > 0),
    age_group TEXT NOT NULL
        CHECK (age_group IN ('U23', '23-25', '26-29', '30+')),
    is_young_rider BOOLEAN NOT NULL,
    CHECK (is_young_rider = (date_of_birth >= DATE '2000-01-01')),
    CHECK (
        (age_at_race < 23 AND age_group = 'U23')
        OR (age_at_race BETWEEN 23 AND 25 AND age_group = '23-25')
        OR (age_at_race BETWEEN 26 AND 29 AND age_group = '26-29')
        OR (age_at_race >= 30 AND age_group = '30+')
    )
);

CREATE TABLE IF NOT EXISTS dw.dim_stage (
    stage_key INTEGER PRIMARY KEY
        CHECK (stage_key > 0),
    stage_id INTEGER NOT NULL UNIQUE
        CHECK (stage_id BETWEEN 1 AND 21),
    stage_order INTEGER NOT NULL UNIQUE
        CHECK (stage_order BETWEEN 1 AND 21 AND stage_order = stage_id),
    stage_type TEXT NOT NULL
        CHECK (stage_type IN ('flat', 'hilly', 'mountain', 'individual time-trial')),
    distance_km NUMERIC(6, 2) NOT NULL
        CHECK (distance_km > 0),
    start_location_name TEXT NOT NULL
        CHECK (btrim(start_location_name) <> ''),
    start_country_code VARCHAR(3) NOT NULL
        CHECK (char_length(btrim(start_country_code)) = 3),
    start_country_name TEXT NOT NULL
        CHECK (btrim(start_country_name) <> ''),
    finish_location_name TEXT NOT NULL
        CHECK (btrim(finish_location_name) <> ''),
    finish_country_code VARCHAR(3) NOT NULL
        CHECK (char_length(btrim(finish_country_code)) = 3),
    finish_country_name TEXT NOT NULL
        CHECK (btrim(finish_country_name) <> '')
);

CREATE TABLE IF NOT EXISTS dw.dim_date (
    date_key INTEGER PRIMARY KEY
        CHECK (date_key > 0),
    full_date DATE NOT NULL UNIQUE,
    year INTEGER NOT NULL
        CHECK (year >= 2025),
    month INTEGER NOT NULL
        CHECK (month BETWEEN 1 AND 12),
    week INTEGER NOT NULL
        CHECK (week BETWEEN 1 AND 53),
    day INTEGER NOT NULL
        CHECK (day BETWEEN 1 AND 31),
    race_week INTEGER NOT NULL
        CHECK (race_week BETWEEN 1 AND 3)
);

CREATE TABLE IF NOT EXISTS dw.fact_results (
    rider_key INTEGER NOT NULL
        REFERENCES dw.dim_rider (rider_key),
    stage_key INTEGER NOT NULL
        REFERENCES dw.dim_stage (stage_key),
    team_key INTEGER NOT NULL
        REFERENCES dw.dim_team (team_key),
    date_key INTEGER NOT NULL
        REFERENCES dw.dim_date (date_key),
    rider_country_key INTEGER NOT NULL
        REFERENCES dw.dim_country (country_key),
    team_country_key INTEGER NOT NULL
        REFERENCES dw.dim_country (country_key)
        CHECK (team_country_key > 0),
    finish_time_seconds INTEGER NOT NULL
        CHECK (finish_time_seconds > 0),
    time_bonus_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (time_bonus_seconds >= 0),
    time_penalty_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (time_penalty_seconds >= 0),
    adjusted_time_seconds INTEGER NOT NULL
        CHECK (
            adjusted_time_seconds > 0
            AND adjusted_time_seconds = finish_time_seconds - time_bonus_seconds + time_penalty_seconds
        ),
    finish_rank INTEGER NOT NULL
        CHECK (finish_rank >= 1),
    stage_points_proxy INTEGER NOT NULL DEFAULT 0
        CHECK (stage_points_proxy BETWEEN 0 AND 50),
    kom_points_proxy INTEGER NOT NULL DEFAULT 0
        CHECK (kom_points_proxy BETWEEN 0 AND 20),
    PRIMARY KEY (rider_key, stage_key)
);

CREATE TABLE IF NOT EXISTS dw.fact_participation (
    rider_key INTEGER PRIMARY KEY
        REFERENCES dw.dim_rider (rider_key),
    team_key INTEGER NOT NULL
        REFERENCES dw.dim_team (team_key),
    rider_country_key INTEGER NOT NULL
        REFERENCES dw.dim_country (country_key),
    team_country_key INTEGER NOT NULL
        REFERENCES dw.dim_country (country_key)
        CHECK (team_country_key > 0),
    participant_count INTEGER NOT NULL DEFAULT 1
        CHECK (participant_count = 1),
    finished_race_flag INTEGER NOT NULL
        CHECK (finished_race_flag IN (0, 1)),
    exit_flag INTEGER NOT NULL
        CHECK (exit_flag IN (0, 1)),
    CHECK (finished_race_flag + exit_flag = 1)
);

CREATE INDEX IF NOT EXISTS idx_dw_fact_results_stage ON dw.fact_results (stage_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_results_team ON dw.fact_results (team_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_results_date ON dw.fact_results (date_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_results_rider_country ON dw.fact_results (rider_country_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_results_team_country ON dw.fact_results (team_country_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_results_stage_rank ON dw.fact_results (stage_key, finish_rank);
CREATE INDEX IF NOT EXISTS idx_dw_fact_participation_team ON dw.fact_participation (team_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_participation_rider_country ON dw.fact_participation (rider_country_key);
CREATE INDEX IF NOT EXISTS idx_dw_fact_participation_team_country ON dw.fact_participation (team_country_key);

-- -----------------------------------------------------------------------------
-- Read-only privileges for Metabase / analytical reader role (tdf_reader)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tdf_reader') THEN
        GRANT USAGE ON SCHEMA tdf, dw TO tdf_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA tdf, dw TO tdf_reader;
        ALTER DEFAULT PRIVILEGES IN SCHEMA tdf, dw GRANT SELECT ON TABLES TO tdf_reader;
    END IF;
END
$$;
