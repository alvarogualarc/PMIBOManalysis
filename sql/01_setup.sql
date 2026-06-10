-- =============================================================================
-- FILE: 01_setup.sql
-- PROJECT: PMI CLIPP BOM Analytics POC
-- PURPOSE: One-time infrastructure setup — database, schema, warehouse, roles,
--          and grant hierarchy. Run once as SYSADMIN / ACCOUNTADMIN.
-- =============================================================================

-- -----------------------------------------------------------------------
-- 0. Context — run as SYSADMIN for object creation; ACCOUNTADMIN for role
--    grants that touch account-level privileges.
-- -----------------------------------------------------------------------
USE ROLE SYSADMIN;

-- =============================================================================
-- 1. DATABASE & SCHEMA
-- =============================================================================

CREATE DATABASE IF NOT EXISTS PMI_CLIPP_POC
    COMMENT = 'Philip Morris International — CLIPP BOM Analytics POC. '
              'Migrating BOM graph analytics from ANZO to Snowflake.';

CREATE SCHEMA IF NOT EXISTS PMI_CLIPP_POC.BOM_ANALYTICS
    COMMENT = 'Primary schema for BOM closure tables, business queries, '
              'RLS policies, and what-if procedures.';

-- =============================================================================
-- 2. VIRTUAL WAREHOUSE
-- =============================================================================

CREATE WAREHOUSE IF NOT EXISTS BOM_WH
    WAREHOUSE_SIZE   = MEDIUM
    AUTO_SUSPEND     = 60          -- suspend after 60 seconds of inactivity
    AUTO_RESUME      = TRUE
    INITIALLY_SUSPENDED = TRUE
    COMMENT = 'Dedicated warehouse for BOM Analytics POC. MEDIUM size supports '
              'recursive CTE builds and ad-hoc analyst queries concurrently.';

-- =============================================================================
-- 3. ROLES
-- =============================================================================
-- Role hierarchy:
--
--   ACCOUNTADMIN
--       └── SYSADMIN
--               └── BOM_ADMIN          (full DDL + DML on PMI_CLIPP_POC)
--                       └── BOM_ANALYST    (SELECT all markets, no DDL)
--                               ├── BOM_USER_PL  (SELECT — Poland only via RLS)
--                               ├── BOM_USER_FR  (SELECT — France only via RLS)
--                               └── BOM_USER_JP  (SELECT — Japan only via RLS)

USE ROLE USERADMIN;   -- USERADMIN creates roles; SYSADMIN grants object privileges

CREATE ROLE IF NOT EXISTS BOM_ADMIN
    COMMENT = 'Full DDL/DML on PMI_CLIPP_POC. Intended for data engineers '
              'and pipeline owners maintaining the BOM schema.';

CREATE ROLE IF NOT EXISTS BOM_ANALYST
    COMMENT = 'Read-only access across ALL markets. Intended for global '
              'product management and cross-market analytics teams.';

CREATE ROLE IF NOT EXISTS BOM_USER_PL
    COMMENT = 'Read-only access scoped to Poland (market_code = PL) via '
              'row-access policy on PRODUCT_VARIANTS and BOM views.';

CREATE ROLE IF NOT EXISTS BOM_USER_FR
    COMMENT = 'Read-only access scoped to France (market_code = FR).';

CREATE ROLE IF NOT EXISTS BOM_USER_JP
    COMMENT = 'Read-only access scoped to Japan (market_code = JP).';

-- =============================================================================
-- 4. ROLE HIERARCHY GRANTS
-- =============================================================================
USE ROLE USERADMIN;

-- Market-restricted roles roll up to BOM_ANALYST so that a global analyst
-- can also assume any market role directly if needed.
GRANT ROLE BOM_USER_PL  TO ROLE BOM_ANALYST;
GRANT ROLE BOM_USER_FR  TO ROLE BOM_ANALYST;
GRANT ROLE BOM_USER_JP  TO ROLE BOM_ANALYST;

-- BOM_ANALYST rolls up to BOM_ADMIN (admin can do everything an analyst can).
GRANT ROLE BOM_ANALYST  TO ROLE BOM_ADMIN;

-- BOM_ADMIN rolls up to SYSADMIN per Snowflake best-practice role hierarchy.
GRANT ROLE BOM_ADMIN    TO ROLE SYSADMIN;

-- =============================================================================
-- 5. OBJECT PRIVILEGE GRANTS
-- =============================================================================
USE ROLE SYSADMIN;

-- --- Warehouse usage ---
GRANT USAGE ON WAREHOUSE BOM_WH TO ROLE BOM_ADMIN;
GRANT USAGE ON WAREHOUSE BOM_WH TO ROLE BOM_ANALYST;
GRANT USAGE ON WAREHOUSE BOM_WH TO ROLE BOM_USER_PL;
GRANT USAGE ON WAREHOUSE BOM_WH TO ROLE BOM_USER_FR;
GRANT USAGE ON WAREHOUSE BOM_WH TO ROLE BOM_USER_JP;

-- --- Database & schema navigation ---
GRANT USAGE ON DATABASE PMI_CLIPP_POC TO ROLE BOM_ADMIN;
GRANT USAGE ON DATABASE PMI_CLIPP_POC TO ROLE BOM_ANALYST;
GRANT USAGE ON DATABASE PMI_CLIPP_POC TO ROLE BOM_USER_PL;
GRANT USAGE ON DATABASE PMI_CLIPP_POC TO ROLE BOM_USER_FR;
GRANT USAGE ON DATABASE PMI_CLIPP_POC TO ROLE BOM_USER_JP;

GRANT USAGE ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT USAGE ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
GRANT USAGE ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_PL;
GRANT USAGE ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_FR;
GRANT USAGE ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_JP;

-- --- BOM_ADMIN: full DDL + DML ---
GRANT ALL PRIVILEGES ON SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT ALL PRIVILEGES ON ALL VIEWS     IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
-- Future objects created in this schema are automatically granted to BOM_ADMIN
GRANT ALL PRIVILEGES ON FUTURE TABLES    IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT ALL PRIVILEGES ON FUTURE VIEWS     IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;
GRANT ALL PRIVILEGES ON FUTURE PROCEDURES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ADMIN;

-- --- BOM_ANALYST: SELECT on all current and future objects ---
GRANT SELECT ON ALL TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
GRANT SELECT ON ALL VIEWS  IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
GRANT SELECT ON FUTURE TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
GRANT SELECT ON FUTURE VIEWS  IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
-- BOM_ANALYST inherits BOM_USER_* via role hierarchy; market-level roles SELECT
-- the same objects but row access policies filter their result sets.
GRANT SELECT ON ALL TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_PL;
GRANT SELECT ON ALL TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_FR;
GRANT SELECT ON ALL TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_JP;
GRANT SELECT ON FUTURE TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_PL;
GRANT SELECT ON FUTURE TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_FR;
GRANT SELECT ON FUTURE TABLES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_JP;
GRANT SELECT ON ALL VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_PL;
GRANT SELECT ON ALL VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_FR;
GRANT SELECT ON ALL VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_JP;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_PL;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_FR;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_USER_JP;

-- Stored procedure USAGE (allows calling without granting ownership)
GRANT USAGE ON ALL PROCEDURES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;
GRANT USAGE ON FUTURE PROCEDURES IN SCHEMA PMI_CLIPP_POC.BOM_ANALYTICS TO ROLE BOM_ANALYST;

-- =============================================================================
-- 6. SET WORKING CONTEXT FOR SUBSEQUENT SCRIPTS
-- =============================================================================
USE ROLE      BOM_ADMIN;
USE DATABASE  PMI_CLIPP_POC;
USE SCHEMA    BOM_ANALYTICS;
USE WAREHOUSE BOM_WH;
