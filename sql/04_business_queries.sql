-- =============================================================================
-- FILE: 04_business_queries.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: 19 parameterised business queries mapped to the PMI BRD.
--
-- USAGE:
--   Replace :param_name placeholders with values before running, or bind them
--   via your BI tool / Snowflake Python Connector parameter binding.
--   All queries target BOM_CLOSURE_LIVE for freshness; substitute BOM_CLOSURE
--   for point-in-time snapshot analysis.
--
-- ASSUMED SCHEMA (tables not in 02/03 but referenced by BRD queries):
--   PRODUCT_VARIANTS  — pv_id, pv_name, global_product_name, market_code,
--                       production_center, category, status
--   PROJECTS          — project_id, project_name, market_code, status,
--                       phase, planned_date, status_changed_date, created_at
--   PV_PROJECT        — pv_id, project_id (M:N link)
--   BOM_REVISIONS     — revision_id, part_id, bom_version, revision_date,
--                       changed_by, change_description, eff_from, eff_to
--   ECO               — eco_id, eco_number, description, status, created_date
--   ECO_PARTS         — eco_id, part_id, change_type
--   PLANNING          — pv_id, market_code, planned_volume FLOAT,
--                       planning_period_start DATE, planning_period_end DATE
-- =============================================================================

USE ROLE      BOM_ANALYST;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;

-- ============================================================================
/*
  BQ-01: Tobacco Leaf Procurement Planning
  How much tobacco leaf (by blend type) needs to be ordered based on PV planning?
  -- PARAM: planning_period_start = '2025-01-01'
  -- PARAM: planning_period_end   = '2025-12-31'
  -- PARAM: market_code           = 'PL'
*/
-- RETURNS: For each Product Variant and leaf part, the gross weight of tobacco
--          leaf required over the planning horizon (cum_qty × planned_volume).
-- ============================================================================
SELECT
    pv.pv_id                                         AS product_variant_id,
    pv.pv_name                                       AS product_variant_name,
    pv.market_code,
    p.part_name                                      AS tobacco_leaf_part,
    p.part_id                                        AS tobacco_leaf_part_id,
    p.supplier                                       AS leaf_supplier,
    pl.planned_volume                                AS planned_units,
    cl.cum_qty                                       AS leaf_qty_per_unit,
    pl.planned_volume * cl.cum_qty                   AS total_leaf_required,
    p.unit_of_measure                                AS leaf_uom,
    p.description                                    AS blend_description
FROM PRODUCT_VARIANTS pv
JOIN PLANNING pl
  ON pl.pv_id          = pv.pv_id
 AND pl.market_code    = pv.market_code
 AND pl.planning_period_start >= :planning_period_start
 AND pl.planning_period_end   <= :planning_period_end
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id    = pv.pv_id
 AND cl.depth          > 0
JOIN PARTS p
  ON p.part_id         = cl.descendant_id
 AND p.category        = 'Tobacco Leaf'
WHERE pv.market_code   = :market_code
ORDER BY pv.pv_name, p.part_name;


-- ============================================================================
/*
  BQ-02: All BOMs for a Given Market
  List all BOMs (PV + key attributes) for Product Variants in a specific market.
  -- PARAM: market_code = 'JP'
*/
-- RETURNS: Every PV active in the market with its top-level BOM summary:
--          number of distinct components, max depth, and BOM version.
-- ============================================================================
SELECT
    pv.pv_id                                         AS product_variant_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    pv.production_center,
    pv.category                                      AS product_category,
    pv.status                                        AS pv_status,
    cl.bom_version,
    COUNT(DISTINCT cl.descendant_id)                 AS total_components,
    MAX(cl.depth)                                    AS max_bom_depth,
    MIN(cl.eff_from)                                 AS bom_eff_from,
    MAX(cl.eff_to)                                   AS bom_eff_to
FROM PRODUCT_VARIANTS pv
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id    = pv.pv_id
 AND cl.depth          > 0
WHERE pv.market_code   = :market_code
GROUP BY
    pv.pv_id, pv.pv_name, pv.global_product_name,
    pv.market_code, pv.production_center,
    pv.category, pv.status, cl.bom_version
ORDER BY pv.pv_name, cl.bom_version;


-- ============================================================================
/*
  BQ-03: Projects by PV (Launch Pipeline Status)
  List all projects in different statuses created for launching a specific PV.
  -- PARAM: pv_id = 'PV_MARLBORO_RED_PL_001'
*/
-- RETURNS: All projects linked to the PV, with status, phase, and dates.
-- ============================================================================
SELECT
    pv.pv_id,
    pv.pv_name                                       AS product_variant_name,
    pv.market_code,
    pr.project_id,
    pr.project_name,
    pr.status                                        AS project_status,
    pr.phase                                         AS current_phase,
    pr.planned_date                                  AS target_launch_date,
    pr.created_at                                    AS project_created_date,
    pr.status_changed_date                           AS last_status_change
FROM PRODUCT_VARIANTS pv
JOIN PV_PROJECT pvp
  ON pvp.pv_id        = pv.pv_id
JOIN PROJECTS pr
  ON pr.project_id    = pvp.project_id
WHERE pv.pv_id        = :pv_id
ORDER BY pr.created_at DESC;


-- ============================================================================
/*
  BQ-04: BOM Version History for a PV
  List all BOM revisions for a specific PV: version history, effectivity,
  and what changed in each revision.
  -- PARAM: pv_id = 'PV_MARLBORO_RED_PL_001'
*/
-- RETURNS: Ordered revision history with change author and description.
-- ============================================================================
SELECT
    rev.revision_id,
    rev.part_id                                      AS bom_item_id,
    p.part_name                                      AS bom_item_name,
    rev.bom_version,
    rev.revision_date,
    rev.eff_from,
    rev.eff_to,
    rev.changed_by,
    rev.change_description
FROM BOM_REVISIONS rev
JOIN PARTS p
  ON p.part_id        = rev.part_id
WHERE rev.part_id     = :pv_id
ORDER BY rev.revision_date DESC;


-- ============================================================================
/*
  BQ-05: Full BOM Explosion — All Parts for a Specific PV
  Get all parts needed to produce a specific BOM item (full multi-level explosion).
  -- PARAM: pv_id = 'PV_MARLBORO_RED_PL_001'
*/
-- RETURNS: Every component at every depth under the PV, with cumulative
--          quantities, categories, and path strings for drill-down.
-- ============================================================================
SELECT
    cl.ancestor_id                                   AS top_level_pv,
    cl.descendant_id                                 AS component_id,
    p.part_name                                      AS component_name,
    p.category                                       AS component_category,
    p.supplier,
    p.standard_cost                                  AS unit_cost,
    cl.depth                                         AS bom_level,
    cl.path                                          AS bom_path,
    cl.cum_qty                                       AS qty_per_pv_unit,
    p.unit_of_measure,
    cl.cum_qty * p.standard_cost                     AS extended_cost_per_pv_unit,
    cl.bom_version,
    cl.eff_from,
    cl.eff_to
FROM BOM_CLOSURE_LIVE cl
JOIN PARTS p
  ON p.part_id         = cl.descendant_id
WHERE cl.ancestor_id   = :pv_id
  AND cl.depth         > 0
ORDER BY cl.depth, cl.descendant_id;


-- ============================================================================
/*
  BQ-06: Where-Used — All PVs That Use a Specific Part
  Find every Product Variant that contains a specific component at any BOM level.
  -- PARAM: part_id = 'CELLULOSE_ACETATE_TOW_01'
*/
-- RETURNS: Every PV that depends on the part, with depth, market, and quantity
--          context — essential for supply disruption impact analysis.
-- ============================================================================
SELECT
    cl.descendant_id                                 AS component_id,
    p_comp.part_name                                 AS component_name,
    cl.ancestor_id                                   AS product_variant_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    pv.production_center,
    cl.depth                                         AS bom_level,
    cl.cum_qty                                       AS qty_per_pv_unit,
    cl.bom_version,
    cl.eff_from,
    cl.eff_to
FROM BOM_CLOSURE_LIVE cl
JOIN PRODUCT_VARIANTS pv
  ON pv.pv_id           = cl.ancestor_id
JOIN PARTS p_comp
  ON p_comp.part_id     = cl.descendant_id
WHERE cl.descendant_id  = :part_id
  AND cl.depth          > 0
ORDER BY pv.market_code, pv.pv_name;


-- ============================================================================
/*
  BQ-07: BOM Comparison — Two Product Variants Side by Side
  Find parts common to both PVs and parts unique to each (set difference).
  -- PARAM: pv_a = 'PV_MARLBORO_RED_PL_001'
  -- PARAM: pv_b = 'PV_MARLBORO_RED_FR_001'
*/
-- RETURNS: Three sections — (1) only in PV_A, (2) only in PV_B,
--          (3) in both with quantity comparison. Useful for localisation review.
-- ============================================================================
WITH bom_a AS (
    SELECT descendant_id, cum_qty, depth
    FROM BOM_CLOSURE_LIVE
    WHERE ancestor_id = :pv_a AND depth > 0
),
bom_b AS (
    SELECT descendant_id, cum_qty, depth
    FROM BOM_CLOSURE_LIVE
    WHERE ancestor_id = :pv_b AND depth > 0
),
comparison AS (
    -- Parts only in PV_A
    SELECT
        p.part_id, p.part_name, p.category,
        a.cum_qty AS qty_in_pv_a,
        NULL      AS qty_in_pv_b,
        a.depth   AS depth_in_pv_a,
        NULL      AS depth_in_pv_b,
        'Only in PV_A' AS membership
    FROM bom_a a
    JOIN PARTS p ON p.part_id = a.descendant_id
    WHERE a.descendant_id NOT IN (SELECT descendant_id FROM bom_b)

    UNION ALL

    -- Parts only in PV_B
    SELECT
        p.part_id, p.part_name, p.category,
        NULL      AS qty_in_pv_a,
        b.cum_qty AS qty_in_pv_b,
        NULL      AS depth_in_pv_a,
        b.depth   AS depth_in_pv_b,
        'Only in PV_B' AS membership
    FROM bom_b b
    JOIN PARTS p ON p.part_id = b.descendant_id
    WHERE b.descendant_id NOT IN (SELECT descendant_id FROM bom_a)

    UNION ALL

    -- Parts in both — show quantity delta
    SELECT
        p.part_id, p.part_name, p.category,
        a.cum_qty AS qty_in_pv_a,
        b.cum_qty AS qty_in_pv_b,
        a.depth   AS depth_in_pv_a,
        b.depth   AS depth_in_pv_b,
        'In Both'  AS membership
    FROM bom_a a
    JOIN bom_b b ON b.descendant_id = a.descendant_id
    JOIN PARTS p ON p.part_id       = a.descendant_id
)
SELECT
    membership,
    part_id,
    part_name,
    category,
    qty_in_pv_a,
    qty_in_pv_b,
    (qty_in_pv_b - qty_in_pv_a) AS qty_delta,
    depth_in_pv_a,
    depth_in_pv_b
FROM comparison
ORDER BY membership, category, part_name;


-- ============================================================================
/*
  BQ-08: Global BOM vs. Local BOM Comparison for a PV
  Compare the GLOBAL (standard) BOM against the LOCAL (market-adapted) BOM
  for the same Product Variant to identify localisation deltas.
  -- PARAM: pv_id = 'PV_PARLIAMENT_AQUA_JP_001'
*/
-- RETURNS: Each component showing its presence/quantity in GLOBAL vs LOCAL.
-- ============================================================================
WITH global_bom AS (
    SELECT descendant_id, cum_qty, depth, path
    FROM BOM_CLOSURE_LIVE
    WHERE ancestor_id = :pv_id AND bom_version = 'GLOBAL' AND depth > 0
),
local_bom AS (
    SELECT descendant_id, cum_qty, depth, path
    FROM BOM_CLOSURE_LIVE
    WHERE ancestor_id = :pv_id AND bom_version = 'LOCAL'  AND depth > 0
)
SELECT
    COALESCE(g.descendant_id, l.descendant_id)       AS component_id,
    p.part_name,
    p.category,
    g.cum_qty                                        AS global_qty,
    l.cum_qty                                        AS local_qty,
    (l.cum_qty - g.cum_qty)                          AS qty_delta,
    g.depth                                          AS global_depth,
    l.depth                                          AS local_depth,
    CASE
        WHEN g.descendant_id IS NULL THEN 'Local Addition'
        WHEN l.descendant_id IS NULL THEN 'Local Removal'
        WHEN g.cum_qty <> l.cum_qty  THEN 'Qty Changed'
        ELSE 'Unchanged'
    END                                              AS change_type
FROM global_bom g
FULL OUTER JOIN local_bom l
  ON l.descendant_id = g.descendant_id
JOIN PARTS p
  ON p.part_id = COALESCE(g.descendant_id, l.descendant_id)
ORDER BY change_type, p.category, p.part_name;


-- ============================================================================
/*
  BQ-09: Engineering Change Orders (ECOs) and Affected Parts / PVs
  Retrieve all ECOs and the Product Variants affected by each change.
  -- PARAM: eco_status = 'Approved'
*/
-- RETURNS: Each ECO with the parts it changes and every PV that contains
--          those parts (the impact footprint of the ECO).
-- ============================================================================
SELECT
    e.eco_id,
    e.eco_number,
    e.description                                    AS eco_description,
    e.status                                         AS eco_status,
    e.created_date                                   AS eco_created_date,
    ep.part_id                                       AS changed_part_id,
    p.part_name                                      AS changed_part_name,
    ep.change_type,
    cl.ancestor_id                                   AS affected_pv_id,
    pv.pv_name                                       AS affected_pv_name,
    pv.market_code                                   AS affected_market,
    cl.depth                                         AS part_depth_in_pv
FROM ECO e
JOIN ECO_PARTS ep
  ON ep.eco_id        = e.eco_id
JOIN PARTS p
  ON p.part_id        = ep.part_id
JOIN BOM_CLOSURE_LIVE cl
  ON cl.descendant_id = ep.part_id
 AND cl.depth         > 0
JOIN PRODUCT_VARIANTS pv
  ON pv.pv_id         = cl.ancestor_id
WHERE e.status        = :eco_status
ORDER BY e.eco_number, ep.part_id, pv.market_code;


-- ============================================================================
/*
  BQ-10: Tobacco Blend by Year and Market
  Retrieve the tobacco blend type used in a specific calendar year and market
  for all PVs (supports annual blend procurement planning).
  -- PARAM: blend_year  = 2025
  -- PARAM: market_code = 'FR'
*/
-- RETURNS: Each PV in the market with its blend component(s) valid in that year.
-- ============================================================================
SELECT
    pv.pv_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    cl.descendant_id                                 AS blend_component_id,
    p.part_name                                      AS blend_component_name,
    p.category                                       AS component_category,
    p.description                                    AS blend_description,
    cl.cum_qty                                       AS blend_qty_per_unit,
    p.unit_of_measure,
    cl.eff_from,
    cl.eff_to,
    cl.bom_version
FROM PRODUCT_VARIANTS pv
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id        = pv.pv_id
 AND cl.depth              > 0
 AND cl.descendant_category = 'Tobacco Blend'
 AND YEAR(cl.eff_from)     <= :blend_year
 AND (cl.eff_to IS NULL OR YEAR(cl.eff_to) >= :blend_year)
JOIN PARTS p
  ON p.part_id             = cl.descendant_id
WHERE pv.market_code       = :market_code
ORDER BY pv.pv_name, p.part_name;


-- ============================================================================
/*
  BQ-11: Plant-to-Plant Specification Comparison for Marlboro Red
  Compare Marlboro Red specs produced in different production centers
  to detect inter-plant BOM divergence.
  -- PARAM: global_product_name_pattern = '%Marlboro Red%'
*/
-- RETURNS: Component-level spec differences grouped by production center,
--          showing where local adaptations exist.
-- ============================================================================
SELECT
    pv.global_product_name,
    pv.production_center,
    pv.market_code,
    cl.descendant_id                                 AS component_id,
    p.part_name                                      AS component_name,
    p.category                                       AS component_category,
    cl.cum_qty                                       AS qty_per_unit,
    p.unit_of_measure,
    cl.bom_version,
    cl.depth                                         AS bom_level
FROM PRODUCT_VARIANTS pv
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id          = pv.pv_id
 AND cl.depth                > 0
JOIN PARTS p
  ON p.part_id               = cl.descendant_id
WHERE pv.global_product_name LIKE :global_product_name_pattern
ORDER BY pv.production_center, cl.depth, p.category, p.part_name;


-- ============================================================================
/*
  BQ-12: All BOM Solutions (Items) Used in a Specific Market
  Retrieve every distinct BOM solution (assembly/sub-assembly) used across all
  PVs in a market — useful for market-level component rationalisation.
  -- PARAM: market_code = 'PL'
*/
-- RETURNS: Unique component list with usage count (how many PVs use it).
-- ============================================================================
SELECT
    cl.descendant_id                                 AS component_id,
    p.part_name                                      AS component_name,
    p.category                                       AS component_category,
    p.supplier,
    p.unit_of_measure,
    p.standard_cost,
    COUNT(DISTINCT cl.ancestor_id)                   AS pv_usage_count,
    MIN(cl.cum_qty)                                  AS min_qty_per_pv,
    MAX(cl.cum_qty)                                  AS max_qty_per_pv,
    AVG(cl.cum_qty)                                  AS avg_qty_per_pv
FROM PRODUCT_VARIANTS pv
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id    = pv.pv_id
 AND cl.depth          > 0
JOIN PARTS p
  ON p.part_id         = cl.descendant_id
WHERE pv.market_code   = :market_code
GROUP BY
    cl.descendant_id, p.part_name, p.category,
    p.supplier, p.unit_of_measure, p.standard_cost
ORDER BY pv_usage_count DESC, p.category, p.part_name;


-- ============================================================================
/*
  BQ-13: Parts with No Revision in the Past N Years
  Find parts that may be stale or under-maintained — no BOM revision recorded
  within the specified number of years.
  -- PARAM: years_without_revision = 2
*/
-- RETURNS: Parts with their last known revision date and how long ago it was.
-- ============================================================================
SELECT
    p.part_id,
    p.part_name,
    p.category,
    p.supplier,
    p.standard_cost,
    MAX(rev.revision_date)                                    AS last_revision_date,
    DATEDIFF('day', MAX(rev.revision_date), CURRENT_DATE)     AS days_since_revision,
    CASE WHEN MAX(rev.revision_date) IS NULL THEN 'Never Revised' ELSE 'Stale' END AS revision_status
FROM PARTS p
LEFT JOIN BOM_REVISIONS rev
  ON rev.part_id         = p.part_id
GROUP BY p.part_id, p.part_name, p.category, p.supplier, p.standard_cost
HAVING MAX(rev.revision_date) < DATEADD('year', -:years_without_revision, CURRENT_DATE)
    OR MAX(rev.revision_date) IS NULL
ORDER BY last_revision_date NULLS FIRST, days_since_revision DESC;


-- ============================================================================
/*
  BQ-14: PVs Planned for Launch in a Date Window
  List all Product Variants whose launch project falls within a specified window.
  -- PARAM: start_date = '2025-01-01'
  -- PARAM: end_date   = '2025-12-31'
*/
-- RETURNS: PV and project details for upcoming launches — supports pipeline review.
-- ============================================================================
SELECT
    pv.pv_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    pv.production_center,
    pr.project_id,
    pr.project_name,
    pr.phase,
    pr.planned_date                                  AS planned_launch_date,
    pr.status                                        AS project_status,
    pr.created_at                                    AS project_created_date
FROM PRODUCT_VARIANTS pv
JOIN PV_PROJECT pvp
  ON pvp.pv_id        = pv.pv_id
JOIN PROJECTS pr
  ON pr.project_id    = pvp.project_id
WHERE pr.phase        = 'Launch'
  AND pr.planned_date BETWEEN :start_date AND :end_date
ORDER BY pr.planned_date, pv.market_code, pv.pv_name;


-- ============================================================================
/*
  BQ-15: Project Status Snapshot — Set of Projects
  Retrieve the current status of a defined list of project IDs.
  -- PARAM: project_ids = 'PROJ_001','PROJ_002','PROJ_003'
*/
-- RETURNS: Current status, phase, and key dates for each project.
-- ============================================================================
SELECT
    pr.project_id,
    pr.project_name,
    pr.market_code,
    pr.status,
    pr.phase,
    pr.planned_date,
    pr.status_changed_date,
    pr.created_at,
    COUNT(DISTINCT pvp.pv_id)                        AS linked_pv_count
FROM PROJECTS pr
LEFT JOIN PV_PROJECT pvp
  ON pvp.project_id   = pr.project_id
WHERE pr.project_id   IN (:project_ids)
GROUP BY
    pr.project_id, pr.project_name, pr.market_code,
    pr.status, pr.phase, pr.planned_date,
    pr.status_changed_date, pr.created_at
ORDER BY pr.project_name;


-- ============================================================================
/*
  BQ-16: Projects Stuck in Pending Approval Beyond N Days
  Identify approval bottlenecks — projects in 'Pending Approval' status
  longer than the specified threshold.
  -- PARAM: n_days = 14
*/
-- RETURNS: Overdue approval projects ordered by longest wait first.
-- ============================================================================
SELECT
    pr.project_id,
    pr.project_name,
    pr.market_code,
    pr.status,
    pr.phase,
    pr.planned_date,
    pr.status_changed_date                           AS pending_since,
    DATEDIFF('day', pr.status_changed_date, CURRENT_DATE) AS days_pending,
    COUNT(DISTINCT pvp.pv_id)                        AS linked_pv_count
FROM PROJECTS pr
LEFT JOIN PV_PROJECT pvp
  ON pvp.project_id   = pr.project_id
WHERE pr.status       = 'Pending Approval'
  AND DATEDIFF('day', pr.status_changed_date, CURRENT_DATE) > :n_days
GROUP BY
    pr.project_id, pr.project_name, pr.market_code,
    pr.status, pr.phase, pr.planned_date, pr.status_changed_date
ORDER BY days_pending DESC;


-- ============================================================================
/*
  BQ-17: Overdue Projects — Past Planned Date, Not Completed or Cancelled
  Surface projects that have passed their planned date without reaching a
  terminal state — key input for the weekly PMI launch review.
  -- PARAM: market_code = 'JP'  (optional filter; remove WHERE clause to see all)
*/
-- RETURNS: Overdue projects with number of days overdue.
-- ============================================================================
SELECT
    pr.project_id,
    pr.project_name,
    pr.market_code,
    pr.status,
    pr.phase,
    pr.planned_date,
    DATEDIFF('day', pr.planned_date, CURRENT_DATE)   AS days_overdue,
    pr.status_changed_date                           AS last_status_change,
    COUNT(DISTINCT pvp.pv_id)                        AS linked_pv_count
FROM PROJECTS pr
LEFT JOIN PV_PROJECT pvp
  ON pvp.project_id   = pr.project_id
WHERE pr.planned_date < CURRENT_DATE
  AND pr.status       NOT IN ('Completed', 'Cancelled')
  AND pr.market_code  = :market_code   -- remove this line for global view
GROUP BY
    pr.project_id, pr.project_name, pr.market_code,
    pr.status, pr.phase, pr.planned_date, pr.status_changed_date
ORDER BY days_overdue DESC;


-- ============================================================================
/*
  BQ-18: PV Launch Phase Milestone Dates
  Retrieve the planned milestone dates for each phase of a PV's launch project.
  -- PARAM: pv_id = 'PV_TEREA_AMBER_JP_001'
*/
-- RETURNS: Ordered phase milestones showing planned vs actual progress.
-- ============================================================================
SELECT
    pv.pv_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    pr.project_id,
    pr.project_name,
    pr.phase                                         AS launch_phase,
    pr.planned_date                                  AS planned_milestone_date,
    pr.status                                        AS phase_status,
    pr.status_changed_date                           AS actual_completion_date,
    DATEDIFF('day', pr.planned_date, COALESCE(pr.status_changed_date, CURRENT_DATE))
                                                     AS days_variance  -- positive = delayed
FROM PRODUCT_VARIANTS pv
JOIN PV_PROJECT pvp
  ON pvp.pv_id        = pv.pv_id
JOIN PROJECTS pr
  ON pr.project_id    = pvp.project_id
WHERE pv.pv_id        = :pv_id
ORDER BY pr.planned_date;


-- ============================================================================
/*
  BQ-19: Cross-Domain Work Order View
  Consolidate Work Orders with project context, PV identity, and BOM components
  in a single output for operations and supply chain teams.
  -- PARAM: market_code = 'PL'
  -- PARAM: start_date  = '2025-01-01'
  -- PARAM: end_date    = '2025-12-31'
*/
-- RETURNS: Full cross-domain join: WO → PV → Project → BOM components.
--          This is the single-query replacement for the multi-system ANZO graph
--          traversal that previously required SPARQL federation across three repos.
-- ============================================================================
SELECT
    pv.pv_id                                         AS product_variant_id,
    pv.pv_name                                       AS product_variant_name,
    pv.global_product_name,
    pv.market_code,
    pv.production_center,
    pr.project_id,
    pr.project_name,
    pr.phase                                         AS project_phase,
    pr.status                                        AS project_status,
    pr.planned_date                                  AS project_planned_date,
    cl.descendant_id                                 AS bom_component_id,
    p.part_name                                      AS bom_component_name,
    p.category                                       AS component_category,
    p.supplier,
    cl.depth                                         AS bom_level,
    cl.cum_qty                                       AS qty_per_pv_unit,
    p.unit_of_measure,
    p.standard_cost                                  AS component_unit_cost,
    cl.cum_qty * p.standard_cost                     AS extended_component_cost,
    cl.bom_version,
    cl.path                                          AS bom_path
FROM PRODUCT_VARIANTS pv
JOIN PV_PROJECT pvp
  ON pvp.pv_id           = pv.pv_id
JOIN PROJECTS pr
  ON pr.project_id       = pvp.project_id
 AND pr.planned_date     BETWEEN :start_date AND :end_date
JOIN BOM_CLOSURE_LIVE cl
  ON cl.ancestor_id      = pv.pv_id
 AND cl.depth            > 0
JOIN PARTS p
  ON p.part_id           = cl.descendant_id
WHERE pv.market_code     = :market_code
ORDER BY
    pv.pv_name, pr.planned_date, cl.depth, p.category, p.part_name;
