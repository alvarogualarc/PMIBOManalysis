from fastapi import APIRouter, Query
from typing import Optional
from snowflake_client import execute_query

router = APIRouter()


@router.get("/schema")
def attribute_schema(category: str = Query(..., description="Material category, e.g. 'Tobacco Leaf'")):
    """
    Returns the attribute schema for a given material category:
    attribute names, units, whether numeric, and available discrete values.
    Used by the frontend to render the correct filter control per attribute.
    """
    rows = execute_query("""
        SELECT
            attribute_name,
            attribute_unit,
            distinct_values,
            sample_values,
            is_numeric
        FROM V_ATTRIBUTE_SCHEMA
        WHERE part_category = %(category)s
        ORDER BY attribute_name
    """, {"category": category})
    return rows


@router.get("/categories")
def attribute_categories():
    """Returns all material categories that have attributes defined."""
    rows = execute_query("""
        SELECT DISTINCT part_category AS category, COUNT(DISTINCT part_id) AS parts_with_attributes
        FROM PART_ATTRIBUTES
        GROUP BY part_category
        ORDER BY part_category
    """)
    return rows


@router.get("/filter")
def filter_materials(
    category: Optional[str] = Query(None, description="Filter by category"),
    filters: Optional[str] = Query(None, description="JSON string of {attr_name: value} filters"),
    include_bom_stats: bool = Query(True, description="Include closure table BOM usage stats"),
):
    """
    Filter materials by dynamic attributes.
    filters param is JSON: {"leaf_grade":"A","origin_country":"USA"}
    Returns matching parts with their full attribute JSON and optional BOM usage stats.
    """
    import json

    filter_dict: dict = {}
    if filters:
        try:
            filter_dict = json.loads(filters)
        except Exception:
            filter_dict = {}

    # Build WHERE clause for category
    where_clauses = ["1=1"]
    params: dict = {}

    if category:
        where_clauses.append("p.category = %(category)s")
        params["category"] = category

    # Each attribute filter becomes a join condition on the EAV table
    # We use the VARIANT view for clean dot-notation filtering
    attr_joins = ""
    for i, (attr_name, attr_value) in enumerate(filter_dict.items()):
        alias = f"af{i}"
        attr_joins += f"""
            JOIN PART_ATTRIBUTES {alias}
                ON {alias}.part_id = p.part_id
                AND {alias}.attribute_name = %(attr_name_{i})s
                AND {alias}.attribute_value = %(attr_value_{i})s
        """
        params[f"attr_name_{i}"] = attr_name
        params[f"attr_value_{i}"] = str(attr_value)

    bom_stats_join = ""
    bom_stats_cols = ""
    if include_bom_stats:
        bom_stats_join = """
            LEFT JOIN (
                SELECT descendant_id, COUNT(DISTINCT ancestor_id) AS used_in_pvs
                FROM BOM_CLOSURE WHERE depth > 0
                GROUP BY descendant_id
            ) bom ON bom.descendant_id = p.part_id
        """
        bom_stats_cols = ", COALESCE(bom.used_in_pvs, 0) AS used_in_pvs"

    where = " AND ".join(where_clauses)

    sql = f"""
        SELECT
            p.part_id,
            p.part_name,
            p.category,
            p.unit_of_measure,
            p.supplier,
            p.standard_cost,
            v.attributes
            {bom_stats_cols}
        FROM DIM_PARTS p
        JOIN V_PART_ATTRIBUTES_JSON v ON v.part_id = p.part_id
        {attr_joins}
        {bom_stats_join}
        WHERE {where}
        ORDER BY p.part_name
    """

    rows = execute_query(sql, params)

    # Convert VARIANT string to dict for cleaner JSON response
    for row in rows:
        attr_raw = row.get("attributes")
        if isinstance(attr_raw, str):
            try:
                import json as _json
                row["attributes"] = _json.loads(attr_raw)
            except Exception:
                pass

    return {
        "data": rows,
        "count": len(rows),
        "category": category,
        "filters_applied": filter_dict,
    }


@router.get("/part/{part_id}")
def get_part_attributes(part_id: str):
    """Get all attributes for a specific part."""
    rows = execute_query("""
        SELECT attribute_name, attribute_value, attribute_unit
        FROM PART_ATTRIBUTES
        WHERE part_id = %(part_id)s
        ORDER BY attribute_name
    """, {"part_id": part_id})
    return {"part_id": part_id, "attributes": rows}
