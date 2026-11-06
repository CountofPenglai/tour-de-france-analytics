-- Run against the course warehouse after loading 003_analytics.sql and 006_country_reports.sql.
DO $checks$
DECLARE
    france record;
    scoped record;
    uae record;
BEGIN
    SELECT * INTO STRICT france FROM dw.country_outcomes('{}') WHERE country_code = 'FRA';
    ASSERT (france.rider_count, france.team_count, france.best_gc_rank, france.stage_wins, france.podium_finishes)
         = (38, 5, 7, 1, 2), 'French nationality, registration or result role is incorrect';
    ASSERT france.best_gc_riders->0->>'bib_number' = '131', 'Wrong French GC rider';
    SELECT * INTO STRICT uae FROM dw.country_outcomes('{}') WHERE country_code = 'UAE';
    ASSERT uae.rider_count = 0 AND uae.team_count = 1 AND uae.best_gc_rank IS NULL
       AND uae.best_gc_riders = '[]'::jsonb AND uae.stage_wins = 0, 'Registration-only country lost';

    ASSERT (SELECT SUM(stage_wins) = 21 AND SUM(podium_finishes) = 63 FROM dw.country_outcomes('{}')),
        'Full-race win or podium totals incorrect';
    ASSERT (SELECT COUNT(*) = 6 FROM dw.country_outcomes('{}') c, jsonb_array_elements(c.podium_rows) e
            WHERE e->>'participation_status' = 'exited'), 'Podium evidence lost later exits';
    SELECT * INTO STRICT scoped FROM dw.country_outcomes('{"stage_scope":"selection","stage_ids":[],
        "rank_scope":"filtered","classification":"young","time_basis":"finish"}') WHERE country_code = 'FRA';
    ASSERT scoped.stage_wins = 0 AND scoped.podium_finishes = 0 AND scoped.podium_rows = '[]'::jsonb,
        'Empty stage selection widened the medal scope';
    ASSERT scoped.rider_count = france.rider_count AND scoped.team_count = france.team_count AND
           scoped.best_gc_rank = france.best_gc_rank AND scoped.best_gc_riders = france.best_gc_riders,
        'Fixed whole-race measures changed with stage, timing or rank controls';
    ASSERT NOT EXISTS (SELECT FROM dw.country_outcomes('{"rider_keys":[]}')), 'Empty rider scope widened';
    ASSERT (SELECT SUM(stage_wins) = 1 AND SUM(podium_finishes) = 3 FROM
            dw.country_outcomes('{"stage_scope":"selection","stage_ids":[5],"stage_types":["individual time-trial"]}')),
        'Selected-stage medal count incorrect';

    ASSERT (SELECT stage_id = 2 AND distance_km = 209.1 FROM dw.route_directory('{}')
            ORDER BY distance_km DESC, stage_order LIMIT 1), 'Longest route incorrect';
    ASSERT (SELECT array_agg(stage_id ORDER BY stage_order) = ARRAY[5,13] AND
                   array_agg(winner_names[1] ORDER BY stage_order) = ARRAY['Remco Evenepoel','Tadej Pogacar']
            FROM dw.route_directory('{"stage_types":["individual time-trial"]}')), 'ITT winners incorrect';
    ASSERT NOT EXISTS (SELECT FROM dw.route_directory('{"stage_ids":[]}')), 'Empty route scope widened';
END
$checks$;
