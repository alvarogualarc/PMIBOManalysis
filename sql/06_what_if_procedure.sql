-- =============================================================================
-- FILE: 06_what_if_procedure.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: BOM What-If Analysis stored procedure.
--
-- BUSINESS CONTEXT
--   PMI supply chain and R&D teams frequently need to evaluate the impact of
--   substituting one BOM component for another BEFORE committing the change.
--   Examples:
--     • Cellulose acetate tow supplier change (quality upgrade or cost reduction)
--     • Filter segment geometry change (diameter / length / ventilation)
--     • Tobacco blend reformulation (regulatory / crop year)
--
--   In ANZO, this required a SPARQL construct query over the graph to hypothetically
--   re-route edges. In Snowflake, we achieve the same result with a pure-SQL
--   CTE overlay — no graph engine required.
--
-- HOW THE PROCEDURE WORKS (READ-ONLY — NO DATA MUTATION)
--   1. Find all (ancestor, old_component) pairs in BOM_CLOSURE where
--      descendant_id = OLD_COMPONENT. These are the affected PV paths.
--   2. For each affected path, construct a hypothetical overlay row replacing
--      OLD_COMPONENT with NEW_COMPONENT in the descendant_id column.
--   3. Return the side-by-side comparison: original row + hypothetical row.
--
--   IMPORTANT: No DML is executed. No temp tables are created or modified.
--   The entire result is computed in-memory via CTEs and returned as a result set.
--   This makes the procedure safe to run in any context, including by BOM_ANALYST.
-- =============================================================================

USE ROLE      BOM_ADMIN;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;

-- =============================================================================
-- STORED PROCEDURE: BOM_WHAT_IF
-- =============================================================================
CREATE OR REPLACE PROCEDURE BOM_WHAT_IF (
    OLD_COMPONENT VARCHAR   COMMENT 'part_id of the component to be hypothetically replaced',
    NEW_COMPONENT VARCHAR   COMMENT 'part_id of the replacement component'
)
RETURNS TABLE (
    pv_id                VARCHAR,
    pv_name              VARCHAR,
    market_code          VARCHAR,
    production_center    VARCHAR,
    original_component   VARCHAR,
    original_part_name   VARCHAR,
    replacement_component VARCHAR,
    replacement_part_name VARCHAR,
    original_qty         FLOAT,
    -- new_qty: carries the same cumulative quantity as the original path.
    -- Quantity-adjustment logic (e.g. density corrections) would be applied
    -- by the caller based on engineering specifications.
    new_qty              FLOAT,
    affected_depth       INTEGER,
    bom_version          VARCHAR,
    bom_path             VARCHAR,
    hypothetical_path    VARCHAR,
    eff_from             DATE,
    eff_to               DATE,
    cost_delta_per_unit  FLOAT
)
LANGUAGE SQL
COMMENT = 'Read-only what-if analysis: shows all PVs affected by replacing '
          'OLD_COMPONENT with NEW_COMPONENT in the BOM. No data is mutated. '
          'Returns side-by-side original vs. hypothetical component view.'
AS
DECLARE
    -- Cursor result variable — Snowflake SQL procedures return TABLE via RESULTSET
    result RESULTSET;
BEGIN
    -- -----------------------------------------------------------------------
    -- MAIN QUERY: pure CTE overlay, zero DML
    -- -----------------------------------------------------------------------
    result := (
        WITH

        -- Step 1: Find all affected (ancestor PV, path) rows in BOM_CLOSURE
        -- where OLD_COMPONENT appears as a descendant.
        affected_paths AS (
            SELECT
                cl.ancestor_id,
                cl.descendant_id         AS old_component_id,
                cl.depth                 AS affected_depth,
                cl.cum_qty               AS original_qty,
                cl.path                  AS original_path,
                cl.bom_version,
                cl.eff_from,
                cl.eff_to
            FROM BOM_CLOSURE_LIVE cl
            WHERE cl.descendant_id = :OLD_COMPONENT
              AND cl.depth         > 0
        ),

        -- Step 2: Hypothetical overlay — replace OLD_COMPONENT with NEW_COMPONENT
        -- in the path string and descendant_id. cum_qty is inherited from the
        -- original path (same structural position in the BOM).
        hypothetical_overlay AS (
            SELECT
                ap.ancestor_id,
                :NEW_COMPONENT                                       AS new_component_id,
                ap.affected_depth,
                ap.original_qty                                      AS new_qty,
                -- Replace old component ID in the path string with the new one
                REPLACE(ap.original_path, :OLD_COMPONENT, :NEW_COMPONENT) AS hypothetical_path,
                ap.original_path,
                ap.original_qty,
                ap.bom_version,
                ap.eff_from,
                ap.eff_to
            FROM affected_paths ap
        ),

        -- Step 3: Enrich with PV and PARTS metadata for a business-readable output
        enriched AS (
            SELECT
                ho.ancestor_id,
                ho.new_component_id,
                ho.affected_depth,
                ho.original_qty,
                ho.new_qty,
                ho.original_path,
                ho.hypothetical_path,
                ho.bom_version,
                ho.eff_from,
                ho.eff_to,
                pv.pv_name,
                pv.market_code,
                pv.production_center,
                p_old.part_name                                      AS original_part_name,
                p_old.standard_cost                                  AS original_unit_cost,
                p_new.part_name                                      AS replacement_part_name,
                p_new.standard_cost                                  AS replacement_unit_cost,
                -- Cost delta per PV unit: positive = more expensive replacement,
                -- negative = cheaper replacement
                ho.new_qty * (p_new.standard_cost - p_old.standard_cost) AS cost_delta_per_unit
            FROM hypothetical_overlay ho
            JOIN PRODUCT_VARIANTS pv
              ON pv.pv_id    = ho.ancestor_id
            -- LEFT JOINs: if OLD or NEW_COMPONENT is not yet in PARTS
            -- (e.g. NEW_COMPONENT is a candidate part not yet approved),
            -- the row is still returned with NULL part details.
            LEFT JOIN PARTS p_old
              ON p_old.part_id = :OLD_COMPONENT
            LEFT JOIN PARTS p_new
              ON p_new.part_id = :NEW_COMPONENT
        )

        -- Final projection: business-friendly column names
        SELECT
            ancestor_id                              AS pv_id,
            pv_name,
            market_code,
            production_center,
            :OLD_COMPONENT                           AS original_component,
            original_part_name,
            :NEW_COMPONENT                           AS replacement_component,
            replacement_part_name,
            original_qty,
            new_qty,
            affected_depth,
            bom_version,
            original_path                            AS bom_path,
            hypothetical_path,
            eff_from,
            eff_to,
            cost_delta_per_unit
        FROM enriched
        ORDER BY market_code, pv_name, affected_depth

    );

    RETURN TABLE(result);
END;

-- =============================================================================
-- GRANT PROCEDURE USAGE TO ANALYSTS
-- =============================================================================
GRANT USAGE ON PROCEDURE BOM_WHAT_IF(VARCHAR, VARCHAR) TO ROLE BOM_ANALYST;

-- =============================================================================
-- DEMO CALL
--
-- Scenario: evaluate impact of switching cellulose acetate tow supplier from
-- the standard grade to a premium-grade alternative across all affected PVs.
-- This is the typical input for an Engineering Change Order (ECO) feasibility
-- assessment.
-- =============================================================================
CALL BOM_WHAT_IF(
    'CELLULOSE_ACETATE_TOW_01',           -- OLD_COMPONENT: current standard tow
    'CELLULOSE_ACETATE_TOW_02_PREMIUM'    -- NEW_COMPONENT: candidate premium tow
);

-- =============================================================================
-- EXTENDED DEMO CALLS — other typical what-if scenarios
-- =============================================================================

-- Scenario: tobacco blend year-on-year reformulation
-- CALL BOM_WHAT_IF('BLEND_VA_BURLEY_2023', 'BLEND_VA_BURLEY_2024');

-- Scenario: filter paper supplier change
-- CALL BOM_WHAT_IF('FILTER_PAPER_STANDARD_60G', 'FILTER_PAPER_PREMIUM_62G');

-- Scenario: inner liner foil gauge change (cost reduction initiative)
-- CALL BOM_WHAT_IF('INNER_LINER_FOIL_14MIC', 'INNER_LINER_FOIL_12MIC');

-- =============================================================================
-- POST-CALL ANALYSIS PATTERN
--
-- The procedure returns a flat result set. Wrap it in a CTE to drive further
-- analysis, e.g. total cost impact across all affected markets:
--
--   WITH what_if AS (
--       SELECT * FROM TABLE(
--           RESULT_SCAN(LAST_QUERY_ID())   -- capture the CALL result
--       )
--   )
--   SELECT
--       market_code,
--       COUNT(DISTINCT pv_id)             AS affected_pvs,
--       SUM(cost_delta_per_unit)          AS total_cost_delta_per_market
--   FROM what_if
--   GROUP BY market_code
--   ORDER BY ABS(total_cost_delta_per_market) DESC;
-- =============================================================================
