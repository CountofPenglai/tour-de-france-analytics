"""Unit tests for scripts/benchmark.py covering result equality/NULL normalization,
top-plan buffer extraction (no parent-child double counting), and pair alternation.
"""

from __future__ import annotations

from decimal import Decimal
import unittest

from scripts.benchmark import (
    BENCHMARK_PAIRS,
    BenchmarkInequalityError,
    build_alternating_schedule,
    compare_query_results,
    compute_sql_text_complexity,
    extract_plan_metrics,
)


class TestBenchmarkRunner(unittest.TestCase):
    """Focused behavioral tests for Project 4 benchmark utilities."""

    def test_equality_and_null_decimal_normalization(self) -> None:
        """Identical rows with SQL NULL and equivalent Decimals pass; leaked 'UNK' or string 'NULL' fails."""
        columns = [
            "bib_number",
            "rider_name",
            "rider_country_name",
            "total_seconds",
            "avg_speed_kmh",
        ]
        normalized_rows = [
            (1, "Tadej Pogacar", "Slovenia", 277349, Decimal("41.2500")),
            (78, "Aleksandr Vlasov", None, 285524, Decimal("40.1000")),
        ]
        star_rows_matching = [
            (1, "Tadej Pogacar", "Slovenia", 277349, Decimal("41.25")),
            (78, "Aleksandr Vlasov", None, 285524, Decimal("40.1")),
        ]

        res = compare_query_results(
            columns,
            normalized_rows,
            columns,
            star_rows_matching,
            pair_id="q1_gc_final",
        )
        self.assertTrue(res["passed"])
        self.assertEqual(res["row_count"], 2)
        self.assertEqual(res["normalized_result_sha256"], res["star_result_sha256"])

        # If dw fails to map 'UNK' / 'Unknown / Unspecified' to SQL NULL, equality check must fail
        star_rows_leaked_unk = [
            (1, "Tadej Pogacar", "Slovenia", 277349, Decimal("41.25")),
            (78, "Aleksandr Vlasov", "Unknown / Unspecified", 285524, Decimal("40.1")),
        ]
        with self.assertRaises(BenchmarkInequalityError):
            compare_query_results(
                columns,
                normalized_rows,
                columns,
                star_rows_leaked_unk,
                pair_id="q1_gc_final",
            )

        # Literal string 'NULL' must not match SQL NULL (None)
        star_rows_string_null = [
            (1, "Tadej Pogacar", "Slovenia", 277349, Decimal("41.25")),
            (78, "Aleksandr Vlasov", "NULL", 285524, Decimal("40.1")),
        ]
        with self.assertRaises(BenchmarkInequalityError):
            compare_query_results(
                columns,
                normalized_rows,
                columns,
                star_rows_string_null,
                pair_id="q1_gc_final",
            )

    def test_plan_metrics_no_buffer_double_count_and_join_depth(self) -> None:
        """Buffer blocks are read from top Plan only, while join counts and depth traverse the tree."""
        sample_explain_json = [
            {
                "Plan": {
                    "Node Type": "Sort",
                    "Shared Hit Blocks": 140,
                    "Shared Read Blocks": 4,
                    "Shared Dirtied Blocks": 0,
                    "Shared Written Blocks": 0,
                    "Temp Read Blocks": 2,
                    "Temp Written Blocks": 2,
                    "Plans": [
                        {
                            "Node Type": "Aggregate",
                            "Shared Hit Blocks": 132,
                            "Shared Read Blocks": 4,
                            "Plans": [
                                {
                                    "Node Type": "Hash Join",
                                    "Shared Hit Blocks": 120,
                                    "Shared Read Blocks": 3,
                                    "Plans": [
                                        {
                                            "Node Type": "Merge Join",
                                            "Shared Hit Blocks": 80,
                                            "Shared Read Blocks": 2,
                                            "Plans": [
                                                {
                                                    "Node Type": "Nested Loop",
                                                    "Shared Hit Blocks": 45,
                                                    "Shared Read Blocks": 1,
                                                    "Plans": [
                                                        {
                                                            "Node Type": "Seq Scan",
                                                            "Shared Hit Blocks": 30,
                                                            "Shared Read Blocks": 1,
                                                        },
                                                        {
                                                            "Node Type": "Index Scan",
                                                            "Shared Hit Blocks": 15,
                                                            "Shared Read Blocks": 0,
                                                        },
                                                    ],
                                                },
                                                {
                                                    "Node Type": "Sort",
                                                    "Shared Hit Blocks": 35,
                                                    "Shared Read Blocks": 1,
                                                },
                                            ],
                                        },
                                        {
                                            "Node Type": "Hash",
                                            "Shared Hit Blocks": 40,
                                            "Shared Read Blocks": 1,
                                        },
                                    ],
                                }
                            ],
                        }
                    ],
                },
                "Planning Time": 0.425,
                "Execution Time": 1.875,
            }
        ]

        metrics = extract_plan_metrics(sample_explain_json)

        # Top Plan has 140 hit blocks and 4 read blocks; summing children would erroneously yield >500
        self.assertEqual(metrics["shared_hit_blocks"], 140)
        self.assertEqual(metrics["shared_read_blocks"], 4)
        self.assertEqual(metrics["temp_read_blocks"], 2)
        self.assertEqual(metrics["temp_written_blocks"], 2)

        # Tree depth: Sort (1) -> Aggregate (2) -> Hash Join (3) -> Merge Join (4) -> Nested Loop (5) -> Seq Scan (6)
        self.assertEqual(metrics["plan_max_depth"], 6)
        self.assertEqual(metrics["hash_join_count"], 1)
        self.assertEqual(metrics["merge_join_count"], 1)
        self.assertEqual(metrics["nested_loop_count"], 1)
        self.assertEqual(metrics["total_join_operators"], 3)
        self.assertAlmostEqual(metrics["planning_time_ms"], 0.425)
        self.assertAlmostEqual(metrics["execution_time_ms"], 1.875)

    def test_warmup_and_alternating_pair_schedule(self) -> None:
        """Schedule warms up each variant once and alternates normalized/star across all 7 repeats."""
        schedule = build_alternating_schedule(repeats=7)

        warmups = [step for step in schedule if step["phase"] == "warmup"]
        measured = [step for step in schedule if step["phase"] == "measured"]

        self.assertEqual([w["variant"] for w in warmups], ["normalized", "star"])
        self.assertEqual(len(measured), 14)

        measured_variants = [m["variant"] for m in measured]
        self.assertEqual(measured_variants.count("normalized"), 7)
        self.assertEqual(measured_variants.count("star"), 7)

        for idx in range(len(measured_variants) - 1):
            self.assertNotEqual(
                measured_variants[idx],
                measured_variants[idx + 1],
                f"Variants did not alternate at measured index {idx}: {measured_variants}",
            )

    def test_owned_sql_files_and_text_complexity(self) -> None:
        """All 3 benchmark SQL pairs exist and simple text complexity ignores comments."""
        self.assertEqual(len(BENCHMARK_PAIRS), 3)
        for spec in BENCHMARK_PAIRS:
            self.assertTrue(spec.normalized_sql_path.is_file(), f"Missing {spec.normalized_sql_path}")
            self.assertTrue(spec.star_sql_path.is_file(), f"Missing {spec.star_sql_path}")

        q3_spec = next(spec for spec in BENCHMARK_PAIRS if spec.pair_id == "q3_terrain_route")
        q3_norm_complexity = compute_sql_text_complexity(
            q3_spec.normalized_sql_path.read_text(encoding="utf-8")
        )
        q3_star_complexity = compute_sql_text_complexity(
            q3_spec.star_sql_path.read_text(encoding="utf-8")
        )

        # Normalized Query 3 requires 7 JOINs (including composite Location & Country joins) vs 3 in Star
        self.assertEqual(q3_norm_complexity["join_token_count"], 7)
        self.assertEqual(q3_star_complexity["join_token_count"], 3)


if __name__ == "__main__":
    unittest.main()
