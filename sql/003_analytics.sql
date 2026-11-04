-- =============================================================================
-- Project 3: Shared OLAP SQL Layer (Phase 3)
-- Schema: dw
-- Execution role: tdf_owner
-- Read-only analytical role: tdf_reader
-- Target DBMS: PostgreSQL 18
-- =============================================================================
-- Provides reusable analytical table functions and views over the star-schema
-- warehouse (dw). All functions are STABLE and SECURITY INVOKER, accepting a
-- single JSONB filter payload: p_filters jsonb DEFAULT '{}'::jsonb.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS dw;

-- -----------------------------------------------------------------------------
-- 1. dw.rider_standings(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Classifications:
--   - 'gc'            : General Classification (ascending total_seconds)
--   - 'young'         : Young Rider Classification (is_young_rider = true, ascending total_seconds)
--   - 'points_proxy'  : Points Classification Proxy (descending stage_points_proxy, no time tie-breaker,
--                       gap_seconds = NULL, total_seconds retained as informational)
--   - 'kom_proxy'     : Mountain (KOM) Classification Proxy (descending kom_points_proxy, no time tie-breaker,
--                       gap_seconds = NULL, total_seconds retained as informational)
--   - 'mountain_time' : Mountain stages cumulative time (ascending total_seconds on mountain stages;
--                       competition completion eligibility still requires all stages in scope)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.rider_standings(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    rider_key integer,
    bib_number integer,
    rider_name text,
    team_key integer,
    team_name text,
    is_young_rider boolean,
    stage_count integer,
    total_seconds integer,
    points integer,
    rank integer,
    gap_seconds integer,
    rank_percentile numeric(5, 2),
    classification text,
    time_basis text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_classification text;
    v_stage_scope text;
    v_as_of_stage integer;
    v_time_basis text;
    v_rank_scope text;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
    v_eligible_stage_count integer;
    v_scoring_stage_count integer;
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_classification := COALESCE(NULLIF(v_filters->>'classification', ''), 'gc');
    IF v_classification NOT IN ('gc', 'young', 'points_proxy', 'kom_proxy', 'mountain_time') THEN
        RAISE EXCEPTION 'Invalid classification: %. Allowed: gc, young, points_proxy, kom_proxy, mountain_time', v_classification;
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    v_time_basis := COALESCE(NULLIF(v_filters->>'time_basis', ''), 'adjusted');
    IF v_time_basis NOT IN ('finish', 'adjusted') THEN
        RAISE EXCEPTION 'Invalid time_basis: %. Allowed: finish, adjusted', v_time_basis;
    END IF;

    v_rank_scope := COALESCE(NULLIF(v_filters->>'rank_scope', ''), 'overall');
    IF v_rank_scope NOT IN ('overall', 'filtered') THEN
        RAISE EXCEPTION 'Invalid rank_scope: %. Allowed: overall, filtered', v_rank_scope;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    -- Determine count of stages required for completion eligibility
    SELECT COUNT(*)::integer
    INTO v_eligible_stage_count
    FROM dw.dim_stage ds
    WHERE (
        (v_stage_scope = 'final')
        OR (v_stage_scope = 'as_of' AND ds.stage_order <= v_as_of_stage)
        OR (
            v_stage_scope = 'selection'
            AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
            AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
        )
    );

    -- Determine count of stages used to aggregate the classification metric
    SELECT COUNT(*)::integer
    INTO v_scoring_stage_count
    FROM dw.dim_stage ds
    WHERE (
        (v_stage_scope = 'final')
        OR (v_stage_scope = 'as_of' AND ds.stage_order <= v_as_of_stage)
        OR (
            v_stage_scope = 'selection'
            AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
            AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
        )
    )
    AND (v_classification <> 'mountain_time' OR ds.stage_type = 'mountain');

    IF v_eligible_stage_count = 0 OR v_scoring_stage_count = 0 THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH eligible_stages AS (
        SELECT ds.stage_key, ds.stage_type
        FROM dw.dim_stage ds
        WHERE (
            (v_stage_scope = 'final')
            OR (v_stage_scope = 'as_of' AND ds.stage_order <= v_as_of_stage)
            OR (
                v_stage_scope = 'selection'
                AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
                AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
            )
        )
    ),
    eligible_riders AS (
        SELECT fr.rider_key
        FROM dw.fact_results fr
        JOIN eligible_stages es ON es.stage_key = fr.stage_key
        GROUP BY fr.rider_key
        HAVING COUNT(DISTINCT fr.stage_key) = v_eligible_stage_count
    ),
    scoring_stages AS (
        SELECT es.stage_key
        FROM eligible_stages es
        WHERE v_classification <> 'mountain_time' OR es.stage_type = 'mountain'
    ),
    rider_totals AS (
        SELECT
            dr.rider_key,
            dr.bib_number,
            dr.rider_name,
            dt.team_key,
            dt.team_name,
            dr.is_young_rider,
            COUNT(fr.stage_key)::integer AS stage_count,
            SUM(
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds
                     ELSE fr.adjusted_time_seconds
                END
            )::integer AS total_seconds,
            SUM(
                CASE WHEN v_classification IN ('kom_proxy', 'mountain_time')
                     THEN fr.kom_points_proxy
                     ELSE fr.stage_points_proxy
                END
            )::integer AS points
        FROM eligible_riders er
        JOIN dw.fact_results fr ON fr.rider_key = er.rider_key
        JOIN scoring_stages ss ON ss.stage_key = fr.stage_key
        JOIN dw.dim_rider dr ON dr.rider_key = fr.rider_key
        JOIN dw.dim_team dt ON dt.team_key = fr.team_key
        WHERE (v_classification <> 'young' OR dr.is_young_rider = TRUE)
          AND (
              v_rank_scope = 'overall'
              OR (
                  (v_team_keys IS NULL OR dt.team_key = ANY(v_team_keys))
                  AND (v_rider_keys IS NULL OR dr.rider_key = ANY(v_rider_keys))
                  AND (NOT v_young_only OR dr.is_young_rider = TRUE)
              )
          )
        GROUP BY dr.rider_key, dr.bib_number, dr.rider_name, dt.team_key, dt.team_name, dr.is_young_rider
    ),
    ranked_cohort AS (
        SELECT
            rt.rider_key,
            rt.bib_number,
            rt.rider_name,
            rt.team_key,
            rt.team_name,
            rt.is_young_rider,
            rt.stage_count,
            rt.total_seconds,
            rt.points,
            (
                CASE WHEN v_classification IN ('points_proxy', 'kom_proxy')
                     THEN RANK() OVER (ORDER BY rt.points DESC)
                     ELSE RANK() OVER (ORDER BY rt.total_seconds ASC)
                END
            )::integer AS rk,
            (
                CASE WHEN v_classification IN ('points_proxy', 'kom_proxy')
                     THEN NULL::integer
                     ELSE (rt.total_seconds - MIN(rt.total_seconds) OVER ())::integer
                END
            ) AS gap_sec,
            COUNT(*) OVER ()::integer AS cohort_size
        FROM rider_totals rt
    )
    SELECT
        rc.rider_key::integer,
        rc.bib_number::integer,
        rc.rider_name::text,
        rc.team_key::integer,
        rc.team_name::text,
        rc.is_young_rider::boolean,
        rc.stage_count::integer,
        rc.total_seconds::integer,
        rc.points::integer,
        rc.rk::integer AS rank,
        rc.gap_sec::integer AS gap_seconds,
        COALESCE(
            ROUND((rc.cohort_size - rc.rk) * 100.0 / NULLIF(rc.cohort_size - 1, 0), 2),
            100.00
        )::numeric(5, 2) AS rank_percentile,
        v_classification::text AS classification,
        v_time_basis::text AS time_basis
    FROM ranked_cohort rc
    WHERE (v_team_keys IS NULL OR rc.team_key = ANY(v_team_keys))
      AND (v_rider_keys IS NULL OR rc.rider_key = ANY(v_rider_keys))
      AND (NOT v_young_only OR rc.is_young_rider = TRUE)
    ORDER BY
        rc.rk ASC,
        CASE WHEN v_classification IN ('points_proxy', 'kom_proxy') THEN -rc.points ELSE rc.total_seconds END ASC,
        rc.bib_number ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. dw.team_standings(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Team aggregation methods:
--   - 'stage_top3'      : Per stage, pick top 3 riders per team via ROW_NUMBER()
--                         ordered by stage time ASC, rider_key ASC; require all
--                         selected stages to have >= 3 finishers (no zero fill).
--   - 'cumulative_top3' : Restrict to riders who completed all selected stages,
--                         sum their cumulative time, and pick top 3 riders per
--                         team via ROW_NUMBER() ordered by cumulative time ASC,
--                         rider_key ASC; require >= 3 complete riders per team.
-- Team timings are ALWAYS computed from the full team roster in the selected
-- stage/time scope under both methods. team_keys selects teams directly;
-- rider_keys and young_only select teams by existence of a matching member in
-- dw.fact_participation + dw.dim_rider (combined AND for the same member) and
-- NEVER remove contributors from team timing calculations.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.team_standings(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    team_key integer,
    team_name text,
    total_seconds integer,
    rank integer,
    gap_seconds integer,
    stage_count integer,
    contributor_count integer,
    team_aggregation text,
    time_basis text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_team_aggregation text;
    v_stage_scope text;
    v_as_of_stage integer;
    v_time_basis text;
    v_rank_scope text;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
    v_target_stage_count integer;
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_team_aggregation := COALESCE(NULLIF(v_filters->>'team_aggregation', ''), 'stage_top3');
    IF v_team_aggregation NOT IN ('stage_top3', 'cumulative_top3') THEN
        RAISE EXCEPTION 'Invalid team_aggregation: %. Allowed: stage_top3, cumulative_top3', v_team_aggregation;
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    v_time_basis := COALESCE(NULLIF(v_filters->>'time_basis', ''), 'adjusted');
    IF v_time_basis NOT IN ('finish', 'adjusted') THEN
        RAISE EXCEPTION 'Invalid time_basis: %. Allowed: finish, adjusted', v_time_basis;
    END IF;

    v_rank_scope := COALESCE(NULLIF(v_filters->>'rank_scope', ''), 'overall');
    IF v_rank_scope NOT IN ('overall', 'filtered') THEN
        RAISE EXCEPTION 'Invalid rank_scope: %. Allowed: overall, filtered', v_rank_scope;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    SELECT COUNT(*)::integer
    INTO v_target_stage_count
    FROM dw.dim_stage ds
    WHERE (
        (v_stage_scope = 'final')
        OR (v_stage_scope = 'as_of' AND ds.stage_order <= v_as_of_stage)
        OR (
            v_stage_scope = 'selection'
            AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
            AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
        )
    );

    IF v_target_stage_count = 0 THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH selected_stages AS (
        SELECT ds.stage_key
        FROM dw.dim_stage ds
        WHERE (
            (v_stage_scope = 'final')
            OR (v_stage_scope = 'as_of' AND ds.stage_order <= v_as_of_stage)
            OR (
                v_stage_scope = 'selection'
                AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
                AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
            )
        )
    ),
    scoped_results AS (
        SELECT
            fr.team_key,
            fr.rider_key,
            fr.stage_key,
            CASE WHEN v_time_basis = 'finish'
                 THEN fr.finish_time_seconds
                 ELSE fr.adjusted_time_seconds
            END AS stage_seconds
        FROM dw.fact_results fr
        JOIN selected_stages ss ON ss.stage_key = fr.stage_key
    ),
    matching_teams AS (
        SELECT dt.team_key
        FROM dw.dim_team dt
        WHERE (v_team_keys IS NULL OR dt.team_key = ANY(v_team_keys))
          AND (
              (v_rider_keys IS NULL AND NOT v_young_only)
              OR EXISTS (
                  SELECT 1
                  FROM dw.fact_participation fp
                  JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
                  WHERE fp.team_key = dt.team_key
                    AND (v_rider_keys IS NULL OR fp.rider_key = ANY(v_rider_keys))
                    AND (NOT v_young_only OR dr.is_young_rider = TRUE)
              )
          )
    ),
    -- Method 1: stage_top3
    stage_ranked AS (
        SELECT
            fr.team_key,
            fr.stage_key,
            fr.rider_key,
            fr.stage_seconds,
            ROW_NUMBER() OVER (
                PARTITION BY fr.team_key, fr.stage_key
                ORDER BY fr.stage_seconds ASC, fr.rider_key ASC
            ) AS rn,
            COUNT(*) OVER (PARTITION BY fr.team_key, fr.stage_key) AS stage_team_finishers
        FROM scoped_results fr
        WHERE v_team_aggregation = 'stage_top3'
    ),
    stage_top3_teams AS (
        SELECT
            sr.team_key,
            SUM(sr.stage_seconds)::integer AS total_seconds,
            COUNT(DISTINCT sr.stage_key)::integer AS stage_count,
            COUNT(DISTINCT sr.rider_key)::integer AS contributor_count
        FROM stage_ranked sr
        WHERE sr.stage_team_finishers >= 3
          AND sr.rn <= 3
        GROUP BY sr.team_key
        HAVING COUNT(DISTINCT sr.stage_key) = v_target_stage_count
           AND COUNT(*) = v_target_stage_count * 3
    ),
    -- Method 2: cumulative_top3
    complete_riders AS (
        SELECT
            fr.team_key,
            fr.rider_key,
            SUM(fr.stage_seconds)::integer AS rider_total_seconds
        FROM scoped_results fr
        WHERE v_team_aggregation = 'cumulative_top3'
        GROUP BY fr.team_key, fr.rider_key
        HAVING COUNT(DISTINCT fr.stage_key) = v_target_stage_count
    ),
    cumulative_ranked AS (
        SELECT
            cr.team_key,
            cr.rider_key,
            cr.rider_total_seconds,
            ROW_NUMBER() OVER (
                PARTITION BY cr.team_key
                ORDER BY cr.rider_total_seconds ASC, cr.rider_key ASC
            ) AS rn
        FROM complete_riders cr
    ),
    cumulative_top3_teams AS (
        SELECT
            cr.team_key,
            SUM(cr.rider_total_seconds)::integer AS total_seconds,
            v_target_stage_count::integer AS stage_count,
            COUNT(DISTINCT cr.rider_key)::integer AS contributor_count
        FROM cumulative_ranked cr
        WHERE cr.rn <= 3
        GROUP BY cr.team_key
        HAVING COUNT(*) = 3
    ),
    combined_teams AS (
        SELECT s.team_key, s.total_seconds, s.stage_count, s.contributor_count
        FROM stage_top3_teams s
        UNION ALL
        SELECT c.team_key, c.total_seconds, c.stage_count, c.contributor_count
        FROM cumulative_top3_teams c
    ),
    ranking_pool AS (
        SELECT
            ct.team_key,
            dt.team_name,
            ct.total_seconds,
            ct.stage_count,
            ct.contributor_count
        FROM combined_teams ct
        JOIN dw.dim_team dt ON dt.team_key = ct.team_key
        WHERE v_rank_scope = 'overall'
           OR ct.team_key IN (SELECT mt.team_key FROM matching_teams mt)
    ),
    ranked_teams AS (
        SELECT
            rp.team_key,
            rp.team_name,
            rp.total_seconds,
            RANK() OVER (ORDER BY rp.total_seconds ASC)::integer AS rk,
            (rp.total_seconds - MIN(rp.total_seconds) OVER ())::integer AS gap_sec,
            rp.stage_count,
            rp.contributor_count
        FROM ranking_pool rp
    )
    SELECT
        rt.team_key::integer,
        rt.team_name::text,
        rt.total_seconds::integer,
        rt.rk::integer AS rank,
        rt.gap_sec::integer AS gap_seconds,
        rt.stage_count::integer,
        rt.contributor_count::integer,
        v_team_aggregation::text AS team_aggregation,
        v_time_basis::text AS time_basis
    FROM ranked_teams rt
    JOIN matching_teams mt ON mt.team_key = rt.team_key
    ORDER BY rt.rk ASC, rt.total_seconds ASC, rt.team_key ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. dw.rider_stage_results(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Detailed rider x stage results joined with conformed dimensions.
-- Global stage_finisher_count and stage winner times are computed across all
-- finishers of each stage prior to applying display filters.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.rider_stage_results(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    rider_key integer,
    bib_number integer,
    rider_name text,
    is_young_rider boolean,
    rider_country_code varchar(3),
    rider_country_name text,
    team_key integer,
    team_name text,
    stage_key integer,
    stage_id integer,
    stage_order integer,
    stage_name text,
    stage_type text,
    stage_date date,
    race_week integer,
    distance_km numeric(6, 2),
    finish_rank integer,
    stage_finisher_count integer,
    finish_time_seconds integer,
    time_bonus_seconds integer,
    time_penalty_seconds integer,
    adjusted_time_seconds integer,
    gap_seconds integer,
    adjusted_gap_seconds integer,
    stage_points_proxy integer,
    kom_points_proxy integer,
    rank_percentile numeric(5, 2),
    finished_race_flag integer,
    exit_flag integer,
    participation_status text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_stage_scope text;
    v_as_of_stage integer;
    v_time_basis text;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    v_time_basis := COALESCE(NULLIF(v_filters->>'time_basis', ''), 'adjusted');
    IF v_time_basis NOT IN ('finish', 'adjusted') THEN
        RAISE EXCEPTION 'Invalid time_basis: %. Allowed: finish, adjusted', v_time_basis;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    RETURN QUERY
    WITH global_stage_metrics AS (
        SELECT
            fr.rider_key,
            fr.stage_key,
            fr.team_key,
            fr.date_key,
            fr.rider_country_key,
            fr.finish_rank,
            fr.finish_time_seconds,
            fr.time_bonus_seconds,
            fr.time_penalty_seconds,
            fr.adjusted_time_seconds,
            fr.stage_points_proxy,
            fr.kom_points_proxy,
            COUNT(*) OVER (PARTITION BY fr.stage_key)::integer AS stage_finisher_count,
            MIN(fr.finish_time_seconds) OVER (PARTITION BY fr.stage_key)::integer AS min_finish_seconds,
            MIN(fr.adjusted_time_seconds) OVER (PARTITION BY fr.stage_key)::integer AS min_adjusted_seconds
        FROM dw.fact_results fr
    )
    SELECT
        dr.rider_key::integer,
        dr.bib_number::integer,
        dr.rider_name::text,
        dr.is_young_rider::boolean,
        dc.country_code::varchar(3) AS rider_country_code,
        dc.country_name::text AS rider_country_name,
        dt.team_key::integer,
        dt.team_name::text,
        ds.stage_key::integer,
        ds.stage_id::integer,
        ds.stage_order::integer,
        ('Stage ' || ds.stage_id || ': ' || ds.start_location_name || ' -> ' || ds.finish_location_name)::text AS stage_name,
        ds.stage_type::text,
        dd.full_date::date AS stage_date,
        dd.race_week::integer,
        ds.distance_km::numeric(6, 2),
        gsm.finish_rank::integer,
        gsm.stage_finisher_count::integer,
        gsm.finish_time_seconds::integer,
        gsm.time_bonus_seconds::integer,
        gsm.time_penalty_seconds::integer,
        gsm.adjusted_time_seconds::integer,
        (gsm.finish_time_seconds - gsm.min_finish_seconds)::integer AS gap_seconds,
        (gsm.adjusted_time_seconds - gsm.min_adjusted_seconds)::integer AS adjusted_gap_seconds,
        gsm.stage_points_proxy::integer,
        gsm.kom_points_proxy::integer,
        COALESCE(
            ROUND((gsm.stage_finisher_count - gsm.finish_rank) * 100.0 / NULLIF(gsm.stage_finisher_count - 1, 0), 2),
            100.00
        )::numeric(5, 2) AS rank_percentile,
        fp.finished_race_flag::integer,
        fp.exit_flag::integer,
        (CASE WHEN fp.finished_race_flag = 1 THEN 'finished' ELSE 'exited' END)::text AS participation_status
    FROM global_stage_metrics gsm
    JOIN dw.dim_rider dr ON dr.rider_key = gsm.rider_key
    JOIN dw.dim_team dt ON dt.team_key = gsm.team_key
    JOIN dw.dim_stage ds ON ds.stage_key = gsm.stage_key
    JOIN dw.dim_date dd ON dd.date_key = gsm.date_key
    JOIN dw.dim_country dc ON dc.country_key = gsm.rider_country_key
    JOIN dw.fact_participation fp ON fp.rider_key = gsm.rider_key
    WHERE (v_stage_scope <> 'as_of' OR ds.stage_order <= v_as_of_stage)
      AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
      AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
      AND (v_team_keys IS NULL OR gsm.team_key = ANY(v_team_keys))
      AND (v_rider_keys IS NULL OR gsm.rider_key = ANY(v_rider_keys))
      AND (NOT v_young_only OR dr.is_young_rider = TRUE)
    ORDER BY ds.stage_order ASC, gsm.finish_rank ASC, dr.bib_number ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. dw.stage_summary(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- One row per stage with distance, start/finish endpoint descriptions, date,
-- race_week, finisher_count, and stage winner summary. Pre-aggregates
-- fact_results by stage_key to avoid any distance duplication.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.stage_summary(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    stage_key integer,
    stage_id integer,
    stage_order integer,
    stage_name text,
    stage_date date,
    race_week integer,
    stage_type text,
    distance_km numeric(6, 2),
    start_location_name text,
    start_country_code varchar(3),
    start_country_name text,
    finish_location_name text,
    finish_country_code varchar(3),
    finish_country_name text,
    route_description text,
    finisher_count integer,
    winner_rider_key integer,
    winner_bib_number integer,
    winner_rider_name text,
    winner_team_name text,
    winning_finish_time_seconds integer,
    winning_adjusted_time_seconds integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_stage_scope text;
    v_as_of_stage integer;
    v_stage_ids integer[];
    v_stage_types text[];
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    RETURN QUERY
    WITH stage_agg AS (
        SELECT
            fr.stage_key,
            MIN(fr.date_key)::integer AS date_key,
            COUNT(*)::integer AS finisher_count,
            MIN(fr.finish_time_seconds)::integer AS winning_finish_time_seconds,
            MIN(fr.adjusted_time_seconds)::integer AS winning_adjusted_time_seconds
        FROM dw.fact_results fr
        GROUP BY fr.stage_key
    ),
    stage_winner AS (
        SELECT
            fr.stage_key,
            dr.rider_key AS winner_rider_key,
            dr.bib_number AS winner_bib_number,
            dr.rider_name AS winner_rider_name,
            dt.team_name AS winner_team_name,
            ROW_NUMBER() OVER (
                PARTITION BY fr.stage_key
                ORDER BY fr.finish_rank ASC, fr.finish_time_seconds ASC, dr.rider_key ASC
            ) AS rn
        FROM dw.fact_results fr
        JOIN dw.dim_rider dr ON dr.rider_key = fr.rider_key
        JOIN dw.dim_team dt ON dt.team_key = fr.team_key
    )
    SELECT
        ds.stage_key::integer,
        ds.stage_id::integer,
        ds.stage_order::integer,
        ('Stage ' || ds.stage_id || ': ' || ds.start_location_name || ' -> ' || ds.finish_location_name)::text AS stage_name,
        dd.full_date::date AS stage_date,
        dd.race_week::integer,
        ds.stage_type::text,
        ds.distance_km::numeric(6, 2),
        ds.start_location_name::text,
        ds.start_country_code::varchar(3),
        ds.start_country_name::text,
        ds.finish_location_name::text,
        ds.finish_country_code::varchar(3),
        ds.finish_country_name::text,
        (ds.start_location_name || ' (' || ds.start_country_code || ') -> ' || ds.finish_location_name || ' (' || ds.finish_country_code || ')')::text AS route_description,
        sa.finisher_count::integer,
        sw.winner_rider_key::integer,
        sw.winner_bib_number::integer,
        sw.winner_rider_name::text,
        sw.winner_team_name::text,
        sa.winning_finish_time_seconds::integer,
        sa.winning_adjusted_time_seconds::integer
    FROM dw.dim_stage ds
    JOIN stage_agg sa ON sa.stage_key = ds.stage_key
    JOIN dw.dim_date dd ON dd.date_key = sa.date_key
    JOIN stage_winner sw ON sw.stage_key = ds.stage_key AND sw.rn = 1
    WHERE (v_stage_scope <> 'as_of' OR ds.stage_order <= v_as_of_stage)
      AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
      AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
    ORDER BY ds.stage_order ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. dw.country_participation(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Role-playing dimension analysis over dw.dim_country (excluding UNK key=0)
-- and dw.fact_participation. Includes the full known country universe even when
-- rider_count = 0 or team_count = 0; finisher_rate is NULL when rider_count = 0.
-- Does not drop rider #78's team from team country counts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.country_participation(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    country_key integer,
    country_code varchar(3),
    country_name text,
    rider_count integer,
    team_count integer,
    finisher_count integer,
    finisher_rate numeric(6, 4)
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_young_only boolean := false;
    v_team_keys integer[];
    v_rider_keys integer[];
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
        IF cardinality(v_team_keys) = 0 THEN
            RETURN;
        END IF;
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
        IF cardinality(v_rider_keys) = 0 THEN
            RETURN;
        END IF;
    END IF;

    RETURN QUERY
    WITH filtered_participation AS (
        SELECT
            fp.rider_key,
            fp.team_key,
            fp.rider_country_key,
            fp.team_country_key,
            fp.participant_count,
            fp.finished_race_flag
        FROM dw.fact_participation fp
        JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
        WHERE (v_team_keys IS NULL OR fp.team_key = ANY(v_team_keys))
          AND (v_rider_keys IS NULL OR fp.rider_key = ANY(v_rider_keys))
          AND (NOT v_young_only OR dr.is_young_rider = TRUE)
    ),
    rider_by_country AS (
        SELECT
            fp.rider_country_key AS country_key,
            SUM(fp.participant_count)::integer AS rider_count,
            SUM(fp.finished_race_flag)::integer AS finisher_count
        FROM filtered_participation fp
        WHERE fp.rider_country_key > 0
        GROUP BY fp.rider_country_key
    ),
    team_by_country AS (
        SELECT
            fp.team_country_key AS country_key,
            COUNT(DISTINCT fp.team_key)::integer AS team_count
        FROM filtered_participation fp
        WHERE fp.team_country_key > 0
        GROUP BY fp.team_country_key
    )
    SELECT
        dc.country_key::integer,
        dc.country_code::varchar(3),
        dc.country_name::text,
        COALESCE(r.rider_count, 0)::integer AS rider_count,
        COALESCE(t.team_count, 0)::integer AS team_count,
        COALESCE(r.finisher_count, 0)::integer AS finisher_count,
        ROUND(
            COALESCE(r.finisher_count, 0)::numeric / NULLIF(COALESCE(r.rider_count, 0), 0),
            4
        )::numeric(6, 4) AS finisher_rate
    FROM dw.dim_country dc
    LEFT JOIN rider_by_country r ON r.country_key = dc.country_key
    LEFT JOIN team_by_country t ON t.country_key = dc.country_key
    WHERE dc.country_key > 0
      AND dc.country_code <> 'UNK'
    ORDER BY
        COALESCE(r.rider_count, 0) DESC,
        COALESCE(t.team_count, 0) DESC,
        dc.country_code ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. dw.rider_specialisation(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Rider x stage_type matrix metrics: average stage rank_percentile, top10_ratio,
-- win_count, mean_gap_seconds, and sample_count.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.rider_specialisation(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    rider_key integer,
    bib_number integer,
    rider_name text,
    team_key integer,
    team_name text,
    is_young_rider boolean,
    stage_type text,
    avg_rank_percentile numeric(5, 2),
    top10_ratio numeric(6, 4),
    top10_count integer,
    win_count integer,
    mean_gap_seconds numeric(10, 2),
    sample_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_stage_scope text;
    v_as_of_stage integer;
    v_time_basis text;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    v_time_basis := COALESCE(NULLIF(v_filters->>'time_basis', ''), 'adjusted');
    IF v_time_basis NOT IN ('finish', 'adjusted') THEN
        RAISE EXCEPTION 'Invalid time_basis: %. Allowed: finish, adjusted', v_time_basis;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    RETURN QUERY
    WITH stage_enriched AS (
        SELECT
            fr.rider_key,
            fr.team_key,
            fr.stage_key,
            fr.finish_rank,
            (
                (COUNT(*) OVER (PARTITION BY fr.stage_key) - fr.finish_rank) * 100.0
                / NULLIF(COUNT(*) OVER (PARTITION BY fr.stage_key) - 1, 0)
            ) AS stage_rank_pct,
            (
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds - MIN(fr.finish_time_seconds) OVER (PARTITION BY fr.stage_key)
                     ELSE fr.adjusted_time_seconds - MIN(fr.adjusted_time_seconds) OVER (PARTITION BY fr.stage_key)
                END
            ) AS stage_gap_sec
        FROM dw.fact_results fr
    )
    SELECT
        dr.rider_key::integer,
        dr.bib_number::integer,
        dr.rider_name::text,
        dt.team_key::integer,
        dt.team_name::text,
        dr.is_young_rider::boolean,
        ds.stage_type::text,
        ROUND(AVG(COALESCE(se.stage_rank_pct, 100.0)), 2)::numeric(5, 2) AS avg_rank_percentile,
        ROUND(
            COUNT(*) FILTER (WHERE se.finish_rank <= 10)::numeric / COUNT(*),
            4
        )::numeric(6, 4) AS top10_ratio,
        COUNT(*) FILTER (WHERE se.finish_rank <= 10)::integer AS top10_count,
        COUNT(*) FILTER (WHERE se.finish_rank = 1)::integer AS win_count,
        ROUND(AVG(se.stage_gap_sec), 2)::numeric(10, 2) AS mean_gap_seconds,
        COUNT(*)::integer AS sample_count
    FROM stage_enriched se
    JOIN dw.dim_rider dr ON dr.rider_key = se.rider_key
    JOIN dw.dim_team dt ON dt.team_key = se.team_key
    JOIN dw.dim_stage ds ON ds.stage_key = se.stage_key
    WHERE (v_stage_scope <> 'as_of' OR ds.stage_order <= v_as_of_stage)
      AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
      AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
      AND (v_team_keys IS NULL OR se.team_key = ANY(v_team_keys))
      AND (v_rider_keys IS NULL OR se.rider_key = ANY(v_rider_keys))
      AND (NOT v_young_only OR dr.is_young_rider = TRUE)
    GROUP BY
        dr.rider_key,
        dr.bib_number,
        dr.rider_name,
        dt.team_key,
        dt.team_name,
        dr.is_young_rider,
        ds.stage_type
    ORDER BY dr.bib_number ASC, ds.stage_type ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. dw.team_depth(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Team competitiveness & depth: wins, podiums, top10_stage_coverage,
-- top10_distinct_riders, finishers, and participants.
-- Pre-aggregates fact_results and fact_participation independently by team_key
-- and joins on conformed dimension dw.dim_team to prevent fact-to-fact fanout.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.team_depth(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    team_key integer,
    team_name text,
    wins integer,
    podiums integer,
    top10_finishes integer,
    top10_stages integer,
    selected_stage_count integer,
    top10_stage_coverage numeric(6, 4),
    top10_distinct_riders integer,
    finishers integer,
    participants integer,
    finisher_rate numeric(6, 4)
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_stage_scope text;
    v_as_of_stage integer;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
    v_selected_stage_count integer;
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    SELECT COUNT(*)::integer
    INTO v_selected_stage_count
    FROM dw.dim_stage ds
    WHERE (v_stage_scope <> 'as_of' OR ds.stage_order <= v_as_of_stage)
      AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
      AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types));

    IF v_selected_stage_count = 0 THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH selected_stages AS (
        SELECT ds.stage_key
        FROM dw.dim_stage ds
        WHERE (v_stage_scope <> 'as_of' OR ds.stage_order <= v_as_of_stage)
          AND (v_stage_ids IS NULL OR ds.stage_id = ANY(v_stage_ids))
          AND (v_stage_types IS NULL OR ds.stage_type = ANY(v_stage_types))
    ),
    participation_by_team AS (
        SELECT
            fp.team_key,
            SUM(fp.participant_count)::integer AS participants,
            SUM(fp.finished_race_flag)::integer AS finishers
        FROM dw.fact_participation fp
        JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
        WHERE (v_team_keys IS NULL OR fp.team_key = ANY(v_team_keys))
          AND (v_rider_keys IS NULL OR fp.rider_key = ANY(v_rider_keys))
          AND (NOT v_young_only OR dr.is_young_rider = TRUE)
        GROUP BY fp.team_key
    ),
    results_by_team AS (
        SELECT
            fr.team_key,
            COUNT(*) FILTER (WHERE fr.finish_rank = 1)::integer AS wins,
            COUNT(*) FILTER (WHERE fr.finish_rank <= 3)::integer AS podiums,
            COUNT(*) FILTER (WHERE fr.finish_rank <= 10)::integer AS top10_finishes,
            COUNT(DISTINCT fr.stage_key) FILTER (WHERE fr.finish_rank <= 10)::integer AS top10_stages,
            COUNT(DISTINCT fr.rider_key) FILTER (WHERE fr.finish_rank <= 10)::integer AS top10_distinct_riders
        FROM dw.fact_results fr
        JOIN selected_stages ss ON ss.stage_key = fr.stage_key
        JOIN dw.dim_rider dr ON dr.rider_key = fr.rider_key
        WHERE (v_team_keys IS NULL OR fr.team_key = ANY(v_team_keys))
          AND (v_rider_keys IS NULL OR fr.rider_key = ANY(v_rider_keys))
          AND (NOT v_young_only OR dr.is_young_rider = TRUE)
        GROUP BY fr.team_key
    )
    SELECT
        dt.team_key::integer,
        dt.team_name::text,
        COALESCE(r.wins, 0)::integer AS wins,
        COALESCE(r.podiums, 0)::integer AS podiums,
        COALESCE(r.top10_finishes, 0)::integer AS top10_finishes,
        COALESCE(r.top10_stages, 0)::integer AS top10_stages,
        v_selected_stage_count::integer AS selected_stage_count,
        ROUND(
            COALESCE(r.top10_stages, 0)::numeric / NULLIF(v_selected_stage_count, 0),
            4
        )::numeric(6, 4) AS top10_stage_coverage,
        COALESCE(r.top10_distinct_riders, 0)::integer AS top10_distinct_riders,
        p.finishers::integer,
        p.participants::integer,
        COALESCE(
            ROUND(p.finishers::numeric / NULLIF(p.participants, 0), 4),
            0.0000
        )::numeric(6, 4) AS finisher_rate
    FROM dw.dim_team dt
    JOIN participation_by_team p ON p.team_key = dt.team_key
    LEFT JOIN results_by_team r ON r.team_key = dt.team_key
    ORDER BY
        COALESCE(r.wins, 0) DESC,
        COALESCE(r.podiums, 0) DESC,
        ROUND(COALESCE(r.top10_stages, 0)::numeric / NULLIF(v_selected_stage_count, 0), 4) DESC,
        COALESCE(r.top10_distinct_riders, 0) DESC,
        dt.team_key ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. dw.gc_evolution(p_filters jsonb DEFAULT '{}'::jsonb)
-- -----------------------------------------------------------------------------
-- Stage-by-stage GC cumulative gap evolution (Worm Chart / Decisive Stages).
-- - Ranking eligibility at each stage cutoff S requires completing all stages 1..S.
-- - Contemporaneous dataset leader at stage S is the 1..S eligible rider with
--   minimum cumulative time across the full dataset.
-- - Defaults to fixed Final GC Top 5 competitors when rider_keys/team_keys are
--   not specified; retains riders who later exit for all stages 1..S they
--   completed when specifically selected.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dw.gc_evolution(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    stage_key integer,
    stage_id integer,
    stage_order integer,
    stage_date date,
    race_week integer,
    stage_type text,
    rider_key integer,
    bib_number integer,
    rider_name text,
    team_key integer,
    team_name text,
    is_young_rider boolean,
    stage_seconds integer,
    cumulative_seconds integer,
    leader_cumulative_seconds integer,
    cumulative_rank integer,
    cumulative_gap_seconds integer,
    stage_net_change_seconds integer,
    stage_gap_seconds integer,
    time_bonus_seconds integer,
    time_penalty_seconds integer,
    net_bonus_penalty_seconds integer,
    cumulative_bonus_seconds integer,
    cumulative_penalty_seconds integer,
    cumulative_net_bonus_penalty_seconds integer,
    time_basis text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = dw, pg_catalog
AS $$
DECLARE
    v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
    v_stage_scope text;
    v_as_of_stage integer;
    v_time_basis text;
    v_rank_scope text;
    v_young_only boolean := false;
    v_stage_ids integer[];
    v_stage_types text[];
    v_team_keys integer[];
    v_rider_keys integer[];
    v_total_stages integer;
BEGIN
    IF jsonb_typeof(v_filters) <> 'object' THEN
        RAISE EXCEPTION 'p_filters must be a JSON object';
    END IF;

    v_stage_scope := COALESCE(NULLIF(v_filters->>'stage_scope', ''), 'final');
    IF v_stage_scope NOT IN ('final', 'as_of', 'selection') THEN
        RAISE EXCEPTION 'Invalid stage_scope: %. Allowed: final, as_of, selection', v_stage_scope;
    END IF;

    IF v_filters ? 'as_of_stage' AND jsonb_typeof(v_filters->'as_of_stage') <> 'null' THEN
        v_as_of_stage := (v_filters->>'as_of_stage')::integer;
        IF v_as_of_stage NOT BETWEEN 1 AND 21 THEN
            RAISE EXCEPTION 'Invalid as_of_stage: % (must be between 1 and 21)', v_as_of_stage;
        END IF;
    ELSE
        v_as_of_stage := 21;
    END IF;

    v_time_basis := COALESCE(NULLIF(v_filters->>'time_basis', ''), 'adjusted');
    IF v_time_basis NOT IN ('finish', 'adjusted') THEN
        RAISE EXCEPTION 'Invalid time_basis: %. Allowed: finish, adjusted', v_time_basis;
    END IF;

    v_rank_scope := COALESCE(NULLIF(v_filters->>'rank_scope', ''), 'overall');
    IF v_rank_scope NOT IN ('overall', 'filtered') THEN
        RAISE EXCEPTION 'Invalid rank_scope: %. Allowed: overall, filtered', v_rank_scope;
    END IF;

    IF v_filters ? 'young_only' AND jsonb_typeof(v_filters->'young_only') <> 'null' THEN
        IF jsonb_typeof(v_filters->'young_only') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid young_only: must be a boolean';
        END IF;
        v_young_only := (v_filters->>'young_only')::boolean;
    END IF;

    IF v_filters ? 'stage_ids' AND jsonb_typeof(v_filters->'stage_ids') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_ids') <> 'array' THEN
            RAISE EXCEPTION 'stage_ids must be a JSON array';
        END IF;
        v_stage_ids := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_ids')::integer);
    END IF;

    IF v_filters ? 'stage_types' AND jsonb_typeof(v_filters->'stage_types') <> 'null' THEN
        IF jsonb_typeof(v_filters->'stage_types') <> 'array' THEN
            RAISE EXCEPTION 'stage_types must be a JSON array';
        END IF;
        v_stage_types := ARRAY(SELECT jsonb_array_elements_text(v_filters->'stage_types'));
        IF NOT (v_stage_types <@ ARRAY['flat', 'hilly', 'mountain', 'individual time-trial']::text[]) THEN
            RAISE EXCEPTION 'Invalid stage_types value in %', v_filters->'stage_types';
        END IF;
    END IF;

    IF v_filters ? 'team_keys' AND jsonb_typeof(v_filters->'team_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'team_keys') <> 'array' THEN
            RAISE EXCEPTION 'team_keys must be a JSON array';
        END IF;
        v_team_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'team_keys')::integer);
    END IF;

    IF v_filters ? 'rider_keys' AND jsonb_typeof(v_filters->'rider_keys') <> 'null' THEN
        IF jsonb_typeof(v_filters->'rider_keys') <> 'array' THEN
            RAISE EXCEPTION 'rider_keys must be a JSON array';
        END IF;
        v_rider_keys := ARRAY(SELECT jsonb_array_elements_text(v_filters->'rider_keys')::integer);
    END IF;

    SELECT COUNT(*)::integer INTO v_total_stages FROM dw.dim_stage;

    RETURN QUERY
    WITH default_final_top5 AS (
        SELECT fr.rider_key
        FROM dw.fact_results fr
        JOIN dw.dim_rider dr ON dr.rider_key = fr.rider_key
        WHERE (NOT v_young_only OR dr.is_young_rider = TRUE)
        GROUP BY fr.rider_key
        HAVING COUNT(DISTINCT fr.stage_key) = v_total_stages
        ORDER BY
            SUM(
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds
                     ELSE fr.adjusted_time_seconds
                END
            ) ASC,
            fr.rider_key ASC
        LIMIT 5
    ),
    target_riders AS (
        SELECT d.rider_key
        FROM default_final_top5 d
        WHERE v_rider_keys IS NULL AND v_team_keys IS NULL
        UNION
        SELECT fp.rider_key
        FROM dw.fact_participation fp
        JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
        WHERE (v_rider_keys IS NOT NULL OR v_team_keys IS NOT NULL)
          AND (v_rider_keys IS NULL OR fp.rider_key = ANY(v_rider_keys))
          AND (v_team_keys IS NULL OR fp.team_key = ANY(v_team_keys))
          AND (NOT v_young_only OR dr.is_young_rider = TRUE)
    ),
    rider_stage_progression AS (
        SELECT
            fr.rider_key,
            fr.team_key,
            fr.stage_key,
            fr.date_key,
            ds.stage_id,
            ds.stage_order,
            ds.stage_type,
            (
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds
                     ELSE fr.adjusted_time_seconds
                END
            )::integer AS stage_seconds,
            MIN(
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds
                     ELSE fr.adjusted_time_seconds
                END
            ) OVER (PARTITION BY fr.stage_key)::integer AS stage_winner_seconds,
            fr.time_bonus_seconds,
            fr.time_penalty_seconds,
            (fr.time_penalty_seconds - fr.time_bonus_seconds)::integer AS net_bonus_penalty_seconds,
            COUNT(*) OVER (
                PARTITION BY fr.rider_key
                ORDER BY ds.stage_order ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::integer AS stages_completed_so_far,
            SUM(
                CASE WHEN v_time_basis = 'finish'
                     THEN fr.finish_time_seconds
                     ELSE fr.adjusted_time_seconds
                END
            ) OVER (
                PARTITION BY fr.rider_key
                ORDER BY ds.stage_order ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::integer AS cumulative_seconds,
            SUM(fr.time_bonus_seconds) OVER (
                PARTITION BY fr.rider_key
                ORDER BY ds.stage_order ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::integer AS cumulative_bonus_seconds,
            SUM(fr.time_penalty_seconds) OVER (
                PARTITION BY fr.rider_key
                ORDER BY ds.stage_order ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::integer AS cumulative_penalty_seconds,
            SUM(fr.time_penalty_seconds - fr.time_bonus_seconds) OVER (
                PARTITION BY fr.rider_key
                ORDER BY ds.stage_order ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::integer AS cumulative_net_bonus_penalty_seconds
        FROM dw.fact_results fr
        JOIN dw.dim_stage ds ON ds.stage_key = fr.stage_key
    ),
    -- Only riders who completed all stages 1..S are eligible at cutoff S
    eligible_at_cutoff AS (
        SELECT rsp.*
        FROM rider_stage_progression rsp
        JOIN dw.dim_rider dr ON dr.rider_key = rsp.rider_key
        WHERE rsp.stages_completed_so_far = rsp.stage_order
          AND (
              v_rank_scope = 'overall'
              OR rsp.rider_key IN (SELECT tr.rider_key FROM target_riders tr)
          )
    ),
    contemporaneous_standings AS (
        SELECT
            eac.*,
            MIN(eac.cumulative_seconds) OVER (PARTITION BY eac.stage_key)::integer AS leader_cumulative_seconds,
            RANK() OVER (
                PARTITION BY eac.stage_key
                ORDER BY eac.cumulative_seconds ASC
            )::integer AS cumulative_rank,
            (
                eac.cumulative_seconds
                - MIN(eac.cumulative_seconds) OVER (PARTITION BY eac.stage_key)
            )::integer AS cumulative_gap_seconds
        FROM eligible_at_cutoff eac
    ),
    trajectory_with_deltas AS (
        SELECT
            cs.*,
            (
                cs.cumulative_gap_seconds
                - COALESCE(
                    LAG(cs.cumulative_gap_seconds) OVER (
                        PARTITION BY cs.rider_key
                        ORDER BY cs.stage_order ASC
                    ),
                    0
                )
            )::integer AS stage_net_change_seconds,
            (cs.stage_seconds - cs.stage_winner_seconds)::integer AS stage_gap_seconds
        FROM contemporaneous_standings cs
        JOIN target_riders tr ON tr.rider_key = cs.rider_key
    )
    SELECT
        twd.stage_key::integer,
        twd.stage_id::integer,
        twd.stage_order::integer,
        dd.full_date::date AS stage_date,
        dd.race_week::integer,
        twd.stage_type::text,
        dr.rider_key::integer,
        dr.bib_number::integer,
        dr.rider_name::text,
        dt.team_key::integer,
        dt.team_name::text,
        dr.is_young_rider::boolean,
        twd.stage_seconds::integer,
        twd.cumulative_seconds::integer,
        twd.leader_cumulative_seconds::integer,
        twd.cumulative_rank::integer,
        twd.cumulative_gap_seconds::integer,
        twd.stage_net_change_seconds::integer,
        twd.stage_gap_seconds::integer,
        twd.time_bonus_seconds::integer,
        twd.time_penalty_seconds::integer,
        twd.net_bonus_penalty_seconds::integer,
        twd.cumulative_bonus_seconds::integer,
        twd.cumulative_penalty_seconds::integer,
        twd.cumulative_net_bonus_penalty_seconds::integer,
        v_time_basis::text AS time_basis
    FROM trajectory_with_deltas twd
    JOIN dw.dim_rider dr ON dr.rider_key = twd.rider_key
    JOIN dw.dim_team dt ON dt.team_key = twd.team_key
    JOIN dw.dim_date dd ON dd.date_key = twd.date_key
    WHERE (v_stage_scope <> 'as_of' OR twd.stage_order <= v_as_of_stage)
      AND (
          v_stage_scope <> 'selection'
          OR (
              (v_stage_ids IS NULL OR twd.stage_id = ANY(v_stage_ids))
              AND (v_stage_types IS NULL OR twd.stage_type = ANY(v_stage_types))
          )
      )
    ORDER BY twd.stage_order ASC, twd.cumulative_rank ASC, dr.bib_number ASC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. dw.olap_rollup (View)
-- -----------------------------------------------------------------------------
-- Explicit GROUP BY ROLLUP ((team_key, team_name), stage_type) view over
-- dw.fact_results for course demonstration of OLAP roll-up hierarchies:
--   - 'team_stage_type' (detail: team x stage_type)
--   - 'team_total'      (subtotal per team across all stage types)
--   - 'grand_total'     (overall total across all teams and stage types)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW dw.olap_rollup AS
WITH stage_ranked AS (
    SELECT
        fr.team_key,
        fr.rider_key,
        fr.stage_key,
        fr.finish_rank,
        fr.finish_time_seconds,
        fr.adjusted_time_seconds,
        fr.stage_points_proxy,
        fr.kom_points_proxy,
        (
            (COUNT(*) OVER (PARTITION BY fr.stage_key) - fr.finish_rank) * 100.0
            / NULLIF(COUNT(*) OVER (PARTITION BY fr.stage_key) - 1, 0)
        ) AS stage_rank_percentile
    FROM dw.fact_results fr
)
SELECT
    dt.team_key,
    COALESCE(dt.team_name, 'ALL TEAMS') AS team_name,
    COALESCE(ds.stage_type, 'ALL STAGE TYPES') AS stage_type,
    GROUPING(dt.team_key) AS team_grouping,
    GROUPING(ds.stage_type) AS stage_type_grouping,
    CASE
        WHEN GROUPING(dt.team_key) = 1 THEN 'grand_total'
        WHEN GROUPING(ds.stage_type) = 1 THEN 'team_total'
        ELSE 'team_stage_type'
    END AS rollup_level,
    COUNT(*)::integer AS result_rows,
    COUNT(DISTINCT sr.rider_key)::integer AS distinct_riders,
    COUNT(DISTINCT sr.stage_key)::integer AS distinct_stages,
    SUM(sr.finish_time_seconds)::bigint AS total_finish_time_seconds,
    SUM(sr.adjusted_time_seconds)::bigint AS total_adjusted_time_seconds,
    SUM(sr.stage_points_proxy)::integer AS total_stage_points_proxy,
    SUM(sr.kom_points_proxy)::integer AS total_kom_points_proxy,
    COUNT(*) FILTER (WHERE sr.finish_rank = 1)::integer AS stage_wins,
    COUNT(*) FILTER (WHERE sr.finish_rank <= 3)::integer AS podium_finishes,
    COUNT(*) FILTER (WHERE sr.finish_rank <= 10)::integer AS top10_finishes,
    ROUND(AVG(COALESCE(sr.stage_rank_percentile, 100.0)), 2)::numeric(5, 2) AS avg_rank_percentile
FROM stage_ranked sr
JOIN dw.dim_team dt ON dt.team_key = sr.team_key
JOIN dw.dim_stage ds ON ds.stage_key = sr.stage_key
GROUP BY ROLLUP ((dt.team_key, dt.team_name), ds.stage_type)
ORDER BY
    GROUPING(dt.team_key) ASC,
    dt.team_name ASC NULLS LAST,
    GROUPING(ds.stage_type) ASC,
    ds.stage_type ASC NULLS LAST;

-- -----------------------------------------------------------------------------
-- Read-only analytical privileges for tdf_reader (no write privileges granted)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tdf_reader') THEN
        GRANT USAGE ON SCHEMA dw TO tdf_reader;
        GRANT SELECT ON TABLE dw.olap_rollup TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.rider_standings(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.team_standings(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.rider_stage_results(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.stage_summary(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.country_participation(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.rider_specialisation(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.team_depth(jsonb) TO tdf_reader;
        GRANT EXECUTE ON FUNCTION dw.gc_evolution(jsonb) TO tdf_reader;
    END IF;
END
$$;
