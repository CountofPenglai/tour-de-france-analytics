-- =============================================================================
-- Benchmark Query 3 (Normalized Schema: tdf)
-- Scope: Rider and team performance grouped by stage terrain (stage_type) and
--        route endpoint countries (start_country_name, finish_country_name).
-- Note: Normalized 3NF schema requires composite foreign-key joins from
--       tdf.stage -> tdf.location (start & finish) -> tdf.country (start & finish),
--       plus joins to tdf.rider and tdf.team.
-- Columns: bib_number, rider_name, team_name, stage_type, start_country_name,
--          finish_country_name, stage_count, total_adjusted_seconds,
--          top10_count, avg_speed_kmh
-- =============================================================================

SELECT
    r.bib_number,
    r.rider_name,
    t.team_name,
    s.stage_type,
    sc.country_name AS start_country_name,
    fc.country_name AS finish_country_name,
    COUNT(res.stage_id) AS stage_count,
    SUM(res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) AS total_adjusted_seconds,
    COUNT(*) FILTER (WHERE res.finish_rank <= 10) AS top10_count,
    ROUND(
        AVG((s.distance_km::NUMERIC / res.finish_time_seconds::NUMERIC) * 3600.0),
        4
    ) AS avg_speed_kmh
FROM tdf.result AS res
INNER JOIN tdf.rider AS r
    ON r.bib_number = res.bib_number
INNER JOIN tdf.team AS t
    ON t.team_name = r.team_name
INNER JOIN tdf.stage AS s
    ON s.stage_id = res.stage_id
INNER JOIN tdf.location AS sl
    ON sl.country_code = s.start_country_code
   AND sl.location_name = s.start_location_name
INNER JOIN tdf.country AS sc
    ON sc.country_code = sl.country_code
INNER JOIN tdf.location AS fl
    ON fl.country_code = s.finish_country_code
   AND fl.location_name = s.finish_location_name
INNER JOIN tdf.country AS fc
    ON fc.country_code = fl.country_code
GROUP BY
    r.bib_number,
    r.rider_name,
    t.team_name,
    s.stage_type,
    sc.country_name,
    fc.country_name
ORDER BY
    r.bib_number ASC,
    s.stage_type ASC,
    sc.country_name ASC,
    fc.country_name ASC;
