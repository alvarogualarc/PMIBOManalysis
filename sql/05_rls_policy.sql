-- =============================================================================
-- FILE: 05_rls_policy.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: Row-Level Security — restrict PRODUCT_VARIANTS visibility by market.
--
-- DESIGN RATIONALE
--   PMI operates under market-specific data sovereignty and competitive
--   confidentiality requirements. BOM_USER_PL must not see Japanese or French
--   product variant data, and vice versa. Snowflake Row Access Policies enforce
--   this at the storage layer — no view logic, no application filter, no risk
--   of accidental exposure through ad-hoc queries.
--
-- POLICY TABLE APPROACH
--   We use an entitlement table (MARKET_ACCESS_POLICY_TABLE) rather than
--   hardcoding role names in the policy body. This makes adding new markets
--   or roles a simple INSERT, with no DDL change to the policy itself.
--
-- CLOSURE TABLE NOTE
--   Snowflake Row Access Policies cannot perform JOINs inside their body
--   (they evaluate per-row based only on the columns passed to them). Because
--   BOM_CLOSURE does not have a direct market_code column (market lives on
--   PRODUCT_VARIANTS), we cannot attach the policy directly to BOM_CLOSURE.
--   The solution is a SECURE VIEW (V_BOM_CLOSURE_SECURE) that inner-joins
--   BOM_CLOSURE to the market-filtered PRODUCT_VARIANTS. Because PRODUCT_VARIANTS
--   already carries the Row Access Policy, Snowflake automatically applies the
--   policy filter when PRODUCT_VARIANTS is queried — including inside the view
--   definition. This gives us transitive market filtering on BOM_CLOSURE.
-- =============================================================================

USE ROLE      BOM_ADMIN;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;

-- =============================================================================
-- 1. ENTITLEMENT TABLE
-- =============================================================================
CREATE OR REPLACE TABLE MARKET_ACCESS_POLICY_TABLE (
    role_name    VARCHAR NOT NULL COMMENT 'Snowflake role name (must match CURRENT_ROLE() exactly)',
    market_code  VARCHAR          COMMENT 'Market code this role may see. NULL = all markets.'
)
COMMENT = 'Maps Snowflake roles to permitted market codes for Row Access Policy. '
          'NULL market_code grants unrestricted access (global roles). '
          'Add a row per market if a role should see multiple specific markets.';

-- =============================================================================
-- 2. SEED ENTITLEMENT DATA
-- =============================================================================
INSERT INTO MARKET_ACCESS_POLICY_TABLE (role_name, market_code) VALUES
    ('BOM_USER_PL',  'PL'),    -- Poland only
    ('BOM_USER_FR',  'FR'),    -- France only
    ('BOM_USER_JP',  'JP'),    -- Japan only
    ('BOM_ANALYST',  NULL),    -- All markets — NULL = no market restriction
    ('BOM_ADMIN',    NULL);    -- All markets — full access

-- =============================================================================
-- 3. ROW ACCESS POLICY DEFINITION
--
-- How this policy works:
--   RETURNS BOOLEAN → TRUE means the row is visible, FALSE means it is hidden.
--   We look up the current session role in MARKET_ACCESS_POLICY_TABLE.
--   If the role has a NULL market_code entry → allow all rows (TRUE).
--   If the role has a specific market_code entry → only allow rows where
--   the row's market_code matches.
--   If the role is not in the table at all → deny access (FALSE) — fail secure.
-- =============================================================================
CREATE OR REPLACE ROW ACCESS POLICY market_bom_policy
AS (market_code VARCHAR)
RETURNS BOOLEAN ->
    EXISTS (
        SELECT 1
        FROM MARKET_ACCESS_POLICY_TABLE apt
        WHERE apt.role_name = CURRENT_ROLE()
          AND (
                apt.market_code IS NULL              -- global role: see all markets
             OR apt.market_code = market_code        -- market role: see own market only
          )
    )
COMMENT = 'Restricts PRODUCT_VARIANTS rows to markets the current role is '
          'entitled to see. Evaluated per-row at query execution time. '
          'Roles not present in MARKET_ACCESS_POLICY_TABLE are denied by default.';

-- =============================================================================
-- 4. ATTACH POLICY TO PRODUCT_VARIANTS
-- =============================================================================
ALTER TABLE PRODUCT_VARIANTS
    ADD ROW ACCESS POLICY market_bom_policy ON (market_code);

-- =============================================================================
-- 5. SECURE VIEW FOR BOM_CLOSURE MARKET FILTERING
--
-- WHY A SECURE VIEW?
--   BOM_CLOSURE has no market_code column — market identity is on PRODUCT_VARIANTS.
--   Snowflake Row Access Policies can only filter based on columns passed to them,
--   so we cannot directly attach market_bom_policy to BOM_CLOSURE.
--
--   Instead, we create a SECURE VIEW that joins BOM_CLOSURE to PRODUCT_VARIANTS.
--   Because PRODUCT_VARIANTS already carries market_bom_policy, the policy fires
--   automatically when PRODUCT_VARIANTS is accessed — even inside the view.
--   The result: querying V_BOM_CLOSURE_SECURE returns only closure rows whose
--   ancestor_id is a PV the current role is entitled to see.
--
--   SECURE keyword prevents view definition inspection by non-owners, protecting
--   the policy implementation from privilege escalation through SHOW CREATE VIEW.
-- =============================================================================
CREATE OR REPLACE SECURE VIEW V_BOM_CLOSURE_SECURE AS
SELECT
    cl.ancestor_id,
    cl.descendant_id,
    cl.depth,
    cl.path,
    cl.cum_qty,
    cl.bom_version,
    cl.eff_from,
    cl.eff_to,
    cl.ancestor_category,
    cl.descendant_category,
    -- Carry market context through for downstream joins
    pv.market_code,
    pv.pv_name,
    pv.global_product_name,
    pv.production_center
FROM BOM_CLOSURE_LIVE cl
-- Joining to PRODUCT_VARIANTS triggers market_bom_policy automatically.
-- Rows where the current role cannot see the PV will be filtered out here.
JOIN PRODUCT_VARIANTS pv
  ON pv.pv_id = cl.ancestor_id
COMMENT = 'Market-restricted view over BOM_CLOSURE_LIVE. Row visibility is '
          'controlled by market_bom_policy attached to PRODUCT_VARIANTS. '
          'Use this view instead of querying BOM_CLOSURE_LIVE directly in '
          'multi-tenant BI contexts.';

-- =============================================================================
-- 6. GRANT VIEW ACCESS TO ANALYST AND USER ROLES
-- =============================================================================
GRANT SELECT ON VIEW V_BOM_CLOSURE_SECURE TO ROLE BOM_ANALYST;
GRANT SELECT ON VIEW V_BOM_CLOSURE_SECURE TO ROLE BOM_USER_PL;
GRANT SELECT ON VIEW V_BOM_CLOSURE_SECURE TO ROLE BOM_USER_FR;
GRANT SELECT ON VIEW V_BOM_CLOSURE_SECURE TO ROLE BOM_USER_JP;

-- =============================================================================
-- 7. VALIDATION — DEMONSTRATE RLS IS WORKING
-- =============================================================================

-- As BOM_ANALYST (global): should see ALL markets
USE ROLE BOM_ANALYST;
SELECT market_code, COUNT(*) AS pv_count
FROM PRODUCT_VARIANTS
GROUP BY market_code
ORDER BY market_code;
-- Expected: rows for PL, FR, JP, and any other markets in the dataset.

-- As BOM_USER_PL (Poland only): should see ONLY PL
USE ROLE BOM_USER_PL;
SELECT market_code, COUNT(*) AS pv_count
FROM PRODUCT_VARIANTS
GROUP BY market_code
ORDER BY market_code;
-- Expected: exactly one row with market_code = 'PL'.

-- Verify BOM closure view is also market-filtered for BOM_USER_FR
USE ROLE BOM_USER_FR;
SELECT DISTINCT market_code
FROM V_BOM_CLOSURE_SECURE;
-- Expected: only 'FR'. No PL or JP rows should appear.

-- Confirm BOM_USER_JP cannot reach Poland data in the closure view
USE ROLE BOM_USER_JP;
SELECT COUNT(*) AS should_be_zero
FROM V_BOM_CLOSURE_SECURE
WHERE market_code = 'PL';
-- Expected: 0

-- Reset to admin role after validation
USE ROLE BOM_ADMIN;

-- =============================================================================
-- 8. POLICY MANAGEMENT REFERENCE
-- =============================================================================
-- List all Row Access Policies in this schema:
SHOW ROW ACCESS POLICIES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS;

-- Show which tables/views use a given policy:
SELECT *
FROM TABLE(INFORMATION_SCHEMA.POLICY_REFERENCES(
    POLICY_NAME => 'PMI_CLIPP_POC.BOM_ANALYTICS.MARKET_BOM_POLICY'
));

-- Add a new market for an existing role (no DDL change needed):
-- INSERT INTO MARKET_ACCESS_POLICY_TABLE VALUES ('BOM_USER_DE', 'DE');

-- Remove a policy from PRODUCT_VARIANTS (do NOT do in production without replacement):
-- ALTER TABLE PRODUCT_VARIANTS DROP ROW ACCESS POLICY market_bom_policy;
