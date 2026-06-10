import React, { useCallback, useEffect, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import BOMGrid from '../components/BOMGrid';
import { getParts, getImpact, ImpactResponse, Part } from '../api/client';
import { ColDef } from 'ag-grid-community';

// ─── Column defs ───────────────────────────────────────────────────────────

const PV_COLS: ColDef[] = [
  { field: 'pv_id',            headerName: 'PV ID',    width: 140 },
  { field: 'pv_name',          headerName: 'PV Name',  flex: 2 },
  { field: 'brand_name',       headerName: 'Brand',    width: 130 },
  { field: 'market_code',      headerName: 'Market',   width: 100 },
  { field: 'lifecycle_status', headerName: 'Status',   width: 130 },
];

const ECO_COLS: ColDef[] = [
  { field: 'eco_id',      headerName: 'ECO ID',       width: 130 },
  { field: 'eco_type',    headerName: 'Type',         width: 120 },
  { field: 'title',       headerName: 'Title',        flex: 2 },
  { field: 'status',      headerName: 'Status',       width: 120 },
  { field: 'created_date', headerName: 'Created',     width: 110,
    valueFormatter: (p) => p.value ? new Date(p.value).toLocaleDateString() : '—' },
];

const PIE_COLORS = ['#003087', '#3B82F6', '#16A34A', '#D97706', '#DC2626', '#7C3AED', '#64748B', '#0EA5E9'];

// ─── Impact tile ───────────────────────────────────────────────────────────────

function ImpactTile({ label, value, accent }: { label: string; value: number | string; accent: string }) {
  return (
    <div
      className="rounded-xl border shadow-sm px-6 py-5 flex flex-col items-center gap-1"
      style={{ borderColor: accent + '40', background: accent + '0D' }}
    >
      <div className="text-4xl font-black" style={{ color: accent }}>{value}</div>
      <div className="text-xs font-medium text-slate-600 text-center mt-1">{label}</div>
    </div>
  );
}

function pvTileAccent(n: number) {
  if (n > 500) return '#DC2626';
  if (n > 100) return '#D97706';
  return '#16A34A';
}

// ─── Part search ───────────────────────────────────────────────────────────────

interface PartDropdownProps {
  onSelect: (part: Part) => void;
}

function PartDropdown({ onSelect }: PartDropdownProps) {
  const [parts, setParts] = useState<Part[]>([]);
  const [value, setValue] = useState('');

  useEffect(() => {
    getParts().then(setParts).catch(() => {});
  }, []);

  return (
    <select
      className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[300px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        const found = parts.find((p) => p.part_id === e.target.value);
        if (found) onSelect(found);
      }}
    >
      <option value="">Select a component / part…</option>
      {parts.map((p) => (
        <option key={p.part_id} value={p.part_id}>[{p.category}] {p.part_name}</option>
      ))}
    </select>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function ImpactAnalysis() {
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImpactResponse | null>(null);

  const handleAnalyze = useCallback(async () => {
    if (!selectedPart) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await getImpact(selectedPart.part_id);
      setResult(data);
    } catch (e: any) {
      setError(e.message ?? 'Impact analysis failed');
    } finally {
      setLoading(false);
    }
  }, [selectedPart]);

  const pieData = result
    ? Object.entries(
        result.affected_pvs.reduce<Record<string, number>>((acc, pv) => {
          acc[pv.market_code] = (acc[pv.market_code] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([name, value]) => ({ name, value }))
    : [];

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-5">
        <h2 className="text-base font-bold text-slate-800">Supply Chain Impact Analysis</h2>
        <p className="text-xs text-slate-500 mt-1">
          Select a component to instantly see every Product Variant, market, brand, and open ECO that would be affected by a change to that part.
        </p>
      </div>

      {/* Controls */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Component to analyze</label>
          <PartDropdown onSelect={setSelectedPart} />
        </div>
        <button
          onClick={handleAnalyze}
          disabled={!selectedPart || loading}
          className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          style={{ background: '#003087' }}
        >
          {loading ? 'Analyzing…' : 'Analyze Impact'}
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Impact tiles */}
      {result && (
        <div className="px-6 py-5 bg-slate-50 border-b border-slate-200">
          <div className="grid grid-cols-4 gap-4">
            <ImpactTile
              label="Product Variants affected"
              value={result.summary.total_pvs}
              accent={pvTileAccent(result.summary.total_pvs)}
            />
            <ImpactTile
              label="Markets affected"
              value={result.summary.markets_count}
              accent="#3B82F6"
            />
            <ImpactTile
              label="Open ECOs"
              value={result.summary.open_ecos_count}
              accent="#D97706"
            />
            <ImpactTile
              label="Brands affected"
              value={result.summary.brands_affected.length}
              accent="#7C3AED"
            />
          </div>
          {result.summary.brands_affected.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {result.summary.brands_affected.map((b) => (
                <span key={b} className="px-2 py-0.5 bg-purple-100 text-purple-800 text-xs font-semibold rounded-full">{b}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Grids + chart */}
      {result && (
        <div className="p-6 flex flex-col gap-6">
          {/* Pie chart */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Affected PVs by Market</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%" cy="50%"
                  outerRadius={80}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => [`${v} PVs`, 'Count']} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Two grids */}
          <div className="grid grid-cols-2 gap-6">
            <BOMGrid
              rowData={result.affected_pvs}
              columnDefs={PV_COLS}
              title="Affected Product Variants"
              height="340px"
            />
            <BOMGrid
              rowData={result.open_ecos}
              columnDefs={ECO_COLS}
              title="Open Engineering Change Orders"
              height="340px"
            />
          </div>
        </div>
      )}

      {!result && !loading && (
        <div className="flex items-center justify-center p-16 text-slate-400 text-sm">
          Select a component above to run the impact analysis.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center p-16">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <span className="text-sm text-slate-500">Traversing BOM_CLOSURE and ECO tables…</span>
          </div>
        </div>
      )}
    </div>
  );
}
