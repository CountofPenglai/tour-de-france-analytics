-- =============================================================================
-- Benchmark Query 3 (Star Schema / Fact Constellation: dw)
-- Scope: Rider and team performance grouped by stage terrain (stage_type) and
--        route endpoint countries (start_country_name, finish_country_name).
-- Note: Star schema stores start/finish location and country attributes
--       denormalized directly on dw.dim_stage, eliminating intermediate
--       Location and Country snowflaked joins.
-- Columns: bib_number, rider_name, team_name, stage_type, start_country_name,
--          finish_country_name, stage_count, total_adjusted_seconds,
--          top10_count, avg_speed_kmh
-- =============================================================================

SELECT
    dr.bib_number,
    dr.rider_name,
    dt.team_name,
    ds.stage_type,
    ds.start_country_name,
    ds.finish_country_name,
    COUNT(fr.stage_key) AS stage_count,
    SUM(fr.adjusted_time_seconds) AS total_adjusted_seconds,
    COUNT(*) FILTER (WHERE fr.finish_rank <= 10) AS top10_count,
    ROUND(
        AVG((ds.distance_km::NUMERIC / fr.finish_time_seconds::NUMERIC) * 3600.0),
        4
    ) AS avg_speed_kmh
FROM dw.fact_results AS fr
INNER JOIN dw.dim_rider AS dr
    ON dr.rider_key = fr.rider_key
INNER JOIN dw.dim_team AS dt
    ON dt.team_key = fr.team_key
INNER JOIN dw.dim_stage AS ds
    ON ds.stage_key = fr.stage_key
GROUP BY
    dr.bib_number,
    dr.rider_name,
    dt.team_name,
    ds.stage_type,
    ds.start_country_name,
    ds.finish_country_name
ORDER BY
    dr.bib_number ASC,
    ds.stage_type ASC,
    ds.start_country_name ASC,
    ds.finish_country_name ASC;
