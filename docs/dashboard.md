# Project 3 P0 Native Metabase Dashboard (`Tour de France 2025 OLAP Analytics`)

This document describes the architecture, provisioning workflow, filter semantics, interactive drill-down chains, and card-to-requirement mapping for the P0 native Metabase OLAP dashboard provisioned by `scripts/provision_dashboard.py`.

---

## 1. Provisioned Dashboard

Metabase OSS v0.65.2.5 hosts the **Project 3 OLAP** collection and **Tour de France 2025 OLAP Analytics** dashboard: five tabs, 30 displayed analytical cards, and one supporting pivot-source question. IDs are assigned independently on each installation and recorded in `.runtime/state/metabase-state.json`. The portal reads these mappings automatically.

## 2. Initialization and Verification

Follow the [standard-package quick start](../README.md#quick-start). The container initializer configures the read-only database connection, creates or updates owned objects, and enables signed embedding. It preserves IDs on subsequent runs. Original development-installation guards are scoped separately from fresh deployments.

```bash
# Reconcile the managed dashboard and execute all 31 questions.
docker compose run --rm --no-deps bootstrap python -m deploy.bootstrap --verify

# Offline tests / payload preview; no Metabase credentials required.
docker compose run --rm --no-deps portal python -m unittest tests.test_dashboard
docker compose run --rm --no-deps portal python scripts/provision_dashboard.py --dry-run
```

For an existing external Metabase instance, the provisioner's CLI can accept explicit connection/state paths; do not reuse mappings from another installation. The included launchers are the supported standard-package entry point.

## 3. Global Dashboard Filters & Scope Semantics

### 3.1 Dashboard Parameters & Selector Lookups

| Dashboard Parameter (`id`) | Slug / Template Tag | Label | Widget Type | Default | Dropdown Values / Source |
| --- | --- | --- | --- | --- | --- |
| `param_stage_scope` | `stage_scope` (`tag_stage_scope`) | `Stage Scope` | `string/=` (single) | `"final"` | Static list: `final`, `as_of`, `selection` |
| `param_as_of_stage` | `as_of_stage` (`tag_as_of_stage`) | `As-Of Stage` | `number/=` (single) | `21` | `dw.dim_stage` (`[stage_id, "Stage N: Start -> Finish"]`) |
| `param_stage_ids` | `stage_ids` (`tag_stage_ids`) | `Stage` | `number/=` (multi) | All stages | `dw.dim_stage` (`[stage_id, "Stage N: Start -> Finish (type)"]`) |
| `param_stage_types` | `stage_types` (`tag_stage_types`) | `Stage Terrain` | `string/=` (multi) | All terrains | Static list: `flat`, `hilly`, `mountain`, `individual time-trial` |
| `param_time_basis` | `time_basis` (`tag_time_basis`) | `Time Basis` | `string/=` (single) | `"adjusted"` | Static list: `adjusted`, `finish` |
| `param_rank_scope` | `rank_scope` (`tag_rank_scope`) | `Rank Scope` | `string/=` (single) | `"overall"` | Static list: `overall`, `filtered` |
| `param_team_keys` | `team_keys` (`tag_team_keys`) | `Team` | `number/=` (multi) | All teams | `dw.dim_team` (`[team_key, team_name]`) |
| `param_rider_keys` | `rider_keys` (`tag_rider_keys`) | `Rider` | `number/=` (multi) | All riders | `dw.dim_rider` (`[rider_key, "#bib rider_name"]`) |
| `param_young_only` | `young_only` (`tag_young_only`) | `Young Rider` | `string/=` (single) | All riders | Static list: `true` (`Born >= 2000-01-01`), `false` (`All Riders`) |
| `param_country_code` | `country_code` (`tag_country_code`) | `Country` | `string/=` (single) | All countries | `dw.dim_country` (`[country_code, "Country Name (CODE)"]`, excludes `UNK`) |

### 3.2 Reusable Native SQL Filter Fragment & JDBC `?` Avoidance

Every parameterized native SQL card builds `p_filters jsonb` using `build_filter_jsonb_sql()`:

```sql
jsonb_strip_nulls(jsonb_build_object(
    'stage_scope', COALESCE(NULL::text [[ , NULLIF((ARRAY[{{stage_scope}}]::text[])[1], '') ]], 'final'),
    'as_of_stage', COALESCE(NULL::integer [[ , (ARRAY[{{as_of_stage}}]::integer[])[1] ]]),
    'stage_ids', COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{stage_ids}}]::integer[]) ]]),
    'stage_types', COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{stage_types}}]::text[]) ]]),
    'time_basis', COALESCE(NULL::text [[ , NULLIF((ARRAY[{{time_basis}}]::text[])[1], '') ]], 'adjusted'),
    'rank_scope', COALESCE(NULL::text [[ , NULLIF((ARRAY[{{rank_scope}}]::text[])[1], '') ]], 'overall'),
    'team_keys', COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{team_keys}}]::integer[]) ]]),
    'rider_keys', COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{rider_keys}}]::integer[]) ]]),
    'young_only', COALESCE(NULL::boolean [[ , (NULLIF((ARRAY[{{young_only}}]::text[])[1], ''))::boolean ]])
))
```

Key properties:
1. **Blank Optional Filters Omit JSON Keys**: When an optional filter (`stage_ids`, `stage_types`, `team_keys`, `rider_keys`, `young_only`, `as_of_stage`) is unset, Metabase strips the `[[ ... ]]` block, leaving `COALESCE(NULL::...)` = `NULL`, which `jsonb_strip_nulls(...)` removes so the JSON key is omitted rather than becoming an empty array `[]`.
2. **PostgreSQL JDBC `?` Operator Safety**: In Metabase native SQL queries, PostgreSQL's `?` JSONB key-existence operator (`f ? 'rider_keys'`) is misinterpreted by the JDBC driver as a positional bind placeholder when optional template tags are active. All native SQL cards therefore use `jsonb_exists(f, 'rider_keys')` and `jsonb_exists(f, 'team_keys')` instead of `?`.
3. **Direct Card Query vs. Dashboard Query Parameter IDs**:
   - When calling `POST /api/card/{card_id}/query` directly, pass native template-tag IDs in `parameters` (e.g., `"id": "tag_team_keys"`, `"id": "tag_stage_ids"`).
   - When querying through the dashboard endpoint (`/api/dashboard/{dashboard_id}/dashcard/{dashcard_id}/card/{card_id}/query`), pass dashboard parameter IDs (e.g., `"id": "param_team_keys"`, `"id": "param_stage_ids"`).

### 3.3 Which Global Filters Affect Which Analytical Functions

| Analytical Function / View | `stage_scope` / `as_of_stage` | `stage_ids` / `stage_types` | `time_basis` | `rank_scope` | `team_keys` / `rider_keys` / `young_only` | `country_code` |
| --- | --- | --- | --- | --- | --- | --- |
| `dw.rider_standings` | Yes (`final`=all 21, `as_of`=`1..S`, `selection`=subset) | Only when `stage_scope = 'selection'` | Yes (`adjusted` vs `finish`) | Yes (`overall` vs `filtered`) | Yes | No |
| `dw.team_standings` | Yes (`final`=all 21, `as_of`=`1..S`, `selection`=subset) | Only when `stage_scope = 'selection'` | Yes (`adjusted` vs `finish`) | Yes (`overall` vs `filtered`) | Yes | No |
| `dw.gc_evolution` | Yes (`final`/`as_of`/`selection`) | Only when `stage_scope = 'selection'` | Yes | Yes | Yes (overrides default Final GC Top 5) | No |
| `dw.stage_summary` | `as_of` bounds `stage_order <= S` | Always applied | Returns both raw & adjusted winning times | N/A | N/A | No |
| `dw.rider_stage_results` | `as_of` bounds `stage_order <= S` | Always applied | Returns both raw & adjusted times/gaps | Stage percentile/gap is global per stage | Yes | No |
| `dw.rider_specialisation` | `as_of` bounds `stage_order <= S` | Always applied | Yes (for `mean_gap_seconds`) | Stage percentile/gap is global per stage | Yes | No |
| `dw.team_depth` | `as_of` bounds `stage_order <= S` | Always applied | N/A (rank-based counts) | N/A | Yes | No |
| `dw.country_participation` | Ignored (race-level participation grain) | Ignored | N/A | N/A | Yes | Applied on Tab 4 summary & detail tables |
| `dw.olap_rollup` | Full-race view | `stage_types` applied | Shows both raw & adjusted sums | N/A | `team_keys` applied | No |
| `Rider Terrain Specialisation · Pivot (Full Race)` | Unparameterized full-race teaching card (all 21 stages) | Unmapped | N/A | N/A | Unmapped | No |

---

## 4. Tab-by-Tab Card Catalog & Requirement Mapping

### Tab 1: `Executive & Race Overview` (ID assigned during initialization)

| Slug | Title | Display | Underlying SQL Interface | Click Destination (new portal tab) |
| --- | --- | --- | --- | --- |
| `caption_overview_scope` | *(Markdown Caption)* | `text` | N/A | No-op |
| `overview_kpi_summary` | `Race at a Glance` | `table` | `dw.fact_participation`, `dw.dim_stage`, `dw.stage_summary` | **No-op** (KPI baseline: 184 starters, 160 finishers, 23 teams, 21 stages, unique km) |
| `overview_terrain_distance_bar` | `Distance by Stage Terrain` | `bar` | `dw.stage_summary` | Terrain → Stage Summary (**Step 1 of Stage Terrain -> Stage -> Rider**) |
| `overview_stage_finisher_trend_line` | `Stage Finisher Trend` | `line` | `dw.stage_summary` | Stage → Stage Results |
| `overview_stage_summary_table` | `Stage Routes` | `table` | `dw.stage_summary` | Stage → Stage Results (**Step 2 of Stage Terrain -> Stage -> Rider**) |
| `overview_stage_rider_results_table` | `Stage Rider Results` | `table` | `dw.rider_stage_results` | Rider → Stage Trajectory (**Step 3 of Stage Terrain -> Stage -> Rider**) |

### Tab 2: `Classifications Comparison` (ID assigned during initialization)

> **Nonofficial Proxy Notice**: Both the Tab 2 caption card (`caption_classifications_proxy_notice`) and the `Points — Proxy` / `KOM — Proxy` card descriptions explicitly label `stage_points_proxy` and `kom_points_proxy` as **nonofficial source-derived indices** mapped from `stage_type` and `finish_rank`. All ranking calculations are delegated to `dw.rider_standings(p_filters)`.

| Slug | Title | Display | Underlying SQL Interface | Click Destination (new portal tab) |
| --- | --- | --- | --- | --- |
| `caption_classifications_proxy_notice` | *(Markdown Caption)* | `text` | N/A | No-op |
| `class_gc_table` | `Time Standings · Active Scope` | `table` | `dw.rider_standings` (`gc`) | Rider → Stage Trajectory |
| `class_young_table` | `Young Rider Time · Active Scope` | `table` | `dw.rider_standings` (`young`) | Rider → Stage Trajectory |
| `class_points_proxy_table` | `Points — Proxy` | `table` | `dw.rider_standings` (`points_proxy`) | Rider → Stage Trajectory |
| `class_kom_proxy_table` | `KOM — Proxy` | `table` | `dw.rider_standings` (`kom_proxy`) | Rider → Stage Trajectory |
| `class_mountain_time_comparison` | `Mountain Time vs KOM — Proxy` | `table` | `dw.rider_standings` (`mountain_time`, `kom_proxy`, `gc`) | Rider → Stage Trajectory |
| `class_multi_rider_percentiles_bar` | `Cross-Classification Percentiles` | `bar` | `dw.rider_standings` (all 5 modes) | Rider → Stage Trajectory |

### Tab 3: `Rider & Team Performance` (ID assigned during initialization)

| Slug | Title | Display | Underlying SQL Interface | Click Destination (new portal tab) |
| --- | --- | --- | --- | --- |
| `perf_team_stage_top3_table` | `Team Standings · Per-stage Top 3` | `table` | `dw.team_standings` (`stage_top3`) | Team → Full Roster (**Step 1 of Team -> Rider -> Stage**, left half `col=0`) |
| `perf_team_cumulative_top3_table` | `Team Standings · Cumulative Top 3` | `table` | `dw.team_standings` (`cumulative_top3`) | Team → Full Roster (**Step 1 of Team -> Rider -> Stage**, right half `col=12`) |
| `perf_team_methods_comparison_bar` | `Team Aggregation Comparison` | `bar` | `dw.team_standings` (both methods) | Team → Full Roster |
| `perf_rider_standings_table` | `Rider Cumulative Standings` | `table` | `dw.rider_standings` (`gc`, with `bib_number`) | Rider → Stage Trajectory (**Step 2 of Team -> Rider -> Stage**) |
| `perf_rider_stage_trajectory_line` | `Rider Stage Percentile Trajectory` | `line` | `dw.rider_standings`, `dw.rider_stage_results` | Stage → Stage Results (**Step 3 of Team -> Rider -> Stage**) |
| `perf_rider_stage_detail_table` | `Rider Stage Results` | `table` | `dw.rider_stage_results` (with `bib_number`) | Stage → Stage Results (**Step 3 of Team -> Rider -> Stage**) |

### Tab 4: `Country Participation` (ID assigned during initialization)

| Slug | Title | Display | Underlying SQL Interface | Click Destination (new portal tab) |
| --- | --- | --- | --- | --- |
| `country_overview_kpi_table` | `Participation by Country Overview` | `table` | `dw.fact_participation`, `dw.country_participation` | **No-op** (Preserves `184` total participants = `183` known nationality + `1` `UNK` `#78 Vlasov`) |
| `country_rider_nationality_bar` | `Riders by Nationality` | `bar` | `dw.country_participation` (`rider_count > 0`) | Country → Union Members |
| `country_team_registration_bar` | `Teams by Registration Country` | `bar` | `dw.country_participation` (`team_count > 0`) | Country → Union Members |
| `country_full_universe_table` | `Country Participation Summary` | `table` | `dw.country_participation` (includes 0-count countries) | Country → Union Members |
| `country_rider_team_detail_table` | `Country Rider & Team Details` | `table` | `dw.country_participation` `LEFT JOIN` `dw.fact_participation` | Rider → Stage Trajectory |

### Tab 5: `Deep-Dive Insights` (ID assigned during initialization)

| Slug | Title | Display | Underlying SQL Interface | Click Destination (new portal tab) |
| --- | --- | --- | --- | --- |
| `insight_rider_specialisation_crosstab_table` | `Rider Terrain Specialisation · Cross-Tab` | `table` | `dw.rider_specialisation` (4 terrain columns) | Rider → Stage Trajectory |
| `insight_rider_specialisation_detail_bar` | `Rider Terrain Specialisation · Breakdown` | `bar` | `dw.rider_standings`, `dw.rider_specialisation` | Terrain → Stage Summary |
| `insight_gc_evolution_line` | `GC Gap Evolution` | `line` | `dw.gc_evolution` (default Final GC Top 5) | Stage → Stage Results |
| `insight_gc_evolution_deltas_table` | `GC Stage Deltas & Bonuses` | `table` | `dw.gc_evolution` | Rider → Stage Trajectory |
| `insight_team_depth_bar` | `Team Top-10 Stage Coverage` | `bar` | `dw.team_depth` | Team → Full Roster |
| `insight_team_depth_table` | `Team Competitiveness & Depth` | `table` | `dw.team_depth` | Team → Full Roster |
| `insight_olap_rollup_table` | `Team × Terrain OLAP Roll-Up` | `table` | `dw.olap_rollup` (`GROUP BY ROLLUP`) | **No-op** |
| `insight_rider_specialisation_pivot_source` | `Rider Stage Percentile Source (Pivot Base)` | `table` *(hidden)* | `dw.rider_stage_results()` | **No-op** (Supporting source question) |
| `insight_rider_specialisation_pivot` | `Rider Terrain Specialisation · Pivot (Full Race)` | `pivot` | MBQL Query Builder over `card__<source_id>` (`AVG(rank_percentile)`, `COUNT(*)`) | **No-op** (Full-race teaching card; no global filter mapping) |

---


## 5. Technical Design Notes & Genuine Metabase Limitations

1. **Dual Specialisation Representation (Filterable Native Cross-Tab + Native MBQL Pivot)**:
   - Metabase's `display = "pivot"` renderer requires a structured Query Builder (`type = "query"`) query with aggregations and at least two breakouts; it cannot render a raw `type = "native"` SQL question directly as a Pivot widget.
   - Conversely, a Query Builder question backed by a saved SQL question (`"source-table": "card__<source_id>"`) cannot forward native template-tag JSONB parameters into the underlying SQL function call.
   - To provide both full interactivity and a genuine Metabase Pivot table:
     - **Cross-Tab card (`Rider Terrain Specialisation · Cross-Tab`)** calls `dw.rider_specialisation(p_filters)` in native SQL, pivots the 4 terrain types (`flat`, `hilly`, `mountain`, `individual time-trial`), and responds to all global dashboard filters (`stage_scope`, `as_of_stage`, `stage_ids`, `stage_types`, `time_basis`, `team_keys`, `rider_keys`, `young_only`).
     - **Pivot card (`Rider Terrain Specialisation · Pivot (Full Race)`)** uses Metabase's documented `Saved SQL Question -> Query Builder Aggregation -> Pivot` pattern over the supporting question (`insight_rider_specialisation_pivot_source`: `SELECT rider_key, team_key, bib_number, ('#' || bib_number || ' ' || rider_name) AS rider_label, stage_id, stage_type, rank_percentile FROM dw.rider_stage_results();`) with `AVG(rank_percentile)` and `COUNT(*)` broken out by `rider_label` × `stage_type` and `pivot_table.column_split` configured. It is explicitly labeled and documented as a full-race supplementary card without global filter mappings.
2. **Chart Axis Clarity**:
   - Bar and line charts plot a single unit per axis (`Distance by Stage Terrain` plots `total_distance_km` in km; `Stage Finisher Trend` plots `finisher_count` in riders; `Team Top-10 Stage Coverage` plots `top10_stage_coverage_pct` in `%`), while companion tables display the full multi-unit metric set.
3. **Metadata-Informed Table Formatting & Merged `column_settings`**:
   - During live provisioning (`ensure_cards()` and `ensure_dashboard()`), the provisioner inspects each native table card's `result_metadata` (or `POST /api/card/{id}/query` `data.cols`) and builds `visualization_settings["table.columns"]`.
   - Internal surrogate key columns (`rider_key`, `team_key`, `stage_key`, `country_key`, `winner_rider_key`) are configured with `"enabled": false` in `table.columns` so they are hidden in the table UI while remaining in the query result set as URL source columns (`{{column:rider_key}}`, `{{column:team_key}}`, etc.), whereas official `bib_number`, `stage_id`, and human-readable columns remain `"enabled": true`.
   - Every displayed column receives a clean `column_title` with explicit units (`seconds`, `km`, `%`, `points`) in `visualization_settings["column_settings"]`, and clickable columns merge `"column_title"` and `"click_behavior"` into the same `column_settings['["name","<col>"]']` entry so neither overwrites the other.

4. **Scope-Aware Labels**:
   - The GC and Young Rider cards use “Time Standings · Active Scope” and “Young Rider Time · Active Scope”. The classification caption distinguishes Final (full-race GC), As-Of (Stages 1–S), and Selection (selected-stage performance, not full-race GC).
   - Country cards label `finisher_count` as **Race Finishers**; stage cards keep **Stage Finishers**. The underlying SQL columns and calculations are unchanged.

## 6. Automatic Detail Navigation

Both the native dashboard and its signed static embed use Metabase custom URL click actions (`type: link`, `linkType: url`). Clicking a chart mark or linked dimension label opens the P1 portal in a **new browser tab**, preserves the active analytical filters, and scrolls/focuses the destination heading. Keep the local portal running. Native filter widgets remain available; these click actions open details rather than changing a dashboard filter in place.

| Clicked dimension | Portal destination |
| --- | --- |
| Terrain | `?view=explore&module=stage_summary&stage_scope=selection&stage_types=<terrain>` |
| Stage | `?drill=stage&stage_id=<id>` |
| Rider | `?drill=rider&rider_key=<key>` |
| Team | `?drill=team&team_key=<key>` |
| Country | `?drill=country&country_code=<code>` |

- `--portal-base-url` (or `PORTAL_BASE_URL`) configures the link base; the default is `http://127.0.0.1:8000`. Only HTTP(S) bases without credentials, query strings or fragments are accepted. No embedding JWT or login credential is placed in a detail link.
- URLs forward Stage Scope, As-Of Stage, Stage, Stage Terrain, Time Basis, Rank Scope, Team, Rider, and Young Rider values. Multi-selection values arrive as comma-separated lists. In Metabase 0.65.2.5, filter templates use the **display name**, such as `{{filter:Stage Scope}}` and `{{filter:Team}}`; column templates use raw result-column names.
- A terrain click explicitly selects that terrain and clears conflicting stage IDs/as-of bounds. An explicit stage/rider/team identifies the requested detail. The portal keeps the remaining applicable filters and exposes its current scope.
- Team tables carry their fixed aggregation method. The comparison chart carries the clicked `aggregation_method`; the portal normalizes “Per-stage Top 3” / “Cumulative Top 3” to its two method keys.
- Table links are attached to meaningful labels (rider/bib, team, stage, country) where the matching identifier exists; arbitrary numeric cells do not become navigation buttons. Hidden identifier columns remain available to link templates.
- Country details use the union of rider nationality and team registration, distinguish both roles, and avoid duplicate members. Their team/rider buttons continue into the Inspector. P1 internal drills stay in the same page and provide Back/Clear controls.
- Native Metabase filter changes are not automatically synchronized back to an already-open P1 page. Their current values are carried when a detail link is clicked. The full-race native Pivot remains unparameterized.

Deployment validation: [standard-package checks](standard-package-verification.md).
