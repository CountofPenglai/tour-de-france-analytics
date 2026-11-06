"""Offline unit tests for scripts/provision_dashboard.py (Task 03 P0 Metabase Dashboard).

Tests cover:
1. Metabase OSS v0.65.2.5 write-schema compliance against tests/fixtures/metabase-write-schemas.json.
2. Regression check for PostgreSQL JDBC '?' placeholder bug: ensures jsonb_exists(f, ...) is used
   and '?' never appears in any native SQL card query.
3. Shortened card titles (no hardcoded counts in titles), single-unit chart axes, and human-friendly
   selector labels (Team, Rider, Country, Young Rider) with defaults final/adjusted/overall/21
   and lookup dropdown values.
4. Metadata-informed table formatting (table.columns hiding surrogate *_key columns while keeping
   bib_number/stage_id enabled, readable column_title labels with explicit units, merged
   column_settings preserving both column_title and click_behavior, and plain-English captions).
5. Native Metabase Pivot card (display='pivot', query_kind='pivot_mbql' over card__<source_id>)
   alongside the filterable native SQL Cross-Tab card on Tab 5.
6. Reusable native SQL JSONB filter fragment, typed template tags, parameter mappings,
   and omission of blank optional keys.
7. Deterministic idempotent provisioning, preservation of deployed IDs (collection 6, dashboard 3,
   tabs 4..8, cards 41..71, dashcards 38..69), preservation of enable_embedding/embedding_params
   on dashboard 3, protected object safety (collection 5, dashboard 2, card 40), and credential redaction.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import urlparse, parse_qs
from typing import Any, Dict, List, Optional, Tuple

from scripts import provision_dashboard as pd


REPO_ROOT = Path(__file__).resolve().parent.parent
WRITE_SCHEMAS_PATH = REPO_ROOT / "tests" / "fixtures" / "metabase-write-schemas.json"
API_SUMMARY_PATH = REPO_ROOT / "tests" / "fixtures" / "metabase-api-summary.json"
ANALYTICS_SQL_PATH = REPO_ROOT / "sql" / "003_analytics.sql"
DEPLOYED_STATE_PATH = REPO_ROOT / "tests" / "fixtures" / "metabase-state.json"


class FakeMetabaseServer:
    """In-memory mock Metabase REST API server for testing idempotent provisioning offline."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, str, Optional[Dict[str, Any]]]] = []
        self.next_collection_id = 10
        self.next_card_id = 100
        self.next_dashboard_id = 20
        self.next_tab_id = 500
        self.next_dashcard_id = 5000

        # Pre-seed installation check objects (collection 5, dashboard 2, card 40)
        self.collections: Dict[int, Dict[str, Any]] = {
            5: {"id": 5, "name": "Installation Check Collection", "archived": False}
        }
        self.dashboards: Dict[int, Dict[str, Any]] = {
            2: {"id": 2, "name": "Installation Check Dashboard", "tabs": [], "dashcards": []}
        }
        self.cards: Dict[int, Dict[str, Any]] = {
            40: {"id": 40, "name": "Installation Check Card", "collection_id": 5}
        }

    def seed_from_state(self, state: Dict[str, Any], enable_embedding: bool = True) -> None:
        """Seed mock server with already-deployed objects from build/metabase-state.json."""
        col_id = int(state["collection_id"])
        dash_id = int(state["dashboard_id"])
        self.collections[col_id] = {
            "id": col_id,
            "name": pd.DEFAULT_COLLECTION_NAME,
            "archived": False,
        }
        for slug, cid in (state.get("cards") or {}).items():
            self.cards[int(cid)] = {
                "id": int(cid),
                "name": slug,
                "collection_id": col_id,
            }
            if int(cid) >= self.next_card_id:
                self.next_card_id = int(cid) + 1

        tabs = []
        for t_spec in pd.TAB_SPECS:
            tid = state.get("tabs", {}).get(t_spec.slug)
            if tid:
                tabs.append({"id": int(tid), "name": t_spec.name, "position": t_spec.position})
                if int(tid) >= self.next_tab_id:
                    self.next_tab_id = int(tid) + 1

        dashcards = []
        for cap in pd.CAPTION_SPECS:
            dc_id = state.get("dashcards", {}).get(cap.slug)
            t_id = state.get("tabs", {}).get(cap.tab_slug)
            if dc_id:
                dashcards.append(
                    {
                        "id": int(dc_id),
                        "card_id": None,
                        "dashboard_tab_id": int(t_id) if t_id else None,
                        "row": cap.row,
                        "col": cap.col,
                        "size_x": cap.size_x,
                        "size_y": cap.size_y,
                    }
                )
                if int(dc_id) >= self.next_dashcard_id:
                    self.next_dashcard_id = int(dc_id) + 1

        for spec in pd.DASHBOARD_CARD_SPECS:
            dc_id = state.get("dashcards", {}).get(spec.slug)
            cid = state.get("cards", {}).get(spec.slug)
            t_id = state.get("tabs", {}).get(spec.tab_slug)
            if dc_id and cid:
                dashcards.append(
                    {
                        "id": int(dc_id),
                        "card_id": int(cid),
                        "dashboard_tab_id": int(t_id) if t_id else None,
                        "row": spec.row,
                        "col": spec.col,
                        "size_x": spec.size_x,
                        "size_y": spec.size_y,
                    }
                )
                if int(dc_id) >= self.next_dashcard_id:
                    self.next_dashcard_id = int(dc_id) + 1

        self.dashboards[dash_id] = {
            "id": dash_id,
            "name": pd.DEFAULT_DASHBOARD_NAME,
            "collection_id": col_id,
            "enable_embedding": enable_embedding,
            "embedding_params": {"stage_scope": "enabled", "team_keys": "enabled"},
            "tabs": tabs,
            "dashcards": dashcards,
        }

    def transport(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes],
    ) -> Tuple[int, bytes]:
        path = "/" + url.split("://", 1)[1].split("/", 1)[1]
        payload = json.loads(body.decode("utf-8")) if body else None
        self.calls.append((method, path, payload))

        if path == "/api/session" and method == "POST":
            return 200, json.dumps({"id": "mock-session-token-xyz"}).encode("utf-8")

        if headers.get("X-Metabase-Session") != "mock-session-token-xyz" and not headers.get("X-API-Key"):
            return 401, b'{"error":"unauthenticated"}'

        if path == "/api/database/2/sync_schema" and method == "POST":
            return 200, b'{"status":"ok"}'

        if path == "/api/database/2/metadata" and method == "GET":
            tables = [
                {"id": 201, "schema": "dw", "name": "dim_country"},
                {"id": 202, "schema": "dw", "name": "dim_team"},
                {"id": 203, "schema": "dw", "name": "dim_rider"},
                {"id": 204, "schema": "dw", "name": "dim_stage"},
                {"id": 205, "schema": "dw", "name": "dim_date"},
                {"id": 206, "schema": "dw", "name": "fact_results"},
                {"id": 207, "schema": "dw", "name": "fact_participation"},
                {"id": 208, "schema": "dw", "name": "olap_rollup"},
            ]
            return 200, json.dumps({"id": 2, "tables": tables}).encode("utf-8")

        if path == "/api/dataset" and method == "POST":
            q = (payload or {}).get("native", {}).get("query", "")
            if "dim_team" in q:
                rows = pd.DEFAULT_LOOKUP_FIXTURES["team_keys"]
            elif "dim_rider" in q:
                rows = pd.DEFAULT_LOOKUP_FIXTURES["rider_keys"]
            elif "dim_stage" in q:
                rows = pd.DEFAULT_LOOKUP_FIXTURES["stage_ids"]
            elif "dim_country" in q:
                rows = pd.DEFAULT_LOOKUP_FIXTURES["country_code"]
            else:
                rows = []
            return 200, json.dumps({"status": "completed", "data": {"rows": rows}}).encode("utf-8")

        if path == "/api/collection" and method == "GET":
            return 200, json.dumps(list(self.collections.values())).encode("utf-8")

        if path == "/api/collection" and method == "POST":
            cid = self.next_collection_id
            self.next_collection_id += 1
            col = {"id": cid, "name": payload["name"], "description": payload.get("description"), "archived": False}
            self.collections[cid] = col
            return 200, json.dumps(col).encode("utf-8")

        m_col = re.match(r"^/api/collection/(\d+)$", path)
        if m_col and method == "GET":
            cid = int(m_col.group(1))
            if cid not in self.collections:
                return 404, b'{"error":"not found"}'
            return 200, json.dumps(self.collections[cid]).encode("utf-8")

        m_items = re.match(r"^/api/collection/(\d+)/items\?models=(card|dashboard)$", path)
        if m_items and method == "GET":
            cid = int(m_items.group(1))
            model = m_items.group(2)
            if model == "card":
                items = [
                    {"id": k, "name": v["name"], "model": "card"}
                    for k, v in self.cards.items()
                    if v.get("collection_id") == cid
                ]
            else:
                items = [
                    {"id": k, "name": v["name"], "model": "dashboard"}
                    for k, v in self.dashboards.items()
                    if v.get("collection_id") == cid
                ]
            return 200, json.dumps({"data": items}).encode("utf-8")

        if path == "/api/card" and method == "POST":
            card_id = self.next_card_id
            self.next_card_id += 1
            native_q = (payload or {}).get("dataset_query", {}).get("native", {}).get("query", "")
            rm = pd.build_default_result_metadata(native_q) if native_q else []
            card_obj = {"id": card_id, "result_metadata": rm, **payload}
            self.cards[card_id] = card_obj
            return 200, json.dumps(card_obj).encode("utf-8")

        m_card = re.match(r"^/api/card/(\d+)$", path)
        if m_card and method == "PUT":
            card_id = int(m_card.group(1))
            if card_id not in self.cards:
                return 404, b'{"error":"not found"}'
            native_q = (payload or {}).get("dataset_query", {}).get("native", {}).get("query", "")
            if native_q and not self.cards[card_id].get("result_metadata"):
                self.cards[card_id]["result_metadata"] = pd.build_default_result_metadata(native_q)
            self.cards[card_id].update(payload)
            return 200, json.dumps(self.cards[card_id]).encode("utf-8")

        m_query = re.match(r"^/api/card/(\d+)/query$", path)
        if m_query and method == "POST":
            card_id = int(m_query.group(1))
            if card_id not in self.cards:
                return 404, b'{"error":"not found"}'
            cols = self.cards[card_id].get("result_metadata") or []
            return (
                200,
                json.dumps({"status": "completed", "data": {"cols": cols, "rows": [[1], [2]]}}).encode("utf-8"),
            )

        if path == "/api/dashboard" and method == "POST":
            did = self.next_dashboard_id
            self.next_dashboard_id += 1
            dash = {
                "id": did,
                "name": payload["name"],
                "description": payload.get("description"),
                "collection_id": payload.get("collection_id"),
                "parameters": payload.get("parameters", []),
                "tabs": [],
                "dashcards": [],
            }
            self.dashboards[did] = dash
            return 200, json.dumps(dash).encode("utf-8")

        m_dash = re.match(r"^/api/dashboard/(\d+)$", path)
        if m_dash and method == "GET":
            did = int(m_dash.group(1))
            if did not in self.dashboards:
                return 404, b'{"error":"not found"}'
            return 200, json.dumps(self.dashboards[did]).encode("utf-8")

        if m_dash and method == "PUT":
            did = int(m_dash.group(1))
            if did not in self.dashboards:
                return 404, b'{"error":"not found"}'
            temp_to_real_tab: Dict[int, int] = {}
            real_tabs: List[Dict[str, Any]] = []
            for t in payload.get("tabs") or []:
                tid = int(t["id"])
                if tid < 0:
                    real_id = self.next_tab_id
                    self.next_tab_id += 1
                    temp_to_real_tab[tid] = real_id
                else:
                    real_id = tid
                    temp_to_real_tab[tid] = real_id
                real_tabs.append({"id": real_id, "name": t["name"], "position": t["position"]})

            real_dashcards: List[Dict[str, Any]] = []
            for dc in payload.get("dashcards") or []:
                dc_id = int(dc["id"])
                if dc_id < 0:
                    real_dc_id = self.next_dashcard_id
                    self.next_dashcard_id += 1
                else:
                    real_dc_id = dc_id
                raw_tab_id = dc.get("dashboard_tab_id")
                mapped_tab_id = temp_to_real_tab.get(raw_tab_id, raw_tab_id)
                real_dashcards.append({**dc, "id": real_dc_id, "dashboard_tab_id": mapped_tab_id})

            updated = {
                **self.dashboards[did],
                **payload,
                "id": did,
                "tabs": real_tabs,
                "dashcards": real_dashcards,
            }
            self.dashboards[did] = updated
            return 200, json.dumps(updated).encode("utf-8")

        return 404, json.dumps({"error": f"unhandled {method} {path}"}).encode("utf-8")


class DashboardProvisionerTest(unittest.TestCase):
    """Comprehensive offline test suite for Task 03 Metabase dashboard provisioning."""

    def test_write_schema_compliance_and_pivot_structure(self) -> None:
        """Verify generated card, collection, pivot, and dashboard payloads obey metabase-write-schemas.json."""
        write_schemas = json.loads(WRITE_SCHEMAS_PATH.read_text(encoding="utf-8"))
        api_summary = json.loads(API_SUMMARY_PATH.read_text(encoding="utf-8"))

        card_schema = write_schemas["/api/card"]
        allowed_card_keys = set(card_schema["properties"].keys())
        required_card_keys = set(card_schema["required"])

        dash_put_schema = write_schemas["/api/dashboard/{id}"]
        allowed_dash_put_keys = set(dash_put_schema["properties"].keys())
        tab_item_schema = dash_put_schema["properties"]["tabs"]["oneOf"][0]["items"]
        allowed_tab_keys = set(tab_item_schema["properties"].keys())
        required_tab_keys = set(tab_item_schema["required"])

        dc_item_schema = dash_put_schema["properties"]["dashcards"]["oneOf"][0]["items"]
        allowed_dc_keys = set(dc_item_schema["properties"].keys())
        required_dc_keys = set(dc_item_schema["required"])

        col_post_schema = api_summary["/api/collection"]["post"]
        allowed_col_keys = set(col_post_schema["properties"].keys())

        bundle = pd.build_dry_run_bundle()

        # 1. Collection payload
        col_payload = bundle["collection_post_payload"]
        self.assertTrue(set(col_payload.keys()).issubset(allowed_col_keys))
        self.assertEqual(col_payload["name"], "Project 3 OLAP")

        # 2. Card payloads (33 visible dashboard cards + 1 hidden pivot source question = 34 total)
        self.assertEqual(len(pd.DASHBOARD_CARD_SPECS), 33)
        self.assertEqual(len(bundle["cards"]), 34)

        by_slug = {c["slug"]: c for c in bundle["cards"]}
        src_entry = by_slug["insight_rider_specialisation_pivot_source"]
        pivot_entry = by_slug["insight_rider_specialisation_pivot"]
        self.assertFalse(src_entry["on_dashboard"])
        self.assertTrue(pivot_entry["on_dashboard"])

        for card_entry in bundle["cards"]:
            payload = card_entry["payload"]
            self.assertTrue(required_card_keys.issubset(payload.keys()))
            self.assertTrue(set(payload.keys()).issubset(allowed_card_keys))
            dq = payload["dataset_query"]
            self.assertEqual(dq["database"], 2)
            if card_entry["query_kind"] == "pivot_mbql":
                self.assertEqual(payload["display"], "pivot")
                self.assertEqual(dq["type"], "query")
                self.assertEqual(
                    dq["query"]["source-table"],
                    f"card__{src_entry['card_id_preview']}",
                )
                self.assertEqual(
                    dq["query"]["aggregation"],
                    [
                        ["avg", ["field", "rank_percentile", {"base-type": "type/Decimal"}]],
                        ["count"],
                    ],
                )
                self.assertEqual(
                    dq["query"]["breakout"],
                    [
                        ["field", "rider_label", {"base-type": "type/Text"}],
                        ["field", "stage_type", {"base-type": "type/Text"}],
                    ],
                )
                self.assertIn("pivot_table.column_split", payload["visualization_settings"])
            else:
                self.assertEqual(dq["type"], "native")
                self.assertIn("query", dq["native"])
                self.assertIn("template-tags", dq["native"])

        # 3. Dashboard PUT payload
        dash_put = bundle["dashboard_put_payload"]
        self.assertTrue(set(dash_put.keys()).issubset(allowed_dash_put_keys))
        self.assertEqual(dash_put["name"], "Tour de France 2025 OLAP Analytics")
        self.assertEqual(dash_put["width"], "full")

        for tab in dash_put["tabs"]:
            self.assertTrue(required_tab_keys.issubset(tab.keys()))
            self.assertTrue(set(tab.keys()).issubset(allowed_tab_keys))

        for dc in dash_put["dashcards"]:
            self.assertTrue(required_dc_keys.issubset(dc.keys()))
            self.assertTrue(set(dc.keys()).issubset(allowed_dc_keys))
            self.assertGreaterEqual(dc["size_x"], 1)
            self.assertGreaterEqual(dc["size_y"], 1)
            self.assertGreaterEqual(dc["row"], 0)
            self.assertGreaterEqual(dc["col"], 0)

    def test_no_jdbc_question_mark_operator_regression(self) -> None:
        """Ensure native SQL never uses the '?' JSONB operator that JDBC mistakes for a bind parameter."""
        for spec in pd.CARD_SPECS:
            if spec.query_kind == "native":
                self.assertNotIn(
                    "?",
                    spec.sql_query,
                    f"Native SQL card {spec.slug} contains '?' which breaks JDBC prepared statements",
                )

        for slug in (
            "class_multi_rider_percentiles_bar",
            "perf_rider_stage_trajectory_line",
            "insight_rider_specialisation_detail_bar",
        ):
            spec = next(s for s in pd.CARD_SPECS if s.slug == slug)
            self.assertIn("jsonb_exists(f, 'rider_keys')", spec.sql_query)
            self.assertIn("jsonb_exists(f, 'team_keys')", spec.sql_query)

    def test_ui_short_titles_single_axis_units_and_selector_labels(self) -> None:
        """Verify shortened card titles, single-unit chart axes, and human-friendly selector definitions."""
        expected_titles = {
            "overview_kpi_summary": "Race at a Glance",
            "overview_terrain_distance_bar": "Distance by Stage Terrain",
            "overview_stage_finisher_trend_line": "Stage Finisher Trend",
            "overview_stage_summary_table": "Stage Routes",
            "overview_stage_rider_results_table": "Stage Rider Results",
            "class_gc_table": "Time Standings · Active Scope",
            "class_young_table": "Young Rider Time · Active Scope",
            "class_points_proxy_table": "Points — Proxy",
            "class_kom_proxy_table": "KOM — Proxy",
            "perf_team_stage_top3_table": "Team Standings · Per-stage Top 3",
            "perf_team_cumulative_top3_table": "Team Standings · Cumulative Top 3",
            "perf_rider_stage_detail_table": "Rider Stage Results",
            "insight_rider_specialisation_crosstab_table": "Rider Terrain Specialisation · Cross-Tab",
            "insight_rider_specialisation_pivot": "Rider Terrain Specialisation · Pivot (Full Race)",
        }
        by_slug = {s.slug: s for s in pd.CARD_SPECS}
        for slug, title in expected_titles.items():
            self.assertEqual(by_slug[slug].name, title)

        # Ensure hardcoded dataset counts were removed from card titles
        for spec in pd.CARD_SPECS:
            for count_str in ("184", "160", "23", "2000-01-01"):
                self.assertNotIn(count_str, spec.name, f"Hardcoded count {count_str} in title of {spec.slug}")

        # Verify single unit per axis on bar/line charts
        self.assertEqual(
            by_slug["overview_terrain_distance_bar"].visualization_settings["graph.metrics"],
            ["total_distance_km"],
        )
        self.assertEqual(
            by_slug["overview_stage_finisher_trend_line"].visualization_settings["graph.metrics"],
            ["finisher_count"],
        )
        self.assertEqual(
            by_slug["insight_team_depth_bar"].visualization_settings["graph.metrics"],
            ["top10_stage_coverage_pct"],
        )

        # Verify selector labels, defaults, and lookup dropdown values
        params = {p["slug"]: p for p in pd.build_dashboard_parameters()}
        self.assertEqual(params["team_keys"]["name"], "Team")
        self.assertEqual(params["rider_keys"]["name"], "Rider")
        self.assertEqual(params["country_code"]["name"], "Country")
        self.assertEqual(params["young_only"]["name"], "Young Rider")

        self.assertEqual(params["stage_scope"]["default"], "final")
        self.assertEqual(params["as_of_stage"]["default"], 21)
        self.assertEqual(params["time_basis"]["default"], "adjusted")
        self.assertEqual(params["rank_scope"]["default"], "overall")

        for lookup_key in ("team_keys", "rider_keys", "stage_ids", "as_of_stage", "country_code"):
            self.assertEqual(params[lookup_key]["values_source_type"], "static-list")
            vals = params[lookup_key]["values_source_config"]["values"]
            self.assertGreater(len(vals), 0)
            if lookup_key != "country_code":
                self.assertIsInstance(vals[0][0], int)
                self.assertIsInstance(vals[0][1], str)

    def test_tabs_display_mix_and_proxy_notices(self) -> None:
        """Verify all 5 required tabs, chart display mix (including pivot), side-by-side team tables, and proxy labels."""
        tab_names = [t.name for t in pd.TAB_SPECS]
        self.assertEqual(
            tab_names,
            [
                "Executive & Race Overview",
                "Classifications Comparison",
                "Rider & Team Performance",
                "Country Participation",
                "Deep-Dive Insights",
            ],
        )

        displays = {spec.display for spec in pd.DASHBOARD_CARD_SPECS}
        self.assertEqual(displays, {"table", "bar", "line", "pivot"})

        points_card = next(s for s in pd.CARD_SPECS if s.slug == "class_points_proxy_table")
        kom_card = next(s for s in pd.CARD_SPECS if s.slug == "class_kom_proxy_table")
        self.assertIn("nonofficial", points_card.description.lower())
        self.assertIn("source-derived", points_card.description.lower())
        self.assertIn("nonofficial", kom_card.description.lower())
        self.assertIn("source-derived", kom_card.description.lower())

        stage_top3 = next(s for s in pd.CARD_SPECS if s.slug == "perf_team_stage_top3_table")
        cum_top3 = next(s for s in pd.CARD_SPECS if s.slug == "perf_team_cumulative_top3_table")
        self.assertEqual(stage_top3.row, cum_top3.row)
        self.assertEqual(stage_top3.col, 0)
        self.assertEqual(cum_top3.col, 12)

    def test_template_tags_parameter_mappings_and_filter_jsonb(self) -> None:
        """Verify template tags, parameter mappings, and reusable JSONB filter SQL fragment."""
        bundle = pd.build_dry_run_bundle()
        dash_param_ids = {p["id"] for p in bundle["dashboard_put_payload"]["parameters"]}

        tag_pattern = re.compile(r"\{\{([a-z_]+)\}\}")
        for spec in pd.CARD_SPECS:
            if spec.query_kind != "native":
                self.assertEqual(spec.filter_keys, ())
                continue
            card_payload = pd.build_card_payload(spec, collection_id=6)
            query = card_payload["dataset_query"]["native"]["query"]
            tags_dict = card_payload["dataset_query"]["native"]["template-tags"]

            referenced_tags = set(tag_pattern.findall(query))
            self.assertEqual(
                referenced_tags,
                set(tags_dict.keys()),
                f"Template tag mismatch in card {spec.slug}",
            )
            self.assertEqual(set(spec.filter_keys), set(tags_dict.keys()))

            mappings = pd.build_parameter_mappings(card_id=1001, filter_keys=spec.filter_keys)
            self.assertEqual(len(mappings), len(spec.filter_keys))
            for m in mappings:
                self.assertIn(m["parameter_id"], dash_param_ids)
                self.assertEqual(m["target"][0], "variable")
                self.assertEqual(m["target"][1][0], "template-tag")
                self.assertIn(m["target"][1][1], tags_dict)

            if spec.tab_slug == "tab_classifications":
                self.assertNotIn("RANK() OVER", query.upper())
                self.assertNotIn("ROW_NUMBER() OVER", query.upper())

        frag = pd.build_filter_jsonb_sql(pd.ALL_COMMON_FILTER_KEYS, {"classification": "gc"})
        self.assertTrue(frag.startswith("jsonb_strip_nulls(jsonb_build_object("))
        for array_key in ("stage_ids", "team_keys", "rider_keys"):
            self.assertIn(
                f"'{array_key}', COALESCE(NULL::jsonb [[ , to_jsonb(ARRAY[{{{{{array_key}}}}}]::integer[]) ]])",
                frag,
            )

    def test_analytical_reading_order_and_report_grains(self) -> None:
        cards = {c.slug: c for c in pd.DASHBOARD_CARD_SPECS}
        depth = cards["insight_team_depth_table"]
        burden = cards["perf_team_member_contributions"]
        self.assertEqual((depth.tab_slug, depth.row), ("tab_performance", 0))
        self.assertLess(depth.row, burden.row)
        self.assertLess(burden.row, cards["perf_team_stage_top3_table"].row)
        self.assertIn("rider_burden_seconds", burden.sql_query)
        self.assertIn("PARTITION BY", burden.sql_query)
        self.assertIn("adjusted", burden.description.lower())
        self.assertIn("mountain_gc_rank", cards["class_gc_table"].sql_query)
        self.assertIn("best_gc_riders", cards["country_full_universe_table"].sql_query)
        self.assertIn("stage_types", cards["country_full_universe_table"].filter_keys)
        self.assertIn("podium_count", cards["insight_terrain_speed"].sql_query)
        self.assertIn("winning_margin", cards["insight_time_rules"].sql_query)
        # A moved pre-existing card must keep a unique, unobstructed place on its destination tab.
        for i, card in enumerate(pd.DASHBOARD_CARD_SPECS):
            for other in pd.DASHBOARD_CARD_SPECS[i+1:]:
                if card.tab_slug == other.tab_slug:
                    self.assertFalse(card.row < other.row + other.size_y and other.row < card.row + card.size_y
                        and card.col < other.col + other.size_x and other.col < card.col + card.size_x,
                        f"Overlapping cards: {card.slug} and {other.slug}")

    def test_shared_sql_function_and_view_references(self) -> None:
        """Verify all 8 dw table functions and dw.olap_rollup view are referenced and exist in 003_analytics.sql."""
        expected_objects = {
            "dw.rider_standings",
            "dw.team_standings",
            "dw.rider_stage_results",
            "dw.stage_summary",
            "dw.country_participation",
            "dw.rider_specialisation",
            "dw.team_depth",
            "dw.gc_evolution",
            "dw.olap_rollup", "dw.gc_comparison", "dw.gc_time_rules",
            "dw.team_roster_performance", "dw.terrain_performance", "dw.country_outcomes",
        }
        used_objects = set()
        for spec in pd.CARD_SPECS:
            for fn in spec.sql_functions_used:
                self.assertIn(fn, spec.sql_query, f"{spec.slug} claims {fn} but does not call it in SQL")
                used_objects.add(fn)
        self.assertEqual(used_objects, expected_objects)

        if ANALYTICS_SQL_PATH.exists():
            sql_text = "\n".join(p.read_text(encoding="utf-8") for p in sorted(
                ANALYTICS_SQL_PATH.parent.glob("0*.sql")))
            for obj in expected_objects:
                self.assertIn(obj, sql_text, f"Missing {obj} in sql/003_analytics.sql")

    def test_click_behaviors_and_noop_distinction(self) -> None:
        """Verify interactive drill-down cards configure crossfilter click_behavior and summary/pivot cards are no-op."""
        noop_slugs = {s.slug for s in pd.DASHBOARD_CARD_SPECS if s.click_action is None}
        self.assertEqual(
            noop_slugs,
            {
                "overview_kpi_summary",
                "country_overview_kpi_table",
                "insight_olap_rollup_table",
                "insight_rider_specialisation_pivot",
            },
        )

    def test_portal_destinations_preserve_filters_and_source_ids(self) -> None:
        """Catch dead-end crossfilters, dropped multi-value context, or links using display labels as keys."""
        by_slug = {s.slug: s for s in pd.CARD_SPECS}
        cases = [
            ("overview_stage_summary_table", "stage_id", "stage", "stage_id", "{{column:stage_id}}"),
            ("class_gc_table", "rider_name", "rider", "rider_key", "{{column:rider_key}}"),
            ("perf_team_stage_top3_table", "team_name", "team", "team_key", "{{column:team_key}}"),
            ("country_full_universe_table", "country_name", "country", "country_code", "{{column:country_code}}"),
        ]
        for slug, col, drill, key, value in cases:
            vis = pd.build_dashcard_visualization_settings(by_slug[slug])
            cb = vis["column_settings"][json.dumps(["name", col], separators=(",", ":"))]["click_behavior"]
            self.assertEqual((cb.get("type"), cb.get("linkType")), ("link", "url"))
            uri = urlparse(cb["linkTemplate"])
            self.assertEqual(uri.netloc, "127.0.0.1:8000")
            params = parse_qs(uri.query)
            self.assertEqual(params["drill"], [drill])
            self.assertEqual(params[key], [value])
            self.assertEqual(params["stage_scope"], ["{{filter:Stage Scope}}"])
            self.assertEqual(params["stage_ids"], ["{{filter:Stage}}"])
            self.assertEqual(params["team_keys"], ["{{filter:Team}}"])
            self.assertEqual(params["rider_keys"], ["{{filter:Rider}}"])
            self.assertEqual(params["time_basis"], ["{{filter:Time Basis}}"])
            self.assertNotIn("click_behavior", vis)  # numeric cells are not generic links
        terrain = pd.build_dashcard_visualization_settings(by_slug["overview_terrain_distance_bar"])
        params = parse_qs(urlparse(terrain["click_behavior"]["linkTemplate"]).query)
        self.assertEqual(params["module"], ["stage_summary"])
        self.assertEqual(params["stage_scope"], ["selection"])
        self.assertEqual(params["stage_types"], ["{{column:stage_type}}"])
        self.assertNotIn("stage_ids", params)  # explicit clicked terrain replaces incompatible stage slice
        member = pd.build_dashcard_visualization_settings(by_slug["country_rider_team_detail_table"])
        team_link = member["column_settings"]['["name","team_name"]']["click_behavior"]["linkTemplate"]
        self.assertIn("drill=team&team_key={{column:team_key}}", team_link)

    def test_team_comparison_link_carries_clicked_method(self) -> None:
        spec = next(s for s in pd.CARD_SPECS if s.slug == "perf_team_methods_comparison_bar")
        link = pd.build_dashcard_visualization_settings(spec)["click_behavior"]["linkTemplate"]
        params = parse_qs(urlparse(link).query)
        self.assertEqual(params.get("team_aggregation"), ["{{column:aggregation_method}}"])

    def test_contextual_finisher_labels_and_configurable_portal_base(self) -> None:
        """Catch race finishers being mislabeled as stage finishers and config not reaching real payloads."""
        by_slug = {s.slug: s for s in pd.CARD_SPECS}
        for slug, label in [("country_full_universe_table", "Race Finishers"),
                            ("country_rider_nationality_bar", "Race Finishers"),
                            ("overview_stage_summary_table", "Stage Finishers")]:
            vis = pd.build_dashcard_visualization_settings(by_slug[slug])
            self.assertEqual(vis["column_settings"]['["name","finisher_count"]']["column_title"], label)
        bundle = pd.build_dry_run_bundle(portal_base_url="http://localhost:9000/")
        templates = json.dumps(bundle["dashboard_put_payload"])
        self.assertIn("http://localhost:9000/?drill=", templates)
        self.assertNotIn("http://127.0.0.1:8000/", templates)
        for invalid in ["javascript:alert(1)", "http://user:secret@localhost:8000", "http://localhost:8000/?token=secret"]:
            with self.assertRaises(ValueError):
                pd.build_dry_run_bundle(portal_base_url=invalid)

    def test_metadata_informed_table_formatting_and_merged_column_settings(self) -> None:
        """Verify table.columns hides *_key columns, column_title includes units, and column_settings merges click_behavior."""
        # 1. Realistic result_metadata fixture for General Classification (card 46)
        gc_spec = next(s for s in pd.CARD_SPECS if s.slug == "class_gc_table")
        gc_metadata_fixture = [
            {"name": "rank", "base_type": "type/Integer", "field_ref": ["field", "rank", {"base-type": "type/Integer"}]},
            {"name": "bib_number", "base_type": "type/Integer", "field_ref": ["field", "bib_number", {"base-type": "type/Integer"}]},
            {"name": "rider_key", "base_type": "type/Integer", "field_ref": ["field", "rider_key", {"base-type": "type/Integer"}]},
            {"name": "rider_name", "base_type": "type/Text", "field_ref": ["field", "rider_name", {"base-type": "type/Text"}]},
            {"name": "team_key", "base_type": "type/Integer", "field_ref": ["field", "team_key", {"base-type": "type/Integer"}]},
            {"name": "team_name", "base_type": "type/Text", "field_ref": ["field", "team_name", {"base-type": "type/Text"}]},
            {"name": "is_young_rider", "base_type": "type/Boolean", "field_ref": ["field", "is_young_rider", {"base-type": "type/Boolean"}]},
            {"name": "total_seconds", "base_type": "type/Integer", "field_ref": ["field", "total_seconds", {"base-type": "type/Integer"}]},
            {"name": "gap_seconds", "base_type": "type/Integer", "field_ref": ["field", "gap_seconds", {"base-type": "type/Integer"}]},
            {"name": "rank_percentile", "base_type": "type/Decimal", "field_ref": ["field", "rank_percentile", {"base-type": "type/Decimal"}]},
            {"name": "stage_wins", "base_type": "type/Integer", "field_ref": ["field", "stage_wins", {"base-type": "type/Integer"}]},
            {"name": "podium_finishes", "base_type": "type/Integer", "field_ref": ["field", "podium_finishes", {"base-type": "type/Integer"}]},
            {"name": "top10_finishes", "base_type": "type/Integer", "field_ref": ["field", "top10_finishes", {"base-type": "type/Integer"}]},
            {"name": "stage_count", "base_type": "type/Integer", "field_ref": ["field", "stage_count", {"base-type": "type/Integer"}]},
            {"name": "time_basis", "base_type": "type/Text", "field_ref": ["field", "time_basis", {"base-type": "type/Text"}]},
        ]

        gc_dash_vis = pd.build_dashcard_visualization_settings(gc_spec, result_metadata=gc_metadata_fixture)
        table_cols_by_name = {c["name"]: c for c in gc_dash_vis["table.columns"]}

        # Surrogate *_key columns are disabled (hidden) in table.columns but still present for crossfiltering
        self.assertFalse(table_cols_by_name["rider_key"]["enabled"])
        self.assertFalse(table_cols_by_name["team_key"]["enabled"])
        # Official bib_number and human-readable columns remain enabled
        self.assertTrue(table_cols_by_name["bib_number"]["enabled"])
        self.assertTrue(table_cols_by_name["rider_name"]["enabled"])
        self.assertTrue(table_cols_by_name["team_name"]["enabled"])
        self.assertTrue(table_cols_by_name["total_seconds"]["enabled"])

        # Verify column_settings has readable titles with explicit units AND merged click_behavior
        col_settings = gc_dash_vis["column_settings"]
        bib_key = '["name","bib_number"]'
        rider_name_key = '["name","rider_name"]'
        total_sec_key = '["name","total_seconds"]'
        gap_sec_key = '["name","gap_seconds"]'
        pct_key = '["name","rank_percentile"]'

        self.assertEqual(col_settings[bib_key]["column_title"], "Bib #")
        self.assertEqual(col_settings[rider_name_key]["column_title"], "Rider")
        self.assertEqual(col_settings[total_sec_key]["column_title"], "Total Time (seconds)")
        self.assertEqual(col_settings[gap_sec_key]["column_title"], "Gap to Leader (seconds)")
        self.assertEqual(col_settings[pct_key]["column_title"], "Rank Percentile (%)")

        # Both column_title and click_behavior coexist in the same column_settings entry
        for clickable_key in (bib_key, rider_name_key):
            self.assertIn("column_title", col_settings[clickable_key])
            self.assertIn("click_behavior", col_settings[clickable_key])
            cb = col_settings[clickable_key]["click_behavior"]
            self.assertEqual(cb["type"], "link")
            self.assertEqual(cb["linkType"], "url")
            self.assertIn("rider_key={{column:rider_key}}", cb["linkTemplate"])

        # 2. Check all native table cards across all 5 tabs
        for spec in pd.CARD_SPECS:
            if spec.display == "table" and spec.query_kind == "native":
                vis = pd.build_dashcard_visualization_settings(spec)
                t_cols = vis.get("table.columns", [])
                self.assertGreater(len(t_cols), 0, f"Missing table.columns in {spec.slug}")
                c_settings = vis.get("column_settings", {})
                for col_entry in t_cols:
                    cname = col_entry["name"]
                    if cname.endswith("_key"):
                        self.assertFalse(
                            col_entry["enabled"],
                            f"Surrogate key {cname} should be disabled in {spec.slug}",
                        )
                    else:
                        self.assertTrue(
                            col_entry["enabled"],
                            f"Visible column {cname} should be enabled in {spec.slug}",
                        )
                    ckey = json.dumps(["name", cname], separators=(",", ":"))
                    self.assertIn(ckey, c_settings, f"Missing column_settings entry for {cname} in {spec.slug}")
                    title = c_settings[ckey].get("column_title", "")
                    self.assertTrue(title, f"Empty column_title for {cname} in {spec.slug}")
                    self.assertNotIn("_", title, f"Unformatted snake_case column_title '{title}' in {spec.slug}")

                if spec.click_action is not None:
                    click_cols = spec.click_action.clickable_columns or (spec.click_action.source_column,)
                    for ccol in click_cols:
                        ckey = json.dumps(["name", ccol], separators=(",", ":"))
                        self.assertIn("column_title", c_settings[ckey])
                        self.assertIn("click_behavior", c_settings[ckey])

        # 3. Verify captions and card descriptions use plain English without dw.* or snake_case identifiers
        for cap in pd.CAPTION_SPECS:
            self.assertNotIn("dw.", cap.markdown_text)
            self.assertNotRegex(cap.markdown_text, r"\b[a-z]+_[a-z]+\b")

        for spec in pd.CARD_SPECS:
            self.assertNotIn("dw.", spec.description, f"Card {spec.slug} description leaks dw.* object name")
            self.assertNotRegex(
                spec.description,
                r"\b[a-z]+_[a-z]+\b",
                f"Card {spec.slug} description contains snake_case identifier: {spec.description}",
            )

    def test_fresh_install_ids_are_not_legacy_protected_objects(self):
        server = FakeMetabaseServer()
        server.collections.clear(); server.dashboards.clear(); server.cards.clear()
        server.next_collection_id = 5
        server.next_dashboard_id = 2
        server.next_card_id = 40
        client = pd.MetabaseClient(base_url="http://127.0.0.1:3000",
            auth=pd.AuthConfig(username="test@example.invalid", password="test-only"),
            transport=server.transport)
        with tempfile.TemporaryDirectory() as tmpdir:
            provisioner = pd.DashboardProvisioner(client, database_id=2,
                state_path=Path(tmpdir)/"state.json", protected_ids={})
            first = provisioner.provision()
            second = provisioner.provision()
            self.assertEqual(first['dashboard_id'], 2)
            self.assertEqual(first['collection_id'], 5)
            self.assertEqual(first['card_count'], 34)
            self.assertEqual(first, second)

    def test_idempotent_upgrade_preserves_deployed_state_and_embedding(self) -> None:
        """Verify rerunning and upgrading from build/metabase-state.json preserves IDs 41..71 and dashboard 3 embedding."""
        self.assertTrue(DEPLOYED_STATE_PATH.exists(), "Expected frozen tests/fixtures/metabase-state.json to exist")
        deployed_state = json.loads(DEPLOYED_STATE_PATH.read_text(encoding="utf-8"))

        # Case A: Rerun against full deployed 31-card state (cards 41..71, tabs 4..8, dashcards 38..69)
        server = FakeMetabaseServer()
        server.seed_from_state(deployed_state, enable_embedding=True)
        auth = pd.AuthConfig(username="admin@example.com", password="secret-password")
        client = pd.MetabaseClient(base_url="http://127.0.0.1:3000", auth=auth, transport=server.transport)

        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "metabase-state.json"
            state_path.write_text(json.dumps(deployed_state), encoding="utf-8")
            provisioner = pd.DashboardProvisioner(client=client, database_id=2, state_path=state_path)

            res1 = provisioner.provision()
            self.assertEqual(res1["collection_id"], 6)
            self.assertEqual(res1["dashboard_id"], 3)
            self.assertEqual(res1["card_count"], 34)
            self.assertEqual(res1["dashcard_count"], 35)  # 2 captions + 33 dashboard cards

            post_creates = [
                c for c in server.calls
                if c[0] == "POST" and c[1] in ("/api/collection", "/api/card", "/api/dashboard")
            ]
            self.assertEqual([c[1] for c in post_creates], ["/api/card"] * 3)

            updated_state = json.loads(state_path.read_text(encoding="utf-8"))
            for key, value in deployed_state["cards"].items():
                self.assertEqual(updated_state["cards"][key], value)
            self.assertEqual(updated_state["tabs"], deployed_state["tabs"])
            for key, value in deployed_state["dashcards"].items():
                self.assertEqual(updated_state["dashcards"][key], value)
            server.calls.clear()
            self.assertEqual(provisioner.provision(), res1)
            self.assertFalse(any(call[0] == "POST" and call[1] in
                ("/api/card", "/api/collection", "/api/dashboard") for call in server.calls))
            self.assertEqual(json.loads(state_path.read_text()), updated_state)

            # Verify live card 46 and dashcard 44 have table.columns and merged column_settings
            card_46_vis = server.cards[46]["visualization_settings"]
            self.assertIn("table.columns", card_46_vis)
            self.assertIn("column_settings", card_46_vis)
            dashcard_44 = next(dc for dc in server.dashboards[3]["dashcards"] if dc["id"] == 44)
            dc_44_col_settings = dashcard_44["visualization_settings"]["column_settings"]
            self.assertIn("column_title", dc_44_col_settings['["name","rider_name"]'])
            self.assertIn("click_behavior", dc_44_col_settings['["name","rider_name"]'])

            # Verify embedding settings on dashboard 3 were preserved during PUT /api/dashboard/3
            self.assertTrue(server.dashboards[3]["enable_embedding"])
            self.assertEqual(
                server.dashboards[3]["embedding_params"],
                {"stage_scope": "enabled", "team_keys": "enabled"},
            )

        # Case B: Upgrade from 29-card pre-pivot state (cards 41..69) creates only the 2 pivot cards
        pre_pivot_state = {
            **deployed_state,
            "cards": {
                k: v
                for k, v in deployed_state["cards"].items()
                if k not in ("insight_rider_specialisation_pivot_source", "insight_rider_specialisation_pivot")
            },
            "dashcards": {
                k: v
                for k, v in deployed_state["dashcards"].items()
                if k != "insight_rider_specialisation_pivot"
            },
        }
        server2 = FakeMetabaseServer()
        server2.seed_from_state(pre_pivot_state, enable_embedding=True)
        client2 = pd.MetabaseClient(base_url="http://127.0.0.1:3000", auth=auth, transport=server2.transport)
        with tempfile.TemporaryDirectory() as tmpdir2:
            state_path2 = Path(tmpdir2) / "metabase-state.json"
            state_path2.write_text(json.dumps(pre_pivot_state), encoding="utf-8")
            provisioner2 = pd.DashboardProvisioner(client=client2, database_id=2, state_path=state_path2)
            res_upgrade = provisioner2.provision()
            self.assertEqual(res_upgrade["card_count"], 34)
            post_cards_upgrade = [c for c in server2.calls if c[0] == "POST" and c[1] == "/api/card"]
            self.assertEqual(len(post_cards_upgrade), 5)

    def test_credentials_resolution_and_redaction(self) -> None:
        """Verify credential parsing from JSON/.env/token files and strict redaction."""
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / "creds.env"
            env_file.write_text(
                "MB_ADMIN_EMAIL='admin@tdf.local'\nMB_ADMIN_PASSWORD=\"super-secret\"\n",
                encoding="utf-8",
            )
            cfg = pd.resolve_credentials(credentials_file=env_file, environ={})
            self.assertEqual(cfg.username, "admin@tdf.local")
            self.assertEqual(cfg.password, "super-secret")
            self.assertEqual(repr(cfg), "AuthConfig(<redacted>)")


if __name__ == "__main__":
    unittest.main()
