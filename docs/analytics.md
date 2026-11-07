# Shared OLAP SQL Layer (`dw` Analytics Reference)

This document specifies the shared PostgreSQL 18 analytical layer implemented in `sql/003_analytics.sql` over the `dw` star-schema data warehouse. Both the **P0 Metabase native dashboard** and the **P1 FastAPI + Static Signed Embedding portal** query these exact interfaces to guarantee 100% consistent metrics.

---

## 1. Execution & Security Model

- **Schema**: `dw`
- **Owner / DDL Execution Role**: `tdf_owner`
- **Read-Only Query Role**: `tdf_reader` (used by Metabase and FastAPI read queries)
- **Function Properties**: All functions are `LANGUAGE plpgsql STABLE SECURITY INVOKER` with `SET search_path = dw, pg_catalog`.
- **Grants**: `SELECT` on `dw.olap_rollup` and `EXECUTE` on all 8 table functions are explicitly granted to `tdf_reader`. No write privileges or `SECURITY DEFINER` escalations are used.

---

## 2. Common `p_filters jsonb` Contract

All 8 analytical table functions accept a single parameter:

```sql
p_filters jsonb DEFAULT '{}'::jsonb
```

### 2.1 Supported Filter Keys & Defaults

| Key | JSON Type | Allowed Values | Default (if omitted or `null`) | Semantics |
| --- | --- | --- | --- | --- |
| `stage_scope` | `string` | `'final'`, `'as_of'`, `'selection'` | `'final'` | `'final'`: all 21 stages (`1..21`).<br>`'as_of'`: cumulative stages `1..as_of_stage`.<br>`'selection'`: custom subset filtered by `stage_ids` and/or `stage_types`. |
| `as_of_stage` | `number` (int) | `1..21` | `21` | Stage cutoff $S$ when `stage_scope = 'as_of'`. |
| `stage_ids` | `array` of int | Stage numbers in `1..21` | All stages (`NULL`) | Explicit stage filter. Ignored by `final`/`as_of` in cumulative standings (`rider_standings`, `team_standings`, `gc_evolution`); always applied in stage-detail, summary, depth, and specialisation functions. |
| `stage_types` | `array` of string | `'flat'`, `'hilly'`, `'mountain'`, `'individual time-trial'` | All stage types (`NULL`) | Stage Type filter. Ignored by `final`/`as_of` in cumulative standings; always applied in stage-detail, summary, depth, and specialisation functions. |
| `time_basis` | `string` | `'finish'`, `'adjusted'` | `'adjusted'` | `'adjusted'`: `finish_time_seconds - time_bonus_seconds + time_penalty_seconds`.<br>`'finish'`: raw `finish_time_seconds`. |
| `rank_scope` | `string` | `'overall'`, `'filtered'` | `'overall'` | `'overall'`: compute `rank`, `gap_seconds`, and `rank_percentile` across the full eligible competition universe before applying display filters (`team_keys`, `rider_keys`, `young_only`).<br>`'filtered'`: filter the cohort first, then rank within the filtered subset. |
| `team_keys` | `array` of int | `dw.dim_team.team_key` values | All teams (`NULL`) | Restricts output (and ranking pool when `rank_scope = 'filtered'`) to matching teams. |
| `rider_keys` | `array` of int | `dw.dim_rider.rider_key` values | All riders (`NULL`) | Restricts rider-level functions to matching riders; in `dw.team_standings`, selects teams having a matching member in `dw.fact_participation` + `dw.dim_rider` without removing team contributors. |
| `young_only` | `boolean` | `true`, `false` | `false` | When `true`, restricts riders to `is_young_rider = true` (`date_of_birth >= '2000-01-01'`); in `dw.team_standings`, selects teams having a matching young rider (combined with `AND` for the same member when `rider_keys` is also provided) without removing team contributors. |
| `classification` | `string` | `'gc'`, `'young'`, `'points_proxy'`, `'kom_proxy'`, `'mountain_time'` | `'gc'` | Used by `dw.rider_standings` to select the classification competition and ranking metric. |
| `team_aggregation` | `string` | `'stage_top3'`, `'cumulative_top3'` | `'stage_top3'` | Used by `dw.team_standings` to select the team time calculation rule. |

### 2.2 Important Behavioral Rules

1. **Missing Keys vs. Empty JSON Arrays (`[]`)**:
   - **Omitted key or JSON `null`**: Uses the documented default (includes all members of that dimension).
   - **Empty JSON array (`[]`)**: Treated as an explicit empty selection and **returns 0 rows** (never silently falls back to including all rows).
2. **Validation**:
   - Passing a non-object JSON value for `p_filters`, a non-array for an array filter, an out-of-range `as_of_stage` (`< 1` or `> 21`), or an unknown enum string raises a descriptive PostgreSQL exception.
3. **Unknown Nationality (`#78 Aleksandr Vlasov`)**:
   - Mapped to `dw.dim_country.country_key = 0` (`country_code = 'UNK'`, `country_name = 'Unknown / Unspecified'`).
   - Retained in all rider and team performance functions (`rider_standings`, `team_standings`, `rider_stage_results`, `rider_specialisation`, `team_depth`, `gc_evolution`).
   - Excluded **only** from the rider nationality rows of `dw.country_participation`, while still preserving his team's registration country count.

---

## 3. Function & View Reference

### 3.1 `dw.rider_standings(p_filters jsonb DEFAULT '{}'::jsonb)`

Computes individual standings across all five classification modes:
- `'gc'`: General Classification, ranked by `RANK() OVER (ORDER BY total_seconds ASC)`.
- `'young'`: Young Rider (White Jersey) Classification (`is_young_rider = true`), ranked by `RANK() OVER (ORDER BY total_seconds ASC)`.
- `'points_proxy'`: Points Classification Proxy, summing `stage_points_proxy`, ranked by `RANK() OVER (ORDER BY points DESC)` with **no time tie-breaker**. Returns `gap_seconds = NULL` (since `gap_seconds` is a time gap) while retaining `total_seconds` as informational.
- `'kom_proxy'`: KOM Classification Proxy, summing `kom_points_proxy`, ranked by `RANK() OVER (ORDER BY points DESC)` with **no time tie-breaker**. Returns `gap_seconds = NULL` while retaining `total_seconds` as informational.
- `'mountain_time'`: Sums times across `'mountain'` stages in the scope (`RANK() OVER (ORDER BY total_seconds ASC)`), while completion eligibility still requires completing all stages in the scope (all 21 stages for `final`, `1..S` for `as_of`).

**Eligibility Rule**: A rider must have a result in every stage of the active scope (`21` stages for `final`, `1..as_of_stage` for `as_of`, or all selected stages for `selection`).

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `rider_key` | `integer` | Surrogate key from `dw.dim_rider`. |
| `bib_number` | `integer` | Official rider bib number (`1` = Tadej Pogacar). |
| `rider_name` | `text` | Rider full name. |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `is_young_rider` | `boolean` | `true` if `date_of_birth >= '2000-01-01'`. |
| `stage_count` | `integer` | Number of scoring stages aggregated into `total_seconds` (`21` for full-race classifications; mountain stage count for `'mountain_time'`). |
| `total_seconds` | `integer` | Sum of `adjusted_time_seconds` (`time_basis = 'adjusted'`) or `finish_time_seconds` (`time_basis = 'finish'`). |
| `points` | `integer` | Sum of `kom_points_proxy` for `'kom_proxy'`/`'mountain_time'`; sum of `stage_points_proxy` otherwise. |
| `rank` | `integer` | Competition rank via `RANK()` (`overall` or `filtered` per `rank_scope`). |
| `gap_seconds` | `integer` | `total_seconds - MIN(total_seconds)` within the active ranking pool for time-based classifications (`'gc'`, `'young'`, `'mountain_time'`); `NULL` for `'points_proxy'` and `'kom_proxy'`. |
| `rank_percentile` | `numeric(5,2)` | `(cohort_size - rank) * 100.0 / NULLIF(cohort_size - 1, 0)` (`100.00` for rank 1). |
| `classification` | `text` | Echoes the active `classification` mode (`'gc'`, `'young'`, `'points_proxy'`, `'kom_proxy'`, `'mountain_time'`). |
| `time_basis` | `text` | Echoes the active `time_basis` (`'adjusted'` or `'finish'`). |

#### Example Queries

```sql
-- Default Final Adjusted GC Standings (160 finishers, winner bib 1 = 277349s)
SELECT * FROM dw.rider_standings();

-- Points Proxy Classification
SELECT * FROM dw.rider_standings('{"classification": "points_proxy"}'::jsonb);

-- As-of Stage 10 GC for a specific team with overall vs filtered ranks
SELECT * FROM dw.rider_standings('{"stage_scope": "as_of", "as_of_stage": 10, "team_keys": [1], "rank_scope": "overall"}'::jsonb);
```

---

### 3.2 `dw.team_standings(p_filters jsonb DEFAULT '{}'::jsonb)`

Computes team standings under both aggregation rules:
- `'stage_top3'` (default): Within each stage in scope, selects the fastest 3 riders per team using `ROW_NUMBER() OVER (PARTITION BY team_key, stage_key ORDER BY stage_seconds ASC, rider_key ASC)`. Teams with fewer than 3 finishers in any stage of the scope are excluded (no zero-fill). Sums the 3 riders' times per stage across all stages in scope.
- `'cumulative_top3'`: Restricts to riders who completed all stages in the scope, computes each rider's cumulative time over the scope, and selects the fastest 3 complete-scope riders per team using `ROW_NUMBER() OVER (PARTITION BY team_key ORDER BY rider_total_seconds ASC, rider_key ASC)`. Teams with fewer than 3 complete-scope riders are excluded.

**Team Roster & Selection Semantics**:
- Team timings (`total_seconds`, `stage_count`, `contributor_count`) are **always** computed from the full team roster in the selected stage/time scope under both `'stage_top3'` and `'cumulative_top3'`.
- `team_keys` selects teams directly. `rider_keys` and `young_only` select teams by existence of a matching member in `dw.fact_participation` joined with `dw.dim_rider` (combined with `AND` for the same member when both are supplied), and **never** remove contributors from a team's timing calculation.
- When `rank_scope = 'overall'` (default), all eligible teams are ranked first and the output is then restricted to the matching teams (so selecting a single rider such as `#1` displays his team's full score and overall rank). When `rank_scope = 'filtered'`, the cohort is restricted to matching teams before `RANK()` and `gap_seconds` are computed.
- Omitted or `null` selection keys are unrestricted; an explicit empty array (`[]`) for `team_keys` or `rider_keys` returns 0 teams.

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `total_seconds` | `integer` | Aggregated team time in seconds across the selected scope. |
| `rank` | `integer` | Team rank via `RANK() OVER (ORDER BY total_seconds ASC)`. |
| `gap_seconds` | `integer` | `total_seconds - MIN(total_seconds)` relative to the leading team in the active ranking pool. |
| `stage_count` | `integer` | Number of stages in the scope (`21` for `'final'`). |
| `contributor_count` | `integer` | Number of distinct riders who contributed to the team's top-3 selections (`3` for `'cumulative_top3'`, `>= 3` for `'stage_top3'`). |
| `team_aggregation` | `text` | Echoes `'stage_top3'` or `'cumulative_top3'`. |
| `time_basis` | `text` | Echoes `'adjusted'` or `'finish'`. |

#### Example Queries

```sql
-- Official Tour per-stage top-3 team standings
SELECT * FROM dw.team_standings('{"team_aggregation": "stage_top3"}'::jsonb);

-- Cumulative top-3 finisher team standings
SELECT * FROM dw.team_standings('{"team_aggregation": "cumulative_top3"}'::jsonb);
```

---

### 3.3 `dw.rider_stage_results(p_filters jsonb DEFAULT '{}'::jsonb)`

Returns rider × stage grain detail joined with rider, team, stage, date, country, and participation status. Global stage metrics (`stage_finisher_count`, `gap_seconds`, `adjusted_gap_seconds`, `rank_percentile`) are computed over all finishers of each stage **before** applying rider/team display filters.

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `rider_key` | `integer` | Surrogate key from `dw.dim_rider`. |
| `bib_number` | `integer` | Official rider bib number. |
| `rider_name` | `text` | Rider full name. |
| `is_young_rider` | `boolean` | Young rider eligibility flag. |
| `rider_country_code` | `varchar(3)` | Rider nationality code (`'UNK'` for bib 78). |
| `rider_country_name` | `text` | Rider nationality name. |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `stage_key` | `integer` | Surrogate key from `dw.dim_stage`. |
| `stage_id` | `integer` | Stage number (`1..21`). |
| `stage_order` | `integer` | Chronological stage order (`1..21`). |
| `stage_name` | `text` | Formatted `'Stage N: Start -> Finish'`. |
| `stage_type` | `text` | `'flat'`, `'hilly'`, `'mountain'`, or `'individual time-trial'`. |
| `stage_date` | `date` | Calendar date of the stage (`dw.dim_date.full_date`). |
| `race_week` | `integer` | Race week (`1`, `2`, or `3`). |
| `distance_km` | `numeric(6,2)` | Stage distance in km. |
| `finish_rank` | `integer` | Stage finish rank (ties permitted). |
| `stage_finisher_count` | `integer` | Global number of riders who finished this stage. |
| `finish_time_seconds` | `integer` | Raw stage finish time in seconds. |
| `time_bonus_seconds` | `integer` | Stage bonus seconds (`>= 0`). |
| `time_penalty_seconds` | `integer` | Stage penalty seconds (`>= 0`). |
| `adjusted_time_seconds` | `integer` | `finish_time_seconds - time_bonus_seconds + time_penalty_seconds`. |
| `gap_seconds` | `integer` | Raw stage gap to stage winner: `finish_time_seconds - MIN(finish_time_seconds) OVER (PARTITION BY stage_key)`. |
| `adjusted_gap_seconds` | `integer` | Adjusted stage gap: `adjusted_time_seconds - MIN(adjusted_time_seconds) OVER (PARTITION BY stage_key)`. |
| `stage_points_proxy` | `integer` | Points classification proxy points earned on this stage (`0..50`). |
| `kom_points_proxy` | `integer` | KOM classification proxy points earned on this stage (`0..20`). |
| `rank_percentile` | `numeric(5,2)` | Global stage percentile: `(stage_finisher_count - finish_rank) * 100.0 / NULLIF(stage_finisher_count - 1, 0)`. |
| `finished_race_flag` | `integer` | `1` if the rider completed all 21 stages, `0` otherwise. |
| `exit_flag` | `integer` | `1` if the rider exited the race, `0` otherwise. |
| `participation_status` | `text` | `'finished'` or `'exited'`. |

---

### 3.4 `dw.stage_summary(p_filters jsonb DEFAULT '{}'::jsonb)`

Returns exactly one row per stage with route endpoints, distance, date, race week, finisher count, and stage winner summary. Pre-aggregates `dw.fact_results` by `stage_key` before joining `dw.dim_stage` so `SUM(distance_km)` across returned rows never duplicates stage distances.

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `stage_key` | `integer` | Surrogate key from `dw.dim_stage`. |
| `stage_id` | `integer` | Stage ID (`1..21`). |
| `stage_order` | `integer` | Stage chronological order (`1..21`). |
| `stage_name` | `text` | `'Stage N: Start -> Finish'`. |
| `stage_date` | `date` | Stage calendar date. |
| `race_week` | `integer` | Race week (`1..3`). |
| `stage_type` | `text` | `'flat'`, `'hilly'`, `'mountain'`, or `'individual time-trial'`. |
| `distance_km` | `numeric(6,2)` | Stage distance in kilometres (un-duplicated). |
| `start_location_name` | `text` | Start city/location name. |
| `start_country_code` | `varchar(3)` | Start country ISO-3 code. |
| `start_country_name` | `text` | Start country name. |
| `finish_location_name` | `text` | Finish city/location name. |
| `finish_country_code` | `varchar(3)` | Finish country ISO-3 code. |
| `finish_country_name` | `text` | Finish country name. |
| `route_description` | `text` | `'Start (CC) -> Finish (CC)'`. |
| `finisher_count` | `integer` | Number of riders who finished the stage. |
| `winner_rider_key` | `integer` | `rider_key` of the stage winner (`finish_rank = 1`). |
| `winner_bib_number` | `integer` | Bib number of the stage winner. |
| `winner_rider_name` | `text` | Name of the stage winner. |
| `winner_team_name` | `text` | Team name of the stage winner. |
| `winning_finish_time_seconds` | `integer` | Minimum raw finish time in seconds on the stage. |
| `winning_adjusted_time_seconds` | `integer` | Minimum adjusted finish time in seconds on the stage. |

---

### 3.5 `dw.country_participation(p_filters jsonb DEFAULT '{}'::jsonb)`

Compares the role-playing country dimension (`dw.dim_country`) across **rider nationality** (`rider_country_key`) and **team registration country** (`team_country_key`) using `dw.fact_participation`.
- Includes the full known country universe (`country_key > 0 AND country_code <> 'UNK'`), including countries with `0` riders and/or `0` teams.
- When `rider_count = 0`, keeps `rider_count = 0` and `team_count` as an integer (`0` when no teams), while returning `finisher_rate = NULL` (not `0.0000`) to avoid representing a zero-rider sample as `0%` finisher performance.
- Excludes `'UNK'` (`country_key = 0`) from the country rows so unknown nationality does not appear as a country, while preserving `#78 Aleksandr Vlasov`'s team contribution under his team's registration country (`team_country_key`).

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `country_key` | `integer` | Surrogate key from `dw.dim_country` (`> 0`). |
| `country_code` | `varchar(3)` | 3-letter country code. |
| `country_name` | `text` | Country name. |
| `rider_count` | `integer` | Number of participating riders of this nationality (`SUM(rider_count) = 183` unfiltered). |
| `team_count` | `integer` | Number of distinct participating teams registered in this country (`SUM(team_count) = 23` unfiltered). |
| `finisher_count` | `integer` | Number of race finishers (`finished_race_flag = 1`) of this nationality. |
| `finisher_rate` | `numeric(6,4)` | Ratio `finisher_count / rider_count` in `[0.0000, 1.0000]`, or `NULL` when `rider_count = 0`. |

---

### 3.6 `dw.rider_specialisation(p_filters jsonb DEFAULT '{}'::jsonb)`

Aggregates rider performance by `stage_type` to evaluate Stage Type specialisation (Pivot analysis). Global stage rank percentiles and stage winner gaps are computed per stage prior to filtering.

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `rider_key` | `integer` | Surrogate key from `dw.dim_rider`. |
| `bib_number` | `integer` | Official rider bib number. |
| `rider_name` | `text` | Rider full name. |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `is_young_rider` | `boolean` | Young rider flag. |
| `stage_type` | `text` | `'flat'`, `'hilly'`, `'mountain'`, or `'individual time-trial'`. |
| `avg_rank_percentile` | `numeric(5,2)` | Mean stage `rank_percentile` (`0..100`) for this stage type. |
| `top10_ratio` | `numeric(6,4)` | Ratio of top-10 stage finishes to `sample_count` (`0.0000..1.0000`). |
| `top10_count` | `integer` | Count of top-10 stage finishes (`finish_rank <= 10`) for this stage type. |
| `win_count` | `integer` | Count of stage wins (`finish_rank = 1`) for this stage type. |
| `mean_gap_seconds` | `numeric(10,2)` | Average stage time gap in seconds to the stage winner for this stage type (respects `time_basis`). |
| `sample_count` | `integer` | Number of stages of this `stage_type` completed by the rider. |

---

### 3.7 `dw.team_depth(p_filters jsonb DEFAULT '{}'::jsonb)`

Evaluates team competitiveness and roster depth by separately aggregating `dw.fact_results` and `dw.fact_participation` by `team_key` and joining them via the conformed dimension `dw.dim_team` (preventing fact-to-fact fanout).

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `wins` | `integer` | Count of stage finishes with `finish_rank = 1`. |
| `podiums` | `integer` | Count of stage finishes with `finish_rank <= 3`. |
| `top10_finishes` | `integer` | Total rider-stage finishes with `finish_rank <= 10`. |
| `top10_stages` | `integer` | Count of distinct stages where at least one team member finished in the top 10. |
| `selected_stage_count` | `integer` | Total number of stages in the selected scope (`21` by default). |
| `top10_stage_coverage` | `numeric(6,4)` | `top10_stages / selected_stage_count` (`0.0000..1.0000`). |
| `top10_distinct_riders` | `integer` | Count of distinct riders on the team who achieved at least one top-10 stage finish. |
| `finishers` | `integer` | Number of team riders who finished the entire race (`SUM(finished_race_flag)` from `dw.fact_participation`). |
| `participants` | `integer` | Number of starting riders on the team (`SUM(participant_count)` from `dw.fact_participation`). |
| `finisher_rate` | `numeric(6,4)` | `finishers / participants` (`0.0000..1.0000`). |

---

### 3.8 `dw.gc_evolution(p_filters jsonb DEFAULT '{}'::jsonb)`

Tracks stage-by-stage cumulative GC progression (Worm Chart / Decisive Stages analysis).
- **Default Cohort**: When neither `rider_keys` nor `team_keys` is passed, selects the **fixed Final GC Top 5 competitors** (completed all 21 stages, ordered by 21-stage cumulative time ascending).
- **Selected Riders & Exited Rider Retention**: When `rider_keys` or `team_keys` is passed, includes those riders and **retains riders who later exit the race** for every stage cutoff `1..S` they completed.
- **Cutoff Eligibility**: At each stage cutoff $S$ (`stage_order = S`), contemporaneous ranking eligibility requires completing all stages `1..S`.
- **Contemporaneous Leader**: Under `rank_scope = 'overall'` (default), `leader_cumulative_seconds` and `cumulative_gap_seconds` at stage $S$ are measured against the overall dataset leader across all riders who completed stages `1..S`.

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `stage_key` | `integer` | Surrogate key from `dw.dim_stage`. |
| `stage_id` | `integer` | Stage number (`1..21`). |
| `stage_order` | `integer` | Chronological stage order (`1..21`). |
| `stage_date` | `date` | Stage calendar date. |
| `race_week` | `integer` | Race week (`1..3`). |
| `stage_type` | `text` | Stage Type (`flat`, `hilly`, `mountain`, or `individual time-trial`). This is not a terrain-only field: Stages 5 and 13 are Individual Time Trials. |
| `rider_key` | `integer` | Surrogate key from `dw.dim_rider`. |
| `bib_number` | `integer` | Official rider bib number. |
| `rider_name` | `text` | Rider full name. |
| `team_key` | `integer` | Surrogate key from `dw.dim_team`. |
| `team_name` | `text` | Team name. |
| `is_young_rider` | `boolean` | Young rider flag. |
| `stage_seconds` | `integer` | Single-stage time in seconds (per `time_basis`). |
| `cumulative_seconds` | `integer` | Cumulative time in seconds across stages `1..S`. |
| `leader_cumulative_seconds` | `integer` | Contemporaneous leader's cumulative time in seconds at stage $S$. |
| `cumulative_rank` | `integer` | Contemporaneous GC rank at stage $S$ via `RANK()`. |
| `cumulative_gap_seconds` | `integer` | `cumulative_seconds - leader_cumulative_seconds` at stage $S$. |
| `stage_net_change_seconds` | `integer` | Change in `cumulative_gap_seconds` from stage $S-1$ to stage $S$ (`< 0` = gained time on leader, `> 0` = lost time). |
| `stage_gap_seconds` | `integer` | Single-stage time gap to the stage winner (`stage_seconds - stage_winner_seconds`). |
| `time_bonus_seconds` | `integer` | Time bonus seconds earned on stage $S$. |
| `time_penalty_seconds` | `integer` | Time penalty seconds incurred on stage $S$. |
| `net_bonus_penalty_seconds` | `integer` | `time_penalty_seconds - time_bonus_seconds` on stage $S$ (net time added by bonuses/penalties). |
| `cumulative_bonus_seconds` | `integer` | Cumulative bonus seconds across stages `1..S`. |
| `cumulative_penalty_seconds` | `integer` | Cumulative penalty seconds across stages `1..S`. |
| `cumulative_net_bonus_penalty_seconds` | `integer` | Cumulative `time_penalty_seconds - time_bonus_seconds` across stages `1..S`. |
| `time_basis` | `text` | Echoes `'adjusted'` or `'finish'`. |

---

### 3.9 `dw.olap_rollup` (View)

Demonstrates explicit SQL `GROUP BY ROLLUP ((team_key, team_name), stage_type)` over `dw.fact_results`, producing three aggregation levels in a single view:
- `'team_stage_type'` (`team_grouping = 0, stage_type_grouping = 0`)
- `'team_total'` (`team_grouping = 0, stage_type_grouping = 1`)
- `'grand_total'` (`team_grouping = 1, stage_type_grouping = 1`)

#### Returned Columns

| Column | Type | Description |
| --- | --- | --- |
| `team_key` | `integer` | `dw.dim_team.team_key` (`NULL` on `grand_total` row). |
| `team_name` | `text` | Team name, or `'ALL TEAMS'` on `grand_total` row. |
| `stage_type` | `text` | Stage type, or `'ALL STAGE TYPES'` on `team_total` and `grand_total` rows. |
| `team_grouping` | `integer` | `GROUPING(dt.team_key)` (`0` or `1`). |
| `stage_type_grouping` | `integer` | `GROUPING(ds.stage_type)` (`0` or `1`). |
| `rollup_level` | `text` | `'team_stage_type'`, `'team_total'`, or `'grand_total'`. |
| `result_rows` | `integer` | Count of `fact_results` rows (`3602` at `grand_total`). |
| `distinct_riders` | `integer` | Count of distinct riders. |
| `distinct_stages` | `integer` | Count of distinct stages. |
| `total_finish_time_seconds` | `bigint` | Sum of raw finish times in seconds. |
| `total_adjusted_time_seconds` | `bigint` | Sum of adjusted finish times in seconds. |
| `total_stage_points_proxy` | `integer` | Sum of stage points proxy. |
| `total_kom_points_proxy` | `integer` | Sum of KOM points proxy. |
| `stage_wins` | `integer` | Count of stage wins (`finish_rank = 1`). |
| `podium_finishes` | `integer` | Count of stage podiums (`finish_rank <= 3`). |
| `top10_finishes` | `integer` | Count of top-10 stage finishes (`finish_rank <= 10`). |
| `avg_rank_percentile` | `numeric(5,2)` | Average stage rank percentile (`0..100`). |
