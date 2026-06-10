// ─── API Response Interfaces ─────────────────────────────────────────────────

export interface BOMNode {
  id: string;
  data: {
    label: string;
    category: string;
    cum_qty: number;
    depth: number;
    part_name: string;
    supplier: string;
  };
  children: BOMNode[];
  position?: { x: number; y: number };
}

export interface BOMRow {
  descendant_id: string;
  part_name: string;
  category: string;
  depth: number;
  path: string;
  cum_qty: number;
  unit_of_measure: string;
  supplier?: string;
  std_cost?: number;
}

export interface ExplodeResponse {
  table_data: BOMRow[];
  tree_data: BOMNode[];
  stats: {
    total_components: number;
    max_depth: number;
    total_cost_estimate: number;
  };
}

export interface WhereUsedRow {
  ancestor_id: string;
  pv_name: string;
  brand_name: string;
  market_code: string;
  lifecycle_status: string;
  depth: number;
  cum_qty: number;
}

export interface WhereUsedResponse {
  data: WhereUsedRow[];
  total_pvs_affected: number;
  markets_affected: string[];
}

export interface CompareResponse {
  only_in_a: BOMRow[];
  only_in_b: BOMRow[];
  in_both: Array<BOMRow & { qty_a: number; qty_b: number; qty_diff: number }>;
  summary: {
    common_count: number;
    only_a_count: number;
    only_b_count: number;
    qty_diff_count: number;
  };
}

export interface ImpactResponse {
  affected_pvs: Array<{
    pv_id: string;
    pv_name: string;
    brand_name: string;
    market_code: string;
    lifecycle_status: string;
  }>;
  open_ecos: Array<{
    eco_id: string;
    eco_type: string;
    title: string;
    created_date: string;
    status: string;
  }>;
  summary: {
    total_pvs: number;
    markets_count: number;
    open_ecos_count: number;
    brands_affected: string[];
  };
}

export interface PV {
  pv_id: string;
  pv_name: string;
  market_code: string;
  brand_name: string;
  lifecycle_status: string;
}

export interface Part {
  part_id: string;
  part_name: string;
  category: string;
  unit_of_measure?: string;
  supplier?: string;
}

export interface Market {
  market_code: string;
  market_name: string;
  region?: string;
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

// ─── API Functions ────────────────────────────────────────────────────────────

export function explodeBOM(pvId: string, maxDepth = 6): Promise<ExplodeResponse> {
  return request<ExplodeResponse>(`/bom/explode${buildQuery({ pv_id: pvId, max_depth: maxDepth })}`);
}

export function whereUsed(partId: string): Promise<WhereUsedResponse> {
  return request<WhereUsedResponse>(`/bom/where-used${buildQuery({ part_id: partId })}`);
}

export function compareBOM(pvA: string, pvB: string): Promise<CompareResponse> {
  return request<CompareResponse>(`/compare/bom${buildQuery({ pv_a: pvA, pv_b: pvB })}`);
}

export function getImpact(partId: string): Promise<ImpactResponse> {
  return request<ImpactResponse>(`/impact/part${buildQuery({ part_id: partId })}`);
}

export function getPVs(filters?: { market_code?: string; brand_name?: string }): Promise<PV[]> {
  return request<PV[]>(`/pvs${buildQuery(filters ?? {})}`);
}

export function getParts(category?: string): Promise<Part[]> {
  return request<Part[]>(`/parts${buildQuery({ category })}`);
}

export function getMarkets(): Promise<Market[]> {
  return request<Market[]>('/markets');
}

export function getBrands(): Promise<string[]> {
  return request<string[]>('/brands');
}

export function getQuestion(id: number, params: Record<string, string>): Promise<any> {
  return request<any>(`/questions/${id}${buildQuery(params)}`);
}

export function getHealth(): Promise<{ status: string; active_pvs: number; total_parts: number; open_ecos: number; pending_approvals: number }> {
  return request('/health');
}
