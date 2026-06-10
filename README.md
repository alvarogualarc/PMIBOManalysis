# PMI CLIPP BOM Analytics — Snowflake POC

A full end-to-end proof of concept demonstrating that Snowflake can replace ANZO graph technology for Philip Morris International's CLIPP BOM analytics platform.

Built from the January 2024 BRD. All 19 business requirements answered live.

---

## What This Is

PMI's CLIPP program manages Product Lifecycle and Bill of Materials data in ARAS PLM across 104 markets and ~20,000 Product Variants. The existing ANZO Hi-Res graph platform is being decommissioned. This POC demonstrates that Snowflake — using a pre-computed closure table pattern — can deliver every BOM analytics requirement faster, inside the Snowflake security boundary, with no graph database required.

**Core technical claim:** BOM explosion, Where Used, BOM Comparison, and all 19 BRD cross-domain queries are answered by a single equality filter on a clustered closure table. No graph traversal at query time.

---

## Repository Structure

```
PMIBOManalysis/
├── sql/                        # Snowflake setup and queries
│   ├── 01_setup.sql            # Database, schema, warehouse, roles
│   ├── 02_closure_table.sql    # Recursive CTE + atomic swap pattern
│   ├── 03_dynamic_table.sql    # Auto-refresh (TARGET_LAG = 1 day)
│   ├── 04_business_queries.sql # All 19 BRD business questions
│   ├── 05_rls_policy.sql       # Market-scoped Row Access Policy
│   └── 06_what_if_procedure.sql# What-if BOM simulation (read-only)
│
├── data_generator/             # Python data generation
│   ├── bom_config.py           # Scale profiles (SMALL / MEDIUM / PRODUCTION)
│   ├── generate_bom_data.py    # Generates 5,800 PVs, 104 markets, 111K closure rows
│   └── requirements.txt
│
├── app/
│   ├── backend/                # FastAPI (Python)
│   │   ├── main.py
│   │   ├── snowflake_client.py # Connection: password / key-pair / SPCS OAuth
│   │   ├── requirements.txt
│   │   └── routers/
│   │       ├── bom.py          # BOM explosion, Where Used, revisions
│   │       ├── comparison.py   # BOM diff
│   │       ├── impact.py       # Supply chain impact analysis
│   │       ├── questions.py    # All 19 BRD queries as REST endpoints
│   │       ├── whatif.py       # What-if simulation overlay
│   │       └── attributes.py   # Dynamic material attribute filtering
│   │
│   ├── frontend/               # React + TypeScript (Vite)
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── BOMExplosion.tsx      # React Flow tree, start from any level
│   │       │   ├── WhereUsed.tsx         # Two-group: intermediates + finished PVs
│   │       │   ├── BOMComparison.tsx     # Side-by-side diff
│   │       │   ├── ImpactAnalysis.tsx    # Supply chain risk tiles
│   │       │   ├── WhatIfSimulator.tsx   # Read-only component substitution
│   │       │   ├── MaterialsExplorer.tsx # EAV dynamic attribute filtering
│   │       │   └── BusinessQuestions.tsx # 19 live BRD queries
│   │       └── components/
│   │           ├── BOMTree.tsx           # React Flow interactive tree
│   │           └── BOMGrid.tsx           # AG Grid wrapper
│   │
│   ├── Dockerfile              # Multi-stage: React build + FastAPI + nginx
│   ├── nginx.conf              # SPCS-compatible (port 8080)
│   ├── entrypoint.sh
│   └── spcs_service_spec.yaml  # Snowflake Container Services deployment spec
│
└── docs/
    ├── 01_architecture.md      # System architecture, data flow, component map
    ├── 02_business_narrative.md# All 19 BRD requirements mapped to SQL + 4 gaps addressed
    ├── 03_objection_handling.md# 10 objections with evidence and talking points
    ├── 04_sample_data_design.md# Data rationale, volumes, diamond dependency monitoring
    ├── 05_poc_runbook.md       # Step-by-step setup + SPCS deployment guide
    └── 06_demo_walkthrough.md  # 25-min demo script + 10-min cut + Q&A responses
```

---

## Quick Start (Local)

### Prerequisites

- Snowflake account with ACCOUNTADMIN role
- Python 3.11+
- Node.js 20+

### 1. Generate Data

```bash
cd data_generator
pip install -r requirements.txt

python generate_bom_data.py \
  --profile MEDIUM \
  --account <your-account> \
  --user <your-user> \
  --password <your-password>
```

Profiles: `SMALL` (fast dev), `MEDIUM` (demo), `PRODUCTION` (full scale).

### 2. Run SQL Setup

In Snowflake Worksheets, run in order:

```sql
-- Run each file sequentially
01_setup.sql
02_closure_table.sql
03_dynamic_table.sql    -- optional, for production auto-refresh
04_business_queries.sql
05_rls_policy.sql
06_what_if_procedure.sql
```

### 3. Start Backend

```bash
cd app/backend
pip install -r requirements.txt

export SNOWFLAKE_ACCOUNT=<account>
export SNOWFLAKE_USER=<user>
export SNOWFLAKE_PASSWORD=<password>   # or use key-pair (see below)
export SNOWFLAKE_DATABASE=PMI_CLIPP_POC
export SNOWFLAKE_SCHEMA=BOM_ANALYTICS
export SNOWFLAKE_WAREHOUSE=BOM_WH

python -m uvicorn main:app --reload --port 8000
```

**Key-pair auth (no MFA):**

```bash
export SNOWFLAKE_PRIVATE_KEY_PATH=~/.snowflake/rsa_key.p8
# omit SNOWFLAKE_PASSWORD
```

API docs: `http://localhost:8000/docs`

### 4. Start Frontend

```bash
cd app/frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

---

## Deployment to Snowflake Container Services (SPCS)

```bash
# Build image
docker build -t pmi-bom-app ./app

# Push to Snowflake image registry
docker tag pmi-bom-app <registry>.snowflakecomputing.com/pmi_clipp_poc/bom_repo/pmi-bom-app:latest
docker push <registry>.snowflakecomputing.com/pmi_clipp_poc/bom_repo/pmi-bom-app:latest

# Deploy service (Snowflake)
CREATE SERVICE PMI_BOM_APP
  IN COMPUTE POOL BOM_COMPUTE_POOL
  FROM SPECIFICATION @BOM_STAGE/spcs_service_spec.yaml;
```

In SPCS, the backend authenticates to Snowflake automatically via the injected OAuth token at `/snowflake/session/token` — no credentials needed in the container.

Full deployment guide: [`docs/05_poc_runbook.md`](docs/05_poc_runbook.md)

---

## Key Architecture Decisions

### Why a Closure Table?

The closure table pre-computes every ancestor-descendant relationship in the BOM tree. At query time, BOM explosion is `WHERE ancestor_id = :pv_id` — a single equality filter on a clustered column. No recursion, no graph traversal, no latency.

| Query | BRD SLA | Actual (POC) |
|---|---|---|
| BOM explosion (any depth) | <20 seconds | **<1 second** |
| Where Used | <1 minute | **<2 seconds** |
| BOM comparison | <1 minute | **<3 seconds** |
| Cross-domain (BQ-19) | <3 minutes | **<5 seconds** |

Closure table rebuild: **1.5 seconds** on X-Small warehouse at 111K rows. Estimated **8 seconds** on Medium at production scale (~1M rows).

### Why EAV for Material Attributes?

Different material categories have different attributes (Tobacco Leaf: grade, origin, moisture; Filter: diameter, pressure drop; Packaging: substrate, gsm, recyclable). An EAV table (`PART_ATTRIBUTES`) mirrors how ARAS stores these internally. A VARIANT rollup view (`V_PART_ATTRIBUTES_JSON`) enables fast dot-notation filtering. A metadata view (`V_ATTRIBUTE_SCHEMA`) auto-discovers available attributes per category — the UI renders filter controls dynamically with zero code changes when ARAS adds new attributes.

### Honest Limitations

- **Graph algorithms not in scope:** Shortest path, pattern matching, and centrality are valid graph database capabilities. Zero of the 19 BRD business questions require them. If PMI's analytics maturity evolves to need these, Snowpark Python can approximate centrality; shortest path requires adjacency table recursion.

- **Diamond dependencies:** If the same component appears via two different paths under the same parent, closure table quantity rollup becomes unreliable. Tobacco BOMs are trees (zero diamonds found in POC data). A monitoring query runs after every rebuild as a data quality gate.

- **UI:** The BOM tree (React Flow) renders hierarchy visually. It is not a force-directed graph layout — nodes are positioned algorithmically by depth level. This covers all BRD requirements but is structurally different from ANZO Hi-Res's graph navigation.

---

## POC Data

- **104 markets** (PMI full global footprint)
- **5,800 Product Variants** (combustible + HTU)
- **28,777 BOM adjacency rows**
- **111,543 closure rows** (3-level depth)
- **Virginia Leaf A → Where Used:** 5,177 PVs across 55 markets
- **Brands:** Marlboro, Parliament, Chesterfield, L&M, Philip Morris, Bond Street, HEETS, TEREA

Data generated via SQL `GENERATOR()` functions directly in Snowflake. The Python generator (`generate_bom_data.py`) produces larger volumes for load testing.

---

## Documentation

| Doc | Contents |
|---|---|
| [`01_architecture.md`](docs/01_architecture.md) | Data flow, Snowflake components, BOM data model, closure table design, SPCS deployment |
| [`02_business_narrative.md`](docs/02_business_narrative.md) | All 19 BRD questions mapped to SQL, 4 customer feedback gaps addressed |
| [`03_objection_handling.md`](docs/03_objection_handling.md) | 10 objections with evidence, talking points, and quick reference card |
| [`04_sample_data_design.md`](docs/04_sample_data_design.md) | Data rationale, actual POC volumes, diamond dependency monitoring |
| [`05_poc_runbook.md`](docs/05_poc_runbook.md) | Step-by-step setup, local dev, SPCS deployment, troubleshooting |
| [`06_demo_walkthrough.md`](docs/06_demo_walkthrough.md) | 25-min demo script, 10-min cut, mid-demo Q&A responses |

---

## License

This repository is confidential and intended for PMI CLIPP evaluation purposes only.
