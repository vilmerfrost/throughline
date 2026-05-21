# Throughline Design System & UI Specification

This document defines the formal design rules, visual language, component architecture, and interaction guidelines for the Throughline codebase visualization interface. 

---

## 1. Project Context

### Product Overview & Target Audience
**Throughline** is a contract-centric (not call-centric) codebase analysis tool designed for multi-language software projects. In modern distributed or polyglot architectures, separate applications and services rarely call each other directly; instead, they interface at shared data contracts (e.g., SQL database tables, JSON/HTTP schema payloads). 

Throughline models these data contracts as the central "spine" of a repository. It visualizes:
1. **Contracts (SQL Tables):** The core schemas that serve as the single source of truth.
2. **Touches (Code Reads/Writes):** The locations in code (TypeScript, Python, Rust, etc.) where those contracts are written to or read from.
3. **Trust Levels:** A measure of how strictly a code touch is bound to the contract, highlighting points where typing guarantees break down.
4. **Drift Findings:** Table-level divergence risks between static contracts and active code touches, grounded in language, direction, and trust signals.

The target audience consists of senior backend, frontend, database, and devops engineers who maintain polyglot systems and need to identify schema drifts and typing vulnerabilities before they cause production failures.

### Technical Stack
As of May 21, 2026, the project is structured as a pnpm monorepo:
* **Frontend:** Built with **React 18.3.1**, **Vite 5.4.11**, **TypeScript 5.6.3**, and **Tailwind CSS 3.4.15**. Visualizations are powered by **@xyflow/react (v12.3.5)**.
* **Analyzer (Backend):** An **Express** server in `@throughline/analyzer` parsing database schema files using `pgsql-ast-parser` and inspecting TypeScript files via `ts-morph`, supplemented by shallow grepping for other languages.
* **Core:** Shared TypeScript types in `@throughline/core` declaring the standard types for `Graph`, `GraphNode`, `GraphEdge`, `DriftFinding`, and `SourceRef`.
* **Important Stack Note:** There is **no Next.js or Supabase** used in the codebase. Vite handles client-side delivery, and Express manages static code/migration analysis. (While mock data refers to paths like `supabase/migrations/...`, this is a target for the file parsing engine, not an active cloud runtime).

### Existing Node-Graph UI & Planned Transitions
A functional proof-of-concept exists in `@throughline/web`. It presents a master-detail split (graph on the left, an inspector sidebar on the right). 
* **The Current State:** The current layout algorithm in `GraphCanvas.tsx` uses hardcoded math rows and columns on load to arrange elements in 3 vertical columns (Reads on the left, Contracts in the middle, Writes on the right). It hardcodes colors as raw hex values inside `apps/web/src/lib/trust.ts`.
* **The Planned State:** This design document formalizes the transition of the existing layout math to a programmatic, auto-routed layout system utilizing **Dagre**, and moves hardcoded color values to native Tailwind and CSS semantic tokens.

---

## 2. Design Principles

Every UI decision in Throughline must enforce these four principles:

1. **Spine Over Call-Graph:** Traditional APM tools show call trees. Throughline is contract-centric. The visual focal point must always be the data contract (the spine), with read and write streams pointing into it.
2. **Signal-to-Noise Ratio (Minimalist Restraint):** A complex codebase contains hundreds of touches. No loud, solid-fill nodes or bright neon background grids are permitted. Statuses must be communicated through subtle border colors and tiny status dots rather than high-saturation fills.
3. **Developer-First Typography:** Code represents truth. The interface must read as a professional developer tool: clean sans-serif for interface controls, and crisp monospace for nodes, files, line numbers, and snippets.
4. **Data-Layout Separation:** Visual rendering coordinates must never be hand-crafted, hardcoded, or stored in database tables. The graph state is strictly `{ nodes, edges }` and coordinate positions are derived programmatically via automated layout passes.

---

## 3. Color & Token System

All colors must be mapped to semantic CSS variables in `apps/web/src/index.css` and extended inside Tailwind (`tailwind.config.js`). Hardcoded hex codes are strictly forbidden in component markup.

### Core Semantic Colors

| CSS Variable | Tailwind Utility / Class | Hex Value | Semantic Meaning / Role | Visual Application |
| :--- | :--- | :--- | :--- | :--- |
| `--color-contract` | `bg-trust-contract` <br> `border-trust-contract` | `#3b82f6` | The primary data spine. Derived from SQL schemas/tables. | Contract node border, status dot, connection handles, selection rings. |
| `--color-verified` | `bg-trust-verified` <br> `border-trust-verified` | `#16a34a` | Static code with verified, compiler-checked types. No casts. | Verified touch node border, status dot. |
| `--color-narrowed` | `bg-trust-narrowed` <br> `border-trust-narrowed` | `#ca8a04` | Partial mappings (e.g., `Pick`/`Omit` or partial column select). | Narrowed touch node border, status dot. |
| `--color-asserted` | `bg-trust-asserted` <br> `border-trust-asserted` | `#dc2626` | Untrusted bypasses like `as X` assertions or forced casts. | Asserted touch node border, status dot, critical alert banners. |
| `--color-dark` | `bg-trust-dark` <br> `border-trust-dark` | `#1f2937` | Flow goes blind: `any`, `never`, or untyped boundaries. | Dark touch node border, status dot. |
| `--color-edge-read` | `stroke-edge-read` | `#93c5fd` | Read flow moving from code components into contracts. | Edge connector path stroke and marker arrowheads. |
| `--color-edge-write` | `stroke-edge-write` | `#f87171` | Write flow moving from code components into contracts. | Edge connector path stroke and marker arrowheads. |

### Surface & Background Tokens

| CSS Variable | Tailwind Utility / Class | Hex Value | Semantic Meaning / Role | Visual Application |
| :--- | :--- | :--- | :--- | :--- |
| `--color-bg-base` | `bg-neutral-950` | `#0a0a0a` | Deep, low-contrast canvas backdrop. | Page body background. |
| `--color-bg-surface`| `bg-neutral-900` | `#171717` | Standard surface containing secondary widgets. | Inspector sidebar background, Legend overlay, Header bar. |
| `--color-bg-node` | `bg-neutral-900/95` | `rgba(23, 23, 23, 0.95)` | Slight transparency for node elements to see canvas grid. | Custom node component card backdrops. |
| `--color-grid` | — | `#262626` | Subtle alignment grid markings. | React Flow background dot pattern. |
| `--color-border-subtle` | `border-neutral-800` | `#262626` | Standard layout dividers. | Header divider, sidebar separator, panel borders. |

### Text Hierarchy Tokens

| CSS Variable | Tailwind Utility / Class | Hex Value | Semantic Meaning / Role | Visual Application |
| :--- | :--- | :--- | :--- | :--- |
| `--color-text-primary` | `text-neutral-100` | `#f5f5f5` | Main headings, code labels, critical metrics. | Node label text, Inspector panel titles. |
| `--color-text-secondary`| `text-neutral-400` | `#a3a3a3` | Standard descriptions and sub-labels. | Legend blurb, metadata tags. |
| `--color-text-muted` | `text-neutral-500` | `#525252` | De-emphasized auxiliary info. | Snippet line numbers, offline/mock indicators. |

---

## 4. Typography

### Global Font Families
* **Interface Font:** System Sans-Serif (`ui-sans-serif, system-ui, -apple-system, sans-serif`) is applied to layout headers, sidebars, legend items, and UI descriptions.
* **Code Font:** System Monospace (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`) is applied to node labels, file paths, schema columns, types, and source snippets.

### Scale & Weight Rules

```
┌────────────────────────────────────────────────────────┐
│ Global Title: 16px · Semibold · Sans-Serif             │
├────────────────────────────────────────────────────────┤
│ Node Label: 14px · Regular · Monospace                 │
├────────────────────────────────────────────────────────┤
│ Metadata / Tag: 11px · Uppercase · Tracking-Wide · Sans │
├────────────────────────────────────────────────────────┤
│ Code Snippet: 12px · Regular · Monospace               │
└────────────────────────────────────────────────────────┘
```

* **App Brand Title:** `text-base` (16px), `font-semibold`, tracking tight.
* **Node Kind Header:** `text-[11px]` (11px), uppercase, tracking wide (`tracking-wide`), `font-medium`.
* **Node Main Title:** `text-sm` (14px), `font-mono`.
* **Inspector Source Snippet:** `text-xs` (12px), `font-mono`, with a line-height of `leading-relaxed`.

---

## 5. Component Rules

All rendering components must adhere to strict, testable functional specs:

### A. The Custom Node (`TrustNode`)
Nodes must render as a unified component with a custom style sheet, rather than inline overrides.

```
┌────────────────────────────────────────────────────────┐
│  ● CONTRACT                             sql · 3 cols   │ [Node Header]
├────────────────────────────────────────────────────────┤
│  batches                                               │ [Node Label]
├────────────────────────────────────────────────────────┤
│  supabase/migrations/20240115093000_create_batches.sql │ [Node Metadata]
└────────────────────────────────────────────────────────┘
```

1. **Fixed Width:** Nodes must have a strict, non-variable width of `220px` (`w-[220px]`) to maintain column grids. No auto-width expansion based on text length is allowed; labels exceeding width must use CSS truncation (`truncate`).
2. **Card Structure:** 
   * Solid `1px` border (`border`) colored matching the node's semantic state.
   * Background of `rgba(23, 23, 23, 0.95)` with backdrop blur.
   * Internal padding must be exactly `12px` horizontally and `8px` vertically (`px-3 py-2`).
3. **Internal Elements:**
   * **Indicator Dot:** A circular dot of exactly `10px` (`h-2.5 w-2.5`) positioned top-left, colored with the node's semantic color.
   * **Node Kind/Language:** Positioned adjacent to the indicator dot, displaying the uppercase kind (`CONTRACT`, `TOUCH`, or `BOUNDARY`) or language (`SQL`, `TS`, `PY`, `RUST`) in `text-[11px]` uppercase.
   * **Node Label:** The central content, using `text-sm font-mono text-neutral-100 truncate mt-1`.
   * **Metadata Badge:** An optional bottom row displaying column counts or language name using `text-[11px] text-neutral-500 mt-0.5`.
4. **Interactive Focus:** When a node is selected, its outline must be accented with a ring (`box-shadow`) matching its semantic color of exactly `2px` with a `0px` offset, keeping the physical border dimension at `1px` to prevent layout reflows.
5. **Connection Handles:** Custom nodes must register target and source handles on both Left (`tl`, `sl`) and Right (`tr`, `sr`) facets. The handles must be visually hidden (`opacity-0`) unless a connection line is actively dragged, and must be color-matched to the node's border.

### B. Graph Edges
Edges are semantic indicators of data direction.
1. **Directional Flow Paths:**
   * **Read Edges:** Flow from touch nodes (left) into contract nodes. Stroke color is `#93c5fd`.
   * **Write Edges:** Flow from code touch nodes (right) into contract nodes. Stroke color is `#f87171`.
2. **Markers:** Standardize on closed arrowheads (`MarkerType.ArrowClosed`) on target elements, matched to the edge stroke color.
3. **Animation Constraints (Restraint Principle):** Edges must **NOT** animate under staticfallback/mock states. Edge animation (`animated: true`) is strictly reserved for live streaming analyzer states (`live === true` passed from `App.tsx`).

### C. Sidebar Inspector
The inspector is the ultimate anchor of truth for nodes. It must reflect state cleanly from the selected node ID.

```
┌────────────────────────────────────────────────────────┐
│  ● CONTRACT                             sql            │ [Header Block]
│  batches                                               │
├────────────────────────────────────────────────────────┤
│  asserted  "as X" cast — "trust me", NOT verified      │ [Trust Banner]
├────────────────────────────────────────────────────────┤
│  Columns:                                              │ [Detail List]
│  id           uuid       not null                      │
│  status       text       not null                      │
├────────────────────────────────────────────────────────┤
│  Source:                                               │ [Source Snippet]
│  apps/admin/src/lib/batches.ts:42                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │ const batchData = adminBatch as Batch;           │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

1. **State Isolation:** The inspector component must receive `node: GraphNode | null` and `drift: DriftFinding[]` as read-only properties. It must never hold an independent copy of node properties to avoid out-of-sync edits.
2. **Subcomponents:**
   * **Empty State:** If no node is selected, render a full-height centered layout with `text-sm text-neutral-500 text-center px-6` saying: *"Select a node to inspect its source, trust level, and any drift it is involved in."*
   * **Header Block:** Renders the semantic color dot, uppercase node kind, language badge, and large bold label.
   * **Trust Banner:** If the node has a trust level, render a bordered banner with the exact color of the trust state, displaying the label and descriptive blurb.
   * **Columns Table:** Visible only for contracts. Render columns in a clean, borderless list. Columns must align left-to-right: Name (left), Database Type (middle), Nullability (right, aligned right).
   * **Source Block:** Displays the file path and line range in monospace. Below, it renders the raw snippet within a code block container styled with `bg-black/60 border border-neutral-800 p-3 rounded-md overflow-x-auto text-xs font-mono text-neutral-200`.
   * **Drift List:** Pulls any drift findings targeting the active node ID, rendering them as alert cards bordered matching their severity (`info` = `#3b82f6`, `warn` = `#ca8a04`, `error` = `#dc2626`).

---

## 6. Layout & Interaction

### Layout Architecture
Throughline separates layout representation from graph state. Node coordinates must be programmatically derived on rendering:

```
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │      │                   │
│   TOUCH / READS   │─────>│     CONTRACTS     │<─────│   TOUCH / WRITES  │
│    (Left Col)     │      │   (Middle Spine)  │      │    (Right Col)    │
│                   │      │                   │      │                   │
└───────────────────┘      └───────────────────┘      └───────────────────┘
```

1. **Spine Columns Strategy:**
   * All Contract nodes are mapped to a central spine column (`x = 440`).
   * All Touch/Boundary nodes configured to write into contracts are arranged on the right (`x = 820`).
   * All Touch/Boundary nodes reading from contracts are arranged on the left (`x = 60`).
2. **Transition to Programmatic Layout (Dagre):**
   * Hand-placed inline coordinate multipliers must be replaced with the Dagre layout engine using a horizontal orientation (`rankdir: LR`).
   * Nodes and edges must be passed to a layouts helper function on update.
   * To maintain the contract spine layout, layout constraints must map readers as upstream ancestors and writers as downstream descendants of contract nodes, with edge directions pointing inward.

### Interactivity & Polish
1. **Master/Detail Split:** The viewport splits horizontally. The canvas occupies a fluid `flex-1` zone. The Inspector occupies a static `w-96 shrink-0` panel pinned to the right edge.
2. **Hover Highlighting & Dimming:**
   * Hovering over any Node must transition the opacity of all unconnected nodes and edges to `0.3` (`duration-200`). The target node and its direct ancestors/descendants remain at full `1.0` opacity.
   * Hovering over an Edge must bump its stroke width to `2px` and set the opacity of unrelated components to `0.3`.
3. **Canvas Selection:** Clicking empty canvas areas triggers `onSelect('')`, resetting the Master/Detail Inspector to its empty state.

---

## 7. Performance Constraints

1. **Memoize Layout Calculations:** Layout processing (such as Dagre coordinate passes) is computationally heavy. Coordinate layouts must be processed inside a `useMemo` block keyed strictly on the hash representation of node IDs and edge relationships (`nodes.map(n => n.id).join(',')`). Viewport panning, zooming, and inspector selection changes must never trigger layout updates.
2. **React Flow Render Culling:** React Flow only renders nodes visible inside the viewport bounding box. To protect performance:
   * Keep custom `TrustNode` DOM structures flat; avoid heavy inline loops.
   * Prevent mounting heavy child subcomponents (such as raw markdown parsers or full column tables) inside nodes. Restrict these complex sub-elements strictly to the static sidebar Inspector.
   * Wrap node components in `React.memo` to prevent re-renders when selection changes do not affect them.
3. **Virtualization Trigger:** For graphs exceeding 200 elements:
   * Automatic zoom-to-fit (`fitView`) should disable animations.
   * Graph node content must transition to "LOD (Level of Detail)" mode, where nested text (language badges, trust labels) is hidden at zoom levels below `0.6` to limit GPU text-rendering overhead.

---

## 8. References

The following sources serve as the authoritative standard for XYFlow and layout engine implementations:

* **Official Library Overview:** [React Flow Home](https://reactflow.dev/)
* **Implementation Patterns:** [React Flow Examples Guide](https://reactflow.dev/examples) (Detailed layouts, dark mode components, custom edge designs, and labels)
* **Custom Node Specifications:** [React Flow Custom Nodes Guide](https://reactflow.dev)
* **Interactive Sandbox & Layout Benchmarks:** [XYFlow Playground Labs](https://xyflow.com/labs/react-flow-playground) (Testing and prototyping Dagre, ELK.js, and D3 Force layout graphs)
* **NPM Package Reference:** [@xyflow/react NPM Details](https://www.npmjs.com/package/@xyflow/react)
* **Source & Engineering Reference:** [XYFlow GitHub Monorepo](https://github.com/xyflow/xyflow)
