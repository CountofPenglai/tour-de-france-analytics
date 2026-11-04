#!/usr/bin/env python3
"""Validate Tour de France 2025 source CSVs and build idempotent PostgreSQL load SQL.

Usage:
    python3 scripts/build_load.py --data-dir data --output build/load.sql
"""

from __future__ import annotations

import argparse
import csv
import datetime
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Sequence


RACE_START_DATE = datetime.date(2025, 7, 5)
YOUNG_RIDER_CUTOFF = datetime.date(2000, 1, 1)

VALID_STAGE_TYPES = frozenset({"flat", "hilly", "mountain", "individual time-trial"})

STAGE_POINTS_PROXY_BY_TYPE: dict[str, tuple[int, ...]] = {
    "flat": (50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2),
    "hilly": (30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2),
    "mountain": (20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1),
    "individual time-trial": (20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1),
}

KOM_POINTS_PROXY_BY_TYPE: dict[str, tuple[int, ...]] = {
    "mountain": (20, 15, 12, 10, 8, 6, 4, 3, 2, 1),
    "hilly": (10, 6, 4, 2, 1),
    "flat": (),
    "individual time-trial": (),
}


@dataclass(frozen=True)
class TdfCountry:
    country_code: str
    country_name: str


@dataclass(frozen=True)
class TdfTeam:
    team_name: str
    country_code: str


@dataclass(frozen=True)
class TdfRider:
    bib_number: int
    rider_name: str
    date_of_birth: datetime.date
    team_name: str
    country_code: str | None

    @property
    def bib(self) -> int:
        return self.bib_number

    @property
    def dob(self) -> datetime.date:
        return self.date_of_birth


@dataclass(frozen=True)
class TdfLocation:
    country_code: str
    location_name: str


@dataclass(frozen=True)
class TdfStage:
    stage_id: int
    stage_order: int
    stage_date: datetime.date
    start_country_code: str
    start_location_name: str
    finish_country_code: str
    finish_location_name: str
    distance_km: Decimal
    stage_type: str

    @property
    def start_location(self) -> str:
        return self.start_location_name

    @property
    def finish_location(self) -> str:
        return self.finish_location_name


@dataclass(frozen=True)
class TdfResult:
    bib_number: int
    stage_id: int
    finish_rank: int
    finish_time_seconds: int
    time_bonus_seconds: int
    time_penalty_seconds: int

    @property
    def bib(self) -> int:
        return self.bib_number


@dataclass(frozen=True)
class TdfExit:
    bib_number: int
    stage_id: int
    exit_reason: str

    @property
    def bib(self) -> int:
        return self.bib_number

    @property
    def reason(self) -> str:
        return self.exit_reason


@dataclass(frozen=True)
class DimCountry:
    country_key: int
    country_code: str
    country_name: str


@dataclass(frozen=True)
class DimTeam:
    team_key: int
    team_name: str


@dataclass(frozen=True)
class DimRider:
    rider_key: int
    bib_number: int
    rider_name: str
    date_of_birth: datetime.date
    age_at_race: int
    age_group: str
    is_young_rider: bool


@dataclass(frozen=True)
class DimStage:
    stage_key: int
    stage_id: int
    stage_order: int
    stage_type: str
    distance_km: Decimal
    start_location_name: str
    start_country_code: str
    start_country_name: str
    finish_location_name: str
    finish_country_code: str
    finish_country_name: str


@dataclass(frozen=True)
class DimDate:
    date_key: int
    full_date: datetime.date
    year: int
    month: int
    week: int
    day: int
    race_week: int


@dataclass(frozen=True)
class FactResult:
    rider_key: int
    stage_key: int
    team_key: int
    date_key: int
    rider_country_key: int
    team_country_key: int
    finish_time_seconds: int
    time_bonus_seconds: int
    time_penalty_seconds: int
    adjusted_time_seconds: int
    finish_rank: int
    stage_points_proxy: int
    kom_points_proxy: int


@dataclass(frozen=True)
class FactParticipation:
    rider_key: int
    team_key: int
    rider_country_key: int
    team_country_key: int
    participant_count: int
    finished_race_flag: int
    exit_flag: int


@dataclass(frozen=True)
class RawStageResultRow:
    day: datetime.date
    rider_bib: int
    finish_rank: int
    finish_time_seconds: int
    time_bonus_seconds: int
    time_penalty_seconds: int
    start_location: str
    start_country_code: str
    start_country_name: str
    finish_location: str
    finish_country_code: str
    finish_country_name: str
    distance_km: Decimal
    stage_type: str
    rider_name: str
    team_name: str


@dataclass(frozen=True)
class RawRiderRow:
    bib: int
    rider_name: str
    dob: datetime.date
    team_name: str
    rider_country_code: str
    rider_country_name: str
    team_country_code: str
    team_country_name: str


@dataclass(frozen=True)
class RawExitRow:
    bib: int
    rider_name: str
    stage_id: int
    reason: str


@dataclass(frozen=True)
class DatasetBundle:
    raw_riders: tuple[RawRiderRow, ...]
    raw_results: tuple[RawStageResultRow, ...]
    raw_exits: tuple[RawExitRow, ...]
    tdf_countries: tuple[TdfCountry, ...]
    tdf_teams: tuple[TdfTeam, ...]
    tdf_riders: tuple[TdfRider, ...]
    tdf_locations: tuple[TdfLocation, ...]
    tdf_stages: tuple[TdfStage, ...]
    tdf_results: tuple[TdfResult, ...]
    tdf_exits: tuple[TdfExit, ...]
    dim_country: tuple[DimCountry, ...]
    dim_team: tuple[DimTeam, ...]
    dim_rider: tuple[DimRider, ...]
    dim_stage: tuple[DimStage, ...]
    dim_date: tuple[DimDate, ...]
    fact_results: tuple[FactResult, ...]
    fact_participation: tuple[FactParticipation, ...]


def compute_age_at_race(
    dob: datetime.date,
    reference_date: datetime.date = RACE_START_DATE,
) -> int:
    """Compute completed integer years of age as of the first stage date (2025-07-05)."""
    years = reference_date.year - dob.year
    if (reference_date.month, reference_date.day) < (dob.month, dob.day):
        years -= 1
    return years


def compute_age_group(age_at_race: int) -> str:
    """Map race-day age to simple age-group labels without equating 23-25 to white jersey."""
    if age_at_race < 23:
        return "U23"
    if age_at_race <= 25:
        return "23-25"
    if age_at_race <= 29:
        return "26-29"
    return "30+"


def compute_is_young_rider(dob: datetime.date) -> bool:
    """Check official Young Rider birthdate threshold (born on or after 2000-01-01)."""
    return dob >= YOUNG_RIDER_CUTOFF


def compute_race_week(stage_order: int) -> int:
    """Compute race week as ((stage_order - 1) // 7) + 1."""
    if stage_order < 1:
        raise ValueError(f"stage_order must be >= 1, got {stage_order}")
    return ((stage_order - 1) // 7) + 1


def compute_adjusted_time(
    finish_time_seconds: int,
    time_bonus_seconds: int,
    time_penalty_seconds: int,
) -> int:
    """Compute adjusted stage time: finish_time - bonus + penalty."""
    return finish_time_seconds - time_bonus_seconds + time_penalty_seconds


def compute_stage_points_proxy(stage_type: str, finish_rank: int) -> int:
    """Compute stage finish points proxy according to SPEC section 4.2."""
    if stage_type not in STAGE_POINTS_PROXY_BY_TYPE:
        raise ValueError(f"Unsupported stage_type: {stage_type!r}")
    if finish_rank < 1:
        raise ValueError(f"finish_rank must be >= 1, got {finish_rank}")
    scoring = STAGE_POINTS_PROXY_BY_TYPE[stage_type]
    if finish_rank <= len(scoring):
        return scoring[finish_rank - 1]
    return 0


def compute_kom_points_proxy(stage_type: str, finish_rank: int) -> int:
    """Compute KOM points proxy according to SPEC section 4.2."""
    if stage_type not in KOM_POINTS_PROXY_BY_TYPE:
        raise ValueError(f"Unsupported stage_type: {stage_type!r}")
    if finish_rank < 1:
        raise ValueError(f"finish_rank must be >= 1, got {finish_rank}")
    scoring = KOM_POINTS_PROXY_BY_TYPE[stage_type]
    if finish_rank <= len(scoring):
        return scoring[finish_rank - 1]
    return 0


def _register_country(
    registry: dict[str, str],
    code: str,
    name: str,
    context: str,
) -> None:
    code_clean = code.strip()
    name_clean = name.strip()
    if len(code_clean) != 3 or code_clean in {"UNK", "NULL"}:
        raise ValueError(f"Invalid country_code {code!r} in {context}")
    if not name_clean or name_clean == "NULL":
        raise ValueError(f"Invalid country_name {name!r} for {code_clean} in {context}")
    existing = registry.get(code_clean)
    if existing is not None and existing != name_clean:
        raise ValueError(
            f"Conflicting country name for {code_clean}: {existing!r} vs {name_clean!r} in {context}"
        )
    registry[code_clean] = name_clean


def load_and_validate_dataset(data_dir: Path | str) -> DatasetBundle:
    """Read and validate only the 3 CSV files and construct tdf and dw records."""
    base_dir = Path(data_dir)
    riders_csv = base_dir / "riders.csv"
    results_csv = base_dir / "individual_results.csv"
    exits_csv = base_dir / "exits.csv"

    for csv_path in (riders_csv, results_csv, exits_csv):
        if not csv_path.is_file():
            raise FileNotFoundError(f"Required source CSV not found: {csv_path}")

    country_registry: dict[str, str] = {}
    team_registry: dict[str, str] = {}
    raw_riders: list[RawRiderRow] = []
    tdf_riders_by_bib: dict[int, TdfRider] = {}

    # 1. Read and validate riders.csv
    expected_rider_cols = [
        "bib",
        "rider_name",
        "dob",
        "team",
        "rider_country_code",
        "rider_country_name",
        "team_country_code",
        "team_country_name",
    ]
    with riders_csv.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != expected_rider_cols:
            raise ValueError(f"Unexpected riders.csv columns: {reader.fieldnames}")
        for line_num, row in enumerate(reader, start=2):
            bib = int(row["bib"])
            if bib <= 0:
                raise ValueError(f"Invalid bib {bib} at riders.csv:{line_num}")
            if bib in tdf_riders_by_bib:
                raise ValueError(f"Duplicate bib {bib} at riders.csv:{line_num}")

            rider_name = row["rider_name"].strip()
            if not rider_name:
                raise ValueError(f"Empty rider_name at riders.csv:{line_num}")

            dob = datetime.date.fromisoformat(row["dob"].strip())
            team_name = row["team"].strip()
            if not team_name:
                raise ValueError(f"Empty team at riders.csv:{line_num}")

            raw_r_code = row["rider_country_code"].strip()
            raw_r_name = row["rider_country_name"].strip()
            if raw_r_code == "NULL" or raw_r_name == "NULL":
                if raw_r_code != "NULL" or raw_r_name != "NULL":
                    raise ValueError(
                        f"Inconsistent NULL nationality fields for bib {bib} at riders.csv:{line_num}"
                    )
                rider_country_code: str | None = None
            else:
                _register_country(
                    country_registry, raw_r_code, raw_r_name, f"riders.csv:{line_num}"
                )
                rider_country_code = raw_r_code

            team_c_code = row["team_country_code"].strip()
            team_c_name = row["team_country_name"].strip()
            _register_country(
                country_registry, team_c_code, team_c_name, f"riders.csv:{line_num}"
            )
            existing_team_country = team_registry.get(team_name)
            if existing_team_country is not None and existing_team_country != team_c_code:
                raise ValueError(
                    f"Conflicting team country for {team_name}: {existing_team_country} vs {team_c_code}"
                )
            team_registry[team_name] = team_c_code

            raw_riders.append(
                RawRiderRow(
                    bib=bib,
                    rider_name=rider_name,
                    dob=dob,
                    team_name=team_name,
                    rider_country_code=raw_r_code,
                    rider_country_name=raw_r_name,
                    team_country_code=team_c_code,
                    team_country_name=team_c_name,
                )
            )
            tdf_riders_by_bib[bib] = TdfRider(
                bib_number=bib,
                rider_name=rider_name,
                date_of_birth=dob,
                team_name=team_name,
                country_code=rider_country_code,
            )

    if not raw_riders:
        raise ValueError("riders.csv contains no data rows")

    # 2. Read and validate individual_results.csv
    expected_result_cols = [
        "day",
        "rider",
        "rank",
        "time",
        "bonus",
        "penalty",
        "start_location",
        "start_country_code",
        "start_country_name",
        "finish_location",
        "finish_country_code",
        "finish_country_name",
        "length",
        "type",
        "name",
        "team",
    ]
    raw_results: list[RawStageResultRow] = []
    location_set: set[tuple[str, str]] = set()
    stage_meta_by_day: dict[datetime.date, tuple[str, str, str, str, Decimal, str]] = {}
    seen_day_rider: set[tuple[datetime.date, int]] = set()

    with results_csv.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != expected_result_cols:
            raise ValueError(
                f"Unexpected individual_results.csv columns: {reader.fieldnames}"
            )
        for line_num, row in enumerate(reader, start=2):
            day = datetime.date.fromisoformat(row["day"].strip())
            rider_bib = int(row["rider"])
            if rider_bib not in tdf_riders_by_bib:
                raise ValueError(
                    f"Unknown rider bib {rider_bib} at individual_results.csv:{line_num}"
                )
            rider_ref = tdf_riders_by_bib[rider_bib]
            if row["name"].strip() != rider_ref.rider_name:
                raise ValueError(
                    f"Rider name mismatch for bib {rider_bib} at individual_results.csv:{line_num}"
                )
            if row["team"].strip() != rider_ref.team_name:
                raise ValueError(
                    f"Team mismatch for bib {rider_bib} at individual_results.csv:{line_num}"
                )

            if (day, rider_bib) in seen_day_rider:
                raise ValueError(
                    f"Duplicate result for (day={day}, rider={rider_bib}) at individual_results.csv:{line_num}"
                )
            seen_day_rider.add((day, rider_bib))

            finish_rank = int(row["rank"])
            if finish_rank < 1:
                raise ValueError(
                    f"Invalid rank {finish_rank} at individual_results.csv:{line_num}"
                )
            finish_time = int(row["time"])
            if finish_time <= 0:
                raise ValueError(
                    f"Invalid finish time {finish_time} at individual_results.csv:{line_num}"
                )
            bonus = int(row["bonus"])
            penalty = int(row["penalty"])
            if bonus < 0 or penalty < 0:
                raise ValueError(
                    f"Negative bonus/penalty at individual_results.csv:{line_num}"
                )
            if compute_adjusted_time(finish_time, bonus, penalty) <= 0:
                raise ValueError(
                    f"Non-positive adjusted time at individual_results.csv:{line_num}"
                )

            start_loc = row["start_location"].strip()
            start_c_code = row["start_country_code"].strip()
            start_c_name = row["start_country_name"].strip()
            finish_loc = row["finish_location"].strip()
            finish_c_code = row["finish_country_code"].strip()
            finish_c_name = row["finish_country_name"].strip()

            _register_country(
                country_registry,
                start_c_code,
                start_c_name,
                f"individual_results.csv:{line_num}",
            )
            _register_country(
                country_registry,
                finish_c_code,
                finish_c_name,
                f"individual_results.csv:{line_num}",
            )

            for loc_c_code, loc_name in (
                (start_c_code, start_loc),
                (finish_c_code, finish_loc),
            ):
                if not loc_name:
                    raise ValueError(
                        f"Empty location name at individual_results.csv:{line_num}"
                    )
                location_set.add((loc_c_code, loc_name))

            distance_km = Decimal(row["length"].strip())
            if distance_km <= 0:
                raise ValueError(
                    f"Non-positive stage length {distance_km} at individual_results.csv:{line_num}"
                )
            stage_type = row["type"].strip()
            if stage_type not in VALID_STAGE_TYPES:
                raise ValueError(
                    f"Unsupported stage type {stage_type!r} at individual_results.csv:{line_num}"
                )

            stage_sig = (
                start_c_code,
                start_loc,
                finish_c_code,
                finish_loc,
                distance_km,
                stage_type,
            )
            prev_sig = stage_meta_by_day.get(day)
            if prev_sig is not None and prev_sig != stage_sig:
                raise ValueError(
                    f"Inconsistent stage metadata on {day}: {prev_sig} vs {stage_sig}"
                )
            stage_meta_by_day[day] = stage_sig

            raw_results.append(
                RawStageResultRow(
                    day=day,
                    rider_bib=rider_bib,
                    finish_rank=finish_rank,
                    finish_time_seconds=finish_time,
                    time_bonus_seconds=bonus,
                    time_penalty_seconds=penalty,
                    start_location=start_loc,
                    start_country_code=start_c_code,
                    start_country_name=start_c_name,
                    finish_location=finish_loc,
                    finish_country_code=finish_c_code,
                    finish_country_name=finish_c_name,
                    distance_km=distance_km,
                    stage_type=stage_type,
                    rider_name=rider_ref.rider_name,
                    team_name=rider_ref.team_name,
                )
            )

    if not raw_results:
        raise ValueError("individual_results.csv contains no data rows")

    # DENSE_RANK() OVER (ORDER BY day ASC) stage mapping
    sorted_days = sorted(stage_meta_by_day.keys())
    day_to_stage_id = {day: idx for idx, day in enumerate(sorted_days, start=1)}
    num_stages = len(sorted_days)

    tdf_stages = tuple(
        TdfStage(
            stage_id=day_to_stage_id[day],
            stage_order=day_to_stage_id[day],
            stage_date=day,
            start_country_code=stage_meta_by_day[day][0],
            start_location_name=stage_meta_by_day[day][1],
            finish_country_code=stage_meta_by_day[day][2],
            finish_location_name=stage_meta_by_day[day][3],
            distance_km=stage_meta_by_day[day][4],
            stage_type=stage_meta_by_day[day][5],
        )
        for day in sorted_days
    )

    tdf_results = tuple(
        sorted(
            (
                TdfResult(
                    bib_number=r.rider_bib,
                    stage_id=day_to_stage_id[r.day],
                    finish_rank=r.finish_rank,
                    finish_time_seconds=r.finish_time_seconds,
                    time_bonus_seconds=r.time_bonus_seconds,
                    time_penalty_seconds=r.time_penalty_seconds,
                )
                for r in raw_results
            ),
            key=lambda x: (x.stage_id, x.finish_rank, x.bib_number),
        )
    )

    # 3. Read and validate exits.csv
    expected_exit_cols = ["bib", "name", "stage", "reason"]
    raw_exits: list[RawExitRow] = []
    tdf_exits_by_bib: dict[int, TdfExit] = {}

    with exits_csv.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != expected_exit_cols:
            raise ValueError(f"Unexpected exits.csv columns: {reader.fieldnames}")
        for line_num, row in enumerate(reader, start=2):
            bib = int(row["bib"])
            if bib not in tdf_riders_by_bib:
                raise ValueError(f"Unknown rider bib {bib} at exits.csv:{line_num}")
            if bib in tdf_exits_by_bib:
                raise ValueError(f"Duplicate exit for bib {bib} at exits.csv:{line_num}")
            rider_ref = tdf_riders_by_bib[bib]
            if row["name"].strip() != rider_ref.rider_name:
                raise ValueError(
                    f"Rider name mismatch for bib {bib} at exits.csv:{line_num}"
                )
            stage_id = int(row["stage"])
            if not (1 <= stage_id <= num_stages):
                raise ValueError(
                    f"Exit stage {stage_id} out of range 1..{num_stages} at exits.csv:{line_num}"
                )
            reason = row["reason"].strip()
            if not reason:
                raise ValueError(f"Empty exit reason at exits.csv:{line_num}")

            raw_exits.append(
                RawExitRow(
                    bib=bib,
                    rider_name=rider_ref.rider_name,
                    stage_id=stage_id,
                    reason=reason,
                )
            )
            tdf_exits_by_bib[bib] = TdfExit(
                bib_number=bib,
                stage_id=stage_id,
                exit_reason=reason,
            )

    # 4. Validate agreement between stage coverage and exits
    stages_by_rider: dict[int, set[int]] = {bib: set() for bib in tdf_riders_by_bib}
    for res in tdf_results:
        stages_by_rider[res.bib_number].add(res.stage_id)

    all_stage_ids = set(range(1, num_stages + 1))
    for bib, completed_stages in stages_by_rider.items():
        exit_rec = tdf_exits_by_bib.get(bib)
        if exit_rec is None:
            if completed_stages != all_stage_ids:
                raise ValueError(
                    f"Rider bib {bib} has no exit record but completed {len(completed_stages)}/{num_stages} stages"
                )
        else:
            if completed_stages == all_stage_ids:
                raise ValueError(
                    f"Rider bib {bib} has an exit record at stage {exit_rec.stage_id} but completed all stages"
                )
            expected_prior_stages = set(range(1, exit_rec.stage_id))
            if completed_stages != expected_prior_stages:
                raise ValueError(
                    f"Rider bib {bib} exited on stage {exit_rec.stage_id} but completed stages {sorted(completed_stages)}"
                )

    tdf_countries = tuple(
        TdfCountry(country_code=code, country_name=country_registry[code])
        for code in sorted(country_registry.keys())
    )
    tdf_teams = tuple(
        TdfTeam(team_name=t_name, country_code=team_registry[t_name])
        for t_name in sorted(team_registry.keys())
    )
    tdf_riders = tuple(
        tdf_riders_by_bib[bib] for bib in sorted(tdf_riders_by_bib.keys())
    )
    tdf_locations = tuple(
        TdfLocation(country_code=c_code, location_name=loc_name)
        for c_code, loc_name in sorted(location_set)
    )
    tdf_exits = tuple(
        tdf_exits_by_bib[bib] for bib in sorted(tdf_exits_by_bib.keys())
    )

    # 5. Construct star-schema (dw) dimensions and facts
    dim_country_list = [
        DimCountry(
            country_key=0,
            country_code="UNK",
            country_name="Unknown / Unspecified",
        )
    ]
    for idx, c in enumerate(tdf_countries, start=1):
        dim_country_list.append(
            DimCountry(
                country_key=idx,
                country_code=c.country_code,
                country_name=c.country_name,
            )
        )
    dim_country = tuple(dim_country_list)
    country_key_by_code = {c.country_code: c.country_key for c in dim_country}

    dim_team = tuple(
        DimTeam(team_key=idx, team_name=t.team_name)
        for idx, t in enumerate(tdf_teams, start=1)
    )
    team_key_by_name = {t.team_name: t.team_key for t in dim_team}

    dim_rider_list: list[DimRider] = []
    for idx, r in enumerate(tdf_riders, start=1):
        age_at_race = compute_age_at_race(r.date_of_birth, RACE_START_DATE)
        dim_rider_list.append(
            DimRider(
                rider_key=idx,
                bib_number=r.bib_number,
                rider_name=r.rider_name,
                date_of_birth=r.date_of_birth,
                age_at_race=age_at_race,
                age_group=compute_age_group(age_at_race),
                is_young_rider=compute_is_young_rider(r.date_of_birth),
            )
        )
    dim_rider = tuple(dim_rider_list)
    rider_key_by_bib = {r.bib_number: r.rider_key for r in dim_rider}

    dim_stage = tuple(
        DimStage(
            stage_key=s.stage_id,
            stage_id=s.stage_id,
            stage_order=s.stage_order,
            stage_type=s.stage_type,
            distance_km=s.distance_km,
            start_location_name=s.start_location_name,
            start_country_code=s.start_country_code,
            start_country_name=country_registry[s.start_country_code],
            finish_location_name=s.finish_location_name,
            finish_country_code=s.finish_country_code,
            finish_country_name=country_registry[s.finish_country_code],
        )
        for s in tdf_stages
    )
    stage_by_id = {s.stage_id: s for s in tdf_stages}

    dim_date = tuple(
        DimDate(
            date_key=int(s.stage_date.strftime("%Y%m%d")),
            full_date=s.stage_date,
            year=s.stage_date.year,
            month=s.stage_date.month,
            week=s.stage_date.isocalendar().week,
            day=s.stage_date.day,
            race_week=compute_race_week(s.stage_order),
        )
        for s in tdf_stages
    )
    date_key_by_stage_id = {
        s.stage_id: int(s.stage_date.strftime("%Y%m%d")) for s in tdf_stages
    }

    fact_results = tuple(
        FactResult(
            rider_key=rider_key_by_bib[res.bib_number],
            stage_key=res.stage_id,
            team_key=team_key_by_name[tdf_riders_by_bib[res.bib_number].team_name],
            date_key=date_key_by_stage_id[res.stage_id],
            rider_country_key=country_key_by_code[
                tdf_riders_by_bib[res.bib_number].country_code or "UNK"
            ],
            team_country_key=country_key_by_code[
                team_registry[tdf_riders_by_bib[res.bib_number].team_name]
            ],
            finish_time_seconds=res.finish_time_seconds,
            time_bonus_seconds=res.time_bonus_seconds,
            time_penalty_seconds=res.time_penalty_seconds,
            adjusted_time_seconds=compute_adjusted_time(
                res.finish_time_seconds,
                res.time_bonus_seconds,
                res.time_penalty_seconds,
            ),
            finish_rank=res.finish_rank,
            stage_points_proxy=compute_stage_points_proxy(
                stage_by_id[res.stage_id].stage_type, res.finish_rank
            ),
            kom_points_proxy=compute_kom_points_proxy(
                stage_by_id[res.stage_id].stage_type, res.finish_rank
            ),
        )
        for res in tdf_results
    )

    fact_participation = tuple(
        FactParticipation(
            rider_key=rider_key_by_bib[r.bib_number],
            team_key=team_key_by_name[r.team_name],
            rider_country_key=country_key_by_code[r.country_code or "UNK"],
            team_country_key=country_key_by_code[team_registry[r.team_name]],
            participant_count=1,
            finished_race_flag=1
            if (len(stages_by_rider[r.bib_number]) == num_stages and r.bib_number not in tdf_exits_by_bib)
            else 0,
            exit_flag=1 if r.bib_number in tdf_exits_by_bib else 0,
        )
        for r in tdf_riders
    )

    return DatasetBundle(
        raw_riders=tuple(raw_riders),
        raw_results=tuple(raw_results),
        raw_exits=tuple(raw_exits),
        tdf_countries=tdf_countries,
        tdf_teams=tdf_teams,
        tdf_riders=tdf_riders,
        tdf_locations=tdf_locations,
        tdf_stages=tdf_stages,
        tdf_results=tdf_results,
        tdf_exits=tdf_exits,
        dim_country=dim_country,
        dim_team=dim_team,
        dim_rider=dim_rider,
        dim_stage=dim_stage,
        dim_date=dim_date,
        fact_results=fact_results,
        fact_participation=fact_participation,
    )


def _sql_str(val: str) -> str:
    """Format a Python string as a safe PostgreSQL string literal."""
    if "\x00" in val:
        raise ValueError("NUL byte not allowed in SQL literal")
    return "'" + val.replace("'", "''") + "'"


def _sql_date(val: datetime.date) -> str:
    return f"DATE '{val.isoformat()}'"


def _chunked(seq: Sequence[str], size: int = 250) -> list[Sequence[str]]:
    return [seq[i : i + size] for i in range(0, len(seq), size)]


def generate_load_sql(bundle: DatasetBundle) -> str:
    """Generate a transaction-wrapped, repeatable PostgreSQL load script for tdf and dw."""
    lines: list[str] = [
        "-- =============================================================================",
        "-- Generated by scripts/build_load.py",
        "-- Transaction-wrapped repeatable load script for schemas tdf and dw.",
        "-- Prerequisite: run sql/001_schema.sql first (or let the idempotent DDL below ensure tables exist).",
        "-- Execution role: tdf_owner",
        "-- =============================================================================",
        "\\set ON_ERROR_STOP on",
        "",
        "BEGIN;",
        "",
    ]

    schema_sql_path = Path(__file__).resolve().parent.parent / "sql" / "001_schema.sql"
    if schema_sql_path.is_file():
        lines.append("-- Ensure schemas, tables, indexes, and reader grants exist idempotently")
        lines.append(schema_sql_path.read_text(encoding="utf-8").strip())
        lines.append("")

    lines.extend(
        [
            "-- Repeatable idempotent cleanup limited strictly to project tables in dw and tdf",
            "TRUNCATE TABLE",
            "    dw.fact_results,",
            "    dw.fact_participation,",
            "    dw.dim_date,",
            "    dw.dim_stage,",
            "    dw.dim_rider,",
            "    dw.dim_team,",
            "    dw.dim_country,",
            "    tdf.rider_award,",
            "    tdf.team_award,",
            "    tdf.classification_award,",
            "    tdf.team_leader,",
            "    tdf.exit,",
            "    tdf.result,",
            "    tdf.stage,",
            "    tdf.location,",
            "    tdf.rider,",
            "    tdf.team,",
            "    tdf.country;",
            "",
            "-- Transaction-local staging tables mirroring the 3 source CSV files",
            "CREATE TEMP TABLE stg_riders (",
            "    bib INTEGER NOT NULL,",
            "    rider_name TEXT NOT NULL,",
            "    dob DATE NOT NULL,",
            "    team TEXT NOT NULL,",
            "    rider_country_code TEXT NOT NULL,",
            "    rider_country_name TEXT NOT NULL,",
            "    team_country_code TEXT NOT NULL,",
            "    team_country_name TEXT NOT NULL",
            ") ON COMMIT DROP;",
            "",
            "CREATE TEMP TABLE stg_individual_results (",
            "    day DATE NOT NULL,",
            "    rider INTEGER NOT NULL,",
            "    rank INTEGER NOT NULL,",
            "    time INTEGER NOT NULL,",
            "    bonus INTEGER NOT NULL,",
            "    penalty INTEGER NOT NULL,",
            "    start_location TEXT NOT NULL,",
            "    start_country_code TEXT NOT NULL,",
            "    start_country_name TEXT NOT NULL,",
            "    finish_location TEXT NOT NULL,",
            "    finish_country_code TEXT NOT NULL,",
            "    finish_country_name TEXT NOT NULL,",
            "    length NUMERIC(6, 2) NOT NULL,",
            "    type TEXT NOT NULL,",
            "    name TEXT NOT NULL,",
            "    team TEXT NOT NULL",
            ") ON COMMIT DROP;",
            "",
            "CREATE TEMP TABLE stg_exits (",
            "    bib INTEGER NOT NULL,",
            "    name TEXT NOT NULL,",
            "    stage INTEGER NOT NULL,",
            "    reason TEXT NOT NULL",
            ") ON COMMIT DROP;",
            "",
        ]
    )

    rider_tuples = [
        f"({r.bib}, {_sql_str(r.rider_name)}, {_sql_date(r.dob)}, {_sql_str(r.team_name)}, "
        f"{_sql_str(r.rider_country_code)}, {_sql_str(r.rider_country_name)}, "
        f"{_sql_str(r.team_country_code)}, {_sql_str(r.team_country_name)})"
        for r in bundle.raw_riders
    ]
    for batch in _chunked(rider_tuples, 200):
        lines.append(
            "INSERT INTO stg_riders (bib, rider_name, dob, team, rider_country_code, rider_country_name, team_country_code, team_country_name) VALUES\n    "
            + ",\n    ".join(batch)
            + ";"
        )
    lines.append("")

    result_tuples = [
        f"({_sql_date(r.day)}, {r.rider_bib}, {r.finish_rank}, {r.finish_time_seconds}, "
        f"{r.time_bonus_seconds}, {r.time_penalty_seconds}, {_sql_str(r.start_location)}, "
        f"{_sql_str(r.start_country_code)}, {_sql_str(r.start_country_name)}, "
        f"{_sql_str(r.finish_location)}, {_sql_str(r.finish_country_code)}, "
        f"{_sql_str(r.finish_country_name)}, {r.distance_km}, {_sql_str(r.stage_type)}, "
        f"{_sql_str(r.rider_name)}, {_sql_str(r.team_name)})"
        for r in bundle.raw_results
    ]
    for batch in _chunked(result_tuples, 250):
        lines.append(
            "INSERT INTO stg_individual_results (day, rider, rank, time, bonus, penalty, start_location, start_country_code, start_country_name, finish_location, finish_country_code, finish_country_name, length, type, name, team) VALUES\n    "
            + ",\n    ".join(batch)
            + ";"
        )
    lines.append("")

    exit_tuples = [
        f"({e.bib}, {_sql_str(e.rider_name)}, {e.stage_id}, {_sql_str(e.reason)})"
        for e in bundle.raw_exits
    ]
    for batch in _chunked(exit_tuples, 200):
        lines.append(
            "INSERT INTO stg_exits (bib, name, stage, reason) VALUES\n    "
            + ",\n    ".join(batch)
            + ";"
        )
    lines.append("")

    lines.extend(
        [
            "-- -----------------------------------------------------------------------------",
            "-- Phase 1 Transformation: Staging -> Normalized Schema (tdf)",
            "-- -----------------------------------------------------------------------------",
            "",
            "-- 1.1 Country universe: strictly the union of countries present in the 3 CSVs",
            "INSERT INTO tdf.country (country_code, country_name)",
            "SELECT country_code, country_name",
            "FROM (",
            "    SELECT rider_country_code AS country_code, rider_country_name AS country_name",
            "    FROM stg_riders",
            "    WHERE rider_country_code <> 'NULL' AND rider_country_name <> 'NULL'",
            "    UNION",
            "    SELECT team_country_code AS country_code, team_country_name AS country_name",
            "    FROM stg_riders",
            "    UNION",
            "    SELECT start_country_code AS country_code, start_country_name AS country_name",
            "    FROM stg_individual_results",
            "    UNION",
            "    SELECT finish_country_code AS country_code, finish_country_name AS country_name",
            "    FROM stg_individual_results",
            ") AS country_union",
            "ORDER BY country_code ASC;",
            "",
            "-- 1.2 Teams",
            "INSERT INTO tdf.team (team_name, country_code)",
            "SELECT DISTINCT team AS team_name, team_country_code AS country_code",
            "FROM stg_riders",
            "ORDER BY team_name ASC;",
            "",
            "-- 1.3 Riders (string 'NULL' nationality converted to SQL NULL)",
            "INSERT INTO tdf.rider (bib_number, rider_name, date_of_birth, team_name, country_code)",
            "SELECT",
            "    bib AS bib_number,",
            "    rider_name,",
            "    dob AS date_of_birth,",
            "    team AS team_name,",
            "    NULLIF(rider_country_code, 'NULL') AS country_code",
            "FROM stg_riders",
            "ORDER BY bib_number ASC;",
            "",
            "-- 1.4 Locations (composite primary key: country_code, location_name)",
            "INSERT INTO tdf.location (country_code, location_name)",
            "SELECT country_code, location_name",
            "FROM (",
            "    SELECT start_country_code AS country_code, start_location AS location_name",
            "    FROM stg_individual_results",
            "    UNION",
            "    SELECT finish_country_code AS country_code, finish_location AS location_name",
            "    FROM stg_individual_results",
            ") AS loc_union",
            "ORDER BY country_code ASC, location_name ASC;",
            "",
            "-- 1.5 Stages mapped via DENSE_RANK() OVER (ORDER BY day ASC) across rest days",
            "INSERT INTO tdf.stage (",
            "    stage_id,",
            "    stage_order,",
            "    stage_date,",
            "    start_country_code,",
            "    start_location_name,",
            "    finish_country_code,",
            "    finish_location_name,",
            "    distance_km,",
            "    stage_type",
            ")",
            "SELECT",
            "    DENSE_RANK() OVER (ORDER BY day ASC)::INTEGER AS stage_id,",
            "    DENSE_RANK() OVER (ORDER BY day ASC)::INTEGER AS stage_order,",
            "    day AS stage_date,",
            "    start_country_code,",
            "    start_location AS start_location_name,",
            "    finish_country_code,",
            "    finish_location AS finish_location_name,",
            "    length AS distance_km,",
            "    type AS stage_type",
            "FROM (",
            "    SELECT DISTINCT",
            "        day,",
            "        start_country_code,",
            "        start_location,",
            "        finish_country_code,",
            "        finish_location,",
            "        length,",
            "        type",
            "    FROM stg_individual_results",
            ") AS distinct_stages",
            "ORDER BY stage_id ASC;",
            "",
            "-- 1.6 Individual stage results",
            "INSERT INTO tdf.result (bib_number, stage_id, finish_rank, finish_time_seconds, time_bonus_seconds, time_penalty_seconds)",
            "SELECT",
            "    r.rider AS bib_number,",
            "    s.stage_id,",
            "    r.rank AS finish_rank,",
            "    r.time AS finish_time_seconds,",
            "    r.bonus AS time_bonus_seconds,",
            "    r.penalty AS time_penalty_seconds",
            "FROM stg_individual_results AS r",
            "INNER JOIN tdf.stage AS s",
            "    ON s.stage_date = r.day",
            "ORDER BY s.stage_id ASC, r.rank ASC, r.rider ASC;",
            "",
            "-- 1.7 Rider exits",
            "INSERT INTO tdf.exit (bib_number, stage_id, exit_reason)",
            "SELECT bib AS bib_number, stage AS stage_id, reason AS exit_reason",
            "FROM stg_exits",
            "ORDER BY bib_number ASC;",
            "",
            "-- -----------------------------------------------------------------------------",
            "-- Phase 2 Transformation: Normalized Schema (tdf) -> Star Warehouse (dw)",
            "-- -----------------------------------------------------------------------------",
            "",
            "-- 2.1 dw.dim_country: country_key = 0 ('UNK') plus stable surrogate keys 1..N",
            "INSERT INTO dw.dim_country (country_key, country_code, country_name)",
            "VALUES (0, 'UNK', 'Unknown / Unspecified');",
            "",
            "INSERT INTO dw.dim_country (country_key, country_code, country_name)",
            "SELECT",
            "    ROW_NUMBER() OVER (ORDER BY c.country_code ASC)::INTEGER AS country_key,",
            "    c.country_code,",
            "    c.country_name",
            "FROM tdf.country AS c",
            "ORDER BY country_key ASC;",
            "",
            "-- 2.2 dw.dim_team",
            "INSERT INTO dw.dim_team (team_key, team_name)",
            "SELECT",
            "    ROW_NUMBER() OVER (ORDER BY t.team_name ASC)::INTEGER AS team_key,",
            "    t.team_name",
            "FROM tdf.team AS t",
            "ORDER BY team_key ASC;",
            "",
            "-- 2.3 dw.dim_rider: age_at_race on 2025-07-05, simple age_group labels, independent is_young_rider",
            "INSERT INTO dw.dim_rider (rider_key, bib_number, rider_name, date_of_birth, age_at_race, age_group, is_young_rider)",
            "SELECT",
            "    ROW_NUMBER() OVER (ORDER BY r.bib_number ASC)::INTEGER AS rider_key,",
            "    r.bib_number,",
            "    r.rider_name,",
            "    r.date_of_birth,",
            "    age_calc.age_at_race,",
            "    CASE",
            "        WHEN age_calc.age_at_race < 23 THEN 'U23'",
            "        WHEN age_calc.age_at_race BETWEEN 23 AND 25 THEN '23-25'",
            "        WHEN age_calc.age_at_race BETWEEN 26 AND 29 THEN '26-29'",
            "        ELSE '30+'",
            "    END AS age_group,",
            "    (r.date_of_birth >= DATE '2000-01-01') AS is_young_rider",
            "FROM tdf.rider AS r",
            "CROSS JOIN LATERAL (",
            "    SELECT EXTRACT(YEAR FROM age(DATE '2025-07-05', r.date_of_birth))::INTEGER AS age_at_race",
            ") AS age_calc",
            "ORDER BY rider_key ASC;",
            "",
            "-- 2.4 dw.dim_stage: denormalized start/finish location and country attributes via composite location keys",
            "INSERT INTO dw.dim_stage (",
            "    stage_key,",
            "    stage_id,",
            "    stage_order,",
            "    stage_type,",
            "    distance_km,",
            "    start_location_name,",
            "    start_country_code,",
            "    start_country_name,",
            "    finish_location_name,",
            "    finish_country_code,",
            "    finish_country_name",
            ")",
            "SELECT",
            "    s.stage_id AS stage_key,",
            "    s.stage_id,",
            "    s.stage_order,",
            "    s.stage_type,",
            "    s.distance_km,",
            "    ls.location_name AS start_location_name,",
            "    ls.country_code AS start_country_code,",
            "    cs.country_name AS start_country_name,",
            "    lf.location_name AS finish_location_name,",
            "    lf.country_code AS finish_country_code,",
            "    cf.country_name AS finish_country_name",
            "FROM tdf.stage AS s",
            "INNER JOIN tdf.location AS ls",
            "    ON ls.country_code = s.start_country_code",
            "   AND ls.location_name = s.start_location_name",
            "INNER JOIN tdf.country AS cs ON cs.country_code = ls.country_code",
            "INNER JOIN tdf.location AS lf",
            "    ON lf.country_code = s.finish_country_code",
            "   AND lf.location_name = s.finish_location_name",
            "INNER JOIN tdf.country AS cf ON cf.country_code = lf.country_code",
            "ORDER BY s.stage_id ASC;",
            "",
            "-- 2.5 dw.dim_date: calendar week separate from race_week = ((stage_order - 1) / 7) + 1",
            "INSERT INTO dw.dim_date (date_key, full_date, year, month, week, day, race_week)",
            "SELECT",
            "    TO_CHAR(s.stage_date, 'YYYYMMDD')::INTEGER AS date_key,",
            "    s.stage_date AS full_date,",
            "    EXTRACT(YEAR FROM s.stage_date)::INTEGER AS year,",
            "    EXTRACT(MONTH FROM s.stage_date)::INTEGER AS month,",
            "    EXTRACT(WEEK FROM s.stage_date)::INTEGER AS week,",
            "    EXTRACT(DAY FROM s.stage_date)::INTEGER AS day,",
            "    (((s.stage_order - 1) / 7) + 1)::INTEGER AS race_week",
            "FROM tdf.stage AS s",
            "ORDER BY s.stage_date ASC;",
            "",
            "-- 2.6 dw.fact_results: adjusted_time_seconds, stage_points_proxy, kom_points_proxy, UNK country key 0",
            "INSERT INTO dw.fact_results (",
            "    rider_key,",
            "    stage_key,",
            "    team_key,",
            "    date_key,",
            "    rider_country_key,",
            "    team_country_key,",
            "    finish_time_seconds,",
            "    time_bonus_seconds,",
            "    time_penalty_seconds,",
            "    adjusted_time_seconds,",
            "    finish_rank,",
            "    stage_points_proxy,",
            "    kom_points_proxy",
            ")",
            "SELECT",
            "    dr.rider_key,",
            "    ds.stage_key,",
            "    dt.team_key,",
            "    dd.date_key,",
            "    dc_rider.country_key AS rider_country_key,",
            "    dc_team.country_key AS team_country_key,",
            "    res.finish_time_seconds,",
            "    res.time_bonus_seconds,",
            "    res.time_penalty_seconds,",
            "    (res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) AS adjusted_time_seconds,",
            "    res.finish_rank,",
            "    CASE",
            "        WHEN ds.stage_type = 'flat' AND res.finish_rank BETWEEN 1 AND 15",
            "            THEN (ARRAY[50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2])[res.finish_rank]",
            "        WHEN ds.stage_type = 'hilly' AND res.finish_rank BETWEEN 1 AND 15",
            "            THEN (ARRAY[30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2])[res.finish_rank]",
            "        WHEN ds.stage_type IN ('mountain', 'individual time-trial') AND res.finish_rank BETWEEN 1 AND 15",
            "            THEN (ARRAY[20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])[res.finish_rank]",
            "        ELSE 0",
            "    END AS stage_points_proxy,",
            "    CASE",
            "        WHEN ds.stage_type = 'mountain' AND res.finish_rank BETWEEN 1 AND 10",
            "            THEN (ARRAY[20, 15, 12, 10, 8, 6, 4, 3, 2, 1])[res.finish_rank]",
            "        WHEN ds.stage_type = 'hilly' AND res.finish_rank BETWEEN 1 AND 5",
            "            THEN (ARRAY[10, 6, 4, 2, 1])[res.finish_rank]",
            "        ELSE 0",
            "    END AS kom_points_proxy",
            "FROM tdf.result AS res",
            "INNER JOIN tdf.rider AS r ON r.bib_number = res.bib_number",
            "INNER JOIN tdf.team AS t ON t.team_name = r.team_name",
            "INNER JOIN tdf.stage AS s ON s.stage_id = res.stage_id",
            "INNER JOIN dw.dim_rider AS dr ON dr.bib_number = r.bib_number",
            "INNER JOIN dw.dim_stage AS ds ON ds.stage_id = s.stage_id",
            "INNER JOIN dw.dim_team AS dt ON dt.team_name = r.team_name",
            "INNER JOIN dw.dim_date AS dd ON dd.full_date = s.stage_date",
            "INNER JOIN dw.dim_country AS dc_rider ON dc_rider.country_code = COALESCE(r.country_code, 'UNK')",
            "INNER JOIN dw.dim_country AS dc_team ON dc_team.country_code = t.country_code",
            "ORDER BY ds.stage_key ASC, res.finish_rank ASC, dr.rider_key ASC;",
            "",
            "-- 2.7 dw.fact_participation: 184 riders, finished_race_flag from 21-stage coverage & exit agreement",
            "INSERT INTO dw.fact_participation (",
            "    rider_key,",
            "    team_key,",
            "    rider_country_key,",
            "    team_country_key,",
            "    participant_count,",
            "    finished_race_flag,",
            "    exit_flag",
            ")",
            "SELECT",
            "    dr.rider_key,",
            "    dt.team_key,",
            "    dc_rider.country_key AS rider_country_key,",
            "    dc_team.country_key AS team_country_key,",
            "    1 AS participant_count,",
            "    CASE",
            "        WHEN COALESCE(rc.stages_completed, 0) = (SELECT COUNT(*) FROM tdf.stage) AND ex.bib_number IS NULL THEN 1",
            "        ELSE 0",
            "    END AS finished_race_flag,",
            "    CASE",
            "        WHEN ex.bib_number IS NOT NULL THEN 1",
            "        ELSE 0",
            "    END AS exit_flag",
            "FROM tdf.rider AS r",
            "INNER JOIN tdf.team AS t ON t.team_name = r.team_name",
            "INNER JOIN dw.dim_rider AS dr ON dr.bib_number = r.bib_number",
            "INNER JOIN dw.dim_team AS dt ON dt.team_name = r.team_name",
            "INNER JOIN dw.dim_country AS dc_rider ON dc_rider.country_code = COALESCE(r.country_code, 'UNK')",
            "INNER JOIN dw.dim_country AS dc_team ON dc_team.country_code = t.country_code",
            "LEFT JOIN (",
            "    SELECT bib_number, COUNT(DISTINCT stage_id) AS stages_completed",
            "    FROM tdf.result",
            "    GROUP BY bib_number",
            ") AS rc ON rc.bib_number = r.bib_number",
            "LEFT JOIN tdf.exit AS ex ON ex.bib_number = r.bib_number",
            "ORDER BY dr.rider_key ASC;",
            "",
            "COMMIT;",
            "",
        ]
    )
    return "\n".join(lines)


def build_load_script(data_dir: Path | str, output_path: Path | str) -> dict[str, int]:
    """Validate source CSVs, write PostgreSQL load script, and return summary counts."""
    bundle = load_and_validate_dataset(data_dir)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(generate_load_sql(bundle), encoding="utf-8")
    return {
        "riders": len(bundle.tdf_riders),
        "teams": len(bundle.tdf_teams),
        "stages": len(bundle.tdf_stages),
        "results": len(bundle.tdf_results),
        "exits": len(bundle.tdf_exits),
        "tdf_countries": len(bundle.tdf_countries),
        "dw_countries": len(bundle.dim_country),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate Tour de France CSVs and generate build/load.sql for tdf and dw."
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Path to directory containing riders.csv, individual_results.csv, and exits.csv",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output path for generated PostgreSQL load script (e.g. build/load.sql)",
    )
    args = parser.parse_args(argv)
    summary = build_load_script(args.data_dir, args.output)
    print(
        f"Generated {args.output}: "
        f"riders={summary['riders']}, "
        f"teams={summary['teams']}, "
        f"stages={summary['stages']}, "
        f"results={summary['results']}, "
        f"exits={summary['exits']}, "
        f"tdf_countries={summary['tdf_countries']}, "
        f"dw_countries={summary['dw_countries']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
