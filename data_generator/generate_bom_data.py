#!/usr/bin/env python3
"""
PMI CLIPP BOM Analytics POC - Data Generator
Generates production-realistic BOM data and loads to Snowflake.

Usage:
    python generate_bom_data.py --profile PRODUCTION --account <account> --user <user> --password <password>
    python generate_bom_data.py --profile MEDIUM --account <account> --user <user> --warehouse BOM_WH
"""

import argparse
import time
from datetime import datetime, timedelta, date
import sys

import numpy as np
import pandas as pd
from tqdm import tqdm

try:
    import snowflake.connector
    from snowflake.connector.pandas_tools import write_pandas
    HAS_SNOWFLAKE = True
except ImportError:
    HAS_SNOWFLAKE = False
    print("Warning: snowflake-connector-python not installed. Snowflake loading disabled.")

from bom_config import (
    SCALE_PROFILES, MARKETS, PRODUCTION_CENTERS,
    COMBUSTIBLE_BRANDS, HTU_BRANDS,
    COMBUSTIBLE_VARIANTS, COMBUSTIBLE_SIZES,
    HEETS_VARIANTS, TEREA_VARIANTS,
    LIFECYCLE_STATUSES, LIFECYCLE_WEIGHTS,
)

# Global RNG — seed 42 ensures full reproducibility
RNG = np.random.default_rng(42)

# Brand → subset of canonical variants that exist as global products
BRAND_VARIANT_MAP = {
    'Marlboro':      ['Red', 'Gold', 'Blue', 'Silver', 'Compact', 'Ice Blast', 'Summer Splash'],
    'Parliament':    ['Blue', 'Silver', 'One'],
    'Chesterfield':  ['Red', 'Blue', 'Silver', 'Gold'],
    'L&M':           ['Red', 'Blue', 'Silver', 'Menthol'],
    'Philip Morris': ['Red', 'Blue', 'Silver'],
    'Bond Street':   ['Red', 'Blue'],
}

# Virginia leaf assigned to each brand (determines 60%+ VLAF_A sharing in closure)
BRAND_VLAF_MAP = {
    'Marlboro':      'VLAF_A',  # Marlboro + Parliament + Chesterfield + PM = majority → VLAF_A in 60%+
    'Parliament':    'VLAF_A',
    'Chesterfield':  'VLAF_A',
    'L&M':           'VLAF_B',
    'Philip Morris': 'VLAF_A',
    'Bond Street':   'VLAF_C',
}

SUPPLIERS = [
    'Universal Leaf Tobacco Co',
    'Standard Industries Inc',
    'Schweitzer-Mauduit International',
    'Filtrona plc',
    'Tann Group AG',
    'Mondi Group',
    'Smurfit Kappa',
]

PMI_USERS = [
    'j.kowalski@pmi.com', 'a.mueller@pmi.com', 'm.tanaka@pmi.com',
    's.dupont@pmi.com',   'r.bianchi@pmi.com', 'k.yamamoto@pmi.com',
    'l.schmidt@pmi.com',  'p.martin@pmi.com',
]

ECO_CHANGE_REASONS = [
    'Supplier qualification change', 'Regulatory compliance requirement',
    'Cost optimisation initiative',  'Raw material specification update',
    'Quality improvement programme', 'Product reformulation',
    'Packaging redesign',            'Formula optimisation',
]

PROJECT_MANAGERS = [
    'Michael Chen', 'Emma Schmidt', 'Tomasz Kowalski', 'Marie Dupont',
    'Roberto Bianchi', 'Keiko Yamamoto', 'Lars Eriksson', 'Priya Sharma',
]

_GENERIC_EFF_FROM = '2018-01-01'
_GENERIC_EFF_TO   = '9999-12-31'


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description='PMI CLIPP BOM Data Generator')
    p.add_argument('--profile',   choices=['SMALL', 'MEDIUM', 'PRODUCTION'], default='SMALL')
    p.add_argument('--account',   help='Snowflake account identifier')
    p.add_argument('--user',      help='Snowflake username')
    p.add_argument('--password',  help='Snowflake password')
    p.add_argument('--warehouse', default='BOM_WH',         help='Snowflake warehouse')
    p.add_argument('--database',  default='PMI_CLIPP_POC',  help='Snowflake database')
    p.add_argument('--schema',    default='BOM_ANALYTICS',  help='Snowflake schema')
    p.add_argument('--no-load',   action='store_true',       help='Generate only, skip Snowflake load')
    return p.parse_args()


def get_snowflake_connection(args):
    if not HAS_SNOWFLAKE:
        raise RuntimeError('snowflake-connector-python not installed')
    return snowflake.connector.connect(
        account=args.account,
        user=args.user,
        password=args.password,
        warehouse=args.warehouse,
        database=args.database,
        schema=args.schema,
    )


# ---------------------------------------------------------------------------
# Dimension generators
# ---------------------------------------------------------------------------

def generate_markets(config):
    return pd.DataFrame(MARKETS)


def generate_production_centers(config):
    return pd.DataFrame(PRODUCTION_CENTERS)


def generate_brands(config):
    rows = []
    premium_comb = {'Marlboro', 'Parliament'}
    for brand in COMBUSTIBLE_BRANDS:
        rows.append({
            'brand_id':   f'BR_{len(rows)+1:03d}',
            'brand_name': brand,
            'category':   'COMBUSTIBLE',
            'is_premium': brand in premium_comb,
        })
    for brand in HTU_BRANDS:
        rows.append({
            'brand_id':   f'BR_{len(rows)+1:03d}',
            'brand_name': brand,
            'category':   'HTU',
            'is_premium': True,
        })
    return pd.DataFrame(rows)


def generate_global_products(config):
    """~40 global products: brand × variant combos for combustible, all HTU flavors."""
    rows, num = [], 1
    for brand, variants in BRAND_VARIANT_MAP.items():
        for variant in variants:
            rows.append({
                'gp_id':       f'GP_{num:03d}',
                'gp_name':     f'{brand} {variant}',
                'brand_name':  brand,
                'category':    'COMBUSTIBLE',
                'is_sellable': True,
                'variant':     variant,
            })
            num += 1
    for variant in HEETS_VARIANTS:
        rows.append({'gp_id': f'GP_{num:03d}', 'gp_name': f'HEETS {variant}',
                     'brand_name': 'HEETS', 'category': 'HTU',
                     'is_sellable': True, 'variant': variant})
        num += 1
    for variant in TEREA_VARIANTS:
        rows.append({'gp_id': f'GP_{num:03d}', 'gp_name': f'TEREA {variant}',
                     'brand_name': 'TEREA', 'category': 'HTU',
                     'is_sellable': True, 'variant': variant})
        num += 1
    return pd.DataFrame(rows)


def generate_product_variants(config, global_products, markets, production_centers):
    """Generate n_combustible_pvs + n_htu_pvs PVs with realistic attributes."""
    n_comb  = config['n_combustible_pvs']
    n_htu   = config['n_htu_pvs']
    n_total = n_comb + n_htu

    # Market → valid PCs
    mkt_to_pcs = {}
    for _, pc in production_centers.iterrows():
        mkt_to_pcs.setdefault(pc['market_code'], []).append(pc['pc_code'])

    mkt_codes  = markets['market_code'].tolist()
    mkt_names  = dict(zip(markets['market_code'], markets['market_name']))
    pc_names   = dict(zip(production_centers['pc_code'], production_centers['pc_name']))

    def _make_rows(gps_df, n, category):
        gp_idx    = RNG.integers(0, len(gps_df), size=n)
        sel_gps   = gps_df.iloc[gp_idx].reset_index(drop=True)
        mkt_idx   = RNG.integers(0, len(mkt_codes), size=n)
        pv_mkts   = [mkt_codes[i] for i in mkt_idx]
        pv_pcs    = [str(RNG.choice(mkt_to_pcs[mc])) for mc in pv_mkts]
        lifecycles = RNG.choice(LIFECYCLE_STATUSES, size=n, p=LIFECYCLE_WEIGHTS)

        start   = date(2018, 1, 1)
        end_rng = date(2024, 1, 1)
        day_range = (end_rng - start).days
        offsets   = RNG.integers(0, day_range, size=n)
        eff_froms = [start + timedelta(days=int(d)) for d in offsets]

        eff_tos = []
        for i, lc in enumerate(lifecycles):
            if lc == 'Obsolete':
                days_active = int(RNG.integers(180, 1461))
                obs = eff_froms[i] + timedelta(days=days_active)
                eff_tos.append(min(obs, date(2024, 12, 31)).strftime('%Y-%m-%d'))
            else:
                eff_tos.append('9999-12-31')

        rows = []
        for i in range(n):
            gp   = sel_gps.iloc[i]
            mc   = pv_mkts[i]
            pc   = pv_pcs[i]
            size = str(RNG.choice(COMBUSTIBLE_SIZES)) if category == 'COMBUSTIBLE' else 'HTU 20s'
            pv_name = f"{gp['gp_name']} {size} {mkt_names[mc]} {pc_names[pc]}"
            rows.append({
                'gp_id':            gp['gp_id'],
                'gp_name':          gp['gp_name'],
                'pv_name':          pv_name,
                'brand_name':       gp['brand_name'],
                'category':         category,
                'variant':          gp['variant'],
                'size':             size,
                'market_code':      mc,
                'pc_code':          pc,
                'lifecycle_status': lifecycles[i],
                'is_sellable':      True,
                'is_global':        bool(RNG.random() < 0.15),
                'eff_from':         eff_froms[i].strftime('%Y-%m-%d'),
                'eff_to':           eff_tos[i],
            })
        return rows

    comb_gps = global_products[global_products['category'] == 'COMBUSTIBLE']
    htu_gps  = global_products[global_products['category'] == 'HTU']
    all_rows = _make_rows(comb_gps, n_comb, 'COMBUSTIBLE') + _make_rows(htu_gps, n_htu, 'HTU')

    suffixes = RNG.integers(1, 20, size=n_total)
    for i, row in enumerate(all_rows):
        row['pv_id'] = f'FA{i+1:06d}.{suffixes[i]:02d}'

    return pd.DataFrame(all_rows)


# ---------------------------------------------------------------------------
# Parts generator (~490 parts, realistic sharing ratios)
# ---------------------------------------------------------------------------

def generate_parts(config):
    """
    Generate ~490 parts across 27 categories.
    Key affinity columns (used internally for BOM assignment):
      brand_affinity   – brand-specific parts (blends, filter assemblies, outer packs …)
      market_affinity  – market-specific parts (tax stamps, outer packs)
      variant_affinity – variant-specific parts (blends, tipping papers)
      flavor_affinity  – HTU flavor-specific parts (substrates, HTU packs)
    """
    parts = []
    leaf_sup = ['Universal Leaf Tobacco Co', 'Standard Industries Inc']

    def p(part_id, name, category, unit, cost_lo, cost_hi,
          supplier=None, brand=None, market=None, variant=None, flavor=None):
        parts.append({
            'part_id':          part_id,
            'part_name':        name,
            'category':         category,
            'description':      f'{category}: {name}',
            'unit_of_measure':  unit,
            'supplier':         supplier or str(RNG.choice(SUPPLIERS)),
            'standard_cost':    round(float(RNG.uniform(cost_lo, cost_hi)), 4),
            'brand_affinity':   brand,
            'market_affinity':  market,
            'variant_affinity': variant,
            'flavor_affinity':  flavor,
        })

    # ── Tobacco leaf ──────────────────────────────────────────────────────────
    for letter in 'ABCDEFGH':
        p(f'VLAF_{letter}', f'Virginia Leaf Grade {letter}',
          'Virginia Leaf', 'kg', 8.0, 15.0, supplier=leaf_sup[0 if letter < 'E' else 1])

    for letter in 'ABCDEF':
        p(f'BLAF_{letter}', f'Burley Leaf Grade {letter}',
          'Burley Leaf', 'kg', 6.0, 12.0, supplier=leaf_sup[ord(letter) % 2])

    for letter in 'ABCDEF':
        p(f'OLAF_{letter}', f'Oriental Leaf Grade {letter}',
          'Oriental Leaf', 'kg', 10.0, 18.0, supplier=leaf_sup[ord(letter) % 2])

    for i in range(1, 5):
        p(f'RECON_{i:03d}', f'Reconstituted Tobacco Sheet {i:03d}',
          'Reconstituted Sheet', 'kg', 4.0, 7.0)

    # ── Tobacco blends: 23 brand+variant specific + 22 generic = 45 ──────────
    for brand, variants in BRAND_VARIANT_MAP.items():
        bc = brand.upper().replace(' ', '').replace('&', '')[:8]
        for variant in variants:
            vc = variant.upper().replace(' ', '_')[:8]
            p(f'BLEND_{bc}_{vc}', f'{brand} {variant} Tobacco Blend',
              'Tobacco Blend', 'kg', 15.0, 35.0, brand=brand, variant=variant)

    for i in range(1, 23):
        p(f'BLEND_GEN_{i:03d}', f'Generic Tobacco Blend {i:03d}',
          'Tobacco Blend', 'kg', 10.0, 25.0)

    # ── Filter components ─────────────────────────────────────────────────────
    cat_sup = ['Filtrona plc', 'Celanese Corporation']
    for i in range(1, 9):
        p(f'CAT_{i:03d}', f'Cellulose Acetate Tow Type {i:03d}',
          'Cellulose Acetate Tow', 'kg', 5.0, 8.0, supplier=cat_sup[(i - 1) % 2])

    # 60 filter assemblies: ~10 per brand
    brands_60 = (COMBUSTIBLE_BRANDS * 10)[:60]
    for i, brand in enumerate(brands_60, 1):
        p(f'FASM_{i:03d}', f'{brand} Filter Assembly {i:03d}',
          'Filter Assembly', 'pcs', 0.02, 0.08, brand=brand, supplier='Filtrona plc')

    for i in range(1, 11):
        p(f'FPW_{i:03d}', f'Filter Plug Wrap {i:03d}',
          'Filter Plug Wrap', 'm', 0.001, 0.005,
          supplier='Schweitzer-Mauduit International')

    # ── Papers ────────────────────────────────────────────────────────────────
    # 20 cigarette papers — cycled across brands
    brands_20 = (COMBUSTIBLE_BRANDS * 4)[:20]
    for i, brand in enumerate(brands_20, 1):
        p(f'CPAP_{i:03d}', f'{brand} Cigarette Paper Grade {i:03d}',
          'Cigarette Paper', 'm', 0.002, 0.008, brand=brand,
          supplier='Schweitzer-Mauduit International')

    # 35 tipping papers: one per BRAND_VARIANT_MAP combo (23) + 12 generic
    for brand, variants in BRAND_VARIANT_MAP.items():
        bc = brand.upper().replace(' ', '').replace('&', '')[:6]
        for variant in variants:
            vc = variant.upper().replace(' ', '')[:6]
            p(f'TPAP_{bc}_{vc}', f'{brand} {variant} Tipping Paper',
              'Tipping Paper', 'm', 0.003, 0.012, brand=brand, variant=variant,
              supplier='Schweitzer-Mauduit International')

    for i in range(1, 13):
        p(f'TPAP_GEN_{i:03d}', f'Generic Tipping Paper Grade {i:03d}',
          'Tipping Paper', 'm', 0.003, 0.012)

    # 12 band papers (NEW)
    for i in range(1, 13):
        p(f'BPAP_{i:03d}', f'Cigarette Band Paper {i:03d}',
          'Band Paper', 'm', 0.001, 0.004,
          supplier='Schweitzer-Mauduit International')

    # ── Packaging materials ───────────────────────────────────────────────────
    # Inner foil: 6 brand-specific + 2 generic = 8
    for brand in COMBUSTIBLE_BRANDS:
        bc = brand.upper().replace(' ', '').replace('&', '')[:6]
        p(f'IFOIL_{bc}', f'{brand} Inner Foil',
          'Inner Foil', 'pcs', 0.005, 0.020, brand=brand, supplier='Mondi Group')
    p('IFOIL_GEN_001', 'Generic Inner Foil',  'Inner Foil', 'pcs', 0.005, 0.020)
    p('IFOIL_GEN_002', 'Premium Inner Foil',  'Inner Foil', 'pcs', 0.010, 0.025)

    # Inner frame: 6 brand-specific + 2 generic = 8
    for brand in COMBUSTIBLE_BRANDS:
        bc = brand.upper().replace(' ', '').replace('&', '')[:6]
        p(f'IFRAME_{bc}', f'{brand} Inner Frame',
          'Inner Frame', 'pcs', 0.003, 0.010, brand=brand, supplier='Smurfit Kappa')
    p('IFRAME_GEN_001', 'Generic Inner Frame',   'Inner Frame', 'pcs', 0.003, 0.010)
    p('IFRAME_GEN_002', 'Standard Inner Frame',  'Inner Frame', 'pcs', 0.003, 0.010)

    # Outer Pack 20s: 30 base (6 brands × 5 markets) + 20 premium (4 brands × 5 markets) + 20 deluxe = 70
    mkt_codes = [m['market_code'] for m in MARKETS]
    op20_count = 0
    for design_idx, (design_label, brands_subset) in enumerate([
        ('01', COMBUSTIBLE_BRANDS),
        ('02', COMBUSTIBLE_BRANDS[:4]),
        ('03', COMBUSTIBLE_BRANDS[:4]),
    ], 1):
        for brand in brands_subset:
            if op20_count >= 70:
                break
            bc = brand.upper().replace(' ', '').replace('&', '')[:6]
            for mkt in mkt_codes:
                if op20_count >= 70:
                    break
                p(f'OP20_{bc}_{mkt}_{design_label}',
                  f'{brand} Standard 20s Outer Pack {mkt} Design {design_idx}',
                  'Outer Pack 20s', 'pcs', 0.05, 0.20,
                  brand=brand, market=mkt, supplier='Smurfit Kappa')
                op20_count += 1

    # Outer Pack 10s: 4 brands × 5 markets (design 01) + 2 brands × 5 markets (design 02) = 30
    op10_count = 0
    for design_idx, brands_subset in enumerate([COMBUSTIBLE_BRANDS[:4], COMBUSTIBLE_BRANDS[:2]], 1):
        dl = f'{design_idx:02d}'
        for brand in brands_subset:
            if op10_count >= 30:
                break
            bc = brand.upper().replace(' ', '').replace('&', '')[:6]
            for mkt in mkt_codes:
                if op10_count >= 30:
                    break
                p(f'OP10_{bc}_{mkt}_{dl}',
                  f'{brand} Standard 10s Outer Pack {mkt} Design {design_idx}',
                  'Outer Pack 10s', 'pcs', 0.03, 0.12,
                  brand=brand, market=mkt, supplier='Smurfit Kappa')
                op10_count += 1

    # Tax stamps: 3 per market × 5 markets = 15
    for mkt in mkt_codes:
        for i in range(1, 4):
            p(f'TX{mkt}_{i:03d}', f'Tax Stamp {mkt} Design {i}',
              f'Tax Stamp {mkt}', 'pcs', 0.01, 0.05, market=mkt)

    # Carton: 15 parts (10 for 20s, 5 for 10s)
    for i in range(1, 16):
        size_label = '20s' if i <= 10 else '10s'
        p(f'CART_{i:03d}', f'Cigarette Carton {size_label} Type {i:03d}',
          'Carton', 'pcs', 0.08, 0.20)

    # Overwrap Film: 15 parts (NEW)
    for i in range(1, 16):
        p(f'OWRAP_{i:03d}', f'Polypropylene Overwrap Film {i:03d}',
          'Overwrap Film', 'm2', 0.002, 0.008, supplier='Mondi Group')

    # Adhesive: 8 parts (NEW)
    for i in range(1, 9):
        p(f'ADHES_{i:03d}', f'Packaging Seam Adhesive {i:03d}',
          'Adhesive', 'g', 0.01, 0.05)

    # Foil Laminate: 12 parts (NEW)
    for i in range(1, 13):
        p(f'FOILAM_{i:03d}', f'Foil Laminate Sheet {i:03d}',
          'Foil Laminate', 'm2', 0.01, 0.04, supplier='Mondi Group')

    # Casing Material: 15 parts — tobacco casing/flavouring (NEW)
    for i in range(1, 16):
        brand = COMBUSTIBLE_BRANDS[(i - 1) % len(COMBUSTIBLE_BRANDS)]
        p(f'CASING_{i:03d}', f'{brand} Tobacco Casing {i:03d}',
          'Casing Material', 'g', 0.05, 0.20, brand=brand)

    # ── HTU-specific ──────────────────────────────────────────────────────────
    # TEREA Tobacco Substrate: 20 parts (8 HEETS flavors + 8 TEREA flavors + 4 generic)
    for flavor in HEETS_VARIANTS:
        fc = flavor.upper().replace(' ', '_')[:10]
        p(f'TSUB_HEETS_{fc}', f'HEETS Tobacco Substrate {flavor}',
          'TEREA Tobacco Substrate', 'g', 0.28, 0.45, brand='HEETS', flavor=flavor)

    for flavor in TEREA_VARIANTS:
        fc = flavor.upper().replace(' ', '_')[:10]
        p(f'TSUB_TEREA_{fc}', f'TEREA Tobacco Substrate {flavor}',
          'TEREA Tobacco Substrate', 'g', 0.30, 0.50, brand='TEREA', flavor=flavor)

    for i in range(1, 5):
        p(f'TSUB_GEN_{i:03d}', f'Generic HTU Tobacco Substrate {i:03d}',
          'TEREA Tobacco Substrate', 'g', 0.28, 0.50)

    # Hollow Acetate Tube: 5
    for i in range(1, 6):
        p(f'HAT_{i:03d}', f'Hollow Acetate Tube {i:03d}',
          'Hollow Acetate Tube', 'pcs', 0.01, 0.04, supplier='Filtrona plc')

    # Cooling Film: 4
    for i in range(1, 5):
        p(f'CFILM_{i:03d}', f'Cooling Film {i:03d}',
          'Cooling Film', 'pcs', 0.02, 0.06)

    # Aerosol Former: 3
    for i in range(1, 4):
        p(f'AFORM_{i:03d}', f'Aerosol Former PG/VG Blend {i:03d}',
          'Aerosol Former', 'g', 0.05, 0.15)

    # HTU Wrapper Paper: 8
    for i in range(1, 9):
        p(f'HWRAP_{i:03d}', f'HTU Wrapper Paper {i:03d}',
          'HTU Wrapper Paper', 'm', 0.001, 0.005,
          supplier='Schweitzer-Mauduit International')

    # HTU Pack: 40 parts — brand + flavor + market specific
    hpack_count = 0
    for brand, flavors in [('HEETS', HEETS_VARIANTS), ('TEREA', TEREA_VARIANTS)]:
        for flavor in flavors[:4]:   # top 4 flavors per brand cover most volume
            fc = flavor.upper().replace(' ', '_')[:8]
            for mkt in mkt_codes:
                if hpack_count >= 40:
                    break
                p(f'HPACK_{brand[:4]}_{fc}_{mkt}',
                  f'{brand} {flavor} Pack {mkt}',
                  'HTU Pack', 'pcs', 0.10, 0.30,
                  brand=brand, flavor=flavor, market=mkt, supplier='Smurfit Kappa')
                hpack_count += 1
            if hpack_count >= 40:
                break
        if hpack_count >= 40:
            break

    df = pd.DataFrame(parts)
    print(f"  Generated {len(df):,} parts across {df['category'].nunique()} categories")
    return df


# ---------------------------------------------------------------------------
# BOM adjacency list  (~170 k–200 k rows at PRODUCTION)
# ---------------------------------------------------------------------------

def generate_bom_items(config, product_variants, parts):
    """
    Build realistic BOM adjacency list with proper component sharing.

    Structure per combustible PV (9 direct edges):
        PV → blend, filter_assy, cig_paper, tipping_paper,
              inner_foil, inner_frame, outer_pack, tax_stamp, carton
    Assembly sub-component edges (shared, one per unique assembly):
        blend   → virginia_leaf, burley_leaf, oriental_leaf, reconstituted_sheet
        fasm    → cellulose_acetate_tow (80% = CAT_001), filter_plug_wrap

    Structure per HTU PV (6 direct edges):
        PV → tobacco_substrate, hollow_acetate_tube, cooling_film,
              htu_wrapper_paper, htu_pack, aerosol_former
    """
    comb_pvs = product_variants[product_variants['category'] == 'COMBUSTIBLE'].copy().reset_index(drop=True)
    htu_pvs  = product_variants[product_variants['category'] == 'HTU'].copy().reset_index(drop=True)
    n_comb, n_htu = len(comb_pvs), len(htu_pvs)

    print(f"  Assigning components to {n_comb:,} combustible PVs …")

    # ── Part lookup helpers ───────────────────────────────────────────────────
    def _by_cat(cat):
        return parts[parts['category'] == cat]['part_id'].tolist()

    def _first_by_brand(cat):
        """Returns {brand: first_part_id} for brand-specific parts."""
        df = parts[(parts['category'] == cat) & parts['brand_affinity'].notna()]
        return df.groupby('brand_affinity')['part_id'].first().to_dict()

    def _all_by_brand(cat):
        """Returns {brand: [part_ids]} for brand-specific parts."""
        d = {}
        for _, row in parts[(parts['category'] == cat) & parts['brand_affinity'].notna()].iterrows():
            d.setdefault(row['brand_affinity'], []).append(row['part_id'])
        return d

    # ── Assign blend: exact match on (brand, variant) via merge ──────────────
    blend_lookup = (
        parts[parts['category'] == 'Tobacco Blend']
        .rename(columns={'brand_affinity': 'brand_name',
                         'variant_affinity': 'variant',
                         'part_id': 'blend_id'})
        [['brand_name', 'variant', 'blend_id']]
        .dropna(subset=['brand_name', 'variant'])
        .drop_duplicates(subset=['brand_name', 'variant'])
    )
    comb_pvs = comb_pvs.merge(blend_lookup, on=['brand_name', 'variant'], how='left')
    generic_blends = _by_cat('Tobacco Blend')
    mask = comb_pvs['blend_id'].isna()
    if mask.any():
        comb_pvs.loc[mask, 'blend_id'] = RNG.choice(generic_blends, size=mask.sum())

    # ── Filter assembly: 85% primary (first by brand), 15% secondary ─────────
    primary_fasm = _first_by_brand('Filter Assembly')
    all_fasm     = _all_by_brand('Filter Assembly')
    generic_fasm = _by_cat('Filter Assembly')

    def _pick_fasm(brand):
        opts = all_fasm.get(brand, generic_fasm[:5])
        if not opts:
            return generic_fasm[0] if generic_fasm else None
        if RNG.random() < 0.85 or len(opts) == 1:
            return opts[0]
        return str(RNG.choice(opts[1:]))

    comb_pvs['fasm_id'] = [_pick_fasm(b) for b in tqdm(comb_pvs['brand_name'], desc='  Filter assembly', leave=False)]

    # ── Cigarette paper: brand-specific (80% primary, 20% alt) ───────────────
    primary_cpap = _first_by_brand('Cigarette Paper')
    all_cpap     = _all_by_brand('Cigarette Paper')
    generic_cpap = _by_cat('Cigarette Paper')

    def _pick_cpap(brand):
        opts = all_cpap.get(brand, generic_cpap[:3])
        return opts[0] if (not opts or RNG.random() < 0.80 or len(opts) == 1) else str(RNG.choice(opts[1:]))

    comb_pvs['cpap_id'] = comb_pvs['brand_name'].map(
        {b: _pick_cpap(b) for b in COMBUSTIBLE_BRANDS})

    # ── Tipping paper: exact (brand, variant) merge ───────────────────────────
    tpap_lookup = (
        parts[parts['category'] == 'Tipping Paper']
        .rename(columns={'brand_affinity': 'brand_name',
                         'variant_affinity': 'variant',
                         'part_id': 'tpap_id'})
        [['brand_name', 'variant', 'tpap_id']]
        .dropna(subset=['brand_name', 'variant'])
        .drop_duplicates(subset=['brand_name', 'variant'])
    )
    comb_pvs = comb_pvs.merge(tpap_lookup, on=['brand_name', 'variant'], how='left')
    generic_tpap = _by_cat('Tipping Paper')
    mask = comb_pvs['tpap_id'].isna()
    if mask.any():
        comb_pvs.loc[mask, 'tpap_id'] = RNG.choice(generic_tpap, size=mask.sum())

    # ── Inner foil / inner frame: brand-specific ──────────────────────────────
    primary_ifoil  = _first_by_brand('Inner Foil')
    primary_iframe = _first_by_brand('Inner Frame')
    generic_ifoil  = _by_cat('Inner Foil')
    generic_iframe = _by_cat('Inner Frame')
    comb_pvs['ifoil_id']  = comb_pvs['brand_name'].map(primary_ifoil).fillna(
        generic_ifoil[0] if generic_ifoil else None)
    comb_pvs['iframe_id'] = comb_pvs['brand_name'].map(primary_iframe).fillna(
        generic_iframe[0] if generic_iframe else None)

    # ── Outer pack: (brand, market) merge — size selects OP20 vs OP10 ─────────
    def _op_lookup(cat):
        return (
            parts[parts['category'] == cat]
            .rename(columns={'brand_affinity': 'brand_name',
                             'market_affinity': 'market_code',
                             'part_id': f'{cat[:4].lower()}_id'})
            [['brand_name', 'market_code', f'{cat[:4].lower()}_id']]
            .dropna(subset=['brand_name', 'market_code'])
            .drop_duplicates(subset=['brand_name', 'market_code'])
        )

    op20_lookup = _op_lookup('Outer Pack 20s').rename(columns={'oute_id': 'op20_id'})
    op10_lookup = _op_lookup('Outer Pack 10s').rename(columns={'oute_id': 'op10_id'})
    # Rename the auto-generated column names properly
    op20_lookup.columns = ['brand_name', 'market_code', 'op20_id']
    op10_lookup.columns = ['brand_name', 'market_code', 'op10_id']

    comb_pvs = comb_pvs.merge(op20_lookup, on=['brand_name', 'market_code'], how='left')
    comb_pvs = comb_pvs.merge(op10_lookup, on=['brand_name', 'market_code'], how='left')

    fallback_op20 = _by_cat('Outer Pack 20s')
    fallback_op10 = _by_cat('Outer Pack 10s')
    is_10s = comb_pvs['size'].str.contains('10s', na=False)
    comb_pvs['op_id'] = np.where(
        is_10s,
        comb_pvs['op10_id'].fillna(comb_pvs['op20_id']).fillna(
            fallback_op10[0] if fallback_op10 else None),
        comb_pvs['op20_id'].fillna(
            fallback_op20[0] if fallback_op20 else None),
    )

    # ── Tax stamp: market-specific (100 % coverage) ───────────────────────────
    tax_map = {}
    for mkt in ['PL', 'FR', 'JP', 'DE', 'CH']:
        tx_parts = parts[parts['category'] == f'Tax Stamp {mkt}']['part_id'].tolist()
        if tx_parts:
            tax_map[mkt] = tx_parts[0]   # primary design for that market
    comb_pvs['tax_id'] = comb_pvs['market_code'].map(tax_map)

    # ── Carton: size-specific random pick ─────────────────────────────────────
    cartons = _by_cat('Carton')
    comb_pvs['cart_id'] = RNG.choice(cartons, size=n_comb) if cartons else None

    # ── HTU component assignment ──────────────────────────────────────────────
    print(f"  Assigning components to {n_htu:,} HTU PVs …")

    tsub_lookup = (
        parts[parts['category'] == 'TEREA Tobacco Substrate']
        .rename(columns={'brand_affinity': 'brand_name',
                         'flavor_affinity': 'variant',
                         'part_id': 'tsub_id'})
        [['brand_name', 'variant', 'tsub_id']]
        .dropna(subset=['brand_name', 'variant'])
        .drop_duplicates(subset=['brand_name', 'variant'])
    )
    htu_pvs = htu_pvs.merge(tsub_lookup, on=['brand_name', 'variant'], how='left')
    generic_tsub = _by_cat('TEREA Tobacco Substrate')
    mask = htu_pvs['tsub_id'].isna()
    if mask.any():
        htu_pvs.loc[mask, 'tsub_id'] = RNG.choice(generic_tsub, size=mask.sum())

    hats   = _by_cat('Hollow Acetate Tube')
    cfilms = _by_cat('Cooling Film')
    hwraps = _by_cat('HTU Wrapper Paper')
    aforms = _by_cat('Aerosol Former')

    # 80% share HAT_001, 90% share CFILM_001 — vectorised
    htu_pvs['hat_id']   = np.where(RNG.random(n_htu) < 0.80, hats[0],
                                    RNG.choice(hats, size=n_htu))
    htu_pvs['cfilm_id'] = np.where(RNG.random(n_htu) < 0.90, cfilms[0],
                                    RNG.choice(cfilms, size=n_htu))
    htu_pvs['hwrap_id'] = RNG.choice(hwraps, size=n_htu)
    htu_pvs['aform_id'] = aforms[0]   # single shared aerosol former

    hpack_lookup = (
        parts[parts['category'] == 'HTU Pack']
        .rename(columns={'brand_affinity': 'brand_name',
                         'flavor_affinity': 'variant',
                         'market_affinity': 'market_code',
                         'part_id': 'hpack_id'})
        [['brand_name', 'variant', 'market_code', 'hpack_id']]
        .dropna(subset=['brand_name', 'variant', 'market_code'])
        .drop_duplicates(subset=['brand_name', 'variant', 'market_code'])
    )
    htu_pvs = htu_pvs.merge(hpack_lookup, on=['brand_name', 'variant', 'market_code'], how='left')
    generic_hpack = _by_cat('HTU Pack')
    mask = htu_pvs['hpack_id'].isna()
    if mask.any():
        htu_pvs.loc[mask, 'hpack_id'] = RNG.choice(generic_hpack, size=mask.sum())

    # ── Build BOM row DataFrames using vectorised construction ────────────────
    print("  Building adjacency list rows …")

    def _pv_rows(pvs, comp_col, qty_arr, uom):
        valid = pvs[pvs[comp_col].notna()][['pv_id', comp_col, 'eff_from', 'eff_to']].copy()
        valid.columns = ['parent_id', 'child_id', 'eff_from', 'eff_to']
        valid['qty']             = qty_arr[:len(valid)] if len(qty_arr) >= len(valid) else np.ones(len(valid))
        valid['unit_of_measure'] = uom
        valid['bom_version']     = 'v1.0'
        return valid

    n_c, n_h = n_comb, n_htu
    bom_parts = [
        # Combustible PV → direct components
        _pv_rows(comb_pvs, 'blend_id',
                 np.clip(RNG.normal(0.65, 0.02, n_c), 0.50, 0.80).round(3), 'g'),
        _pv_rows(comb_pvs, 'fasm_id',  np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'cpap_id',  np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'tpap_id',  np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'ifoil_id', np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'iframe_id',np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'op_id',    np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'tax_id',   np.ones(n_c), 'pcs'),
        _pv_rows(comb_pvs, 'cart_id',  np.full(n_c, 10.0), 'pcs'),
        # HTU PV → direct components
        _pv_rows(htu_pvs,  'tsub_id',  np.clip(RNG.normal(0.32, 0.01, n_h), 0.25, 0.40).round(3), 'g'),
        _pv_rows(htu_pvs,  'hat_id',   np.ones(n_h), 'pcs'),
        _pv_rows(htu_pvs,  'cfilm_id', np.ones(n_h), 'pcs'),
        _pv_rows(htu_pvs,  'hwrap_id', np.ones(n_h), 'pcs'),
        _pv_rows(htu_pvs,  'hpack_id', np.ones(n_h), 'pcs'),
        _pv_rows(htu_pvs,  'aform_id', np.clip(RNG.normal(0.05, 0.005, n_h), 0.03, 0.08).round(4), 'g'),
    ]

    # ── Assembly sub-component edges (shared — one per unique assembly) ────────
    burley   = _by_cat('Burley Leaf')
    oriental = _by_cat('Oriental Leaf')
    recon    = _by_cat('Reconstituted Sheet')
    cat_parts = _by_cat('Cellulose Acetate Tow')
    fpw_parts = _by_cat('Filter Plug Wrap')

    assy_rows = []
    unique_blends = comb_pvs[['blend_id', 'brand_name']].drop_duplicates('blend_id').reset_index(drop=True)

    for _, row in tqdm(unique_blends.iterrows(), total=len(unique_blends),
                       desc='  Blend sub-components', leave=False):
        bid  = row['blend_id']
        efrom, eto = _GENERIC_EFF_FROM, _GENERIC_EFF_TO

        vlaf  = BRAND_VLAF_MAP.get(row['brand_name'], 'VLAF_A')
        blaf  = burley[   hash(bid) % len(burley)]    if burley   else None
        olaf  = oriental[ hash(bid) % len(oriental)]  if oriental else None
        rcn   = recon[    hash(bid) % len(recon)]     if recon    else None

        base = {'bom_version': 'v1.0', 'eff_from': efrom, 'eff_to': eto}
        assy_rows.append({**base, 'parent_id': bid, 'child_id': vlaf,
                           'qty': round(float(RNG.normal(0.35, 0.03)), 3), 'unit_of_measure': 'kg'})
        if blaf:
            assy_rows.append({**base, 'parent_id': bid, 'child_id': blaf,
                               'qty': round(float(RNG.normal(0.20, 0.02)), 3), 'unit_of_measure': 'kg'})
        if olaf:
            assy_rows.append({**base, 'parent_id': bid, 'child_id': olaf,
                               'qty': round(float(RNG.normal(0.10, 0.01)), 3), 'unit_of_measure': 'kg'})
        if rcn:
            assy_rows.append({**base, 'parent_id': bid, 'child_id': rcn,
                               'qty': round(float(RNG.normal(0.15, 0.02)), 3), 'unit_of_measure': 'kg'})

    unique_fasms = comb_pvs[['fasm_id']].drop_duplicates().reset_index(drop=True)
    for _, row in tqdm(unique_fasms.iterrows(), total=len(unique_fasms),
                       desc='  Filter sub-components', leave=False):
        fid = row['fasm_id']
        base = {'bom_version': 'v1.0', 'eff_from': _GENERIC_EFF_FROM, 'eff_to': _GENERIC_EFF_TO}
        # 80% of filter assemblies use CAT_001 (most shared)
        cat_id = cat_parts[0] if (cat_parts and RNG.random() < 0.80) else (
            str(RNG.choice(cat_parts)) if cat_parts else None)
        fpw_id = str(RNG.choice(fpw_parts)) if fpw_parts else None
        if cat_id:
            assy_rows.append({**base, 'parent_id': fid, 'child_id': cat_id,
                               'qty': round(float(RNG.normal(0.12, 0.01)), 4), 'unit_of_measure': 'kg'})
        if fpw_id:
            assy_rows.append({**base, 'parent_id': fid, 'child_id': fpw_id,
                               'qty': 1.0, 'unit_of_measure': 'pcs'})

    # Combine everything
    all_dfs = [df for df in bom_parts if df is not None and len(df) > 0]
    if assy_rows:
        all_dfs.append(pd.DataFrame(assy_rows))

    result = pd.concat(all_dfs, ignore_index=True)
    result = result.dropna(subset=['child_id'])
    result = result.drop_duplicates(subset=['parent_id', 'child_id'])

    # Report VLAF_A coverage (validates sharing metric)
    vlaf_a_in_closure_proxy = comb_pvs[
        comb_pvs['brand_name'].isin([b for b, v in BRAND_VLAF_MAP.items() if v == 'VLAF_A'])
    ]
    pct = 100 * len(vlaf_a_in_closure_proxy) / max(n_comb, 1)
    print(f"  Generated {len(result):,} BOM adjacency rows  "
          f"(VLAF_A in closure of ~{pct:.0f}% combustible PVs)")
    return result


# ---------------------------------------------------------------------------
# BOM revisions
# ---------------------------------------------------------------------------

def generate_bom_revisions(config, bom_items):
    """30% of PV-level BOM edges get 2 historical revision records each."""
    pv_edges = bom_items[bom_items['parent_id'].str.startswith('FA')].copy()
    n_sample = max(1, int(len(pv_edges) * 0.30))
    sampled  = pv_edges.sample(n=n_sample, random_state=42)

    rows = []
    for _, edge in tqdm(sampled.iterrows(), total=len(sampled),
                        desc='  BOM revisions', leave=False):
        pv_id, part_id, curr_qty = edge['parent_id'], edge['child_id'], edge['qty']
        try:
            base_date = datetime.strptime(str(edge['eff_from']), '%Y-%m-%d')
        except Exception:
            base_date = datetime(2018, 1, 1)

        for rev in range(2):
            days_back   = int(RNG.integers(30, 730)) * (rev + 1)
            rev_date    = base_date - timedelta(days=days_back)
            old_qty     = round(float(RNG.normal(curr_qty, curr_qty * 0.05)), 4)
            rows.append({
                'pv_id':          pv_id,
                'part_id':        part_id,
                'old_qty':        old_qty,
                'new_qty':        round(float(curr_qty), 4),
                'revision_date':  rev_date.strftime('%Y-%m-%d'),
                'revised_by':     str(RNG.choice(PMI_USERS)),
                'change_reason':  str(RNG.choice(ECO_CHANGE_REASONS)),
            })

    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# ECOs
# ---------------------------------------------------------------------------

def generate_eco(config, parts, product_variants):
    """Generate ~2 000 Engineering Change Orders."""
    n_eco       = max(50, int(config.get('n_combustible_pvs', 200) * 0.08))
    n_eco       = min(n_eco, 2000)
    part_ids    = parts['part_id'].tolist()
    pv_ids      = product_variants['pv_id'].tolist()

    eco_types   = ['Express ECO', 'Resource ECO', 'Product Record']
    statuses    = ['Open', 'Closed', 'Draft']
    status_w    = [0.25, 0.65, 0.10]

    rows = []
    for i in range(1, n_eco + 1):
        status   = str(RNG.choice(statuses, p=status_w))
        eco_type = str(RNG.choice(eco_types))
        create_d = date(2018, 1, 1) + timedelta(days=int(RNG.integers(0, 2190)))
        close_d  = None
        if status == 'Closed':
            close_d = (create_d + timedelta(days=int(RNG.integers(7, 365)))).strftime('%Y-%m-%d')

        affects_part = RNG.random() < 0.50
        rows.append({
            'eco_id':          f'ECO_{i:05d}',
            'eco_type':        eco_type,
            'status':          status,
            'title':           f'{eco_type} — {str(RNG.choice(ECO_CHANGE_REASONS))} #{i:05d}',
            'affected_part_id': str(RNG.choice(part_ids)) if affects_part else None,
            'affected_pv_id':   str(RNG.choice(pv_ids))  if not affects_part else None,
            'created_date':    create_d.strftime('%Y-%m-%d'),
            'closed_date':     close_d,
            'created_by':      str(RNG.choice(PMI_USERS)),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Projects & PV-project link
# ---------------------------------------------------------------------------

def generate_projects(config, product_variants):
    """Generate ~500 projects with realistic lifecycle."""
    n_proj  = max(20, min(500, config.get('n_combustible_pvs', 200) // 4))
    phases  = ['Phase 1', 'Phase 2', 'Launch']
    statuses = ['Approved', 'In Progress', 'Pending Approval', 'Overdue', 'Completed', 'Cancelled']
    status_w = [0.10, 0.25, 0.10, 0.10, 0.40, 0.05]

    rows = []
    for i in range(1, n_proj + 1):
        status   = str(RNG.choice(statuses, p=status_w))
        phase    = str(RNG.choice(phases))
        start_d  = date(2019, 1, 1) + timedelta(days=int(RNG.integers(0, 1825)))
        dur_days = int(RNG.integers(60, 730))
        end_d    = start_d + timedelta(days=dur_days)
        actual   = None
        status_changed = (start_d + timedelta(days=int(RNG.integers(0, dur_days)))).strftime('%Y-%m-%d')
        if status == 'Completed':
            actual = (end_d + timedelta(days=int(RNG.integers(-30, 90)))).strftime('%Y-%m-%d')

        brand_hint = str(RNG.choice(COMBUSTIBLE_BRANDS + HTU_BRANDS))
        rows.append({
            'project_id':           f'PRJ_{i:04d}',
            'project_name':         f'{brand_hint} Portfolio Initiative {i:04d}',
            'status':               status,
            'phase':                phase,
            'planned_start_date':   start_d.strftime('%Y-%m-%d'),
            'planned_end_date':     end_d.strftime('%Y-%m-%d'),
            'actual_end_date':      actual,
            'status_changed_date':  status_changed,
            'project_manager':      str(RNG.choice(PROJECT_MANAGERS)),
        })
    return pd.DataFrame(rows)


def generate_pv_project(projects, product_variants):
    """Link table — ~3 PVs per project on average."""
    pv_ids   = product_variants['pv_id'].tolist()
    proj_ids = projects['project_id'].tolist()
    rows     = []
    seen     = set()
    for proj_id in tqdm(proj_ids, desc='  PV–project links', leave=False):
        n_pvs = int(RNG.integers(1, 8))   # 1–7 PVs per project
        for pv_id in RNG.choice(pv_ids, size=min(n_pvs, len(pv_ids)), replace=False):
            key = (str(pv_id), proj_id)
            if key not in seen:
                seen.add(key)
                rows.append({'pv_id': str(pv_id), 'project_id': proj_id})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Manufacturing specs (combustible only)
# ---------------------------------------------------------------------------

def generate_mspec(config, product_variants):
    """One manufacturing spec per combustible PV."""
    comb = product_variants[product_variants['category'] == 'COMBUSTIBLE'].copy()
    n    = len(comb)

    # Cigarette dimensions vary by size
    def _length(size):
        if '100s' in str(size):   return round(float(RNG.normal(100, 0.5)), 1)
        if 'Slim' in str(size):   return round(float(RNG.normal(83, 0.5)),  1)
        return round(float(RNG.normal(83, 0.5)), 1)   # KS

    def _circ(size):
        if 'Slim' in str(size):   return round(float(RNG.normal(17.0, 0.2)), 2)
        return round(float(RNG.normal(24.8, 0.2)), 2)

    rows = []
    for i, (_, pv) in enumerate(tqdm(comb.iterrows(), total=n,
                                      desc='  Mspec rows', leave=False)):
        size = pv.get('size', 'KS 20s')
        rows.append({
            'mspec_id':                   f'MSPEC_{i+1:06d}',
            'pv_id':                       pv['pv_id'],
            'mspec_name':                 f"{pv['pv_name']} Manufacturing Spec",
            'pc_code':                     pv['pc_code'],
            'cigarette_length_mm':         _length(size),
            'cigarette_circumference_mm':  _circ(size),
            'filter_length_mm':            round(float(RNG.normal(23.0, 1.0)), 1),
            'tobacco_weight_g':            round(float(RNG.normal(0.75, 0.05)), 3),
            'draw_resistance_mmwg':        round(float(RNG.normal(100, 8.0)), 0),
            'created_date':                pv['eff_from'],
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# GHP parameters
# ---------------------------------------------------------------------------

def generate_ghp_parameters(config, product_variants):
    """4–6 global harmonised parameters per PV."""
    PARAM_RANGES = {
        'Nicotine Yield':      (0.1,  1.0,  'mg', 'COMBUSTIBLE'),
        'Tar Yield':           (1.0,  15.0, 'mg', 'COMBUSTIBLE'),
        'CO Yield':            (1.0,  15.0, 'mg', 'COMBUSTIBLE'),
        'Units Per Pack':      (10,   20,   'pcs', None),
        'Pack Weight g':       (10.0, 16.0, 'g',  None),
        'Filter Ventilation %':(0.0,  80.0, '%',  'COMBUSTIBLE'),
        'Aerosol Nicotine':    (0.05, 0.50, 'mg', 'HTU'),
        'Aerosol CO':          (0.1,  2.0,  'mg', 'HTU'),
    }
    rows = []
    for _, pv in tqdm(product_variants.iterrows(), total=len(product_variants),
                      desc='  GHP parameters', leave=False):
        cat         = pv['category']
        applicable  = [(name, lo, hi, unit) for name, (lo, hi, unit, cat_filter)
                       in PARAM_RANGES.items()
                       if cat_filter is None or cat_filter == cat]
        n_params = int(RNG.integers(4, 7))
        chosen   = RNG.choice(len(applicable), size=min(n_params, len(applicable)), replace=False)
        for idx in chosen:
            name, lo, hi, unit = applicable[idx]
            val = float(RNG.uniform(lo, hi))
            rows.append({
                'pv_id':           pv['pv_id'],
                'parameter_name':  name,
                'parameter_value': round(val, 4),
                'parameter_unit':  unit,
                'is_global':       bool(RNG.random() < 0.40),
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Snowflake loader
# ---------------------------------------------------------------------------

def load_dataframe_to_snowflake(conn, df, table_name, schema):
    """Write DataFrame to Snowflake, auto-creating the table if needed."""
    load_df = df.copy()
    load_df.columns = [c.upper() for c in load_df.columns]
    # Convert object columns to str to avoid connector type issues
    for col in load_df.select_dtypes(include='object').columns:
        load_df[col] = load_df[col].astype(str).replace('None', None).replace('nan', None)

    success, _, nrows, _ = write_pandas(
        conn, load_df, table_name.upper(),
        schema=schema.upper(),
        auto_create_table=True,
        overwrite=True,
    )
    if success:
        print(f"    ✓ {schema}.{table_name}: {nrows:,} rows loaded")
    else:
        print(f"    ✗ ERROR loading {table_name}")
    return success


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def main():
    args   = parse_args()
    config = SCALE_PROFILES[args.profile]
    print(f"\nPMI CLIPP BOM Data Generator  —  profile: {args.profile}")
    print(f"  {config['description']}")
    print(f"  Combustible PVs: {config['n_combustible_pvs']:,}  |  HTU PVs: {config['n_htu_pvs']:,}\n")

    conn = None
    if not getattr(args, 'no_load', False):
        if not args.account:
            print("No --account provided; running in generate-only mode (--no-load).")
        elif HAS_SNOWFLAKE:
            try:
                print("Connecting to Snowflake …")
                conn = get_snowflake_connection(args)
                print("  Connected.\n")
            except Exception as e:
                print(f"  Connection failed: {e}\n  Continuing in generate-only mode.")

    total_start = time.time()
    summaries   = {}

    def _gen(label, fn, *fn_args):
        t0  = time.time()
        df  = fn(*fn_args)
        elapsed = time.time() - t0
        print(f"  [{elapsed:5.1f}s]  {label}: {len(df):,} rows")
        summaries[label] = len(df)
        return df

    print("── Generating dimension tables ────────────────────────────────────")
    markets             = _gen('DIM_MARKETS',             generate_markets,             config)
    production_centers  = _gen('DIM_PRODUCTION_CENTERS',  generate_production_centers,  config)
    brands              = _gen('DIM_BRANDS',              generate_brands,              config)
    global_products     = _gen('DIM_GLOBAL_PRODUCTS',     generate_global_products,     config)
    parts               = _gen('DIM_PARTS',               generate_parts,               config)
    product_variants    = _gen('DIM_PRODUCT_VARIANTS',    generate_product_variants,
                                config, global_products, markets, production_centers)

    print("\n── Generating fact tables ─────────────────────────────────────────")
    bom_items           = _gen('FACT_BOM_ITEMS',          generate_bom_items,
                                config, product_variants, parts)
    bom_revisions       = _gen('FACT_BOM_REVISIONS',      generate_bom_revisions,       config, bom_items)
    projects            = _gen('DIM_PROJECTS',            generate_projects,            config, product_variants)
    pv_project          = _gen('FACT_PV_PROJECT',         generate_pv_project,          projects, product_variants)
    mspec               = _gen('FACT_MSPEC',              generate_mspec,               config, product_variants)
    ghp_params          = _gen('FACT_GHP_PARAMETERS',     generate_ghp_parameters,      config, product_variants)
    eco                 = _gen('DIM_ECO',                 generate_eco,                 config, parts, product_variants)

    print(f"\n── Total generation time: {time.time() - total_start:.1f}s ─────────────────")

    # ── Load to Snowflake ──────────────────────────────────────────────────────
    if conn:
        print("\n── Loading to Snowflake ───────────────────────────────────────────")
        schema = args.schema
        ordered_loads = [
            (markets,            'DIM_MARKETS'),
            (production_centers, 'DIM_PRODUCTION_CENTERS'),
            (brands,             'DIM_BRANDS'),
            (global_products,    'DIM_GLOBAL_PRODUCTS'),
            (parts,              'DIM_PARTS'),
            (product_variants,   'DIM_PRODUCT_VARIANTS'),
            (bom_items,          'FACT_BOM_ITEMS'),
            (bom_revisions,      'FACT_BOM_REVISIONS'),
            (projects,           'DIM_PROJECTS'),
            (pv_project,         'FACT_PV_PROJECT'),
            (mspec,              'FACT_MSPEC'),
            (ghp_params,         'FACT_GHP_PARAMETERS'),
            (eco,                'DIM_ECO'),
        ]
        load_start = time.time()
        for df, tbl in ordered_loads:
            load_dataframe_to_snowflake(conn, df, tbl, schema)
        print(f"\n  Total load time: {time.time() - load_start:.1f}s")
        conn.close()

    # ── Final summary ──────────────────────────────────────────────────────────
    print("\n── Row count summary ──────────────────────────────────────────────")
    total_rows = 0
    for label, cnt in summaries.items():
        print(f"  {label:<30} {cnt:>10,}")
        total_rows += cnt
    print(f"  {'TOTAL':.<30} {total_rows:>10,}")
    print(f"\nDone in {time.time() - total_start:.1f}s.\n")


if __name__ == '__main__':
    main()
