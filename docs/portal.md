# P1 Local Analytics Portal Reference (`web/`)

This document describes the **P1 FastAPI + HTML Local Analytics Portal** for the **Tour de France 2025 OLAP System**. The portal wraps the **P0 Metabase 5-Tab Native Dashboard** via server-side Static Signed Embedding (`HS256` JWT) and provides an independent, 3-level **Team → Rider → Stage** interactive OLAP drill-down panel alongside a direct module explorer backed by the shared PostgreSQL `dw` analytical layer.

---

## 1. Architecture & Design Principles

1. **Single Source of Truth (`dw` Star Schema)**:
   - Both the P0 Metabase dashboard and the P1 FastAPI portal query the exact same PostgreSQL 18 functions in `sql/003_analytics.sql` (`dw.rider_standings`, `dw.team_standings`, `dw.rider_stage_results`, `dw.stage_summary`, `dw.country_participation`, `dw.rider_specialisation`, `dw.team_depth`, `dw.gc_evolution`).
   - Ranking (`RANK()`), top-3 team selection (`ROW_NUMBER()`), percentiles, and proxy point totals are **never** re-implemented in Python or JavaScript.
2. **Server-Side Security & Read-Only Database Access**:
   - Database connections use the read-only role `tdf_reader` via `psycopg` with `conn.read_only = True`, read-only transactions, and bounded session timeouts (`SET LOCAL statement_timeout = 10000`, `SET LOCAL lock_timeout = 5000`).
   - All analytical function calls use a static SQL whitelist (`ALLOWLISTED_ANALYTICS_SQL`) and pass user filters strictly as a single bound `psycopg.types.json.Jsonb` parameter (`%s`).
   - Metabase Static Signed Embedding tokens are signed exclusively on the server (`HS256`, 10-minute expiration, fixed `resource: {"dashboard": <MB_DASHBOARD_ID>}`, `params: {}`). Neither `DATABASE_URL` nor `MB_EMBEDDING_SECRET_KEY` is ever exposed in HTTP responses, logs, or frontend assets.
3. **Offline-Friendly Startup & Dependency Injection**:
   - `create_app(settings=None, query_runner=None)` initializes without opening any database or network connections at import/startup time.
   - Missing embedding credentials produce a helpful HTTP `503` JSON payload on `GET /api/embed` while keeping the P0 native dashboard link and direct warehouse explorer operational.

---

## 2. Server Environment Configuration

| Variable | Fallback File Variable | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | `DATABASE_URL_FILE` | `None` | PostgreSQL connection string for read-only role `tdf_reader` (e.g. `postgresql://tdf_reader:...@127.0.0.1:5432/tour_de_france`). |
| `MB_EMBEDDING_SECRET_KEY` | `MB_EMBEDDING_SECRET_KEY_FILE` | `None` | Metabase Static Embedding secret key (64-hex string configured in Metabase Admin → Settings → Embedding). |
| `MB_URL` | — | `http://127.0.0.1:3000` | Base URL of the local Metabase OSS instance. |
| `MB_DASHBOARD_ID` | — | `None` | Integer ID of the published P0 Metabase dashboard (required for `GET /api/embed`). |
| `MB_TABS_JSON` | — | `None` | Optional JSON object mapping tab labels/keys (`"Tab 1: Executive & Race Overview"`, etc.) to integer/string Metabase tab IDs. |
| `STATEMENT_TIMEOUT_MS` | — | `10000` | Per-query PostgreSQL `statement_timeout` in milliseconds. |

---

## 3. HTTP & JSON API Reference

### 3.1 `GET /` and `/static/*`
Serves the light editorial HTML portal (`web/static/index.html`, `web/static/styles.css`, `web/static/app.js`). Uses system fonts only with zero external CDN requests.

### 3.2 `GET /api/health`
Returns public readiness flags (`database_configured`, `embed_configured`), the native P0 dashboard URL (`p0_dashboard_url`), the 5-tab descriptors (`tabs`), and `allowed_analytics`. Never exposes secret values or file paths.

### 3.3 `GET /api/embed`
Generates a signed Metabase dashboard embed URL:
- **JWT Payload**:
  ```json
  {
    "resource": {"dashboard": 1},
    "params": {},
    "iat": 1762140000,
    "exp": 1762140600
  }
  ```
- **Filter Parity & Repeated / CSV Array Parameters**:
  - Forwards all common app filters supported by the Metabase dashboard (`stage_scope`, `as_of_stage`, `stage_ids`, `stage_types`, `time_basis`, `rank_scope`, `team_keys`, `rider_keys`, `young_only`) after strict validation (`422` on invalid values).
  - Accepts both repeated array query parameters (`?stage_ids=4&stage_ids=14&team_keys=20&team_keys=22`) and comma-separated (CSV) array values (`?stage_ids=5,13&team_keys=20,22&stage_types=mountain,individual+time-trial`), forwarding validated array items via `urlencode(..., doseq=True)` while preserving explicit empty array selections (`?stage_ids=`) distinct from omitted keys.
  - Excludes `team_aggregation` (P0 side-by-side team cards use fixed aggregation rules) and ignores unknown query parameters.
- **Single-Pass Canonical Tab Resolution**:
  - The frontend passes canonical tab keys (`tab_1_overview` .. `tab_5_insights`), which the server resolves in a single pass against `MB_TABS_JSON` without colliding with numeric 1..5 index keys (e.g. when `1->4, 2->5, 3->6, 4->7, 5->8`, `tab_2_classifications` resolves to `5` and is never re-mapped to `8`). When `MB_TABS_JSON` is unconfigured, no fake `tab=` parameter is appended.
- **Automatic Pre-Expiry Refresh**:
  - The frontend schedules a single cancellable timer (`clearTimeout` before `setTimeout`) to refresh the signed embed URL ~9 minutes into the 10-minute token lifetime using the active filter and tab state, retrying gracefully on transient errors without accumulating timers.
- **Security**: Client attempts to pass `?dashboard_id=...` or `?resource=...` are rejected with HTTP `422`.
- **Missing Configuration**: If `MB_EMBEDDING_SECRET_KEY` (or `_FILE`) or `MB_DASHBOARD_ID` is not set, returns HTTP `503` with `missing_config`, `p0_dashboard_url`, and `tabs`.

### 3.4 `GET /api/metadata`
Queries conformed dimensions (`dw.dim_team`, `dw.dim_rider` + `dw.fact_participation`, `dw.stage_summary('{}'::jsonb)`, `dw.dim_country`) to populate UI filter controls:
- `teams`: 23 participating teams with registration country and finisher counts.
- `riders`: 184 participating riders (1 row per rider from `dw.fact_participation`, preserving `#78 Aleksandr Vlasov` with `rider_country_code = 'UNK'`).
- `stages`: 21 stages with `dropdown_label` formatted as `Stage 1 · 2025-07-05 · flat · 184.9 km · Lille -> Lille`.
- `countries`: Known countries (`country_key > 0 AND country_code <> 'UNK'`).

### 3.5 `POST /api/analytics/{name}`
Executes one of the 8 allowlisted `dw` analytical table functions using `SELECT * FROM dw.<name>(%s)` with a single bound `Jsonb` parameter:
1. `rider_standings`
2. `team_standings`
3. `rider_stage_results`
4. `stage_summary`
5. `country_participation`
6. `rider_specialisation`
7. `team_depth`
8. `gc_evolution`

#### Validated Filter Schema (`AnalyticsFilters`)
- `stage_scope`: `'final' | 'as_of' | 'selection'`
- `as_of_stage`: integer in `1..21`
- `stage_ids`: list of integers in `1..21`
- `stage_types`: list of `'flat' | 'hilly' | 'mountain' | 'individual time-trial'`
- `time_basis`: `'adjusted' | 'finish'`
- `rank_scope`: `'overall' | 'filtered'`
- `team_keys`: list of positive integers (`>= 1`)
- `rider_keys`: list of positive integers (`>= 1`)
- `young_only`: boolean (`true | false`)
- `classification`: `'gc' | 'young' | 'points_proxy' | 'kom_proxy' | 'mountain_time'`
- `team_aggregation`: `'stage_top3' | 'cumulative_top3'`

**Validation & Serialization Semantics**:
- Invalid enum strings, out-of-range stage numbers (`< 1` or `> 21`), wrong types, or unknown extra keys return HTTP `422`.
- Omitted keys and explicit `null` values are excluded from the bound `Jsonb` payload so PostgreSQL defaults apply.
- Explicit empty arrays `[]` are preserved in the bound `Jsonb` payload (returning 0 rows rather than falling back to all rows).
- PostgreSQL `Decimal` values are serialized as JSON floats, `date` values as ISO-8601 strings (`YYYY-MM-DD`), and `NULL` values (`gap_seconds` on proxy points classifications, `finisher_rate` on 0-rider countries) as JSON `null`.

### 3.6 `POST /api/team/{team_key}/riders` (and `GET /api/team/{team_key}/riders`)
Supports Step 2 of the independent **Team → Rider → Stage** drill panel:
- Queries `dw.fact_participation` (grain: 1 row per starting rider) for `team_key` and left-joins pre-aggregated `dw.rider_stage_results` over the active stage scope.
- Includes **all starting team members including later exits** without fact-to-fact fanout.
- Preserves `#78 Aleksandr Vlasov` (`rider_country_code = 'UNK'`, `rider_country_name = 'Unknown / Unspecified'`).
- Labels incomplete/exited riders' time sums as **available-stage contributions only** (`contribution_label`), never full-race GC.
- Clicking any rider in the UI subsequently calls `POST /api/analytics/rider_stage_results` with `rider_keys: [rider_key]` to display stage-by-stage ranks (including ties), raw/adjusted times, bonuses, penalties, and proxy points.

### 3.7 `POST /api/country/{country_code}/members` (and `GET /api/country/{country_code}/members`)
Supports the **Explore → Country Participation → Country Union-Member Detail** drill:
- Strictly validates `country_code` as a 3-letter uppercase ASCII alpha code and rejects `'UNK'`, `'NULL'`, or malformed codes with HTTP `422` before any SQL is executed.
- Executes bound read-only SQL (`COUNTRY_MEMBERS_SQL`, parameters `(country_code, Jsonb(filters))`) over `dw.dim_country`, `dw.fact_participation`, `dw.dim_rider`, and `dw.dim_team`, applying active `team_keys`, `rider_keys`, and `young_only` filters.
- Returns one row per union member (`fp.rider_country_key = tc_target.country_key OR fp.team_country_key = tc_target.country_key`) with zero duplicate rows and explicit role classification:
  - `role_code = 'rider_nationality'` (`Rider Nationality`)
  - `role_code = 'team_registration'` (`Team Registration`)
  - `role_code = 'both'` (`Rider Nationality & Team Registration`)
- Returns `summary` breakdown counts (`union_member_count`, `rider_national_count`, `registered_team_member_count`, `registered_team_count`, `both_roles_count`, `rider_nationality_only_count`, `team_registration_only_count`, `finisher_count`, `exited_count`). At default scope, France (`FRA`) returns `51` union members (`38` nationals and `40` riders across `5` French-registered teams, with `27` overlapping in `both`), and `UAE` returns `8` registered-team riders and `0` nationals.
- Preserves `#78 Aleksandr Vlasov` (`rider_country_code = 'UNK'`) when drilling into his team's registration country (`GER` for Red Bull – BORA – hansgrohe) and preserves riders who exited before Stage 21 (`finished_race_flag = 0`).

---

## 4. Interactive Explore Drills, Pagination, Accessibility & URL Deep-Link Contract

### 4.1 Terrain Specialisation Pagination (`rider_specialisation`)
- All `715` rows returned by `dw.rider_specialisation` under default scope are accessible without silent truncation.
- Displays top and bottom pagination bars with visible displayed/total count (`Showing 1–100 of 715 rows`), a page-size selector (`50`, `100` default, `250`, `All (715)`), `First`, `Prev`, `Next`, `Last`, and `Show All (715)` buttons.
- Resets/clamps the active page whenever filters change and preserves row-level rider trajectory drill actions on every page.

### 4.2 Explore Stage Summary → Stage Result Detail (`stage_summary`)
- Clicking any stage row in **Explore → Stage Summary** opens a titled Stage Result Detail view (`Stage <id> Results: <route> · <count> Stage Results`) and automatically scrolls/focuses its heading (`#explore-stage-detail-heading`).
- Queries shared `dw.rider_stage_results` with `{ "stage_scope": "selection", "stage_ids": [<stage_id>] }` plus active `time_basis`, `team_keys`, `rider_keys`, and `young_only` filters so the clicked stage is never lost due to `final`/`as_of` scope or terrain checkboxes (Stage 5 returns all `179` stage finishers under default filters).
- Displays stage metadata (date, week, terrain, distance, displayed/total finisher count, time basis) and formatted finish/adjusted times, gaps, bonuses/penalties, and proxy points.
- Clicking any rider row opens their stage-by-stage trajectory in Step 3 of the expandable Inspector, and clicking `← Back to Stage Summary` restores the 21-stage summary table.

### 4.3 Explore Country Participation → Country Union-Member Detail (`country_participation`)
- Clicking any country row in **Explore → Country Participation** opens a titled Country Member Detail view (`Country Member Detail: <name> (<code>) · <count> Union Members`) via `POST /api/country/{country_code}/members` and scrolls/focuses `#explore-country-detail-heading`.
- Distinguishes `Rider Nationality`, `Team Registration`, and `Rider Nationality & Team Registration` (`both`) with role chips and a header summary strip.
- Clicking a member's team button opens the full team roster in Step 2 of the Inspector; clicking a rider button or row opens the rider's stage trajectory in Step 3 of the Inspector; clicking `← Back to Country Participation` returns to the country summary table.
- Gracefully renders a zero-member empty state when filters narrow a valid country to 0 members and a clear warning state for unknown/invalid country codes (including `UNK`).

### 4.4 Automatic Target Scroll/Focus, Keyboard Accessibility & Return Navigation
- **Target-Specific Scroll & Focus**:
  - Team drills (from Overview Team Standings, Explore Team Standings, Explore Team Depth, Country Member team buttons, or `?drill=team`) scroll to and focus the populated **Team Roster** heading (`#drill-roster-heading` / `#drill-roster-step`) after async data renders.
  - Rider drills (from Overview Standings, Explore Individual Standings, Stage Results, Country Members, Terrain Specialisation, GC Evolution, Team Roster, or `?drill=rider`) scroll to and focus the populated **Rider Stage-by-Stage Results** heading (`#drill-rider-heading` / `#drill-rider-step`) after async data renders.
- **Keyboard & Screen-Reader Accessibility**:
  - Interactive table rows include `tabindex="0"`, `role="button"`, `aria-label`, and `Enter`/`Space` key handlers alongside explicit `<button type="button" class="table-link-btn">` elements.
- **Return & Clear Controls**:
  - `#drill-back-btn` (`← Back to ...`) and `#drill-clear-btn` (`Clear Inspector`) return focus and scroll position to the originating Explore module, Stage Detail, Country Detail, or Overview section without leaving stale detail state.

### 4.5 Validated URL Deep-Link Contract & Multi-Selection Pills
After metadata loads on startup, the portal parses and validates `window.location.search` against allowlisted views, modules, drills, enums, stage IDs (`1..21`), and known team/rider/country keys:
- **Drill Deep Links**:
  - `?drill=stage&stage_id=5` → switches to Explore `stage_summary` and opens Stage 5 Results (`179` rows).
  - `?drill=country&country_code=FRA` → switches to Explore `country_participation` and opens France (`FRA`) Union Member Detail (`51` union members).
  - `?drill=team&team_key=21` → loads Team `#21` roster in Step 2 of the Inspector and focuses `#drill-roster-heading`.
  - `?drill=rider&rider_key=1&team_key=21` (or `?drill=rider&rider_key=1`, auto-resolving `team_key` from metadata) → loads Team `#21` roster and Rider `#1` stage trajectory in Step 3 of the Inspector and focuses `#drill-rider-heading`.
- **View & Module Deep Links**:
  - `?view=explore&module=stage_summary&stage_scope=selection&stage_types=mountain` → opens Explore `stage_summary` filtered to mountain stages.
- **Shared Filter Keys & Multi-Value Arrays**:
  - Supports `stage_scope` (`final` | `as_of` | `selection`), `as_of_stage` (`1..21`), `time_basis` (`adjusted` | `finish`), `rank_scope` (`overall` | `filtered`), `team_aggregation` (`stage_top3` | `cumulative_top3`), `young_only` (`true` | `false` | `1` | `0`), `classification`, `tab`, and array filters `stage_ids`, `stage_types`, `team_keys`, and `rider_keys`.
  - Array filters accept both repeated query parameters (`?team_keys=20&team_keys=22`) and comma-separated values (`?team_keys=20,22&stage_ids=5,13`).
  - On startup detail URLs, blank template values such as `team_keys=` mean unset; literal `team_keys=[]` is an explicit empty selection. This differs from the internal `/api/embed` empty-array serialization: do not change that API convention.
  - Team comparison links also accept the display labels `Per-stage Top 3` and `Cumulative Top 3`, normalizing them to `stage_top3` and `cumulative_top3`.
  - Multiple selected teams, riders, and stages are rendered as removable pills (`#selected-teams-pills`, `#selected-riders-pills`, `#selected-stages-pills`) and forwarded in full to both `/api/analytics/*` and `/api/embed`.
- **Safe Invalid-Link Handling**:
  - Malformed or unknown URL parameters never execute code, evaluate URLs, or redirect; they display a dismissible notice in `#deeplink-feedback-banner` and fall back to safe default state (or show the explicit invalid stage/country state box when `drill=stage` or `drill=country` has an invalid target).

---

## 5. Documented Numeric Units

| Function / Endpoint | Metric Columns | Unit & Interpretation |
| --- | --- | --- |
| `rider_standings` | `total_seconds`, `gap_seconds`, `points`, `rank`, `rank_percentile` | `total_seconds` / `gap_seconds`: seconds (`HH:MM:SS` in UI; `gap_seconds` is `null` for `points_proxy` and `kom_proxy`). `points`: non-official proxy points (`integer`). `rank`: ordinal competition rank via SQL `RANK()`. `rank_percentile`: `0.00..100.00%`. |
| `team_standings` | `total_seconds`, `gap_seconds`, `stage_count`, `contributor_count`, `rank` | `total_seconds` / `gap_seconds`: seconds. `stage_count`: stages in scope. `contributor_count`: distinct contributing riders (`3` for `cumulative_top3`, `>= 3` for `stage_top3`). |
| `rider_stage_results` | `distance_km`, `finish_rank`, `stage_finisher_count`, `finish_time_seconds`, `time_bonus_seconds`, `time_penalty_seconds`, `adjusted_time_seconds`, `gap_seconds`, `adjusted_gap_seconds`, `stage_points_proxy`, `kom_points_proxy`, `rank_percentile` | `distance_km`: km (`numeric(6,2)`). Times/bonuses/penalties/gaps: seconds. `finish_rank`: stage finish rank (ties preserved). `stage_points_proxy` (`0..50`) & `kom_points_proxy` (`0..20`): derived proxy points. `rank_percentile`: `0.00..100.00%`. |
| `stage_summary` | `distance_km`, `finisher_count`, `winning_finish_time_seconds`, `winning_adjusted_time_seconds` | `distance_km`: km (1 row per stage, never duplicated). `finisher_count`: stage finishers. Winning times: seconds. |
| `country_participation` | `rider_count`, `team_count`, `finisher_count`, `finisher_rate` | Counts: integers (`UNK` excluded from country rows). `finisher_rate`: ratio `0.0000..1.0000` (`null` when `rider_count = 0`). |
| `rider_specialisation` | `avg_rank_percentile`, `top10_ratio`, `top10_count`, `win_count`, `mean_gap_seconds`, `sample_count` | `avg_rank_percentile`: `0.00..100.00%`. `top10_ratio`: `0.0000..1.0000`. `mean_gap_seconds`: seconds. `sample_count`: completed stages on terrain. |
| `team_depth` | `wins`, `podiums`, `top10_finishes`, `top10_stages`, `selected_stage_count`, `top10_stage_coverage`, `top10_distinct_riders`, `finishers`, `participants`, `finisher_rate` | Counts: integers. `top10_stage_coverage` & `finisher_rate`: ratios `0.0000..1.0000`. |
| `gc_evolution` | `stage_seconds`, `cumulative_seconds`, `leader_cumulative_seconds`, `cumulative_gap_seconds`, `stage_net_change_seconds`, `stage_gap_seconds`, `time_bonus_seconds`, `time_penalty_seconds`, `cumulative_rank` | All time/gap/bonus/penalty columns: seconds (`stage_net_change_seconds < 0` means gained time on leader). `cumulative_rank`: contemporaneous SQL `RANK()` at stage $S$. |
| `country_members_drill` | `finished_race_flag`, `exit_flag`, `is_rider_national`, `is_team_registered`, `role_code`, `membership_role` | Flags: `0 | 1` (`boolean` for role flags). `role_code`: `'rider_nationality' | 'team_registration' | 'both'`. `summary` provides integer counts for union members, nationals, registered-team members, and registered teams. |

---

## 6. Deployment and Offline Testing

Use the [standard-package quick start](../README.md#quick-start). The launchers initialize a dedicated Compose deployment and inject the generated database/embedding configuration.

```bash
docker compose run --rm --no-deps portal python -m unittest tests.test_web
```

## Visual A navigation (2026-11-03)

The approved prototype sidebar now opens real modules directly. Global scope controls are under **Filters**; closing without applying restores the previous scope. The home hero and race-context KPIs precede the chart/leader preview and the embedded Metabase canvas. The full-race KPIs do not change with filters; the stage chart follows stage scope and always covers all riders. **Calculation notes** and the Team → Rider → Stage inspector expand on demand. The inspector opens automatically when following a drill. Complete classification columns remain in Explore, and **Full table** carries the selected classification.


## Dedicated Drill Down workspace

Open **06 Drill Down** in the sidebar, or `/?view=drilldown`. Choose Team, Stage terrain, or Country; Country offers separate Team registration and Rider nationality roles. Select rows to descend and use the numbered path or **Up one level** to return. Search and pagination stay within the current level; **Reset path** retains global filters.

The view reuses `/api/metadata`, `/api/analytics/rider_stage_results` and `/api/analytics/team_standings`. It groups existing rows for display without recalculating team rankings or stage finish positions. Available-stage rider totals include exited riders and are not GC. Scope changes preserve valid selected parents and visibly return from excluded branches. Existing legacy team/rider links continue using the original inspector.
