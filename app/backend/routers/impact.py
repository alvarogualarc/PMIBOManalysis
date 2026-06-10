from fastapi import APIRouter, Query

from snowflake_client import execute_query

router = APIRouter()


@router.get("/part")
def part_impact(part_id: str = Query(..., description="Part ID to analyse")):
    # 1. Affected PVs
    sql_pvs = """
        SELECT
            pv.pv_id,
            pv.pv_name,
            pv.brand_name,
            pv.market_code,
            pv.pc_code,
            pv.lifecycle_status
        FROM PRODUCT_VARIANTS pv
        WHERE pv.pv_id IN (
            SELECT ancestor_id
            FROM BOM_CLOSURE
            WHERE descendant_id = %(part_id)s
              AND depth > 0
        )
        ORDER BY pv.market_code, pv.brand_name
    """

    # 2. Open ECOs on this part
    sql_ecos = """
        SELECT
            eco_id,
            eco_type,
            status,
            title,
            affected_part_id,
            affected_pv_id,
            created_date,
            closed_date,
            created_by
        FROM ECO
        WHERE affected_part_id = %(part_id)s
          AND status = 'Open'
        ORDER BY created_date DESC
    """

    # 3. Markets summary
    sql_markets = """
        SELECT
            pv.market_code,
            COUNT(DISTINCT pv.pv_id) AS pv_count
        FROM PRODUCT_VARIANTS pv
        WHERE pv.pv_id IN (
            SELECT ancestor_id
            FROM BOM_CLOSURE
            WHERE descendant_id = %(part_id)s
              AND depth > 0
        )
        GROUP BY pv.market_code
        ORDER BY pv_count DESC
    """

    pvs = execute_query(sql_pvs, {"part_id": part_id})
    ecos = execute_query(sql_ecos, {"part_id": part_id})
    markets = execute_query(sql_markets, {"part_id": part_id})

    brands: set[str] = set()
    for r in pvs:
        bn = r.get("BRAND_NAME") or r.get("brand_name")
        if bn:
            brands.add(bn)

    return {
        "affected_pvs": pvs,
        "open_ecos": ecos,
        "markets_breakdown": markets,
        "summary": {
            "total_pvs": len(pvs),
            "markets_count": len(markets),
            "open_ecos_count": len(ecos),
            "brands_affected": sorted(brands),
        },
    }
