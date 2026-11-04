#!/usr/bin/env python3
"""Project 4 benchmark runner comparing normalized (tdf) vs. star-schema (dw) SQL queries.

Features:
- Connects via psycopg using DBDSN_FILE (or DB_DSN_FILE) or DATABASE_URL environment
  variables without printing or persisting any credentials/secrets.
- Enforces read-only transactions for all queries and EXPLAIN executions.
- Runs only the 3 owned fixed query pairs under sql/benchmarks/.
- Verifies exact result equivalence first (including Decimal and NULL normalization)
  and aborts immediately on any column, row-count, or cell mismatch.
- Warms up each query once, then executes at least 7 alternating pair repeats of
  EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).
- Extracts plan max depth and join operator counts (Hash Join, Merge Join, Nested Loop)
  from the plan tree while reading Shared Hit/Read Blocks strictly from the top Plan
  node to avoid parent-child double counting.
- Computes simple text complexity metrics (non-comment lines, JOIN tokens, CTE count)
  explicitly labelled as simple text counts rather than a formal SQL parser.
- Writes JSON and concise Markdown reports under build/benchmark/.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import statistics
import sys
from typing import Any, Sequence


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SQL_BENCHMARK_DIR = PROJECT_ROOT / "sql" / "benchmarks"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "build" / "benchmark"
MIN_REPEATS = 7
DEFAULT_MAX_STAGE = 21


class BenchmarkInequalityError(ValueError):
    """Raised when normalized and star benchmark queries produce different outputs."""


@dataclass(frozen=True)
class BenchmarkPairSpec:
    """Specification for a fixed normalized vs. star SQL benchmark pair."""

    pair_id: str
    title: str
    description: str
    normalized_sql_relpath: str
    star_sql_relpath: str
    supports_max_stage_param: bool = False

    @property
    def normalized_sql_path(self) -> Path:
        return PROJECT_ROOT / self.normalized_sql_relpath

    @property
    def star_sql_path(self) -> Path:
        return PROJECT_ROOT / self.star_sql_relpath


BENCHMARK_PAIRS: tuple[BenchmarkPairSpec, ...] = (
    BenchmarkPairSpec(
        pair_id="q1_gc_final",
        title="Query 1: Final Rider Adjusted GC Ranking and Country Roles",
        description=(
            "Complete 21-stage finishers ranked by cumulative adjusted time (RANK with ties), "
            "resolving team name, rider nationality name (preserving NULL / mapping dw UNK to NULL), "
            "and team registration country name."
        ),
        normalized_sql_relpath="sql/benchmarks/q1_gc_final_normalized.sql",
        star_sql_relpath="sql/benchmarks/q1_gc_final_star.sql",
        supports_max_stage_param=False,
    ),
    BenchmarkPairSpec(
        pair_id="q2_team_stage_top3",
        title="Query 2: Full-Race Team Classification (stage_top3 Rule)",
        description=(
            "Per-stage top-3 rider adjusted times summed across all 21 stages for teams with "
            "at least 3 finishers per stage, including registration country and distinct top-3 "
            "contributor count with deterministic (adjusted_time_seconds ASC, bib_number ASC) tie-break."
        ),
        normalized_sql_relpath="sql/benchmarks/q2_team_stage_top3_normalized.sql",
        star_sql_relpath="sql/benchmarks/q2_team_stage_top3_star.sql",
        supports_max_stage_param=True,
    ),
    BenchmarkPairSpec(
        pair_id="q3_terrain_route",
        title="Query 3: Rider & Team Terrain and Route Endpoint Country Performance",
        description=(
            "Rider performance grouped by stage_type and start/finish country names: completed stages, "
            "summed adjusted time, top-10 stage finishes, and average finish speed (km/h, rounded to "
            "4 decimal places)."
        ),
        normalized_sql_relpath="sql/benchmarks/q3_terrain_route_normalized.sql",
        star_sql_relpath="sql/benchmarks/q3_terrain_route_star.sql",
        supports_max_stage_param=False,
    ),
)

COUNT_TABLES: tuple[str, ...] = (
    "tdf.country",
    "tdf.team",
    "tdf.rider",
    "tdf.location",
    "tdf.stage",
    "tdf.result",
    "tdf.exit",
    "dw.dim_country",
    "dw.dim_team",
    "dw.dim_rider",
    "dw.dim_stage",
    "dw.dim_date",
    "dw.fact_results",
    "dw.fact_participation",
)


def resolve_dsn(dsn_file_arg: str | None = None) -> tuple[str, str]:
    """Resolve database connection string from CLI file or environment without leaking secrets.

    Returns:
        Tuple of (dsn_string, source_label) where source_label is a safe identifier
        such as 'cli:--dsn-file', 'env:DBDSN_FILE', 'env:DB_DSN_FILE', or 'env:DATABASE_URL'.
    """
    if dsn_file_arg:
        path = Path(dsn_file_arg).expanduser()
        if not path.is_file():
            raise RuntimeError("Configured --dsn-file does not exist or is not a regular file.")
        dsn = path.read_text(encoding="utf-8").strip()
        if not dsn:
            raise RuntimeError("Configured --dsn-file is empty.")
        return dsn, "cli:--dsn-file"

    for env_file_key in ("DBDSN_FILE", "DB_DSN_FILE"):
        env_file_val = os.environ.get(env_file_key, "").strip()
        if env_file_val:
            path = Path(env_file_val).expanduser()
            if not path.is_file():
                raise RuntimeError(f"Environment variable {env_file_key} points to a missing file.")
            dsn = path.read_text(encoding="utf-8").strip()
            if not dsn:
                raise RuntimeError(f"File referenced by {env_file_key} is empty.")
            return dsn, f"env:{env_file_key}"

    env_url = os.environ.get("DATABASE_URL", "").strip()
    if env_url:
        return env_url, "env:DATABASE_URL"

    raise RuntimeError(
        "No database connection configured. Set DBDSN_FILE (or DATABASE_URL) in the environment "
        "or pass --dsn-file."
    )


def sha256_text(text: str) -> str:
    """Compute hex SHA-256 digest of UTF-8 text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    """Compute hex SHA-256 digest of a file on disk."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parameterize_sql(sql_text: str, max_stage: int = DEFAULT_MAX_STAGE) -> str:
    """Apply optional stage-scope parameter to SQL queries containing /*MAX_STAGE_ID*/ marker."""
    if not (1 <= int(max_stage) <= 21):
        raise ValueError(f"max_stage must be an integer between 1 and 21, got {max_stage!r}")
    return re.sub(
        r"/\*MAX_STAGE_ID\*/\s*\d+",
        f"/*MAX_STAGE_ID*/ {int(max_stage)}",
        sql_text,
    )


def strip_sql_comments(sql_text: str) -> str:
    """Strip SQL block comments (/* ... */) and line comments (-- ...) for text metrics."""
    without_block = re.sub(r"/\*.*?\*/", " ", sql_text, flags=re.DOTALL)
    without_line = re.sub(r"--[^\n\r]*", "", without_block)
    return without_line


def compute_sql_text_complexity(sql_text: str) -> dict[str, Any]:
    """Compute simple lexical/text complexity counts for a SQL query.

    Explicitly labelled as simple text counts rather than a formal SQL parser.
    """
    cleaned = strip_sql_comments(sql_text)
    non_comment_lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    join_tokens = re.findall(r"\bJOIN\b", cleaned, flags=re.IGNORECASE)

    has_with = bool(re.search(r"^\s*WITH\b", cleaned, flags=re.IGNORECASE | re.MULTILINE))
    cte_matches = (
        re.findall(
            r"(?:\bWITH\b|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(",
            cleaned,
            flags=re.IGNORECASE,
        )
        if has_with
        else []
    )

    return {
        "measurement_method": "simple_text_counts_not_formal_parser",
        "non_comment_line_count": len(non_comment_lines),
        "join_token_count": len(join_tokens),
        "cte_count": len(cte_matches),
    }


def normalize_cell(value: Any) -> dict[str, Any]:
    """Normalize a single database cell value into a canonical typed structure.

    Ensures:
    - SQL NULL (None) is distinct from literal strings 'NULL' or 'UNK'.
    - Decimal / numeric values normalize trailing zeros (e.g., Decimal('41.5000') -> '41.5').
    - Integer and boolean types remain distinct.
    """
    if value is None:
        return {"type": "null", "value": None}
    if isinstance(value, bool):
        return {"type": "bool", "value": value}
    if isinstance(value, int):
        return {"type": "int", "value": value}
    if isinstance(value, Decimal):
        if value.is_nan():
            return {"type": "decimal", "value": "NaN"}
        normalized = Decimal(0) if value == 0 else value.normalize()
        return {"type": "decimal", "value": format(normalized, "f")}
    if isinstance(value, float):
        dec = Decimal(str(value))
        normalized = Decimal(0) if dec == 0 else dec.normalize()
        return {"type": "decimal", "value": format(normalized, "f")}
    if isinstance(value, str):
        return {"type": "str", "value": value}
    return {"type": type(value).__name__, "value": str(value)}


def normalize_rows(rows: Sequence[Sequence[Any]]) -> list[list[dict[str, Any]]]:
    """Normalize a sequence of result rows into canonical cell dictionaries."""
    return [[normalize_cell(cell) for cell in row] for row in rows]


def _row_sort_key(normalized_row: Sequence[dict[str, Any]]) -> tuple[tuple[str, str], ...]:
    """Create a deterministic total-order sort key for a normalized row."""
    key_parts: list[tuple[str, str]] = []
    for cell in normalized_row:
        cell_type = str(cell["type"])
        raw_val = cell["value"]
        if raw_val is None:
            val_str = ""
        elif cell_type == "int":
            val_str = f"{int(raw_val):024d}"
        elif cell_type == "decimal":
            dec = Decimal(str(raw_val))
            val_str = f"{dec:024.8f}"
        else:
            val_str = str(raw_val)
        key_parts.append((cell_type, val_str))
    return tuple(key_parts)


def compute_result_sha256(columns: Sequence[str], normalized_rows: Sequence[Sequence[dict[str, Any]]]) -> str:
    """Compute deterministic SHA-256 digest over column names and sorted normalized rows."""
    sorted_rows = sorted(normalized_rows, key=_row_sort_key)
    payload = {
        "columns": list(columns),
        "rows": sorted_rows,
    }
    canonical_json = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return sha256_text(canonical_json)


def compare_query_results(
    normalized_columns: Sequence[str],
    normalized_raw_rows: Sequence[Sequence[Any]],
    star_columns: Sequence[str],
    star_raw_rows: Sequence[Sequence[Any]],
    pair_id: str = "unknown_pair",
) -> dict[str, Any]:
    """Compare normalized and star query outputs for exact equivalence.

    Raises BenchmarkInequalityError if columns, row counts, sorted normalized rows,
    or row ordering differ.
    """
    norm_cols = list(normalized_columns)
    star_cols = list(star_columns)
    if norm_cols != star_cols:
        raise BenchmarkInequalityError(
            f"[{pair_id}] Column mismatch between normalized and star queries: "
            f"{norm_cols} != {star_cols}"
        )

    if len(normalized_raw_rows) != len(star_raw_rows):
        raise BenchmarkInequalityError(
            f"[{pair_id}] Row count mismatch: normalized={len(normalized_raw_rows)}, "
            f"star={len(star_raw_rows)}"
        )

    norm_rows = normalize_rows(normalized_raw_rows)
    star_rows = normalize_rows(star_raw_rows)

    norm_sorted = sorted(norm_rows, key=_row_sort_key)
    star_sorted = sorted(star_rows, key=_row_sort_key)

    if norm_sorted != star_sorted:
        first_diff_idx = next(
            (idx for idx, (lhs, rhs) in enumerate(zip(norm_sorted, star_sorted)) if lhs != rhs),
            0,
        )
        raise BenchmarkInequalityError(
            f"[{pair_id}] Sorted result value mismatch at sorted row {first_diff_idx}: "
            f"normalized={norm_sorted[first_diff_idx]} vs star={star_sorted[first_diff_idx]}"
        )

    if norm_rows != star_rows:
        first_order_idx = next(
            (idx for idx, (lhs, rhs) in enumerate(zip(norm_rows, star_rows)) if lhs != rhs),
            0,
        )
        raise BenchmarkInequalityError(
            f"[{pair_id}] Row ordering mismatch at row {first_order_idx}: "
            f"normalized={norm_rows[first_order_idx]} vs star={star_rows[first_order_idx]}"
        )

    norm_sha = compute_result_sha256(norm_cols, norm_rows)
    star_sha = compute_result_sha256(star_cols, star_rows)

    return {
        "passed": True,
        "column_names": norm_cols,
        "row_count": len(norm_rows),
        "normalized_result_sha256": norm_sha,
        "star_result_sha256": star_sha,
    }


def build_alternating_schedule(repeats: int = MIN_REPEATS) -> list[dict[str, Any]]:
    """Build warmup + alternating pair execution schedule.

    Warmup runs each variant once ('normalized', 'star'), followed by `repeats`
    alternating pair repeats ('normalized', 'star', 'normalized', 'star', ...).
    """
    if repeats < 1:
        raise ValueError(f"repeats must be >= 1, got {repeats}")

    schedule: list[dict[str, Any]] = [
        {"phase": "warmup", "repeat": 0, "variant": "normalized"},
        {"phase": "warmup", "repeat": 0, "variant": "star"},
    ]
    for repeat_idx in range(1, repeats + 1):
        schedule.append({"phase": "measured", "repeat": repeat_idx, "variant": "normalized"})
        schedule.append({"phase": "measured", "repeat": repeat_idx, "variant": "star"})
    return schedule


def extract_plan_metrics(explain_payload: Any) -> dict[str, Any]:
    """Extract structural, buffer, and timing metrics from EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).

    Important:
    - Buffer counters (Shared Hit/Read/Dirtied/Written Blocks, Temp Read/Written Blocks) in
      PostgreSQL EXPLAIN JSON are already cumulative at each parent node. They are therefore
      extracted strictly from the top-level `Plan` node and NEVER summed across child nodes.
    - Plan depth and join operator counts (Hash Join, Merge Join, Nested Loop) are derived
      by traversing the `Plan` tree.
    """
    if isinstance(explain_payload, str):
        parsed = json.loads(explain_payload)
    else:
        parsed = explain_payload

    if isinstance(parsed, list):
        if not parsed:
            raise ValueError("EXPLAIN JSON list is empty.")
        doc = parsed[0]
    elif isinstance(parsed, dict):
        doc = parsed
    else:
        raise ValueError(f"Unexpected EXPLAIN JSON root type: {type(parsed).__name__}")

    if "Plan" not in doc or not isinstance(doc["Plan"], dict):
        raise ValueError("EXPLAIN JSON document is missing top-level 'Plan' object.")

    top_plan = doc["Plan"]

    # Buffer metrics strictly from top_plan (cumulative across the entire execution plan tree)
    shared_hit_blocks = int(top_plan.get("Shared Hit Blocks", 0))
    shared_read_blocks = int(top_plan.get("Shared Read Blocks", 0))
    shared_dirtied_blocks = int(top_plan.get("Shared Dirtied Blocks", 0))
    shared_written_blocks = int(top_plan.get("Shared Written Blocks", 0))
    temp_read_blocks = int(top_plan.get("Temp Read Blocks", 0))
    temp_written_blocks = int(top_plan.get("Temp Written Blocks", 0))

    node_type_counts: dict[str, int] = {}
    hash_join_count = 0
    merge_join_count = 0
    nested_loop_count = 0
    total_plan_nodes = 0

    def _walk_plan(node: dict[str, Any]) -> int:
        nonlocal hash_join_count, merge_join_count, nested_loop_count, total_plan_nodes
        total_plan_nodes += 1
        node_type = str(node.get("Node Type", "Unknown"))
        node_type_counts[node_type] = node_type_counts.get(node_type, 0) + 1

        if node_type == "Hash Join":
            hash_join_count += 1
        elif node_type == "Merge Join":
            merge_join_count += 1
        elif node_type == "Nested Loop":
            nested_loop_count += 1

        children = node.get("Plans") or []
        if not children:
            return 1
        return 1 + max(_walk_plan(child) for child in children)

    plan_max_depth = _walk_plan(top_plan)
    planning_time_ms = float(doc.get("Planning Time", 0.0))
    execution_time_ms = float(doc.get("Execution Time", 0.0))

    return {
        "planning_time_ms": planning_time_ms,
        "execution_time_ms": execution_time_ms,
        "total_time_ms": planning_time_ms + execution_time_ms,
        "plan_max_depth": plan_max_depth,
        "total_plan_nodes": total_plan_nodes,
        "root_node_type": str(top_plan.get("Node Type", "Unknown")),
        "hash_join_count": hash_join_count,
        "merge_join_count": merge_join_count,
        "nested_loop_count": nested_loop_count,
        "total_join_operators": hash_join_count + merge_join_count + nested_loop_count,
        "shared_hit_blocks": shared_hit_blocks,
        "shared_read_blocks": shared_read_blocks,
        "shared_dirtied_blocks": shared_dirtied_blocks,
        "shared_written_blocks": shared_written_blocks,
        "temp_read_blocks": temp_read_blocks,
        "temp_written_blocks": temp_written_blocks,
        "buffer_extraction_scope": "top_plan_only_no_parent_child_double_count",
        "node_type_counts": node_type_counts,
    }


def summarize_variant_runs(run_records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate repeated EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) runs using medians."""
    if not run_records:
        raise ValueError("Cannot summarize empty run_records.")

    planning_times = [float(r["metrics"]["planning_time_ms"]) for r in run_records]
    execution_times = [float(r["metrics"]["execution_time_ms"]) for r in run_records]
    total_times = [float(r["metrics"]["total_time_ms"]) for r in run_records]
    shared_hits = [int(r["metrics"]["shared_hit_blocks"]) for r in run_records]
    shared_reads = [int(r["metrics"]["shared_read_blocks"]) for r in run_records]

    representative = run_records[0]["metrics"]

    return {
        "measured_run_count": len(run_records),
        "median_planning_time_ms": round(float(statistics.median(planning_times)), 4),
        "median_execution_time_ms": round(float(statistics.median(execution_times)), 4),
        "median_total_time_ms": round(float(statistics.median(total_times)), 4),
        "min_execution_time_ms": round(min(execution_times), 4),
        "max_execution_time_ms": round(max(execution_times), 4),
        "plan_max_depth": int(representative["plan_max_depth"]),
        "total_plan_nodes": int(representative["total_plan_nodes"]),
        "root_node_type": representative["root_node_type"],
        "hash_join_count": int(representative["hash_join_count"]),
        "merge_join_count": int(representative["merge_join_count"]),
        "nested_loop_count": int(representative["nested_loop_count"]),
        "total_join_operators": int(representative["total_join_operators"]),
        "median_shared_hit_blocks": int(statistics.median_low(shared_hits)),
        "median_shared_read_blocks": int(statistics.median_low(shared_reads)),
        "buffer_extraction_scope": representative["buffer_extraction_scope"],
        "node_type_counts": representative["node_type_counts"],
        "runs": list(run_records),
    }


def _fetch_query_output(cur: Any, sql_text: str) -> tuple[list[str], list[tuple[Any, ...]]]:
    """Execute a SELECT statement and return (column_names, rows)."""
    cur.execute(sql_text)
    columns = [desc.name for desc in (cur.description or [])]
    rows = [tuple(row) for row in cur.fetchall()]
    return columns, rows


def _run_explain_json(cur: Any, sql_text: str) -> dict[str, Any]:
    """Execute EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and return the root explain dict."""
    explain_sql = f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n{sql_text}"
    cur.execute(explain_sql)
    row = cur.fetchone()
    if not row:
        raise RuntimeError("EXPLAIN returned no rows.")
    payload = row[0]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if isinstance(payload, list):
        return payload[0]
    if isinstance(payload, dict):
        return payload
    raise RuntimeError(f"Unexpected EXPLAIN payload type: {type(payload).__name__}")


def collect_db_metadata(cur: Any) -> dict[str, Any]:
    """Collect PostgreSQL server version and row counts for tdf and dw tables."""
    cur.execute("SHOW server_version;")
    server_version = str(cur.fetchone()[0])

    cur.execute("SELECT version();")
    full_version = str(cur.fetchone()[0])

    table_counts: dict[str, int] = {}
    for table_name in COUNT_TABLES:
        schema_name, rel_name = table_name.split(".", 1)
        cur.execute(f"SELECT COUNT(*) FROM {schema_name}.{rel_name};")
        table_counts[table_name] = int(cur.fetchone()[0])

    return {
        "server_version": server_version,
        "full_version": full_version,
        "table_row_counts": table_counts,
    }


def format_markdown_summary(report: dict[str, Any]) -> str:
    """Render a concise Markdown summary report from the benchmark results dictionary."""
    lines: list[str] = [
        "# Project 4 Benchmark Summary: Normalized (`tdf`) vs. Star Schema (`dw`)",
        "",
        "## 1. Execution Metadata & Protocol",
        "",
        f"- **Generated At (UTC)**: `{report['generated_at_utc']}`",
        f"- **PostgreSQL Version**: `{report['environment']['postgres_server_version']}`",
        f"- **Python / psycopg**: `{report['environment']['python_version']}` / `{report['environment']['psycopg_version']}`",
        f"- **Connection Source**: `{report['environment']['dsn_source']}` (read-only transaction, credentials redacted)",
        f"- **Stage Scope (`max_stage_id`)**: `{report['benchmark_protocol']['max_stage_id']}`",
        f"- **Warmup & Repeats**: `{report['benchmark_protocol']['warmup_runs_per_query']}` warmup per query + `{report['benchmark_protocol']['measured_repeats_per_pair']}` alternating pair repeats of `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`",
        "- **Cache Condition Note**: Both schemas reside in the same PostgreSQL instance and are measured using warmed alternating repeats without pruning OS or PostgreSQL shared buffer caches (no controlled cold-cache claim).",
        "",
        "## 2. Result Equivalence & SQL Text Complexity",
        "",
        "> **Note on SQL Complexity Counts**: `Non-Comment Lines`, `JOIN Tokens`, and `CTE Count` are simple lexical/text counts on comment-stripped SQL (`simple_text_counts_not_formal_parser`), not formal AST parser metrics.",
        "",
        "| Pair ID | Rows | Exact Match | Result SHA-256 (prefix) | Norm Lines / JOINs / CTEs | Star Lines / JOINs / CTEs |",
        "| --- | ---: | :---: | --- | :---: | :---: |",
    ]

    for pair in report["pairs"]:
        eq = pair["equivalence_check"]
        c_norm = pair["complexity_comparison"]["normalized"]
        c_star = pair["complexity_comparison"]["star"]
        sha_short = eq["normalized_result_sha256"][:16]
        lines.append(
            f"| `{pair['pair_id']}` | {eq['row_count']} | `{eq['passed']}` | `{sha_short}...` | "
            f"{c_norm['non_comment_line_count']} / {c_norm['join_token_count']} / {c_norm['cte_count']} | "
            f"{c_star['non_comment_line_count']} / {c_star['join_token_count']} / {c_star['cte_count']} |"
        )

    lines.extend(
        [
            "",
            "## 3. Execution Plan Structure & Median Timing Comparison",
            "",
            "> **Note on Buffer Counts**: `Shared Hit` and `Shared Read` blocks are taken strictly from the top-level `Plan` node (`top_plan_only_no_parent_child_double_count`) because PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` parent nodes already include child buffer counts.",
            "",
            "| Pair ID | Schema | Median Plan (ms) | Median Exec (ms) | Median Total (ms) | Plan Depth | Joins (Hash/Merge/NL) | Top-Plan Shared Hit / Read |",
            "| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |",
        ]
    )

    for pair in report["pairs"]:
        for variant_label, variant_key in (("Normalized (`tdf`)", "normalized"), ("Star (`dw`)", "star")):
            perf = pair["performance_comparison"][variant_key]
            joins_str = (
                f"{perf['total_join_operators']} "
                f"({perf['hash_join_count']}/{perf['merge_join_count']}/{perf['nested_loop_count']})"
            )
            buffers_str = f"{perf['median_shared_hit_blocks']} / {perf['median_shared_read_blocks']}"
            lines.append(
                f"| `{pair['pair_id']}` | {variant_label} | "
                f"{perf['median_planning_time_ms']:.4f} | "
                f"{perf['median_execution_time_ms']:.4f} | "
                f"{perf['median_total_time_ms']:.4f} | "
                f"{perf['plan_max_depth']} | {joins_str} | {buffers_str} |"
            )

    lines.extend(
        [
            "",
            "## 4. Source SQL File Hashes (SHA-256)",
            "",
            "| Pair ID | Variant | Relative Path | SHA-256 |",
            "| --- | --- | --- | --- |",
        ]
    )

    for pair in report["pairs"]:
        for variant_key in ("normalized", "star"):
            src = pair["source_files"][variant_key]
            lines.append(
                f"| `{pair['pair_id']}` | `{variant_key}` | `{src['relpath']}` | `{src['sha256']}` |"
            )

    lines.extend(
        [
            "",
            "## 5. Interpretation Notes",
            "",
            "- With 3,602 stage result rows (184 riders across 21 stages), both schemas fit comfortably in PostgreSQL shared buffers; sub-millisecond or low-millisecond runtime differences can fluctuate with scheduler jitter and should be interpreted alongside structural plan metrics (`plan_max_depth`, join operator counts, and top-plan buffer hits).",
            "- Denormalized attributes in `dw.dim_stage` (Query 3) and precomputed `adjusted_time_seconds` + `fact_participation.finished_race_flag` in `dw` (Queries 1–3) reduce join chain depth and repeated arithmetic expressions at the cost of controlled storage redundancy and ETL maintenance.",
            "",
        ]
    )
    return "\n".join(lines)


def run_benchmarks(
    repeats: int = MIN_REPEATS,
    max_stage: int = DEFAULT_MAX_STAGE,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    dsn_file: str | None = None,
) -> dict[str, Any]:
    """Execute the full benchmark suite against PostgreSQL and write reports."""
    if repeats < MIN_REPEATS:
        raise ValueError(f"Benchmark protocol requires at least {MIN_REPEATS} repeats, got {repeats}.")
    if not (1 <= max_stage <= 21):
        raise ValueError(f"max_stage must be between 1 and 21, got {max_stage}.")

    import psycopg

    dsn, dsn_source = resolve_dsn(dsn_file)

    with psycopg.connect(dsn) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY;")
            db_meta = collect_db_metadata(cur)

            pair_reports: list[dict[str, Any]] = []
            for spec in BENCHMARK_PAIRS:
                if not spec.normalized_sql_path.is_file():
                    raise FileNotFoundError(f"Missing SQL file: {spec.normalized_sql_path}")
                if not spec.star_sql_path.is_file():
                    raise FileNotFoundError(f"Missing SQL file: {spec.star_sql_path}")

                raw_norm_sql = spec.normalized_sql_path.read_text(encoding="utf-8")
                raw_star_sql = spec.star_sql_path.read_text(encoding="utf-8")

                effective_norm_sql = (
                    parameterize_sql(raw_norm_sql, max_stage=max_stage)
                    if spec.supports_max_stage_param
                    else raw_norm_sql
                )
                effective_star_sql = (
                    parameterize_sql(raw_star_sql, max_stage=max_stage)
                    if spec.supports_max_stage_param
                    else raw_star_sql
                )

                # Step 1: Execute both queries and verify exact result equality before timing
                norm_cols, norm_rows = _fetch_query_output(cur, effective_norm_sql)
                star_cols, star_rows = _fetch_query_output(cur, effective_star_sql)
                equivalence = compare_query_results(
                    norm_cols,
                    norm_rows,
                    star_cols,
                    star_rows,
                    pair_id=spec.pair_id,
                )

                # Step 2: Build warmup + alternating schedule and run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                schedule = build_alternating_schedule(repeats=repeats)
                sql_by_variant = {
                    "normalized": effective_norm_sql,
                    "star": effective_star_sql,
                }
                measured_runs: dict[str, list[dict[str, Any]]] = {
                    "normalized": [],
                    "star": [],
                }
                warmup_runs: dict[str, dict[str, Any]] = {}

                for step_index, step in enumerate(schedule, start=1):
                    variant = step["variant"]
                    raw_plan = _run_explain_json(cur, sql_by_variant[variant])
                    metrics = extract_plan_metrics(raw_plan)
                    run_entry = {
                        "step_index": step_index,
                        "phase": step["phase"],
                        "repeat": step["repeat"],
                        "variant": variant,
                        "metrics": metrics,
                        "raw_plan_json": raw_plan,
                    }
                    if step["phase"] == "warmup":
                        warmup_runs[variant] = run_entry
                    else:
                        measured_runs[variant].append(run_entry)

                pair_reports.append(
                    {
                        "pair_id": spec.pair_id,
                        "title": spec.title,
                        "description": spec.description,
                        "source_files": {
                            "normalized": {
                                "relpath": spec.normalized_sql_relpath,
                                "sha256": sha256_file(spec.normalized_sql_path),
                            },
                            "star": {
                                "relpath": spec.star_sql_relpath,
                                "sha256": sha256_file(spec.star_sql_path),
                            },
                        },
                        "equivalence_check": equivalence,
                        "complexity_comparison": {
                            "measurement_method": "simple_text_counts_not_formal_parser",
                            "normalized": compute_sql_text_complexity(effective_norm_sql),
                            "star": compute_sql_text_complexity(effective_star_sql),
                        },
                        "execution_schedule": schedule,
                        "warmup_runs": warmup_runs,
                        "performance_comparison": {
                            "normalized": summarize_variant_runs(measured_runs["normalized"]),
                            "star": summarize_variant_runs(measured_runs["star"]),
                        },
                    }
                )

    report: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "psycopg_version": getattr(psycopg, "__version__", "unknown"),
            "postgres_server_version": db_meta["server_version"],
            "postgres_full_version": db_meta["full_version"],
            "dsn_source": dsn_source,
            "readonly_transaction": True,
        },
        "table_row_counts": db_meta["table_row_counts"],
        "benchmark_protocol": {
            "warmup_runs_per_query": 1,
            "measured_repeats_per_pair": repeats,
            "alternating_pair_order": True,
            "max_stage_id": max_stage,
            "cache_condition": "same_database_instance_warmed_alternating_repeats_no_cold_cache_claim",
            "buffer_metric_rule": "top_plan_only_no_parent_child_double_count",
            "complexity_metric_rule": "simple_text_counts_not_formal_parser",
        },
        "pairs": pair_reports,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "benchmark_results.json"
    md_path = output_dir / "benchmark_summary.md"

    json_path.write_text(json.dumps(report, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    md_path.write_text(format_markdown_summary(report), encoding="utf-8")

    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for benchmark runner."""
    parser = argparse.ArgumentParser(
        description=(
            "Run Project 4 normalized (tdf) vs. star-schema (dw) SQL benchmarks "
            "using read-only transactions and EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)."
        )
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=MIN_REPEATS,
        help=f"Number of alternating measured EXPLAIN repeats per pair (minimum and default: {MIN_REPEATS}).",
    )
    parser.add_argument(
        "--max-stage",
        type=int,
        default=DEFAULT_MAX_STAGE,
        help=f"Stage upper bound (1..21) for Query 2 team stage_top3 scope (default: {DEFAULT_MAX_STAGE}).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory under which benchmark_results.json and benchmark_summary.md are saved.",
    )
    parser.add_argument(
        "--dsn-file",
        type=str,
        default=None,
        help="Optional path to a file containing the PostgreSQL DSN (overrides DBDSN_FILE / DATABASE_URL).",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint."""
    args = parse_args(argv)
    report = run_benchmarks(
        repeats=args.repeats,
        max_stage=args.max_stage,
        output_dir=args.output_dir,
        dsn_file=args.dsn_file,
    )
    print(
        f"Completed {len(report['pairs'])} benchmark pairs with {args.repeats} alternating repeats each. "
        f"Reports written to {args.output_dir / 'benchmark_results.json'} and "
        f"{args.output_dir / 'benchmark_summary.md'}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
