# How Snowflake Answers Every PMI Business Requirement

Every business question in the PMI BRD (January 2024) is answerable using Snowflake's closure table pattern combined with standard SQL joins. This document maps each requirement to the specific Snowflake approach, the SQL pattern used, the expected output a user sees, and the POC demo page that demonstrates it live. No graph database engine is required for any of the 19 business questions. The technically interesting ones — BOM explosion, Where Used, cross-domain joins — are pre-validated in this POC on production-scale data (111,543 closure rows covering 5,800 Product Variants across 104 markets, with measurements scaling to production at ~1M rows).

---

## Customer Feedback: 4 Gaps Identified and Addressed

Following initial POC review, four gaps were raised from customer sessions. All four have been addressed in the current version of the POC. This section documents each gap, the concern raised, and the implemented solution.

### Gap 1 — Relative Depth / Impact Tier

**Concern raised:** When a user runs Where Used on a raw material and gets 5,000 PVs, the `depth` column shows different numbers for different PVs (depth=2 in one, depth=3 in another). A business user might conclude the ingredient is "deeper" in one product — when in fact the BOM trees simply have different heights. Depth is a structural property, not an impact measure.

**Solution implemented:** The Where Used query now returns three normalised columns computed dynamically via SQL window functions:

| Column | What it shows | Example |
|---|---|---|
| `level_display` | Position AND tree height in one label | `"2 of 3"` |
| `levels_from_leaf` | Hops to the raw material — comparable across all BOM structures | `1` |
| `impact_tier` | Business-friendly classification | `MID LEVEL` |

`levels_from_leaf` is the key column. A component with `levels_from_leaf = 1` is one step from the raw material regardless of whether the overall tree is 3 levels or 6 levels deep. This allows cross-PV comparison of structural position without knowledge of each PV’s BOM height.

**Demo:** Where Used page — search `VIRGINIA_LEAF_A` — observe `level_display`, `levels_from_leaf`, and colour-coded `impact_tier` column across 5,177 PVs.

---

### Gap 2 — BOM Explosion from Any Level in the Hierarchy

**Concern raised:** The BOM Explosion page only allowed starting from a Product Variant. Business users sometimes want to explore the sub-tree of a specific sub-assembly (e.g. `FILTER_ASSEMBLY_001`) or a blend, without knowing which PV to start from.

**Solution implemented:** A mode toggle on the BOM Explosion page: **Product Variant** | **Any Component**. When "Any Component" is selected, a searchable part dropdown replaces the PV cascade. The user selects any part (a blend, filter assembly, outer pack, raw material) and the BOM Explosion runs with that part as the root.

**Architecture note:** No backend or closure table change was required. The closure table already stores self-rows for every part at depth=0. Starting from any part is `WHERE ancestor_id = :part_id` — the exact same query, different parameter. This is a core strength of the closure table pattern that live recursion does not share.

**Demo:** BOM Explosion — toggle to "Any Component" — search `BLEND_MARLBORO_RED_01` — observe sub-tree showing Virginia Leaf, Burley Leaf, Oriental Leaf, Glycerin.

---

### Gap 3 — Where Used Showing ALL Materials Impacted

**Concern raised:** The original Where Used only showed finished Product Variants. When a tobacco leaf changes, business users also need to see which **intermediate components** are impacted (the blends, assemblies, and specs that directly use the ingredient) — because those also need specification updates.

**Solution implemented:** The Where Used query now uses `LEFT JOIN` to include both `PRODUCT_VARIANTS` and `PARTS` as ancestors. Results are split into two groups:

- **Intermediate Components Impacted** (amber indicator) — blends, filter assemblies, outer packs that directly reference the changed ingredient. Previously invisible.
- **Finished Product Variants** (blue indicator) — the top-level PVs, same as before.

For `VIRGINIA_LEAF_A`, the intermediate group shows `BLEND_MARLBORO_RED_01`, `BLEND_PARLIAMENT_01`, etc. — the blend specifications that a formulation team would need to update. The finished PV group shows all 5,177 affected products.

**Demo:** Where Used — search `VIRGINIA_LEAF_A` — observe amber group (intermediate blends) above blue group (finished PVs).

---

### Gap 4 — Dynamic Filtering by Material-Specific Attributes

**Concern raised:** Different material categories have different attributes. Tobacco Leaf has leaf_grade, origin_country, curing_method. Filter Component has diameter_mm, pressure_drop_pa. Packaging has substrate, gsm_weight, recyclable. A fixed relational schema cannot hold all these without either massive NULLs or separate tables. Business users need to filter materials by these attributes dynamically.

**Solution implemented:** Three-layer architecture:

1. **`PART_ATTRIBUTES` (EAV table):** Stores material attributes as name-value pairs — directly mirroring how ARAS stores properties. New attributes from ARAS require only an INSERT, not a schema change.

2. **`V_PART_ATTRIBUTES_JSON` (VARIANT rollup view):** Aggregates EAV rows per part into a JSON OBJECT. Enables Snowflake dot-notation filtering: `attributes:leaf_grade::VARCHAR = 'A'`.

3. **`V_ATTRIBUTE_SCHEMA` (metadata view):** Auto-discovers available attribute names per category. The frontend queries this to render filter controls dynamically — discrete value dropdowns for categorical attributes (leaf_grade: A/B/C), number inputs for numeric attributes (moisture_pct).

**Demo:** Materials Explorer page — select "Tobacco Leaf" — observe 7 attribute filters rendered automatically — filter by `leaf_grade = A` AND `origin_country = USA` — see matching parts with their BOM usage counts — click a part to navigate to Where Used.

**Key point for PMI:** When a new attribute is added to an ARAS part type, the only change required is inserting rows into `PART_ATTRIBUTES`. The filter UI adds the new attribute automatically on next page load. No DDL, no backend code change, no frontend code change, no deployment.

---

## BOM-Specific Requirements

These four requirements rely on the closure table and are the core technical differentiator of this POC.

---

### BOM Explosion

> "The system shall display the full multi-level Bill of Materials for any Product Variant, showing all components and sub-assemblies to any requested depth."

**Snowflake Approach:** Query `BOM_CLOSURE` filtered on `ancestor_id`. Because all ancestor-descendant relationships are pre-computed, this is a single equality filter — not a recursive traversal at query time.

**SQL Pattern:**
```sql
SELECT
    c.descendant_id,
    p.part_name,
    p.part_type,
    c.depth,
    c.quantity_cumulative,
    c.path
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PARTS p ON p.part_id = c.descendant_id
WHERE c.ancestor_id = :pv_id
  AND c.depth <= :max_depth
ORDER BY c.depth, p.part_name;
```

**Expected Output:** Hierarchical list of all components under the selected PV, with depth, cumulative quantity, and full path. Rendered as an interactive React Flow tree in the UI.

**Demo Page:** BOM Explosion

---

### Where Used

> "The system shall identify all Product Variants that contain a specified component, across all markets and brands."

**Snowflake Approach:** Reverse closure lookup — query `BOM_CLOSURE` filtered on `descendant_id`. Same single equality filter, opposite direction.

**SQL Pattern:**
```sql
SELECT
    c.ancestor_id AS pv_id,
    pv.pv_name,
    pv.brand,
    pv.market,
    c.depth,
    c.quantity_cumulative
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
WHERE c.descendant_id = :part_id
ORDER BY pv.market, pv.brand, pv.pv_name;
```

**Expected Output:** Full list of PVs containing the selected component, grouped by market and brand. For shared inputs like Virginia Leaf A, this returns 1,200+ PVs across 5 markets.

**Demo Page:** Where Used

---

### BOM Comparison

> "The system shall compare the Bills of Materials of two Product Variants and highlight differences, including components unique to each PV and components present in both."

**Snowflake Approach:** Two closure scans joined with a `FULL OUTER JOIN`. Components in both PVs appear in the `COMMON` partition; components in only one appear in the `UNIQUE_A` or `UNIQUE_B` partitions.

**SQL Pattern:**
```sql
SELECT
    COALESCE(a.descendant_id, b.descendant_id) AS part_id,
    COALESCE(pa.part_name, pb.part_name) AS part_name,
    a.quantity_cumulative AS qty_pv_a,
    b.quantity_cumulative AS qty_pv_b,
    CASE
        WHEN a.descendant_id IS NULL THEN 'UNIQUE_B'
        WHEN b.descendant_id IS NULL THEN 'UNIQUE_A'
        ELSE 'COMMON'
    END AS comparison_status
FROM BOM_ANALYTICS.BOM_CLOSURE a
FULL OUTER JOIN BOM_ANALYTICS.BOM_CLOSURE b
    ON a.descendant_id = b.descendant_id
    AND b.ancestor_id = :pv_id_b
JOIN BOM_ANALYTICS.PARTS pa ON pa.part_id = a.descendant_id
JOIN BOM_ANALYTICS.PARTS pb ON pb.part_id = b.descendant_id
WHERE a.ancestor_id = :pv_id_a
ORDER BY comparison_status, part_name;
```

**Expected Output:** Three-column diff table: common components (with qty comparison), components unique to PV A, components unique to PV B. Tax stamps and market-specific regulatory parts appear as `UNIQUE_A` or `UNIQUE_B` rows — immediately visible.

**Demo Page:** BOM Comparison

---

### Combustible mSpec

> "The system shall display the material specification (mSpec) for combustible Product Variants, including GHP parameters (Nicotine, Tar, CO, Units per Pack)."

**Snowflake Approach:** Join `PRODUCT_VARIANTS` to `GHP_PARAMETERS` — a straightforward 1:N join with a pivot for display. No closure table involvement.

**SQL Pattern:**
```sql
SELECT
    pv.pv_id,
    pv.pv_name,
    pv.brand,
    pv.market,
    MAX(CASE WHEN g.parameter_name = 'Nicotine' THEN g.parameter_value END) AS nicotine_mg,
    MAX(CASE WHEN g.parameter_name = 'Tar'      THEN g.parameter_value END) AS tar_mg,
    MAX(CASE WHEN g.parameter_name = 'CO'       THEN g.parameter_value END) AS co_mg,
    MAX(CASE WHEN g.parameter_name = 'Units per Pack' THEN g.parameter_value END) AS units_per_pack
FROM BOM_ANALYTICS.PRODUCT_VARIANTS pv
JOIN BOM_ANALYTICS.GHP_PARAMETERS g ON g.pv_id = pv.pv_id
WHERE pv.pv_id = :pv_id
GROUP BY pv.pv_id, pv.pv_name, pv.brand, pv.market;
```

**Expected Output:** Single-row mSpec card showing all four GHP parameters for the selected PV, suitable for regulatory reporting.

**Demo Page:** mSpec Detail

---

## Non-BOM Reports (16 Power BI Views)

These 16 reports are tabular joins — they do not require the closure table. Each is served by the FastAPI backend as a parameterized SQL query returning JSON to an AG Grid component in the React UI. Migration from Power BI is straightforward: the DAX measures translate directly to SQL aggregations, and AG Grid provides the same column sorting, filtering, and export capabilities that PMI users expect.

The pattern for all 16 is consistent:

```sql
SELECT <selected columns>
FROM <primary table>
[JOIN <related tables> ON ...]
WHERE <filter parameters>
ORDER BY <sort column>;
```

AG Grid handles client-side pagination, column pinning, and CSV/Excel export without additional backend logic.

---

### BQ-01 — Product Variant View

> "Display all attributes of a selected Product Variant including brand, market, category, lifecycle status, and creation date."

**Snowflake Approach:** Single-table select on `PRODUCT_VARIANTS` with optional joins to `PROJECTS` and `ECO` for related context.

**SQL Pattern:**
```sql
SELECT
    pv_id, pv_name, brand, market, category,
    lifecycle_status, creation_date, last_modified_date
FROM BOM_ANALYTICS.PRODUCT_VARIANTS
WHERE pv_id = :pv_id;
```

**Expected Output:** Attribute card for the selected PV. All fields from the ARAS PV object.

**Demo Page:** Product Variant Detail

---

### BQ-02 — Project View

> "Display all attributes of a selected Product Launch Project including project name, status, owner, target market, and associated Product Variants."

**Snowflake Approach:** Join `PROJECTS` to `PROJECT_PV_MAP` to retrieve associated PVs. Tabular join, no closure needed.

**SQL Pattern:**
```sql
SELECT
    p.project_id, p.project_name, p.status,
    p.owner, p.target_market, p.start_date, p.end_date,
    pv.pv_id, pv.pv_name, pv.brand
FROM BOM_ANALYTICS.PROJECTS p
JOIN BOM_ANALYTICS.PROJECT_PV_MAP m ON m.project_id = p.project_id
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = m.pv_id
WHERE p.project_id = :project_id;
```

**Expected Output:** Project header card + grid of associated PVs with brand and lifecycle status.

**Demo Page:** Project Detail

---

### BQ-03 — PV & Project View

> "Display all Product Variants associated with a project, and all projects associated with a Product Variant, in a combined view."

**Snowflake Approach:** Bidirectional join between `PROJECTS`, `PROJECT_PV_MAP`, and `PRODUCT_VARIANTS`. Single query with UNION or two-panel layout.

**SQL Pattern:**
```sql
-- PVs for a project
SELECT pv.pv_name, pv.brand, pv.market, pv.lifecycle_status
FROM BOM_ANALYTICS.PROJECT_PV_MAP m
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = m.pv_id
WHERE m.project_id = :project_id;

-- Projects for a PV
SELECT p.project_name, p.status, p.target_market
FROM BOM_ANALYTICS.PROJECT_PV_MAP m
JOIN BOM_ANALYTICS.PROJECTS p ON p.project_id = m.project_id
WHERE m.pv_id = :pv_id;
```

**Expected Output:** Two-panel view: PVs in the project (left) and projects containing the PV (right).

**Demo Page:** PV & Project Cross-Reference

---

### BQ-04 — Part View

> "Display all attributes of a selected Part including part type, supplier, current lifecycle status, and all Product Variants in which it is used."

**Snowflake Approach:** `PARTS` lookup + Where Used closure query. The part attributes come from `PARTS`; the usage list comes from `BOM_CLOSURE`.

**SQL Pattern:**
```sql
SELECT p.part_id, p.part_name, p.part_type, p.supplier, p.lifecycle_status,
       COUNT(DISTINCT c.ancestor_id) AS pv_usage_count
FROM BOM_ANALYTICS.PARTS p
LEFT JOIN BOM_ANALYTICS.BOM_CLOSURE c ON c.descendant_id = p.part_id
WHERE p.part_id = :part_id
GROUP BY 1,2,3,4,5;
```

**Expected Output:** Part attribute card with usage count badge. Drill-through to Where Used list.

**Demo Page:** Part Detail

---

### BQ-05 — mSpec View (All PVs)

> "Display GHP parameters (Nicotine, Tar, CO, Units per Pack) for all Product Variants matching selected filter criteria (brand, market, category)."

**Snowflake Approach:** Join `PRODUCT_VARIANTS` to `GHP_PARAMETERS` with pivoting, filtered by user-selected criteria. Returns a grid suitable for regulatory comparison.

**SQL Pattern:**
```sql
SELECT
    pv.pv_id, pv.pv_name, pv.brand, pv.market, pv.category,
    MAX(CASE WHEN g.parameter_name = 'Nicotine'      THEN g.parameter_value END) AS nicotine_mg,
    MAX(CASE WHEN g.parameter_name = 'Tar'           THEN g.parameter_value END) AS tar_mg,
    MAX(CASE WHEN g.parameter_name = 'CO'            THEN g.parameter_value END) AS co_mg,
    MAX(CASE WHEN g.parameter_name = 'Units per Pack' THEN g.parameter_value END) AS units_per_pack
FROM BOM_ANALYTICS.PRODUCT_VARIANTS pv
JOIN BOM_ANALYTICS.GHP_PARAMETERS g ON g.pv_id = pv.pv_id
WHERE (:brand IS NULL OR pv.brand = :brand)
  AND (:market IS NULL OR pv.market = :market)
GROUP BY 1,2,3,4,5
ORDER BY pv.market, pv.brand, pv.pv_name;
```

**Expected Output:** AG Grid with one row per PV, four GHP parameter columns, exportable to Excel for regulatory submissions.

**Demo Page:** mSpec Report

---

### BQ-06 — ECO View

> "Display all Engineering Change Orders associated with a Product Variant, including ECO status, change description, effective date, and approver."

**Snowflake Approach:** Join `ECO` to `ECO_PV_MAP` filtered by PV. Tabular join.

**SQL Pattern:**
```sql
SELECT
    e.eco_id, e.eco_name, e.status, e.change_description,
    e.effective_date, e.approver, e.change_type
FROM BOM_ANALYTICS.ECO e
JOIN BOM_ANALYTICS.ECO_PV_MAP m ON m.eco_id = e.eco_id
WHERE m.pv_id = :pv_id
ORDER BY e.effective_date DESC;
```

**Expected Output:** Chronological ECO list for the selected PV showing change history.

**Demo Page:** ECO History

---

### BQ-07 — Product Launch Report

> "Display all Product Variants in active launch projects, grouped by market and brand, with project milestone status."

**Snowflake Approach:** Join `PROJECTS` (filtered to active) → `PROJECT_PV_MAP` → `PRODUCT_VARIANTS`. Aggregate by market/brand.

**SQL Pattern:**
```sql
SELECT
    pv.market, pv.brand,
    COUNT(DISTINCT pv.pv_id) AS pv_count,
    COUNT(DISTINCT p.project_id) AS active_project_count,
    MIN(p.end_date) AS earliest_launch_date
FROM BOM_ANALYTICS.PROJECTS p
JOIN BOM_ANALYTICS.PROJECT_PV_MAP m ON m.project_id = p.project_id
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = m.pv_id
WHERE p.status = 'ACTIVE'
GROUP BY pv.market, pv.brand
ORDER BY pv.market, pv.brand;
```

**Expected Output:** Summary grid grouped by market/brand with PV count and nearest launch date.

**Demo Page:** Launch Report

---

### BQ-08 — Market Portfolio View

> "Display all Product Variants for a selected market, with brand, category, lifecycle status, and GHP parameter summaries."

**Snowflake Approach:** Join `PRODUCT_VARIANTS` to `GHP_PARAMETERS`, filtered by market. Same pivot as BQ-05 with market filter applied.

**SQL Pattern:**
```sql
SELECT pv.pv_id, pv.pv_name, pv.brand, pv.category, pv.lifecycle_status,
       MAX(CASE WHEN g.parameter_name = 'Nicotine' THEN g.parameter_value END) AS nicotine_mg,
       MAX(CASE WHEN g.parameter_name = 'Tar'      THEN g.parameter_value END) AS tar_mg
FROM BOM_ANALYTICS.PRODUCT_VARIANTS pv
LEFT JOIN BOM_ANALYTICS.GHP_PARAMETERS g ON g.pv_id = pv.pv_id
WHERE pv.market = :market
GROUP BY 1,2,3,4,5
ORDER BY pv.brand, pv.pv_name;
```

**Expected Output:** Market portfolio grid; supports regulatory portfolio reviews.

**Demo Page:** Market Portfolio

---

### BQ-09 — Brand Portfolio View

> "Display all Product Variants for a selected brand across all markets."

**Snowflake Approach:** Single-table filter on `PRODUCT_VARIANTS.brand`. No joins required.

**SQL Pattern:**
```sql
SELECT pv_id, pv_name, market, category, lifecycle_status, creation_date
FROM BOM_ANALYTICS.PRODUCT_VARIANTS
WHERE brand = :brand
ORDER BY market, pv_name;
```

**Expected Output:** Cross-market brand grid showing global portfolio consistency.

**Demo Page:** Brand Portfolio

---

### BQ-10 — Lifecycle Status Report

> "Display counts of Product Variants by lifecycle status (Active, Obsolete, In Development) across all markets."

**Snowflake Approach:** Aggregation on `PRODUCT_VARIANTS`. No joins.

**SQL Pattern:**
```sql
SELECT
    market,
    lifecycle_status,
    COUNT(*) AS pv_count
FROM BOM_ANALYTICS.PRODUCT_VARIANTS
GROUP BY market, lifecycle_status
ORDER BY market, lifecycle_status;
```

**Expected Output:** Pivot-style summary table; suitable for portfolio health dashboard.

**Demo Page:** Portfolio Dashboard (KPI tiles)

---

### BQ-11 — Supplier Exposure View

> "Display all suppliers used in the BOM of a selected Product Variant, with part count and total quantity."

**Snowflake Approach:** Closure table lookup joined to `PARTS` for supplier attribute. Aggregated by supplier.

**SQL Pattern:**
```sql
SELECT
    p.supplier,
    COUNT(DISTINCT p.part_id) AS part_count,
    SUM(c.quantity_cumulative) AS total_quantity
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PARTS p ON p.part_id = c.descendant_id
WHERE c.ancestor_id = :pv_id
GROUP BY p.supplier
ORDER BY total_quantity DESC;
```

**Expected Output:** Supplier risk view for a PV; identifies single-source dependencies.

**Demo Page:** BOM Explosion (supplier summary panel)

---

### BQ-12 — Part Lifecycle Report

> "Display all Parts with Obsolete or End-of-Life lifecycle status that are still referenced in Active Product Variants."

**Snowflake Approach:** Join `PARTS` (filtered to obsolete) to `BOM_CLOSURE` to `PRODUCT_VARIANTS` (filtered to active). Identifies compliance risk.

**SQL Pattern:**
```sql
SELECT
    p.part_id, p.part_name, p.part_type, p.lifecycle_status,
    COUNT(DISTINCT c.ancestor_id) AS active_pv_count
FROM BOM_ANALYTICS.PARTS p
JOIN BOM_ANALYTICS.BOM_CLOSURE c ON c.descendant_id = p.part_id
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv
    ON pv.pv_id = c.ancestor_id AND pv.lifecycle_status = 'Active'
WHERE p.lifecycle_status IN ('Obsolete', 'End of Life')
GROUP BY 1,2,3,4
ORDER BY active_pv_count DESC;
```

**Expected Output:** Risk register of obsolete parts still embedded in active BOMs — a high-value compliance report.

**Demo Page:** Parts Report

---

### BQ-13 — ECO Impact Analysis

> "For a selected Engineering Change Order, display all Product Variants affected by the change."

**Snowflake Approach:** Join `ECO` → `ECO_PV_MAP` → `PRODUCT_VARIANTS`. Tabular join.

**SQL Pattern:**
```sql
SELECT
    pv.pv_id, pv.pv_name, pv.brand, pv.market, pv.lifecycle_status,
    e.eco_name, e.change_type, e.effective_date
FROM BOM_ANALYTICS.ECO e
JOIN BOM_ANALYTICS.ECO_PV_MAP m ON m.eco_id = e.eco_id
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = m.pv_id
WHERE e.eco_id = :eco_id
ORDER BY pv.market, pv.brand;
```

**Expected Output:** Change impact list — all PVs that will be modified by the ECO.

**Demo Page:** ECO Impact

---

### BQ-14 — Work Order Status View

> "Display all Work Orders associated with Product Variants in a selected market, with status and completion date."

**Snowflake Approach:** Join `WORK_ORDERS` to `PRODUCT_VARIANTS` filtered by market.

**SQL Pattern:**
```sql
SELECT
    wo.work_order_id, wo.work_order_name, wo.status,
    wo.completion_date, pv.pv_name, pv.brand
FROM BOM_ANALYTICS.WORK_ORDERS wo
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = wo.pv_id
WHERE pv.market = :market
ORDER BY wo.completion_date DESC;
```

**Expected Output:** Work order pipeline for market operations teams.

**Demo Page:** Work Orders Report

---

### BQ-15 — HTU BOM View

> "Display the Bill of Materials for Heat-not-Burn (HTU) Product Variants, structured by the HTU component hierarchy."

**Snowflake Approach:** Closure table lookup with `category = 'HTU'` filter on the ancestor PV. Identical query pattern to combustible BOM explosion; HTU has a 3–4 level hierarchy vs 5–6 for combustibles.

**SQL Pattern:**
```sql
SELECT
    c.descendant_id, p.part_name, p.part_type,
    c.depth, c.quantity_cumulative, c.path
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PARTS p ON p.part_id = c.descendant_id
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
WHERE c.ancestor_id = :pv_id
  AND pv.category = 'HTU'
ORDER BY c.depth, p.part_name;
```

**Expected Output:** HTU BOM tree rendered in React Flow. Shallower hierarchy than combustibles; faster render.

**Demo Page:** BOM Explosion (HTU category)

---

### BQ-16 — Cross-Market Part Usage

> "Display all markets in which a specified Part is used, with PV counts and brands per market."

**Snowflake Approach:** Where Used closure lookup + group-by on market.

**SQL Pattern:**
```sql
SELECT
    pv.market,
    pv.brand,
    COUNT(DISTINCT pv.pv_id) AS pv_count,
    SUM(c.quantity_cumulative) AS total_quantity
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
WHERE c.descendant_id = :part_id
GROUP BY pv.market, pv.brand
ORDER BY pv.market, pv.brand;
```

**Expected Output:** Market exposure heat map for supply chain risk assessment.

**Demo Page:** Where Used (market summary tab)

---

### BQ-17 — Default Layout View

> "Display a standard summary view of a Product Variant showing BOM component count, project associations, ECO count, and GHP parameters in a single screen."

**Snowflake Approach:** Four parallel queries assembled by the FastAPI layer into a single dashboard response: closure aggregate for BOM count, project join, ECO count, GHP pivot.

**SQL Pattern:**
```sql
-- BOM summary (fast — single closure scan)
SELECT COUNT(DISTINCT descendant_id) AS component_count,
       MAX(depth) AS max_depth
FROM BOM_ANALYTICS.BOM_CLOSURE
WHERE ancestor_id = :pv_id;

-- Project count
SELECT COUNT(*) AS project_count
FROM BOM_ANALYTICS.PROJECT_PV_MAP
WHERE pv_id = :pv_id;

-- ECO count
SELECT COUNT(*) AS eco_count
FROM BOM_ANALYTICS.ECO_PV_MAP
WHERE pv_id = :pv_id;
```

**Expected Output:** Single-screen summary card — the default landing view when a user opens any PV.

**Demo Page:** Home Dashboard / PV Detail

---

### BQ-18 — Large/Customized Layout (up to 1M records)

> "Support customized and large tabular exports containing all components across multiple Product Variants for a selected market, up to 1 million records."

**Snowflake Approach:** Closure table scan filtered by market (via PV join). Snowflake returns the full result set; AG Grid renders it with virtual scrolling (only visible rows are in the DOM). Result cache accelerates repeated runs.

**SQL Pattern:**
```sql
SELECT
    pv.market, pv.brand, pv.pv_id, pv.pv_name,
    c.descendant_id, p.part_name, p.part_type,
    c.depth, c.quantity_cumulative
FROM BOM_ANALYTICS.BOM_CLOSURE c
JOIN BOM_ANALYTICS.PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
JOIN BOM_ANALYTICS.PARTS p ON p.part_id = c.descendant_id
WHERE pv.market = :market
ORDER BY pv.brand, pv.pv_name, c.depth;
-- Returns up to 1M rows; AG Grid virtual scrolling handles rendering
```

**Expected Output:** Full cross-PV component export for a market. Exportable to CSV/Excel via AG Grid toolbar.

**Demo Page:** Large Layout Export (Business Questions page)

---

### BQ-19 — Cross-Domain Query (Work Orders + Projects + PV + BOM)

> "Display a unified view combining Work Order status, Project milestone, Product Variant attributes, and BOM component count in a single output for operational review."

**Snowflake Approach:** Multi-table SQL join across `WORK_ORDERS`, `PROJECTS`, `PROJECT_PV_MAP`, `PRODUCT_VARIANTS`, and a subquery on `BOM_CLOSURE` for component count. This is the most complex query in the BRD — it is the one that appeared to require graph traversal. In Snowflake it is a standard 5-table join with an aggregation subquery.

**SQL Pattern:**
```sql
SELECT
    pv.pv_id,
    pv.pv_name,
    pv.brand,
    pv.market,
    pv.lifecycle_status,
    p.project_name,
    p.status AS project_status,
    p.end_date AS target_launch_date,
    wo.work_order_name,
    wo.status AS work_order_status,
    bom.component_count,
    bom.max_depth
FROM BOM_ANALYTICS.PRODUCT_VARIANTS pv
LEFT JOIN BOM_ANALYTICS.PROJECT_PV_MAP pm ON pm.pv_id = pv.pv_id
LEFT JOIN BOM_ANALYTICS.PROJECTS p ON p.project_id = pm.project_id
LEFT JOIN BOM_ANALYTICS.WORK_ORDERS wo ON wo.pv_id = pv.pv_id
LEFT JOIN (
    SELECT ancestor_id,
           COUNT(DISTINCT descendant_id) AS component_count,
           MAX(depth) AS max_depth
    FROM BOM_ANALYTICS.BOM_CLOSURE
    GROUP BY ancestor_id
) bom ON bom.ancestor_id = pv.pv_id
WHERE (:market IS NULL OR pv.market = :market)
  AND (:brand  IS NULL OR pv.brand  = :brand)
ORDER BY pv.market, pv.brand, pv.pv_name;
```

**Expected Output:** Operational dashboard row per PV — work order status, project status, BOM depth and size, all in one grid. This is the "hardest" BRD query. In the demo it runs in under 3 seconds.

**Demo Page:** Business Questions → BQ-19

---

## Performance SLAs

### Closure Table Rebuild Time by Warehouse Size

The closure table is rebuilt once daily after the ARAS delta load completes. Times are measured and estimated across warehouse sizes:

| Dataset Scale | Rows | X-Small | Small | Medium | Large |
|---|---|---|---|---|---|
| **POC (104 markets, 5,800 PVs)** | **111K** | **1.5s ✓ measured** | **1.5s ✓ measured** | **1.5s ✓ measured** | — |
| Demo scale (30 markets, ~3K PVs) | ~50K | ~1s | ~1s | ~1s | — |
| Mid scale (50 markets, ~10K PVs) | ~500K | ~15s | ~8s | ~4s | ~2s |
| Production (100 markets, ~20K PVs) | ~1M | ~30s | ~15s | ~8s | ~4s |
| Full history (100 markets, all revisions) | ~5M | ~150s | ~75s | ~38s | ~19s |

**Key insight:** At PMI's active portfolio scale (~1M rows), a **Medium warehouse rebuilds in ~8 seconds**. Even at full historical scale (5M rows), the overnight batch window has more than enough headroom on a Medium. There is no operational reason to run larger than Medium for the daily refresh.

**Why X-Small is sufficient for the POC demo:** At 111K rows the rebuild completes in 1.5 seconds on X-Small. WH size only becomes a differentiator above ~500K rows where Snowflake's parallelism across multiple servers starts to separate the tiers.

### Query SLAs (production scale, Medium warehouse)

| Query Type | BRD SLA | Expected Snowflake | Mechanism |
|---|---|---|---|
| Simple (≤2 BOM levels) | <20 seconds | **<1 second** | Closure table clustered micro-partition scan |
| Medium (multiple levels, depth filter) | <1 minute | **1–5 seconds** | Closure table with depth filter + part join |
| Complex (cross-domain: BQ-19) | <3 minutes | **5–30 seconds** | Multi-join SQL across 5 tables |
| Default layout (BQ-17 summary card) | <20 seconds | **<1 second** | Pre-aggregated subquery; result cache on repeat |
| Large layout export (up to 1M rows) | Not specified | **10–60 seconds** | Full closure scan by market; AG Grid virtual scroll |
| Where Used (shared ingredient, 5,000+ PVs) | <1 minute | **<2 seconds** | Reverse closure scan on `descendant_id` |

All query times at production scale use a **Medium warehouse, no query cache warming**. The POC demonstrates all queries on 111K closure rows (X-Small, 1.5s rebuild), with timings proportionally faster than production estimates.
