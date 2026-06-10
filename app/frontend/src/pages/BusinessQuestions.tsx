import React, { useCallback, useEffect, useRef, useState } from 'react';
import BOMGrid from '../components/BOMGrid';
import { getQuestion, getPVs, PV } from '../api/client';
import { ColDef } from 'ag-grid-community';

// ─── PV Selector component ───────────────────────────────────────────────────

function PVSelector({ value, onChange, label, required }: {
  value: string; onChange: (v: string) => void; label: string; required?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<PV[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (query.length < 3) { setSuggestions([]); return; }
    getPVs().then((all) => {
      const lower = query.toLowerCase();
      setSuggestions(all.filter(p =>
        p.pv_name.toLowerCase().includes(lower) || p.pv_id.toLowerCase().includes(lower)
      ).slice(0, 15));
    }).catch(() => {});
  }, [query]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-500">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Type PV name or ID…"
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-72 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute top-full mt-1 left-0 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-56 overflow-y-auto">
            {suggestions.map(p => (
              <button key={p.pv_id} onMouseDown={() => {
                setQuery(p.pv_name); onChange(p.pv_id); setOpen(false); setSuggestions([]);
              }} className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm flex flex-col border-b border-slate-50 last:border-0">
                <span className="font-medium text-slate-800 truncate">{p.pv_name}</span>
                <span className="text-xs text-slate-400 font-mono">{p.pv_id} · {p.market_code} · {p.brand_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {value && value !== query && (
        <div className="text-xs text-slate-400 font-mono">ID: {value}</div>
      )}
    </div>
  );
}

// ─── Question definitions ─────────────────────────────────────────────────────

type ParamType = 'text' | 'date' | 'number' | 'market_code' | 'pv_id';

interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  placeholder?: string;
  required?: boolean;
}

interface QuestionDef {
  id: number;
  code: string;
  question: string;
  description: string;
  note?: string;
  params: ParamDef[];
  sql: string;
}

const QUESTIONS: QuestionDef[] = [
  {
    id: 1, code: 'BQ-01',
    question: 'What is the tobacco leaf weight required for a given Product Variant?',
    description: 'Calculates cumulative tobacco leaf weight through BOM explosion for planning and procurement.',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT descendant_id, part_name, cum_qty, unit_of_measure
FROM BOM_CLOSURE bc
JOIN PART p ON bc.descendant_id = p.part_id
WHERE bc.ancestor_id = %(pv_id)s
  AND p.category = 'TOBACCO'
ORDER BY cum_qty DESC;`,
  },
  {
    id: 2, code: 'BQ-02',
    question: 'Which Product Variants are active in a given market?',
    description: 'Returns all active PVs for a market, useful for market portfolio reporting.',
    params: [{ key: 'market_code', label: 'Market Code', type: 'market_code', required: true }],
    sql: `SELECT pv_id, pv_name, brand_name, lifecycle_status, effective_date
FROM PRODUCT_VARIANT
WHERE market_code = %(market_code)s
  AND lifecycle_status = 'ACTIVE'
ORDER BY brand_name, pv_name;`,
  },
  {
    id: 3, code: 'BQ-03',
    question: 'Which projects are associated with a Product Variant?',
    description: 'Links a PV back to all PLM projects that created or modified it.',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT pr.project_id, pr.project_name, pr.status, pr.created_date, pr.owner
FROM PROJECT pr
JOIN PROJECT_PV_LINK lnk ON pr.project_id = lnk.project_id
WHERE lnk.pv_id = %(pv_id)s
ORDER BY pr.created_date DESC;`,
  },
  {
    id: 4, code: 'BQ-04',
    question: 'What are the BOM revisions for a Product Variant?',
    description: 'Shows the full audit trail of BOM changes over time.',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT revision_id, effective_date, change_reason, changed_by, eco_id
FROM BOM_REVISION
WHERE pv_id = %(pv_id)s
ORDER BY effective_date DESC;`,
  },
  {
    id: 5, code: 'BQ-05',
    question: 'What parts are required to produce a given PV (full multi-level BOM explosion)?',
    description: 'Recursive BOM explosion returning every direct and indirect component.',
    params: [
      { key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true },
      { key: 'max_depth', label: 'Max Depth (1–8)', type: 'number', placeholder: '6' },
    ],
    sql: `SELECT descendant_id, part_name, category, depth, path, cum_qty, unit_of_measure
FROM BOM_CLOSURE bc
JOIN PART p ON bc.descendant_id = p.part_id
WHERE bc.ancestor_id = %(pv_id)s
  AND bc.depth <= %(max_depth)s
ORDER BY bc.depth, part_name;`,
  },
  {
    id: 6, code: 'BQ-06',
    question: 'Which assemblies or PVs use a given component (Where Used)?',
    description: 'Reverse BOM traversal — finds every product that contains a part.',
    params: [{ key: 'part_id', label: 'Part ID', type: 'text', required: true, placeholder: 'e.g. PART-001' }],
    sql: `SELECT ancestor_id, pv.pv_name, pv.brand_name, pv.market_code, bc.depth, bc.cum_qty
FROM BOM_CLOSURE bc
JOIN PRODUCT_VARIANT pv ON bc.ancestor_id = pv.pv_id
WHERE bc.descendant_id = %(part_id)s
ORDER BY pv.market_code, pv.brand_name;`,
  },
  {
    id: 7, code: 'BQ-07',
    question: 'Compare the BOM of two Product Variants — common and unique components?',
    description: 'FULL OUTER JOIN on BOM_CLOSURE to diff two PVs. Note: may be slow on large datasets due to join cardinality.',
    params: [
      { key: 'pv_a', label: 'PV A', type: 'pv_id', required: true },
      { key: 'pv_b', label: 'PV B', type: 'pv_id', required: true },
    ],
    sql: `WITH a AS (SELECT descendant_id, cum_qty FROM BOM_CLOSURE WHERE ancestor_id = %(pv_a)s),
     b AS (SELECT descendant_id, cum_qty FROM BOM_CLOSURE WHERE ancestor_id = %(pv_b)s)
SELECT COALESCE(a.descendant_id, b.descendant_id) AS part_id,
       a.cum_qty AS qty_a, b.cum_qty AS qty_b,
       CASE WHEN a.descendant_id IS NULL THEN 'ONLY_B'
            WHEN b.descendant_id IS NULL THEN 'ONLY_A'
            ELSE 'BOTH' END AS diff_flag
FROM a FULL OUTER JOIN b ON a.descendant_id = b.descendant_id;`,
    note: 'BQ-07 uses FULL OUTER JOIN on BOM_CLOSURE. For best performance ensure BOM_CLOSURE is clustered on (ancestor_id, descendant_id).',
  },
  {
    id: 8, code: 'BQ-08',
    question: 'What is the Global BOM vs Local BOM for a Product Variant?',
    description: 'Splits components into global (shared across markets) vs local (market-specific, e.g. tax stamps).',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT p.part_id, p.part_name, p.category, p.is_global,
       COUNT(DISTINCT bc2.ancestor_id) AS used_in_pv_count
FROM BOM_CLOSURE bc
JOIN PART p ON bc.descendant_id = p.part_id
LEFT JOIN BOM_CLOSURE bc2 ON bc2.descendant_id = p.part_id
WHERE bc.ancestor_id = %(pv_id)s
GROUP BY 1,2,3,4
ORDER BY p.is_global DESC, p.category;`,
  },
  {
    id: 9, code: 'BQ-09',
    question: 'Which ECOs affect a given product or component?',
    description: 'Finds all open Engineering Change Orders that reference a product or part.',
    params: [{ key: 'item_id', label: 'PV or Part ID', type: 'text', required: true }],
    sql: `SELECT eco.eco_id, eco.eco_type, eco.title, eco.status, eco.created_date,
       eco.owner, eil.item_type
FROM ECO eco
JOIN ECO_ITEM_LINK eil ON eco.eco_id = eil.eco_id
WHERE eil.item_id = %(item_id)s
ORDER BY eco.created_date DESC;`,
  },
  {
    id: 10, code: 'BQ-10',
    question: 'What tobacco blend is used for a given market and production year?',
    description: 'Returns the tobacco blend specification including leaf grades and ratios.',
    params: [
      { key: 'market_code', label: 'Market Code', type: 'market_code', required: true },
      { key: 'production_year', label: 'Production Year', type: 'number', placeholder: '2025', required: true },
    ],
    sql: `SELECT tb.blend_id, tb.blend_name, tbc.leaf_grade, tbc.origin_country,
       tbc.ratio_pct, tb.effective_year
FROM TOBACCO_BLEND tb
JOIN TOBACCO_BLEND_COMPONENT tbc ON tb.blend_id = tbc.blend_id
JOIN PRODUCT_VARIANT pv ON pv.tobacco_blend_id = tb.blend_id
WHERE pv.market_code = %(market_code)s
  AND tb.effective_year = %(production_year)s
ORDER BY tbc.ratio_pct DESC;`,
  },
  {
    id: 11, code: 'BQ-11',
    question: 'Compare the BOM of the same product across two plants?',
    description: 'Cross-plant BOM comparison to identify manufacturing site differences. Uses FULL OUTER JOIN.',
    params: [
      { key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true },
      { key: 'plant_a', label: 'Plant A', type: 'text', required: true, placeholder: 'e.g. PLANT-EU' },
      { key: 'plant_b', label: 'Plant B', type: 'text', required: true, placeholder: 'e.g. PLANT-AP' },
    ],
    sql: `WITH a AS (SELECT descendant_id, cum_qty FROM BOM_CLOSURE
              WHERE ancestor_id = %(pv_id)s AND plant_code = %(plant_a)s),
     b AS (SELECT descendant_id, cum_qty FROM BOM_CLOSURE
              WHERE ancestor_id = %(pv_id)s AND plant_code = %(plant_b)s)
SELECT COALESCE(a.descendant_id, b.descendant_id) AS part_id,
       a.cum_qty AS qty_plant_a, b.cum_qty AS qty_plant_b
FROM a FULL OUTER JOIN b ON a.descendant_id = b.descendant_id;`,
    note: 'BQ-11 uses FULL OUTER JOIN on BOM_CLOSURE. Ensure proper clustering for performance.',
  },
  {
    id: 12, code: 'BQ-12',
    question: 'What are all solutions (SKUs) available for a given market?',
    description: 'Returns all SKU/solution combinations approved for sale in a market.',
    params: [{ key: 'market_code', label: 'Market Code', type: 'market_code', required: true }],
    sql: `SELECT s.solution_id, s.solution_name, s.brand_name, s.format,
       s.nicotine_content, s.lifecycle_status
FROM SOLUTION s
WHERE s.market_code = %(market_code)s
ORDER BY s.brand_name, s.solution_name;`,
  },
  {
    id: 13, code: 'BQ-13',
    question: 'Which parts have had no BOM revision in the last 2 years?',
    description: 'Identifies potentially stale or inactive components for data hygiene review.',
    params: [],
    sql: `SELECT p.part_id, p.part_name, p.category, MAX(br.effective_date) AS last_revision_date,
       DATEDIFF('day', MAX(br.effective_date), CURRENT_DATE()) AS days_since_revision
FROM PART p
LEFT JOIN BOM_REVISION_ITEM bri ON p.part_id = bri.part_id
LEFT JOIN BOM_REVISION br ON bri.revision_id = br.revision_id
GROUP BY 1,2,3
HAVING MAX(br.effective_date) < DATEADD('year', -2, CURRENT_DATE())
    OR MAX(br.effective_date) IS NULL
ORDER BY days_since_revision DESC NULLS FIRST;`,
  },
  {
    id: 14, code: 'BQ-14',
    question: 'Which PVs are planned for commercial launch within a given date range?',
    description: 'Pipeline view of upcoming product launches for market planning.',
    params: [
      { key: 'start_date', label: 'From Date', type: 'date', required: true },
      { key: 'end_date',   label: 'To Date',   type: 'date', required: true },
    ],
    sql: `SELECT pv_id, pv_name, brand_name, market_code, planned_launch_date, lifecycle_status
FROM PRODUCT_VARIANT
WHERE planned_launch_date BETWEEN %(start_date)s AND %(end_date)s
  AND lifecycle_status IN ('DEVELOPMENT', 'PILOT')
ORDER BY planned_launch_date, market_code;`,
  },
  {
    id: 15, code: 'BQ-15',
    question: 'What is the current status of given projects?',
    description: 'Batch project status check. Enter multiple project IDs separated by commas.',
    params: [{
      key: 'project_ids',
      label: 'Project IDs (comma-separated)',
      type: 'text',
      required: true,
      placeholder: 'e.g. PROJ-001, PROJ-002, PROJ-003',
    }],
    sql: `-- project_ids expanded to individual bind params at runtime (injection-safe)
SELECT project_id, project_name, status, owner, created_date,
       target_completion_date, percent_complete
FROM PROJECT
WHERE project_id IN (%(project_ids)s)
ORDER BY created_date DESC;`,
    note: 'project_ids is safely expanded to individual bind parameters at runtime in the backend — no SQL injection risk.',
  },
  {
    id: 16, code: 'BQ-16',
    question: 'Which projects have been waiting for approval for more than N days?',
    description: 'Escalation report for stalled approvals in PLM workflows.',
    params: [{ key: 'days', label: 'Waiting days threshold', type: 'number', placeholder: '14', required: true }],
    sql: `SELECT project_id, project_name, status, owner,
       approval_submitted_date,
       DATEDIFF('day', approval_submitted_date, CURRENT_DATE()) AS waiting_days
FROM PROJECT
WHERE status = 'PENDING_APPROVAL'
  AND DATEDIFF('day', approval_submitted_date, CURRENT_DATE()) > %(days)s
ORDER BY waiting_days DESC;`,
  },
  {
    id: 17, code: 'BQ-17',
    question: 'Which projects are overdue (past target completion date)?',
    description: 'Portfolio health check — identifies at-risk projects for PMO review.',
    params: [],
    sql: `SELECT project_id, project_name, status, owner,
       target_completion_date,
       DATEDIFF('day', target_completion_date, CURRENT_DATE()) AS days_overdue
FROM PROJECT
WHERE target_completion_date < CURRENT_DATE()
  AND status NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY days_overdue DESC;`,
  },
  {
    id: 18, code: 'BQ-18',
    question: 'What are the key milestone dates for a Product Variant?',
    description: 'End-to-end timeline view of a PV through its PLM lifecycle gates.',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT milestone_type, planned_date, actual_date, status,
       DATEDIFF('day', planned_date, COALESCE(actual_date, CURRENT_DATE())) AS variance_days
FROM PV_MILESTONE
WHERE pv_id = %(pv_id)s
ORDER BY planned_date;`,
  },
  {
    id: 19, code: 'BQ-19',
    question: 'Cross-domain: Work orders + project + PV + BOM for end-to-end traceability',
    description: 'The most complex query in the BRD — joins Project, PV, and BOM tables to deliver full product lifecycle traceability in a single result set. This is what ANZO called "interconnect all data points".',
    note: 'Requires a PV that has associated projects. Try searching "Parliament Aqua Blue Slim" or use ID: FA000156.SL',
    params: [{ key: 'pv_id', label: 'Product Variant ID', type: 'pv_id', required: true }],
    sql: `SELECT
    pr.project_id, pr.project_name,
    pr.status AS project_status, pr.phase,
    pv.pv_id, pv.pv_name,
    pv.market_code, pv.brand_name,
    c.descendant_id AS part_id, p.part_name,
    p.category, c.depth AS bom_level,
    c.cum_qty, p.unit_of_measure, p.supplier
FROM PROJECTS pr
JOIN PV_PROJECT lnk      ON lnk.project_id = pr.project_id
JOIN PRODUCT_VARIANTS pv ON pv.pv_id       = lnk.pv_id
JOIN BOM_CLOSURE c       ON c.ancestor_id  = pv.pv_id AND c.depth > 0
JOIN PARTS p             ON p.part_id      = c.descendant_id
WHERE pv.pv_id = %(pv_id)s
ORDER BY pr.project_id, c.depth, p.part_name;`,
  },
];

// ─── Single question accordion item ──────────────────────────────────────────

function QuestionItem({ q }: { q: QuestionDef }) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [cols, setCols] = useState<ColDef[]>([]);
  const [showSQL, setShowSQL] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setParam = useCallback((key: string, value: string) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      const response = await getQuestion(q.id, params);
      const data: any[] = Array.isArray(response) ? response : response.data ?? [];
      setRows(data);
      if (data.length > 0) {
        setCols(
          Object.keys(data[0]).map((k) => ({
            field: k,
            headerName: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            flex: 1,
            minWidth: 100,
          }))
        );
      } else {
        setCols([]);
      }
    } catch (e: any) {
      setError(e.message ?? 'Query failed');
    } finally {
      setLoading(false);
    }
  }, [q.id, params]);

  const canRun = q.params.every((p) => !p.required || (params[p.key] ?? '').trim() !== '');

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      {/* Header */}
      <button
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className="flex-shrink-0 w-14 text-center text-xs font-black px-2 py-1 rounded text-white"
          style={{ background: '#003087' }}
        >
          {q.code}
        </span>
        <span className="flex-1 text-sm font-semibold text-slate-800">{q.question}</span>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Body */}
      {open && (
        <div className="border-t border-slate-100 px-5 py-4 flex flex-col gap-4">
          <p className="text-xs text-slate-500">{q.description}</p>

          {q.note && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <svg className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" /></svg>
              <span className="text-xs text-amber-800">{q.note}</span>
            </div>
          )}

          {/* Param inputs */}
          {q.params.length > 0 && (
            <div className="flex flex-wrap gap-4 items-end">
              {q.params.map((p) => (
                p.type === 'pv_id' ? (
                  <PVSelector
                    key={p.key}
                    label={p.label}
                    required={p.required}
                    value={params[p.key] ?? ''}
                    onChange={(v) => setParam(p.key, v)}
                  />
                ) : (
                  <div key={p.key} className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-slate-500">
                      {p.label}{p.required && <span className="text-red-500 ml-0.5">*</span>}
                    </label>
                    <input
                      ref={p.key === q.params[0]?.key ? inputRef : undefined}
                      type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                      value={params[p.key] ?? ''}
                      onChange={(e) => setParam(p.key, e.target.value)}
                      placeholder={p.placeholder ?? ''}
                      className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm min-w-[180px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                )
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleRun}
              disabled={loading || !canRun}
              className="px-4 py-1.5 text-sm font-semibold text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              style={{ background: '#003087' }}
            >
              {loading ? 'Running…' : 'Run Query'}
            </button>
            <button
              onClick={() => setShowSQL((s) => !s)}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              {showSQL ? 'Hide SQL' : 'Show SQL'}
            </button>
          </div>

          {/* SQL reveal */}
          {showSQL && (
            <pre
              className="rounded-lg p-4 text-xs font-mono overflow-x-auto"
              style={{ background: '#0F172A', color: '#94A3B8', lineHeight: 1.6 }}
            >
              <code>{q.sql}</code>
            </pre>
          )}

          {/* Error */}
          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <div className="w-4 h-4 border border-blue-200 border-t-blue-600 rounded-full animate-spin" />
              Querying Snowflake…
            </div>
          )}

          {/* Results */}
          {rows !== null && !loading && (
            <div>
              {rows.length === 0 ? (
                <div className="text-xs text-slate-400 py-2">No results returned.</div>
              ) : (
                <BOMGrid
                  rowData={rows}
                  columnDefs={cols}
                  title={`${q.code} Results`}
                  height="320px"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function BusinessQuestions() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">Business Requirements</h1>
        <p className="text-sm text-slate-500 mt-1">
          All 19 business requirements from the PMI BRD, answered live from Snowflake.
          Click any question to expand, enter parameters, and run the query.
        </p>
        <div className="mt-3 inline-flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5">
          <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          <span className="text-xs font-medium text-blue-700">
            Each query runs directly on Snowflake — no pre-computed cache
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {QUESTIONS.map((q) => (
          <QuestionItem key={q.id} q={q} />
        ))}
      </div>
    </div>
  );
}
