-- =============================================================================
-- Benchmark Query 2 (Star Schema / Fact Constellation: dw)
-- Scope: Full 21-stage Team Classification under the official stage_top3 rule
--        (sum of the fastest 3 riders per team on each stage, requiring >= 3
--        finishers on every stage across all 21 stages).
-- Tie-break: Deterministic ROW_NUMBER() ordered by adjusted_time_seconds ASC,
--            bib_number ASC so distinct contributor_count is identical across
--            both models even when teammates finish in the same peloton time.
-- Columns: team_name, team_country_name, contributor_count, total_seconds, rank
-- =============================================================================

WITH ranked_team_stage AS (
    SELECT
        dt.team_name,
        tc.country_name AS team_country_name,
        ds.stage_id,
        dr.bib_number,
        fr.adjusted_time_seconds,
        ROW_NUMBER() OVER (
            PARTITION BY fr.team_key, fr.stage_key
            ORDER BY
                fr.adjusted_time_seconds ASC,
                dr.bib_number ASC
        ) AS rn_in_team_stage,
        COUNT(*) OVER (
            PARTITION BY fr.team_key, fr.stage_key
        ) AS team_stage_finishers
    FROM dw.fact_results AS fr
    INNER JOIN dw.dim_rider AS dr
        ON dr.rider_key = fr.rider_key
    INNER JOIN dw.dim_team AS dt
        ON dt.team_key = fr.team_key
    INNER JOIN dw.dim_country AS tc
        ON tc.country_key = fr.team_country_key
    INNER JOIN dw.dim_stage AS ds
        ON ds.stage_key = fr.stage_key
    WHERE ds.stage_id BETWEEN 1 AND /*MAX_STAGE_ID*/ 21
)
SELECT
    team_name,
    team_country_name,
    COUNT(DISTINCT bib_number) AS contributor_count,
    SUM(adjusted_time_seconds) AS total_seconds,
    RANK() OVER (
        ORDER BY SUM(adjusted_time_seconds) ASC
    ) AS rank
FROM ranked_team_stage
WHERE team_stage_finishers >= 3
  AND rn_in_team_stage <= 3
GROUP BY
    team_name,
    team_country_name
HAVING COUNT(DISTINCT stage_id) = /*MAX_STAGE_ID*/ 21
ORDER BY
    rank ASC,
    team_name ASC;
