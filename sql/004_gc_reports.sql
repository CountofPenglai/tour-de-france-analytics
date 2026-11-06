-- Cohort membership, ranking scope and ties follow the shared classification functions.
CREATE OR REPLACE FUNCTION dw.gc_comparison(p_filters jsonb DEFAULT '{}')
RETURNS TABLE (
    rider_key integer, bib_number integer, rider_name text, team_key integer, team_name text,
    age_at_race integer, age_group text, gc_rank integer, young_gc_rank integer,
    mountain_gc_rank integer, mountain_rank_gain integer, total_seconds integer, gap_seconds integer,
    stage_count integer, mountain_stage_count integer, mountain_seconds integer
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog AS $$
    SELECT g.rider_key, g.bib_number, g.rider_name, g.team_key, g.team_name,
           r.age_at_race, r.age_group, g.rank, y.rank, m.rank, g.rank - m.rank,
           g.total_seconds, g.gap_seconds, g.stage_count, coalesce(m.stage_count, 0), m.total_seconds
    FROM dw.rider_standings(p_filters || '{"classification":"gc"}') g
    JOIN dw.dim_rider r ON r.rider_key = g.rider_key
    LEFT JOIN dw.rider_standings(p_filters || '{"classification":"young"}') y ON y.rider_key = g.rider_key
    LEFT JOIN dw.rider_standings(p_filters || '{"classification":"mountain_time"}') m ON m.rider_key = g.rider_key
    ORDER BY g.rank, g.rider_key;
$$;

-- Calculate changes against the preceding race day before hiding out-of-scope dates.
CREATE OR REPLACE FUNCTION dw.gc_trajectory(p_filters jsonb DEFAULT '{}')
RETURNS TABLE (
    rider_key integer, bib_number integer, rider_name text, team_key integer, team_name text,
    stage_id integer, stage_order integer, stage_type text, stage_date date,
    cumulative_rank integer, previous_rank integer, rank_gain integer, cumulative_seconds integer,
    cumulative_gap_seconds integer, daily_gap_change integer, stage_seconds integer,
    finish_rank integer, finish_time_seconds integer, time_bonus_seconds integer,
    time_penalty_seconds integer, adjusted_time_seconds integer
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog AS $$
    WITH history AS (
        SELECT e.*, lag(e.cumulative_rank) OVER (PARTITION BY e.rider_key ORDER BY e.stage_order) AS prev
        FROM dw.gc_evolution(p_filters || '{"stage_scope":"final"}') e
    )
    SELECT h.rider_key, h.bib_number, h.rider_name, h.team_key, h.team_name,
           h.stage_id, h.stage_order, h.stage_type, h.stage_date, h.cumulative_rank, h.prev,
           h.prev - h.cumulative_rank, h.cumulative_seconds, h.cumulative_gap_seconds,
           h.stage_net_change_seconds, h.stage_seconds, f.finish_rank, f.finish_time_seconds,
           h.time_bonus_seconds, h.time_penalty_seconds, f.adjusted_time_seconds
    FROM history h
    JOIN dw.fact_results f ON f.stage_key = h.stage_key AND f.rider_key = h.rider_key
    WHERE CASE coalesce(p_filters->>'stage_scope', 'final')
        WHEN 'as_of' THEN h.stage_order <= coalesce((p_filters->>'as_of_stage')::int, 21)
        WHEN 'selection' THEN
            (p_filters->>'stage_ids' IS NULL OR p_filters->'stage_ids' @> to_jsonb(h.stage_id))
            AND (p_filters->>'stage_types' IS NULL OR p_filters->'stage_types' @> to_jsonb(h.stage_type))
        ELSE true END
    ORDER BY h.stage_order, h.cumulative_rank, h.rider_key;
$$;

CREATE OR REPLACE FUNCTION dw.gc_time_rules(p_filters jsonb DEFAULT '{}')
RETURNS TABLE (
    rider_key integer, bib_number integer, rider_name text, team_key integer, team_name text,
    scenario text, bonus_seconds integer, penalty_seconds integer, baseline_rank integer,
    baseline_seconds integer, baseline_gap integer, scenario_rank integer, rank_gain integer,
    scenario_seconds integer, scenario_gap integer, winning_margin integer
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = dw, pg_catalog AS $$
    WITH params AS (
        SELECT CASE WHEN p_filters->>'rank_scope' = 'filtered' THEN p_filters
                    ELSE p_filters - ARRAY['team_keys','rider_keys','young_only'] END AS cohort
    ), baseline AS (
        SELECT g.* FROM params p
        CROSS JOIN LATERAL dw.rider_standings(p.cohort || '{"classification":"gc","time_basis":"adjusted"}') g
    ), adjustments AS (
        SELECT f.rider_key, sum(f.time_bonus_seconds)::int AS bonus, sum(f.time_penalty_seconds)::int AS penalty
        FROM dw.fact_results f JOIN dw.dim_stage s ON s.stage_key = f.stage_key
        WHERE CASE coalesce(p_filters->>'stage_scope', 'final')
            WHEN 'as_of' THEN s.stage_order <= coalesce((p_filters->>'as_of_stage')::int, 21)
            WHEN 'selection' THEN
                (p_filters->>'stage_ids' IS NULL OR p_filters->'stage_ids' @> to_jsonb(s.stage_id))
                AND (p_filters->>'stage_types' IS NULL OR p_filters->'stage_types' @> to_jsonb(s.stage_type))
            ELSE true END
        GROUP BY f.rider_key
    ), alternatives AS (
        SELECT b.*, a.bonus, a.penalty, v.scenario, v.seconds
        FROM baseline b JOIN adjustments a ON a.rider_key = b.rider_key
        CROSS JOIN LATERAL (VALUES
            ('standard', b.total_seconds),
            ('no_bonus', b.total_seconds + a.bonus),
            ('no_penalty', b.total_seconds - a.penalty),
            ('raw', b.total_seconds + a.bonus - a.penalty)
        ) v(scenario, seconds)
    ), ranked AS (
        SELECT a.*, rank() OVER (PARTITION BY a.scenario ORDER BY a.seconds)::int AS pos,
               min(a.seconds) OVER (PARTITION BY a.scenario) AS lead_time,
               nth_value(a.seconds, 2) OVER (PARTITION BY a.scenario ORDER BY a.seconds, a.rider_key
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS runner_up
        FROM alternatives a
    )
    SELECT r.rider_key, r.bib_number, r.rider_name, r.team_key, r.team_name,
           r.scenario, r.bonus, r.penalty, r.rank, r.total_seconds, r.gap_seconds,
           r.pos, r.rank - r.pos, r.seconds, r.seconds - r.lead_time, r.runner_up - r.lead_time
    FROM ranked r
    WHERE (p_filters->>'rider_keys' IS NULL OR p_filters->'rider_keys' @> to_jsonb(r.rider_key))
      AND (p_filters->>'team_keys' IS NULL OR p_filters->'team_keys' @> to_jsonb(r.team_key))
      AND (NOT coalesce((p_filters->>'young_only')::boolean, false) OR r.is_young_rider)
    ORDER BY r.scenario, r.rank, r.rider_key;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tdf_reader') THEN
        GRANT EXECUTE ON FUNCTION dw.gc_comparison(jsonb), dw.gc_trajectory(jsonb), dw.gc_time_rules(jsonb) TO tdf_reader;
    END IF;
END $$;
