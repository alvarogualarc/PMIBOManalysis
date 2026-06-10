import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BOMGrid from '../components/BOMGrid';
import { ColDef } from 'ag-grid-community';

const BASE = '/api';

async function fetchJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

interface AttrSchema {
  attribute_name: string;
  attribute_unit: string | null;
  distinct_values: number;
  sample_values: string[];
  is_numeric: boolean;
}

interface ActiveFilter { name: string; value: string; }

// ─── Filter chip ─────────────────────────────────────────────────────────────

function FilterChip({ name, value, unit, onRemove }: {
  name: string; value: string; unit?: string | null; onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
      {name} = {value}{unit ? ` ${unit}` : ''}
      <button onClick={onRemove} className="ml-1 text-blue-500 hover:text-blue-800 font-bold leading-none">×</button>
    </span>
  );
}

// ─── Add filter row ───────────────────────────────────────────────────────────

function AddFilterRow({ schema, onAdd }: {
  schema: AttrSchema[];
  onAdd: (filter: ActiveFilter) => void;
}) {
  const [selectedAttr, setSelectedAttr] = useState('');
  const [value, setValue] = useState('');

  const attrDef = schema.find(s => s.attribute_name === selectedAttr);
  const discreteValues = attrDef && !attrDef.is_numeric ? attrDef.sample_values : [];

  const handleAdd = () => {
    if (!selectedAttr || !value) return;
    onAdd({ name: selectedAttr, value });
    setSelectedAttr('');
    setValue('');
  };

  return (
    <div className="flex items-end gap-2 flex-wrap">
      {/* Attribute selector */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-500 font-medium">Attribute</label>
        <select
          value={selectedAttr}
          onChange={e => { setSelectedAttr(e.target.value); setValue(''); }}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm min-w-[180px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select attribute…</option>
          {schema.map(s => (
            <option key={s.attribute_name} value={s.attribute_name}>
              {s.attribute_name.replace(/_/g, ' ')}{s.attribute_unit ? ` (${s.attribute_unit})` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Value input: dropdown for discrete, text/number for numeric */}
      {selectedAttr && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 font-medium">
            Value{attrDef?.attribute_unit ? ` (${attrDef.attribute_unit})` : ''}
          </label>
          {discreteValues.length > 0 ? (
            <select
              value={value}
              onChange={e => setValue(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm min-w-[140px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select value…</option>
              {discreteValues.sort().map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          ) : (
            <input
              type={attrDef?.is_numeric ? 'number' : 'text'}
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={attrDef?.is_numeric ? 'Enter value…' : 'Enter value…'}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-36 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>
      )}

      <button
        onClick={handleAdd}
        disabled={!selectedAttr || !value}
        className="px-4 py-1.5 text-sm font-semibold text-white rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
        style={{ background: '#003087' }}
      >
        + Add Filter
      </button>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function MaterialsExplorer() {
  const navigate = useNavigate();
  const [categories, setCategories]   = useState<Array<{category: string; parts_with_attributes: number}>>([]);
  const [selectedCat, setSelectedCat] = useState('');
  const [schema, setSchema]           = useState<AttrSchema[]>([]);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [result, setResult]           = useState<any | null>(null);

  // Load categories on mount
  useEffect(() => {
    fetchJSON(`${BASE}/attributes/categories`).then(setCategories).catch(() => {});
  }, []);

  // Load schema when category changes
  useEffect(() => {
    setSchema([]); setActiveFilters([]); setResult(null);
    if (!selectedCat) return;
    fetchJSON(`${BASE}/attributes/schema?category=${encodeURIComponent(selectedCat)}`)
      .then(setSchema).catch(() => {});
  }, [selectedCat]);

  const handleSearch = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const filtersObj: Record<string,string> = {};
      activeFilters.forEach(f => { filtersObj[f.name] = f.value; });
      const filtersParam = Object.keys(filtersObj).length
        ? `&filters=${encodeURIComponent(JSON.stringify(filtersObj))}`
        : '';
      const catParam = selectedCat ? `category=${encodeURIComponent(selectedCat)}` : '';
      const data = await fetchJSON(`${BASE}/attributes/filter?${catParam}${filtersParam}`);
      setResult(data);
    } catch (e: any) {
      setError(e.message ?? 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [selectedCat, activeFilters]);

  // Build AG Grid column defs dynamically from result
  const cols: ColDef[] = result?.data?.length
    ? [
        { field: 'part_id',        headerName: 'Part ID',     width: 200, cellStyle: { fontFamily: 'monospace', fontSize: 12 } },
        { field: 'part_name',      headerName: 'Name',        flex: 2 },
        { field: 'category',       headerName: 'Category',    width: 140 },
        { field: 'supplier',       headerName: 'Supplier',    width: 160 },
        { field: 'standard_cost',  headerName: 'Std Cost',    width: 100, type: 'numericColumn' },
        { field: 'used_in_pvs',    headerName: 'Used in PVs', width: 110, type: 'numericColumn' },
        // Dynamic attribute columns from first row's attributes object
        ...Object.keys(result.data[0]?.attributes ?? {}).map((attr: string) => ({
          headerName: attr.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          valueGetter: (p: any) => p.data?.attributes?.[attr] ?? '—',
          width: 130,
        })),
      ]
    : [];

  return (
    <div className="flex flex-col gap-0 min-h-full">

      {/* Controls */}
      <div className="bg-white border-b border-slate-200 px-6 py-5">
        <h2 className="text-base font-bold text-slate-800 mb-4">Materials Explorer</h2>
        <p className="text-xs text-slate-500 mb-4">
          Filter materials by category-specific attributes. Each category has its own attribute schema — no fixed columns.
        </p>

        {/* Category selector */}
        <div className="flex items-end gap-4 flex-wrap mb-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Material Category</label>
            <select
              value={selectedCat}
              onChange={e => setSelectedCat(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm min-w-[200px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All categories</option>
              {categories.map(c => (
                <option key={c.category} value={c.category}>
                  {c.category} ({c.parts_with_attributes} parts)
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
            style={{ background: '#003087' }}
          >
            {loading ? 'Searching…' : 'Search Materials'}
          </button>
        </div>

        {/* Dynamic filter builder */}
        {schema.length > 0 && (
          <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
            <div className="text-xs font-semibold text-slate-600 mb-3 uppercase tracking-wide">
              Filter by {selectedCat} Attributes
            </div>

            {/* Active filters as chips */}
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {activeFilters.map((f, i) => {
                  const attrDef = schema.find(s => s.attribute_name === f.name);
                  return (
                    <FilterChip
                      key={i}
                      name={f.name.replace(/_/g, ' ')}
                      value={f.value}
                      unit={attrDef?.attribute_unit}
                      onRemove={() => setActiveFilters(prev => prev.filter((_, j) => j !== i))}
                    />
                  );
                })}
                <button
                  onClick={() => setActiveFilters([])}
                  className="text-xs text-slate-400 hover:text-red-500 underline"
                >
                  Clear all
                </button>
              </div>
            )}

            <AddFilterRow
              schema={schema.filter(s => !activeFilters.some(f => f.name === s.attribute_name))}
              onAdd={f => setActiveFilters(prev => [...prev, f])}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Results */}
      {result && (
        <div className="px-6 py-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-sm font-semibold text-slate-700">
              {result.count} material{result.count !== 1 ? 's' : ''} found
            </span>
            {result.filters_applied && Object.keys(result.filters_applied).length > 0 && (
              <span className="text-xs text-slate-400">
                with {Object.keys(result.filters_applied).length} filter{Object.keys(result.filters_applied).length > 1 ? 's' : ''} applied
              </span>
            )}
            <span className="text-xs text-slate-300">— click a row to see Where Used</span>
          </div>
          <BOMGrid
            rowData={result.data}
            columnDefs={cols}
            height="520px"
            onRowClick={(row) => navigate(`/where-used?part_id=${encodeURIComponent(row.part_id)}`)}
          />
        </div>
      )}

      {/* Empty state */}
      {!result && !loading && (
        <div className="flex flex-col items-center justify-center flex-1 py-24 text-slate-400">
          <div className="text-5xl mb-4">🔍</div>
          <div className="text-base font-medium">Select a material category and apply attribute filters</div>
          <div className="text-sm mt-2 max-w-md text-center">
            Each category has its own schema — Tobacco Leaf shows leaf grade and origin,
            Filter Component shows diameter and pressure drop, Packaging shows substrate and recyclability.
          </div>
        </div>
      )}
    </div>
  );
}
