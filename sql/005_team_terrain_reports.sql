-- The starting roster is the population. Aggregate completed results first, so
-- riders who exited or recorded no result in the interval still have a row.
CREATE OR REPLACE FUNCTION dw.team_roster_performance(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    team_key integer, team_name text, rider_key integer, bib_number integer, rider_name text,
    rider_country_name text, exit_flag integer, top10_count integer, win_count integer,
    completed_stage_count integer, rider_burden_seconds bigint, terrain_top10 jsonb
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog AS $$
    WITH results AS (
        SELECT r.rider_key, count(*)::integer AS completed,
               sum(r.adjusted_time_seconds) AS burden,
               count(*) FILTER (WHERE r.finish_rank = 1)::integer AS wins,
               count(*) FILTER (WHERE r.finish_rank <= 10)::integer AS top10,
               jsonb_build_object(
                   'flat', count(*) FILTER (WHERE r.finish_rank <= 10 AND r.stage_type = 'flat'),
                   'hilly', count(*) FILTER (WHERE r.finish_rank <= 10 AND r.stage_type = 'hilly'),
                   'mountain', count(*) FILTER (WHERE r.finish_rank <= 10 AND r.stage_type = 'mountain'),
                   'individual time-trial', count(*) FILTER (WHERE r.finish_rank <= 10 AND r.stage_type = 'individual time-trial')
               ) AS by_terrain
        FROM dw.rider_stage_results(p_filters) r
        GROUP BY r.rider_key
    )
    SELECT fp.team_key, dt.team_name::text, fp.rider_key, dr.bib_number, dr.rider_name::text,
           dc.country_name::text, fp.exit_flag::integer, coalesce(r.top10, 0), coalesce(r.wins, 0),
           coalesce(r.completed, 0), coalesce(r.burden, 0), coalesce(r.by_terrain, '{}'::jsonb)
    FROM dw.fact_participation fp
    JOIN dw.dim_team dt ON dt.team_key = fp.team_key
    JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
    JOIN dw.dim_country dc ON dc.country_key = fp.rider_country_key
    LEFT JOIN results r ON r.rider_key = fp.rider_key
    WHERE EXISTS (SELECT 1 FROM dw.stage_summary(p_filters))
      AND (jsonb_typeof(p_filters->'team_keys') IS DISTINCT FROM 'array'
           OR p_filters->'team_keys' @> to_jsonb(ARRAY[fp.team_key]))
      AND (jsonb_typeof(p_filters->'rider_keys') IS DISTINCT FROM 'array'
           OR p_filters->'rider_keys' @> to_jsonb(ARRAY[fp.rider_key]))
      AND (NOT coalesce((p_filters->>'young_only')::boolean, false) OR dr.is_young_rider)
    ORDER BY fp.team_key, coalesce(r.top10, 0) DESC, dr.bib_number
$$;

-- Each completed result contributes its own distance and raw seconds to both
-- levels. Rank unrounded weighted speeds in a common, two-terrain cohort.
CREATE OR REPLACE FUNCTION dw.terrain_performance(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    entity_kind text, entity_key integer, entity_name text, team_key integer, team_name text,
    stage_type text, sample_count integer, distance_km numeric, raw_seconds bigint,
    speed_kmh numeric, podium_count integer, mean_winner_gap_seconds numeric,
    baseline_rank integer, mountain_rank integer, terrain_rank_gain integer, ranked_entities integer
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog AS $$
    WITH selected_members AS (
        SELECT fp.team_key, fp.rider_key
        FROM dw.fact_participation fp
        JOIN dw.dim_rider dr ON dr.rider_key = fp.rider_key
        WHERE (jsonb_typeof(p_filters->'team_keys') IS DISTINCT FROM 'array'
               OR p_filters->'team_keys' @> to_jsonb(ARRAY[fp.team_key]))
          AND (jsonb_typeof(p_filters->'rider_keys') IS DISTINCT FROM 'array'
               OR p_filters->'rider_keys' @> to_jsonb(ARRAY[fp.rider_key]))
          AND (NOT coalesce((p_filters->>'young_only')::boolean, false) OR dr.is_young_rider)
    ), visible_entities AS (
        SELECT 'rider' AS kind, m.rider_key AS id FROM selected_members m
        UNION ALL
        SELECT DISTINCT 'team', m.team_key FROM selected_members m
    ), cells AS (
        SELECT e.kind, e.id, e.name, r.team_key, r.team_name, r.stage_type,
               count(*)::integer AS n, sum(r.distance_km) AS km, sum(r.finish_time_seconds) AS secs,
               count(*) FILTER (WHERE r.finish_rank <= 3)::integer AS podiums,
               avg(r.gap_seconds) AS mean_gap
        FROM dw.rider_stage_results(coalesce(p_filters, '{}'::jsonb) - ARRAY['team_keys','rider_keys','young_only']) r
        CROSS JOIN LATERAL (VALUES ('rider', r.rider_key, r.rider_name),
                                   ('team', r.team_key, r.team_name)) e(kind, id, name)
        -- A member selection identifies teams, just as in team standings.
        -- Retain every ride from each team used in the comparison cohort.
        LEFT JOIN visible_entities v ON v.kind = e.kind AND v.id = e.id
        WHERE p_filters->>'rank_scope' IS DISTINCT FROM 'filtered' OR v.id IS NOT NULL
        GROUP BY e.kind, e.id, e.name, r.team_key, r.team_name, r.stage_type
    ), comparable AS (
        SELECT c.kind, c.id,
               sum(c.km) FILTER (WHERE c.stage_type IN ('flat', 'hilly')) /
                   nullif(sum(c.secs) FILTER (WHERE c.stage_type IN ('flat', 'hilly')), 0) AS baseline,
               sum(c.km) FILTER (WHERE c.stage_type = 'mountain') /
                   nullif(sum(c.secs) FILTER (WHERE c.stage_type = 'mountain'), 0) AS mountain
        FROM cells c
        GROUP BY c.kind, c.id
        HAVING bool_or(c.stage_type IN ('flat','hilly')) AND bool_or(c.stage_type = 'mountain')
    ), ranks AS (
        SELECT v.kind, v.id, rank() OVER (PARTITION BY v.kind ORDER BY v.baseline DESC)::integer AS base,
               rank() OVER (PARTITION BY v.kind ORDER BY v.mountain DESC)::integer AS mtn,
               count(*) OVER (PARTITION BY v.kind)::integer AS n
        FROM comparable v
    )
    SELECT c.kind, c.id, c.name, c.team_key, c.team_name, c.stage_type,
           c.n, c.km, c.secs, 3600 * c.km / nullif(c.secs, 0), c.podiums,
           c.mean_gap, k.base, k.mtn, k.base - k.mtn, k.n
    FROM cells c
    JOIN visible_entities v ON v.kind = c.kind AND v.id = c.id
    LEFT JOIN ranks k ON k.kind = c.kind AND k.id = c.id
    ORDER BY c.kind, c.id, c.stage_type
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tdf_reader') THEN
        GRANT EXECUTE ON FUNCTION dw.team_roster_performance(jsonb), dw.terrain_performance(jsonb) TO tdf_reader;
    END IF;
END $$;
