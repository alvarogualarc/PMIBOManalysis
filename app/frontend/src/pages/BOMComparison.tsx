import React, { useCallback, useEffect, useState } from 'react';
import BOMGrid from '../components/BOMGrid';
import { getPVs, compareBOM, CompareResponse, PV } from '../api/client';
import { ColDef, CellClassParams } from 'ag-grid-community';

// ─── Shared column base ───────────────────────────────────────────────────────

const BASE_COLS: ColDef[] = [
  { field: 'descendant_id', headerName: 'Part ID',   width: 130 },
  { field: 'part_name',     headerName: 'Part Name', flex: 2 },
  { field: 'category',      headerName: 'Category',  width: 120 },
  { field: 'depth',         headerName: 'Level',     width: 80,  type: 'numericColumn' },
  { field: 'cum_qty',       headerName: 'Qty',       width: 90,  type: 'numericColumn' },
  { field: 'unit_of_measure', headerName: 'UoM',     width: 80 },
];

const IN_BOTH_COLS: ColDef[] = [
  { field: 'descendant_id', headerName: 'Part ID',   width: 130 },
  { field: 'part_name',     headerName: 'Part Name', flex: 2 },
  { field: 'category',      headerName: 'Category',  width: 120 },
  { field: 'depth',         headerName: 'Level',     width: 80,  type: 'numericColumn' },
  {
    field: 'qty_a', headerName: 'Qty A', width: 90, type: 'numericColumn',
    cellStyle: { fontWeight: 500 },
  },
  {
    field: 'qty_b', headerName: 'Qty B', width: 90, type: 'numericColumn',
    cellStyle: { fontWeight: 500 },
  },
  {
    field: 'qty_diff', headerName: '\u0394 Qty', width: 90, type: 'numericColumn',
    valueFormatter: (p) => p.value > 0 ? `+${p.value}` : String(p.value),
    cellStyle: (p: CellClassParams) =>
      p.value !== 0
        ? { color: p.value > 0 ? '#16A34A' : '#DC2626', fontWeight: 700 }
        : {},
  },
  {
    field: 'unit_of_measure', headerName: 'UoM', width: 80,
    cellClass: (p: CellClassParams) => p.data.qty_diff !== 0 ? 'ag-row-amber' : '',
  },
];

// ─── Summary tile ───────────────────────────────────────────────────────────

function SummaryTile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-5 py-4 flex flex-col items-center gap-1">
      <div className="text-3xl font-bold" style={{ color: accent }}>{value}</div>
      <div className="text-xs text-slate-500 text-center">{label}</div>
    </div>
  );
}

// ─── PV selector ────────────────────────────────────────────────────────────────

interface PVSelectProps {
  pvs: PV[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}

function PVSelect({ pvs, value, onChange, label }: PVSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-500">{label}</label>
      <select
        className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[260px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select Product Variant…</option>
        {pvs.map((pv) => (
          <option key={pv.pv_id} value={pv.pv_id}>
            [{pv.market_code}] {pv.pv_name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Tab panel ──────────────────────────────────────────────────────────────────

type TabKey = 'only_a' | 'both' | 'only_b';

// ─── Main page ───────────────────────────────────────────────────────────────

export default function BOMComparison() {
  const [pvs, setPvs] = useState<PV[]>([]);
  const [pvA, setPvA] = useState('');
  const [pvB, setPvB] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [tab, setTab] = useState<TabKey>('only_a');

  useEffect(() => {
    getPVs().then(setPvs).catch(() => {});
  }, []);

  const pvAName = pvs.find((p) => p.pv_id === pvA)?.pv_name ?? 'PV A';
  const pvBName = pvs.find((p) => p.pv_id === pvB)?.pv_name ?? 'PV B';

  const handleCompare = useCallback(async () => {
    if (!pvA || !pvB) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await compareBOM(pvA, pvB);
      setResult(data);
      setTab('only_a');
    } catch (e: any) {
      setError(e.message ?? 'Comparison failed');
    } finally {
      setLoading(false);
    }
  }, [pvA, pvB]);

  const qtyDiffCount = result?.in_both.filter((r) => r.qty_diff !== 0).length ?? 0;

  const TABS: { key: TabKey; label: string; count: number; accent: string }[] = result
    ? [
        { key: 'only_a', label: `Only in ${pvAName}`, count: result.only_in_a.length, accent: '#DC2626' },
        { key: 'both',   label: 'In Both',             count: result.in_both.length,   accent: '#003087' },
        { key: 'only_b', label: `Only in ${pvBName}`,  count: result.only_in_b.length, accent: '#3B82F6' },
      ]
    : [];

  // Row style for only_a (red tint) and only_b (blue tint)
  const onlyAColDefs: ColDef[] = BASE_COLS.map((c) => ({
    ...c,
    cellStyle: { background: '#FEF2F2' },
  }));
  const onlyBColDefs: ColDef[] = BASE_COLS.map((c) => ({
    ...c,
    cellStyle: { background: '#EFF6FF' },
  }));

  return (
    <div className="flex flex-col gap-0">
      {/* Controls */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-end gap-4">
        <PVSelect pvs={pvs} value={pvA} onChange={setPvA} label="Product Variant A" />
        <div className="flex items-end pb-2">
          <span className="text-slate-400 font-bold text-lg">vs</span>
        </div>
        <PVSelect pvs={pvs} value={pvB} onChange={setPvB} label="Product Variant B" />
        <button
          onClick={handleCompare}
          disabled={!pvA || !pvB || pvA === pvB || loading}
          className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          style={{ background: '#003087' }}
        >
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Summary row */}
      {result && (
        <div className="px-6 py-5 bg-slate-50 border-b border-slate-200">
          <div className="grid grid-cols-4 gap-4 mb-3">
            <SummaryTile label="Common components" value={result.summary.common_count}  accent="#003087" />
            <SummaryTile label={`Unique to ${pvAName}`} value={result.summary.only_a_count} accent="#DC2626" />
            <SummaryTile label={`Unique to ${pvBName}`} value={result.summary.only_b_count} accent="#3B82F6" />
            <SummaryTile label="Qty differences" value={qtyDiffCount} accent="#D97706" />
          </div>
          <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
            <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" /></svg>
            <span className="text-xs text-amber-800">
              <strong>Key insight:</strong> Market-specific components (e.g. regulatory tax stamps) appear in the &ldquo;Unique&rdquo; columns — demonstrating how Snowflake captures market-level BOM variations.
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      {result && (
        <>
          <div className="px-6 pt-4 bg-white border-b border-slate-200 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                  tab === t.key ? 'border-blue-700 text-blue-700 bg-blue-50' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {t.label}
                <span
                  className="text-xs font-bold px-1.5 py-0.5 rounded-full text-white"
                  style={{ background: t.accent }}
                >
                  {t.count}
                </span>
              </button>
            ))}
          </div>

          <div className="p-6">
            {tab === 'only_a' && (
              <BOMGrid rowData={result.only_in_a} columnDefs={onlyAColDefs} title={`Components only in ${pvAName}`} height="400px" />
            )}
            {tab === 'both' && (
              <BOMGrid rowData={result.in_both} columnDefs={IN_BOTH_COLS} title="Components in both PVs (amber rows = qty difference)" height="400px" />
            )}
            {tab === 'only_b' && (
              <BOMGrid rowData={result.only_in_b} columnDefs={onlyBColDefs} title={`Components only in ${pvBName}`} height="400px" />
            )}
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="flex items-center justify-center p-16 text-slate-400 text-sm">
          Select two Product Variants and click Compare to see a side-by-side BOM diff.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center p-16">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <span className="text-sm text-slate-500">Running FULL OUTER JOIN on BOM_CLOSURE…</span>
          </div>
        </div>
      )}
    </div>
  );
}
