# Structural Analyser

Web-based 2D/3D structural frame analysis and design tool.  
Direct Stiffness Method (FEM) | ACI 318-19 | Eurocode 2 & 3 | P-Δ | Mode Shapes | Response Spectrum

> ### ⚠ Read before using this for real work
>
> This is an **engineering aid, not code-compliant design software.** Every
> result it produces must be independently checked by a qualified engineer who
> takes responsibility for the design. It carries no warranty of any kind.
>
> Specific limits worth knowing:
>
> - The design modules implement **simplified forms** of EC3, EC2 and ACI 318-19.
>   They cover the common checks, not the full codes, and use recommended
>   partial factors rather than any national annex.
> - Column checks assume **symmetric reinforcement**; effective lengths come
>   from the per-member K factors you set, which the tool does not verify
>   against the real restraint conditions.
> - Second-order effects are covered by the P-Δ module only when you run it;
>   the linear solve does not include them.
> - Connections, fatigue, fire, seismic detailing and serviceability beyond
>   deflection and crack width are **not covered at all**.
> - The code was written with **Claude**, Anthropic's AI model, working from my
>   prompts — see [How this was built](#how-this-was-built). That is one more
>   reason to verify results rather than trust them.
>
> `npm test` asserts the invariants the analysis rests on — equilibrium for
> every load and support type, agreement between the linear, P-Δ and modal
> paths, 2D against 3D, closed-form beam results against numerical integration,
> and the section library against first principles. Passing tests mean those
> invariants hold; they do not mean the tool is fit for any particular design.

---

## How this was built

This project was built with [Claude](https://claude.ai) (Anthropic's AI model)
in Claude Code. Claude wrote the code; I directed the work and judged the
results. My part is the engineering:

- **Prompting for what I want designed.** Each feature starts as a prompt that
  says what it must do in engineering terms — the method, the code clause it
  implements, units, sign conventions and the edge cases that matter — rather
  than a loose request.
- **Interpreting what comes back.** I read the output as an engineer: does the
  deflected shape make sense, do the reactions balance the loads, does a member
  check agree with a hand calculation. When it doesn't, the next prompt says
  exactly what is wrong and why.
- **Deciding what is correct.** Claude proposes; I decide. The regression tests
  came out of the same loop — they encode the checks I would otherwise repeat by
  hand, so a later change cannot quietly break them.

Being AI-assisted does not change the disclaimer above: treat every result as
something to check.

---

## Quick Start

```bash
npm start          # serves on http://localhost:5500
# or
npx serve -p 5500 -s .
```

Open `http://localhost:5500` in Chrome/Firefox/Edge.

```bash
npm install        # dev tooling only (serve, eslint) — nothing the app loads at runtime
npm run lint       # ESLint 9, flat config in eslint.config.js
npm test           # solver regression checks — no framework, plain node
```

`npm test` runs `tests/regression.js`, which loads the analysis and design
modules into a Node VM the same way `index.html` loads them and asserts the
invariants rather than golden numbers: global force equilibrium for every load
type and every support type (springs included), agreement between the linear and
P-Δ paths, that second-order effects amplify sway and amplify it more as gravity
load grows, that 2D and 3D give the same answer for a planar frame, that the
design codes read the solver's compression-positive axial convention, and that
degenerate models produce an error instead of a plausible-looking answer.

> **Runtime dependency:** `index.html` loads SheetJS from a CDN for `.xlsx`
> import. Everything else is served locally, but section-library import from
> Excel will not work offline or under a CSP that blocks `cdn.sheetjs.com`.

---

## File Structure

```
/
├── index.html                  Entry point — all UI markup and modal dialogs
│                               Also defines the GRIDSYS / WORKPLANE / WIZ /
│                               MAT_UI / DEFL_INSP globals in inline <script>s
├── package.json
├── eslint.config.js            ESLint 9 flat config (browser scripts, no modules)
│
├── css/
│   ├── style.css               Main stylesheet (variables, layout, all components)
│   │                           Also the global :focus-visible ring (--focus-ring)
│   └── features.css            New feature styles (perf overlay, DB search,
│                               progress bar, command palette)
│
├── js/
│   │
│   ├── app.js                  ★ Main application IIFE — canvas, state, rendering,
│   │                             events, solve dispatch, design tab, UI wiring.
│   │                             Exposes window.SA namespace for extension modules.
│   │
│   ├── solver.js               2D Direct Stiffness solver (K-matrix, DOF partitioning)
│   ├── solver3d.js             3D Space Frame solver (6 DOF/node, local↔global transforms)
│   │
│   ├── core/
│   │   ├── perf.js             Performance timer — wraps solve/P-Δ/modal pipelines,
│   │   │                       shows the overlay defined in css/features.css
│   │   ├── generators.js       Structure generators (frame / truss / continuous beam)
│   │   │                       Uses window.SA — must load AFTER app.js
│   │   ├── selection.js        Selection & edit ops (move, copy, rotate, split, merge…)
│   │   │                       Uses window.SA — must load AFTER app.js
│   │   ├── a11y-labels.js      Wires index.html's visible but unassociated <label>s
│   │   │                       to their controls (adds `for`/`id`, focuses on click).
│   │   │                       Controls generated by JS are named in their own
│   │   │                       renderers instead — out of scope for this file.
│   │   ├── command-palette.js  Ctrl+K search over every ribbon command.
│   │   │                       Indexes .rib-panel / .rib-group / .rib-btn straight
│   │   │                       from index.html, so a new ribbon button is
│   │   │                       searchable with no change here.
│   │   └── dialog-ux.js        Close button, role="dialog" and focus trap for all
│   │                           60 .modal-overlay dialogs. Closing matches
│   │                           app.js's closeTopModal() exactly.
│   │
│   ├── db/
│   │   └── indexeddb.js        IndexedDB manager (StructDB)
│   │                           Stores: sections | projects (auto-save) | results_cache
│   │                           NOTE: implemented and loaded, but nothing calls it
│   │                           yet — the live auto-save uses localStorage. See below.
│   │
│   ├── features/
│   │   ├── view3d.js           3D view management (axis views, ViewCube sync)
│   │   ├── extrude.js          Solid 3D extrusion renderer
│   │   └── frame_sections.js   Define ▸ Sections (ETABS Frame Properties).
│   │                           Reads and writes window.SA.sections directly —
│   │                           see "One store for sections and materials".
│   │
│   ├── aci/                    ACI 318-19 chapter modules
│   │   ├── ch1-materials.js    ch3-flexure.js   ch4-shear.js
│   │   └── ch5-development.js  ch6-columns.js
│   │
│   ├── asce7/                  ASCE 7-16 chapter modules
│   │   ├── ch1-risk-categories.js
│   │   ├── ch2-load-combinations.js
│   │   └── ch3-dead-loads.js
│   │
│   ├── workers/
│   │   └── solver.worker.js    Web Worker — runs FEM off the main thread
│   │                           Handles: solve | pdelta | modes messages
│   │                           app.js creates it lazily in getSolveWorker() and
│   │                           falls back to an inline solve if it cannot. See below.
│   │
│   ├── analysis/
│   │   ├── modes.js            Natural frequencies & mode shapes, 2D and 3D (Bathe subspace iteration)
│   │   ├── pdelta.js           P-Δ geometric nonlinearity (iterative geometric stiffness)
│   │   └── spectrum.js         Response spectrum (ASCE 7 / EC8, SRSS & CQC, 2D & 3D) + ASCE 7 §12.8 ELF
│   │
│   ├── calc/
│   │   ├── section_props.js    Section property calculator (I, A, centroid, Z…)
│   │   ├── beam_formulas.js    Classic beam closed-form solutions
│   │   ├── compound_section.js Compound section builder (add/subtract shapes)
│   │   ├── formula_library.js  Engineering formula reference library
│   │   ├── mohrs_circle.js     Mohr's circle for 2D stress state
│   │   ├── natural_freq.js     Single-DOF frequency estimator
│   │   └── pm_interaction.js   P-M interaction diagram renderer
│   │
│   ├── design/
│   │   ├── checks.js           EC3 member capacity checks (compression, bending, shear)
│   │   ├── aci_checks.js       ACI 318-19 RC checks (flexure, shear, columns, bearing)
│   │   ├── rc_design.js        EC2-2004 RC section design (parabolic-rectangular block)
│   │   ├── sections.js         Standard steel section database (W, IPE, HEA, CHS, RHS…)
│   │   ├── foundation.js       Foundation design (bearing capacity, settlement)
│   │   ├── modifiers.js        ACI §6.6.3.1 stiffness modifiers (EI reduction)
│   │   └── load_combos_generator.js  ASCE 7 / EN 1990 load combination generator
│   │
│   ├── report/
│   │   └── report.js           HTML report generator (BMD, SFD, tables, design summary)
│   │
│   ├── io/
│   │   └── fileio.js           File I/O — .frame (JSON), CSV forces, DXF, clipboard
│   │
│   └── utils/
│       └── units.js            SI ↔ Imperial unit conversion system
│
├── create_sections_db.py       Python script — generates sections_db.xlsx
├── sections_db.xlsx            Steel / Concrete / Timber section library (Excel)
├── viewcube_new.py             ViewCube SVG generator
├── AUDIT_FINDINGS.md           Code audit notes (point-in-time; some items since fixed)
├── tests/                      Regression suite (npm test) + minimal DOM stub
└── docs/asce7-16/              ASCE 7-16 reference pages, linked from the app
```

---

## Module Architecture

### window.SA — Live State Namespace

`app.js` exposes its internal closure state as `window.SA` so extension modules
(`generators.js`, `selection.js`) can read and write app state without being
inside the IIFE:

```js
// Read live state
const nodes = window.SA.nodes;       // always returns current nodes array
const beams = window.SA.beams;

// Write state (setter updates closure variable)
window.SA.results = null;
window.SA.nodes   = window.SA.nodes.filter(...);

// Call core functions
window.SA.addNode(x, y);
window.SA.snapshot();
window.SA.render();
window.SA.toast('Done', 'success');
```

### Script Load Order (mandatory)

```
view3d.js, extrude.js, frame_sections.js      (loaded first, in <head> — but only
                                               touch window.SA lazily, inside functions
                                               called later, never at top level, so
                                               loading before app.js exists is safe)
  ↓
perf.js  ←  indexeddb.js                      (infrastructure — no deps)
  ↓
[calc / design / analysis / solver scripts]
  ↓
app.js                                        (populates window.SA)
  ↓
generators.js, selection.js                   (use window.SA)
a11y-labels.js, dialog-ux.js, command-palette.js  (read the ribbon / dialog markup,
                                               so they need index.html parsed)
```

The actual `<script>` order lives in `index.html`; this is the dependency shape,
not a line-by-line transcript — `asce7/*` and `aci/*` chapter modules load last
and have no ordering constraint of their own.

### One store for sections and materials

`window.SA.sections` and `window.SA.materials` are the **only** copies. The two
Define dialogs read and write those arrays in place:

| Dialog | Module | Writes to |
|--------|--------|-----------|
| Define ▸ Sections | `js/features/frame_sections.js` (`FRAME_SEC`) | `SA.sections` |
| Define ▸ Materials | inline `MAT_UI` in `index.html` | `SA.materials` |
| Section Manager, Model explorer, solver | `app.js` | `SA.sections` |

Both dialogs previously kept private arrays in their own localStorage keys
(`sa_frame_secs_v5`, `sa_materials_v1`) and pushed them into `SA` by **name** —
on dialog close and on a `setTimeout` 1.5 s after every page load. That made
section and material definitions a property of the *browser* rather than of the
model, and the push overwrote whatever the model had: an edit made in the
Sections table, or a section loaded from a `.frame` file, was silently reverted
to the local copy's value, and the solver then ran on the reverted numbers.
Deletes never propagated and a rename produced a duplicate.

Both keys are now read **once** and merged into the model (`FRAME_SEC.init()`,
`MAT_UI.migrate()`, both called from `App.init()` after the session is
restored — materials first, since sections resolve their material by id). The
old keys are left in place so a rollback loses nothing.

Two kinds of section live in the one array:

- **Parametric** — has `shapeId` plus dimensions. `A`, `I`, `Iy`, `J`, `Sx`,
  `Sy`, `rx`, `ry` are derived by `_compute()` from the dimensions, and `E`,
  `fy`, `rho` from `materials[materialId]`. `_compute()` ends by calling
  `_flatten()`, which writes the solver-facing fields onto the same object — so
  the definition and the numbers derived from it cannot disagree. These cells
  are read-only in the Sections table.
- **General** — no `shapeId`. Properties were entered directly (Excel import,
  `+ Section`, Section Manager). Nothing recomputes them; fully editable.

Sections reference materials by `materialId`, not by name, so renaming a
material keeps every section attached to it. Editing a material re-applies its
`E`/`fy`/`ρ` to every section that uses it (`MAT_UI.applyToSections`) and
clears stale results. Deleting a material that sections use, or a section that
members use, is refused with the list of dependants.

Everything travels with the project: `materials` is in the autosave payload,
the undo snapshot, and the `.frame` file. A file written before materials were
part of the schema imports as `materials: null`, and the caller keeps its own
library rather than being handed an empty one.

### IndexedDB (StructDB)

> **Partly wired.** The results cache is live: `solveLinear()` fingerprints the
> model with `modelHash()`, returns a cached result on a hit, and writes one
> after each solve (clearing the cache if the browser rejects the write on
> quota). The fingerprint covers geometry, sections, loads, settlements and
> member releases, so a hinge or section change invalidates it.
>
> Still on `localStorage`: the auto-save and named saves, written by `app.js`
> to `sa_autosave_v1` / `sa_file_*`. `saveSections`/`searchSections`/
> `getAllSections`/`getSectionById` below are fully implemented and covered by
> the test suite, but nothing in the app calls them — section import
> (Excel/CSV) writes straight into `window.SA.sections` and never touches this
> store. A third store, `projects`, held `saveProject`/`loadProject` for
> exactly the auto-save job above; nothing ever called those either, so
> `DB_VERSION 2` (see `js/db/indexeddb.js`) removed the store outright rather
> than leave an empty one in every install.

Two stores for fast offline access:

| Store | Key | Purpose |
|-------|-----|---------|
| `sections` | auto-increment | Full section library; indexed by `material` + `nameSearch` — implemented, unused |
| `results_cache` | model hash | Skip re-solving unchanged models — live |

```js
// Import sections into DB after Excel/CSV load (implemented; nothing calls this yet)
await StructDB.saveSections(sections);

// Fast filtered search (no re-import needed) — implemented; nothing calls this yet
const steelSections = await StructDB.searchSections('W200', 'steel');

// Results cache — avoid re-solving unchanged models (this path is live)
const hash    = StructDB.modelHash(nodes, beams, sections, loads, settlements);
const cached  = await StructDB.getCachedResults(hash);
if (cached) { useResults(cached); } else { solve(); StructDB.cacheResults(hash, results); }
```

### Web Worker (solver.worker.js)

Offloads heavy FEM computations off the main thread. `app.js` creates the worker
lazily in `getSolveWorker()` and solves every load case in one `solve_all` round
trip; if the worker cannot be created (a `file://` origin blocks workers) or it
errors, `solveLinear()` falls back to solving inline on the main thread, so both
paths end up in `finishSolve()`. Note that anything it `importScripts` must guard
`window` assignments, since workers have no `window`:

```js
const worker = new Worker('js/workers/solver.worker.js');
worker.onmessage = e => {
  if (e.data.type === 'solve_result') applyResults(e.data.results);
  if (e.data.type === 'progress')     showProgress(e.data.pct, e.data.label);
  if (e.data.type === 'error')        showError(e.data.error);
};
worker.postMessage({ type: 'solve', model: { nodes, beams, sections, loads, settlements } });
// Also supports: 'pdelta' and 'modes' message types
```

---

## Analysis Capabilities

| Feature | Implementation |
|---------|---------------|
| 2D Linear Static | Direct Stiffness (K matrix partitioning, DOF penalty-free) |
| 3D Space Frame | 6-DOF/node, local↔global rotation matrix |
| P-Δ (2nd order) | Iterative geometric stiffness update |
| Natural Frequencies | Bathe subspace iteration (consistent mass matrix), 2D and 3D |
| 3D Modal | 6 DOF/node space frame — torsional and coupled modes 2D cannot represent, drawn and animated in the 3D view |
| Response Spectrum | Modal superposition, ASCE 7-16 §11.4.5 / EN 1998-1 §3.2.2.5 spectra, SRSS or CQC, 2D and 3D (X/Y/Z) |
| Equivalent Lateral Force | ASCE 7-16 §12.8 (Table 12.8-2 C<sub>t</sub>/x, Eq 12.8-2..6), used for the §12.9.1.4 scaling check |
| Elastic Critical Load | λcr per member from the P-Δ axial forces (EC3 §5.2.1 bands) |
| Load Combinations | ASCE 7 / EN 1990 linear superposition |
| Seismic load case | The spectrum's combined modal forces as an equivalent static EQ case, resolved to the design base shear, for the ±E combinations |
| Settlement | Prescribed displacement DOF |
| Self-weight | Distributed load from ρ·A·g per beam |
| Seismic mass | Member self-weight plus applied gravity loads, lumped to nodes and factored per load case (ASCE 7-16 §12.7.2 defaults) |

## Design Codes

| Code | Module | Checks |
|------|--------|--------|
| EC3-2005 | `design/checks.js` | Axial, bending, shear, combined |
| EC2-2004 | `design/rc_design.js` | Flexure, shear, crack width, span/depth, column N-M interaction (§6.1 strain compatibility) |
| ACI 318-19 | `design/aci_checks.js` | Flexure (φ=0.90), shear (φ=0.75), columns |

---

## Extending the App

To add a new tool or operation:

1. Create `js/core/my-module.js` — use `window.SA.*` for state access
2. Add `<script src="js/core/my-module.js"></script>` **after** `app.js` in `index.html`
3. Expose as `window.MyModule = { ... }`
4. Call from app.js event handlers via `window.MyModule?.myFunction()`

---

## Browser Requirements

Chrome 90+, Firefox 88+, Safari 15+, Edge 90+  
Requires: IndexedDB, Web Workers, SVG, CSS custom properties, ES2020

---

## License

[MIT](LICENSE). The license's no-warranty clause applies alongside the
disclaimer at the top of this file.
