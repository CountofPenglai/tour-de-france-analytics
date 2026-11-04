-- =============================================================================
-- Benchmark Query 2 (Normalized Schema: tdf)
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
        t.team_name,
        tc.country_name AS team_country_name,
        res.stage_id,
        r.bib_number,
        (res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) AS adjusted_time_seconds,
        ROW_NUMBER() OVER (
            PARTITION BY t.team_name, res.stage_id
            ORDER BY
                (res.finish_time_seconds - res.time_bonus_seconds + res.time_penalty_seconds) ASC,
                r.bib_number ASC
        ) AS rn_in_team_stage,
        COUNT(*) OVER (
            PARTITION BY t.team_name, res.stage_id
        ) AS team_stage_finishers
    FROM tdf.result AS res
    INNER JOIN tdf.rider AS r
        ON r.bib_number = res.bib_number
    INNER JOIN tdf.team AS t
        ON t.team_name = r.team_name
    INNER JOIN tdf.country AS tc
        ON tc.country_code = t.country_code
    INNER JOIN tdf.stage AS s
        ON s.stage_id = res.stage_id
    WHERE s.stage_id BETWEEN 1 AND /*MAX_STAGE_ID*/ 21
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
