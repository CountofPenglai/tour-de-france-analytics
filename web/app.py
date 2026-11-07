"""FastAPI backend for the Tour de France 2025 P1 Local Analytics Portal.

Provides:
- Static Signed Embedding (HS256 JWT, 10-minute expiry) for the P0 Metabase dashboard.
- Strictly allowlisted read-only access to the shared PostgreSQL `dw` OLAP functions
  using bound `psycopg.types.json.Jsonb` parameters.
- Independent 3-level drill-down support (Team -> Team Roster including exits -> Rider Stage Results)
  without duplicating SQL ranking or scoring logic in Python or JavaScript.
"""

from __future__ import annotations

import inspect
import json
import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Callable, Literal
from urllib.parse import urlencode

import jwt
import psycopg
from fastapi import Body, FastAPI, HTTPException, Path as FastAPIPath, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

STATIC_DIR = Path(__file__).resolve().parent / "static"

# -----------------------------------------------------------------------------
# Static SQL Whitelist & Queries (Read-only against schema `dw`)
# -----------------------------------------------------------------------------

AnalyticsFunctionName = Literal[
    "rider_standings",
    "team_standings",
    "rider_stage_results",
    "stage_summary",
    "country_participation",
    "rider_specialisation",
    "team_depth",
    "gc_evolution",
]

ALLOWLISTED_ANALYTICS_SQL: dict[str, str] = {
    "rider_standings": "SELECT * FROM dw.rider_standings(%s)",
    "team_standings": "SELECT * FROM dw.team_standings(%s)",
    "rider_stage_results": "SELECT * FROM dw.rider_stage_results(%s)",
    "stage_summary": "SELECT * FROM dw.stage_summary(%s)",
    "country_participation": "SELECT * FROM dw.country_participation(%s)",
    "rider_specialisation": "SELECT * FROM dw.rider_specialisation(%s)",
    "team_depth": "SELECT * FROM dw.team_depth(%s)",
    "gc_evolution": "SELECT * FROM dw.gc_evolution(%s)",
}

METADATA_SQL: dict[str, str] = {
    "teams": """
        SELECT
            dt.team_key,
            dt.team_name,
            MIN(dc.country_code)::varchar(3) AS team_country_code,
            MIN(dc.country_name)::text AS team_country_name,
            COUNT(fp.rider_key)::integer AS participant_count,
            COALESCE(SUM(fp.finished_race_flag), 0)::integer AS finisher_count
        FROM dw.dim_team dt
        LEFT JOIN dw.fact_participation fp ON fp.team_key = dt.team_key
        LEFT JOIN dw.dim_country dc ON dc.country_key = fp.team_country_key
        GROUP BY dt.team_key, dt.team_name
        ORDER BY dt.team_name ASC, dt.team_key ASC
    """,
    "riders": """
        SELECT
            dr.rider_key,
            dr.bib_number,
            dr.rider_name,
            dr.date_of_birth,
            dr.age_at_race,
            dr.age_group,
            dr.is_young_rider,
            dt.team_key,
            dt.team_name,
            dc.country_key AS rider_country_key,
            dc.country_code AS rider_country_code,
            dc.country_name AS rider_country_name,
            fp.finished_race_flag,
            fp.exit_flag,
            CASE WHEN fp.finished_race_flag = 1 THEN 'finished' ELSE 'exited' END AS participation_status
        FROM dw.fact_participation fp
        JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
        JOIN dw.dim_team dt ON dt.team_key = fp.team_key
        JOIN dw.dim_country dc ON dc.country_key = fp.rider_country_key
        ORDER BY dr.bib_number ASC, dr.rider_key ASC
    """,
    "stages": """
        SELECT
            stage_key,
            stage_id,
            stage_order,
            stage_name,
            stage_date,
            race_week,
            stage_type,
            distance_km,
            start_location_name,
            start_country_code,
            start_country_name,
            finish_location_name,
            finish_country_code,
            finish_country_name,
            route_description,
            finisher_count,
            winner_rider_key,
            winner_bib_number,
            winner_rider_name,
            winner_team_name,
            winning_finish_time_seconds,
            winning_adjusted_time_seconds
        FROM dw.stage_summary('{}'::jsonb)
        ORDER BY stage_order ASC
    """,
    "countries": """
        SELECT
            country_key,
            country_code,
            country_name
        FROM dw.dim_country
        WHERE country_key > 0 AND country_code <> 'UNK'
        ORDER BY country_name ASC, country_key ASC
    """,
}

# Team roster drill query:
# Starts from `dw.fact_participation` (grain: 1 row per starting rider, including later exits)
# and left-joins pre-aggregated stage results from `dw.rider_stage_results(%s)` over the
# selected stage scope. Prevents fact-to-fact fanout and preserves #78 Aleksandr Vlasov ('UNK').
TEAM_RIDERS_SQL = """
WITH params AS (
    SELECT %s::integer AS target_team_key, %s::jsonb AS filters
),
scope_stages AS (
    SELECT COUNT(*)::integer AS selected_stage_count
    FROM dw.stage_summary((SELECT filters FROM params))
),
roster AS (
    SELECT
        dr.rider_key,
        dr.bib_number,
        dr.rider_name,
        dr.date_of_birth,
        dr.age_at_race,
        dr.age_group,
        dr.is_young_rider,
        dc.country_code AS rider_country_code,
        dc.country_name AS rider_country_name,
        dt.team_key,
        dt.team_name,
        fp.finished_race_flag,
        fp.exit_flag,
        CASE WHEN fp.finished_race_flag = 1 THEN 'finished' ELSE 'exited' END AS participation_status
    FROM dw.fact_participation fp
    JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
    JOIN dw.dim_team dt ON dt.team_key = fp.team_key
    JOIN dw.dim_country dc ON dc.country_key = fp.rider_country_key
    CROSS JOIN params p
    WHERE fp.team_key = p.target_team_key
      AND (
          NOT (p.filters ? 'young_only')
          OR COALESCE((p.filters->>'young_only')::boolean, false) = false
          OR dr.is_young_rider = true
      )
      AND (
          NOT (p.filters ? 'rider_keys')
          OR jsonb_typeof(p.filters->'rider_keys') = 'null'
          OR dr.rider_key = ANY(
              ARRAY(SELECT jsonb_array_elements_text(p.filters->'rider_keys')::integer)
          )
      )
),
stage_agg AS (
    SELECT
        rsr.rider_key,
        COUNT(*)::integer AS stages_completed,
        COALESCE(SUM(rsr.finish_time_seconds), 0)::integer AS finish_time_seconds,
        COALESCE(SUM(rsr.adjusted_time_seconds), 0)::integer AS adjusted_time_seconds,
        COALESCE(SUM(rsr.time_bonus_seconds), 0)::integer AS time_bonus_seconds,
        COALESCE(SUM(rsr.time_penalty_seconds), 0)::integer AS time_penalty_seconds,
        COALESCE(SUM(rsr.stage_points_proxy), 0)::integer AS stage_points_proxy,
        COALESCE(SUM(rsr.kom_points_proxy), 0)::integer AS kom_points_proxy,
        MIN(rsr.finish_rank)::integer AS best_stage_rank,
        COUNT(*) FILTER (WHERE rsr.finish_rank = 1)::integer AS stage_wins,
        COUNT(*) FILTER (WHERE rsr.finish_rank <= 3)::integer AS stage_podiums,
        COUNT(*) FILTER (WHERE rsr.finish_rank <= 10)::integer AS top10_finishes,
        ROUND(AVG(rsr.rank_percentile), 2)::numeric(5, 2) AS avg_rank_percentile,
        MAX(rsr.stage_id)::integer AS last_stage_id
    FROM dw.rider_stage_results(
        CASE
            WHEN (SELECT filters FROM params) ? 'team_keys' THEN (SELECT filters FROM params)
            ELSE (SELECT filters FROM params) || jsonb_build_object('team_keys', jsonb_build_array((SELECT target_team_key FROM params)))
        END
    ) rsr
    GROUP BY rsr.rider_key
)
SELECT
    r.rider_key,
    r.bib_number,
    r.rider_name,
    r.age_at_race,
    r.age_group,
    r.is_young_rider,
    r.rider_country_code,
    r.rider_country_name,
    r.team_key,
    r.team_name,
    r.finished_race_flag,
    r.exit_flag,
    r.participation_status,
    COALESCE(sa.stages_completed, 0)::integer AS stages_completed,
    ss.selected_stage_count,
    (COALESCE(sa.stages_completed, 0) = ss.selected_stage_count AND ss.selected_stage_count > 0) AS completed_selected_scope,
    (r.finished_race_flag = 1 AND COALESCE(sa.stages_completed, 0) = 21) AS is_full_gc_finisher,
    sa.finish_time_seconds,
    sa.adjusted_time_seconds,
    CASE
        WHEN COALESCE((SELECT filters->>'time_basis' FROM params), 'adjusted') = 'finish'
        THEN sa.finish_time_seconds
        ELSE sa.adjusted_time_seconds
    END AS selected_time_seconds,
    COALESCE(sa.time_bonus_seconds, 0)::integer AS time_bonus_seconds,
    COALESCE(sa.time_penalty_seconds, 0)::integer AS time_penalty_seconds,
    COALESCE(sa.stage_points_proxy, 0)::integer AS stage_points_proxy,
    COALESCE(sa.kom_points_proxy, 0)::integer AS kom_points_proxy,
    sa.best_stage_rank,
    COALESCE(sa.stage_wins, 0)::integer AS stage_wins,
    COALESCE(sa.stage_podiums, 0)::integer AS stage_podiums,
    COALESCE(sa.top10_finishes, 0)::integer AS top10_finishes,
    sa.avg_rank_percentile,
    sa.last_stage_id,
    CASE
        WHEN COALESCE(sa.stages_completed, 0) = 0 THEN 'No stages completed in selected scope'
        WHEN r.finished_race_flag = 1
             AND COALESCE((SELECT filters->>'stage_scope' FROM params), 'final') = 'final'
             AND COALESCE(sa.stages_completed, 0) = 21
            THEN 'Full 21-stage finisher (available for GC & team contribution)'
        WHEN COALESCE(sa.stages_completed, 0) = ss.selected_stage_count AND ss.selected_stage_count > 0
            THEN 'Completed selected scope (' || COALESCE(sa.stages_completed, 0) || '/' || ss.selected_stage_count || ' stages)'
        ELSE 'Available-stage contribution only (' || COALESCE(sa.stages_completed, 0) || '/' || ss.selected_stage_count || ' stages; exited / incomplete for full GC)'
    END AS contribution_label
FROM roster r
CROSS JOIN scope_stages ss
LEFT JOIN stage_agg sa ON sa.rider_key = r.rider_key
ORDER BY
    r.finished_race_flag DESC,
    COALESCE(sa.stages_completed, 0) DESC,
    selected_time_seconds ASC NULLS LAST,
    r.bib_number ASC
"""

# Country union-member drill query:
# Starts from `dw.dim_country` (excluding `country_key = 0 / 'UNK'` as target country)
# joined to `dw.fact_participation` (grain: 1 row per starting rider, preventing duplicate
# membership rows when a rider both has that nationality and rides for a team registered
# in that country). Distinguishes `rider_nationality`, `team_registration`, and `both`,
# while preserving exited riders and `'UNK'` nationality riders on registered teams.
COUNTRY_MEMBERS_SQL = """
WITH params AS (
    SELECT %s::varchar(3) AS target_country_code, %s::jsonb AS filters
),
target_country AS (
    SELECT
        dc.country_key,
        dc.country_code,
        dc.country_name
    FROM dw.dim_country dc
    CROSS JOIN params p
    WHERE dc.country_key > 0
      AND dc.country_code <> 'UNK'
      AND dc.country_code = p.target_country_code
)
SELECT
    tc_target.country_key,
    tc_target.country_code,
    tc_target.country_name,
    dr.rider_key,
    dr.bib_number,
    dr.rider_name,
    dr.date_of_birth,
    dr.age_at_race,
    dr.age_group,
    dr.is_young_rider,
    rc.country_key AS rider_country_key,
    rc.country_code AS rider_country_code,
    rc.country_name AS rider_country_name,
    dt.team_key,
    dt.team_name,
    tc_team.country_key AS team_country_key,
    tc_team.country_code AS team_country_code,
    tc_team.country_name AS team_country_name,
    fp.finished_race_flag,
    fp.exit_flag,
    CASE WHEN fp.finished_race_flag = 1 THEN 'finished' ELSE 'exited' END AS participation_status,
    (fp.rider_country_key = tc_target.country_key) AS is_rider_national,
    (fp.team_country_key = tc_target.country_key) AS is_team_registered,
    CASE
        WHEN fp.rider_country_key = tc_target.country_key AND fp.team_country_key = tc_target.country_key
            THEN 'both'
        WHEN fp.rider_country_key = tc_target.country_key
            THEN 'rider_nationality'
        ELSE 'team_registration'
    END AS role_code,
    CASE
        WHEN fp.rider_country_key = tc_target.country_key AND fp.team_country_key = tc_target.country_key
            THEN 'Rider Nationality & Team Registration'
        WHEN fp.rider_country_key = tc_target.country_key
            THEN 'Rider Nationality'
        ELSE 'Team Registration'
    END AS membership_role
FROM target_country tc_target
JOIN dw.fact_participation fp
  ON (fp.rider_country_key = tc_target.country_key OR fp.team_country_key = tc_target.country_key)
JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
JOIN dw.dim_team dt ON dt.team_key = fp.team_key
JOIN dw.dim_country rc ON rc.country_key = fp.rider_country_key
JOIN dw.dim_country tc_team ON tc_team.country_key = fp.team_country_key
CROSS JOIN params p
WHERE (
    NOT (p.filters ? 'young_only')
    OR COALESCE((p.filters->>'young_only')::boolean, false) = false
    OR dr.is_young_rider = true
)
AND (
    NOT (p.filters ? 'team_keys')
    OR jsonb_typeof(p.filters->'team_keys') = 'null'
    OR fp.team_key = ANY(
        ARRAY(SELECT jsonb_array_elements_text(p.filters->'team_keys')::integer)
    )
)
AND (
    NOT (p.filters ? 'rider_keys')
    OR jsonb_typeof(p.filters->'rider_keys') = 'null'
    OR dr.rider_key = ANY(
        ARRAY(SELECT jsonb_array_elements_text(p.filters->'rider_keys')::integer)
    )
)
ORDER BY
    CASE
        WHEN fp.rider_country_key = tc_target.country_key AND fp.team_country_key = tc_target.country_key THEN 1
        WHEN fp.rider_country_key = tc_target.country_key THEN 2
        ELSE 3
    END ASC,
    dr.bib_number ASC,
    dr.rider_key ASC
"""

# -----------------------------------------------------------------------------
# Documented Numeric Units per Analytical Function
# -----------------------------------------------------------------------------

FUNCTION_UNITS: dict[str, dict[str, str]] = {
    "rider_standings": {
        "stage_count": "stages (count)",
        "total_seconds": "seconds (integer; formatted as HH:MM:SS in UI)",
        "points": "proxy points (integer; derived from stage finish rank & stage type, non-official)",
        "rank": "ordinal competition rank via SQL RANK() (1 = leader, ties share rank)",
        "gap_seconds": "seconds behind classification leader (NULL for points_proxy and kom_proxy)",
        "rank_percentile": "percentage 0.00..100.00 (100.00 = rank 1 in cohort)",
    },
    "team_standings": {
        "total_seconds": "seconds (integer; sum of top-3 team riders per stage_top3 or cumulative_top3)",
        "rank": "ordinal competition rank via SQL RANK() (1 = leading team)",
        "gap_seconds": "seconds behind leading team",
        "stage_count": "stages in active scope (count)",
        "contributor_count": "distinct riders contributing to team top-3 selections (count)",
    },
    "rider_stage_results": {
        "distance_km": "kilometres (numeric(6,2))",
        "finish_rank": "ordinal stage finish rank (ties permitted in source data)",
        "stage_finisher_count": "riders finishing the stage globally (count)",
        "finish_time_seconds": "seconds (raw stage finish time)",
        "time_bonus_seconds": "seconds (time bonus subtracted in adjusted time)",
        "time_penalty_seconds": "seconds (time penalty added in adjusted time)",
        "adjusted_time_seconds": "seconds (finish_time_seconds - time_bonus_seconds + time_penalty_seconds)",
        "gap_seconds": "raw seconds relative to the recorded stage winner",
        "adjusted_gap_seconds": "adjusted seconds relative to the recorded stage winner",
        "stage_points_proxy": "proxy points 0..50 (derived from stage finish rank & stage type)",
        "kom_points_proxy": "proxy points 0..20 (derived from mountain/hilly finish rank)",
        "rank_percentile": "percentage 0.00..100.00 across all finishers of the stage",
    },
    "stage_summary": {
        "distance_km": "kilometres (numeric(6,2), one row per stage, never duplicated)",
        "finisher_count": "riders finishing the stage (count)",
        "winning_finish_time_seconds": "seconds (recorded stage winner, raw time)",
        "winning_adjusted_time_seconds": "seconds (recorded stage winner, adjusted time)",
    },
    "country_participation": {
        "rider_count": "participating riders of this nationality (count; excludes UNK row)",
        "team_count": "participating teams registered in this country (count)",
        "finisher_count": "full-race finishers of this nationality (count)",
        "finisher_rate": "ratio 0.0000..1.0000 (finisher_count / rider_count; NULL when rider_count = 0)",
    },
    "rider_specialisation": {
        "avg_rank_percentile": "percentage 0.00..100.00 (mean global stage rank percentile by stage type)",
        "top10_ratio": "ratio 0.0000..1.0000 (top10_count / sample_count)",
        "top10_count": "stages finished in top 10 by stage type (count)",
        "win_count": "stage wins by stage type (count)",
        "mean_gap_seconds": "seconds (mean stage time gap to stage winner by stage type)",
        "sample_count": "completed stages by stage type (count)",
    },
    "team_depth": {
        "wins": "stage wins (finish_rank = 1 count)",
        "podiums": "stage podiums (finish_rank <= 3 count)",
        "top10_finishes": "rider-stage finishes in top 10 (count)",
        "top10_stages": "distinct stages with >= 1 team rider in top 10 (count)",
        "selected_stage_count": "stages in active scope (count)",
        "top10_stage_coverage": "ratio 0.0000..1.0000 (top10_stages / selected_stage_count)",
        "top10_distinct_riders": "distinct team riders with >= 1 top-10 stage finish (count)",
        "finishers": "full-race finishers on team (count)",
        "participants": "starting riders on team (count)",
        "finisher_rate": "ratio 0.0000..1.0000 (finishers / participants)",
    },
    "gc_evolution": {
        "stage_seconds": "seconds (single-stage time under selected time_basis)",
        "cumulative_seconds": "seconds (cumulative time across stages 1..S)",
        "leader_cumulative_seconds": "seconds (contemporaneous leader cumulative time at stage S)",
        "cumulative_rank": "ordinal contemporaneous rank at stage S via SQL RANK()",
        "cumulative_gap_seconds": "seconds behind contemporaneous leader at stage S",
        "stage_net_change_seconds": "seconds gained (< 0) or lost (> 0) vs leader on stage S",
        "stage_gap_seconds": "signed seconds relative to the recorded stage winner, using the selected time basis",
        "time_bonus_seconds": "seconds (stage S bonus)",
        "time_penalty_seconds": "seconds (stage S penalty)",
        "net_bonus_penalty_seconds": "seconds (time_penalty_seconds - time_bonus_seconds on stage S)",
        "cumulative_bonus_seconds": "seconds (cumulative bonuses across stages 1..S)",
        "cumulative_penalty_seconds": "seconds (cumulative penalties across stages 1..S)",
        "cumulative_net_bonus_penalty_seconds": "seconds (cumulative net penalty - bonus across stages 1..S)",
    },
    "team_riders_drill": {
        "stages_completed": "stages completed by rider within selected scope (count)",
        "selected_stage_count": "total stages in selected scope (count)",
        "finish_time_seconds": "seconds (sum of raw stage times across completed stages in scope; NULL if 0 stages)",
        "adjusted_time_seconds": "seconds (sum of adjusted stage times across completed stages in scope; NULL if 0 stages)",
        "selected_time_seconds": "seconds (available-stage time sum under active time_basis; never full GC for incomplete riders)",
        "time_bonus_seconds": "seconds (sum of stage bonuses in scope)",
        "time_penalty_seconds": "seconds (sum of stage penalties in scope)",
        "stage_points_proxy": "proxy points (sum of stage_points_proxy in scope, non-official)",
        "kom_points_proxy": "proxy points (sum of kom_points_proxy in scope, non-official)",
        "avg_rank_percentile": "percentage 0.00..100.00 (mean stage percentile across completed stages in scope)",
    },
    "country_members_drill": {
        "finished_race_flag": "1 = finished all 21 stages, 0 = exited race before final stage",
        "exit_flag": "1 = exited race before final stage, 0 = finished all 21 stages",
        "is_rider_national": "boolean (true when rider nationality matches target country)",
        "is_team_registered": "boolean (true when team registration country matches target country)",
        "role_code": "categorical role ('rider_nationality', 'team_registration', or 'both')",
        "membership_role": "human-readable role ('Rider Nationality', 'Team Registration', or 'Rider Nationality & Team Registration')",
    },
}

DEFAULT_P0_TABS: list[dict[str, Any]] = [
    {
        "key": "tab_1_overview",
        "index": 1,
        "label": "Tab 1: Executive & Race Overview",
        "short_label": "1 · Executive & Race Overview",
        "tab_id": None,
        "description": "Race overview, participation & finisher scale, stage route and stage type distribution.",
    },
    {
        "key": "tab_2_classifications",
        "index": 2,
        "label": "Tab 2: Classifications Comparison",
        "short_label": "2 · Classifications Comparison",
        "tab_id": None,
        "description": "GC, Young Rider, Points Proxy, and KOM Proxy standings & time basis comparison.",
    },
    {
        "key": "tab_3_performance",
        "index": 3,
        "label": "Tab 3: Rider & Team Performance",
        "short_label": "3 · Rider & Team Performance",
        "tab_id": None,
        "description": "Dual-method team standings (stage_top3 vs cumulative_top3) and team-rider-stage drill.",
    },
    {
        "key": "tab_4_countries",
        "index": 4,
        "label": "Tab 4: Country Participation",
        "short_label": "4 · Country Participation",
        "tab_id": None,
        "description": "Role-playing country dimension: team registration country vs rider nationality.",
    },
    {
        "key": "tab_5_insights",
        "index": 5,
        "label": "Tab 5: Deep-Dive Insights",
        "short_label": "5 · Deep-Dive Insights",
        "tab_id": None,
        "description": "Rider stage type specialisation pivot, decisive stage GC gap evolution, and team depth.",
    },
]

# Allowed filter query parameters forwarded to the Metabase embed URL.
# Note: `team_aggregation` is intentionally excluded because P0 side-by-side cards
# use fixed aggregation methods; `resource` and `dashboard_id` are forbidden.
ALLOWED_EMBED_FILTER_KEYS: frozenset[str] = frozenset(
    {
        "stage_scope",
        "as_of_stage",
        "stage_ids",
        "stage_types",
        "time_basis",
        "rank_scope",
        "team_keys",
        "rider_keys",
        "young_only",
    }
)
ARRAY_EMBED_FILTER_KEYS: frozenset[str] = frozenset(
    {"stage_ids", "stage_types", "team_keys", "rider_keys"}
)
ALLOWED_STAGE_SCOPES: frozenset[str] = frozenset({"final", "as_of", "selection"})
ALLOWED_STAGE_TYPES: frozenset[str] = frozenset(
    {"flat", "hilly", "mountain", "individual time-trial"}
)
ALLOWED_TIME_BASES: frozenset[str] = frozenset({"finish", "adjusted"})
ALLOWED_RANK_SCOPES: frozenset[str] = frozenset({"overall", "filtered"})


# -----------------------------------------------------------------------------
# Configuration & Secret Resolution
# -----------------------------------------------------------------------------


def _read_secret_from_file(file_path: str | Path | None) -> str | None:
    """Read a secret string from a private file path without leaking contents on error."""
    if not file_path:
        return None
    cleaned_path = str(file_path).strip()
    if not cleaned_path:
        return None
    try:
        content = Path(cleaned_path).read_text(encoding="utf-8").strip()
        return content if content else None
    except OSError:
        return None


def _parse_positive_int(raw: Any) -> int | None:
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw > 0 else None
    text = str(raw).strip()
    if not text:
        return None
    try:
        val = int(text, 10)
        return val if val > 0 else None
    except ValueError:
        return None


def _parse_tabs_mapping(raw_tabs: Any) -> dict[str, int | str]:
    """Parse optional MB_TABS_JSON mapping labels/keys to Metabase tab IDs."""
    if not raw_tabs:
        return {}
    parsed: Any = raw_tabs
    if isinstance(raw_tabs, str):
        text = raw_tabs.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {}
    if isinstance(parsed, dict):
        result: dict[str, int | str] = {}
        for k, v in parsed.items():
            if v is None or isinstance(v, bool):
                continue
            key_str = str(k).strip()
            if not key_str:
                continue
            if isinstance(v, int):
                result[key_str] = v
            else:
                v_str = str(v).strip()
                if v_str:
                    try:
                        result[key_str] = int(v_str, 10)
                    except ValueError:
                        result[key_str] = v_str
        return result
    return {}


@dataclass
class PortalSettings:
    """Server configuration for the P1 FastAPI portal.

    Secrets have `repr=False` so they are never printed in tracebacks or logs.
    """

    database_url: str | None = field(default=None, repr=False)
    database_url_file: str | None = field(default=None, repr=False)
    mb_embedding_secret_key: str | None = field(default=None, repr=False)
    mb_embedding_secret_key_file: str | None = field(default=None, repr=False)
    mb_url: str = "http://127.0.0.1:3000"
    mb_dashboard_id: int | None = None
    mb_tabs_json: str | dict[str, Any] | None = None
    statement_timeout_ms: int = 10000

    def resolve_database_url(self) -> str | None:
        if self.database_url and str(self.database_url).strip():
            return str(self.database_url).strip()
        return _read_secret_from_file(self.database_url_file)

    def resolve_mb_secret_key(self) -> str | None:
        if self.mb_embedding_secret_key and str(self.mb_embedding_secret_key).strip():
            return str(self.mb_embedding_secret_key).strip()
        return _read_secret_from_file(self.mb_embedding_secret_key_file)

    def normalized_mb_url(self) -> str:
        base = (self.mb_url or "http://127.0.0.1:3000").strip().rstrip("/")
        return base or "http://127.0.0.1:3000"

    def p0_dashboard_url(self) -> str:
        base = self.normalized_mb_url()
        if self.mb_dashboard_id is not None and self.mb_dashboard_id > 0:
            return f"{base}/dashboard/{self.mb_dashboard_id}"
        return base

    def resolved_tabs(self) -> tuple[list[dict[str, Any]], dict[str, int | str]]:
        tabs_map = _parse_tabs_mapping(self.mb_tabs_json)
        lower_map = {k.lower(): v for k, v in tabs_map.items()}
        tabs_list: list[dict[str, Any]] = []
        for item in DEFAULT_P0_TABS:
            tab_copy = dict(item)
            idx_str = str(item["index"])
            matched_id = (
                tabs_map.get(item["label"])
                or tabs_map.get(item["short_label"])
                or tabs_map.get(item["key"])
                or tabs_map.get(idx_str)
                or tabs_map.get(f"Tab {idx_str}")
                or lower_map.get(item["label"].lower())
                or lower_map.get(item["key"].lower())
                or lower_map.get(f"tab {idx_str}")
                or lower_map.get(f"tab_{idx_str}")
            )
            if matched_id is None:
                # Also match by prefix such as "Tab 1"
                prefix = f"tab {idx_str}"
                for k_lower, v_id in lower_map.items():
                    if k_lower.startswith(prefix):
                        matched_id = v_id
                        break
            tab_copy["tab_id"] = matched_id
            tabs_list.append(tab_copy)
        return tabs_list, tabs_map


def load_settings(raw: PortalSettings | dict[str, Any] | Any | None = None) -> PortalSettings:
    """Normalize settings from None (environment), a dict, or a PortalSettings instance."""
    if isinstance(raw, PortalSettings):
        return raw

    source: dict[str, Any]
    if raw is None:
        source = dict(os.environ)
    elif isinstance(raw, dict):
        source = raw
    else:
        source = {
            k: getattr(raw, k)
            for k in dir(raw)
            if not k.startswith("_") and not callable(getattr(raw, k))
        }

    def _get(env_key: str, attr_key: str, default: Any = None) -> Any:
        if env_key in source and source[env_key] is not None:
            return source[env_key]
        if attr_key in source and source[attr_key] is not None:
            return source[attr_key]
        return default

    db_url = _get("DATABASE_URL", "database_url")
    db_url_file = _get("DATABASE_URL_FILE", "database_url_file")
    mb_secret = _get("MB_EMBEDDING_SECRET_KEY", "mb_embedding_secret_key")
    mb_secret_file = _get("MB_EMBEDDING_SECRET_KEY_FILE", "mb_embedding_secret_key_file")
    mb_url = _get("MB_URL", "mb_url", "http://127.0.0.1:3000")
    mb_dashboard_id = _parse_positive_int(_get("MB_DASHBOARD_ID", "mb_dashboard_id"))
    mb_tabs_json = _get("MB_TABS_JSON", "mb_tabs_json")
    timeout_raw = _parse_positive_int(_get("STATEMENT_TIMEOUT_MS", "statement_timeout_ms", 10000))

    return PortalSettings(
        database_url=str(db_url).strip() if db_url else None,
        database_url_file=str(db_url_file).strip() if db_url_file else None,
        mb_embedding_secret_key=str(mb_secret).strip() if mb_secret else None,
        mb_embedding_secret_key_file=str(mb_secret_file).strip() if mb_secret_file else None,
        mb_url=str(mb_url).strip() if mb_url else "http://127.0.0.1:3000",
        mb_dashboard_id=mb_dashboard_id,
        mb_tabs_json=mb_tabs_json,
        statement_timeout_ms=timeout_raw or 10000,
    )


# -----------------------------------------------------------------------------
# Pydantic Filter Contract (Strict Validation -> 422 on Bad Enums / Ranges)
# -----------------------------------------------------------------------------

StageScopeLiteral = Literal["final", "as_of", "selection"]
StageTypeLiteral = Literal["flat", "hilly", "mountain", "individual time-trial"]
TimeBasisLiteral = Literal["finish", "adjusted"]
RankScopeLiteral = Literal["overall", "filtered"]
ClassificationLiteral = Literal["gc", "young", "points_proxy", "kom_proxy", "mountain_time"]
TeamAggregationLiteral = Literal["stage_top3", "cumulative_top3"]

StageNumberInt = Annotated[StrictInt, Field(ge=1, le=21)]
PositiveKeyInt = Annotated[StrictInt, Field(ge=1)]


class AnalyticsFilters(BaseModel):
    """Validated JSONB filter contract shared by all `dw.*` analytical functions.

    Rules enforced:
    - Unknown filter keys are forbidden (422).
    - Enums and 1..21 stage ranges are strictly validated (422).
    - Omitted keys and explicit `null` values are excluded from the bound JSONB object
      so PostgreSQL applies its documented defaults.
    - Explicit empty lists `[]` are preserved as `[]` (distinct from missing/null)
      so PostgreSQL returns 0 rows for an empty selection.
    """

    model_config = ConfigDict(extra="forbid")

    stage_scope: StageScopeLiteral | None = None
    as_of_stage: StageNumberInt | None = None
    stage_ids: list[StageNumberInt] | None = None
    stage_types: list[StageTypeLiteral] | None = None
    time_basis: TimeBasisLiteral | None = None
    rank_scope: RankScopeLiteral | None = None
    team_keys: list[PositiveKeyInt] | None = None
    rider_keys: list[PositiveKeyInt] | None = None
    young_only: StrictBool | None = None
    classification: ClassificationLiteral | None = None
    team_aggregation: TeamAggregationLiteral | None = None

    @field_validator("stage_scope", "time_basis", "rank_scope", "classification", "team_aggregation", mode="before")
    @classmethod
    def _empty_string_to_none(cls, val: Any) -> Any:
        if val == "":
            return None
        return val

    def to_clean_dict(self) -> dict[str, Any]:
        """Return only actually present non-null filter keys, preserving `[]`."""
        return self.model_dump(exclude_none=True)


# -----------------------------------------------------------------------------
# Read-Only Database Execution & Serialization
# -----------------------------------------------------------------------------


class PsycopgQueryRunner:
    """Lazy, read-only PostgreSQL query runner backed by `psycopg`."""

    def __init__(self, settings: PortalSettings) -> None:
        self._settings = settings

    def __call__(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> list[dict[str, Any]]:
        dsn = self._settings.resolve_database_url()
        if not dsn:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Database connection is not configured. Set DATABASE_URL or "
                    "DATABASE_URL_FILE with read-only tdf_reader credentials."
                ),
            )
        timeout_ms = max(1000, int(self._settings.statement_timeout_ms or 10000))
        try:
            with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as conn:
                conn.read_only = True
                with conn.transaction():
                    with conn.cursor() as cur:
                        cur.execute(f"SET LOCAL statement_timeout = {timeout_ms}")
                        cur.execute("SET LOCAL lock_timeout = 5000")
                        cur.execute(sql, params)
                        if cur.description is None:
                            return []
                        return list(cur.fetchall())
        except HTTPException:
            raise
        except psycopg.OperationalError:
            raise HTTPException(
                status_code=503,
                detail="Database service is currently unreachable. Verify PostgreSQL is running.",
            ) from None
        except psycopg.Error:
            raise HTTPException(
                status_code=400,
                detail="Database query execution failed under the provided parameters.",
            ) from None


def _invoke_query_runner(
    runner: Callable[..., list[dict[str, Any]]] | Any,
    sql: str,
    params: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    """Invoke either a callable `(sql, params)` or an injected runner object."""
    target: Callable[..., Any]
    if callable(runner):
        target = runner
    elif hasattr(runner, "fetch_all") and callable(runner.fetch_all):
        target = runner.fetch_all
    elif hasattr(runner, "query") and callable(runner.query):
        target = runner.query
    elif hasattr(runner, "run") and callable(runner.run):
        target = runner.run
    elif hasattr(runner, "execute") and callable(runner.execute):
        target = runner.execute
    else:
        raise TypeError("Invalid query_runner: expected callable(sql, params)")

    try:
        sig = inspect.signature(target)
        positional_params = [
            p
            for p in sig.parameters.values()
            if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        has_varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in sig.parameters.values())
        if len(positional_params) == 1 and not has_varargs:
            rows = target(sql)
        else:
            rows = target(sql, params)
    except (ValueError, TypeError):
        rows = target(sql, params)

    if rows is None:
        return []
    return list(rows)


def serialize_value(val: Any) -> Any:
    """Convert PostgreSQL / Python Decimal and date/datetime objects to JSON-safe values."""
    if val is None or isinstance(val, (bool, int, float, str)):
        return val
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if isinstance(val, dict):
        return {str(k): serialize_value(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [serialize_value(v) for v in val]
    return str(val)


def serialize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Serialize a list of row dicts into JSON-ready dicts."""
    return [{str(k): serialize_value(v) for k, v in row.items()} for row in rows]


# -----------------------------------------------------------------------------
# Signed Metabase Embedding Helpers
# -----------------------------------------------------------------------------


def _extract_multi_query_items(query_params: Any) -> list[tuple[str, str]]:
    """Extract ordered `(key, value)` pairs preserving repeated query parameter keys."""
    if query_params is None:
        return []
    if hasattr(query_params, "multi_items") and callable(query_params.multi_items):
        return [(str(k), str(v)) for k, v in query_params.multi_items()]
    if isinstance(query_params, dict):
        items: list[tuple[str, str]] = []
        for k, v in query_params.items():
            if v is None:
                continue
            if isinstance(v, (list, tuple)):
                if len(v) == 0:
                    items.append((str(k), ""))
                else:
                    for elem in v:
                        if elem is not None:
                            items.append((str(k), str(elem)))
            else:
                items.append((str(k), str(v)))
        return items
    if isinstance(query_params, (list, tuple)):
        return [(str(k), str(v)) for k, v in query_params]
    return []


def _resolve_embed_tab(
    raw_tab: str,
    tabs_list: list[dict[str, Any]],
    tabs_map: dict[str, int | str],
) -> int | str | None:
    """Resolve a tab reference to a configured Metabase tab ID in a single pass.

    - Canonical keys (`tab_1_overview` .. `tab_5_insights`) and labels resolve directly
      to that tab's `tab_id` without re-evaluating numeric IDs against index keys.
    - Returns `None` if no real `tab_id` is configured (never fakes a tab jump).
    """
    cleaned = raw_tab.strip()
    if not cleaned:
        return None
    cleaned_lower = cleaned.lower()

    # 1. Match canonical tab key, full label, or short label first (single resolution)
    for t_item in tabs_list:
        if cleaned in (t_item["key"], t_item["label"], t_item["short_label"]) or cleaned_lower in (
            t_item["key"].lower(),
            t_item["label"].lower(),
            t_item["short_label"].lower(),
        ):
            return t_item.get("tab_id")

    # 2. Match explicit key in tabs_map (e.g., "Tab 1: Executive & Race Overview" or "1")
    if cleaned in tabs_map:
        return tabs_map[cleaned]
    for k, v in tabs_map.items():
        if k.lower() == cleaned_lower:
            return v

    # 3. Match an already-resolved actual tab_id present on one of the configured tabs
    for t_item in tabs_list:
        t_id = t_item.get("tab_id")
        if t_id is not None and str(t_id) == cleaned:
            return t_id

    return None


def _validate_embed_filter_value(key: str, raw_val: str) -> str:
    """Validate a single non-empty filter parameter value for the Metabase embed URL."""
    val = raw_val.strip()
    if key == "stage_scope":
        if val not in ALLOWED_STAGE_SCOPES:
            raise HTTPException(status_code=422, detail=f"Invalid stage_scope: {val}")
        return val
    if key == "as_of_stage":
        parsed = _parse_positive_int(val)
        if parsed is None or parsed < 1 or parsed > 21:
            raise HTTPException(status_code=422, detail=f"Invalid as_of_stage: {val}")
        return str(parsed)
    if key == "stage_ids":
        parsed = _parse_positive_int(val)
        if parsed is None or parsed < 1 or parsed > 21:
            raise HTTPException(status_code=422, detail=f"Invalid stage_ids value: {val}")
        return str(parsed)
    if key == "stage_types":
        if val not in ALLOWED_STAGE_TYPES:
            raise HTTPException(status_code=422, detail=f"Invalid stage_types value: {val}")
        return val
    if key == "time_basis":
        if val not in ALLOWED_TIME_BASES:
            raise HTTPException(status_code=422, detail=f"Invalid time_basis: {val}")
        return val
    if key == "rank_scope":
        if val not in ALLOWED_RANK_SCOPES:
            raise HTTPException(status_code=422, detail=f"Invalid rank_scope: {val}")
        return val
    if key in ("team_keys", "rider_keys"):
        parsed = _parse_positive_int(val)
        if parsed is None or parsed < 1:
            raise HTTPException(status_code=422, detail=f"Invalid {key} value: {val}")
        return str(parsed)
    if key == "young_only":
        low = val.lower()
        if low not in ("true", "false"):
            raise HTTPException(status_code=422, detail=f"Invalid young_only value: {val}")
        return low
    raise HTTPException(status_code=422, detail=f"Unsupported filter key: {key}")


def _validate_country_code(raw_code: Any) -> str:
    """Validate and normalize a 3-letter country code excluding the 'UNK' unknown member."""
    if not isinstance(raw_code, str):
        raise HTTPException(status_code=422, detail="Invalid country_code: must be a 3-letter string.")
    cleaned = raw_code.strip().upper()
    if (
        len(cleaned) != 3
        or not cleaned.isascii()
        or not cleaned.isalpha()
        or cleaned in ("UNK", "NULL")
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid country_code '{raw_code}': must be a 3-letter uppercase country code "
                "excluding 'UNK'."
            ),
        )
    return cleaned


def build_signed_embed_payload(
    settings: PortalSettings,
    query_params: Any = None,
) -> dict[str, Any]:
    """Generate a server-signed HS256 JWT iframe URL for the fixed Metabase dashboard.

    - Strictly signs `resource: {"dashboard": <fixed MB_DASHBOARD_ID>}` and `params: {}`.
    - Token expires in 10 minutes (`exp = iat + 600`).
    - Preserves repeated array filter parameters via `urlencode(..., doseq=True)`.
    - Raises 503 with missing configuration keys if secret or dashboard ID is unconfigured.
    """
    secret_key = settings.resolve_mb_secret_key()
    dashboard_id = settings.mb_dashboard_id
    missing: list[str] = []
    if not secret_key:
        missing.append("MB_EMBEDDING_SECRET_KEY")
    if dashboard_id is None or dashboard_id <= 0:
        missing.append("MB_DASHBOARD_ID")

    tabs_list, tabs_map = settings.resolved_tabs()
    p0_url = settings.p0_dashboard_url()

    if missing:
        raise HTTPException(
            status_code=503,
            detail={
                "message": (
                    "Metabase Static Signed Embedding is not yet configured on this server. "
                    f"Missing required configuration: {', '.join(missing)}. "
                    "You can still open the P0 native Metabase dashboard directly or use the "
                    "Explore view and Team -> Rider -> Stage drill panel below."
                ),
                "missing_config": missing,
                "p0_dashboard_url": p0_url,
                "tabs": tabs_list,
                "tabs_map": tabs_map,
            },
        )

    now = int(time.time())
    exp = now + 600  # 10 minutes
    jwt_payload: dict[str, Any] = {
        "resource": {"dashboard": int(dashboard_id)},
        "params": {},
        "iat": now,
        "exp": exp,
    }
    token = jwt.encode(jwt_payload, secret_key, algorithm="HS256")
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    raw_items = _extract_multi_query_items(query_params)
    safe_params: list[tuple[str, str | list[str]]] = []
    active_tab_id: int | str | None = None
    grouped_arrays: dict[str, list[str]] = {}
    explicit_empty_arrays: set[str] = set()

    for key, raw_val in raw_items:
        if key == "tab":
            resolved = _resolve_embed_tab(raw_val, tabs_list, tabs_map)
            if resolved is not None:
                active_tab_id = resolved
            continue

        # Ignore unknown params and `team_aggregation` (P0 cards use fixed aggregation rules)
        if key not in ALLOWED_EMBED_FILTER_KEYS:
            continue

        stripped = raw_val.strip()
        if key in ARRAY_EMBED_FILTER_KEYS:
            if stripped in ("", "[]"):
                explicit_empty_arrays.add(key)
            elif "," in stripped:
                csv_parts = [p.strip() for p in stripped.split(",") if p.strip() != ""]
                if not csv_parts:
                    raise HTTPException(status_code=422, detail=f"Invalid {key} value: {raw_val}")
                for part in csv_parts:
                    validated_item = _validate_embed_filter_value(key, part)
                    grouped_arrays.setdefault(key, []).append(validated_item)
            else:
                validated_item = _validate_embed_filter_value(key, stripped)
                grouped_arrays.setdefault(key, []).append(validated_item)
        else:
            if stripped == "":
                continue
            validated_scalar = _validate_embed_filter_value(key, stripped)
            safe_params.append((key, validated_scalar))

    if active_tab_id is not None:
        safe_params.insert(0, ("tab", str(active_tab_id)))

    for arr_key in ("stage_ids", "stage_types", "team_keys", "rider_keys"):
        if arr_key in grouped_arrays:
            safe_params.append((arr_key, grouped_arrays[arr_key]))
        elif arr_key in explicit_empty_arrays:
            # Preserve explicit empty selection (`stage_ids=`) distinct from omitted key
            safe_params.append((arr_key, ""))

    query_string = f"?{urlencode(safe_params, doseq=True)}" if safe_params else ""
    base_url = settings.normalized_mb_url()
    iframe_url = f"{base_url}/embed/dashboard/{token}{query_string}#bordered=false&titled=true"

    return {
        "iframe_url": iframe_url,
        "p0_dashboard_url": p0_url,
        "dashboard_id": int(dashboard_id),
        "expires_in_seconds": 600,
        "issued_at": now,
        "expires_at": exp,
        "active_tab_id": active_tab_id,
        "tabs": tabs_list,
        "tabs_map": tabs_map,
    }


# -----------------------------------------------------------------------------
# FastAPI Application Factory
# -----------------------------------------------------------------------------


def create_app(
    settings: PortalSettings | dict[str, Any] | Any | None = None,
    query_runner: Callable[..., list[dict[str, Any]]] | Any | None = None,
) -> FastAPI:
    """Create the FastAPI application with optional injected settings and query runner."""
    resolved_settings = load_settings(settings)
    active_runner = query_runner if query_runner is not None else PsycopgQueryRunner(resolved_settings)

    app = FastAPI(
        title="Tour de France 2025 OLAP Analytics Portal (P1)",
        version="1.0.0",
        description=(
            "Local P1 FastAPI + Static Signed Embedding portal backed by the shared "
            "PostgreSQL `dw` star-schema analytical layer."
        ),
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    app.state.settings = resolved_settings
    app.state.query_runner = active_runner

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    def execute_read_query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        try:
            raw_rows = _invoke_query_runner(app.state.query_runner, sql, params)
            return serialize_rows(raw_rows)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="Analytical query service encountered an unexpected error.",
            ) from None

    @app.get("/", include_in_schema=False)
    def serve_portal_index() -> FileResponse:
        index_path = STATIC_DIR / "index.html"
        if not index_path.is_file():
            raise HTTPException(status_code=404, detail="Portal index.html not found.")
        return FileResponse(str(index_path), media_type="text/html; charset=utf-8")

    @app.get("/api/health")
    def get_health() -> dict[str, Any]:
        """Return portal readiness and public configuration metadata without secrets."""
        tabs_list, tabs_map = resolved_settings.resolved_tabs()
        has_db = bool(resolved_settings.resolve_database_url()) or (query_runner is not None)
        has_secret = bool(resolved_settings.resolve_mb_secret_key())
        has_dashboard_id = bool(
            resolved_settings.mb_dashboard_id and resolved_settings.mb_dashboard_id > 0
        )
        return {
            "status": "ok",
            "service": "tdf-2025-p1-portal",
            "database_configured": has_db,
            "embed_configured": bool(has_secret and has_dashboard_id),
            "p0_dashboard_url": resolved_settings.p0_dashboard_url(),
            "mb_url": resolved_settings.normalized_mb_url(),
            "mb_dashboard_id": resolved_settings.mb_dashboard_id,
            "tabs": tabs_list,
            "tabs_map": tabs_map,
            "allowed_analytics": list(ALLOWLISTED_ANALYTICS_SQL.keys()),
        }

    @app.get("/api/embed")
    def get_signed_embed(
        request: Request,
        resource: str | None = Query(default=None),
        dashboard_id: str | None = Query(default=None),
    ) -> dict[str, Any]:
        """Return a server-signed Metabase dashboard iframe URL (HS256, 10-min expiry).

        Rejects any client attempt to override the embedded dashboard resource ID.
        """
        if resource is not None or dashboard_id is not None:
            raise HTTPException(
                status_code=422,
                detail="Embedded resource ID is fixed on the server and cannot be overridden.",
            )
        return build_signed_embed_payload(resolved_settings, request.query_params)

    @app.get("/api/metadata")
    def get_metadata() -> dict[str, Any]:
        """Return conformed dimension metadata (teams, riders, stages, countries) and filter enums."""
        teams = execute_read_query(METADATA_SQL["teams"], ())
        riders = execute_read_query(METADATA_SQL["riders"], ())
        stages = execute_read_query(METADATA_SQL["stages"], ())
        countries = execute_read_query(METADATA_SQL["countries"], ())

        for stage in stages:
            s_id = stage.get("stage_id")
            s_date = stage.get("stage_date")
            s_type = stage.get("stage_type")
            s_dist = stage.get("distance_km")
            start_loc = stage.get("start_location_name")
            finish_loc = stage.get("finish_location_name")
            dist_part = f" · {s_dist} km" if s_dist is not None else ""
            route_part = f" · {start_loc} -> {finish_loc}" if start_loc and finish_loc else ""
            stage["dropdown_label"] = f"Stage {s_id} · {s_date} · {s_type}{dist_part}{route_part}"

        return {
            "teams": teams,
            "riders": riders,
            "stages": stages,
            "countries": countries,
            "filter_options": {
                "stage_scope": ["final", "as_of", "selection"],
                "as_of_stage_range": [1, 21],
                "stage_types": ["flat", "hilly", "mountain", "individual time-trial"],
                "time_basis": ["adjusted", "finish"],
                "rank_scope": ["overall", "filtered"],
                "classification": ["gc", "young", "points_proxy", "kom_proxy", "mountain_time"],
                "team_aggregation": ["stage_top3", "cumulative_top3"],
            },
            "units": FUNCTION_UNITS,
        }

    @app.post("/api/analytics/{name}")
    def post_analytics(
        name: str,
        filters: AnalyticsFilters = Body(default_factory=AnalyticsFilters),
    ) -> dict[str, Any]:
        """Execute an allowlisted `dw.*` analytical table function with a bound `Jsonb` parameter."""
        sql = ALLOWLISTED_ANALYTICS_SQL.get(name)
        if sql is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "message": f"Analytics function '{name}' is not in the allowlist.",
                    "allowed_functions": list(ALLOWLISTED_ANALYTICS_SQL.keys()),
                },
            )

        clean_filters = filters.to_clean_dict()
        bound_param = Jsonb(clean_filters)
        rows = execute_read_query(sql, (bound_param,))

        return {
            "function": name,
            "filters": clean_filters,
            "count": len(rows),
            "row_count": len(rows),
            "units": FUNCTION_UNITS.get(name, {}),
            "rows": rows,
        }

    # These named reports are shared by the analytical pages and native BI questions.
    report_queries = {
        "gc_comparison": "SELECT * FROM dw.gc_comparison(%s)",
        "gc_trajectory": "SELECT * FROM dw.gc_trajectory(%s)",
        "gc_time_rules": "SELECT * FROM dw.gc_time_rules(%s)",
        "team_roster_performance": "SELECT * FROM dw.team_roster_performance(%s)",
        "terrain_performance": "SELECT * FROM dw.terrain_performance(%s)",
        "route_directory": "SELECT * FROM dw.route_directory(%s)",
        "country_outcomes": "SELECT * FROM dw.country_outcomes(%s)",
    }

    @app.post("/api/reports/{name}")
    def read_report(name: str, filters: AnalyticsFilters = Body(default_factory=AnalyticsFilters)) -> dict[str, Any]:
        sql = report_queries.get(name)
        if sql is None:
            raise HTTPException(status_code=404, detail="Unknown race report")
        selection = filters.to_clean_dict()
        rows = execute_read_query(sql, (Jsonb(selection),))
        return {"function": name, "filters": selection, "row_count": len(rows), "rows": rows}

    @app.post("/api/team/{team_key}/riders")
    def post_team_riders(
        team_key: StrictInt = FastAPIPath(..., ge=1, description="Surrogate key from dw.dim_team"),
        filters: AnalyticsFilters = Body(default_factory=AnalyticsFilters),
    ) -> dict[str, Any]:
        """Return all starting riders on a team (including later exits) merged with stage aggregates.

        Uses `dw.fact_participation` for the roster grain (1 row per rider) left-joined
        to pre-aggregated `dw.rider_stage_results` over the selected stage scope.
        """
        clean_filters = filters.to_clean_dict()
        bound_param = Jsonb(clean_filters)
        rows = execute_read_query(TEAM_RIDERS_SQL, (int(team_key), bound_param))

        return {
            "team_key": int(team_key),
            "filters": clean_filters,
            "count": len(rows),
            "row_count": len(rows),
            "units": FUNCTION_UNITS["team_riders_drill"],
            "note": (
                "Includes all starting team members from dw.fact_participation (including riders who "
                "later exited the race). Rider time totals reflect available-stage contributions within "
                "the active stage scope and must not be interpreted as full-race GC for incomplete riders."
            ),
            "rows": rows,
        }

    @app.get("/api/team/{team_key}/riders")
    def get_team_riders(
        team_key: StrictInt = FastAPIPath(..., ge=1, description="Surrogate key from dw.dim_team"),
    ) -> dict[str, Any]:
        """Convenience GET wrapper for default-scope team roster drill."""
        return post_team_riders(team_key=team_key, filters=AnalyticsFilters())

    @app.post("/api/country/{country_code}/members")
    def post_country_members(
        country_code: str = FastAPIPath(
            ...,
            description="3-letter country code from dw.dim_country (excluding UNK)",
        ),
        filters: AnalyticsFilters = Body(default_factory=AnalyticsFilters),
    ) -> dict[str, Any]:
        """Return union of riders by nationality and registered-team roster members for a country.

        Uses `dw.fact_participation` (grain: 1 row per rider) joined to `dw.dim_country`,
        `dw.dim_rider`, and `dw.dim_team` so overlapping roles (`rider_nationality`,
        `team_registration`, `both`) never produce duplicate membership rows, while preserving
        exited riders and unspecified rider nationality (`'UNK'`) on registered teams.
        """
        normalized_code = _validate_country_code(country_code)
        clean_filters = filters.to_clean_dict()
        bound_param = Jsonb(clean_filters)
        rows = execute_read_query(COUNTRY_MEMBERS_SQL, (normalized_code, bound_param))

        country_name = rows[0].get("country_name") if rows else None
        rider_national_count = sum(
            1
            for r in rows
            if r.get("is_rider_national") is True
            or r.get("role_code") in ("rider_nationality", "both")
        )
        team_member_count = sum(
            1
            for r in rows
            if r.get("is_team_registered") is True
            or r.get("role_code") in ("team_registration", "both")
        )
        both_roles_count = sum(1 for r in rows if r.get("role_code") == "both")
        rider_only_count = sum(1 for r in rows if r.get("role_code") == "rider_nationality")
        team_only_count = sum(1 for r in rows if r.get("role_code") == "team_registration")
        registered_team_keys = {
            r.get("team_key")
            for r in rows
            if (
                r.get("is_team_registered") is True
                or r.get("role_code") in ("team_registration", "both")
            )
            and r.get("team_key") is not None
        }
        finisher_count = sum(1 for r in rows if r.get("finished_race_flag") == 1)
        exited_count = len(rows) - finisher_count

        return {
            "country_code": normalized_code,
            "country_name": country_name,
            "filters": clean_filters,
            "count": len(rows),
            "row_count": len(rows),
            "summary": {
                "union_member_count": len(rows),
                "rider_national_count": rider_national_count,
                "registered_team_member_count": team_member_count,
                "registered_team_count": len(registered_team_keys),
                "both_roles_count": both_roles_count,
                "rider_nationality_only_count": rider_only_count,
                "team_registration_only_count": team_only_count,
                "finisher_count": finisher_count,
                "exited_count": exited_count,
            },
            "units": FUNCTION_UNITS["country_members_drill"],
            "note": (
                "Includes the union of participating riders of this nationality and roster members "
                "of teams registered in this country from dw.fact_participation (1 row per rider, "
                "no duplicate rows). Preserves exited riders and unspecified rider nationality ('UNK') "
                "on registered teams."
            ),
            "rows": rows,
        }

    @app.get("/api/country/{country_code}/members")
    def get_country_members(
        country_code: str = FastAPIPath(
            ...,
            description="3-letter country code from dw.dim_country (excluding UNK)",
        ),
    ) -> dict[str, Any]:
        """Convenience GET wrapper for default-scope country union-member drill."""
        return post_country_members(country_code=country_code, filters=AnalyticsFilters())

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(_request: Request, _exc: Exception) -> JSONResponse:
        """Guarantee stack traces and secret values are never leaked in HTTP responses."""
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal portal server error."},
        )

    return app


app = create_app()
