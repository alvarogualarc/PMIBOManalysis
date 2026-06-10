-- =============================================================================
-- FILE: 03_dynamic_table.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: Snowflake Dynamic Table for continuous BOM Closure refresh.
--
-- PRODUCTION PATTERN vs. POC PATTERN
--   02_closure_table.sql uses a manual recursive CTE build + atomic SWAP.
--   That approach is ideal for the initial POC data load and for scheduled
--   off-hours refreshes where a pipeline orchestrator (Airflow, dbt, etc.)
--   controls timing.
--
--   THIS FILE defines the production-grade alternative: a Snowflake Dynamic
--   Table. Dynamic Tables automatically re-execute their defining query
--   whenever the base tables (BOM_ITEMS, PARTS) have changed and the lag
--   target has elapsed. No external orchestration is needed.
--
-- HOW IT WORKS
--   • Snowflake monitors BOM_ITEMS and PARTS for DML changes.
--   • When changes are detected and TARGET_LAG has passed, Snowflake schedules
--     a refresh — either incremental (if Snowflake can infer a diff) or full.
--   • Because recursive CTEs cannot be incrementally refreshed, Snowflake will
--     use a FULL refresh strategy for this Dynamic Table. That is expected and
--     acceptable for BOM closures: the full graph must be recomputed any time
--     a BOM edge changes.
--   • TARGET_LAG = '1 day' means analysts will see BOM changes within 24 hours
--     of the upstream edit — appropriate for PMI's daily planning cycle.
--
-- COEXISTENCE WITH BOM_CLOSURE
--   BOM_CLOSURE (from 02_closure_table.sql) and BOM_CLOSURE_LIVE (this file)
--   can coexist. During the POC:
--     • BOM_CLOSURE_LIVE is the always-fresh read target for dashboards/BI.
--     • BOM_CLOSURE is used for what-if procedures and point-in-time snapshots.
--   In production, retire BOM_CLOSURE and route all reads to BOM_CLOSURE_LIVE.
-- =============================================================================

USE ROLE      BOM_ADMIN;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;

-- =============================================================================
-- CREATE OR REPLACE DYNAMIC TABLE BOM_CLOSURE_LIVE
-- =============================================================================
CREATE OR REPLACE DYNAMIC TABLE BOM_CLOSURE_LIVE

    -- Snowflake guarantees that data in this table is at most 1 day stale
    -- relative to BOM_ITEMS and PARTS at any point in time.
    TARGET_LAG  = '1 day'

    -- The warehouse used to execute refresh jobs. BOM_WH is MEDIUM, which
    -- comfortably handles the recursive CTE over typical PMI BOM sizes.
    WAREHOUSE   = BOM_WH

    COMMENT = 'Production Dynamic Table: auto-refreshing BOM Closure. '
              'Snowflake re-runs the recursive CTE whenever BOM_ITEMS or PARTS '
              'change. TARGET_LAG of 1 day matches PMI daily planning cadence. '
              'Replaces the manual swap pattern in 02_closure_table.sql for '
              'production use.'

AS

-- =============================================================================
-- DEFINING QUERY — identical recursive CTE logic to 02_closure_table.sql
-- Kept in-sync deliberately: both files must reflect the same BOM semantics.
-- =============================================================================
WITH RECURSIVE bom_tree AS (

    -- ANCHOR: self-rows — every part is its own ancestor at depth 0
    SELECT
        p.part_id          AS ancestor_id,
        p.part_id          AS descendant_id,
        0                  AS depth,
        p.part_id          AS path,
        1.0                AS cum_qty,
        NULL::VARCHAR      AS bom_version,
        NULL::DATE         AS eff_from,
        NULL::DATE         AS eff_to
    FROM PMI_CLIPP_POC.BOM_ANALYTICS.PARTS p

    UNION ALL

    -- RECURSIVE STEP: extend path by one BOM_ITEMS edge
    SELECT
        bt.ancestor_id,
        bi.child_id                                       AS descendant_id,
        bt.depth + 1                                      AS depth,
        bt.path || '>' || bi.child_id                     AS path,
        bt.cum_qty * bi.qty                               AS cum_qty,
        bi.bom_version,
        GREATEST(
            COALESCE(bt.eff_from, bi.eff_from),
            bi.eff_from
        )                                                 AS eff_from,
        CASE
            WHEN bt.eff_to IS NULL AND bi.eff_to IS NULL THEN NULL
            WHEN bt.eff_to IS NULL THEN bi.eff_to
            WHEN bi.eff_to IS NULL THEN bt.eff_to
            ELSE LEAST(bt.eff_to, bi.eff_to)
        END                                               AS eff_to
    FROM bom_tree bt
    JOIN PMI_CLIPP_POC.BOM_ANALYTICS.BOM_ITEMS bi
      ON bi.parent_id = bt.descendant_id

)
SELECT
    bt.ancestor_id,
    bt.descendant_id,
    bt.depth,
    bt.path,
    bt.cum_qty,
    bt.bom_version,
    bt.eff_from,
    bt.eff_to,
    pa.category  AS ancestor_category,
    pd.category  AS descendant_category
FROM bom_tree bt
LEFT JOIN PMI_CLIPP_POC.BOM_ANALYTICS.PARTS pa ON pa.part_id = bt.ancestor_id
LEFT JOIN PMI_CLIPP_POC.BOM_ANALYTICS.PARTS pd ON pd.part_id = bt.descendant_id;

-- =============================================================================
-- MONITORING: check refresh history and current lag
-- =============================================================================

-- Show the most recent refresh attempts, their status, and how long they took.
-- Run this after BOM_ITEMS is updated to confirm the refresh cycle completed.
SELECT *
FROM TABLE(
    INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
        NAME => 'PMI_CLIPP_POC.BOM_ANALYTICS.BOM_CLOSURE_LIVE'
    )
)
ORDER BY REFRESH_START_TIME DESC
LIMIT 20;

-- Simpler system function variant — returns lag metrics for the named table.
SELECT SYSTEM$GET_DYNAMIC_TABLE_REFRESH_HISTORY('BOM_ANALYTICS.BOM_CLOSURE_LIVE');

-- Show current Dynamic Table status including lag, refresh state, and scheduling.
SHOW DYNAMIC TABLES LIKE 'BOM_CLOSURE_LIVE' IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS;

-- =============================================================================
-- OPERATIONAL NOTES
-- =============================================================================
-- Force an immediate refresh (useful after a large BOM_ITEMS batch load):
--   ALTER DYNAMIC TABLE BOM_CLOSURE_LIVE REFRESH;
--
-- Suspend automatic refreshes (e.g. during a freeze period):
--   ALTER DYNAMIC TABLE BOM_CLOSURE_LIVE SUSPEND;
--
-- Resume:
--   ALTER DYNAMIC TABLE BOM_CLOSURE_LIVE RESUME;
--
-- Change lag target (e.g. tighten to 4 hours for near-real-time):
--   ALTER DYNAMIC TABLE BOM_CLOSURE_LIVE SET TARGET_LAG = '4 hours';
--
-- Drop (irreversible):
--   DROP DYNAMIC TABLE BOM_CLOSURE_LIVE;
-- =============================================================================
