-- =============================================================================
-- Benchmark Query 1 (Normalized Schema: tdf)
-- Scope: Final General Classification (GC) across all 21 stages for complete
--        race finishers (21 stage results), using adjusted time and RANK() ties.
-- Columns: bib_number, rider_name, team_name, rider_country_name,
--          team_country_name, total_seconds, rank
-- =============================================================================

SELECT
    r.bib_number,
    r.rider_name,
    t.team_name,
    rc.country_name AS rider_country_name,
    tc.country_name AS team_country_name,
    SUM(res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) AS total_seconds,
    RANK() OVER (
        ORDER BY SUM(res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) ASC
    ) AS rank
FROM tdf.result AS res
INNER JOIN tdf.rider AS r
    ON r.bib_number = res.bib_number
INNER JOIN tdf.team AS t
    ON t.team_name = r.team_name
LEFT JOIN tdf.country AS rc
    ON rc.country_code = r.country_code
INNER JOIN tdf.country AS tc
    ON tc.country_code = t.country_code
GROUP BY
    r.bib_number,
    r.rider_name,
    t.team_name,
    rc.country_name,
    tc.country_name
HAVING COUNT(res.stage_id) = 21
ORDER BY
    rank ASC,
    r.bib_number ASC;
