import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import {
  HomeIcon,
  CubeTransparentIcon,
  MagnifyingGlassCircleIcon,
  ArrowsRightLeftIcon,
  BoltIcon,
  QuestionMarkCircleIcon,
  BeakerIcon,
  CircleStackIcon,
} from '@heroicons/react/24/outline';
import BOMExplosion from './pages/BOMExplosion';
import WhereUsed from './pages/WhereUsed';
import BOMComparison from './pages/BOMComparison';
import ImpactAnalysis from './pages/ImpactAnalysis';
import BusinessQuestions from './pages/BusinessQuestions';
import WhatIfSimulator from './pages/WhatIfSimulator';
import MaterialsExplorer from './pages/MaterialsExplorer';
import { getHealth } from './api/client';

// ─── KPI Tile ───────────────────────────────────────────────────────────

function KpiTile({ label, value, icon, accent }: { label: string; value: string | number; icon: React.ReactNode; accent: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex items-center gap-4">
      <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: accent + '1A' }}>
        <div style={{ color: accent }}>{icon}</div>
      </div>
      <div>
        <div className="text-2xl font-bold text-slate-800">{value}</div>
        <div className="text-xs text-slate-500 font-medium mt-0.5">{label}</div>
      </div>
    </div>
  );
}

// ─── Home dashboard ──────────────────────────────────────────────────

function HomeDashboard() {
  const [stats, setStats] = useState({ active_pvs: '—', total_parts: '—', open_ecos: '—', pending_approvals: '—' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHealth()
      .then((h) =>
        setStats({
          active_pvs: h.active_pvs?.toLocaleString() ?? '—',
          total_parts: h.total_parts?.toLocaleString() ?? '—',
          open_ecos: h.open_ecos?.toLocaleString() ?? '—',
          pending_approvals: h.pending_approvals?.toLocaleString() ?? '—',
        })
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">PMI BOM Analytics</h1>
      <p className="text-slate-500 text-sm mb-8">
        Powered by Snowflake — migrated from ANZO Hi-Res graph. Use the sidebar to explore BOM capabilities.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <KpiTile label="Active Product Variants" value={loading ? '⋯' : stats.active_pvs} icon={<CubeTransparentIcon className="w-6 h-6" />} accent="#003087" />
        <KpiTile label="Total Parts" value={loading ? '⋯' : stats.total_parts} icon={<CubeTransparentIcon className="w-6 h-6" />} accent="#3B82F6" />
        <KpiTile label="Open ECOs" value={loading ? '⋯' : stats.open_ecos} icon={<BoltIcon className="w-6 h-6" />} accent="#D97706" />
        <KpiTile label="Pending Approvals" value={loading ? '⋯' : stats.pending_approvals} icon={<QuestionMarkCircleIcon className="w-6 h-6" />} accent="#DC2626" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { to: '/bom-explosion',      title: 'BOM Explosion',       desc: 'Visualize multi-level BOM as an interactive tree',           icon: <CubeTransparentIcon className="w-5 h-5" />, accent: '#003087' },
          { to: '/where-used',         title: 'Where Used',          desc: 'Find every PV using a given component',                      icon: <MagnifyingGlassCircleIcon className="w-5 h-5" />, accent: '#16A34A' },
          { to: '/bom-comparison',     title: 'BOM Comparison',      desc: 'Side-by-side diff of two Product Variants',                  icon: <ArrowsRightLeftIcon className="w-5 h-5" />, accent: '#3B82F6' },
          { to: '/impact-analysis',    title: 'Impact Analysis',     desc: 'Assess supply-chain impact of changing a component',         icon: <BoltIcon className="w-5 h-5" />, accent: '#DC2626' },
          { to: '/business-questions', title: 'Business Questions',  desc: '19 live BRD queries — all answered by Snowflake',            icon: <QuestionMarkCircleIcon className="w-5 h-5" />, accent: '#7C3AED' },
        ].map((card) => (
          <NavLink key={card.to} to={card.to} className="block bg-white rounded-xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow p-5 group">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: card.accent + '1A', color: card.accent }}>
                {card.icon}
              </div>
              <span className="font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{card.title}</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">{card.desc}</p>
          </NavLink>
        ))}
      </div>
    </div>
  );
}

// ─── Sidebar nav ───────────────────────────────────────────────────────────

const NAV_LINKS = [
  { to: '/',                    label: 'Dashboard',          icon: <HomeIcon className="w-5 h-5" /> },
  { to: '/bom-explosion',       label: 'BOM Explosion',      icon: <CubeTransparentIcon className="w-5 h-5" /> },
  { to: '/where-used',          label: 'Where Used',         icon: <MagnifyingGlassCircleIcon className="w-5 h-5" /> },
  { to: '/bom-comparison',      label: 'BOM Comparison',     icon: <ArrowsRightLeftIcon className="w-5 h-5" /> },
  { to: '/impact-analysis',     label: 'Impact Analysis',    icon: <BoltIcon className="w-5 h-5" /> },
  { to: '/what-if',             label: 'What-If Simulator',  icon: <BeakerIcon className="w-5 h-5" /> },
  { to: '/materials',           label: 'Materials Explorer', icon: <CircleStackIcon className="w-5 h-5" /> },
  { to: '/business-questions',  label: 'Business Questions', icon: <QuestionMarkCircleIcon className="w-5 h-5" /> },
];

function Sidebar() {
  const location = useLocation();
  return (
    <aside
      className="flex flex-col h-full w-56 flex-shrink-0"
      style={{ background: '#003087' }}
    >
      {/* Logo */}
      <div className="px-5 py-6 border-b border-white/10">
        <div className="text-white font-bold text-lg tracking-tight">PMI</div>
        <div className="text-white/60 text-xs font-medium mt-0.5">BOM Analytics</div>
        <span className="mt-2 inline-block bg-amber-400 text-amber-900 text-xs font-bold px-2 py-0.5 rounded">
          POC Demo
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 flex flex-col gap-0.5">
        {NAV_LINKS.map((link) => {
          const active = link.to === '/' ? location.pathname === '/' : location.pathname.startsWith(link.to);
          return (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-white/20 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              {link.icon}
              {link.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-white/10">
        <div className="text-white/40 text-xs">Powered by Snowflake</div>
      </div>
    </aside>
  );
}

// ─── Root App ──────────────────────────────────────────────────────────────

function AppLayout() {
  const location = useLocation();
  const pageTitle: Record<string, string> = {
    '/':                    'Dashboard',
    '/bom-explosion':       'BOM Explosion',
    '/where-used':          'Where Used',
    '/bom-comparison':      'BOM Comparison',
    '/impact-analysis':     'Impact Analysis',
    '/what-if':             'What-If Simulator',
    '/materials':           'Materials Explorer',
    '/business-questions':  'Business Questions',
  };
  const title = pageTitle[location.pathname] ?? 'PMI BOM Analytics';

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top header */}
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">
          <h2 className="font-semibold text-slate-700 text-sm">{title}</h2>
          <span className="ml-auto text-xs text-slate-400">PMI BOM Analytics POC — Snowflake SPCS</span>
        </header>
        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<HomeDashboard />} />
            <Route path="/bom-explosion" element={<BOMExplosion />} />
            <Route path="/where-used" element={<WhereUsed />} />
            <Route path="/bom-comparison" element={<BOMComparison />} />
            <Route path="/impact-analysis" element={<ImpactAnalysis />} />
            <Route path="/what-if" element={<WhatIfSimulator />} />
            <Route path="/materials" element={<MaterialsExplorer />} />
            <Route path="/business-questions" element={<BusinessQuestions />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
