import logging
from datetime import datetime, timezone

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from snowflake_client import execute_query, get_connection
from routers import bom, comparison, impact, questions, whatif, attributes

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="PMI BOM Analytics API",
    description="Backend API for PMI BOM Analytics POC – serves BOM explosion, comparison, impact analysis, and business questions against Snowflake.",
    version="0.1.0",
    openapi_tags=[
        {"name": "health", "description": "Service health and metadata"},
        {"name": "bom", "description": "BOM explosion and where-used queries"},
        {"name": "compare", "description": "Side-by-side BOM comparisons"},
        {"name": "impact", "description": "Part change impact analysis"},
        {"name": "questions", "description": "Pre-built BRD business questions"},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(bom.router,        prefix="/api/bom",        tags=["bom"])
app.include_router(comparison.router,  prefix="/api/compare",    tags=["compare"])
app.include_router(impact.router,      prefix="/api/impact",     tags=["impact"])
app.include_router(questions.router,   prefix="/api/questions",  tags=["questions"])
app.include_router(whatif.router,      prefix="/api/whatif",     tags=["whatif"])
app.include_router(attributes.router,  prefix="/api/attributes", tags=["attributes"])


@app.on_event("startup")
async def startup_event():
    try:
        get_connection()
        logger.info("Snowflake connection OK")
    except Exception as e:
        logger.error("Snowflake connection FAILED on startup: %s", e)


@app.get("/api/health", tags=["health"])
def health():
    try:
        rows = execute_query("""
            SELECT
                (SELECT COUNT(*) FROM PRODUCT_VARIANTS WHERE lifecycle_status = 'Released') AS active_pvs,
                (SELECT COUNT(*) FROM PARTS)                                                AS total_parts,
                (SELECT COUNT(*) FROM ECO WHERE status = 'Open')                            AS open_ecos,
                (SELECT COUNT(*) FROM PROJECTS WHERE status = 'Pending Approval')           AS pending_approvals
        """)
        kpis = rows[0] if rows else {}
        return {
            "status": "ok",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "active_pvs":        kpis.get("active_pvs", 0),
            "total_parts":       kpis.get("total_parts", 0),
            "open_ecos":         kpis.get("open_ecos", 0),
            "pending_approvals": kpis.get("pending_approvals", 0),
        }
    except Exception as e:
        logger.error("Health KPI query failed: %s", e)
        return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/api/markets", tags=["health"])
def get_markets():
    rows = execute_query(
        "SELECT market_code, market_name, region FROM MARKETS ORDER BY region, market_name"
    )
    return rows


@app.get("/api/brands", tags=["health"])
def get_brands():
    rows = execute_query(
        "SELECT DISTINCT brand_name FROM PRODUCT_VARIANTS WHERE brand_name IS NOT NULL ORDER BY brand_name"
    )
    return [r["brand_name"] for r in rows]


@app.get("/api/pvs", tags=["health"])
def get_pvs(
    market_code: str = Query(None),
    brand_name: str = Query(None),
    lifecycle_status: str = Query(None),
):
    clauses = ["1=1"]
    params: dict = {}
    if market_code:
        clauses.append("market_code = %(market_code)s")
        params["market_code"] = market_code
    if brand_name:
        clauses.append("brand_name = %(brand_name)s")
        params["brand_name"] = brand_name
    if lifecycle_status:
        clauses.append("lifecycle_status = %(lifecycle_status)s")
        params["lifecycle_status"] = lifecycle_status

    where = " AND ".join(clauses)
    sql = (
        f"SELECT pv_id, pv_name, market_code, brand_name, lifecycle_status "
        f"FROM PRODUCT_VARIANTS WHERE {where} ORDER BY pv_name"
    )
    return execute_query(sql, params)


@app.get("/api/parts", tags=["health"])
def get_parts(category: str = Query(None)):
    if category:
        sql = "SELECT part_id, part_name, category FROM PARTS WHERE category = %(category)s ORDER BY part_name"
        return execute_query(sql, {"category": category})
    return execute_query("SELECT part_id, part_name, category FROM PARTS ORDER BY part_name")
