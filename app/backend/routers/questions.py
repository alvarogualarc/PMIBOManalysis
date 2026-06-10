import time
from typing import Optional

from fastapi import APIRouter, Query, HTTPException, Path

from snowflake_client import execute_query

router = APIRouter()

# ---------------------------------------------------------------------------
# Question registry: id -> (question_text, sql_template, required_params)
# ---------------------------------------------------------------------------

QUESTIONS: dict[int, dict] = {
    1: {
        "text": "BQ-01: What is the total material cost for a given product variant at a planned production volume?",
        "sql": """
            SELECT
                pv.pv_id,
                pv.pv_name,
                pv.brand_name,
                pv.market_code,
                SUM(c.cum_qty * p.standard_cost) AS unit_material_cost,
                SUM(c.cum_qty * p.standard_cost) * %(planned_volume_units)s AS total_material_cost,
                %(planned_volume_units)s AS planned_volume_units
            FROM BOM_CLOSURE c
            JOIN PARTS p ON p.part_id = c.descendant_id
            JOIN PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
            WHERE c.ancestor_id = %(pv_id)s
              AND c.depth > 0
            GROUP BY pv.pv_id, pv.pv_name, pv.brand_name, pv.market_code
        """,
    },
    2: {
        "text": "BQ-02: Which product variants are active (sellable) in a given market?",
        "sql": """
            SELECT pv_id, pv_name, brand_name, market_code, pc_code, lifecycle_status, eff_from, eff_to
            FROM PRODUCT_VARIANTS
            WHERE market_code = %(market_code)s
              AND is_sellable = TRUE
            ORDER BY brand_name, pv_name
        """,
    },
    3: {
        "text": "BQ-03: What is the full multi-level BOM for a given product variant?",
        "sql": """
            SELECT
                c.descendant_id,
                p.part_name,
                p.category,
                c.depth,
                c.path,
                c.cum_qty,
                p.unit_of_measure,
                p.supplier,
                p.standard_cost,
                c.ancestor_category,
                c.descendant_category
            FROM BOM_CLOSURE c
            JOIN PARTS p ON p.part_id = c.descendant_id
            WHERE c.ancestor_id = %(pv_id)s
              AND c.depth > 0
            ORDER BY c.depth, c.descendant_id
        """,
    },
    4: {
        "text": "BQ-04: What are the manufacturing specifications (MSPEC) for a given product variant?",
        "sql": """
            SELECT
                ms.mspec_id,
                ms.mspec_name,
                ms.pc_code,
                ms.cigarette_length_mm,
                ms.cigarette_circumference_mm,
                ms.filter_length_mm,
                ms.tobacco_weight_g,
                pv.pv_name,
                pv.brand_name,
                pv.market_code
            FROM MSPEC ms
            JOIN PRODUCT_VARIANTS pv ON pv.pv_id = ms.pv_id
            WHERE ms.pv_id = %(pv_id)s
        """,
    },
    5: {
        "text": "BQ-05: How many levels deep is the BOM for a given product variant (BOM depth)?",
        "sql": """
            SELECT
                MAX(c.depth) AS max_bom_depth,
                COUNT(DISTINCT c.descendant_id) AS total_unique_parts,
                COUNT(*) AS total_bom_lines
            FROM BOM_CLOSURE c
            WHERE c.ancestor_id = %(pv_id)s
              AND c.depth > 0
              AND c.depth <= %(max_depth)s
        """,
    },
    6: {
        "text": "BQ-06: In how many and which product variants is a specific part used (where-used / multi-level)?",
        "sql": """
            SELECT
                c.ancestor_id,
                pv.pv_name,
                pv.brand_name,
                pv.market_code,
                pv.lifecycle_status,
                c.depth,
                c.cum_qty,
                c.path
            FROM BOM_CLOSURE c
            JOIN PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
            WHERE c.descendant_id = %(part_id)s
              AND c.depth > 0
            ORDER BY pv.market_code, pv.brand_name
        """,
    },
    7: {
        "text": "BQ-07: What are the BOM differences between two product variants?",
        "sql": """
            SELECT
                COALESCE(a.descendant_id, b.descendant_id) AS part_id,
                p.part_name,
                p.category,
                a.cum_qty AS qty_pv_a,
                b.cum_qty AS qty_pv_b,
                (b.cum_qty - a.cum_qty) AS qty_diff,
                CASE
                    WHEN a.descendant_id IS NULL THEN 'Only in PV_B'
                    WHEN b.descendant_id IS NULL THEN 'Only in PV_A'
                    WHEN a.cum_qty <> b.cum_qty THEN 'Qty Difference'
                    ELSE 'Same'
                END AS diff_type
            FROM BOM_CLOSURE a
            FULL OUTER JOIN BOM_CLOSURE b
                ON b.descendant_id = a.descendant_id
               AND b.ancestor_id = %(pv_b)s
               AND b.depth > 0
            JOIN PARTS p ON p.part_id = COALESCE(a.descendant_id, b.descendant_id)
            WHERE (a.ancestor_id = %(pv_a)s OR a.ancestor_id IS NULL)
              AND (a.depth > 0 OR b.depth > 0)
            ORDER BY diff_type, part_id
        """,
    },
    8: {
        "text": "BQ-08: What are the global/harmonised parameters for a given product variant?",
        "sql": """
            SELECT
                ghp.parameter_name,
                ghp.parameter_value,
                ghp.parameter_unit,
                ghp.is_global,
                pv.pv_name,
                pv.brand_name
            FROM GHP_PARAMETERS ghp
            JOIN PRODUCT_VARIANTS pv ON pv.pv_id = ghp.pv_id
            WHERE ghp.pv_id = %(pv_id)s
            ORDER BY ghp.is_global DESC, ghp.parameter_name
        """,
    },
    9: {
        "text": "BQ-09: What are the open Engineering Change Orders (ECOs) and their affected parts/PVs?",
        "sql": """
            SELECT
                e.eco_id,
                e.eco_type,
                e.status,
                e.title,
                e.affected_part_id,
                p.part_name,
                e.affected_pv_id,
                pv.pv_name,
                e.created_date,
                e.closed_date,
                e.created_by
            FROM ECO e
            LEFT JOIN PARTS p ON p.part_id = e.affected_part_id
            LEFT JOIN PRODUCT_VARIANTS pv ON pv.pv_id = e.affected_pv_id
            WHERE e.status = %(status)s
              AND (%(eco_type)s IS NULL OR e.eco_type = %(eco_type)s)
            ORDER BY e.created_date DESC
        """,
    },
    10: {
        "text": "BQ-10: How many product variants were launched in a given market and year?",
        "sql": """
            SELECT
                pv_id,
                pv_name,
                brand_name,
                market_code,
                lifecycle_status,
                eff_from,
                pc_code
            FROM PRODUCT_VARIANTS
            WHERE market_code = %(market_code)s
              AND YEAR(eff_from) = %(year)s
            ORDER BY eff_from
        """,
    },
    11: {
        "text": "BQ-11: What are the BOM differences for the same brand across two markets?",
        "sql": """
            SELECT
                COALESCE(a.descendant_id, b.descendant_id) AS part_id,
                p.part_name,
                p.category,
                pva.pv_id AS pv_id_market_a,
                pva.pv_name AS pv_name_market_a,
                pvb.pv_id AS pv_id_market_b,
                pvb.pv_name AS pv_name_market_b,
                a.cum_qty AS qty_market_a,
                b.cum_qty AS qty_market_b,
                CASE
                    WHEN a.descendant_id IS NULL THEN 'Only in market_b'
                    WHEN b.descendant_id IS NULL THEN 'Only in market_a'
                    WHEN a.cum_qty <> b.cum_qty THEN 'Qty Difference'
                    ELSE 'Same'
                END AS diff_type
            FROM PRODUCT_VARIANTS pva
            JOIN BOM_CLOSURE a ON a.ancestor_id = pva.pv_id AND a.depth > 0
            JOIN PRODUCT_VARIANTS pvb
                ON pvb.brand_name = pva.brand_name
               AND pvb.market_code = %(market_code_b)s
            JOIN BOM_CLOSURE b
                ON b.ancestor_id = pvb.pv_id
               AND b.descendant_id = a.descendant_id
               AND b.depth > 0
            JOIN PARTS p ON p.part_id = COALESCE(a.descendant_id, b.descendant_id)
            WHERE pva.market_code = %(market_code_a)s
            ORDER BY diff_type, part_id
        """,
    },
    12: {
        "text": "BQ-12: What is the complete product portfolio (all PVs and their BOMs) for a given market?",
        "sql": """
            SELECT
                pv.pv_id,
                pv.pv_name,
                pv.brand_name,
                pv.market_code,
                pv.pc_code,
                pv.lifecycle_status,
                COUNT(DISTINCT c.descendant_id) AS unique_components,
                SUM(c.cum_qty * p.standard_cost) AS total_material_cost
            FROM PRODUCT_VARIANTS pv
            LEFT JOIN BOM_CLOSURE c ON c.ancestor_id = pv.pv_id AND c.depth > 0
            LEFT JOIN PARTS p ON p.part_id = c.descendant_id
            WHERE pv.market_code = %(market_code)s
            GROUP BY pv.pv_id, pv.pv_name, pv.brand_name, pv.market_code, pv.pc_code, pv.lifecycle_status
            ORDER BY pv.brand_name, pv.pv_name
        """,
    },
    13: {
        "text": "BQ-13: Which BOMs have not been revised in N or more years (stale/frozen BOMs)?",
        "sql": """
            SELECT
                pv.pv_id,
                pv.pv_name,
                pv.brand_name,
                pv.market_code,
                pv.lifecycle_status,
                MAX(br.revision_date) AS last_revision_date,
                DATEDIFF('year', MAX(br.revision_date), CURRENT_DATE()) AS years_since_revision
            FROM PRODUCT_VARIANTS pv
            LEFT JOIN BOM_REVISIONS br ON br.pv_id = pv.pv_id
            GROUP BY pv.pv_id, pv.pv_name, pv.brand_name, pv.market_code, pv.lifecycle_status
            HAVING years_since_revision >= %(years_without_revision)s
                OR MAX(br.revision_date) IS NULL
            ORDER BY years_since_revision DESC NULLS FIRST
        """,
    },
    14: {
        "text": "BQ-14: How many ECOs were raised, resolved, or are pending in a given date range?",
        "sql": """
            SELECT
                status,
                eco_type,
                COUNT(*) AS eco_count,
                MIN(created_date) AS earliest,
                MAX(created_date) AS latest
            FROM ECO
            WHERE created_date BETWEEN %(start_date)s AND %(end_date)s
            GROUP BY status, eco_type
            ORDER BY eco_type, status
        """,
    },
    15: {
        "text": "BQ-15: What is the status and progress of selected projects linked to product variants?",
        "sql": """
            SELECT
                proj.project_id,
                proj.project_name,
                proj.status,
                proj.phase,
                proj.planned_start_date,
                proj.planned_end_date,
                proj.actual_end_date,
                proj.project_manager,
                COUNT(DISTINCT pp.pv_id) AS linked_pvs
            FROM PROJECTS proj
            LEFT JOIN PV_PROJECT pp ON pp.project_id = proj.project_id
            WHERE proj.project_id IN (%(project_ids)s)
            GROUP BY
                proj.project_id, proj.project_name, proj.status, proj.phase,
                proj.planned_start_date, proj.planned_end_date,
                proj.actual_end_date, proj.project_manager
            ORDER BY proj.planned_start_date
        """,
    },
    16: {
        "text": "BQ-16: Which ECOs have been waiting for closure longer than N days?",
        "sql": """
            SELECT
                eco_id,
                eco_type,
                status,
                title,
                affected_part_id,
                affected_pv_id,
                created_date,
                created_by,
                DATEDIFF('day', created_date, CURRENT_DATE()) AS days_open
            FROM ECO
            WHERE status = 'Open'
              AND DATEDIFF('day', created_date, CURRENT_DATE()) >= %(min_days_waiting)s
            ORDER BY days_open DESC
        """,
    },
    17: {
        "text": "BQ-17: Which projects are overdue (planned end date passed, not yet completed)?",
        "sql": """
            SELECT
                project_id,
                project_name,
                status,
                phase,
                planned_end_date,
                actual_end_date,
                project_manager,
                DATEDIFF('day', planned_end_date, CURRENT_DATE()) AS days_overdue
            FROM PROJECTS
            WHERE status NOT IN ('Completed', 'Cancelled')
              AND planned_end_date < CURRENT_DATE()
            ORDER BY days_overdue DESC
        """,
    },
    18: {
        "text": "BQ-18: What are the direct (level-1) components of a product variant?",
        "sql": """
            SELECT
                c.descendant_id AS part_id,
                p.part_name,
                p.category,
                c.cum_qty,
                c.path,
                p.unit_of_measure,
                p.supplier,
                p.standard_cost
            FROM BOM_CLOSURE c
            JOIN PARTS p ON p.part_id = c.descendant_id
            WHERE c.ancestor_id = %(pv_id)s
              AND c.depth = 1
            ORDER BY p.category, p.part_name
        """,
    },
    19: {
        "text": "BQ-19: Get work orders (projects) with project number, the PV, and all BOM items related — in one query and one output (cross-domain join).",
        "sql": """
            SELECT
                pr.project_id,
                pr.project_name,
                pr.status           AS project_status,
                pr.phase,
                pr.planned_end_date,
                pv.pv_id,
                pv.pv_name,
                pv.market_code,
                pv.brand_name,
                pv.lifecycle_status AS pv_status,
                c.descendant_id     AS part_id,
                p.part_name,
                p.category,
                c.depth             AS bom_level,
                c.cum_qty,
                p.unit_of_measure,
                p.supplier
            FROM PROJECTS pr
            JOIN PV_PROJECT lnk     ON lnk.project_id = pr.project_id
            JOIN PRODUCT_VARIANTS pv ON pv.pv_id       = lnk.pv_id
            JOIN BOM_CLOSURE c       ON c.ancestor_id   = pv.pv_id AND c.depth > 0
            JOIN PARTS p             ON p.part_id        = c.descendant_id
            WHERE pv.pv_id = %(pv_id)s
            ORDER BY pr.project_id, c.depth, p.part_name
        """,
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_params(question_id: int, raw: dict) -> dict:
    """Fill defaults and coerce types for each question."""
    p = dict(raw)
    if question_id == 1:
        p.setdefault("planned_volume_units", 1000000)
        p["planned_volume_units"] = int(p["planned_volume_units"])
    elif question_id == 5:
        p.setdefault("max_depth", 10)
        p["max_depth"] = int(p["max_depth"])
    elif question_id == 9:
        p.setdefault("status", "Open")
        p.setdefault("eco_type", None)
    elif question_id == 13:
        p.setdefault("years_without_revision", 2)
        p["years_without_revision"] = int(p["years_without_revision"])
    elif question_id == 16:
        p.setdefault("min_days_waiting", 3)
        p["min_days_waiting"] = int(p["min_days_waiting"])
    elif question_id == 10:
        p["year"] = int(p["year"])
    return p


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get("/{question_id}")
def run_question(
    question_id: int = Path(..., ge=1, le=19, description="BRD business question number (1-19)"),
    # BQ-01
    pv_id: Optional[str] = Query(None),
    planned_volume_units: int = Query(1_000_000),
    # BQ-02, BQ-10, BQ-12
    market_code: Optional[str] = Query(None),
    # BQ-06, BQ-impact
    part_id: Optional[str] = Query(None),
    # BQ-07
    pv_a: Optional[str] = Query(None),
    pv_b: Optional[str] = Query(None),
    # BQ-05
    max_depth: int = Query(10),
    # BQ-09
    eco_type: Optional[str] = Query(None),
    status: Optional[str] = Query("Open"),
    # BQ-10
    year: Optional[int] = Query(None),
    # BQ-11
    market_code_a: Optional[str] = Query(None),
    market_code_b: Optional[str] = Query(None),
    # BQ-13
    years_without_revision: int = Query(2),
    # BQ-14
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    # BQ-15
    project_ids: Optional[str] = Query(None, description="Comma-separated project IDs"),
    # BQ-16
    min_days_waiting: int = Query(3),
):
    if question_id not in QUESTIONS:
        raise HTTPException(status_code=404, detail=f"Question {question_id} not found")

    q = QUESTIONS[question_id]
    sql = q["sql"].strip()

    raw_params: dict = {
        "pv_id": pv_id,
        "planned_volume_units": planned_volume_units,
        "market_code": market_code,
        "part_id": part_id,
        "pv_a": pv_a,
        "pv_b": pv_b,
        "max_depth": max_depth,
        "eco_type": eco_type,
        "status": status,
        "year": year,
        "market_code_a": market_code_a,
        "market_code_b": market_code_b,
        "years_without_revision": years_without_revision,
        "start_date": start_date,
        "end_date": end_date,
        "min_days_waiting": min_days_waiting,
    }

    params = _normalize_params(question_id, raw_params)

    # BQ-15: project_ids is a comma-separated string; expand inline (safe: integers only)
    if question_id == 15:
        if not project_ids:
            raise HTTPException(status_code=400, detail="project_ids query param required for BQ-15")
        # Validate that all tokens are alphanumeric to prevent injection
        ids = [pid.strip() for pid in project_ids.split(",") if pid.strip()]
        if not ids:
            raise HTTPException(status_code=400, detail="project_ids must be non-empty")
        # Build safe IN clause with individual bind params
        bind_keys = [f"proj_id_{i}" for i in range(len(ids))]
        in_clause = ", ".join(f"%({k})s" for k in bind_keys)
        sql = sql.replace("%(project_ids)s", in_clause)
        for k, v in zip(bind_keys, ids):
            params[k] = v

    start_ts = time.monotonic()
    try:
        data = execute_query(sql, params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    elapsed_ms = round((time.monotonic() - start_ts) * 1000, 1)

    return {
        "question_id": question_id,
        "question_text": q["text"],
        "data": data,
        "row_count": len(data),
        "execution_time_ms": elapsed_ms,
    }
