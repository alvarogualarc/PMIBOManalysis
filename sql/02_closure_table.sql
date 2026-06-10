-- =============================================================================
-- FILE: 02_closure_table.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: Build the BOM Closure Table from the raw BOM_ITEMS and PARTS tables
--          that the Python data generator populates.
--
-- WHAT IS A CLOSURE TABLE?
--   A closure table pre-materialises every ancestor–descendant relationship in
--   a tree, including multi-hop paths. Instead of traversing parent→child links
--   at query time, every reachable (ancestor, descendant) pair is stored as a
--   single row with depth and cumulative quantity. This turns expensive recursive
--   graph queries into simple WHERE clauses and enables sub-second explosion
--   on very deep BOMs.
--
-- SOURCE TABLES (created by Python data generator):
--   BOM_ITEMS   — edges: parent_id, child_id, qty, unit_of_measure, bom_version,
--                        eff_from, eff_to
--   PARTS       — nodes: part_id, part_name, category, description,
--                        unit_of_measure, supplier, standard_cost
--
-- OUTPUT:
--   BOM_CLOSURE — fully materialised closure with cumulative quantities,
--                 path strings, category metadata, and effectivity dates.
-- =============================================================================

USE ROLE      BOM_ADMIN;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;

-- =============================================================================
-- STEP 1 — COLD-START GUARD
--   Create BOM_CLOSURE as an empty shell (matching final schema) the very
--   first time this script runs. The SWAP in step 3 requires the target table
--   to already exist; this CREATE OR REPLACE is idempotent on subsequent runs
--   because we immediately SWAP onto the freshly built staging table.
-- =============================================================================
CREATE OR REPLACE TABLE BOM_CLOSURE (
    -- The part at the top of the path (could be a Product Variant or sub-assembly)
    ancestor_id         VARCHAR   COMMENT 'Part ID of the root / ancestor node in this path',
    -- The part at the bottom of the path (could be the same part when depth=0)
    descendant_id       VARCHAR   COMMENT 'Part ID of the leaf / descendant node',
    -- How many edges separate ancestor from descendant (0 = self-row)
    depth               INTEGER   COMMENT 'Number of BOM levels between ancestor and descendant. 0 = self.',
    -- Human-readable path string, e.g. "PV_MARLBORO_RED_PL>BLEND_01>TOBACCO_LEAF_VA"
    path                VARCHAR   COMMENT 'Ancestor-to-descendant path, parts separated by >',
    -- Net quantity of descendant needed to produce ONE unit of ancestor,
    -- accounting for all intermediate assembly yields.
    cum_qty             FLOAT     COMMENT 'Cumulative quantity: units of descendant per unit of ancestor',
    -- BOM version tag (e.g. GLOBAL, LOCAL, DRAFT-2024Q4)
    bom_version         VARCHAR   COMMENT 'BOM version identifier propagated from BOM_ITEMS',
    -- Effectivity window — the closure row is valid within [eff_from, eff_to]
    eff_from            DATE      COMMENT 'Start date of effectivity window (from BOM_ITEMS)',
    eff_to              DATE      COMMENT 'End date of effectivity window (from BOM_ITEMS); NULL = open-ended',
    -- Denormalised category labels from PARTS — avoids joins in downstream queries
    ancestor_category   VARCHAR   COMMENT 'PARTS.category of the ancestor part',
    descendant_category VARCHAR   COMMENT 'PARTS.category of the descendant part'
)
COMMENT = 'BOM Closure Table: every (ancestor, descendant) reachable pair with '
          'cumulative quantity and effectivity. Production data is maintained by '
          'the Dynamic Table in 03_dynamic_table.sql; this table is the manually-'
          'swapped POC variant.'
CLUSTER BY (ancestor_id, descendant_id);

-- =============================================================================
-- STEP 2 — BUILD BOM_CLOSURE_STAGING VIA RECURSIVE CTE
--
-- WHY RECURSIVE CTE?
--   Snowflake supports SQL-standard recursive CTEs (WITH RECURSIVE). We use it
--   to walk the BOM tree from every part downward, accumulating:
--     • depth   — incremented by 1 at each level
--     • cum_qty — multiplied by the child edge quantity at each level
--     • path    — appended with '>' + child_id at each level
--
-- EFFECTIVITY HANDLING:
--   We propagate the MINIMUM eff_from and MAXIMUM eff_to across the path so
--   that each closure row reflects the tightest effectivity window of all
--   edges traversed. A NULL eff_to (open-ended) is treated as 9999-12-31 for
--   MAX comparison, then converted back to NULL.
--
-- PERFORMANCE NOTE:
--   BOM trees in tobacco manufacturing rarely exceed 8–10 levels. Snowflake
--   caps recursive CTE iterations at 100 by default (sufficient here).
-- =============================================================================
CREATE OR REPLACE TABLE BOM_CLOSURE_STAGING AS
WITH RECURSIVE bom_tree AS (

    -- -----------------------------------------------------------------------
    -- ANCHOR: every part is its own ancestor at depth 0, cum_qty = 1.0
    -- This ensures every part appears in the closure even if it has no
    -- children (leaf parts) and allows "find all descendants of X" queries
    -- to use a single table without a UNION.
    -- -----------------------------------------------------------------------
    SELECT
        p.part_id                        AS ancestor_id,
        p.part_id                        AS descendant_id,
        0                                AS depth,
        p.part_id                        AS path,         -- seed path with self
        1.0                              AS cum_qty,
        NULL::VARCHAR                    AS bom_version,  -- no edge at depth 0
        NULL::DATE                       AS eff_from,
        NULL::DATE                       AS eff_to
    FROM PARTS p

    UNION ALL

    -- -----------------------------------------------------------------------
    -- RECURSIVE STEP: extend each existing path by one BOM_ITEMS edge.
    -- We join the current frontier (bom_tree) to BOM_ITEMS on:
    --   parent_id = current descendant_id
    -- This walks DOWN the tree level by level.
    -- -----------------------------------------------------------------------
    SELECT
        bt.ancestor_id                                    AS ancestor_id,
        bi.child_id                                       AS descendant_id,
        bt.depth + 1                                      AS depth,
        bt.path || '>' || bi.child_id                     AS path,
        bt.cum_qty * bi.qty                               AS cum_qty,
        bi.bom_version                                    AS bom_version,
        -- Tightest effectivity: max of the two eff_from values
        GREATEST(
            COALESCE(bt.eff_from, bi.eff_from),
            bi.eff_from
        )                                                 AS eff_from,
        -- Tightest effectivity: min of the two eff_to values (NULL → open-ended)
        CASE
            WHEN bt.eff_to IS NULL AND bi.eff_to IS NULL THEN NULL
            WHEN bt.eff_to IS NULL THEN bi.eff_to
            WHEN bi.eff_to IS NULL THEN bt.eff_to
            ELSE LEAST(bt.eff_to, bi.eff_to)
        END                                               AS eff_to
    FROM bom_tree bt
    JOIN BOM_ITEMS bi
      ON bi.parent_id = bt.descendant_id

)

-- Final SELECT: join PARTS twice to denormalise category onto both endpoints.
-- ancestor_category and descendant_category let analysts filter purely on the
-- closure table without an additional join to PARTS.
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
LEFT JOIN PARTS pa ON pa.part_id = bt.ancestor_id
LEFT JOIN PARTS pd ON pd.part_id = bt.descendant_id;

-- =============================================================================
-- STEP 3 — ATOMIC SWAP
--
-- WHY SWAP INSTEAD OF INSERT OVERWRITE?
--   ALTER TABLE … SWAP WITH is a metadata-only operation (zero-copy, instant).
--   It atomically exchanges BOM_CLOSURE_STAGING and BOM_CLOSURE so that:
--     a) Analysts running queries on BOM_CLOSURE see no downtime window.
--     b) The old BOM_CLOSURE data is immediately available in _STAGING for
--        rollback or diff comparison.
--   This is the standard Snowflake pattern for zero-downtime table refreshes.
-- =============================================================================
ALTER TABLE BOM_CLOSURE_STAGING SWAP WITH BOM_CLOSURE;

-- After the SWAP:
--   BOM_CLOSURE         → contains the freshly built data (was _STAGING)
--   BOM_CLOSURE_STAGING → contains the previous production data (safe to drop
--                         once validated)

-- =============================================================================
-- STEP 4 — CLUSTERING KEY
--
-- Almost all BOM queries filter or join on ancestor_id (explosion) or
-- descendant_id (where-used). Clustering on both eliminates full-table scans
-- on large BOMs and dramatically improves partition pruning for both access
-- patterns. Snowflake's Automatic Clustering will maintain this asynchronously.
-- =============================================================================
ALTER TABLE BOM_CLOSURE CLUSTER BY (ancestor_id, descendant_id);

-- =============================================================================
-- VALIDATION — quick row counts to confirm the build succeeded
-- =============================================================================
SELECT
    COUNT(*)                                         AS total_rows,
    COUNT(DISTINCT ancestor_id)                      AS distinct_ancestors,
    COUNT(DISTINCT descendant_id)                    AS distinct_descendants,
    MAX(depth)                                       AS max_depth,
    SUM(CASE WHEN depth = 0 THEN 1 ELSE 0 END)      AS self_rows,
    SUM(CASE WHEN depth > 0 THEN 1 ELSE 0 END)      AS relationship_rows
FROM BOM_CLOSURE;
