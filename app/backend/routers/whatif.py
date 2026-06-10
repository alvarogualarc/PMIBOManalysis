from fastapi import APIRouter, Query
from snowflake_client import execute_query

router = APIRouter()


@router.get("/simulate")
def simulate(
    old_component: str = Query(..., description="Part ID to replace"),
    new_component: str = Query(..., description="Replacement Part ID"),
):
    # Affected PVs and their simulated paths
    sql_sim = """
        SELECT
            pv.pv_id,
            pv.pv_name,
            pv.brand_name,
            pv.market_code,
            pv.lifecycle_status,
            c.depth,
            c.cum_qty,
            c.path                                                     AS original_path,
            REPLACE(c.path, %(old_component)s, %(new_component)s)      AS simulated_path,
            %(old_component)s                                          AS original_component,
            %(new_component)s                                          AS replacement_component
        FROM BOM_CLOSURE c
        JOIN PRODUCT_VARIANTS pv ON pv.pv_id = c.ancestor_id
        WHERE c.descendant_id = %(old_component)s
          AND c.depth > 0
        ORDER BY pv.market_code, pv.brand_name, pv.pv_name
    """
    rows = execute_query(sql_sim, {
        "old_component": old_component,
        "new_component": new_component,
    })

    # Old component details
    old_part = execute_query(
        "SELECT part_id, part_name, category, unit_of_measure, supplier, standard_cost FROM PARTS WHERE part_id = %(p)s",
        {"p": old_component},
    )
    new_part = execute_query(
        "SELECT part_id, part_name, category, unit_of_measure, supplier, standard_cost FROM PARTS WHERE part_id = %(p)s",
        {"p": new_component},
    )

    markets: set[str] = set()
    brands: set[str] = set()
    for r in rows:
        mc = r.get("market_code")
        bn = r.get("brand_name")
        if mc: markets.add(mc)
        if bn: brands.add(bn)

    return {
        "affected_pvs":       rows,
        "old_part":           old_part[0] if old_part else {},
        "new_part":           new_part[0] if new_part else {},
        "summary": {
            "total_pvs":       len(rows),
            "markets_count":   len(markets),
            "brands_count":    len(brands),
            "markets":         sorted(markets),
            "brands":          sorted(brands),
        },
    }


@router.get("/scenarios")
def list_scenarios():
    return execute_query(
        "SELECT scenario_id, old_component_id, new_component_id, created_by, created_at FROM WHAT_IF_SCENARIOS ORDER BY created_at DESC"
    )


@router.post("/scenarios")
def save_scenario(
    scenario_id: str = Query(...),
    old_component: str = Query(...),
    new_component: str = Query(...),
):
    execute_query(
        """
        INSERT INTO WHAT_IF_SCENARIOS (scenario_id, old_component_id, new_component_id, created_by)
        VALUES (%(sid)s, %(old)s, %(new)s, 'demo_user')
        """,
        {"sid": scenario_id, "old": old_component, "new": new_component},
    )
    return {"status": "saved", "scenario_id": scenario_id}
