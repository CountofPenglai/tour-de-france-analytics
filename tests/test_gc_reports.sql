-- Run after the Tour de France fixture and 004_gc_reports.sql.
DO $$
DECLARE
    comparison record;
    n integer;
    margin integer;
    separation integer;
BEGIN
    SELECT count(*) INTO n FROM dw.gc_comparison('{}');
    ASSERT n = 160, 'final cohort';
    SELECT * INTO STRICT comparison FROM dw.gc_comparison('{}') WHERE rider_name = 'Ben O''Connor';
    ASSERT comparison.gc_rank = 11 AND comparison.mountain_gc_rank = 8, 'mountain comparison';
    SELECT * INTO STRICT comparison FROM dw.gc_comparison(jsonb_build_object('rider_keys', array[comparison.rider_key]));
    ASSERT comparison.gc_rank = 11 AND comparison.mountain_rank_gain = 3, 'overall rank before display filters';
    SELECT count(*) INTO n FROM dw.gc_comparison('{"stage_scope":"selection","stage_ids":[]}');
    ASSERT n = 0, 'empty stage choice';
    SELECT count(*) INTO n FROM dw.gc_comparison('{"stage_scope":"as_of","as_of_stage":1}') WHERE mountain_gc_rank IS NOT NULL;
    ASSERT n = 0, 'no mountains before stage two';
    SELECT count(*) INTO n FROM dw.gc_time_rules('{}');
    ASSERT n = 640, 'four scenarios for every finisher';
    SELECT max(winning_margin) INTO margin FROM dw.gc_time_rules('{}') WHERE scenario = 'standard';
    ASSERT margin = 264, 'adjusted margin';
    SELECT max(winning_margin) INTO margin FROM dw.gc_time_rules('{}') WHERE scenario = 'raw';
    ASSERT margin = 246, 'raw margin';
    SELECT count(*) INTO n FROM dw.gc_time_rules('{}') WHERE (baseline_rank <= 10) <> (scenario_rank <= 10);
    ASSERT n = 0, 'unchanged final top ten in four scenarios';
    SELECT count(*) INTO n FROM dw.gc_time_rules('{"stage_scope":"as_of","as_of_stage":1}') WHERE scenario = 'raw' AND scenario_rank=1;
    ASSERT n > 1, 'raw first-stage tie';
    SELECT max(winning_margin) INTO margin FROM dw.gc_time_rules('{"rider_keys":[1]}') WHERE scenario='raw';
    ASSERT margin = 246, 'overall winning margin before a rider filter';
    SELECT max(daily_gap_change) - min(daily_gap_change) INTO separation
    FROM dw.gc_trajectory('{"stage_scope":"selection","stage_ids":[12]}');
    ASSERT separation = 252, 'selected stage delta uses its actual predecessor';
    SELECT count(*) INTO n FROM dw.gc_trajectory('{"stage_scope":"selection","stage_ids":[12]}')
    WHERE previous_rank IS NOT NULL AND rank_gain = previous_rank - cumulative_rank;
    ASSERT n = 5, 'selected stage rank change uses stage 11';
END $$;
