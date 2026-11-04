# Project 4 Benchmark Methodology & Interpretation Guide (`tdf` vs. `dw`)

## 1. Purpose and Fair-Comparison Principles

This document specifies the benchmark methodology, execution commands, metric definitions, and architectural trade-off framework for **Task 4.4** (comparing the Project 2 normalized 3NF/BCNF relational schema `tdf` against the Project 3 star-schema / fact-constellation warehouse `dw`).

> [!IMPORTANT]
> **No Fabricated Pre-Execution Numbers**: Runtime timings (`Planning Time`, `Execution Time`) and live PostgreSQL buffer counters (`Shared Hit Blocks`, `Shared Read Blocks`) are **not** pre-filled in this document before controller execution. All runtime numbers must be read directly from `build/benchmark/benchmark_results.json` and `build/benchmark/benchmark_summary.md` after running `scripts/benchmark.py`.

To ensure an unbiased comparison:
- **Direct Equivalent SQL Only**: Although `dw` provides reusable analytical views and parameterized SQL table functions for the dashboard, the benchmark SQL files under `sql/benchmarks/` query the base tables of `tdf` and `dw` directly. Calling warehouse views or functions would hide `JOIN` tokens, CTE layers, and expression work inside function bodies.
- **Bitwise-Identical Logical Results**: Each normalized/star query pair returns the exact same column names, row ordering, and normalized values (verified automatically before timing).

---

## 2. Benchmark Query Pairs (`sql/benchmarks/`)

| Pair ID | Normalized SQL (`tdf`) | Star Schema SQL (`dw`) | Analytical Scope & Equivalence Rules |
| --- | --- | --- | --- |
| `q1_gc_final` | `sql/benchmarks/q1_gc_final_normalized.sql` | `sql/benchmarks/q1_gc_final_star.sql` | **Final Rider Adjusted GC Ranking (21 Stages)**: Ranks all 160 complete-race finishers using `RANK()` (allowing ties) over cumulative adjusted time (`finish - bonus + penalty`). Outputs `bib_number, rider_name, team_name, rider_country_name, team_country_name, total_seconds, rank`. Normalized uses `LEFT JOIN tdf.country` for nullable rider nationality (`#78 Aleksandr Vlasov`) and `HAVING COUNT(stage_id) = 21`; Star filters `fact_participation.finished_race_flag = 1`, sums precomputed `fact_results.adjusted_time_seconds`, and maps `rc.country_code = 'UNK'` back to SQL `NULL` for exact equality with `tdf`. |
| `q2_team_stage_top3` | `sql/benchmarks/q2_team_stage_top3_normalized.sql` | `sql/benchmarks/q2_team_stage_top3_star.sql` | **Full 21-Stage Team Classification (`stage_top3`)**: Computes official per-stage top-3 rider adjusted time sums across all 21 stages (`team_stage_finishers >= 3` on every stage), outputting `team_name, team_country_name, contributor_count, total_seconds, rank`. Both queries use a deterministic window order `ORDER BY adjusted_time_seconds ASC, bib_number ASC` in `ROW_NUMBER()` so peloton ties on flat stages select the exact same 3 teammates and yield identical `COUNT(DISTINCT bib_number)` (`contributor_count`). Supports optional `--max-stage` CLI override (default `21`). |
| `q3_terrain_route` | `sql/benchmarks/q3_terrain_route_normalized.sql` | `sql/benchmarks/q3_terrain_route_star.sql` | **Rider & Team Terrain and Route Endpoint Country Performance**: Aggregates per rider, team, `stage_type`, `start_country_name`, and `finish_country_name`: completed stages (`stage_count`), `total_adjusted_seconds`, `top10_count`, and `avg_speed_kmh` (`ROUND(AVG((distance_km::NUMERIC / finish_time_seconds::NUMERIC) * 3600.0), 4)`). Normalized requires composite foreign-key joins through `tdf.location` (start/finish) and `tdf.country` (start/finish); Star reads denormalized stage endpoint attributes directly from `dw.dim_stage`. (All 21 stages in the current 2025 CSV dataset have `France` as both start and finish country; no cross-border rows are fabricated.) |

### Static SQL Text Complexity (Simple Lexical Counts)

The table below reports the static lexical counts computed by `compute_sql_text_complexity()` on comment-stripped SQL (`simple_text_counts_not_formal_parser`, not a formal AST parser):

| Pair ID | Variant | Non-Comment SQL Lines | `JOIN` Token Count | CTE Count (`WITH`) | Structural Reason for Difference |
| --- | --- | ---: | ---: | ---: | --- |
| `q1_gc_final` | Normalized (`tdf`) | 29 | 4 | 0 | Snowflaked join chain `result -> rider -> team -> country (tc)` + `LEFT JOIN country (rc)`, computing `finish - bonus + penalty` inline and filtering finishers post-aggregation via `HAVING COUNT(res.stage_id) = 21`. |
| `q1_gc_final` | Star (`dw`) | 35 | 5 | 0 | Star joins from `fact_results` to `fact_participation` (`WHERE finished_race_flag = 1`), `dim_rider`, `dim_team`, and role-playing `dim_country` (`rc`, `tc`), using precomputed `adjusted_time_seconds` and `CASE WHEN rc.country_code = 'UNK' THEN NULL`. |
| `q2_team_stage_top3` | Normalized (`tdf`) | 42 | 4 | 1 | Joins `result -> rider -> team -> country` + `stage`, repeating inline `(finish - bonus + penalty)` arithmetic in `SELECT` and `ROW_NUMBER() OVER (...)`. |
| `q2_team_stage_top3` | Star (`dw`) | 42 | 4 | 1 | Direct star joins from `fact_results` (`team_key`, `team_country_key`, `stage_key`, `rider_key`) using precomputed `fr.adjusted_time_seconds`. |
| `q3_terrain_route` | Normalized (`tdf`) | 46 | 7 | 0 | Requires 7 joins including two composite foreign-key joins to `tdf.location` (`(country_code, location_name)`) and two joins to `tdf.country` to resolve start/finish country names. |
| `q3_terrain_route` | Star (`dw`) | 34 | 3 | 0 | Requires only 3 star joins (`dim_rider`, `dim_team`, `dim_stage`) because route endpoint country names are denormalized into `dw.dim_stage` and `adjusted_time_seconds` is precomputed in `dw.fact_results`. |

---

## 3. Execution

Run from the folder containing `compose.yaml` after the [standard-package startup](../README.md#quick-start).

```bash
docker compose run --rm --no-deps portal python -m unittest tests.test_benchmark
docker compose exec portal python scripts/benchmark.py --dsn-file /run/secrets/reader_database_url --output-dir /tmp/benchmark --repeats 7 --max-stage 21
mkdir -p build/benchmark
docker compose cp portal:/tmp/benchmark/. ./build/benchmark/
```

On PowerShell, use `New-Item -ItemType Directory -Force build/benchmark` to create the output folder. The runner writes `benchmark_results.json` and `benchmark_summary.md`, including result equality, SQL hashes, versions, measured timings, buffers, and query plans. No database credentials are written to these reports.

## 4. Measurement Protocol and Metric Definitions

1. **Read-Only Transaction Enforcement**:
   `scripts/benchmark.py` sets `conn.read_only = True` and executes `SET TRANSACTION READ ONLY;` before running any query.
2. **Pre-Timing Result Equivalence Gate**:
   Before running `EXPLAIN ANALYZE`, both queries in each pair are executed and normalized:
   - SQL `NULL` (`None`) is typed as `{"type": "null", "value": None}`, strictly distinct from strings `"NULL"` or `"UNK"`.
   - `Decimal` values are normalized so equivalent scales (e.g. `41.2500` vs. `41.25`) match deterministically.
   - Any mismatch in column names, row count, sorted values, or row ordering raises `BenchmarkInequalityError` and halts execution immediately.
3. **Warmup + Alternating Pair Repeats (No Cold-Cache Claim)**:
   - Both `tdf` and `dw` reside in the same PostgreSQL database instance; OS page cache and PostgreSQL shared buffers are **not** flushed between queries.
   - Each query pair first runs 1 warmup execution (`normalized`, then `star`), followed by at least 7 alternating measured pair repeats (`normalized, star, normalized, star, ...`). Alternating order ensures any background system drift affects both schemas symmetrically.
4. **Top-Plan Buffer Extraction (Avoiding Double Counting)**:
   - In PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, every parent plan node's `"Shared Hit Blocks"` and `"Shared Read Blocks"` already include the cumulative buffer hits/reads of all its child nodes.
   - Summing buffer fields across all nodes in the plan tree would multiply leaf scan buffer counts by tree depth. Therefore, `extract_plan_metrics()` reads buffer counters **strictly from the root `Plan` node** (`top_plan_only_no_parent_child_double_count`).
5. **Plan Tree Depth and Join Operator Counts**:
   - `plan_max_depth`: Longest root-to-leaf path in the `Plan` tree (root node = depth 1).
   - Join operators: Total occurrences of `"Hash Join"`, `"Merge Join"`, and `"Nested Loop"` across the plan tree.

---

## 5. Engineering Trade-Offs and Interpretation Guidelines

When interpreting the controller-executed results in `build/benchmark/benchmark_summary.md`:

1. **Why Execution Times Can Be Close (or Flip) on 3,602 Rows**:
   - The 2025 Tour de France dataset contains `3,602` rows in `tdf.result` / `dw.fact_results`, `184` riders, `23` teams, and `21` stages. The entire working set occupies only a few dozen 8 KB PostgreSQL pages in shared memory (`Shared Hit Blocks`).
   - At this scale, execution time is typically around single-digit milliseconds, where hash table allocation, sort overhead, or minor CPU scheduling jitter can outweigh saved index/hash probes. For example, in `q1_gc_final`, the star query joins `dw.fact_participation` to filter `finished_race_flag = 1` (5 star joins vs. 4 snowflaked joins in `tdf`), so its wall-clock time need not always be lower than `tdf`.
2. **Where the Star Schema Demonstrates Clear Structural Advantage**:
   - **Denormalized Route Hierarchy (`q3_terrain_route`)**: Resolving start and finish country names in 3NF (`tdf`) requires 7 joins across `result`, `rider`, `team`, `stage`, two role-played `location` tables (composite key `(country_code, location_name)`), and two role-played `country` tables. In `dw`, `dim_stage` denormalizes start/finish location and country attributes, cutting the query to 3 joins, reducing plan tree depth, and simplifying ad-hoc BI SQL authoring.
   - **Precomputed Measures & Unknown Member Integrity**: `dw.fact_results` stores precomputed `adjusted_time_seconds` (avoiding repeated `finish - bonus + penalty` expressions across window functions and aggregations) and uses surrogate key `country_key = 0 ('UNK')` so all fact foreign keys remain `NOT NULL` (`INNER JOIN`-safe for BI tools like Metabase).
   - **Explicit Multi-Grain Fact Constellation (`fact_results` + `fact_participation`)**: Separating stage-result grain (`3,602` rows) from race-participation grain (`184` rows) allows direct filtering on `finished_race_flag = 1` and accurate headcount/completion-rate aggregation without `COUNT(DISTINCT)` over stage rows.
3. **Costs of the Star Schema (`dw`)**:
   - **Storage Redundancy**: Denormalized attributes in `dim_stage` (repeating `'France'` across stage endpoints) and precomputed columns (`adjusted_time_seconds`, proxy points) increase row width compared to 3NF.
   - **ETL & Write-Path Maintenance**: Updates to country names, stage metadata, or rider team assignments require an idempotent ETL refresh (`tdf -> dw`) rather than a single-row normalized update.
