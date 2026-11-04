-- =============================================================================
-- Benchmark Query 1 (Star Schema / Fact Constellation: dw)
-- Scope: Final General Classification (GC) across all 21 stages for complete
--        race finishers (fact_participation.finished_race_flag = 1), using
--        precomputed adjusted_time_seconds and RANK() ties.
-- Note: Maps dw.dim_country 'UNK' unknown member back to NULL for exact
--       relational result equivalence with tdf.
-- Columns: bib_number, rider_name, team_name, rider_country_name,
--          team_country_name, total_seconds, rank
-- =============================================================================

SELECT
    dr.bib_number,
    dr.rider_name,
    dt.team_name,
    CASE
        WHEN rc.country_code = 'UNK' THEN NULL
        ELSE rc.country_name
    END AS rider_country_name,
    tc.country_name AS team_country_name,
    SUM(fr.adjusted_time_seconds) AS total_seconds,
    RANK() OVER (
        ORDER BY SUM(fr.adjusted_time_seconds) ASC
    ) AS rank
FROM dw.fact_results AS fr
INNER JOIN dw.fact_participation AS fp
    ON fp.rider_key = fr.rider_key
INNER JOIN dw.dim_rider AS dr
    ON dr.rider_key = fr.rider_key
INNER JOIN dw.dim_team AS dt
    ON dt.team_key = fr.team_key
INNER JOIN dw.dim_country AS rc
    ON rc.country_key = fr.rider_country_key
INNER JOIN dw.dim_country AS tc
    ON tc.country_key = fr.team_country_key
WHERE fp.finished_race_flag = 1
GROUP BY
    dr.bib_number,
    dr.rider_name,
    dt.team_name,
    rc.country_code,
    rc.country_name,
    tc.country_name
ORDER BY
    rank ASC,
    dr.bib_number ASC;
