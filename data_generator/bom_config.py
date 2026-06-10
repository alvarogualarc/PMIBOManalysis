"""
PMI CLIPP BOM Analytics POC - Generator Configuration
Seed data and scale profiles for the BOM data generator.
"""

SCALE_PROFILES = {
    'SMALL':      {'n_combustible_pvs': 200,   'n_htu_pvs': 50,   'description': 'Dev/test - fast'},
    'MEDIUM':     {'n_combustible_pvs': 2000,  'n_htu_pvs': 500,  'description': 'Demo - 5 min generate'},
    'PRODUCTION': {'n_combustible_pvs': 17000, 'n_htu_pvs': 3000, 'description': 'PMI realistic scale'},
}

MARKETS = [
    {'market_code': 'PL', 'market_name': 'Poland',      'region': 'EEMA'},
    {'market_code': 'FR', 'market_name': 'France',      'region': 'WE'},
    {'market_code': 'JP', 'market_name': 'Japan',       'region': 'APAC'},
    {'market_code': 'DE', 'market_name': 'Germany',     'region': 'WE'},
    {'market_code': 'CH', 'market_name': 'Switzerland', 'region': 'WE'},
]

PRODUCTION_CENTERS = [
    {'pc_code': 'WAW', 'pc_name': 'Warsaw',    'market_code': 'PL'},
    {'pc_code': 'KRK', 'pc_name': 'Krakow',    'market_code': 'PL'},
    {'pc_code': 'LYO', 'pc_name': 'Lyon',      'market_code': 'FR'},
    {'pc_code': 'OSA', 'pc_name': 'Osaka',     'market_code': 'JP'},
    {'pc_code': 'FRK', 'pc_name': 'Frankfurt', 'market_code': 'DE'},
    {'pc_code': 'GVA', 'pc_name': 'Geneva',    'market_code': 'CH'},
    {'pc_code': 'BOL', 'pc_name': 'Bologna',   'market_code': 'CH'},
    {'pc_code': 'NCE', 'pc_name': 'Nice',      'market_code': 'FR'},
]

COMBUSTIBLE_BRANDS = ['Marlboro', 'Parliament', 'Chesterfield', 'L&M', 'Philip Morris', 'Bond Street']
HTU_BRANDS = ['HEETS', 'TEREA']

# Combustible variant types
COMBUSTIBLE_VARIANTS = [
    'Red', 'Gold', 'Blue', 'Silver', 'Compact',
    'Ice Blast', 'Summer Splash', 'Purple Edition', 'Menthol', 'One',
]
COMBUSTIBLE_SIZES = ['KS 20s', 'KS 10s', '100s 20s', 'Slim 20s']

# HTU flavors
HEETS_VARIANTS = ['Bronze', 'Silver', 'Turquoise', 'Yellow', 'Sienna', 'Amber', 'Mauve', 'Teak']
TEREA_VARIANTS = ['Amber', 'Warm Regular', 'Cool Regular', 'Purple', 'Bright', 'Smooth Regular', 'Yugen', 'Pearl']

LIFECYCLE_STATUSES = ['Preliminary', 'Released', 'Obsolete']
LIFECYCLE_WEIGHTS  = [0.15, 0.70, 0.15]   # Most PVs are Released
