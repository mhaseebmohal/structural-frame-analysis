# Structural Analyser — Prioritized Findings

## Correctness & Numerical Risk

**Concurrent worker solves can overwrite each other's results with no error**
`solveViaWorker()` attaches a fresh listener per call to the single shared worker, and the worker's `solve_all` reply carries no request id. If a second solve starts before the first resolves (double-click, autoSolve on a fast edit, or a racing cache lookup), the newer solve's promise can be satisfied by the older solve's message, silently displaying stale forces/reactions. `js/app.js:4689-4707, 5011-5032`; `js/workers/solver.worker.js:69-97`

**3D solver treats NaN pivots as valid and returns garbage as "success"**
`gaussSolve3D`'s singularity test (`Math.abs(piv) < REL_TOL*scale`) is always false for NaN, so a NaN pivot is never caught — the solve keeps dividing by NaN and returns NaN/Infinity displacements as if it were a normal result. The 2D solver was specifically rewritten to guard against exactly this. `js/solver3d.js:179,192`

**P-Delta second-order analysis is always run as 2D, even for 3D models**
`solvePDeltaAll()` calls `PDeltaAnalysis.runPDelta()` with no planar/`use3D` check, unlike the linear solve which explicitly branches on `isPlanarModel()`. A genuinely 3D frame with P-Delta enabled has its geometry silently collapsed to 2D and reports a physically meaningless result as a successful solve. `js/analysis/pdelta.js:139` (cf. `js/app.js:4914-4915`)

**Deflection Inspector shows the wrong bending moment for most solved members**
`DEFL_INSP.momentAt()` reimplements the internal-moment formula instead of calling the codebase's single source of truth, using `+ef.M1` where the correct formula (and the codebase's own comment) requires `-ef.M1`, and only handles `beam_dist` loads — silently ignoring `beam_point`/`beam_trap`. The adjacent `shearAt()` has the identical load-type blind spot for the "V" readout. `index.html:7269-7288`

**Modal analysis reports non-converged results as converged**
`subspaceIteration()` always returns its last iterate even when it exhausts `maxIter` (100) without ever passing its own relative-eigenvalue tolerance check; only an outright Cholesky failure is treated as an error. A model whose frequencies never actually converged is displayed with no indication anything is wrong. `js/analysis/modes.js:373-390` (call sites `1004-1006`, `1149-1151`)

**Compound Section Builder understates self-weight by ~78x**
`_pushCompoundSection()` hardcodes `rho: 1.0` on every section it pushes to the library instead of the app's normal steel default (78.5 kN/m3). Since self-weight is generated as `-rho*A`, any beam using a section built in the Compound Section tool gets self-weight silently understated by a factor of ~78.5. `js/app.js:10279-10289`

**EC0 "EQU" equilibrium combo carries zero seismic load when only an EQ case exists**
`generateEC0_ULS()`'s EQU branch triggers on `WL || EQ`, but its factor-assignment filter matches only `WL` cases. For an EQ-only model the combo is still generated and labeled "1.5WL," but contains only factored dead load — a materially wrong, mislabeled equilibrium check. `js/design/load_combos_generator.js:76-84`

**Punching shear check ignores the minor-axis moment**
`designPadFoundation()` computes bearing pressures with full biaxial (Mx, My) moments, but the `punchingShear()` call hardcodes `e_y=0`, dropping `My_uls` from the eccentricity factor beta entirely — understating punching demand for any biaxially loaded footing. `js/design/foundation.js:402-403`

**Footing's transverse direction is copied, not independently designed**
`designPadFoundation()` computes flexure/shear only in the X-direction (using L, col_L); the reported Y-direction reinforcement is the X-direction value copied over "for square footings," even though L, B, col_L, col_B are independent inputs with no enforcement that the footing is square. A rectangular footing's transverse direction is reported as checked when it was never calculated. `js/design/foundation.js:426` (calc at `384-397`)

**Section/load-case names from an imported or shared model execute as HTML**
Names arriving via a `.frame` file or a `?data=` share link are never sanitized, then written straight into `innerHTML` in the member popup, the case badge, and the cases pane — while an `escapeIssue()` helper already exists and is used elsewhere in the same file. A crafted name executes as script the moment the popup opens. `js/app.js:3723, 3823-3852, 5831, 5981`

**Response-spectrum scaling misreports itself at near-zero base shear**
The §12.9.1.4 scale-up guard (`baseShear > 0 && elf.V > baseShear`) and the equivalent-static-force scale factor both fall through when the modal base shear is zero/near-zero (negligible participation in a direction), leaving the structure unscaled — and the ELF path additionally emits a note claiming the base shear "already meets" the target, which is false whenever `elf.V > 0`. `js/analysis/spectrum.js:445, 527`

**3D solver has no near-mechanism / runaway-displacement sanity check**
The 2D solver explicitly flags a near-mechanism model when peak displacement exceeds 100x the model span; `solveFrame3D` has no equivalent after `gaussSolve3D` returns, so a near-mechanism 3D model that passes the pivot test silently returns kilometre-scale displacements as a successful solve. It also still uses the penalty method the 2D solver's own comments call ill-conditioned, rather than the exact DOF partitioning 2D moved to. `js/solver3d.js:408, 445-469`

**solver3d.js and modes.js disagree on how a custom restraint mask combines with "no support"**
solver3d.js skips a node entirely when `support` is unset/`'none'`, before ever checking a custom `fixedDOF` mask — silently dropping that node's restraint from the static solve. modes.js's parallel function was explicitly patched to guard this exact case, so the same model can be correctly restrained for modal analysis and unrestrained for the static solve. `js/solver3d.js:414` vs `js/analysis/modes.js:915`

**ACI column phi-factor strain limits are hardcoded, ignoring rebar grade**
`phiFromEpst()` hardcodes the compression-/tension-controlled strain boundaries (0.002/0.005) instead of deriving them from fy per ACI 318-19 Table 21.2.2, even though `columnCheck()` accepts an arbitrary `fy_rebar`. A separate, code-correct implementation (`ch6-columns.js`'s `phi_col`) exists but is never called, so any rebar grade other than ~Grade 60 gets a wrong phi/phiMn/phiPn. `js/design/aci_checks.js:44-53`

**Load dialog validates only area-load fields; every other load type accepts NaN silently**
Only the `area_load` branch of the "load-ok" handler filters and rejects invalid numeric input with a toast. Nodal, moment, beam_point, beam_dist and beam_trap all read fx/fy/m/pos straight off the input value with no isNaN/blank check, so a cleared field silently stores NaN and only surfaces later as an opaque solver failure. `js/app.js:8176-8219`

**Report's displacement/reaction tables aren't 3D-aware — the same bug already fixed in fileio.js**
`dispTable()`/`reactTable()` hardcode 2D-only fields (u/v/theta, Rx/Ry/M); a 3D solve's results have no `theta` field, so the report prints literal "NaN" for rotation and silently drops w/θx/θy/θz and Rz. fileio.js's CSV export had this identical bug and was explicitly fixed with an `is3D` branch — the fix was never carried over to the HTML report. `js/report/report.js:307-373`

## Data Integrity & Persistence

**File ▸ Export JSON silently drops load cases, combinations, id counters and metadata**
`exportJSON()` serializes only `{nodes, beams, sections, materials, loads, settlements}`, while the sibling `saveFile()` and `FileIO.importJSON()`'s own expected shape both include `loadCases`/`loadCombos`/`nextId`. Exporting then re-importing the same file silently reverts to the single default "Dead" load case with zero combinations. `js/app.js:6219-6226` (cf. `6138-6146`)

**Named File Save/Load does not persist or restore 3D mode, unlike autosave**
`autoSaveToLocal()`/`restoreSession()` explicitly save/restore `mode3D`/`view3D` with a comment that geometry and its coordinate convention must travel together; `saveFile()`/`loadFile()` never do. Reloading a named 3D save in a fresh session restores Z-lifted coordinates but leaves the app in 2D projection, flattening the model until the user manually re-enables 3D. `js/app.js:6138-6170`

**Named grid systems live only in localStorage — not saved with the project, autosave, or undo**
`GRIDSYS.apply()` persists grid lines only to `localStorage['sa_grids_v1']`; grids are absent from `currentStateStr()`/`autoSaveToLocal()` and from `exportJSON()`/`importJSON()`. A grid system does not survive Undo/Redo, does not travel with a shared `.frame` file, and silently reverts to whatever is in that browser's localStorage — the exact class of bug already fixed for materials. `index.html:8065-8069`

**Three .frame/.json import entry points apply inconsistent repair and validation**
The older `file-load` handler assigns imported data directly with no call to `sanitizeLoadedSections()` or `adoptMaterials()`; the newer `file-import-json` handler calls `sanitizeLoadedSections()`; the clipboard-import handler calls both. Loading the same legacy-schema file through different buttons produces different in-memory state. `js/app.js:7936-7961` vs `8034-8055` vs `8014-8032`

**importJSON performs no shape/type validation at the file/URL trust boundary**
`importJSON` only falls back on falsy/missing fields (`data.nodes || []`); it never checks the values are actually arrays. A malformed `.frame` file or `?data=` share link with e.g. `"nodes": {}` passes through unchanged and only fails later as an unhandled TypeError deep in the render path instead of a clean "Invalid file" message. `js/io/fileio.js:71-86`

## Incomplete Features vs Documented Behavior

**Beam Wizard's "Apply Self-Weight" checkbox is never read — checking it does nothing**
`runWizard()` reads every other wizard field but never queries `#wiz-selfwt` or calls the existing `applySelfWeight()` function. A user can check the box, click Generate, and get a beam with no self-weight load and no indication anything was skipped. `js/app.js:6273-6374` (checkbox: `index.html:3799-3803`)

**`ASCE7_Ch2`'s combination generator is dead code; `ASCE7_Ch1`'s Risk Category never reaches the Response Spectrum's I_e — RESOLVED (partially) 2026-09-29**
Re-investigated before fixing: the original claim that `ASCE7_Ch3_UI` is undefined was **stale/wrong** — it's defined at `index.html:5134-5383` and correctly wired from `js/app.js:9396`; no fix was needed there. `ASCE7_Ch2` (`js/asce7/ch2-load-combinations.js:22`) is genuinely dead (zero callers anywhere), but it is **not a safe drop-in** for the generator the "Generate Combos" button actually uses (`LoadCombosGenerator.generateASCE7()` in `js/design/load_combos_generator.js:135`) — for the combos both cover, the factors are numerically identical, just reached via a declarative table instead of imperative branches. Ch2's extra granularity (separate `EQv`/`EQh` seismic terms, `LLr`/`RL` roof-live/rain combos) depends on load-case `type`s the app's UI never produces (only `DL,LL,WL,EQ,SL,TL,OTHER` exist), so wiring it in as-is would generate **zero** seismic combos — a regression. Left alone; would need new load-case types plumbed through the whole app first, which is a feature, not a bug fix.

The one part of this that *was* a real, safely-fixable gap: `ASCE7_Ch1.getImportanceFactors()` computes the correct I_e from Risk Category and displays it as info text in the Combos dialog (`index.html:5402-5409`), but the Response Spectrum dialog's `I_e` field (`rs-ie`, `index.html:2318`) is a free-typed number with no connection to it at all — ASCE 7-16 Table 1.5-2 makes I_e a *derived* value, not an independent choice, so a user picking Risk Category IV (I_e=1.5) elsewhere could still run the spectrum at whatever `rs-ie` already had. Added a "↻ From Risk Cat." button next to `rs-ie` that fills it from the current Risk Category selection on click (not automatically, to avoid silently overwriting a value set for a real reason). `index.html:2318` (button), `index.html:5411-5426` (wiring).

**Command palette's ribbon index silently skips the entire "Generate" dropdown (12 commands)**
`buildIndex()` only collects elements matching `.rib-btn, .rib-btn-lg`; the Generate dropdown's 12 real actions (Simple Beam, Truss, Vierendeel, Arch, Beam Wizard, etc.) are plain `<button>` elements with none of those classes, so Ctrl+K search for "arch" or "truss" finds nothing, directly contradicting the module's own claim that any ribbon button is searchable with no extra wiring. `js/core/command-palette.js:58-62`; `index.html:125-141`

**Section-library CRUD bypasses the app's own accessible modal system**
`addNew()`, `addCopy()`, and `deleteSec()` use native `prompt()`/`alert()`/`confirm()` instead of the shared `.modal-overlay` system that `dialog-ux.js` was built specifically to give every dialog a focus trap and accessible labeling — the one place in the audited code where a dialog-like interaction skips that shared path. `js/features/frame_sections.js:551-584`

## Performance

**Default "color by section" rendering is O(n²) and runs on every mousemove/wheel tick**
`sectionColorIndex()` rebuilds an order-of-first-use array via a full scan of `beams` on every call; `drawBeams()` calls it once per beam whenever `colorBy === 'section'` (the documented default), and `render()` drives this unthrottled from `onMouseMove`/`onWheel` during panning, 3D-orbit, and scroll. A model of a few hundred members re-does an O(n²) scan dozens of times per second while the user simply pans or zooms. `js/app.js:1975` (scan at `148-156`)

**O(beams × nodes) linear scans inside extruded-3D drawing, re-run on every mousemove during orbit/pan**
`drawExtrudedBeams()` does `nodes.find()`/`sections.find()` per beam — two full array scans per beam — and `render()` calls it unconditionally on every mousemove while rotating or panning in 3D. A Map keyed by id, built once per draw call, would make each lookup O(1). `js/features/extrude.js:566-570`

**`mergeCoincidentNodes()` does an unguarded O(n²) pairwise distance scan**
The coincidence check compares every node against every other with no spatial bucketing or size guard. It's a user-triggered action rather than a render-loop cost, but the generators in the same file can produce hundreds of nodes, and merge is exactly the operation reached for after importing or generating a large grid. `js/core/selection.js:352-360`

## Dead Code & Cleanup

**Abandoned placeholder check in the ACI Ch.6 column calculator: always true, never read**
An `inside` value is computed via a loop whose body is `return true; // placeholder — we'll do proper check`, self-admitting it was never finished. The actual pass/fail badge uses a separate, correct computation a few lines later; `inside` is dead weight. `index.html:5996-6002`

**`DEFL_INSP.projectToMember()` is dead code — defined but never called or exported**
It projects a screen point onto a member's line in model space, but it's absent from `DEFL_INSP`'s returned API and has zero callers anywhere in the project. The actual xi-from-pointer logic lives entirely in `_setXiFromEvent()`, which works in pixel space and has nothing to do with this function — leftover from a superseded interaction design. `index.html:7382-7393`

**`PerfMonitor` is fully implemented but never invoked anywhere in the app**
A complete timer/log/overlay API was built "to see how long each analysis step takes," but no file anywhere calls `PerfMonitor.start`/`.end` — the solve pipeline it was meant to instrument never uses it. The module, its DOM overlay, and its CSS are dead weight loaded on every page view. `js/core/perf.js:9`

**`saveSections`/`searchSections`/`getAllSections`/`getSectionById` are implemented but never called**
README documents these as the intended Excel/CSV import workflow, but the real section-import path writes straight into the in-memory `sections` array and never touches `StructDB`. This is the same class of dead code the file's own header says was already removed once for a `projects` store. `js/db/indexeddb.js:83-127`

**"channel" primitive is computed but unreachable from the UI**
`primitiveProps()` and `_bounds()` both implement a full "channel" shape case, but the shape-type `<select>`, `SHAPE_PARAMS`, and the SVG preview renderer all omit it — there is no way to create a `channel`-typed shape from the UI. Calc logic was ported over but the UI wiring was never finished. `js/calc/compound_section.js:44` (also `124`)

**EI unit-conversion formula duplicated verbatim instead of reusing the shared helper**
`E*1e6 * I*1e-8` is hand-written in four separate `FORMULAS` entries and re-derived again independently in `natural_freq.js` and the test suite, even though `beam_formulas.js` already exports `calcEI()` for exactly this conversion. A future unit-convention change would need to be applied consistently across six locations with nothing enforcing it. `js/calc/formula_library.js:32,44,56,89`

**Brand-blue color hardcoded ~52 times; the CSS variable meant to hold it is never defined**
Three call sites reference `var(--accent, #1565c0)` as if an `--accent` variable exists, but it's never declared — the fallback literal is always what applies. The same literal is hand-written ~52 more times across two CSS files, none of which vary under dark mode, unlike `--focus-ring`. Any future rebrand needs a find-and-replace instead of one variable edit. `css/style.css:46` (usages e.g. `2138-2139, 2452`)

## Test Coverage Gaps

**ACI 318 chapter calculators (Ch1/Ch3/Ch4/Ch6) are live UI features with zero regression coverage**
`index.html` wires materials, flexure, shear, and column-interaction calculators into real "Design Calculator" dialogs, but none of `ch1-materials.js`, `ch3-flexure.js`, `ch4-shear.js`, or `ch6-columns.js` is ever loaded into a test VM context — only `ch5-development.js` is. A broken column interaction diagram or shear formula would ship without a single failing test. `tests/regression.js:35` (usage e.g. `index.html:5990`)

**Auto-generated ASCE7/EC0 load combinations (`LoadCombosGenerator`) are untested**
The "Generate Combinations" button builds a project's combination set from factor tables, but neither `load_combos_generator.js` nor `ch2-load-combinations.js` is loaded anywhere in the test suite. The groups that do test combinations only use manually constructed objects, so a wrong factor in the path most users actually click would pass the whole suite. `js/app.js:8826-8841`

**`PropertyModifiers` is never loaded in any test context, so the modifier round-trip test can't catch a regression**
`FileIO.exportJSON`'s `modifiers` field falls back to `{}` when `window.PropertyModifiers` is undefined; the "round-trip keeps the model intact" test group never defines it in its fixture, so that branch always exercises the empty-object fallback and can never detect a broken modifier export/import. `js/design/modifiers.js:1`

**Foundation sliding check, size optimizer, and HTML report builder have no dedicated test**
`slidingCheck` (EC7 sliding resistance), `optimizeSize`, and `buildReportHTML` are never called by name in the test suite; the pad-foundation test group only checks that the overall `checks[]` array has finite eta values, which can't catch a wrong sliding-resistance formula or threshold as long as the number stays finite. `js/design/foundation.js:292` (test group `tests/regression.js:469-527`)

**`CompoundSection` and `FormulaLibrary` dialogs have zero test coverage**
Both are live, wired-up dialogs (500+ lines each of property math / reference calculations), but neither module is loaded into any test VM context nor referenced by name anywhere in the suite. `js/app.js:9221-9237`

## Documentation Drift

**README's file tree and script-load-order diagram are stale**
Both list `js/core/constants.js`, which was deliberately deleted (asserted by the test suite itself, which checks it no longer exists) — a developer following the README will look for a file that's gone. The load-order diagram also omits three real `<script>` tags (`view3d.js`, `extrude.js`, `frame_sections.js`) that load before the documented "infrastructure" block, and omits `js/core/a11y-labels.js` entirely from both the file tree and the diagram. `README.md:89, 196-208`

**README documents a removed "projects" IndexedDB store and a removed `StructDB.saveProject` API**
The store table and code sample still describe auto-save/manual-save slots via `saveProject`, but the module's own header comment says this was removed in DB_VERSION 2 because nothing ever called it, and the test suite asserts all four related functions are `undefined`. `README.md:269-285`

**README's "sections" IndexedDB store is presented as a working example despite having zero callers**
README's own "partly wired" note admits the sections/projects stores are aspirational, but the code sample immediately below still shows `StructDB.saveSections()`/`searchSections()` as if runnable. Section CRUD actually reads/writes `window.SA.sections` directly and never touches `StructDB`. `README.md:273-283`

**`generators.js`'s module header documents only 3 of the 11 functions it actually exports**
The header says `window.AppGenerators = { generateFrame, generateTruss, generateContinuousBeam }`, but the module's return statement exports 8 more generators (`generateArch`, `generateFloorGrid`, `generateVierendeel`, etc.) that `index.html` calls directly, bypassing the header's implied surface area entirely. `js/core/generators.js:12` (exports at `684-689`)

## Tooling / DX

**No CI and no pre-commit hook — lint and the 1838-check regression suite are not wired together**
`package.json` defines `lint` and `test` as independent scripts with no `pretest`/`prepare` hook connecting them, and there is no `.github/workflows` directory anywhere in the repo. Both are enforced only if a developer remembers to run them by hand. `package.json:8-14`

**Test harness has no fault isolation between its ~100 groups — one thrown error silently voids everything after it**
A failed assertion is recorded and execution continues, but an actual thrown error (e.g. a null dereference) aborts the whole process immediately with no top-level try/catch: every later group never runs, and the run ends in a raw stack trace instead of the normal pass/fail summary — with no CI gating this file, a single crash can mask regressions across a large fraction of the suite with no clear signal they were skipped. `tests/regression.js:57-66, 7500-7507`
