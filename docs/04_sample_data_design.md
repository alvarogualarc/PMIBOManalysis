# POC Sample Data — Design Rationale and Volume Analysis

## 1. Design Philosophy

Performance claims are only credible when demonstrated on realistic data. A POC that shows sub-second BOM explosion on 100 rows proves nothing about production behavior. The PMI CLIPP BOM Analytics POC was designed from the start to run on production-scale data: 20,000 Product Variants, 200,000 BOM line items, and a fully materialized closure table of 5–8 million rows.

This choice has two consequences that matter in a sales context. First, every timing shown in the demo is a timing on real-scale data — not an optimistic projection from a toy dataset. When the demo shows BOM explosion completing in under 1 second, that is on 5 million closure rows, not 5,000. Second, the Where Used result for Virginia Leaf A returning 1,200+ Product Variants is not a fabricated number — it is the natural output of a correctly designed data generation model that reflects how PMI's global tobacco supply chain actually works. The demo tells a true story.

The data generation script (`generate_bom_data.py`) produces deterministic output with `seed=42`. Every demo session shows identical numbers, enabling a consistent narrative. The PRODUCTION profile takes 15–20 minutes to generate and load; a DEMO profile (2,000 PVs, ~600K closure rows) is available for rapid environment setup.

---

## 2. Tobacco Industry BOM Structure

PMI's combustible tobacco products follow a well-defined manufacturing hierarchy. Each level represents a distinct manufacturing or formulation step, and components at lower levels are shared extensively across brands and markets.

### Combustible (Cigarette) Hierarchy — 5 to 6 Levels

```
Level 0: PRODUCT_VARIANT (e.g., Marlboro Red KS Poland)
          │
          ├── Level 1: TOBACCO BLEND (e.g., Marlboro Full Flavor Blend)
          │           │
          │           ├── Level 2: TOBACCO ROD (shredded tobacco column)
          │           │           │
          │           │           └── Level 3: RAW LEAF (e.g., Virginia Leaf A,
          │           │                        Burley Leaf B, Oriental Leaf C)
          │           │
          │           └── Level 2: FILTER (acetate tow + plasticizer)
          │
          ├── Level 1: PACK MATERIALS
          │           ├── Level 2: PAPER (cigarette paper, tipping paper)
          │           ├── Level 2: FOIL (inner liner)
          │           ├── Level 2: PACK BOARD (outer pack)
          │           └── Level 2: TAX STAMP (market-specific regulatory)
          │
          └── Level 1: CARTON MATERIALS
                      └── Level 2: CARTON BOARD (outer shipping unit)
```

### Heat-Not-Burn (HTU / IQOS Tobacco Stick) Hierarchy — 3 to 4 Levels

```
Level 0: PRODUCT_VARIANT (e.g., HEETS Amber Selection Poland)
          │
          ├── Level 1: TOBACCO PLUG
          │           └── Level 2: PROCESSED TOBACCO SHEET
          │                       └── Level 3: RAW LEAF
          │
          ├── Level 1: FILTER SEGMENT (hollow acetate + cellulose)
          │
          └── Level 1: OUTER WRAPPER & PLUG WRAP
                      └── Level 2: SPECIALTY PAPER
```

HTU BOMs are shallower (3–4 levels vs. 5–6 for combustibles) and have fewer shared raw materials, producing fewer closure rows per PV. This is reflected in the data generation logic.

**Note on scope boundary:** IQOS device hardware BOMs (heater blade, battery, electronics, enclosure) are explicitly out of scope. Those live in a separate engineering PLM system and have a different BOM structure (electronics, 6–9 levels). This POC represents only the tobacco product BOM managed in ARAS CLIPP.

---

## 3. Component Sharing — The Key Design Decision

The single most important design decision in the sample data is the modeling of shared raw materials — particularly tobacco leaf grades.

Virginia Leaf A is a specific grade of flue-cured Virginia tobacco. In PMI's actual supply chain, the same leaf grade is sourced from the same global supplier network and used across the entire Marlboro brand family worldwide. There is no separate "Virginia Leaf A for Poland" and "Virginia Leaf A for France" — the leaf specification is global; only the pack-level components (tax stamps, market-specific pack artwork) differ by market.

In the POC data model, this is represented accurately: Virginia Leaf A has a single `part_id` and appears in the `BOM_CLOSURE` table as a descendant of 1,200+ Product Variants across all 5 markets.

This design decision makes the Where Used demo striking and meaningful:

1. A user searches Where Used for `VIRGINIA_LEAF_A`
2. The result shows 1,200+ Product Variants, 5 markets, all Marlboro brands
3. The demo narrative: *"A supply disruption on this one ingredient affects 1,200 Product Variants globally. In Snowflake, that impact assessment takes under 2 seconds."*

This is not a contrived scenario. It accurately represents the supply chain risk structure of a global tobacco manufacturer. The demo tells a story that PMI's supply chain and procurement teams will immediately recognize as true.

The same sharing logic applies to other raw materials (Burley Leaf B, acetate tow filter grades, standard cigarette paper), though at lower usage counts. Part sharing is what drives closure table fanout from 200,000 BOM line items to 5–8 million closure rows.

---

## 4. Entity Counts and Rationale

### Actual POC Dataset (Live in Snowflake as of current session)

Note: The POC data was generated via SQL GENERATOR() functions to demonstrate all BOM mechanics. Actual PMI production volumes will be significantly larger. The POC is sized to demonstrate all query patterns at realistic depth and breadth, not to hit an exact row count target.

| Entity | Actual POC Rows | Target PRODUCTION | Design Rationale |
|---|---|---|---|
| `DIM_MARKETS` | **104** | 104+ | PMI’s full active market footprint including all major regions (WE, CEE, CIS, ME, AF, APAC, LAC) |
| `DIM_PRODUCTION_CENTERS` | **58** | 60+ | Regional factory hubs (Warsaw, Lyon, Osaka, Dubai, São Paulo, etc.) — not one per market |
| `DIM_PRODUCT_VARIANTS` | **5,800** | 20,000+ | 104 markets × combustible + HTU brands × packaging sizes. Full portfolio with historical PVs would be 3× higher |
| `DIM_PARTS` | **107** | 500+ | Core material types seeded; full ARAS extract would include all leaf grades, regional packaging specs, and regulatory stamps |
| `FACT_BOM_ITEMS` | **28,777** | 200,000+ | Adjacency list; all BOM levels across all PVs |
| `BOM_CLOSURE` | **111,543** | 1M–5M | Pre-computed closure; clustered on (ancestor_id, descendant_id) for sub-second BOM explosion |
| `PART_ATTRIBUTES` | **95** | 5,000+ | EAV table for dynamic material attributes (leaf grade, filter specs, packaging substrate, etc.) |
| `DIM_ECO` | **1,000** | 2,000+ | Engineering Change Orders across all status types |
| `DIM_PROJECTS` | **400** | 500+ | Product launch projects, including Overdue and Pending Approval for BQ-16/17 demo |
| `FACT_PV_PROJECT` | **800** | 40,000+ | PV-to-project link table |
| `FACT_GHP_PARAMETERS` | **1,264** | 80,000+ | Nicotine, Tar, CO, Units per Pack per released PV |

### Key Demo Numbers (from actual POC data)

- **Virginia Leaf A — Where Used:** 5,177 Product Variants across 55 markets — the flagship demo moment
- **Closure table rebuild time:** 1.5 seconds on X-Small warehouse at 111K rows
- **Estimated at production scale (~1M rows):** 8 seconds on Medium warehouse
- **BOM explosion query time:** <1 second (single micro-partition scan on clustered column)
- **Materials Explorer categories:** 5 (Tobacco Leaf, Filter Component, Packaging, Tobacco Blend, Regulatory)
- **Attribute schema entries:** 31 distinct attribute definitions across 5 categories

---

## 5. Scope Boundary

**In scope — ARAS CLIPP managed tobacco product BOMs:**

- Combustible cigarette Product Variants (all brands, all markets)
- Heat-Not-Burn (HTU) tobacco stick Product Variants (HEETS, TEREA)
- Raw material parts (tobacco leaf, paper, foil, board, acetate)
- Market-specific packaging and regulatory components (tax stamps, health warnings)
- GHP parameters (Nicotine, Tar, CO, Units per Pack)

**Out of scope:**

- **IQOS device hardware BOMs** — The IQOS device (heater, battery, electronics, plastic enclosure) is managed in a separate engineering PLM system, not ARAS CLIPP. Device hardware BOMs have a different structure (6–9 levels, electronic components, PCB assembly) and are governed by a different team. Including them would distort the BOM depth statistics and misrepresent the CLIPP scope.
- **Snus and oral nicotine products** — Different product category; not referenced in the January 2024 BRD.
- **Historical archived PVs** — Not loaded in the PRODUCTION profile (see Section 6 for extrapolation).

This scope boundary is important to communicate clearly in the demo. When a PMI attendee asks "what about IQOS device parts?", the answer is: those are a separate PLM system; the CLIPP/ARAS scope is tobacco product BOMs, which is exactly what this POC models.

---

## 6. Extrapolation to Full Production

The PRODUCTION profile models PMI's active combustible and HTU portfolio. A full production deployment would include:

| Expansion Factor | Rationale | Estimated Closure Rows |
|---|---|---|
| POC PRODUCTION (20K active PVs) | As demonstrated | 5–8 million |
| + Historical PVs (×3 lifecycle multiplier) | Products obsoleted over 10+ years; still referenced in ECOs and work orders | 15–25 million |
| + Full global market expansion (remaining markets not in POC) | POC uses 5 markets; PMI operates in ~180 markets | 30–50 million |

Even at 50 million closure rows, Snowflake's clustering and micro-partition architecture keeps BOM explosion sub-second. Micro-partition pruning means that a BOM explosion for one PV scans the same 1–2 micro-partitions regardless of whether the total table is 5M or 50M rows, because the table is clustered on `ancestor_id`. The performance SLAs in this POC hold at 10× scale.

A Medium warehouse handles 50M rows for BOM explosion. Cross-market large layout queries (BQ-18, up to 1M result rows) would benefit from a Large warehouse at that scale.

---

## 7. Diamond Dependency Monitoring

A closure table breaks silently when the same component is reachable via two different paths under the same parent (a "diamond dependency"). The cumulative quantity column becomes unreliable because it double-counts the component's contribution.

**Status in this POC:** Zero diamond dependencies confirmed. The following query returned zero rows on the full POC closure table (111,543 rows, 5,800 PVs):

```sql
SELECT ancestor_id, descendant_id, COUNT(*) AS path_count
FROM BOM_CLOSURE WHERE depth > 0
GROUP BY ancestor_id, descendant_id
HAVING COUNT(*) > 1;
-- Returns: 0 rows
```

**Why tobacco BOMs don't have diamonds:** Tobacco product BOMs are trees, not directed acyclic graphs. Each ingredient has exactly one formulation role and one path to the finished product. PMI's PLM and recipe management systems enforce single-path ingredient usage for regulatory traceability. Diamond dependencies occur in mechanical/electronics BOMs (shared fasteners, shared PCBs) but not in tobacco recipe structures.

**Production safeguard:** This query runs as an automated data quality gate after every closure rebuild. If it returns rows, affected PVs are flagged before their BOM quantities are trusted in MRP calculations. The cumulative quantity column is reliable only when this query returns zero rows.

---

## 8. Data Generation Script

`generate_bom_data.py` produces all tables from scratch using a seeded random number generator (`seed=42`). The generation logic:

1. **Parts first:** Generate 500 parts with realistic tobacco-industry names and types. Assign sharing weights: raw leaf grades get high sharing probability (used in many PVs); tax stamps get low sharing (market-specific).

2. **PVs second:** Generate 20,000 PVs distributed across 5 markets, 4 brands, and combustible/HTU categories. Assign brand-market combinations weighted by realistic portfolio distributions (Marlboro dominates, Parliament and L&M are secondary).

3. **BOM items third:** For each PV, generate BOM line items by category (tobacco blend, filter, paper, pack, regulatory). Apply component sharing: select from the parts pool with weights, so shared parts (Virginia Leaf A) are chosen by many PVs.

4. **Closure table fourth:** Build the closure table from BOM items using a recursive SQL query. This is a one-time build step, not part of the dynamic refresh logic.

5. **Supporting entities:** Generate ECOs, projects, work orders, GHP parameters with referential integrity to the PVs already created.

The script streams inserts to Snowflake using the `snowflake-connector-python` batch insert API (10,000 rows per batch). PRODUCTION profile total runtime: 15–20 minutes. Progress bars are shown per table.

```bash
# PRODUCTION profile (full demo dataset)
python generate_bom_data.py \
  --profile PRODUCTION \
  --account <your-account>.snowflakecomputing.com \
  --user <your-user> \
  --password <your-password>

# DEMO profile (quick setup, ~3 min)
python generate_bom_data.py \
  --profile DEMO \
  --account <your-account>.snowflakecomputing.com \
  --user <your-user> \
  --password <your-password>
```

Reproducibility: identical arguments always produce identical data. Demo coordinators can reset the environment by dropping and re-generating without any randomness in results.
