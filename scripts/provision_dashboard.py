#!/usr/bin/env python3
"""Idempotent Metabase dashboard provisioner for Project 3 (P0 Native OLAP Dashboard).

Provisions the collection ``Project 3 OLAP``, 30 dashboard analytical cards (plus 1
hidden source question backing the native Metabase Pivot card), and the 5-tab
dashboard ``Tour de France 2025 OLAP Analytics`` against Metabase OSS v0.65.2.5
using only the Python standard library.

Key design guarantees:
- Dry-run payload generation by default (``--dry-run``); live REST API execution
  requires explicit ``--execute``.
- Credentials or session tokens are read exclusively at execution time from
  environment variables or ``--credentials-file PATH`` and are never hardcoded,
  logged, printed, or persisted in ``build/metabase-state.json``.
- Preserves existing installation-check objects (collection 5, dashboard 2,
  card 40) as well as already-deployed Project 3 object IDs in
  ``build/metabase-state.json`` (collection 6, dashboard 3, tabs 4..8, cards 41..71,
  dashcards 38..69), including ``enable_embedding`` and ``embedding_params`` on
  dashboard 3.
- Metadata-informed table formatting hides surrogate ``*_key`` columns via
  ``table.columns`` (``enabled: false``) while preserving them in the underlying
  query results for portal click mappings, and merges human-readable
  ``column_title`` labels (with explicit units: seconds, km, %) alongside
  ``click_behavior`` in ``column_settings``.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:3000"
DEFAULT_PORTAL_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_DATABASE_ID = 2
DEFAULT_COLLECTION_NAME = "Project 3 OLAP"
DEFAULT_COLLECTION_DESCRIPTION = (
    "BT5110 Project 3 Tour de France 2025 Star-Schema OLAP Analytics (P0 Native Dashboard)."
)
DEFAULT_DASHBOARD_NAME = "Tour de France 2025 OLAP Analytics"
DEFAULT_DASHBOARD_DESCRIPTION = (
    "5-tab OLAP analytical dashboard for the 2025 Tour de France. "
    "Note: Points — Proxy and KOM — Proxy are nonofficial source-derived indices "
    "calculated transparently from stage terrain and stage finishing positions."
)
DEFAULT_STATE_PATH = Path("build/metabase-state.json")

# Installation-check objects that must never be modified or deleted.
PROTECTED_COLLECTION_IDS = frozenset({5})
PROTECTED_DASHBOARD_IDS = frozenset({2})
PROTECTED_CARD_IDS = frozenset({40})

# Surrogate key columns hidden in table.columns (enabled=False) while kept in SQL results for click_behavior.
SURROGATE_KEY_COLUMNS = frozenset(
    {
        "rider_key",
        "team_key",
        "stage_key",
        "country_key",
        "winner_rider_key",
    }
)

# Human-readable column titles with explicit units (seconds, km, %, points).
COLUMN_LABELS: Dict[str, str] = {
    # Identifiers & dimensions
    "rank": "Rank",
    "cumulative_rank": "GC Rank",
    "finish_rank": "Finish Rank",
    "mountain_time_rank": "Mountain Time Rank",
    "kom_proxy_rank": "KOM Proxy Rank",
    "gc_rank": "GC Rank",
    "bib_number": "Bib #",
    "winner_bib_number": "Winner Bib #",
    "rider_key": "Rider Key",
    "winner_rider_key": "Winner Rider Key",
    "rider_name": "Rider",
    "winner_rider_name": "Stage Winner",
    "rider_label": "Rider (#Bib & Name)",
    "team_key": "Team Key",
    "team_name": "Team",
    "winner_team_name": "Winning Team",
    "is_young_rider": "Young Rider",
    "stage_key": "Stage Key",
    "stage_id": "Stage",
    "stage_name": "Stage Route",
    "stage_date": "Date",
    "race_week": "Race Week",
    "stage_type": "Stage Terrain",
    "route_description": "Start -> Finish Route",
    "participation_status": "Race Status",
    "classification": "Classification",
    "classification_label": "Classification",
    "time_basis": "Time Basis",
    "team_aggregation": "Team Method",
    "aggregation_method": "Team Aggregation Rule",
    "proxy_notice": "Index Scope",
    "country_key": "Country Key",
    "country_code": "Country Code",
    "country_name": "Country",
    "country_role_profile": "Participation Profile",
    "role_relationship": "Country Role",
    "rider_nationality_code": "Rider Nationality",
    "team_registration_code": "Team Country",
    "rollup_level": "Roll-Up Level",
    # Distances (km)
    "distance_km": "Distance (km)",
    "total_distance_km": "Total Distance (km)",
    "avg_distance_km": "Avg Stage Distance (km)",
    "total_distance_km_unfiltered": "Total Race Distance (km)",
    "distance_km_in_scope": "Selected Scope Distance (km)",
    # Times, gaps, bonuses & penalties (seconds)
    "total_seconds": "Total Time (seconds)",
    "gap_seconds": "Gap to Leader (seconds)",
    "raw_gap_seconds": "Raw Gap to Winner (seconds)",
    "adjusted_gap_seconds": "Adjusted Gap to Winner (seconds)",
    "finish_time_seconds": "Raw Finish Time (seconds)",
    "adjusted_time_seconds": "Adjusted Time (seconds)",
    "time_bonus_seconds": "Bonus (seconds)",
    "time_penalty_seconds": "Penalty (seconds)",
    "winning_finish_time_seconds": "Winning Raw Time (seconds)",
    "winning_adjusted_time_seconds": "Winning Adjusted Time (seconds)",
    "mountain_total_seconds": "Mountain Time (seconds)",
    "mountain_gap_seconds": "Mountain Gap (seconds)",
    "gc_total_seconds": "GC Total Time (seconds)",
    "gc_gap_seconds": "GC Gap (seconds)",
    "stage_seconds": "Stage Time (seconds)",
    "cumulative_seconds": "Cumulative Time (seconds)",
    "leader_cumulative_seconds": "Leader Cumulative Time (seconds)",
    "cumulative_gap_seconds": "Cumulative Gap to Leader (seconds)",
    "stage_net_change_seconds": "Stage Net Gap Change (seconds)",
    "stage_gap_seconds": "Stage Gap to Winner (seconds)",
    "net_bonus_penalty_seconds": "Stage Net Penalty - Bonus (seconds)",
    "cumulative_bonus_seconds": "Cumulative Bonus (seconds)",
    "cumulative_penalty_seconds": "Cumulative Penalty (seconds)",
    "cumulative_net_bonus_penalty_seconds": "Cumulative Net Penalty - Bonus (seconds)",
    "mean_gap_seconds": "Mean Gap to Winner (seconds)",
    "flat_mean_gap_s": "Flat Mean Gap (seconds)",
    "hilly_mean_gap_s": "Hilly Mean Gap (seconds)",
    "mountain_mean_gap_s": "Mountain Mean Gap (seconds)",
    "itt_mean_gap_s": "ITT Mean Gap (seconds)",
    "total_finish_time_seconds": "Total Raw Time (seconds)",
    "total_adjusted_time_seconds": "Total Adjusted Time (seconds)",
    # Percentages & percentiles (%)
    "rank_percentile": "Rank Percentile (%)",
    "avg_rank_percentile": "Mean Rank Percentile (%)",
    "mountain_time_percentile": "Mountain Time Percentile (%)",
    "kom_proxy_percentile": "KOM Proxy Percentile (%)",
    "finisher_rate_pct": "Finisher Rate (%)",
    "country_finisher_rate_pct": "Country Finisher Rate (%)",
    "top10_ratio_pct": "Top-10 Finish Rate (%)",
    "top10_stage_coverage_pct": "Top-10 Stage Coverage (%)",
    "flat_avg_rank_pct": "Flat Mean Percentile (%)",
    "hilly_avg_rank_pct": "Hilly Mean Percentile (%)",
    "mountain_avg_rank_pct": "Mountain Mean Percentile (%)",
    "itt_avg_rank_pct": "ITT Mean Percentile (%)",
    "flat_top10_pct": "Flat Top-10 Rate (%)",
    "hilly_top10_pct": "Hilly Top-10 Rate (%)",
    "mountain_top10_pct": "Mountain Top-10 Rate (%)",
    "itt_top10_pct": "ITT Top-10 Rate (%)",
    # Points & counts
    "points": "Proxy Points",
    "points_proxy_total": "Points Proxy (points)",
    "kom_proxy_total": "KOM Proxy (points)",
    "kom_proxy_points": "KOM Proxy (points)",
    "stage_points_proxy": "Stage Points Proxy (points)",
    "kom_points_proxy": "Stage KOM Proxy (points)",
    "total_stage_points_proxy": "Total Points Proxy (points)",
    "total_kom_points_proxy": "Total KOM Proxy (points)",
    "stage_count": "Stages",
    "stages_in_scope": "Stages in Scope",
    "stages_unfiltered": "Total Race Stages",
    "mountain_stage_count": "Mountain Stages",
    "selected_stage_count": "Stages in Scope",
    "distinct_stages": "Distinct Stages",
    "sample_count": "Stages Sampled",
    "total_stages_sampled": "Total Stages Sampled",
    "contributor_count": "Contributing Riders",
    "finisher_count": "Stage Finishers",
    "stage_finisher_count": "Stage Finishers",
    "avg_finishers": "Avg Stage Finishers",
    "participants_unfiltered": "Total Starters",
    "finishers_unfiltered": "Total Finishers",
    "exits_unfiltered": "Total Withdrawals",
    "teams_unfiltered": "Total Teams",
    "unfiltered_total_participants": "Total Starters (All Riders)",
    "unfiltered_total_finishers": "Total Finishers",
    "unfiltered_total_teams": "Total Teams",
    "unk_nationality_riders": "Unspecified Nationality Riders",
    "known_nationality_riders_in_scope": "Known-Nationality Riders",
    "known_nationality_finishers_in_scope": "Known-Nationality Finishers",
    "teams_in_scope": "Registered Teams in Scope",
    "known_countries_in_universe": "Countries in Universe",
    "countries_with_riders": "Countries with Riders",
    "countries_with_teams": "Countries with Teams",
    "zero_activity_countries": "Zero-Activity Countries",
    "rider_count": "Riders",
    "team_count": "Registered Teams",
    "country_rider_count": "Country Riders",
    "country_team_count": "Country Teams",
    "wins": "Stage Wins",
    "win_count": "Stage Wins",
    "stage_wins": "Stage Wins",
    "flat_wins": "Flat Wins",
    "hilly_wins": "Hilly Wins",
    "mountain_wins": "Mountain Wins",
    "itt_wins": "ITT Wins",
    "podiums": "Stage Podiums",
    "podium_finishes": "Stage Podiums",
    "top10_finishes": "Top-10 Finishes",
    "top10_count": "Top-10 Finishes",
    "top10_stages": "Stages with Top-10 Finish",
    "top10_distinct_riders": "Distinct Top-10 Riders",
    "finishers": "Race Finishers",
    "participants": "Starting Riders",
    "result_rows": "Stage Result Rows",
    "distinct_riders": "Distinct Riders",
}


def get_column_label(col_name: str) -> str:
    """Return a clean human-readable column label with units for a SQL column name."""
    if col_name in COLUMN_LABELS:
        return COLUMN_LABELS[col_name]
    if col_name.endswith("_seconds") or col_name.endswith("_s"):
        stem = re.sub(r"_(seconds|s)$", "", col_name).replace("_", " ").title()
        return f"{stem} (seconds)"
    if col_name.endswith("_km"):
        stem = col_name[: -len("_km")].replace("_", " ").title()
        return f"{stem} (km)"
    if col_name.endswith("_pct") or col_name.endswith("_percentile"):
        stem = re.sub(r"_(pct|percentile)$", "", col_name).replace("_", " ").title()
        return f"{stem} (%)"
    return col_name.replace("_", " ").title()


def is_hidden_surrogate_key(col_name: str) -> bool:
    """Return True if the column is an internal surrogate key that should be hidden in tables."""
    return col_name in SURROGATE_KEY_COLUMNS or col_name.endswith("_key")


def infer_metabase_base_type(col_name: str) -> str:
    """Infer a plausible Metabase base_type for a SQL column when live metadata is unavailable."""
    if col_name == "is_young_rider":
        return "type/Boolean"
    if col_name == "stage_date":
        return "type/Date"
    if (
        col_name.endswith("_km")
        or col_name.endswith("_pct")
        or col_name.endswith("_percentile")
        or col_name.endswith("_gap_s")
        or col_name in ("mean_gap_seconds", "avg_finishers")
    ):
        return "type/Decimal"
    if (
        col_name in SURROGATE_KEY_COLUMNS
        or col_name.endswith("_key")
        or col_name.endswith("_seconds")
        or col_name.endswith("_count")
        or col_name.endswith("_rank")
        or col_name.endswith("_wins")
        or col_name.endswith("_unfiltered")
        or col_name.endswith("_in_scope")
        or col_name.endswith("_finishes")
        or col_name.endswith("_riders")
        or col_name.endswith("_stages")
        or col_name.endswith("_countries")
        or col_name in (
            "rank",
            "bib_number",
            "winner_bib_number",
            "stage_id",
            "race_week",
            "points",
            "points_proxy_total",
            "kom_proxy_total",
            "kom_proxy_points",
            "stage_points_proxy",
            "kom_points_proxy",
            "total_stage_points_proxy",
            "total_kom_points_proxy",
            "wins",
            "podiums",
            "finishers",
            "participants",
            "result_rows",
            "total_stages_sampled",
            "known_countries_in_universe",
            "countries_with_teams",
        )
    ):
        return "type/Integer"
    return "type/Text"


def extract_select_columns(sql_query: str) -> List[str]:
    """Extract the ordered output column names from the final SELECT projection of a SQL query."""
    if not sql_query or not sql_query.strip():
        return []
    matches = list(re.finditer(r"(?im)^SELECT\b", sql_query))
    if not matches:
        return []
    last_select_start = matches[-1].end()
    tail = sql_query[last_select_start:]
    from_match = re.search(r"(?im)^\s*FROM\b", tail)
    select_body = tail[: from_match.start()] if from_match else tail

    # Split top-level comma-separated projection expressions (ignoring commas inside parentheses)
    parts: List[str] = []
    buf: List[str] = []
    depth = 0
    in_single_quote = False
    for ch in select_body:
        if ch == "'":
            in_single_quote = not in_single_quote
            buf.append(ch)
        elif not in_single_quote and ch == "(":
            depth += 1
            buf.append(ch)
        elif not in_single_quote and ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif not in_single_quote and depth == 0 and ch == ",":
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())

    cols: List[str] = []
    for expr in parts:
        if not expr:
            continue
        m_as = re.search(r"(?is)\bAS\s+([a-z_][a-z0-9_]*)\s*$", expr)
        if m_as:
            cols.append(m_as.group(1))
            continue
        m_col = re.search(r"(?is)(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*$", expr)
        if m_col:
            cols.append(m_col.group(1))
    return cols


def build_default_result_metadata(sql_query: str) -> List[Dict[str, Any]]:
    """Build deterministic fallback result_metadata entries from a native SQL query."""
    cols = extract_select_columns(sql_query)
    metadata: List[Dict[str, Any]] = []
    for col_name in cols:
        base_type = infer_metabase_base_type(col_name)
        metadata.append(
            {
                "name": col_name,
                "display_name": get_column_label(col_name),
                "base_type": base_type,
                "field_ref": ["field", col_name, {"base-type": base_type}],
            }
        )
    return metadata


# ---------------------------------------------------------------------------
# 1. Dashboard Filter & Native SQL Template-Tag Definitions
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FilterSpec:
    """Declarative specification for a dashboard parameter and native SQL tag."""

    key: str
    param_id: str
    name: str
    param_type: str
    section_id: str
    tag_type: str
    is_multi_select: bool = False
    default_value: Optional[Any] = None
    default_sql_literal: Optional[str] = None
    static_values: Optional[Tuple[Tuple[Any, str], ...]] = None


FILTER_SPECS: Dict[str, FilterSpec] = {
    "stage_scope": FilterSpec(
        key="stage_scope",
        param_id="param_stage_scope",
        name="Stage Scope",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=False,
        default_value="final",
        default_sql_literal="'final'",
        static_values=(
            ("final", "Final (All 21 Stages)"),
            ("as_of", "As-Of Stage S (Cumulative 1..S)"),
            ("selection", "Selected Stages / Terrain Subset"),
        ),
    ),
    "as_of_stage": FilterSpec(
        key="as_of_stage",
        param_id="param_as_of_stage",
        name="As-Of Stage",
        param_type="number/=",
        section_id="number",
        tag_type="number",
        is_multi_select=False,
        default_value=21,
    ),
    "stage_ids": FilterSpec(
        key="stage_ids",
        param_id="param_stage_ids",
        name="Stage",
        param_type="number/=",
        section_id="number",
        tag_type="number",
        is_multi_select=True,
    ),
    "stage_types": FilterSpec(
        key="stage_types",
        param_id="param_stage_types",
        name="Stage Terrain",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=True,
        static_values=(
            ("flat", "Flat"),
            ("hilly", "Hilly"),
            ("mountain", "Mountain"),
            ("individual time-trial", "Individual Time-Trial"),
        ),
    ),
    "time_basis": FilterSpec(
        key="time_basis",
        param_id="param_time_basis",
        name="Time Basis",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=False,
        default_value="adjusted",
        default_sql_literal="'adjusted'",
        static_values=(
            ("adjusted", "Adjusted Time (with Bonus & Penalty)"),
            ("finish", "Raw Finish Time"),
        ),
    ),
    "rank_scope": FilterSpec(
        key="rank_scope",
        param_id="param_rank_scope",
        name="Rank Scope",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=False,
        default_value="overall",
        default_sql_literal="'overall'",
        static_values=(
            ("overall", "Overall Competition Rank"),
            ("filtered", "Filtered Cohort Rank"),
        ),
    ),
    "team_keys": FilterSpec(
        key="team_keys",
        param_id="param_team_keys",
        name="Team",
        param_type="number/=",
        section_id="number",
        tag_type="number",
        is_multi_select=True,
    ),
    "rider_keys": FilterSpec(
        key="rider_keys",
        param_id="param_rider_keys",
        name="Rider",
        param_type="number/=",
        section_id="number",
        tag_type="number",
        is_multi_select=True,
    ),
    "young_only": FilterSpec(
        key="young_only",
        param_id="param_young_only",
        name="Young Rider",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=False,
        static_values=(
            ("true", "Young Riders Only (Born >= 2000-01-01)"),
            ("false", "All Riders"),
        ),
    ),
    "country_code": FilterSpec(
        key="country_code",
        param_id="param_country_code",
        name="Country",
        param_type="string/=",
        section_id="string",
        tag_type="text",
        is_multi_select=False,
    ),
}

LOOKUP_QUERIES: Dict[str, str] = {
    "team_keys": "SELECT team_key, team_name FROM dw.dim_team ORDER BY team_name ASC;",
    "rider_keys": (
        "SELECT rider_key, ('#' || bib_number || ' ' || rider_name) AS rider_label "
        "FROM dw.dim_rider ORDER BY bib_number ASC;"
    ),
    "stage_ids": (
        "SELECT stage_id, ('Stage ' || stage_id || ': ' || start_location_name || ' -> ' || "
        "finish_location_name || ' (' || stage_type || ')') AS stage_label "
        "FROM dw.dim_stage ORDER BY stage_order ASC;"
    ),
    "as_of_stage": (
        "SELECT stage_id, ('Stage ' || stage_id || ': ' || start_location_name || ' -> ' || "
        "finish_location_name) AS stage_label "
        "FROM dw.dim_stage ORDER BY stage_order ASC;"
    ),
    "country_code": (
        "SELECT country_code, (country_name || ' (' || country_code || ')') AS country_label "
        "FROM dw.dim_country WHERE country_key > 0 AND country_code <> 'UNK' "
        "ORDER BY country_name ASC;"
    ),
}

DEFAULT_LOOKUP_FIXTURES: Dict[str, List[List[Any]]] = {
    "team_keys": [
        [1, "Alpecin-Deceuninck"],
        [2, "Arkea-B&B Hotels"],
        [20, "Team Visma | Lease a Bike"],
        [22, "UAE Team Emirates"],
    ],
    "rider_keys": [
        [1, "#1 Tadej Pogacar"],
        [9, "#11 Jonas Vingegaard"],
        [17, "#21 Remco Evenepoel"],
    ],
    "stage_ids": [[i, f"Stage {i}"] for i in range(1, 22)],
    "as_of_stage": [[i, f"Stage {i}"] for i in range(1, 22)],
    "country_code": [
        ["BEL", "Belgium (BEL)"],
        ["DEN", "Denmark (DEN)"],
        ["FRA", "France (FRA)"],
        ["SLO", "Slovenia (SLO)"],
        ["UAE", "United Arab Emirates (UAE)"],
    ],
}

ALL_COMMON_FILTER_KEYS: Tuple[str, ...] = (
    "stage_scope",
    "as_of_stage",
    "stage_ids",
    "stage_types",
    "time_basis",
    "rank_scope",
    "team_keys",
    "rider_keys",
    "young_only",
)

STAGE_FILTER_KEYS: Tuple[str, ...] = (
    "stage_scope",
    "as_of_stage",
    "stage_ids",
    "stage_types",
)

DEPTH_FILTER_KEYS: Tuple[str, ...] = (
    "stage_scope",
    "as_of_stage",
    "stage_ids",
    "stage_types",
    "team_keys",
    "rider_keys",
    "young_only",
)

SPECIALISATION_FILTER_KEYS: Tuple[str, ...] = (
    "stage_scope",
    "as_of_stage",
    "stage_ids",
    "stage_types",
    "time_basis",
    "team_keys",
    "rider_keys",
    "young_only",
)

COUNTRY_FILTER_KEYS: Tuple[str, ...] = (
    "team_keys",
    "rider_keys",
    "young_only",
)

COUNTRY_DETAIL_FILTER_KEYS: Tuple[str, ...] = (
    "team_keys",
    "rider_keys",
    "young_only",
    "country_code",
)


def build_dashboard_parameters(
    lookup_values: Optional[Mapping[str, Sequence[Sequence[Any]]]] = None,
) -> List[Dict[str, Any]]:
    """Build the dashboard-level parameter definitions for PUT /api/dashboard/{id}."""
    resolved_lookups = lookup_values if lookup_values is not None else DEFAULT_LOOKUP_FIXTURES
    params: List[Dict[str, Any]] = []
    for key in (
        "stage_scope",
        "as_of_stage",
        "stage_ids",
        "stage_types",
        "time_basis",
        "rank_scope",
        "team_keys",
        "rider_keys",
        "young_only",
        "country_code",
    ):
        spec = FILTER_SPECS[key]
        param: Dict[str, Any] = {
            "id": spec.param_id,
            "name": spec.name,
            "slug": spec.key,
            "type": spec.param_type,
            "sectionId": spec.section_id,
            "isMultiSelect": spec.is_multi_select,
        }
        if spec.default_value is not None:
            param["default"] = spec.default_value

        if spec.static_values is not None:
            param["values_query_type"] = "list"
            param["values_source_type"] = "static-list"
            param["values_source_config"] = {
                "values": [[val, label] for val, label in spec.static_values]
            }
        elif key in resolved_lookups and resolved_lookups[key]:
            param["values_query_type"] = "list"
            param["values_source_type"] = "static-list"
            param["values_source_config"] = {
                "values": [[row[0], row[1]] for row in resolved_lookups[key]]
            }
        params.append(param)
    return params


def _sql_filter_entry(key: str) -> str:
    """Return the key/value SQL pair for ``jsonb_build_object(...)``."""
    if key in ("stage_scope", "time_basis", "rank_scope"):
        default_lit = FILTER_SPECS[key].default_sql_literal or "'final'"
        return (
            f"'{key}', COALESCE(NULL::text "
            f"[[ , NULLIF((ARRAY[{{{{{key}}}}}]::text[])[1], '') ]], {default_lit})"
        )
    if key == "as_of_stage":
        return (
            "'as_of_stage', COALESCE(NULL::integer "
            "[[ , (ARRAY[{{as_of_stage}}]::integer[])[1] ]])"
        )
    if key in ("stage_ids", "team_keys", "rider_keys"):
        return (
            f"'{key}', COALESCE(NULL::jsonb "
            f"[[ , to_jsonb(ARRAY[{{{{{key}}}}}]::integer[]) ]])"
        )
    if key == "stage_types":
        return (
            "'stage_types', COALESCE(NULL::jsonb "
            "[[ , to_jsonb(ARRAY[{{stage_types}}]::text[]) ]])"
        )
    if key == "young_only":
        return (
            "'young_only', COALESCE(NULL::boolean "
            "[[ , (NULLIF((ARRAY[{{young_only}}]::text[])[1], ''))::boolean ]])"
        )
    raise ValueError(f"Unsupported JSONB filter key: {key}")


def build_filter_jsonb_sql(
    filter_keys: Sequence[str],
    extra_static: Optional[Mapping[str, str]] = None,
) -> str:
    """Build the reusable ``jsonb_strip_nulls(jsonb_build_object(...))`` SQL fragment."""
    entries: List[str] = []
    if extra_static:
        for k, v in extra_static.items():
            escaped = v.replace("'", "''")
            entries.append(f"'{k}', '{escaped}'")
    for key in filter_keys:
        if key == "country_code":
            continue
        entries.append(_sql_filter_entry(key))
    joined = ",\n            ".join(entries)
    return f"jsonb_strip_nulls(jsonb_build_object(\n            {joined}\n        ))"


def build_template_tags(filter_keys: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """Build the ``template-tags`` dictionary for a native SQL ``dataset_query``."""
    tags: Dict[str, Dict[str, Any]] = {}
    for key in filter_keys:
        spec = FILTER_SPECS[key]
        tags[key] = {
            "id": f"tag_{key}",
            "name": key,
            "display-name": spec.name,
            "type": spec.tag_type,
            "required": False,
        }
    return tags


def build_parameter_mappings(
    card_id: int,
    filter_keys: Sequence[str],
) -> List[Dict[str, Any]]:
    """Build the dashcard ``parameter_mappings`` array linking dashboard filters to tags."""
    mappings: List[Dict[str, Any]] = []
    for key in filter_keys:
        spec = FILTER_SPECS[key]
        mappings.append(
            {
                "parameter_id": spec.param_id,
                "card_id": card_id,
                "target": ["variable", ["template-tag", key]],
            }
        )
    return mappings


# ---------------------------------------------------------------------------
# 2. Tab, Click Behavior, Caption, and Card Specifications
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TabSpec:
    slug: str
    name: str
    position: int
    temp_id: int


TAB_SPECS: Tuple[TabSpec, ...] = (
    TabSpec("tab_overview", "Executive & Race Overview", 0, -1),
    TabSpec("tab_classifications", "Classifications Comparison", 1, -2),
    TabSpec("tab_performance", "Rider & Team Performance", 2, -3),
    TabSpec("tab_country", "Country Participation", 3, -4),
    TabSpec("tab_insights", "Deep-Dive Insights", 4, -5),
)


@dataclass(frozen=True)
class ClickActionSpec:
    """Route a clicked dimension to the local portal with the active dashboard scope."""

    source_column: str
    target_param_key: str
    clickable_columns: Tuple[str, ...] = ()

    def to_click_behavior_dict(
        self, portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
        overrides: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        base = validate_portal_base_url(portal_base_url)
        column = "{{column:" + self.source_column + "}}"
        targets = {
            "stage_ids": ("stage", "stage_id"),
            "team_keys": ("team", "team_key"),
            "rider_keys": ("rider", "rider_key"),
            "country_code": ("country", "country_code"),
        }
        if self.target_param_key == "stage_types":
            params = {"view": "explore", "module": "stage_summary",
                      "stage_scope": "selection", "stage_types": column}
            excluded = {"stage_scope", "stage_types", "stage_ids", "as_of_stage"}
        else:
            drill, key = targets[self.target_param_key]
            params = {"drill": drill, key: column}
            excluded = set()
        for key in ALL_COMMON_FILTER_KEYS:
            if key not in excluded:
                params[key] = "{{filter:" + FILTER_SPECS[key].name + "}}"
        params.update(overrides or {})
        # Metabase URL-encodes substituted values (including CSV arrays), not this template.
        return {"type": "link", "linkType": "url",
                "linkTemplate": base + "/?" + "&".join(key + "=" + val for key, val in params.items())}


def validate_portal_base_url(value: str) -> str:
    """Allow an explicitly configured HTTP(S) portal base, never credentials or query tokens."""
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Portal base URL must be HTTP(S) without credentials, query or fragment")
    return value.rstrip("/")


@dataclass(frozen=True)
class CaptionDashcardSpec:
    """Virtual markdown text dashcard placed on a tab to document scope & proxy rules."""

    slug: str
    tab_slug: str
    row: int
    col: int
    size_x: int
    size_y: int
    markdown_text: str


@dataclass(frozen=True)
class CardSpec:
    """Declarative specification for an analytical card and its dashboard placement."""

    slug: str
    name: str
    description: str
    tab_slug: str
    display: str
    row: int
    col: int
    size_x: int
    size_y: int
    filter_keys: Tuple[str, ...]
    sql_query: str
    sql_functions_used: Tuple[str, ...]
    visualization_settings: Dict[str, Any] = field(default_factory=dict)
    click_action: Optional[ClickActionSpec] = None
    on_dashboard: bool = True
    query_kind: str = "native"
    source_card_slug: Optional[str] = None


# Implementation notes moved out of visible captions: KPI cards already show race
# totals; custom click actions open PORTAL_BASE_URL in a new tab with active filters.
# All standings use dw.rider_standings; proxy indices use finish rank and terrain,
# not official intermediate sprint or mountain-pass points.
CAPTION_SPECS: Tuple[CaptionDashcardSpec, ...] = (
    CaptionDashcardSpec(
        slug="caption_overview_scope", tab_slug="tab_overview",
        row=0, col=0, size_x=24, size_y=2,
        markdown_text="**Race & stages** · Compare terrain and stage patterns, then select a stage or rider to open its results.",
    ),
    CaptionDashcardSpec(
        slug="caption_classifications_proxy_notice", tab_slug="tab_classifications",
        row=0, col=0, size_x=24, size_y=3,
        markdown_text=(
            "**Compare rankings** · Final = full-race GC; As-Of = stages 1–S; Selection = selected-stage performance. "
            "Only riders completing every stage in scope qualify; Young Rider requires birth in 2000 or later.\n\n"
            "**Points / KOM: nonofficial source-derived proxy indices**, based on stage finishes and terrain. Tied scores share a rank."
        ),
    ),
)


def _build_card_specs() -> Tuple[CardSpec, ...]:
    """Construct all analytical CardSpecs across the 5 dashboard tabs."""
    f_stage = build_filter_jsonb_sql(STAGE_FILTER_KEYS)
    f_base = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS)
    f_gc = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"classification": "gc"})
    f_young = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"classification": "young"})
    f_points = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"classification": "points_proxy"})
    f_kom = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"classification": "kom_proxy"})
    f_mt = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"classification": "mountain_time"})
    f_team_stage = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"team_aggregation": "stage_top3"})
    f_team_cum = build_filter_jsonb_sql(ALL_COMMON_FILTER_KEYS, {"team_aggregation": "cumulative_top3"})
    f_country = build_filter_jsonb_sql(COUNTRY_FILTER_KEYS)
    f_spec = build_filter_jsonb_sql(SPECIALISATION_FILTER_KEYS)
    f_depth = build_filter_jsonb_sql(DEPTH_FILTER_KEYS)

    return (
        # =====================================================================
        # TAB 1: Executive & Race Overview (5 data cards + 1 caption card)
        # =====================================================================
        CardSpec(
            slug="overview_kpi_summary",
            name="Race at a Glance",
            description=(
                "Full-race participation baseline (184 starters, 160 finishers, 24 withdrawals, 23 teams, "
                "21 stages, and 3,302.00 km total distance) alongside the stage count and unique route distance (km) "
                "in the selected scope."
            ),
            tab_slug="tab_overview",
            display="table",
            row=2,
            col=0,
            size_x=24,
            size_y=4,
            filter_keys=STAGE_FILTER_KEYS,
            sql_functions_used=("dw.stage_summary",),
            sql_query=f"""WITH global_participation AS (
    SELECT
        SUM(fp.participant_count)::integer AS participants_unfiltered,
        SUM(fp.finished_race_flag)::integer AS finishers_unfiltered,
        SUM(fp.exit_flag)::integer AS exits_unfiltered,
        ROUND(SUM(fp.finished_race_flag)::numeric * 100.0 / NULLIF(SUM(fp.participant_count), 0), 2) AS finisher_rate_pct,
        COUNT(DISTINCT fp.team_key)::integer AS teams_unfiltered
    FROM dw.fact_participation fp
),
global_stages AS (
    SELECT
        COUNT(*)::integer AS stages_unfiltered,
        SUM(ds.distance_km)::numeric(8, 2) AS total_distance_km_unfiltered
    FROM dw.dim_stage ds
),
scoped_stages AS (
    SELECT
        COUNT(*)::integer AS stages_in_scope,
        COALESCE(SUM(ss.distance_km), 0)::numeric(8, 2) AS distance_km_in_scope
    FROM dw.stage_summary({f_stage}) ss
)
SELECT
    gp.participants_unfiltered,
    gp.finishers_unfiltered,
    gp.exits_unfiltered,
    gp.finisher_rate_pct,
    gp.teams_unfiltered,
    gs.stages_unfiltered,
    gs.total_distance_km_unfiltered,
    ss.stages_in_scope,
    ss.distance_km_in_scope
FROM global_participation gp
CROSS JOIN global_stages gs
CROSS JOIN scoped_stages ss;""",
            click_action=None,
        ),
        CardSpec(
            slug="overview_terrain_distance_bar",
            name="Distance by Stage Terrain",
            description=(
                "Total unique route distance (km) by stage terrain category without duplicating distance across "
                "rider rows (stage counts and averages are listed in Stage Routes). Click a bar to open stages of that terrain in the portal."
            ),
            tab_slug="tab_overview",
            display="bar",
            row=6,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=STAGE_FILTER_KEYS,
            sql_functions_used=("dw.stage_summary",),
            sql_query=f"""SELECT
    ss.stage_type,
    COUNT(*)::integer AS stage_count,
    SUM(ss.distance_km)::numeric(8, 2) AS total_distance_km,
    ROUND(AVG(ss.distance_km), 2)::numeric(6, 2) AS avg_distance_km,
    ROUND(AVG(ss.finisher_count), 1)::numeric(6, 1) AS avg_finishers
FROM dw.stage_summary({f_stage}) ss
GROUP BY ss.stage_type
ORDER BY total_distance_km DESC, ss.stage_type ASC;""",
            visualization_settings={
                "graph.dimensions": ["stage_type"],
                "graph.metrics": ["total_distance_km"],
                "graph.x_axis.title_text": "Stage Terrain",
                "graph.y_axis.title_text": "Total Distance (km)",
            },
            click_action=ClickActionSpec(
                source_column="stage_type",
                target_param_key="stage_types",
                clickable_columns=("stage_type",),
            ),
        ),
        CardSpec(
            slug="overview_stage_finisher_trend_line",
            name="Stage Finisher Trend",
            description=(
                "Number of riders finishing each stage from Stage 1 to Stage 21. "
                "Click a stage point to open its results in the portal."
            ),
            tab_slug="tab_overview",
            display="line",
            row=6,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=STAGE_FILTER_KEYS,
            sql_functions_used=("dw.stage_summary",),
            sql_query=f"""SELECT
    ss.stage_id,
    ss.stage_name,
    ss.stage_type,
    ss.race_week,
    ss.finisher_count,
    ss.distance_km
FROM dw.stage_summary({f_stage}) ss
ORDER BY ss.stage_order ASC;""",
            visualization_settings={
                "graph.dimensions": ["stage_id"],
                "graph.metrics": ["finisher_count"],
                "graph.x_axis.title_text": "Stage",
                "graph.y_axis.title_text": "Finishers (riders)",
            },
            click_action=ClickActionSpec(
                source_column="stage_id",
                target_param_key="stage_ids",
                clickable_columns=("stage_id",),
            ),
        ),
        CardSpec(
            slug="overview_stage_summary_table",
            name="Stage Routes",
            description=(
                "One row per stage showing calendar date, race week, terrain category, unique stage distance (km), "
                "start and finish locations, finisher count, and stage winner. Click a stage label to open its results in the portal."
            ),
            tab_slug="tab_overview",
            display="table",
            row=13,
            col=0,
            size_x=24,
            size_y=7,
            filter_keys=STAGE_FILTER_KEYS,
            sql_functions_used=("dw.stage_summary",),
            sql_query=f"""SELECT
    ss.stage_id,
    ss.stage_date,
    ss.race_week,
    ss.stage_type,
    ss.distance_km,
    ss.route_description,
    ss.finisher_count,
    ss.winner_bib_number,
    ss.winner_rider_key,
    ss.winner_rider_name,
    ss.winner_team_name,
    ss.winning_finish_time_seconds,
    ss.winning_adjusted_time_seconds
FROM dw.stage_summary({f_stage}) ss
ORDER BY ss.stage_order ASC;""",
            click_action=ClickActionSpec(
                source_column="stage_id",
                target_param_key="stage_ids",
                clickable_columns=("stage_id", "route_description", "stage_type"),
            ),
        ),
        CardSpec(
            slug="overview_stage_rider_results_table",
            name="Stage Rider Results",
            description=(
                "Individual rider results per stage showing official bib number, finish rank, raw and adjusted times "
                "and gaps to the stage winner (seconds), global stage rank percentile (%), and nonofficial proxy points. "
                "Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_overview",
            display="table",
            row=20,
            col=0,
            size_x=24,
            size_y=8,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_stage_results",),
            sql_query=f"""SELECT
    rsr.stage_id,
    rsr.stage_name,
    rsr.stage_type,
    rsr.race_week,
    rsr.finish_rank,
    rsr.bib_number,
    rsr.rider_key,
    rsr.rider_name,
    rsr.team_key,
    rsr.team_name,
    rsr.finish_time_seconds,
    rsr.time_bonus_seconds,
    rsr.time_penalty_seconds,
    rsr.adjusted_time_seconds,
    rsr.gap_seconds AS raw_gap_seconds,
    rsr.adjusted_gap_seconds,
    rsr.rank_percentile,
    rsr.stage_points_proxy,
    rsr.kom_points_proxy,
    rsr.participation_status
FROM dw.rider_stage_results({f_base}) rsr
ORDER BY rsr.stage_order ASC, rsr.finish_rank ASC, rsr.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),

        # =====================================================================
        # TAB 2: Classifications Comparison (6 data cards + 1 caption card)
        # =====================================================================
        CardSpec(
            slug="class_gc_table",
            name="Time Standings · Active Scope",
            description=(
                "Cumulative time (seconds) and gap among riders completing every stage in the active scope. "
                "Final means Full-Race GC; As-Of means Stages 1–S; Selection means selected-stage performance, "
                "not full-race GC. Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_classifications",
            display="table",
            row=3,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""SELECT
    rs.rank,
    rs.bib_number,
    rs.rider_key,
    rs.rider_name,
    rs.team_key,
    rs.team_name,
    rs.is_young_rider,
    rs.stage_count,
    rs.total_seconds,
    rs.gap_seconds,
    rs.rank_percentile,
    rs.time_basis
FROM dw.rider_standings({f_gc}) rs
ORDER BY rs.rank ASC, rs.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="class_young_table",
            name="Young Rider Time · Active Scope",
            description=(
                "Age-eligible time standings for riders born in 2000 or later who completed every stage in the selected "
                "scope, ranked by cumulative time (seconds). Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_classifications",
            display="table",
            row=3,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""SELECT
    rs.rank,
    rs.bib_number,
    rs.rider_key,
    rs.rider_name,
    rs.team_key,
    rs.team_name,
    rs.is_young_rider,
    rs.stage_count,
    rs.total_seconds,
    rs.gap_seconds,
    rs.rank_percentile,
    rs.time_basis
FROM dw.rider_standings({f_young}) rs
ORDER BY rs.rank ASC, rs.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="class_points_proxy_table",
            name="Points — Proxy",
            description=(
                "Nonofficial source-derived proxy index summing stage finish points mapped from stage terrain and "
                "top-15 stage finishes; ranked strictly by descending points without time tie-breakers. "
                "Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_classifications",
            display="table",
            row=10,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""SELECT
    rs.rank,
    rs.bib_number,
    rs.rider_key,
    rs.rider_name,
    rs.team_key,
    rs.team_name,
    rs.is_young_rider,
    rs.stage_count,
    rs.points AS points_proxy_total,
    rs.rank_percentile,
    rs.total_seconds,
    'Nonofficial Source-Derived Proxy'::text AS proxy_notice
FROM dw.rider_standings({f_points}) rs
ORDER BY rs.rank ASC, rs.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="class_kom_proxy_table",
            name="KOM — Proxy",
            description=(
                "Nonofficial source-derived proxy index summing climb points mapped from mountain (top 10) and "
                "hilly (top 5) stage finishes; ranked strictly by descending points without time tie-breakers. "
                "Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_classifications",
            display="table",
            row=10,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""SELECT
    rs.rank,
    rs.bib_number,
    rs.rider_key,
    rs.rider_name,
    rs.team_key,
    rs.team_name,
    rs.is_young_rider,
    rs.stage_count,
    rs.points AS kom_proxy_total,
    rs.rank_percentile,
    rs.total_seconds,
    'Nonofficial Source-Derived Proxy'::text AS proxy_notice
FROM dw.rider_standings({f_kom}) rs
ORDER BY rs.rank ASC, rs.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="class_mountain_time_comparison",
            name="Mountain Time vs KOM — Proxy",
            description=(
                "Compares cumulative time on mountain stages (seconds, among riders completing the selected scope) "
                "against nonofficial KOM — Proxy points and overall General Classification rank. "
                "Click a rider to open their stage trajectory in the portal."
            ),
            tab_slug="tab_classifications",
            display="table",
            row=17,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""WITH mt AS (
    SELECT * FROM dw.rider_standings({f_mt})
),
kp AS (
    SELECT rider_key, rank AS kom_proxy_rank, points AS kom_proxy_points, rank_percentile AS kom_proxy_percentile
    FROM dw.rider_standings({f_kom})
),
gc AS (
    SELECT rider_key, rank AS gc_rank, total_seconds AS gc_total_seconds, gap_seconds AS gc_gap_seconds
    FROM dw.rider_standings({f_gc})
)
SELECT
    mt.rank AS mountain_time_rank,
    mt.bib_number,
    mt.rider_key,
    mt.rider_name,
    mt.team_key,
    mt.team_name,
    mt.stage_count AS mountain_stage_count,
    mt.total_seconds AS mountain_total_seconds,
    mt.gap_seconds AS mountain_gap_seconds,
    mt.rank_percentile AS mountain_time_percentile,
    kp.kom_proxy_rank,
    kp.kom_proxy_points,
    kp.kom_proxy_percentile,
    gc.gc_rank,
    gc.gc_gap_seconds,
    mt.time_basis
FROM mt
LEFT JOIN kp ON kp.rider_key = mt.rider_key
LEFT JOIN gc ON gc.rider_key = mt.rider_key
ORDER BY mt.rank ASC, mt.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="class_multi_rider_percentiles_bar",
            name="Cross-Classification Percentiles",
            description=(
                "Compares rider rank percentiles (0-100%) across General Classification, Young Rider, "
                "Points — Proxy (nonofficial), KOM — Proxy (nonofficial), and Mountain Time. "
                "Defaults to the Top 10 GC finishers when no team or rider filter is selected."
            ),
            tab_slug="tab_classifications",
            display="bar",
            row=17,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""WITH active_filters AS (
    SELECT {f_base} AS f
),
all_classifications AS (
    SELECT * FROM dw.rider_standings((SELECT f || '{{"classification":"gc"}}'::jsonb FROM active_filters))
    UNION ALL
    SELECT * FROM dw.rider_standings((SELECT f || '{{"classification":"young"}}'::jsonb FROM active_filters))
    UNION ALL
    SELECT * FROM dw.rider_standings((SELECT f || '{{"classification":"points_proxy"}}'::jsonb FROM active_filters))
    UNION ALL
    SELECT * FROM dw.rider_standings((SELECT f || '{{"classification":"kom_proxy"}}'::jsonb FROM active_filters))
    UNION ALL
    SELECT * FROM dw.rider_standings((SELECT f || '{{"classification":"mountain_time"}}'::jsonb FROM active_filters))
),
default_cohort AS (
    SELECT rider_key
    FROM all_classifications
    WHERE classification = 'gc'
    ORDER BY rank ASC, bib_number ASC
    LIMIT 10
)
SELECT
    ac.bib_number,
    ac.rider_key,
    ('#' || ac.bib_number || ' ' || ac.rider_name)::text AS rider_label,
    ac.rider_name,
    ac.team_name,
    CASE ac.classification
        WHEN 'gc' THEN '1. GC (Time)'
        WHEN 'young' THEN '2. Young Rider (White Jersey)'
        WHEN 'points_proxy' THEN '3. Points Proxy (Nonofficial)'
        WHEN 'kom_proxy' THEN '4. KOM Proxy (Nonofficial)'
        WHEN 'mountain_time' THEN '5. Mountain Stage Time'
        ELSE ac.classification
    END AS classification_label,
    ac.rank,
    ac.rank_percentile
FROM all_classifications ac
WHERE (
    (SELECT jsonb_exists(f, 'rider_keys') OR jsonb_exists(f, 'team_keys') FROM active_filters)
    OR ac.rider_key IN (SELECT rider_key FROM default_cohort)
)
ORDER BY ac.bib_number ASC, classification_label ASC;""",
            visualization_settings={
                "graph.dimensions": ["rider_label", "classification_label"],
                "graph.metrics": ["rank_percentile"],
                "graph.x_axis.title_text": "Rider (#Bib & Name)",
                "graph.y_axis.title_text": "Rank Percentile (%)",
            },
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_label"),
            ),
        ),

        # =====================================================================
        # TAB 3: Rider & Team Performance (6 data cards)
        # =====================================================================
        CardSpec(
            slug="perf_team_stage_top3_table",
            name="Team Standings · Per-stage Top 3",
            description=(
                "Official Tour de France team rule: sums the fastest 3 riders per team on each stage across all "
                "stages in the selected scope (times and gaps in seconds). Click a team label to open its full roster in the portal."
            ),
            tab_slug="tab_performance",
            display="table",
            row=0,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.team_standings",),
            sql_query=f"""SELECT
    ts.rank,
    ts.team_key,
    ts.team_name,
    ts.total_seconds,
    ts.gap_seconds,
    ts.stage_count,
    ts.contributor_count,
    ts.team_aggregation,
    ts.time_basis
FROM dw.team_standings({f_team_stage}) ts
ORDER BY ts.rank ASC, ts.team_key ASC;""",
            click_action=ClickActionSpec(
                source_column="team_key",
                target_param_key="team_keys",
                clickable_columns=("team_name",),
            ),
        ),
        CardSpec(
            slug="perf_team_cumulative_top3_table",
            name="Team Standings · Cumulative Top 3",
            description=(
                "Alternative team rule: sums the top 3 cumulative finishers per team who completed every stage "
                "in the selected scope (times and gaps in seconds). Placed side-by-side with Per-stage Top 3. "
                "Click a team label to open its full roster in the portal."
            ),
            tab_slug="tab_performance",
            display="table",
            row=0,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.team_standings",),
            sql_query=f"""SELECT
    ts.rank,
    ts.team_key,
    ts.team_name,
    ts.total_seconds,
    ts.gap_seconds,
    ts.stage_count,
    ts.contributor_count,
    ts.team_aggregation,
    ts.time_basis
FROM dw.team_standings({f_team_cum}) ts
ORDER BY ts.rank ASC, ts.team_key ASC;""",
            click_action=ClickActionSpec(
                source_column="team_key",
                target_param_key="team_keys",
                clickable_columns=("team_name",),
            ),
        ),
        CardSpec(
            slug="perf_team_methods_comparison_bar",
            name="Team Aggregation Comparison",
            description=(
                "Side-by-side bar comparison of each team's time gap to the leading team (seconds) under "
                "Per-stage Top 3 versus Cumulative Top 3. Click a bar to open the team roster in the portal."
            ),
            tab_slug="tab_performance",
            display="bar",
            row=7,
            col=0,
            size_x=24,
            size_y=6,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.team_standings",),
            sql_query=f"""WITH active_filters AS (
    SELECT {f_base} AS f
),
stage_m AS (
    SELECT * FROM dw.team_standings((SELECT f || '{{"team_aggregation":"stage_top3"}}'::jsonb FROM active_filters))
),
cum_m AS (
    SELECT * FROM dw.team_standings((SELECT f || '{{"team_aggregation":"cumulative_top3"}}'::jsonb FROM active_filters))
)
SELECT
    s.team_key,
    s.team_name,
    'Per-stage Top 3'::text AS aggregation_method,
    s.rank,
    s.total_seconds,
    s.gap_seconds,
    s.contributor_count
FROM stage_m s
UNION ALL
SELECT
    c.team_key,
    c.team_name,
    'Cumulative Top 3'::text AS aggregation_method,
    c.rank,
    c.total_seconds,
    c.gap_seconds,
    c.contributor_count
FROM cum_m c
ORDER BY rank ASC, team_name ASC, aggregation_method ASC;""",
            visualization_settings={
                "graph.dimensions": ["team_name", "aggregation_method"],
                "graph.metrics": ["gap_seconds"],
                "graph.x_axis.title_text": "Team",
                "graph.y_axis.title_text": "Gap to Leader (seconds)",
            },
            click_action=ClickActionSpec(
                source_column="team_key",
                target_param_key="team_keys",
                clickable_columns=("team_name",),
            ),
        ),
        CardSpec(
            slug="perf_rider_standings_table",
            name="Rider Cumulative Standings",
            description=(
                "Individual rider cumulative standings showing official bib number, team, total time and gap "
                "to the leader (seconds), nonofficial points proxy, and rank percentile (%). "
                "Step 2 of Team -> Rider -> Stage drill-down: click a rider label to open their stage trajectory in the portal."
            ),
            tab_slug="tab_performance",
            display="table",
            row=13,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings",),
            sql_query=f"""SELECT
    rs.rank,
    rs.bib_number,
    rs.rider_key,
    rs.rider_name,
    rs.team_key,
    rs.team_name,
    rs.is_young_rider,
    rs.stage_count,
    rs.total_seconds,
    rs.gap_seconds,
    rs.points AS points_proxy_total,
    rs.rank_percentile,
    rs.time_basis
FROM dw.rider_standings({f_gc}) rs
ORDER BY rs.rank ASC, rs.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="perf_rider_stage_trajectory_line",
            name="Rider Stage Percentile Trajectory",
            description=(
                "Stage-by-stage rank percentile trajectory (0-100%) across stages 1 to 21. "
                "Defaults to the Top 5 GC finishers when no team or rider filter is selected. "
                "Click a stage point to open its results in the portal."
            ),
            tab_slug="tab_performance",
            display="line",
            row=13,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings", "dw.rider_stage_results"),
            sql_query=f"""WITH active_filters AS (
    SELECT {f_base} AS f
),
default_top5 AS (
    SELECT rider_key
    FROM dw.rider_standings((SELECT f || '{{"classification":"gc"}}'::jsonb FROM active_filters))
    ORDER BY rank ASC, bib_number ASC
    LIMIT 5
),
stage_rows AS (
    SELECT * FROM dw.rider_stage_results((SELECT f FROM active_filters))
)
SELECT
    sr.stage_id,
    sr.stage_type,
    sr.bib_number,
    sr.rider_key,
    ('#' || sr.bib_number || ' ' || sr.rider_name)::text AS rider_label,
    sr.team_name,
    sr.finish_rank,
    sr.rank_percentile,
    sr.adjusted_gap_seconds
FROM stage_rows sr
WHERE (
    (SELECT jsonb_exists(f, 'rider_keys') OR jsonb_exists(f, 'team_keys') FROM active_filters)
    OR sr.rider_key IN (SELECT rider_key FROM default_top5)
)
ORDER BY sr.stage_order ASC, sr.finish_rank ASC, sr.bib_number ASC;""",
            visualization_settings={
                "graph.dimensions": ["stage_id", "rider_label"],
                "graph.metrics": ["rank_percentile"],
                "graph.x_axis.title_text": "Stage",
                "graph.y_axis.title_text": "Stage Rank Percentile (%)",
            },
            click_action=ClickActionSpec(
                source_column="stage_id",
                target_param_key="stage_ids",
                clickable_columns=("stage_id",),
            ),
        ),
        CardSpec(
            slug="perf_rider_stage_detail_table",
            name="Rider Stage Results",
            description=(
                "Step 3 of Team -> Rider -> Stage drill-down: rider stage results showing official bib number, "
                "stage route, terrain, distance (km), finish rank, raw and adjusted times and gaps (seconds), "
                "and nonofficial proxy points. Click a stage label to open its results in the portal."
            ),
            tab_slug="tab_performance",
            display="table",
            row=20,
            col=0,
            size_x=24,
            size_y=8,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_stage_results",),
            sql_query=f"""SELECT
    rsr.bib_number,
    rsr.rider_key,
    rsr.rider_name,
    rsr.is_young_rider,
    rsr.team_key,
    rsr.team_name,
    rsr.stage_id,
    rsr.stage_name,
    rsr.stage_date,
    rsr.race_week,
    rsr.stage_type,
    rsr.distance_km,
    rsr.finish_rank,
    rsr.stage_finisher_count,
    rsr.finish_time_seconds,
    rsr.time_bonus_seconds,
    rsr.time_penalty_seconds,
    rsr.adjusted_time_seconds,
    rsr.gap_seconds AS raw_gap_seconds,
    rsr.adjusted_gap_seconds,
    rsr.stage_points_proxy,
    rsr.kom_points_proxy,
    rsr.rank_percentile,
    rsr.participation_status
FROM dw.rider_stage_results({f_base}) rsr
ORDER BY rsr.bib_number ASC, rsr.stage_order ASC;""",
            click_action=ClickActionSpec(
                source_column="stage_id",
                target_param_key="stage_ids",
                clickable_columns=("stage_id", "stage_name"),
            ),
        ),

        # =====================================================================
        # TAB 4: Country Participation (5 data cards)
        # =====================================================================
        CardSpec(
            slug="country_overview_kpi_table",
            name="Participation by Country Overview",
            description=(
                "Compares unfiltered full-race participation (184 starters = 183 known-nationality riders + "
                "1 rider with unspecified nationality, 160 finishers, 23 teams) against active country totals."
            ),
            tab_slug="tab_country",
            display="table",
            row=0,
            col=0,
            size_x=24,
            size_y=4,
            filter_keys=COUNTRY_FILTER_KEYS,
            sql_functions_used=("dw.country_participation",),
            sql_query=f"""WITH global_fp AS (
    SELECT
        SUM(fp.participant_count)::integer AS unfiltered_total_participants,
        SUM(fp.finished_race_flag)::integer AS unfiltered_total_finishers,
        COUNT(DISTINCT fp.team_key)::integer AS unfiltered_total_teams,
        COUNT(*) FILTER (WHERE fp.rider_country_key = 0)::integer AS unk_nationality_riders
    FROM dw.fact_participation fp
),
cp AS (
    SELECT
        COUNT(*)::integer AS known_countries_in_universe,
        COUNT(*) FILTER (WHERE c.rider_count > 0)::integer AS countries_with_riders,
        COUNT(*) FILTER (WHERE c.team_count > 0)::integer AS countries_with_teams,
        COUNT(*) FILTER (WHERE c.rider_count = 0 AND c.team_count = 0)::integer AS zero_activity_countries,
        COALESCE(SUM(c.rider_count), 0)::integer AS known_nationality_riders_in_scope,
        COALESCE(SUM(c.finisher_count), 0)::integer AS known_nationality_finishers_in_scope,
        COALESCE(SUM(c.team_count), 0)::integer AS teams_in_scope
    FROM dw.country_participation({f_country}) c
)
SELECT
    g.unfiltered_total_participants,
    g.unfiltered_total_finishers,
    g.unfiltered_total_teams,
    g.unk_nationality_riders,
    cp.known_nationality_riders_in_scope,
    cp.known_nationality_finishers_in_scope,
    cp.teams_in_scope,
    cp.known_countries_in_universe,
    cp.countries_with_riders,
    cp.countries_with_teams,
    cp.zero_activity_countries
FROM global_fp g
CROSS JOIN cp;""",
            click_action=None,
        ),
        CardSpec(
            slug="country_rider_nationality_bar",
            name="Riders by Nationality",
            description=(
                "Participating riders and race finishers by rider nationality (excludes unspecified nationality "
                "so the known-nationality total is 183 riders). Click a bar to open country members in the portal."
            ),
            tab_slug="tab_country",
            display="bar",
            row=4,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=COUNTRY_FILTER_KEYS,
            sql_functions_used=("dw.country_participation",),
            sql_query=f"""SELECT
    cp.country_code,
    cp.country_name,
    cp.rider_count,
    cp.finisher_count,
    ROUND(cp.finisher_rate * 100.0, 2)::numeric(6, 2) AS finisher_rate_pct
FROM dw.country_participation({f_country}) cp
WHERE cp.rider_count > 0
ORDER BY cp.rider_count DESC, cp.finisher_count DESC, cp.country_code ASC;""",
            visualization_settings={
                "graph.dimensions": ["country_name"],
                "graph.metrics": ["rider_count", "finisher_count"],
                "graph.x_axis.title_text": "Rider Nationality",
                "graph.y_axis.title_text": "Riders",
            },
            click_action=ClickActionSpec(
                source_column="country_code",
                target_param_key="country_code",
                clickable_columns=("country_code", "country_name"),
            ),
        ),
        CardSpec(
            slug="country_team_registration_bar",
            name="Teams by Registration Country",
            description=(
                "Number of participating teams by team registration country across all 23 teams. "
                "Click a bar to open country members in the portal."
            ),
            tab_slug="tab_country",
            display="bar",
            row=4,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=COUNTRY_FILTER_KEYS,
            sql_functions_used=("dw.country_participation",),
            sql_query=f"""SELECT
    cp.country_code,
    cp.country_name,
    cp.team_count,
    cp.rider_count
FROM dw.country_participation({f_country}) cp
WHERE cp.team_count > 0
ORDER BY cp.team_count DESC, cp.rider_count DESC, cp.country_code ASC;""",
            visualization_settings={
                "graph.dimensions": ["country_name"],
                "graph.metrics": ["team_count"],
                "graph.x_axis.title_text": "Team Registration Country",
                "graph.y_axis.title_text": "Teams",
            },
            click_action=ClickActionSpec(
                source_column="country_code",
                target_param_key="country_code",
                clickable_columns=("country_code", "country_name"),
            ),
        ),
        CardSpec(
            slug="country_full_universe_table",
            name="Country Participation Summary",
            description=(
                "Complete country participation table comparing rider nationality counts, finisher rate (%), "
                "and registered team counts across all known countries (including countries with 0 riders or 0 teams). "
                "Click a country label to open its members in the portal."
            ),
            tab_slug="tab_country",
            display="table",
            row=11,
            col=0,
            size_x=24,
            size_y=7,
            filter_keys=COUNTRY_DETAIL_FILTER_KEYS,
            sql_functions_used=("dw.country_participation",),
            sql_query=f"""SELECT
    cp.country_key,
    cp.country_code,
    cp.country_name,
    cp.rider_count,
    cp.finisher_count,
    ROUND(cp.finisher_rate * 100.0, 2)::numeric(6, 2) AS finisher_rate_pct,
    cp.team_count,
    CASE
        WHEN cp.rider_count > 0 AND cp.team_count > 0 THEN 'Riders & Registered Teams'
        WHEN cp.rider_count > 0 AND cp.team_count = 0 THEN 'Riders Only (0 Teams)'
        WHEN cp.rider_count = 0 AND cp.team_count > 0 THEN 'Registered Teams Only (0 Riders)'
        ELSE 'Zero Riders & Zero Teams'
    END AS country_role_profile
FROM dw.country_participation({f_country}) cp
WHERE (
    COALESCE(NULL::text [[ , NULLIF((ARRAY[{{{{country_code}}}}]::text[])[1], '') ]]) IS NULL
    OR cp.country_code = COALESCE(NULL::text [[ , NULLIF((ARRAY[{{{{country_code}}}}]::text[])[1], '') ]])
)
ORDER BY cp.rider_count DESC, cp.team_count DESC, cp.country_code ASC;""",
            click_action=ClickActionSpec(
                source_column="country_code",
                target_param_key="country_code",
                clickable_columns=("country_code", "country_name"),
            ),
        ),
        CardSpec(
            slug="country_rider_team_detail_table",
            name="Country Rider & Team Details",
            description=(
                "Country drill-down showing riders of that nationality and teams registered in that country "
                "(retaining a summary row when a zero-count country is selected). Click a rider label to open their stage trajectory in the portal."
            ),
            tab_slug="tab_country",
            display="table",
            row=18,
            col=0,
            size_x=24,
            size_y=8,
            filter_keys=COUNTRY_DETAIL_FILTER_KEYS,
            sql_functions_used=("dw.country_participation",),
            sql_query=f"""WITH cp AS (
    SELECT *
    FROM dw.country_participation({f_country})
    WHERE (
        COALESCE(NULL::text [[ , NULLIF((ARRAY[{{{{country_code}}}}]::text[])[1], '') ]]) IS NULL
        OR country_code = COALESCE(NULL::text [[ , NULLIF((ARRAY[{{{{country_code}}}}]::text[])[1], '') ]])
    )
),
matched_members AS (
    SELECT
        dc.country_key,
        CASE
            WHEN fp.rider_country_key = dc.country_key AND fp.team_country_key = dc.country_key
                THEN 'Rider Nationality & Team Registration'
            WHEN fp.rider_country_key = dc.country_key
                THEN 'Rider Nationality'
            ELSE 'Team Registration Country'
        END AS role_relationship,
        dr.bib_number,
        dr.rider_key,
        dr.rider_name,
        dr.is_young_rider,
        rc.country_code AS rider_nationality_code,
        dt.team_key,
        dt.team_name,
        tc.country_code AS team_registration_code,
        CASE WHEN fp.finished_race_flag = 1 THEN 'finished' ELSE 'exited' END AS participation_status
    FROM dw.dim_country dc
    JOIN dw.fact_participation fp
      ON (fp.rider_country_key = dc.country_key OR fp.team_country_key = dc.country_key)
    JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
    JOIN dw.dim_team dt ON dt.team_key = fp.team_key
    JOIN dw.dim_country rc ON rc.country_key = fp.rider_country_key
    JOIN dw.dim_country tc ON tc.country_key = fp.team_country_key
    WHERE dc.country_key > 0
      [[ AND fp.team_key = ANY(ARRAY[{{{{team_keys}}}}]::integer[]) ]]
      [[ AND fp.rider_key = ANY(ARRAY[{{{{rider_keys}}}}]::integer[]) ]]
      AND (
          NOT COALESCE(NULL::boolean [[ , (NULLIF((ARRAY[{{{{young_only}}}}]::text[])[1], ''))::boolean ]], FALSE)
          OR dr.is_young_rider = TRUE
      )
)
SELECT
    cp.country_code,
    cp.country_name,
    cp.rider_count AS country_rider_count,
    cp.team_count AS country_team_count,
    ROUND(cp.finisher_rate * 100.0, 2)::numeric(6, 2) AS country_finisher_rate_pct,
    COALESCE(mm.role_relationship, 'No Riders or Registered Teams (0 Count)')::text AS role_relationship,
    mm.bib_number,
    mm.rider_key,
    COALESCE(mm.rider_name, '—')::text AS rider_name,
    mm.is_young_rider,
    COALESCE(mm.rider_nationality_code, '—')::text AS rider_nationality_code,
    mm.team_key,
    COALESCE(mm.team_name, '—')::text AS team_name,
    COALESCE(mm.team_registration_code, '—')::text AS team_registration_code,
    COALESCE(mm.participation_status, 'n/a')::text AS participation_status
FROM cp
LEFT JOIN matched_members mm ON mm.country_key = cp.country_key
ORDER BY cp.rider_count DESC, cp.team_count DESC, cp.country_code ASC, mm.bib_number ASC NULLS LAST;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),

        # =====================================================================
        # TAB 5: Deep-Dive Insights (7 existing cards + 1 hidden source + 1 native Pivot)
        # =====================================================================
        CardSpec(
            slug="insight_rider_specialisation_crosstab_table",
            name="Rider Terrain Specialisation · Cross-Tab",
            description=(
                "Filterable four-terrain cross-tab matrix (Flat, Hilly, Mountain, Individual Time-Trial) "
                "comparing rider mean stage percentile (%), Top-10 finish rate (%), stage wins, mean gap to "
                "the stage winner (seconds), and stages sampled. Click a rider label to open their stage trajectory in the portal."
            ),
            tab_slug="tab_insights",
            display="table",
            row=0,
            col=0,
            size_x=14,
            size_y=7,
            filter_keys=SPECIALISATION_FILTER_KEYS,
            sql_functions_used=("dw.rider_specialisation",),
            sql_query=f"""SELECT
    sp.bib_number,
    sp.rider_key,
    sp.rider_name,
    sp.team_key,
    sp.team_name,
    sp.is_young_rider,
    MAX(sp.avg_rank_percentile) FILTER (WHERE sp.stage_type = 'flat') AS flat_avg_rank_pct,
    MAX(sp.avg_rank_percentile) FILTER (WHERE sp.stage_type = 'hilly') AS hilly_avg_rank_pct,
    MAX(sp.avg_rank_percentile) FILTER (WHERE sp.stage_type = 'mountain') AS mountain_avg_rank_pct,
    MAX(sp.avg_rank_percentile) FILTER (WHERE sp.stage_type = 'individual time-trial') AS itt_avg_rank_pct,
    ROUND(MAX(sp.top10_ratio) FILTER (WHERE sp.stage_type = 'flat') * 100.0, 1) AS flat_top10_pct,
    ROUND(MAX(sp.top10_ratio) FILTER (WHERE sp.stage_type = 'hilly') * 100.0, 1) AS hilly_top10_pct,
    ROUND(MAX(sp.top10_ratio) FILTER (WHERE sp.stage_type = 'mountain') * 100.0, 1) AS mountain_top10_pct,
    ROUND(MAX(sp.top10_ratio) FILTER (WHERE sp.stage_type = 'individual time-trial') * 100.0, 1) AS itt_top10_pct,
    COALESCE(MAX(sp.win_count) FILTER (WHERE sp.stage_type = 'flat'), 0)::integer AS flat_wins,
    COALESCE(MAX(sp.win_count) FILTER (WHERE sp.stage_type = 'hilly'), 0)::integer AS hilly_wins,
    COALESCE(MAX(sp.win_count) FILTER (WHERE sp.stage_type = 'mountain'), 0)::integer AS mountain_wins,
    COALESCE(MAX(sp.win_count) FILTER (WHERE sp.stage_type = 'individual time-trial'), 0)::integer AS itt_wins,
    MAX(sp.mean_gap_seconds) FILTER (WHERE sp.stage_type = 'flat') AS flat_mean_gap_s,
    MAX(sp.mean_gap_seconds) FILTER (WHERE sp.stage_type = 'hilly') AS hilly_mean_gap_s,
    MAX(sp.mean_gap_seconds) FILTER (WHERE sp.stage_type = 'mountain') AS mountain_mean_gap_s,
    MAX(sp.mean_gap_seconds) FILTER (WHERE sp.stage_type = 'individual time-trial') AS itt_mean_gap_s,
    SUM(sp.sample_count)::integer AS total_stages_sampled
FROM dw.rider_specialisation({f_spec}) sp
GROUP BY
    sp.rider_key,
    sp.bib_number,
    sp.rider_name,
    sp.team_key,
    sp.team_name,
    sp.is_young_rider
ORDER BY
    COALESCE(MAX(sp.avg_rank_percentile) FILTER (WHERE sp.stage_type = 'mountain'), 0) DESC,
    sp.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="insight_rider_specialisation_detail_bar",
            name="Rider Terrain Specialisation · Breakdown",
            description=(
                "Grouped bar chart of mean stage rank percentile (%) by terrain category (defaults to Top 10 "
                "GC finishers when unfiltered; Top-10 rates, wins, mean gaps, and sample counts appear in the "
                "Cross-Tab table). Click a bar to open stages of that terrain in the portal."
            ),
            tab_slug="tab_insights",
            display="bar",
            row=0,
            col=14,
            size_x=10,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.rider_standings", "dw.rider_specialisation"),
            sql_query=f"""WITH active_filters AS (
    SELECT {f_base} AS f
),
default_top10 AS (
    SELECT rider_key
    FROM dw.rider_standings((SELECT f || '{{"classification":"gc"}}'::jsonb FROM active_filters))
    ORDER BY rank ASC, bib_number ASC
    LIMIT 10
),
spec_rows AS (
    SELECT * FROM dw.rider_specialisation((SELECT f FROM active_filters))
)
SELECT
    sr.bib_number,
    sr.rider_key,
    ('#' || sr.bib_number || ' ' || sr.rider_name)::text AS rider_label,
    sr.rider_name,
    sr.team_name,
    sr.stage_type,
    sr.avg_rank_percentile,
    ROUND(sr.top10_ratio * 100.0, 2)::numeric(6, 2) AS top10_ratio_pct,
    sr.top10_count,
    sr.win_count,
    sr.mean_gap_seconds,
    sr.sample_count
FROM spec_rows sr
WHERE (
    (SELECT jsonb_exists(f, 'rider_keys') OR jsonb_exists(f, 'team_keys') FROM active_filters)
    OR sr.rider_key IN (SELECT rider_key FROM default_top10)
)
ORDER BY sr.bib_number ASC, sr.stage_type ASC;""",
            visualization_settings={
                "graph.dimensions": ["rider_label", "stage_type"],
                "graph.metrics": ["avg_rank_percentile"],
                "graph.x_axis.title_text": "Rider (#Bib & Name)",
                "graph.y_axis.title_text": "Mean Stage Percentile (%)",
            },
            click_action=ClickActionSpec(
                source_column="stage_type",
                target_param_key="stage_types",
                clickable_columns=("stage_type",),
            ),
        ),
        CardSpec(
            slug="insight_gc_evolution_line",
            name="GC Gap Evolution",
            description=(
                "Stage-by-stage cumulative time gap (seconds) to the contemporaneous race leader across stages "
                "1 to 21. Defaults to the Final GC Top 5 contenders and retains riders who later withdrew for "
                "all stages they completed when selected. Click a stage point to open its results in the portal."
            ),
            tab_slug="tab_insights",
            display="line",
            row=7,
            col=0,
            size_x=14,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.gc_evolution",),
            sql_query=f"""SELECT
    ge.stage_id,
    ge.stage_date,
    ge.race_week,
    ge.stage_type,
    ge.bib_number,
    ge.rider_key,
    ('#' || ge.bib_number || ' ' || ge.rider_name)::text AS rider_label,
    ge.rider_name,
    ge.team_name,
    ge.cumulative_rank,
    ge.cumulative_gap_seconds,
    ge.stage_net_change_seconds,
    ge.net_bonus_penalty_seconds,
    ge.time_basis
FROM dw.gc_evolution({f_base}) ge
ORDER BY ge.stage_order ASC, ge.cumulative_rank ASC, ge.bib_number ASC;""",
            visualization_settings={
                "graph.dimensions": ["stage_id", "rider_label"],
                "graph.metrics": ["cumulative_gap_seconds"],
                "graph.x_axis.title_text": "Stage Cutoff S",
                "graph.y_axis.title_text": "Cumulative Gap to Leader (seconds)",
            },
            click_action=ClickActionSpec(
                source_column="stage_id",
                target_param_key="stage_ids",
                clickable_columns=("stage_id",),
            ),
        ),
        CardSpec(
            slug="insight_gc_evolution_deltas_table",
            name="GC Stage Deltas & Bonuses",
            description=(
                "Stage-by-stage GC progression showing cumulative time and gap to the leader (seconds), "
                "single-stage net gap change (negative = gained time on leader), and time bonuses/penalties. "
                "Click a rider label to open their stage trajectory in the portal."
            ),
            tab_slug="tab_insights",
            display="table",
            row=7,
            col=14,
            size_x=10,
            size_y=7,
            filter_keys=ALL_COMMON_FILTER_KEYS,
            sql_functions_used=("dw.gc_evolution",),
            sql_query=f"""SELECT
    ge.stage_id,
    ge.stage_date,
    ge.race_week,
    ge.stage_type,
    ge.bib_number,
    ge.rider_key,
    ge.rider_name,
    ge.team_key,
    ge.team_name,
    ge.cumulative_rank,
    ge.stage_seconds,
    ge.cumulative_seconds,
    ge.leader_cumulative_seconds,
    ge.cumulative_gap_seconds,
    ge.stage_net_change_seconds,
    ge.stage_gap_seconds,
    ge.time_bonus_seconds,
    ge.time_penalty_seconds,
    ge.net_bonus_penalty_seconds,
    ge.cumulative_bonus_seconds,
    ge.cumulative_penalty_seconds,
    ge.cumulative_net_bonus_penalty_seconds,
    ge.time_basis
FROM dw.gc_evolution({f_base}) ge
ORDER BY ge.stage_order ASC, ge.cumulative_rank ASC, ge.bib_number ASC;""",
            click_action=ClickActionSpec(
                source_column="rider_key",
                target_param_key="rider_keys",
                clickable_columns=("bib_number", "rider_name"),
            ),
        ),
        CardSpec(
            slug="insight_team_depth_bar",
            name="Team Top-10 Stage Coverage",
            description=(
                "Percentage of stages in the selected scope where at least one team member finished in the Top 10 "
                "(distinct Top-10 riders, podiums, and wins are detailed in Team Competitiveness & Depth). "
                "Click a bar to open the team roster in the portal."
            ),
            tab_slug="tab_insights",
            display="bar",
            row=14,
            col=0,
            size_x=12,
            size_y=7,
            filter_keys=DEPTH_FILTER_KEYS,
            sql_functions_used=("dw.team_depth",),
            sql_query=f"""SELECT
    td.team_key,
    td.team_name,
    ROUND(td.top10_stage_coverage * 100.0, 2)::numeric(6, 2) AS top10_stage_coverage_pct,
    td.top10_distinct_riders,
    td.wins,
    td.podiums,
    td.top10_finishes
FROM dw.team_depth({f_depth}) td
ORDER BY td.top10_stage_coverage DESC, td.wins DESC, td.podiums DESC, td.team_key ASC;""",
            visualization_settings={
                "graph.dimensions": ["team_name"],
                "graph.metrics": ["top10_stage_coverage_pct"],
                "graph.x_axis.title_text": "Team",
                "graph.y_axis.title_text": "Top-10 Stage Coverage (%)",
            },
            click_action=ClickActionSpec(
                source_column="team_key",
                target_param_key="team_keys",
                clickable_columns=("team_name",),
            ),
        ),
        CardSpec(
            slug="insight_team_depth_table",
            name="Team Competitiveness & Depth",
            description=(
                "Team competitiveness summary comparing stage wins, podiums, Top-10 stage coverage (%), "
                "distinct Top-10 riders, race finishers, and finisher rate (%). Click a team label to open its full roster in the portal."
            ),
            tab_slug="tab_insights",
            display="table",
            row=14,
            col=12,
            size_x=12,
            size_y=7,
            filter_keys=DEPTH_FILTER_KEYS,
            sql_functions_used=("dw.team_depth",),
            sql_query=f"""SELECT
    td.team_key,
    td.team_name,
    td.wins,
    td.podiums,
    td.top10_finishes,
    td.top10_stages,
    td.selected_stage_count,
    ROUND(td.top10_stage_coverage * 100.0, 2)::numeric(6, 2) AS top10_stage_coverage_pct,
    td.top10_distinct_riders,
    td.finishers,
    td.participants,
    ROUND(td.finisher_rate * 100.0, 2)::numeric(6, 2) AS finisher_rate_pct
FROM dw.team_depth({f_depth}) td
ORDER BY td.wins DESC, td.podiums DESC, td.top10_stage_coverage DESC, td.team_key ASC;""",
            click_action=ClickActionSpec(
                source_column="team_key",
                target_param_key="team_keys",
                clickable_columns=("team_name",),
            ),
        ),
        CardSpec(
            slug="insight_olap_rollup_table",
            name="Team × Terrain OLAP Roll-Up",
            description=(
                "Hierarchical OLAP roll-up summary across Team and Stage Terrain showing detail rows, "
                "team subtotals, and the overall grand total."
            ),
            tab_slug="tab_insights",
            display="table",
            row=21,
            col=0,
            size_x=24,
            size_y=7,
            filter_keys=("team_keys", "stage_types"),
            sql_functions_used=("dw.olap_rollup",),
            sql_query="""SELECT
    r.rollup_level,
    r.team_key,
    r.team_name,
    r.stage_type,
    r.result_rows,
    r.distinct_riders,
    r.distinct_stages,
    r.total_finish_time_seconds,
    r.total_adjusted_time_seconds,
    r.total_stage_points_proxy,
    r.total_kom_points_proxy,
    r.stage_wins,
    r.podium_finishes,
    r.top10_finishes,
    r.avg_rank_percentile
FROM dw.olap_rollup r
WHERE (
    r.rollup_level = 'grand_total'
    [[ OR r.team_key = ANY(ARRAY[{{team_keys}}]::integer[]) ]]
    OR COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{team_keys}}]::integer[]) ]]) IS NULL
)
AND (
    r.rollup_level IN ('grand_total', 'team_total')
    [[ OR r.stage_type = ANY(ARRAY[{{stage_types}}]::text[]) ]]
    OR COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{stage_types}}]::text[]) ]]) IS NULL
)
ORDER BY
    r.team_grouping ASC,
    r.team_name ASC,
    r.stage_type_grouping ASC,
    r.stage_type ASC;""",
            click_action=None,
        ),
        # =====================================================================
        # Supplementary Native Metabase Pivot (Saved SQL Source -> Query Builder -> Pivot)
        # =====================================================================
        CardSpec(
            slug="insight_rider_specialisation_pivot_source",
            name="Rider Stage Percentile Source (Pivot Base)",
            description=(
                "Unparameterized full-race source question providing stage rank percentiles by rider and terrain "
                "for the native Metabase Pivot table."
            ),
            tab_slug="tab_insights",
            display="table",
            row=0,
            col=0,
            size_x=12,
            size_y=6,
            filter_keys=(),
            sql_functions_used=("dw.rider_stage_results",),
            sql_query="""SELECT
    rider_key,
    team_key,
    bib_number,
    ('#' || bib_number || ' ' || rider_name) AS rider_label,
    stage_id,
    stage_type,
    rank_percentile
FROM dw.rider_stage_results();""",
            click_action=None,
            on_dashboard=False,
            query_kind="native",
        ),
        CardSpec(
            slug="insight_rider_specialisation_pivot",
            name="Rider Terrain Specialisation · Pivot (Full Race)",
            description=(
                "Supplementary native Metabase Pivot table showing full-race mean stage rank percentile (%) and "
                "completed stage counts across all 21 stages by Rider and Stage Terrain. "
                "Use Rider Terrain Specialisation · Cross-Tab above for filtered scope analysis."
            ),
            tab_slug="tab_insights",
            display="pivot",
            row=28,
            col=0,
            size_x=24,
            size_y=8,
            filter_keys=(),
            sql_functions_used=(),
            sql_query="",
            visualization_settings={
                "pivot_table.column_split": {
                    "rows": [["field", "rider_label", {"base-type": "type/Text"}]],
                    "columns": [["field", "stage_type", {"base-type": "type/Text"}]],
                    "values": [
                        ["aggregation", 0],
                        ["aggregation", 1],
                    ],
                },
                "pivot_table.collapsed_rows": {
                    "value": [],
                    "rows": [],
                },
            },
            click_action=None,
            on_dashboard=True,
            query_kind="pivot_mbql",
            source_card_slug="insight_rider_specialisation_pivot_source",
        ),
    )


CARD_SPECS: Tuple[CardSpec, ...] = _build_card_specs()
DASHBOARD_CARD_SPECS: Tuple[CardSpec, ...] = tuple(s for s in CARD_SPECS if s.on_dashboard)


# ---------------------------------------------------------------------------
# 3. Payload Builders & Metadata-Informed Table Formatting
# ---------------------------------------------------------------------------

def build_collection_payload(
    name: str = DEFAULT_COLLECTION_NAME,
    description: str = DEFAULT_COLLECTION_DESCRIPTION,
) -> Dict[str, Any]:
    """Build payload for POST /api/collection."""
    return {
        "name": name,
        "description": description,
    }


def get_card_column_label(spec: CardSpec, name: str) -> str:
    if spec.tab_slug == "tab_country" and name == "finisher_count":
        return "Race Finishers"
    return get_column_label(name)


def build_card_visualization_settings(
    spec: CardSpec,
    result_metadata: Optional[Sequence[Mapping[str, Any]]] = None,
    include_click_behavior: bool = False,
    portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
) -> Dict[str, Any]:
    """Build visualization_settings with metadata-informed table.columns and merged column_settings.

    - For table cards: hides surrogate ``*_key`` columns via ``table.columns`` (``enabled: False``)
      while keeping them in the SQL result set for portal links; assigns every column a
      readable ``column_title`` with units in ``column_settings``; and merges ``click_behavior``
      into the clickable column entries when ``include_click_behavior=True``.
    - For bar/line charts: assigns readable ``column_title`` labels to plotted dimension/metric
      columns in ``column_settings`` and attaches top-level ``click_behavior`` when requested.
    """
    vis: Dict[str, Any] = dict(spec.visualization_settings)
    col_settings: Dict[str, Dict[str, Any]] = {
        k: dict(v) for k, v in (vis.get("column_settings") or {}).items() if isinstance(v, Mapping)
    }

    if spec.display == "table" and spec.query_kind == "native":
        meta_list = (
            list(result_metadata)
            if result_metadata is not None and len(result_metadata) > 0
            else build_default_result_metadata(spec.sql_query)
        )
        table_cols: List[Dict[str, Any]] = []
        for col_meta in meta_list:
            if not isinstance(col_meta, Mapping) or not col_meta.get("name"):
                continue
            col_name = str(col_meta["name"])
            base_type = str(col_meta.get("base_type") or infer_metabase_base_type(col_name))
            field_ref = col_meta.get("field_ref") or ["field", col_name, {"base-type": base_type}]
            hidden = is_hidden_surrogate_key(col_name)
            table_cols.append(
                {
                    "name": col_name,
                    "fieldRef": field_ref,
                    "enabled": not hidden,
                }
            )
            col_key = json.dumps(["name", col_name], separators=(",", ":"))
            entry = dict(col_settings.get(col_key) or {})
            entry["column_title"] = get_card_column_label(spec, col_name)
            col_settings[col_key] = entry

        vis["table.columns"] = table_cols

        if include_click_behavior and spec.click_action is not None:
            overrides = {}
            if spec.slug == "perf_team_stage_top3_table":
                overrides["team_aggregation"] = "stage_top3"
            elif spec.slug == "perf_team_cumulative_top3_table":
                overrides["team_aggregation"] = "cumulative_top3"
            actions = {col: spec.click_action for col in
                       (spec.click_action.clickable_columns or (spec.click_action.source_column,))}
            names = {c["name"] for c in table_cols}
            # Distinct labels in a member/result row lead to their own dimension's detail.
            for key, target, labels in [("team_key", "team_keys", ("team_name",)),
                                        ("rider_key", "rider_keys", ("bib_number", "rider_name")),
                                        ("stage_id", "stage_ids", ("stage_id", "stage_name"))]:
                if key in names:
                    for col in labels:
                        if col in names:
                            actions[col] = ClickActionSpec(key, target)
            for col_name, action in actions.items():
                col_key = json.dumps(["name", col_name], separators=(",", ":"))
                entry = dict(col_settings.get(col_key) or {})
                entry.setdefault("column_title", get_card_column_label(spec, col_name))
                entry["click_behavior"] = action.to_click_behavior_dict(portal_base_url, overrides)
                col_settings[col_key] = entry

        vis["column_settings"] = col_settings
        return vis

    # Bar / Line chart readable series/dimension labels
    if spec.display in ("bar", "line"):
        chart_cols = list(vis.get("graph.dimensions") or []) + list(vis.get("graph.metrics") or [])
        for col_name in chart_cols:
            if isinstance(col_name, str):
                col_key = json.dumps(["name", col_name], separators=(",", ":"))
                entry = dict(col_settings.get(col_key) or {})
                entry.setdefault("column_title", get_card_column_label(spec, col_name))
                col_settings[col_key] = entry
        if col_settings:
            vis["column_settings"] = col_settings
        if include_click_behavior and spec.click_action is not None:
            overrides = ({"team_aggregation": "{{column:aggregation_method}}"}
                         if spec.slug == "perf_team_methods_comparison_bar" else None)
            vis["click_behavior"] = spec.click_action.to_click_behavior_dict(portal_base_url, overrides)
        return vis

    if include_click_behavior and spec.click_action is not None:
        vis["click_behavior"] = spec.click_action.to_click_behavior_dict(portal_base_url)
    return vis


def build_dashcard_visualization_settings(
    spec: CardSpec,
    result_metadata: Optional[Sequence[Mapping[str, Any]]] = None,
    portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
) -> Dict[str, Any]:
    """Build dashcard-level visualization_settings with merged column_settings and click_behavior."""
    return build_card_visualization_settings(
        spec,
        result_metadata=result_metadata,
        include_click_behavior=True,
        portal_base_url=portal_base_url,
    )


def build_card_payload(
    spec: CardSpec,
    collection_id: int,
    database_id: int = DEFAULT_DATABASE_ID,
    source_card_id: Optional[int] = None,
    result_metadata: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """Build payload for POST /api/card or PUT /api/card/{id}."""
    if spec.query_kind == "pivot_mbql":
        if not isinstance(source_card_id, int) or source_card_id <= 0:
            raise ValueError(f"Card {spec.slug} requires a positive source_card_id for card__<id> source-table")
        dataset_query: Dict[str, Any] = {
            "type": "query",
            "database": database_id,
            "query": {
                "source-table": f"card__{source_card_id}",
                "aggregation": [
                    ["avg", ["field", "rank_percentile", {"base-type": "type/Decimal"}]],
                    ["count"],
                ],
                "breakout": [
                    ["field", "rider_label", {"base-type": "type/Text"}],
                    ["field", "stage_type", {"base-type": "type/Text"}],
                ],
            },
        }
    else:
        dataset_query = {
            "type": "native",
            "database": database_id,
            "native": {
                "query": spec.sql_query,
                "template-tags": build_template_tags(spec.filter_keys),
            },
        }

    return {
        "name": spec.name,
        "description": spec.description,
        "collection_id": collection_id,
        "display": spec.display,
        "visualization_settings": build_card_visualization_settings(
            spec,
            result_metadata=result_metadata,
            include_click_behavior=False,
        ),
        "dataset_query": dataset_query,
    }


def build_dashboard_create_payload(
    collection_id: int,
    name: str = DEFAULT_DASHBOARD_NAME,
    description: str = DEFAULT_DASHBOARD_DESCRIPTION,
    lookup_values: Optional[Mapping[str, Sequence[Sequence[Any]]]] = None,
) -> Dict[str, Any]:
    """Build payload for POST /api/dashboard."""
    return {
        "name": name,
        "description": description,
        "collection_id": collection_id,
        "parameters": build_dashboard_parameters(lookup_values=lookup_values),
    }


def build_dashboard_put_payload(
    collection_id: int,
    card_ids_by_slug: Mapping[str, int],
    existing_tab_ids_by_slug: Optional[Mapping[str, int]] = None,
    existing_dashcard_ids_by_slug: Optional[Mapping[str, int]] = None,
    lookup_values: Optional[Mapping[str, Sequence[Sequence[Any]]]] = None,
    existing_dashboard: Optional[Mapping[str, Any]] = None,
    card_metadata_by_slug: Optional[Mapping[str, Sequence[Mapping[str, Any]]]] = None,
    name: str = DEFAULT_DASHBOARD_NAME,
    description: str = DEFAULT_DASHBOARD_DESCRIPTION,
    portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
) -> Tuple[Dict[str, Any], List[str]]:
    """Build payload for PUT /api/dashboard/{id} and return ordered dashcard slugs."""
    portal_base_url = validate_portal_base_url(portal_base_url)
    existing_tabs = existing_tab_ids_by_slug or {}
    existing_dashcards = existing_dashcard_ids_by_slug or {}
    metadata_map = card_metadata_by_slug or {}

    tabs_payload: List[Dict[str, Any]] = []
    tab_id_by_slug: Dict[str, int] = {}
    for tab in TAB_SPECS:
        tab_id = existing_tabs.get(tab.slug, tab.temp_id)
        tab_id_by_slug[tab.slug] = tab_id
        tabs_payload.append(
            {
                "id": tab_id,
                "name": tab.name,
                "position": tab.position,
            }
        )

    dashcards_payload: List[Dict[str, Any]] = []
    dashcard_slug_order: List[str] = []
    next_temp_id = -101

    # 1. Virtual markdown caption cards
    for cap in CAPTION_SPECS:
        dc_id = existing_dashcards.get(cap.slug, next_temp_id)
        if dc_id < 0:
            next_temp_id -= 1
        dashcard_slug_order.append(cap.slug)
        dashcards_payload.append(
            {
                "id": dc_id,
                "card_id": None,
                "dashboard_tab_id": tab_id_by_slug[cap.tab_slug],
                "row": cap.row,
                "col": cap.col,
                "size_x": cap.size_x,
                "size_y": cap.size_y,
                "parameter_mappings": [],
                "visualization_settings": {
                    "virtual_card": {
                        "name": None,
                        "display": "text",
                        "visualization_settings": {},
                        "dataset_query": {},
                        "archived": False,
                    },
                    "text": cap.markdown_text,
                },
            }
        )

    # 2. Analytical data cards placed on dashboard tabs
    for spec in DASHBOARD_CARD_SPECS:
        if spec.slug not in card_ids_by_slug:
            raise KeyError(f"Missing provisioned card_id for card slug: {spec.slug}")
        card_id = card_ids_by_slug[spec.slug]
        dc_id = existing_dashcards.get(spec.slug, next_temp_id)
        if dc_id < 0:
            next_temp_id -= 1
        dashcard_slug_order.append(spec.slug)
        dashcards_payload.append(
            {
                "id": dc_id,
                "card_id": card_id,
                "dashboard_tab_id": tab_id_by_slug[spec.tab_slug],
                "row": spec.row,
                "col": spec.col,
                "size_x": spec.size_x,
                "size_y": spec.size_y,
                "parameter_mappings": build_parameter_mappings(card_id, spec.filter_keys),
                "visualization_settings": build_dashcard_visualization_settings(
                    spec,
                    result_metadata=metadata_map.get(spec.slug),
                    portal_base_url=portal_base_url,
                ),
            }
        )

    payload: Dict[str, Any] = {
        "name": name,
        "description": description,
        "collection_id": collection_id,
        "width": "full",
        "auto_apply_filters": True,
        "parameters": build_dashboard_parameters(lookup_values=lookup_values),
        "tabs": tabs_payload,
        "dashcards": dashcards_payload,
    }

    if isinstance(existing_dashboard, Mapping):
        if existing_dashboard.get("enable_embedding") is not None:
            payload["enable_embedding"] = bool(existing_dashboard["enable_embedding"])
        if isinstance(existing_dashboard.get("embedding_params"), Mapping):
            payload["embedding_params"] = dict(existing_dashboard["embedding_params"])

    return payload, dashcard_slug_order


def build_dry_run_bundle(
    database_id: int = DEFAULT_DATABASE_ID,
    state: Optional[Mapping[str, Any]] = None,
    lookup_values: Optional[Mapping[str, Sequence[Sequence[Any]]]] = None,
    card_metadata_by_slug: Optional[Mapping[str, Sequence[Mapping[str, Any]]]] = None,
    portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
) -> Dict[str, Any]:
    """Generate the complete deterministic dry-run API payload bundle without network calls."""
    existing_state = state or {}
    collection_id = int(existing_state.get("collection_id") or 6)
    dashboard_id = int(existing_state.get("dashboard_id") or 3)
    existing_cards: Mapping[str, int] = existing_state.get("cards") or {}
    existing_tabs: Mapping[str, int] = existing_state.get("tabs") or {}
    existing_dashcards: Mapping[str, int] = existing_state.get("dashcards") or {}
    metadata_map = card_metadata_by_slug or {}

    card_ids_by_slug: Dict[str, int] = {}
    cards_list: List[Dict[str, Any]] = []
    for idx, spec in enumerate(CARD_SPECS, start=1001):
        cid = int(existing_cards.get(spec.slug, idx))
        card_ids_by_slug[spec.slug] = cid

    for spec in CARD_SPECS:
        cid = card_ids_by_slug[spec.slug]
        src_id = card_ids_by_slug.get(spec.source_card_slug) if spec.source_card_slug else None
        cards_list.append(
            {
                "slug": spec.slug,
                "tab_slug": spec.tab_slug,
                "on_dashboard": spec.on_dashboard,
                "query_kind": spec.query_kind,
                "card_id_preview": cid,
                "sql_functions_used": list(spec.sql_functions_used),
                "has_click_behavior": spec.click_action is not None,
                "payload": build_card_payload(
                    spec,
                    collection_id=collection_id,
                    database_id=database_id,
                    source_card_id=src_id,
                    result_metadata=metadata_map.get(spec.slug),
                ),
            }
        )

    dashboard_put_payload, dashcard_order = build_dashboard_put_payload(
        collection_id=collection_id,
        card_ids_by_slug=card_ids_by_slug,
        existing_tab_ids_by_slug=existing_tabs,
        existing_dashcard_ids_by_slug=existing_dashcards,
        lookup_values=lookup_values,
        card_metadata_by_slug=metadata_map,
        portal_base_url=portal_base_url,
    )

    return {
        "mode": "dry-run",
        "database_id": database_id,
        "protected_objects": {
            "collections": sorted(PROTECTED_COLLECTION_IDS),
            "dashboards": sorted(PROTECTED_DASHBOARD_IDS),
            "cards": sorted(PROTECTED_CARD_IDS),
        },
        "collection_post_payload": build_collection_payload(),
        "dashboard_post_payload": build_dashboard_create_payload(
            collection_id=collection_id,
            lookup_values=lookup_values,
        ),
        "cards": cards_list,
        "dashboard_id_preview": dashboard_id,
        "dashboard_put_payload": dashboard_put_payload,
        "dashcard_slug_order": dashcard_order,
    }


# ---------------------------------------------------------------------------
# 4. Credentials & Redacted HTTP Client
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AuthConfig:
    """In-memory authentication configuration; never serialized or logged."""

    session_token: Optional[str] = None
    api_key: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None

    def __repr__(self) -> str:
        return "AuthConfig(<redacted>)"


def _parse_credentials_file(path: Path) -> Dict[str, str]:
    """Parse a credentials file in JSON, KEY=VALUE (.env), or single-line token format."""
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        raise ValueError(f"Credentials file is empty: {path}")

    if raw.startswith("{"):
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("JSON credentials file must contain an object")
        return {str(k): str(v) for k, v in data.items() if v is not None}

    lines = [
        line.strip()
        for line in raw.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if len(lines) == 1 and "=" not in lines[0]:
        return {"session_token": lines[0]}

    parsed: Dict[str, str] = {}
    for line in lines:
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        val = v.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        parsed[k.strip()] = val
    return parsed


def resolve_credentials(
    credentials_file: Optional[Path] = None,
    session_token: Optional[str] = None,
    api_key: Optional[str] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> AuthConfig:
    """Resolve Metabase credentials from CLI args, environment, or credentials file."""
    env = environ if environ is not None else os.environ
    file_data: Dict[str, str] = {}

    cred_path = credentials_file
    if cred_path is None:
        env_path = env.get("MB_CREDENTIALS_FILE") or env.get("METABASE_CREDENTIALS_FILE")
        if env_path:
            cred_path = Path(env_path)

    if cred_path is not None:
        file_data = _parse_credentials_file(cred_path)

    def _pick(*keys: str) -> Optional[str]:
        for k in keys:
            if k in env and env[k].strip():
                return env[k].strip()
            if k in file_data and file_data[k].strip():
                return file_data[k].strip()
            k_lower = k.lower()
            if k_lower in file_data and file_data[k_lower].strip():
                return file_data[k_lower].strip()
        return None

    tok = (session_token or "").strip() or _pick(
        "MB_SESSION_TOKEN",
        "METABASE_SESSION_TOKEN",
        "X_METABASE_SESSION",
        "SESSION_TOKEN",
        "session_token",
        "token",
    )
    key = (api_key or "").strip() or _pick(
        "MB_API_KEY",
        "METABASE_API_KEY",
        "X_API_KEY",
        "API_KEY",
        "api_key",
    )
    user = _pick(
        "MB_ADMIN_EMAIL",
        "METABASE_ADMIN_EMAIL",
        "MB_EMAIL",
        "METABASE_EMAIL",
        "MB_USERNAME",
        "METABASE_USERNAME",
        "ADMIN_EMAIL",
        "email",
        "username",
    )
    pwd = _pick(
        "MB_ADMIN_PASSWORD",
        "METABASE_ADMIN_PASSWORD",
        "MB_PASSWORD",
        "METABASE_PASSWORD",
        "ADMIN_PASSWORD",
        "password",
    )

    if not tok and not key and not (user and pwd):
        raise ValueError(
            "No Metabase credentials provided. Supply --credentials-file PATH, "
            "MB_SESSION_TOKEN, MB_API_KEY, or MB_ADMIN_EMAIL + MB_ADMIN_PASSWORD."
        )
    return AuthConfig(session_token=tok, api_key=key, username=user, password=pwd)


TransportCallable = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, bytes]]


class MetabaseClient:
    """Minimal stdlib REST client for Metabase with strict credential redaction."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        auth: Optional[AuthConfig] = None,
        timeout_seconds: int = 30,
        transport: Optional[TransportCallable] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._auth = auth
        self._session_token: Optional[str] = auth.session_token if auth else None
        self._api_key: Optional[str] = auth.api_key if auth else None
        self._timeout = timeout_seconds
        self._transport = transport

    def _default_transport(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes],
    ) -> Tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return int(resp.status), resp.read()
        except urllib.error.HTTPError as exc:
            err_body = exc.read() if exc.fp is not None else b""
            return int(exc.code), err_body

    def ensure_authenticated(self) -> None:
        """Obtain a session token via POST /api/session if using username/password."""
        if self._session_token or self._api_key:
            return
        if not self._auth or not self._auth.username or not self._auth.password:
            raise RuntimeError("Cannot authenticate: missing session token, API key, or credentials.")
        resp = self.request(
            "POST",
            "/api/session",
            {"username": self._auth.username, "password": self._auth.password},
            require_auth=False,
        )
        if not isinstance(resp, dict) or not resp.get("id"):
            raise RuntimeError("Authentication via POST /api/session did not return a session id.")
        self._session_token = str(resp["id"])

    def request(
        self,
        method: str,
        path: str,
        payload: Optional[Any] = None,
        require_auth: bool = True,
        allow_404: bool = False,
    ) -> Any:
        """Execute an HTTP request against the Metabase API without leaking credentials."""
        if require_auth:
            self.ensure_authenticated()

        url = f"{self.base_url}{path if path.startswith('/') else '/' + path}"
        headers: Dict[str, str] = {"Accept": "application/json"}
        if require_auth:
            if self._api_key:
                headers["X-API-Key"] = self._api_key
            elif self._session_token:
                headers["X-Metabase-Session"] = self._session_token

        body: Optional[bytes] = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")

        transport = self._transport or self._default_transport
        status, raw_bytes = transport(method.upper(), url, headers, body)

        if status == 404 and allow_404:
            return None
        if status < 200 or status >= 300:
            snippet = raw_bytes.decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Metabase API {method} {path} failed with HTTP {status}: {snippet}")

        if not raw_bytes:
            return {}
        text = raw_bytes.decode("utf-8", errors="replace").strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}


# ---------------------------------------------------------------------------
# 5. State Mapping & Idempotent Provisioner
# ---------------------------------------------------------------------------

def load_state_file(path: Path) -> Dict[str, Any]:
    """Load persisted object ID state from ``build/metabase-state.json`` if present."""
    if not path.exists():
        return {"collection_id": None, "dashboard_id": None, "tabs": {}, "cards": {}, "dashcards": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Invalid state file format in {path}")
    return {
        "collection_id": data.get("collection_id"),
        "dashboard_id": data.get("dashboard_id"),
        "tabs": dict(data.get("tabs") or {}),
        "cards": dict(data.get("cards") or {}),
        "dashcards": dict(data.get("dashcards") or {}),
    }


def save_state_file(path: Path, state: Mapping[str, Any]) -> None:
    """Persist positive Metabase object IDs to ``build/metabase-state.json``."""
    clean_tabs = {k: int(v) for k, v in (state.get("tabs") or {}).items() if int(v) > 0}
    clean_cards = {k: int(v) for k, v in (state.get("cards") or {}).items() if int(v) > 0}
    clean_dashcards = {k: int(v) for k, v in (state.get("dashcards") or {}).items() if int(v) > 0}
    out = {
        "collection_id": int(state["collection_id"]) if state.get("collection_id") else None,
        "dashboard_id": int(state["dashboard_id"]) if state.get("dashboard_id") else None,
        "tabs": clean_tabs,
        "cards": clean_cards,
        "dashcards": clean_dashcards,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def map_returned_dashboard_ids(
    remote_dashboard: Mapping[str, Any],
    card_ids_by_slug: Mapping[str, int],
) -> Tuple[Dict[str, int], Dict[str, int]]:
    """Map returned positive tab IDs and dashcard IDs from GET/PUT /api/dashboard/{id}."""
    remote_tabs = remote_dashboard.get("tabs") or []
    tab_id_by_name: Dict[str, int] = {}
    tab_id_by_pos: Dict[int, int] = {}
    for rt in remote_tabs:
        if isinstance(rt, dict) and isinstance(rt.get("id"), int) and rt["id"] > 0:
            if isinstance(rt.get("name"), str):
                tab_id_by_name[rt["name"]] = rt["id"]
            if isinstance(rt.get("position"), int):
                tab_id_by_pos[rt["position"]] = rt["id"]

    mapped_tabs: Dict[str, int] = {}
    for spec in TAB_SPECS:
        real_tab_id = tab_id_by_name.get(spec.name) or tab_id_by_pos.get(spec.position)
        if real_tab_id is not None and real_tab_id > 0:
            mapped_tabs[spec.slug] = real_tab_id

    remote_dashcards = remote_dashboard.get("dashcards") or []
    by_tab_and_card: Dict[Tuple[Optional[int], int], int] = {}
    by_card_only: Dict[int, int] = {}
    by_tab_and_pos_virtual: Dict[Tuple[Optional[int], int, int], int] = {}

    for dc in remote_dashcards:
        if not isinstance(dc, dict) or not isinstance(dc.get("id"), int) or dc["id"] <= 0:
            continue
        dc_id = int(dc["id"])
        tab_id = dc.get("dashboard_tab_id")
        card_id = dc.get("card_id")
        row = int(dc.get("row", -1))
        col = int(dc.get("col", -1))
        if isinstance(card_id, int) and card_id > 0:
            by_tab_and_card[(tab_id, card_id)] = dc_id
            by_card_only[card_id] = dc_id
        else:
            by_tab_and_pos_virtual[(tab_id, row, col)] = dc_id

    mapped_dashcards: Dict[str, int] = {}
    for cap in CAPTION_SPECS:
        t_id = mapped_tabs.get(cap.tab_slug)
        dc_id = by_tab_and_pos_virtual.get((t_id, cap.row, cap.col))
        if dc_id is not None and dc_id > 0:
            mapped_dashcards[cap.slug] = dc_id

    for spec in DASHBOARD_CARD_SPECS:
        cid = card_ids_by_slug.get(spec.slug)
        if cid is None:
            continue
        t_id = mapped_tabs.get(spec.tab_slug)
        dc_id = by_tab_and_card.get((t_id, cid)) or by_card_only.get(cid)
        if dc_id is not None and dc_id > 0:
            mapped_dashcards[spec.slug] = dc_id

    return mapped_tabs, mapped_dashcards


class DashboardProvisioner:
    """Idempotent Metabase provisioner for collection, cards, and 5-tab dashboard."""

    def __init__(
        self,
        client: MetabaseClient,
        database_id: int = DEFAULT_DATABASE_ID,
        state_path: Path = DEFAULT_STATE_PATH,
        portal_base_url: str = DEFAULT_PORTAL_BASE_URL,
        protected_ids: Optional[Mapping[str, Sequence[int]]] = None,
    ) -> None:
        # Legacy protections belong to the original installation only. A new
        # dedicated Compose installation supplies an empty mapping explicitly.
        guards = protected_ids if protected_ids is not None else {
            'collections': PROTECTED_COLLECTION_IDS,
            'dashboards': PROTECTED_DASHBOARD_IDS,
            'cards': PROTECTED_CARD_IDS,
        }
        self.protected_collections = frozenset(guards.get('collections', ()))
        self.protected_dashboards = frozenset(guards.get('dashboards', ()))
        self.protected_cards = frozenset(guards.get('cards', ()))
        self.client = client
        self.database_id = database_id
        self.state_path = state_path
        self.portal_base_url = validate_portal_base_url(portal_base_url)
        self.card_metadata_by_slug: Dict[str, List[Dict[str, Any]]] = {}

    def sync_and_inspect_schema(self) -> Dict[str, int]:
        """Trigger POST /api/database/{id}/sync_schema and inspect dw table metadata."""
        self.client.request("POST", f"/api/database/{self.database_id}/sync_schema", {})
        meta = self.client.request("GET", f"/api/database/{self.database_id}/metadata")
        dw_tables: Dict[str, int] = {}
        if isinstance(meta, dict):
            for tbl in meta.get("tables") or []:
                if isinstance(tbl, dict) and tbl.get("schema") == "dw" and tbl.get("name") and tbl.get("id"):
                    dw_tables[str(tbl["name"])] = int(tbl["id"])
        return dw_tables

    def fetch_dimension_lookup_values(self) -> Dict[str, List[List[Any]]]:
        """Fetch dropdown lookup values via read-only POST /api/dataset queries over dw dimensions."""
        lookups: Dict[str, List[List[Any]]] = {}
        for key, sql in LOOKUP_QUERIES.items():
            spec = FILTER_SPECS[key]
            resp = self.client.request(
                "POST",
                "/api/dataset",
                {
                    "database": self.database_id,
                    "type": "native",
                    "native": {"query": sql},
                },
            )
            rows = (
                resp.get("data", {}).get("rows", [])
                if isinstance(resp, dict) and isinstance(resp.get("data"), dict)
                else []
            )
            formatted: List[List[Any]] = []
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, (list, tuple)) and len(row) >= 2 and row[0] is not None:
                        val = int(row[0]) if spec.tag_type == "number" else str(row[0]).strip()
                        label = str(row[1]).strip()
                        formatted.append([val, label])
            lookups[key] = formatted if formatted else list(DEFAULT_LOOKUP_FIXTURES.get(key, []))
        return lookups

    def ensure_collection(self, state: Dict[str, Any]) -> int:
        """Reuse or create the dedicated collection ``Project 3 OLAP``."""
        existing_id = state.get("collection_id")
        if isinstance(existing_id, int) and existing_id > 0:
            if existing_id in self.protected_collections:
                raise RuntimeError(f"Refusing to touch protected collection ID {existing_id}")
            remote = self.client.request("GET", f"/api/collection/{existing_id}", allow_404=True)
            if isinstance(remote, dict) and remote.get("id") == existing_id:
                return existing_id

        collections = self.client.request("GET", "/api/collection")
        if isinstance(collections, list):
            for col in collections:
                if (
                    isinstance(col, dict)
                    and col.get("name") == DEFAULT_COLLECTION_NAME
                    and isinstance(col.get("id"), int)
                    and col["id"] not in self.protected_collections
                    and not col.get("archived", False)
                ):
                    state["collection_id"] = int(col["id"])
                    return int(col["id"])

        created = self.client.request("POST", "/api/collection", build_collection_payload())
        if not isinstance(created, dict) or not isinstance(created.get("id"), int):
            raise RuntimeError("POST /api/collection did not return a valid collection id")
        col_id = int(created["id"])
        state["collection_id"] = col_id
        return col_id

    def _list_collection_items(self, collection_id: int, model: str) -> Dict[str, int]:
        resp = self.client.request(
            "GET",
            f"/api/collection/{collection_id}/items?models={urllib.parse.quote(model)}",
            allow_404=True,
        )
        items = resp.get("data") if isinstance(resp, dict) else None
        found: Dict[str, int] = {}
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("id"), int):
                    found[item["name"]] = int(item["id"])
        return found

    def _extract_card_result_metadata(
        self,
        spec: CardSpec,
        card_id: int,
        card_resp: Optional[Mapping[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Obtain column result metadata from the card object or POST /api/card/{id}/query."""
        if isinstance(card_resp, Mapping):
            rm = card_resp.get("result_metadata")
            if isinstance(rm, list) and len(rm) > 0:
                return [dict(col) for col in rm if isinstance(col, Mapping) and col.get("name")]

        q_resp = self.client.request("POST", f"/api/card/{card_id}/query", {})
        if isinstance(q_resp, Mapping) and isinstance(q_resp.get("data"), Mapping):
            cols = q_resp["data"].get("cols")
            if isinstance(cols, list) and len(cols) > 0:
                return [dict(col) for col in cols if isinstance(col, Mapping) and col.get("name")]

        return build_default_result_metadata(spec.sql_query)

    def ensure_cards(self, collection_id: int, state: Dict[str, Any]) -> Dict[str, int]:
        """Create or update all analytical cards in place and apply metadata-informed table formatting."""
        state_cards: Dict[str, int] = dict(state.get("cards") or {})
        existing_by_name = self._list_collection_items(collection_id, "card")

        resolved: Dict[str, int] = {}
        for spec in CARD_SPECS:
            source_id = resolved.get(spec.source_card_slug) if spec.source_card_slug else None
            payload = build_card_payload(
                spec,
                collection_id=collection_id,
                database_id=self.database_id,
                source_card_id=source_id,
            )
            candidate_id = state_cards.get(spec.slug) or existing_by_name.get(spec.name)

            card_id: Optional[int] = None
            card_resp: Optional[Dict[str, Any]] = None
            if isinstance(candidate_id, int) and candidate_id > 0:
                if candidate_id in self.protected_cards:
                    raise RuntimeError(f"Refusing to modify protected card ID {candidate_id}")
                updated = self.client.request(
                    "PUT",
                    f"/api/card/{candidate_id}",
                    {**payload, "archived": False},
                    allow_404=True,
                )
                if isinstance(updated, dict) and isinstance(updated.get("id"), int):
                    card_id = int(updated["id"])
                    card_resp = updated

            if card_id is None:
                created = self.client.request("POST", "/api/card", payload)
                if not isinstance(created, dict) or not isinstance(created.get("id"), int):
                    raise RuntimeError(f"POST /api/card failed for {spec.slug}")
                card_id = int(created["id"])
                card_resp = created

            resolved[spec.slug] = card_id

            # Warm result metadata for hidden source question or fetch live metadata for native table cards
            if not spec.on_dashboard:
                self.client.request("POST", f"/api/card/{card_id}/query", {})
            elif spec.display == "table" and spec.query_kind == "native":
                live_meta = self._extract_card_result_metadata(spec, card_id, card_resp)
                self.card_metadata_by_slug[spec.slug] = live_meta
                formatted_payload = build_card_payload(
                    spec,
                    collection_id=collection_id,
                    database_id=self.database_id,
                    source_card_id=source_id,
                    result_metadata=live_meta,
                )
                if formatted_payload["visualization_settings"] != payload["visualization_settings"]:
                    self.client.request(
                        "PUT",
                        f"/api/card/{card_id}",
                        {**formatted_payload, "archived": False},
                    )

        state["cards"] = resolved
        return resolved

    def ensure_dashboard(
        self,
        collection_id: int,
        card_ids_by_slug: Mapping[str, int],
        state: Dict[str, Any],
        lookup_values: Optional[Mapping[str, Sequence[Sequence[Any]]]] = None,
    ) -> int:
        """Create or update the 5-tab dashboard, preserving embedding and positive IDs."""
        dashboard_id = state.get("dashboard_id")
        remote_dash: Optional[Dict[str, Any]] = None

        if isinstance(dashboard_id, int) and dashboard_id > 0:
            if dashboard_id in self.protected_dashboards:
                raise RuntimeError(f"Refusing to modify protected dashboard ID {dashboard_id}")
            remote_dash = self.client.request("GET", f"/api/dashboard/{dashboard_id}", allow_404=True)

        if not isinstance(remote_dash, dict):
            existing_dashboards = self._list_collection_items(collection_id, "dashboard")
            candidate_id = existing_dashboards.get(DEFAULT_DASHBOARD_NAME)
            if isinstance(candidate_id, int) and candidate_id not in self.protected_dashboards:
                remote_dash = self.client.request("GET", f"/api/dashboard/{candidate_id}", allow_404=True)
                if isinstance(remote_dash, dict):
                    dashboard_id = candidate_id

        if not isinstance(remote_dash, dict) or not isinstance(dashboard_id, int):
            created = self.client.request(
                "POST",
                "/api/dashboard",
                build_dashboard_create_payload(
                    collection_id=collection_id,
                    lookup_values=lookup_values,
                ),
            )
            if not isinstance(created, dict) or not isinstance(created.get("id"), int):
                raise RuntimeError("POST /api/dashboard did not return a valid dashboard id")
            dashboard_id = int(created["id"])
            if dashboard_id in self.protected_dashboards:
                raise RuntimeError(f"Refusing to modify protected dashboard ID {dashboard_id}")
            remote_dash = self.client.request("GET", f"/api/dashboard/{dashboard_id}", allow_404=True) or created

        remote_tabs, remote_dashcards = map_returned_dashboard_ids(remote_dash, card_ids_by_slug)
        merged_tabs = {**dict(state.get("tabs") or {}), **remote_tabs}
        merged_dashcards = {**dict(state.get("dashcards") or {}), **remote_dashcards}

        put_payload, _ = build_dashboard_put_payload(
            collection_id=collection_id,
            card_ids_by_slug=card_ids_by_slug,
            existing_tab_ids_by_slug=merged_tabs,
            existing_dashcard_ids_by_slug=merged_dashcards,
            lookup_values=lookup_values,
            existing_dashboard=remote_dash,
            card_metadata_by_slug=self.card_metadata_by_slug,
            portal_base_url=self.portal_base_url,
        )

        updated_dash = self.client.request("PUT", f"/api/dashboard/{dashboard_id}", put_payload)
        if not isinstance(updated_dash, dict) or not updated_dash.get("tabs"):
            updated_dash = self.client.request("GET", f"/api/dashboard/{dashboard_id}")

        final_tabs, final_dashcards = map_returned_dashboard_ids(updated_dash, card_ids_by_slug)
        state["dashboard_id"] = dashboard_id
        state["tabs"] = final_tabs
        state["dashcards"] = final_dashcards
        return dashboard_id

    def provision(self) -> Dict[str, Any]:
        """Run full idempotent provisioning and persist state."""
        state = load_state_file(self.state_path)
        dw_tables = self.sync_and_inspect_schema()
        lookup_values = self.fetch_dimension_lookup_values()
        collection_id = self.ensure_collection(state)
        cards = self.ensure_cards(collection_id, state)
        dashboard_id = self.ensure_dashboard(
            collection_id,
            cards,
            state,
            lookup_values=lookup_values,
        )
        save_state_file(self.state_path, state)
        return {
            "status": "provisioned",
            "collection_id": collection_id,
            "dashboard_id": dashboard_id,
            "tab_count": len(state.get("tabs") or {}),
            "card_count": len(cards),
            "dashcard_count": len(state.get("dashcards") or {}),
            "dw_tables_synced": len(dw_tables),
            "state_file": str(self.state_path),
        }

    def verify_cards(self) -> Dict[str, Any]:
        """Execute each provisioned card query via POST /api/card/{id}/query and return compact status."""
        state = load_state_file(self.state_path)
        cards: Dict[str, int] = dict(state.get("cards") or {})
        if not cards:
            raise RuntimeError(f"No provisioned cards found in state file {self.state_path}")

        results: List[Dict[str, Any]] = []
        failed = 0
        for spec in CARD_SPECS:
            cid = cards.get(spec.slug)
            if not cid:
                failed += 1
                results.append({"slug": spec.slug, "card_id": None, "status": "missing", "rows": 0})
                continue
            resp = self.client.request("POST", f"/api/card/{cid}/query", {})
            err = resp.get("error") if isinstance(resp, dict) else "invalid_response"
            rows = (
                resp.get("data", {}).get("rows", [])
                if isinstance(resp, dict) and isinstance(resp.get("data"), dict)
                else []
            )
            if err:
                failed += 1
                results.append(
                    {
                        "slug": spec.slug,
                        "card_id": cid,
                        "status": "error",
                        "rows": len(rows) if isinstance(rows, list) else 0,
                        "error": str(err)[:160],
                    }
                )
            else:
                results.append(
                    {
                        "slug": spec.slug,
                        "card_id": cid,
                        "status": "ok",
                        "rows": len(rows) if isinstance(rows, list) else 0,
                    }
                )

        return {
            "status": "ok" if failed == 0 else "error",
            "verified_cards": len(results),
            "failed_cards": failed,
            "cards": results,
        }


# ---------------------------------------------------------------------------
# 6. CLI Entrypoint
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Idempotent Metabase OLAP Dashboard Provisioner (Project 3 P0)."
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate and validate API payloads offline without making network calls (default).",
    )
    mode_group.add_argument(
        "--execute",
        action="store_true",
        help="Execute live REST API provisioning against Metabase.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Execute card queries via POST /api/card/{id}/query and output compact verification status.",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("MB_BASE_URL", DEFAULT_BASE_URL),
        help=f"Metabase base URL (default: {DEFAULT_BASE_URL}).",
    )
    parser.add_argument("--portal-base-url",
                        default=os.environ.get("PORTAL_BASE_URL", DEFAULT_PORTAL_BASE_URL),
                        help="Portal base URL for detail links (default: local port 8000).")
    parser.add_argument(
        "--database-id",
        type=int,
        default=int(os.environ.get("MB_DATABASE_ID", str(DEFAULT_DATABASE_ID))),
        help=f"Metabase database ID for tour_de_france (default: {DEFAULT_DATABASE_ID}).",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=DEFAULT_STATE_PATH,
        help=f"Path to persisted object ID state JSON (default: {DEFAULT_STATE_PATH}).",
    )
    parser.add_argument(
        "--credentials-file",
        type=Path,
        default=None,
        help="Path to file containing Metabase session token, API key, or admin email/password.",
    )
    parser.add_argument(
        "--session-token",
        default=None,
        help="Explicit Metabase session token (prefer env MB_SESSION_TOKEN or --credentials-file).",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="Explicit Metabase API key (prefer env MB_API_KEY or --credentials-file).",
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=None,
        help="Optional path to write the dry-run payload bundle JSON.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not args.execute and not args.verify:
        existing_state = load_state_file(args.state_file) if args.state_file.exists() else None
        bundle = build_dry_run_bundle(database_id=args.database_id, state=existing_state,
                                      portal_base_url=args.portal_base_url)
        if args.output_json is not None:
            args.output_json.parent.mkdir(parents=True, exist_ok=True)
            args.output_json.write_text(json.dumps(bundle, indent=2) + "\n", encoding="utf-8")
        summary = {
            "mode": "dry-run",
            "collection_name": DEFAULT_COLLECTION_NAME,
            "dashboard_name": DEFAULT_DASHBOARD_NAME,
            "database_id": args.database_id,
            "tab_count": len(TAB_SPECS),
            "card_count": len(CARD_SPECS),
            "dashboard_card_count": len(DASHBOARD_CARD_SPECS),
            "caption_card_count": len(CAPTION_SPECS),
            "dashcard_count": len(bundle["dashboard_put_payload"]["dashcards"]),
            "parameter_count": len(bundle["dashboard_put_payload"]["parameters"]),
            "output_json": str(args.output_json) if args.output_json else None,
        }
        print(json.dumps(summary, indent=2))
        return 0

    auth = resolve_credentials(
        credentials_file=args.credentials_file,
        session_token=args.session_token,
        api_key=args.api_key,
    )
    client = MetabaseClient(base_url=args.base_url, auth=auth)
    provisioner = DashboardProvisioner(
        client=client,
        database_id=args.database_id,
        state_path=args.state_file,
        portal_base_url=args.portal_base_url,
    )

    output: Dict[str, Any] = {}
    if args.execute:
        output["provision"] = provisioner.provision()
    if args.verify:
        output["verify"] = provisioner.verify_cards()

    print(json.dumps(output, indent=2))
    if args.verify and output.get("verify", {}).get("status") != "ok":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
