from fastapi import APIRouter, Query

from snowflake_client import execute_query

router = APIRouter()


@router.get("/bom")
def compare_bom(
    pv_a: str = Query(..., description="First Product Variant ID"),
    pv_b: str = Query(..., description="Second Product Variant ID"),
):
    # Parts only in PV_A
    sql_only_a = """
        SELECT
            a.descendant_id AS part_id,
            p.part_name,
            p.category,
            a.depth,
            a.cum_qty AS qty_a,
            p.standard_cost
        FROM BOM_CLOSURE a
        JOIN PARTS p ON p.part_id = a.descendant_id
        LEFT JOIN BOM_CLOSURE b
            ON b.descendant_id = a.descendant_id
           AND b.ancestor_id = %(pv_b)s
           AND b.depth > 0
        WHERE a.ancestor_id = %(pv_a)s
          AND a.depth > 0
          AND b.descendant_id IS NULL
        ORDER BY a.depth, a.descendant_id
    """

    # Parts only in PV_B
    sql_only_b = """
        SELECT
            b.descendant_id AS part_id,
            p.part_name,
            p.category,
            b.depth,
            b.cum_qty AS qty_b,
            p.standard_cost
        FROM BOM_CLOSURE b
        JOIN PARTS p ON p.part_id = b.descendant_id
        LEFT JOIN BOM_CLOSURE a
            ON a.descendant_id = b.descendant_id
           AND a.ancestor_id = %(pv_a)s
           AND a.depth > 0
        WHERE b.ancestor_id = %(pv_b)s
          AND b.depth > 0
          AND a.descendant_id IS NULL
        ORDER BY b.depth, b.descendant_id
    """

    # Parts in both
    sql_both = """
        SELECT
            a.descendant_id AS part_id,
            p.part_name,
            p.category,
            a.depth AS depth_a,
            b.depth AS depth_b,
            a.cum_qty AS qty_a,
            b.cum_qty AS qty_b,
            (b.cum_qty - a.cum_qty) AS qty_diff,
            p.standard_cost
        FROM BOM_CLOSURE a
        JOIN PARTS p ON p.part_id = a.descendant_id
        JOIN BOM_CLOSURE b
            ON b.descendant_id = a.descendant_id
           AND b.ancestor_id = %(pv_b)s
           AND b.depth > 0
        WHERE a.ancestor_id = %(pv_a)s
          AND a.depth > 0
        ORDER BY a.descendant_id
    """

    params = {"pv_a": pv_a, "pv_b": pv_b}
    only_a = execute_query(sql_only_a, params)
    only_b = execute_query(sql_only_b, params)
    in_both = execute_query(sql_both, params)

    qty_diffs = [
        r for r in in_both
        if (r.get("QTY_DIFF") or r.get("qty_diff") or 0) != 0
    ]

    return {
        "only_in_a": only_a,
        "only_in_b": only_b,
        "in_both": in_both,
        "summary": {
            "common_count":   len(in_both),
            "only_a_count":   len(only_a),
            "only_b_count":   len(only_b),
            "qty_diff_count": len(qty_diffs),
        },
    }
