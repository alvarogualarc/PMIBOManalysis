import React, { useCallback, useState } from 'react';
import { getParts, Part } from '../api/client';
import BOMGrid from '../components/BOMGrid';
import { ColDef } from 'ag-grid-community';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

const BASE = '/api';

async function runSimulation(oldId: string, newId: string) {
  const res = await fetch(`${BASE}/whatif/simulate?old_component=${encodeURIComponent(oldId)}&new_component=${encodeURIComponent(newId)}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Part Selector ───────────────────────────────────────────────────────────

function PartSelector({ label, onSelect, selected }: { label: string; onSelect: (p: Part) => void; selected: Part | null }) {
  const [query, setQuery] = useState('');
  const [parts, setParts] = useState<Part[]>([]);
  const [open, setOpen] = useState(false);

  const handleInput = (val: string) => {
    setQuery(val);
    if (val.length < 2) { setParts([]); return; }
    setOpen(true);
    getParts().then((all) => {
      const lower = val.toLowerCase();
      setParts(all.filter(p =>
        p.part_name.toLowerCase().includes(lower) || p.part_id.toLowerCase().includes(lower)
      ).slice(0, 15));
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      <div className="relative">
        <input
          value={selected ? selected.part_name : query}
          onChange={(e) => { if (selected) { onSelect(null as any); setQuery(e.target.value); } handleInput(e.target.value); }}
          onFocus={() => { if (!selected) setOpen(true); }}
          placeholder="Search part name or ID…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {selected && (
          <button
            onClick={() => { onSelect(null as any); setQuery(''); setParts([]); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-lg leading-none"
          >×</button>
        )}
        {open && !selected && parts.length > 0 && (
          <div className="absolute top-full mt-1 left-0 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-56 overflow-y-auto">
            {parts.map(p => (
              <button
                key={p.part_id}
                onMouseDown={() => { onSelect(p); setQuery(''); setOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm flex flex-col"
              >
                <span className="font-medium text-slate-800">{p.part_name}</span>
                <span className="text-xs text-slate-400 font-mono">{p.part_id} · {p.category}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div className="text-xs text-slate-500 font-mono">
          {selected.part_id} · <span className="text-blue-600">{selected.category}</span>
        </div>
      )}
    </div>
  );
}

// ─── Column defs ─────────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { field: 'pv_id',                headerName: 'PV ID',           width: 150, cellStyle: { fontFamily: 'monospace', fontSize: 12 } },
  { field: 'pv_name',             headerName: 'Product Variant',  flex: 2 },
  { field: 'brand_name',          headerName: 'Brand',            width: 130 },
  { field: 'market_code',         headerName: 'Market',           width: 90 },
  { field: 'lifecycle_status',    headerName: 'Status',           width: 120 },
  { field: 'original_component',  headerName: 'Original Part',    width: 220, cellStyle: { color: '#DC2626' } },
  { field: 'replacement_component', headerName: 'Replacement',    width: 220, cellStyle: { color: '#16A34A' } },
  { field: 'cum_qty',             headerName: 'Qty',              width: 80,  type: 'numericColumn' },
  { field: 'depth',               headerName: 'BOM Level',        width: 100, type: 'numericColumn' },
];

const CHART_COLORS = ['#003087','#3B82F6','#16A34A','#D97706','#DC2626','#7C3AED','#64748B','#0EA5E9','#F59E0B'];

// ─── Main page ───────────────────────────────────────────────────────────────

export default function WhatIfSimulator() {
  const [oldPart, setOldPart]   = useState<Part | null>(null);
  const [newPart, setNewPart]   = useState<Part | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<any | null>(null);

  const handleRun = useCallback(async () => {
    if (!oldPart || !newPart) return;
    if (oldPart.part_id === newPart.part_id) {
      setError('Original and replacement parts must be different.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await runSimulation(oldPart.part_id, newPart.part_id);
      setResult(data);
    } catch (e: any) {
      setError(e.message ?? 'Simulation failed');
    } finally {
      setLoading(false);
    }
  }, [oldPart, newPart]);

  const marketData = result
    ? result.summary.markets.map((m: string) => ({
        market: m,
        count: result.affected_pvs.filter((r: any) => r.market_code === m).length,
      }))
    : [];

  return (
    <div className="flex flex-col gap-0 min-h-full">

      {/* Controls */}
      <div className="bg-white border-b border-slate-200 px-6 py-5">
        <h2 className="text-base font-bold text-slate-800 mb-4">What-If BOM Simulator</h2>
        <div className="flex flex-wrap items-end gap-6">
          <PartSelector label="Replace this component" onSelect={setOldPart} selected={oldPart} />

          {/* Arrow */}
          <div className="text-2xl text-slate-400 mb-2 select-none">→</div>

          <PartSelector label="With this replacement" onSelect={setNewPart} selected={newPart} />

          <button
            onClick={handleRun}
            disabled={!oldPart || !newPart || loading}
            className="px-6 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity mb-0.5"
            style={{ background: '#003087' }}
          >
            {loading ? 'Running…' : 'Run Simulation'}
          </button>
        </div>

        {/* Part detail comparison */}
        {oldPart && newPart && (
          <div className="mt-4 grid grid-cols-2 gap-4 max-w-2xl">
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <div className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">Original</div>
              <div className="text-sm font-bold text-slate-800">{oldPart.part_name}</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">{oldPart.part_id}</div>
              <div className="text-xs text-slate-500 mt-0.5">{oldPart.category}</div>
            </div>
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
              <div className="text-xs font-semibold text-green-600 uppercase tracking-wide mb-1">Replacement</div>
              <div className="text-sm font-bold text-slate-800">{newPart.part_name}</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">{newPart.part_id}</div>
              <div className="text-xs text-slate-500 mt-0.5">{newPart.category}</div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Results */}
      {result && (
        <div className="flex flex-col gap-6 px-6 py-6">

          {/* Impact summary tiles */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
              <div className="text-3xl font-bold text-slate-800">{result.summary.total_pvs.toLocaleString()}</div>
              <div className="text-sm text-slate-500 mt-1">Product Variants affected</div>
              <div className="text-xs text-red-500 mt-1">Would require BOM update</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
              <div className="text-3xl font-bold text-slate-800">{result.summary.markets_count}</div>
              <div className="text-sm text-slate-500 mt-1">Markets affected</div>
              <div className="text-xs text-slate-400 mt-1">{result.summary.markets.slice(0, 5).join(', ')}{result.summary.markets.length > 5 ? ` +${result.summary.markets.length - 5} more` : ''}</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
              <div className="text-3xl font-bold text-slate-800">{result.summary.brands_count}</div>
              <div className="text-sm text-slate-500 mt-1">Brands affected</div>
              <div className="text-xs text-slate-400 mt-1">{result.summary.brands.join(', ')}</div>
            </div>
          </div>

          {/* Market breakdown chart */}
          {marketData.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
              <h3 className="text-sm font-semibold text-slate-700 mb-4">Affected PVs by Market</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={marketData} margin={{ top: 0, right: 20, bottom: 40, left: 0 }}>
                  <XAxis dataKey="market" angle={-45} textAnchor="end" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {marketData.map((_: any, i: number) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Affected PVs grid */}
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700">Affected Product Variants</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Each row shows a PV where <span className="font-mono text-red-600">{result.affected_pvs[0]?.original_component}</span> would be replaced by{' '}
                <span className="font-mono text-green-600">{result.affected_pvs[0]?.replacement_component}</span>. No data has been changed.
              </p>
            </div>
            <BOMGrid rowData={result.affected_pvs} columnDefs={COLS} height="420px" />
          </div>

        </div>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <div className="flex flex-col items-center justify-center flex-1 py-24 text-slate-400">
          <div className="text-5xl mb-4">⇄</div>
          <div className="text-base font-medium">Select two components and run the simulation</div>
          <div className="text-sm mt-2">No data is modified — this is a read-only overlay on the BOM closure table</div>
        </div>
      )}

    </div>
  );
}
