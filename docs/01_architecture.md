# PMI CLIPP BOM Analytics — Snowflake Architecture

## 1. Overview

This architecture delivers a fully managed, cloud-native Bill of Materials analytics platform for Philip Morris International's CLIPP program, replacing the ANZO graph technology stack with Snowflake. ARAS PLM remains the system of record for all product and BOM data; Snowflake consumes daily delta extracts, materializes a pre-computed closure table covering every ancestor-descendant relationship across PMI's global combustible and HTU portfolio, and serves interactive BOM explosion, Where Used, and cross-domain analytics through a React + React Flow application hosted entirely within the Snowflake boundary via Snowpark Container Services (SPCS). The result is sub-second BOM traversal on 5–8 million closure rows, market-scoped Row Access Policies that replicate ARAS security, and a zero-infrastructure-maintenance operational model.

---

## 2. Data Flow Diagram

```
ARAS PLM (source of truth)
     │  Daily delta extract (Snowpipe or scheduled task)
     ▼
┌─────────────────────────────────────┐
│             SNOWFLAKE               │
│                                     │
│  Staging Tables (raw ARAS data)     │
│         │                           │
│         │  Dynamic Table refresh    │
│         ▼  (TARGET_LAG = 1 day)     │
│  BOM_CLOSURE (5-8M rows)            │
│  Clustered on ancestor_id +         │
│  descendant_id                      │
│         │                           │
│         │  FastAPI (Python)         │
│         │  in SPCS Container        │
│         ▼                           │
│  React + React Flow UI              │
│  Served via SPCS endpoint           │
└─────────────────────────────────────┘
     │  SAML/SSO via AD
     ▼
Business Users (400 users, 20 concurrent)
```

---

## 3. Snowflake Components Used

| Component | Purpose | Why It Was Chosen |
|---|---|---|
| **Dynamic Tables** | Auto-refresh `BOM_CLOSURE` daily from staging tables | Declarative refresh with `TARGET_LAG = 1 day`; no ETL orchestration code to maintain |
| **Row Access Policies** | Replicate ARAS market-scoped RLS (PL users see only Polish PVs, etc.) | Policy logic lives in Snowflake; no application-layer filtering needed; auditable |
| **Recursive CTEs** | Build the closure table on demand and support ad-hoc what-if BOM analysis | Standard SQL, no graph engine required; closure build runs once per day |
| **EAV Table + VARIANT views** | `PART_ATTRIBUTES` stores material-specific attributes as name-value pairs; `V_PART_ATTRIBUTES_JSON` collapses to VARIANT for dot-notation filtering; `V_ATTRIBUTE_SCHEMA` auto-discovers attribute metadata per category | New ARAS attributes require only an INSERT — UI filter controls adapt automatically, zero DDL |
| **Snowpark Container Services (SPCS)** | Host the React + FastAPI application inside the Snowflake network boundary | Data never leaves Snowflake; SSO via AD applies to the container endpoint; no separate cloud infrastructure |
| **Clustering Keys** | `BOM_CLOSURE` clustered on `(ancestor_id, descendant_id)` | BOM explosion (`WHERE ancestor_id = X`) becomes a single micro-partition scan; query time drops to <1 second |
| **Snowflake Cortex AI** | Future AI-assisted BOM anomaly detection and natural language BOM queries | Pre-integrated with Snowflake data; no separate ML infrastructure *(roadmap item — not in POC scope)* |

---

## 4. BOM Data Model

```
┌──────────────────────┐
│   PRODUCT_VARIANTS   │
│  pv_id (PK)          │
│  pv_name             │
│  brand               │
│  market              │
│  category            │──────────────────────────┐
└──────────┬───────────┘                          │
           │  1:N                                 │
           ▼                                      │
┌──────────────────────┐                          │
│      BOM_ITEMS       │                          │
│  bom_item_id (PK)    │                          │
│  parent_id  (FK→PV)  │                          │
│  part_id    (FK→PARTS│                          │
│  quantity            │                          │
│  effective_date      │                          │
└──────────┬───────────┘                          │
           │  N:1                                 │
           ▼                                      │
┌──────────────────────┐                          │
│        PARTS         │                          │
│  part_id (PK)        │                          │
│  part_name           │                          │
│  part_type           │                          │
│  supplier            │                          │
└──────────────────────┘                          │
                                                  │
┌─────────────────────────────────────────────┐   │
│               BOM_CLOSURE  (derived)        │◄──┘
│  ancestor_id   (FK → PRODUCT_VARIANTS.pv_id │
│                 or PARTS.part_id)            │
│  descendant_id (FK → PARTS.part_id)         │
│  depth         (integer: 1 = direct child)  │
│  path          (string: full ancestry chain)│
│  quantity_cumulative                        │
└─────────────────────────────────────────────┘
```

`BOM_CLOSURE` is a derived table — it is fully recomputed by the Dynamic Table engine each day from `BOM_ITEMS`. Business queries read only from `BOM_CLOSURE`; they never execute live recursion.

---

## 5. Closure Table Design

### What Is a Closure Table?

A closure table stores every (ancestor, descendant) pair in a BOM graph — not just the direct parent-child edges. For a 5-level combustible hierarchy (leaf → blend → rod → cigarette → pack), a single Product Variant generates approximately 250–400 closure rows covering all depth combinations. Summed across 20,000 PVs with shared components, this produces 5–8 million rows.

### Why a Closure Table Instead of Live Recursion?

| Approach | BOM Explosion Query | Where Used Query | Scalability |
|---|---|---|---|
| **Live recursive CTE** | Re-traverses the graph on every request; 2–15 seconds at scale | Full graph scan; 5–30 seconds | Degrades as BOM grows |
| **Closure table** | `WHERE ancestor_id = X` — single equality filter | `WHERE descendant_id = Y` — single equality filter | Constant time; independent of BOM depth |

The closure table trades write-time compute (daily rebuild) for read-time performance. Given PMI's daily ARAS delta cycle, the rebuild cadence aligns perfectly.

### Key Columns

| Column | Type | Description |
|---|---|---|
| `ancestor_id` | VARCHAR | The top-level node (PV or intermediate assembly) |
| `descendant_id` | VARCHAR | The leaf or intermediate component |
| `depth` | INTEGER | Number of edges between ancestor and descendant |
| `path` | VARCHAR | Pipe-delimited full path string for display |
| `quantity_cumulative` | FLOAT | Rolled-up quantity from ancestor to descendant |
| `bom_version` | VARCHAR | Effective BOM version for multi-version comparison |

### Expected Row Count at PMI Scale

- **POC (PRODUCTION profile):** 5–8 million rows
- **Full production (all historical PVs):** 15–25 million rows
- **Warehouse size for <1-second BOM explosion:** Medium (sufficient for 20 concurrent users)

---

## 6. Concurrency and Performance

PMI's stated requirements: 400 total users, 20 concurrent. Snowflake's multi-cluster warehouse handles this transparently.

| Scenario | Warehouse Config | Expected Query Time | Mechanism |
|---|---|---|---|
| BOM explosion (single PV, all depths) | Medium, 1 cluster | <1 second | Clustered micro-partition scan on `ancestor_id` |
| Where Used (single part, all PVs) | Medium, 1 cluster | <1 second | Clustered micro-partition scan on `descendant_id` |
| BOM comparison (2 PVs, diff report) | Medium, 1 cluster | 1–3 seconds | Two closure scans + `FULL OUTER JOIN` |
| BQ-19 cross-domain (work orders + projects + BOM) | Medium, 1 cluster | 3–15 seconds | Multi-join across 5 tables; all indexed |
| 20 concurrent BOM explorations | Medium, 2 clusters (auto-scale) | <3 seconds p95 | Snowflake auto-scale adds second cluster at queue threshold |

Auto-suspend is set to 5 minutes; auto-resume is instantaneous from the application layer. The Medium warehouse costs approximately $2/hour — negligible compared to ANZO infrastructure costs.

---

## 7. Security

### Row Access Policies (RLS)

Snowflake Row Access Policies enforce data-layer security that mirrors the ARAS object-level access model. A policy function evaluates the current session role against a mapping table (`MARKET_ACCESS_MAP`) and filters `PRODUCT_VARIANTS` rows accordingly. All downstream queries — BOM explosion, Where Used, reports — inherit this filter transparently because the policy is attached to the base table, not the application.

```sql
-- Example: market-scoped RLS
CREATE OR REPLACE ROW ACCESS POLICY market_rls AS (market VARCHAR) RETURNS BOOLEAN ->
  EXISTS (
    SELECT 1 FROM MARKET_ACCESS_MAP
    WHERE role_name = CURRENT_ROLE()
    AND (allowed_market = market OR allowed_market = 'ALL')
  );
```

### SSO via Active Directory

SPCS endpoints are authenticated via Snowflake's SAML/SSO integration with PMI's Azure Active Directory. Users authenticate once through AD; the SPCS service inherits the Snowflake session token. No separate identity provider configuration is needed in the application.

### Data Classification

Snowflake's native data classification tags are applied to sensitive columns (e.g., `supplier`, `formulation_id`) to support audit and governance requirements. Classification is visible in Snowsight and queryable via `INFORMATION_SCHEMA`.

---

## 8. SPCS Deployment

The application is packaged as a single Docker image containing:
- **Nginx** (port 8080): serves the React build, proxies `/api` to the FastAPI backend
- **FastAPI** (port 8000, internal): executes parameterized Snowflake queries via the Snowflake Python connector; returns JSON to the UI

The SPCS service specification:

```yaml
spec:
  containers:
    - name: pmi-bom-app
      image: <registry>.snowflakecomputing.com/pmi_clipp_poc/bom_repo/pmi-bom-app:latest
      env:
        SNOWFLAKE_ACCOUNT: <account>
        SNOWFLAKE_USER: <service_user>
      ports:
        - containerPort: 8080
  endpoints:
    - name: ui
      port: 8080
      public: true
```

The service runs in a Snowflake-managed compute pool (`STANDARD_1` instance type for the POC). The public endpoint URL is provided by `SHOW SERVICES` and is protected by Snowflake's authentication layer.

---

## 9. Production UI Upgrade Path — React Flow in SPCS

One of the strongest objections to replacing ANZO Hi-Res is the loss of its interactive graph visualization. The POC directly addresses this: the BOM Explosion page renders a fully interactive React Flow tree inside SPCS.

**What React Flow provides (demonstrated in the POC, not a roadmap promise):**

- Zoom and pan across multi-level BOM trees with hundreds of nodes
- Expand/collapse individual BOM nodes to explore depth incrementally
- Click a node (e.g., "Virginia Leaf A") to immediately pivot to the Where Used view
- Color-coded nodes by part type (tobacco, packaging, regulatory)
- Export the current tree view as SVG for offline documentation

This is not a wireframe or a prototype — it is the running POC application, accessible at the SPCS endpoint. The visual experience is comparable to ANZO Hi-Res for BOM navigation use cases. It runs inside the Snowflake security boundary, so PMI's data governance policies apply automatically.

---

## 10. Migration Phasing

### Phase 1 — Foundation (Months 1–3)

| Workstream | Deliverable |
|---|---|
| Data Pipeline | Snowpipe or scheduled task ingesting ARAS daily delta into staging tables |
| Closure Table | Dynamic Table `BOM_CLOSURE` with full PMI combustible portfolio |
| BOM Analytics | BOM Explosion, Where Used, BOM Comparison, Combustible mSpec (4 BOM reports) |
| Non-BOM Reports | 5 highest-priority reports migrated from Power BI to Snowflake-backed AG Grid |
| Security | Row Access Policies: market-scoped RLS; SAML SSO integration |
| SPCS App | React + FastAPI application deployed to SPCS; AD-authenticated endpoint |

### Phase 2 — Full Migration (Months 4–6)

| Workstream | Deliverable |
|---|---|
| Non-BOM Reports | Remaining 11 of 16 Power BI reports migrated |
| Performance Tuning | Clustering key validation on full-production data volume; warehouse sizing |
| SSO Hardening | Full AD group-to-Snowflake role mapping; MFA enforcement |
| UAT | PMI business user acceptance testing across all 19 business questions |
| Go-Live | Production cutover; ANZO decommission planning |

The technically complex work — BOM closure table construction, recursive CTE logic, Row Access Policies, SPCS deployment — is proven in Phase 1 (and pre-validated in this POC). Phase 2 is methodical report migration and hardening, not discovery.
