-- Run against the loaded 2025 race warehouse after applying the report functions.
DO $$
DECLARE
    jonas integer;
    visma integer;
    scope jsonb;
    full_team record;
    observed record;
BEGIN
    SELECT r.rider_key, fp.team_key INTO STRICT jonas, visma
    FROM dw.dim_rider r JOIN dw.fact_participation fp USING (rider_key)
    WHERE r.rider_name = 'Jonas Vingegaard';
    scope := jsonb_build_object('rider_keys', jsonb_build_array(jonas));
    SELECT * INTO STRICT observed FROM dw.terrain_performance(scope || '{"rank_scope":"overall"}')
    WHERE entity_kind = 'rider' AND stage_type = 'mountain';
    IF (observed.baseline_rank, observed.mountain_rank, observed.terrain_rank_gain, observed.ranked_entities)
       IS DISTINCT FROM (9, 7, 2, 172) THEN
        RAISE EXCEPTION 'Overall rider filter changed the full-field ranks: %', observed;
    END IF;
    SELECT * INTO STRICT observed FROM dw.terrain_performance(scope || '{"rank_scope":"filtered"}')
    WHERE entity_kind = 'rider' AND stage_type = 'mountain';
    IF (observed.baseline_rank, observed.mountain_rank, observed.terrain_rank_gain, observed.ranked_entities)
       IS DISTINCT FROM (1, 1, 0, 1) THEN
        RAISE EXCEPTION 'Single-rider filtered cohort did not re-rank: %', observed;
    END IF;
    SELECT * INTO STRICT full_team FROM dw.terrain_performance()
    WHERE entity_kind = 'team' AND entity_key = visma AND stage_type = 'mountain';
    SELECT * INTO STRICT observed FROM dw.terrain_performance(scope)
    WHERE entity_kind = 'team' AND stage_type = 'mountain';
    IF (observed.sample_count, observed.speed_kmh, observed.baseline_rank, observed.mountain_rank, observed.ranked_entities)
       IS DISTINCT FROM (full_team.sample_count, full_team.speed_kmh, full_team.baseline_rank, full_team.mountain_rank, 23) THEN
        RAISE EXCEPTION 'Member selection changed full-team speed or overall position: %', observed;
    END IF;
    SELECT * INTO STRICT observed FROM dw.terrain_performance(scope || '{"rank_scope":"filtered"}')
    WHERE entity_kind = 'team' AND stage_type = 'mountain';
    IF (observed.sample_count, observed.speed_kmh, observed.baseline_rank, observed.mountain_rank, observed.ranked_entities)
       IS DISTINCT FROM (full_team.sample_count, full_team.speed_kmh, 1, 1, 1) THEN
        RAISE EXCEPTION 'Filtered team cohort or whole-team speed is incorrect: %', observed;
    END IF;
END $$;
