-- =============================================================================
-- Project 3: Analytical Layer Verification Suite (Phase 3)
-- Target schema: dw
-- =============================================================================
-- Run after sql/001_schema.sql, warehouse ETL load, and sql/003_analytics.sql:
--   psql -v ON_ERROR_STOP=1 -f sql/verify_analytics.sql
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- Winner reference must follow recorded rank, even when a later placing was timed faster.
DO $$
DECLARE
    winner record;
    detail record;
BEGIN
    SELECT * INTO STRICT winner FROM dw.stage_summary('{"stage_ids":[21]}');
    SELECT * INTO STRICT detail FROM dw.rider_stage_results(jsonb_build_object(
        'stage_ids', jsonb_build_array(21), 'rider_keys', jsonb_build_array(winner.winner_rider_key)));
    ASSERT detail.finish_rank = 1 AND detail.finish_time_seconds = 11250;
    ASSERT detail.gap_seconds = 0 AND detail.adjusted_gap_seconds = 0;
    ASSERT winner.winning_finish_time_seconds = detail.finish_time_seconds;
    ASSERT winner.winning_adjusted_time_seconds = detail.adjusted_time_seconds;
    ASSERT EXISTS (SELECT 1 FROM dw.rider_stage_results('{"stage_ids":[21]}') WHERE gap_seconds = -9);
END $$;

-- 1. Source-control GC winner (bib 1, total_seconds = 277349) & 160 finishers
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_finisher_count integer;
    v_winner_bib integer;
    v_winner_seconds integer;
    v_winner_gap integer;
    v_winner_stage_count integer;
    v_winner_pct numeric(5, 2);
    v_finish_basis_seconds integer;
BEGIN
    SELECT COUNT(*)::integer
    INTO v_finisher_count
    FROM dw.rider_standings('{"classification":"gc","stage_scope":"final","time_basis":"adjusted","rank_scope":"overall"}'::jsonb);

    IF v_finisher_count <> 160 THEN
        RAISE EXCEPTION 'Expected 160 eligible GC finishers in final adjusted standings, got %', v_finisher_count;
    END IF;

    SELECT bib_number, total_seconds, gap_seconds, stage_count, rank_percentile
    INTO v_winner_bib, v_winner_seconds, v_winner_gap, v_winner_stage_count, v_winner_pct
    FROM dw.rider_standings('{}'::jsonb)
    WHERE rank = 1;

    IF v_winner_bib <> 1 OR v_winner_seconds <> 277349 OR v_winner_gap <> 0 OR v_winner_stage_count <> 21 OR v_winner_pct <> 100.00 THEN
        RAISE EXCEPTION 'Unexpected final adjusted GC winner metrics: bib=%, total_seconds=%, gap=%, stages=%, pct=%',
            v_winner_bib, v_winner_seconds, v_winner_gap, v_winner_stage_count, v_winner_pct;
    END IF;

    SELECT total_seconds
    INTO v_finish_basis_seconds
    FROM dw.rider_standings('{"classification":"gc","stage_scope":"final","time_basis":"finish"}'::jsonb)
    WHERE bib_number = 1;

    IF v_finish_basis_seconds IS NULL OR v_finish_basis_seconds <= v_winner_seconds THEN
        RAISE EXCEPTION 'Expected finish time_basis total_seconds (%) for bib 1 to exceed adjusted total_seconds (%) due to bonuses',
            v_finish_basis_seconds, v_winner_seconds;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Country participation (183 known nationality riders, 23 teams, UNK handling)
--    and team_depth (23 teams, 184 participants, 160 finishers, no fanout)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_unk_rows integer;
    v_known_riders integer;
    v_total_teams integer;
    v_zero_role_countries integer;
    v_zero_rider_null_rate_rows integer;
    v_zero_rider_nonnull_rate_rows integer;
    v_pos_rider_null_rate_rows integer;
    v_depth_teams integer;
    v_depth_participants integer;
    v_depth_finishers integer;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE country_code = 'UNK' OR country_key = 0)::integer,
        COALESCE(SUM(rider_count), 0)::integer,
        COALESCE(SUM(team_count), 0)::integer,
        COUNT(*) FILTER (WHERE rider_count = 0 OR team_count = 0)::integer,
        COUNT(*) FILTER (WHERE rider_count = 0 AND finisher_rate IS NULL)::integer,
        COUNT(*) FILTER (WHERE rider_count = 0 AND finisher_rate IS NOT NULL)::integer,
        COUNT(*) FILTER (WHERE rider_count > 0 AND finisher_rate IS NULL)::integer
    INTO
        v_unk_rows, v_known_riders, v_total_teams, v_zero_role_countries,
        v_zero_rider_null_rate_rows, v_zero_rider_nonnull_rate_rows, v_pos_rider_null_rate_rows
    FROM dw.country_participation('{}'::jsonb);

    IF v_unk_rows <> 0 THEN
        RAISE EXCEPTION 'Expected UNK (country_key=0) to be excluded from dw.country_participation, found % rows', v_unk_rows;
    END IF;

    IF v_known_riders <> 183 THEN
        RAISE EXCEPTION 'Expected 183 riders with known nationality in dw.country_participation, got %', v_known_riders;
    END IF;

    IF v_total_teams <> 23 THEN
        RAISE EXCEPTION 'Expected 23 teams across team registration countries in dw.country_participation, got %', v_total_teams;
    END IF;

    IF v_zero_role_countries <= 0 THEN
        RAISE EXCEPTION 'Expected known country universe to include countries with 0 riders or 0 teams, got %', v_zero_role_countries;
    END IF;

    IF v_zero_rider_null_rate_rows <= 0 OR v_zero_rider_nonnull_rate_rows <> 0 OR v_pos_rider_null_rate_rows <> 0 THEN
        RAISE EXCEPTION 'dw.country_participation finisher_rate NULL semantics violated: zero_rider_null_rate=%, zero_rider_nonnull_rate=%, pos_rider_null_rate=%',
            v_zero_rider_null_rate_rows, v_zero_rider_nonnull_rate_rows, v_pos_rider_null_rate_rows;
    END IF;

    SELECT
        COUNT(*)::integer,
        COALESCE(SUM(participants), 0)::integer,
        COALESCE(SUM(finishers), 0)::integer
    INTO v_depth_teams, v_depth_participants, v_depth_finishers
    FROM dw.team_depth('{}'::jsonb);

    IF v_depth_teams <> 23 OR v_depth_participants <> 184 OR v_depth_finishers <> 160 THEN
        RAISE EXCEPTION 'dw.team_depth fanout or count mismatch: teams=% (expected 23), participants=% (expected 184), finishers=% (expected 160)',
            v_depth_teams, v_depth_participants, v_depth_finishers;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. NULL/UNK nationality rider (#78 Aleksandr Vlasov) retained in performance
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_rider78_key integer;
    v_rider78_team_key integer;
    v_rider78_team_country_key integer;
    v_gc_rows integer;
    v_stage_rows integer;
    v_spec_samples integer;
    v_team_country_riders integer;
    v_team_country_teams integer;
    v_team_country_rate numeric(6, 4);
BEGIN
    SELECT dr.rider_key, fp.team_key, fp.team_country_key
    INTO v_rider78_key, v_rider78_team_key, v_rider78_team_country_key
    FROM dw.dim_rider dr
    JOIN dw.fact_participation fp ON fp.rider_key = dr.rider_key
    WHERE dr.bib_number = 78;

    IF v_rider78_key IS NULL THEN
        RAISE EXCEPTION 'Rider bib 78 not found in dw.dim_rider';
    END IF;

    SELECT COUNT(*)::integer
    INTO v_gc_rows
    FROM dw.rider_standings('{}'::jsonb)
    WHERE bib_number = 78 AND stage_count = 21;

    IF v_gc_rows <> 1 THEN
        RAISE EXCEPTION 'Expected bib 78 to be retained in final dw.rider_standings with 21 stages, found % rows', v_gc_rows;
    END IF;

    SELECT COUNT(*)::integer
    INTO v_stage_rows
    FROM dw.rider_stage_results(jsonb_build_object('rider_keys', jsonb_build_array(v_rider78_key)))
    WHERE bib_number = 78 AND rider_country_code = 'UNK';

    IF v_stage_rows <> 21 THEN
        RAISE EXCEPTION 'Expected 21 stage result rows for bib 78 with rider_country_code=UNK, got %', v_stage_rows;
    END IF;

    SELECT COALESCE(SUM(sample_count), 0)::integer
    INTO v_spec_samples
    FROM dw.rider_specialisation(jsonb_build_object('rider_keys', jsonb_build_array(v_rider78_key)));

    IF v_spec_samples <> 21 THEN
        RAISE EXCEPTION 'Expected 21 total specialisation stage samples for bib 78, got %', v_spec_samples;
    END IF;

    -- Filtering country_participation to rider #78 alone must still retain his team's country contribution
    -- while keeping rider_count = 0 and finisher_rate IS NULL
    SELECT rider_count, team_count, finisher_rate
    INTO v_team_country_riders, v_team_country_teams, v_team_country_rate
    FROM dw.country_participation(jsonb_build_object('rider_keys', jsonb_build_array(v_rider78_key)))
    WHERE country_key = v_rider78_team_country_key;

    IF v_team_country_riders <> 0 OR v_team_country_teams <> 1 OR v_team_country_rate IS NOT NULL THEN
        RAISE EXCEPTION 'Expected rider 78 team country row to have rider_count=0, team_count=1, finisher_rate=NULL; got riders=%, teams=%, rate=%',
            v_team_country_riders, v_team_country_teams, v_team_country_rate;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. Perfect consistency across scopes: final vs as_of=21 vs selection=[1..21]
--    plus empty selection returning 0 rows and final/as_of ignoring ad hoc subsets
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_diff_rider_asof integer;
    v_diff_rider_sel integer;
    v_diff_team_asof integer;
    v_diff_team_sel integer;
    v_empty_rows integer;
    v_final_ignore_subset_stages integer;
BEGIN
    SELECT COUNT(*)::integer
    INTO v_diff_rider_asof
    FROM (
        (
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"final"}'::jsonb)
            EXCEPT
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"as_of","as_of_stage":21}'::jsonb)
        )
        UNION ALL
        (
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"as_of","as_of_stage":21}'::jsonb)
            EXCEPT
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"final"}'::jsonb)
        )
    ) d;

    IF v_diff_rider_asof <> 0 THEN
        RAISE EXCEPTION 'Mismatch between dw.rider_standings final and as_of=21: % differing rows', v_diff_rider_asof;
    END IF;

    SELECT COUNT(*)::integer
    INTO v_diff_rider_sel
    FROM (
        (
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"final"}'::jsonb)
            EXCEPT
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"selection","stage_ids":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]}'::jsonb)
        )
        UNION ALL
        (
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"selection","stage_ids":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]}'::jsonb)
            EXCEPT
            SELECT rider_key, bib_number, stage_count, total_seconds, points, rank, gap_seconds, rank_percentile
            FROM dw.rider_standings('{"stage_scope":"final"}'::jsonb)
        )
    ) d;

    IF v_diff_rider_sel <> 0 THEN
        RAISE EXCEPTION 'Mismatch between dw.rider_standings final and selection=[1..21]: % differing rows', v_diff_rider_sel;
    END IF;

    SELECT COUNT(*)::integer
    INTO v_diff_team_asof
    FROM (
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"final"}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"as_of","as_of_stage":21}'::jsonb)
        )
        UNION ALL
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"as_of","as_of_stage":21}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"final"}'::jsonb)
        )
    ) d;

    IF v_diff_team_asof <> 0 THEN
        RAISE EXCEPTION 'Mismatch between dw.team_standings final and as_of=21: % differing rows', v_diff_team_asof;
    END IF;

    SELECT COUNT(*)::integer
    INTO v_diff_team_sel
    FROM (
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"final"}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"selection","stage_ids":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]}'::jsonb)
        )
        UNION ALL
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"selection","stage_ids":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"stage_scope":"final"}'::jsonb)
        )
    ) d;

    IF v_diff_team_sel <> 0 THEN
        RAISE EXCEPTION 'Mismatch between dw.team_standings final and selection=[1..21]: % differing rows', v_diff_team_sel;
    END IF;

    -- final must ignore ad hoc stage_ids for cumulative GC
    SELECT MIN(stage_count)::integer
    INTO v_final_ignore_subset_stages
    FROM dw.rider_standings('{"stage_scope":"final","stage_ids":[1,2]}'::jsonb);

    IF v_final_ignore_subset_stages <> 21 THEN
        RAISE EXCEPTION 'Expected stage_scope=final to ignore ad hoc stage_ids and use 21 stages, got %', v_final_ignore_subset_stages;
    END IF;

    -- Empty array selections must return 0 rows
    SELECT (
        (SELECT COUNT(*) FROM dw.rider_standings('{"stage_scope":"selection","stage_ids":[]}'::jsonb))
        + (SELECT COUNT(*) FROM dw.rider_standings('{"rider_keys":[]}'::jsonb))
        + (SELECT COUNT(*) FROM dw.team_standings('{"team_keys":[]}'::jsonb))
        + (SELECT COUNT(*) FROM dw.team_standings('{"rider_keys":[]}'::jsonb))
        + (SELECT COUNT(*) FROM dw.rider_stage_results('{"stage_ids":[]}'::jsonb))
        + (SELECT COUNT(*) FROM dw.stage_summary('{"stage_ids":[]}'::jsonb))
    )::integer
    INTO v_empty_rows;

    IF v_empty_rows <> 0 THEN
        RAISE EXCEPTION 'Expected empty selection arrays to return 0 rows, got % total rows', v_empty_rows;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Targeted overall vs filtered rank check (riders and teams)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_rank2_rider_key integer;
    v_rank3_rider_key integer;
    v_overall_rank integer;
    v_overall_gap integer;
    v_overall_pct numeric(5, 2);
    v_filtered_rank integer;
    v_filtered_gap integer;
    v_filtered_pct numeric(5, 2);
    v_rank2_team_key integer;
    v_rank2_team_seconds integer;
    v_rank2_team_contributors integer;
    v_rank2_team_rider_key integer;
    v_team_overall_rank integer;
    v_team_overall_gap integer;
    v_team_overall_seconds integer;
    v_team_overall_contributors integer;
    v_team_filtered_rank integer;
    v_team_filtered_gap integer;
    v_team_filtered_seconds integer;
    v_team_filtered_contributors integer;
    v_rider1_key integer;
    v_rider1_is_young boolean;
    v_rider1_team_key integer;
    v_r1_unfiltered_sec integer;
    v_r1_unfiltered_rk integer;
    v_r1_unfiltered_gap integer;
    v_r1_unfiltered_contrib integer;
    v_r1_overall_sec integer;
    v_r1_overall_rk integer;
    v_r1_overall_gap integer;
    v_r1_overall_contrib integer;
    v_r1_filtered_sec integer;
    v_r1_filtered_rk integer;
    v_r1_filtered_gap integer;
    v_r1_filtered_contrib integer;
    v_r1_cum_unfiltered_sec integer;
    v_r1_cum_overall_sec integer;
    v_r1_cum_filtered_sec integer;
    v_r1_cum_filtered_rk integer;
    v_r1_young_mismatch_rows integer;
BEGIN
    SELECT rider_key INTO v_rank2_rider_key FROM dw.rider_standings('{}'::jsonb) WHERE rank = 2 ORDER BY rider_key LIMIT 1;
    SELECT rider_key INTO v_rank3_rider_key FROM dw.rider_standings('{}'::jsonb) WHERE rank = 3 ORDER BY rider_key LIMIT 1;

    SELECT rank, gap_seconds, rank_percentile
    INTO v_overall_rank, v_overall_gap, v_overall_pct
    FROM dw.rider_standings(
        jsonb_build_object(
            'rank_scope', 'overall',
            'rider_keys', jsonb_build_array(v_rank2_rider_key, v_rank3_rider_key)
        )
    )
    WHERE rider_key = v_rank2_rider_key;

    SELECT rank, gap_seconds, rank_percentile
    INTO v_filtered_rank, v_filtered_gap, v_filtered_pct
    FROM dw.rider_standings(
        jsonb_build_object(
            'rank_scope', 'filtered',
            'rider_keys', jsonb_build_array(v_rank2_rider_key, v_rank3_rider_key)
        )
    )
    WHERE rider_key = v_rank2_rider_key;

    IF v_overall_rank <> 2 OR v_overall_gap <= 0 OR v_overall_pct >= 100.00 THEN
        RAISE EXCEPTION 'Expected overall rank=2 with gap>0 and pct<100 for global 2nd place rider, got rank=%, gap=%, pct=%',
            v_overall_rank, v_overall_gap, v_overall_pct;
    END IF;

    IF v_filtered_rank <> 1 OR v_filtered_gap <> 0 OR v_filtered_pct <> 100.00 THEN
        RAISE EXCEPTION 'Expected filtered rank=1 with gap=0 and pct=100 for top rider in filtered subset, got rank=%, gap=%, pct=%',
            v_filtered_rank, v_filtered_gap, v_filtered_pct;
    END IF;

    -- Team overall vs filtered check (by team_keys and by single rider_keys selection)
    SELECT team_key, total_seconds, contributor_count
    INTO v_rank2_team_key, v_rank2_team_seconds, v_rank2_team_contributors
    FROM dw.team_standings('{}'::jsonb)
    WHERE rank = 2
    ORDER BY team_key
    LIMIT 1;

    SELECT fp.rider_key
    INTO v_rank2_team_rider_key
    FROM dw.fact_participation fp
    WHERE fp.team_key = v_rank2_team_key
    ORDER BY fp.rider_key
    LIMIT 1;

    SELECT rank, gap_seconds, total_seconds, contributor_count
    INTO v_team_overall_rank, v_team_overall_gap, v_team_overall_seconds, v_team_overall_contributors
    FROM dw.team_standings(jsonb_build_object('rank_scope', 'overall', 'rider_keys', jsonb_build_array(v_rank2_team_rider_key)));

    SELECT rank, gap_seconds, total_seconds, contributor_count
    INTO v_team_filtered_rank, v_team_filtered_gap, v_team_filtered_seconds, v_team_filtered_contributors
    FROM dw.team_standings(jsonb_build_object('rank_scope', 'filtered', 'rider_keys', jsonb_build_array(v_rank2_team_rider_key)));

    IF v_team_overall_rank <> 2 OR v_team_overall_gap <= 0
       OR v_team_overall_seconds <> v_rank2_team_seconds
       OR v_team_overall_contributors <> v_rank2_team_contributors
       OR v_team_filtered_rank <> 1 OR v_team_filtered_gap <> 0
       OR v_team_filtered_seconds <> v_rank2_team_seconds
       OR v_team_filtered_contributors <> v_rank2_team_contributors THEN
        RAISE EXCEPTION 'Team overall vs filtered rider selection check failed: overall=(rank %, gap %, sec %, contrib %), filtered=(rank %, gap %, sec %, contrib %)',
            v_team_overall_rank, v_team_overall_gap, v_team_overall_seconds, v_team_overall_contributors,
            v_team_filtered_rank, v_team_filtered_gap, v_team_filtered_seconds, v_team_filtered_contributors;
    END IF;

    -- Rider #1 (bib 1) single-rider selection in dw.team_standings must return his team's full score/rank in overall mode and rank 1 in filtered mode
    SELECT dr.rider_key, dr.is_young_rider, fp.team_key
    INTO v_rider1_key, v_rider1_is_young, v_rider1_team_key
    FROM dw.dim_rider dr
    JOIN dw.fact_participation fp ON fp.rider_key = dr.rider_key
    WHERE dr.bib_number = 1;

    SELECT total_seconds, rank, gap_seconds, contributor_count
    INTO v_r1_unfiltered_sec, v_r1_unfiltered_rk, v_r1_unfiltered_gap, v_r1_unfiltered_contrib
    FROM dw.team_standings('{"team_aggregation":"stage_top3"}'::jsonb)
    WHERE team_key = v_rider1_team_key;

    SELECT total_seconds, rank, gap_seconds, contributor_count
    INTO v_r1_overall_sec, v_r1_overall_rk, v_r1_overall_gap, v_r1_overall_contrib
    FROM dw.team_standings(jsonb_build_object('team_aggregation', 'stage_top3', 'rank_scope', 'overall', 'rider_keys', jsonb_build_array(v_rider1_key)));

    SELECT total_seconds, rank, gap_seconds, contributor_count
    INTO v_r1_filtered_sec, v_r1_filtered_rk, v_r1_filtered_gap, v_r1_filtered_contrib
    FROM dw.team_standings(jsonb_build_object('team_aggregation', 'stage_top3', 'rank_scope', 'filtered', 'rider_keys', jsonb_build_array(v_rider1_key)));

    IF v_r1_overall_sec <> v_r1_unfiltered_sec OR v_r1_overall_rk <> v_r1_unfiltered_rk
       OR v_r1_overall_gap <> v_r1_unfiltered_gap OR v_r1_overall_contrib <> v_r1_unfiltered_contrib
       OR v_r1_filtered_sec <> v_r1_unfiltered_sec OR v_r1_filtered_rk <> 1
       OR v_r1_filtered_gap <> 0 OR v_r1_filtered_contrib <> v_r1_unfiltered_contrib THEN
        RAISE EXCEPTION 'Rider #1 team_standings stage_top3 mismatch: unfiltered=(sec %, rk %, gap %, contrib %), overall=(sec %, rk %, gap %, contrib %), filtered=(sec %, rk %, gap %, contrib %)',
            v_r1_unfiltered_sec, v_r1_unfiltered_rk, v_r1_unfiltered_gap, v_r1_unfiltered_contrib,
            v_r1_overall_sec, v_r1_overall_rk, v_r1_overall_gap, v_r1_overall_contrib,
            v_r1_filtered_sec, v_r1_filtered_rk, v_r1_filtered_gap, v_r1_filtered_contrib;
    END IF;

    SELECT total_seconds
    INTO v_r1_cum_unfiltered_sec
    FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb)
    WHERE team_key = v_rider1_team_key;

    SELECT total_seconds
    INTO v_r1_cum_overall_sec
    FROM dw.team_standings(jsonb_build_object('team_aggregation', 'cumulative_top3', 'rank_scope', 'overall', 'rider_keys', jsonb_build_array(v_rider1_key)));

    SELECT total_seconds, rank
    INTO v_r1_cum_filtered_sec, v_r1_cum_filtered_rk
    FROM dw.team_standings(jsonb_build_object('team_aggregation', 'cumulative_top3', 'rank_scope', 'filtered', 'rider_keys', jsonb_build_array(v_rider1_key)));

    IF v_r1_cum_overall_sec <> v_r1_cum_unfiltered_sec OR v_r1_cum_filtered_sec <> v_r1_cum_unfiltered_sec OR v_r1_cum_filtered_rk <> 1 THEN
        RAISE EXCEPTION 'Rider #1 team_standings cumulative_top3 mismatch: unfiltered=%, overall=%, filtered=(sec %, rk %)',
            v_r1_cum_unfiltered_sec, v_r1_cum_overall_sec, v_r1_cum_filtered_sec, v_r1_cum_filtered_rk;
    END IF;

    -- Combined AND for same member: if rider #1 is not a young rider, selecting rider #1 + young_only=true must return 0 teams
    IF NOT v_rider1_is_young THEN
        SELECT COUNT(*)::integer
        INTO v_r1_young_mismatch_rows
        FROM dw.team_standings(jsonb_build_object('rider_keys', jsonb_build_array(v_rider1_key), 'young_only', true));

        IF v_r1_young_mismatch_rows <> 0 THEN
            RAISE EXCEPTION 'Expected 0 teams when combining non-young rider #1 with young_only=true, got %', v_r1_young_mismatch_rows;
        END IF;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 6. Two team aggregation methods (stage_top3 & cumulative_top3) independently derived
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_stage_top3_diff integer;
    v_cum_top3_diff integer;
    v_stage_top3_count integer;
    v_cum_top3_count integer;
    v_bad_cum_contributors integer;
BEGIN
    SELECT COUNT(*)::integer INTO v_stage_top3_count FROM dw.team_standings('{"team_aggregation":"stage_top3"}'::jsonb);
    SELECT COUNT(*)::integer INTO v_cum_top3_count FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb);

    IF v_stage_top3_count <> 23 OR v_cum_top3_count <> 23 THEN
        RAISE EXCEPTION 'Expected 23 teams in unfiltered stage_top3 (%) and cumulative_top3 (%) standings',
            v_stage_top3_count, v_cum_top3_count;
    END IF;
    -- Independent derivation of stage_top3
    WITH ranked_per_stage AS (
        SELECT
            fr.team_key,
            fr.stage_key,
            fr.rider_key,
            fr.adjusted_time_seconds,
            ROW_NUMBER() OVER (
                PARTITION BY fr.team_key, fr.stage_key
                ORDER BY fr.adjusted_time_seconds ASC, fr.rider_key ASC
            ) AS rn,
            COUNT(*) OVER (PARTITION BY fr.team_key, fr.stage_key) AS team_stage_cnt
        FROM dw.fact_results fr
    ),
    expected_stage_top3 AS (
        SELECT
            team_key,
            SUM(adjusted_time_seconds)::integer AS total_seconds,
            RANK() OVER (ORDER BY SUM(adjusted_time_seconds) ASC)::integer AS rank,
            (SUM(adjusted_time_seconds) - MIN(SUM(adjusted_time_seconds)) OVER ())::integer AS gap_seconds,
            COUNT(DISTINCT stage_key)::integer AS stage_count,
            COUNT(DISTINCT rider_key)::integer AS contributor_count
        FROM ranked_per_stage
        WHERE team_stage_cnt >= 3 AND rn <= 3
        GROUP BY team_key
        HAVING COUNT(DISTINCT stage_key) = 21 AND COUNT(*) = 63
    )
    SELECT COUNT(*)::integer
    INTO v_stage_top3_diff
    FROM (
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"team_aggregation":"stage_top3"}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM expected_stage_top3
        )
        UNION ALL
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM expected_stage_top3
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"team_aggregation":"stage_top3"}'::jsonb)
        )
    ) d;

    IF v_stage_top3_diff <> 0 THEN
        RAISE EXCEPTION 'dw.team_standings stage_top3 diverged from independent derivation (% rows)', v_stage_top3_diff;
    END IF;

    -- Independent derivation of cumulative_top3
    WITH complete_riders AS (
        SELECT
            fr.team_key,
            fr.rider_key,
            SUM(fr.adjusted_time_seconds)::integer AS rider_seconds
        FROM dw.fact_results fr
        GROUP BY fr.team_key, fr.rider_key
        HAVING COUNT(DISTINCT fr.stage_key) = 21
    ),
    ranked_riders AS (
        SELECT
            team_key,
            rider_key,
            rider_seconds,
            ROW_NUMBER() OVER (
                PARTITION BY team_key
                ORDER BY rider_seconds ASC, rider_key ASC
            ) AS rn
        FROM complete_riders
    ),
    expected_cum_top3 AS (
        SELECT
            team_key,
            SUM(rider_seconds)::integer AS total_seconds,
            RANK() OVER (ORDER BY SUM(rider_seconds) ASC)::integer AS rank,
            (SUM(rider_seconds) - MIN(SUM(rider_seconds)) OVER ())::integer AS gap_seconds,
            21::integer AS stage_count,
            COUNT(DISTINCT rider_key)::integer AS contributor_count
        FROM ranked_riders
        WHERE rn <= 3
        GROUP BY team_key
        HAVING COUNT(*) = 3
    )
    SELECT COUNT(*)::integer
    INTO v_cum_top3_diff
    FROM (
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb)
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM expected_cum_top3
        )
        UNION ALL
        (
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM expected_cum_top3
            EXCEPT
            SELECT team_key, total_seconds, rank, gap_seconds, stage_count, contributor_count
            FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb)
        )
    ) d;

    IF v_cum_top3_diff <> 0 THEN
        RAISE EXCEPTION 'dw.team_standings cumulative_top3 diverged from independent derivation (% rows)', v_cum_top3_diff;
    END IF;

    SELECT COUNT(*) FILTER (WHERE contributor_count <> 3)::integer
    INTO v_bad_cum_contributors
    FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb);

    IF v_bad_cum_contributors <> 0 THEN
        RAISE EXCEPTION 'Expected all cumulative_top3 teams to have contributor_count = 3, found % exceptions', v_bad_cum_contributors;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 7. Proxy classifications & stage proxy max/pattern checks, young & mountain_time
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_flat_max_pts integer;
    v_hilly_max_pts integer;
    v_mtn_max_pts integer;
    v_itt_max_pts integer;
    v_pts_outside_top15 integer;
    v_mtn_max_kom integer;
    v_hilly_max_kom integer;
    v_other_max_kom integer;
    v_points_rank_mismatch integer;
    v_kom_rank_mismatch integer;
    v_points_nonnull_gaps integer;
    v_kom_nonnull_gaps integer;
    v_proxy_null_totals integer;
    v_time_mode_null_gaps integer;
    v_non_young_in_young integer;
    v_mtn_time_finishers integer;
    v_mtn_stage_count integer;
    v_expected_mtn_stages integer;
BEGIN
    SELECT
        MAX(stage_points_proxy) FILTER (WHERE stage_type = 'flat'),
        MAX(stage_points_proxy) FILTER (WHERE stage_type = 'hilly'),
        MAX(stage_points_proxy) FILTER (WHERE stage_type = 'mountain'),
        MAX(stage_points_proxy) FILTER (WHERE stage_type = 'individual time-trial'),
        COUNT(*) FILTER (WHERE finish_rank > 15 AND stage_points_proxy <> 0),
        MAX(kom_points_proxy) FILTER (WHERE stage_type = 'mountain'),
        MAX(kom_points_proxy) FILTER (WHERE stage_type = 'hilly'),
        MAX(kom_points_proxy) FILTER (WHERE stage_type IN ('flat', 'individual time-trial'))
    INTO
        v_flat_max_pts, v_hilly_max_pts, v_mtn_max_pts, v_itt_max_pts,
        v_pts_outside_top15, v_mtn_max_kom, v_hilly_max_kom, v_other_max_kom
    FROM dw.rider_stage_results('{}'::jsonb);

    IF v_flat_max_pts <> 50 OR v_hilly_max_pts <> 30 OR v_mtn_max_pts <> 20 OR v_itt_max_pts <> 20 OR v_pts_outside_top15 <> 0 THEN
        RAISE EXCEPTION 'Stage points proxy pattern mismatch: flat=%, hilly=%, mtn=%, itt=%, outside_top15=%',
            v_flat_max_pts, v_hilly_max_pts, v_mtn_max_pts, v_itt_max_pts, v_pts_outside_top15;
    END IF;

    IF v_mtn_max_kom <> 20 OR v_hilly_max_kom <> 10 OR v_other_max_kom <> 0 THEN
        RAISE EXCEPTION 'KOM points proxy pattern mismatch: mtn=%, hilly=%, other=%',
            v_mtn_max_kom, v_hilly_max_kom, v_other_max_kom;
    END IF;

    -- Proxy ranks must use descending points only, with no time tie-breaker
    SELECT COUNT(*)::integer
    INTO v_points_rank_mismatch
    FROM (
        SELECT rank, RANK() OVER (ORDER BY points DESC) AS expected_rank
        FROM dw.rider_standings('{"classification":"points_proxy"}'::jsonb)
    ) t
    WHERE rank <> expected_rank;

    SELECT COUNT(*)::integer
    INTO v_kom_rank_mismatch
    FROM (
        SELECT rank, RANK() OVER (ORDER BY points DESC) AS expected_rank
        FROM dw.rider_standings('{"classification":"kom_proxy"}'::jsonb)
    ) t
    WHERE rank <> expected_rank;

    IF v_points_rank_mismatch <> 0 OR v_kom_rank_mismatch <> 0 THEN
        RAISE EXCEPTION 'Proxy classification rank tie-breaker mismatch: points_mismatch=%, kom_mismatch=%',
            v_points_rank_mismatch, v_kom_rank_mismatch;
    END IF;

    -- Proxy classifications must return NULL gap_seconds while retaining total_seconds as informational
    SELECT
        COUNT(*) FILTER (WHERE gap_seconds IS NOT NULL)::integer,
        COUNT(*) FILTER (WHERE total_seconds IS NULL)::integer
    INTO v_points_nonnull_gaps, v_proxy_null_totals
    FROM dw.rider_standings('{"classification":"points_proxy"}'::jsonb);

    SELECT
        COUNT(*) FILTER (WHERE gap_seconds IS NOT NULL)::integer,
        v_proxy_null_totals + COUNT(*) FILTER (WHERE total_seconds IS NULL)::integer
    INTO v_kom_nonnull_gaps, v_proxy_null_totals
    FROM dw.rider_standings('{"classification":"kom_proxy"}'::jsonb);

    SELECT (
        (SELECT COUNT(*) FILTER (WHERE gap_seconds IS NULL) FROM dw.rider_standings('{"classification":"gc"}'::jsonb))
        + (SELECT COUNT(*) FILTER (WHERE gap_seconds IS NULL) FROM dw.rider_standings('{"classification":"young"}'::jsonb))
        + (SELECT COUNT(*) FILTER (WHERE gap_seconds IS NULL) FROM dw.rider_standings('{"classification":"mountain_time"}'::jsonb))
    )::integer
    INTO v_time_mode_null_gaps;

    IF v_points_nonnull_gaps <> 0 OR v_kom_nonnull_gaps <> 0 OR v_proxy_null_totals <> 0 OR v_time_mode_null_gaps <> 0 THEN
        RAISE EXCEPTION 'rider_standings gap_seconds/total_seconds semantics mismatch: points_nonnull_gaps=%, kom_nonnull_gaps=%, proxy_null_totals=%, time_mode_null_gaps=%',
            v_points_nonnull_gaps, v_kom_nonnull_gaps, v_proxy_null_totals, v_time_mode_null_gaps;
    END IF;

    -- Young classification restricts to is_young_rider = TRUE
    SELECT COUNT(*) FILTER (WHERE NOT is_young_rider)::integer
    INTO v_non_young_in_young
    FROM dw.rider_standings('{"classification":"young"}'::jsonb);

    IF v_non_young_in_young <> 0 THEN
        RAISE EXCEPTION 'Found % non-young riders in young classification', v_non_young_in_young;
    END IF;

    -- mountain_time uses mountain stage times while final eligibility remains all 21 stages (160 finishers)
    SELECT COUNT(*)::integer, MIN(stage_count)::integer
    INTO v_mtn_time_finishers, v_mtn_stage_count
    FROM dw.rider_standings('{"classification":"mountain_time","stage_scope":"final"}'::jsonb);

    SELECT COUNT(*)::integer
    INTO v_expected_mtn_stages
    FROM dw.dim_stage
    WHERE stage_type = 'mountain';

    IF v_mtn_time_finishers <> 160 OR v_mtn_stage_count <> v_expected_mtn_stages THEN
        RAISE EXCEPTION 'mountain_time final mismatch: finishers=% (expected 160), stage_count=% (expected %)',
            v_mtn_time_finishers, v_mtn_stage_count, v_expected_mtn_stages;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 8. Stage summary (no duplicated distance), GC evolution (retains exited riders
--    when selected), OLAP rollup view, and invalid enum rejection
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_summary_stages integer;
    v_summary_dist numeric(10, 2);
    v_dim_dist numeric(10, 2);
    v_summary_finishers integer;
    v_gc_evo_default_rows integer;
    v_gc_evo_default_riders integer;
    v_exited_rider_key integer;
    v_exited_completed_stages integer;
    v_exited_evo_rows integer;
    v_rollup_grand_rows integer;
    v_invalid_rejected boolean := false;
BEGIN
    SELECT COUNT(*)::integer, SUM(distance_km)::numeric(10, 2), SUM(finisher_count)::integer
    INTO v_summary_stages, v_summary_dist, v_summary_finishers
    FROM dw.stage_summary('{}'::jsonb);

    SELECT SUM(distance_km)::numeric(10, 2)
    INTO v_dim_dist
    FROM dw.dim_stage;

    IF v_summary_stages <> 21 OR v_summary_dist <> v_dim_dist OR v_summary_finishers <> 3602 THEN
        RAISE EXCEPTION 'dw.stage_summary mismatch: stages=%, dist=% (expected %), finishers=% (expected 3602)',
            v_summary_stages, v_summary_dist, v_dim_dist, v_summary_finishers;
    END IF;

    SELECT COUNT(*)::integer, COUNT(DISTINCT rider_key)::integer
    INTO v_gc_evo_default_rows, v_gc_evo_default_riders
    FROM dw.gc_evolution('{}'::jsonb);

    IF v_gc_evo_default_riders <> 5 OR v_gc_evo_default_rows <> 105 THEN
        RAISE EXCEPTION 'Expected default dw.gc_evolution to return 5 riders x 21 stages (105 rows), got % riders and % rows',
            v_gc_evo_default_riders, v_gc_evo_default_rows;
    END IF;

    -- Select a rider who exited after completing at least 1 stage and verify historical trajectory retention
    SELECT fp.rider_key, COUNT(fr.stage_key)::integer
    INTO v_exited_rider_key, v_exited_completed_stages
    FROM dw.fact_participation fp
    JOIN dw.fact_results fr ON fr.rider_key = fp.rider_key
    WHERE fp.exit_flag = 1
    GROUP BY fp.rider_key
    HAVING COUNT(fr.stage_key) >= 1
    ORDER BY COUNT(fr.stage_key) DESC, fp.rider_key ASC
    LIMIT 1;

    SELECT COUNT(*)::integer
    INTO v_exited_evo_rows
    FROM dw.gc_evolution(jsonb_build_object('rider_keys', jsonb_build_array(v_exited_rider_key)));

    IF v_exited_evo_rows <> v_exited_completed_stages THEN
        RAISE EXCEPTION 'Expected exited rider % to retain % historical stages in dw.gc_evolution, got %',
            v_exited_rider_key, v_exited_completed_stages, v_exited_evo_rows;
    END IF;

    -- Verify dw.olap_rollup grand total
    SELECT result_rows
    INTO v_rollup_grand_rows
    FROM dw.olap_rollup
    WHERE rollup_level = 'grand_total';

    IF v_rollup_grand_rows <> 3602 THEN
        RAISE EXCEPTION 'Expected dw.olap_rollup grand_total result_rows = 3602, got %', v_rollup_grand_rows;
    END IF;

    -- Verify unknown enum values are rejected meaningfully
    BEGIN
        PERFORM * FROM dw.rider_standings('{"classification":"unknown_mode"}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        v_invalid_rejected := true;
    END;

    IF NOT v_invalid_rejected THEN
        RAISE EXCEPTION 'Expected dw.rider_standings to reject unknown classification enum value';
    END IF;
END
$$;

-- Summary output for controller log inspection
SELECT
    'verify_analytics_passed' AS status,
    (SELECT total_seconds FROM dw.rider_standings('{}'::jsonb) WHERE rank = 1) AS gc_winner_adjusted_seconds,
    (SELECT COUNT(*) FROM dw.rider_standings('{}'::jsonb)) AS final_gc_finishers,
    (SELECT SUM(rider_count) FROM dw.country_participation('{}'::jsonb)) AS known_nationality_riders,
    (SELECT SUM(team_count) FROM dw.country_participation('{}'::jsonb)) AS total_teams,
    (SELECT COUNT(*) FROM dw.team_standings('{"team_aggregation":"stage_top3"}'::jsonb)) AS stage_top3_ranked_teams,
    (SELECT COUNT(*) FROM dw.team_standings('{"team_aggregation":"cumulative_top3"}'::jsonb)) AS cumulative_top3_ranked_teams;
