-- =============================================================================
-- Database Integration Verification Script for Project 3 (Phases 1-2)
-- Run after sql/001_schema.sql and build/load.sql as tdf_owner (or tdf_reader).
-- Raises an exception if any count, relational constraint, or warehouse rule fails.
-- =============================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_cnt BIGINT;
BEGIN
    -- 1. Exact row counts in normalized schema (tdf)
    SELECT COUNT(*) INTO v_cnt FROM tdf.country;
    IF v_cnt <> 29 THEN
        RAISE EXCEPTION 'Expected 29 rows in tdf.country, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.team;
    IF v_cnt <> 23 THEN
        RAISE EXCEPTION 'Expected 23 rows in tdf.team, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.rider;
    IF v_cnt <> 184 THEN
        RAISE EXCEPTION 'Expected 184 rows in tdf.rider, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.location;
    IF v_cnt <> 39 THEN
        RAISE EXCEPTION 'Expected 39 rows in tdf.location, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.stage;
    IF v_cnt <> 21 THEN
        RAISE EXCEPTION 'Expected 21 rows in tdf.stage, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.result;
    IF v_cnt <> 3602 THEN
        RAISE EXCEPTION 'Expected 3602 rows in tdf.result, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.v_result_adjusted;
    IF v_cnt <> 3602 THEN
        RAISE EXCEPTION 'Expected 3602 rows in tdf.v_result_adjusted, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.exit;
    IF v_cnt <> 24 THEN
        RAISE EXCEPTION 'Expected 24 rows in tdf.exit, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.team_leader;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Expected 0 fabricated rows in tdf.team_leader, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.classification_award;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Expected 0 fabricated rows in tdf.classification_award, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.rider_award;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Expected 0 fabricated rows in tdf.rider_award, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.team_award;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Expected 0 fabricated rows in tdf.team_award, found %', v_cnt;
    END IF;

    -- 2. Exact row counts in star warehouse schema (dw)
    SELECT COUNT(*) INTO v_cnt FROM dw.dim_country;
    IF v_cnt <> 30 THEN
        RAISE EXCEPTION 'Expected 30 rows in dw.dim_country (29 + UNK), found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.dim_team;
    IF v_cnt <> 23 THEN
        RAISE EXCEPTION 'Expected 23 rows in dw.dim_team, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.dim_rider;
    IF v_cnt <> 184 THEN
        RAISE EXCEPTION 'Expected 184 rows in dw.dim_rider, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.dim_stage;
    IF v_cnt <> 21 THEN
        RAISE EXCEPTION 'Expected 21 rows in dw.dim_stage, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.dim_date;
    IF v_cnt <> 21 THEN
        RAISE EXCEPTION 'Expected 21 rows in dw.dim_date, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.fact_results;
    IF v_cnt <> 3602 THEN
        RAISE EXCEPTION 'Expected 3602 rows in dw.fact_results, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM dw.fact_participation;
    IF v_cnt <> 184 THEN
        RAISE EXCEPTION 'Expected 184 rows in dw.fact_participation, found %', v_cnt;
    END IF;

    -- 3. NULL nationality in tdf.rider -> UNK (country_key = 0) in dw facts
    SELECT COUNT(*) INTO v_cnt FROM tdf.rider WHERE country_code IS NULL AND bib_number = 78;
    IF v_cnt <> 1 THEN
        RAISE EXCEPTION 'Expected bib_number 78 to have NULL country_code in tdf.rider';
    END IF;

    SELECT COUNT(*) INTO v_cnt FROM tdf.rider WHERE country_code IS NOT NULL;
    IF v_cnt <> 183 THEN
        RAISE EXCEPTION 'Expected 183 riders with known country_code in tdf.rider, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.dim_country
    WHERE country_key = 0 AND country_code = 'UNK' AND country_name = 'Unknown / Unspecified';
    IF v_cnt <> 1 THEN
        RAISE EXCEPTION 'Missing or invalid UNK row at dw.dim_country.country_key = 0';
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_results AS fr
    INNER JOIN dw.dim_rider AS dr ON dr.rider_key = fr.rider_key
    WHERE dr.bib_number = 78 AND fr.rider_country_key = 0 AND fr.team_country_key > 0;
    IF v_cnt <> 21 THEN
        RAISE EXCEPTION 'Expected 21 fact_results rows for bib 78 with rider_country_key = 0, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_participation AS fp
    INNER JOIN dw.dim_rider AS dr ON dr.rider_key = fp.rider_key
    WHERE dr.bib_number = 78 AND fp.rider_country_key = 0 AND fp.team_country_key > 0;
    IF v_cnt <> 1 THEN
        RAISE EXCEPTION 'Expected fact_participation row for bib 78 with rider_country_key = 0';
    END IF;

    -- 4. Stage/date alignment across rest days, composite location joins, same-city endpoints, and race_week
    SELECT COUNT(*) INTO v_cnt
    FROM tdf.stage
    WHERE (stage_id = 10 AND stage_order = 10 AND stage_date = DATE '2025-07-14')
       OR (stage_id = 11 AND stage_order = 11 AND stage_date = DATE '2025-07-16')
       OR (stage_id = 15 AND stage_order = 15 AND stage_date = DATE '2025-07-20')
       OR (stage_id = 16 AND stage_order = 16 AND stage_date = DATE '2025-07-22');
    IF v_cnt <> 4 THEN
        RAISE EXCEPTION 'Stage date alignment across rest days (July 15 and July 21) failed';
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM tdf.stage AS s
    INNER JOIN dw.dim_stage AS ds ON ds.stage_id = s.stage_id
    WHERE ds.stage_order <> s.stage_order
       OR ds.start_country_code <> s.start_country_code
       OR ds.start_location_name <> s.start_location_name
       OR ds.finish_country_code <> s.finish_country_code
       OR ds.finish_location_name <> s.finish_location_name;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Composite location identity mismatch between tdf.stage and dw.dim_stage';
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.dim_stage
    WHERE (stage_id = 1 AND start_country_code = 'FRA' AND start_location_name = 'Lille Métropole' AND finish_country_code = 'FRA' AND finish_location_name = 'Lille Métropole')
       OR (stage_id = 5 AND start_country_code = 'FRA' AND start_location_name = 'Caen' AND finish_country_code = 'FRA' AND finish_location_name = 'Caen')
       OR (stage_id = 11 AND start_country_code = 'FRA' AND start_location_name = 'Toulouse' AND finish_country_code = 'FRA' AND finish_location_name = 'Toulouse');
    IF v_cnt <> 3 THEN
        RAISE EXCEPTION 'Same-city stage endpoints for stages 1, 5, 11 failed verification';
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.dim_date AS dd
    INNER JOIN tdf.stage AS s ON s.stage_date = dd.full_date
    INNER JOIN dw.dim_stage AS ds ON ds.stage_id = s.stage_id
    WHERE dd.race_week <> (((ds.stage_order - 1) / 7) + 1)
       OR dd.week <> EXTRACT(WEEK FROM dd.full_date)::INTEGER
       OR dd.race_week = dd.week;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'race_week or calendar week calculation mismatch in dw.dim_date';
    END IF;

    -- 5. Age cutoff vs age_group distinction
    SELECT COUNT(*) INTO v_cnt
    FROM dw.dim_rider
    WHERE age_group = '23-25' AND is_young_rider = FALSE AND date_of_birth < DATE '2000-01-01';
    IF v_cnt = 0 THEN
        RAISE EXCEPTION 'Expected riders aged 25 on 2025-07-05 born in 1999 to have age_group=23-25 and is_young_rider=FALSE';
    END IF;

    -- 6. Proxy scoring and adjusted_time_seconds verification across all 3,602 rows
    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_results AS fr
    INNER JOIN dw.dim_stage AS ds ON ds.stage_key = fr.stage_key
    WHERE fr.adjusted_time_seconds <> (fr.finish_time_seconds - fr.time_bonus_seconds + fr.time_penalty_seconds)
       OR fr.stage_points_proxy <> (
            CASE
                WHEN ds.stage_type = 'flat' AND fr.finish_rank BETWEEN 1 AND 15
                    THEN (ARRAY[50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2])[fr.finish_rank]
                WHEN ds.stage_type = 'hilly' AND fr.finish_rank BETWEEN 1 AND 15
                    THEN (ARRAY[30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2])[fr.finish_rank]
                WHEN ds.stage_type IN ('mountain', 'individual time-trial') AND fr.finish_rank BETWEEN 1 AND 15
                    THEN (ARRAY[20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])[fr.finish_rank]
                ELSE 0
            END
       )
       OR fr.kom_points_proxy <> (
            CASE
                WHEN ds.stage_type = 'mountain' AND fr.finish_rank BETWEEN 1 AND 10
                    THEN (ARRAY[20, 15, 12, 10, 8, 6, 4, 3, 2, 1])[fr.finish_rank]
                WHEN ds.stage_type = 'hilly' AND fr.finish_rank BETWEEN 1 AND 5
                    THEN (ARRAY[10, 6, 4, 2, 1])[fr.finish_rank]
                ELSE 0
            END
       );
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Found % rows in dw.fact_results with mismatched adjusted_time or proxy points', v_cnt;
    END IF;

    -- 7. Participation states agreement with 21-stage coverage and tdf.exit
    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_participation
    WHERE finished_race_flag = 1 AND exit_flag = 0;
    IF v_cnt <> 160 THEN
        RAISE EXCEPTION 'Expected 160 finishers in dw.fact_participation, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_participation
    WHERE finished_race_flag = 0 AND exit_flag = 1;
    IF v_cnt <> 24 THEN
        RAISE EXCEPTION 'Expected 24 exited riders in dw.fact_participation, found %', v_cnt;
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM dw.fact_participation AS fp
    INNER JOIN dw.dim_rider AS dr ON dr.rider_key = fp.rider_key
    LEFT JOIN (
        SELECT rider_key, COUNT(DISTINCT stage_key) AS stage_cnt
        FROM dw.fact_results
        GROUP BY rider_key
    ) AS rc ON rc.rider_key = fp.rider_key
    LEFT JOIN tdf.exit AS ex ON ex.bib_number = dr.bib_number
    WHERE (fp.finished_race_flag = 1 AND (COALESCE(rc.stage_cnt, 0) <> 21 OR ex.bib_number IS NOT NULL))
       OR (fp.exit_flag = 1 AND (COALESCE(rc.stage_cnt, 0) = 21 OR ex.bib_number IS NULL));
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'Participation flags disagree with 21-stage coverage or tdf.exit for % riders', v_cnt;
    END IF;

    -- 8. Accented characters and apostrophe round-trip verification
    SELECT COUNT(*) INTO v_cnt
    FROM dw.dim_rider
    WHERE (bib_number = 121 AND rider_name = 'Ben O''Connor')
       OR (bib_number = 131 AND rider_name = 'Kévin Vauquelin')
       OR (bib_number = 151 AND rider_name = 'Félix Gall');
    IF v_cnt <> 3 THEN
        RAISE EXCEPTION 'UTF-8 accent or apostrophe round-trip check failed in dw.dim_rider';
    END IF;
END
$$;

SELECT
    (SELECT COUNT(*) FROM tdf.country) AS tdf_countries,
    (SELECT COUNT(*) FROM tdf.team) AS tdf_teams,
    (SELECT COUNT(*) FROM tdf.rider) AS tdf_riders,
    (SELECT COUNT(*) FROM tdf.location) AS tdf_locations,
    (SELECT COUNT(*) FROM tdf.stage) AS tdf_stages,
    (SELECT COUNT(*) FROM tdf.result) AS tdf_results,
    (SELECT COUNT(*) FROM tdf.exit) AS tdf_exits,
    (SELECT COUNT(*) FROM dw.dim_country) AS dw_countries,
    (SELECT COUNT(*) FROM dw.dim_team) AS dw_teams,
    (SELECT COUNT(*) FROM dw.dim_rider) AS dw_riders,
    (SELECT COUNT(*) FROM dw.dim_stage) AS dw_stages,
    (SELECT COUNT(*) FROM dw.dim_date) AS dw_dates,
    (SELECT COUNT(*) FROM dw.fact_results) AS dw_fact_results,
    (SELECT COUNT(*) FROM dw.fact_participation) AS dw_fact_participation;
