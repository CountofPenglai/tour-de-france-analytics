-- The route directory uses the full stage field for winners. Person filters apply
-- to the result table opened from that directory.
CREATE OR REPLACE FUNCTION dw.route_directory(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    stage_id integer, stage_order integer, stage_name text, stage_date date,
    stage_type text, distance_km numeric, start_location_name text,
    finish_location_name text, winner_names text[]
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog
AS $$
    SELECT s.stage_id, s.stage_order, s.stage_name, s.stage_date, s.stage_type,
           s.distance_km, s.start_location_name, s.finish_location_name,
           ARRAY(SELECT r.rider_name
                 FROM dw.fact_results f
                 JOIN dw.dim_rider r USING (rider_key)
                 WHERE f.stage_key = s.stage_key AND f.finish_rank = 1
                 ORDER BY r.bib_number, r.rider_key)
    FROM dw.stage_summary(p_filters) s
    ORDER BY s.stage_order
$$;

-- Country participation is full-race, honors use the active stage selection,
-- and final GC uses adjusted time and overall rank across all complete riders.
CREATE OR REPLACE FUNCTION dw.country_outcomes(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
    country_code varchar(3), country_name text, rider_count integer, team_count integer,
    best_gc_rank integer, best_gc_riders jsonb, stage_wins integer,
    podium_finishes integer, podium_rows jsonb
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog
AS $$
    WITH gc AS MATERIALIZED (
        SELECT p.rider_country_key, r.rider_key, r.bib_number, r.rider_name, r.team_name,
               r.rank AS gc_rank, r.total_seconds,
               MIN(r.rank) OVER (PARTITION BY p.rider_country_key) AS country_best
        FROM dw.rider_standings(COALESCE(p_filters, '{}'::jsonb) ||
            '{"stage_scope":"final","classification":"gc","time_basis":"adjusted","rank_scope":"overall"}'::jsonb) r
        JOIN dw.fact_participation p USING (rider_key)
        WHERE p.rider_country_key > 0
    ), best AS (
        SELECT g.rider_country_key, g.gc_rank,
               jsonb_agg(jsonb_build_object(
                   'rider_key', g.rider_key, 'bib_number', g.bib_number, 'rider_name', g.rider_name,
                   'team_name', g.team_name, 'gc_rank', g.gc_rank, 'total_seconds', g.total_seconds,
                   'country_role', 'rider_nationality'
               ) ORDER BY g.bib_number, g.rider_key) AS riders
        FROM gc g
        WHERE g.gc_rank = g.country_best
        GROUP BY g.rider_country_key, g.gc_rank
    ), honors AS (
        SELECT r.rider_country_code, COUNT(*) FILTER (WHERE r.finish_rank = 1)::integer AS wins,
               COUNT(*)::integer AS podiums,
               jsonb_agg(jsonb_build_object(
                   'stage_id', r.stage_id, 'stage_date', r.stage_date, 'stage_type', r.stage_type,
                   'finish_rank', r.finish_rank, 'rider_key', r.rider_key, 'bib_number', r.bib_number,
                   'rider_name', r.rider_name, 'team_key', r.team_key, 'team_name', r.team_name,
                   'participation_status', r.participation_status, 'country_role', 'rider_nationality'
               ) ORDER BY r.stage_order, r.finish_rank, r.bib_number) AS records
        FROM dw.rider_stage_results(p_filters) r
        WHERE r.finish_rank <= 3 AND r.rider_country_code <> 'UNK'
        GROUP BY r.rider_country_code
    )
    SELECT c.country_code, c.country_name, c.rider_count, c.team_count,
           b.gc_rank, COALESCE(b.riders, '[]'::jsonb), COALESCE(h.wins, 0),
           COALESCE(h.podiums, 0), COALESCE(h.records, '[]'::jsonb)
    FROM dw.country_participation(p_filters) c
    LEFT JOIN best b ON b.rider_country_key = c.country_key
    LEFT JOIN honors h ON h.rider_country_code = c.country_code
    WHERE c.rider_count > 0 OR c.team_count > 0
    ORDER BY c.rider_count DESC, c.team_count DESC, c.country_code
$$;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tdf_reader') THEN
        GRANT EXECUTE ON FUNCTION dw.route_directory(jsonb), dw.country_outcomes(jsonb) TO tdf_reader;
    END IF;
END
$grant$;
