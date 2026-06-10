import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import BOMGrid from '../components/BOMGrid';
import { getParts, whereUsed, WhereUsedResponse, Part } from '../api/client';
import { ColDef } from 'ag-grid-community';

// ─── Column defs ─────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { field: 'ancestor_id',      headerName: 'PV ID',           width: 140, cellStyle: { fontFamily: 'monospace', fontSize: 12 } },
  { field: 'pv_name',          headerName: 'PV Name',         flex: 2 },
  { field: 'brand_name',       headerName: 'Brand',           width: 130 },
  { field: 'market_code',      headerName: 'Market',          width: 90 },
  { field: 'lifecycle_status', headerName: 'Status',          width: 110 },
  {
    field: 'impact_tier',
    headerName: 'Impact Tier',
    width: 130,
    cellStyle: (params: any) => {
      const colors: Record<string, string> = {
        DIRECT:       '#7C3AED',
        'NEAR TOP':   '#DC2626',
        'MID LEVEL':  '#D97706',
        DEEP:         '#64748B',
        'RAW MATERIAL': '#16A34A',
      };
      return { color: colors[params.value] ?? '#1e293b', fontWeight: 600 };
    },
  },
  { field: 'level_display',    headerName: 'Level',           width: 100 },
  { field: 'levels_from_leaf', headerName: 'Steps from Leaf', width: 130, type: 'numericColumn' },
  { field: 'depth_pct',        headerName: 'Depth %',         width: 90,  type: 'numericColumn' },
  { field: 'cum_qty',          headerName: 'Cum. Qty',        width: 100, type: 'numericColumn' },
  { field: 'path',             headerName: 'Full BOM Path',   flex: 3,    cellStyle: { fontFamily: 'monospace', fontSize: 11, color: '#64748B' } },
];

const CHART_COLORS = ['#003087', '#3B82F6', '#16A34A', '#D97706', '#DC2626', '#7C3AED', '#64748B'];

// ─── Part search combobox ───────────────────────────────────────────────

interface PartSearchProps {
  onSelect: (part: Part) => void;
  initialPartId?: string;
}

function PartSearch({ onSelect, initialPartId }: PartSearchProps) {
  const [query, setQuery] = useState('');
  const [parts, setParts] = useState<Part[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialPartId) {
      getParts().then((all) => {
        const found = all.find((p) => p.part_id === initialPartId);
        if (found) {
          setQuery(found.part_name);
          onSelect(found);
        }
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPartId]);

  const handleInput = (val: string) => {
    setQuery(val);
    setOpen(true);
    if (debounce.current) clearTimeout(debounce.current);
    if (val.length < 2) { setParts([]); return; }
    debounce.current = setTimeout(() => {
      setLoading(true);
      getParts()
        .then((all) => {
          const lower = val.toLowerCase();
          setParts(all.filter((p) =>
            p.part_name.toLowerCase().includes(lower) || p.part_id.toLowerCase().includes(lower)
          ).slice(0, 20));
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 300);
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => query.length >= 2 && setOpen(true)}
        placeholder="Search by part name or ID…"
        className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-80 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {open && (loading || parts.length > 0) && (
        <div className="absolute top-full mt-1 left-0 w-80 bg-white border border-slate-200 rounded-lg shadow-lg z-20 max-h-60 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>}
          {parts.map((p) => (
            <button
              key={p.part_id}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm flex justify-between items-center"
              onMouseDown={() => {
                setQuery(p.part_name);
                setOpen(false);
                onSelect(p);
              }}
            >
              <span className="font-medium text-slate-700">{p.part_name}</span>
              <span className="text-xs text-slate-400 font-mono">{p.part_id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function WhereUsed() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preloadPartId = searchParams.get('part_id') ?? undefined;

  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhereUsedResponse | null>(null);

  const handleFind = useCallback(async () => {
    if (!selectedPart) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await whereUsed(selectedPart.part_id);
      setResult(data);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load where-used data');
    } finally {
      setLoading(false);
    }
  }, [selectedPart]);

  // Auto-run if part preloaded from navigation
  useEffect(() => {
    if (preloadPartId && selectedPart?.part_id === preloadPartId) {
      handleFind();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPart]);

  // Derive chart data from result
  const marketData = result
    ? Object.entries(
        result.data.reduce<Record<string, number>>((acc, row) => {
          acc[row.market_code] = (acc[row.market_code] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([market_code, count]) => ({ market_code, count }))
    : [];

  const brandData = result
    ? Object.entries(
        result.data.reduce<Record<string, number>>((acc, row) => {
          acc[row.brand_name] = (acc[row.brand_name] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([brand_name, count]) => ({ brand_name, count }))
    : [];

  const handleRowClick = useCallback(
    (row: any) => navigate(`/bom-explosion?pv_id=${encodeURIComponent(row.ancestor_id)}`),
    [navigate]
  );

  return (
    <div className="flex flex-col gap-0">
      {/* Controls */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Component / Part</label>
          <PartSearch onSelect={setSelectedPart} initialPartId={preloadPartId} />
        </div>
        <button
          onClick={handleFind}
          disabled={!selectedPart || loading}
          className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          style={{ background: '#003087' }}
        >
          {loading ? 'Searching…' : 'Find Usage'}
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Summary banner */}
      {result && selectedPart && (
        <div className="mx-6 mt-6 rounded-xl px-6 py-4" style={{ background: '#003087' }}>
          <div className="text-white text-xl font-bold">
            <span className="text-amber-300">{selectedPart.part_name}</span>
            {' '}impacts{' '}
            <span className="text-amber-300">{result.total_impacted ?? result.total_pvs_affected}</span>
            {' '}nodes —{' '}
            <span className="text-amber-300">{(result as any).intermediates?.length ?? 0}</span>
            {' '}intermediate components +{' '}
            <span className="text-amber-300">{result.total_pvs_affected}</span>
            {' '}finished PVs across{' '}
            <span className="text-amber-300">{result.markets_affected.length}</span>
            {' '}markets
          </div>
          <div className="text-white/60 text-sm mt-1">
            Markets: {result.markets_affected.join(', ')}
          </div>
        </div>
      )}

      {/* Charts */}
      {result && (
        <div className="grid grid-cols-2 gap-6 px-6 mt-6">
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">PVs by Market</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={marketData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="market_code" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" name="PVs" radius={[4, 4, 0, 0]}>
                  {marketData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">PVs by Brand</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={brandData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="brand_name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" name="PVs" radius={[4, 4, 0, 0]}>
                  {brandData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Two-group results: Intermediate Components + Finished PVs */}
      {result && (
        <div className="px-6 mt-6 mb-6 flex flex-col gap-6">

          {/* Group 1: Intermediate components impacted */}
          {(result as any).intermediates?.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />
                <h3 className="text-sm font-semibold text-slate-700">
                  Intermediate Components Impacted ({(result as any).intermediates.length})
                </h3>
                <span className="text-xs text-slate-400">— specs, recipes and assemblies that directly use this component</span>
              </div>
              <BOMGrid
                rowData={(result as any).intermediates}
                columnDefs={[
                  { field: 'ancestor_id',   headerName: 'Component ID',    width: 200, cellStyle: { fontFamily: 'monospace', fontSize: 12 } },
                  { field: 'ancestor_name', headerName: 'Component Name',  flex: 2 },
                  { field: 'ancestor_type', headerName: 'Type',            width: 140 },
                  { field: 'impact_tier',   headerName: 'Impact Tier',     width: 120 },
                  { field: 'level_display', headerName: 'Level',           width: 100 },
                  { field: 'cum_qty',       headerName: 'Qty',             width: 80, type: 'numericColumn' },
                  { field: 'path',          headerName: 'Path',            flex: 2, cellStyle: { fontFamily: 'monospace', fontSize: 11, color: '#64748B' } },
                ]}
                height="220px"
              />
            </div>
          )}

          {/* Group 2: Finished Product Variants */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-3 h-3 rounded-full bg-blue-600 inline-block" />
              <h3 className="text-sm font-semibold text-slate-700">
                Finished Product Variants ({result.total_pvs_affected})
              </h3>
              <span className="text-xs text-slate-400">— click a row to open in BOM Explosion</span>
            </div>
            <BOMGrid
              rowData={(result as any).finished_pvs ?? result.data}
              columnDefs={COLS}
              onRowClick={handleRowClick}
              height="360px"
            />
          </div>
        </div>
      )}

      {/* Charts */}
      {result && (
        <div className="grid grid-cols-2 gap-6 px-6 mt-6">
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">PVs by Market</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={marketData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="market_code" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" name="PVs" radius={[4, 4, 0, 0]}>
                  {marketData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">PVs by Brand</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={brandData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="brand_name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" name="PVs" radius={[4, 4, 0, 0]}>
                  {brandData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Results grid */}
      {result && (
        <div className="px-6 mt-6 mb-6">
          <BOMGrid
            rowData={result.data}
            columnDefs={COLS}
            title="Product Variants using this component"
            onRowClick={handleRowClick}
            height="360px"
          />
          <p className="text-xs text-slate-400 mt-1">Click a row to open that PV in BOM Explosion.</p>
        </div>
      )}

      {!result && !loading && (
        <div className="flex-1 flex items-center justify-center p-16 text-slate-400 text-sm">
          Search for a part to see all Product Variants that include it.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center p-16">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <span className="text-sm text-slate-500">Querying BOM_CLOSURE in Snowflake…</span>
          </div>
        </div>
      )}
    </div>
  );
}
