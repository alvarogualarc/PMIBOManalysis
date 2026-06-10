import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BOMTree from '../components/BOMTree';
import BOMGrid from '../components/BOMGrid';
import {
  getBrands,
  getMarkets,
  getPVs,
  getParts,
  explodeBOM,
  ExplodeResponse,
  BOMNode,
  PV,
  Market,
  Part,
} from '../api/client';
import { ColDef } from 'ag-grid-community';

// ─── KPI tile ───────────────────────────────────────────────────────────

function StatTile({ label, value, accent = '#003087' }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-5 py-4">
      <div className="text-2xl font-bold" style={{ color: accent }}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </div>
  );
}

// ─── Column defs for table view ──────────────────────────────────────────────

const BOM_COLS: ColDef[] = [
  { field: 'descendant_id', headerName: 'Part ID',        width: 130 },
  { field: 'part_name',     headerName: 'Part Name',      flex: 2 },
  { field: 'category',      headerName: 'Category',       width: 120 },
  { field: 'depth',         headerName: 'BOM Level',      width: 100, type: 'numericColumn' },
  { field: 'path',          headerName: 'Path',           flex: 2 },
  { field: 'cum_qty',       headerName: 'Qty (Cum)',      width: 110, type: 'numericColumn' },
  { field: 'unit_of_measure', headerName: 'UoM',          width: 80 },
  { field: 'supplier',      headerName: 'Supplier',       width: 150 },
  { field: 'std_cost',      headerName: 'Std Cost',       width: 110, type: 'numericColumn',
    valueFormatter: (p) => p.value != null ? `$${Number(p.value).toFixed(4)}` : '—' },
];

// ─── Part detail side panel ──────────────────────────────────────────────

interface PartPanelProps {
  nodeId: string;
  nodeData: any;
  onClose: () => void;
  onWhereUsed: (partId: string) => void;
}

function PartPanel({ nodeId, nodeData, onClose, onWhereUsed }: PartPanelProps) {
  return (
    <div className="w-72 flex-shrink-0 bg-white border-l border-slate-200 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100" style={{ background: '#003087' }}>
        <span className="text-sm font-semibold text-white">Part Details</span>
        <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <div className="text-xs text-slate-400 font-medium">Part ID</div>
          <div className="text-sm font-mono text-slate-700 mt-0.5">{nodeId}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">Part Name</div>
          <div className="text-sm font-semibold text-slate-800 mt-0.5">{nodeData?.part_name ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">Category</div>
          <div className="text-sm text-slate-700 mt-0.5">{nodeData?.category ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">Cumulative Qty</div>
          <div className="text-sm text-slate-700 mt-0.5">{nodeData?.cum_qty ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">Supplier</div>
          <div className="text-sm text-slate-700 mt-0.5">{nodeData?.supplier || '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">BOM Depth</div>
          <div className="text-sm text-slate-700 mt-0.5">Level {nodeData?.depth ?? '—'}</div>
        </div>
      </div>
      <div className="mt-auto p-4 border-t border-slate-100">
        <button
          onClick={() => onWhereUsed(nodeId)}
          className="w-full py-2 text-sm font-semibold text-white rounded-lg transition-opacity hover:opacity-90"
          style={{ background: '#003087' }}
        >
          Analyze Where Used →
        </button>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function BOMExplosion() {
  const navigate = useNavigate();

  // Mode: 'pv' = start from Product Variant, 'part' = start from any component
  const [startMode, setStartMode] = useState<'pv' | 'part'>('pv');

  // PV-mode state
  const [brands, setBrands] = useState<string[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [pvs, setPvs] = useState<PV[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedMarket, setSelectedMarket] = useState('');
  const [selectedPV, setSelectedPV] = useState('');

  // Part-mode state
  const [partQuery, setPartQuery] = useState('');
  const [partSuggestions, setPartSuggestions] = useState<Part[]>([]);
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [partDropOpen, setPartDropOpen] = useState(false);

  const [depth, setDepth] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplodeResponse | null>(null);
  const [view, setView] = useState<'tree' | 'table'>('tree');
  const [selectedNode, setSelectedNode] = useState<{ id: string; data: any } | null>(null);

  // Load brands + markets on mount
  useEffect(() => {
    getBrands().then(setBrands).catch(() => {});
    getMarkets().then(setMarkets).catch(() => {});
  }, []);

  // Load PVs when brand or market changes (PV mode only)
  useEffect(() => {
    if (startMode !== 'pv') return;
    if (!selectedBrand && !selectedMarket) { setPvs([]); return; }
    getPVs({ brand_name: selectedBrand || undefined, market_code: selectedMarket || undefined })
      .then(setPvs).catch(() => {});
    setSelectedPV('');
  }, [selectedBrand, selectedMarket, startMode]);

  // Part search (part mode)
  useEffect(() => {
    if (startMode !== 'part' || partQuery.length < 2) { setPartSuggestions([]); return; }
    getParts().then((all) => {
      const lower = partQuery.toLowerCase();
      setPartSuggestions(all.filter(p =>
        p.part_name.toLowerCase().includes(lower) || p.part_id.toLowerCase().includes(lower)
      ).slice(0, 15));
    }).catch(() => {});
  }, [partQuery, startMode]);

  // The ID to explode from — either a PV or any part
  const ancestorId = startMode === 'pv' ? selectedPV : (selectedPart?.part_id ?? '');

  const handleExplode = useCallback(async () => {
    if (!ancestorId) return;
    setLoading(true); setError(null); setResult(null); setSelectedNode(null);
    try {
      const data = await explodeBOM(ancestorId, depth);
      setResult(data);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load BOM');
    } finally {
      setLoading(false);
    }
  }, [ancestorId, depth]);

  const handleNodeClick = useCallback((nodeId: string, nodeData: any) => {
    setSelectedNode({ id: nodeId, data: nodeData });
  }, []);

  const handleWhereUsed = useCallback((partId: string) => {
    navigate(`/where-used?part_id=${encodeURIComponent(partId)}`);
  }, [navigate]);

  const uniqueCategories = result
    ? new Set(result.table_data.map((r) => r.category)).size
    : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-end gap-4">

        {/* Mode toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Start from</label>
          <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm">
            {(['pv', 'part'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setStartMode(m); setResult(null); setError(null); }}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  startMode === m ? 'text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
                style={startMode === m ? { background: '#003087' } : {}}
              >
                {m === 'pv' ? 'Product Variant' : 'Any Component'}
              </button>
            ))}
          </div>
        </div>

        {/* PV mode: Brand → Market → PV cascade */}
        {startMode === 'pv' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Brand</label>
              <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[140px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={selectedBrand} onChange={(e) => setSelectedBrand(e.target.value)}>
                <option value="">All Brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Market</label>
              <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[140px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={selectedMarket} onChange={(e) => setSelectedMarket(e.target.value)}>
                <option value="">All Markets</option>
                {markets.map((m) => <option key={m.market_code} value={m.market_code}>{m.market_code} — {m.market_name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Product Variant</label>
              <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[240px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={selectedPV} onChange={(e) => setSelectedPV(e.target.value)}>
                <option value="">Select a PV…</option>
                {pvs.map((pv) => <option key={pv.pv_id} value={pv.pv_id}>{pv.pv_name}</option>)}
              </select>
            </div>
          </>
        )}

        {/* Part mode: searchable component dropdown */}
        {startMode === 'part' && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Component / Sub-assembly</label>
            <div className="relative">
              <input
                value={selectedPart ? selectedPart.part_name : partQuery}
                onChange={(e) => { if (selectedPart) { setSelectedPart(null); } setPartQuery(e.target.value); setPartDropOpen(true); }}
                onFocus={() => setPartDropOpen(true)}
                placeholder="Search part name or ID…"
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-80 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {selectedPart && (
                <button onClick={() => { setSelectedPart(null); setPartQuery(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">×</button>
              )}
              {partDropOpen && !selectedPart && partSuggestions.length > 0 && (
                <div className="absolute top-full mt-1 left-0 w-80 bg-white border border-slate-200 rounded-lg shadow-lg z-20 max-h-56 overflow-y-auto">
                  {partSuggestions.map(p => (
                    <button key={p.part_id} onMouseDown={() => { setSelectedPart(p); setPartQuery(''); setPartDropOpen(false); }}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm flex flex-col">
                      <span className="font-medium text-slate-800">{p.part_name}</span>
                      <span className="text-xs text-slate-400 font-mono">{p.part_id} · {p.category}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedPart && (
              <div className="text-xs text-slate-500 font-mono mt-0.5">
                {selectedPart.part_id} · <span className="text-blue-600">{selectedPart.category}</span>
                <span className="ml-2 text-amber-600 font-sans">↳ shows sub-components of this part</span>
              </div>
            )}
          </div>
        )}

        {/* Depth + button (always shown) */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Depth: {depth}</label>
          <input type="range" min={1} max={8} step={1} value={depth}
            onChange={(e) => setDepth(Number(e.target.value))} className="w-28 accent-blue-600" />
        </div>

        <button
          onClick={handleExplode}
          disabled={!ancestorId || loading}
          className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          style={{ background: '#003087' }}
        >
          {loading ? 'Loading…' : 'Explore BOM'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Stats row */}
      {result && (
        <div className="grid grid-cols-4 gap-4 px-6 py-4 bg-slate-50 border-b border-slate-200">
          <StatTile label="Total Components" value={result.stats.total_components} />
          <StatTile label="Max BOM Depth" value={result.stats.max_depth} accent="#3B82F6" />
          <StatTile label="Unique Categories" value={uniqueCategories} accent="#16A34A" />
          <StatTile label="Est. Total Cost" value={result.stats.total_cost_estimate != null ? `$${result.stats.total_cost_estimate.toFixed(2)}` : '—'} accent="#D97706" />
        </div>
      )}

      {/* View toggle */}
      {result && (
        <div className="px-6 pt-4 flex gap-1 bg-white border-b border-slate-200">
          {(['tree', 'table'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-5 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                view === v
                  ? 'border-blue-700 text-blue-700 bg-blue-50'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {v === 'tree' ? 'Tree View' : 'Table View'}
            </button>
          ))}
        </div>
      )}

      {/* Content area */}
      <div className="flex flex-1 min-h-0">
        {result && view === 'tree' && (
          <>
            <div className="flex-1 min-w-0" style={{ height: '100%' }}>
              <BOMTree
                data={result.tree_data}
                onNodeClick={handleNodeClick}
              />
            </div>
            {selectedNode && (
              <PartPanel
                nodeId={selectedNode.id}
                nodeData={selectedNode.data}
                onClose={() => setSelectedNode(null)}
                onWhereUsed={handleWhereUsed}
              />
            )}
          </>
        )}

        {result && view === 'table' && (
          <div className="flex-1 p-6 overflow-auto">
            <BOMGrid
              rowData={result.table_data}
              columnDefs={BOM_COLS}
              title="BOM Components"
            />
          </div>
        )}

        {!result && !loading && (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
            {startMode === 'pv'
              ? 'Select a Product Variant and click "Explore BOM"'
              : 'Select any component or sub-assembly and click "Explore BOM" to see its sub-tree'}
          </div>
        )}

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
              <span className="text-sm text-slate-500">Exploding BOM in Snowflake…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
