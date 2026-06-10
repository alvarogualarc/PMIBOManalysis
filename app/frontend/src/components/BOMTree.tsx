import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
  Node,
  Edge,
  NodeProps,
  Handle,
  Position,
  MarkerType,
  FitViewOptions,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { BOMNode } from '../api/client';

// ─── Category color map ─────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, { bg: string; border: string; badge: string; text: string }> = {
  tobacco:   { bg: '#FEF3C7', border: '#D97706', badge: '#D97706', text: '#92400E' },
  filter:    { bg: '#F1F5F9', border: '#64748B', badge: '#64748B', text: '#334155' },
  packaging: { bg: '#EFF6FF', border: '#3B82F6', badge: '#3B82F6', text: '#1E40AF' },
  leaf:      { bg: '#F0FDF4', border: '#16A34A', badge: '#16A34A', text: '#14532D' },
  regulatory:{ bg: '#FEF2F2', border: '#DC2626', badge: '#DC2626', text: '#7F1D1D' },
  htu:       { bg: '#F5F3FF', border: '#7C3AED', badge: '#7C3AED', text: '#4C1D95' },
  default:   { bg: '#F8FAFC', border: '#94A3B8', badge: '#94A3B8', text: '#475569' },
};

function categoryColors(cat: string) {
  const key = cat?.toLowerCase() ?? '';
  for (const k of Object.keys(CATEGORY_COLORS)) {
    if (key.includes(k)) return CATEGORY_COLORS[k];
  }
  return CATEGORY_COLORS.default;
}

// ─── Custom node ──────────────────────────────────────────────────────────

interface BOMNodeData extends Record<string, unknown> {
  label: string;
  category: string;
  cum_qty: number;
  depth: number;
  part_name: string;
  supplier: string;
}

function BOMFlowNode({ data, selected }: NodeProps) {
  const d = data as BOMNodeData;
  const colors = categoryColors(d.category);
  return (
    <div
      style={{
        background: colors.bg,
        border: `2px solid ${selected ? '#003087' : colors.border}`,
        borderRadius: 10,
        width: 220,
        padding: '8px 10px',
        boxShadow: selected ? '0 4px 16px rgba(0,48,135,0.25)' : '0 1px 4px rgba(0,0,0,0.10)',
        transition: 'box-shadow 0.15s, border-color 0.15s',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: colors.border }} />
      {/* Category badge */}
      <span
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          background: colors.badge,
          color: '#fff',
          fontSize: 9,
          fontWeight: 700,
          borderRadius: 4,
          padding: '1px 5px',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {d.category}
      </span>
      <div style={{ fontWeight: 700, fontSize: 12, color: colors.text, paddingRight: 60, lineHeight: 1.3 }}>
        {d.part_name || d.label}
      </div>
      <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>
        Qty: <strong>{d.cum_qty}</strong>
        {d.supplier && <span style={{ marginLeft: 8, opacity: 0.7 }}>{d.supplier}</span>}
      </div>
      <div style={{
        position: 'absolute',
        bottom: 5,
        right: 8,
        fontSize: 9,
        color: colors.border,
        fontWeight: 600,
        opacity: 0.7,
      }}>
        L{d.depth}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: colors.border }} />
    </div>
  );
}

const nodeTypes = { bomNode: BOMFlowNode };

// ─── Tree layout algorithm ──────────────────────────────────────────────

const H_GAP = 260;
const V_GAP = 130;

function countLeaves(node: BOMNode): number {
  if (!node.children || node.children.length === 0) return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

function layoutTree(
  node: BOMNode,
  depth: number,
  xOffset: number,
  nodes: Node[],
  edges: Edge[],
  parentId?: string
): number {
  const leafCount = countLeaves(node);
  const x = xOffset + (leafCount * H_GAP) / 2 - H_GAP / 2;
  const y = depth * V_GAP;

  nodes.push({
    id: node.id,
    type: 'bomNode',
    position: { x, y },
    data: { ...node.data },
  });

  if (parentId) {
    edges.push({
      id: `e-${parentId}-${node.id}`,
      source: parentId,
      target: node.id,
      animated: true,
      style: { stroke: '#94A3B8', strokeDasharray: '5,3', strokeWidth: 1.5 },
      label: String(node.data.cum_qty),
      labelStyle: { fontSize: 10, fill: '#64748B', fontWeight: 600 },
      labelBgStyle: { fill: '#F8FAFC', fillOpacity: 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94A3B8', width: 12, height: 12 },
    });
  }

  let childX = xOffset;
  for (const child of node.children ?? []) {
    const childLeaves = countLeaves(child);
    layoutTree(child, depth + 1, childX, nodes, edges, node.id);
    childX += childLeaves * H_GAP;
  }

  return leafCount;
}

function buildFlowGraph(treeData: BOMNode[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let xOffset = 0;
  for (const root of treeData) {
    const leaves = countLeaves(root);
    layoutTree(root, 0, xOffset, nodes, edges);
    xOffset += leaves * H_GAP;
  }
  return { nodes, edges };
}

// ─── Legend ─────────────────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { label: 'Tobacco',    color: '#D97706' },
  { label: 'Filter',     color: '#64748B' },
  { label: 'Packaging',  color: '#3B82F6' },
  { label: 'Leaf/Raw',   color: '#16A34A' },
  { label: 'Regulatory', color: '#DC2626' },
  { label: 'HTU',        color: '#7C3AED' },
];

function Legend() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #E2E8F0',
        borderRadius: 8,
        padding: '8px 12px',
        zIndex: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: '#003087', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Component Categories
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {LEGEND_ITEMS.map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: item.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#475569' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main BOMTree component ────────────────────────────────────────────

interface BOMTreeProps {
  data: BOMNode[];
  onNodeClick?: (nodeId: string, nodeData: any) => void;
}

const fitViewOptions: FitViewOptions = { padding: 0.15, duration: 600 };

export default function BOMTree({ data, onNodeClick }: BOMTreeProps) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => buildFlowGraph(data), [data]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [warned, setWarned] = useState(false);

  useEffect(() => {
    const { nodes: n, edges: e } = buildFlowGraph(data);
    setNodes(n);
    setEdges(e);
    setWarned(n.length > 100);
  }, [data, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick?.(node.id, node.data);
    },
    [onNodeClick]
  );

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Select a Product Variant and click &ldquo;Explore BOM&rdquo; to visualize the tree.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {warned && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#FEF3C7',
            border: '1px solid #D97706',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 12,
            color: '#92400E',
            zIndex: 20,
            whiteSpace: 'nowrap',
          }}
        >
          Large tree ({nodes.length} nodes) — try reducing the depth limit for better performance.
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.1}
        maxZoom={2}
        deleteKeyCode={null}
      >
        <MiniMap
          nodeColor={(n) => {
            const cat = (n.data as BOMNodeData)?.category ?? '';
            return categoryColors(cat).border;
          }}
          maskColor="rgba(0,48,135,0.06)"
          style={{ border: '1px solid #E2E8F0', borderRadius: 6 }}
        />
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#E2E8F0" />
        <Legend />
      </ReactFlow>
    </div>
  );
}
