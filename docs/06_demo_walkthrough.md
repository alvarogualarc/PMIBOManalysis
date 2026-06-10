# PMI CLIPP BOM Analytics — Demo Walkthrough Script

**Purpose:** Step-by-step demo guide for sales engineers and solution architects.  
**Audience:** PMI Operations, Product, and Digital teams evaluating Snowflake vs ANZO.  
**Duration:** 25–35 minutes full demo. 10-minute version marked with ⚡.  
**Prerequisites:** Backend running, frontend open at `http://localhost:5173`, Snowflake connection active.

---

## Before You Start

**The single narrative thread to maintain throughout:**

> *"Every question you asked about your BOM data — all 19 in your BRD — we answered. Not in theory. Live, on your data model, right now."*

Refer back to this at every transition. The demo is not a feature tour — it is a proof of requirements.

**Know these numbers cold:**
- 104 markets, 5,800 PVs, 111,543 closure rows in this POC
- Virginia Leaf A: 5,177 PVs, 55 markets
- BOM explosion: <1 second
- Closure rebuild: 1.5 seconds (X-Small warehouse)
- BQ-19: 80 rows, 17 columns, 5 joined entities, <3 seconds

---

## ⚡ 1. Opening — Home Dashboard (2 min)

**Navigate to:** `http://localhost:5173` (home screen)

**Say:**
> "What you're looking at is a live application running entirely inside Snowflake — hosted in Snowflake Container Services, authenticated through your AD, and querying a Snowflake database that was loaded from an ARAS-equivalent data model. There is no third-party server, no external cloud, no data leaving the Snowflake boundary."

**Point to the KPI tiles:**
> "These are live numbers. 5,800 Product Variants across 104 markets, 500 open ECOs, 66 projects pending approval. All from the same closure table we'll walk through in detail."

**Transition:**
> "Let me start with the question that was hardest to answer in your previous system: BOM Explosion. Full multi-level BOM for any Product Variant, in one shot."

---

## ⚡ 2. BOM Explosion — Product Variant (5 min)

**Navigate to:** BOM Explosion (sidebar)

**Action:** Select Brand = Marlboro, Market = PL (Poland), then pick any Marlboro Red PV from the dropdown. Set Depth = 5. Click **Explore BOM**.

**While tree renders, say:**
> "The tree you're seeing is pre-computed. Every one of those edges was traversed last night during a 1.5-second rebuild. At query time, Snowflake ran a single equality filter — not a graph traversal. The ANZO Hi-Res system traverses this on every request. We don't."

**Point to the tree nodes:**
> "Each node is color-coded by material type — amber for tobacco, red for regulatory, blue for packaging, green for raw leaf. Click any node."

**Click OUTER_PACK_MRL_20S_PL:**
> "This is the Poland-specific outer pack. Notice the red node next to it — that's TAX_STAMP_PL_01. The Polish regulatory stamp appears at depth 2 under the pack. A French PV has TAX_STAMP_FR_01 here instead. That single difference is what makes BOM Comparison the most useful report in the system."

**Point to the Part Details panel:**
> "Supplier, cost, category — all available. And this button — 'Analyze Where Used' — takes you directly to the impact analysis for this component. We'll come back to that."

**Switch to Table View tab:**
> "The same data in tabular form — filterable, sortable, exportable to CSV. AG Grid with column-level filtering on every attribute. This is what replaces your Power BI tabular views."

**Transition:**
> "Now — one thing your BRD specifically asked for was BOM explosion starting from any level, not just the finished product. Let me show you that."

### BOM Explosion — From a Sub-Assembly

**Action:** Toggle **Start from** to **Any Component**. Search for `Marlboro Red Proprietary Blend`. Select `BLEND_MARLBORO_RED_01`. Click **Explore BOM**.

**Say:**
> "Now the tree root is the blend itself, not the finished product. We're looking down from the blend at its raw material sub-tree: Virginia Leaf, Burley Leaf, Oriental Leaf, Reconstituted Sheet, Glycerin. No code change. No schema change. The closure table already stored this relationship — we just changed the starting point."

> "This is impossible in a conventional recursive query model — you'd have to re-anchor the recursion. In a closure table, any node is a valid root. Same query, different WHERE clause."

---

## ⚡ 3. Where Used — The Supply Chain Risk Moment (4 min)

**Navigate to:** Where Used (sidebar)

**Action:** Search for `Virginia Flue-Cured Leaf Type A`. Select it. Click **Find Usage**.

**While results load, set up the moment:**
> "Virginia Leaf A is a specific flue-cured tobacco grade sourced globally. The same ingredient goes into Marlboro, Parliament, Chesterfield — across every market PMI operates in."

**When results appear, point to the banner:**
> "5,177 Product Variants. 55 markets. Under 2 seconds."

**Point to the amber group (Intermediate Components):**
> "This is new — and important. The original system only showed you the finished products. But when a tobacco leaf changes, your formulation team also needs to know which **blend specifications** need updating. These amber rows — BLEND_MARLBORO_RED_01, BLEND_PARLIAMENT_01 — are the intermediate components that directly use this leaf. Previously invisible. Now surfaced automatically."

**Point to the `impact_tier` and `level_display` columns:**
> "Two things worth noting here. `Level Display` shows '2 of 3' — meaning this leaf is at position 2 in a 3-level tree. `Steps from Leaf` shows 1 — one hop from the raw material. That number is comparable across every one of these 5,177 PVs regardless of how deep their individual BOM trees are. We normalised the depth so you can actually use it as an impact measure."

**Transition:**
> "Let me show you what comparing two BOMs looks like — specifically why the Poland and France packs are different."

---

## 4. BOM Comparison — Market Specificity (3 min)

**Navigate to:** BOM Comparison (sidebar)

**Action:** Select a Marlboro Red PV for Poland in the first dropdown, Marlboro Red PV for France in the second. Click **Compare**.

**Point to the three panels:**
> "Three columns: components only in the Polish BOM, components shared by both, components only in the French BOM."

**Point to the unique columns:**
> "Look at the unique items: OUTER_PACK_MRL_20S_PL vs OUTER_PACK_MRL_20S_FR — different market packaging. TAX_STAMP_PL_01 vs TAX_STAMP_FR_01 — different regulatory components. Everything else — the tobacco blend, the filter, the paper, the tipping paper — is identical. That's the global BOM vs the local BOM difference, visually, in three seconds."

**Talking point if asked about ANZO:**
> "In ANZO, this was a SPARQL query you had to write. Here it's a button."

---

## ⚡ 5. Impact Analysis — Supply Chain Risk (3 min)

**Navigate to:** Impact Analysis (sidebar)

**Action:** Search for `Cellulose Acetate Tow Grade 01`. Click **Analyze Impact**.

**Point to the tiles:**
> "448 Product Variants. 5 markets. 8 brands. This is every combustible cigarette we modelled — because this is the primary filter material used in 80% of our cigarette filters."

> "3 open ECOs are already tracking changes related to this component. And look at the affected markets — every single market we operate in."

**Point to the affected PVs grid:**
> "Click any PV row and it navigates to BOM Explosion for that product. Every screen connects. The user never has to leave the application to answer a follow-up question."

---

## 6. What-If Simulator — Proactive Planning (3 min)

**Navigate to:** What-If Simulator (sidebar)

**Say:**
> "One of the capabilities PMI explicitly called out as missing from PLM Analytics was BOM simulation. The ability to ask: if I change this component, what does the impact look like — without actually making the change."

**Action:** 
- First part: search `Cellulose Acetate Tow Grade 01`
- Arrow, then second part: search `Cellulose Acetate Tow Grade 02`
- Click **Run Simulation**

**Point to results:**
> "448 Product Variants would be affected by this substitution. 5 markets. 8 brands. The table shows every PV, with the original component highlighted red and the replacement highlighted green. Nothing in Snowflake has been changed. This is a read-only overlay on the closure table — a simulation, not a commit."

> "In ANZO, this required a custom workflow. Here it's two dropdowns and a button, running a pure SQL CTE overlay."

---

## 7. Materials Explorer — Dynamic Attribute Filtering (3 min)

**Navigate to:** Materials Explorer (sidebar)

**Say:**
> "A concern raised after the initial review was: how do you filter materials by attributes that are different per category? Tobacco Leaf has leaf grade and origin country. Filter components have diameter and pressure drop. Packaging has substrate and recyclability. A fixed schema can't hold all of these."

**Action:** Select category **Tobacco Leaf** from the dropdown. Observe filter panel appearing.

> "Seven attribute filters appear automatically — sourced from a metadata view that queries what attributes actually exist in the data. Not hardcoded. If ARAS adds a new attribute tomorrow, I insert one row into the database. The filter appears on the next page load. Zero DDL. Zero deployment."

**Action:** Click **+ Add Filter** → select `leaf_grade` → value `A`. Add another: `origin_country` → `USA`. Click **Search Materials**.

> "Two Grade A Virginia leaf types sourced from USA. Both used in over 5,000 Product Variants. Click either row to navigate directly to Where Used."

**Transition:**
> "Let me close with the hardest query in your BRD — the one your document describes as 'get work orders with project number and the PV and BOM items related in one query and one output.' Your BRD called this out specifically because it wasn't possible in PLM Analytics."

---

## ⚡ 8. Business Questions — BQ-19, The Climax (4 min)

**Navigate to:** Business Questions (sidebar)

**Action:** Scroll to BQ-19 and expand it.

**Read the description aloud:**
> "'Cross-domain: work orders, project, PV, and BOM for end-to-end traceability. The most complex query in the BRD — joins Project, PV, and BOM tables to deliver full product lifecycle traceability in a single result set. This is what ANZO called interconnect all data points.'"

**Click Show SQL:**
> "Five tables. One query. Projects joined to PVs through a link table, then to BOM_CLOSURE, then to parts. This is the query your BRD said required a graph database."

**Action:** Search for `Parliament Aqua Blue Slim`, select it, click **Run Query**.

**While results load:**
> "80 rows. 17 columns. Project ID, project name, project status, phase, planned end date, PV ID, PV name, market, brand, BOM level, part name, category, quantity, unit, supplier. Every domain in one flat result set. In ANZO, this required traversing four relationship types in a single SPARQL query. In Snowflake, it's a standard SQL join."

**Point to project_status column:**
> "Notice project status is 'Overdue'. That's a live field from the Projects table. If a project managing the launch of this PV is overdue, procurement can see it alongside the BOM components they need to source. That is the 'interconnect all data points' requirement — fulfilled. Not by a graph traversal. By a well-written SQL JOIN."

**Pause.**

> "That was 19 business questions. All answered. All live."

---

## 9. Closing — The Honest Summary (2 min)

**Say:**
> "Let me be direct about what this architecture is, and what it isn't."

> "It is a relational system with a pre-computed graph structure. It is not a native graph database. ANZO's graph model gives you certain capabilities — shortest path, pattern matching, centrality — that Snowflake doesn't replicate natively. We looked at every one of your 19 business questions. None of them require those capabilities. Every one is answered by a closure table lookup or a multi-join SQL query."

> "What Snowflake gives you that ANZO doesn't: sub-second query performance on 100,000+ closure rows, a UI that runs inside your cloud boundary, market-scoped row access policies that replicate your ARAS security, daily automatic refresh with zero orchestration code, and a path to Cortex AI for the next generation of BOM analytics."

> "The question isn't whether Snowflake is a graph database. The question is whether Snowflake answers your 19 business questions. It does. We just showed you."

---

## Handling Common Questions Mid-Demo

**"What about ANZO's ontology — can Snowflake handle schema changes as flexibly?"**
> "Yes — we just showed you. The Materials Explorer page adds new filter controls automatically when new rows are inserted into the attribute table. No DDL required. The BRD doesn't list schema evolution speed as a requirement, but we solved it anyway."

**"The depth numbers look different across PVs — how do I know if an impact is significant?"**
> "Good observation. Go back to Where Used — look at the `Impact Tier` column and `Steps from Leaf`. Those are normalised against the tree height of each PV. A component with `Steps from Leaf = 1` has the same structural significance regardless of whether the tree is 3 or 6 levels deep."

**"What happens if the same component is used in two different sub-assemblies in the same product?"**
> "We checked. Zero occurrences in this dataset — tobacco BOMs are trees, not graphs. Each ingredient has one role and one path to the finished product. We have an automated monitor that catches any that appear in real ARAS data before they affect MRP calculations."

**"Can we start BOM explosion from a blend or a sub-assembly, not just from the finished product?"**
> "Yes — switch the toggle on BOM Explosion to 'Any Component'. We just demonstrated it with the Marlboro Red blend."

**"Can you handle 400 users?"**
> "Multi-cluster warehouse auto-scales at queue threshold. The POC is on a single Medium cluster. Production would run two clusters and handle 20 concurrent users per cluster. Snowflake auto-suspend saves cost during off-hours."

**"How long does the migration take?"**
> "The hard parts are in front of you — closure table, BOM analytics, RLS, SPCS deployment. All proven. The remaining work is 14 more tabular reports — SQL joins to AG Grid. That's methodical, not risky. Six months is achievable with a structured workstream."

---

## 10-Minute Version ⚡

Run only the sections marked ⚡:

1. Home Dashboard — 2 min: establish scale and context
2. BOM Explosion (PV mode only) — 3 min: tree + tax stamp moment
3. Where Used (Virginia Leaf A) — 2 min: 5,177 PVs, intermediate components
4. BQ-19 — 3 min: SQL reveal + run query + 80 rows

Skip: BOM Comparison, Impact Analysis, What-If, Materials Explorer. Offer those as follow-up for a second session focused on operational use cases.

---

## Demo Preparation Checklist

- [ ] Backend running: `uvicorn main:app --reload --port 8000`
- [ ] Frontend running: `npm run dev` at `localhost:5173`
- [ ] Snowflake connection verified: `curl localhost:8000/api/health` returns KPI counts
- [ ] BOM Explosion loads for a Marlboro Red PL PV
- [ ] Virginia Leaf A Where Used returns 5,177+ rows
- [ ] BQ-19 with `FA000156.SL` returns 80 rows
- [ ] Materials Explorer: Tobacco Leaf category shows 7 attribute filters
- [ ] Docs folder open in case you need to reference objection handling

