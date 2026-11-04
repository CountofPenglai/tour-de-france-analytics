"""Offline unit tests for the Tour de France 2025 P1 FastAPI + HTML portal.

Covers:
- Function allowlist enforcement and static SQL usage.
- Strict Pydantic filter validation (422 on bad enums, out-of-range stages, extra keys).
- Bound `psycopg.types.json.Jsonb` parameter passing (SQL injection resilience).
- Distinction between omitted/`null` filter keys and explicit empty arrays `[]`.
- Decimal, date, and nullable (`gap_seconds=None`, `finisher_rate=None`) JSON serialization.
- Server-only HS256 JWT signed embedding (`resource: {"dashboard": id}`, `params: {}`, 10-min `exp`),
  file-based secret resolution, rejection of client-supplied resource IDs, and zero secret leakage.
- Useful HTTP 503 response when embedding configuration is absent.
- Team -> Rider -> Stage drill endpoint preserving exited team members and bib #78 ('UNK')
  using shared `dw` source functions without duplicating ranking/scoring algorithms.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import jwt
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from web.app import (
    ALLOWLISTED_ANALYTICS_SQL,
    COUNTRY_MEMBERS_SQL,
    TEAM_RIDERS_SQL,
    PortalSettings,
    create_app,
)


class RecordingQueryRunner:
    """In-memory test query runner that records `(sql, params)` calls without a live DB."""

    def __init__(self, CannedResponses: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.canned_rows: list[dict[str, Any]] = CannedResponses or []

    def __call__(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        self.calls.append((sql, tuple(params)))
        return list(self.canned_rows)


class PortalWebTests(unittest.TestCase):
    """Test suite for `web.app` using FastAPI TestClient and injected `query_runner`."""

    def test_health_no_secrets_and_offline_startup(self) -> None:
        secret_value = "super-secret-metabase-signing-key-do-not-expose"
        db_dsn = "postgresql://tdf_reader:topsecretpass@127.0.0.1:5432/tour_de_france"
        settings = PortalSettings(
            database_url=db_dsn,
            mb_embedding_secret_key=secret_value,
            mb_url="http://127.0.0.1:3000",
            mb_dashboard_id=14,
        )
        runner = RecordingQueryRunner()
        app = create_app(settings=settings, query_runner=runner)
        client = TestClient(app)

        # Startup makes zero DB queries
        self.assertEqual(len(runner.calls), 0)

        resp = client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        body_text = resp.text
        self.assertNotIn(secret_value, body_text)
        self.assertNotIn("topsecretpass", body_text)
        self.assertNotIn(db_dsn, body_text)

        payload = resp.json()
        self.assertEqual(payload["status"], "ok")
        self.assertTrue(payload["database_configured"])
        self.assertTrue(payload["embed_configured"])
        self.assertEqual(payload["p0_dashboard_url"], "http://127.0.0.1:3000/dashboard/14")
        self.assertEqual(set(payload["allowed_analytics"]), set(ALLOWLISTED_ANALYTICS_SQL.keys()))
        self.assertEqual(len(payload["tabs"]), 5)

    def test_portal_index_and_static_assets_no_cdn(self) -> None:
        runner = RecordingQueryRunner()
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        html_resp = client.get("/")
        self.assertEqual(html_resp.status_code, 200)
        html_text = html_resp.text
        self.assertIn("Tour de France 2025 · Race Analytics", html_text)
        self.assertIn("Race Dashboard", html_text)
        self.assertIn("Refresh dashboard", html_text)
        self.assertIn("Explore five analytical views", html_text)
        self.assertIn("Points Proxy", html_text)
        self.assertIn("KOM Proxy", html_text)
        self.assertIn("never official", html_text)
        self.assertIn("Young Rider", html_text)
        self.assertNotIn("U25", html_text)
        self.assertIn("Team → Rider → Stage Inspector", html_text)
        # Verify no external CDN scripts or stylesheets are referenced
        self.assertNotIn("https://cdn.", html_text)
        self.assertNotIn("https://fonts.googleapis.com", html_text)
        self.assertNotIn("https://unpkg.com", html_text)

        css_resp = client.get("/static/styles.css")
        self.assertEqual(css_resp.status_code, 200)
        self.assertIn("--tour-yellow", css_resp.text)
        self.assertIn("minmax(0, 1fr)", css_resp.text)
        self.assertIn("min-width: 0", css_resp.text)

        js_resp = client.get("/static/app.js")
        self.assertEqual(js_resp.status_code, 200)
        self.assertIn("/api/team/", js_resp.text)
        self.assertIn("/api/analytics/rider_stage_results", js_resp.text)

    def test_analytics_function_whitelist(self) -> None:
        runner = RecordingQueryRunner()
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        for fn_name, expected_sql in ALLOWLISTED_ANALYTICS_SQL.items():
            runner.calls.clear()
            resp = client.post(f"/api/analytics/{fn_name}", json={})
            self.assertEqual(resp.status_code, 200, msg=f"Failed for allowlisted {fn_name}")
            self.assertEqual(len(runner.calls), 1)
            sql, params = runner.calls[0]
            self.assertEqual(sql, expected_sql)
            self.assertEqual(len(params), 1)
            self.assertIsInstance(params[0], Jsonb)
            self.assertEqual(params[0].obj, {})

        # Disallowed / injection function names must be rejected without touching query_runner
        runner.calls.clear()
        for disallowed in (
            "olap_rollup",
            "pg_sleep",
            "arbitrary_sql",
            "rider_standings; DROP TABLE dw.fact_results;--",
        ):
            resp = client.post(f"/api/analytics/{disallowed}", json={})
            self.assertEqual(resp.status_code, 404)
        self.assertEqual(len(runner.calls), 0)

    def test_bad_filters_return_422_without_executing_sql(self) -> None:
        runner = RecordingQueryRunner()
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        invalid_payloads: list[Any] = [
            {"stage_scope": "all_stages"},
            {"as_of_stage": 0},
            {"as_of_stage": 22},
            {"as_of_stage": -3},
            {"as_of_stage": True},
            {"stage_ids": [0]},
            {"stage_ids": [1, 22]},
            {"stage_ids": ["1"]},
            {"stage_ids": "1,2"},
            {"stage_types": ["gravel"]},
            {"stage_types": ["flat'; DROP TABLE dw.fact_results;--"]},
            {"time_basis": "raw"},
            {"rank_scope": "subgroup"},
            {"team_keys": [0]},
            {"team_keys": [-5]},
            {"rider_keys": [0]},
            {"young_only": "true"},
            {"classification": "sprint_official"},
            {"team_aggregation": "top5"},
            {"unexpected_key": "value"},
            {"sql": "SELECT 1"},
        ]

        for bad_payload in invalid_payloads:
            resp = client.post("/api/analytics/rider_standings", json=bad_payload)
            self.assertEqual(
                resp.status_code,
                422,
                msg=f"Expected 422 for payload {bad_payload}, got {resp.status_code}",
            )

        # Also verify invalid team_key on /api/team/{key}/riders returns 422
        self.assertEqual(client.post("/api/team/0/riders", json={}).status_code, 422)
        self.assertEqual(client.post("/api/team/-1/riders", json={}).status_code, 422)
        self.assertEqual(len(runner.calls), 0)

    def test_filter_null_ignored_and_empty_array_preserved(self) -> None:
        runner = RecordingQueryRunner()
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        # Case 1: null values are ignored (excluded from bound jsonb), present values kept
        resp1 = client.post(
            "/api/analytics/rider_standings",
            json={
                "stage_scope": "as_of",
                "as_of_stage": 10,
                "team_keys": None,
                "rider_keys": None,
                "stage_ids": None,
                "time_basis": "adjusted",
            },
        )
        self.assertEqual(resp1.status_code, 200)
        _, params1 = runner.calls[-1]
        self.assertIsInstance(params1[0], Jsonb)
        self.assertEqual(
            params1[0].obj,
            {
                "stage_scope": "as_of",
                "as_of_stage": 10,
                "time_basis": "adjusted",
            },
        )

        # Case 2: explicit empty arrays `[]` are preserved (distinct from missing/null)
        resp2 = client.post(
            "/api/analytics/rider_stage_results",
            json={
                "stage_scope": "selection",
                "stage_ids": [],
                "team_keys": [],
                "rider_keys": [],
            },
        )
        self.assertEqual(resp2.status_code, 200)
        _, params2 = runner.calls[-1]
        self.assertIsInstance(params2[0], Jsonb)
        self.assertEqual(
            params2[0].obj,
            {
                "stage_scope": "selection",
                "stage_ids": [],
                "team_keys": [],
                "rider_keys": [],
            },
        )

    def test_decimal_date_and_nullable_serialization(self) -> None:
        sample_rows = [
            {
                "rider_key": 1,
                "bib_number": 1,
                "rider_name": "Sample Rider",
                "stage_date": date(2025, 7, 5),
                "distance_km": Decimal("184.90"),
                "rank_percentile": Decimal("100.00"),
                "gap_seconds": None,  # NULL in proxy classifications
                "finisher_rate": None,  # NULL in 0-rider countries
            }
        ]
        runner = RecordingQueryRunner(sample_rows)
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        resp = client.post(
            "/api/analytics/rider_standings",
            json={"classification": "points_proxy"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["row_count"], 1)
        row = data["rows"][0]
        self.assertEqual(row["stage_date"], "2025-07-05")
        self.assertIsInstance(row["distance_km"], float)
        self.assertAlmostEqual(row["distance_km"], 184.9)
        self.assertIsInstance(row["rank_percentile"], float)
        self.assertAlmostEqual(row["rank_percentile"], 100.0)
        self.assertIsNone(row["gap_seconds"])
        self.assertIsNone(row["finisher_rate"])

    def test_signed_embed_jwt_resource_expiry_and_no_secret_leak(self) -> None:
        secret = "test-hs256-embedding-secret-key-987654321"
        tabs_json = '{"Tab 1: Executive & Race Overview": 101, "Tab 2: Classifications Comparison": 102}'
        settings = PortalSettings(
            mb_embedding_secret_key=secret,
            mb_url="http://127.0.0.1:3000",
            mb_dashboard_id=42,
            mb_tabs_json=tabs_json,
        )
        app = create_app(settings=settings, query_runner=RecordingQueryRunner())
        client = TestClient(app)

        resp = client.get(
            "/api/embed",
            params={"tab": "Tab 1: Executive & Race Overview", "time_basis": "adjusted"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn(secret, resp.text)

        payload = resp.json()
        self.assertEqual(payload["dashboard_id"], 42)
        self.assertEqual(payload["expires_in_seconds"], 600)
        self.assertEqual(payload["active_tab_id"], 101)

        iframe_url = payload["iframe_url"]
        parsed = urlparse(iframe_url)
        self.assertEqual(parsed.scheme, "http")
        self.assertEqual(parsed.netloc, "127.0.0.1:3000")
        self.assertTrue(parsed.path.startswith("/embed/dashboard/"))
        token = parsed.path.split("/embed/dashboard/", 1)[1]

        decoded = jwt.decode(token, secret, algorithms=["HS256"])
        self.assertEqual(decoded["resource"], {"dashboard": 42})
        self.assertEqual(decoded["params"], {})
        self.assertEqual(decoded["exp"] - decoded["iat"], 600)

        # Client attempts to override dashboard_id or resource must be rejected
        self.assertEqual(client.get("/api/embed?dashboard_id=999").status_code, 422)
        self.assertEqual(client.get("/api/embed?resource=999").status_code, 422)

    def test_signed_embed_secret_from_file_and_503_when_missing(self) -> None:
        # 1. Missing config returns 503 with helpful missing_config list
        unconfigured_app = create_app(
            settings=PortalSettings(mb_url="http://127.0.0.1:3000"),
            query_runner=RecordingQueryRunner(),
        )
        unconfigured_client = TestClient(unconfigured_app)
        resp_503 = unconfigured_client.get("/api/embed")
        self.assertEqual(resp_503.status_code, 503)
        detail = resp_503.json()["detail"]
        self.assertIn("MB_EMBEDDING_SECRET_KEY", detail["missing_config"])
        self.assertIn("MB_DASHBOARD_ID", detail["missing_config"])

        # 2. Secret loaded from MB_EMBEDDING_SECRET_KEY_FILE works and never leaks
        with tempfile.TemporaryDirectory() as tmpdir:
            secret_file = Path(tmpdir) / "mb_secret.txt"
            file_secret = "file-backed-jwt-secret-key-2025"
            secret_file.write_text(f"{file_secret}\n", encoding="utf-8")

            file_settings = PortalSettings(
                mb_embedding_secret_key_file=str(secret_file),
                mb_dashboard_id=9,
            )
            file_app = create_app(settings=file_settings, query_runner=RecordingQueryRunner())
            file_client = TestClient(file_app)

            ok_resp = file_client.get("/api/embed")
            self.assertEqual(ok_resp.status_code, 200)
            self.assertNotIn(file_secret, ok_resp.text)
            self.assertNotIn(str(secret_file), ok_resp.text)

    def test_team_riders_drill_includes_exits_and_unk_nationality_via_bound_sql(self) -> None:
        mock_roster_rows = [
            {
                "rider_key": 78,
                "bib_number": 78,
                "rider_name": "Aleksandr Vlasov",
                "age_at_race": 29,
                "age_group": "26-29",
                "is_young_rider": False,
                "rider_country_code": "UNK",
                "rider_country_name": "Unknown / Unspecified",
                "team_key": 8,
                "team_name": "Red Bull - BORA - hansgrohe",
                "finished_race_flag": 1,
                "exit_flag": 0,
                "participation_status": "finished",
                "stages_completed": 21,
                "selected_stage_count": 21,
                "completed_selected_scope": True,
                "is_full_gc_finisher": True,
                "finish_time_seconds": 281000,
                "adjusted_time_seconds": 280990,
                "selected_time_seconds": 280990,
                "time_bonus_seconds": 10,
                "time_penalty_seconds": 0,
                "stage_points_proxy": 45,
                "kom_points_proxy": 12,
                "best_stage_rank": 4,
                "stage_wins": 0,
                "stage_podiums": 0,
                "top10_finishes": 3,
                "avg_rank_percentile": Decimal("84.50"),
                "last_stage_id": 21,
                "contribution_label": "Full 21-stage finisher (available for GC & team contribution)",
            },
            {
                "rider_key": 79,
                "bib_number": 79,
                "rider_name": "Exited Teammate Example",
                "age_at_race": 24,
                "age_group": "23-25",
                "is_young_rider": True,
                "rider_country_code": "GER",
                "rider_country_name": "Germany",
                "team_key": 8,
                "team_name": "Red Bull - BORA - hansgrohe",
                "finished_race_flag": 0,
                "exit_flag": 1,
                "participation_status": "exited",
                "stages_completed": 9,
                "selected_stage_count": 21,
                "completed_selected_scope": False,
                "is_full_gc_finisher": False,
                "finish_time_seconds": 115000,
                "adjusted_time_seconds": 115000,
                "selected_time_seconds": 115000,
                "time_bonus_seconds": 0,
                "time_penalty_seconds": 0,
                "stage_points_proxy": 10,
                "kom_points_proxy": 0,
                "best_stage_rank": 12,
                "stage_wins": 0,
                "stage_podiums": 0,
                "top10_finishes": 0,
                "avg_rank_percentile": Decimal("62.10"),
                "last_stage_id": 9,
                "contribution_label": "Available-stage contribution only (9/21 stages; exited / incomplete for full GC)",
            },
        ]
        runner = RecordingQueryRunner(mock_roster_rows)
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        resp = client.post(
            "/api/team/8/riders",
            json={"stage_scope": "final", "time_basis": "adjusted"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(runner.calls), 1)
        sql, params = runner.calls[0]
        self.assertEqual(sql, TEAM_RIDERS_SQL)
        self.assertIn("dw.fact_participation", sql)
        self.assertIn("dw.rider_stage_results", sql)
        self.assertIn("LEFT JOIN stage_agg", sql)
        self.assertEqual(params[0], 8)
        self.assertIsInstance(params[1], Jsonb)
        self.assertEqual(params[1].obj, {"stage_scope": "final", "time_basis": "adjusted"})

        body = resp.json()
        self.assertEqual(body["team_key"], 8)
        self.assertEqual(body["row_count"], 2)
        rows = body["rows"]
        self.assertEqual(rows[0]["bib_number"], 78)
        self.assertEqual(rows[0]["rider_country_code"], "UNK")
        self.assertEqual(rows[1]["participation_status"], "exited")
        self.assertFalse(rows[1]["is_full_gc_finisher"])
        self.assertIn("Available-stage contribution only", rows[1]["contribution_label"])

    def test_embed_filter_parity_repeated_arrays_and_ignored_unknown_params(self) -> None:
        secret = "test-embed-filter-parity-secret-key"
        settings = PortalSettings(
            mb_embedding_secret_key=secret,
            mb_url="http://127.0.0.1:3000",
            mb_dashboard_id=12,
        )
        app = create_app(settings=settings, query_runner=RecordingQueryRunner())
        client = TestClient(app)

        # Repeated array values must be preserved via multi_items + urlencode(doseq=True),
        # while `team_aggregation` and unknown params are ignored.
        resp = client.get(
            "/api/embed"
            "?stage_scope=selection"
            "&stage_ids=4&stage_ids=14"
            "&stage_types=mountain&stage_types=individual+time-trial"
            "&time_basis=adjusted"
            "&rank_scope=filtered"
            "&team_keys=1&team_keys=8"
            "&rider_keys=1&rider_keys=78"
            "&young_only=true"
            "&team_aggregation=cumulative_top3"
            "&unknown_param=ignored_value"
        )
        self.assertEqual(resp.status_code, 200)
        iframe_url = resp.json()["iframe_url"]
        parsed = urlparse(iframe_url)
        qs = parse_qs(parsed.query, keep_blank_values=True)

        self.assertEqual(qs.get("stage_scope"), ["selection"])
        self.assertEqual(qs.get("stage_ids"), ["4", "14"])
        self.assertEqual(qs.get("stage_types"), ["mountain", "individual time-trial"])
        self.assertEqual(qs.get("time_basis"), ["adjusted"])
        self.assertEqual(qs.get("rank_scope"), ["filtered"])
        self.assertEqual(qs.get("team_keys"), ["1", "8"])
        self.assertEqual(qs.get("rider_keys"), ["1", "78"])
        self.assertEqual(qs.get("young_only"), ["true"])
        self.assertNotIn("team_aggregation", qs)
        self.assertNotIn("unknown_param", qs)

        # Explicit empty array selection (`stage_ids=`) is preserved distinct from omitted
        empty_resp = client.get("/api/embed?stage_scope=selection&stage_ids=")
        self.assertEqual(empty_resp.status_code, 200)
        empty_qs = parse_qs(urlparse(empty_resp.json()["iframe_url"]).query, keep_blank_values=True)
        self.assertEqual(empty_qs.get("stage_ids"), [""])
        self.assertNotIn("team_keys", empty_qs)

        # Invalid filter values on /api/embed return 422
        self.assertEqual(client.get("/api/embed?as_of_stage=22").status_code, 422)
        self.assertEqual(client.get("/api/embed?stage_types=cobbles").status_code, 422)
        self.assertEqual(client.get("/api/embed?stage_ids=0").status_code, 422)
        self.assertEqual(client.get("/api/embed?team_keys=0").status_code, 422)

    def test_embed_tab_navigation_index_collision_regression(self) -> None:
        # Live deployment maps index 1->4, 2->5, 3->6, 4->7, 5->8.
        # Canonical tab key `tab_2_classifications` must resolve once to 5 (never remapping 5->8).
        secret = "test-tab-collision-regression-secret"
        settings = PortalSettings(
            mb_embedding_secret_key=secret,
            mb_url="http://127.0.0.1:3000",
            mb_dashboard_id=2,
            mb_tabs_json='{"1": 4, "2": 5, "3": 6, "4": 7, "5": 8}',
        )
        app = create_app(settings=settings, query_runner=RecordingQueryRunner())
        client = TestClient(app)

        expected_by_key = {
            "tab_1_overview": 4,
            "tab_2_classifications": 5,
            "tab_3_performance": 6,
            "tab_4_countries": 7,
            "tab_5_insights": 8,
        }
        for canonical_key, expected_tab_id in expected_by_key.items():
            resp = client.get("/api/embed", params={"tab": canonical_key})
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(body["active_tab_id"], expected_tab_id)
            qs = parse_qs(urlparse(body["iframe_url"]).query)
            self.assertEqual(qs.get("tab"), [str(expected_tab_id)])

        # When MB_TABS_JSON is not configured, do not fake a tab jump parameter on the iframe URL
        no_tabs_app = create_app(
            settings=PortalSettings(
                mb_embedding_secret_key=secret,
                mb_url="http://127.0.0.1:3000",
                mb_dashboard_id=2,
            ),
            query_runner=RecordingQueryRunner(),
        )
        no_tabs_client = TestClient(no_tabs_app)
        no_tabs_resp = no_tabs_client.get("/api/embed", params={"tab": "tab_2_classifications"})
        self.assertEqual(no_tabs_resp.status_code, 200)
        self.assertIsNone(no_tabs_resp.json()["active_tab_id"])
        self.assertNotIn("tab", parse_qs(urlparse(no_tabs_resp.json()["iframe_url"]).query))

    def test_embed_accepts_csv_serialized_array_params(self) -> None:
        secret = "test-embed-csv-array-secret"
        settings = PortalSettings(
            mb_embedding_secret_key=secret,
            mb_url="http://127.0.0.1:3000",
            mb_dashboard_id=12,
        )
        app = create_app(settings=settings, query_runner=RecordingQueryRunner())
        client = TestClient(app)

        resp = client.get(
            "/api/embed"
            "?stage_scope=selection"
            "&stage_ids=5,13"
            "&team_keys=20,22"
            "&rider_keys=1,9"
            "&stage_types=mountain,individual+time-trial"
        )
        self.assertEqual(resp.status_code, 200)
        qs = parse_qs(urlparse(resp.json()["iframe_url"]).query, keep_blank_values=True)
        self.assertEqual(qs.get("stage_scope"), ["selection"])
        self.assertEqual(qs.get("stage_ids"), ["5", "13"])
        self.assertEqual(qs.get("team_keys"), ["20", "22"])
        self.assertEqual(qs.get("rider_keys"), ["1", "9"])
        self.assertEqual(qs.get("stage_types"), ["mountain", "individual time-trial"])

        # Invalid CSV items must still return 422
        self.assertEqual(client.get("/api/embed?stage_ids=5,99").status_code, 422)
        self.assertEqual(client.get("/api/embed?team_keys=20,0").status_code, 422)
        self.assertEqual(client.get("/api/embed?stage_types=mountain,cobbles").status_code, 422)

    def test_country_members_endpoint_validation_and_bound_sql(self) -> None:
        runner = RecordingQueryRunner()
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        # Invalid country codes (including UNK, NULL, non-3-letter, numeric, SQL injection)
        # must return 422 before any SQL is executed.
        for bad_code in (
            "UNK",
            "unk",
            "NULL",
            "FR",
            "FRAX",
            "123",
            "FR1",
            "FRA'; DROP TABLE dw.dim_country;--",
        ):
            post_resp = client.post(f"/api/country/{bad_code}/members", json={})
            self.assertEqual(
                post_resp.status_code,
                422,
                msg=f"Expected 422 for POST country_code={bad_code!r}",
            )
            get_resp = client.get(f"/api/country/{bad_code}/members")
            self.assertEqual(
                get_resp.status_code,
                422,
                msg=f"Expected 422 for GET country_code={bad_code!r}",
            )

        # Invalid filter body on POST /api/country/FRA/members also returns 422 without SQL
        self.assertEqual(
            client.post("/api/country/FRA/members", json={"team_keys": [0]}).status_code,
            422,
        )
        self.assertEqual(
            client.post("/api/country/FRA/members", json={"unexpected_key": 1}).status_code,
            422,
        )
        self.assertEqual(len(runner.calls), 0)

        # Lowercase 'fra' normalizes to 'FRA' and binds ("FRA", Jsonb(...)) to COUNTRY_MEMBERS_SQL
        ok_resp = client.post(
            "/api/country/fra/members",
            json={"team_keys": [1, 4], "young_only": True, "rider_keys": None},
        )
        self.assertEqual(ok_resp.status_code, 200)
        self.assertEqual(len(runner.calls), 1)
        sql, params = runner.calls[0]
        self.assertEqual(sql, COUNTRY_MEMBERS_SQL)
        self.assertIn("dw.dim_country", sql)
        self.assertIn("dw.fact_participation", sql)
        self.assertIn("dw.dim_rider", sql)
        self.assertIn("dw.dim_team", sql)
        self.assertEqual(params[0], "FRA")
        self.assertIsInstance(params[1], Jsonb)
        self.assertEqual(params[1].obj, {"team_keys": [1, 4], "young_only": True})

    def test_country_members_role_union_counts_and_preserves_unk_and_exits(self) -> None:
        # Case 1: Country with both roles, rider-nationality-only, and team-registration-only
        fra_union_rows = [
            {
                "country_code": "FRA",
                "country_name": "France",
                "rider_key": 11,
                "bib_number": 11,
                "rider_name": "French National On French Team",
                "age_at_race": 24,
                "age_group": "23-25",
                "is_young_rider": True,
                "rider_country_code": "FRA",
                "rider_country_name": "France",
                "team_key": 4,
                "team_name": "Decathlon AG2R La Mondiale Team",
                "team_country_code": "FRA",
                "team_country_name": "France",
                "finished_race_flag": 1,
                "exit_flag": 0,
                "participation_status": "finished",
                "is_rider_national": True,
                "is_team_registered": True,
                "role_code": "both",
                "membership_role": "Rider Nationality & Team Registration",
            },
            {
                "country_code": "FRA",
                "country_name": "France",
                "rider_key": 12,
                "bib_number": 12,
                "rider_name": "French National On Foreign Team",
                "age_at_race": 28,
                "age_group": "26-29",
                "is_young_rider": False,
                "rider_country_code": "FRA",
                "rider_country_name": "France",
                "team_key": 21,
                "team_name": "Team Visma | Lease a Bike",
                "team_country_code": "NLD",
                "team_country_name": "Netherlands",
                "finished_race_flag": 1,
                "exit_flag": 0,
                "participation_status": "finished",
                "is_rider_national": True,
                "is_team_registered": False,
                "role_code": "rider_nationality",
                "membership_role": "Rider Nationality",
            },
            {
                "country_code": "FRA",
                "country_name": "France",
                "rider_key": 18,
                "bib_number": 18,
                "rider_name": "Foreign Rider On French Team (Exited)",
                "age_at_race": 30,
                "age_group": "30+",
                "is_young_rider": False,
                "rider_country_code": "AUS",
                "rider_country_name": "Australia",
                "team_key": 4,
                "team_name": "Decathlon AG2R La Mondiale Team",
                "team_country_code": "FRA",
                "team_country_name": "France",
                "finished_race_flag": 0,
                "exit_flag": 1,
                "participation_status": "exited",
                "is_rider_national": False,
                "is_team_registered": True,
                "role_code": "team_registration",
                "membership_role": "Team Registration",
            },
        ]
        runner = RecordingQueryRunner(fra_union_rows)
        app = create_app(settings=PortalSettings(), query_runner=runner)
        client = TestClient(app)

        resp = client.post("/api/country/FRA/members", json={})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["country_code"], "FRA")
        self.assertEqual(body["country_name"], "France")
        self.assertEqual(body["row_count"], 3)
        summary = body["summary"]
        self.assertEqual(summary["union_member_count"], 3)
        self.assertEqual(summary["rider_national_count"], 2)
        self.assertEqual(summary["registered_team_member_count"], 2)
        self.assertEqual(summary["registered_team_count"], 1)
        self.assertEqual(summary["both_roles_count"], 1)
        self.assertEqual(summary["rider_nationality_only_count"], 1)
        self.assertEqual(summary["team_registration_only_count"], 1)
        self.assertEqual(summary["finisher_count"], 2)
        self.assertEqual(summary["exited_count"], 1)

        # Case 2: Registered-team country drill preserves #78 Aleksandr Vlasov ('UNK' nationality)
        deu_rows = [
            {
                "country_code": "GER",
                "country_name": "Germany",
                "rider_key": 78,
                "bib_number": 78,
                "rider_name": "Aleksandr Vlasov",
                "age_at_race": 29,
                "age_group": "26-29",
                "is_young_rider": False,
                "rider_country_code": "UNK",
                "rider_country_name": "Unknown / Unspecified",
                "team_key": 8,
                "team_name": "Red Bull - BORA - hansgrohe",
                "team_country_code": "GER",
                "team_country_name": "Germany",
                "finished_race_flag": 1,
                "exit_flag": 0,
                "participation_status": "finished",
                "is_rider_national": False,
                "is_team_registered": True,
                "role_code": "team_registration",
                "membership_role": "Team Registration",
            }
        ]
        runner.canned_rows = deu_rows
        get_resp = client.get("/api/country/GER/members")
        self.assertEqual(get_resp.status_code, 200)
        deu_body = get_resp.json()
        self.assertEqual(deu_body["summary"]["union_member_count"], 1)
        self.assertEqual(deu_body["summary"]["rider_national_count"], 0)
        self.assertEqual(deu_body["summary"]["registered_team_member_count"], 1)
        self.assertEqual(deu_body["rows"][0]["bib_number"], 78)
        self.assertEqual(deu_body["rows"][0]["rider_country_code"], "UNK")
        self.assertEqual(deu_body["rows"][0]["role_code"], "team_registration")


if __name__ == "__main__":
    unittest.main()
