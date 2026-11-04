# Data Dictionary — Schemas `tdf` and `dw`

## 1. Source CSV Files (`data/`)

| Source File | Row Count | Natural Grain | Key Columns & Notes |
| --- | ---: | --- | --- |
| `data/riders.csv` | 184 | One row per participating rider | `bib`, `rider_name`, `dob`, `team`, `rider_country_code`, `rider_country_name`, `team_country_code`, `team_country_name`. `#78 Aleksandr Vlasov` has string `'NULL'` for rider country fields. |
| `data/individual_results.csv` | 3,602 | One row per rider finishing a stage | `day`, `rider`, `rank`, `time`, `bonus`, `penalty`, `start_location`, `start_country_code`, `start_country_name`, `finish_location`, `finish_country_code`, `finish_country_name`, `length`, `type`, `name`, `team`. Contains 21 stage dates (`2025-07-05` to `2025-07-27`, with rest days on `2025-07-15` and `2025-07-21`). |
| `data/exits.csv` | 24 | One row per rider who exited the race | `bib`, `name`, `stage`, `reason` (`DNS` or `withdrawal`). Stage numbers are integers (`1..20`). |

---

## 2. Normalized Relational Schema (`tdf`)

| Table | Row Count | Grain | Primary Key | Natural / Unique Keys & Foreign Keys | Source Mapping & Rules |
| --- | ---: | --- | --- | --- | --- |
| `tdf.country` | 29 | One country present in source CSVs | `country_code` | `UNIQUE (country_name)` | Union of non-null rider, team, start, and finish countries across the 3 CSVs. Excludes `'NULL'` and `'UNK'`. |
| `tdf.team` | 23 | One participating team | `team_name` | `FK (country_code) -> tdf.country` | Distinct `(team, team_country_code)` from `riders.csv`. |
| `tdf.rider` | 184 | One participating rider | `bib` | `FK (team_name) -> tdf.team`, nullable `FK (country_code) -> tdf.country` | From `riders.csv`; string `'NULL'` in `rider_country_code` mapped to SQL `NULL` (`bib = 78`). |
| `tdf.location` | 34 | One distinct start or finish city/area | `location_name` | `FK (country_code) -> tdf.country` | Union of `(start_location, start_country_code)` and `(finish_location, finish_country_code)` from `individual_results.csv`. |
| `tdf.stage` | 21 | One race stage | `stage_id` | `UNIQUE (stage_date)`, `FK (start_location, finish_location) -> tdf.location` | `stage_id` (`1..21`) derived via `DENSE_RANK() OVER (ORDER BY day ASC)` across rest days. Same-city start/finish permitted (Stages 1, 5, 11). |
| `tdf.result` | 3,602 | One stage finish result for one rider | `(stage_id, bib)` | `FK (stage_id) -> tdf.stage`, `FK (bib) -> tdf.rider` | Joined from `individual_results.csv` on `day = stage_date`. Tied `finish_rank` permitted; zero `time_bonus_seconds` / `time_penalty_seconds` valid. |
| `tdf.exit` | 24 | One race exit event for one rider | `bib` | `FK (bib) -> tdf.rider`, `FK (stage_id) -> tdf.stage` | From `exits.csv` (`bib, stage, reason`). |
| `tdf.team_leader` | 0 | One leader per team (empty relation) | `team_name` | `UNIQUE (leader_bib)`, `FK -> tdf.team, tdf.rider` | Preserved for relational schema completeness; no records fabricated. |
| `tdf.award` | 0 | One award record (empty relation) | `award_name` | `FK (winner_bib) -> tdf.rider` | Preserved for relational schema completeness; no records fabricated. |

---

## 3. Star Warehouse Schema (`dw`)

### 3.1 Shared Dimensions

| Table | Row Count | Grain | Surrogate PK | Natural Unique Key | Attributes & Transformation Rules |
| --- | ---: | --- | --- | --- | --- |
| `dw.dim_country` | 30 | One country or unknown member | `country_key` | `country_code`, `country_name` | `country_key = 0` is `'UNK'` (`'Unknown / Unspecified'`). Keys `1..29` assigned by `ROW_NUMBER() OVER (ORDER BY country_code ASC)` from `tdf.country`. Serves as role-playing dimension (`rider_country_key`, `team_country_key`). |
| `dw.dim_team` | 23 | One team | `team_key` | `team_name` | Keys `1..23` assigned by `ROW_NUMBER() OVER (ORDER BY team_name ASC)` from `tdf.team`. |
| `dw.dim_rider` | 184 | One rider | `rider_key` | `bib_number` | Keys `1..184` ordered by `bib_number ASC`. `age_at_race` computed on `2025-07-05`. `age_group` uses simple labels `'U23'`, `'23-25'`, `'26-29'`, `'30+'`. `is_young_rider` independently defined as `date_of_birth >= DATE '2000-01-01'` (riders born in 1999 aged 25 on `2025-07-05` have `age_group = '23-25'` and `is_young_rider = FALSE`). |
| `dw.dim_stage` | 21 | One stage | `stage_key` | `stage_id`, `stage_order` | `stage_key = stage_id = stage_order (1..21)`. Denormalizes `stage_type`, `distance_km`, `start_location_name`, `start_country_code`, `start_country_name`, `finish_location_name`, `finish_country_code`, `finish_country_name`. |
| `dw.dim_date` | 21 | One stage race date | `date_key` | `full_date` | `date_key = YYYYMMDD` integer (`20250705..20250727`). Stores `year`, `month`, ISO calendar `week` (`27..30`), `day`, and separate `race_week = ((stage_order - 1) / 7) + 1` (`1..3`). |

### 3.2 Fact Tables

| Table | Row Count | Grain | Primary Key | Dimension Foreign Keys (All `NOT NULL`) | Measures & Derivation Rules |
| --- | ---: | --- | --- | --- | --- |
| `dw.fact_results` | 3,602 | One rider finishing one stage | `(rider_key, stage_key)` | `rider_key`, `stage_key`, `team_key`, `date_key`, `rider_country_key`, `team_country_key` | `finish_time_seconds`, `time_bonus_seconds`, `time_penalty_seconds`, `adjusted_time_seconds = finish_time_seconds - time_bonus_seconds + time_penalty_seconds`, `finish_rank`, `stage_points_proxy`, `kom_points_proxy`. Null rider nationality (`bib = 78`) maps to `rider_country_key = 0 ('UNK')`. |
| `dw.fact_participation` | 184 | One rider participating in the 2025 race | `rider_key` | `rider_key`, `team_key`, `rider_country_key`, `team_country_key` | `participant_count = 1`, `finished_race_flag` (`1` iff completed all 21 stages and absent from `tdf.exit`; 160 riders), `exit_flag` (`1` iff present in `tdf.exit`; 24 riders, including 2 Stage-1 withdrawals with 0 rows in `fact_results`). |

### 3.3 Proxy Scoring Definitions (`dw.fact_results`)

Both `stage_points_proxy` and `kom_points_proxy` are **derived proxy measures** based solely on stage finish rank and stage type (since intermediate sprint and climb classifications are not present in the source CSVs):
- **`stage_points_proxy`** (ranks `1..15`, `0` otherwise):
  - `flat`: `[50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2]`
  - `hilly`: `[30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2]`
  - `mountain` and `individual time-trial`: `[20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]`
- **`kom_points_proxy`**:
  - `mountain` (ranks `1..10`, `0` otherwise): `[20, 15, 12, 10, 8, 6, 4, 3, 2, 1]`
  - `hilly` (ranks `1..5`, `0` otherwise): `[10, 6, 4, 2, 1]`
  - `flat` and `individual time-trial`: `0`
