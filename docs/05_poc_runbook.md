# POC Setup and Demo Runbook

This runbook covers everything needed to go from a blank Snowflake account to a running PMI CLIPP BOM Analytics demo. Follow the steps in order. Estimated total setup time: 25–35 minutes for the PRODUCTION profile (15–20 min data generation + 5–10 min SQL setup + 5 min app startup).

---

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| Snowflake account | **Enterprise edition or higher** — required for Dynamic Tables and SPCS |
| Snowflake user role | `SYSADMIN` or equivalent for initial setup (database, warehouse, role creation) |
| Python | 3.11+ |
| Node.js | 20+ |
| Docker | Required for SPCS deployment (Step 4b). Not needed for local dev (Step 4a). |
| `snowflake-connector-python` | Installed via `pip install -r requirements.txt` |

Verify your Snowflake edition before starting. Dynamic Tables require Enterprise; SPCS requires Enterprise or Business Critical.

```sql
-- Confirm edition
SELECT SYSTEM$WHITELIST_SNOWPARK_CONTAINER_SERVICES();
-- Returns: true if SPCS is available on your account
```

---

## Step 1: Generate Sample Data

The data generator creates all tables and loads them directly into Snowflake. It creates the database (`BOM_ANALYTICS`), schema, warehouse (`BOM_WH`), and all tables if they do not exist.

```bash
cd data_generator
pip install -r requirements.txt

python generate_bom_data.py \
  --profile PRODUCTION \
  --account <your-account>.snowflakecomputing.com \
  --user <your-user> \
  --password <your-password>
```

**Profile options:**

| Profile | PVs | Closure Rows | Load Time | Use For |
|---|---|---|---|---|
| `PRODUCTION` | 20,000 | 5–8M | 15–20 min | Performance demos, all benchmarks |
| `DEMO` | 2,000 | ~600K | 2–3 min | UI testing, quick environment setup |

**Expected terminal output:**
```
[1/8] Generating PARTS...          ████████████████ 500/500
[2/8] Generating PRODUCT_VARIANTS... ████████████████ 20000/20000
[3/8] Generating BOM_ITEMS...      ████████████████ 200000/200000
[4/8] Building BOM_CLOSURE...      (SQL-side build, ~3 min)
[5/8] Generating ECO...            ████████████████ 2000/2000
[6/8] Generating PROJECTS...       ████████████████ 500/500
[7/8] Generating GHP_PARAMETERS... ████████████████ 80000/80000
[8/8] Generating WORK_ORDERS...    ████████████████ 15000/15000

✓ Data generation complete.
  PRODUCT_VARIANTS:  20,000
  PARTS:               500
  BOM_ITEMS:         200,000
  BOM_CLOSURE:     6,247,831
  ECO:               2,000
  PROJECTS:            500
  GHP_PARAMETERS:   80,000
  WORK_ORDERS:      15,000
```

---

## Step 2: Run SQL Setup Files

Run these SQL files in order using Snowflake Worksheets, SnowSQL, or the Snowflake VSCode extension. Each file is idempotent (`CREATE OR REPLACE`) — safe to re-run.

```sql
-- 1. Database, schema, warehouse, roles, grants
-- (If data generator already ran, this is a no-op for existing objects)
source sql/01_setup.sql;

-- 2. Build or verify the BOM_CLOSURE table with clustering
source sql/02_closure_table.sql;

-- 3. (Optional) Create Dynamic Table for daily auto-refresh
-- Skip this for a one-time POC demo environment
source sql/03_dynamic_table.sql;

-- 4. Run all 19 business queries and verify they return data
source sql/04_business_queries.sql;

-- 5. Create Row Access Policies (market-scoped RLS)
source sql/05_rls_policy.sql;

-- 6. Create the What-If BOM procedure (scenario planning)
source sql/06_what_if_procedure.sql;
```

Files 3 and 6 are optional for the core demo but demonstrate Dynamic Tables and stored procedure capabilities respectively. File 5 (RLS) is required if you plan to demo the security objection response.

---

## Step 3: Verify Data

Run these verification queries in Snowflake Worksheets before starting the demo. Confirm expected results match.

```sql
-- 3.1 Closure table size — expect 5,000,000 to 8,000,000 rows
SELECT COUNT(*) AS closure_rows FROM BOM_ANALYTICS.BOM_CLOSURE;

-- 3.2 Where Used for the star ingredient — expect 1,000+ ancestor PVs
SELECT COUNT(DISTINCT ancestor_id) AS pv_count
FROM BOM_ANALYTICS.BOM_CLOSURE
WHERE descendant_id = (
    SELECT part_id FROM BOM_ANALYTICS.PARTS
    WHERE part_name = 'Virginia Leaf A'
);
-- Expected: 1,000–1,400

-- 3.3 BOM explosion — expect 200–500 rows, query < 1 second
SELECT COUNT(*) AS component_count,
       MAX(depth) AS max_depth
FROM BOM_ANALYTICS.BOM_CLOSURE
WHERE ancestor_id = (
    SELECT pv_id FROM BOM_ANALYTICS.PRODUCT_VARIANTS
    WHERE pv_name ILIKE '%Marlboro Red KS%'
      AND market = 'PL'
    LIMIT 1
);
-- Expected: 250–450 rows, max_depth = 5, execution < 1 second

-- 3.4 BOM comparison — verify both PVs exist
SELECT pv_id, pv_name, market
FROM BOM_ANALYTICS.PRODUCT_VARIANTS
WHERE (pv_name ILIKE '%Marlboro Red KS%' AND market IN ('PL', 'FR'))
ORDER BY market;
-- Expected: 2 rows (one PL, one FR)

-- 3.5 Row counts for KPI tiles
SELECT
    (SELECT COUNT(*) FROM BOM_ANALYTICS.PRODUCT_VARIANTS) AS pv_count,
    (SELECT COUNT(*) FROM BOM_ANALYTICS.PARTS)            AS part_count,
    (SELECT COUNT(*) FROM BOM_ANALYTICS.PROJECTS
     WHERE status = 'ACTIVE')                             AS active_projects,
    (SELECT COUNT(*) FROM BOM_ANALYTICS.BOM_CLOSURE)      AS closure_rows;

-- 3.6 Verify RLS policy (if 05_rls_policy.sql was run)
USE ROLE PMI_PL_USER;
SELECT COUNT(*) FROM BOM_ANALYTICS.PRODUCT_VARIANTS; -- Expect ~4,000 (PL market only)
USE ROLE SYSADMIN;
SELECT COUNT(*) FROM BOM_ANALYTICS.PRODUCT_VARIANTS; -- Expect 20,000 (all markets)
```

If any verification query fails or returns unexpected counts, check the troubleshooting section at the end of this document before proceeding to the demo.

---

## Step 4a: Local Development (No Docker Required)

Use this path for development, UI iteration, or demos on a laptop without Docker.

```bash
# ── Backend (FastAPI) ─────────────────────────────────────────────────────────
cd app/backend
pip install -r requirements.txt

export SNOWFLAKE_ACCOUNT=<your-account>.snowflakecomputing.com
export SNOWFLAKE_USER=<your-user>
export SNOWFLAKE_PASSWORD=<your-password>
export SNOWFLAKE_DATABASE=BOM_ANALYTICS
export SNOWFLAKE_SCHEMA=PUBLIC
export SNOWFLAKE_WAREHOUSE=BOM_WH
export SNOWFLAKE_ROLE=SYSADMIN

uvicorn main:app --reload --port 8000
# Backend running at http://localhost:8000
# API docs at http://localhost:8000/docs
```

```bash
# ── Frontend (React) — open a second terminal ─────────────────────────────────
cd app/frontend
npm install
npm run dev
# Development server at http://localhost:5173
# /api/* requests proxy to http://localhost:8000
```

Open `http://localhost:5173` in Chrome or Firefox. The Home dashboard should display KPI tiles with production-scale row counts.

**Verify the app is connected:**
- KPI tiles show non-zero numbers (PVs: ~20,000; Parts: ~500)
- BOM Explosion: search for "Marlboro Red", select a KS Poland PV, set depth 5, click Explore
- The React Flow tree renders within 2 seconds

---

## Step 4b: SPCS Deployment (Production / Client Demo)

Use this path when demonstrating inside Snowflake's network boundary, or for the production deployment.

The SPCS container image packages Nginx (port 8080, public), a React production build, and a FastAPI backend (port 8000, internal). Nginx serves the React static files and proxies `/api` requests to the FastAPI process. Snowflake session credentials are injected via SPCS environment variables — no secrets in the image.

**Build context note:** The Dockerfile expects to be built from the `app/` directory. The build context must include both `frontend/` and `backend/` subdirectories. Do not build from `app/frontend/` or `app/backend/` independently — the multi-stage Dockerfile references both.

```bash
# ── 1. Build the Docker image ─────────────────────────────────────────────────
# Build from the app/ directory (includes both frontend and backend)
docker build -t pmi-bom-app ./app

# Verify the image starts and responds on port 8080
docker run -p 8080:8080 \
  -e SNOWFLAKE_ACCOUNT=<account> \
  -e SNOWFLAKE_USER=<user> \
  -e SNOWFLAKE_PASSWORD=<password> \
  pmi-bom-app
# Test: curl http://localhost:8080/api/health → {"status": "ok"}
# Stop with Ctrl+C — the container handles SIGTERM gracefully (5s drain)
```

```bash
# ── 2. Push to Snowflake image registry ──────────────────────────────────────
# Get your registry URL from Snowflake first
REGISTRY=$(snowsql -q "SHOW IMAGE REPOSITORIES IN SCHEMA BOM_ANALYTICS.PUBLIC" \
  --format=json | jq -r '.[0].repository_url')

docker tag pmi-bom-app ${REGISTRY}/pmi-bom-app:latest
docker push ${REGISTRY}/pmi-bom-app:latest
```

```sql
-- ── 3. Create compute pool and service in Snowflake ──────────────────────────
-- Run in Snowsight or SnowSQL as SYSADMIN

CREATE COMPUTE POOL IF NOT EXISTS BOM_COMPUTE_POOL
  MIN_NODES = 1
  MAX_NODES = 2
  INSTANCE_FAMILY = STANDARD_1;

-- Wait for compute pool to reach ACTIVE state (~2-3 min)
SHOW COMPUTE POOLS;

-- Upload service spec (if not already on stage)
PUT file://spcs_service_spec.yaml @BOM_ANALYTICS.PUBLIC.BOM_STAGE OVERWRITE = TRUE;

-- Create the service
CREATE SERVICE IF NOT EXISTS PMI_BOM_APP
  IN COMPUTE POOL BOM_COMPUTE_POOL
  FROM SPECIFICATION @BOM_ANALYTICS.PUBLIC.BOM_STAGE/spcs_service_spec.yaml
  EXTERNAL_ACCESS_INTEGRATIONS = (ALLOW_ALL_INTEGRATION);

-- Monitor until status = RUNNING (~2-3 min)
SELECT SYSTEM$GET_SERVICE_STATUS('PMI_BOM_APP');

-- Get the public endpoint URL
SHOW SERVICES;
-- Copy the 'dns_name' value from the output — this is your demo URL
```

**Service spec (`spcs_service_spec.yaml`):**

```yaml
spec:
  containers:
    - name: pmi-bom-app
      image: <registry>.snowflakecomputing.com/bom_analytics/public/bom_repo/pmi-bom-app:latest
      env:
        SNOWFLAKE_ACCOUNT: <account-identifier>
        SNOWFLAKE_USER: <service-account-user>
        SNOWFLAKE_DATABASE: BOM_ANALYTICS
        SNOWFLAKE_SCHEMA: PUBLIC
        SNOWFLAKE_WAREHOUSE: BOM_WH
      secrets:
        - snowflakeSecret: BOM_ANALYTICS.PUBLIC.BOM_APP_SECRET
          envVarName: SNOWFLAKE_PASSWORD
      resources:
        requests:
          cpu: "1"
          memory: 2Gi
        limits:
          cpu: "2"
          memory: 4Gi
  endpoints:
    - name: ui
      port: 8080
      public: true
```

**Grant users access to the endpoint:**

```sql
GRANT USAGE ON SERVICE PMI_BOM_APP TO ROLE PMI_DEMO_USER;
```

Users access the app at the `dns_name` URL from `SHOW SERVICES`. Snowflake OAuth handles authentication — users log in with their Snowflake credentials (which are federated to AD via SAML SSO in production).

---

## Step 5: Demo Script — 10-Minute PMI Demo Flow

### Setup Before the Meeting

1. Open the app in Chrome, full screen, zoom level 100%
2. Pre-navigate to the Home dashboard — KPI tiles should be visible
3. Have Snowsight open in a second browser tab, logged in as `SYSADMIN`
4. Confirm BOM_WH is resumed (`SELECT SYSTEM$WAREHOUSE_STATUS('BOM_WH')`)
5. Run Step 3 verification queries — confirm all pass

---

### Slide 1 — Home Dashboard (2 minutes)

**What to show:** KPI tiles — Product Variants, Parts, Active Projects, Closure Rows

**Script:** *"This is production-scale data. 20,000 Product Variants — a realistic representation of PMI's combustible and HTU portfolio across 5 markets. 500 components — the tobacco industry uses a small but highly shared set of raw materials. And 6 million closure rows — that's every ancestor-descendant relationship in every BOM, pre-computed. When you ask for a BOM explosion, we're not traversing a graph. We're looking up a row in this table."*

Point to the closure row count. Let the number land.

---

### Slide 2 — BOM Explosion (3 minutes)

**What to show:** Select Marlboro Red KS Poland → depth 5 → React Flow tree

**Script:** *"Let me show you the experience your users will have."*

Type "Marlboro Red" in the search box. Select Marlboro Red KS Poland from the dropdown. Set depth to 5. Click "Explore BOM".

*"The tree is loading. Five levels of tobacco manufacturing hierarchy — leaf to carton."*

Wait for React Flow to render. Then pan to find Virginia Leaf A in the tree. Click the node.

*"Virginia Leaf A. A specific grade of flue-cured Virginia tobacco. Same supplier, same spec, used across the entire Marlboro family globally. Let me show you what that means."*

---

### Slide 3 — Where Used (2 minutes)

**What to show:** Virginia Leaf A → 1,200+ PVs, 5 markets, all Marlboro brands

**Script (immediately after clicking the node):** *"Virginia Leaf A is used in — [pause, let the number load] — 1,247 Product Variants. Five markets. The full Marlboro family and several L&M variants."*

*"A supply disruption on this one ingredient — a weather event in Zimbabwe, a supplier quality issue — affects more than 1,200 Product Variants globally. This answer takes under 2 seconds in Snowflake. This is the supply chain risk insight your procurement team needs in real time."*

Scroll through the market breakdown in the table.

---

### Slide 4 — BOM Comparison (1.5 minutes)

**What to show:** Marlboro Red KS Poland vs Marlboro Red KS France — diff view highlighting tax stamps

**Script:** *"One of the most common BOM questions in a multinational portfolio: how does the Polish BOM differ from the French BOM for the same product? Let me show you."*

Select Poland / France comparison. Wait for the diff table.

Point to the UNIQUE_B rows (France-specific). *"Tax stamp — France-specific regulatory requirement. Health warning size — differs by market regulation. The global tobacco blend is identical; the market-specific regulatory pack components are exactly what you'd expect to be different."*

*"Every market-specific regulatory component is captured. Compliance reviews are instant."*

---

### Slide 5 — Business Questions: BQ-19 (1.5 minutes)

**What to show:** Navigate to Business Questions page → select BQ-19 → run → show results

**Script:** *"The last thing I want to show you is the query your team called out as the hardest in the BRD — BQ-19. Cross-domain: work orders, project status, product attributes, and BOM component count in one unified output."*

Click BQ-19. Click Run.

*"[Query executes.] 2.8 seconds. Work order status, project milestone, brand, market, BOM depth — everything in one row per Product Variant."*

*"This was the query that was supposed to require ANZO's graph traversal. It's a standard SQL join. And if you need to know why that matters: the simpler the technology, the easier it is for your engineering team to own, extend, and maintain without a specialized graph database vendor."*

---

## Troubleshooting

### Closure table build fails with recursion limit error

```
Error: Recursive query exceeded maximum recursion limit of 100
```

**Fix:** Before running `02_closure_table.sql`, set:

```sql
ALTER SESSION SET MAX_RECURSION_DEPTH = 20;
```

This is a session-level setting. Add it to the top of `02_closure_table.sql` as a precaution.

---

### SPCS endpoint not accessible (browser shows connection refused or 502)

**Diagnose:**

```sql
-- Check compute pool status — must be ACTIVE, not STARTING
SHOW COMPUTE POOLS;

-- Check service status — must be RUNNING
SELECT SYSTEM$GET_SERVICE_STATUS('PMI_BOM_APP');

-- Check service logs for startup errors
SELECT value FROM TABLE(
    SYSTEM$GET_SERVICE_LOGS('PMI_BOM_APP', 0, 'pmi-bom-app', 100)
);
```

**Common causes:**
- Compute pool still in `STARTING` state — wait 2–3 more minutes
- Service image pull failed — verify image was pushed to correct registry path
- `SNOWFLAKE_PASSWORD` secret not found — confirm the secret object exists in `BOM_ANALYTICS.PUBLIC`

---

### Frontend shows "Failed to fetch" or blank data panels

**Diagnose in this order:**

1. Confirm the backend is running: `curl http://localhost:8000/api/health` → `{"status": "ok"}`
2. Check that the Nginx proxy config routes `/api` to `localhost:8000` (not `localhost:8080`)
3. Verify Snowflake environment variables are set: `echo $SNOWFLAKE_ACCOUNT`
4. Check FastAPI logs for Snowflake authentication errors — a wrong warehouse name or suspended warehouse are the most common causes

**Note on nginx header inheritance:** The Nginx configuration must forward the `X-Forwarded-For` and `Authorization` headers to the FastAPI backend. If the SPCS deployment shows authenticated requests failing, verify that `proxy_pass_header Authorization;` is present in the nginx config block.

---

### Data generation completes but row counts are lower than expected

**Diagnose:**

```sql
SELECT table_name, row_count
FROM BOM_ANALYTICS.INFORMATION_SCHEMA.TABLES
WHERE table_schema = 'PUBLIC'
ORDER BY table_name;
```

If `BOM_CLOSURE` has fewer than 4 million rows:
- The recursive CTE build may have hit a default recursion limit mid-build
- Drop and rebuild: `DROP TABLE BOM_ANALYTICS.BOM_CLOSURE;` then re-run `02_closure_table.sql` with `MAX_RECURSION_DEPTH = 20` set

If `PRODUCT_VARIANTS` has fewer than 20,000 rows:
- The data generator likely encountered a batch insert timeout
- Re-run with `--profile PRODUCTION` — the generator detects existing rows and skips completed tables

---

### Dynamic Table (BOM_CLOSURE_DT) shows FAILED refresh status

```sql
-- Check refresh history
SELECT *
FROM TABLE(INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
    NAME => 'BOM_ANALYTICS.PUBLIC.BOM_CLOSURE_DT'
))
ORDER BY refresh_start_time DESC
LIMIT 5;
```

Most common cause: the warehouse `BOM_WH` was suspended when the scheduled refresh triggered. Set auto-resume on the warehouse:

```sql
ALTER WAREHOUSE BOM_WH SET AUTO_RESUME = TRUE;
```

Then manually trigger a refresh:

```sql
ALTER DYNAMIC TABLE BOM_ANALYTICS.BOM_CLOSURE_DT REFRESH;
```
