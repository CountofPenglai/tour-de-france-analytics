"""Offline unit tests for TDF normalized schema (tdf) and star warehouse (dw) ETL.

Note: These tests validate CSV parsing, business rule transformations, synthetic edge
cases, source file preservation, and generated SQL scripts offline using Python's
standard library. Live PostgreSQL execution is verified separately via sql/verify_load.sql.
"""

from __future__ import annotations

import datetime
import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path

from scripts import build_load


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = WORKSPACE_ROOT / "data"
SCHEMA_SQL_PATH = WORKSPACE_ROOT / "sql" / "001_schema.sql"
VERIFY_SQL_PATH = WORKSPACE_ROOT / "sql" / "verify_load.sql"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestETLCore(unittest.TestCase):
    """Offline tests for Phase 1 (tdf) and Phase 2 (dw) data transformation and SQL generation."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.initial_hashes = {
            name: _sha256(DATA_DIR / name)
            for name in ("riders.csv", "individual_results.csv", "exits.csv")
        }
        cls.bundle = build_load.load_and_validate_dataset(DATA_DIR)

    def test_01_exact_source_and_warehouse_counts(self) -> None:
        """Verify exact counts: 184 riders, 23 teams, 21 stages, 3602 results, 24 exits."""
        self.assertEqual(len(self.bundle.tdf_riders), 184)
        self.assertEqual(len(self.bundle.tdf_teams), 23)
        self.assertEqual(len(self.bundle.tdf_stages), 21)
        self.assertEqual(len(self.bundle.tdf_results), 3602)
        self.assertEqual(len(self.bundle.tdf_exits), 24)

        # Country universe is strictly the union of countries present in the 3 CSVs (29 countries)
        # plus country_key = 0 ('UNK') in dw.dim_country (30 total).
        self.assertEqual(len(self.bundle.tdf_countries), 29)
        self.assertEqual(len(self.bundle.dim_country), 30)
        self.assertEqual(len(self.bundle.dim_team), 23)
        self.assertEqual(len(self.bundle.dim_rider), 184)
        self.assertEqual(len(self.bundle.dim_stage), 21)
        self.assertEqual(len(self.bundle.dim_date), 21)
        self.assertEqual(len(self.bundle.fact_results), 3602)
        self.assertEqual(len(self.bundle.fact_participation), 184)

    def test_02_source_files_preserved_and_utf8_round_trip(self) -> None:
        """Ensure source CSV files are never modified and accents/apostrophes round-trip."""
        for name, expected_hash in self.initial_hashes.items():
            self.assertEqual(_sha256(DATA_DIR / name), expected_hash, f"{name} was modified")

        riders_by_bib = {r.bib: r for r in self.bundle.tdf_riders}
        self.assertEqual(riders_by_bib[121].rider_name, "Ben O'Connor")
        self.assertEqual(riders_by_bib[131].rider_name, "Kévin Vauquelin")
        self.assertEqual(riders_by_bib[151].rider_name, "Félix Gall")
        self.assertEqual(riders_by_bib[196].rider_name, "Niklas Märkl")
        self.assertEqual(riders_by_bib[41].team_name, "INTERMARCHÉ - WANTY")

        stages_by_id = {s.stage_id: s for s in self.bundle.tdf_stages}
        self.assertEqual(stages_by_id[1].start_location, "Lille Métropole")
        self.assertEqual(stages_by_id[7].finish_location, "Mûr-De-Bretagne Guerlédan")
        self.assertEqual(stages_by_id[17].start_location, "Bollène")
        self.assertEqual(stages_by_id[21].finish_location, "Paris Champs-Élysées")

    def test_03_stage_date_dense_rank_alignment_and_rest_days(self) -> None:
        """Verify DENSE_RANK stage numbering across rest days and race_week vs calendar week."""
        stages = sorted(self.bundle.tdf_stages, key=lambda s: s.stage_id)
        self.assertEqual([s.stage_id for s in stages], list(range(1, 22)))
        self.assertEqual(stages[0].stage_date, datetime.date(2025, 7, 5))
        self.assertEqual(stages[-1].stage_date, datetime.date(2025, 7, 27))

        # Rest days on 2025-07-15 (between stages 10 and 11) and 2025-07-21 (between stages 15 and 16)
        stage_dates = {s.stage_date for s in stages}
        self.assertNotIn(datetime.date(2025, 7, 15), stage_dates)
        self.assertNotIn(datetime.date(2025, 7, 21), stage_dates)
        self.assertEqual(stages[9].stage_id, 10)
        self.assertEqual(stages[9].stage_date, datetime.date(2025, 7, 14))
        self.assertEqual(stages[10].stage_id, 11)
        self.assertEqual(stages[10].stage_date, datetime.date(2025, 7, 16))
        self.assertEqual(stages[14].stage_id, 15)
        self.assertEqual(stages[14].stage_date, datetime.date(2025, 7, 20))
        self.assertEqual(stages[15].stage_id, 16)
        self.assertEqual(stages[15].stage_date, datetime.date(2025, 7, 22))

        # Same-city start/finish preserved for Stages 1, 5, 11
        for stage_num, expected_city in ((1, "Lille Métropole"), (5, "Caen"), (11, "Toulouse")):
            st = stages[stage_num - 1]
            self.assertEqual(st.start_location, expected_city)
            self.assertEqual(st.finish_location, expected_city)

        # Check race_week = ((stage_order - 1) // 7) + 1 vs ISO calendar week
        dates_by_full_date = {d.full_date: d for d in self.bundle.dim_date}
        for idx, st in enumerate(stages, start=1):
            d = dates_by_full_date[st.stage_date]
            expected_race_week = ((idx - 1) // 7) + 1
            self.assertEqual(d.race_week, expected_race_week)
            self.assertEqual(d.week, st.stage_date.isocalendar().week)
            self.assertNotEqual(d.race_week, d.week)

        # Stage 1..7 -> race_week 1; 8..14 -> race_week 2; 15..21 -> race_week 3
        self.assertEqual(dates_by_full_date[datetime.date(2025, 7, 11)].race_week, 1)  # Stage 7
        self.assertEqual(dates_by_full_date[datetime.date(2025, 7, 12)].race_week, 2)  # Stage 8
        self.assertEqual(dates_by_full_date[datetime.date(2025, 7, 19)].race_week, 2)  # Stage 14
        self.assertEqual(dates_by_full_date[datetime.date(2025, 7, 20)].race_week, 3)  # Stage 15

    def test_04_duplicate_finish_rank_allowed_and_one_result_per_rider_stage(self) -> None:
        """Verify tied finish_rank in a stage is accepted while duplicate (stage, rider) is rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_data = Path(tmpdir)
            for name in ("riders.csv", "individual_results.csv", "exits.csv"):
                shutil.copy2(DATA_DIR / name, tmp_data / name)

            # Modify Stage 1 rank 2 to rank 1 (creating a tied rank 1 on 2025-07-05)
            results_path = tmp_data / "individual_results.csv"
            lines = results_path.read_text(encoding="utf-8").splitlines()
            self.assertTrue(lines[2].startswith("2025-07-05,41,2,"))
            lines[2] = lines[2].replace("2025-07-05,41,2,", "2025-07-05,41,1,", 1)
            results_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

            tied_bundle = build_load.load_and_validate_dataset(tmp_data)
            stage1_rank1 = [
                r for r in tied_bundle.tdf_results if r.stage_id == 1 and r.finish_rank == 1
            ]
            self.assertEqual(len(stage1_rank1), 2)

            # Now duplicate (day, rider) and verify validation rejects it
            lines.append(lines[1])
            results_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                build_load.load_and_validate_dataset(tmp_data)

    def test_05_null_nationality_to_unk_warehouse_key(self) -> None:
        """Verify bib 78 has NULL country in tdf.rider and maps to country_key = 0 ('UNK') in dw facts."""
        self.assertNotIn("UNK", {c.country_code for c in self.bundle.tdf_countries})
        self.assertNotIn("NULL", {c.country_code for c in self.bundle.tdf_countries})

        unk_dim = next(c for c in self.bundle.dim_country if c.country_key == 0)
        self.assertEqual(unk_dim.country_code, "UNK")
        self.assertEqual(unk_dim.country_name, "Unknown / Unspecified")

        tdf_vlasov = next(r for r in self.bundle.tdf_riders if r.bib == 78)
        self.assertIsNone(tdf_vlasov.country_code)

        dim_vlasov = next(r for r in self.bundle.dim_rider if r.bib_number == 78)
        vlasov_part = next(
            p for p in self.bundle.fact_participation if p.rider_key == dim_vlasov.rider_key
        )
        self.assertEqual(vlasov_part.rider_country_key, 0)
        self.assertGreater(vlasov_part.team_country_key, 0)

        vlasov_results = [
            r for r in self.bundle.fact_results if r.rider_key == dim_vlasov.rider_key
        ]
        self.assertEqual(len(vlasov_results), 21)
        self.assertTrue(all(r.rider_country_key == 0 for r in vlasov_results))
        self.assertTrue(all(r.team_country_key == vlasov_part.team_country_key for r in vlasov_results))

        # No fact rows can have NULL foreign keys
        for row in self.bundle.fact_results:
            self.assertIsNotNone(row.rider_country_key)
            self.assertIsNotNone(row.team_country_key)
        for row in self.bundle.fact_participation:
            self.assertIsNotNone(row.rider_country_key)
            self.assertIsNotNone(row.team_country_key)

    def test_06_age_cutoff_vs_age_group_distinction(self) -> None:
        """Verify age_at_race on 2025-07-05, simple age_group labels, and independent is_young_rider."""
        allowed_labels = {"U23", "23-25", "26-29", "30+"}
        self.assertEqual({r.age_group for r in self.bundle.dim_rider}, allowed_labels)

        # Direct boundary tests on helper functions
        self.assertEqual(build_load.compute_age_at_race(datetime.date(2002, 7, 6)), 22)
        self.assertEqual(build_load.compute_age_group(22), "U23")
        self.assertEqual(build_load.compute_age_at_race(datetime.date(2002, 7, 5)), 23)
        self.assertEqual(build_load.compute_age_group(23), "23-25")
        self.assertEqual(build_load.compute_age_group(25), "23-25")
        self.assertEqual(build_load.compute_age_group(26), "26-29")
        self.assertEqual(build_load.compute_age_group(29), "26-29")
        self.assertEqual(build_load.compute_age_group(30), "30+")

        self.assertFalse(build_load.compute_is_young_rider(datetime.date(1999, 12, 31)))
        self.assertTrue(build_load.compute_is_young_rider(datetime.date(2000, 1, 1)))

        # Riders aged 25 on 2025-07-05 but born in 1999 must be in age_group '23-25'
        # while having is_young_rider = False
        age_23_25_not_young = [
            r
            for r in self.bundle.dim_rider
            if r.age_group == "23-25" and not r.is_young_rider
        ]
        self.assertGreater(len(age_23_25_not_young), 0)
        for r in age_23_25_not_young:
            self.assertEqual(r.age_at_race, 25)
            self.assertLess(r.date_of_birth, datetime.date(2000, 1, 1))

        # Every rider with is_young_rider = True has date_of_birth >= 2000-01-01
        for r in self.bundle.dim_rider:
            self.assertEqual(r.is_young_rider, r.date_of_birth >= datetime.date(2000, 1, 1))

    def test_07_proxy_scoring_arrays_and_boundaries(self) -> None:
        """Verify full proxy arrays and rank boundaries for stage_points_proxy and kom_points_proxy."""
        expected_stage_points = {
            "flat": [50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2],
            "hilly": [30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2],
            "mountain": [20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
            "individual time-trial": [20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        }
        for stage_type, expected_arr in expected_stage_points.items():
            actual_arr = [
                build_load.compute_stage_points_proxy(stage_type, rank)
                for rank in range(1, 16)
            ]
            self.assertEqual(actual_arr, expected_arr, f"Mismatch for {stage_type} stage_points_proxy")
            self.assertEqual(build_load.compute_stage_points_proxy(stage_type, 16), 0)
            self.assertEqual(build_load.compute_stage_points_proxy(stage_type, 184), 0)

        expected_kom_mountain = [20, 15, 12, 10, 8, 6, 4, 3, 2, 1]
        self.assertEqual(
            [build_load.compute_kom_points_proxy("mountain", rank) for rank in range(1, 11)],
            expected_kom_mountain,
        )
        self.assertEqual(build_load.compute_kom_points_proxy("mountain", 11), 0)

        expected_kom_hilly = [10, 6, 4, 2, 1]
        self.assertEqual(
            [build_load.compute_kom_points_proxy("hilly", rank) for rank in range(1, 6)],
            expected_kom_hilly,
        )
        self.assertEqual(build_load.compute_kom_points_proxy("hilly", 6), 0)

        for non_kom_type in ("flat", "individual time-trial"):
            for rank in (1, 2, 5, 10, 15, 50):
                self.assertEqual(build_load.compute_kom_points_proxy(non_kom_type, rank), 0)

        # Also check adjusted_time_seconds formula including zero and non-zero bonus/penalty
        for row in self.bundle.fact_results:
            self.assertEqual(
                row.adjusted_time_seconds,
                row.finish_time_seconds - row.time_bonus_seconds + row.time_penalty_seconds,
            )
        self.assertTrue(any(r.time_bonus_seconds > 0 for r in self.bundle.fact_results))
        self.assertTrue(any(r.time_penalty_seconds > 0 for r in self.bundle.fact_results))
        self.assertTrue(any(r.time_bonus_seconds == 0 and r.time_penalty_seconds == 0 for r in self.bundle.fact_results))

    def test_08_participation_states_and_exit_agreement(self) -> None:
        """Verify 160 finishers (all 21 stages) and 24 exits (including 2 Stage 1 withdrawals with 0 results)."""
        finishers = [p for p in self.bundle.fact_participation if p.finished_race_flag == 1]
        exits = [p for p in self.bundle.fact_participation if p.exit_flag == 1]
        self.assertEqual(len(finishers), 160)
        self.assertEqual(len(exits), 24)

        for p in self.bundle.fact_participation:
            self.assertEqual(p.participant_count, 1)
            self.assertIn(p.finished_race_flag, (0, 1))
            self.assertIn(p.exit_flag, (0, 1))
            self.assertEqual(p.finished_race_flag + p.exit_flag, 1)

        stages_per_rider = {r.rider_key: 0 for r in self.bundle.dim_rider}
        for res in self.bundle.fact_results:
            stages_per_rider[res.rider_key] += 1

        for p in finishers:
            self.assertEqual(stages_per_rider[p.rider_key], 21)
        for p in exits:
            self.assertLess(stages_per_rider[p.rider_key], 21)

        # Specifically, 2 riders withdrew in Stage 1 and have 0 stage results in fact_results
        zero_result_riders = [k for k, cnt in stages_per_rider.items() if cnt == 0]
        self.assertEqual(len(zero_result_riders), 2)

    def test_09_sql_files_and_build_load_generation(self) -> None:
        """Verify sql/001_schema.sql, sql/verify_load.sql, and generated build/load.sql properties."""
        self.assertTrue(SCHEMA_SQL_PATH.is_file(), "sql/001_schema.sql must exist")
        self.assertTrue(VERIFY_SQL_PATH.is_file(), "sql/verify_load.sql must exist")

        schema_sql = SCHEMA_SQL_PATH.read_text(encoding="utf-8")
        self.assertNotIn("DROP SCHEMA", schema_sql.upper())
        self.assertNotIn("tdf.award", schema_sql)
        for required_token in (
            "CREATE SCHEMA IF NOT EXISTS tdf",
            "CREATE SCHEMA IF NOT EXISTS dw",
            "tdf.country",
            "tdf.team",
            "tdf.rider",
            "tdf.location",
            "PRIMARY KEY (country_code, location_name)",
            "tdf.stage",
            "FOREIGN KEY (start_country_code, start_location_name)",
            "FOREIGN KEY (finish_country_code, finish_location_name)",
            "tdf.result",
            "tdf.exit",
            "exit_reason",
            "tdf.team_leader",
            "FOREIGN KEY (team_name, bib_number)",
            "tdf.classification_award",
            "tdf.rider_award",
            "tdf.team_award",
            "tdf.v_result_adjusted",
            "dw.dim_country",
            "dw.dim_team",
            "dw.dim_rider",
            "dw.dim_stage",
            "dw.dim_date",
            "dw.fact_results",
            "dw.fact_participation",
            "is_young_rider",
            "race_week",
            "stage_points_proxy",
            "kom_points_proxy",
            "tdf_reader",
        ):
            self.assertIn(required_token, schema_sql)

        with tempfile.TemporaryDirectory() as tmpdir:
            out_sql = Path(tmpdir) / "load.sql"
            summary = build_load.build_load_script(DATA_DIR, out_sql)
            self.assertEqual(summary["riders"], 184)
            self.assertEqual(summary["teams"], 23)
            self.assertEqual(summary["stages"], 21)
            self.assertEqual(summary["results"], 3602)
            self.assertEqual(summary["exits"], 24)

            load_sql = out_sql.read_text(encoding="utf-8")
            self.assertIn("BEGIN;", load_sql)
            self.assertIn("COMMIT;", load_sql)
            self.assertIn("DENSE_RANK() OVER (ORDER BY", load_sql)
            self.assertIn("Unknown / Unspecified", load_sql)
            self.assertIn("Ben O''Connor", load_sql)
            self.assertIn("Paris Champs-Élysées", load_sql)
            self.assertIn("ON ls.country_code = s.start_country_code", load_sql)
            self.assertIn("AND ls.location_name = s.start_location_name", load_sql)
            self.assertIn("ON lf.country_code = s.finish_country_code", load_sql)
            self.assertIn("AND lf.location_name = s.finish_location_name", load_sql)

    def test_10_composite_location_identity_regression(self) -> None:
        """Verify composite (country_code, location_name) allows homonymous cities across countries and preserves country identity."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_data = Path(tmpdir)
            for name in ("riders.csv", "individual_results.csv", "exits.csv"):
                shutil.copy2(DATA_DIR / name, tmp_data / name)

            results_path = tmp_data / "individual_results.csv"
            lines = results_path.read_text(encoding="utf-8").splitlines()
            header = lines[0]

            # Rewrite Stage 2 (2025-07-06) start_location to 'Lille Métropole' in country 'BEL' ('Belgium')
            # while Stage 1 (2025-07-05) keeps 'Lille Métropole' in country 'FRA' ('France').
            updated_lines = [header]
            for line in lines[1:]:
                if line.startswith("2025-07-06,"):
                    line = line.replace(
                        ",Lauwin-Planque,FRA,France,",
                        ",Lille Métropole,BEL,Belgium,",
                        1,
                    )
                updated_lines.append(line)
            results_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")

            homonym_bundle = build_load.load_and_validate_dataset(tmp_data)

            # Both ('FRA', 'Lille Métropole') and ('BEL', 'Lille Métropole') must coexist in tdf_locations
            loc_pairs = {(loc.country_code, loc.location_name) for loc in homonym_bundle.tdf_locations}
            self.assertIn(("FRA", "Lille Métropole"), loc_pairs)
            self.assertIn(("BEL", "Lille Métropole"), loc_pairs)

            # Stage 1 and Stage 2 must preserve their respective start_country_code in tdf_stages and dim_stage
            stages_by_id = {s.stage_id: s for s in homonym_bundle.tdf_stages}
            self.assertEqual(stages_by_id[1].start_country_code, "FRA")
            self.assertEqual(stages_by_id[1].start_location_name, "Lille Métropole")
            self.assertEqual(stages_by_id[2].start_country_code, "BEL")
            self.assertEqual(stages_by_id[2].start_location_name, "Lille Métropole")

            dim_stages_by_id = {s.stage_id: s for s in homonym_bundle.dim_stage}
            self.assertEqual(len(homonym_bundle.dim_stage), 21)
            self.assertEqual(dim_stages_by_id[1].start_country_code, "FRA")
            self.assertEqual(dim_stages_by_id[1].start_country_name, "France")
            self.assertEqual(dim_stages_by_id[2].start_country_code, "BEL")
            self.assertEqual(dim_stages_by_id[2].start_country_name, "Belgium")

            # Conflicting country code for a stage endpoint within the SAME stage day must still be rejected
            bad_lines = list(updated_lines)
            for idx, line in enumerate(bad_lines):
                if line.startswith("2025-07-06,"):
                    bad_lines[idx] = line.replace(
                        ",Lille Métropole,BEL,Belgium,",
                        ",Lille Métropole,FRA,France,",
                        1,
                    )
                    break
            results_path.write_text("\n".join(bad_lines) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                build_load.load_and_validate_dataset(tmp_data)


if __name__ == "__main__":
    unittest.main()
