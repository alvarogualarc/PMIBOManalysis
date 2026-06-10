from typing import Optional
from collections import defaultdict

from fastapi import APIRouter, Query, HTTPException

from snowflake_client import execute_query

router = APIRouter()


def _build_tree(rows: list[dict]) -> list[dict]:
    """Build nested tree from flat BOM_CLOSURE rows using the path column."""
    # path format: 'ancestor_id/child_id/grandchild_id/...'
    nodes: dict[str, dict] = {}
    root_ids: list[str] = []

    # First pass: create all node objects
    for row in rows:
        node_id = str(row.get("DESCENDANT_ID") or row.get("descendant_id"))
        nodes[node_id] = {
            "id": node_id,
            "data": {
                "label": row.get("PART_NAME") or row.get("part_name"),
                "category": row.get("CATEGORY") or row.get("category"),
                "cum_qty": row.get("CUM_QTY") or row.get("cum_qty"),
                "depth": row.get("DEPTH") or row.get("depth"),
                "unit_of_measure": row.get("UNIT_OF_MEASURE") or row.get("unit_of_measure"),
                "supplier": row.get("SUPPLIER") or row.get("supplier"),
                "standard_cost": row.get("STANDARD_COST") or row.get("standard_cost"),
                "path": row.get("PATH") or row.get("path"),
            },
            "children": [],
        }

    # Second pass: wire parent -> child using path segments
    children_assigned: set[str] = set()
    for row in rows:
        path_raw = row.get("PATH") or row.get("path") or ""
        segments = [s for s in path_raw.split("/") if s]
        node_id = str(row.get("DESCENDANT_ID") or row.get("descendant_id"))
        if len(segments) >= 2:
            parent_id = str(segments[-2])
            if parent_id in nodes:
                nodes[parent_id]["children"].append(nodes[node_id])
                children_assigned.add(node_id)

    # Roots are nodes not assigned as children
    for node_id, node in nodes.items():
        if node_id not in children_assigned:
            root_ids.append(node_id)

    return [nodes[rid] for rid in root_ids if rid in nodes]


@router.get("/explode")
def explode_bom(
    pv_id: str = Query(..., description="Product Variant ID"),
    max_depth: int = Query(10, ge=1, le=20),
):
    sql = """
        -- Include the PV root (depth=0) so the tree has a single connected root
        SELECT
            c.descendant_id,
            COALESCE(d.part_name, pv.pv_name, c.descendant_id) AS part_name,
            COALESCE(d.category, 'Product Variant')             AS category,
            c.depth,
            c.path,
            c.cum_qty,
            COALESCE(d.unit_of_measure, 'pcs')                  AS unit_of_measure,
            COALESCE(d.supplier, '')                             AS supplier,
            COALESCE(d.standard_cost, 0)                        AS standard_cost
        FROM BOM_CLOSURE c
        LEFT JOIN PARTS d              ON d.part_id  = c.descendant_id
        LEFT JOIN PRODUCT_VARIANTS pv  ON pv.pv_id   = c.descendant_id
        WHERE c.ancestor_id = %(pv_id)s
          AND c.depth <= %(max_depth)s
        ORDER BY c.depth, c.descendant_id
    """
    rows = execute_query(sql, {"pv_id": pv_id, "max_depth": max_depth})

    if not rows:
        return {"table_data": [], "tree_data": [], "stats": {}}

    categories: set[str] = set()
    max_d = 0
    total_cost = 0.0

    for r in rows:
        cat = r.get("CATEGORY") or r.get("category")
        if cat:
            categories.add(cat)
        d = r.get("DEPTH") or r.get("depth") or 0
        if d > max_d:
            max_d = d
        cost = r.get("STANDARD_COST") or r.get("standard_cost") or 0
        qty = r.get("CUM_QTY") or r.get("cum_qty") or 0
        try:
            total_cost += float(cost) * float(qty)
        except (TypeError, ValueError):
            pass

    stats = {
        "total_components": len(rows),
        "unique_categories": len(categories),
        "max_depth": max_d,
        "total_cost_estimate": round(total_cost, 4),
    }

    tree_data = _build_tree(rows)

    return {"table_data": rows, "tree_data": tree_data, "stats": stats}


@router.get("/where-used")
def where_used(part_id: str = Query(..., description="Part ID to trace upward")):
    sql = """
        SELECT
            c.ancestor_id,
            COALESCE(pv.pv_name, p.part_name, c.ancestor_id)       AS ancestor_name,
            CASE WHEN pv.pv_id IS NOT NULL THEN 'Product Variant'
                 ELSE COALESCE(p.category, 'Component') END         AS ancestor_type,
            CASE WHEN pv.pv_id IS NOT NULL THEN TRUE
                 ELSE FALSE END                                      AS is_finished_pv,
            pv.brand_name,
            pv.market_code,
            pv.lifecycle_status,
            p.category                                               AS part_category,
            p.supplier,
            c.depth                                                  AS absolute_depth,
            c.depth || ' of ' || pv_h.tree_height                   AS level_display,
            pv_h.tree_height - c.depth                              AS levels_from_leaf,
            ROUND(c.depth::FLOAT / pv_h.tree_height * 100, 0)::INT  AS depth_pct,
            CASE
                WHEN c.depth = 1                                THEN 'DIRECT'
                WHEN (pv_h.tree_height - c.depth) = 0          THEN 'RAW MATERIAL'
                WHEN c.depth::FLOAT / pv_h.tree_height <= 0.40 THEN 'NEAR TOP'
                WHEN c.depth::FLOAT / pv_h.tree_height <= 0.70 THEN 'MID LEVEL'
                ELSE                                                 'DEEP'
            END                                                      AS impact_tier,
            c.cum_qty,
            c.path
        FROM BOM_CLOSURE c
        LEFT JOIN PRODUCT_VARIANTS pv ON pv.pv_id  = c.ancestor_id
        LEFT JOIN PARTS p             ON p.part_id = c.ancestor_id
        JOIN (
            SELECT ancestor_id, MAX(depth) AS tree_height
            FROM BOM_CLOSURE WHERE depth > 0
            GROUP BY ancestor_id
        ) pv_h ON pv_h.ancestor_id = c.ancestor_id
        WHERE c.descendant_id = %(part_id)s
          AND c.depth > 0
        ORDER BY is_finished_pv, c.depth, ancestor_name
    """
    rows = execute_query(sql, {"part_id": part_id})

    markets: set[str] = set()
    brands: set[str] = set()
    intermediates: list = []
    finished_pvs: list = []

    for r in rows:
        mc = r.get("market_code")
        bn = r.get("brand_name")
        if mc: markets.add(mc)
        if bn: brands.add(bn)
        if r.get("is_finished_pv"):
            finished_pvs.append(r)
        else:
            intermediates.append(r)

    return {
        "intermediates":       intermediates,
        "finished_pvs":        finished_pvs,
        "data":                rows,           # kept for backward compat
        "total_pvs_affected":  len(finished_pvs),
        "total_impacted":      len(rows),
        "markets_affected":    sorted(markets),
        "brands_affected":     sorted(brands),
    }


@router.get("/revisions")
def bom_revisions(pv_id: str = Query(..., description="Product Variant ID")):
    sql = """
        SELECT
            br.pv_id,
            br.part_id,
            p.part_name,
            br.old_qty,
            br.new_qty,
            br.revision_date,
            br.revised_by,
            br.change_reason
        FROM BOM_REVISIONS br
        JOIN PARTS p ON p.part_id = br.part_id
        WHERE br.pv_id = %(pv_id)s
        ORDER BY br.revision_date DESC
    """
    rows = execute_query(sql, {"pv_id": pv_id})
    return {"pv_id": pv_id, "revisions": rows, "total": len(rows)}
