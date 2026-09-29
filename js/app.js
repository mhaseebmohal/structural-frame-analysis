// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — Main Application
// ──────────────────────────────────────────────────────────────────

const App = (() => {
  // ── State ─────────────────────────────────────────────────────────
  let tool = 'select';

  let nodes    = [];
  let beams    = [];
  let sections = [
    // Concrete 9"×9" square section (229mm × 229mm) — default
    // A = 9×9 = 81 in² = 522.58 cm²  | I = 9⁴/12 = 546.75 in⁴ = 22,754 cm⁴
    // E = 25 GPa (normal concrete, ~3625 ksi)  | fy = 27.6 MPa (f'c ≈ 4000 psi)
    { id:1, name:'Conc 9"×9"',     E:25,  A:522.6, I:22754,  fy:27.6, rho:23.6 },
    { id:2, name:'Steel W200×100', E:210, A:127,   I:113000, fy:250,  rho:78.5 },
    { id:3, name:'Steel IPE 300',  E:210, A:53.8,  I:8356,   fy:235,  rho:78.5 },
    { id:4, name:'Concrete 30×60', E:30,  A:1800,  I:540000, fy:25,   rho:25   }
  ];
  // Materials used to live in MAT_UI's own closure and its own localStorage key
  // ('sa_materials_v1'), which meant they were a property of the BROWSER rather
  // than of the model: a project opened elsewhere silently picked up whatever
  // materials that machine happened to have. They are model state now, saved
  // and loaded with everything else, and sections point at them by id.
  let materials   = defaultMaterials();
  let loads       = [];
  let settlements = [];
  let results       = null;   // points into allCaseResults or allComboResults
  let designResults = null;   // from DesignChecks.runDesignChecks()
  let _modeData     = null;   // { modes: [...] } from ModeShapeAnalysis.computeModes
  let _spectrumData = null;   // last ResponseSpectrum.run() result, for the report
                              // Module scope: reset by New File / Clear Results,
                              // which live outside init().
  let _redrawModeShapes = null;  // set by init() — keeps the mode overlay aligned
  let projectMeta   = { title: 'Structural Analysis Report', engineer: '', company: '', notes: '' };

  // ── Load cases & combinations ─────────────────────────────────────
  // Dead and Live are the two cases essentially every model needs, and a model
  // with no cases at all cannot hold a load. Defined once here: the same literal
  // used to be repeated in five places, so adding Live in one of them would
  // have left the other four handing back a Dead-only model.
  function defaultLoadCases() {
    return [{ id: 1, name: 'Dead', type: 'DL', color: '#1565C0' },
            { id: 2, name: 'Live', type: 'LL', color: '#2e7d32' }];
  }
  /** Whatever came out of a file, guarantee at least one usable case. */
  /**
   * Which load case a load belongs to.
   *
   * This used to be `l.caseId || 1`, which assumes a case with id 1 exists.
   * Nothing guarantees that — the startup template numbers its cases 3, 4, 5 —
   * and when it does not, a load with a missing or zero caseId matches no case
   * at all. It is then dropped from every case AND every combination: the solve
   * succeeds, every reaction reads zero, and the only hint is that the load
   * arrow is drawn in the unresolved-case colour. Falling back to the first
   * real case keeps the load in the analysis where it can be seen and
   * corrected, instead of quietly deleting it.
   */
  function caseIdOf(l) {
    if (loadCases.some(c => c.id === l.caseId)) return l.caseId;
    return loadCases.length ? loadCases[0].id : l.caseId;
  }

  function loadCasesOr(saved) {
    return (Array.isArray(saved) && saved.length) ? saved : defaultLoadCases();
  }
  let loadCases  = defaultLoadCases();
  let loadCombos = [];
  let allCaseResults  = {};
  let allComboResults = {};
  let envelopeResult  = null;   // worst-of-all-combinations, built after each solve
  let activeDisplay   = { type:'case', id:1 };

  // ── Multi-select & rubber-band ────────────────────────────────────
  let multiSel   = { nodes: new Set(), beams: new Set() };
  let rubberBand = null;   // { x0,y0,x1,y1 } screen px while Shift-dragging

  let nextId = { node:1, beam:1, load:1, section:5, settlement:1, lcase:3, combo:1, material:10 };

  // Interaction
  let beamStart     = null;
  let pendingNodeId = null;

  // Canvas transform
  let pan   = { x: 0, y: 0 };
  let scale = 80;

  // Settings
  let cfg = {
    grid: true, snap: true, gridSize: 0.5,
    labels: true, beamLabels: true, angleSnap: false, autoSolve: false,
    // Member classification thresholds, degrees from horizontal. Settings
    // offered both fields and getMemberType() hardcoded 70 and 20, so moving
    // either changed nothing — while member type decides the C/B/BR label,
    // the colour, the per-type ACI stiffness modifiers and which design
    // checks a member is given.
    colAngle: 70, beamAngle: 20
  };

  // 3D Space Frame mode
  let mode3D = false;
  // 3D orbit angles — azimuth (rotation around Z-up) and elevation (tilt above XY plane)
  // The standard isometric camera: 45° azimuth, atan(1/√2) = 35.26° elevation.
  // Everything that means "go back to the default 3D view" uses this — the
  // View ribbon's Isometric button, the view cube's Home button and Home key,
  // the 2D/3D toggle's restore, and the generators. The orbit reset and the R
  // key used to use el = π/6 (30°) instead, which is dimetric, not isometric:
  // four controls that all mean the same thing landed on two different views,
  // and neither of the two matched the button labelled "Isometric".
  const ISO_AZ = Math.PI / 4, ISO_EL = 0.6155;
  let view3D = { az: ISO_AZ, el: ISO_EL };
  let rotating3D = false, rotStart3D = null;

  // Views
  let views = {
    bmd: true, sfd: false, nfd: false,
    defl: false, react: true, vals: true,
    fill: true, peaks: true,           // ETABS: fill diagrams + peak flags
    scale: 20, stress: false, energy: false, lengths: false,
    deflScale: 200, local: false,
    extrude: true,    // 3D member extrusion (show solid cross-section geometry in 3D mode)
    extrudeLines: true,  // show the wireframe centreline through an extruded solid.
                         // Off: fully invisible (still clickable — it is the pick
                         // target extrude.js's solids do not listen for) even when
                         // the member is selected, where it used to stay full-strength.

    colorBy: 'section',  // 'type' | 'section' — ETABS "View by Color".
                         // Defaults to section so members read as groups.
    drift: false,     // annotate inter-story drift ratios on canvas
    // View ▸ Show / Hide. VIEW_CTL has always written these two; nothing
    // declared or read them, so the toggles reported a state they never
    // produced. Declared here so they persist and restore like the rest.
    loads: true, supports: true,
  };

  // Section colour palette (ETABS-inspired distinct colours)
  const SECTION_PALETTE = [
    '#1565c0','#2e7d32','#c62828','#e65100',
    '#6a1b9a','#00695c','#f57f17','#ad1457',
    '#00838f','#558b2f','#4527a0','#37474f'
  ];

  /**
   * Palette slot for a section under "View by Colour > Section".
   *
   * Indexed by order of FIRST USE among the members, not by position in the
   * section library: the library holds ~25 entries, so indexing by library
   * position handed the two sections in a typical model adjacent palette slots
   * that look nearly identical. Order-of-use gives the first section slot 0,
   * the second slot 1, and so on — maximally separated. Shared with extrude.js
   * so the solids and the wireframe agree.
   */
  // The order-of-first-use map is built once and reused: drawBeams() asks for
  // it once per member on every render (which mousemove/wheel drive), and
  // rebuilding it per call made that O(n^2). It is dropped at the start of each
  // render() and whenever the model revision changes, and is also keyed on the
  // beams array identity/length so an unnoticed swap cannot serve a stale map.
  let _secOrderCache = null;
  function sectionColorIndex(sectionId) {
    if (!_secOrderCache || _secOrderCache.beams !== beams || _secOrderCache.n !== beams.length) {
      const map = new Map();
      for (const b of beams) {
        if (b.sectionId == null) continue;
        if (!map.has(b.sectionId)) map.set(b.sectionId, map.size);
      }
      _secOrderCache = { beams, n: beams.length, map };
    }
    const i = _secOrderCache.map.get(sectionId);
    return i === undefined ? 0 : i;
  }

  function sectionColor(sectionId) {
    return SECTION_PALETTE[sectionColorIndex(sectionId) % SECTION_PALETTE.length];
  }

  // Strain energy map (populated on each render when views.energy is on)
  let _strainEnergyMap = null;

  // Pan tracking
  let panning = false, panStart = null;

  // Selection
  let selNode = null, selBeam = null;

  // Load direction mode ('vert' | 'horiz' | 'angle' | 'custom')
  let loadDirMode = 'vert';

  // Tracks which load is being edited (null = adding new)
  let _editingLoadId = null;

  // ── Undo/Redo ─────────────────────────────────────────────────────
  const MAX_HISTORY    = 40;
  const SA_UNDO_KEY    = 'sa_undo_history_v1';
  let history   = [];   // stack of PRE-EDIT states (undo)
  let redoStack = [];   // states undone past (redo)
  let _autoSaveTimer = null;
  let _undoSaveTimer = null;

  // Serialised snapshot of everything undo/redo restores.
  // Named grid systems used to live only in GRIDSYS's own localStorage key,
  // so they were absent here — a grid line added or deleted did not survive
  // Undo/Redo, unlike every other model edit.
  function currentStateStr() {
    return JSON.stringify({ nodes, beams, sections, materials, loads, settlements, nextId, loadCases, loadCombos,
                             grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined });
  }

  /**
   * Record the state as it is NOW, before the caller mutates it.
   *
   * history is therefore a stack of PRE-EDIT states, and redoStack holds states
   * we have undone past. The previous implementation kept a single array plus a
   * cursor and assumed history[histIdx] was the *current* state — but snapshot()
   * stores the pre-edit state, so that slot went stale the instant the caller
   * mutated. Undo consequently stepped one edit too far and redo could never
   * reach the newest state: adding two nodes then undoing gave 11 → 9 → 10,
   * jumping backwards past a state and then forwards again.
   */
  // Results belong to the model they were computed from. Deleting every member
  // and section used to leave the diagrams and the summary on screen reporting
  // 80 kN of reaction for a model with nothing in it — numbers with no
  // structure behind them, which is the most dangerous thing this app can show.
  // Every model change bumps this; a solve records it; the accessor refuses to
  // hand back results stamped with a different revision.
  let _modelRev   = 0;
  let _resultsRev = -1;
  let _staleWarned = false;

  function bumpModelRev() { _modelRev++; _secOrderCache = null; }

  function resultsAreCurrent() {
    // The revision catches edits; the emptiness test catches any mutation path
    // that forgets to bump it, which is the failure this guards against.
    return _resultsRev === _modelRev && nodes.length > 0 && beams.length > 0;
  }

  function snapshot() {
    bumpModelRev();
    history.push(currentStateStr());
    if (history.length > MAX_HISTORY) history.shift();
    redoStack.length = 0;        // a fresh edit invalidates the redo branch
    updateUndoRedo();
    // Debounced autosave — writes to localStorage 600ms after last change
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(autoSaveToLocal, 600);
    // Persist undo history to localStorage (debounced, last 20 steps)
    clearTimeout(_undoSaveTimer);
    _undoSaveTimer = setTimeout(saveUndoHistory, 800);
  }

  function saveUndoHistory() {
    try {
      // Store only the last 20 steps to stay within storage limits
      const toSave = history.slice(-20);
      localStorage.setItem(SA_UNDO_KEY, JSON.stringify({ h: toSave, i: toSave.length - 1 }));
    } catch(e) { /* localStorage quota exceeded — skip silently */ }
  }

  function restoreUndoHistory() {
    try {
      const raw = localStorage.getItem(SA_UNDO_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.h) || !d.h.length) return false;
      history   = d.h;
      redoStack = [];
      updateUndoRedo();
      return true;
    } catch(e) { return false; }
  }

  // ── localStorage autosave ─────────────────────────────────────────
  const SA_AUTOSAVE_KEY = 'sa_autosave_v1';

  function autoSaveToLocal() {
    try {
      const payload = JSON.stringify({
        nodes, beams, sections, materials, loads, settlements,
        nextId, loadCases, loadCombos,
        // Persist the view mode: the coordinate convention depends on it, and
        // restoring geometry without it left the two out of step.
        mode3D, view3D,
        grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined,
        _savedAt: Date.now()
      });
      localStorage.setItem(SA_AUTOSAVE_KEY, payload);
      // Update status bar indicator
      const ind = document.getElementById('sb-autosave');
      if (ind) {
        ind.textContent = '● Saved';
        ind.style.color = '#2e7d32';
        // Fade to muted after 2 s
        clearTimeout(ind._fadeTimer);
        ind._fadeTimer = setTimeout(() => {
          if (ind) { ind.textContent = '●'; ind.style.color = '#94a3b8'; }
        }, 2000);
      }
    } catch (e) {
      console.warn('Autosave failed:', e.message);
    }
  }

  /**
   * Load the model out of a ?data= share link, if this page was opened with one.
   *
   * Returns true when a model was loaded, so the caller knows not to restore
   * the previous session over the top of it.
   */
  function loadSharedURLModel() {
    if (!window.FileIO || !FileIO.importFromURL) return false;
    let d;
    try { d = FileIO.importFromURL(); } catch (e) { d = { error: e.message }; }
    if (!d) return false;                       // no ?data= on the URL
    if (d.error || !Array.isArray(d.nodes) || !d.nodes.length) {
      toast('That shared link could not be read' +
            (d.error ? ': ' + d.error : '.') +
            ' Opening your last session instead.', 'warn');
      return false;
    }

    // Keep whatever was here. Following someone's link is not a decision to
    // throw away your own unsaved model.
    try {
      const prev = localStorage.getItem(SA_AUTOSAVE_KEY);
      if (prev) localStorage.setItem(SA_AUTOSAVE_KEY + '_replaced', prev);
    } catch (e) { /* storage full or blocked — the link still loads */ }

    nodes = d.nodes; beams = d.beams || [];
    sections = d.sections || []; loads = d.loads || [];
    settlements = d.settlements || []; nextId = d.nextId || nextId;
    sanitizeLoadedSections();
    adoptMaterials(d.materials, 'This shared link');
    loadCases  = loadCasesOr(d.loadCases);
    loadCombos = d.loadCombos || [];
    if (d.meta) projectMeta = { ...projectMeta, ...d.meta };

    // Restore the view mode alongside the geometry — same reasoning as
    // restoreSession()/loadFile(): a shared 3D model with no mode3D in its
    // data (links made before this travelled) is left in whatever mode this
    // session already defaults to at init, rather than forced to 2D.
    if (typeof d.mode3D === 'boolean') {
      mode3D = d.mode3D;
      if (mode3D && d.view3D && typeof d.view3D.az === 'number') view3D = { ...d.view3D };
      const b3 = document.getElementById('btn-3d');
      if (b3) { b3.classList.toggle('active', mode3D); setBtnLabel(b3, mode3D ? '3D ✓' : '3D'); }
      const orb = document.getElementById('btn-orbit-reset');
      if (orb) orb.style.display = mode3D ? '' : 'none';
      const nzr = document.getElementById('node-z-row');
      if (nzr) nzr.style.display = mode3D ? 'flex' : 'none';
    }
    if (d.grids) window.GRIDSYS?.setGrids?.(d.grids);

    // Everything restoreSession() does once it has the arrays. Returning true
    // without this left the model loaded but the node, member and load tables
    // still empty, and the canvas on its default zoom — the panels are not
    // redrawn anywhere else in init.
    //
    // The undo history is the one thing deliberately left behind: it belongs
    // to the session this link replaced, not to the model now on screen.
    updateNodeTable(); updateBeamTable(); updateSectionTable();
    updateLoadTable(); updateCasesPane(); populateDisplaySelector();
    fitToScreen(); render();
    snapshot();

    toast('Opened a shared model. Your previous session was kept — ' +
          'use File ▸ New to start clean.', 'info');
    return true;
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(SA_AUTOSAVE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.nodes) || d.nodes.length === 0) return false;
      nodes       = d.nodes;
      beams       = d.beams       || [];
      if (d.sections && d.sections.length) { sections = d.sections; sanitizeLoadedSections(); }
      // A payload written before materials joined the model has none; the
      // defaults already in place are the right answer, not an empty library.
      if (d.materials && d.materials.length) materials = d.materials;
      loads       = d.loads       || [];
      settlements = d.settlements || [];
      if (d.nextId) nextId = { ...nextId, ...d.nextId };
      loadCases   = loadCasesOr(d.loadCases);
      loadCombos  = d.loadCombos  || [];
      // Restore the view mode alongside the geometry. Set the flag directly
      // rather than clicking #btn-3d: the coordinates in the payload are
      // already in the saved mode's convention and must not be migrated again.
      if (d.mode3D) {
        mode3D = true;
        if (d.view3D && typeof d.view3D.az === 'number') view3D = { ...d.view3D };
        const b3 = document.getElementById('btn-3d');
        if (b3) { b3.classList.add('active'); setBtnLabel(b3, '3D ✓'); }
        const orb = document.getElementById('btn-orbit-reset');
        if (orb) orb.style.display = '';
        const nzr = document.getElementById('node-z-row');
        if (nzr) nzr.style.display = 'flex';
      }
      if (d.grids) window.GRIDSYS?.setGrids?.(d.grids);
      // Refresh all UI tables
      updateNodeTable(); updateBeamTable(); updateSectionTable();
      updateLoadTable(); updateCasesPane(); populateDisplaySelector();
      fitToScreen(); render();
      // Restore undo history for this session
      restoreUndoHistory();
      snapshot(); // take initial snapshot of restored state
      // Human-readable age
      let ageStr = '';
      if (d._savedAt) {
        const sec = Math.round((Date.now() - d._savedAt) / 1000);
        ageStr = sec < 60 ? ` (${sec}s ago)` : sec < 3600 ? ` (${Math.round(sec/60)}m ago)` : ` (${Math.round(sec/3600)}h ago)`;
      }
      toast(`Session restored${ageStr} — ${nodes.length} nodes, ${beams.length} members`, 'ok');
      return true;
    } catch (e) {
      console.warn('Session restore failed:', e.message);
      return false;
    }
  }

  function clearAutosave() {
    try { localStorage.removeItem(SA_AUTOSAVE_KEY); } catch (_) {}
  }

  // Undo and redo swap the whole model out, so anything computed from the
  // previous one is stale by definition.
  function undo() {
    bumpModelRev();
    if (!history.length) return;
    // Park the live state so redo can come back to it, then step to the most
    // recent pre-edit state.
    redoStack.push(currentStateStr());
    restoreSnapshot(history.pop());
    updateUndoRedo();
    toast('Undo', 'info');
  }

  function redo() {
    bumpModelRev();
    if (!redoStack.length) return;
    history.push(currentStateStr());
    restoreSnapshot(redoStack.pop());
    updateUndoRedo();
    toast('Redo', 'info');
  }

  function restoreSnapshot(s) {
    const d = JSON.parse(s);
    nodes = d.nodes; beams = d.beams; sections = d.sections;
    if (d.materials) materials = d.materials;
    loads = d.loads; settlements = d.settlements; nextId = d.nextId;
    sanitizeLoadedSections();
    loadCases  = loadCasesOr(d.loadCases);
    loadCombos = d.loadCombos || [];
    window.GRIDSYS?.setGrids?.(d.grids);
    results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
    selNode = null; selBeam = null;
    multiSel = { nodes: new Set(), beams: new Set() };
    updateNodeTable(); updateBeamTable(); updateSectionTable(); updateLoadTable();
    updateCasesPane(); populateDisplaySelector();
    // Define ▸ Sections and Define ▸ Materials render from these same arrays,
    // so an undo has to repaint them too if either is open.
    window.FRAME_SEC?.refresh?.();
    window.MAT_UI?.refresh?.();
    render();
    updateUndoRedo();
  }

  function updateUndoRedo() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.classList.toggle('disabled', history.length === 0);
    if (btnRedo) btnRedo.classList.toggle('disabled', redoStack.length === 0);
  }

  // ── Toast notifications ───────────────────────────────────────────
  // ── Errors and warnings that stay put ─────────────────────────────
  //
  // A solver message used to be a toast that vanished after 2.1 seconds —
  // long enough to notice, not long enough to read, and gone before you could
  // act on it. Anything the user has to DO something about now opens a dialog
  // that waits, and carries the fix alongside the message.
  //
  // Each entry is matched against the raw message text; the first hit supplies
  // the explanation and the steps. Order matters — specific before general.
  const ISSUE_GUIDE = [
    {
      re: /has no section assigned|no valid section|does not exist(?!.*node)|No member could be analysed/i,
      what: 'A member has no section, so it carries no properties — no area, no ' +
            'stiffness — and the analysis has nothing to assemble from it.',
      how: ['Open <b>Define ▸ Sections</b> and create a section if the list is empty.',
            'Click the member on the canvas, then assign the section in the <b>Props</b> panel.',
            'Members drawn before any section existed are created without one — that is ' +
            'the usual cause.',
            'Press <b>SOLVE</b> again.']
    },
    {
      re: /references a node that does not exist/i,
      what: 'A member points at a node that is no longer in the model, so it cannot ' +
            'be placed in space.',
      how: ['Delete that member and draw it again between two existing nodes.']
    },
    {
      re: /zero length/i,
      what: 'A member starts and ends at the same point, so it has no direction and ' +
            'no stiffness.',
      how: ['Move one of its two nodes apart, or delete the member.',
            'This usually comes from clicking the same node twice while drawing.']
    },
    {
      re: /Nothing restrains horizontal movement/i,
      what: 'Every support is a roller. Rollers hold the structure up but let it ' +
            'slide sideways, so the whole model can drift horizontally without ' +
            'resistance — mathematically a mechanism, not a structure.',
      how: ['Change one support to a <b>pin</b> (holds both directions).',
            'A simply supported beam is <b>pin at one end, roller at the other</b> — ' +
            'the roller is what lets it expand freely.',
            'Use the <b>Supp</b> tool, click the node, and pick Pin.']
    },
    {
      re: /Nothing restrains vertical movement/i,
      what: 'No support holds the structure up, so it falls as a rigid body.',
      how: ['Add a pin, roller or fixed support with the <b>Supp</b> tool.']
    },
    {
      re: /can spin about it|does not resist rotation/i,
      what: 'There is only one support and it allows rotation, so the structure ' +
            'pivots freely about that point.',
      how: ['Add a second support somewhere else on the structure, or',
            'change the single support to <b>fixed</b>, which resists rotation.']
    },
    {
      re: /All DOFs constrained/i,
      what: 'Every degree of freedom is held by a support, so there is nothing left ' +
            'free to move and nothing to solve. A two-node member fixed at both ends ' +
            'is the usual case.',
      how: ['Add a node partway along the member so it has somewhere to deflect.',
            'Or release one support from fixed to pin.']
    },
    {
      re: /one plane|out-of-plane/i,
      what: 'Every node lies in a single plane, but the model is being analysed in 3D, ' +
            'where nothing stops it swinging out of that plane.',
      how: ['Switch to <b>2D mode</b> with the 2D/3D button — a flat frame belongs there.',
            'Or, if it really is a 3D structure, add supports that restrain the ' +
            'out-of-plane direction.']
    },
    {
      re: /no longer exists/i,
      what: 'A load is attached to a member or node that has since been deleted. The ' +
            'solver skips it, so that load contributes nothing.',
      how: ['Open the <b>Loads</b> table and delete or re-target the stray load.',
            'If reactions came out at zero, this is why.']
    },
    {
      re: /No supports defined/i,
      what: 'The structure is not attached to anything, so it is free to float away.',
      how: ['Pick the <b>Supp</b> tool and click the nodes that rest on the ground.']
    },
    {
      re: /No nodes defined|No beams defined/i,
      what: 'There is nothing to analyse yet.',
      how: ['Draw nodes with the <b>Node</b> tool, then join them with <b>Beam</b>.',
            'Or start from a template under <b>Define ▸ Generate</b>.']
    },
    {
      re: /No mass in model/i,
      what: 'Dynamic analysis needs mass, which comes from each section’s unit ' +
            'weight and area.',
      how: ['Give every section a unit weight <b>ρ</b> and an area <b>A</b> in ' +
            '<b>Define ▸ Sections</b>.',
            'To include floor loading as seismic mass, tick <b>From applied loads</b> ' +
            'in the Response Spectrum dialog.']
    },
    {
      re: /did not converge/i,
      what: 'The mode-shape iteration could not settle, which normally means the model ' +
            'is unstable or a section is missing properties.',
      how: ['Check the structure solves under an ordinary <b>SOLVE</b> first.',
            'Make sure every section has E, A and I set.']
    },
    {
      re: /singular/i,
      what: 'The stiffness matrix cannot be inverted: some part of the model can move ' +
            'without anything resisting it.',
      how: ['Check every member has a section assigned.',
            'Check the supports prevent sliding, lifting and spinning.',
            'Check no member is left dangling with a free end.']
    }
  ];

  function issueGuide(msg) {
    for (const g of ISSUE_GUIDE) if (g.re.test(msg)) return g;
    return null;
  }

  const _issuesSeen = new Set();
  let _issuesMuted = false;

  /** Show a message that the user has to act on, and keep it on screen. */
  function showIssue(msg, kind) {
    const list = document.getElementById('issues-list');
    if (!list) { return false; }            // dialog not in the DOM — caller falls back

    // Repeating the same complaint verbatim adds noise, not information.
    const key = kind + '|' + msg;
    if (_issuesSeen.has(key)) { openModal('modal-issues'); return true; }
    _issuesSeen.add(key);

    const isErr = kind === 'error';
    const g = issueGuide(msg);
    const accent = isErr ? '#c62828' : '#e65100';

    const row = document.createElement('div');
    row.style.cssText = 'border-left:4px solid ' + accent + ';padding:8px 12px;margin:10px 0;' +
                        'background:var(--bg-pane);border-radius:0 6px 6px 0';
    row.innerHTML =
      `<div style="font-weight:700;color:${accent};font-size:12px;margin-bottom:4px">` +
        `${isErr ? '⚠ Error' : '⚠ Warning'}</div>` +
      `<div style="font-size:12.5px;line-height:1.5;margin-bottom:${g ? '8px' : '0'}">` +
        `${escapeIssue(msg)}</div>` +
      (g ? `<div style="font-size:11.5px;color:var(--text-sec);line-height:1.55;` +
             `margin-bottom:6px"><b>What this means.</b> ${g.what}</div>` +
           `<div style="font-size:11.5px;line-height:1.6"><b>How to fix it</b>` +
           `<ol style="margin:4px 0 0 16px;padding:0">` +
           g.how.map(h => `<li style="margin-bottom:3px">${h}</li>`).join('') +
           `</ol></div>`
         : '');
    list.appendChild(row);

    const title = document.getElementById('issues-title');
    if (title) title.textContent = isErr ? 'Problem to fix' : 'Something to check';
    openModal('modal-issues');
    return true;
  }

  // The message text is ours, but a section or member name could reach it, so
  // escape before it goes anywhere near innerHTML.
  function escapeIssue(v) {
    return String(v).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function toast(msg, type = '') {
    // Errors and warnings go to a dialog that waits for the user instead of a
    // toast that disappears in two seconds. Everything else — 'Solved 3 cases',
    // 'Working plane: XZ' — is confirmation, not something to act on, and stays
    // a toast. The checkbox in the dialog puts errors back to toasts for anyone
    // who finds the interruption worse than the loss.
    if ((type === 'error' || type === 'warn') && !_issuesMuted && showIssue(msg, type))
      return;
    const container = document.getElementById('toast-container');
    const div = document.createElement('div');
    div.className = 'toast' + (type ? ' ' + type : '');
    div.textContent = msg;
    div.title = 'Click to dismiss';
    container.appendChild(div);

    // Every message used to vanish after 2.1 seconds whatever its length, so a
    // long one was gone before it could be read. Give it reading time instead:
    // roughly 55 ms a character — about 220 words a minute, unhurried — with a
    // 4.5 s floor so even 'Saved' is comfortably readable, and a ceiling so a
    // very long message does not camp on the canvas.
    const dwell = Math.min(15000, Math.max(4500, msg.length * 55));

    let timer = null;
    const dismiss = () => {
      if (!div.isConnected) return;
      div.classList.add('fading');
      setTimeout(() => div.remove(), 400);
    };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(dismiss, ms); };

    // Reading it should not be a race: hovering holds it, and leaving gives a
    // fresh couple of seconds rather than cutting off mid-sentence.
    div.addEventListener('mouseenter', () => clearTimeout(timer));
    div.addEventListener('mouseleave', () => arm(2000));
    div.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
    arm(dwell);
  }

  // ── Tooltip ───────────────────────────────────────────────────────
  let tooltipTimer = null;

  function showTooltip(msg, x, y) {
    clearTimeout(tooltipTimer);
    const el = document.getElementById('tooltip-box');
    el.textContent = msg;
    el.style.left = (x + 14) + 'px';
    el.style.top  = (y - 6) + 'px';
    el.classList.add('visible');
  }

  function hideTooltip() {
    clearTimeout(tooltipTimer);
    document.getElementById('tooltip-box').classList.remove('visible');
  }

  // ── Button label helper ───────────────────────────────────────────
  // Toolbar buttons carry a .tb-lbl span, but the hidden compatibility
  // shims in index.html are plain text buttons — fall back to the button.
  function setBtnLabel(btn, text) {
    if (!btn) return;
    (btn.querySelector('.tb-lbl') || btn).textContent = text;
  }

  // ── Dark mode ─────────────────────────────────────────────────────
  function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    setBtnLabel(document.getElementById('btn-darkmode'), isDark ? 'Dark' : 'Light');
    drawScaleBar();
    render();
  }

  // ── DOM refs ──────────────────────────────────────────────────────
  const svg         = () => document.getElementById('canvas');
  const layerGrid    = () => document.getElementById('layer-grid');
  const layerExtrude = () => document.getElementById('layer-extrude');
  const layerBeams   = () => document.getElementById('layer-beams');
  const layerNodes   = () => document.getElementById('layer-nodes');
  const layerSupp    = () => document.getElementById('layer-supports');
  const layerLoads   = () => document.getElementById('layer-loads');
  const layerRes     = () => document.getElementById('layer-results');
  const layerLabels  = () => document.getElementById('layer-labels');
  const layerTemp    = () => document.getElementById('layer-temp');

  // ── Coordinate helpers ────────────────────────────────────────────
  function mToS(mx, my) {
    return { x: mx * scale + pan.x, y: -my * scale + pan.y };
  }

  function sToM(sx, sy) {
    return { x: (sx - pan.x) / scale, y: -(sy - pan.y) / scale };
  }

  function snapPt(mx, my) {
    if (!cfg.snap) return { x: mx, y: my };
    const g = cfg.gridSize;
    return { x: Math.round(mx / g) * g, y: Math.round(my / g) * g };
  }

  // ── 3D orbit projection  (Z-UP — matches ETABS/SAP2000 convention) ──────
  // Orthographic parallel projection with dynamic azimuth and elevation.
  // X = east, Y = north/depth (horizontal plan), Z = up (elevation)
  // Right basis (world→screenX): [cos(az), -sin(az), 0]
  // Up   basis  (world→screenY): [sin(az)·sin(el), cos(az)·sin(el), cos(el)]
  function mToS3D(x, y, z) {
    const ca = Math.cos(view3D.az), sa = Math.sin(view3D.az);
    const ce = Math.cos(view3D.el), se = Math.sin(view3D.el);
    return {
      x:  (x * ca - y * sa) * scale + pan.x,
      y: -(x * sa * se + z * ce + y * ca * se) * scale + pan.y
    };
  }
  // ── Working plane for 3D drawing ─────────────────────────────────
  // plane: 'XZ' (front, y=const), 'XY' (plan, z=const), 'YZ' (side, x=const)
  let _workPlane  = 'XZ';   // default: XZ front elevation (matches default structure)
  let _workLevel  = 0;      // the fixed axis value (y=0 for XZ, z=0 for XY, x=0 for YZ)

  // Inverse: screen (sx,sy) → world (x,y,z) on the current working plane
  function sToM3D(sx, sy) {
    const az = view3D.az, el = view3D.el;
    const ca = Math.cos(az), sa = Math.sin(az);
    const ce = Math.cos(el), se = Math.sin(el);
    const u  = (sx - pan.x) / scale;   // rotated x-component
    const sv = (sy - pan.y) / scale;   // −(elevation terms)
    // sv = -(se*(sa*x + ca*y) + ce*z)  … general formula
    const g = cfg.gridSize;

    let wx, wy, wz;
    // When the working plane turns edge-on to the camera, a screen point no
    // longer picks a unique point on it — the maths divides by a vanishing
    // cosine. The old `ce || 0.001` guard only caught an *exact* zero, so a
    // plan view (el = 90°, cos = 6e-17) sailed through and produced coordinates
    // hundreds of kilometres out. Flag it instead and let callers refuse.
    const EDGE_ON = 0.02;   // ≈1.1° from edge-on
    let degenerate = false;

    if (_workPlane === 'XZ') {
      // Fixed: y = _workLevel (front-elevation plane)
      // u = ca*x - sa*y  → x = (u + sa*y) / ca   (if ca ≠ 0)
      // sv = -(se*(sa*x+ca*y) + ce*z)
      const y0 = _workLevel;
      if (Math.abs(ca) > 0.05) {
        wx = (u + sa * y0) / ca;
      } else {
        wx = (-sv / se - ce * 0) / sa || 0;
      }
      degenerate = Math.abs(ce) < EDGE_ON;
      wz = degenerate ? 0 : -(sv + se * (sa * wx + ca * y0)) / ce;
      wy = y0;
    } else if (_workPlane === 'XY') {
      // Fixed: z = _workLevel (plan-view plane)
      // sv = -(se*(sa*x+ca*y) + ce*z0)  → sa*x+ca*y = -(sv+ce*z0)/se
      const z0 = _workLevel;
      degenerate = Math.abs(se) < EDGE_ON;   // elevation view — plan is edge-on
      const v  = degenerate ? 0 : -(sv + ce * z0) / se;
      wx =  u * ca + v * sa;
      wy = -u * sa + v * ca;
      wz = z0;
    } else {
      // YZ: fixed x = _workLevel
      const x0 = _workLevel;
      // u = ca*x0 - sa*y  → y = (ca*x0 - u) / sa
      if (Math.abs(sa) > 0.05) {
        wy = (ca * x0 - u) / sa;
      } else {
        wy = (-sv / se - ce * 0) / ca || 0;
      }
      degenerate = Math.abs(ce) < EDGE_ON;
      wz = degenerate ? 0 : -(sv + se * (sa * x0 + ca * wy)) / ce;
      wx = x0;
    }

    // Snap to grid
    if (cfg.snap) {
      wx = Math.round(wx / g) * g;
      wy = Math.round(wy / g) * g;
      wz = Math.round(wz / g) * g;
    }
    return { x: wx, y: wy, z: wz, degenerate };
  }

  // Expose working plane controls for the UI
  function setWorkPlane(plane, level) {
    _workPlane = plane;
    if (level !== undefined) _workLevel = +level || 0;
    // Update the toolbar display. The UI is three .wp-btn buttons — the old
    // #work-plane-sel <select> does not exist, so the highlight only caught up
    // when WORKPLANE's 300ms poller next ran.
    document.querySelectorAll('.wp-btn').forEach(b =>
      b.classList.toggle('active', b.id === 'wp-btn-' + plane));
    const lvl = document.getElementById('work-plane-level');
    if (lvl) lvl.value = _workLevel;
    toast('Working plane: ' + plane + ' (fixed=' + _workLevel.toFixed(2) + 'm)', 'info');
    render();
  }
  // Helper: project a node to screen using 2D or 3D
  // In 2D mode: if nd.y===0 and nd.z is set (Z-lifted structure), use nd.z for vertical
  /**
   * True 3D length of a member, and its in-plane angle.
   *
   * Several places computed length as hypot(dx, dy), which is correct only for
   * a plain 2D model. Every model the generators produce is Z-lifted (elevation
   * in nd.z, nd.y === 0), so a vertical column came out with length 0.000 m —
   * in the member tooltip, the properties popup and, more seriously, the
   * buckling parameters table that feeds effective-length checks.
   * The true distance is correct under either convention.
   */
  function memberLength(ni, nj) {
    if (!ni || !nj) return 0;
    return Math.hypot(nj.x - ni.x, (nj.y || 0) - (ni.y || 0), (nj.z || 0) - (ni.z || 0));
  }

  // In-plane inclination, measured against whichever axis carries elevation.
  function memberAngleDeg(ni, nj) {
    if (!ni || !nj) return 0;
    const dx = nj.x - ni.x;
    const dyR = (nj.y || 0) - (ni.y || 0);
    const dzR = (nj.z || 0) - (ni.z || 0);
    const dv = (Math.abs(dyR) < 1e-10 && Math.abs(dzR) > 1e-10) ? dzR : dyR;
    return Math.atan2(dv, dx) * 180 / Math.PI;
  }

  // True when the model already stores elevation in Z with Y flat — the
  // convention liftToZ produces and that solver.js / nodeToS both understand.
  // Used to keep the 2D→3D migration idempotent.
  function isZLiftedModel() {
    return nodes.length > 0 &&
           nodes.some(n => (n.z || 0) !== 0) &&
           nodes.every(n => !n.y);
  }

  // Which axis carries elevation for storey/level logic. In 3D and in Z-lifted
  // models that is Z; in a plain 2D model it is Y. Evaluate once per pass —
  // isZLiftedModel() walks every node, so calling it per node is quadratic.
  function verticalIsZ() { return mode3D || isZLiftedModel(); }

  function nodeToS(nd) {
    if (mode3D) return mToS3D(nd.x, nd.y || 0, nd.z || 0);
    const yFor2D = (nd.y === 0 && nd.z) ? nd.z : nd.y;
    return mToS(nd.x, yFor2D);
  }

  /**
   * A node's projected position at scale = 1, pan = 0.
   *
   * Both projections are affine in scale and pan — mToS gives
   * (x*scale + pan.x, -y*scale + pan.y) and mToS3D the same with (u, v) in
   * place of (x, y) — so anything that needs to solve for scale and pan, rather
   * than apply them, works in these units. Kept next to nodeToS because it has
   * to track it exactly: the u/v here are mToS3D's two rows, and the 2D branch
   * repeats nodeToS's Z-lifted rule.
   */
  function nodeToUnit(nd) {
    if (mode3D) {
      const ca = Math.cos(view3D.az), sa = Math.sin(view3D.az);
      const ce = Math.cos(view3D.el), se = Math.sin(view3D.el);
      const x = nd.x, y = nd.y || 0, z = nd.z || 0;
      return { u: x * ca - y * sa, v: x * sa * se + z * ce + y * ca * se };
    }
    return { u: nd.x, v: (nd.y === 0 && nd.z) ? nd.z : nd.y };
  }

  /**
   * Screen direction (unit vector) of a load vector, for drawing its arrow.
   *
   * Loads are stored in the solver's 2D-first naming: fx is global X, fy is the
   * VERTICAL component — global Z in the Z-up 3D world — and fz is the depth
   * component, global Y. solver3d.js assembles them that way into the 6-DOF
   * force vector.
   *
   * The arrows were drawn straight from (fx, -fy) as though those were screen
   * pixels, which holds only in 2D. In 3D the camera was never consulted, so a
   * load along global X stayed pinned to the screen horizontal however far you
   * orbited — and since screen-horizontal is a different world direction at
   * every azimuth, the arrow claimed a direction the load did not have. fz was
   * ignored outright, so a depth-direction load drew no arrow at all.
   *
   * Returns null when the vector points at or away from the camera and so
   * projects to a point, leaving no direction to draw.
   */
  function loadDirToS(fx, fy, fz) {
    fx = fx || 0; fy = fy || 0; fz = fz || 0;
    let dx, dy;
    if (mode3D) {
      const ca = Math.cos(view3D.az), sa = Math.sin(view3D.az);
      const ce = Math.cos(view3D.el), se = Math.sin(view3D.el);
      // World vector (X, Y, Z) = (fx, fz, fy) through mToS3D's two rows; the
      // pan/scale translation cancels in a direction, leaving just the rotation.
      dx =  fx * ca - fz * sa;
      dy = -(fx * sa * se + fy * ce + fz * ca * se);
    } else {
      dx = fx; dy = -fy;
    }
    const m = Math.hypot(dx, dy);
    return m < 1e-9 ? null : { x: dx / m, y: dy / m };
  }

  function snapAngle(mx, my, fromNode) {
    if (!cfg.angleSnap || !fromNode) return { x: mx, y: my };
    const dx = mx - fromNode.x, dy = my - fromNode.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: mx, y: my };
    const angle = Math.atan2(dy, dx);
    const snap  = Math.PI / 12; // 15°
    const snappedAngle = Math.round(angle / snap) * snap;
    return {
      x: fromNode.x + Math.cos(snappedAngle) * len,
      y: fromNode.y + Math.sin(snappedAngle) * len
    };
  }

  function svgPt(e) {
    const rect = svg().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Rendering ─────────────────────────────────────────────────────
  // Tear down the mode-shape overlay: drop the computed modes, remove the drawn
  // shapes and info box, and hide the mode bar. The overlay lives on its own
  // layer that render() never clears, so the reset paths must clear it directly.
  function resetModeOverlay() {
    _modeData = null;
    document.querySelectorAll('.sv-mode-shape').forEach(el => el.remove());
    const box = document.getElementById('mode-info-overlay');
    if (box) box.remove();
    const bar = document.getElementById('mode-bar');
    if (bar) bar.style.display = 'none';
  }

  // ── Screen-space label declutter ──────────────────────────────────
  // Node, member, length and load labels are all positioned from model
  // geometry, so in the isometric view they routinely land on top of each
  // other (a node tag printing straight through a load value, for instance).
  // Every label reserves the box it occupies; later labels step away from
  // space that is already taken, and give up rather than overprint.
  let _labelBoxes = [];
  function clearLabelBoxes() { _labelBoxes = []; }

  function _boxesOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Reserve a box outright (for labels that own their position, e.g. loads).
  function reserveLabelBox(x, y, w, h) {
    _labelBoxes.push({ x, y, w, h });
  }

  /**
   * Find a free spot near (x, y) for a w×h label, stepping vertically away
   * from collisions. `anchor` matches the text-anchor: 'middle' or 'start'.
   * Returns {x, y} to draw at, or null when the area is too crowded — callers
   * skip the label instead of adding to the pile.
   */
  function placeLabel(x, y, w, h, anchor) {
    const STEP = 12, MAX_STEPS = 5;
    // Labels carry a 3px halo stroke, which getBBox() counts, plus we want a
    // little breathing room — so reserve slightly more than the glyph box.
    const PAD  = 3;
    const left = (anchor === 'middle' ? x - w / 2 : x) - PAD;
    const bw   = w + PAD * 2;
    const bh   = h + PAD * 2;
    for (let i = 0; i <= MAX_STEPS; i++) {
      const offsets = i === 0 ? [0] : [-i * STEP, i * STEP];
      for (const dy of offsets) {
        const box = { x: left, y: y - h - PAD + dy, w: bw, h: bh };
        if (!_labelBoxes.some(b => _boxesOverlap(box, b))) {
          _labelBoxes.push(box);
          return { x, y: y + dy };
        }
      }
    }
    return null;
  }

  // Rough text width — the SVG labels use a ~11px sans font.
  function labelWidth(text, fontPx) {
    return text.length * fontPx * 0.55 + 4;
  }

  /**
   * On-canvas notice explaining what the extruded view hides.
   *
   * Load arrows and per-member force labels are drawn on the member centreline,
   * so once solids are showing they sit inside the extrusion and read as noise.
   * They are suppressed — but silently hiding a user's loads is worse than the
   * clutter, so say so, name exactly what is hidden, and give the way back.
   */
  function updateExtrudeHint() {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;
    let el = document.getElementById('extrude-hint');

    const extruded  = mode3D && views.extrude;
    const nLoads    = loads.length;
    const hasForces = !!(getActiveResults() && getActiveResults().success);

    // Nothing is being hidden — no notice to show.
    if (!extruded || (nLoads === 0 && !hasForces)) {
      if (el) el.remove();
      return;
    }

    const hidden = [];
    if (nLoads)    hidden.push(`${nLoads} applied load${nLoads === 1 ? '' : 's'}`);
    if (hasForces) hidden.push('member force labels');

    if (!el) {
      el = document.createElement('div');
      el.id = 'extrude-hint';
      wrap.appendChild(el);
    }
    el.innerHTML =
      `<b>Extruded view</b> — ${hidden.join(' and ')} hidden for clarity.` +
      `<br><span class="eh-sub">Turn off <b>Extrude</b> to show them again.` +
      (hasForces ? ' Force diagrams (BMD/SFD/NFD) still display.' : '') +
      `</span>`;
  }

  function render() {
    _secOrderCache = null;
    clearLabelBoxes();
    // Compute strain energy map if needed
    if (views.energy) {
      const res = getActiveResults();
      _strainEnergyMap = computeStrainEnergyMap(res);
    } else {
      _strainEnergyMap = null;
    }
    drawGrid();
    // 3D solid extrusion (drawn below the wireframe). extrude.js ships a much
    // better renderer — real cross-section profiles, Phong shading, per-face
    // depth sort — but this closure-local function shadowed the global it
    // publishes, so internal renders silently used the flat-ribbon fallback
    // below and only external SA.render() callers saw the good one.
    if (window.EXTRUDE && window.EXTRUDE.draw) window.EXTRUDE.draw();
    else drawExtrudedBeams();
    drawResults();
    drawBeams();
    drawSupports();
    drawLoads();
    drawNodes();
    drawLabels();
    drawScaleBar();
    updateColorLegend();
    updateExtrudeHint();
    // Mode shapes are baked into screen coordinates, so they must be rebuilt
    // whenever the view changes or they drift away from the model.
    if (_redrawModeShapes) _redrawModeShapes();
  }

  function updateColorLegend() {
    const el = document.getElementById('color-legend');
    if (!el) return;
    const _activeRes = getActiveResults();
    const hasResults = _activeRes && _activeRes.success;

    if (!hasResults) {
      // Member type legend
      el.innerHTML = `
        <span class="leg-title">Members:</span>
        <span class="leg-item"><span class="leg-dash" style="background:#1565C0"></span> Beam</span>
        <span class="leg-item"><span class="leg-dash" style="background:#1a237e;height:4px"></span> Column</span>
        <span class="leg-item" title="Brace (BR) — diagonal member classified by angle 20°–70° from horizontal. Carries axial load (tension/compression) with minimal bending. Auto-classified: ≤20°=Beam, ≥70°=Column, else=Brace. Change type manually in Members table → Type column." style="cursor:help"><span class="leg-dash" style="background:none;border-top:2px dashed #e65100;width:24px;display:inline-block"></span> Brace ❓</span>
        <span class="leg-item"><span class="leg-dash" style="background:#1565C0;border-radius:50%;width:8px;height:8px"></span> Hinge</span>`;
      return;
    }

    if (views.stress && !views.energy) {
      // Compute actual max utilization across all beams
      let maxUtil = 0, minUtil = Infinity;
      for (const bm of beams) {
        const ef  = _activeRes.elemForces.find(e => e.id === bm.id);
        const sec = sections.find(s => s.id === bm.sectionId);
        if (!ef || !sec || !sec.fy) continue;
        const A_m2 = sec.A / 1e4, I_m4 = (sec.Ix || sec.I || 10000) / 1e8;
        const ymax = Math.pow(I_m4 / A_m2, 0.5);
        const sig1 = Math.abs(ef.N1)/A_m2 + Math.abs(ef.M1)*ymax/I_m4;
        const sig2 = Math.abs(ef.N2)/A_m2 + Math.abs(ef.M2)*ymax/I_m4;
        const util = Math.max(sig1, sig2) / (sec.fy * 1000);
        if (util > maxUtil) maxUtil = util;
        if (util < minUtil) minUtil = util;
      }
      const pct = (v) => (v * 100).toFixed(0) + '%';
      el.innerHTML = `
        <span class="leg-title">Utilization:</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#43a047"></span> &lt;50% Safe</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#fb8c00"></span> 50–80% Moderate</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#e53935"></span> 80–100% High</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#6a1a9a"></span> &gt;100% Overstressed</span>
        <span class="leg-max">Max: ${pct(maxUtil)}  Min: ${pct(minUtil === Infinity ? 0 : minUtil)}</span>`;
    } else if (views.energy && _strainEnergyMap) {
      const vals = Object.values(_strainEnergyMap).filter(v => v != null);
      const maxE = vals.length ? Math.max(...vals) : 0;
      el.innerHTML = `
        <span class="leg-title">Strain Energy:</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#43a047"></span> &lt;5% of max</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#fb8c00"></span> 5–15%</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#e53935"></span> 15–30%</span>
        <span class="leg-item"><span class="leg-swatch" style="background:#6a1a9a"></span> &gt;30%</span>
        <span class="leg-max">Max beam: ${(maxE * 100).toFixed(1)}%</span>`;
    } else {
      // Normal view with results — show diagram types active
      const active = [];
      if (views.bmd)  active.push('<span class="leg-item"><span class="leg-swatch" style="background:#1976d2;opacity:0.7"></span> BMD</span>');
      if (views.sfd)  active.push('<span class="leg-item"><span class="leg-swatch" style="background:#388e3c;opacity:0.7"></span> SFD</span>');
      if (views.nfd)  active.push('<span class="leg-item"><span class="leg-swatch" style="background:#f57c00;opacity:0.7"></span> NFD</span>');
      if (views.defl) active.push('<span class="leg-item"><span class="leg-swatch" style="background:#7b1fa2;opacity:0.7"></span> Deflection</span>');
      if (_activeRes.pdelta) active.push('<span class="leg-item" style="color:#e65100;font-weight:600">P-Δ Active</span>');
      el.innerHTML = `<span class="leg-title">Views:</span>` + (active.join('') || '<span style="color:var(--text-muted)">No diagram selected</span>');
    }
  }

  // Strain energy per beam as fraction of total
  // U_M = (M1²+M1·M2+M2²)·L/(6EI)  [cubic interpolation, exact for linear M]
  // U_N = N_avg²·L/(2EA)
  function computeStrainEnergyMap(res) {
    if (!res || !res.elemForces) return null;
    const map = {};
    let total = 0;
    for (const ef of res.elemForces) {
      const bm  = beams.find(b => b.id === ef.id);
      const sec = bm ? sections.find(s => s.id === bm.sectionId) : null;
      if (!sec) { map[ef.id] = 0; continue; }
      const EI = (sec.E || 210) * 1e6 * (sec.Ix || sec.I || 10000) / 1e8;  // kN·m²
      const EA = (sec.E || 210) * 1e6 * (sec.A  || 30) / 1e4;              // kN
      const L  = ef.L || 1;
      const U_M = (ef.M1**2 + ef.M1*ef.M2 + ef.M2**2) * L / (6 * EI);
      const N_avg = (ef.N1 + ef.N2) / 2;
      const U_N = N_avg**2 * L / (2 * EA);
      const U   = Math.abs(U_M) + Math.abs(U_N);
      map[ef.id] = U;
      total += U;
    }
    if (total > 0) {
      for (const id in map) map[id] /= total;  // normalise to fraction
    }
    return map;
  }

  function clearLayer(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function makeSVG(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // ── 3D Extruded Member Rendering ─────────────────────────────────
  // Draws each beam as a solid 3D box based on its cross-section dimensions.
  // Only active in 3D mode with views.extrude = true.
  // Uses painter's algorithm (back-to-front face sort) for correct depth ordering.
  function drawExtrudedBeams() {
    const g = layerExtrude();
    if (!g) return;
    clearLayer(g);
    if (!mode3D || !views.extrude) return;

    // ── Camera look-from direction (world→camera, Z-up orthographic) ──
    const az = view3D.az, el = view3D.el;
    const lFx = Math.sin(az) * Math.cos(el);
    const lFy = Math.cos(az) * Math.cos(el);
    const lFz = -Math.sin(el);                // negative: camera is above → looks down

    // Light direction (from upper-right-front — gives nice shading variety)
    const lRaw = [lFx + 0.4, lFy - 0.2, lFz + 0.9];
    const lLen  = Math.hypot(...lRaw);
    const [lightX, lightY, lightZ] = lRaw.map(v => v / lLen);

    const allFaces = [];

    for (const bm of beams) {
      const ni = findNode(bm.node1), nj = findNode(bm.node2);
      if (!ni || !nj) continue;
      const sec = sections.find(s => s.id === bm.sectionId);
      if (!sec) continue;

      // ── Local axes (Z-up DCM, mirrors solver3d.js buildDCM3D) ─────
      const dx = nj.x - ni.x, dy = nj.y - ni.y, dzb = (nj.z||0) - (ni.z||0);
      const L  = Math.hypot(dx, dy, dzb);
      if (L < 1e-9) continue;

      const ex = [dx/L, dy/L, dzb/L];

      // Reference: global Z [0,0,1]; for near-vertical beams use global X [1,0,0]
      const isVert = Math.abs(ex[2]) > 0.999;
      const ref    = isVert ? [1,0,0] : [0,0,1];

      // ez = normalize(ex × ref) — local horizontal perpendicular
      let ezX = ex[1]*ref[2]-ex[2]*ref[1];
      let ezY = ex[2]*ref[0]-ex[0]*ref[2];
      let ezZ = ex[0]*ref[1]-ex[1]*ref[0];
      const ezLen = Math.hypot(ezX, ezY, ezZ);
      if (ezLen < 1e-9) continue;
      ezX /= ezLen; ezY /= ezLen; ezZ /= ezLen;

      // ey = ez × ex — in vertical plane (local "up" / strong-axis direction)
      const eyX = ezY*ex[2]-ezZ*ex[1];
      const eyY = ezZ*ex[0]-ezX*ex[2];
      const eyZ = ezX*ex[1]-ezY*ex[0];

      // ── Section bounding-box dimensions (in metres) ───────────────
      let sH, sW;   // sH = depth (ey direction), sW = width (ez direction)
      if (sec.d  > 0) { sH = sec.d  / 1000; } else {
        const Av = (sec.A||10)*1e-4, Iv = (sec.Ix||sec.I||1000)*1e-8;
        sH = Math.max(0.06, Math.min(2.0, Math.sqrt(12*Iv/Av)));
      }
      if (sec.bf > 0) { sW = sec.bf / 1000; } else { sW = Math.max(0.06, (sec.A||10)*1e-4 / sH); }

      // Clamp to reasonable visual limits
      sH = Math.max(0.06, Math.min(1.8, sH));
      sW = Math.max(0.06, Math.min(1.4, sW));

      const hH = sH/2, hW = sW/2;

      // ── 8 vertices (start i: 0–3, end j: 4–7) ────────────────────
      // Ordering: 0=top-right, 1=top-left, 2=bot-left, 3=bot-right (start side)
      const xi = ni.x, yi = ni.y, zi = ni.z||0;
      const xj = nj.x, yj = nj.y, zj = nj.z||0;
      const mkV = (bx, by, bz, sy, sz) => ({
        wx: bx + sy*eyX + sz*ezX,
        wy: by + sy*eyY + sz*ezY,
        wz: bz + sy*eyZ + sz*ezZ
      });
      const v = [
        mkV(xi,yi,zi,  hH,  hW), mkV(xi,yi,zi,  hH, -hW),
        mkV(xi,yi,zi, -hH, -hW), mkV(xi,yi,zi, -hH,  hW),
        mkV(xj,yj,zj,  hH,  hW), mkV(xj,yj,zj,  hH, -hW),
        mkV(xj,yj,zj, -hH, -hW), mkV(xj,yj,zj, -hH,  hW),
      ];
      // Project all 8 to screen
      const p = v.map(vt => mToS3D(vt.wx, vt.wy, vt.wz));

      // ── Vivid section-palette colours (by section index) ────────────
      // 10-colour material-design palette; cycles if more than 10 sections
      const PALETTE = [
        [41,  182, 246],  // 0 Sky Blue      — steel horizontal
        [102, 187, 106],  // 1 Emerald        — steel column
        [255, 167,  38],  // 2 Amber          — timber
        [171,  71, 188],  // 3 Purple         — composite
        [239,  83,  80],  // 4 Coral Red      — alt steel
        [38,  198, 218],  // 5 Cyan           — concrete beam
        [255, 213,  79],  // 6 Gold           — prestressed
        [141, 110,  99],  // 7 Brown          — timber heavy
        [236,  64, 122],  // 8 Pink           — light section
        [120, 144, 156],  // 9 Blue-grey      — UC column
      ];
      const secIdx = sections.findIndex(s => s.id === bm.sectionId);
      const pal = PALETTE[Math.max(0, secIdx) % PALETTE.length];
      let baseR = pal[0], baseG = pal[1], baseB = pal[2];

      // Design utilisation tint overrides palette colour
      if (designResults) {
        const bd = designResults.byBeam.find(b => b.id === bm.id);
        if (bd && bd.maxEta != null) {
          const eta = bd.maxEta;
          if      (eta > 0.95) { baseR=230; baseG=48;  baseB=48;  }  // FAIL — vivid red
          else if (eta > 0.80) { baseR=255; baseG=143; baseB=10;  }  // NEAR — deep amber
          else if (eta > 0.50) { baseR=56;  baseG=195; baseB=90;  }  // OK   — bright green
        }
      }

      const isSel = bm.id === selBeam || multiSel.beams.has(bm.id);

      // ── 6 faces: [vertex-indices, outward normal] ─────────────────
      const faces6 = [
        { vi:[0,1,5,4],  nx:eyX,   ny:eyY,   nz:eyZ,   isTop:true  },  // top
        { vi:[3,2,6,7],  nx:-eyX,  ny:-eyY,  nz:-eyZ,  isTop:false },  // bottom
        { vi:[0,3,7,4],  nx:ezX,   ny:ezY,   nz:ezZ,   isTop:false },  // right
        { vi:[1,2,6,5],  nx:-ezX,  ny:-ezY,  nz:-ezZ,  isTop:false },  // left
        { vi:[4,5,6,7],  nx:ex[0], ny:ex[1], nz:ex[2], isTop:false },  // end j
        { vi:[0,1,2,3],  nx:-ex[0],ny:-ex[1],nz:-ex[2],isTop:false },  // end i
      ];

      for (const f of faces6) {
        // Back-face cull
        const dotCam = f.nx*lFx + f.ny*lFy + f.nz*lFz;
        if (dotCam < -0.05) continue;

        // ── Phong shading: ambient + diffuse + specular ────────────
        const dotL = Math.max(0, f.nx*lightX + f.ny*lightY + f.nz*lightZ);

        // Blinn-Phong specular: halfway vector between light and view
        const hx = lightX - lFx, hy = lightY - lFy, hz = lightZ - lFz;
        const hLen = Math.hypot(hx, hy, hz);
        const spec = hLen > 0
          ? Math.pow(Math.max(0, (f.nx*hx + f.ny*hy + f.nz*hz) / hLen), 28) * 0.28
          : 0;

        const ambient = 0.28;
        const diffuse = 0.62 * dotL;
        let shade = Math.min(1.0, ambient + diffuse + spec);

        // Top face gets extra brightness (sky light bonus)
        if (f.isTop) shade = Math.min(1.0, shade + 0.12);

        // End caps slightly desaturated — mix toward gray
        const capBlend = (!f.isTop && (f.vi[0]===4||f.vi[0]===0)) ? 0.18 : 0;

        const r2 = Math.min(255, Math.round((baseR*(1-capBlend) + 128*capBlend) * shade));
        const g2 = Math.min(255, Math.round((baseG*(1-capBlend) + 128*capBlend) * shade));
        const b2 = Math.min(255, Math.round((baseB*(1-capBlend) + 140*capBlend) * shade));

        // Depth for painter's sort
        const fcx = f.vi.reduce((s,i)=>s+v[i].wx,0)/4;
        const fcy = f.vi.reduce((s,i)=>s+v[i].wy,0)/4;
        const fcz = f.vi.reduce((s,i)=>s+v[i].wz,0)/4;
        const depth = fcx*lFx + fcy*lFy + fcz*lFz;

        // Edge stroke: darker + thicker for crisper look
        const edgeColor = isSel ? '#ffcc00'
          : `rgba(${Math.round(r2*0.35)},${Math.round(g2*0.35)},${Math.round(b2*0.35)},0.85)`;

        allFaces.push({
          pts:   f.vi.map(i => `${p[i].x.toFixed(1)},${p[i].y.toFixed(1)}`).join(' '),
          color: `rgb(${r2},${g2},${b2})`,
          edge:  edgeColor,
          sw:    isSel ? 2.0 : 0.9,
          depth, isSel
        });
      }
    }

    // Painter's sort: farthest faces first
    allFaces.sort((a, b) => a.depth - b.depth);

    for (const f of allFaces) {
      g.appendChild(makeSVG('polygon', {
        points:         f.pts,
        fill:           f.color,
        stroke:         f.edge,
        'stroke-width': String(f.sw),
        'stroke-linejoin': 'round',
      }));
    }
  }

  // Grid
  // The 3D orientation gizmo that used to be drawn here (a small SVG cube in
  // the canvas's top-left) was a second, cut-down copy of the ViewCube that
  // #view-cube already provides — two cubes on screen showing the same thing.
  // The canvas one is kept: it has the compass rose, drag-to-orbit, keyboard
  // focus and an accessible name, none of which the SVG gizmo had.

  /**
   * Sky / ground backdrop for the 3D view, plus a soft fade for the ground grid.
   *
   * The projection is orthographic, so the z=0 plane maps affinely onto the
   * whole screen: there is no true horizon and the grid legitimately covers
   * every pixel. That is exactly why orbiting up and down felt disorienting —
   * nothing on screen said which way was up, and the grid read as wallpaper
   * rather than as ground.
   *
   * So this is a CUE, not a projection: a band of sky above and ground below,
   * split where the horizon would be, and the grid faded out away from the
   * middle so it settles under the model instead of tiling the canvas.
   *
   *   · +Z projects upward whenever cos(el) > 0, so the gradient runs top-to-
   *     bottom then and is flipped when the view turns past vertical;
   *   · the ground's share of the screen grows with |sin el| — looking straight
   *     down (el = ±90°) you are looking at nothing but ground, and edge-on
   *     (el = 0) it sits at mid-screen.
   */
  function ensure3DBackdropDefs(W, H) {
    const svgEl = svg();
    let defs = svgEl.querySelector('defs');
    if (!defs) { defs = makeSVG('defs'); svgEl.insertBefore(defs, svgEl.firstChild); }

    let grad = defs.querySelector('#sky-ground-grad');
    if (!grad) {
      grad = makeSVG('linearGradient', { id: 'sky-ground-grad',
                                         x1: '0', y1: '0', x2: '0', y2: '1' });
      // Classes rather than literal colours, so the palette lives in the
      // stylesheet next to every other theme-aware value.
      ['sky-far', 'sky-near', 'horizon', 'ground-near', 'ground-far'].forEach(c => {
        grad.appendChild(makeSVG('stop', { class: 'sg-' + c }));
      });
      defs.appendChild(grad);
    }

    let fadeG = defs.querySelector('#grid-fade-grad');
    if (!fadeG) {
      fadeG = makeSVG('radialGradient', { id: 'grid-fade-grad' });
      [['0', '#fff', '1'], ['0.45', '#fff', '1'], ['1', '#fff', '0']].forEach(([o, c, op]) => {
        fadeG.appendChild(makeSVG('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }));
      });
      defs.appendChild(fadeG);
    }

    let mask = defs.querySelector('#grid-fade-mask');
    if (!mask) {
      mask = makeSVG('mask', { id: 'grid-fade-mask', maskUnits: 'userSpaceOnUse' });
      mask.appendChild(makeSVG('rect', { id: 'grid-fade-rect', fill: 'url(#grid-fade-grad)' }));
      defs.appendChild(mask);
    }
    const mr = mask.querySelector('#grid-fade-rect');
    mr.setAttribute('x', 0); mr.setAttribute('y', 0);
    mr.setAttribute('width', W); mr.setAttribute('height', H);

    const se = Math.sin(view3D.el), ce = Math.cos(view3D.el);

    // How much of the screen is sky, measured from the sky end of the gradient.
    // SIGNED, not |sin el| — that is the whole point:
    //
    //   el = +90°  camera overhead looking straight down  → 0.0, all ground
    //   el =   0°  edge-on with the ground plane          → 0.5, horizon mid-screen
    //   el = -90°  camera underneath looking straight up  → 1.0, all sky
    //
    // The ground here is a reference grid, not an opaque slab, so from below you
    // are looking up THROUGH it at the sky — you should not be staring at the
    // underside of a floor. An earlier version used |sin el|, which cannot tell
    // "steeply from above" from "steeply from below" and so put ground overhead
    // when you orbited underneath.
    const skyShare = Math.max(0, Math.min(1, 0.5 - 0.5 * se));
    const t = skyShare;
    const stops = grad.querySelectorAll('stop');
    const offs = [0, Math.max(0, t - 0.10), t, Math.min(1, t + 0.015), 1];
    stops.forEach((st, i) => st.setAttribute('offset', offs[i]));

    // Which end of the screen the sky is at. Only one flip is needed now that
    // skyShare carries the above/below sense: cos el < 0 means the view has
    // turned past vertical, +Z projects downward and the whole screen is over.
    const flip = ce < 0;
    grad.setAttribute('y1', flip ? '1' : '0');
    grad.setAttribute('y2', flip ? '0' : '1');
    return true;
  }

  function drawGrid() {
    const g = layerGrid();
    clearLayer(g);

    const svgEl = svg();
    const W = svgEl.clientWidth  || 800;
    const H = svgEl.clientHeight || 600;

    // ── Named grids only render after user clicks Apply in Grid System dialog ──
    const namedGrids = window.GRIDSYS && GRIDSYS.getGrids();
    const hasNamedGrids = namedGrids &&
      (window.GRIDSYS.isApplied && GRIDSYS.isApplied()) &&   // must be explicitly applied
      (namedGrids.xLines.some(l=>l.visible) || namedGrids.yLines.some(l=>l.visible));

    if (hasNamedGrids) {
      // Plain grey canvas background (no background grid squares)
      const bg = makeSVG('rect', {
        x: 0, y: 0, width: W, height: H,
        fill: 'var(--bg-canvas, #f0f1f4)', 'pointer-events': 'none'
      });
      g.appendChild(bg);
      // Draw only the named ETABS grid lines (no background grid)
      drawNamedGrids(g, W, H);
      return;
    }

    if (!cfg.grid) { drawNamedGrids(g, W, H); return; }

    if (mode3D) {
      // Sky above, ground below, so orbiting up and down has a horizon to read
      // against instead of grid in every direction.
      ensure3DBackdropDefs(W, H);
      g.appendChild(makeSVG('rect', { x: 0, y: 0, width: W, height: H,
        fill: 'url(#sky-ground-grad)', class: 'sky-ground-bg', 'pointer-events': 'none' }));

      // Isometric ground grid (X-Y horizontal plane at Z=0, Z-up convention)
      //
      // This drew a fixed +/-20 cells about the origin, so the ground stopped
      // dead mid-canvas: at the default 0.5 m spacing the whole grid was 20 m
      // across however far you zoomed out or panned, leaving bare background
      // over most of the view. Cover the viewport instead, the way the 2D
      // branch below already does — unproject the four screen corners onto the
      // z=0 plane and grid their bounding box.
      const gs0 = cfg.gridSize;
      const ca = Math.cos(view3D.az), sa = Math.sin(view3D.az);
      const se = Math.sin(view3D.el);

      // Screen -> ground (z=0):  x = u*ca + v*sa,  y = -u*sa + v*ca
      // with u = (sx-pan.x)/scale and v = -(sy-pan.y)/(scale*sin el).
      const groundPt = (sx, sy) => {
        const u =  (sx - pan.x) / scale;
        const v = -(sy - pan.y) / (scale * se);
        return { x: u * ca + v * sa, y: -u * sa + v * ca };
      };

      let minX, maxX, minY, maxY;
      // sin el -> 0 puts the eye in the ground plane, which then projects to a
      // single screen line: there is no finite region to cover and v divides by
      // ~0. Fall back to a bounded patch rather than gridding infinity.
      if (Math.abs(se) < 0.02) {
        const R = 20 * gs0;
        minX = minY = -R; maxX = maxY = R;
      } else {
        const cs = [groundPt(0, 0), groundPt(W, 0), groundPt(0, H), groundPt(W, H)];
        minX = Math.min(...cs.map(p => p.x));  maxX = Math.max(...cs.map(p => p.x));
        minY = Math.min(...cs.map(p => p.y));  maxY = Math.max(...cs.map(p => p.y));
      }

      // Zoomed out, that area can run to thousands of cells. Step the spacing up
      // in x5 jumps until the count is sane, so the grid stays continuous
      // instead of collapsing into solid fill (and keeps the frame cheap).
      let gs = gs0;
      const MAX_LINES = 240;
      while ((maxX - minX) / gs + (maxY - minY) / gs > MAX_LINES) gs *= 5;
      const gsM = gs * 5;

      const lineCls = (world) => {
        const isMaj = Math.abs(Math.round(world / gsM) * gsM - world) < 1e-9;
        return world === 0 ? 'grid-axis' : (isMaj ? 'grid-major' : 'grid-minor');
      };
      // Everything below goes into a masked group: crisp under the model,
      // fading out toward the edges so the ground reads as a surface the
      // structure stands on rather than as tiling across the whole canvas.
      const gl = makeSVG('g', { mask: 'url(#grid-fade-mask)' });
      g.appendChild(gl);
      // Lines of constant Y span the full X extent, and vice versa.
      for (let i = Math.floor(minY / gs); i <= Math.ceil(maxY / gs); i++) {
        const world = i * gs;
        const a = mToS3D(minX, world, 0), b = mToS3D(maxX, world, 0);
        gl.appendChild(makeSVG('line', { x1:a.x, y1:a.y, x2:b.x, y2:b.y, class:lineCls(world) }));
      }
      for (let i = Math.floor(minX / gs); i <= Math.ceil(maxX / gs); i++) {
        const world = i * gs;
        const c = mToS3D(world, minY, 0), d = mToS3D(world, maxY, 0);
        gl.appendChild(makeSVG('line', { x1:c.x, y1:c.y, x2:d.x, y2:d.y, class:lineCls(world) }));
      }
      // World-space axis arrows from origin: X=red, Y=blue(depth), Z=green(up)
      // Sized from the user's spacing, not the auto-coarsened one, so they stay
      // put as you zoom.
      const origin = mToS3D(0,0,0);
      const xEnd = mToS3D(gs0*2,0,0), yEnd = mToS3D(0,gs0*2,0), zEnd = mToS3D(0,0,gs0*2);
      [['X','#e53935',xEnd], ['Y','#1565C0',yEnd], ['Z','#2e7d32',zEnd]].forEach(([lbl,col,ep]) => {
        g.appendChild(makeSVG('line', { x1:origin.x,y1:origin.y,x2:ep.x,y2:ep.y, stroke:col,'stroke-width':2,'pointer-events':'none','opacity':'0.7' }));
        const t = makeSVG('text', { x:ep.x+4, y:ep.y-4, fill:col, 'font-size':'11', 'font-weight':'bold','pointer-events':'none' });
        t.textContent = lbl;
        g.appendChild(t);
      });

      return;
    }

    const gs  = cfg.gridSize;
    const gsM = gs * 5;
    const x0m = sToM(0, 0).x, x1m = sToM(W, 0).x;
    const y1m = sToM(0, 0).y, y0m = sToM(0, H).y;
    const startX = Math.floor(x0m / gs) * gs;
    const startY = Math.floor(y0m / gs) * gs;

    for (let mx = startX; mx <= x1m + gs; mx += gs) {
      const isMaj = Math.abs(Math.round(mx / gsM) * gsM - mx) < 1e-9;
      const sx = mx * scale + pan.x;
      g.appendChild(makeSVG('line', {
        x1: sx, y1: 0, x2: sx, y2: H,
        class: mx === 0 ? 'grid-axis' : (isMaj ? 'grid-major' : 'grid-minor')
      }));
    }
    for (let my = startY; my <= y1m + gs; my += gs) {
      const isMaj = Math.abs(Math.round(my / gsM) * gsM - my) < 1e-9;
      const sy = -my * scale + pan.y;
      g.appendChild(makeSVG('line', {
        x1: 0, y1: sy, x2: W, y2: sy,
        class: my === 0 ? 'grid-axis' : (isMaj ? 'grid-major' : 'grid-minor')
      }));
    }

    // ── ETABS-style named grid lines ──────────────────────────────────
    drawNamedGrids(g, W, H);

    // ── 2D Axis Indicator (bottom-left corner, like AutoCAD WCS) ──────
    drawAxisIndicator2D(g, W, H);
  }

  function drawNamedGrids(g, W, H) {
    const grids = window.GRIDSYS && GRIDSYS.getGrids();
    if (!grids || (!grids.xLines.length && !grids.yLines.length)) return;

    const col    = grids.color || '#3a8fc7';
    const bR_m   = grids.bubbleR || 0.4;   // bubble radius in model units (m)
    const bR_px  = bR_m * scale;            // bubble radius in screen px

    function gridLine(x1, y1, x2, y2) {
      g.appendChild(makeSVG('line', { x1:x1, y1:y1, x2:x2, y2:y2,
        stroke:col, 'stroke-width':'1.2', 'stroke-dasharray':'8,5',
        opacity:'0.8', 'pointer-events':'none' }));
    }
    function bubble(cx, cy, label) {
      g.appendChild(makeSVG('circle', { cx:cx, cy:cy, r:Math.max(10, bR_px),
        fill:'#fff', stroke:col, 'stroke-width':'1.5', 'pointer-events':'none' }));
      const txt = makeSVG('text', { x:cx, y:cy,
        'text-anchor':'middle', 'dominant-baseline':'central',
        fill:col, 'font-size': Math.max(9, Math.min(14, bR_px*0.9)),
        'font-weight':'700', 'font-family':'Arial,sans-serif',
        'pointer-events':'none' });
      txt.textContent = label;
      g.appendChild(txt);
    }
    const atStart = gl => gl.bubbleLoc === 'Start' || gl.bubbleLoc === 'Both';
    const atEnd   = gl => gl.bubbleLoc === 'End'   || gl.bubbleLoc === 'Both';

    if (mode3D) {
      // Named grids lie on the ground plane (z = 0), ETABS-style: an X line runs
      // along Y at constant X, a Y line along X at constant Y, each spanning the
      // perpendicular family so the set closes into a rectangle. Bubbles sit at
      // the two ends of the line in world space.
      //
      // The 2D code below places these as flat screen verticals and horizontals
      // at `ord*scale + pan`, which ignores the camera completely — in 3D that
      // drew a screen-aligned crosshatch bearing no relation to the axes it
      // names, and it did not move when you orbited.
      const ords = fam => fam.filter(l => l.visible).map(l => l.ord);
      const xO = ords(grids.xLines), yO = ords(grids.yLines);
      // A family with no lines, or a single line, has no extent to span — give
      // the perpendicular lines something sensible to run across.
      const span = o => {
        if (!o.length) return { lo: -10, hi: 10 };
        let lo = Math.min(...o), hi = Math.max(...o);
        if (lo === hi) { lo -= 5; hi += 5; }
        return { lo: lo, hi: hi };
      };
      const xS = span(xO), yS = span(yO);
      // Stand the bubbles just clear of the outermost perpendicular line.
      const over = Math.max(bR_m * 2, 0.5);

      const draw = (gl, ax, ay, bx, by) => {
        const pa = mToS3D(ax, ay, 0), pb = mToS3D(bx, by, 0);
        gridLine(pa.x, pa.y, pb.x, pb.y);
        if (atStart(gl)) bubble(pa.x, pa.y, gl.id);
        if (atEnd(gl))   bubble(pb.x, pb.y, gl.id);
      };
      grids.xLines.forEach(gl => { if (gl.visible)
        draw(gl, gl.ord, yS.lo - over, gl.ord, yS.hi + over); });
      grids.yLines.forEach(gl => { if (gl.visible)
        draw(gl, xS.lo - over, gl.ord, xS.hi + over, gl.ord); });
      return;
    }

    // ── X grid lines (vertical lines at constant X) ─────────────────
    grids.xLines.forEach(function(gl) {
      if (!gl.visible) return;
      const sx = gl.ord * scale + pan.x;
      gridLine(sx, 0, sx, H);
      if (atStart(gl)) bubble(sx, Math.max(bR_px+4, 14), gl.id);
      if (atEnd(gl))   bubble(sx, Math.min(H - bR_px - 4, H - 14), gl.id);
    });

    // ── Y grid lines (horizontal lines at constant Y) ────────────────
    grids.yLines.forEach(function(gl) {
      if (!gl.visible) return;
      const sy = -(gl.ord * scale) + pan.y;
      gridLine(0, sy, W, sy);
      if (atStart(gl)) bubble(Math.max(bR_px+4, 14), sy, gl.id);
      if (atEnd(gl))   bubble(Math.min(W - bR_px - 4, W - 14), sy, gl.id);
    });
  }

  // ── 2D Axis Indicator ─────────────────────────────────────────────
  // Draws a fixed WCS-style axis indicator in the bottom-left corner
  // of the 2D canvas. Shows X (horizontal) and Y (vertical) with colour
  // coding that matches the 3D view (X=red, Y=green, Z=blue).
  function drawAxisIndicator2D(g, W, H) {
    if (mode3D) return;   // 3D mode has its own axis arrows on the grid

    const OX = W - 55, OY = H - 55;   // indicator origin (bottom-right, above coords display)
    const LEN = 36;                // arrow length in px

    // Background circle for visibility
    const bg = makeSVG('circle', {
      cx: OX, cy: OY, r: 44,
      fill: 'rgba(255,255,255,0.72)',
      stroke: 'rgba(120,130,160,0.25)', 'stroke-width': '1',
      'pointer-events': 'none'
    });
    g.appendChild(bg);

    // ── X axis (horizontal right, red) ──────────────────────────────
    const xEnd = { x: OX + LEN, y: OY };
    _axisArrow(g, OX, OY, xEnd.x, xEnd.y, '#e53935', 'X');

    // ── Y axis (vertical up, green) ──────────────────────────────────
    const yEnd = { x: OX, y: OY - LEN };
    _axisArrow(g, OX, OY, yEnd.x, yEnd.y, '#2e7d32', 'Y');

    // ── Z axis (diagonal, blue) — shown dimmed when in 2D mode ──────
    // Indicates the Z axis direction (out-of-plane / into screen in 2D)
    const zLen = LEN * 0.6;
    const zEnd = { x: OX - zLen * 0.6, y: OY + zLen * 0.6 };
    _axisArrow(g, OX, OY, zEnd.x, zEnd.y, '#1565c0', 'Z', 0.45);

    // ── WCS label ────────────────────────────────────────────────────
    const wcs = makeSVG('text', {
      x: OX, y: OY + 30,
      'text-anchor': 'middle', 'dominant-baseline': 'auto',
      fill: 'rgba(60,80,120,0.65)',
      'font-size': '9', 'font-weight': '700',
      'font-family': 'Arial,sans-serif',
      'pointer-events': 'none',
      'letter-spacing': '1'
    });
    wcs.textContent = 'WCS';
    g.appendChild(wcs);
  }

  function _axisArrow(g, x0, y0, x1, y1, col, lbl, opacity) {
    const alpha = opacity !== undefined ? opacity : 1;

    // Shaft
    const ln = makeSVG('line', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: col, 'stroke-width': '2.2', 'stroke-linecap': 'round',
      opacity: alpha, 'pointer-events': 'none'
    });
    g.appendChild(ln);

    // Arrowhead
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const ah = 8, aw = 3.5;
    const ax0 = x1 - ux * ah - uy * aw;
    const ay0 = y1 - uy * ah + ux * aw;
    const ax1 = x1 - ux * ah + uy * aw;
    const ay1 = y1 - uy * ah - ux * aw;
    const arrow = makeSVG('polygon', {
      points: `${x1},${y1} ${ax0},${ay0} ${ax1},${ay1}`,
      fill: col, opacity: alpha, 'pointer-events': 'none'
    });
    g.appendChild(arrow);

    // Label
    const offX = ux * 10 + (Math.abs(uy) > 0.5 ? -5 : 5);
    const offY = uy * 10 + (Math.abs(ux) > 0.5 ? -5 : 0);
    const txt = makeSVG('text', {
      x: x1 + offX, y: y1 + offY,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: col, 'font-size': '11', 'font-weight': '800',
      'font-family': 'Arial,sans-serif',
      opacity: alpha, 'pointer-events': 'none',
      style: `text-shadow: 0 0 3px rgba(255,255,255,0.9)`
    });
    txt.textContent = lbl;
    g.appendChild(txt);
  }

  // Redraw named grids when GRIDSYS.apply() fires
  document.addEventListener('sa_drawgrid', function() {
    render();
  });

  // Scale bar
  function drawScaleBar() {
    const cvs = document.getElementById('scale-bar-canvas');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    // Pick a nice bar length: closest power of 10 / 2 / 5 that maps to 40–120px
    let barM = 1;
    const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    for (const c of candidates) {
      const px = c * scale;
      if (px >= 50 && px <= 130) { barM = c; break; }
    }
    const barPx = barM * scale;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const fg = isDark ? '#ddd' : '#333';
    const bg = isDark ? 'rgba(30,30,30,0.8)' : 'rgba(255,255,255,0.8)';

    ctx.fillStyle = bg;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(2, 2, 156, 28, 4) : ctx.rect(2, 2, 156, 28);
    ctx.fill(); ctx.stroke();

    const x0 = 14, y0 = 18;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 5);
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0);
    ctx.moveTo(x0 + barPx, y0 - 5); ctx.lineTo(x0 + barPx, y0 + 5);
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(barM >= 1 ? `${barM} m` : `${(barM*100).toFixed(0)} cm`, x0 + barPx / 2, y0 - 8);
  }

  // Nodes
  /**
   * Node marker radius, in screen px.
   *
   * A flat 6 px read as a blob sitting over the joint once you zoomed in on a
   * connection, and was easy to lose among the members when zoomed out. Size it
   * against the app's default zoom instead, so it shrinks as you move in on a
   * detail and grows as you pull back to the whole frame. Clamped at both ends
   * so it neither disappears nor returns to being a blob, and the upper clamp
   * stays inside hitNode()'s 10 px pick radius so the marker is never larger
   * than its own click target.
   */
  const NODE_R_REF = 80;   // the scale at which the base radius applies
  function nodeRadius(selected) {
    // 2.5 px zoomed right in, 4 px at the default zoom, 4.5 px at the far end.
    // The upper clamp was 7 px, which read as a fat blob once the model shrank
    // away from it, so the marker is allowed only a little headroom above its
    // default size.
    const r = Math.max(2.5, Math.min(4.5, 4 * NODE_R_REF / scale));
    return +(selected ? r * 1.35 : r).toFixed(2);
  }

  function drawNodes() {
    const g = layerNodes();
    clearLayer(g);

    for (const nd of nodes) {
      const { x: sx, y: sy } = nodeToS(nd);
      const isMSel = multiSel.nodes.has(nd.id);
      const _isSelNode = nd.id === selNode;
      const c = makeSVG('circle', {
        cx: sx, cy: sy,
        r: nodeRadius(_isSelNode || isMSel),
        class: 'sv-node' + (_isSelNode ? ' sel' : '') + (isMSel ? ' multi-sel' : ''),
        'data-nid': nd.id
      });
      c.addEventListener('click',     e => onNodeClick(e, nd.id));
      c.addEventListener('mousedown', e => {
        if (tool === 'select') { e.stopPropagation(); selNode = nd.id; selBeam = null; render(); }
      });
      c.addEventListener('mousemove', e => {
        const coordStr = mode3D
          ? `X=${nd.x.toFixed(2)}, Y=${nd.y.toFixed(2)}, Z=${(nd.z||0).toFixed(2)} m`
          : `(${nd.x.toFixed(2)}, ${nd.y.toFixed(2)})`;
        showTooltip(`N${nd.id}  ${coordStr}  ${nd.support || 'free'}`, e.clientX, e.clientY);
      });
      c.addEventListener('mouseleave', hideTooltip);
      g.appendChild(c);
    }
  }

  // ── Colour helpers for utilisation gradient ──────────────────────
  function lerpHex(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
    const r  = Math.round(((ah>>16)&255) + (((bh>>16)&255) - ((ah>>16)&255)) * t);
    const gg = Math.round(((ah>>8) &255) + (((bh>>8) &255) - ((ah>>8) &255)) * t);
    const bl = Math.round(( ah     &255) + (( bh     &255) - ( ah     &255)) * t);
    return '#' + [r,gg,bl].map(x => x.toString(16).padStart(2,'0')).join('');
  }
  function utilColor(u) {
    u = Math.max(0, u);
    if (u <= 0.50) return lerpHex('#43a047', '#fdd835', u / 0.50);          // green→yellow
    if (u <= 0.80) return lerpHex('#fdd835', '#fb8c00', (u-0.50) / 0.30);   // yellow→orange
    if (u <= 1.00) return lerpHex('#fb8c00', '#e53935', (u-0.80) / 0.20);   // orange→red
    return lerpHex('#e53935', '#880e4f', Math.min((u-1.0)/0.5, 1));         // red→purple
  }

  // Beams
  function drawBeams() {
    const g = layerBeams();
    clearLayer(g);

    // Remove stale linearGradients from SVG defs each redraw
    svg().querySelectorAll('linearGradient[id^="grad-beam-"]').forEach(el => el.remove());
    const svgDefs = svg().querySelector('defs');

    for (const bm of beams) {
      const ni = findNode(bm.node1), nj = findNode(bm.node2);
      if (!ni || !nj) continue;
      const s1 = nodeToS(ni), s2 = nodeToS(nj);

      const isSelected = bm.id === selBeam || multiSel.beams.has(bm.id);
      const _activeRes = getActiveResults();

      // Shared tooltip builder
      const buildTooltip = (e) => {
        const sec = sections.find(s => s.id === bm.sectionId);
        const L   = memberLength(ni, nj).toFixed(2);
        const mtype = getMemberType(bm);
        let txt = `${getMemberLabel(bm)}  [${mtype}]  L=${L}m  §${sec ? sec.name : '?'}`;
        const Ky = bm.Ky != null ? bm.Ky : 1.0;
        const Kz = bm.Kz != null ? bm.Kz : 1.0;
        if (Ky !== 1.0 || Kz !== 1.0) txt += `  Ky=${Ky} Kz=${Kz}`;
        if (_activeRes && _activeRes.success) {
          const ef = _activeRes.elemForces.find(f => f.id === bm.id);
          if (ef) txt += `  N=${ef.N1.toFixed(1)} V=${ef.V1.toFixed(1)} M=${DesignChecks.internalForceAt(ef, 'BMD', 0).toFixed(1)} kN/kNm`;
        }
        if (designResults) {
          const bd = designResults.byBeam.find(b => b.id === bm.id);
          if (bd) txt += `  η=${bd.maxEta.toFixed(3)} [${bd.overall}]`;
        }
        if (_strainEnergyMap && _strainEnergyMap[bm.id] != null) {
          txt += `  U=${(_strainEnergyMap[bm.id]*100).toFixed(1)}%`;
        }
        showTooltip(txt, e.clientX, e.clientY);
      };

      // ── Gradient rendering — stress view with analysis results ───────
      let usedGradient = false;
      if (views.stress && !views.energy && _activeRes && _activeRes.success) {
        const ef  = _activeRes.elemForces.find(e => e.id === bm.id);
        const sec = sections.find(s => s.id === bm.sectionId);

        if (ef && sec && sec.fy) {
          const A_m2 = sec.A / 1e4;
          const I_m4 = (sec.Ix || sec.I || 10000) / 1e8;
          const ymax = Math.pow(I_m4 / A_m2, 0.5);   // ≈ h/2  (approx from I/A)

          // Build SVG linearGradient with 5 utilisation stops
          const gradId = `grad-beam-${bm.id}`;
          const grad = makeSVG('linearGradient', {
            id: gradId, gradientUnits: 'userSpaceOnUse',
            x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y
          });
          for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
            const N_t = ef.N1 + (ef.N2 - ef.N1) * t;
            const M_t = ef.M1 + (ef.M2 - ef.M1) * t;
            const sig_t = (Math.abs(N_t) / A_m2 + Math.abs(M_t) * ymax / I_m4) / 1000; // MPa
            const util_t = sig_t / sec.fy;
            const stop = makeSVG('stop', {
              offset: `${(t * 100).toFixed(0)}%`, 'stop-color': utilColor(util_t)
            });
            grad.appendChild(stop);
          }
          svgDefs.appendChild(grad);

          // Selection glow (behind gradient line) — red when selected or multi-selected
          const _isMSelBeam = multiSel.beams.has(bm.id);
          if (isSelected || _isMSelBeam) {
            g.appendChild(makeSVG('line', {
              x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y,
              stroke: '#e53935', 'stroke-width': 10, 'stroke-linecap': 'round',
              opacity: 0.5, 'pointer-events': 'none'
            }));
          }

          // Gradient-stroked beam line
          g.appendChild(makeSVG('line', {
            x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y,
            style: `stroke:url(#${gradId});stroke-width:3.5;stroke-linecap:round`,
            'pointer-events': 'none'
          }));

          // Invisible wide hit-target for mouse events
          const hit = makeSVG('line', {
            x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y,
            stroke: 'transparent', 'stroke-width': 14,
            'data-bid': bm.id, cursor: 'pointer'
          });
          hit.addEventListener('click', e => onBeamClick(e, bm.id));
          hit.addEventListener('mousemove', buildTooltip);
          hit.addEventListener('mouseleave', hideTooltip);
          g.appendChild(hit);

          usedGradient = true;
        }
      }

      // ── Fallback: single-colour class-based line ─────────────────────
      if (!usedGradient) {
        const mtype = getMemberType(bm);
        let cls = 'sv-beam' + (isSelected ? ' sel' : '') + (multiSel.beams.has(bm.id) ? ' multi-sel' : '');
        // Member type base colour (only when not in stress/energy/section-color view)
        if (!views.stress && !views.energy && views.colorBy !== 'section' && mtype !== 'beam') {
          cls += mtype === 'column' ? ' sv-beam-column' : ' sv-beam-brace';
        }
        // Section-color override (ETABS "View by Color > Section")
        let _secStroke = null;
        if (views.colorBy === 'section' && !views.stress && !views.energy) {
          _secStroke = sectionColor(bm.sectionId);
        }

        if (_activeRes && _activeRes.success) {
          const ef  = _activeRes.elemForces.find(e => e.id === bm.id);
          const sec = sections.find(s => s.id === bm.sectionId);

          // Stress utilisation colour
          if (views.stress && ef && sec && sec.fy) {
            const A_m2 = sec.A / 1e4, I_m4 = (sec.Ix || sec.I || 10000) / 1e8;
            const ymax = Math.pow(I_m4 / A_m2, 0.5);
            const sig1 = Math.abs(ef.N1) / A_m2 + Math.abs(ef.M1) * ymax / I_m4;
            const sig2 = Math.abs(ef.N2) / A_m2 + Math.abs(ef.M2) * ymax / I_m4;
            const util  = Math.max(sig1, sig2) / (sec.fy * 1000);
            if      (util < 0.5) cls += ' sv-beam-low';
            else if (util < 0.8) cls += ' sv-beam-mid';
            else if (util < 1.0) cls += ' sv-beam-high';
            else                 cls += ' sv-beam-over';
          }

          // Design utilisation colour (when no ef or no fy — falls back here)
          if (views.stress && designResults && !views.energy) {
            const bd = designResults.byBeam.find(b => b.id === bm.id);
            if (bd) {
              const eta = bd.maxEta;
              if      (eta < 0.5) cls += ' sv-beam-low';
              else if (eta < 0.8) cls += ' sv-beam-mid';
              else if (eta < 1.0) cls += ' sv-beam-high';
              else                cls += ' sv-beam-over';
            }
          }

          // Strain energy colour
          if (views.energy && ef && sec) {
            const frac = _strainEnergyMap ? (_strainEnergyMap[bm.id] || 0) : 0;
            if      (frac < 0.05) cls += ' sv-beam-low';
            else if (frac < 0.15) cls += ' sv-beam-mid';
            else if (frac < 0.30) cls += ' sv-beam-high';
            else                  cls += ' sv-beam-over';
          }
        }

        const lnAttrs = { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, class: cls, 'data-bid': bm.id };
        if (_secStroke) { lnAttrs.stroke = _secStroke; lnAttrs['stroke-width'] = '3'; lnAttrs['stroke-linecap'] = 'round'; }
        // With solids showing, the full-weight centreline reads as a stripe
        // painted down each member. Keep it (selection and picking still need
        // it) but drop it back so the extrusion is what you actually see.
        const _extruded = mode3D && views.extrude;
        if (_extruded && !views.extrudeLines) {
          // "Hide centreline" option: fully invisible, selected or not — a
          // selected member used to keep its centreline at full strength,
          // which is the stripe this option exists to remove. opacity:0,
          // not display:none, so the line stays the click/pick target.
          lnAttrs.opacity = '0';
        } else if (_extruded && !isSelected && !multiSel.beams.has(bm.id)) {
          lnAttrs['stroke-width'] = '1';
          lnAttrs.opacity = '0.35';
        }
        const ln = makeSVG('line', lnAttrs);
        ln.addEventListener('click', e => onBeamClick(e, bm.id));
        ln.addEventListener('mousemove', buildTooltip);
        ln.addEventListener('mouseleave', hideTooltip);
        g.appendChild(ln);
      }

      // ── Hinges ──────────────────────────────────────────────────────
      if (bm.hingeStart) {
        const hx = s1.x + (s2.x - s1.x) * 0.07;
        const hy = s1.y + (s2.y - s1.y) * 0.07;
        g.appendChild(makeSVG('circle', { cx: hx, cy: hy, r: 4, fill:'var(--bg-canvas)', stroke:'var(--beam-stroke)', 'stroke-width':1.5, 'pointer-events':'none' }));
      }
      if (bm.hingeEnd) {
        const hx = s1.x + (s2.x - s1.x) * 0.93;
        const hy = s1.y + (s2.y - s1.y) * 0.93;
        g.appendChild(makeSVG('circle', { cx: hx, cy: hy, r: 4, fill:'var(--bg-canvas)', stroke:'var(--beam-stroke)', 'stroke-width':1.5, 'pointer-events':'none' }));
      }

      // ── Local axes ──────────────────────────────────────────────────
      if (views.local) drawLocalAxes(g, ni, nj);
    }
  }

  // Local element axes  (red=local-X, green=local-Y)
  function drawLocalAxes(g, ni, nj) {
    // Use the effective vertical ordinate, and project through nodeToS, so this
    // works for Z-lifted and 3D models. Reading nd.y directly gave dx = dy = 0
    // on every vertical column, so the local-axis triad was never drawn for
    // exactly the members whose orientation matters most.
    const useZ = verticalIsZ();
    const vOf  = nd => useZ ? (nd.z || 0) : nd.y;
    const dx = nj.x - ni.x, dy = vOf(nj) - vOf(ni);
    const L  = Math.hypot(dx, dy);
    if (L < 1e-10) return;
    const mid = { x: (ni.x + nj.x) / 2,
                  y: (ni.y + nj.y) / 2,
                  z: ((ni.z || 0) + (nj.z || 0)) / 2 };
    const { x: scx, y: scy } = nodeToS(mid);
    const c = dx / L, sv = dy / L;
    const AL = 22;   // arrow length in screen px
    // Local X = beam axis (c, sv) in math → screen (c, -sv)
    g.appendChild(makeSVG('line', { x1:scx, y1:scy, x2:scx+c*AL, y2:scy-sv*AL,
      stroke:'#e53935', 'stroke-width':1.5, 'marker-end':'url(#arrow-red)', 'pointer-events':'none' }));
    // Local Y = perpendicular (-sv, c) in math → screen (-sv, -c)
    g.appendChild(makeSVG('line', { x1:scx, y1:scy, x2:scx-sv*AL, y2:scy-c*AL,
      stroke:'#43a047', 'stroke-width':1.5, 'marker-end':'url(#arrow-green)', 'pointer-events':'none' }));
  }

  // Supports
  function drawSupports() {
    const g = layerSupp();
    clearLayer(g);
    // View ▸ Show / Hide ▸ Supports. `!== false` so a model saved before the
    // flag existed still draws them.
    if (views.supports === false) return;
    for (const nd of nodes) {
      if (!nd.support || nd.support === 'none') continue;
      const { x: sx, y: sy } = nodeToS(nd);
      drawSupportSymbol(g, sx, sy, nd.support, nd);
    }
  }

  function drawSupportSymbol(g, sx, sy, type, nd) {
    const sz = 14;

    if (type === 'spring') {
      // Zigzag coil symbol
      const nCoils = 5, totalH = 30, step = totalH / (nCoils * 2 + 2);
      const pts = [`${sx},${sy}`];
      for (let i = 0; i < nCoils * 2; i++) {
        const py = sy + step * (i + 1.5);
        const px = sx + (i % 2 === 0 ? sz * 0.6 : -sz * 0.6);
        pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }
      pts.push(`${sx},${(sy + totalH).toFixed(1)}`);
      g.appendChild(makeSVG('polyline', {
        points: pts.join(' '),
        fill:'none', stroke:'var(--sup-pin)', 'stroke-width':1.8, 'pointer-events':'none'
      }));
      g.appendChild(makeSVG('line', { x1:sx-12, y1:sy+totalH, x2:sx+12, y2:sy+totalH, class:'sup-ground', 'stroke-width':2 }));
      drawHatch(g, sx, sy + totalH + 1, 26, 5);
      if (nd && views.vals) {
        const ky = nd.springKy || 0;
        if (ky > 0) {
          const t = makeSVG('text', { x:sx+14, y:sy+14, 'font-size':'9', fill:'var(--sup-pin)', 'font-weight':'600', 'pointer-events':'none' });
          t.textContent = `ky=${ky}`;
          g.appendChild(t);
        }
      }
      return;
    }

    if (type === 'pin') {
      g.appendChild(makeSVG('polygon', {
        points: `${sx},${sy} ${sx-sz},${sy+sz*1.4} ${sx+sz},${sy+sz*1.4}`,
        class: 'sup-pin'
      }));
      g.appendChild(makeSVG('line', { x1: sx-sz-3, y1: sy+sz*1.4, x2: sx+sz+3, y2: sy+sz*1.4, class:'sup-ground', 'stroke-width':2 }));
      drawHatch(g, sx, sy+sz*1.4+1, sz*2+6, 6);
    }
    else if (type === 'roller') {
      g.appendChild(makeSVG('polygon', {
        points: `${sx},${sy} ${sx-sz},${sy+sz*1.4} ${sx+sz},${sy+sz*1.4}`,
        class: 'sup-roller'
      }));
      g.appendChild(makeSVG('circle', { cx: sx-sz/2+1, cy: sy+sz*1.4+5, r:4, fill:'none', stroke:'var(--sup-pin)', 'stroke-width':1.2 }));
      g.appendChild(makeSVG('circle', { cx: sx+sz/2-1, cy: sy+sz*1.4+5, r:4, fill:'none', stroke:'var(--sup-pin)', 'stroke-width':1.2 }));
      g.appendChild(makeSVG('line', { x1: sx-sz-3, y1: sy+sz*1.4+10, x2: sx+sz+3, y2: sy+sz*1.4+10, class:'sup-ground', 'stroke-width':2 }));
      drawHatch(g, sx, sy+sz*1.4+11, sz*2+6, 5);
    }
    else if (type === 'rollerH') {
      g.appendChild(makeSVG('polygon', {
        points: `${sx},${sy} ${sx-sz*1.4},${sy-sz} ${sx-sz*1.4},${sy+sz}`,
        class: 'sup-roller'
      }));
      g.appendChild(makeSVG('circle', { cx: sx-sz*1.4-5, cy: sy-sz/2+1, r:4, fill:'none', stroke:'var(--sup-pin)', 'stroke-width':1.2 }));
      g.appendChild(makeSVG('circle', { cx: sx-sz*1.4-5, cy: sy+sz/2-1, r:4, fill:'none', stroke:'var(--sup-pin)', 'stroke-width':1.2 }));
      g.appendChild(makeSVG('line', { x1: sx-sz*1.4-11, y1: sy-sz-3, x2: sx-sz*1.4-11, y2: sy+sz+3, class:'sup-ground', 'stroke-width':2 }));
    }
    else if (type === 'fixed') {
      const wallW = 12, wallH = sz * 2.5;
      const wx = sx - wallW - 2;
      g.appendChild(makeSVG('rect', { x: wx, y: sy - wallH/2, width: wallW, height: wallH, class:'sup-fixed' }));
      g.appendChild(makeSVG('line', { x1: sx-2, y1: sy, x2: wx+wallW, y2: sy, stroke:'#666', 'stroke-width':1, fill:'none' }));
      for (let i = 0; i < 5; i++) {
        const hy = sy - wallH/2 + (i+0.5) * (wallH/5);
        g.appendChild(makeSVG('line', { x1: wx, y1: hy, x2: wx-6, y2: hy+7, stroke:'#888', 'stroke-width':1 }));
      }
    }
  }

  function drawHatch(g, cx, y, w, h) {
    const x0 = cx - w/2;
    for (let i = 0; i < 6; i++) {
      const x = x0 + i * (w/5);
      g.appendChild(makeSVG('line', { x1: x, y1: y, x2: x-h, y2: y+h, stroke:'#888', 'stroke-width':1 }));
    }
  }

  // Loads
  // ── Get (or create) a coloured arrowhead marker in SVG defs ─────────
  function _ensureArrowMarker(color) {
    const safeId = 'arrow-lc-' + color.replace(/[^0-9a-f]/gi, '');
    const svgEl  = svg();
    let defs = svgEl.querySelector('defs');
    if (!defs) { defs = makeSVG('defs'); svgEl.insertBefore(defs, svgEl.firstChild); }
    if (!document.getElementById(safeId)) {
      const marker = makeSVG('marker', {
        id: safeId, markerWidth:'7', markerHeight:'7', refX:'4', refY:'3.5', orient:'auto'
      });
      marker.appendChild(makeSVG('path', { d:'M0,0 L0,7 L7,3.5 z', fill: color }));
      defs.appendChild(marker);
    }
    return safeId;
  }

  function drawLoads() {
    const g = layerLoads();
    clearLayer(g);
    // View ▸ Show / Hide ▸ Loads. This toggle set views.loads and nothing
    // read it, so the arrows stayed put while the toast said "Loads: OFF".
    if (views.loads === false) return;

    // Load arrows are drawn along the member centreline, so with solids showing
    // they land inside/behind the extrusion and read as clutter rather than
    // information. Hide them while extruded; updateExtrudeHint() tells the user
    // where they went and how to get them back.
    if (mode3D && views.extrude) return;

    // Build a map: elementId → [list of dist/point loads] to compute display offset index
    const beamLoadIdx = {};
    loads.forEach(ld => {
      if (ld.type === 'beam_dist' || ld.type === 'beam_trap' || ld.type === 'beam_point') {
        if (!beamLoadIdx[ld.elementId]) beamLoadIdx[ld.elementId] = [];
        beamLoadIdx[ld.elementId].push(ld.id);
      }
    });

    // Build case color map
    const lcColorMap = {};
    loadCases.forEach(lc => { lcColorMap[lc.id] = lc.color || '#e53935'; });
    const lcTypeMap  = {};
    loadCases.forEach(lc => { lcTypeMap[lc.id]  = lc.type  || ''; });

    for (const ld of loads) {
      const ldColor = lcColorMap[ld.caseId] || '#e53935';
      const ldType  = lcTypeMap[ld.caseId]  || '';

      if (ld.type === 'nodal') {
        const nd = findNode(ld.nodeId); if (!nd) continue;
        const { x: sx, y: sy } = nodeToS(nd);
        drawPointLoad(g, sx, sy, ld.fx || 0, ld.fy || 0, ldColor, ld.fz || 0);
      }
      else if (ld.type === 'moment') {
        const nd = findNode(ld.nodeId); if (!nd) continue;
        const { x: sx, y: sy } = nodeToS(nd);
        drawMomentSymbol(g, sx, sy, ld.m || 0, ldColor);
      }
      else if (ld.type === 'beam_point') {
        const bm = findBeam(ld.elementId); if (!bm) continue;
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        if (!ni || !nj) continue;
        const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = (nj.z||0) - (ni.z||0);
        const L  = Math.hypot(dx, dy, dz);
        const t  = L > 0 ? ld.pos / L : 0;
        const mx = ni.x + dx * t, my = ni.y + dy * t, mz = (ni.z||0) + dz * t;
        const yFor2D_pt = (my === 0 && mz !== 0) ? mz : my;
        const { x: sx, y: sy } = mode3D ? mToS3D(mx, my, mz) : mToS(mx, yFor2D_pt);
        drawPointLoad(g, sx, sy, ld.fx || 0, ld.fy || 0, ldColor, ld.fz || 0);
      }
      else if (ld.type === 'beam_dist' || ld.type === 'beam_trap') {
        const bm = findBeam(ld.elementId); if (!bm) continue;
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        if (!ni || !nj) continue;
        // Offset index so multiple loads on the same beam are visually staggered
        const arr   = beamLoadIdx[ld.elementId] || [];
        const ldIdx = arr.indexOf(ld.id);
        drawDistLoad(g, ni, nj, ld, ldColor, ldType, ldIdx);
      }
      else if (ld.type === 'area_load') {
        const ids = (ld.nodeIds || []).filter(id => findNode(id));
        if (ids.length < 3) continue;
        // Draw shaded polygon
        const pts = ids.map(id => { const {x,y} = nodeToS(findNode(id)); return `${x},${y}`; }).join(' ');
        const poly = makeSVG('polygon', { points: pts,
          fill:'rgba(229,57,53,0.15)', stroke:'#e53935', 'stroke-width':1.5,
          'stroke-dasharray':'5 3', 'pointer-events':'none' });
        g.appendChild(poly);
        // Centroid label
        const sumPt = ids.reduce((acc, id) => { const {x,y}=nodeToS(findNode(id)); return {x:acc.x+x,y:acc.y+y}; }, {x:0,y:0});
        const cx = sumPt.x / ids.length, cy = sumPt.y / ids.length;
        const pLbl = `${(ld.p||0).toFixed(1)} kN/m²`;
        const bg = makeSVG('rect', { x:cx-24, y:cy-10, width:50, height:16, rx:3, fill:'rgba(255,255,255,0.82)', stroke:'#e53935', 'stroke-width':0.8, 'pointer-events':'none' });
        g.appendChild(bg);
        const t = makeSVG('text', { x:cx+1, y:cy+2, 'text-anchor':'middle', 'font-size':'9', fill:'#b71c1c', 'font-weight':'700', 'pointer-events':'none' });
        t.textContent = pLbl;
        g.appendChild(t);
      }
    }
  }

  function drawPointLoad(g, sx, sy, fx, fy, color, fz) {
    const col = color || '#e53935';
    fz = fz || 0;
    const mag = Math.hypot(fx, fy, fz);
    if (mag < 1e-9) return;
    const dir = loadDirToS(fx, fy, fz);
    if (!dir) return;          // edge-on to the camera — no direction to draw
    const mid = _ensureArrowMarker(col);
    const len = 40;
    const nx = dir.x, ny = dir.y;
    // Tail sits back along the force, head stays on the node, so the arrow
    // points the way the force acts. It used to be tail = node + dir*len, which
    // drew every arrow reversed: self-weight (fy negative, per genSelfWeight)
    // pointed up, and a +X load pointed toward -X.
    const ex = sx - nx * len, ey = sy - ny * len;
    g.appendChild(makeSVG('line', {
      x1: ex, y1: ey, x2: sx, y2: sy,
      stroke: col, 'stroke-width':2, 'marker-end':`url(#${mid})`
    }));
    if (views.vals) {
      const US  = window.UnitSystem;
      const fL  = US ? US.label('force') : 'kN';
      const show = v => (US && v !== 0 ? US.toDisplay(v, 'force') : v).toFixed(1) + fL;
      // Same order and separator as before, so a load with no depth component
      // reads exactly as it always did; fz only appears when it is set.
      const parts = [];
      if (fy !== 0) parts.push(show(fy));
      if (fx !== 0) parts.push(show(fx));
      if (fz !== 0) parts.push(show(fz));
      const lbl = parts.join(', ');
      const t = makeSVG('text', { x: ex - nx*5, y: ey - ny*5, class:'sv-label',
        'text-anchor':'middle', fill: col, 'font-size':'10', 'font-weight':'700' });
      t.textContent = lbl;
      g.appendChild(t);
    }
  }

  function drawMomentSymbol(g, sx, sy, m, color) {
    const col = color || '#e53935';
    const mid = _ensureArrowMarker(col);
    const r = 16, sign = m >= 0 ? 1 : -1;
    const path = `M ${sx+r},${sy} A ${r},${r} 0 1,${sign<0?0:1} ${sx+r*sign*0.5},${sy - r*0.87}`;
    g.appendChild(makeSVG('path', { d: path, fill:'none', stroke: col, 'stroke-width':2, 'marker-end':`url(#${mid})` }));
    if (views.vals) {
      const US  = window.UnitSystem;
      const mD  = US ? US.toDisplay(m, 'moment') : m;
      const mL  = US ? US.label('moment') : 'kNm';
      const t = makeSVG('text', { x: sx + r + 5, y: sy, class:'sv-label', fill: col, 'font-size':'10' });
      t.textContent = `${mD.toFixed(1)} ${mL}`;
      g.appendChild(t);
    }
  }

  // ldIdx = index of this load among dist loads on same beam (0=first,1=second…)
  function drawDistLoad(g, ni, nj, ld, color, caseType, ldIdx) {
    const col  = color    || '#e53935';
    const lcTy = caseType || '';
    const idx  = ldIdx    || 0;
    const mid  = _ensureArrowMarker(col);

    const fx1  = ld.fx  || 0,  fy1 = ld.fy  || 0,  fz1 = ld.fz || 0;
    const fx2  = ld.fx2 !== undefined ? ld.fx2 : fx1;
    const fy2  = ld.fy2 !== undefined ? ld.fy2 : fy1;
    const fz2  = ld.fz2 !== undefined ? ld.fz2 : fz1;
    const mag1 = Math.hypot(fx1, fy1, fz1), mag2 = Math.hypot(fx2, fy2, fz2);
    if (mag1 < 1e-9 && mag2 < 1e-9) return;

    // "Vertical" means along the model's vertical axis only — a depth (fz)
    // component is no more vertical than an fx one, and must take the angled
    // branch so its arrows are drawn on the projected direction.
    const isVert  = Math.abs(fx1) < 1e-9 && Math.abs(fx2) < 1e-9 &&
                    Math.abs(fz1) < 1e-9 && Math.abs(fz2) < 1e-9;
    const ALEN    = 28;   // fixed arrow length — same for ALL loads, clean uniform look
    const nArrows = 5;
    const s1 = nodeToS(ni), s2 = nodeToS(nj);

    // ── Draw arrows ────────────────────────────────────────────────────
    for (let i = 0; i <= nArrows; i++) {
      const t   = i / nArrows;
      const mx  = ni.x + (nj.x - ni.x) * t;
      const my  = ni.y + (nj.y - ni.y) * t;
      const mz  = (ni.z||0) + ((nj.z||0) - (ni.z||0)) * t;
      const y2D = (my === 0 && mz !== 0) ? mz : my;
      const { x: sx, y: sy } = mode3D ? mToS3D(mx, my, mz) : mToS(mx, y2D);
      const fxT = fx1 + (fx2-fx1)*t, fyT = fy1 + (fy2-fy1)*t,
            fzT = fz1 + (fz2-fz1)*t;
      const magT = Math.hypot(fxT, fyT, fzT); if (magT < 1e-9) continue;
      const dirT = loadDirToS(fxT, fyT, fzT); if (!dirT) continue;
      const nx = dirT.x, ny = dirT.y;
      const len = isVert ? ALEN : (magT / Math.max(mag1,mag2)) * ALEN;
      g.appendChild(makeSVG('line', {
        x1: sx-nx*len, y1: sy-ny*len, x2: sx, y2: sy,
        stroke: col, 'stroke-width':'1.6', 'marker-end':`url(#${mid})`
      }));
    }

    // ── Connecting bar ─────────────────────────────────────────────────
    if (isVert) {
      const sign = Math.sign(fy1) || -1;
      // Offset the bar along the same projected direction as the arrow tails so
      // it stays attached to them at any camera angle. For a purely vertical
      // load that direction is (0, -sign), which reproduces the previous
      // screen-space offset exactly.
      const dBar = loadDirToS(fx1, fy1, fz1) || { x: 0, y: -sign };
      const bx1 = s1.x - dBar.x * ALEN, by1 = s1.y - dBar.y * ALEN;
      const bx2 = s2.x - dBar.x * ALEN, by2 = s2.y - dBar.y * ALEN;
      g.appendChild(makeSVG('line', {
        x1: bx1, y1: by1, x2: bx2, y2: by2,
        stroke: col, 'stroke-width': '1.8'
      }));

      if (views.vals) {
        // Compact stacked text: each case label shifts up by 12px × idx
        const fy1D  = Math.abs(fy1);
        const fy2D  = Math.abs(ld.fy2 !== undefined ? ld.fy2 : fy1);
        const dec   = fy1D >= 10 ? 1 : fy1D >= 1 ? 2 : 3;
        const valStr = ld.type === 'beam_trap'
          ? `${fy1D.toFixed(dec)}→${fy2D.toFixed(dec)}`
          : `${fy1D.toFixed(dec)}`;
        const midX = (s1.x + s2.x) / 2;
        // Place label ABOVE the bar (or below for upward loads)
        // Each extra load shifts label by 13px so they stack without overlapping
        const baseY = sign < 0 ? Math.min(by1,by2) - 5 - idx*13
                                : Math.max(by1,by2) + 13 + idx*13;

        // Tiny case tag (e.g. "DL" "LL") in bold case color + value
        const labelTxt = lcTy ? `${lcTy}: ${valStr} kN/m` : `${valStr} kN/m`;

        // Subtle background for readability (not a pill — just a soft rect)
        const tw = labelTxt.length * 4.8 + 6;
        // Claim this space so node/member labels (drawn later) route around it.
        reserveLabelBox(midX - tw/2, baseY - 9, tw, 11);
        g.appendChild(makeSVG('rect', {
          x: midX - tw/2, y: baseY - 9, width: tw, height: 11, rx: 2,
          fill: 'white', opacity: '0.75'
        }));
        const t = makeSVG('text', {
          x: midX, y: baseY,
          class:'sv-label', 'text-anchor':'middle',
          fill: col, 'font-size':'9', 'font-weight':'700'
        });
        t.textContent = labelTxt;
        g.appendChild(t);
      }
    } else {
      // ── Non-vertical (angled/horizontal) ─────────────────────────────
      const d1 = loadDirToS(fx1, fy1, fz1) || { x: 0, y: 0 };
      const d2 = loadDirToS(fx2, fy2, fz2) || { x: 0, y: 0 };
      const t1x=s1.x-d1.x*ALEN, t1y=s1.y-d1.y*ALEN;
      const t2x=s2.x-d2.x*ALEN, t2y=s2.y-d2.y*ALEN;
      g.appendChild(makeSVG('line', {
        x1: t1x, y1: t1y, x2: t2x, y2: t2y,
        stroke: col, 'stroke-width':'1.8', 'stroke-dasharray':'5,3'
      }));

      if (views.vals) {
        const m1D  = Math.abs(mag1);
        const dec  = m1D >= 10 ? 1 : m1D >= 1 ? 2 : 3;
        const ang  = Math.atan2(-fy1, fx1) * 180 / Math.PI;
        const lbl  = `${lcTy ? lcTy+': ' : ''}${m1D.toFixed(dec)} kN/m @ ${ang.toFixed(0)}°`;
        const midX = (t1x+t2x)/2, midY = (t1y+t2y)/2 - 4 - idx*13;
        const tw   = lbl.length * 4.8 + 6;
        g.appendChild(makeSVG('rect', {
          x: midX-tw/2, y: midY-9, width: tw, height: 11, rx: 2,
          fill: 'white', opacity:'0.75'
        }));
        const t = makeSVG('text', {
          x: midX, y: midY,
          class:'sv-label', 'text-anchor':'middle',
          fill: col, 'font-size':'9', 'font-weight':'700'
        });
        t.textContent = lbl;
        g.appendChild(t);
      }
    }
  }

  // Labels
  function drawLabels() {
    const g = layerLabels();
    clearLayer(g);

    if (cfg.labels) {
      for (const nd of nodes) {
        const { x: sx, y: sy } = nodeToS(nd);
        // Only carry the elevation when there is one — "(Z=0.0m)" on every
        // base node was pure noise and the main source of label collisions.
        const z   = nd.z || 0;
        const lbl = (mode3D && Math.abs(z) > 1e-9)
          ? `N${nd.id} z=${z.toFixed(1)}`
          : `N${nd.id}`;
        const w   = labelWidth(lbl, 11);
        const pos = placeLabel(sx + 8, sy - 5, w, 12, 'start');
        if (!pos) continue;
        const t = makeSVG('text', { x: pos.x, y: pos.y, class:'sv-label lbl-node', 'font-size':'11', 'font-weight':'bold',
                                    stroke:'var(--bg-canvas,#fff)', 'stroke-width':'3',
                                    'paint-order':'stroke', 'stroke-linejoin':'round' });
        t.textContent = lbl;
        g.appendChild(t);
      }
    }

    if (cfg.beamLabels) {
      for (const bm of beams) {
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        if (!ni || !nj) continue;
        const mx = (ni.x + nj.x) / 2, my = (ni.y + nj.y) / 2, mz = ((ni.z||0) + (nj.z||0)) / 2;
        const { x: sx, y: sy } = mode3D ? mToS3D(mx, my, mz) : mToS(mx, my);
        const txt = getMemberLabel(bm);
        const pos = placeLabel(sx, sy - 6, labelWidth(txt, 10), 11, 'middle');
        if (!pos) continue;
        const t = makeSVG('text', { x: pos.x, y: pos.y, class:'sv-label lbl-member', 'text-anchor':'middle', 'font-size':'10',
                                    stroke:'var(--bg-canvas,#fff)', 'stroke-width':'3',
                                    'paint-order':'stroke', 'stroke-linejoin':'round' });
        t.textContent = txt;
        g.appendChild(t);
      }
    }

    if (views.lengths) {
      const US = window.UnitSystem;
      const lenLbl = US ? US.label('length') : 'm';
      const lenDec = US ? (US.current().decimals.length || 2) : 2;
      for (const bm of beams) {
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        if (!ni || !nj) continue;
        const L    = Math.hypot(nj.x - ni.x, nj.y - ni.y, (nj.z||0) - (ni.z||0));
        const LD   = US ? US.toDisplay(L, 'length') : L;
        const mx   = (ni.x + nj.x) / 2, my = (ni.y + nj.y) / 2, mz = ((ni.z||0)+(nj.z||0))/2;
        const { x: sx, y: sy } = mode3D ? mToS3D(mx, my, mz) : mToS(mx, my);
        const txt = `${LD.toFixed(lenDec)} ${lenLbl}`;
        const pos = placeLabel(sx, sy + 14, labelWidth(txt, 9), 10, 'middle');
        if (!pos) continue;
        const t = makeSVG('text', { x: pos.x, y: pos.y, class:'sv-label lbl-dim', 'text-anchor':'middle', 'font-size':'9',
                                    stroke:'var(--bg-canvas,#fff)', 'stroke-width':'3',
                                    'paint-order':'stroke', 'stroke-linejoin':'round' });
        t.textContent = txt;
        g.appendChild(t);
      }
    }

    // ── Inter-story drift ratios (ETABS drift annotation) ──────────────
    if (views.drift) {
      const res = getActiveResults();
      if (res && res.success) {
        const stories = computeStoryForces(res);
        if (stories) {
          for (const s of stories) {
            if (s.h < 0.001) continue;
            const midY = (s.yBot + s.yTop) / 2;
            // Band the storey along whichever axis is vertical, and project the
            // label accordingly — this filtered on nd.y and projected with the
            // 2D mapper, so it found nothing in 3D / Z-lifted models.
            const useZd = verticalIsZ();
            const evd = nd => useZd ? (nd.z || 0) : nd.y;
            const storyNodes = nodes.filter(nd =>
              evd(nd) >= s.yBot - 0.1 && evd(nd) <= s.yTop + 0.1
            );
            if (!storyNodes.length) continue;
            const leftX = Math.min(...storyNodes.map(nd => nd.x));
            const { x: sx, y: sy } = useZd && mode3D
              ? mToS3D(leftX, 0, midY)
              : mToS(leftX, midY);

            const ratio = s.driftRatio;
            const ratioStr = ratio < 0.0001 ? '0'
              : ratio > 0.01 ? ratio.toFixed(4)
              : `1/${Math.round(1 / ratio)}`;
            // Green < 1/500, amber < 1/200, red ≥ 1/200
            const col = ratio >= 1/200  ? '#c62828'
                      : ratio >= 1/500  ? '#e65100'
                      : '#2e7d32';

            const bg = makeSVG('rect', {
              x: sx - 56, y: sy - 10, width: 54, height: 14,
              rx: 2, fill: col, opacity: '0.15', 'pointer-events': 'none'
            });
            const txt = makeSVG('text', {
              x: sx - 29, y: sy + 1,
              class: 'sv-label', 'text-anchor': 'middle', 'font-size': '9.5',
              fill: col, 'font-weight': '700', 'pointer-events': 'none'
            });
            txt.textContent = `Δ/h = ${ratioStr}`;
            g.appendChild(bg);
            g.appendChild(txt);
          }
        }
      }
    }
  }

  // ── getActiveResults — central accessor ──────────────────────────
  function getActiveResults() {
    // One gate for all 22 readers — diagrams, tables, summary, design checks,
    // reports. Blocking here is what makes the guarantee hold everywhere
    // rather than in whichever paths someone remembered to patch.
    if (!resultsAreCurrent()) {
      if ((results || envelopeResult || Object.keys(allCaseResults).length) && !_staleWarned) {
        _staleWarned = true;
        discardStaleResults();
      }
      return null;
    }
    if (activeDisplay.type === 'case')     return allCaseResults[activeDisplay.id]  || null;
    if (activeDisplay.type === 'combo')    return allComboResults[activeDisplay.id] || null;
    if (activeDisplay.type === 'envelope') return envelopeResult || null;
    return null;
  }

  /** Drop results that no longer describe the model, and say so. */
  function discardStaleResults() {
    results = null; envelopeResult = null; designResults = null;
    allCaseResults = {}; allComboResults = {};
    // Panels that hold their own copy of the numbers and are not rebuilt by
    // render(). The Quick Summary is the one that sat there reporting 80 kN of
    // reaction for an empty model.
    //
    // The Results pane is another: it keeps the table showResultsPanel() last
    // wrote. Move a node and it went on showing 52 rows of reactions,
    // displacements and member end forces for the geometry that existed
    // before the move, with nothing on screen saying they were stale.
    try { showResultsPanel(null); } catch (e) { /* mid-teardown */ }
    document.getElementById('quick-summary')?.remove();
    document.querySelectorAll('.sv-mode-shape').forEach(el => el.remove());
    const modeBar = document.getElementById('mode-bar');
    if (modeBar) modeBar.style.display = 'none';
    setTimeout(() => {
      toast('The model changed, so the previous results no longer describe it and ' +
            'have been cleared. Press SOLVE again.', 'warn');
      try { populateDisplaySelector(); render(); } catch (e) { /* mid-teardown */ }
      _staleWarned = false;
    }, 0);
  }

  // Results overlay
  function drawResults() {
    const g = layerRes();
    clearLayer(g);
    const res = getActiveResults();
    if (!res || !res.success) return;

    const sc = views.scale;

    if (mode3D) {
      // In 3D mode: draw force labels offset from beam midpoint.
      // Suppressed while extruded — three numeric labels per member printed over
      // the solids is unreadable, and it is the main thing that made the
      // extruded view look cluttered. The diagrams (BMD/SFD/NFD) still draw,
      // because those are explicit toggles the user asked for.
      const _extruded = views.extrude;
      let _labelIdx3D = 0;
      for (const ef of (_extruded ? [] : res.elemForces)) {
        const bm = findBeam(ef.id); if (!bm) continue;
        const ni = findNode(bm.node1), nj = findNode(bm.node2); if (!ni || !nj) continue;

        // Midpoint in model coords
        const mx = (ni.x + nj.x) / 2, my = ((ni.y||0) + (nj.y||0)) / 2,
              mz = ((ni.z||0) + (nj.z||0)) / 2;
        const { x: sx, y: sy } = mToS3D(mx, my, mz);

        if (views.vals) {
          const US = window.UnitSystem;
          const fLbl = US ? US.label('force') : 'kN', mLbl = US ? US.label('moment') : 'kNm';
          const N  = US ? US.toDisplay(ef.N1, 'force')                   : ef.N1;
          // Internal moment at the start, not the end action, so this box
          // agrees with the diagram beside it and with the results tables.
          const M_int = DesignChecks.internalForceAt(ef, 'BMD', 0);
          const Mz = US ? US.toDisplay(M_int, 'moment') : M_int;
          const V  = US ? US.toDisplay(ef.Vy1 || ef.V1, 'force')         : (ef.Vy1 || ef.V1);

          // Compute perpendicular offset in screen space so labels don't overlap member
          // Direction from ni to nj on screen
          const si = mToS3D(ni.x, ni.y||0, ni.z||0);
          const sj = mToS3D(nj.x, nj.y||0, nj.z||0);
          const dx = sj.x - si.x, dy = sj.y - si.y;
          const len = Math.hypot(dx, dy) || 1;
          // Perpendicular unit vector (90° counter-clockwise)
          const perpX = -dy / len, perpY = dx / len;
          // Alternate offset side for adjacent members to reduce overlap
          const side = (_labelIdx3D++ % 2 === 0) ? 1 : -1;
          const OFFSET = 32;    // px clearance from member axis
          const lx = sx + perpX * OFFSET * side;
          const ly = sy + perpY * OFFSET * side;

          // Label box with line to member
          const lineEl = makeSVG('line', { x1:sx, y1:sy, x2:lx, y2:ly,
            stroke:'rgba(100,100,100,0.4)', 'stroke-width':'0.8',
            'stroke-dasharray':'3,2', 'pointer-events':'none' });
          g.appendChild(lineEl);

          const bh = 42, bw = 90;
          const bg = makeSVG('rect', { x:lx-bw/2, y:ly-bh/2, width:bw, height:bh, rx:4,
            fill:'rgba(255,255,255,0.93)', stroke:'#90a4ae', 'stroke-width':'1',
            'pointer-events':'none', 'filter':'drop-shadow(0 1px 3px rgba(0,0,0,0.15))' });
          g.appendChild(bg);

          const mkLabel = (txt, yOff, col) => {
            const t = makeSVG('text', { x:lx, y:ly + yOff,
              'text-anchor':'middle', 'font-size':'9', fill:col,
              'font-weight':'600', 'pointer-events':'none' });
            t.textContent = txt; g.appendChild(t);
          };
          mkLabel(`N=${N.toFixed(1)} ${fLbl}`,   -12, '#880e4f');
          mkLabel(`M=${Mz.toFixed(1)} ${mLbl}`,    0, '#1565c0');
          mkLabel(`V=${V.toFixed(1)} ${fLbl}`,     12, '#2e7d32');
        }
      }
      // Force diagrams in 3D. Previously this branch emitted only the numeric
      // labels above and returned, so BMD/SFD/NFD — and with them Fill Diagrams
      // and Peaks — did nothing at all in the default 3D view.
      for (const ef of res.elemForces) {
        if (views.bmd)  drawDiagram3D(g, ef, 'bmd', sc, 'sv-bmd', '#1565C0');
        if (views.sfd)  drawDiagram3D(g, ef, 'sfd', sc, 'sv-sfd', '#2e7d32');
        if (views.nfd)  drawDiagram3D(g, ef, 'nfd', sc, 'sv-nfd', '#880e4f');
        if (views.defl) drawDeflected3D(g, ef);
      }
      if (views.react) drawReactions(g, res);
      return;
    }

    for (const ef of res.elemForces) {
      if (views.bmd)  drawDiagram(g, ef, 'bmd', sc, 'sv-bmd', '#1565C0');
      if (views.sfd)  drawDiagram(g, ef, 'sfd', sc, 'sv-sfd', '#2e7d32');
      if (views.nfd)  drawDiagram(g, ef, 'nfd', sc, 'sv-nfd', '#880e4f');
      if (views.defl) drawDeflected(g, ef);
    }

    if (views.react) drawReactions(g, res);
  }

  /**
   * The distributed load acting on a member, for diagram shaping.
   *
   * solveFrame3D does not attach per-element loads to its elemForces (the 2D
   * solver does), so in 3D `distLoad` was always undefined: a UDL beam's moment
   * diagram was drawn as a straight chord between end moments rather than a
   * parabola, and the span peak never appeared. Fall back to resolving the load
   * from the model for whichever case or combination is being displayed.
   */
  function memberDistLoad(ef) {
    const isDist = ld => ld.type === 'beam_dist' || ld.type === 'beam_trap';

    // Resolve a global load onto the member's LOCAL TRANSVERSE axis, the same
    // projection fefLocal2D uses. The ordinates this feeds are added to M1/V1,
    // which are local end forces, so a global intensity cannot go in raw.
    //
    // Reading ld.fy straight through meant a column under a horizontal wind UDL
    // was drawn as a plain chord between its end moments — fx was never looked
    // at — while a column under its own weight, which carries no bending at all,
    // got a full parabola from the vertical component. Only horizontal members
    // came out right.
    const c = ef.c !== undefined ? ef.c : 1;
    const s = ef.s !== undefined ? ef.s : 0;
    const wt  = ld => -(ld.fx || 0) * s + (ld.fy || 0) * c;
    const wt2 = ld => -((ld.fx2 !== undefined ? ld.fx2 : (ld.fx || 0))) * s
                    +  ((ld.fy2 !== undefined ? ld.fy2 : (ld.fy || 0))) * c;

    // Every distributed load on the member contributes, not just the first one
    // found: self-weight plus an imposed UDL is an ordinary combination, and
    // only one of them used to shape the diagram.
    const sum = (list, factorOf) => {
      let fy = 0, fy2 = 0, any = false;
      for (const l of list) {
        const k = factorOf ? factorOf(l) : 1;
        if (k === null) continue;
        fy  += k * wt(l);
        fy2 += k * wt2(l);
        any = true;
      }
      return any ? { type: 'beam_dist', fy, fy2 } : null;
    };

    if (ef.loads) {
      const found = ef.loads.filter(isDist);
      if (found.length) return sum(found);
    }
    const onMember = loads.filter(l => isDist(l) && l.elementId === ef.id);
    if (!onMember.length) return null;

    if (activeDisplay.type === 'case') {
      return sum(onMember.filter(l => caseIdOf(l) === activeDisplay.id));
    }
    // Combination: superpose the factored intensities of its constituent cases.
    const combo = loadCombos.find(c2 => c2.id === activeDisplay.id);
    if (!combo) return null;
    const factorFor = l => {
      // Factor entries are { caseId, factor } — the shape used by the combo
      // dialog, the generator and combineCaseResults.
      const f = (combo.factors || []).find(ff => ff.caseId === caseIdOf(l));
      return f ? f.factor : null;
    };
    return sum(onMember, factorFor);
  }

  /**
   * Diagram ordinate at parametric station t ∈ [0,1] along a member.
   * Shared by the 2D and 3D diagram renderers so both plot identical values.
   */
  function diagramValueAt(ef, type, t, distLoad) {
    const L = ef.L;
    if (type === 'bmd') {
      // Returns MINUS the internal moment, and deliberately so: this value is a
      // SCREEN OFFSET, and callers plot it as `sy + perp.y * v`, where screen y
      // grows downward. Returning −M therefore draws a SAGGING span ABOVE the
      // member axis, which is the orientation this app uses.
      //
      // Do not "correct" the sign to match the tables without also flipping the
      // offset expression — negating here alone turns every diagram upside down.
      //
      // The shear relation V(x) = V1 + w·x closes exactly on V2, and M(L) lands
      // exactly on the far-end moment.
      if (distLoad) {
        const x = t * L;
        const wy1 = distLoad.fy;
        const wy2 = distLoad.fy2 !== undefined ? distLoad.fy2 : wy1;
        return ef.M1 - ef.V1 * x - wy1 * x * x / 2 - (wy2 - wy1) * x * x * x / (6 * L);
      }
      return ef.M1 * (1 - t) + ef.M2 * t;
    }
    if (type === 'sfd') {
      if (distLoad) {
        const x = t * L;
        const wy1 = distLoad.fy;
        const wy2 = distLoad.fy2 !== undefined ? distLoad.fy2 : wy1;
        return ef.V1 + wy1 * x + (wy2 - wy1) * x * x / (2 * L);
      }
      return ef.V1 * (1 - t) + ef.V2 * t;
    }
    return ef.N1 * (1 - t) + ef.N2 * t;
  }

  /**
   * BMD / SFD / NFD drawn in 3D. drawResults() used to return after emitting
   * plain force labels in 3D mode, so every diagram option (BMD, SFD, NFD, Fill
   * Diagrams, Peaks) appeared dead the moment the view was 3D — which is the
   * default. The ordinates come from diagramValueAt(), the same source the 2D
   * renderer uses, and are offset perpendicular to the member before projection.
   */
  function drawDiagram3D(g, ef, type, sc, cls, col) {
    const L = ef.L;
    if (!L || L < 1e-10) return;

    const p1 = [ef.x1, ef.y1 || 0, ef.z1 || 0];
    const p2 = [ef.x2, ef.y2 || 0, ef.z2 || 0];
    const ax = [(p2[0]-p1[0])/L, (p2[1]-p1[1])/L, (p2[2]-p1[2])/L];

    // Offset direction: the vertical component perpendicular to the member, so
    // the diagram sits in the vertical plane through the member. Near-vertical
    // members (columns) fall back to global X.
    const dotUp = ax[2];
    let perp = [-ax[0]*dotUp, -ax[1]*dotUp, 1 - ax[2]*dotUp];
    let pl = Math.hypot(perp[0], perp[1], perp[2]);
    if (pl < 1e-6) {
      const dx = ax[0];
      perp = [1 - ax[0]*dx, -ax[1]*dx, -ax[2]*dx];
      pl = Math.hypot(perp[0], perp[1], perp[2]);
      if (pl < 1e-6) return;
    }
    perp = [perp[0]/pl, perp[1]/pl, perp[2]/pl];

    const distLoad = memberDistLoad(ef);
    const nSeg = (type === 'bmd' && distLoad) ? 16 : ((type === 'sfd' && distLoad) ? 8 : 1);
    // Model-space magnitude per unit of force/moment, matched to the 2D factor.
    const factor = sc * 0.05 / Math.max(scale, 1e-6);

    const spine = [], offset = [];
    for (let i = 0; i <= nSeg; i++) {
      const t = i / nSeg;
      const bx = p1[0] + (p2[0]-p1[0]) * t;
      const by = p1[1] + (p2[1]-p1[1]) * t;
      const bz = p1[2] + (p2[2]-p1[2]) * t;
      const v  = diagramValueAt(ef, type, t, distLoad) * factor;
      const sp = mToS3D(bx, by, bz);
      const op = mToS3D(bx + perp[0]*v, by + perp[1]*v, bz + perp[2]*v);
      spine.push([sp.x, sp.y]);
      offset.push([op.x, op.y]);
    }

    if (views.fill !== false) {
      const pts = [...spine.map(p => `${p[0]},${p[1]}`),
                   ...[...offset].reverse().map(p => `${p[0]},${p[1]}`)].join(' ');
      g.appendChild(makeSVG('polygon', { points: pts, class: cls, 'pointer-events':'none' }));
    } else {
      const ol = makeSVG('polyline', { points: offset.map(p => `${p[0]},${p[1]}`).join(' '),
                                       class: cls, 'pointer-events':'none' });
      ol.setAttribute('fill', 'none');
      g.appendChild(ol);
      g.appendChild(makeSVG('line', {
        x1: spine[0][0], y1: spine[0][1], x2: spine[nSeg][0], y2: spine[nSeg][1],
        stroke: col, 'stroke-width':'0.5', opacity:'0.4', 'pointer-events':'none' }));
    }

    if (views.vals) {
      // M1/M2 are END ACTIONS — the negative of the internal moment — so a
      // hogging support was labelled positive and a sagging one negative,
      // disagreeing with the results tables about the same point.
      const startVal = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', 0)
                     : type==='sfd' ? ef.V1 : ef.N1;
      const endVal   = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', ef.L)
                     : type==='sfd' ? ef.V2 : ef.N2;
      drawDiagValue(g, offset[0][0],    offset[0][1],    startVal, col);
      drawDiagValue(g, offset[nSeg][0], offset[nSeg][1], endVal,   col);
    }

    // Flag the largest INTERIOR extremum. The global maximum of a fixed-end
    // member sits at a support, which the end value labels already report — the
    // useful marker is the span peak (e.g. the sagging moment at mid-span).
    if (views.peaks !== false && nSeg > 1) {
      let pi = -1, pv = 0;
      for (let i = 1; i < nSeg; i++) {
        const vPrev = diagramValueAt(ef, type, (i-1) / nSeg, distLoad);
        const vHere = diagramValueAt(ef, type,  i    / nSeg, distLoad);
        const vNext = diagramValueAt(ef, type, (i+1) / nSeg, distLoad);
        const a = Math.abs(vHere);
        const isExtremum = (vHere - vPrev) * (vNext - vHere) <= 0;
        if (isExtremum && a > pv) { pv = a; pi = i; }
      }
      if (pi > 0) {
        g.appendChild(makeSVG('circle', { cx: offset[pi][0], cy: offset[pi][1], r: 3,
                                          fill: col, stroke: 'var(--bg-canvas,#fff)',
                                          'stroke-width': '1', 'pointer-events':'none' }));
        // drawDiagValue reads the sign only to decide which side of the curve
        // point the text sits on, so it wants the INTERNAL value — the same one
        // the end labels use — not the negated screen offset.
        if (views.vals) drawDiagValue(g, offset[pi][0], offset[pi][1],
                                      type === 'bmd'
                                        ? DesignChecks.internalForceAt(ef, 'BMD', (pi / nSeg) * ef.L)
                                        : diagramValueAt(ef, type, pi / nSeg, distLoad), col);
      }
    }
  }

  function drawDiagram(g, ef, type, sc, cls, col) {
    const { x1, y1, x2, y2, L } = ef;
    if (!L || L < 1e-10) return;

    // Resolve c, s — 2D solver stores ef.c/ef.s directly; 3D solver uses λ
    let c = ef.c, sv = ef.s;
    if (c === undefined || sv === undefined) {
      if (ef.λ) { c = ef.λ[0][0]; sv = ef.λ[0][2] || ef.λ[0][1] || 0; }
      else {
        const dz = (ef.z2||0)-(ef.z1||0), dy = y2-y1;
        const Lc = Math.hypot(x2-x1, dy!==0?dy:dz) || 1;
        c = (x2-x1)/Lc; sv = (dy!==0?dy:dz)/Lc;
      }
    }
    if (isNaN(c)) c = 1; if (isNaN(sv)) sv = 0;

    // Perpendicular direction for diagram offset
    const perp   = { x: -sv, y: c };
    const factor = sc * 0.05;
    // Z-aware screen coordinates: for Z-lifted 2D structures y=0, height in z
    const ey1 = (Math.abs(y1||0) < 1e-10 && (ef.z1||0) !== 0) ? ef.z1 : (y1||0);
    const ey2 = (Math.abs(y2||0) < 1e-10 && (ef.z2||0) !== 0) ? ef.z2 : (y2||0);
    const s1 = mToS(x1, ey1), s2 = mToS(x2, ey2);

    const distLoad = memberDistLoad(ef);
    const nSeg = (type === 'bmd' && distLoad) ? 16 : ((type === 'sfd' && distLoad) ? 8 : 1);

    const spine = [], offset = [];

    for (let i = 0; i <= nSeg; i++) {
      const t  = i / nSeg;
      const sx = s1.x + (s2.x - s1.x) * t;
      const sy = s1.y + (s2.y - s1.y) * t;
      spine.push([sx, sy]);

      // Shared with the 3D renderer so both plot the same ordinates.
      const v = diagramValueAt(ef, type, t, distLoad);
      offset.push([sx - perp.x * v * factor, sy + perp.y * v * factor]);
    }

    const pts = [
      ...spine.map(p => `${p[0]},${p[1]}`),
      ...[...offset].reverse().map(p => `${p[0]},${p[1]}`)
    ].join(' ');

    // Fill or outline depending on views.fill
    if (views.fill !== false) {
      g.appendChild(makeSVG('polygon', { points: pts, class: cls, 'pointer-events':'none' }));
    } else {
      // Outline only: draw the offset polyline (no fill polygon)
      const outlinePts = offset.map(p => `${p[0]},${p[1]}`).join(' ');
      const ol = makeSVG('polyline', { points: outlinePts, class: cls, 'pointer-events':'none' });
      ol.setAttribute('fill', 'none');
      g.appendChild(ol);
      // draw baseline (spine) too
      const bl = makeSVG('line', { x1: spine[0][0], y1: spine[0][1], x2: spine[nSeg][0], y2: spine[nSeg][1], stroke: col, 'stroke-width': '0.5', opacity: '0.4', 'pointer-events':'none' });
      g.appendChild(bl);
    }

    // Values at end stations
    if (views.vals) {
      // M1/M2 are END ACTIONS — the negative of the internal moment — so a
      // hogging support was labelled positive and a sagging one negative,
      // disagreeing with the results tables about the same point.
      const startVal = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', 0)
                     : type==='sfd' ? ef.V1 : ef.N1;
      const endVal   = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', ef.L)
                     : type==='sfd' ? ef.V2 : ef.N2;
      drawDiagValue(g, offset[0][0],    offset[0][1],    startVal, col);
      drawDiagValue(g, offset[nSeg][0], offset[nSeg][1], endVal,   col);
    }

    // Peak flag: find the max-absolute-value point within the span
    if (views.peaks !== false) {
      let peakT = -1, peakV = 0;

      if (distLoad && (type === 'bmd' || type === 'sfd')) {
        // Analytical peak for distributed load
        const wy1 = distLoad.fy;
        const wy2 = distLoad.fy2 !== undefined ? distLoad.fy2 : wy1;
        if (type === 'bmd') {
          // Zero-shear location: V(x) = V1 + wy1·x + (wy2-wy1)·x²/(2L) = 0
          // For uniform: x_peak = -V1/wy1 (if wy1 ≠ 0 and 0 < x < L)
          const dw = (wy2 - wy1) / L;
          let xpeak = -1;
          if (Math.abs(dw) < 1e-10) {
            xpeak = Math.abs(wy1) > 1e-10 ? -ef.V1 / wy1 : -1;
          } else {
            // Quadratic: (dw/2)x² + wy1·x + V1 = 0
            const aa = dw / 2, bb = wy1, cc = ef.V1;
            const disc = bb*bb - 4*aa*cc;
            if (disc >= 0) {
              const r1 = (-bb + Math.sqrt(disc)) / (2*aa);
              const r2 = (-bb - Math.sqrt(disc)) / (2*aa);
              xpeak = (r1 >= 0 && r1 <= L) ? r1 : (r2 >= 0 && r2 <= L) ? r2 : -1;
            }
          }
          if (xpeak >= 0 && xpeak <= L) {
            // Was  M1 + V1·x + ∫∫w.  The internal moment is  −M1 + V1·x + ∫∫w,
            // so this ran a full 2·M1 high on any member carrying an end
            // moment: a propped cantilever under 10 kN/m over 6 m flagged its
            // peak as 115.31 kNm against a true 25.31 — a 4.6× overstatement
            // that grew with the end moment. Read it from the one function that
            // also fills the tables and the design checks.
            peakT = xpeak / L; peakV = DesignChecks.internalForceAt(ef, 'BMD', xpeak);
          }
        } else { // SFD
          // Peak at x=0 or x=L or zero-crossing of wy
          const v0 = Math.abs(ef.V1), vL = Math.abs(ef.V2);
          if (v0 > vL) { peakT = 0; peakV = ef.V1; }
          else         { peakT = 1; peakV = ef.V2; }
        }
      } else {
        // No distributed load: peak is at whichever end has larger abs value
        const v0 = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', 0)
                 : type==='sfd' ? ef.V1 : ef.N1;
        const v1 = type==='bmd' ? DesignChecks.internalForceAt(ef, 'BMD', ef.L)
                 : type==='sfd' ? ef.V2 : ef.N2;
        if (Math.abs(v1) > Math.abs(v0)) { peakT = 1; peakV = v1; }
        else                              { peakT = 0; peakV = v0; }
      }

      // Only draw flag if value is significant and not already shown by vals
      const alreadyShown = views.vals && (peakT === 0 || peakT === 1);
      if (peakT >= 0 && Math.abs(peakV) > 0.001 && !alreadyShown) {
        // Interpolate position along offset array
        const tIdx = peakT * nSeg;
        const i0 = Math.min(Math.floor(tIdx), nSeg - 1);
        const frac = tIdx - i0;
        const px = offset[i0][0] + frac * (offset[i0+1]?.[0] - offset[i0][0] || 0);
        const py = offset[i0][1] + frac * (offset[i0+1]?.[1] - offset[i0][1] || 0);
        drawPeakFlag(g, px, py, peakV, col);
      }
    }
  }

  function drawDiagValue(g, x, y, v, col) {
    if (Math.abs(v) < 0.001) return;
    // Offset label away from member axis so it clears the extruded section
    const clearance = 14;   // px clearance above/below the diagram point
    const textY = v >= 0 ? y - clearance : y + clearance + 7;
    // White halo background for readability over section fills
    const bg = makeSVG('text', { x, y: textY, 'text-anchor':'middle', 'font-size':'9',
      fill:'white', stroke:'white', 'stroke-width':'3', 'stroke-linejoin':'round',
      'paint-order':'stroke', 'pointer-events':'none' });
    bg.textContent = Math.abs(v).toFixed(2);
    g.appendChild(bg);
    const t = makeSVG('text', { x, y: textY, 'text-anchor':'middle', 'font-size':'9',
      fill: col, 'font-weight':'600', 'pointer-events':'none' });
    t.textContent = Math.abs(v).toFixed(2);
    g.appendChild(t);
  }

  // ── Peak flag: ETABS-style callout box at the controlling station ─
  function drawPeakFlag(g, x, y, v, col) {
    if (Math.abs(v) < 0.001) return;
    const lbl  = Math.abs(v).toFixed(2);
    const bw   = lbl.length * 5.5 + 10;
    const bh   = 14;
    // Extra offset so flag clears any section extrusion (24px clearance)
    const offY = v >= 0 ? -30 : 16;
    const bx   = x - bw / 2;
    const by   = y + offY;

    // Stem line from diagram point to box
    const stemY = v >= 0 ? by + bh : by;
    const line = makeSVG('line', { x1: x, y1: y, x2: x, y2: stemY,
      stroke: col, 'stroke-width': '1', 'stroke-dasharray': '2,2', 'pointer-events':'none' });
    g.appendChild(line);

    // Background box
    const rect = makeSVG('rect', { x: bx, y: by, width: bw, height: bh, rx: '2',
      fill: col, opacity: '0.85', 'pointer-events':'none' });
    g.appendChild(rect);

    // Value text inside box
    const txt = makeSVG('text', { x: x, y: by + bh - 3, 'text-anchor':'middle',
      'font-size':'8.5', fill:'#fff', 'font-weight':'700', 'pointer-events':'none' });
    txt.textContent = lbl;
    g.appendChild(txt);
  }

  /**
   * Deflected shape in 3D.
   *
   * The 3D solver gives global end translations (u,v,w) and rotations
   * (θx,θy,θz) plus λ, the 3×3 direction-cosine matrix. Rotate both into local
   * axes, Hermite-interpolate the transverse displacement in each local
   * bending plane, then rotate back — so the curve follows the member's real
   * flexure rather than a straight chord between displaced ends.
   */
  function drawDeflected3D(g, ef) {
    const L = ef.L;
    if (!L || L < 1e-10 || !ef.λ) return;
    const lam = ef.λ;
    const toLocal  = v => [
      lam[0][0]*v[0] + lam[0][1]*v[1] + lam[0][2]*v[2],
      lam[1][0]*v[0] + lam[1][1]*v[1] + lam[1][2]*v[2],
      lam[2][0]*v[0] + lam[2][1]*v[1] + lam[2][2]*v[2]
    ];
    const toGlobal = v => [
      lam[0][0]*v[0] + lam[1][0]*v[1] + lam[2][0]*v[2],
      lam[0][1]*v[0] + lam[1][1]*v[1] + lam[2][1]*v[2],
      lam[0][2]*v[0] + lam[1][2]*v[1] + lam[2][2]*v[2]
    ];

    const d1 = toLocal([ef.u1 || 0, ef.v1 || 0, ef.w1 || 0]);
    const d2 = toLocal([ef.u2 || 0, ef.v2 || 0, ef.w2 || 0]);
    const r1 = toLocal([ef['θx1'] || 0, ef['θy1'] || 0, ef['θz1'] || 0]);
    const r2 = toLocal([ef['θx2'] || 0, ef['θy2'] || 0, ef['θz2'] || 0]);

    const DS = views.deflScale;
    const npts = 16;
    const pts = [];
    for (let i = 0; i <= npts; i++) {
      const xi = i / npts;
      const H1 = 1 - 3*xi*xi + 2*xi*xi*xi;
      const H2 = xi*(1 - xi)*(1 - xi)*L;
      const H3 = 3*xi*xi - 2*xi*xi*xi;
      const H4 = xi*xi*(xi - 1)*L;

      const ul = (1 - xi)*d1[0] + xi*d2[0];              // axial
      const vl = H1*d1[1] + H2*r1[2] + H3*d2[1] + H4*r2[2];   // local x-y, driven by θz
      const wl = H1*d1[2] - H2*r1[1] + H3*d2[2] - H4*r2[1];   // local x-z, driven by θy

      const dg = toGlobal([ul, vl, wl]);
      const bx = ef.x1 + (ef.x2 - ef.x1)*xi;
      const by = (ef.y1||0) + ((ef.y2||0) - (ef.y1||0))*xi;
      const bz = (ef.z1||0) + ((ef.z2||0) - (ef.z1||0))*xi;
      const sp = mToS3D(bx + dg[0]*DS, by + dg[1]*DS, bz + dg[2]*DS);
      pts.push(`${sp.x.toFixed(1)},${sp.y.toFixed(1)}`);
    }
    g.appendChild(makeSVG('polyline', { points: pts.join(' '), class:'sv-defl', 'pointer-events':'none' }));
  }

  function drawDeflected(g, ef) {
    const { x1, y1, x2, y2, L } = ef;
    if (!L || L < 1e-10) return;

    // Resolve c, s
    let c = ef.c, sv = ef.s;
    if (c === undefined || sv === undefined) {
      if (ef.λ) { c = ef.λ[0][0]; sv = ef.λ[0][2] || ef.λ[0][1] || 0; }
      else { const dz=(ef.z2||0)-(ef.z1||0),dy=y2-y1,Lc=Math.hypot(x2-x1,dy!==0?dy:dz)||1; c=(x2-x1)/Lc; sv=(dy!==0?dy:dz)/Lc; }
    }
    if (isNaN(c)) c = 1; if (isNaN(sv)) sv = 0;

    // Resolve rotations: 2D=t1/t2, 3D=θz1/θz2
    const t1 = ef.t1 !== undefined ? ef.t1 : (ef.θz1 || 0);
    const t2 = ef.t2 !== undefined ? ef.t2 : (ef.θz2 || 0);
    // Resolve displacements: use w1/w2 (Z-disp) for 3D vertical
    const u1 = ef.u1 || 0, u2 = ef.u2 || 0;
    const v1 = ef.w1 !== undefined ? ef.w1 : (ef.v1 || 0);
    const v2 = ef.w2 !== undefined ? ef.w2 : (ef.v2 || 0);

    // Z-aware effective Y: for Z-lifted structures y=0 and height is in z
    const ey1 = (Math.abs(y1||0) < 1e-10 && (ef.z1||0) !== 0) ? ef.z1 : (y1||0);
    const ey2 = (Math.abs(y2||0) < 1e-10 && (ef.z2||0) !== 0) ? ef.z2 : (y2||0);

    // Transform global nodal displacements → local beam axes
    const ul1 =  u1*c + v1*sv;
    const vl1 = -u1*sv + v1*c;
    const ul2 =  u2*c + v2*sv;
    const vl2 = -u2*sv + v2*c;

    const DS = views.deflScale;
    const pts = [];
    const npts = 16;
    for (let i = 0; i <= npts; i++) {
      const xi = i / npts;
      const H1 =  1 - 3*xi*xi + 2*xi*xi*xi;
      const H2 =  xi*(1 - xi)*(1 - xi)*L;
      const H3 =  3*xi*xi - 2*xi*xi*xi;
      const H4 =  xi*xi*(xi - 1)*L;
      const vy_loc = H1*vl1 + H2*t1 + H3*vl2 + H4*t2;
      const ux_loc = (1 - xi)*ul1 + xi*ul2;
      const du = ux_loc*c - vy_loc*sv;
      const dv = ux_loc*sv + vy_loc*c;
      // Use Z-aware undisplaced position
      const mx = x1 + (x2 - x1)*xi + du * DS;
      const my = ey1 + (ey2 - ey1)*xi + dv * DS;
      const sp = mToS(mx, my);
      pts.push(`${sp.x.toFixed(1)},${sp.y.toFixed(1)}`);
    }
    g.appendChild(makeSVG('polyline', { points: pts.join(' '), class:'sv-defl', 'pointer-events':'none' }));
  }

  function drawReactions(g, res) {
    for (const nd of nodes) {
      if (!nd.support || nd.support === 'none') continue;
      const r = res.reactions[nd.id]; if (!r) continue;
      const { x: sx, y: sy } = nodeToS(nd);
      const arrowLen = 40;
      const US = window.UnitSystem;
      const fLbl = US ? US.label('force') : 'kN';
      const mLbl = US ? US.label('moment') : 'kNm';

      // In 3D (Z-up) mode vertical reaction is Rz; in 2D it is Ry
      const vertR  = res.is3D ? (r.Rz || 0) : (r.Ry || 0);
      const horizR = r.Rx || 0;
      const momR   = res.is3D ? (r.Mz || 0) : (r.M  || 0);

      if (Math.abs(vertR) > 1e-6) {
        const dir = vertR >= 0 ? 1 : -1;
        const ay = sy + dir * arrowLen;
        g.appendChild(makeSVG('line', {
          x1: sx, y1: ay, x2: sx, y2: sy + dir * 8,
          stroke:'#1a237e', 'stroke-width':2.5, 'marker-end':'url(#arrow-blue)'
        }));
        if (views.vals) {
          const vd = US ? US.toDisplay(vertR, 'force') : vertR;
          const t = makeSVG('text', { x: sx+6, y: ay, 'font-size':'10', fill:'#1a237e', 'font-weight':'bold' });
          t.textContent = `${vd.toFixed(2)} ${fLbl}`;
          g.appendChild(t);
        }
      }

      if (Math.abs(horizR) > 1e-6) {
        const dir = horizR >= 0 ? -1 : 1;
        const ax = sx + dir * arrowLen;
        g.appendChild(makeSVG('line', {
          x1: ax, y1: sy, x2: sx + dir * 8, y2: sy,
          stroke:'#1a237e', 'stroke-width':2.5, 'marker-end':'url(#arrow-blue)'
        }));
        if (views.vals) {
          const rd = US ? US.toDisplay(horizR, 'force') : horizR;
          const t = makeSVG('text', { x: ax, y: sy-6, 'font-size':'10', fill:'#1a237e', 'font-weight':'bold', 'text-anchor':'middle' });
          t.textContent = `${rd.toFixed(2)} ${fLbl}`;
          g.appendChild(t);
        }
      }

      if (Math.abs(momR) > 1e-6 && nd.support === 'fixed') {
        const md = US ? US.toDisplay(momR, 'moment') : momR;
        const t = makeSVG('text', { x: sx+8, y: sy + 28, 'font-size':'10', fill:'#1a237e', 'font-weight':'bold' });
        t.textContent = `${md.toFixed(2)} ${mLbl}`;
        g.appendChild(t);
      }

      // For 3D, also draw Ry (depth-direction horizontal reaction) if significant
      if (res.is3D && Math.abs(r.Ry || 0) > 1e-6) {
        const ry3d = r.Ry;
        const yd = US ? US.toDisplay(ry3d, 'force') : ry3d;
        const t = makeSVG('text', { x: sx+8, y: sy + 40, 'font-size':'9', fill:'#6a1e9e', 'font-weight':'bold' });
        t.textContent = `Ry=${yd.toFixed(2)} ${fLbl}`;
        g.appendChild(t);
      }
    }
  }

  // ── Tool handlers ─────────────────────────────────────────────────

  function onCanvasClick(e) {
    if (e.button !== 0) return;
    const sp  = svgPt(e);
    let mp;
    if (mode3D) {
      const pt3d = sToM3D(sp.x, sp.y);   // uses _workPlane to give correct (x,y,z)
      // The working plane is edge-on to the camera — the click does not identify
      // a point on it. Refuse rather than drop geometry at an arbitrary spot.
      if (pt3d.degenerate && (tool === 'node' || tool === 'beam')) {
        toast(`Working plane ${_workPlane} is edge-on in this view — orbit slightly, or switch the drawing plane`, 'warn');
        return;
      }
      mp = { x: pt3d.x, y: pt3d.y, z: pt3d.z };
    } else {
      const raw = sToM(sp.x, sp.y);
      mp = snapPt(raw.x, raw.y);
      mp.z = 0;
    }

    if (cfg.angleSnap && tool === 'beam' && beamStart !== null && !mode3D) {
      const snapped = snapAngle(mp.x, mp.y, findNode(beamStart));
      mp.x = snapped.x; mp.y = snapped.y;
    }

    if (tool === 'node') {
      snapshot();
      // In 3D mode: mp already has correct x,y,z from working-plane sToM3D
      const nid = mode3D ? addNode(mp.x, mp.y, mp.z) : addNode(mp.x, mp.y, 0);
      if (mode3D && nid) {
        const nd = findNode(nid);
        if (nd) nd.z = mp.z;   // ensure z is stored
      }
      updateNodeTable(); render();
    }
    else if (tool === 'beam') {
      const hit = hitNode(sp.x, sp.y);
      if (hit !== null) {
        if (beamStart === null) {
          beamStart = hit;
          highlightNode(hit, true);
          setHint('Click another node to complete the beam');
        } else {
          if (beamStart !== hit) {
            snapshot();
            addBeam(beamStart, hit);
            updateBeamTable(); render();
          }
          beamStart = null; highlightNode(null);
          setHint('Click a node to start a beam');
        }
      } else {
        snapshot();
        const nz3D = mode3D ? (+document.getElementById('new-node-z')?.value || 0) : 0;
        const nid = addNode(mp.x, mp.y, nz3D);
        updateNodeTable();
        if (beamStart !== null) {
          addBeam(beamStart, nid);
          updateBeamTable(); beamStart = null; highlightNode(null);
        } else {
          beamStart = nid;
          setHint('Click another node to complete the beam');
        }
        render();
      }
    }
    else if (tool === 'support') {
      const hit = hitNode(sp.x, sp.y);
      if (hit !== null) { pendingNodeId = hit; openModal('modal-support'); }
    }
    else if (tool === 'hinge') {
      const hit = hitBeam(sp.x, sp.y);
      if (hit !== null) {
        const bm = findBeam(hit);
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        const s1 = nodeToS(ni), s2 = nodeToS(nj);
        const d1 = Math.hypot(sp.x-s1.x, sp.y-s1.y);
        const d2 = Math.hypot(sp.x-s2.x, sp.y-s2.y);
        snapshot();
        if (d1 < d2) bm.hingeStart = !bm.hingeStart;
        else         bm.hingeEnd   = !bm.hingeEnd;
        updateBeamTable(); render();
      }
    }
    else if (tool === 'load') {
      pendingNodeId = hitNode(sp.x, sp.y);

      // Use larger threshold (15px) for beam detection in Load mode — easier clicking
      const pendingBeamHit = hitBeam(sp.x, sp.y, 15);

      populateLoadDialog();

      const beamSel = document.getElementById('load-beam-sel');
      const typeSel = document.getElementById('load-type-sel');

      if (pendingBeamHit !== null && pendingNodeId === null) {
        // Beam was clicked — pre-select it + switch to Uniform Distributed
        if (beamSel) beamSel.value = String(pendingBeamHit);
        if (typeSel) { typeSel.value = 'beam_dist'; typeSel.dispatchEvent(new Event('change')); }
        selBeam = pendingBeamHit; selNode = null;
        render();
      } else if (pendingNodeId === null && pendingBeamHit === null) {
        // Clicked empty canvas — find the nearest beam as a helpful default
        let nearestBeam = null, nearestDist = Infinity;
        for (const bm of beams) {
          const ni = findNode(bm.node1), nj = findNode(bm.node2);
          if (!ni || !nj) continue;
          const s1 = nodeToS(ni), s2 = nodeToS(nj);
          const d = Math.hypot(sp.x - (s1.x+s2.x)/2, sp.y - (s1.y+s2.y)/2);
          if (d < nearestDist) { nearestDist = d; nearestBeam = bm.id; }
        }
        if (nearestBeam !== null) {
          // Pre-select nearest beam + switch to Distributed Load as helpful default
          if (beamSel) beamSel.value = String(nearestBeam);
          if (typeSel && typeSel.value === 'nodal') {
            typeSel.value = 'beam_dist'; typeSel.dispatchEvent(new Event('change'));
          }
        }
      }

      openModal('modal-load');
    }
    else if (tool === 'section') {
      const hbSec = hitBeam(sp.x, sp.y);
      if (hbSec !== null) {
        selBeam = hbSec; selNode = null;
        render();
        // Open the Change Section dialog (shows current section, dropdown of all sections)
        App._openChangeSection(hbSec);
      } else {
        toast('Click on a beam or column to change its section', 'info');
      }
    }
    else if (tool === 'settle')  { populateSettleDialog(); openModal('modal-settle'); }
    else if (tool === 'delete') {
      const hn = hitNode(sp.x, sp.y);
      if (hn !== null) {
        snapshot();
        const gone = deleteNode(hn);
        updateNodeTable(); updateBeamTable(); updateLoadTable(); render();
        reportNodeDeletion(hn, gone);
      } else {
        const hb = hitBeam(sp.x, sp.y);
        if (hb !== null) {
          snapshot(); deleteBeam(hb);
          updateBeamTable(); updateLoadTable(); render();
        }
      }
    }
    else if (tool === 'select') {
      const hn = hitNode(sp.x, sp.y);
      const hb = hitBeam(sp.x, sp.y);
      selNode = hn; selBeam = hn === null ? hb : null;
      render();
    }
  }

  function onNodeClick(e, nid) {
    e.stopPropagation();
    if (tool === 'beam') {
      if (beamStart === null) {
        beamStart = nid; highlightNode(nid, true);
        setHint('Click another node to complete the beam');
      } else {
        if (beamStart !== nid) {
          snapshot(); addBeam(beamStart, nid); updateBeamTable(); render();
        }
        beamStart = null; highlightNode(null);
        setHint('Click a node to start a beam');
      }
    } else if (tool === 'support') { pendingNodeId = nid; openModal('modal-support'); }
    else if (tool === 'load') { pendingNodeId = nid; populateLoadDialog(); openModal('modal-load'); }
    else if (tool === 'delete') {
      snapshot();
      const gone = deleteNode(nid);
      updateNodeTable(); updateBeamTable(); updateLoadTable(); render();
      reportNodeDeletion(nid, gone);
    } else if (tool === 'select') { selNode = nid; selBeam = null; render(); }
  }

  function onBeamClick(e, bid) {
    e.stopPropagation();
    if (tool === 'hinge') {
      const bm = findBeam(bid);
      const sp = svgPt(e);
      const ni = findNode(bm.node1), nj = findNode(bm.node2);
      const s1 = nodeToS(ni), s2 = nodeToS(nj);
      snapshot();
      if (Math.hypot(sp.x-s1.x, sp.y-s1.y) < Math.hypot(sp.x-s2.x, sp.y-s2.y))
        bm.hingeStart = !bm.hingeStart;
      else bm.hingeEnd = !bm.hingeEnd;
      updateBeamTable(); render();
    } else if (tool === 'load') {
      pendingNodeId = null;
      document.getElementById('load-type-sel').value = 'beam_dist';
      updateLoadDialog();
      document.getElementById('load-beam-sel').value = bid;
      openModal('modal-load');
    } else if (tool === 'delete') {
      snapshot(); deleteBeam(bid);
      updateBeamTable(); updateLoadTable(); render();
    } else if (tool === 'select') { selBeam = bid; selNode = null; render(); }
  }

  function onMouseMove(e) {
    // Rubber-band update — Window (L→R, blue solid) vs Crossing (R→L, green dashed)
    if (rubberBand) {
      const sp = svgPt(e);
      rubberBand.x1 = sp.x; rubberBand.y1 = sp.y;
      const lt = layerTemp(); clearLayer(lt);
      const rx=Math.min(rubberBand.x0,rubberBand.x1), ry=Math.min(rubberBand.y0,rubberBand.y1);
      const w=Math.abs(rubberBand.x1-rubberBand.x0), h=Math.abs(rubberBand.y1-rubberBand.y0);
      const isCrossing = rubberBand.x1 < rubberBand.x0; // right-to-left = crossing
      const fillCol  = isCrossing ? 'rgba(0,180,60,0.06)'  : 'rgba(21,101,192,0.07)';
      const strokeCol= isCrossing ? '#00b43c'              : '#1565c0';
      const dash     = isCrossing ? '6,4'                  : 'none';
      const rect = makeSVG('rect', { x:rx, y:ry, width:w, height:h,
        fill:fillCol, stroke:strokeCol, 'stroke-width':'1.5',
        'stroke-dasharray':dash, 'vector-effect':'non-scaling-stroke' });
      lt.appendChild(rect);
      // Label top-left corner
      const labelSvg = makeSVG('text', { x:rx+4, y:ry-4, 'font-size':'9',
        fill:strokeCol, style:'font-weight:600;pointer-events:none' });
      labelSvg.textContent = isCrossing ? '✕ Crossing' : '□ Window';
      lt.appendChild(labelSvg);
      return;
    }

    if (rotating3D) {
      const sp = svgPt(e);
      const dx = sp.x - rotStart3D.x, dy = sp.y - rotStart3D.y;
      rotStart3D = sp;
      view3D.az = (view3D.az + dx * 0.008) % (Math.PI * 2);
      view3D.el  = Math.max(0.04, Math.min(Math.PI / 2 - 0.04, view3D.el - dy * 0.006));
      render(); return;
    }

    if (panning) {
      const sp = svgPt(e);
      pan.x += sp.x - panStart.x;
      pan.y += sp.y - panStart.y;
      panStart = sp;
      render(); return;
    }

    const sp  = svgPt(e);
    let mp;
    if (mode3D) {
      const pt3d = sToM3D(sp.x, sp.y);
      mp = pt3d;
      // Update working plane coordinate display
      if (window.WORKPLANE) WORKPLANE.updateSnapPos(pt3d.x, pt3d.y, pt3d.z);
    } else {
      const raw = sToM(sp.x, sp.y);
      mp = snapPt(raw.x, raw.y);
      if (window.WORKPLANE) WORKPLANE.updateSnapPos(mp.x, mp.y, 0);
    }
    {
      const lenLbl = window.UnitSystem ? UnitSystem.label('length') : 'm';
      const xD = window.UnitSystem ? UnitSystem.toDisplay(mp.x, 'length') : mp.x;
      const yD = window.UnitSystem ? UnitSystem.toDisplay(mode3D ? mp.z : mp.y, 'length') : (mode3D ? mp.z : mp.y);
      const dec = window.UnitSystem ? (UnitSystem.current().decimals.length || 2) : 2;
      const coordTxt = mode3D
        ? `x:${xD.toFixed(dec)} y:${(mp.y||0).toFixed(dec)} z:${yD.toFixed(dec)} ${lenLbl}`
        : `x: ${xD.toFixed(dec)}  y: ${yD.toFixed(dec)} ${lenLbl}`;
      document.getElementById('coords-display').textContent = coordTxt;
    }
    document.getElementById('st-info').textContent = `Nodes: ${nodes.length} | Beams: ${beams.length} | Loads: ${loads.length}`;

    const lt = layerTemp();
    clearLayer(lt);
    if (tool === 'beam' && beamStart !== null) {
      const ni = findNode(beamStart);
      // The rubber band must use the SAME projection as the beam it previews.
      // Both ends were projected with the plain 2D transform: the start node
      // through mToS(x, y) — wrong for a Z-lifted model, where the node is drawn
      // from z — and the cursor end through a hand-rolled `x*scale+pan.x,
      // -y*scale+pan.y`, which in 3D drops z entirely and runs world-Y up the
      // screen. Drawing on the XZ plane (y fixed) therefore pinned the preview
      // to a single screen row: the dashed line ran dead horizontal, along no
      // model axis, however the cursor moved. nodeToS()/mToS3D() are the
      // projections the renderer itself uses.
      let tp = mp;
      // snapAngle is 2D-only (it rewrites x/y and ignores z). onCanvasClick
      // already skips it in 3D, so previewing it there would show a beam the
      // click will not create.
      if (cfg.angleSnap && !mode3D) tp = snapAngle(mp.x, mp.y, ni);
      // A working plane edge-on to the camera gives no usable point — the click
      // is refused, so do not draw a preview to an arbitrary spot either.
      if (!(mode3D && mp.degenerate)) {
        const s1 = nodeToS(ni);
        const s2 = mode3D ? mToS3D(tp.x, tp.y || 0, tp.z || 0) : mToS(tp.x, tp.y);
        lt.appendChild(makeSVG('line', { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, class:'sv-temp-beam' }));
      }
    }
  }

  function onMouseDown(e) {
    // Left drag on empty space in select mode → rubber-band (AutoCAD-style)
    if (e.button === 0 && tool === 'select') {
      const sp = svgPt(e);
      if (hitNode(sp.x, sp.y) === null && hitBeam(sp.x, sp.y) === null) {
        rubberBand = { x0:sp.x, y0:sp.y, x1:sp.x, y1:sp.y };
        e.preventDefault(); return;
      }
    }
    // Shift + left click still also works for rubber-band
    if (e.button === 0 && e.shiftKey && tool === 'select') {
      const sp = svgPt(e);
      rubberBand = { x0:sp.x, y0:sp.y, x1:sp.x, y1:sp.y };
      e.preventDefault(); return;
    }
    // In 3D mode: right-drag or Ctrl+left-drag → orbit rotation
    if (mode3D && (e.button === 2 || (e.button === 0 && e.ctrlKey))) {
      rotating3D = true; rotStart3D = svgPt(e);
      svg().style.cursor = 'move'; e.preventDefault(); return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panning = true; panStart = svgPt(e);
      svg().style.cursor = 'grabbing'; e.preventDefault();
    } else if (e.button === 2) {
      panning = true; panStart = svgPt(e);
      svg().style.cursor = 'grabbing'; e.preventDefault();
    }
  }

  function onMouseUp(e) {
    if (rubberBand) {
      // AutoCAD-style: Window (L→R) = fully inside; Crossing (R→L) = inside OR crossing
      const isCrossing = rubberBand.x1 < rubberBand.x0;
      const rx0=Math.min(rubberBand.x0,rubberBand.x1), rx1=Math.max(rubberBand.x0,rubberBand.x1);
      const ry0=Math.min(rubberBand.y0,rubberBand.y1), ry1=Math.max(rubberBand.y0,rubberBand.y1);
      multiSel.nodes.clear(); multiSel.beams.clear();
      selNode = null; selBeam = null;

      // Helper: does segment (ax,ay)-(bx,by) intersect rectangle rx0..rx1, ry0..ry1?
      function segIntersectsRect(ax,ay,bx,by) {
        // Cohen-Sutherland clipping — if both endpoints outside same edge, no intersect
        function code(x,y){return((x<rx0)?1:(x>rx1)?2:0)|((y<ry0)?4:(y>ry1)?8:0);}
        let c0=code(ax,ay),c1=code(bx,by);
        while(true){
          if(!(c0|c1)) return true;   // both inside
          if(c0&c1)    return false;  // both outside same edge
          const c=c0||c1; let x,y;
          if(c&8){x=ax+(bx-ax)*(ry1-ay)/(by-ay);y=ry1;}
          else if(c&4){x=ax+(bx-ax)*(ry0-ay)/(by-ay);y=ry0;}
          else if(c&2){y=ay+(by-ay)*(rx1-ax)/(bx-ax);x=rx1;}
          else{y=ay+(by-ay)*(rx0-ax)/(bx-ax);x=rx0;}
          if(c===c0){ax=x;ay=y;c0=code(ax,ay);}else{bx=x;by=y;c1=code(bx,by);}
        }
      }

      // Select nodes always by containment (same for both modes)
      // Use nodeToS so Z-lifted 2D structures map correctly (nd.z as height)
      for (const nd of nodes) {
        const {x:sx,y:sy}=nodeToS(nd);
        if (sx>=rx0&&sx<=rx1&&sy>=ry0&&sy<=ry1) multiSel.nodes.add(nd.id);
      }
      // Select beams: Window = both ends inside; Crossing = any overlap
      for (const bm of beams) {
        const ni=findNode(bm.node1),nj=findNode(bm.node2); if(!ni||!nj) continue;
        const s1=nodeToS(ni),s2=nodeToS(nj);
        const n1In=s1.x>=rx0&&s1.x<=rx1&&s1.y>=ry0&&s1.y<=ry1;
        const n2In=s2.x>=rx0&&s2.x<=rx1&&s2.y>=ry0&&s2.y<=ry1;
        if (isCrossing) {
          if (n1In || n2In || segIntersectsRect(s1.x,s1.y,s2.x,s2.y)) multiSel.beams.add(bm.id);
        } else {
          if (n1In && n2In) multiSel.beams.add(bm.id);
        }
      }
      rubberBand = null;
      clearLayer(layerTemp());
      render();
      if (multiSel.nodes.size || multiSel.beams.size)
        toast(`${isCrossing?'Crossing':'Window'} selection: ${multiSel.nodes.size} node(s), ${multiSel.beams.size} member(s)`, 'info');
      return;
    }
    if (rotating3D) { rotating3D = false; svg().style.cursor = ''; return; }
    if (panning) { panning = false; svg().style.cursor = ''; }
  }

  function onWheel(e) {
    e.preventDefault();
    const sp = svgPt(e);
    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    pan.x = sp.x + (pan.x - sp.x) * factor;
    pan.y = sp.y + (pan.y - sp.y) * factor;
    scale *= factor;
    scale = Math.max(5, Math.min(scale, 2000));
    render();
  }

  // ── Hit testing ───────────────────────────────────────────────────

  function hitNode(sx, sy, radius = 10) {
    let best = null, bd = Infinity;
    for (const nd of nodes) {
      // nodeToS, not mToS: picking has to use the projection the node was drawn
      // with. The flat 2D transform ignores nd.z, so in 3D — and in a Z-lifted
      // 2D model, which is what the generators produce — the pick point drifted
      // away from the marker with distance from the origin (455 px for a node
      // at 12 m, 7 m). hitBeam directly below already did this correctly.
      const sp = nodeToS(nd);
      const d  = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < radius && d < bd) { bd = d; best = nd.id; }
    }
    return best;
  }

  function hitBeam(sx, sy, threshold = 6) {
    let best = null, bd = Infinity;
    for (const bm of beams) {
      const ni = findNode(bm.node1), nj = findNode(bm.node2);
      if (!ni || !nj) continue;
      const s1 = nodeToS(ni), s2 = nodeToS(nj);
      const d = ptSegDist(sx, sy, s1.x, s1.y, s2.x, s2.y);
      if (d < threshold && d < bd) { bd = d; best = bm.id; }
    }
    return best;
  }

  function ptSegDist(px, py, ax, ay, bx, by) {
    const dx = bx-ax, dy = by-ay;
    const lenSq = dx*dx + dy*dy;
    if (lenSq < 1e-10) return Math.hypot(px-ax, py-ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
    return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
  }

  // ── Data helpers ──────────────────────────────────────────────────

  function findNode(id) { return nodes.find(n => n.id === id) || null; }
  function findBeam(id) { return beams.find(b => b.id === id) || null; }

  // ── Member Properties Popup ───────────────────────────────────────

  function hideMemberPopup() {
    const pop = document.getElementById('member-popup');
    if (pop) pop.style.display = 'none';
  }

  function showMemberPopup(bid, cx, cy) {
    const pop  = document.getElementById('member-popup');
    const body = document.getElementById('mpop-body');
    const ttl  = document.getElementById('mpop-title');
    if (!pop || !body) return;

    const bm  = findBeam(bid); if (!bm) return;
    const ni  = findNode(bm.node1), nj = findNode(bm.node2);
    const sec = sections.find(s => s.id === bm.sectionId);
    const _activeRes = getActiveResults();
    const ef  = _activeRes ? _activeRes.elemForces?.find(e => e.id === bid) : null;
    const US  = window.UnitSystem;

    const L   = memberLength(ni, nj);
    const mtype = getMemberType(bm);
    ttl.textContent = `B${bid} — ${mtype.charAt(0).toUpperCase()+mtype.slice(1)}`;

    const fmt = (v, unit) => {
      if (!v && v !== 0) return '—';
      const disp = US ? US.toDisplay(v, unit) : v;
      return isFinite(disp) ? disp.toFixed(3) + ' ' + (US ? US.label(unit) : unit) : '—';
    };
    const fmtF = v => fmt(v, 'force');
    const fmtM = v => fmt(v, 'moment');
    const fmtL = v => fmt(v, 'length');

    let html = `<div class="mpop-section">Geometry</div>
      <table>
        <tr><td>Length</td><td>${fmtL(L)}</td></tr>
        <tr><td>Angle</td><td>${ni&&nj?memberAngleDeg(ni,nj).toFixed(1)+'°':'—'}</td></tr>
        <tr><td>Section</td><td>${escapeIssue(sec ? sec.name : '?')}</td></tr>
        <tr><td>N1 → N2</td><td>${bm.node1} → ${bm.node2}</td></tr>
      </table>`;

    if (sec) {
      html += `<div class="mpop-section">Section Properties</div>
        <table>
          <tr><td>E</td><td>${sec.E} GPa</td></tr>
          <tr><td>A</td><td>${sec.A} cm²</td></tr>
          <tr><td>I</td><td>${sec.I} cm⁴</td></tr>
          <tr><td>fy</td><td>${sec.fy || '—'} MPa</td></tr>
        </table>`;
    }

    if (ef) {
      const maxN   = Math.max(Math.abs(ef.N1), Math.abs(ef.N2));
      const maxV   = Math.max(Math.abs(ef.V1), Math.abs(ef.V2));
      const maxM   = Math.max(Math.abs(ef.M1), Math.abs(ef.M2));
      html += `<div class="mpop-section">Element Forces</div>
        <table>
          <tr><td>N (start)</td><td>${fmtF(ef.N1)}</td></tr>
          <tr><td>N (end)</td><td>${fmtF(ef.N2)}</td></tr>
          <tr><td>V (start)</td><td>${fmtF(ef.V1)}</td></tr>
          <tr><td>V (end)</td><td>${fmtF(ef.V2)}</td></tr>
          <tr><td>M (start)</td><td>${fmtM(DesignChecks.internalForceAt(ef, 'BMD', 0))}</td></tr>
          <tr><td>M (end)</td><td>${fmtM(ef.M2)}</td></tr>
          <tr><td style="color:#1565C0;font-weight:600">|N| max</td><td style="font-weight:700;color:#1565C0">${fmtF(maxN)}</td></tr>
          <tr><td style="color:#388e3c;font-weight:600">|V| max</td><td style="font-weight:700;color:#388e3c">${fmtF(maxV)}</td></tr>
          <tr><td style="color:#e53935;font-weight:600">|M| max</td><td style="font-weight:700;color:#e53935">${fmtM(maxM)}</td></tr>
        </table>`;

      if (sec && sec.fy) {
        const A_m2 = sec.A / 1e4, I_m4 = (sec.Ix || sec.I) / 1e8;
        const ymax = Math.pow(I_m4 / A_m2, 0.5);
        const sig1 = Math.abs(ef.N1)/A_m2 + Math.abs(ef.M1)*ymax/I_m4;
        const sig2 = Math.abs(ef.N2)/A_m2 + Math.abs(ef.M2)*ymax/I_m4;
        const util = Math.max(sig1, sig2) / (sec.fy * 1000);
        const col  = util < 0.5 ? '#43a047' : util < 0.8 ? '#fb8c00' : util < 1.0 ? '#e53935' : '#6a1a9a';
        html += `<div class="mpop-section">Utilization</div>
          <table>
            <tr><td>σ / fy</td>
              <td style="color:${col};font-weight:700">${(util*100).toFixed(1)}%
                <div style="display:inline-block;width:50px;height:6px;background:#e0e0e0;border-radius:3px;vertical-align:middle;margin-left:4px">
                  <div style="width:${Math.min(100,util*100).toFixed(0)}%;height:100%;background:${col};border-radius:3px"></div>
                </div>
              </td>
            </tr>
          </table>`;
      }
    } else {
      html += `<div style="color:var(--text-muted);padding:6px 0;font-style:italic">Solve to see forces &amp; utilization</div>`;
    }

    if (typeof designResults !== 'undefined' && designResults) {
      const bd = designResults.byBeam && designResults.byBeam.find(b => b.id === bid);
      if (bd) {
        const col = bd.overall === 'OK' ? '#43a047' : bd.overall === 'NEAR' ? '#fb8c00' : '#e53935';
        html += `<div class="mpop-section">Design Check</div>
          <table>
            <tr><td>Status</td><td style="color:${col};font-weight:700">${bd.overall} (η=${bd.maxEta.toFixed(3)})</td></tr>
          </table>`;
      }
    }

    // ── Applied Loads (dynamic — all loads on this beam) ─────────────
    const bmLoads = loads.filter(ld =>
      (ld.type === 'beam_dist' || ld.type === 'beam_point' || ld.type === 'beam_trap') &&
      ld.elementId === bid
    );
    {
      const lcMap = {};
      loadCases.forEach(lc => { lcMap[lc.id] = lc; });
      const typeTag  = { beam_dist:'UDL', beam_trap:'Trap.', beam_point:'Point' };
      const typeIcon = { beam_dist:'▬', beam_trap:'◤', beam_point:'▼' };

      // Direction & value string helper
      const loadValStr = ld => {
        const fx = ld.fx || 0, fy = ld.fy || 0;
        const unit = (ld.type === 'beam_point') ? 'kN' : 'kN/m';
        if (ld.type === 'beam_trap') {
          const fy2 = ld.fy2 !== undefined ? ld.fy2 : fy;
          return { val: `${fy.toFixed(2)} → ${fy2.toFixed(2)}`, unit, dir: fy < 0 ? '↓' : '↑', mag: Math.max(Math.abs(fy), Math.abs(fy2)) };
        }
        if (Math.abs(fy) > 1e-9 && Math.abs(fx) < 1e-9)
          return { val: fy.toFixed(2), unit, dir: fy < 0 ? '↓' : '↑', mag: Math.abs(fy) };
        if (Math.abs(fx) > 1e-9 && Math.abs(fy) < 1e-9)
          return { val: fx.toFixed(2), unit, dir: fx > 0 ? '→' : '←', mag: Math.abs(fx) };
        return { val: `fx=${fx.toFixed(1)} fy=${fy.toFixed(1)}`, unit, dir: '↗', mag: Math.hypot(fx,fy) };
      };

      // Max magnitude for relative bar
      const maxMag = bmLoads.reduce((m, ld) => Math.max(m, loadValStr(ld).mag), 0) || 1;

      const countStr = bmLoads.length > 0 ? ` <span style="background:#e53935;color:#fff;border-radius:8px;padding:0 5px;font-size:9px;margin-left:4px">${bmLoads.length}</span>` : '';
      html += `<div class="mpop-section">Applied Loads${countStr}</div>`;

      if (bmLoads.length > 0) {
        html += `<div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">`;
        bmLoads.forEach((ld, idx) => {
          const lc      = lcMap[ld.caseId];
          // Case name/type can arrive from an imported .frame file or a
          // share-link URL with no sanitisation upstream, and used to go
          // straight into innerHTML below — a crafted name executed as
          // markup the moment this popup opened. lcColor is validated to a
          // strict hex format for the same reason: it lands unescaped in a
          // style attribute, where a stray `"` could break out of it.
          const lcNm    = escapeIssue(lc ? lc.name : `Case ${ld.caseId}`);
          const lcTy    = escapeIssue(lc ? lc.type : '');
          const lcColor = (lc && lc.color && /^#[0-9a-f]{6}$/i.test(lc.color)) ? lc.color : '#1565c0';
          const tag     = typeTag[ld.type]  || ld.type;
          const icon    = typeIcon[ld.type] || '▼';
          const info    = loadValStr(ld);
          const barPct  = Math.round((info.mag / maxMag) * 100);
          // Light tint from case color
          const hexToRgb = c => { const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16); return `${r},${g},${b}`; };
          const rgb = /^#[0-9a-f]{6}$/i.test(lcColor) ? hexToRgb(lcColor) : '21,101,192';
          html += `
          <div style="border-left:3px solid ${lcColor};border-radius:0 5px 5px 0;
                      background:rgba(${rgb},0.07);padding:5px 6px 4px 7px;position:relative">
            <!-- Header row: case badge + type + remove -->
            <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
              <span style="background:${lcColor};color:#fff;font-size:8px;font-weight:700;
                           padding:1px 5px;border-radius:8px;letter-spacing:0.04em;text-transform:uppercase">${lcTy || lcNm}</span>
              <span style="font-size:9px;color:${lcColor};font-weight:600">${lcNm}</span>
              <span style="margin-left:auto;font-size:9px;color:var(--text-muted)">${icon} ${tag}</span>
              <button class="mpop-rm-load" data-lid="${ld.id}"
                style="width:14px;height:14px;line-height:1;border-radius:3px;border:1px solid ${lcColor};
                       color:${lcColor};background:transparent;cursor:pointer;font-size:8px;padding:0;flex-shrink:0"
                title="Remove this load">✕</button>
            </div>
            <!-- Value row -->
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:13px;font-weight:700;color:${lcColor};line-height:1">${info.dir}</span>
              <span class="mpop-load-val" data-lid="${ld.id}"
                style="font-size:12px;font-weight:700;color:${lcColor};cursor:pointer;flex:1"
                title="Click to edit">${info.val}</span>
              <span style="font-size:9px;color:var(--text-sec);white-space:nowrap">${info.unit}</span>
            </div>
            <!-- Magnitude bar -->
            <div style="margin-top:4px;background:rgba(${rgb},0.15);border-radius:3px;height:3px;overflow:hidden">
              <div style="width:${barPct}%;height:100%;background:${lcColor};border-radius:3px;
                          transition:width 0.3s"></div>
            </div>
          </div>`;
        });
        html += `</div>`;
      } else {
        html += `<div style="color:var(--text-muted);font-size:10px;padding:6px 0;font-style:italic;text-align:center">
          No loads applied to this member</div>`;
      }
    }

    // ── Quick Add Load section ────────────────────────────────────────
    html += `<div class="mpop-section" style="margin-top:8px">Quick Add Load</div>`;
    if (loadCases.length > 0) {
      const lcOpts = loadCases.map(lc => {
        const col = /^#[0-9a-f]{6}$/i.test(lc.color || '') ? lc.color : '#1565c0';
        return `<option value="${lc.id}" data-color="${col}">${escapeIssue(lc.name)} (${escapeIssue(lc.type)})</option>`;
      }).join('');
      // Quick preset buttons based on available cases
      const presetBtns = loadCases.slice(0, 4).map(lc => {
        const col = /^#[0-9a-f]{6}$/i.test(lc.color || '') ? lc.color : '#1565c0';
        const hexToRgb2 = c => { try{ const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16); return `${r},${g},${b}`; }catch(e){return '21,101,192';} };
        const rgb2 = /^#[0-9a-f]{6}$/i.test(col) ? hexToRgb2(col) : '21,101,192';
        return `<button class="mpop-quick-preset" data-caseid="${lc.id}" data-color="${col}"
          style="padding:3px 7px;font-size:9px;font-weight:700;border-radius:4px;cursor:pointer;
                 background:rgba(${rgb2},0.12);border:1px solid ${col};color:${col}">
          ${escapeIssue(lc.type)}</button>`;
      }).join('');
      html += `
      <div style="display:flex;gap:3px;margin-bottom:6px;flex-wrap:wrap">${presetBtns}</div>
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:4px">
        <span id="mpop-case-dot" style="width:9px;height:9px;border-radius:50%;background:#1565c0;flex-shrink:0"></span>
        <select id="mpop-udl-case"
          style="flex:1;font-size:10px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;
                 background:var(--bg-pane);color:var(--text)">${lcOpts}</select>
      </div>
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:6px">
        <input id="mpop-udl-val" type="number" value="-10" step="0.5"
          style="flex:1;font-size:11px;font-weight:700;padding:3px 5px;border:1px solid var(--border);
                 border-radius:4px;background:var(--bg-pane);color:var(--text)">
        <span style="font-size:10px;color:var(--text-sec);white-space:nowrap">kN/m ↕</span>
      </div>
      <button id="mpop-udl-apply"
        style="width:100%;padding:5px 0;font-size:11px;font-weight:700;
               background:#1565c0;color:#fff;border:none;border-radius:5px;cursor:pointer;
               letter-spacing:0.02em">＋ Apply UDL</button>`;
    } else {
      html += `<div style="color:var(--text-muted);font-size:10px;font-style:italic">Add load cases first</div>`;
    }

    body.innerHTML = html;

    // Wire ✕ remove-load buttons
    body.querySelectorAll('.mpop-rm-load').forEach(btn => {
      btn.addEventListener('click', () => {
        const lid = parseInt(btn.dataset.lid, 10);
        const idx = loads.findIndex(l => l.id === lid);
        if (idx >= 0) {
          snapshot();
          loads.splice(idx, 1);
          render(); updateLoadTable();
          showMemberPopup(bid, null, null);
        }
      });
    });

    // Wire inline value edit — click on value text to edit in-place
    body.querySelectorAll('.mpop-load-val').forEach(span => {
      span.addEventListener('click', () => {
        const lid = parseInt(span.dataset.lid, 10);
        const ld  = loads.find(l => l.id === lid); if (!ld) return;
        const cur = ld.fy !== undefined && Math.abs(ld.fy) > 1e-9 ? ld.fy : (ld.fx || 0);
        const inp = document.createElement('input');
        inp.type  = 'number'; inp.value = cur; inp.step = '0.5';
        inp.style.cssText = 'width:70px;font-size:11px;font-weight:700;padding:1px 4px;border:1px solid #1565c0;border-radius:3px';
        span.replaceWith(inp);
        inp.focus(); inp.select();
        const apply = () => {
          const v = parseFloat(inp.value);
          if (!isNaN(v) && v !== cur) {
            snapshot();
            if (ld.fy !== undefined && Math.abs(ld.fy) > 1e-9) ld.fy = v;
            else ld.fx = v;
            if (ld.fy2 !== undefined) ld.fy2 = v;  // keep uniform for UDL
            render(); updateLoadTable();
          }
          showMemberPopup(bid, null, null);
        };
        inp.addEventListener('blur', apply);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') showMemberPopup(bid, null, null); });
      });
    });

    // Wire Quick Load: case selector updates dot color
    const caseSel = document.getElementById('mpop-udl-case');
    const caseDot = document.getElementById('mpop-case-dot');
    const applyBtn = document.getElementById('mpop-udl-apply');
    if (caseSel && caseDot) {
      const syncDot = () => {
        const opt = caseSel.options[caseSel.selectedIndex];
        const col = opt ? (opt.dataset.color || '#1565c0') : '#1565c0';
        caseDot.style.background = col;
        if (applyBtn) applyBtn.style.background = col;
      };
      caseSel.addEventListener('change', syncDot);
      syncDot();
    }

    // Wire preset case buttons (click → select that case)
    body.querySelectorAll('.mpop-quick-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        if (caseSel) {
          caseSel.value = btn.dataset.caseid;
          caseSel.dispatchEvent(new Event('change'));
        }
        // Highlight active preset
        body.querySelectorAll('.mpop-quick-preset').forEach(b =>
          b.style.fontWeight = b === btn ? '900' : '700'
        );
      });
    });

    // Wire Apply UDL button
    const mpopApplyBtn = document.getElementById('mpop-udl-apply');
    if (mpopApplyBtn) {
      mpopApplyBtn.addEventListener('click', () => {
        const udl    = parseFloat(document.getElementById('mpop-udl-val')?.value) || 0;
        const caseId = parseInt(document.getElementById('mpop-udl-case')?.value, 10);
        if (!udl) { toast('Enter a non-zero UDL value', 'warn'); return; }
        if (!caseId) { toast('No load case selected', 'warn'); return; }
        snapshot();
        loads.push({ id: nextId.load++, type: 'beam_dist', elementId: bid, fx: 0, fy: udl, fy2: udl, m: 0, caseId });
        render(); updateLoadTable();
        const lc = loadCases.find(l => l.id === caseId);
        toast(`${lc ? lc.name : 'Load'}: ${udl} kN/m applied to B${bid}`, 'ok');
        showMemberPopup(bid, null, null);
      });
    }

    pop.style.display = 'block';
    // Only reposition if caller provided coordinates (null = in-place refresh)
    if (cx !== null && cy !== null) {
      const rect = pop.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let x = cx + 12, y = cy - 10;
      if (x + rect.width  > vw - 10) x = cx - rect.width - 12;
      if (y + rect.height > vh - 10) y = vh - rect.height - 10;
      if (y < 5) y = 5;
      pop.style.left = x + 'px';
      pop.style.top  = y + 'px';
    }
  }

  function showNodePopup(nid, cx, cy) {
    const pop  = document.getElementById('member-popup');
    const body = document.getElementById('mpop-body');
    const ttl  = document.getElementById('mpop-title');
    if (!pop || !body) return;

    const nd = findNode(nid); if (!nd) return;
    const _activeRes = getActiveResults();
    const disp = _activeRes && _activeRes.disp ? _activeRes.disp[nid] : null;
    const react = _activeRes && _activeRes.reactions ? _activeRes.reactions[nid] : null;
    const US = window.UnitSystem;
    const fmtD = v => { const d = US ? US.toDisplay(v,'length') : v; return d.toFixed(4) + (US?US.label('length'):'m'); };
    const fmtF = v => { const d = US ? US.toDisplay(v,'force') : v; return d.toFixed(3) + (US?US.label('force'):'kN'); };
    const fmtM = v => { const d = US ? US.toDisplay(v,'moment') : v; return d.toFixed(3) + (US?US.label('moment'):'kNm'); };

    ttl.textContent = `Node ${nid}`;
    let html = `<div class="mpop-section">Geometry</div>
      <table>
        <tr><td>X</td><td>${nd.x.toFixed(3)} m</td></tr>
        <tr><td>Y</td><td>${nd.y.toFixed(3)} m</td></tr>
        <tr><td>Support</td><td>${nd.support || 'none'}</td></tr>
      </table>`;

    if (disp) {
      html += `<div class="mpop-section">Displacements</div>
        <table>
          <tr><td>δx</td><td>${fmtD(disp.u || 0)}</td></tr>
          <tr><td>δy</td><td>${fmtD(disp.v || 0)}</td></tr>
          <tr><td>θ</td><td>${(((disp.theta||0)*180/Math.PI)).toFixed(4)}°</td></tr>
        </table>`;
    }

    if (react && nd.support && nd.support !== 'none') {
      html += `<div class="mpop-section">Reactions</div>
        <table>
          <tr><td>Rx</td><td>${fmtF(react.Rx || react.Rz || 0)}</td></tr>
          <tr><td>Ry</td><td>${fmtF(react.Ry || react.Rz || 0)}</td></tr>
          <tr><td>M</td><td>${fmtM(react.M || react.Mz || 0)}</td></tr>
        </table>`;
    }

    body.innerHTML = html;
    pop.style.display = 'block';
    const rect = pop.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = cx + 12, y = cy - 10;
    if (x + rect.width  > vw - 10) x = cx - rect.width - 12;
    if (y + rect.height > vh - 10) y = vh - rect.height - 10;
    if (y < 5) y = 5;
    pop.style.left = x + 'px';
    pop.style.top  = y + 'px';
  }

  // Two nodes at the same point are never wanted — the app ships a Merge
  // Coincident Nodes tool precisely to clean them up — and they are invisible:
  // the marker looks like one node, but a member attaches to one of them and a
  // support lands on the other, so the member is unsupported and the model
  // fails at SOLVE as a singular matrix, a long way from the cause.
  //
  // The Beam tool could produce one on any click. It picks an existing node
  // with hitNode()'s 10 px radius but creates the new one at the GRID-SNAPPED
  // point, so wherever half the grid spacing exceeds 10 px on screen there is a
  // ring in which a click misses the node yet snaps onto its exact coordinates.
  // At the default 0.5 m grid that is any zoom above 40 px/m — most of them.
  const NODE_COINCIDENT_TOL = 1e-3;   // 1 mm: below any real dimension, above float noise

  function findNodeAt(x, y, z = 0, tol = NODE_COINCIDENT_TOL) {
    return nodes.find(n => Math.abs(n.x - x) <= tol &&
                           Math.abs(n.y - y) <= tol &&
                           Math.abs((n.z || 0) - (z || 0)) <= tol) || null;
  }

  /**
   * Add a node, or return the id of the one already at that point.
   *
   * Returning the existing id rather than refusing keeps every caller working:
   * the Beam tool joins to the node the user aimed at, a mirror about an axis
   * through existing nodes reuses them instead of doubling them up, and a
   * generator that recomputes a shared corner gets the corner it already made.
   */
  function addNode(x, y, z = 0) {
    const existing = findNodeAt(x, y, z);
    if (existing) return existing.id;
    const id = nextId.node++;
    nodes.push({ id, x, y, z: z || 0, support: 'none' });
    return id;
  }

  // ── Section id allocation ─────────────────────────────────────────
  // Sections arrive from three places — the built-in defaults, the standard
  // SectionDB, and saved projects — and nextId.section was seeded from
  // sections.length, which is not a safe next id once ids are non-contiguous.
  // Colliding ids made sections.find(s => s.id === bm.sectionId) resolve a
  // member to whichever duplicate came first, so a beam could silently be
  // analysed with another section's E/A/I. Always allocate above the current max.
  /**
   * A section to fall back on when the library has been emptied. A member
   * without one cannot be analysed at all, so it is better to hand back
   * something real and obviously editable than to leave the model unusable.
   */
  function defaultSection() {
    return { id: allocSectionId(), name: 'Conc 9"×9"',
             E: 25, A: 522.6, I: 22754, fy: 27.6, rho: 23.6 };
  }

  /**
   * The material library a new model starts with. Sections reference these by
   * `materialId`, and MAT_UI edits this array in place — there is no second
   * copy anywhere.
   *
   * E is GPa, weight kN/m³, fy/fu/fc MPa, alpha 1/°C.
   */
  function defaultMaterials() {
    return [
      { id:1, name:'C25 (4000Psi)', type:'Concrete', color:'#9e9e9e', sym:'Isotropic',
        weight:24.5, E:28.7, nu:0.2, alpha:9.9e-6, fy:null, fu:null, fc:25, notes:'' },
      { id:2, name:'C30 (5000Psi)', type:'Concrete', color:'#78909c', sym:'Isotropic',
        weight:24.5, E:30.5, nu:0.2, alpha:9.9e-6, fy:null, fu:null, fc:30, notes:'' },
      { id:3, name:'C35', type:'Concrete', color:'#607d8b', sym:'Isotropic',
        weight:24.5, E:33.5, nu:0.2, alpha:9.9e-6, fy:null, fu:null, fc:35, notes:'' },
      { id:4, name:'A36 Steel', type:'Steel', color:'#1565c0', sym:'Isotropic',
        weight:77.0, E:200, nu:0.3, alpha:1.17e-5, fy:250, fu:400, fc:null, notes:'' },
      { id:5, name:'A572 Gr50', type:'Steel', color:'#0d47a1', sym:'Isotropic',
        weight:77.0, E:200, nu:0.3, alpha:1.17e-5, fy:345, fu:450, fc:null, notes:'' },
      { id:6, name:'A992Fy50', type:'Steel', color:'#1a237e', sym:'Isotropic',
        weight:77.0, E:200, nu:0.3, alpha:1.17e-5, fy:345, fu:450, fc:null, notes:'' },
      { id:7, name:'A615Gr60', type:'Rebar', color:'#e53935', sym:'Uniaxial',
        weight:77.0, E:200, nu:null, alpha:1.17e-5, fy:420, fu:620, fc:null, notes:'' },
      { id:8, name:'A615Gr40', type:'Rebar', color:'#c62828', sym:'Uniaxial',
        weight:77.0, E:200, nu:null, alpha:1.17e-5, fy:280, fu:420, fc:null, notes:'' },
      { id:9, name:'A416Gr270', type:'Rebar', color:'#880e4f', sym:'Uniaxial',
        weight:77.0, E:196.5, nu:null, alpha:1.17e-5, fy:1860, fu:1860, fc:null, notes:'Prestressing strand' }
    ];
  }

  /** Materials are keyed by id; name is a label the user may change freely. */
  function findMaterial(id) {
    return materials.find(m => m.id === +id) || null;
  }

  function allocMaterialId() {
    const maxId = materials.reduce((m, x) => Math.max(m, +x.id || 0), 0);
    const id    = Math.max(maxId + 1, +nextId.material || 1);
    nextId.material = id + 1;
    return id;
  }

  function allocSectionId() {
    const maxId = sections.reduce((m, s) => Math.max(m, +s.id || 0), 0);
    const id    = Math.max(maxId + 1, +nextId.section || 1);
    nextId.section = id + 1;
    return id;
  }

  // ── Legacy inertia repair ─────────────────────────────────────────
  // The default sections written by generators.js carried a second moment
  // exactly one decade too small (mm⁴→cm⁴ is ÷1e4, not ÷1e5), so any model
  // saved before that fix is 10× too flexible and draws wrong in 3D.
  //
  // Deliberately narrow: it repairs ONLY sections still carrying the exact
  // fingerprint the buggy generator produced — name, area, modulus, density and
  // the wrong I all matching. A section the user has edited will not match and
  // is left untouched. Nothing is inferred from names alone, because some
  // correct sections are named in cm ("Concrete 30×60") and would be misread.
  const LEGACY_SECTIONS = [
    { name: 'Col 400×400',  A: 1600, E: 25, rho: 25, badI:  21333, goodI: 213333, d: 400, bf: 400 },
    { name: 'Beam 300×600', A: 1800, E: 25, rho: 25, badI:  54000, goodI: 540000, d: 600, bf: 300 }
  ];

  function repairLegacySectionInertia() {
    const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);
    const repaired = [];
    for (const s of sections) {
      const spec = LEGACY_SECTIONS.find(x => x.name === s.name);
      if (!spec) continue;
      const I = s.Ix != null ? s.Ix : s.I;
      if (!near(+s.A, spec.A) || !near(+s.E, spec.E) || !near(+s.rho, spec.rho)) continue;
      if (!near(+I, spec.badI)) continue;          // already correct, or edited
      s.I = spec.goodI;
      s.Ix = spec.goodI;
      if (s.d  == null) s.d  = spec.d;             // exact dims for the extruder
      if (s.bf == null) s.bf = spec.bf;
      repaired.push(s.name);
    }
    if (repaired.length) {
      console.warn(`[sections] corrected second moment on ${repaired.length} legacy section(s): ${repaired.join(', ')}`);
      toast(`Updated ${repaired.length} section(s) with a corrected second moment (I was 10× low) — re-solve for accurate results`, 'warn');
    }
    return repaired.length;
  }

  // Repair a section list that already contains duplicate ids (saved sessions
  // predate the allocator above). Members keep resolving to the first match,
  // which is what find() already returned, so this changes no analysis result —
  // it only makes subsequent id allocation unambiguous.
  function dedupeSectionIds() {
    const seen = new Set();
    let fixed = 0;
    for (const s of sections) {
      if (seen.has(s.id)) { s.id = allocSectionId(); fixed++; }
      seen.add(s.id);
    }
    if (fixed) console.warn(`[sections] reassigned ${fixed} duplicate section id(s)`);
    return fixed;
  }

  // Run after any path that replaces the sections array with saved data.
  function sanitizeLoadedSections() {
    repairLegacySectionInertia();
    dedupeSectionIds();
  }

  /**
   * Create a beam between two nodes and return its id.
   *
   * Returns the EXISTING beam's id when one already connects the pair, and
   * null for a degenerate self-loop. Callers used to read the new beam back as
   * `beams[beams.length - 1]` because nothing was returned — which silently
   * mutated an unrelated beam whenever this function short-circuited on a
   * duplicate, handing that beam the wrong section and hinge flags.
   */
  function addBeam(nid1, nid2) {
    if (nid1 === nid2 || nid1 == null || nid2 == null) return null;
    const existing = beams.find(b => (b.node1===nid1&&b.node2===nid2)||(b.node1===nid2&&b.node2===nid1));
    if (existing) return existing.id;
    const id = nextId.beam++;
    // A member with no section contributes no stiffness, so the solver drops it
    // and the model fails as a singular matrix. Rather than create something
    // unusable and complain later, give it a real section: reinstate the default
    // if the library has been emptied. The user can change it; they cannot
    // easily diagnose a member that was never analysable.
    if (sections.length === 0) {
      sections.push(defaultSection());
      updateSectionTable();
      toast('No sections were defined, so a default 9"×9" concrete section was ' +
            'created for this member. Change it in Define ▸ Sections.', 'warn');
    }
    const secId = sections[0].id;
    beams.push({ id, node1: nid1, node2: nid2, sectionId: secId, hingeStart: false, hingeEnd: false, memberType: 'auto' });
    return id;
  }

  /**
   * Returns the effective member type for display/design:
   *   'column' | 'beam' | 'brace'
   * If memberType is 'auto', classify by angle from horizontal.
   */
  function getMemberType(bm) {
    if (bm.memberType && bm.memberType !== 'auto') return bm.memberType;
    const ni = findNode(bm.node1), nj = findNode(bm.node2);
    if (!ni || !nj) return 'beam';
    const dx = Math.abs(nj.x - ni.x);
    const dy = Math.abs((nj.z !== undefined && nj.z !== ni.z)
      ? (nj.z - ni.z)     // 3D mode: use Z for height
      : (nj.y - ni.y));   // 2D mode
    const ang = Math.atan2(dy, dx) * 180 / Math.PI; // 0°=horiz, 90°=vert
    // Settings ▸ Modelling. Defaults are the 70/20 this used to hardcode.
    const colA  = cfg.colAngle  > 0 ? cfg.colAngle  : 70;
    const beamA = cfg.beamAngle > 0 ? cfg.beamAngle : 20;
    if (ang >= colA)  return 'column';
    if (ang <= beamA) return 'beam';
    return 'brace';
  }

  /**
   * Returns the display label for a member: C1, B2, BR3 etc.
   * Columns → C prefix; Beams → B prefix; Braces → BR prefix.
   */
  function getMemberLabel(bm) {
    if (bm.label) return bm.label;  // custom label
    const type = getMemberType(bm);
    if (type === 'column') return 'C' + bm.id;
    if (type === 'brace')  return 'BR' + bm.id;
    return 'B' + bm.id;
  }

  /**
   * Delete a node and everything that cannot survive without it.
   *
   * Returns what went with it — { members, loads, settlements } — so callers
   * can tell the user. Deleting a node silently took every attached member and
   * its loads, which is far more destructive than deleting a section (which
   * has always asked first and named the members using it).
   */
  function deleteNode(nid) {
    const goneMembers = beams.filter(b => b.node1 === nid || b.node2 === nid);
    const goneMemberIds = new Set(goneMembers.map(b => b.id));
    const goneLoads = loads.filter(l => l.nodeId === nid || goneMemberIds.has(l.elementId));
    const goneSettle = settlements.filter(s => s.nodeId === nid);

    nodes       = nodes.filter(n => n.id !== nid);
    beams       = beams.filter(b => b.node1 !== nid && b.node2 !== nid);
    // Member loads on a member that has just gone would otherwise be orphaned:
    // the load list kept them, pointing at an elementId nothing resolves to.
    loads       = loads.filter(l => l.nodeId !== nid && !goneMemberIds.has(l.elementId));
    settlements = settlements.filter(s => s.nodeId !== nid);
    if (selNode === nid) selNode = null;
    multiSel.nodes.delete(nid);
    goneMemberIds.forEach(id => multiSel.beams.delete(id));
    results = null;
    return { members: goneMembers, loads: goneLoads.length, settlements: goneSettle.length };
  }

  /**
   * Say what a node deletion took with it.
   *
   * No confirm on the delete-tool paths — that mode is for rapid editing and a
   * dialog per click would be worse than the problem it solves. But removing
   * members and their loads without a word is what made it surprising.
   */
  function reportNodeDeletion(nid, gone) {
    if (!gone || !gone.members.length) return;
    toast(`Deleted node ${nid} with ${gone.members.length} ` +
          `member${gone.members.length === 1 ? '' : 's'}` +
          (gone.loads ? ` and ${gone.loads} load${gone.loads === 1 ? '' : 's'}` : '') +
          '. Ctrl+Z to undo.', 'warn');
  }

  /** What deleting this node would take with it, without deleting anything. */
  function nodeDeletionImpact(nid) {
    const mem = beams.filter(b => b.node1 === nid || b.node2 === nid);
    const ids = new Set(mem.map(b => b.id));
    return { members: mem,
             loads: loads.filter(l => l.nodeId === nid || ids.has(l.elementId)).length };
  }

  function deleteBeam(bid) {
    beams  = beams.filter(b => b.id !== bid);
    loads  = loads.filter(l => l.elementId !== bid);
    if (selBeam === bid) selBeam = null;
    results = null;
  }

  function highlightNode(nid, on = true) {
    document.querySelectorAll('.sv-node').forEach(el => el.classList.remove('highlighted'));
    if (on && nid !== null) {
      const el = document.querySelector(`.sv-node[data-nid="${nid}"]`);
      if (el) el.classList.add('highlighted');
    }
  }

  // ── Tool activation ───────────────────────────────────────────────

  function setTool(t) {
    tool = t;
    beamStart = null;
    highlightNode(null);
    clearLayer(layerTemp());

    // Sync top toolbar buttons
    document.querySelectorAll('.tb-btn[data-tool]').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.tb-btn[data-tool="${t}"]`);
    if (btn) btn.classList.add('active');

    // Sync Draw pane tool palette buttons
    document.querySelectorAll('.draw-tool-btn[data-draw-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.drawTool === t);
    });

    const labels = {
      select:'Select', node:'Place Node', beam:'Draw Beam', support:'Set Support',
      hinge:'Toggle Hinge', load:'Add Load', section:'Add Section',
      settle:'Add Settlement', delete:'Delete Element'
    };
    document.getElementById('st-mode').textContent = 'Mode: ' + (labels[t] || t);
    document.getElementById('st-hint').textContent = hintFor(t);
    // Status bar mirrors the active tool. It used to update only on ribbon
    // clicks, so keyboard shortcuts left it showing a stale tool.
    const sbTool = document.getElementById('sb-tool');
    if (sbTool) sbTool.textContent = labels[t] || t;
  }

  function hintFor(t) {
    return {
      select:  'Click to select. Middle/Alt-drag to pan.',
      node:    'Click canvas to place a node.',
      beam:    'Click first node, then second node.',
      support: 'Click a node to set its support.',
      hinge:   'Click near a beam end to toggle hinge.',
      load:    'Click a node or beam to add a load.',
      section: 'Opens section dialog.',
      settle:  'Opens settlement dialog.',
      delete:  'Click a node or beam to delete it.'
    }[t] || '';
  }

  function setHint(msg) { document.getElementById('st-hint').textContent = msg; }

  // ── combineCaseResults — linear superposition ─────────────────────
  /**
   * Superpose case results into a combination.
   *
   * Rewritten to be dimension-agnostic. The previous version hardcoded the 2D
   * field set — disp {u,v,theta}, reactions {Rx,Ry,M}, forces {N,V,M} — so under
   * the 3D solver, which reports {u,v,w,θx,θy,θz} and {Rx,Ry,Rz,Mx,My,Mz}, the
   * entire vertical reaction (Rz) was dropped from every combination. It also
   * rebuilt element geometry as L = hypot(dx, dy), which is exactly zero for a
   * Z-up column, giving L = 0 and NaN direction cosines.
   *
   * Now: geometry is copied from the contributing case (already correct for
   * whichever solver produced it) and every numeric field is summed by factor.
   */
  /**
   * The load set a combination actually represents: every case's loads scaled
   * by that case's factor, gathered into one list.
   *
   * The linear path never needs this — it solves each case once and superposes
   * the RESULTS, which is exact for a linear system and much cheaper. A
   * second-order analysis cannot be superposed: P-delta is the interaction
   * between axial force and lateral drift, so gravity and wind have to be in
   * the structure at the same time for it to exist at all.
   *
   * Only the force-carrying fields scale. `pos` is a position along the
   * member, and the ids identify what the load acts on.
   */
  const LOAD_FORCE_KEYS = ['fx', 'fy', 'fz', 'fx2', 'fy2', 'm', 'mx', 'my', 'mz'];

  function factoredLoadsFor(combo) {
    const out = [];
    for (const { caseId, factor } of (combo.factors || [])) {
      if (!factor) continue;
      for (const l of loads) {
        if (caseIdOf(l) !== caseId) continue;
        const scaled = { ...l };
        for (const k of LOAD_FORCE_KEYS) {
          if (typeof scaled[k] === 'number') scaled[k] = scaled[k] * factor;
        }
        out.push(scaled);
      }
    }
    return out;
  }

  function combineCaseResults(combo) {
    const parts = (combo.factors || []).filter(f =>
      f && f.factor && allCaseResults[f.caseId] && allCaseResults[f.caseId].success);
    if (!parts.length) return null;

    // Geometry/identity travels with the element; everything else superposes.
    const GEOM = new Set(['id','L','x1','y1','z1','x2','y2','z2','c','s','λ','loads']);

    const addNumeric = (dst, src, f, skip) => {
      if (!src) return;
      for (const k in src) {
        if (skip && skip.has(k)) continue;
        const v = src[k];
        if (typeof v === 'number' && isFinite(v)) dst[k] = (dst[k] || 0) + f * v;
      }
    };

    const base = allCaseResults[parts[0].caseId];
    const combined = { success: true, disp: {}, reactions: {}, elemForces: [] };

    // Seed element entries from the base case so L, direction cosines and the
    // 3D transform λ are whatever that solver actually produced.
    for (const bef of base.elemForces) {
      const ef = {};
      for (const k of GEOM) if (bef[k] !== undefined) ef[k] = bef[k];
      ef.loads = [];             // combinations plot from superposed end values
      combined.elemForces.push(ef);
    }

    for (const { caseId, factor } of parts) {
      const cRes = allCaseResults[caseId];
      const f = factor;

      for (const nd of nodes) {
        if (!combined.disp[nd.id])      combined.disp[nd.id] = {};
        if (!combined.reactions[nd.id]) combined.reactions[nd.id] = {};
        addNumeric(combined.disp[nd.id],      cRes.disp      && cRes.disp[nd.id],      f);
        addNumeric(combined.reactions[nd.id], cRes.reactions && cRes.reactions[nd.id], f);
      }

      for (const cef of cRes.elemForces) {
        const ef = combined.elemForces.find(e => e.id === cef.id);
        if (!ef) continue;
        addNumeric(ef, cef, f, GEOM);
      }
    }

    return combined;
  }

  // ── Envelope across every load combination ────────────────────────
  //
  // Design is governed by the WORST case across all combinations, not by
  // whichever one happens to be on screen. With a generated ASCE 7 or EN 1990
  // set that is easily 10-20 combinations, and cycling the display selector
  // through each one by eye is not a workable way to design.
  //
  // For each member and each force component this keeps the value of largest
  // magnitude and records which combination produced it, so the diagrams and
  // tables show the governing case directly.
  //
  // IMPORTANT: an envelope is not a real equilibrium state — the worst N and
  // the worst M generally come from different combinations — so it is flagged
  // with isEnvelope and the report skips its equilibrium check. Member design
  // does NOT use this object for the same reason; runDesignChecks() evaluates
  // every combination properly and keeps the worst utilisation (see below).
  function buildEnvelope() {
    const sources = Object.keys(allComboResults).length
      ? loadCombos.filter(cb => allComboResults[cb.id])
                  .map(cb => ({ label: cb.name || ('Combo ' + cb.id), res: allComboResults[cb.id] }))
      : loadCases.filter(lc => allCaseResults[lc.id])
                 .map(lc => ({ label: lc.name || ('Case ' + lc.id), res: allCaseResults[lc.id] }));
    if (sources.length === 0) return null;

    const GEOM = new Set(['id','L','x1','y1','z1','x2','y2','z2','c','s','λ','loads']);
    const base = sources[0].res;
    if (!base || !base.elemForces) return null;

    const env = {
      success: true, isEnvelope: true,
      sourceCount: sources.length,
      sourceLabels: sources.map(s => s.label),
      disp: {}, reactions: {}, elemForces: [], governing: {}
    };

    // Keep whichever value is largest in magnitude, and remember its source.
    const worst = (dst, src, skip, govBag, key) => {
      if (!src) return;
      for (const k in src) {
        if (skip && skip.has(k)) continue;
        const v = src[k];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        if (dst[k] === undefined || Math.abs(v) > Math.abs(dst[k])) {
          dst[k] = v;
          if (govBag) (govBag[key] = govBag[key] || {})[k] = src.__label;
        }
      }
    };

    for (const bef of base.elemForces) {
      const ef = {};
      for (const k of GEOM) if (bef[k] !== undefined) ef[k] = bef[k];
      ef.loads = [];          // an envelope has no single load pattern to draw
      env.elemForces.push(ef);
    }

    for (const { label, res } of sources) {
      for (const nd of nodes) {
        env.disp[nd.id]      = env.disp[nd.id]      || {};
        env.reactions[nd.id] = env.reactions[nd.id] || {};
        const d = res.disp && res.disp[nd.id];
        const r = res.reactions && res.reactions[nd.id];
        if (d) worst(env.disp[nd.id],      Object.assign({ __label: label }, d), GEOM);
        if (r) worst(env.reactions[nd.id], Object.assign({ __label: label }, r), GEOM);
      }
      for (const cef of res.elemForces || []) {
        const ef = env.elemForces.find(e => e.id === cef.id);
        if (!ef) continue;
        worst(ef, Object.assign({ __label: label }, cef), GEOM, env.governing, cef.id);
      }
    }

    // __label leaks in through Object.assign; strip it from the outputs.
    const strip = o => { if (o && '__label' in o) delete o.__label; };
    env.elemForces.forEach(strip);
    Object.values(env.disp).forEach(strip);
    Object.values(env.reactions).forEach(strip);

    return env;
  }

  // ── populateDisplaySelector ───────────────────────────────────────
  function populateDisplaySelector() {
    const sel = document.getElementById('active-display-sel');
    const wrap = document.getElementById('display-selector');
    const hasCases  = Object.keys(allCaseResults).length  > 0;
    const hasCombos = Object.keys(allComboResults).length > 0;
    wrap.style.display = (hasCases || hasCombos) ? '' : 'none';
    sel.innerHTML = '';

    // Envelope first — it is the one design is actually governed by.
    if (envelopeResult) {
      const o = document.createElement('option');
      o.value = 'envelope:0';
      o.textContent = `[Envelope] worst of ${envelopeResult.sourceCount} ` +
                      (hasCombos ? 'combination' : 'case') +
                      (envelopeResult.sourceCount === 1 ? '' : 's');
      if (activeDisplay.type === 'envelope') o.selected = true;
      sel.appendChild(o);
    }

    for (const lc of loadCases) {
      if (!allCaseResults[lc.id]) continue;
      const o = document.createElement('option');
      o.value = `case:${lc.id}`;
      o.textContent = `[Case] ${lc.name}`;
      if (activeDisplay.type==='case' && activeDisplay.id===lc.id) o.selected = true;
      sel.appendChild(o);
    }
    for (const cb of loadCombos) {
      if (!allComboResults[cb.id]) continue;
      const o = document.createElement('option');
      o.value = `combo:${cb.id}`;
      o.textContent = `[Combo] ${cb.name}`;
      if (activeDisplay.type==='combo' && activeDisplay.id===cb.id) o.selected = true;
      sel.appendChild(o);
    }
  }

  // ── Area Load Expansion ───────────────────────────────────────────
  // Converts area_load entries (polygon of nodeIds + pressure p [kN/m²])
  // into equivalent nodal forces using tributary area (fan triangulation).
  function expandAreaLoads(caseLoads) {
    const regular  = caseLoads.filter(l => l.type !== 'area_load');
    const areaLds  = caseLoads.filter(l => l.type === 'area_load');
    if (!areaLds.length) return regular;

    const tribForce = {}; // nodeId → accumulated Fy [kN]
    for (const al of areaLds) {
      const ids = (al.nodeIds || []).filter(id => findNode(id));
      if (ids.length < 3) continue;
      const p = al.p || 0; // kN/m²
      // Fan-triangulate from first vertex
      for (let i = 1; i < ids.length - 1; i++) {
        const n0 = findNode(ids[0]), n1 = findNode(ids[i]), n2 = findNode(ids[i + 1]);
        // Triangle area in XZ plane (3D) or XY plane (2D)
        const ax = n1.x - n0.x, az = (n1.z || 0) - (n0.z || 0);
        const bx = n2.x - n0.x, bz = (n2.z || 0) - (n0.z || 0);
        const ay = n1.y - n0.y, by = n2.y - n0.y;
        const triArea = mode3D
          ? 0.5 * Math.abs(ax * bz - bx * az)   // XZ area for horizontal slab
          : 0.5 * Math.abs(ax * by - bx * ay);   // XY area for 2D frame
        const nodeForce = p * triArea / 3; // equal share to each vertex
        [ids[0], ids[i], ids[i + 1]].forEach(id => {
          tribForce[id] = (tribForce[id] || 0) + nodeForce;
        });
      }
    }
    // Append equivalent nodal loads (downward = -Fy)
    const extra = Object.entries(tribForce).map(([nid, F]) => ({
      id: -1, type: 'nodal', nodeId: +nid, fx: 0, fy: -F, m: 0,
      caseId: areaLds[0].caseId
    }));
    return [...regular, ...extra];
  }

  // ── Solve ─────────────────────────────────────────────────────────

  // ── Analysis dispatch ─────────────────────────────────────────────
  // `solve()` is the single entry point every caller uses (toolbar, auto-solve,
  // keyboard shortcut). It picks the analysis type rather than being reassigned
  // at runtime — the P-Δ path used to monkey-patch this function declaration
  // from inside init(), which meant the behaviour depended on load order.
  let pDeltaEnabled = false;

  function solve() {
    if (pDeltaEnabled && window.PDeltaAnalysis) return solvePDeltaAll();
    return solveLinear();
  }

  // ── Solver worker ─────────────────────────────────────────────────
  // The FEM runs in js/workers/solver.worker.js so large models do not freeze
  // the UI. _solveWorker is null before the first attempt and false once we
  // know a worker cannot be created (file:// origins block workers, for one) —
  // in that case every solve falls back to the main thread.
  let _solveWorker = null;
  let _solveSeq    = 0;   // results from a superseded solve are discarded

  function getSolveWorker() {
    if (_solveWorker !== null) return _solveWorker;
    try {
      _solveWorker = new Worker('js/workers/solver.worker.js');
      // A worker-level error means the scripts never loaded; stop using it.
      _solveWorker.addEventListener('error', e => {
        console.warn('[solve] worker error, reverting to main thread:', e.message);
        try { _solveWorker.terminate(); } catch (_) {}
        _solveWorker = false;
      });
    } catch (e) {
      console.warn('[solve] worker unavailable, using main thread:', e.message);
      _solveWorker = false;
    }
    return _solveWorker;
  }

  // One request/response round trip. Progress messages drive the top bar.
  //
  // The worker is a single shared instance re-used across calls, and its
  // replies carry no correlation id of their own, so if a second solve starts
  // before the first one's promise settles — a double-click, autoSolve firing
  // mid-solve, or a racing cache lookup — both calls' 'message' listeners are
  // live on the same worker at once. Every 'solve_all_result' message fires
  // BOTH listeners, so the newer call's promise could be resolved with the
  // OLDER call's results. Tagging each request with its own id and ignoring
  // any reply that doesn't carry it back is what keeps concurrent solves from
  // cross-talking.
  let _workerReqSeq = 0;
  function solveViaWorker(worker, model) {
    const reqId = ++_workerReqSeq;
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        fn(arg);
      };
      const onMsg = e => {
        const d = e.data;
        if (d.reqId !== reqId) return;      // reply to a different in-flight request
        if (d.type === 'progress')          { showSolveProgress(d.pct, d.label); return; }
        if (d.type === 'solve_all_result')  { done(resolve, d.results); return; }
        if (d.type === 'error')             { done(reject, new Error(d.error)); }
      };
      const onErr = e => done(reject, new Error(e.message || 'worker crashed'));
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ type: 'solve_all', model, reqId });
    });
  }

  function showSolveProgress(pct, label) {
    let bar = document.getElementById('worker-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'worker-progress';
      document.body.appendChild(bar);
    }
    bar.classList.add('active');
    bar.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
    if (label) bar.title = label;
  }

  function hideSolveProgress() {
    const bar = document.getElementById('worker-progress');
    if (bar) { bar.classList.remove('active'); bar.style.setProperty('--pct', '0%'); }
  }

  // Second-order (P-Δ) analysis across every load case.
  function solvePDeltaAll() {
    window.PerfMonitor?.start('pdelta');
    results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
    _resultsRev = _modelRev;      // these results describe the model as it is now
    let anyOk = false;
    const nonConverged = [];
    const caseErrors = [];
    for (const lc of loadCases) {
      const caseLoads = loads.filter(l => caseIdOf(l) === lc.id);
      const res = PDeltaAnalysis.runPDelta(nodes, beams, sections, caseLoads, settlements);
      if (res && res.success) {
        // Elastic critical load factors per member. criticalLoadFactors() has
        // been finished and exported in pdelta.js all along with nothing calling
        // it — a buckling check sitting on the shelf. P-Δ is exactly when it is
        // meaningful, because the axial forces it needs are the second-order ones.
        try {
          res.buckling = PDeltaAnalysis.criticalLoadFactors(res.elemForces, beams, sections);
        } catch (e) { res.buckling = null; }
        allCaseResults[lc.id] = res;
        anyOk = true;
        if (!res.converged) nonConverged.push(lc.name);
      } else if (res && res.error) {
        // e.g. the non-planar guard above — a real reason, not just "failed",
        // and worth more than the generic "check structure" toast below.
        caseErrors.push(`"${lc.name}": ${res.error}`);
      }
    }
    // Combinations are SOLVED, not superposed.
    //
    // This used to call combineCaseResults(), which adds up the per-case
    // results — and every case had been run through P-delta on its own. Dead
    // load alone has axial force but no sway to amplify; wind alone has sway
    // but almost no axial force. Neither case can show the effect, and adding
    // two first-order-looking answers together cannot produce it either. On a
    // two-storey frame, "second-order" 1.2D + 1.0W + L came out 1% SMALLER
    // than first-order — iteration noise, not amplification.
    //
    // Each combination now goes to the solver as one factored load set, with
    // gravity and lateral present together, which is the only arrangement in
    // which P-delta means anything.
    let comboFails = 0;
    for (const cb of loadCombos) {
      const cLoads = factoredLoadsFor(cb);
      if (!cLoads.length) continue;
      const res = PDeltaAnalysis.runPDelta(nodes, beams, sections, cLoads, settlements);
      if (res && res.success) {
        try {
          res.buckling = PDeltaAnalysis.criticalLoadFactors(res.elemForces, beams, sections);
        } catch (e) { res.buckling = null; }
        allComboResults[cb.id] = res;
        anyOk = true;
        if (!res.converged) nonConverged.push(cb.name);
      } else {
        // Falling back to superposition would report a first-order answer as
        // though it were second-order, so say so instead.
        comboFails++;
      }
    }
    envelopeResult = buildEnvelope();
    if (!anyOk) {
      window.PerfMonitor?.end('pdelta');
      toast(caseErrors.length ? 'P-Δ solve failed — ' + caseErrors[0] : 'P-Δ solve failed — check structure', 'error');
      return;
    }
    if (caseErrors.length) {
      toast(`${caseErrors.length} load case${caseErrors.length === 1 ? '' : 's'} could not run ` +
            'under P-Δ: ' + caseErrors.join('; '), 'warn');
    }
    if (comboFails) {
      toast(`${comboFails} combination${comboFails === 1 ? '' : 's'} did not converge under ` +
            'P-Δ and ha' + (comboFails === 1 ? 's' : 've') + ' no second-order result. ' +
            'The structure may be close to buckling.', 'warn');
    }
    if (nonConverged.length) {
      toast('P-Δ did not fully converge for: ' + nonConverged.join(', ') +
            '. Treat those results as indicative.', 'warn');
    }

    results = getActiveResults();
    if (!results) {
      const firstId = Object.keys(allCaseResults)[0];
      if (firstId) { activeDisplay = { type:'case', id:+firstId }; results = allCaseResults[+firstId]; }
    }
    render();
    showResultsPanel(results);
    populateDisplaySelector();
    const dsEl = document.getElementById('display-selector');
    if (dsEl) dsEl.style.display = '';
    window.PerfMonitor?.end('pdelta');
    toast('P-Δ solve complete', 'ok');
  }

  /**
   * True when the model can be analysed correctly by the 2D solver.
   *
   * Two conditions, both required.
   *
   * 1. Planar geometry — every node shares a common Y (the X-Z vertical plane,
   *    i.e. a Z-lifted frame) or a common Z (the classic X-Y plane).
   *
   * 2. No out-of-plane actions. Flat geometry alone is not enough: a floor
   *    grillage is also flat in Z, but it is loaded perpendicular to its plane
   *    and genuinely needs the 6-DOF solver. The 2D load UI only expresses
   *    in-plane fx/fy/m, so an out-of-plane action can only be present if
   *    something set fz, mx or my on a load, or gave a node a custom 3D DOF
   *    mask. Either is a positive signal that the model is 3D by intent.
   *
   * A single node, or an empty model, counts as planar.
   */
  function isPlanarModel() {
    if (nodes.length < 2) return true;
    const TOL = 1e-9;

    const y0 = nodes[0].y || 0, z0 = nodes[0].z || 0;
    let flatY = true, flatZ = true;
    for (const nd of nodes) {
      if (nd.fixedDOF) return false;              // custom 3D restraint mask
      if (Math.abs((nd.y || 0) - y0) > TOL) flatY = false;
      if (Math.abs((nd.z || 0) - z0) > TOL) flatZ = false;
      if (!flatY && !flatZ) return false;
    }

    // Out-of-plane loading — the grillage case.
    for (const ld of loads) {
      if (ld.fz != null || ld.mx != null || ld.my != null) return false;
    }
    return true;
  }

  /**
   * Net vertical force a load contributes, in the storage convention where
   * negative fy is downward (genSelfWeight writes -rho*A, the Fy field defaults
   * to -10, and Angle mode defaults to -90 deg).
   */
  function netVerticalOf(ld) {
    if (ld.type === 'nodal' || ld.type === 'beam_point') return ld.fy || 0;
    if (ld.type === 'beam_dist' || ld.type === 'beam_trap') {
      const bm = findBeam(ld.elementId); if (!bm) return 0;
      const L = memberLength(findNode(bm.node1), findNode(bm.node2));
      const a = ld.fy || 0;
      const b = ld.fy2 !== undefined ? ld.fy2 : a;
      return (a + b) / 2 * L;
    }
    return 0;
  }

  /**
   * Warn when a gravity load case pulls upward.
   *
   * Nothing stops you typing a positive Fy, and positive is UP — so a dead load
   * entered as +8.33 instead of -8.33 is uplift. The model still solves, every
   * equilibrium check still passes, and the only clue is the load arrow pointing
   * the wrong way. Dead, live and snow are downward by definition, so a net
   * upward total in one of those cases is a sign error worth stopping for. Wind
   * and seismic are left alone: uplift is a real load case for both.
   */
  function warnUpliftCases() {
    const GRAVITY = { DL: 'Dead', LL: 'Live', SL: 'Snow' };
    const bad = [];
    for (const lc of loadCases) {
      const kind = GRAVITY[lc.type];
      if (!kind) continue;
      const net = loads.filter(l => caseIdOf(l) === lc.id)
                       .reduce((s, l) => s + netVerticalOf(l), 0);
      if (net > 1e-6) bad.push(`${lc.name} (+${net.toFixed(2)} kN up)`);
    }
    if (!bad.length) return;
    toast(`${bad.length === 1 ? 'Load case' : 'Load cases'} acting UPWARD: ${bad.join(', ')}. ` +
          `Gravity is negative Fy — the Fy field defaults to -10 for that reason. ` +
          `Positive Fy is uplift. Solving anyway.`, 'warn');
  }

  function solveLinear() {
    if (nodes.length === 0) { toast('No nodes defined!', 'error'); return; }
    if (beams.length === 0) { toast('No beams defined!', 'error'); return; }
    // A node restrained only via a custom 3D fixedDOF mask (support left
    // unset/'none') is a real restraint — solver3d.js and modes.js both treat
    // it as one. Missing it here blocked a legitimately-restrained 3D model
    // from ever reaching the solver, with a message ("no supports") that was
    // simply wrong for that model.
    if (!nodes.some(n => (n.support && n.support !== 'none') || n.fixedDOF)) {
      toast('No supports defined.', 'error'); return;
    }
    warnUpliftCases();
    window.PerfMonitor?.start('solve');

    allCaseResults  = {};
    allComboResults = {};

    // ── Solver selection ─────────────────────────────────────────────────
    // Routed on the GEOMETRY of the model, not on mode3D. mode3D is a view
    // setting — it says how the canvas draws, not how many dimensions the
    // structure occupies — and the default template turns it on for a frame
    // that is entirely planar (every node at y = 0, elevation in z).
    //
    // Sending a planar frame to the 3D solver is not merely wasteful, it is
    // singular: the UI's supports are 2D concepts, so 'pin' restrains one node
    // out of plane and 'roller' restrains none, leaving the frame free to swing
    // about the vertical axis as a rigid body. The 3D solver used to skip the
    // resulting zero pivots and return whatever fell out — the default model
    // solved to displacements of ~1e14 m presented as success. With the pivot
    // check fixed it correctly reports a singular matrix, which makes the wrong
    // routing visible rather than silently wrong.
    //
    // The 2D solver handles both planar orientations: the X-Y plane directly,
    // and the X-Z ("Z-lifted") plane via its dy_eff fallback. It is also what
    // the BMD/SFD renderer and the deflection inspector expect, since they read
    // 2D elemForces (c, s, t1, t2).
    const planar = isPlanarModel();
    const use3D  = mode3D && !!window.solveFrame3D && !planar;

    // Load cases, with area loads already expanded to member loads.
    const cases = loadCases.map(lc => ({
      id:    lc.id,
      name:  lc.name,
      loads: expandAreaLoads(loads.filter(l => caseIdOf(l) === lc.id))
    }));

    // A load whose case cannot be resolved is now applied to the first case
    // rather than dropped, but that is a guess about the engineer's intent and
    // has to be visible.
    {
      const strayCase = loads.filter(l => !loadCases.some(c => c.id === l.caseId));
      if (strayCase.length && loadCases.length)
        toast(`${strayCase.length} load${strayCase.length === 1 ? ' is' : 's are'} not ` +
              `assigned to any load case, so ${strayCase.length === 1 ? 'it has' : 'they have'} ` +
              `been analysed under "${loadCases[0].name}". Set the case in the Loads ` +
              'table if that is not what you meant.', 'warn');
    }

    // Members whose section does not resolve — never assigned, or assigned to a
    // section since deleted. The solver reports this too, but naming them here
    // points at the row in the Members table the user has to change, which is
    // the actual next step.
    {
      const orphanSec = beams.filter(b => !sections.some(sc => sc.id === b.sectionId));
      if (orphanSec.length)
        toast(`${orphanSec.length} member${orphanSec.length === 1 ? '' : 's'} ` +
              `(${orphanSec.map(b => getMemberLabel(b)).join(', ')}) ` +
              `${orphanSec.length === 1 ? 'has' : 'have'} no valid section. ` +
              'Set one in the Members table — the row shows — none —.', 'warn');
    }

    // A load pointing at a member or node that no longer exists is skipped by
    // the solver without a word, so the run 'succeeds' with the load simply
    // absent — every reaction zero, and nothing on screen to say why. Say it.
    {
      const beamIds = new Set(beams.map(b => b.id));
      const nodeIds = new Set(nodes.map(n => n.id));
      let orphans = 0;
      for (const c of cases)
        for (const l of c.loads) {
          if (l.elementId != null && !beamIds.has(l.elementId)) orphans++;
          else if (l.nodeId != null && !nodeIds.has(l.nodeId))  orphans++;
        }
      if (orphans > 0)
        toast(`${orphans} load${orphans === 1 ? '' : 's'} point at a member or node that no ` +
              'longer exists and will be ignored.', 'warn');
    }

    // ── Results cache ────────────────────────────────────────────────────
    // StructDB has had a hash-keyed results store, and a fingerprint the test
    // suite already guards, with nothing ever calling it. Re-solving a model
    // nothing has changed is pure waste — most obviously when flipping between
    // load cases or reopening a project — so consult it before doing the work.
    //
    // The hash covers every solver input (geometry, sections, loads,
    // settlements, modifiers, springs, releases, DOF masks). Anything it misses
    // would serve a stale answer, which is why it is fingerprinted rather than
    // timestamped, and why its sensitivity is a test in its own right.
    const cacheKey = (window.StructDB && cfg.cacheResults !== false)
      ? StructDB.modelHash(nodes, beams, sections, loads, settlements) + (use3D ? '|3d' : '|2d')
      : null;
    if (cacheKey) {
      StructDB.getCachedResults(cacheKey).then(hit => {
        if (hit && hit.byCase && Object.keys(hit.byCase).length) {
          allCaseResults = hit.byCase;
          toast('Results loaded from cache (model unchanged)', 'ok');
          finishSolve(hit.errors || []);
        } else {
          runSolve();
        }
      }).catch(() => runSolve());   // IndexedDB unavailable — just solve
    } else {
      runSolve();
    }

    // Store a freshly computed set under the current fingerprint.
    //
    // cacheResults returns a promise, so a rejected write — most likely the
    // IndexedDB quota once a few large models have accumulated — would escape a
    // synchronous try/catch and surface as an unhandled rejection. Catch it on
    // the promise and drop the whole cache when it happens: the cache is an
    // optimisation, and a full store that can never be written to again is worse
    // than an empty one.
    function cacheIfPossible(errors) {
      if (!cacheKey) return;
      let p;
      try { p = StructDB.cacheResults(cacheKey, { byCase: allCaseResults, errors }); }
      catch (e) { return; }
      if (p && typeof p.catch === 'function') {
        p.catch(() => { try { StructDB.clearResultsCache(); } catch (e) { /* give up quietly */ } });
      }
    }

    function runSolve() {

      // Off-thread when a worker is available; otherwise solve inline. Both
      // paths converge on finishSolve() so the UI behaves identically.
      const worker = getSolveWorker();
      if (worker) {
        const seq = ++_solveSeq;
        showSolveProgress(3, 'Solving…');
        solveViaWorker(worker, { nodes, beams, sections, settlements, cases, use3D })
          .then(({ byCase, errors }) => {
            if (seq !== _solveSeq) return;        // superseded by a newer solve
            allCaseResults = byCase;
            cacheIfPossible(errors);
            finishSolve(errors);
          })
          .catch(err => {
            if (seq !== _solveSeq) return;
            console.warn('[solve] worker failed, falling back to main thread:', err.message);
            finishSolve(solveCasesInline(cases, use3D));
          })
          .finally(() => { if (seq === _solveSeq) hideSolveProgress(); });
        return;
      }

        const errs = solveCasesInline(cases, use3D);
        cacheIfPossible(errs);
        finishSolve(errs);
    }
  }

  // Solve every case on the main thread. Returns the list of error messages.
  function solveCasesInline(cases, use3D) {
    const errMsgs = [];
    for (const c of cases) {
      const res = (use3D && window.solveFrame3D)
        ? solveFrame3D(nodes, beams, sections, c.loads, settlements)
        : solveFrame(nodes, beams, sections, c.loads, settlements);
      if (res.success) allCaseResults[c.id] = res;
      else errMsgs.push(`"${c.name}": ${res.error}`);
    }
    return errMsgs;
  }

  // Everything after the cases are solved: combine, pick the active display,
  // then refresh the canvas and panels.
  function finishSolve(errMsgs) {
    errMsgs = errMsgs || [];
    window.PerfMonitor?.end('solve');

    // ── Combine ───────────────────────────────────────────────────
    for (const cb of loadCombos) {
      const combined = combineCaseResults(cb);
      if (combined) allComboResults[cb.id] = combined;
    }

    if (Object.keys(allCaseResults).length === 0) {
      // Nothing solved. solveLinear() empties allCaseResults before it starts,
      // but `results`, the envelope and the drawn diagrams still hold the
      // PREVIOUS solve — of a different model. Returning here without clearing
      // them left those numbers on screen and in SA.results, reported as the
      // current answer: change a pin to a roller, watch the solve fail, and the
      // old reactions stay up as though nothing had happened. Stale results
      // presented as current are worse than no results at all.
      results = null;
      envelopeResult = null;
      designResults = null;
      document.querySelectorAll('.sv-mode-shape').forEach(el => el.remove());
      populateDisplaySelector();
      render();
      updateBeamTable(); updateNodeTable();
      toast('Solver error: ' + errMsgs[0], 'error');
      return;
    }

    // Stamp the results with the model they came from. This has to happen
    // before anything reads them back, or the gate rejects its own output.
    _resultsRev = _modelRev;

    // Worst-of-all-combinations, for display and diagrams.
    envelopeResult = buildEnvelope();

    // Keep active display if still valid, else default to first case
    const adOk = (activeDisplay.type==='case'  && allCaseResults[activeDisplay.id]) ||
                 (activeDisplay.type==='combo' && allComboResults[activeDisplay.id]);
    if (!adOk) {
      const firstOk = loadCases.find(lc => allCaseResults[lc.id]);
      if (firstOk) activeDisplay = { type:'case', id: firstOk.id };
    }

    results = getActiveResults();
    populateDisplaySelector();

    // ── Auto-enable BMD + Values on every successful solve ───────────
    views.bmd  = true;
    views.vals = true;
    // Sync ribbon buttons (active highlight) and settings checkboxes
    const bmdBtn = document.getElementById('disp-bmd');
    const valBtn = document.getElementById('disp-vals');
    if (bmdBtn) bmdBtn.classList.add('active');
    if (valBtn) valBtn.classList.add('active');
    const ckBmd = document.getElementById('view-bmd');
    const ckVal = document.getElementById('view-vals');
    if (ckBmd) ckBmd.checked = true;
    if (ckVal) ckVal.checked = true;

    // Turn the extruded view off, because it hides the very thing SOLVE was
    // pressed to see: load arrows and member force labels sit on the member
    // centreline, inside the solids, so they are suppressed while extrusion is
    // on. Only in 3D — in 2D the setting draws nothing, so leaving the user's
    // preference alone costs them nothing.
    if (mode3D && views.extrude) {
      views.extrude = false;
      ['disp-extrude', 'btn-extrude'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.classList.remove('active');
      });
      const ckExt = document.getElementById('view-extrude');
      if (ckExt) ckExt.checked = false;
      document.getElementById('extrude-hint')?.remove();
      toast('Extrude turned off so the loads and force labels are visible.', 'info');
    }

    render();
    showResultsPanel(results);

    // Switch to Display tab so user sees force diagrams immediately
    const dispTabBtn = document.querySelector('.rib-tab[data-rib="display"]');
    if (dispTabBtn) dispTabBtn.click();
    // Also switch right panel to Results
    switchPane('results');

    if (errMsgs.length) toast(`${errMsgs.length} case(s) failed`, 'error');
    else toast(`Solved ${loadCases.length} case(s)${loadCombos.length ? ' + '+loadCombos.length+' combo(s)' : ''} — BMD shown`, 'success');

    updateQuickSummary(results);
  }

  // ── checkMemberCapacity (simplified EC3 interaction) ─────────────
  function checkMemberCapacity(res) {
    if (!res || !res.success) return [];
    const out = [];
    for (const ef of res.elemForces) {
      const bm  = findBeam(ef.id); if (!bm) continue;
      const sec = sections.find(s => s.id === bm.sectionId); if (!sec) continue;
      const A_m2   = sec.A / 1e4;           // cm² → m²
      const I_m4   = sec.I / 1e8;           // cm⁴ → m⁴
      const fy_kNm2 = sec.fy * 1000;        // MPa → kN/m²
      const E_kNm2  = sec.E  * 1e6;         // GPa → kN/m²
      const Npl  = fy_kNm2 * A_m2;                   // kN
      const h    = 2 * Math.sqrt(I_m4 / A_m2);       // rough depth
      const Wely = h > 0 ? I_m4 / (h / 2) : 1e-9;   // m³
      const Mpl  = fy_kNm2 * Wely;                   // kNm
      const Ncr  = Math.PI**2 * E_kNm2 * I_m4 / (ef.L**2); // kN buckling
      // Span values, not end values. Taking max(|M1|, |M2|) made this column
      // read η = 0.000 ✓ OK for every simply supported beam, whose end moments
      // are zero by definition however heavily it is loaded — the same defect
      // the EC3 module had.
      const sm = spanMaxima(res).find(x => x.id === ef.id);
      const N_max = Math.max(Math.abs(ef.N1), Math.abs(ef.N2));
      const M_max = sm ? sm.Mmax : Math.max(Math.abs(ef.M1), Math.abs(ef.M2));
      const V_max = sm ? sm.Vmax : Math.max(Math.abs(ef.V1), Math.abs(ef.V2));
      const util  = (Npl > 0 ? N_max / Npl : 0) + (Mpl > 0 ? M_max / Mpl : 0);
      out.push({ id:ef.id, N_max, M_max, V_max, Npl, Mpl, Ncr, util });
    }
    return out;
  }

  /**
   * Peak |M|, |V| and δ anywhere along each member, with the station each
   * occurs at. Memoised onto the result set, so the results panel and the
   * Quick Summary read the same numbers and neither re-samples.
   *
   * Every table in the app reported values at NODES and member ENDS. For a
   * simply supported beam both end moments are zero by definition and both node
   * deflections are zero because the nodes ARE the supports, so moment and
   * deflection showed as columns of zeros and only shear looked alive. The
   * governing values — wL²/8 and 5wL⁴/384EI, both at mid-span — were never on
   * screen anywhere except the diagram.
   *
   * Sampled with the same DesignChecks functions the diagrams and the EC3
   * checks use, so all three agree by construction.
   */
  function spanMaxima(res) {
    if (!res || !res.success) return [];
    if (res._spanMax) return res._spanMax;
    const DC = window.DesignChecks;

    // Physical spans, so a beam split across several elements reports the sag
    // of the whole member rather than of each piece against its own chord.
    const spans = {};
    if (DC && DC.buildSpans) {
      try {
        const EIof = id => {
          const b = beams.find(x => x.id === id);
          const sc = b && sections.find(x => x.id === b.sectionId);
          return sc ? (sc.E || 0) * 1e6 * (((sc.Ix || sc.I) || 0) / 1e8) : 0;
        };
        for (const sp of DC.buildSpans(beams, res.elemForces, res.reactions, nodes)) {
          const d = DC.spanDeflection(sp, res.elemForces, EIof, 61);
          d.members = sp.elems.slice();
          sp.elems.forEach(id => { spans[id] = d; });
        }
      } catch (e) { /* leave deflection blank rather than report the wrong one */ }
    }

    const out = (res.elemForces || []).map(ef => {
      const bm  = beams.find(b => b.id === ef.id) || { id: ef.id };
      let Mmax = Math.max(Math.abs(ef.M1 || 0), Math.abs(ef.M2 || 0)), Mx = 0;
      let Vmax = Math.max(Math.abs(ef.V1 || 0), Math.abs(ef.V2 || 0)), Vx = 0;
      if (DC && DC.internalForceAt) {
        const N = 40;
        for (let i = 0; i <= N; i++) {
          const x = (i / N) * ef.L;
          const M = Math.abs(DC.internalForceAt(ef, 'BMD', x));
          const V = Math.abs(DC.internalForceAt(ef, 'SFD', x));
          if (M > Mmax) { Mmax = M; Mx = x; }
          if (V > Vmax) { Vmax = V; Vx = x; }
        }
      }
      // Deflection is reported for the whole PHYSICAL span this element belongs
      // to, measured from that span's chord — the same quantity the design
      // check uses. Per-element absolute deflection counted the rigid-body
      // movement of the ends, and per-element chord-relative lost the sag of a
      // span that had been split.
      const sp = spans[ef.id];
      let dMax = sp ? Math.abs(sp.v) : null, dx = sp ? sp.x : null;
      return { id: ef.id, bm, Mmax, Mx, Vmax, Vx, dMax, dx, spanMembers: sp && sp.members };
    });
    try { Object.defineProperty(res, '_spanMax', { value: out, enumerable: false }); }
    catch (_) { res._spanMax = out; }
    return out;
  }

  function showResultsPanel(res) {
    const area = document.getElementById('results-area');
    if (!res || !res.success) {
      area.innerHTML = '<p class="no-results">Run Solve to see results.</p>'; return;
    }

    const caseName = activeDisplay.type === 'case'
      ? (loadCases.find(c => c.id === activeDisplay.id) || {}).name || '?'
      : (loadCombos.find(c => c.id === activeDisplay.id) || {}).name || '?';

    // Unit helpers — convert every value individually (most reliable approach)
    const US   = window.UnitSystem;
    const fF   = v => US ? US.toDisplay(v, 'force')        : v;
    const fM_  = v => US ? US.toDisplay(v, 'moment')       : v;
    const fD_  = v => US ? US.toDisplay(v, 'displacement') : v * 1000;
    const fLbl = US ? US.label('force')   : 'kN';
    const mLbl = US ? US.label('moment')  : 'kNm';
    const dLbl = US ? (US.current().toDisp.dispUnit || 'mm') : 'mm';
    const fDec = US ? (US.current().decimals.force  || 3) : 3;
    const mDec = US ? (US.current().decimals.moment || 3) : 3;

    let html = `<div style="padding:5px 10px;background:var(--bg-pane);border-bottom:1px solid var(--border-tbl);font-size:11px;font-weight:600;color:var(--text-sec)">Showing: ${escapeIssue(caseName)} (${escapeIssue(activeDisplay.type)})</div>`;

    // ── Reactions ──────────────────────────────────────────────────────
    if (res.is3D) {
      html += `<div class="res-section"><h4>Reactions 3D [${fLbl}, ${mLbl}]</h4>
        <table class="res-tbl"><thead><tr><th>Node</th><th title="Support force along X">Force X</th><th title="Support force along Y">Force Y</th><th title="Support force along Z — vertical in 3D">Force Z</th><th title="Support moment about X">Moment X</th><th title="Support moment about Y">Moment Y</th><th title="Support moment about Z">Moment Z</th></tr></thead><tbody>`;
      for (const nd of nodes) {
        if (!nd.support || nd.support === 'none') continue;
        const r = res.reactions && res.reactions[nd.id]; if (!r) continue;
        html += `<tr><td>N${nd.id}</td>
          <td>${fF(r.Rx||0).toFixed(fDec)}</td><td>${fF(r.Ry||0).toFixed(fDec)}</td><td>${fF(r.Rz||0).toFixed(fDec)}</td>
          <td>${fM_(r.Mx||0).toFixed(mDec)}</td><td>${fM_(r.My||0).toFixed(mDec)}</td><td>${fM_(r.Mz||0).toFixed(mDec)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    } else {
      html += `<div class="res-section"><h4>Reactions [${fLbl}, ${mLbl}]</h4>
        <table class="res-tbl"><thead><tr><th>Node</th><th title="Horizontal support force (Rx)">Horizontal</th><th title="Vertical support force (Ry) — positive is upward">Vertical</th><th title="Support moment (M) — non-zero only at a fixed support">Moment</th></tr></thead><tbody>`;
      for (const nd of nodes) {
        if (!nd.support || nd.support === 'none') continue;
        const r = res.reactions && res.reactions[nd.id]; if (!r) continue;
        html += `<tr><td>N${nd.id}</td><td>${fF(r.Rx).toFixed(fDec)}</td><td>${fF(r.Ry).toFixed(fDec)}</td><td>${fM_(r.M).toFixed(mDec)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    // ── Displacements ──────────────────────────────────────────────────
    if (res.is3D) {
      html += `<div class="res-section"><h4>Displacements 3D [${dLbl}, mrad]</h4>
        <table class="res-tbl"><thead><tr><th>Node</th><th title="Movement along X (u)">Move X</th><th title="Movement along Y (v)">Move Y</th><th title="Movement along Z (w) — vertical in 3D">Move Z</th><th title="Rotation about X (θx)">Rot X</th><th title="Rotation about Y (θy)">Rot Y</th><th title="Rotation about Z (θz)">Rot Z</th></tr></thead><tbody>`;
      for (const nd of nodes) {
        const d = res.disp && res.disp[nd.id]; if (!d) continue;
        html += `<tr><td>N${nd.id}</td>
          <td>${fD_(d.u).toFixed(2)}</td><td>${fD_(d.v).toFixed(2)}</td><td>${fD_(d.w||0).toFixed(2)}</td>
          <td>${((d.θx||0)*1000).toFixed(3)}</td><td>${((d.θy||0)*1000).toFixed(3)}</td><td>${((d.θz||d.theta||0)*1000).toFixed(3)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    } else {
      html += `<div class="res-section"><h4>Displacements [${dLbl}, mrad]</h4>
        <table class="res-tbl"><thead><tr><th>Node</th><th title="Sideways movement (u), mm">Horizontal</th><th title="Up/down movement (v), mm — negative is downward">Vertical</th><th title="Rotation of the joint (θ), milliradians">Rotation</th></tr></thead><tbody>`;
      for (const nd of nodes) {
        const d = res.disp && res.disp[nd.id]; if (!d) continue;
        html += `<tr><td>N${nd.id}</td><td>${fD_(d.u).toFixed(2)}</td><td>${fD_(d.v).toFixed(2)}</td><td>${(d.theta*1000).toFixed(3)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    // Axial force reads compression orange / tension green, and says which it
    // is on hover.
    //
    // This solver is COMPRESSION-POSITIVE — a 300 kN load pushing down on a
    // column returns N = +300, which tests/regression.js asserts directly and
    // pdelta.js and the design modules all rely on. The panel had it the other
    // way round, colouring every gravity-loaded column green and captioning it
    // "N>0 = tension", so a frame whose columns are all in compression was
    // displayed as a frame entirely in tension.
    const axialCell = N => {
      const v = fF(N);
      const style = v > 0.001 ? 'color:#e65100' : v < -0.001 ? 'color:#2e7d32' : '';
      const tip   = v > 0.001 ? ' title="Compression"' : v < -0.001 ? ' title="Tension"' : '';
      return `<td style="${style}"${tip}>${v.toFixed(fDec)}</td>`;
    };

    // ── Element Forces ─────────────────────────────────────────────────
    if (res.is3D) {
      html += `<div class="res-section"><h4>Member end forces 3D [${fLbl}, ${mLbl}] — local axes</h4>
        <div style="font-size:10px;color:var(--text-sec);margin-bottom:5px;padding:3px 6px;background:var(--bg2);border-radius:3px">
          Axial: <strong>positive = compression</strong> (orange), <strong>negative = tension</strong> (green).
          Moments are internal values, the same sign as the bending diagrams.
        </div>
        <table class="res-tbl res-split"><thead><tr><th>Member</th><th>End</th><th title="Axial force along the member — positive is compression, negative is tension">Axial</th><th title="Shear across the member, local y direction">Shear y</th><th title="Shear across the member, local z direction">Shear z</th><th title="Twisting moment about the member axis">Torsion</th><th title="Bending moment about the local y axis">Moment y</th><th title="Bending moment about the local z axis — the main bending for a beam">Moment z</th></tr></thead><tbody>`;
      let i2 = 0;
      for (const ef of (res.elemForces || [])) {
        const bmEf = beams.find(b=>b.id===ef.id)||{id:ef.id};
        // One row per end. Six numeric columns for both ends at once needed far
        // more width than the panel has, and the end node was short two of
        // them — Vz2 and My2 were computed but never shown.
        const alt = (i2 % 2) ? ' res-alt' : '';
        const cell = (v, dec) => `<td>${v.toFixed(dec)}</td>`;
        // Moments are END ACTIONS here, exactly as in 2D — solver3d unpacks
        // them with the same structure (end 1 raw, end 2 negated) and even
        // aliases Mz1/Mz2 as the "legacy 2D names" M1/M2. So they carry the
        // opposite sign to the internal moment and are negated for display,
        // keeping this table consistent with the 2D one and with the diagrams.
        // Shear and axial need no flip: 2D shear already agreed with the shear
        // diagram end for end.
        const mom = m => fM_(-(m || 0));
        html += `<tr class="res-m1${alt}"><td rowspan="2" class="res-mlbl">${getMemberLabel(bmEf)}</td>
          <td class="res-end">Start</td>
          ${axialCell(ef.N1)}${cell(fF(ef.Vy1), fDec)}${cell(fF(ef.Vz1), fDec)}
          ${cell(mom(ef.Tx1), mDec)}${cell(mom(ef.My1), mDec)}${cell(mom(ef.Mz1), mDec)}</tr>
          <tr class="res-m2${alt}"><td class="res-end">End</td>
          ${axialCell(ef.N2)}${cell(fF(ef.Vy2), fDec)}${cell(fF(ef.Vz2 || 0), fDec)}
          ${cell(mom(ef.Tx2), mDec)}${cell(mom(ef.My2), mDec)}${cell(mom(ef.Mz2), mDec)}</tr>`;
        i2++;
      }
      html += '</tbody></table></div>';
    } else {
      html += `<div class="res-section"><h4>Member end forces [${fLbl}, ${mLbl}]</h4>
        <div style="font-size:10px;color:var(--text-sec);margin-bottom:5px;padding:3px 6px;background:var(--bg2);border-radius:3px">
          Axial: <strong>positive = compression</strong> (orange), <strong>negative = tension</strong> (green).
          Moment: <strong>positive = sagging</strong>, negative = hogging — the same sign as the bending diagram.
        </div>
        <table class="res-tbl res-split"><thead><tr><th>Member</th><th>End</th><th title="Axial force along the member — positive is compression, negative is tension">Axial</th><th title="Shear force across the member">Shear</th><th title="Internal bending moment at this end — positive is sagging, negative is hogging, matching the bending diagram. Zero at a pinned end, so both ends of a simply supported beam read zero; see the largest values below.">Moment</th></tr></thead><tbody>`;
      // One row per end rather than six numeric columns side by side: the
      // six-column form needed 366 px inside a 283 px panel, so reading a
      // single member meant scrolling sideways and losing its label.
      let i1 = 0;
      for (const ef of (res.elemForces || [])) {
        const bmEf = beams.find(b=>b.id===ef.id)||{id:ef.id};
        const alt  = (i1 % 2) ? ' res-alt' : '';
        // Shear and moment come from the same function that draws the diagram
        // and fills Span Maxima, evaluated at x = 0 and x = L.
        //
        // ef.M1/ef.M2 are END ACTIONS, whose sign is the NEGATIVE of the
        // internal bending moment — printing them raw made this table disagree
        // with the diagram beside it about the same beam. A fixed-fixed span
        // under UDL read +30 at the support and −15 at mid-span (implying it
        // sags over the support and hogs in the middle) while the diagram
        // correctly showed −30 and +15. Deriving both ends here means the two
        // cannot drift apart again.
        const V_1 = DesignChecks.internalForceAt(ef, 'SFD', 0);
        const V_2 = DesignChecks.internalForceAt(ef, 'SFD', ef.L);
        const M_1 = DesignChecks.internalForceAt(ef, 'BMD', 0);
        const M_2 = DesignChecks.internalForceAt(ef, 'BMD', ef.L);
        html += `<tr class="res-m1${alt}"><td rowspan="2" class="res-mlbl">${getMemberLabel(bmEf)}</td>
          <td class="res-end">Start</td>
          ${axialCell(ef.N1)}
          <td>${fF(V_1).toFixed(fDec)}</td>
          <td>${fM_(M_1).toFixed(mDec)}</td></tr>
          <tr class="res-m2${alt}"><td class="res-end">End</td>
          ${axialCell(ef.N2)}
          <td>${fF(V_2).toFixed(fDec)}</td>
          <td>${fM_(M_2).toFixed(mDec)}</td></tr>`;
        i1++;
      }
      html += '</tbody></table></div>';
    }

    // ── Span maxima ────────────────────────────────────────────────────
    //
    // The three tables above report values at NODES and at member ENDS. For a
    // simply supported beam both end moments are zero by definition and both
    // node deflections are zero because the nodes are the supports — so the
    // panel showed a column of zeros for moment and deflection and real numbers
    // only for shear, and looked like it was reporting shear alone. The values
    // that matter are between the ends: wL²/8 at mid-span, 5wL⁴/384EI at
    // mid-span, neither of which is ever a node.
    //
    // Sampled by the same functions the diagrams and the design checks use, so
    // all three agree.
    if (!res.is3D && (res.elemForces || []).length) {
      html += `<div class="res-section"><h4>Largest values along each member</h4>
        <div style="font-size:10px;color:var(--text-sec);margin-bottom:5px;padding:3px 6px;background:var(--bg2);border-radius:3px">
          Peak value anywhere along each member, with the distance from its first node.
          The tables above are end and node values, which are zero at both ends of a simply supported span.
        </div>
        <table class="res-tbl"><thead><tr>
          <th>Member</th>
          <th title="Biggest bending moment anywhere along this member, and how far along it occurs">Largest bending moment [${mLbl}]</th>
          <th title="Biggest shear force anywhere along this member, and how far along it occurs">Largest shear force [${fLbl}]</th>
          <th title="Biggest sag or deflection anywhere along this member, and how far along it occurs">Largest deflection [${dLbl}]</th>
        </tr></thead><tbody>`;
      for (const sm of spanMaxima(res)) {
        const dTxt  = sm.dMax != null ? fD_(sm.dMax).toFixed(2) : '—';
        const dxTxt = sm.dx   != null ? sm.dx.toFixed(2)        : '—';
        // Value and its location in one cell: seven columns did not fit the
        // panel and forced horizontal scrolling to read a single row.
        const at = x => `<span class="res-at">at ${x} m</span>`;
        html += `<tr><td>${getMemberLabel(sm.bm)}</td>
          <td><strong>${fM_(sm.Mmax).toFixed(mDec)}</strong> ${at(sm.Mx.toFixed(2))}</td>
          <td><strong>${fF(sm.Vmax).toFixed(fDec)}</strong> ${at(sm.Vx.toFixed(2))}</td>
          <td><strong>${dTxt}</strong> ${dxTxt === '—' ? '' : at(dxTxt)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    // Design checks
    const dc = checkMemberCapacity(res);
    if (dc.length > 0) {
      html += '<div class="res-section"><h4>Design check — quick screening (EC3 simplified)</h4><table class="res-tbl"><thead><tr><th>Member</th><th title="How much of the member&#39;s capacity is used by axial force plus bending, as a fraction. Below 1.00 means it has capacity to spare; above 1.00 means it is overloaded.">Capacity used</th><th title="Euler buckling load (Ncr) — the axial compression at which this member would buckle, in kN">Buckling load</th><th>Status</th></tr></thead><tbody>';
      for (const d of dc) {
        const pct  = Math.min(d.util * 100, 100).toFixed(0);
        const col  = d.util <= 0.8 ? '#4caf50' : d.util <= 1.0 ? '#ff9800' : '#f44336';
        const rowCls = d.util <= 0.8 ? 'design-ok' : d.util <= 1.0 ? 'design-warn' : 'design-fail';
        const bar  = `<div class="util-bar-wrap"><div style="height:100%;width:${pct}%;background:${col}"></div></div>`;
        const sta  = d.util <= 0.8 ? '✓ OK' : d.util <= 1.0 ? '⚠ Near' : '✗ FAIL';
        html += `<tr class="${rowCls}"><td>B${d.id}</td><td>${d.util.toFixed(3)} ${bar}</td><td>${d.Ncr.toFixed(1)}</td><td>${sta}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    area.innerHTML = html;
  }

  // ── Table updates ─────────────────────────────────────────────────

  function updateNodeTable() {
    const tbody = document.querySelector('#tbl-nodes tbody');
    tbody.innerHTML = '';
    // Update header for 3D mode
    const thead = document.querySelector('#tbl-nodes thead tr');
    if (thead) {
      const hasZth = thead.querySelector('th.th-z');
      if (mode3D && !hasZth) {
        // In 3D Z-up: Y column = horizontal depth, Z column = elevation
        // Retitle Y column from "Y [m]" to "Y [m] (depth)" and add Z column
        const yth = thead.querySelector('th.th-y');
        if (yth) { yth.title = 'Horizontal depth (plan Y)'; }
        const zth = document.createElement('th');
        zth.className = 'th-z';
        zth.textContent = 'Z [m]';   // label refreshed per active unit below
        zth.title = 'Elevation / height (vertical, Z-up)';
        thead.insertBefore(zth, thead.children[3]);
      } else if (!mode3D && hasZth) {
        hasZth.remove();
        const yth = thead.querySelector('th.th-y');
        if (yth) { yth.title = ''; }
      }
    }
    // Unit helpers
    const US = window.UnitSystem;
    const lenDec  = US ? (US.current().decimals.length || 3) : 3;
    const lenStep = US ? (US.toDisplay(0.25, 'length')).toFixed(lenDec > 2 ? 3 : 2) : '0.25';
    // In 2D mode: liftToZ structures store height in nd.z with nd.y===0
    // Show Z as the height column and route edits to nd.z in that case
    const isZLifted2D = !mode3D && nodes.some(n => (n.z||0) !== 0) && nodes.every(n => !n.y);
    const lenU = US ? (US.current().length || 'm') : 'm';
    const yth2 = document.querySelector('#tbl-nodes thead tr .th-y');
    if (yth2) {
      yth2.textContent = (isZLifted2D ? 'Z [' : 'Y [') + lenU + ']';
      yth2.title       = isZLifted2D ? 'Height / elevation (stored as Z)' : '';
    }
    // Z column is created once when 3D turns on, so its label has to be
    // refreshed here or it keeps whatever unit was active at creation.
    const zth2 = document.querySelector('#tbl-nodes thead tr .th-z');
    if (zth2) zth2.textContent = 'Z [' + lenU + ']';
    for (const nd of nodes) {
      const tr = document.createElement('tr');
      if (nd.id === selNode) tr.classList.add('sel');
      const xDisp  = US ? US.toDisplay(nd.x, 'length').toFixed(lenDec) : nd.x.toFixed(3);
      const yVal   = isZLifted2D ? (nd.z || 0) : nd.y;   // show Z when z-lifted
      const yDisp  = US ? US.toDisplay(yVal, 'length').toFixed(lenDec) : yVal.toFixed(3);
      const yField = isZLifted2D ? 'z' : 'y';             // write to correct field
      const zDisp  = US ? US.toDisplay(nd.z||0, 'length').toFixed(lenDec) : (nd.z||0).toFixed(3);
      const zCell  = mode3D ? `<td><input type="number" value="${zDisp}" step="${lenStep}" data-nid="${nd.id}" data-f="z"
              aria-label="Node ${nd.id} Z coordinate"></td>` : '';
      tr.innerHTML = `
        <td>${nd.id}</td>
        <td><input type="number" value="${xDisp}" step="${lenStep}" data-nid="${nd.id}" data-f="x"
              aria-label="Node ${nd.id} X coordinate"></td>
        <td><input type="number" value="${yDisp}" step="${lenStep}" data-nid="${nd.id}" data-f="${yField}"
              aria-label="Node ${nd.id} ${yField.toUpperCase()} coordinate"></td>
        ${zCell}
        <td><select data-nid="${nd.id}" data-f="support" aria-label="Node ${nd.id} support">
          <option value="none"    ${nd.support==='none'    ?'selected':''}>None</option>
          <option value="pin"     ${nd.support==='pin'     ?'selected':''}>Pin</option>
          <option value="roller"  ${nd.support==='roller'  ?'selected':''}>Roller ↑</option>
          <option value="rollerH" ${nd.support==='rollerH' ?'selected':''}>Roller ↔</option>
          <option value="fixed"   ${nd.support==='fixed'   ?'selected':''}>Fixed</option>
        </select></td>
        <td><button class="tbl-del-btn" data-del-node="${nd.id}"
              title="Delete node ${nd.id}" aria-label="Delete node ${nd.id}">&#10005;</button></td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('input, select').forEach(el => {
      el.addEventListener('change', () => {
        const nd = findNode(+el.dataset.nid); if (!nd) return;
        const f = el.dataset.f;
        if (f === 'x' || f === 'y' || f === 'z') {
          const raw = parseFloat(el.value);
          nd[f] = window.UnitSystem ? UnitSystem.fromDisplay(raw, 'length') : raw;
        } else { nd[f] = el.value; }
        snapshot(); render();
      });
    });

    tbody.querySelectorAll('[data-del-node]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nid = +btn.dataset.delNode;
        const hit = nodeDeletionImpact(nid);
        if (hit.members.length) {
          const names = hit.members.map(b => getMemberLabel(b)).join(', ');
          const ok = confirm(
            `Deleting node ${nid} also deletes the ${hit.members.length} ` +
            `member${hit.members.length === 1 ? '' : 's'} attached to it (${names})` +
            (hit.loads ? ` and ${hit.loads} load${hit.loads === 1 ? '' : 's'}` : '') +
            '.\n\nOK to delete, Cancel to keep.');
          if (!ok) return;
        }
        snapshot();
        const gone = deleteNode(nid);
        updateNodeTable(); updateBeamTable(); updateLoadTable(); render();
        if (gone.members.length) {
          toast(`Deleted node ${nid} with ${gone.members.length} ` +
                `member${gone.members.length === 1 ? '' : 's'}` +
                (gone.loads ? ` and ${gone.loads} load${gone.loads === 1 ? '' : 's'}` : '') +
                '. Ctrl+Z to undo.', 'warn');
        }
      });
    });
  }

  function updateBeamTable() {
    const tbody = document.querySelector('#tbl-beams tbody');
    tbody.innerHTML = '';
    for (const bm of beams) {
      const tr = document.createElement('tr');
      if (bm.id === selBeam) tr.classList.add('sel');
      // A <select> with no option marked `selected` shows its FIRST option, so
      // a member whose section is missing — never assigned, or assigned to one
      // since deleted — displayed the first section in the library as though it
      // were its own. The table said 'Conc 9"x9"' while the member had nothing,
      // and the solver's refusal to analyse it looked inexplicable. Show the
      // truth, and make it look wrong.
      const secOk = sections.some(s => s.id === bm.sectionId);
      const secOpts =
        (secOk ? '' : '<option value="" selected>— none —</option>') +
        sections.map(s =>
          `<option value="${s.id}" ${bm.sectionId===s.id?'selected':''}>${escapeIssue(s.name)}</option>`
        ).join('');
      const mt = bm.memberType || 'auto';
      const lbl = getMemberLabel(bm);
      const typeColor = getMemberType(bm) === 'column' ? '#1a237e' : getMemberType(bm) === 'brace' ? '#e65100' : '#2e7d32';
      tr.innerHTML = `
        <td style="font-weight:700;color:${typeColor}">${escapeIssue(lbl)}</td>
        <td>${bm.node1}</td>
        <td>${bm.node2}</td>
        <td><select data-bid="${bm.id}" data-f="sectionId" aria-label="Member ${escapeIssue(lbl)} section"${secOk ? '' : ' style="color:#c62828;font-weight:700;border-color:#c62828"'}>${secOpts}</select></td>
        <td><select data-bid="${bm.id}" data-f="memberType" aria-label="Member ${escapeIssue(lbl)} type" style="font-size:10px;padding:1px 2px">
          <option value="auto"   ${mt==='auto'   ?'selected':''}>Auto</option>
          <option value="beam"   ${mt==='beam'   ?'selected':''}>Beam</option>
          <option value="column" ${mt==='column' ?'selected':''}>Column</option>
          <option value="brace"  ${mt==='brace'  ?'selected':''}>Brace</option>
        </select></td>
        <td><input type="checkbox" ${bm.hingeStart?'checked':''} data-bid="${bm.id}" data-f="hingeStart"
              aria-label="Member ${escapeIssue(lbl)} hinge at start"></td>
        <td><input type="checkbox" ${bm.hingeEnd  ?'checked':''} data-bid="${bm.id}" data-f="hingeEnd"
              aria-label="Member ${escapeIssue(lbl)} hinge at end"></td>
        <td><button class="tbl-del-btn" data-del-beam="${bm.id}"
              title="Delete member ${bm.id}" aria-label="Delete member ${bm.id}">&#10005;</button></td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('select, input[type="checkbox"]').forEach(el => {
      el.addEventListener('change', () => {
        const bm = findBeam(+el.dataset.bid); if (!bm) return;
        const f = el.dataset.f;
        if (el.type === 'checkbox') bm[f] = el.checked;
        // The '— none —' placeholder has an empty value, and +'' is 0 — a number
        // that is not a section id but is not null either. Keep unassigned as
        // null so every check for it agrees.
        else if (f === 'sectionId') bm[f] = el.value === '' ? null : +el.value;
        else bm[f] = el.value;
        snapshot(); render();
      });
    });

    tbody.querySelectorAll('[data-del-beam]').forEach(btn => {
      btn.addEventListener('click', () => {
        snapshot(); deleteBeam(+btn.dataset.delBeam);
        updateBeamTable(); updateLoadTable(); render();
      });
    });
  }

  function updateSectionTable() {
    const tbody = document.querySelector('#tbl-sections tbody');
    tbody.innerHTML = '';
    for (const sc of sections) {
      // A section with a shape is PARAMETRIC: A and I come from its dimensions,
      // E/fy/ρ from its material, and Define ▸ Sections recomputes them from
      // those inputs. Typing over a derived cell here used to look like it
      // worked and then silently revert on the next recompute, so the derived
      // cells are read-only and say where to change the real input. A section
      // with no shape is GENERAL — its properties were typed in directly (Excel
      // import, "+ Section") and stay fully editable.
      const derived = !!sc.shapeId;
      const matName = derived && window.MAT_UI
        ? (MAT_UI.getMaterialById(sc.materialId)?.name || '') : '';
      const lockGeom = derived
        ? ` readonly class="derived" title="From ${escapeIssue(sc.name)}'s shape ` +
          `(${escapeIssue(sc.shapeId)}, ${sc.d || '?'}×${sc.bf || '?'} mm) — change it in Define ▸ Sections"`
        : '';
      const lockMat = derived
        ? ` readonly class="derived" title="From material ${escapeIssue(matName || '(unset)')}` +
          ` — change it in Define ▸ Materials"`
        : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${sc.id}</td>
        <td><input type="text"   value="${escapeIssue(sc.name)}" data-sid="${sc.id}" data-f="name"
              aria-label="Section ${sc.id} name"></td>
        <td><input type="number" value="${sc.A}"         step="0.01" data-sid="${sc.id}" data-f="A"
              aria-label="Section ${sc.id} area A"${lockGeom}></td>
        <td><input type="number" value="${sc.I}"         step="1"    data-sid="${sc.id}" data-f="I"
              aria-label="Section ${sc.id} second moment of area I"${lockGeom}></td>
        <td><input type="number" value="${sc.E}"         step="1"    data-sid="${sc.id}" data-f="E"
              aria-label="Section ${sc.id} modulus of elasticity E"${lockMat}></td>
        <td><input type="number" value="${sc.fy||235}"   step="5"    data-sid="${sc.id}" data-f="fy"
              aria-label="Section ${sc.id} yield strength fy"${lockMat}></td>
        <td><input type="number" value="${sc.rho||0}"    step="0.5"  data-sid="${sc.id}" data-f="rho"
              aria-label="Section ${sc.id} density rho"${lockMat}></td>
        <td><button class="tbl-del-btn" data-del-sec="${sc.id}"
              title="Delete section ${sc.id}" aria-label="Delete section ${sc.id}">&#10005;</button></td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('input').forEach(el => {
      el.addEventListener('change', () => {
        const sc = sections.find(s => s.id === +el.dataset.sid); if (!sc) return;
        if (el.readOnly) return;
        const f = el.dataset.f;
        sc[f] = f === 'name' ? el.value : parseFloat(el.value);
        // One store means one undo step and one autosave for this edit, and the
        // Define ▸ Sections list has to show the new name.
        snapshot();
        window.FRAME_SEC?.refresh?.();
        render();
      });
    });

    tbody.querySelectorAll('[data-del-sec]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid = +btn.dataset.delSec;
        // Deleting a section used to leave every member that used it pointing
        // at an id that no longer existed. Nothing said so, the members table
        // then displayed the first section in its place, and the model only
        // failed later at SOLVE with a singular matrix. Ask first.
        const users = beams.filter(b => b.sectionId === sid);
        if (users.length) {
          const names = users.map(b => getMemberLabel(b)).join(', ');
          const ok = confirm(
            `${users.length} member${users.length === 1 ? ' uses' : 's use'} this section ` +
            `(${names}).` + '\n\n' +
            `Deleting it leaves ${users.length === 1 ? 'that member' : 'those members'} ` +
            'with no properties, and the model will not solve until you assign ' +
            'another section.' + '\n\n' + 'Delete it anyway?');
          if (!ok) return;
        }
        snapshot();
        sections = sections.filter(s => s.id !== sid);
        // Never leave the library empty: with no sections there is nothing to
        // assign, and every member in the model becomes unanalysable at once.
        if (sections.length === 0) {
          sections.push(defaultSection());
          toast('That was the last section, so a default 9"×9" concrete section ' +
                'was kept to assign members to.', 'info');
        }
        // Clear the dangling reference rather than leaving a dead id behind, so
        // the members table can show '— none —' and mean it.
        users.forEach(b => { b.sectionId = null; });
        if (users.length)
          toast(`${users.length} member${users.length === 1 ? ' is' : 's are'} now without a ` +
                'section and cannot be analysed until one is assigned.', 'warn');
        updateSectionTable(); updateBeamTable(); render();
      });
    });
  }

  function updateLoadTable(filterCaseId) {
    const tbody = document.querySelector('#tbl-loads tbody');
    tbody.innerHTML = '';
    const displayed = filterCaseId
      ? loads.filter(l => (l.caseId||1) === filterCaseId)
      : loads;
    for (const ld of displayed) {
      const tr = document.createElement('tr');
      const typeLabel = { nodal:'Node', moment:'Moment', beam_point:'Beam pt.', beam_dist:'Dist.', beam_trap:'Trap.', area_load:'Area' }[ld.type] || ld.type;
      const on = ld.type === 'area_load'
        ? `[${(ld.nodeIds||[]).join(',')}]`
        : (ld.nodeId ? `N${ld.nodeId}` : (ld.elementId ? `B${ld.elementId}` : '-'));
      const lc = loadCases.find(c => c.id === (ld.caseId||1));
      const badge = lc
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${/^#[0-9a-f]{6}$/i.test(lc.color||'') ? lc.color : '#1565c0'};margin-right:3px;vertical-align:middle"></span>${escapeIssue(lc.name)}`
        : '-';
      tr.innerHTML = `
        <td>${ld.id}</td>
        <td>${typeLabel}</td>
        <td>${on}</td>
        <td style="white-space:nowrap">${badge}</td>
        <td>${ld.type === 'area_load' ? '-' : (ld.fx||0).toFixed(2)}</td>
        <td>${ld.type === 'area_load' ? `${(ld.p||0)} kN/m²` : (ld.fy||0).toFixed(2)}</td>
        <td>${(ld.m ||0).toFixed(2)}</td>
        <td>${ld.pos !== undefined ? ld.pos : '-'}</td>
        <td style="white-space:nowrap">
          <button class="tbl-del-btn" data-edit-load="${ld.id}"
                  title="Edit load ${ld.id}" aria-label="Edit load ${ld.id}">&#9998;</button>
          <button class="tbl-del-btn" data-del-load="${ld.id}"
                  title="Delete load ${ld.id}" aria-label="Delete load ${ld.id}">&#10005;</button>
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-del-load]').forEach(btn => {
      btn.addEventListener('click', () => {
        snapshot();
        loads = loads.filter(l => l.id !== +btn.dataset.delLoad);
        updateLoadTable(); results = null; render();
        if (cfg.autoSolve) solve();
      });
    });
    tbody.querySelectorAll('[data-edit-load]').forEach(btn => {
      btn.addEventListener('click', () => openEditLoad(+btn.dataset.editLoad));
    });
  }

  // ── Edit an existing load ─────────────────────────────────────────
  function openEditLoad(ldId) {
    const ld = loads.find(l => l.id === ldId);
    if (!ld) return;
    _editingLoadId = ldId;

    // Populate selectors
    populateLoadDialog();

    // Set type
    document.getElementById('load-type-sel').value = ld.type;

    // Set load case
    const cSel = document.getElementById('load-case-sel');
    if (cSel && ld.caseId) cSel.value = ld.caseId;

    // Set node / beam
    if (ld.nodeId)    document.getElementById('load-node-sel').value = ld.nodeId;
    if (ld.elementId) document.getElementById('load-beam-sel').value = ld.elementId;

    // Detect direction mode from stored values
    const hasFx  = ld.fx !== undefined && ld.fx !== 0;
    const hasFy  = ld.fy !== undefined && ld.fy !== 0;

    if (hasFx && hasFy) {
      loadDirMode = 'custom';
    } else if (hasFx && !hasFy) {
      loadDirMode = 'horiz';
    } else {
      loadDirMode = 'vert';
    }
    document.querySelectorAll('.dir-mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === loadDirMode));

    // Pre-fill numeric inputs
    if (ld.fx  !== undefined) document.getElementById('load-fx-val').value  = ld.fx;
    if (ld.fy  !== undefined) document.getElementById('load-fy-val').value  = ld.fy;
    if (ld.fy2 !== undefined) document.getElementById('load-fy2-val').value = ld.fy2;
    if (ld.m   !== undefined) document.getElementById('load-m-val').value   = ld.m;
    if (ld.pos !== undefined) document.getElementById('load-pos-val').value = ld.pos;
    if (ld.nodeIds) document.getElementById('load-area-nodes').value = (ld.nodeIds||[]).join(',');
    if (ld.p  !== undefined) document.getElementById('load-pressure-val').value = ld.p;

    // Update modal title and button
    document.getElementById('load-modal-title').textContent = 'Edit Load';
    document.getElementById('load-ok').textContent = 'Update';

    updateLoadDialog();
    openModal('modal-load');
  }

  // ── Cases pane ───────────────────────────────────────────────────
  function updateCasesPane() {
    // Load cases table
    const tb1 = document.querySelector('#tbl-cases tbody');
    if (tb1) {
      tb1.innerHTML = '';
      for (const lc of loadCases) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${lc.id}</td>
          <td>${escapeIssue(lc.name)}</td>
          <td>${escapeIssue(lc.type)}</td>
          <td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${/^#[0-9a-f]{6}$/i.test(lc.color) ? lc.color : '#1565c0'};vertical-align:middle"></span></td>
          <td>
            <button class="tbl-del-btn" data-edit-lc="${lc.id}"
                    title="Edit load case ${lc.id}" aria-label="Edit load case ${lc.id}">&#9998;</button>
            <button class="tbl-del-btn" data-del-lc="${lc.id}"
                    title="Delete load case ${lc.id}" aria-label="Delete load case ${lc.id}">&#10005;</button>
          </td>`;
        tb1.appendChild(tr);
      }
      tb1.querySelectorAll('[data-edit-lc]').forEach(btn =>
        btn.addEventListener('click', () => openEditCase(+btn.dataset.editLc)));
      tb1.querySelectorAll('[data-del-lc]').forEach(btn =>
        btn.addEventListener('click', () => {
          if (loadCases.length <= 1) { toast('At least one case required.', 'error'); return; }
          const id = +btn.dataset.delLc;
          const lc = loadCases.find(c => c.id === id);
          const nm = lc ? lc.name : ('case ' + id);

          // Combinations reference cases by id. Deleting a case used to leave
          // them pointing at one that no longer exists: the Factors column
          // rendered "1.2×?" and, at solve time, that term silently contributed
          // nothing — so 1.2D + 1.0W + L quietly became 1.2D + L and still
          // reported itself under the old name. Say what is affected and clean
          // up, rather than leave a combination that lies about what it is.
          const affected = loadCombos.filter(cb => (cb.factors || []).some(f => f.caseId === id));
          if (affected.length) {
            const willEmpty = affected.filter(cb =>
              !(cb.factors || []).some(f => f.caseId !== id && f.factor));
            const ok = confirm(
              `${affected.length} load combination${affected.length === 1 ? '' : 's'} use "${nm}":\n\n  ` +
              affected.map(c => c.name).join('\n  ') + '\n\n' +
              `Deleting the case removes its term from ${affected.length === 1 ? 'it' : 'them'}` +
              (willEmpty.length
                ? `, and ${willEmpty.length} would be left with nothing and removed as well`
                : '') +
              '.\n\nOK to delete and update, Cancel to keep everything.');
            if (!ok) return;
          }

          snapshot();
          loadCases = loadCases.filter(c => c.id !== id);
          loads = loads.filter(l => (l.caseId||1) !== id);
          loadCombos.forEach(cb => {
            const had = (cb.factors || []).some(f => f.caseId === id && f.factor);
            cb.factors = (cb.factors || []).filter(f => f.caseId !== id);
            // The name is a label the user chose, so it does not get rewritten
            // — but "0.9D + 1.0W" on a combination that is now only 0.9D is a
            // lie, and that name is what the display selector and the results
            // header show. Mark it instead, so the change is visible and the
            // original intent is still readable.
            if (had) cb.name = `${cb.name} (−${nm})`;
          });
          const emptied = loadCombos.filter(cb => !(cb.factors || []).some(f => f.factor));
          if (emptied.length) {
            loadCombos = loadCombos.filter(cb => (cb.factors || []).some(f => f.factor));
          }

          delete allCaseResults[id];
          // The combinations changed, so any combination results describe a set
          // that no longer exists.
          allComboResults = {};
          // Stop the display pointing at something that has just gone.
          if ((activeDisplay.type === 'case'  && activeDisplay.id === id) ||
              (activeDisplay.type === 'combo' && emptied.some(c => c.id === activeDisplay.id))) {
            activeDisplay = { type: 'case', id: loadCases[0] ? loadCases[0].id : 1 };
            results = null;
          }

          updateCasesPane(); updateLoadTable(); populateDisplaySelector(); render();
          if (emptied.length) {
            toast(`Removed "${nm}". ${emptied.length} combination${emptied.length === 1 ? '' : 's'} ` +
                  `had nothing left and ${emptied.length === 1 ? 'was' : 'were'} removed: ` +
                  emptied.map(c => c.name).join(', '), 'warn');
          } else if (affected.length) {
            toast(`Removed "${nm}" and its term from ${affected.length} ` +
                  `combination${affected.length === 1 ? '' : 's'}.`, 'info');
          }
        }));
    }

    // Combos table
    const tb2 = document.querySelector('#tbl-combos tbody');
    if (tb2) {
      tb2.innerHTML = '';
      for (const cb of loadCombos) {
        const fStr = cb.factors.filter(f=>f.factor).map(f=>{
          const lc = loadCases.find(c=>c.id===f.caseId);
          return `${f.factor}×${escapeIssue(lc?lc.name:'?')}`;
        }).join(' + ') || '—';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${cb.id}</td>
          <td>${escapeIssue(cb.name)}</td>
          <td style="font-size:9px">${fStr}</td>
          <td>
            <button class="tbl-del-btn" data-edit-cb="${cb.id}"
                    title="Edit combination ${cb.id}" aria-label="Edit combination ${cb.id}">&#9998;</button>
            <button class="tbl-del-btn" data-del-cb="${cb.id}"
                    title="Delete combination ${cb.id}" aria-label="Delete combination ${cb.id}">&#10005;</button>
          </td>`;
        tb2.appendChild(tr);
      }
      tb2.querySelectorAll('[data-edit-cb]').forEach(btn =>
        btn.addEventListener('click', () => openEditCombo(+btn.dataset.editCb)));
      tb2.querySelectorAll('[data-del-cb]').forEach(btn =>
        btn.addEventListener('click', () => {
          const id = +btn.dataset.delCb; snapshot();
          loadCombos = loadCombos.filter(c => c.id !== id);
          delete allComboResults[id]; updateCasesPane();
        }));
    }

    // Update case filter in Loads pane
    const filt = document.getElementById('pnl-load-case-filter');
    if (filt) {
      const prev = filt.value;
      filt.innerHTML = '<option value="all">All cases</option>' +
        loadCases.map(lc=>`<option value="${lc.id}">${escapeIssue(lc.name)}</option>`).join('');
      filt.value = prev;
    }
  }

  function openEditCase(id) {
    const lc = loadCases.find(c => c.id === id);
    if (!lc) return;
    document.getElementById('lcase-edit-id').value = id;
    document.getElementById('lcase-name').value    = lc.name;
    document.getElementById('lcase-type').value    = lc.type;
    document.getElementById('lcase-color').value   = lc.color;
    openModal('modal-loadcase');
  }

  function openEditCombo(id) {
    const cb = loadCombos.find(c => c.id === id);
    document.getElementById('combo-edit-id').value = id || '';
    document.getElementById('combo-name').value    = cb ? cb.name : 'ULS: 1.35DL + 1.5LL';
    populateComboFactors(cb);
    openModal('modal-combo');
  }

  function populateComboFactors(cb) {
    const list = document.getElementById('combo-factors-list');
    if (!list) return;
    list.innerHTML = '';
    for (const lc of loadCases) {
      const f = cb ? (cb.factors.find(x=>x.caseId===lc.id)||{factor:0}).factor : 0;
      const div = document.createElement('div');
      div.className = 'form-row';
      div.innerHTML = `<label><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${/^#[0-9a-f]{6}$/i.test(lc.color||'') ? lc.color : '#1565c0'};margin-right:4px;vertical-align:middle"></span>${escapeIssue(lc.name)}</label>
        <input type="number" step="0.05" value="${f}" data-cid="${lc.id}" style="width:70px">`;
      list.appendChild(div);
    }
  }

  // ── Modal helpers ─────────────────────────────────────────────────

  function openModal(id)  { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // Every currently visible dialog, top-most last (by stacking order).
  function openModals() {
    return [...document.querySelectorAll('.modal-overlay')]
      .filter(m => getComputedStyle(m).display !== 'none')
      .sort((a, b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0));
  }
  // Dismiss the top-most dialog. Clears the inline display too, since a few
  // dialogs are still opened that way rather than via the .open class.
  function closeTopModal() {
    const list = openModals();
    if (!list.length) return false;
    const top = list[list.length - 1];
    top.classList.remove('open');
    if (top.style.display) top.style.display = '';
    return true;
  }

  function populateLoadDialog() {
    const nodeOpts = nodes.map(n => `<option value="${n.id}">N${n.id} (${n.x},${n.y})</option>`).join('');
    document.getElementById('load-node-sel').innerHTML = nodeOpts;
    if (pendingNodeId) document.getElementById('load-node-sel').value = pendingNodeId;
    const beamOpts = beams.map(b => `<option value="${b.id}">B${b.id} (N${b.node1}−N${b.node2})</option>`).join('');
    document.getElementById('load-beam-sel').innerHTML = beamOpts;
    // Load case selector
    const cSel = document.getElementById('load-case-sel');
    if (cSel) cSel.innerHTML = loadCases.map(lc=>`<option value="${lc.id}">${escapeIssue(lc.name)}</option>`).join('');
    // Reset direction mode to vertical each time dialog opens
    loadDirMode = 'vert';
    document.querySelectorAll('.dir-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'vert'));
    updateLoadDialog();
  }

  function updateLoadDialog() {
    const t       = document.getElementById('load-type-sel').value;
    const isArea   = t === 'area_load';
    const isMoment = t === 'moment';
    const isDist   = t === 'beam_dist' || t === 'beam_trap';
    const isTrap   = t === 'beam_trap';
    const isBeam   = t === 'beam_point' || isDist;
    const dm       = loadDirMode;
    const isAngle  = dm === 'angle';
    const isHoriz  = dm === 'horiz';
    const isCustom = dm === 'custom';
    const hasDir   = !isArea && !isMoment;

    // Direction row: hide for area/moment
    const dirRow = document.getElementById('load-dir-row');
    if (dirRow) dirRow.style.display = hasDir ? '' : 'none';

    document.getElementById('load-node-row').style.display   = (t==='nodal'||isMoment) ? '' : 'none';
    document.getElementById('load-beam-row').style.display   = isBeam ? '' : 'none';

    // Magnitude + angle rows: only in angle mode for non-area/moment
    document.getElementById('load-mag-row').style.display    = (isAngle && hasDir) ? '' : 'none';
    document.getElementById('load-ang-row').style.display    = (isAngle && hasDir) ? '' : 'none';

    // Fx row: visible in horiz or custom mode (not area/moment/angle)
    document.getElementById('load-fx-row').style.display     = (!isAngle && (isHoriz||isCustom) && hasDir) ? '' : 'none';

    // Fy row: hidden in horiz mode and angle mode; visible otherwise for non-area/moment
    document.getElementById('load-fy-row').style.display     = (!isArea && !isMoment && !isHoriz && !isAngle) ? '' : 'none';

    document.getElementById('load-m-row').style.display      = isMoment ? '' : 'none';
    document.getElementById('load-pos-row').style.display    = (t==='beam_point') ? '' : 'none';

    // Fy2 row for trap: show unless angle mode (in angle mode, fy2-val becomes end magnitude)
    document.getElementById('load-fy2-row').style.display    = (isTrap && !isHoriz) ? '' : 'none';

    document.getElementById('load-area-row').style.display   = isArea ? '' : 'none';
    document.getElementById('load-press-row').style.display  = isArea ? '' : 'none';

    // Update labels dynamically
    const fyLbl  = document.querySelector('#load-fy-row label');
    const fxLbl  = document.querySelector('#load-fx-row label');
    const fy2Lbl = document.querySelector('#load-fy2-row label');
    const magLbl = document.querySelector('#load-mag-row label');
    const angLbl = document.querySelector('#load-ang-row label');
    const forceU = window.UnitSystem ? UnitSystem.label('force') : 'kN';
    const distU  = window.UnitSystem ? UnitSystem.label('distLoad') : 'kN/m';

    if (fyLbl)  fyLbl.textContent  = isDist ? `Fy start [${distU}]` : `Fy [${forceU}]`;
    if (fxLbl)  fxLbl.textContent  = isDist ? `Fx start [${distU}]` : `Fx [${forceU}]`;
    if (fy2Lbl) fy2Lbl.textContent = (isTrap && isAngle) ? `End Magnitude [${distU}]` : `Fy end [${distU}]`;
    if (magLbl) magLbl.textContent = isDist ? `Magnitude [${distU}]` : `Magnitude [${forceU}]`;
    if (angLbl) angLbl.textContent = 'Angle [° from +X]  (0°=right, −90°=down)';
  }

  function populateSettleDialog() {
    const opts = nodes.filter(n => n.support && n.support!=='none').map(n =>
      `<option value="${n.id}">N${n.id} (${n.support})</option>`).join('');
    document.getElementById('settle-node-sel').innerHTML = opts || '<option>No supported nodes</option>';
  }

  // ── Panel tabs ─────────────────────────────────────────────────────

  function switchPane(name) {
    document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    const tab = document.querySelector(`.ptab[data-pane="${name}"]`);
    if (tab) tab.classList.add('active');
    const pane = document.getElementById(`pane-${name}`);
    if (pane) pane.classList.add('active');
  }

  // ── File ops ──────────────────────────────────────────────────────

  /**
   * Take the material library that arrived with a model, and say so when one
   * did not arrive at all.
   *
   * Sections reference their material by `materialId` and take E, fy and ρ
   * from it, so a model and its materials are one thing. Every load path has
   * to adopt them together or the sections resolve against whatever library
   * happens to be in memory — which is how a project saved with A36 steel
   * (E = 200 GPa) reopened as aluminium (E = 70 GPa) with nothing said. The
   * numbers were wrong by a factor of three and the model still looked right.
   *
   * Files written before materials travelled with the model have none. There
   * is nothing to restore in that case, so the current library stays — but the
   * references are checked, because the ids in an old file mean whatever the
   * library means today, and a section pointing at a material that no longer
   * exists must not pass silently.
   */
  function adoptMaterials(incoming, sourceLabel) {
    if (Array.isArray(incoming) && incoming.length) {
      materials = incoming;
    } else {
      const known = new Set(materials.map(m => m.id));
      const orphans = sections.filter(s => s.materialId != null && !known.has(s.materialId));
      if (orphans.length) {
        const one = orphans.length === 1;
        toast(`${sourceLabel} was saved before materials travelled with the model, and ` +
              `${orphans.length} section${one ? '' : 's'} ` +
              `(${orphans.map(s => s.name).join(', ')}) ` +
              `${one ? 'references' : 'reference'} a material this library does not ` +
              'have. Check Define ▸ Materials before relying on the results.', 'warn');
      }
    }
    // The two Define dialogs hold their own view of these arrays. On the
    // shared-link path this runs during init, before either has been set up,
    // so a refresh that is not ready yet must not take the caller down with
    // it — init goes on to initialise both properly a few lines later.
    try { window.MAT_UI?.refresh?.(); }    catch (e) { /* set up later in init */ }
    try { window.FRAME_SEC?.refresh?.(); } catch (e) { /* set up later in init */ }
  }

  function saveFile() {
    const name = document.getElementById('file-name').value.trim() || 'structure1';
    // `materials` belongs here: the sections below reference it by id.
    // mode3D/view3D travel too — same reason autoSaveToLocal() carries them:
    // the node coordinates are stored in whichever convention (Y- or
    // Z-elevation) that flag means, so loading them back without it left a
    // saved 3D model's Z-lifted geometry rendered in 2D as a flattened frame.
    const data = { nodes, beams, sections, materials, loads, settlements,
                   nextId, loadCases, loadCombos, mode3D, view3D,
                   grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined };
    localStorage.setItem('sa_file_' + name, JSON.stringify(data));
    loadSavedList();
    toast(`Saved: ${name}`, 'success');
  }

  function loadFile(name) {
    const raw = localStorage.getItem('sa_file_' + name);
    if (!raw) { toast('File not found.', 'error'); return; }
    const d = JSON.parse(raw);
    nodes = d.nodes || []; beams = d.beams || [];
    sections = d.sections || []; loads = d.loads || [];
    settlements = d.settlements || []; nextId = d.nextId || nextId;
    sanitizeLoadedSections();
    adoptMaterials(d.materials, `"${name}"`);
    loadCases  = loadCasesOr(d.loadCases);
    loadCombos = d.loadCombos || [];
    // Restore the view mode alongside the geometry — same logic as
    // restoreSession(). Set the flags directly rather than clicking #btn-3d:
    // the coordinates in the payload are already in the saved mode's
    // convention and must not be migrated again. A file saved from a 2D
    // session needs the mirror-image reset, or the CURRENT session's 3D state
    // (if any) would be kept while loading 2D-convention coordinates under it.
    // A save written before mode3D travelled has no way to say which — leave
    // the current session's mode alone rather than guessing 2D, which is what
    // loading one of those files did before this existed anyway.
    if (typeof d.mode3D === 'boolean') {
      const b3  = document.getElementById('btn-3d');
      const orb = document.getElementById('btn-orbit-reset');
      const nzr = document.getElementById('node-z-row');
      mode3D = d.mode3D;
      if (mode3D) {
        if (d.view3D && typeof d.view3D.az === 'number') view3D = { ...d.view3D };
        if (b3) { b3.classList.add('active'); setBtnLabel(b3, '3D ✓'); }
        if (orb) orb.style.display = '';
        if (nzr) nzr.style.display = 'flex';
      } else {
        if (b3) { b3.classList.remove('active'); setBtnLabel(b3, '3D'); }
        if (orb) orb.style.display = 'none';
        if (nzr) nzr.style.display = 'none';
      }
    }
    if (d.grids) window.GRIDSYS?.setGrids?.(d.grids);
    results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
    designResults = null;
    multiSel = { nodes: new Set(), beams: new Set() };
    // Mode shapes belong to the model that was replaced.
    resetModeOverlay();
    updateNodeTable(); updateBeamTable(); updateSectionTable(); updateLoadTable();
    updateCasesPane(); populateDisplaySelector();
    fitToScreen(); render();
    closeModal('modal-files');
    toast(`Loaded: ${name}`, 'success');
    snapshot();
  }

  /**
   * Apply a FileIO.importJSON() result to the live model. Shared by every
   * .frame/.json import path (the legacy "file-load" button, the newer
   * "file-import-json" button, and clipboard paste) so they cannot drift
   * apart again — they used to each assemble this sequence by hand, and two
   * of the three skipped sanitizeLoadedSections() and/or adoptMaterials(),
   * so loading the same legacy-schema file through different buttons left
   * the model in different states.
   */
  function applyImportedModel(data, sourceLabel) {
    nodes       = data.nodes       || [];
    beams       = data.beams       || [];
    sections    = data.sections    || [];
    loads       = data.loads       || [];
    settlements = data.settlements || [];
    nextId      = data.nextId      || nextId;
    sanitizeLoadedSections();
    adoptMaterials(data.materials, sourceLabel);
    loadCases  = loadCasesOr(data.loadCases);
    loadCombos = data.loadCombos || [];
    if (data.meta) projectMeta = { ...projectMeta, ...data.meta };

    // Same reasoning as loadFile(): restore the view mode alongside the
    // geometry, and leave the current session's mode alone when the file
    // predates mode3D travelling with the model at all.
    if (typeof data.mode3D === 'boolean') {
      const b3  = document.getElementById('btn-3d');
      const orb = document.getElementById('btn-orbit-reset');
      const nzr = document.getElementById('node-z-row');
      mode3D = data.mode3D;
      if (mode3D) {
        if (data.view3D && typeof data.view3D.az === 'number') view3D = { ...data.view3D };
        if (b3) { b3.classList.add('active'); setBtnLabel(b3, '3D ✓'); }
        if (orb) orb.style.display = '';
        if (nzr) nzr.style.display = 'flex';
      } else {
        if (b3) { b3.classList.remove('active'); setBtnLabel(b3, '3D'); }
        if (orb) orb.style.display = 'none';
        if (nzr) nzr.style.display = 'none';
      }
    }
    if (data.grids) window.GRIDSYS?.setGrids?.(data.grids);

    results = null; designResults = null; allCaseResults = {}; allComboResults = {};
    envelopeResult = null;
    resetModeOverlay();
    multiSel = { nodes: new Set(), beams: new Set() };
    updateNodeTable(); updateBeamTable(); updateSectionTable();
    updateLoadTable(); updateCasesPane(); populateDisplaySelector();
    updateDesignTable(); fitToScreen(); render(); snapshot();
    window.FRAME_SEC?.refresh?.(); window.MAT_UI?.refresh?.();
  }

  function newFile() {
    if (!confirm('Start a new file? Unsaved work will be lost.')) return;
    clearAutosave();
    nodes = []; beams = []; loads = []; settlements = [];
    results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
    designResults = null;
    loadCases  = defaultLoadCases();
    loadCombos = [];
    nextId = { node:1, beam:1, load:1, section: sections.length + 1, settlement:1, lcase:3, combo:1 };
    selNode = null; selBeam = null;
    multiSel = { nodes: new Set(), beams: new Set() };
    // Hide mode-bar (mode shapes are invalidated on new file)
    resetModeOverlay();
    updateNodeTable(); updateBeamTable(); updateLoadTable();
    updateCasesPane(); populateDisplaySelector();
    render();
    closeModal('modal-files');
    snapshot();
  }

  function loadSavedList() {
    const ul = document.getElementById('saved-list');
    ul.innerHTML = '';
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sa_file_')) keys.push(key);
    }
    if (keys.length === 0) {
      ul.innerHTML = '<li style="color:var(--text-muted);font-style:italic">No saved files</li>';
      return;
    }
    for (const key of keys) {
      const name = key.replace('sa_file_', '');
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeIssue(name)}</span><div style="display:flex;gap:4px">
        <button class="btn-xs btn-blue" style="padding:1px 6px;font-size:10px" data-load="${escapeIssue(name)}">Load</button>
        <button class="btn-xs btn-red"  style="padding:1px 6px;font-size:10px" data-rm="${escapeIssue(name)}">✕</button>
      </div>`;
      li.querySelector('[data-load]').addEventListener('click', () => loadFile(name));
      li.querySelector('[data-rm]').addEventListener('click', () => {
        localStorage.removeItem(key); loadSavedList();
      });
      ul.appendChild(li);
    }
  }

  // Fallback only — used when window.FileIO itself failed to load, so the
  // real export path (FileIO.downloadJSON, which already carries all of
  // this) is unavailable. Kept in the same shape as that path rather than
  // the narrower one this used to be, so a rare fallback save isn't missing
  // load cases, combinations, id counters and view mode that a normal one has.
  function exportJSON() {
    const data = { nodes, beams, sections, materials, loads, settlements,
                   loadCases, loadCombos, nextId, meta: projectMeta, mode3D, view3D,
                   grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (document.getElementById('file-name').value || 'structure') + '.json';
    a.click(); URL.revokeObjectURL(url);
  }

  function exportPNG() {
    const name = (document.getElementById('file-name')?.value || 'structure') + '.png';
    // FileIO.exportPNG inlines the computed styles before rasterising — a raw
    // serializeToString() drops every class-based style (grid, labels, nodes).
    if (window.FileIO && FileIO.exportPNG) {
      FileIO.exportPNG(svg(), name, 2);
      toast('PNG exported (2× resolution)', 'success');
      return;
    }
    toast('FileIO not loaded — cannot export PNG', 'error');
  }

  function exportCSV() {
    if (!results || !results.success) {
      toast('Solve first to export results.', 'error'); return;
    }
    let csv = 'Type,ID,Rx_kN,Ry_kN,M_kNm\n';
    for (const nd of nodes) {
      if (!nd.support || nd.support === 'none') continue;
      const r = results.reactions[nd.id]; if (!r) continue;
      csv += `Reaction,N${nd.id},${r.Rx.toFixed(4)},${r.Ry.toFixed(4)},${r.M.toFixed(4)}\n`;
    }
    csv += '\nType,ID,u_mm,v_mm,theta_mrad\n';
    for (const nd of nodes) {
      const d = results.disp[nd.id]; if (!d) continue;
      csv += `Disp,N${nd.id},${(d.u*1000).toFixed(4)},${(d.v*1000).toFixed(4)},${(d.theta*1000).toFixed(4)}\n`;
    }
    csv += '\nMember,N1[kN],V1[kN],M1[kNm],N2[kN],V2[kN],M2[kNm]\n';
    for (const ef of results.elemForces) {
      const bmCsv = beams.find(b=>b.id===ef.id)||{id:ef.id};
      // Internal moments, matching the on-screen tables and diagrams; the raw
      // M1/M2 end actions carry the opposite sign.
      csv += `${getMemberLabel(bmCsv)},${ef.N1.toFixed(3)},${ef.V1.toFixed(3)},${DesignChecks.internalForceAt(ef,'BMD',0).toFixed(3)},${ef.N2.toFixed(3)},${ef.V2.toFixed(3)},${DesignChecks.internalForceAt(ef,'BMD',ef.L).toFixed(3)}
`;
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (document.getElementById('file-name').value || 'results') + '.csv';
    a.click(); URL.revokeObjectURL(url);
    toast('CSV exported', 'success');
  }

  // ── Wizard ────────────────────────────────────────────────────────

  function runWizard() {
    // Read spans from chips
    const chipInputs = document.querySelectorAll('#wiz-span-list .wiz-span-chip input');
    const spans = Array.from(chipInputs).map(i => parseFloat(i.value)).filter(v => v > 0);
    if (spans.length === 0) { toast('Add at least one span.', 'error'); return; }

    const x0     = parseFloat(document.getElementById('wiz-x0').value) || 0;
    const y0     = parseFloat(document.getElementById('wiz-y0').value) || 0;
    const orient = document.getElementById('wiz-orient').value;
    const ohL    = parseFloat(document.getElementById('wiz-oh-left').value) || 0;
    const ohR    = parseFloat(document.getElementById('wiz-oh-right').value) || 0;
    const lSup   = document.getElementById('wiz-sup-left').dataset.val  || 'pin';
    const mSup   = document.getElementById('wiz-sup-mid').dataset.val   || 'roller';
    const rSup   = document.getElementById('wiz-sup-right').dataset.val || 'roller';
    const secId  = +(document.getElementById('wiz-section').value) || (sections[0] && sections[0].id);
    const mtype  = document.getElementById('wiz-mtype').value;

    const lcDl   = +(document.getElementById('wiz-lc-dl').value) || (loadCases[0] && loadCases[0].id) || 1;
    const lcLl   = +(document.getElementById('wiz-lc-ll').value) || lcDl;
    const udlOn  = document.getElementById('wiz-udl-on').checked;
    const udlDL  = udlOn ? (parseFloat(document.getElementById('wiz-udl-dl').value) || 0) : 0;
    const udlLL  = udlOn ? (parseFloat(document.getElementById('wiz-udl-ll').value) || 0) : 0;
    const hingeStr = document.getElementById('wiz-hinges').value;
    const hingeIdxs = hingeStr ? hingeStr.split(',').map(s=>parseInt(s.trim())).filter(v=>!isNaN(v)) : [];

    // Per-span sections
    const perSpan = document.getElementById('wiz-per-span-sec').checked;
    const perSpanSels = perSpan ? Array.from(document.querySelectorAll('#wiz-per-span-list select')) : [];

    const applySW = !!(document.getElementById('wiz-selfwt') && document.getElementById('wiz-selfwt').checked);
    const wizBeamIds = [];

    snapshot();

    // Build overhang + main spans + overhang
    const allSpans = [];
    if (ohL > 0) allSpans.push({ len: ohL, isOH: true, side: 'left' });
    spans.forEach((s, i) => allSpans.push({ len: s, isOH: false, idx: i }));
    if (ohR > 0) allSpans.push({ len: ohR, isOH: true, side: 'right' });

    let pos = orient === 'vertical' ? y0 : x0;
    const newNodeIds = [];

    for (let i = 0; i <= allSpans.length; i++) {
      const nx = orient === 'vertical' ? x0 : pos;
      const ny = orient === 'vertical' ? pos : y0;
      const nid = addNode(nx, ny);
      newNodeIds.push(nid);

      const isLeft   = i === 0;
      const isRight  = i === allSpans.length;
      const isOHNode = (allSpans[i] && allSpans[i].isOH) || (allSpans[i-1] && allSpans[i-1].isOH);

      if (isLeft)  findNode(nid).support = ohL > 0 ? 'none' : lSup;
      else if (isRight) findNode(nid).support = ohR > 0 ? 'none' : rSup;
      else if (!isOHNode) findNode(nid).support = mSup;
      else findNode(nid).support = 'none';

      // Apply left support at first MAIN node if there's an overhang
      if (ohL > 0 && i === 1 && !allSpans[0].isOH) findNode(nid).support = lSup;
      if (ohR > 0 && isRight && allSpans[allSpans.length-1].isOH) {
        const prevNid = newNodeIds[newNodeIds.length - 2];
        if (prevNid) findNode(prevNid).support = rSup;
      }

      if (i < allSpans.length) pos += allSpans[i].len;
    }

    for (let i = 0; i < allSpans.length; i++) {
      const mainIdx = allSpans[i].idx !== undefined ? allSpans[i].idx : -1;
      const spanSecId = (perSpan && mainIdx >= 0 && perSpanSels[mainIdx]) ?
                        (+perSpanSels[mainIdx].value || secId) : secId;

      const hStart = hingeIdxs.includes(i);
      const hEnd   = hingeIdxs.includes(i + 1);
      const bid_new = nextId.beam++;
      wizBeamIds.push(bid_new);
      beams.push({ id: bid_new, node1: newNodeIds[i], node2: newNodeIds[i+1],
                   sectionId: spanSecId, memberType: mtype,
                   hingeStart: hStart, hingeEnd: hEnd });

      if (mainIdx >= 0) {
        if (udlDL !== 0) loads.push({ id: nextId.load++, type: 'beam_dist', elementId: bid_new, fy: udlDL, fy2: udlDL, pos: 0, caseId: lcDl });
        if (udlLL !== 0) loads.push({ id: nextId.load++, type: 'beam_dist', elementId: bid_new, fy: udlLL, fy2: udlLL, pos: 0, caseId: lcLl });
      }
    }

    // Point loads
    if (document.getElementById('wiz-pl-on').checked) {
      document.querySelectorAll('#wiz-pl-list .wiz-pl-row').forEach(row => {
        const spanI  = (parseInt(row.querySelector('.wiz-pl-span').value) || 1) - 1;
        const pos_pl = parseFloat(row.querySelector('.wiz-pl-pos').value) || 0.5;
        const fy_pl  = parseFloat(row.querySelector('.wiz-pl-fy').value)  || 0;
        const beamIdx = (ohL > 0 ? 1 : 0) + spanI;
        const bmTarget = beams[beams.length - allSpans.length + beamIdx];
        if (bmTarget && fy_pl !== 0) {
          loads.push({ id: nextId.load++, type: 'beam_point', elementId: bmTarget.id, fy: fy_pl, pos: pos_pl, caseId: lcDl });
        }
      });
    }

    // "Apply Self-Weight": only to the beams this wizard just made, under the
    // dead-load case. applySelfWeight() reads its scope from the selection, so
    // borrow it for the call and put the user's own selection back after.
    if (applySW) {
      const prevSel = multiSel.beams;
      multiSel.beams = new Set(wizBeamIds);
      try { applySelfWeight(0, lcDl, 'sel'); }
      finally { multiSel.beams = prevSel; }
    }

    updateNodeTable(); updateBeamTable(); updateLoadTable();
    fitToScreen(); render();
    closeModal('modal-wizard');
    toast(`Wizard: ${spans.length}-span beam generated (${allSpans.length} members total)`, 'success');
  }

  // ── mirrorStructure ───────────────────────────────────────────────
  function mirrorStructure(axis, value, action) {
    snapshot();
    if (action === 'replace') {
      for (const nd of nodes) {
        if (axis === 'y') nd.x = 2 * value - nd.x;
        else              nd.y = 2 * value - nd.y;
      }
    } else {
      // Copy: use selection if active, else all
      const scope = multiSel.nodes.size > 0 ? [...multiSel.nodes] : nodes.map(n => n.id);
      const nodeMap = {};
      for (const nid of scope) {
        const nd = findNode(nid); if (!nd) continue;
        const nx = axis === 'y' ? 2 * value - nd.x : nd.x;
        const ny = axis === 'x' ? 2 * value - nd.y : nd.y;
        const exist = nodes.find(n => Math.abs(n.x-nx)<1e-6 && Math.abs(n.y-ny)<1e-6);
        if (exist) { nodeMap[nid] = exist.id; continue; }
        const newId = nextId.node++;
        nodeMap[nid] = newId;
        nodes.push({ id:newId, x:nx, y:ny, support: nd.support,
          springKx:nd.springKx, springKy:nd.springKy, springKm:nd.springKm });
      }
      const bScope = multiSel.beams.size > 0
        ? beams.filter(b => multiSel.beams.has(b.id))
        : beams.filter(b => scope.includes(b.node1) && scope.includes(b.node2));
      for (const bm of bScope) {
        const n1 = nodeMap[bm.node1], n2 = nodeMap[bm.node2];
        if (!n1 || !n2) continue;
        if (beams.find(b=>(b.node1===n1&&b.node2===n2)||(b.node1===n2&&b.node2===n1))) continue;
        beams.push({ id:nextId.beam++, node1:n1, node2:n2, sectionId:bm.sectionId,
          hingeStart:bm.hingeStart, hingeEnd:bm.hingeEnd });
      }
    }
    updateNodeTable(); updateBeamTable(); render();
    toast('Mirror applied', 'success');
  }

  // ── applySelfWeight ───────────────────────────────────────────────
  function applySelfWeight(rhoOverride, caseId, scope) {
    const targets = scope === 'sel' && multiSel.beams.size > 0
      ? beams.filter(b => multiSel.beams.has(b.id))
      : beams;
    let count = 0, replaced = 0;
    snapshot();
    for (const bm of targets) {
      const sec = sections.find(s => s.id === bm.sectionId); if (!sec) continue;
      const rho = rhoOverride > 0 ? rhoOverride : (sec.rho || 0);
      if (!rho) continue;
      const A_m2 = sec.A / 1e4;
      // fwgt (ETABS-style self-weight multiplier) is advertised in
      // design/modifiers.js but was never read here.
      const fwgt = stiffMod(bm, sec, 'fwgt');
      const w = -(rho * A_m2 * fwgt);   // kN/m downward

      // Replace this member's existing self-weight rather than stacking another
      // one on top. Invoking the command twice used to silently double the dead
      // load, with nothing in the UI to show it had happened.
      const before = loads.length;
      loads = loads.filter(ld => !(ld.selfWeight && ld.elementId === bm.id && ld.caseId === caseId));
      replaced += before - loads.length;

      loads.push({ id:nextId.load++, type:'beam_dist', elementId:bm.id,
                   fx:0, fy:w, m:0, caseId, selfWeight:true });
      count++;
    }
    updateLoadTable(); render();
    if (cfg.autoSolve && count > 0) solve();
    toast(count > 0
            ? `Self-weight applied to ${count} beam(s)` +
              (replaced > 0 ? ` (${replaced} existing replaced)` : '')
            : 'No beams have density set.',
          count > 0 ? 'success' : 'error');
  }

  // ── Detect design code from selector ─────────────────────────────
  function getDesignCode() {
    const sel = document.getElementById('design-code-sel');
    if (!sel) return 'EC3';
    const v = sel.value || 'auto';
    if (v === 'ACI') return 'ACI';
    if (v === 'EC2') return 'EC2';
    if (v === 'auto') {
      // Auto-detect: look at sections — if any concrete section, prefer EC2/ACI
      const hasConcrete = sections.some(s => s.E && s.E < 50 && s.fy && s.fy < 50);
      return hasConcrete ? 'EC2' : 'EC3';
    }
    return 'EC3';
  }

  // ── Capture SVG canvas as data URI ───────────────────────────────
  function captureSVG() {
    const svgEl = document.getElementById('canvas');
    if (!svgEl) return null;
    // Styles must be inlined here too, or the report embeds an unstyled canvas.
    if (window.FileIO && FileIO.svgDataURI) return FileIO.svgDataURI(svgEl);
    try {
      return 'data:image/svg+xml;charset=utf-8,' +
             encodeURIComponent(new XMLSerializer().serializeToString(svgEl));
    } catch (e) { return null; }
  }

  // ── generateHTMLReport ────────────────────────────────────────────
  function generateHTMLReport() {
    if (window.ReportGenerator) {
      ReportGenerator.openInWindow({
        title:       projectMeta.title,
        projectName: projectMeta.title,
        engineer:    projectMeta.engineer,
        company:     projectMeta.company,
        date:        new Date().toLocaleDateString(),
        svgCanvas:   captureSVG(),
        nodes, beams, sections, loads,
        results:       getActiveResults(),
        designResults,
        loadCases,
        designCode:  getDesignCode(),
        // Carried through only if a spectrum has actually been run this
        // session; the report leaves the section out entirely otherwise.
        spectrum:    _spectrumData
      });
    } else {
      toast('ReportGenerator not loaded', 'error');
    }
  }

  // ── generateSummaryReport ─────────────────────────────────────────
  function generateSummaryReport() {
    if (window.ReportGenerator) {
      ReportGenerator.openSummaryInWindow({
        title:       projectMeta.title,
        projectName: projectMeta.title,
        engineer:    projectMeta.engineer,
        company:     projectMeta.company,
        date:        new Date().toLocaleDateString(),
        svgCanvas:   captureSVG(),
        nodes, beams, sections, loads,
        results:       getActiveResults(),
        designResults,
        loadCases,
        designCode:  getDesignCode()
      });
    } else {
      toast('ReportGenerator not loaded', 'error');
    }
  }

  // ── Design tab ────────────────────────────────────────────────────
  //
  // Every result set a member could be governed by. Design used to run against
  // getActiveResults() alone — whichever case or combination happened to be
  // selected in the display dropdown — so with a generated ASCE 7 set of a
  // dozen combinations, eleven of them were never checked.
  //
  // The component envelope is deliberately NOT used here. Its worst N and
  // worst M can come from different combinations, which is over-conservative
  // for an interaction check and not a state the structure ever occupies. The
  // correct answer is to evaluate each combination in full and keep the worst
  // utilisation per member, which is what ETABS and SAP report as "governing".
  function designSourceSets() {
    const combos = loadCombos.filter(cb => allComboResults[cb.id])
                             .map(cb => ({ label: cb.name || ('Combo ' + cb.id),
                                           kind: 'combo', res: allComboResults[cb.id] }));
    if (combos.length) return combos;
    return loadCases.filter(lc => allCaseResults[lc.id])
                    .map(lc => ({ label: lc.name || ('Case ' + lc.id),
                                  kind: 'case', res: allCaseResults[lc.id] }));
  }

  // Merge per-beam design results, keeping the worst utilisation and noting
  // which set produced it.
  function mergeWorstByBeam(runs) {
    const byId = new Map();
    for (const { label, out } of runs) {
      if (!out || !out.byBeam) continue;
      for (const bd of out.byBeam) {
        const prev = byId.get(bd.id);
        const eta  = Number.isFinite(bd.maxEta) ? bd.maxEta : -Infinity;
        if (!prev || eta > (Number.isFinite(prev.maxEta) ? prev.maxEta : -Infinity)) {
          byId.set(bd.id, Object.assign({}, bd, { governedBy: label }));
        }
      }
    }
    return [...byId.values()];
  }

  /**
   * Concrete cylinder strength for a section, and where it came from.
   *
   * Both code paths used to read it straight off `sec.fy`, which on a concrete
   * section historically doubles as f'c. That holds for the built-in
   * `Conc 9"×9"` (fy = 27.6 MPa) but not for the sections the default frame
   * generator writes, which carry `fy: 420` — a REBAR grade. So every check on
   * those members was run with 420 MPa concrete.
   *
   * Under ACI it merely inflated the capacity and passed quietly. Under EC2 it
   * collapsed the N-M envelope outright: NRd,max came out NEGATIVE (-32,000 kN),
   * M_Rd fell to zero at every axial load, and the check returned its
   * "way over" sentinel of eta = 9 for every column.
   *
   * EC2 covers C12/15 to C90/105, so a value above 100 MPa is not a concrete
   * strength — it is a rebar grade in the wrong field, and is treated as one.
   */
  const FCK_MAX = 100;                 // EN 1992-1-1 tops out at C90/105
  const FCK_DEFAULT = 30;

  function concreteStrengthFor(sec) {
    if (sec.fck > 0 && sec.fck <= FCK_MAX) return { fck: sec.fck, from: 'section fck' };

    const mat = sec.materialId != null ? findMaterial(sec.materialId) : null;
    if (mat && mat.fc > 0 && mat.fc <= FCK_MAX)
      return { fck: mat.fc, from: `material ${mat.name}` };

    if (sec.fy > 0 && sec.fy <= FCK_MAX) return { fck: sec.fy, from: "section fy (f'c)" };

    // Nothing usable. Say so rather than designing to an invented strength.
    return {
      fck: FCK_DEFAULT, from: 'assumed',
      warn: sec.fy > FCK_MAX
        ? `${sec.name}: fy = ${sec.fy} MPa is a rebar grade, not a concrete strength — ` +
          `checks assume f'c = ${FCK_DEFAULT} MPa. Set a concrete material on this section.`
        : `${sec.name}: no concrete strength on the section or its material — ` +
          `checks assume f'c = ${FCK_DEFAULT} MPa.`
    };
  }

  /**
   * Longitudinal steel area from the bar layout in Define ▸ Sections ▸ Rebar.
   *
   * That dialog records a full arrangement — bars along each face, bar and
   * corner-bar areas, cover, confinement — and nothing read a line of it.
   * Both codes fell back to their own minimum instead: ACI to rho,min = 1%
   * and EC2 to max(0.10·NEd/fyd, 0.002·Ac) ≈ 0.2%. A 400×400 column detailed
   * with 12 #9 bars (7740 mm², 4.8%) was therefore checked as though it held
   * 320 mm², which is why its EC2 N-M utilisation came out at 8.5.
   *
   * Perimeter count for a rectangular arrangement: the two faces along each
   * axis share their corner bars, so n = 2·n3 + 2·n2 − 4, of which 4 are
   * corner bars and may be a different size.
   *
   * Returns 0 when no layout has been set, which both codes already read as
   * "no layout given — assume the code minimum".
   */
  function rebarAreaOf(sec) {
    const r = sec && sec.rebar;
    if (!r) return 0;
    const n3 = Math.max(2, +r.barsAlong3 || 0);
    const n2 = Math.max(2, +r.barsAlong2 || 0);
    const total = 2 * n3 + 2 * n2 - 4;
    if (!(total > 0)) return 0;
    const inner = Math.max(0, total - 4);
    const Abar  = +r.barArea > 0 ? +r.barArea : 0;
    const Acorn = +r.cornerBarArea > 0 ? +r.cornerBarArea : Abar;
    const As = 4 * Acorn + inner * Abar;
    return As > 0 ? As : 0;
  }

  /** Rebar yield for a section: an out-of-range `fy` is exactly that. */
  function rebarGradeFor(sec, bm, dflt) {
    if (bm && bm.fy_rebar > 0) return bm.fy_rebar;
    if (sec.fy > FCK_MAX) return sec.fy;          // 420, 500 — a bar grade
    const mat = sec.materialId != null ? findMaterial(sec.materialId) : null;
    if (mat && mat.fy > FCK_MAX) return mat.fy;
    return dflt;
  }

  // Run the full suite (EC3, augmented with ACI/EC2 for concrete) against ONE
  // result set. runDesignChecks() below calls this once per load combination.
  function checkAgainst(srcRes, codeMode) {
    const dr = DesignChecks.runDesignChecks(srcRes, beams, sections, nodes);
    // One entry per distinct problem, not one per member per combination.
    const concreteWarnings = new Set();

    if (codeMode !== 'EC3' && dr && dr.byBeam) {
      for (const bd of dr.byBeam) {
        const bm  = beams.find(b => b.id === bd.id);
        if (!bm) continue;
        const sec = sections.find(s => s.id === bm.sectionId);
        if (!sec) continue;
        const ef  = srcRes.elemForces.find(e => e.id === bd.id);
        if (!ef) continue;

        const b_m = sec.bf ? sec.bf / 1000 : 0.3;
        const h_m = sec.d  ? sec.d  / 1000 : 0.6;

        // Effective length for the concrete column checks.
        //
        // The per-member Lcr override and the Ky/Kz factors are already set
        // in the design table and the member dialog, and EC3 has always used
        // them — but neither the ACI nor the EC2 branch below was told about
        // them, so every concrete column was slenderness-checked as if
        // pinned-pinned over its own length. A fixed-base cantilever column
        // really wants k = 2.0, which is where the difference matters most.
        //
        // Both concrete checks reduce to a SINGLE slenderness (EC2 works from
        // ic = h/sqrt(12), ACI from one k*lu), so the more onerous of the two
        // axes is the honest value to feed them. An explicit Lcr override
        // already IS the effective length, so it becomes k directly.
        const _Ky  = bm.Ky != null ? bm.Ky : 1.0;
        const _Kz  = bm.Kz != null ? bm.Kz : 1.0;
        const kEff = (bm.Lcr > 0 && ef.L > 0) ? bm.Lcr / ef.L : Math.max(_Ky, _Kz);

        // Resolve which code to use for this section
        const isConcrete = (window.RCDesign && RCDesign.isRC(sec)) ||
                           (window.ACIDesign && ACIDesign.isACI(sec));
        if (!isConcrete) continue;  // steel sections stay with EC3

        const useACI = codeMode === 'ACI' ||
                       (codeMode === 'auto' && window.ACIDesign && ACIDesign.isACI(sec));
        const useEC2 = !useACI && (codeMode === 'EC2' ||
                       (codeMode === 'auto' && window.RCDesign && RCDesign.isRC(sec)));

        let newChecks = null, modeLabel = '', modeNote = '';

        // Concrete strength is resolved here, once, and handed to whichever
        // code runs. Both used to dig it out of sec.fy themselves and both
        // got 420 MPa for the default frame's columns and beams.
        const cs = concreteStrengthFor(sec);
        if (cs.warn) concreteWarnings.add(cs.warn);
        const strengthNote = ` f'c/fck = ${cs.fck} MPa (${cs.from}).`;

        if (useACI && window.ACIDesign) {
          newChecks = ACIDesign.runACIChecks(ef, sec, {
            b: b_m, h: h_m,
            fc:         cs.fck,             // f'c [MPa], resolved above
            fy_rebar:   rebarGradeFor(sec, bm, 420),
            Ast:        rebarAreaOf(sec),   // the bar layout, if one was set
            cover:      bm.cover    || 40,
            phi_bar:    bm.phi_bar  || 19,
            k:          kEff,               // §6.6.4 effective length factor
            memberType: getMemberType(bm)   // 'column' | 'beam' | 'brace'
          });
          modeLabel = '⚙ ACI 318-19 Mode';
          modeNote  = 'ACI 318-19 strength design checks (φMn, φVn, column P-M interaction).' +
                      strengthNote;

        } else if (useEC2 && window.RCDesign) {
          newChecks = RCDesign.runRCChecks(ef, sec, {
            b: b_m, h: h_m,
            fck: cs.fck,                    // resolved above, never sec.fy blind
            fyk: rebarGradeFor(sec, bm, 500),
            As_col: rebarAreaOf(sec),       // the bar layout, if one was set
            cover: bm.cover || 35, phi: bm.phi || 16,
            l0: kEff * (ef.L || 0),         // EC2 5.8.3.2 effective height
            // The ACI branch has always been told what kind of member this is;
            // EC2 was not, so it could never run its column checks.
            memberType: getMemberType(bm)   // 'column' | 'beam' | 'brace'
          });
          modeLabel = '⚙ EC2 Mode';
          modeNote  = 'EN 1992-1-1 (EC2) reinforcement design checks applied for concrete section.' +
                      strengthNote;
        }

        if (newChecks) {
          bd.checks = [
            { check: modeLabel, status: 'INFO', pass: true, eta: null, note: modeNote },
            ...newChecks
          ];
          const etas = bd.checks.map(c => c.eta).filter(e => e != null && Number.isFinite(e));
          bd.maxEta  = etas.length ? +Math.max(...etas).toFixed(4) : 0;
          // Statuses arrive qualified — 'FAIL (strut)', 'WARN (slender…)' — and
          // exact equality matched none of them, so an EC2 strut-crushing
          // failure rolled up to an overall verdict of OK.
          const cls_ = s => (window.DesignChecks ? DesignChecks.classifyStatus(s)
                                                 : (s === 'FAIL' ? 'FAIL' : s === 'NEAR' ? 'NEAR' : 'OK'));
          const fails = bd.checks.filter(c => cls_(c.status) === 'FAIL').length;
          const nears = bd.checks.filter(c => cls_(c.status) === 'NEAR').length;
          bd.overall  = fails > 0 ? 'FAIL' : nears > 0 ? 'NEAR' : 'OK';
          bd.cls = useACI ? 'ACI-RC' : 'RC';
        }
      }
    }
    // A member designed against an assumed strength is not a detail to bury in
    // a note: it changes every number in its row.
    if (concreteWarnings.size) {
      dr.concreteWarnings = [...concreteWarnings];
    }
    return dr;
  }

  // Summary counts over a merged byBeam list.
  function summariseDesign(byBeam) {
    return {
      total: byBeam.length,
      pass:  byBeam.filter(b => b.overall === 'OK').length,
      near:  byBeam.filter(b => b.overall === 'NEAR').length,
      fail:  byBeam.filter(b => b.overall === 'FAIL').length,
      globalStatus: byBeam.some(b => b.overall === 'FAIL') ? 'FAIL'
        : byBeam.some(b => b.overall === 'NEAR') ? 'NEAR' : 'OK'
    };
  }

  function runDesignChecks() {
    const res = getActiveResults();
    if (!res || !res.success) { toast('Solve first, then run design checks', 'warn'); return; }
    if (!window.DesignChecks)  { toast('DesignChecks module not loaded', 'error'); return; }

    const codeMode = (document.getElementById('design-code-sel') || {}).value || 'auto';

    // Check EVERY combination and keep the worst utilisation per member.
    const sets = designSourceSets();
    const runs = (sets.length ? sets : [{ label: 'Active display', res }])
      .map(s => ({ label: s.label, out: checkAgainst(s.res, codeMode) }))
      .filter(r => r.out && r.out.byBeam);

    if (!runs.length) { toast('No results to check', 'warn'); return; }

    const byBeam = mergeWorstByBeam(runs);
    const codeLbl = { auto:'Auto', ACI:'ACI 318-19', EC2:'EC2', EC3:'EC3' }[codeMode] || codeMode;
    designResults = Object.assign({}, runs[0].out, {
      byBeam,
      checkedSets: runs.map(r => r.label),
      summary: summariseDesign(byBeam),
      // Travels with the results so an export cannot misreport the standard.
      codeMode, codeLabel: codeLbl
    });

    updateDesignTable();

    // Show the table that was just built. The design results live in a section
    // of the Results pane, so running the checks from the Design ribbon tab —
    // or from anywhere other than that pane — filled in a table the user was
    // not looking at and left them on whichever pane they started from, with
    // only a toast to say anything had happened.
    switchPane('results');
    document.getElementById('pane-design')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const s = designResults.summary;
    const scope = runs.length > 1 ? ` over ${runs.length} combinations` : '';
    toast(`[${codeLbl}] Design checks${scope}: ${s.pass} OK · ${s.near} Near · ${s.fail} Fail`,
          s.fail > 0 ? 'warn' : 'ok');
  }

  function updateDesignTable() {
    const tbody = document.querySelector('#tbl-design tbody');
    if (!tbody) return;
    if (!designResults) { tbody.innerHTML = '<tr><td colspan="5" style="color:#888;text-align:center">Run Checks first</td></tr>'; return; }

    const STATUS_COL = { OK:'#2e7d32', NEAR:'#e65100', FAIL:'#c62828' };
    tbody.innerHTML = designResults.byBeam.map(b => {
      const col = STATUS_COL[b.overall] || '#555';
      const pct = Math.min(100, b.maxEta * 100).toFixed(0);
      const bar = `<div style="width:60px;height:7px;background:#e0e0e0;border-radius:4px;display:inline-block;vertical-align:middle;margin-right:4px;">
        <div style="width:${pct}%;height:100%;background:${col};border-radius:4px;"></div></div>
        <span style="font-size:11px;color:${col};font-weight:600;">${b.maxEta.toFixed(3)}</span>`;
      const modbadge = (window.PropertyModifiers && PropertyModifiers.isModified(b.id))
        ? PropertyModifiers.summaryBadge(b.id) : '';
      // Which combination drove this member's worst utilisation.
      const gov = b.governedBy
        ? `<div style="font-size:9px;color:var(--text-sec);margin-top:1px">gov: ${escapeIssue(b.governedBy)}</div>` : '';
      return `<tr>
        <td>${escapeIssue(b.label)}</td>
        <td style="font-size:11px">${escapeIssue(b.secName)}${modbadge}${gov}</td>
        <td>${bar}</td>
        <td><span style="padding:1px 6px;border-radius:10px;background:${col}22;color:${col};font-size:11px;font-weight:700;">${b.overall}</span></td>
        <td style="text-align:center">
          <button class="btn-xs" onclick="App._openCheckDetail(${b.id})" title="View check details" style="padding:1px 5px;">🔍</button>
          <button class="btn-xs" onclick="App._openModifiers(${b.id})" title="Property modifiers" style="padding:1px 5px;">⚙</button>
          <button class="btn-xs${b.overall==='FAIL'?' btn-red':b.overall==='NEAR'?' btn-orange':''}" onclick="App._openChangeSection(${b.id})" title="Change/edit section" style="padding:1px 5px;">📐</button>
        </td>
      </tr>`;
    }).join('');

    // Update summary badge
    const sumEl = document.getElementById('design-summary');
    if (sumEl && designResults.summary) {
      const s = designResults.summary;
      const col = s.globalStatus === 'FAIL' ? '#c62828' : s.globalStatus === 'NEAR' ? '#e65100' : '#2e7d32';
      sumEl.innerHTML = `<span style="color:${col};font-weight:700;">Overall: ${s.globalStatus}</span>
        &nbsp; ✓ ${s.pass} OK &nbsp; ⚠ ${s.near} Near &nbsp; ✗ ${s.fail} Fail`;
    }
    // Ribbon badge — previously only ever cleared, so it stayed blank forever
    const dcBadge = document.getElementById('design-checks-badge');
    if (dcBadge && designResults.summary) {
      const s2 = designResults.summary;
      dcBadge.textContent = s2.fail ? `${s2.fail} FAIL` : s2.near ? `${s2.near} NEAR` : `${s2.pass} OK`;
    }

    // Update Lcr / K-factor table
    const lcrtbody = document.querySelector('#tbl-lcr tbody');
    if (lcrtbody) {
      lcrtbody.innerHTML = beams.map(bm => {
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        const L = ni && nj ? memberLength(ni, nj).toFixed(3) : '?';
        const inp = (field, val, step, title) =>
          `<input type="number" style="width:54px;padding:2px 3px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:3px;font-size:10px;"
            value="${val}" step="${step}" min="0"
            onchange="App._setLcr(${bm.id}, '${field}', +this.value)"
            title="${title}">`;
        return `<tr>
          <td style="font-size:11px">B${bm.id}<br><span style="color:var(--text-sec);font-size:10px">L=${L}m</span></td>
          <td>${inp('Lcr', bm.Lcr || 0, 0.1, `Lcr override — 0 = use beam length (${L} m)`)}</td>
          <td>${inp('Ky',  bm.Ky  != null ? bm.Ky : 1.0, 0.05, 'Major-axis K-factor: 0.5=fix-fix, 0.7=fix-pin, 1.0=pin-pin, 2.0=cantilever')}</td>
          <td>${inp('Kz',  bm.Kz  != null ? bm.Kz : 1.0, 0.05, 'Minor-axis K-factor (out-of-plane buckling)')}</td>
        </tr>`;
      }).join('');
    }
  }

  // ── Human-readable labels for every check parameter ─────────────────────
  // Each entry: [ 'Full Description', 'Symbol / Notation', 'unit' ]
  const PARAM_META = {
    // ── Section Classification ───────────────────────────────────────────────
    cls:              ['Section class',                        'Class',         ''],
    epsilon:          ['Epsilon — yield strength factor',      'ε = √(235/fy)', ''],
    flange:           ['Flange classification',                'Flange class',  ''],
    web:              ['Web classification',                   'Web class',     ''],
    c_flange:         ['Flange outstand (c)',                  'c_flange',      'mm'],
    c_web:            ['Web clear height (c)',                 'c_web',         'mm'],
    c_flange_ratio:   ['Flange slenderness',                   'c/t_f',         ''],
    c_web_ratio:      ['Web slenderness',                      'c/t_w',         ''],
    limits_flange:    ['Flange class 1/2/3 limits',            'c/t_f limits',  ''],
    limits_web:       ['Web class 1/2/3 limits',               'c/t_w limits',  ''],

    // ── Axial — tension ──────────────────────────────────────────────────────
    Nt_Rd:            ['Tensile resistance (gross section)',    'N_t,Rd',        'kN'],
    isTension:        ['Member is in tension',                 'Tension',       ''],

    // ── Axial — compression / buckling ───────────────────────────────────────
    N_Ed:             ['Design axial force (compression +)',   'N_Ed',          'kN'],
    Npl_Rd:           ['Gross cross-section axial resistance', 'N_pl,Rd',       'kN'],
    Nb_Rd:            ['Flexural buckling resistance',         'N_b,Rd = χAfy/γM1', 'kN'],
    Ncr_y:            ['Elastic critical load — major axis',   'N_cr,y (y-y)',  'kN'],
    Ncr_z:            ['Elastic critical load — minor axis',   'N_cr,z (z-z)',  'kN'],
    lambda_y:         ['Non-dim. slenderness — major axis',    'λ̄_y = √(Afy/Ncr,y)', ''],
    lambda_z:         ['Non-dim. slenderness — minor axis',    'λ̄_z = √(Afy/Ncr,z)', ''],
    SR_y:             ['Slenderness ratio — major axis',       'KL/r_y',        ''],
    SR_z:             ['Slenderness ratio — minor axis',       'KL/r_z',        ''],
    chi_y:            ['Buckling reduction factor — major axis','χ_y',           ''],
    chi_z:            ['Buckling reduction factor — minor axis','χ_z',           ''],
    chi:              ['Governing buckling reduction factor',   'χ = min(χ_y, χ_z)', ''],
    curveY:           ['EC3 buckling curve — major axis',      'Curve (y-y)',   ''],
    curveZ:           ['EC3 buckling curve — minor axis',      'Curve (z-z)',   ''],
    Ky:               ['Effective length factor — major axis', 'K_y',           ''],
    Kz:               ['Effective length factor — minor axis', 'K_z',           ''],
    Lcr_y:            ['Effective buckling length — major',    'L_cr,y = K_y·L','m'],
    Lcr_z:            ['Effective buckling length — minor',    'L_cr,z = K_z·L','m'],
    Lcr:              ['Effective buckling length (override)',  'L_cr',          'm'],
    johnson_note:     ['Column type — Johnson vs Euler',       'Column type',   ''],

    // ── Flexure ──────────────────────────────────────────────────────────────
    M_Ed:             ['Design bending moment (max of ends)',  'M_Ed',          'kNm'],
    Mc_Rd:            ['Cross-section bending resistance',     'M_c,Rd = W·fy/γM0', 'kNm'],
    MB_Rd:            ['LTB bending resistance (χ_LT × Mc)',   'M_b,Rd (LTB)', 'kNm'],
    Mb_Rd:            ['Governing bending resistance',         'M_b,Rd (governing)', 'kNm'],
    modulus:          ['Section modulus used in calculation',  'W (modulus)',   'cm³'],
    modulus_label:    ['Type of section modulus',              'Modulus type',  ''],
    Mcr:              ['Elastic critical moment for LTB',      'M_cr',          'kNm'],
    lambdaLT:         ['LTB non-dim. slenderness',             'λ̄_LT = √(W·fy/Mcr)', ''],
    chiLT:            ['LTB reduction factor',                 'χ_LT',          ''],
    ltbCurve:         ['LTB buckling curve (EC3 6.3.2)',       'LTB curve',     ''],
    ltb_note:         ['Lateral-torsional buckling result',    'LTB status',    ''],
    section_cls:      ['Section class (for flexure check)',    'Section class', ''],

    // ── Shear ────────────────────────────────────────────────────────────────
    V_Ed:             ['Design shear force (max of ends)',     'V_Ed',          'kN'],
    Vpl_Rd:           ['Plastic shear resistance',             'V_pl,Rd = Av·fy/(√3·γM0)', 'kN'],
    Av_cm2:           ['Shear area (effective web area)',      'A_v',           'cm²'],
    hw_tw:            ['Web slenderness for shear buckling',   'h_w / t_w',     ''],
    shear_buckling_note: ['Shear buckling check note',         'Shear buckling',''],
    rho_V:            ['Moment reduction due to high shear',   'ρ (M-V interaction)', ''],
    MV_reduction:     ['M-V interaction effect',               'M-V note',      ''],

    // ── Plate Buckling ───────────────────────────────────────────────────────
    // (elements rendered as sub-table separately)

    // ── Torsion ──────────────────────────────────────────────────────────────
    isOpenSection:    ['Open cross-section (I, H, T, angle)',  'Open section',  ''],
    G_kNm2:           ['Shear modulus G',                      'G',             'GPa'],
    J_cm4:            ['St. Venant torsion constant',          'J (torsional)', 'cm⁴'],
    Cw_cm6:           ['Warping torsion constant',             'C_w (warping)', 'cm⁶'],
    tau_Rd_kNm2:      ['Torsional shear resistance',           'τ_Rd = fy/(√3·γM0)', 'MPa'],
    Tt_pl_Rd:         ['Plastic torsional resistance',         'T_t,pl,Rd',     'kNm'],
    warning:          ['Torsion design note',                  'Warning',       ''],

    // ── Combined N+M Interaction (EC3 6.3.3 Method 2) ──────────────────────
    // N_Ed, M_Ed, Nb_Rd, Mb_Rd already defined above
    kyy:              ['Interaction factor — major axis bend', 'k_yy (EC3 Annex B, Table B.1)', ''],
    kzy:              ['Interaction factor — minor axis bend', 'k_zy = 0.6·k_yy', ''],
    eta_6_61:         ['Utilisation — EC3 Eq.6.61 (major axis buckling)', 'η(6.61) = N/χNpl + kyy·M/χ_LT·Mpl', ''],
    eta_6_62:         ['Utilisation — EC3 Eq.6.62 (minor axis buckling)', 'η(6.62) = N/χ_z·Npl + kzy·M/χ_LT·Mpl', ''],
    governing:        ['Governing interaction equation',       'Governing eq.', ''],

    // ── Deflection ───────────────────────────────────────────────────────────
    v_max_mm:         ['Maximum end-node deflection',         'δ_max',         'mm'],
    limit_mm:         ['Serviceability deflection limit',      'δ_limit',       'mm'],
    limit_frac:       ['Deflection limit fraction',            'Limit fraction',''],
    L_m:              ['Beam span length',                     'L',             'm'],

    // ── Property Modifiers ───────────────────────────────────────────────────
    active:           ['Modifiers applied to section',         'Modifiers active',''],

    // ── Common / shared ──────────────────────────────────────────────────────
    eta:              ['Utilisation ratio (demand / capacity)', 'η = Ed / Rd',  '≤ 1.0'],
    note:             ['Design note or reference',             'Note',          ''],
    L:                ['Member length',                        'L',             'm'],

    // ── ACI 318-19 Material Properties ───────────────────────────────────────
    fcprime_MPa:      ["Specified concrete comp. strength f'c", "f'c",           'MPa'],
    fy_rebar_MPa:     ['Rebar yield strength (longitudinal)',   'fy (rebar)',    'MPa'],
    Ec_MPa:           ['Modulus of elasticity (ACI §19.2.2)',   'Ec = 4700√f\'c','MPa'],
    fr_MPa:           ['Modulus of rupture (ACI §19.2.3)',      'fr = 0.62λ√f\'c','MPa'],
    beta1:            ['Stress block depth factor (ACI §22.2.2.4.3)', 'β₁',    ''],
    eps_cu:           ['Ultimate concrete strain',              'ε_cu = 0.003', ''],
    lambda:           ['Normal-weight concrete factor',         'λ',             ''],

    // ── ACI Flexure ───────────────────────────────────────────────────────────
    phi:              ['Strength reduction factor φ (flexure)', 'φ',             ''],
    phiMn:            ['Design flexural strength',              'φMn',           'kNm'],
    Mn_kNm:           ['Nominal flexural strength',             'Mn',            'kNm'],
    As_req_mm2:       ['Required tension steel area',           'As,req',        'mm²'],
    As_min_mm2:       ['Minimum tension steel (ACI §9.6.1.2)',  'As,min',        'mm²'],
    As_prov_mm2:      ['Provided (design) tension steel area',  'As,prov',       'mm²'],
    a_mm:             ['Depth of equiv. stress block',          'a = As·fy/(0.85f\'c·b)', 'mm'],
    c_mm:             ['Neutral axis depth from comp. face',    'c = a/β₁',      'mm'],
    d_eff_mm:         ['Effective depth to tension steel',      'd',             'mm'],
    eps_t:            ['Net tensile strain in tension steel',   'ε_t',           ''],
    phi_zone:         ['Strain classification zone',            'φ zone',        ''],

    // ── ACI Shear ─────────────────────────────────────────────────────────────
    phi_shear:        ['Shear strength reduction factor',       'φ (shear)',     ''],
    phiVc:            ['Design concrete shear strength',        'φVc',           'kN'],
    Vc_kN:            ['Nominal concrete shear strength',       'Vc = 0.17λ√f\'c·bw·d', 'kN'],
    Vs_req_kN:        ['Required steel shear contribution',     'Vs,req',        'kN'],
    Vs_max_kN:        ['Maximum steel shear (§22.5.1.2)',       'Vs,max = 0.66√f\'c·bw·d', 'kN'],
    Av_s_req:         ['Required stirrup area ratio',           'Av/s,req',      'mm²/mm'],
    Av_s_min:         ['Minimum stirrup area ratio (§9.6.3.4)', 'Av/s,min',      'mm²/mm'],
    Av_s_design:      ['Design stirrup area ratio',             'Av/s,design',   'mm²/mm'],
    bw_mm:            ['Beam web width',                        'bw',            'mm'],
    sqrt_fcprime:     ["Square root of f'c",                    '√f\'c',         '√MPa'],
    struts_ok:        ['Compression strut check (Vs ≤ Vs,max)', 'Struts OK',     ''],
    no_links_needed:  ['Stirrups not required (Vu ≤ 0.5φVc)',   'No links',      ''],

    // ── ACI Column ────────────────────────────────────────────────────────────
    phi_col:          ['Column strength reduction factor',       'φ (column)',    ''],
    phiPn0_kN:        ['Design axial (pure compression)',        'φPn0',          'kN'],
    phiMn0_kNm:       ['Design moment (pure bending)',           'φMn0',          'kNm'],
    Ast_use_mm2:      ['Longitudinal steel area (design)',       'Ast',           'mm²'],
    Ast_min_mm2:      ['Minimum steel: ρg = 1% · Ag',           'Ast,min (1%)',  'mm²'],
    Ast_max_mm2:      ['Maximum steel: ρg = 8% · Ag',           'Ast,max (8%)',  'mm²'],
    rho_g_pct:        ['Gross reinforcement ratio',              'ρg = Ast/Ag',  '%'],
    reinf_ok:         ['Reinforcement ratio within ACI limits',  'ρg in range',  ''],
    eta_P:            ['Axial utilization P/φPn',                'η_P = P/φPn',  ''],
    eta_M:            ['Moment utilization M/φMn',               'η_M = M/φMn',  ''],
    interaction_formula: ['Interaction equation used',           'Interaction',   ''],
    column_type:      ['Column tie type and φ factor',           'Column type',  ''],
    Ag_mm2:           ['Gross cross-section area',               'Ag',            'mm²'],

    // ── ACI Reinf. Ratio (beam) ───────────────────────────────────────────────
    rho_pct:          ['Provided reinforcement ratio',           'ρ = As/(bw·d)', '%'],
    rho_min_pct:      ['Minimum reinforcement ratio',            'ρ,min',         '%'],
    rho_max_pct:      ['Maximum reinforcement ratio (ε_t=0.004)','ρ,max',         '%'],
    // As_prov_mm2 is defined once above, under the ACI flexure group.
    As_max_mm2:       ['Max steel (ε_t ≥ 0.004 limit)',          'As,max',        'mm²'],

    // ── ACI Deflection / min h ────────────────────────────────────────────────
    l_eff_m:          ['Member span (effective length)',          'ℓ_eff',         'm'],
    h_actual_mm:      ['Actual member depth',                    'h',             'mm'],
    h_min_mm:         ['ACI Table 9.3.1.1 minimum depth',        'h,min = ℓ/n',  'mm'],
    l_div_h:          ['Span-to-depth ratio',                    'ℓ/h',           ''],
    member_type:      ['Member support condition',               'Member type',   ''],

    // ── ACI column reinf. ratio ───────────────────────────────────────────────
    Ast_mm2:          ['Longitudinal steel area',                'Ast',           'mm²'],

    // ── ACI Slenderness (§6.6.4) ──────────────────────────────────────────────
    klu_r:            ['Slenderness ratio klu/r',                'klu/r',         ''],
    limit:            ['ACI §6.2.5 slenderness limit',          'limit',         ''],
    r_mm:             ['Radius of gyration  r = 0.30h',         'r',             'mm'],
    k_factor:         ['Effective length factor',               'k',             ''],
    EI_eff_MNm2:      ['Effective flexural stiffness §6.6.4.4', 'EI_eff',        'MN·m²'],
    Pc_kN:            ['Critical Euler buckling load',          'Pc = π²EI/(klu)²','kN'],
    Cm:               ['Equivalent moment correction',          'Cm',            ''],
    delta_ns:         ['Non-sway moment magnifier',             'δns',           ''],
    magnified:        ['Slenderness magnification applied',     'Magnified',     ''],
    M2_orig_kNm:      ['Original end moment',                   'M₂ (orig)',     'kNm'],
    Mc_kNm:           ['Magnified design moment',               'Mc = δns·M₂',  'kNm'],
    stable:           ['Column stability (Pu < 0.75·Pc)',       'Stable',        ''],

    // ── ACI Development Length (§25.4) ───────────────────────────────────────
    bar:              ['Bar designation and diameter',           'Bar',           ''],
    ld_mm:            ['Tension development length',            'ld',            'mm'],
    ldh_mm:           ['Standard hook development length',      'ldh',           'mm'],
    ldc_mm:           ['Compression development length',        'ldc',           'mm'],
    lap_A_mm:         ['Class-A lap splice length (≤50% spliced)','Lap-A = 1.0ld','mm'],
    lap_B_mm:         ['Class-B lap splice length (all spliced)','Lap-B = 1.3ld', 'mm'],
    psi_t:            ['Top-bar factor ψt (ACI §25.4.2.4)',     'ψt',            ''],
    psi_e:            ['Epoxy factor ψe',                       'ψe',            ''],
    psi_s:            ['Bar-size factor ψs',                    'ψs',            ''],
    psi_g:            ['Grade factor ψg',                       'ψg',            ''],
    cb_ktr:           ['Confinement (cb + Ktr)/db',             '(cb+Ktr)/db',   ''],

    // ── ACI Torsion (§22.7) ──────────────────────────────────────────────────
    Tu_kNm:           ['Factored torsional demand',             'Tu',            'kNm'],
    Tcr_kNm:          ['Cracking torsion λ√f\'c·Acp²/pcp',     'Tcr',           'kNm'],
    Tu_threshold_kNm: ['Threshold: neglect if Tu ≤ φTcr/4',    'φTcr/4',        'kNm'],
    torsion_neglected:['Torsion effects may be neglected',      'Neglected',     ''],
    Aoh_mm2:          ['Area enclosed by hoop centerline',      'Aoh',           'mm²'],
    ph_mm:            ['Perimeter of Aoh',                      'ph',            'mm'],
    At_s_mm2_mm:      ['Required transverse steel per leg',     'At/s',          'mm²/mm'],
    Al_req_mm2:       ['Required longitudinal torsion steel',   'Al,req',        'mm²'],
    Al_design_mm2:    ['Design longitudinal torsion steel',     'Al,design',     'mm²'],
    combined_ok:      ['Combined V+T strut check (§22.7.7.1)', 'Combined OK',   ''],

    // ── ACI Crack Control (§24.3) ────────────────────────────────────────────
    fs_MPa:           ['Estimated service steel stress',        'fs',            'MPa'],
    s_actual_mm:      ['Estimated/actual bar spacing',          's (actual)',    'mm'],
    s_limit_mm:       ['Maximum bar spacing §24.3.2',           's,max',         'mm'],
    spacing_ok:       ['Bar spacing satisfies §24.3.2',         'Spacing OK',    ''],
    wc_mm:            ['Estimated crack width (Frosch 2001)',   'wc',            'mm'],
    wc_limit_mm:      ['Crack width limit (0.33 interior)',     'wc,lim',        'mm'],
    wc_ok:            ['Crack width within limits',            'wc OK',         ''],
  };

  // ── P-M Interaction Diagram SVG renderer ─────────────────────────────────
  function _renderPMDiagram(pts, N_kN, M_kNm) {
    const W = 400, H = 275;
    const mt = 16, mb = 36, ml = 60, mr = 14;
    const iw = W - ml - mr, ih = H - mt - mb;

    // Axis range with padding
    const allP = pts.map(p => p.phi_Pn);
    const allM = pts.map(p => p.phi_Mn);
    const rawMaxP = Math.max(...allP);
    const rawMinP = Math.min(...allP);
    const rawMaxM = Math.max(...allM, 1);
    const pRange = rawMaxP - rawMinP;
    const maxP = rawMaxP + pRange * 0.08;
    const minP = rawMinP - pRange * 0.05;
    const maxM = rawMaxM * 1.18;

    // Scale helpers
    const scX = m => ml + (m / maxM) * iw;
    const scY = p => mt + ih - ((p - minP) / (maxP - minP)) * ih;

    // Nice tick generator
    function niceTicks(lo, hi, n) {
      const rng = hi - lo || 1;
      const raw = rng / n;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      const step = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag;
      const ticks = [];
      let t = Math.ceil(lo / step - 1e-9) * step;
      while (t <= hi + step * 0.01) { ticks.push(+t.toFixed(8)); t += step; }
      return ticks;
    }
    const pTicks = niceTicks(minP, maxP, 5);
    const mTicks = niceTicks(0, maxM, 5);

    // Zone boundaries (sorted pts: descending phi_Pn)
    let P_ccBound = maxP, P_tcBound = minP;
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].zone === 'compression-controlled' && pts[i + 1].zone !== 'compression-controlled')
        P_ccBound = (pts[i].phi_Pn + pts[i + 1].phi_Pn) / 2;
      if (pts[i].zone !== 'tension-controlled' && pts[i + 1].zone === 'tension-controlled')
        P_tcBound = (pts[i].phi_Pn + pts[i + 1].phi_Pn) / 2;
    }
    const y_top  = scY(maxP);
    const y_cc   = scY(P_ccBound);
    const y_tc   = scY(P_tcBound);
    const y_bot  = scY(minP);

    // Envelope path (already sorted high→low phi_Pn; first & last pts have phi_Mn=0)
    const pathD = pts.map((p, i) =>
      `${i === 0 ? 'M' : 'L'}${scX(p.phi_Mn).toFixed(1)} ${scY(p.phi_Pn).toFixed(1)}`
    ).join(' ') + ' Z';   // closes back along M=0 (first point = last point in M)

    // Design point
    const dpX = scX(Math.abs(M_kNm));
    const dpY = scY(N_kN);
    const dpVis = dpY > mt - 12 && dpY < mt + ih + 12 && dpX >= ml - 5 && dpX <= ml + iw + 5;

    const fmtP = v => Math.abs(v) >= 1e4 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
    const fmtM = v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);

    return `
<div style="margin-top:14px;border:1px solid var(--border,#dde);border-radius:8px;overflow:hidden;background:var(--bg-modal,#fff)">
  <div style="padding:6px 10px;background:var(--bg-tbl-alt,#f5f5f5);display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border,#dde)">
    <span style="font-size:12px;font-weight:700;color:var(--text,#333)">φP-φM Interaction Diagram</span>
    <span style="font-size:10px;color:var(--text-sec,#888)">ACI 318-19 §22.4 · Whitney Stress Block</span>
  </div>
  <div style="padding:6px 8px 4px;overflow-x:auto">
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="font-family:'Consolas',monospace;display:block">
      <!-- Zone background bands -->
      <rect x="${ml}" y="${y_top.toFixed(1)}" width="${iw}" height="${Math.max(0, y_cc - y_top).toFixed(1)}" fill="#dbeafe" opacity="0.55"/>
      <rect x="${ml}" y="${y_cc.toFixed(1)}"  width="${iw}" height="${Math.max(0, y_tc - y_cc ).toFixed(1)}" fill="#fef9c3" opacity="0.55"/>
      <rect x="${ml}" y="${y_tc.toFixed(1)}"  width="${iw}" height="${Math.max(0, y_bot - y_tc).toFixed(1)}" fill="#dcfce7" opacity="0.55"/>
      <!-- P=0 horizontal reference -->
      <line x1="${ml}" y1="${scY(0).toFixed(1)}" x2="${ml + iw}" y2="${scY(0).toFixed(1)}" stroke="#999" stroke-width="0.8" stroke-dasharray="5,3"/>
      <!-- Interaction envelope (filled + stroked) -->
      <path d="${pathD}" fill="#1565c01a" stroke="#1565c0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <!-- Axes -->
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ih}" stroke="#444" stroke-width="1.5"/>
      <line x1="${ml}" y1="${mt + ih}" x2="${ml + iw}" y2="${mt + ih}" stroke="#444" stroke-width="1.5"/>
      <!-- P-axis ticks + labels -->
      ${pTicks.map(t => {
        const ty = scY(t);
        if (ty < mt - 4 || ty > mt + ih + 4) return '';
        return `<line x1="${ml - 4}" y1="${ty.toFixed(1)}" x2="${ml}" y2="${ty.toFixed(1)}" stroke="#666" stroke-width="1"/>
                <text x="${ml - 6}" y="${(ty + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#666">${fmtP(t)}</text>`;
      }).join('\n')}
      <!-- M-axis ticks + labels -->
      ${mTicks.map(t => {
        const tx = scX(t);
        if (tx < ml - 4 || tx > ml + iw + 4) return '';
        return `<line x1="${tx.toFixed(1)}" y1="${mt + ih}" x2="${tx.toFixed(1)}" y2="${mt + ih + 4}" stroke="#666" stroke-width="1"/>
                <text x="${tx.toFixed(1)}" y="${mt + ih + 14}" text-anchor="middle" font-size="9" fill="#666">${fmtM(t)}</text>`;
      }).join('\n')}
      <!-- Axis labels -->
      <text x="${(ml + iw / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="10" font-weight="600" fill="#333">φMn (kNm)</text>
      <text x="11" y="${(mt + ih / 2).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="#333" transform="rotate(-90,11,${(mt + ih / 2).toFixed(1)})">φPn (kN)</text>
      <!-- Design point crosshairs + marker -->
      ${dpVis ? `
      <line x1="${dpX.toFixed(1)}" y1="${mt}" x2="${dpX.toFixed(1)}" y2="${mt + ih}" stroke="#c62828" stroke-width="1" stroke-dasharray="4,3" opacity="0.65"/>
      <line x1="${ml}" y1="${dpY.toFixed(1)}" x2="${ml + iw}" y2="${dpY.toFixed(1)}" stroke="#c62828" stroke-width="1" stroke-dasharray="4,3" opacity="0.65"/>
      <circle cx="${dpX.toFixed(1)}" cy="${dpY.toFixed(1)}" r="5.5" fill="#c62828" stroke="white" stroke-width="2"/>
      <text x="${Math.min(dpX + 9, ml + iw - 58).toFixed(1)}" y="${(dpY - 8).toFixed(1)}" font-size="9" fill="#c62828" font-weight="700">(${Math.abs(M_kNm).toFixed(1)}, ${N_kN.toFixed(0)})</text>
      ` : `<text x="${(ml + iw / 2).toFixed(1)}" y="${(mt + ih / 2).toFixed(1)}" text-anchor="middle" font-size="10" fill="#c62828">Design point outside chart range</text>`}
      <!-- Legend (bottom-left) -->
      <rect x="${ml + 4}" y="${mt + ih - 52}" width="120" height="50" fill="white" fill-opacity="0.88" stroke="#ccc" stroke-width="0.5" rx="3"/>
      <rect x="${ml +  9}" y="${mt + ih - 46}" width="9" height="9" fill="#dbeafe" stroke="#93c5fd" stroke-width="0.8"/>
      <text x="${ml + 21}" y="${mt + ih - 38}" font-size="8.5" fill="#555">Compression-controlled</text>
      <rect x="${ml +  9}" y="${mt + ih - 34}" width="9" height="9" fill="#fef9c3" stroke="#fde047" stroke-width="0.8"/>
      <text x="${ml + 21}" y="${mt + ih - 26}" font-size="8.5" fill="#555">Transition zone</text>
      <rect x="${ml +  9}" y="${mt + ih - 22}" width="9" height="9" fill="#dcfce7" stroke="#86efac" stroke-width="0.8"/>
      <text x="${ml + 21}" y="${mt + ih - 14}" font-size="8.5" fill="#555">Tension-controlled</text>
      <circle cx="${(ml + 13.5).toFixed(1)}" cy="${(mt + ih - 5).toFixed(1)}" r="4" fill="#c62828" stroke="white" stroke-width="1.5"/>
      <text x="${ml + 21}" y="${mt + ih - 2}" font-size="8.5" fill="#c62828">Design point (φMn, φPn)</text>
    </svg>
  </div>
</div>`;
  }

  // Expose helpers for inline onclick
  function _openCheckDetail(beamId) {
    if (!designResults) { toast('Run design checks first', 'warn'); return; }
    const bd = designResults.byBeam.find(b => b.id === beamId);
    if (!bd) return;
    const STATUS_COL = { OK:'#2e7d32', NEAR:'#e65100', FAIL:'#c62828', INFO:'#1565c0' };

    document.getElementById('chk-beam-label').textContent = `${bd.label} — ${bd.secName}  (L=${bd.L}m, Class ${bd.cls})`;

    // Render checks
    const body = document.getElementById('chk-dialog-body');
    body.innerHTML = bd.checks.map(c => {
      const col = STATUS_COL[c.status] || '#555';
      let rows = `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">`;
      let rowIdx = 0;
      for (const [k, v] of Object.entries(c)) {
        if (['check','status','pass','elements'].includes(k)) continue;
        if (v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) continue;
        if (Array.isArray(v)) continue;

        const meta = PARAM_META[k];
        const label  = meta ? meta[0] : k.replace(/_/g,' ');  // fallback: humanise key
        const symbol = meta ? meta[1] : k;
        const unit   = meta ? meta[2] : '';
        const isKey  = ['eta','N_Ed','M_Ed','V_Ed','Nb_Rd','Mb_Rd','Vpl_Rd',
                        'Npl_Rd','Nt_Rd','v_max_mm','limit_mm'].includes(k);

        const dispVal = typeof v === 'number'
          ? (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(3) : v.toFixed(4))
          : String(v);

        const bg = rowIdx++ % 2 === 0 ? '' : 'background:var(--bg-tbl-alt,#f5f5f5)';
        rows += `<tr style="${bg}">
          <td style="padding:4px 8px;width:60%;border-bottom:1px solid var(--border-tbl,#e8e8e8)">
            <span style="display:block;font-weight:${isKey?700:400};color:var(--text)">${label}</span>
            ${symbol !== label
              ? `<span style="font-size:10px;color:var(--text-sec);font-family:monospace">${symbol}${unit?' ['+unit+']':''}</span>`
              : (unit ? `<span style="font-size:10px;color:var(--text-sec)">[${unit}]</span>` : '')}
          </td>
          <td style="padding:4px 8px;font-weight:${isKey?700:500};color:${isKey?col:'var(--text)'};border-bottom:1px solid var(--border-tbl,#e8e8e8)">
            ${dispVal}
          </td>
        </tr>`;
      }
      rows += '</table>';
      // Plate buckling: render elements sub-table
      let elemTable = '';
      if (c.elements && c.elements.length > 0) {
        const SCOL = { OK:'#2e7d32', NEAR:'#e65100', FAIL:'#c62828' };
        elemTable = `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px;border-top:1px solid #eee">
          <thead><tr style="background:var(--bg-tbl-alt,#f5f5f5)">
            <th style="padding:3px 6px;text-align:left">Element</th>
            <th style="padding:3px 6px">b/t</th>
            <th style="padding:3px 6px">k</th>
            <th style="padding:3px 6px">σcr [MPa]</th>
            <th style="padding:3px 6px">λp</th>
            <th style="padding:3px 6px">ρ</th>
            <th style="padding:3px 6px">Status</th>
          </tr></thead><tbody>
          ${c.elements.map((el,i) => `<tr style="${i%2?'background:var(--bg-tbl-alt,#f5f5f5)':''}">
            <td style="padding:2px 6px">${el.element}</td>
            <td style="padding:2px 6px;text-align:center">${el.b_t}</td>
            <td style="padding:2px 6px;text-align:center">${el.k}</td>
            <td style="padding:2px 6px;text-align:center">${el.sigma_cr}</td>
            <td style="padding:2px 6px;text-align:center">${el.lambda_p}</td>
            <td style="padding:2px 6px;text-align:center">${el.rho}</td>
            <td style="padding:2px 6px;color:${SCOL[el.status]||'#555'};font-weight:700;text-align:center">${el.status}</td>
          </tr>`).join('')}
          </tbody></table>`;
      }
      const eta = c.eta !== null && c.eta !== undefined
        ? `<span style="font-weight:700;color:${col}"> η=${c.eta.toFixed(4)}</span>` : '';

      // Plain-English description of what this check is verifying
      const CHECK_DESC = {
        // ── EC3 / steel ─────────────────────────────────────────────────────
        'Section Classification':       'Classifies flange & web slenderness per EC3 Table 5.2 (ε = √(235/fy)). Class 1=fully plastic, 2=compact, 3=semi-compact, 4=slender.',
        'Axial (Tension)':              'Checks tensile demand against gross cross-section yield resistance N_t,Rd = A·fy/γM0.',
        'Axial (Compression/Buckling)': 'Checks flexural buckling for both axes using EC3 §6.3.1. χ from imperfection curves a0→d. Effective length = K·L per axis.',
        'Flexure':                      'Checks bending moment against cross-section resistance M_c,Rd and lateral-torsional buckling resistance M_b,Rd (EC3 §6.3.2). LTB uses C1=1.12 (conservative).',
        'Shear':                        'Checks shear demand against plastic shear resistance V_pl,Rd = A_v·fy/(√3·γM0) per EC3 §6.2.6. Also checks web shear buckling (hw/tw > 72ε).',
        'Plate Buckling (EC3 §4)':      'Checks individual plate elements (web, flange outstand) for local buckling using σcr = k·π²E/[12(1−ν²)(b/t)²]. λp > 0.673 triggers effective width reduction ρ.',
        'Torsion':                      '2D frame analysis provides no torsion — capacity shown for reference only. Check separately if significant torsion exists in the structure.',
        'Combined N+M Interaction':     'Beam-column interaction per EC3 §6.3.3 Method 2 (Annex B). Equations 6.61 (major axis) and 6.62 (minor axis) must both be satisfied.',
        'Deflection':                   'Serviceability check using end-node displacements. Limit L/300 (SS beam) or L/150 (cantilever). Note: mid-span deflection may be larger than end values.',
        'Property Modifiers':           'Lists any stiffness modifiers (EA, EI, GJ, mass) applied to this beam, typically for cracked sections, semi-rigid joints, or analysis assumptions.',
        // ── ACI 318-19 / concrete ───────────────────────────────────────────
        '⚙ ACI 318-19 Mode':            'ACI 318-19 strength design (LRFD φ-factor method). Sections detected as ACI RC use f\'c from the section fy field and Grade 60 (fy=420 MPa) rebar by default.',
        '⚙ EC2 Mode':                   'EN 1992-1-1:2004 design applied to this reinforced concrete section (EC2 γM factors).',
        'ACI 318-19 Material Properties': 'Summary of concrete material properties derived from f\'c per ACI 318-19. Ec = 4700√f\'c, β₁ = 0.85 (f\'c≤28 MPa), fr = 0.62√f\'c, ε_cu = 0.003.',
        'Flexure (ACI §22.3)':          'Checks flexural demand against φMn = φ·As·fy·(d−a/2). Stress block: a = As·fy/(0.85f\'c·b). φ=0.90 when ε_t≥0.005 (tension-controlled). Requires ε_t≥0.004 per §9.3.3.1.',
        'Shear (ACI §22.5)':            'Simplified Vc = 0.17λ√f\'c·bw·d (§22.5.5.1). φ=0.75. Stirrups required when Vu>φVc. Vs,max = 0.66√f\'c·bw·d limits section size. Av/s,min from §9.6.3.4.',
        'Column (ACI §22.4)':           'φPn0 = φ·0.80·[0.85f\'c(Ag−Ast)+fy·Ast] for tied columns (φ=0.65, α=0.80). Interaction: P/φPn + M/φMn ≤ 1.0 (compression-dominant) or M/φMn + 0.5P/φPn ≤ 1.0.',
        'Reinforcement — Beam (ACI §9.6.1.2)': 'As,min = max(0.25√f\'c/fy, 1.4/fy)·bw·d per §9.6.1.2. As,max from ε_t = 0.004 limit (§9.3.3.1): ρ_max = 0.85β₁f\'c/fy × 3/7.',
        'Reinforcement — Column (ACI §10.6.1.1)': 'Gross reinforcement ratio ρg = Ast/Ag must satisfy 0.01 ≤ ρg ≤ 0.08 per ACI §10.6.1.1. ρg < 1% risks creep problems; ρg > 8% causes congestion.',
        'Deflection — Min h (ACI §9.3.1)': 'Minimum member depth from ACI Table 9.3.1.1 to waive explicit deflection calculation (Grade 60, normalwt). SS: ℓ/16; One-end cont.: ℓ/18.5; Both cont.: ℓ/21; Cantilever: ℓ/8.',
        'Slenderness (ACI §6.6.4)':        'Moment magnification for non-sway frames per §6.6.4. Slenderness ratio klu/r checked against limit 34−12(M1/M2). EI_eff = 0.4EcIg/(1+βdns). δns = Cm/(1−Pu/0.75Pc) ≥ 1.0. Magnified moment Mc = δns·M2.',
        'Development Length (ACI §25.4)':  'Straight bar ld per §25.4.2.4: ld = (3/40)·(fy/λ√f\'c)·(ψt·ψe·ψs·ψg/cb_ktr)·db, min 300 mm. Hook ldh = 0.24ψe·fy/(λ√f\'c)·db. Compression ldc per §25.4.9. Class A lap = 1.0·ld; Class B lap = 1.3·ld.',
        'Torsion (ACI §22.7)':             'Torsion threshold φTcr/4 where Tcr = λ√f\'c·Acp²/pcp per §22.7.4. Transverse steel At/s = Tu/(2φAo·fyt); Al = (At/s)·ph·(fyt/fy). Combined V+T strut check: √[(Vu/bwd)²+(Tu·ph/1.7Aoh²)²] ≤ φ(Vc/bwd + 0.66√f\'c).',
        'Crack Control (ACI §24.3)':       'Maximum bar spacing s ≤ min[380(280/fs)−2.5cc, 300(280/fs)] per §24.3.2. fs = service-level moment / (0.9·As·d) or 2/3·fy. Frosch crack width wc = 2β(fs/Es)√(dc²+(s/2)²) ≤ 0.33 mm (interior exposure).',
      };
      const desc = CHECK_DESC[c.check] || '';

      return `<div style="margin-bottom:10px;border:1px solid ${col}44;border-radius:6px;overflow:hidden;">
        <div style="background:${col}15;padding:6px 10px;display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <span style="font-weight:700;color:${col};font-size:13px">${c.check}</span>
            ${desc ? `<div style="font-size:10px;color:${col}bb;margin-top:2px;max-width:440px;line-height:1.4">${desc}</div>` : ''}
          </div>
          <div style="white-space:nowrap;margin-left:8px">
            ${eta} <span style="padding:2px 8px;border-radius:10px;background:${col}22;color:${col};font-size:11px;font-weight:700">${c.status||''}</span>
          </div>
        </div>
        <div style="padding:6px 10px;">${rows}${elemTable}</div>
      </div>`;
    }).join('');

    // ── P-M Interaction Diagram for ACI column checks ─────────────────────────
    if (window.ACIDesign) {
      const colChk = bd.checks.find(c => c.check === 'Column (ACI §22.4)');
      const matChk = bd.checks.find(c => c.check === 'ACI 318-19 Material Properties');
      if (colChk && matChk) {
        const _bm   = beams.find(b => b.id === beamId);
        const _sec  = _bm ? sections.find(s => s.id === _bm.sectionId) : null;
        const b_mm  = (_sec && _sec.bf) ? _sec.bf : 300;
        const h_mm  = (_sec && _sec.d)  ? _sec.d  : 500;
        const fc    = matChk.fcprime_MPa   || 28;
        const fy    = matChk.fy_rebar_MPa  || 420;
        const Ast   = colChk.Ast_use_mm2   || 0;
        const tied  = !String(colChk.column_type || '').toLowerCase().includes('spiral');
        try {
          const pmPts = ACIDesign.generatePMCurve(b_mm, h_mm, Ast, fc, fy, tied);
          body.insertAdjacentHTML('beforeend', _renderPMDiagram(pmPts, colChk.N_Ed, colChk.M_Ed));
        } catch (_e) { /* diagram unavailable, skip silently */ }
      }
    }

    document.getElementById('chk-modifiers-btn').onclick = () => { closeModal('modal-check-detail'); _openModifiers(beamId); };
    document.getElementById('chk-close-btn').onclick = () => closeModal('modal-check-detail');
    openModal('modal-check-detail');
  }

  function _openModifiers(beamId) {
    if (!window.PropertyModifiers) { toast('PropertyModifiers module not loaded', 'error'); return; }
    const bm  = beams.find(b => b.id === beamId);
    const sec = bm ? sections.find(s => s.id === bm.sectionId) : null;
    document.getElementById('mod-beam-label').textContent = bm ? getMemberLabel(bm) : beamId;
    const body = document.getElementById('mod-dialog-body');
    body.innerHTML = PropertyModifiers.buildDialogHTML(beamId, sec);
    PropertyModifiers.wireDialog(beamId, (id, mods) => {
      const b = beams.find(x => x.id === id);
      if (b) b.modifiers = mods;
      snapshot();
      updateDesignTable();
      closeModal('modal-modifiers');
      toast('Modifiers saved', 'ok');
    });
    document.getElementById('mod-reset-btn').onclick = () => {
      PropertyModifiers.remove(beamId);
      const b = beams.find(x => x.id === beamId);
      if (b) delete b.modifiers;
      snapshot(); updateDesignTable();
      closeModal('modal-modifiers');
      toast('Modifiers reset to unity', 'ok');
    };
    document.getElementById('mod-cancel-btn').onclick = () => closeModal('modal-modifiers');
    openModal('modal-modifiers');
  }

  // _setLcr now handles Lcr, Ky, and Kz fields
  function _setLcr(beamId, field, val) {
    // Legacy: _setLcr(id, val) — called without field name
    if (typeof field === 'number') { val = field; field = 'Lcr'; }
    const bm = beams.find(b => b.id === beamId);
    if (!bm) return;
    if (field === 'Lcr') {
      bm.Lcr = val > 0 ? val : undefined;
    } else if (field === 'Ky') {
      bm.Ky = val > 0 ? val : 1.0;
    } else if (field === 'Kz') {
      bm.Kz = val > 0 ? val : 1.0;
    }
    snapshot();
  }

  // ── Change Section modal ───────────────────────────────────────────
  function _openChangeSection(beamId) {
    const bm  = beams.find(b => b.id === beamId); if (!bm) return;
    const bd  = designResults && designResults.byBeam.find(b => b.id === beamId);

    // Demand summary from design checks
    let demandHtml = '<p style="color:#888;font-size:11px">Run design checks to see demand.</p>';
    if (bd) {
      const col = { OK:'#2e7d32', NEAR:'#e65100', FAIL:'#c62828' }[bd.overall] || '#555';
      // Same qualified-status problem as the roll-up above: a check reporting
      // 'FAIL (strut)' never appeared in this list.
      const kind = s => (window.DesignChecks ? DesignChecks.classifyStatus(s)
                                             : (s === 'FAIL' ? 'FAIL' : s === 'NEAR' ? 'NEAR' : 'OK'));
      const failing = bd.checks.filter(c => kind(c.status) === 'FAIL' || kind(c.status) === 'NEAR')
        .map(c => `<li style="color:${kind(c.status)==='FAIL'?'#c62828':'#e65100'}">${c.check} — η=${c.eta!=null?c.eta.toFixed(3):'—'}</li>`).join('');
      demandHtml = `
        <div style="font-size:11px;margin-bottom:6px">
          <span style="font-weight:700;color:${col}">Overall: ${bd.overall}</span>
          &nbsp; η<sub>max</sub> = <b>${bd.maxEta.toFixed(3)}</b>
        </div>
        ${failing ? `<ul style="margin:4px 0 0 14px;padding:0;font-size:11px">${failing}</ul>` : '<p style="color:#2e7d32;font-size:11px">✓ All checks passing.</p>'}`;
    }

    // Build section dropdown
    const secOpts = sections.map(s =>
      `<option value="${s.id}" ${s.id===bm.sectionId?'selected':''}>${escapeIssue(s.name)} (A=${s.A}cm², I=${s.I}cm⁴)</option>`
    ).join('');

    // Populate the modal
    document.getElementById('cs-beam-label').textContent = getMemberLabel(bm);
    document.getElementById('cs-demand').innerHTML = demandHtml;

    // Section selector
    document.getElementById('cs-sec-sel').innerHTML = secOpts;
    // Wire selector → update editor fields
    function syncEditorFromSec(sid) {
      const s = sections.find(x => x.id === +sid);
      if (!s) return;
      document.getElementById('cs-name').value = s.name;
      document.getElementById('cs-E').value    = s.E;
      document.getElementById('cs-A').value    = s.A;
      document.getElementById('cs-I').value    = s.I;
      document.getElementById('cs-fy').value   = s.fy || 235;
      document.getElementById('cs-rho').value  = s.rho || 78.5;
    }
    document.getElementById('cs-sec-sel').onchange = function() { syncEditorFromSec(this.value); };
    syncEditorFromSec(bm.sectionId);

    // Populate K-factor fields from beam
    document.getElementById('cs-Ky').value = bm.Ky != null ? bm.Ky : 1.0;
    document.getElementById('cs-Kz').value = bm.Kz != null ? bm.Kz : 1.0;

    // K-factor preset dropdown
    document.getElementById('cs-K-preset').value = '';
    document.getElementById('cs-K-preset').onchange = function() {
      if (!this.value) return;
      const [ky, kz] = this.value.split(',').map(Number);
      document.getElementById('cs-Ky').value = ky;
      document.getElementById('cs-Kz').value = kz;
      this.value = '';
    };

    // Apply button — change beam section (use existing or create new)
    document.getElementById('cs-apply-btn').onclick = () => {
      const selId = +document.getElementById('cs-sec-sel').value;
      const name = document.getElementById('cs-name').value.trim();
      const E    = +document.getElementById('cs-E').value;
      const A    = +document.getElementById('cs-A').value;
      const I    = +document.getElementById('cs-I').value;
      const fy   = +document.getElementById('cs-fy').value;
      const rho  = +document.getElementById('cs-rho').value;

      // Apply K-factors to beam
      bm.Ky = +document.getElementById('cs-Ky').value || 1.0;
      bm.Kz = +document.getElementById('cs-Kz').value || 1.0;

      const selSec = sections.find(s => s.id === selId);
      // Check if user edited values vs selected section
      const edited = selSec && (selSec.name !== name || selSec.E !== E || selSec.A !== A || selSec.I !== I || selSec.fy !== fy);
      if (edited) {
        // Ask to update existing or create new
        const choice = confirm(`Save edited properties as a NEW section?\n\nOK = Create new section "${name}"\nCancel = Update section "${selSec.name}" in place`);
        if (choice) {
          // Create new section
          const newSec = { id: allocSectionId(), name, E, A, I, fy, rho };
          sections.push(newSec);
          bm.sectionId = newSec.id;
        } else {
          // Update existing in place
          selSec.name = name; selSec.E = E; selSec.A = A; selSec.I = I; selSec.fy = fy; selSec.rho = rho;
          bm.sectionId = selSec.id;
        }
      } else {
        bm.sectionId = selId;
      }
      snapshot();
      updateSectionTable(); updateBeamTable();
      designResults = null; updateDesignTable();
      render();
      closeModal('modal-change-section');
      toast('Section changed — re-run Solve then Design Checks', 'ok');
    };

    // Auto-size button — search standard DB + user library for lightest passing section
    document.getElementById('cs-autosize-btn').onclick = () => {
      if (!window.DesignChecks) { toast('DesignChecks not loaded', 'error'); return; }
      const res = getActiveResults();
      if (!res || !res.success) { toast('Run Solve first', 'warn'); return; }
      const ef  = res.elemForces.find(e => e.id === beamId);
      if (!ef) { toast('No analysis results for this beam', 'warn'); return; }

      // Build candidate pool: standard DB (IPE, HEA, HEB, SHS, CHS) + user library
      // All candidates get current fy; sorted by area (lightest first)
      const curFy = bm._sec ? bm._sec.fy : 355;
      const curE  = bm._sec ? bm._sec.E  : 210;

      let candidates = [];

      // Standard library sections
      if (window.SectionDB && SectionDB.all) {
        for (const s of SectionDB.all) {
          if (!s.A || !s.Ix) continue;
          candidates.push({
            id: `std_${s.name}`, name: s.name,
            E: curE, A: s.A, I: s.Ix, Ix: s.Ix, Iy: s.Iy || s.Ix,
            fy: curFy, rho: 1.0,
            d: s.d, bf: s.bf, tf: s.tf, tw: s.tw,
            Zx: s.Zx, Sx: s.Sx, J: s.J, Cw: s.Cw,
            _fromDB: true
          });
        }
      }

      // User library sections
      for (const s of sections) {
        if (s.A && (s.I || s.Ix)) candidates.push({ ...s, _fromDB: false });
      }

      // Sort lightest first
      candidates.sort((a, b) => a.A - b.A);

      let found = null, tested = 0;
      for (const s of candidates) {
        const tryBm = { ...bm, sectionId: s.id };
        try {
          // Temporarily add s to a working section array for the check
          const trySections = [...sections.filter(x => x.id !== s.id), s];
          const tryRes = DesignChecks.runDesignChecks(res, [tryBm], trySections);
          const tryBd  = tryRes && tryRes.byBeam && tryRes.byBeam[0];
          tested++;
          if (tryBd && (tryBd.overall === 'OK' || tryBd.overall === 'NEAR')) {
            found = s; break;
          }
        } catch(err) { /* skip bad section */ }
      }

      if (found) {
        // Add to user library if from standard DB
        if (found._fromDB) {
          const existing = sections.find(s => s.name === found.name);
          if (!existing) {
            // The standard DB carries its own ids, which collide with ids
            // already handed out to user sections — reassign on import.
            found.id = allocSectionId();
            sections.push(found);
          }
          // Update dropdown
          const sel = document.getElementById('cs-sec-sel');
          if (!Array.from(sel.options).find(o => o.value == found.id)) {
            const opt = document.createElement('option');
            opt.value = found.id;
            opt.textContent = `${found.name} (A=${found.A.toFixed(1)}cm², I=${found.Ix.toFixed(0)}cm⁴)`;
            sel.appendChild(opt);
          }
          sel.value = found.id;
        } else {
          document.getElementById('cs-sec-sel').value = found.id;
        }
        syncEditorFromSec(found.id);
        const selEl = document.getElementById('cs-sec-sel');
        selEl.style.outline = '2px solid #2e7d32';
        setTimeout(() => selEl.style.outline = '', 2500);
        toast(`✓ Auto-sized: ${found.name} — A=${found.A.toFixed(1)} cm²  I=${(found.Ix||found.I||0).toFixed(0)} cm⁴  (${tested} tested)`, 'success');
      } else {
        toast(`No passing section found in ${tested} candidates — add heavier sections or reduce loads`, 'warn');
      }
    };

    // Save as new section button
    document.getElementById('cs-save-new-btn').onclick = () => {
      const name = document.getElementById('cs-name').value.trim() || 'Custom Section';
      const E    = +document.getElementById('cs-E').value;
      const A    = +document.getElementById('cs-A').value;
      const I    = +document.getElementById('cs-I').value;
      const fy   = +document.getElementById('cs-fy').value;
      const rho  = +document.getElementById('cs-rho').value;
      const newSec = { id: allocSectionId(), name, E, A, I, fy, rho };
      sections.push(newSec);
      // Add to dropdown
      const opt = document.createElement('option');
      opt.value = newSec.id; opt.textContent = `${newSec.name} (A=${A}cm², I=${I}cm⁴)`;
      opt.selected = true;
      document.getElementById('cs-sec-sel').appendChild(opt);
      snapshot(); updateSectionTable();
      toast(`New section "${name}" added to library`, 'ok');
    };

    document.getElementById('cs-close-btn').onclick = () => closeModal('modal-change-section');
    openModal('modal-change-section');
  }

  // ── Fit to screen ─────────────────────────────────────────────────

  function fitToScreen() {
    if (nodes.length === 0) {
      const W = svg().clientWidth || 800;
      const H = svg().clientHeight || 600;
      pan = { x: W/2, y: H/2 }; scale = 80;
      render();   // always render even on empty canvas
      return;
    }
    const W = svg().clientWidth  || 800;
    const H = svg().clientHeight || 600;
    const padX = W * 0.15, padY = H * 0.18;

    // Fit what is actually DRAWN, not the raw coordinates.
    //
    // This took the model's x extent against the canvas width and its y (or z)
    // extent against the height, then solved pan with the flat 2D mapping. In
    // 3D nothing is drawn that way: mToS3D mixes x and y by the azimuth and
    // compresses the vertical by the elevation, so the fit was solving for a
    // projection the canvas was not using — the frame landed small and off
    // centre, and the error changed as you orbited. Project every node first
    // and fit the box that comes out, which is exact at any camera angle and
    // collapses the 2D and 3D cases into one calculation.
    const pts  = nodes.map(nodeToUnit);
    const us   = pts.map(p => p.u), vs = pts.map(p => p.v);
    const minU = Math.min(...us),   maxU = Math.max(...us);
    const minV = Math.min(...vs),   maxV = Math.max(...vs);
    const du = (maxU - minU) || 1,  dv = (maxV - minV) || 1;

    scale = Math.min((W - 2*padX) / du, (H - 2*padY) / dv);
    scale = Math.max(10, Math.min(scale, 400));

    // sx = u*scale + pan.x — put the projected x centre at the canvas centre.
    pan.x = W / 2 - (minU + maxU) / 2 * scale;

    const isZLifted = nodes.some(n => (n.z||0) !== 0) && nodes.every(n => !n.y);
    if (!mode3D && isZLifted) {
      // 2D elevation of a Z-lifted model: keep the base sitting near the bottom
      // of the canvas, which is how this view has always read.
      // sy = pan.y - v*scale, so the lowest point lands at H - padY when
      // pan.y = H - padY + minV*scale.
      pan.y = H - padY + minV * scale;
    } else {
      // Centre the projected extent. In 3D the base is not a fixed screen edge —
      // orbit and it moves — so an even margin all round is the stable choice.
      pan.y = H / 2 + (minV + maxV) / 2 * scale;
    }
    render();
  }

  // ── Init / Event binding ──────────────────────────────────────────

  function init() {
    const cvs = svg();
    cvs.addEventListener('click',       onCanvasClick);
    cvs.addEventListener('mousemove',   onMouseMove);
    cvs.addEventListener('mousedown',   onMouseDown);
    cvs.addEventListener('mouseup',     onMouseUp);
    cvs.addEventListener('wheel',       onWheel, { passive: false });
    cvs.addEventListener('contextmenu', e => {
      e.preventDefault();
      const sp  = svgPt(e);
      const bid = hitBeam(sp.x, sp.y);
      const nid = hitNode(sp.x, sp.y);

      // If results exist and a beam was right-clicked → open Deflection Inspector
      if (bid !== null && results && results.success && window.DEFL_INSP) {
        const ef = results.elemForces && results.elemForces.find(f => f.id === bid);
        const bm = beams.find(b => b.id === bid);
        if (ef) {
          DEFL_INSP.open(ef, bm);   // opens as centred modal dialog
          return;
        }
      }
      if (bid !== null) showMemberPopup(bid, e.clientX, e.clientY);
      else if (nid !== null) showNodePopup(nid, e.clientX, e.clientY);
      else { hideMemberPopup(); if (window.DEFL_INSP) DEFL_INSP.close(); }
    });

    // Member popup close button and keyboard/click dismissal
    document.getElementById('mpop-close')?.addEventListener('click', hideMemberPopup);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMemberPopup(); });
    document.getElementById('canvas')?.addEventListener('mousedown', () => hideMemberPopup());

    // ── Touch support (mobile pan + pinch-zoom) ───────────────────────
    let _touchDist = null, _touchScale = scale, _touchPanStart = null, _touchMid = null;
    cvs.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        _touchDist  = Math.hypot(dx, dy);
        _touchScale = scale;
        const rect = cvs.getBoundingClientRect();
        _touchMid   = { x:(e.touches[0].clientX+e.touches[1].clientX)/2-rect.left,
                        y:(e.touches[0].clientY+e.touches[1].clientY)/2-rect.top };
      } else if (e.touches.length === 1) {
        const rect = cvs.getBoundingClientRect();
        _touchPanStart = { x:e.touches[0].clientX-rect.left, y:e.touches[0].clientY-rect.top };
        panning = true;
        panStart = _touchPanStart;
      }
    }, { passive: false });
    cvs.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && _touchDist) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const d  = Math.hypot(dx, dy);
        const factor = d / _touchDist;
        const newScale = Math.max(5, Math.min(2000, _touchScale * factor));
        if (_touchMid) {
          pan.x = _touchMid.x + (pan.x - _touchMid.x) * (newScale / scale);
          pan.y = _touchMid.y + (pan.y - _touchMid.y) * (newScale / scale);
        }
        scale = newScale;
        render();
      } else if (e.touches.length === 1 && panning) {
        const rect = cvs.getBoundingClientRect();
        const sp = { x:e.touches[0].clientX-rect.left, y:e.touches[0].clientY-rect.top };
        pan.x += sp.x - panStart.x; pan.y += sp.y - panStart.y;
        panStart = sp; render();
      }
    }, { passive: false });
    cvs.addEventListener('touchend', e => {
      if (e.touches.length < 2) _touchDist = null;
      if (e.touches.length === 0) { panning = false; _touchPanStart = null; }
    }, { passive: false });

    // Toolbar tool buttons
    document.querySelectorAll('.tb-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    // Solve
    document.getElementById('btn-solve').addEventListener('click', solve);

    // Delete / Abort
    document.getElementById('btn-delete').addEventListener('click', () => setTool('delete'));
    document.getElementById('btn-abort').addEventListener('click', () => {
      beamStart = null; highlightNode(null); clearLayer(layerTemp()); setTool('select');
    });

    // ── Clear Canvas ───────────────────────────────────────────────────
    const btnClearCanvas = document.getElementById('btn-clear-canvas');
    if (btnClearCanvas) {
      btnClearCanvas.addEventListener('click', () => {
        if (!confirm('Clear all nodes, beams and loads? This cannot be undone.')) return;
        snapshot(); // save state for one undo level
        nodes = []; beams = []; loads = []; settlements = [];
        results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
        designResults = null;
        selNode = null; selBeam = null;
        multiSel = { nodes: new Set(), beams: new Set() };
        // Geometry is gone, so node/beam/load ids restart — but the sections
        // and materials survive, and seeding from sections.length is not a safe
        // next id once ids are non-contiguous (two sections with ids 5 and 6
        // gave nextId.section = 3). Keep both allocators above what exists.
        nextId = { node:1, beam:1, load:1, settlement:1,
                   section:  sections.reduce((m,s)  => Math.max(m, +s.id||0), 0) + 1,
                   material: materials.reduce((m,x) => Math.max(m, +x.id||0), 0) + 1,
                   lcase: (loadCases[0] ? loadCases[0].id+1 : 2), combo:1 };
        // Hide mode-bar (mode shapes invalidated when canvas cleared)
        resetModeOverlay();
        updateNodeTable(); updateBeamTable(); updateLoadTable();
        updateCasesPane(); populateDisplaySelector();
        render();
        toast('Canvas cleared.', 'info');
      });
    }

    // ── Extrude toggle ─────────────────────────────────────────────────
    const btnExtrude = document.getElementById('btn-extrude');
    if (btnExtrude) {
      // Mark active by default (extrude is on) — only meaningful in 3D mode
      btnExtrude.classList.toggle('active', views.extrude);
      btnExtrude.addEventListener('click', () => {
        views.extrude = !views.extrude;
        btnExtrude.classList.toggle('active', views.extrude);
        render();
        // Extrusion is drawn only in 3D, so in 2D this used to flip the flag,
        // redraw nothing and still announce "3D Extrusion on" — a control
        // reporting a state it had not produced. Say what actually happened.
        // The View ribbon's axis buttons already set the precedent for this:
        // when a view needs 3D they say so and take you there.
        if (!mode3D && views.extrude) {
          toast('3D Extrusion on — switch to 3D [3] to see it', 'info');
        } else {
          toast(`3D Extrusion ${views.extrude ? 'on' : 'off'}`, 'info');
        }
      });
    }

    // Undo / Redo
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);

    // Dark mode
    document.getElementById('btn-darkmode').addEventListener('click', toggleDarkMode);

    // Mobile panel toggle
    const btnPanelToggle = document.getElementById('btn-panel-toggle');
    if (btnPanelToggle) {
      btnPanelToggle.addEventListener('click', () => {
        const sp = document.getElementById('side-panel');
        sp.classList.toggle('panel-collapsed');
        btnPanelToggle.classList.toggle('active');
      });
    }

    // 3D Space Frame Mode toggle
    const btn3d = document.getElementById('btn-3d');
    if (btn3d) {
      btn3d.addEventListener('click', () => {
        mode3D = !mode3D;
        btn3d.classList.toggle('active', mode3D);
        setBtnLabel(btn3d, mode3D ? '3D ✓' : '3D');
        // ── Coordinate migration for Z-up convention ──────────────────
        // In 2D mode: nd.y = elevation, nd.z unused.
        // In 3D mode (Z-up): nd.z = elevation, nd.y = horizontal depth.
        if (mode3D) {
          // Entering 3D: move elevation from Y to Z; Y becomes horizontal depth.
          //
          // Skip when the model is ALREADY in the Z-up convention. mode3D is not
          // part of the saved payload, so a model built in 3D reloads with its
          // Z-up coordinates but mode3D === false (2D still renders it correctly
          // via the same Z-lift convention in nodeToS). Migrating again read
          // elevation from y — which is 0 for those models — and swapped it with
          // z, laying the whole frame flat in the horizontal plane.
          if (!isZLiftedModel()) {
            nodes.forEach(nd => {
              const elev  = nd.y;          // 2D vertical height
              const depth = nd.z || 0;     // prior depth (0 when first entering)
              nd.z = elev;                 // elevation → Z (vertical)
              nd.y = depth;                // depth stays Y (horizontal)
            });
          }
          view3D = { az: ISO_AZ, el: ISO_EL };
        } else {
          // Leaving 3D: restore elevation from Z back to Y for 2D solver
          nodes.forEach(nd => {
            nd.y = nd.z || 0;
            nd.z = 0;
          });
        }
        const orb = document.getElementById('btn-orbit-reset');
        if (orb) orb.style.display = mode3D ? '' : 'none';
        // Show/hide Z-elevation input in Nodes pane
        const nodeZRow = document.getElementById('node-z-row');
        if (nodeZRow) nodeZRow.style.display = mode3D ? 'flex' : 'none';
        updateNodeTable();
        results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
        render();
        // Update Draw pane Δz row visibility
        if (typeof window._drawPaneUpdateDzRow === 'function') window._drawPaneUpdateDzRow();
        toast(`3D Space Frame mode ${mode3D ? 'enabled — Z=elevation, Y=depth, right-drag to orbit' : 'disabled'}`, 'info');
      });
    }

    // Orbit reset button
    const orbitResetBtn = document.getElementById('btn-orbit-reset');
    if (orbitResetBtn) {
      orbitResetBtn.addEventListener('click', () => {
        view3D = { az: ISO_AZ, el: ISO_EL }; render();
      });
    }

    // Views
    document.getElementById('btn-views').addEventListener('click', () => {
      document.getElementById('view-bmd').checked    = views.bmd;
      document.getElementById('view-sfd').checked    = views.sfd;
      document.getElementById('view-nfd').checked    = views.nfd;
      document.getElementById('view-defl').checked   = views.defl;
      document.getElementById('view-react').checked  = views.react;
      document.getElementById('view-stress').checked = views.stress;
      document.getElementById('view-energy').checked = views.energy;
      document.getElementById('view-vals').checked   = views.vals;
      const vfEl = document.getElementById('view-fill');  if (vfEl) vfEl.checked = views.fill;
      const vpEl = document.getElementById('view-peaks'); if (vpEl) vpEl.checked = views.peaks;
      document.getElementById('view-lengths').checked= views.lengths;
      document.getElementById('view-scale').value    = views.scale;
      document.getElementById('view-scale-lbl').textContent = views.scale;
      document.getElementById('view-defl-sc').value  = views.deflScale;
      const vlEl = document.getElementById('view-local');
      if (vlEl) vlEl.checked = views.local;
      // new ETABS-inspired fields
      const vcbEl = document.getElementById('view-color-by');  if (vcbEl) vcbEl.value   = views.colorBy || 'type';
      const vdrEl = document.getElementById('view-drift');      if (vdrEl) vdrEl.checked = views.drift;
      const vnlEl = document.getElementById('view-nodelabels'); if (vnlEl) vnlEl.checked = cfg.labels;
      const vblEl = document.getElementById('view-beamlabels'); if (vblEl) vblEl.checked = cfg.beamLabels;
      openModal('modal-views');
    });
    document.getElementById('view-scale').addEventListener('input', function() {
      document.getElementById('view-scale-lbl').textContent = this.value;
    });
    document.getElementById('views-ok').addEventListener('click', () => {
      views.bmd      = document.getElementById('view-bmd').checked;
      views.sfd      = document.getElementById('view-sfd').checked;
      views.nfd      = document.getElementById('view-nfd').checked;
      views.defl     = document.getElementById('view-defl').checked;
      views.react    = document.getElementById('view-react').checked;
      views.stress   = document.getElementById('view-stress').checked;
      views.energy   = document.getElementById('view-energy').checked;
      views.vals     = document.getElementById('view-vals').checked;
      const vfEl2 = document.getElementById('view-fill');  if (vfEl2) views.fill  = vfEl2.checked;
      const vpEl2 = document.getElementById('view-peaks'); if (vpEl2) views.peaks = vpEl2.checked;
      views.lengths  = document.getElementById('view-lengths').checked;
      views.scale    = +document.getElementById('view-scale').value;
      views.deflScale= +document.getElementById('view-defl-sc').value || 200;
      const vl = document.getElementById('view-local');
      if (vl) views.local = vl.checked;
      // new ETABS-inspired fields
      const vcb2 = document.getElementById('view-color-by');  if (vcb2) views.colorBy  = vcb2.value;
      const vdr2 = document.getElementById('view-drift');      if (vdr2) views.drift    = vdr2.checked;
      const vnl2 = document.getElementById('view-nodelabels'); if (vnl2) cfg.labels     = vnl2.checked;
      const vbl2 = document.getElementById('view-beamlabels'); if (vbl2) cfg.beamLabels = vbl2.checked;
      closeModal('modal-views');
      render();
    });

    // Files
    document.getElementById('btn-files').addEventListener('click', () => { loadSavedList(); openModal('modal-files'); });
    document.getElementById('file-save').addEventListener('click',        saveFile);
    document.getElementById('file-new').addEventListener('click',         newFile);

    // legacy load button (may not exist in older HTML, guard it)
    const fileLoadBtn = document.getElementById('file-load');
    if (fileLoadBtn) fileLoadBtn.addEventListener('click', () => {
      if (!window.FileIO) { toast('FileIO not loaded','error'); return; }
      FileIO.openFile('.frame,.json', (text, name) => {
        const data = FileIO.importJSON(text);
        if (data.error) { toast('Import error: ' + data.error, 'error'); return; }
        applyImportedModel(data, `"${name}"`);
        toast('Imported: ' + name, 'ok');
        closeModal('modal-files');
      });
    });

    document.getElementById('file-export-json').addEventListener('click', () => {
      if (window.FileIO) {
        FileIO.downloadJSON({ nodes, beams, sections, materials, loads, settlements, loadCases, loadCombos, nextId, meta: projectMeta, mode3D, view3D,
          grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined },
          (document.getElementById('file-name').value || 'structure') + '.frame');
        toast('Exported .frame file', 'ok');
      } else { exportJSON(); }
    });
    document.getElementById('file-export-png').addEventListener('click',  () => {
      if (window.FileIO) {
        FileIO.exportPNG(document.getElementById('canvas'),
          (document.getElementById('file-name').value || 'structure') + '.png');
        toast('PNG export started', 'ok');
      } else { exportPNG(); }
    });
    document.getElementById('file-export-csv').addEventListener('click',  () => {
      if (window.FileIO) {
        FileIO.downloadCSV(getActiveResults(), beams, nodes,
          (document.getElementById('file-name').value || 'results') + '.csv');
        toast('Forces CSV exported', 'ok');
      } else { exportCSV(); }
    });

    const expDcsv = document.getElementById('file-export-design-csv');
    if (expDcsv) expDcsv.addEventListener('click', () => {
      if (!designResults) { toast('Run design checks first', 'warn'); return; }
      if (window.FileIO) {
        FileIO.downloadDesignCSV(designResults,
          (document.getElementById('file-name').value || 'design') + '_checks.csv',
          designResults.codeLabel);
        toast('Design CSV exported', 'ok');
      }
    });

    const expDxf = document.getElementById('file-export-dxf');
    if (expDxf) expDxf.addEventListener('click', () => {
      if (window.FileIO) {
        FileIO.downloadDXF(nodes, beams, (document.getElementById('file-name').value || 'structure') + '.dxf');
        toast('DXF exported', 'ok');
      }
    });

    const shareUrl = document.getElementById('file-share-url');
    if (shareUrl) shareUrl.addEventListener('click', () => {
      if (!window.FileIO) return;
      const r = FileIO.exportToURL({ nodes, beams, sections, materials, loads, settlements,
                                     loadCases, loadCombos, nextId, meta: projectMeta, mode3D, view3D,
                                     grids: window.GRIDSYS ? GRIDSYS.getGrids() : undefined });
      if (r.error) { toast(r.error, 'warn'); return; }
      navigator.clipboard?.writeText(r.url).then(() => toast('Share URL copied to clipboard!','ok'))
        .catch(() => prompt('Share URL:', r.url));
    });

    const impClip = document.getElementById('file-import-clipboard');
    if (impClip) impClip.addEventListener('click', async () => {
      if (!window.FileIO) return;
      const data = await FileIO.importFromClipboard();
      if (data && data.error) { toast('Clipboard error: '+data.error,'error'); return; }
      if (!data || !data.nodes) { toast('No valid structure on clipboard', 'warn'); return; }
      applyImportedModel(data, 'This clipboard model');
      toast('Imported from clipboard', 'ok');
      closeModal('modal-files');
    });

    const impJson = document.getElementById('file-import-json');
    if (impJson) impJson.addEventListener('click', () => {
      if (!window.FileIO) return;
      FileIO.openFile('.frame,.json', (text, name) => {
        const data = FileIO.importJSON(text);
        if (data.error) { toast('Import error: ' + data.error, 'error'); return; }
        applyImportedModel(data, `"${name}"`);
        toast('Imported: ' + name, 'ok');
        closeModal('modal-files');
      });
    });

    const rptFull = document.getElementById('file-report-full');
    if (rptFull) rptFull.addEventListener('click', () => { generateHTMLReport(); closeModal('modal-files'); });

    const rptSummaryFile = document.getElementById('file-report-summary');
    if (rptSummaryFile) rptSummaryFile.addEventListener('click', () => { generateSummaryReport(); closeModal('modal-files'); });

    document.getElementById('files-close').addEventListener('click', () => closeModal('modal-files'));

    // Design tab buttons
    const runDesignBtn = document.getElementById('pnl-run-design');
    if (runDesignBtn) runDesignBtn.addEventListener('click', runDesignChecks);

    const expDesignCsv = document.getElementById('pnl-export-design-csv');
    if (expDesignCsv) expDesignCsv.addEventListener('click', () => {
      if (!designResults) { toast('Run design checks first', 'warn'); return; }
      if (window.FileIO) FileIO.downloadDesignCSV(designResults, undefined, designResults.codeLabel);
    });

    const openRptBtn = document.getElementById('pnl-open-report');
    if (openRptBtn) openRptBtn.addEventListener('click', generateHTMLReport);

    const openSumBtn = document.getElementById('pnl-open-summary');
    if (openSumBtn) openSumBtn.addEventListener('click', generateSummaryReport);

    // Settings
    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('cfg-grid').checked      = cfg.grid;
      document.getElementById('cfg-snap').checked      = cfg.snap;
      document.getElementById('cfg-gridsize').value    = cfg.gridSize;
      document.getElementById('cfg-anglesnap').checked = cfg.angleSnap;
      document.getElementById('cfg-labels').checked    = cfg.labels;
      document.getElementById('cfg-beamlbls').checked  = cfg.beamLabels;
      const asEl = document.getElementById('cfg-autosolve');
      if (asEl) asEl.checked = cfg.autoSolve;
      const caEl = document.getElementById('cfg-col-angle');
      if (caEl) caEl.value = cfg.colAngle;
      const baEl = document.getElementById('cfg-beam-angle');
      if (baEl) baEl.value = cfg.beamAngle;
      openModal('modal-settings');
    });
    document.getElementById('cfg-ok').addEventListener('click', () => {
      cfg.grid       = document.getElementById('cfg-grid').checked;
      cfg.snap       = document.getElementById('cfg-snap').checked;
      cfg.gridSize   = +document.getElementById('cfg-gridsize').value || 0.5;
      cfg.angleSnap  = document.getElementById('cfg-anglesnap').checked;
      cfg.labels     = document.getElementById('cfg-labels').checked;
      cfg.beamLabels = document.getElementById('cfg-beamlbls').checked;
      // Validated together: a column threshold at or below the beam threshold
      // would leave the brace band inverted and silently reclassify the model.
      const caEl = document.getElementById('cfg-col-angle');
      const baEl = document.getElementById('cfg-beam-angle');
      if (caEl && baEl) {
        const ca = +caEl.value, ba = +baEl.value;
        if (ca > 0 && ba > 0 && ca > ba) { cfg.colAngle = ca; cfg.beamAngle = ba; }
        else {
          toast(`The column threshold (${ca}°) must be steeper than the beam ` +
                `threshold (${ba}°). Keeping ${cfg.colAngle}° and ${cfg.beamAngle}°.`, 'warn');
        }
      }
      const asEl = document.getElementById('cfg-autosolve');
      if (asEl) cfg.autoSolve = asEl.checked;
      closeModal('modal-settings');
      render();
    });

    // Support dialog
    document.getElementById('sup-ok').addEventListener('click', () => {
      const val = document.querySelector('input[name="sup"]:checked').value;
      if (pendingNodeId !== null) {
        const nd = findNode(pendingNodeId);
        if (nd) { snapshot(); nd.support = val; updateNodeTable(); render(); }
      }
      pendingNodeId = null;
      closeModal('modal-support');
    });
    document.getElementById('sup-cancel').addEventListener('click', () => closeModal('modal-support'));

    // Load dialog — direction mode buttons
    document.getElementById('load-dir-btns').addEventListener('click', e => {
      const btn = e.target.closest('.dir-mode-btn');
      if (!btn) return;
      loadDirMode = btn.dataset.mode;
      document.querySelectorAll('.dir-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === loadDirMode));
      updateLoadDialog();
    });
    document.getElementById('load-type-sel').addEventListener('change', updateLoadDialog);
    document.getElementById('load-ok').addEventListener('click', () => {
      const t = document.getElementById('load-type-sel').value;
      const cSel = document.getElementById('load-case-sel');
      // Preserve ID if editing, otherwise allocate new.
      //
      // The case fell back to the literal 1 when the selector had no usable
      // value, and a case with id 1 need not exist — the startup template
      // numbers its cases 3, 4, 5. The load then belonged to nothing, was left
      // out of every case and every combination, and the model solved to zero
      // with the load arrow still drawn on the member. Fall back to a case that
      // is actually there.
      const firstCase = loadCases.length ? loadCases[0].id : 1;
      const pickedCase = cSel ? +cSel.value : NaN;
      const ld = { id: _editingLoadId !== null ? _editingLoadId : nextId.load++,
                   type: t,
                   caseId: loadCases.some(c => c.id === pickedCase) ? pickedCase : firstCase };

      // Every numeric field is validated, not just the area-load ones: a blank or
      // non-numeric entry used to be stored as NaN (or a silent 0) and only
      // surfaced later as an opaque solver failure.
      const bad = [];
      const num = (id, label) => {
        const raw = document.getElementById(id).value;
        const v = raw === '' || raw == null ? NaN : +raw;
        if (!Number.isFinite(v)) { bad.push(label); return 0; }
        return v;
      };
      const rejectBad = () => {
        if (_editingLoadId === null && ld.id === nextId.load - 1) nextId.load--;
        toast('Invalid load input: ' + [...new Set(bad)].join(', ') + ' must be a number', 'error');
      };

      /** Helper: compute {fx, fy} from current direction mode */
      const getFxFy = () => {
        const dm = loadDirMode;
        if (dm === 'angle') {
          const mag = num('load-mag-val','Magnitude');
          const ang = num('load-ang-val','Angle') * Math.PI / 180;
          return { fx: mag * Math.cos(ang), fy: mag * Math.sin(ang) };
        } else if (dm === 'horiz') {
          return { fx: num('load-fx-val','Fx'), fy: 0 };
        } else if (dm === 'custom') {
          return { fx: num('load-fx-val','Fx'), fy: num('load-fy-val','Fy') };
        } else { // vert
          return { fx: 0, fy: num('load-fy-val','Fy') };
        }
      };

      if (t === 'nodal') {
        ld.nodeId = +document.getElementById('load-node-sel').value;
        if (!nodes.some(n => n.id === ld.nodeId)) bad.push('Node');
        const ff = getFxFy(); ld.fx = ff.fx; ld.fy = ff.fy; ld.m = 0;
      } else if (t === 'moment') {
        ld.nodeId = +document.getElementById('load-node-sel').value;
        if (!nodes.some(n => n.id === ld.nodeId)) bad.push('Node');
        ld.fx = 0; ld.fy = 0;
        ld.m = num('load-m-val','Moment');
      } else if (t === 'beam_point') {
        ld.elementId = +document.getElementById('load-beam-sel').value;
        if (!beams.some(b => b.id === ld.elementId)) bad.push('Member');
        const ff = getFxFy(); ld.fx = ff.fx; ld.fy = ff.fy;
        ld.pos = num('load-pos-val','Position');
        ld.m   = 0;
      } else if (t === 'beam_dist') {
        ld.elementId = +document.getElementById('load-beam-sel').value;
        if (!beams.some(b => b.id === ld.elementId)) bad.push('Member');
        const ff = getFxFy(); ld.fx = ff.fx; ld.fy = ff.fy; ld.m = 0;
      } else if (t === 'beam_trap') {
        ld.elementId = +document.getElementById('load-beam-sel').value;
        if (!beams.some(b => b.id === ld.elementId)) bad.push('Member');
        const dm = loadDirMode;
        if (dm === 'angle') {
          const mag1 = num('load-mag-val','Magnitude');
          const mag2 = num('load-fy2-val','End magnitude'); // end magnitude
          const ang  = num('load-ang-val','Angle') * Math.PI / 180;
          ld.fx  = mag1 * Math.cos(ang); ld.fy  = mag1 * Math.sin(ang);
          ld.fx2 = mag2 * Math.cos(ang); ld.fy2 = mag2 * Math.sin(ang);
        } else if (dm === 'horiz') {
          const v = num('load-fx-val','Fx');
          ld.fx = v; ld.fy = 0; ld.fx2 = v; ld.fy2 = 0;
        } else if (dm === 'custom') {
          ld.fx  = num('load-fx-val','Fx');
          ld.fy  = num('load-fy-val','Fy');
          ld.fx2 = ld.fx;
          ld.fy2 = num('load-fy2-val','End magnitude');
        } else { // vert
          ld.fx = 0; ld.fy  = num('load-fy-val','Fy');
          ld.fx2 = 0; ld.fy2 = num('load-fy2-val','End magnitude');
        }
        ld.m = 0;
      } else if (t === 'area_load') {
        const raw = document.getElementById('load-area-nodes').value;
        const ids = raw.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length < 3) { if (_editingLoadId === null && ld.id === nextId.load - 1) nextId.load--; toast('Area load needs ≥ 3 node IDs', 'error'); return; }
        ld.nodeIds = ids;
        ld.p = num('load-pressure-val','Pressure');
      }

      if (bad.length) { rejectBad(); return; }

      snapshot();
      if (_editingLoadId !== null) {
        // Replace existing load in-place
        const idx = loads.findIndex(l => l.id === _editingLoadId);
        if (idx !== -1) loads[idx] = ld;
        _editingLoadId = null;
      } else {
        loads.push(ld);
      }
      // Reset modal title/button back to "Add"
      document.getElementById('load-modal-title').textContent = 'Add Load';
      document.getElementById('load-ok').textContent = 'Add';
      updateLoadTable(); results = null; render();
      if (cfg.autoSolve) solve();
      closeModal('modal-load');
    });
    document.getElementById('load-cancel').addEventListener('click', () => {
      _editingLoadId = null;
      document.getElementById('load-modal-title').textContent = 'Add Load';
      document.getElementById('load-ok').textContent = 'Add';
      closeModal('modal-load');
    });

    // Section dialog — preset loader
    document.getElementById('sec-preset').addEventListener('change', function() {
      if (!this.value) return;
      const parts = this.value.split('|');
      // format: name|E|A|I|fy|rho[|Iy|J]
      document.getElementById('sec-name').value = parts[0];
      document.getElementById('sec-E').value    = parts[1];
      document.getElementById('sec-A').value    = parts[2];
      document.getElementById('sec-I').value    = parts[3];
      document.getElementById('sec-fy').value   = parts[4] || 235;
      const rhoEl = document.getElementById('sec-rho');
      if (rhoEl) rhoEl.value = parts[5] || 0;
      const IyEl = document.getElementById('sec-Iy'), JEl = document.getElementById('sec-J');
      if (IyEl) IyEl.value = parts[6] || '';
      if (JEl)  JEl.value  = parts[7] || '';
    });

    document.getElementById('sec-ok').addEventListener('click', () => {
      snapshot();
      const Ival = +document.getElementById('sec-I').value;
      const IyEl = document.getElementById('sec-Iy'), JEl = document.getElementById('sec-J');
      const sec = {
        id:   allocSectionId(),
        name: document.getElementById('sec-name').value || 'Section',
        E:    +document.getElementById('sec-E').value,
        A:    +document.getElementById('sec-A').value,
        I:    Ival,
        Ix:   Ival,   // strong axis (same as I for 2D compat)
        fy:   +document.getElementById('sec-fy').value || 235,
        rho:  +(document.getElementById('sec-rho')||{value:0}).value || 0
      };
      if (IyEl && IyEl.value) sec.Iy = +IyEl.value;
      if (JEl  && JEl.value)  sec.J  = +JEl.value;
      sections.push(sec);
      updateSectionTable(); updateBeamTable();
      closeModal('modal-section');
      // Reset preset selector
      document.getElementById('sec-preset').value = '';
    });
    document.getElementById('sec-cancel').addEventListener('click', () => closeModal('modal-section'));

    // Settlement dialog
    document.getElementById('settle-ok').addEventListener('click', () => {
      const nid = +document.getElementById('settle-node-sel').value;
      const dir = document.getElementById('settle-dir').value;
      const val = +document.getElementById('settle-val').value;
      snapshot();
      settlements.push({ id: nextId.settlement++, nodeId: nid, dir, value: val });
      closeModal('modal-settle');
    });
    document.getElementById('settle-cancel').addEventListener('click', () => closeModal('modal-settle'));

    // Wizard
    document.getElementById('btn-wizard').addEventListener('click', () => {
      if (window.WIZ) WIZ.open();
      openModal('modal-wizard');
    });
    document.getElementById('wiz-ok').addEventListener('click', runWizard);
    document.getElementById('wiz-cancel').addEventListener('click', () => closeModal('modal-wizard'));

    // Shortcuts modal
    document.getElementById('shortcuts-close').addEventListener('click', () => closeModal('modal-shortcuts'));

    // ── Mirror ─────────────────────────────────────────────────────
    document.getElementById('btn-mirror').addEventListener('click', () => openModal('modal-mirror'));
    document.getElementById('mirror-ok').addEventListener('click', () => {
      const axis   = document.querySelector('input[name="mirror-axis"]:checked').value;
      const value  = axis==='y' ? +document.getElementById('mirror-x').value : +document.getElementById('mirror-y').value;
      const action = document.getElementById('mirror-action').value;
      mirrorStructure(axis, value, action);
      closeModal('modal-mirror');
    });
    document.getElementById('mirror-cancel').addEventListener('click', () => closeModal('modal-mirror'));

    // ── Self-weight ────────────────────────────────────────────────
    document.getElementById('btn-selfwt').addEventListener('click', () => {
      const cSel = document.getElementById('selfwt-case');
      if (cSel) cSel.innerHTML = loadCases.map(lc=>`<option value="${lc.id}">${escapeIssue(lc.name)}</option>`).join('');
      openModal('modal-selfwt');
    });
    document.getElementById('selfwt-ok').addEventListener('click', () => {
      const rho   = +document.getElementById('selfwt-rho').value  || 0;
      const scope = document.getElementById('selfwt-scope').value;
      const cid   = +(document.getElementById('selfwt-case')||{}).value || 1;
      applySelfWeight(rho, cid, scope);
      closeModal('modal-selfwt');
    });
    document.getElementById('selfwt-cancel').addEventListener('click', () => closeModal('modal-selfwt'));

    // ── Report ────────────────────────────────────────────────────
    document.getElementById('btn-report').addEventListener('click', generateHTMLReport);

    // ── Z-elevation reset button ──────────────────────────────────
    const nodeZResetBtn = document.getElementById('node-z-reset');
    if (nodeZResetBtn) nodeZResetBtn.addEventListener('click', () => {
      const inp = document.getElementById('new-node-z');
      if (inp) { inp.value = '0'; toast('Z reset to 0', 'info'); }
    });

    // ── P-Delta toggle ─────────────────────────────────────────────
    const btnPdelta = document.getElementById('btn-pdelta');
    if (btnPdelta) {
      btnPdelta.addEventListener('click', () => {
        pDeltaEnabled = !pDeltaEnabled;
        btnPdelta.classList.toggle('active', pDeltaEnabled);
        toast(`P-Delta analysis ${pDeltaEnabled ? 'enabled' : 'disabled'}`, 'info');
        if (cfg.autoSolve) solve();
      });
    }

    // ── Mode Shape Analysis ─────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════
    //  Mode Shape Animation — multi-mode simultaneous + sound
    // ══════════════════════════════════════════════════════════════
    let _modeAnimId    = null;   // requestAnimationFrame id
    let _modeT         = 0;      // animation wall-clock time (seconds)
    let _modeHighlight = 0;      // which mode chip is currently selected

    const modeBar     = document.getElementById('mode-bar');
    const modeStop    = document.getElementById('mode-stop');
    const modeSpd     = document.getElementById('mode-speed');
    const modeChips   = document.getElementById('mode-chips');

    // Colours for each mode (up to 8)
    const MODE_COLORS = [
      '#9c27b0','#e53935','#1565c0','#2e7d32',
      '#e65100','#00838f','#6d4c41','#37474f'
    ];

    // ── Build mode chips in the bar ───────────────────────────────
    function buildModeChips() {
      if (!modeChips || !_modeData) return;
      modeChips.innerHTML = '';
      _modeData.modes.forEach((m, i) => {
        const chip = document.createElement('button');
        chip.className = 'btn-xs';
        chip.style.cssText = `background:${MODE_COLORS[i]}22;color:${MODE_COLORS[i]};
          border:1.5px solid ${MODE_COLORS[i]}88;font-size:10px;padding:1px 6px;border-radius:10px;
          font-weight:700;cursor:pointer;min-width:62px;`;
        const tDisp = m.period < 1000 ? m.period.toFixed(3) + 's' : '∞';
        chip.title = `Mode ${m.modeNum} — T=${m.period < 1000 ? m.period.toFixed(4) : '∞'} s | f=${m.freq.toFixed(4)} Hz | Ux=${(m.uxPct||0).toFixed(1)}% | Uy=${(m.uyPct||0).toFixed(1)}%`;
        chip.innerHTML = `M${m.modeNum} <span style="font-weight:400;font-size:9px">T=${tDisp}</span>`;
        chip.dataset.modeIdx = i;
        chip.addEventListener('click', () => {
          _modeHighlight = i;
          highlightChip(i);
          updateModeInfoOverlay(i);
          if (_modeAnimId) {
            // Animation running — switch to this mode; reset phase for clean start
            _modeT = 0;
          } else {
            // Static — show peak shape
            clearModeShapes();
            const g = modeLayer();
            if (g) { const grp = drawSingleModeShape(i, 1.0); if (grp) g.appendChild(grp); }
          }
        });
        modeChips.appendChild(chip);
      });
    }

    function highlightChip(idx) {
      if (!modeChips) return;
      [...modeChips.children].forEach((chip, i) => {
        const col = MODE_COLORS[i];
        chip.style.background    = i === idx ? `${col}44` : `${col}11`;
        chip.style.borderColor   = i === idx ? col        : `${col}55`;
        chip.style.boxShadow     = i === idx ? `0 0 6px ${col}88` : 'none';
      });
    }

    // ── ETABS-style mode shape: wire shadow + cubic deformed + node dots ──
    // ── 3D mode shapes ────────────────────────────────────────────
    //
    // A space-frame mode moves in all three directions at once, and the
    // planar drawing path cannot express that: it carries the out-of-plane
    // coordinate through untouched, so a torsional mode — the one worth
    // looking at in 3D — renders as a straight undeformed frame.
    //
    // The member curve is interpolated in the element's own local axes, the
    // same ones solver3d builds the stiffness on, then rotated back to global.
    // Two bending planes, with the sign convention each uses:
    //   local y:  v' =  θz   →  v = H1·v1 + H2·θz1 + H3·v2 + H4·θz2
    //   local z:  w' = −θy   →  w = H1·w1 − H2·θy1 + H3·w2 − H4·θy2
    function drawModeShape3D(modeIdx, amplitudeScale) {
      const m = _modeData?.modes[modeIdx]; if (!m) return null;
      if (typeof buildDCM3D !== 'function') return null;
      const phi   = m.phi;
      const nIdx2 = {}; nodes.forEach((nd, i) => { nIdx2[nd.id] = i; });
      const svgNS = 'http://www.w3.org/2000/svg';
      const color = MODE_COLORS[modeIdx] || '#9c27b0';
      const P     = nd => [nd.x || 0, nd.y || 0, nd.z || 0];

      const svgEl  = svg();
      const diagPx = Math.hypot(svgEl.clientWidth || 800, svgEl.clientHeight || 600);
      const maxPhi = Math.max(...nodes.map(nd => {
        const i = nIdx2[nd.id];
        return Math.hypot(phi[i*6] || 0, phi[i*6+1] || 0, phi[i*6+2] || 0);
      }).filter(Number.isFinite), 1e-10);
      const ampM = amplitudeScale * diagPx * 0.07 / (maxPhi * scale);

      const group = document.createElementNS(svgNS, 'g');
      group.setAttribute('class', `sv-mode-shape sv-mode-${modeIdx}`);
      group.setAttribute('pointer-events', 'none');

      const shadowColor = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';

      // ── Undeformed wire shadow ──────────────────────────────────
      for (const bm of beams) {
        const ni = nodes[nIdx2[bm.node1]], nj = nodes[nIdx2[bm.node2]];
        if (!ni || !nj) continue;
        const a = P(ni), b = P(nj);
        const pi = mToS3D(a[0], a[1], a[2]), pj = mToS3D(b[0], b[1], b[2]);
        const sh = document.createElementNS(svgNS, 'line');
        sh.setAttribute('x1', pi.x.toFixed(1)); sh.setAttribute('y1', pi.y.toFixed(1));
        sh.setAttribute('x2', pj.x.toFixed(1)); sh.setAttribute('y2', pj.y.toFixed(1));
        sh.setAttribute('stroke', shadowColor);
        sh.setAttribute('stroke-width', '1.5');
        sh.setAttribute('stroke-dasharray', '6,4');
        group.appendChild(sh);
      }

      // ── Deformed members ────────────────────────────────────────
      const npts = 20;
      const dot3 = (r, v) => r[0]*v[0] + r[1]*v[1] + r[2]*v[2];
      for (const bm of beams) {
        const ni = nodes[nIdx2[bm.node1]], nj = nodes[nIdx2[bm.node2]];
        if (!ni || !nj) continue;
        const a = P(ni), b = P(nj);
        const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
        const L = Math.hypot(dx, dy, dz);
        if (L < 1e-10) continue;
        const { λ } = buildDCM3D(dx, dy, dz, L);
        const toL = v => [dot3(λ[0], v), dot3(λ[1], v), dot3(λ[2], v)];
        // λ rows are the local axes in global components, so λᵀ takes a local
        // vector back to global.
        const toG = v => [
          λ[0][0]*v[0] + λ[1][0]*v[1] + λ[2][0]*v[2],
          λ[0][1]*v[0] + λ[1][1]*v[1] + λ[2][1]*v[2],
          λ[0][2]*v[0] + λ[1][2]*v[1] + λ[2][2]*v[2]
        ];

        const ii = nIdx2[bm.node1] * 6, ij = nIdx2[bm.node2] * 6;
        const g = k => [(phi[k] || 0) * ampM, (phi[k+1] || 0) * ampM, (phi[k+2] || 0) * ampM];
        const d1 = toL(g(ii)),     d2 = toL(g(ij));
        const r1 = toL(g(ii + 3)), r2 = toL(g(ij + 3));

        const pts = [];
        for (let k = 0; k <= npts; k++) {
          const xi = k / npts;
          const H1 = 1 - 3*xi*xi + 2*xi*xi*xi;
          const H2 = xi*(1-xi)*(1-xi)*L;
          const H3 = 3*xi*xi - 2*xi*xi*xi;
          const H4 = xi*xi*(xi-1)*L;
          const uL = (1 - xi)*d1[0] + xi*d2[0];
          const vL = H1*d1[1] + H2*r1[2] + H3*d2[1] + H4*r2[2];
          const wL = H1*d1[2] - H2*r1[1] + H3*d2[2] - H4*r2[1];
          const dG = toG([uL, vL, wL]);
          const sp = mToS3D(a[0] + dx*xi + dG[0],
                            a[1] + dy*xi + dG[1],
                            a[2] + dz*xi + dG[2]);
          pts.push(`${sp.x.toFixed(1)},${sp.y.toFixed(1)}`);
        }
        const pl = document.createElementNS(svgNS, 'polyline');
        pl.setAttribute('points', pts.join(' '));
        pl.setAttribute('fill', 'none');
        pl.setAttribute('stroke', color);
        pl.setAttribute('stroke-width', '2.5');
        pl.setAttribute('stroke-linecap', 'round');
        pl.setAttribute('stroke-linejoin', 'round');
        pl.setAttribute('opacity', '0.95');
        group.appendChild(pl);
      }

      // ── Deformed node dots ──────────────────────────────────────
      for (const nd of nodes) {
        const i = nIdx2[nd.id] * 6, p = P(nd);
        const sp = mToS3D(p[0] + (phi[i]   || 0) * ampM,
                          p[1] + (phi[i+1] || 0) * ampM,
                          p[2] + (phi[i+2] || 0) * ampM);
        const c2 = document.createElementNS(svgNS, 'circle');
        c2.setAttribute('cx', sp.x.toFixed(1));
        c2.setAttribute('cy', sp.y.toFixed(1));
        c2.setAttribute('r',  '4');
        c2.setAttribute('fill',   color);
        c2.setAttribute('stroke', '#fff');
        c2.setAttribute('stroke-width', '1.5');
        c2.setAttribute('opacity', '0.95');
        group.appendChild(c2);
      }
      return group;
    }
    function drawSingleModeShape(modeIdx, amplitudeScale) {
      // A 3D modal result carries six DOF per node; this path assumes three.
      if (_modeData?.is3D) return drawModeShape3D(modeIdx, amplitudeScale);
      const m = _modeData?.modes[modeIdx]; if (!m) return null;
      const phi   = m.phi;
      const nIdx2 = {}; nodes.forEach((nd, i) => { nIdx2[nd.id] = i; });
      const svgNS = 'http://www.w3.org/2000/svg';
      const color = MODE_COLORS[modeIdx] || '#9c27b0';

      // Mode DOFs live in the planar (x, v) system the eigen-solve used, where v
      // is the effective vertical: nd.z for 3D and Z-lifted models, else nd.y.
      // Project through the same rules as nodeToS so shapes land on the model.
      const vOf     = nd => mode3D ? (nd.z || 0)
                                   : ((nd.y === 0 && nd.z) ? nd.z : nd.y);
      const depthOf = nd => mode3D ? (nd.y || 0) : 0;
      const planarToS = (px, pv, pd) => mode3D ? mToS3D(px, pd, pv) : mToS(px, pv);

      // Amplitude: scale so max visual displacement ≈ 8 % of canvas diagonal
      const svgEl  = svg();
      const diagPx = Math.hypot(svgEl.clientWidth || 800, svgEl.clientHeight || 600);
      const maxPhi = Math.max(...nodes.map(nd => {
        const i = nIdx2[nd.id];
        return Math.hypot(phi[i*3] || 0, phi[i*3+1] || 0);
      }).filter(Number.isFinite), 1e-10);
      const ampM = amplitudeScale * diagPx * 0.07 / (maxPhi * scale);  // metres

      const group = document.createElementNS(svgNS, 'g');
      group.setAttribute('class', `sv-mode-shape sv-mode-${modeIdx}`);
      group.setAttribute('pointer-events', 'none');

      // ── 1. Wire shadow: undeformed structure in dim grey ────────
      const shadowColor = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';

      for (const bm of beams) {
        const ni = nodes[nIdx2[bm.node1]], nj = nodes[nIdx2[bm.node2]];
        if (!ni || !nj) continue;
        const pi = planarToS(ni.x, vOf(ni), depthOf(ni));
        const pj = planarToS(nj.x, vOf(nj), depthOf(nj));
        const sh = document.createElementNS(svgNS, 'line');
        sh.setAttribute('x1', pi.x.toFixed(1)); sh.setAttribute('y1', pi.y.toFixed(1));
        sh.setAttribute('x2', pj.x.toFixed(1)); sh.setAttribute('y2', pj.y.toFixed(1));
        sh.setAttribute('stroke', shadowColor);
        sh.setAttribute('stroke-width', '1.5');
        sh.setAttribute('stroke-dasharray', '6,4');
        group.appendChild(sh);
      }

      // ── 2. Deformed shape: Hermitian cubic interpolation ────────
      const npts = 20;
      for (const bm of beams) {
        const ni = nodes[nIdx2[bm.node1]], nj = nodes[nIdx2[bm.node2]];
        if (!ni || !nj) continue;
        const ii = nIdx2[bm.node1], ij = nIdx2[bm.node2];
        const dx = nj.x - ni.x, dy = vOf(nj) - vOf(ni);
        const dd = depthOf(nj) - depthOf(ni);          // out-of-plane, carried through
        const L  = Math.hypot(dx, dy); if (L < 1e-10) continue;
        const c  = dx / L, s = dy / L;

        const u1 = (phi[ii*3]   || 0) * ampM, v1 = (phi[ii*3+1] || 0) * ampM;
        const t1 = (phi[ii*3+2] || 0) * ampM;
        const u2 = (phi[ij*3]   || 0) * ampM, v2 = (phi[ij*3+1] || 0) * ampM;
        const t2 = (phi[ij*3+2] || 0) * ampM;

        // Local-axis displacements
        const ul1 =  u1*c + v1*s,  vl1 = -u1*s + v1*c;
        const ul2 =  u2*c + v2*s,  vl2 = -u2*s + v2*c;

        const pts = [];
        for (let k = 0; k <= npts; k++) {
          const xi = k / npts;
          const H1 = 1 - 3*xi*xi + 2*xi*xi*xi;
          const H2 = xi*(1-xi)*(1-xi)*L;
          const H3 = 3*xi*xi - 2*xi*xi*xi;
          const H4 = xi*xi*(xi-1)*L;
          const vy_loc = H1*vl1 + H2*t1 + H3*vl2 + H4*t2;
          const ux_loc = (1 - xi)*ul1 + xi*ul2;
          const du = ux_loc*c - vy_loc*s;
          const dv = ux_loc*s + vy_loc*c;
          const sp = planarToS(ni.x + dx*xi + du,
                               vOf(ni) + dy*xi + dv,
                               depthOf(ni) + dd*xi);
          pts.push(`${sp.x.toFixed(1)},${sp.y.toFixed(1)}`);
        }
        const pl = document.createElementNS(svgNS, 'polyline');
        pl.setAttribute('points', pts.join(' '));
        pl.setAttribute('fill', 'none');
        pl.setAttribute('stroke', color);
        pl.setAttribute('stroke-width', '2.5');
        pl.setAttribute('stroke-linecap', 'round');
        pl.setAttribute('stroke-linejoin', 'round');
        pl.setAttribute('opacity', '0.95');
        group.appendChild(pl);
      }

      // ── 3. Deformed node dots ───────────────────────────────────
      for (const nd of nodes) {
        const i  = nIdx2[nd.id];
        const du = (phi[i*3]   || 0) * ampM;
        const dv = (phi[i*3+1] || 0) * ampM;
        const sp = planarToS(nd.x + du, vOf(nd) + dv, depthOf(nd));
        const c2 = document.createElementNS(svgNS, 'circle');
        c2.setAttribute('cx', sp.x.toFixed(1));
        c2.setAttribute('cy', sp.y.toFixed(1));
        c2.setAttribute('r',  '4');
        c2.setAttribute('fill',   color);
        c2.setAttribute('stroke', '#fff');
        c2.setAttribute('stroke-width', '1.5');
        c2.setAttribute('opacity', '0.95');
        group.appendChild(c2);
      }

      return group;
    }

    // Overlay layer for mode shapes — sits above the model and is untouched
    // by render(), which clears only the layers it draws.
    const modeLayer = () => document.getElementById('layer-defl');

    // ── Clear all mode shape groups and overlay ───────────────────
    function clearModeShapes() {
      document.querySelectorAll('.sv-mode-shape').forEach(el => el.remove());
    }

    // ── ETABS-style info overlay (top-right of canvas) ───────────
    // Shows: Mode N | T = x.xxx s | f = x.xx Hz | Ux xx% | Uy xx%
    function updateModeInfoOverlay(modeIdx) {
      const wrap = document.getElementById('canvas-wrap'); if (!wrap) return;

      let box = document.getElementById('mode-info-overlay');
      if (!box) {
        box = document.createElement('div');
        box.id = 'mode-info-overlay';
        box.style.cssText = [
          'position:absolute', 'top:10px', 'right:12px',
          'background:rgba(0,0,0,0.62)',
          'color:#fff',
          'font-family:monospace',
          'font-size:11.5px',
          'line-height:1.7',
          'padding:7px 11px',
          'border-radius:5px',
          'pointer-events:none',
          'z-index:50',
          'min-width:168px',
          'border:1px solid rgba(255,255,255,0.15)',
          'backdrop-filter:blur(4px)'
        ].join(';');
        wrap.appendChild(box);
      }

      const m = _modeData?.modes[modeIdx];
      if (!m) { box.style.display = 'none'; return; }
      box.style.display = '';

      const color    = MODE_COLORS[modeIdx] || '#9c27b0';
      const dot      = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle"></span>`;
      const tStr     = m.period < 1000 ? m.period.toFixed(4) + ' s'  : '∞';
      const fStr     = m.freq.toFixed(4)  + ' Hz';
      const uxStr    = typeof m.uxPct === 'number' ? m.uxPct.toFixed(1) + '%' : '—';
      const uyStr    = typeof m.uyPct === 'number' ? m.uyPct.toFixed(1) + '%' : '—';
      const row = (label, val) =>
        `<div style="display:flex;justify-content:space-between;gap:14px">
           <span style="opacity:0.7">${label}</span>
           <span style="font-weight:700">${val}</span>
         </div>`;

      box.innerHTML =
        `<div style="font-size:12px;font-weight:700;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.2);padding-bottom:3px">
           ${dot}Mode ${m.modeNum}
         </div>` +
        row('Period T',  tStr) +
        row('Freq f',    fStr) +
        row('Mass X',    uxStr) +
        row('Mass Y',    uyStr);
    }

    function removeModeInfoOverlay() {
      const box = document.getElementById('mode-info-overlay');
      if (box) box.remove();
    }

    // ── Show modes bar and compute ────────────────────────────────
    function showModeBar() {
      if (!window.ModeShapeAnalysis) { toast('ModeShapeAnalysis not loaded', 'error'); return; }
      const res = getActiveResults();
      if (!res || !res.success) { toast('Solve first before running mode analysis', 'warn'); return; }
      const numModes = parseInt(document.getElementById('mode-count')?.value || 8);
      // Six DOF per node in 3D, three in 2D. The mode bar, the participation
      // table and the shape drawing all follow _modeData.is3D from here.
      window.PerfMonitor?.start('modes');
      _modeData = mode3D
        ? ModeShapeAnalysis.computeModes3D(nodes, beams, sections, numModes, massOptions())
        : ModeShapeAnalysis.computeModes(nodes, beams, sections, numModes, massOptions());
      window.PerfMonitor?.end('modes');
      if (_modeData.error) { toast('Mode analysis: ' + _modeData.error, 'error'); return; }
      if (_modeData.converged === false)
        toast('Mode shapes did not fully converge — frequencies below are the last iterate, ' +
              'not a settled answer. Treat them as indicative.', 'warn');
      _modeHighlight = 0;
      buildModeChips();
      highlightChip(0);
      if (modeBar) modeBar.style.display = 'flex';
      // Show mode 1 static peak shape immediately
      clearModeShapes();
      const g = modeLayer();
      if (g) {
        const grp = drawSingleModeShape(0, 1.0);
        if (grp) g.appendChild(grp);
      }
      updateModeInfoOverlay(0);
      toast(`${_modeData.modes.length} modes computed`, 'info');
    }

    // ── Animate selected mode shape (ETABS-style sinusoidal oscillation) ──
    // Smoothly oscillates the selected mode: +1 → 0 → −1 → 0 → +1
    // No auto-cycling. Click a chip to switch modes while animating.
    function startModeAnimAll() {
      if (_modeAnimId) return;
      document.getElementById('mode-play-all').style.display = 'none';
      if (modeStop) modeStop.style.display = '';
      _modeT = 0;
      let last = performance.now();

      function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const spd = parseFloat(modeSpd?.value || 1);
        _modeT += dt * spd;

        // Pure sinusoidal: one full cycle per second × speed
        const amp = Math.sin(_modeT * Math.PI * 2);

        clearModeShapes();
        const g = modeLayer();
        if (g && _modeData) {
          const grp = drawSingleModeShape(_modeHighlight, amp);
          if (grp) g.appendChild(grp);
        }

        _modeAnimId = requestAnimationFrame(frame);
      }
      _modeAnimId = requestAnimationFrame(frame);
    }

    // ── Stop animation ────────────────────────────────────────────
    function stopModeAnim() {
      if (_modeAnimId) { cancelAnimationFrame(_modeAnimId); _modeAnimId = null; }
      clearModeShapes();
      // Restore peak shape (amp = 1) and keep info overlay — same as ETABS Stop
      if (_modeData) {
        const g = modeLayer();
        if (g) { const grp = drawSingleModeShape(_modeHighlight, 1.0); if (grp) g.appendChild(grp); }
        updateModeInfoOverlay(_modeHighlight);
      }
      const playAllBtn = document.getElementById('mode-play-all');
      if (playAllBtn) playAllBtn.style.display = '';
      if (modeStop) modeStop.style.display = 'none';
    }

    // Rebuild the static mode-shape overlay after a render (pan / zoom / theme).
    // Skipped while animating — the animation loop already redraws every frame.
    _redrawModeShapes = () => {
      if (_modeAnimId || !_modeData || !_modeData.modes) return;
      const layer = modeLayer();
      if (!layer || !layer.querySelector('.sv-mode-shape')) return;
      clearModeShapes();
      const grp = drawSingleModeShape(_modeHighlight, 1.0);
      if (grp) layer.appendChild(grp);
    };

    document.getElementById('btn-modes')?.addEventListener('click', showModeBar);
    document.getElementById('mode-recompute')?.addEventListener('click', () => { stopModeAnim(); showModeBar(); });
    document.getElementById('mode-play-all')?.addEventListener('click', startModeAnimAll);
    document.getElementById('mode-stop')?.addEventListener('click', stopModeAnim);
    document.getElementById('mode-close')?.addEventListener('click', () => {
      stopModeAnim();
      clearModeShapes();
      removeModeInfoOverlay();
      if (modeBar) modeBar.style.display = 'none';
    });

    // ── Auto Combo Generator ────────────────────────────────────────
    const btnCombos = document.getElementById('btn-combos');
    if (btnCombos) btnCombos.addEventListener('click', () => openModal('modal-combos'));

    const comboGenPreview = document.getElementById('combo-gen-preview');
    if (comboGenPreview) comboGenPreview.addEventListener('click', () => {
      if (!window.LoadCombosGenerator) { toast('LoadCombosGenerator not loaded','error'); return; }
      const code           = document.getElementById('combo-gen-code')?.value || 'EC0';
      const method         = document.getElementById('combo-gen-method')?.value || 'LRFD';
      const includeSeismic = document.getElementById('combo-gen-seismic')?.checked || false;
      const ulsOnly        = document.getElementById('combo-gen-uls-only')?.checked || false;
      const slsOnly        = document.getElementById('combo-gen-sls-only')?.checked || false;
      const generated = LoadCombosGenerator.generate(loadCases, code, { method, includeSeismic, ulsOnly, slsOnly });
      const area = document.getElementById('combo-gen-preview-area');
      area.innerHTML = generated.length === 0
        ? '<p style="color:#e53935">No combinations generated. Check load case types (DL/LL/WL/SL/EQ needed).</p>'
        : LoadCombosGenerator.buildSummaryHTML(generated, loadCases);
      area._generated = generated;
    });

    function applyGeneratedCombos(replace) {
      if (!window.LoadCombosGenerator) return;
      const area = document.getElementById('combo-gen-preview-area');
      const generated = area._generated;
      if (!generated || !generated.length) {
        toast('Preview first, then apply', 'warn'); return;
      }
      const formatted = LoadCombosGenerator.toAppFormat(generated, nextId.combo);
      if (replace) loadCombos = [];
      formatted.forEach(c => {
        loadCombos.push({ id: nextId.combo++, name: c.name, factors: c.factors });
      });
      snapshot(); updateCasesPane(); populateDisplaySelector();
      closeModal('modal-combos');
      toast(`${formatted.length} combinations ${replace ? 'replaced' : 'added'}`, 'ok');
    }

    const comboGenApply   = document.getElementById('combo-gen-apply');
    const comboGenReplace = document.getElementById('combo-gen-replace');
    const comboGenClose   = document.getElementById('combo-gen-close');
    if (comboGenApply)   comboGenApply.addEventListener('click',   () => applyGeneratedCombos(false));
    if (comboGenReplace) comboGenReplace.addEventListener('click',  () => applyGeneratedCombos(true));
    if (comboGenClose)   comboGenClose.addEventListener('click',    () => closeModal('modal-combos'));

    // ── Foundation Design ───────────────────────────────────────────
    const btnFoundation = document.getElementById('btn-foundation');
    if (btnFoundation) btnFoundation.addEventListener('click', () => openModal('modal-foundation'));

    function getFoundationParams() {
      const gv = id => parseFloat(document.getElementById(id).value) || 0;
      return {
        L: gv('fnd-L'), B: gv('fnd-B'), h_f: gv('fnd-h'),
        col_L: gv('fnd-colL'), col_B: gv('fnd-colB'), Df: gv('fnd-Df'),
        qa: gv('fnd-qa'), φ_soil: gv('fnd-phi-soil'), c_soil: gv('fnd-c-soil'), γsoil: gv('fnd-gamma-soil'),
        N_G: gv('fnd-NG'), N_Q: gv('fnd-NQ'), N_W: gv('fnd-NW'),
        Mx_G: gv('fnd-MxG'), Mx_Q: gv('fnd-MxQ'), My_G: 0,
        H_G: gv('fnd-HG'), H_Q: gv('fnd-HQ'),
        fck: gv('fnd-fck'), fyk: gv('fnd-fyk'),
        cover: gv('fnd-cover'), phi: gv('fnd-phi-bar')
      };
    }

    const fndRun = document.getElementById('fnd-run');
    if (fndRun) fndRun.addEventListener('click', () => {
      if (!window.FoundationDesign || !window.RCDesign) {
        toast('Foundation modules not loaded', 'error'); return;
      }
      const params = getFoundationParams();
      const result = FoundationDesign.designPadFoundation(params);
      const area   = document.getElementById('fnd-results');
      area.innerHTML = FoundationDesign.buildReportHTML(result);
      area._result = result;
      const s = result.summary;
      toast(`Foundation ${s.status} — η=${s.maxEta}`, s.status === 'OK' ? 'ok' : 'warn');
    });

    const fndOptimize = document.getElementById('fnd-optimize');
    if (fndOptimize) fndOptimize.addEventListener('click', () => {
      if (!window.FoundationDesign) return;
      const params = getFoundationParams();
      const r = FoundationDesign.optimizeSize(params);
      if (r.error) { toast(r.error, 'error'); return; }
      document.getElementById('fnd-L').value = r.recommended_L;
      document.getElementById('fnd-B').value = r.recommended_B;
      toast(`Optimal size: ${r.recommended_L}×${r.recommended_B} m`, 'ok');
      // Re-run with optimal size
      document.getElementById('fnd-run').click();
    });

    const fndReport = document.getElementById('fnd-report');
    if (fndReport) fndReport.addEventListener('click', () => {
      const area = document.getElementById('fnd-results');
      const result = area._result;
      if (!result) { toast('Run design first', 'warn'); return; }
      if (!window.ReportGenerator) return;
      // Build a mini foundation report
      const html = ReportGenerator.generate({
        title:       'Foundation Design Report',
        projectName: projectMeta.title,
        engineer:    projectMeta.engineer,
        company:     projectMeta.company,
        date:        new Date().toLocaleDateString(),
        nodes: [], beams: [], sections: [], loads: [], loadCases: [],
        results: null, designResults: null
      });
      const win = window.open('', '_blank', 'width=1100,height=850');
      if (!win) { toast('Pop-up blocked', 'error'); return; }
      // Custom foundation report
      const fndHtml = html.replace(
        '<div class="rpt-section">',
        `<div class="rpt-section"><h2>Foundation Design Results</h2>${FoundationDesign.buildReportHTML(result)}<br><div class="rpt-section">`
      );
      win.document.write(fndHtml); win.document.close();
    });

    const fndClose = document.getElementById('fnd-close');
    if (fndClose) fndClose.addEventListener('click', () => closeModal('modal-foundation'));

    // ── Load case dialog ──────────────────────────────────────────
    document.getElementById('pnl-add-case').addEventListener('click', () => {
      document.getElementById('lcase-edit-id').value = '';
      document.getElementById('lcase-name').value    = 'New Case';
      document.getElementById('lcase-type').value    = 'DL';
      document.getElementById('lcase-color').value   = '#795548';
      openModal('modal-loadcase');
    });
    document.getElementById('lcase-ok').addEventListener('click', () => {
      const editId = +document.getElementById('lcase-edit-id').value;
      const name   = document.getElementById('lcase-name').value  || 'Case';
      const type   = document.getElementById('lcase-type').value;
      const color  = document.getElementById('lcase-color').value;
      snapshot();
      if (editId) {
        const lc = loadCases.find(c=>c.id===editId);
        if (lc) { lc.name=name; lc.type=type; lc.color=color; }
      } else {
        loadCases.push({ id:nextId.lcase++, name, type, color });
      }
      updateCasesPane(); updateLoadTable();
      closeModal('modal-loadcase');
    });
    document.getElementById('lcase-cancel').addEventListener('click', () => closeModal('modal-loadcase'));

    // ── Combo dialog ──────────────────────────────────────────────
    document.getElementById('pnl-add-combo').addEventListener('click', () => {
      openEditCombo(null);
    });
    document.getElementById('combo-ok').addEventListener('click', () => {
      const editId = +document.getElementById('combo-edit-id').value;
      const name   = document.getElementById('combo-name').value || 'Combo';
      const inputs = document.querySelectorAll('#combo-factors-list input[data-cid]');
      const factors = [];
      inputs.forEach(inp => factors.push({ caseId:+inp.dataset.cid, factor:+inp.value||0 }));
      snapshot();
      if (editId) {
        const cb = loadCombos.find(c=>c.id===editId);
        if (cb) { cb.name=name; cb.factors=factors; }
      } else {
        loadCombos.push({ id:nextId.combo++, name, factors });
      }
      updateCasesPane();
      closeModal('modal-combo');
    });
    document.getElementById('combo-cancel').addEventListener('click', () => closeModal('modal-combo'));

    // ── Display selector (case/combo switcher) ────────────────────
    document.getElementById('active-display-sel').addEventListener('change', function() {
      const [type, idStr] = this.value.split(':');
      activeDisplay = { type, id: +idStr };
      results = getActiveResults();
      render();
      showResultsPanel(results);
    });

    // ── Spring support show/hide fields ───────────────────────────
    document.querySelectorAll('input[name="sup"]').forEach(r =>
      r.addEventListener('change', () => {
        const spf = document.getElementById('spring-fields');
        if (spf) spf.style.display = r.value === 'spring' ? '' : 'none';
      }));

    // ── Spring values saved to node ───────────────────────────────
    // (override sup-ok handler to capture spring values)
    document.getElementById('sup-ok').removeEventListener('click', null);
    document.getElementById('sup-ok').addEventListener('click', () => {
      const val = document.querySelector('input[name="sup"]:checked').value;
      if (pendingNodeId !== null) {
        const nd = findNode(pendingNodeId);
        if (nd) {
          snapshot();
          nd.support = val;
          if (val === 'spring') {
            nd.springKx = +document.getElementById('spring-kx').value || 0;
            nd.springKy = +document.getElementById('spring-ky').value || 0;
            nd.springKm = +document.getElementById('spring-km').value || 0;
          }
          updateNodeTable(); render();
        }
      }
      pendingNodeId = null;
      closeModal('modal-support');
    });

    // ── Views: local axes checkbox ────────────────────────────────
    document.getElementById('views-ok').addEventListener('click', () => {
      // (re-attach to capture views.local and views.deflScale)
    }, { once: false });

    // ── Settings: autosolve ───────────────────────────────────────
    // (handled below by overriding cfg-ok)

    // ── Load-case filter in Loads pane ────────────────────────────
    const lcFilter = document.getElementById('pnl-load-case-filter');
    if (lcFilter) {
      lcFilter.addEventListener('change', function() {
        updateLoadTable(this.value === 'all' ? null : +this.value);
      });
    }

    // Panel buttons
    // Styled like the buttons either side of it but doing nothing on click.
    // Its tooltip carries the only explanation, which a touch user never
    // sees. Say it out loud instead of leaving a dead control in a toolbar.
    document.getElementById('pnl-nudge-info')?.addEventListener('click', () => {
      toast(selNode
        ? `Node ${selNode} selected — arrow keys nudge it by ${cfg.gridSize} m, ` +
          `Shift for ${cfg.gridSize * 5} m` +
          (mode3D ? ', Alt for the depth axis' : '')
        : 'Select a node first, then the arrow keys nudge it', 'info');
    });
    document.getElementById('pnl-add-node').addEventListener('click',  () => setTool('node'));
    document.getElementById('pnl-del-node').addEventListener('click',  () => setTool('delete'));
    // '+ Member' sits beside the Members table and its count, so it reads like
    // it will add a row the way '+ Section' does. It does not — it switches the
    // mouse into draw mode, and the only clue was the status-bar hint at the
    // very bottom of the window, nowhere near where the user just clicked. So
    // it looks like nothing happened and the button looks broken.
    document.getElementById('pnl-add-beam').addEventListener('click',  () => {
      if (nodes.length < 2) {
        toast('A member spans between two nodes, and there ' +
              (nodes.length === 1 ? 'is only 1' : 'are none') +
              ' in the model. Add nodes with + Node first.', 'warn');
        return;
      }
      // Two nodes already picked out leaves nothing to guess at — make the
      // member, which is what the button appears to promise.
      if (multiSel.nodes.size === 2) {
        const [a, b] = [...multiSel.nodes];
        snapshot();
        const bid = addBeam(a, b);
        multiSel.nodes.clear();
        updateBeamTable(); updateNodeTable(); render();
        toast(bid ? `Member created between nodes ${a} and ${b}.`
                  : 'Those two nodes are already joined by a member.',
              bid ? 'ok' : 'warn');
        return;
      }
      setTool('beam');
      toast('Draw mode: click the first node, then the second, to create a ' +
            'member. Or select exactly two nodes and press + Member again.', 'info');
    });
    document.getElementById('pnl-del-beam').addEventListener('click',  () => setTool('delete'));
    document.getElementById('pnl-add-sec').addEventListener('click',   () => openModal('modal-section'));
    document.getElementById('pnl-del-sec').addEventListener('click',   () => {
      if (selBeam) { sections = sections.filter(s => s.id !== findBeam(selBeam)?.sectionId); updateSectionTable(); }
    });

    // ── Purge unused sections ─────────────────────────────────────────
    // The library fills up from three directions — the built-in defaults, the
    // starter presets in frame_sections.js, and anything imported from Excel —
    // so a model with two sections on its members routinely lists twenty, with
    // no way to tell which two are real. Drop everything no member references.
    // snapshot() first, so Undo brings the whole library back.
    const btnPurgeSec = document.getElementById('btn-purge-sections');
    if (btnPurgeSec) btnPurgeSec.addEventListener('click', () => {
      const used = new Set(beams.map(b => b.sectionId));
      const keep = sections.filter(s => used.has(s.id));
      const drop = sections.length - keep.length;
      // With nothing assigned, every section reads as unused and this would
      // empty the library — which assignSection and the default-section repair
      // both assume never happens. Refuse instead of stripping it bare.
      if (!keep.length) {
        toast('No member has a section assigned — purging would empty the library', 'warn');
        return;
      }
      if (!drop) { toast('Nothing to purge — every section is in use', 'info'); return; }
      snapshot();
      sections = keep;
      updateSectionTable();
      render();
      toast(`Purged ${drop} unused section${drop === 1 ? '' : 's'} — ${keep.length} left. Undo restores them.`, 'ok');
    });
    document.getElementById('pnl-add-load').addEventListener('click', () => {
      _editingLoadId = null;
      document.getElementById('load-modal-title').textContent = 'Add Load';
      document.getElementById('load-ok').textContent = 'Add';
      populateLoadDialog();
      openModal('modal-load');
    });
    document.getElementById('pnl-del-load').addEventListener('click',  () => setTool('delete'));

    // Panel tabs
    document.querySelectorAll('.ptab').forEach(t => {
      t.addEventListener('click', () => switchPane(t.dataset.pane));
    });

    // ── Tools pane — Section Properties Calculator ──────────────────
    const btnSecProps = document.getElementById('btn-sec-props');
    if (btnSecProps) btnSecProps.addEventListener('click', () => {
      if (!window.SectionProps) { toast('SectionProps not loaded','error'); return; }
      const body = document.getElementById('sec-props-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = SectionProps.buildDialogHTML();
        SectionProps.wireDialog(newSec => {
          // onUseSection: add to sections list
          sections.push({ id: allocSectionId(), name: newSec.name, ...newSec });
          snapshot(); updateSectionTable(); updateBeamTable();
          toast(`Section "${newSec.name}" added to model`, 'ok');
          closeModal('modal-sec-props');
        });
        body.dataset.wired = '1';
      }
      openModal('modal-sec-props');
    });
    const spClose = document.getElementById('sp-close');
    if (spClose) spClose.addEventListener('click', () => closeModal('modal-sec-props'));

    // ── Tools pane — Beam Formulas Calculator ───────────────────────
    const btnBeamFormulas = document.getElementById('btn-beam-formulas');
    if (btnBeamFormulas) btnBeamFormulas.addEventListener('click', () => {
      if (!window.BeamFormulas) { toast('BeamFormulas not loaded','error'); return; }
      const body = document.getElementById('beam-formulas-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = BeamFormulas.buildDialogHTML();
        BeamFormulas.wireDialog();
        body.dataset.wired = '1';
      }
      openModal('modal-beam-formulas');
    });
    const bfClose = document.getElementById('bf-close');
    if (bfClose) bfClose.addEventListener('click', () => closeModal('modal-beam-formulas'));

    // ── Tools pane — Mohr's Circle Calculator ───────────────────────
    const btnMohrs = document.getElementById('btn-mohrs-circle');
    if (btnMohrs) btnMohrs.addEventListener('click', () => {
      if (!window.MohrsCircle) { toast('MohrsCircle not loaded', 'error'); return; }
      const body = document.getElementById('mohrs-circle-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = MohrsCircle.buildDialogHTML();
        MohrsCircle.wireDialog();
        body.dataset.wired = '1';
      }
      openModal('modal-mohrs-circle');
    });
    const mcClose = document.getElementById('mc-close');
    if (mcClose) mcClose.addEventListener('click', () => closeModal('modal-mohrs-circle'));

    // ── Tools pane — Natural Frequency Calculator ────────────────────
    const btnNatFreq = document.getElementById('btn-natural-freq');
    if (btnNatFreq) btnNatFreq.addEventListener('click', () => {
      if (!window.NaturalFreq) { toast('NaturalFreq not loaded', 'error'); return; }
      const body = document.getElementById('natural-freq-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = NaturalFreq.buildDialogHTML();
        NaturalFreq.wireDialog();
        body.dataset.wired = '1';
      }
      openModal('modal-natural-freq');
    });
    const nfClose = document.getElementById('nf-close');
    if (nfClose) nfClose.addEventListener('click', () => closeModal('modal-natural-freq'));

    // ── Tools pane — P-M Interaction Diagram ────────────────────────
    const btnPMD = document.getElementById('btn-pm-diagram');
    if (btnPMD) btnPMD.addEventListener('click', () => {
      if (!window.PMInteraction) { toast('PMInteraction not loaded', 'error'); return; }

      // Build demand list from current results
      const res = getActiveResults();
      const demands = [];
      if (res && res.success) {
        for (const ef of res.elemForces) {
          const bm  = beams.find(b => b.id === ef.id);
          if (!bm) continue;
          demands.push({
            beamId:    bm.id,
            sectionId: bm.sectionId,
            N_Ed: Math.max(Math.abs(ef.N1), Math.abs(ef.N2)),
            M_Ed: Math.max(Math.abs(ef.M1), Math.abs(ef.M2))
          });
        }
      }

      const body = document.getElementById('pm-diagram-body');
      body.innerHTML = PMInteraction.buildDialogHTML(sections[0], demands, sections);
      PMInteraction.wireDialog(sections, demands);
      openModal('modal-pm-diagram');
    });
    const pmiClose = document.getElementById('pmi-close');
    if (pmiClose) pmiClose.addEventListener('click', () => closeModal('modal-pm-diagram'));

    // ── Tools pane — Compound Section Builder ────────────────────────
    const btnCompSec = document.getElementById('btn-compound-section');
    if (btnCompSec) btnCompSec.addEventListener('click', () => {
      if (!window.CompoundSection) { toast('CompoundSection not loaded', 'error'); return; }
      const body = document.getElementById('compound-section-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = CompoundSection.buildDialogHTML();
        CompoundSection.wireDialog();
        body.dataset.wired = '1';
      }
      openModal('modal-compound-section');
    });
    const ccsClose = document.getElementById('ccs-close');
    if (ccsClose) ccsClose.addEventListener('click', () => closeModal('modal-compound-section'));

    // ── Tools pane — Formula Library ─────────────────────────────────
    const btnFormulaLib = document.getElementById('btn-formula-library');
    if (btnFormulaLib) btnFormulaLib.addEventListener('click', () => {
      if (!window.FormulaLibrary) { toast('FormulaLibrary not loaded', 'error'); return; }
      const body = document.getElementById('formula-library-body');
      if (body.dataset.wired !== '1') {
        body.innerHTML = FormulaLibrary.buildDialogHTML();
        FormulaLibrary.wireDialog();
        body.dataset.wired = '1';
      }
      openModal('modal-formula-library');
    });
    const flClose = document.getElementById('fl-close');
    if (flClose) flClose.addEventListener('click', () => closeModal('modal-formula-library'));

    // ── Tools pane — ACI 318-19 Material Properties Calculator ──────
    const btnAciMat = document.getElementById('btn-aci-materials');
    if (btnAciMat) btnAciMat.addEventListener('click', () => {
      openModal('modal-aci-mat');
      _buildAciMaterialsDialog();
    });
    const aciMatClose = document.getElementById('aci-mat-close');
    if (aciMatClose) aciMatClose.addEventListener('click', () => closeModal('modal-aci-mat'));

    // ── ASCE 7-16 §3 Dead Load Calculator ──────────────────────────
    const btnDeadLoad = document.getElementById('btn-dead-load-calc');
    if (btnDeadLoad) btnDeadLoad.addEventListener('click', () => {
      openModal('modal-dead-load');
      window.ASCE7_Ch3_UI?.init();
    });

    // ── Design pane — ACI §6.6.3.1 Stiffness Modifiers ─────────────
    const pnlAciApply = document.getElementById('pnl-aci-apply-mods');
    if (pnlAciApply) pnlAciApply.addEventListener('click', _applyAciStiffMods);

    const pnlAciClear = document.getElementById('pnl-aci-clear-mods');
    if (pnlAciClear) pnlAciClear.addEventListener('click', _clearAciStiffMods);

    // Zoom buttons
    document.getElementById('zoom-in').addEventListener('click',  () => { const c = svgCenter(); zoomAt(c.x, c.y, 1.25); });
    document.getElementById('zoom-out').addEventListener('click', () => { const c = svgCenter(); zoomAt(c.x, c.y, 0.8); });
    document.getElementById('zoom-fit').addEventListener('click', fitToScreen);

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(ov => {
      ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // A dialog is open: Escape dismisses it, nothing else reaches the canvas.
      // Previously tool shortcuts fired behind the dialog (g armed the delete
      // tool, i re-solved), taking effect as soon as it was closed.
      if (openModals().length) {
        if (e.key === 'Escape') { closeTopModal(); e.preventDefault(); }
        return;
      }

      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) { e.preventDefault(); redo(); return; }
      if (e.altKey && e.key.toLowerCase() === 'd') { toggleDarkMode(); return; }
      // Ctrl+A is Select All everywhere else, and this app has a Select All
      // button with no shortcut, so it used to be the one chord that did the
      // opposite of what it says. Fit moved to F, which the ribbon tooltips
      // ('Fit all to view [F]') had been promising all along.
      if (e.ctrlKey && e.key === 'a') { e.preventDefault(); selectAll(); return; }
      if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') { fitToScreen(); return; }

      // Arrow-key nudge for selected node
      if (selNode && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const nd = findNode(selNode); if (!nd) return;
        const step = e.shiftKey ? cfg.gridSize * 5 : cfg.gridSize;
        // The vertical axis is Y in 2D and Z in 3D. Nudging always moved Y,
        // so in 3D the up arrow slid the node sideways in depth and left its
        // elevation alone — the same axis mix-up that put the plan depth into
        // the ELF building height.
        const vAxis = mode3D ? 'z' : 'y';
        const dAxis = mode3D ? 'y' : 'z';
        if (e.key === 'ArrowLeft')  nd.x -= step;
        if (e.key === 'ArrowRight') nd.x += step;
        // Alt moves along the depth axis instead, which is the only way to
        // reach it now that the plain arrows mean what they say.
        const axis = e.altKey && mode3D ? dAxis : vAxis;
        if (e.key === 'ArrowUp')    nd[axis] = (nd[axis] || 0) + step;
        if (e.key === 'ArrowDown')  nd[axis] = (nd[axis] || 0) - step;
        // Geometry changed — existing results describe the old model
        results = null; allCaseResults = {}; allComboResults = {}; envelopeResult = null;
        snapshot(); updateNodeTable(); render();
        if (cfg.autoSolve) solve();
        return;
      }

      const map = { d:'node', e:'beam', h:'support', b:'hinge', c:'load', a:'section',
                    m:'settle', w:'select', g:'delete', i:'solve', v:'views', u:'files', o:'settings' };
      const t = map[e.key.toLowerCase()];
      if (t === 'solve') { solve(); return; }
      if (t === 'views') { document.getElementById('btn-views').click(); return; }
      if (t === 'files') { document.getElementById('btn-files').click(); return; }
      if (t === 'settings') { document.getElementById('btn-settings').click(); return; }
      if (t) { setTool(t); return; }

      if (e.key === '3') { const b3d = document.getElementById('btn-3d'); if (b3d) b3d.click(); return; }
      if (e.key === 'r' || e.key === 'R') {
        if (mode3D) { view3D = { az: ISO_AZ, el: ISO_EL }; render(); toast('Orbit reset', 'info'); return; }
      }
      if (e.key === '?') { openModal('modal-shortcuts'); return; }
      if (e.key === 'Escape') {
        setTool('select'); beamStart=null; highlightNode(null); clearLayer(layerTemp());
        multiSel.nodes.clear(); multiSel.beams.clear(); render();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selNode) { snapshot(); deleteNode(selNode); updateNodeTable(); updateBeamTable(); updateLoadTable(); render(); }
        else if (selBeam) { snapshot(); deleteBeam(selBeam); updateBeamTable(); updateLoadTable(); render(); }
      }
    });

    // Resize
    window.addEventListener('resize', () => { drawGrid(); drawScaleBar(); });

    // ── Unit system ────────────────────────────────────────────────
    if (window.UnitSystem) {
      // Populate unit switcher in all containers (status bar + any ribbon wrap)
      ['unit-switcher-wrap','unit-switcher-wrap-titlebar','unit-switcher-wrap-status'].forEach(function(id){
        const w = document.getElementById(id);
        if (w) w.innerHTML = UnitSystem.buildSwitcherHTML();
      });
      UnitSystem.wire();    // loads saved pref, wires select, registers updateDOM
      UnitSystem.onSwitch(() => {
        // Refresh all panels that show values with units
        updateNodeTable();
        updateBeamTable();
        updateLoadTable();
        if (results) showResultsPanel(results);
        updateDesignTable();
        render();           // canvas labels re-draw
      });
      // Apply initial DOM labels
      UnitSystem.updateDOM();
    }

    // Initial state
    updateSectionTable();
    updateCasesPane();
    populateDisplaySelector();
    setTool('select');
    fitToScreen();
    render();
    snapshot();

    initDrawPane();   // wire draw pane buttons after all helpers are defined
    initResizers();   // wire panel drag-resize handles

    // ── Dropdown menus ─────────────────────────────────────────────
    (function initDropdowns() {
      const ddPairs = [
        ['dd-analysis-btn', 'dd-analysis-menu'],
        ['dd-tools-btn',    'dd-tools-menu'],
        ['dd-view-btn',     'dd-view-menu'],
      ];
      ddPairs.forEach(([btnId, menuId]) => {
        const btn  = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!btn || !menu) return;
        btn.addEventListener('click', e => {
          e.stopPropagation();
          // Close all other dropdowns
          document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
          menu.classList.toggle('open');
        });
      });
      // Close dropdowns when clicking elsewhere
      document.addEventListener('click', () => {
        document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      });

      // Wire dropdown items to the same handlers as the original buttons
      const ddMap = {
        'dd-selfwt':    'btn-selfwt',
        'dd-pdelta':    'btn-pdelta',
        'dd-modes':     'btn-modes',
        'dd-combos':    'btn-combos',
        'dd-mirror':    'btn-mirror',
        'dd-wizard':    'btn-wizard',
        'dd-foundation':'btn-foundation',
        'dd-report':    'btn-report',
        'dd-files':     'btn-files',
        'dd-settings':  'btn-settings',
        'dd-views':     'btn-views',
        'dd-3d':        'btn-3d',
        'dd-extrude':   'btn-extrude',
        'dd-darkmode':  'btn-darkmode',
      };
      Object.entries(ddMap).forEach(([ddId, origId]) => {
        const ddBtn   = document.getElementById(ddId);
        const origBtn = document.getElementById(origId);
        if (ddBtn && origBtn) {
          ddBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
            origBtn.click();
          });
        }
      });

      // ── Results Tables (dd-results-table) ───────────────────────
      document.getElementById('dd-results-table')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
        openResultsTable();
      });
    })();

    // ═══════════════════════════════════════════════════════════════
    //  RESULTS TABLES — node displacements, member forces, reactions
    // ═══════════════════════════════════════════════════════════════
    function openResultsTable() {
      const res = getActiveResults();
      if (!res || !res.success) {
        toast('Solve the structure first', 'warn'); return;
      }

      // Case label
      const caseName = (() => {
        if (activeDisplay.type === 'case') {
          const lc = loadCases.find(c => c.id === activeDisplay.id);
          return lc ? lc.name : `Case ${activeDisplay.id}`;
        }
        const co = loadCombos.find(c => c.id === activeDisplay.id);
        return co ? co.name : `Combo ${activeDisplay.id}`;
      })();
      const lbl = document.getElementById('results-case-label');
      if (lbl) lbl.textContent = `Load: ${caseName}`;

      // ── Unit conversion for this dialog ───────────────────────
      // These tables used to emit raw SI with hardcoded SI headers, so in
      // imperial mode they showed kN/m while the results pane beside them
      // showed kip/ft for the same model.
      const RU  = window.UnitSystem;
      const cv  = (v, q) => RU ? RU.toDisplay(v || 0, q) : (v || 0);
      const dec = q => RU ? (RU.current().decimals[q] ?? 3) : 3;
      const uLen = RU ? RU.current().length   : 'm';
      const uFor = RU ? RU.current().force    : 'kN';
      const uMom = RU ? RU.current().moment   : 'kNm';
      const uDsp = RU ? (RU.current().toDisp.dispUnit || 'mm') : 'mm';
      const setHdr = (paneId, labels) => {
        const th = document.querySelectorAll('#' + paneId + ' thead th');
        labels.forEach((t, i) => { if (th[i] && t !== null) th[i].textContent = t; });
      };
      setHdr('res-tab-displ', ['Node', 'X (' + uLen + ')', 'Y (' + uLen + ')',
                              'Ux (' + uDsp + ')', 'Uy (' + uDsp + ')', 'θz (mrad)']);
      setHdr('res-tab-forces', ['Beam', 'N₁ (' + uFor + ')', 'V₁ (' + uFor + ')', 'M₁ (' + uMom + ')',
                              'N₂ (' + uFor + ')', 'V₂ (' + uFor + ')', 'M₂ (' + uMom + ')']);

      // ── Displacements tab ─────────────────────────────────────
      const dispBody = document.getElementById('res-displ-body');
      if (dispBody) {
        dispBody.innerHTML = '';
        const nIdx = {}; nodes.forEach((nd, i) => { nIdx[nd.id] = i; });
        const maxUx = Math.max(...nodes.map(n => Math.abs(cv(res.disp?.[n.id]?.u, 'displacement'))));
        const maxUy = Math.max(...nodes.map(n => Math.abs(cv(res.disp?.[n.id]?.v, 'displacement'))));
        nodes.forEach(nd => {
          const d = res.disp ? res.disp[nd.id] : null;
          const ux = d ? cv(d.u, 'displacement') : 0;
          const uy = d ? cv(d.v, 'displacement') : 0;
          const rz = d ? (d.theta || 0) * 1000 : 0;   // rad → mrad (unit-agnostic)
          const tr = document.createElement('tr');
          const uxStyle = Math.abs(ux) === maxUx && maxUx > 0.001 ? 'color:#c62828;font-weight:700' : '';
          const uyStyle = Math.abs(uy) === maxUy && maxUy > 0.001 ? 'color:#c62828;font-weight:700' : '';
          tr.innerHTML = `<td>${nd.id}</td><td>${cv(nd.x,'length').toFixed(dec('length'))}</td>` +
            `<td>${cv(nd.y,'length').toFixed(dec('length'))}</td>` +
            `<td style="${uxStyle}">${ux.toFixed(4)}</td>` +
            `<td style="${uyStyle}">${uy.toFixed(4)}</td>` +
            `<td>${rz.toFixed(4)}</td>`;
          dispBody.appendChild(tr);
        });
      }

      // ── Member forces tab ─────────────────────────────────────
      const forcesBody = document.getElementById('res-forces-body');
      if (forcesBody && res.elemForces) {
        forcesBody.innerHTML = '';
        res.elemForces.forEach(ef => {
          const bm = beams.find(b => b.id === ef.id);
          const label = bm ? (bm.label || ef.id) : ef.id;
          // Find max moment for highlight
          const tr = document.createElement('tr');
          // |internal| == |end action| at a member end, so the peak highlight is
          // unaffected by the sign correction below.
          const maxM = Math.max(...res.elemForces.map(e => Math.max(Math.abs(e.M1||0), Math.abs(e.M2||0))));
          const maxV = Math.max(...res.elemForces.map(e => Math.max(Math.abs(e.V1||0), Math.abs(e.V2||0))));
          // Internal moments, as everywhere else. ef.M1/ef.M2 are END ACTIONS,
          // whose sign is the negative of the internal moment — printing them
          // raw made this dialog disagree with the results panel, the diagrams
          // and the report about the same member.
          const M1i = window.DesignChecks ? DesignChecks.internalForceAt(ef, 'BMD', 0) : -ef.M1;
          const M2i = window.DesignChecks ? DesignChecks.internalForceAt(ef, 'BMD', ef.L) : -ef.M2;
          const m1Style = Math.abs(M1i) === maxM && maxM > 0.001 ? 'color:#1565c0;font-weight:700' : '';
          const m2Style = Math.abs(M2i) === maxM && maxM > 0.001 ? 'color:#1565c0;font-weight:700' : '';
          const v1Style = Math.abs(ef.V1) === maxV && maxV > 0.001 ? 'color:#2e7d32;font-weight:700' : '';
          const v2Style = Math.abs(ef.V2) === maxV && maxV > 0.001 ? 'color:#2e7d32;font-weight:700' : '';
          const fD = dec('force'), mD = dec('moment');
          tr.innerHTML = `<td>${label}</td>` +
            `<td>${cv(ef.N1,'force').toFixed(fD)}</td>` +
            `<td style="${v1Style}">${cv(ef.V1,'force').toFixed(fD)}</td>` +
            `<td style="${m1Style}">${cv(M1i,'moment').toFixed(mD)}</td>` +
            `<td>${cv(ef.N2,'force').toFixed(fD)}</td>` +
            `<td style="${v2Style}">${cv(ef.V2,'force').toFixed(fD)}</td>` +
            `<td style="${m2Style}">${cv(M2i,'moment').toFixed(mD)}</td>`;
          forcesBody.appendChild(tr);
        });
      }

      // ── Reactions tab ─────────────────────────────────────────
      const reactBody = document.getElementById('res-react-body');
      if (reactBody && res.reactions) {
        reactBody.innerHTML = '';
        // The 3D solver reports 6 components (Rx, Ry, Rz, Mx, My, Mz) with Z as
        // the vertical axis; the 2D solver reports Rx, Ry and M. The old filter
        // only tested the 2D set, so in 3D every support — where the whole
        // reaction sits in Rz — was dismissed as "near zero" and the table came
        // out empty. Test every component, and show the right vertical one.
        const vertKey = mode3D ? 'Rz' : 'Ry';
        const hV = document.getElementById('res-react-h-vert');
        const hM = document.getElementById('res-react-h-mom');
        if (hV) hV.textContent = (mode3D ? 'Rz (' : 'Ry (') + uFor + ')';
        if (hM) hM.textContent = (mode3D ? 'My (' : 'Mz (') + uMom + ')';
        const hRx = document.querySelector('#res-tab-react thead th:nth-child(2)');
        if (hRx) hRx.textContent = 'Rx (' + uFor + ')';

        nodes.forEach(nd => {
          const r = res.reactions[nd.id]; if (!r) return;
          const comps = ['Rx','Ry','Rz','Mx','My','Mz','M'];
          if (comps.every(k => Math.abs(r[k] || 0) < 1e-8)) return;
          const mom = mode3D ? (r.My || 0)
                             : (r.M !== undefined ? r.M : (r.Mz || 0));
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${nd.id}</td>` +
            `<td>${cv(r.Rx,'force').toFixed(dec('force'))}</td>` +
            `<td>${cv(r[vertKey],'force').toFixed(dec('force'))}</td>` +
            `<td>${cv(mom,'moment').toFixed(dec('moment'))}</td>`;
          reactBody.appendChild(tr);
        });
      }

      // ── Story Forces tab ─────────────────────────────────────
      const storyBody = document.getElementById('res-story-body');
      if (storyBody) {
        storyBody.innerHTML = '';
        const stories = computeStoryForces(res);
        if (!stories || !stories.length) {
          storyBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-sec);padding:12px">No multi-story data — needs nodes at ≥2 vertical levels with connecting columns</td></tr>';
        } else {
          const maxShear = Math.max(...stories.map(s => s.storyShear));
          stories.slice().reverse().forEach((s, idx) => {
            const tr = document.createElement('tr');
            const ratioStr = s.driftRatio < 0.0001 ? '—'
              : s.driftRatio > 0.01 ? s.driftRatio.toFixed(5)
              : `1/${Math.round(1 / s.driftRatio)}`;
            const driftCol = s.driftRatio >= 1/200  ? '#c62828'
                           : s.driftRatio >= 1/500  ? '#e65100'
                           : '#2e7d32';
            const shearW = maxShear > 0 ? Math.round((s.storyShear / maxShear) * 60) : 0;
            tr.innerHTML =
              `<td>${s.yBot.toFixed(2)}–${s.yTop.toFixed(2)}</td>` +
              `<td>${s.h.toFixed(2)}</td>` +
              `<td>${s.driftMM.toFixed(3)}</td>` +
              `<td style="color:${driftCol};font-weight:${s.driftRatio >= 1/500 ? 700 : 400}">${ratioStr}</td>` +
              `<td><div style="display:flex;align-items:center;gap:4px">` +
              `<div style="width:${shearW}px;height:6px;background:#1565c0;border-radius:2px;opacity:0.7"></div>` +
              `<span>${s.storyShear.toFixed(2)}</span></div></td>`;
            storyBody.appendChild(tr);
          });
        }
      }

      openModal('modal-results-table');
    }

    // ── Tab switching ───────────────────────────────────────────
    document.querySelectorAll('.res-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.res-tab').forEach(b => {
          b.classList.remove('active');
          b.style.borderBottomColor = 'transparent';
          b.style.color = '';
        });
        btn.classList.add('active');
        btn.style.borderBottomColor = '#1565c0';
        btn.style.color = '#1565c0';
        document.querySelectorAll('.res-tab-pane').forEach(p => p.style.display = 'none');
        const pane = document.getElementById(`res-tab-${tab}`);
        if (pane) pane.style.display = '';
      });
    });
    // Highlight first tab on open
    (() => {
      const firstTab = document.querySelector('.res-tab[data-tab="displ"]');
      if (firstTab) { firstTab.style.borderBottomColor = '#1565c0'; firstTab.style.color = '#1565c0'; }
    })();

    // ── CSV export ──────────────────────────────────────────────
    document.getElementById('res-export-csv')?.addEventListener('click', () => {
      const activeTab = document.querySelector('.res-tab.active')?.dataset.tab || 'displ';
      // Header units must track the table, which now renders in the active
      // unit system rather than always SI.
      const CU = window.UnitSystem;
      const cLen = CU ? CU.current().length : 'm';
      const cFor = CU ? CU.current().force  : 'kN';
      const cMom = CU ? CU.current().moment : 'kNm';
      const cDsp = CU ? (CU.current().toDisp.dispUnit || 'mm') : 'mm';
      let csv = '', filename = 'results.csv';
      if (activeTab === 'displ') {
        csv = `Node,X(${cLen}),Y(${cLen}),Ux(${cDsp}),Uy(${cDsp}),Rz(mrad)\n`;
        document.querySelectorAll('#res-displ-body tr').forEach(tr => {
          csv += [...tr.cells].map(td => td.textContent).join(',') + '\n';
        });
        filename = 'displacements.csv';
      } else if (activeTab === 'forces') {
        csv = `Beam,N1(${cFor}),V1(${cFor}),M1(${cMom}),N2(${cFor}),V2(${cFor}),M2(${cMom})\n`;
        document.querySelectorAll('#res-forces-body tr').forEach(tr => {
          csv += [...tr.cells].map(td => td.textContent).join(',') + '\n';
        });
        filename = 'member_forces.csv';
      } else {
        csv = `Node,Rx(${cFor}),Ry(${cFor}),Mz(${cMom})\n`;
        document.querySelectorAll('#res-react-body tr').forEach(tr => {
          csv += [...tr.cells].map(td => td.textContent).join(',') + '\n';
        });
        filename = 'reactions.csv';
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = filename; a.click();
      toast('CSV exported', 'success');
    });

    document.getElementById('res-close')?.addEventListener('click', () => closeModal('modal-results-table'));

    // ═══════════════════════════════════════════════════════════════
    //  MODAL PARTICIPATION TABLE
    // ═══════════════════════════════════════════════════════════════
    document.getElementById('mode-participation')?.addEventListener('click', () => {
      if (!_modeData || !_modeData.modes) { toast('Run mode analysis first', 'warn'); return; }
      const tbody = document.getElementById('participation-body');
      if (!tbody) return;
      tbody.innerHTML = '';
      // A space frame participates in three directions, not two. Z is the
      // vertical in 3D; in 2D the app calls that Y and there is no third.
      const is3 = !!_modeData.is3D;
      const zHead = document.getElementById('participation-z-head');
      if (zHead) zHead.style.display = is3 ? '' : 'none';
      let cumX = 0, cumY = 0, cumZ = 0;
      _modeData.modes.forEach((m, i) => {
        const ux  = m.uxPct || 0;
        const uy  = m.uyPct || 0;
        const uz  = m.uzPct || 0;
        cumX += ux; cumY += uy; cumZ += uz;
        const color = MODE_COLORS[i] || '#9c27b0';
        const tr = document.createElement('tr');
        const pctBar = (v) => {
          const w = Math.min(v, 100).toFixed(1);
          return `<div style="display:flex;align-items:center;gap:4px">
            <div style="width:${w}px;max-width:60px;height:6px;background:${color};border-radius:2px;opacity:0.8"></div>
            <span>${v.toFixed(1)}%</span></div>`;
        };
        const cumStyle = (v) => v >= 90 ? 'color:#2e7d32;font-weight:700' : v >= 70 ? 'color:#e65100;font-weight:600' : '';
        tr.innerHTML =
          `<td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle"></span>M${m.modeNum}</td>` +
          `<td>${m.period < 1000 ? m.period.toFixed(4) : '∞'}</td>` +
          `<td>${m.freq.toFixed(4)}</td>` +
          `<td>${pctBar(ux)}</td>` +
          `<td style="${cumStyle(cumX)}">${cumX.toFixed(1)}%</td>` +
          `<td>${pctBar(uy)}</td>` +
          `<td style="${cumStyle(cumY)}">${cumY.toFixed(1)}%</td>` +
          (is3 ? `<td>${pctBar(uz)}</td>` +
                 `<td style="${cumStyle(cumZ)}">${cumZ.toFixed(1)}%</td>` : '');
        tbody.appendChild(tr);
      });
      // Summary row: highlight if < 90%
      const sumTr = document.createElement('tr');
      sumTr.style.fontWeight = '700';
      sumTr.style.borderTop = '2px solid var(--border-tbl)';
      const warnX = cumX < 90 ? '⚠' : '✓';
      const warnY = cumY < 90 ? '⚠' : '✓';
      const warnZ = cumZ < 90 ? '⚠' : '✓';
      sumTr.innerHTML =
        `<td colspan="3" style="text-align:right">Total:</td>` +
        `<td></td><td>${warnX} ${cumX.toFixed(1)}%</td>` +
        `<td></td><td>${warnY} ${cumY.toFixed(1)}%</td>` +
        (is3 ? `<td></td><td>${warnZ} ${cumZ.toFixed(1)}%</td>` : '');
      tbody.appendChild(sumTr);
      openModal('modal-participation');
    });
    document.getElementById('participation-close')?.addEventListener('click', () => closeModal('modal-participation'));

    // ── Issues dialog ─────────────────────────────────────────────
    document.getElementById('issues-close')?.addEventListener('click',
      () => closeModal('modal-issues'));
    document.getElementById('issues-clear')?.addEventListener('click', () => {
      const l = document.getElementById('issues-list');
      if (l) l.innerHTML = '';
      _issuesSeen.clear();
      closeModal('modal-issues');
    });
    // Some people would rather have the old fleeting toast than a dialog that
    // interrupts. Their call — but the setting says plainly what it costs.
    document.getElementById('issues-mute')?.addEventListener('change', (e) => {
      _issuesMuted = !!e.target.checked;
      if (_issuesMuted) {
        closeModal('modal-issues');
        toast('Errors will now flash briefly instead of waiting for you.', 'info');
      }
    });

    // ═══════════════════════════════════════════════════════════════
    //  RESPONSE SPECTRUM ANALYSIS
    // ═══════════════════════════════════════════════════════════════
    // No HTML escaper exists anywhere in the app yet. Everything interpolated
    // below is a number or a string this module wrote itself, so nothing here
    // is attacker-controlled — but a helper costs three lines and means the
    // next person to add a field does not have to work that out again.
    const esc = v => String(v).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const rsNum = (id, dflt) => {
      const v = parseFloat(document.getElementById(id)?.value);
      return isFinite(v) ? v : dflt;
    };
    // Both the mode bar and the response spectrum read their mass from here.
    // If they disagreed, the periods on the chips would not match the periods
    // in the spectrum table, for no reason the user could see.
    function massOptions() {
      if (!document.getElementById('rs-mass')?.checked) return {};
      return {
        loads, loadCases,
        massFactors: {
          DL: rsNum('rs-mDL', 1.0),
          LL: rsNum('rs-mLL', 0.25),
          SL: rsNum('rs-mSL', 0.2)
        }
      };
    }


    // Only one parameter block is relevant at a time — showing the EC8 soil
    // factor next to R and Ie invites someone to fill in both and wonder which
    // one the run used.
    function rsSyncCode() {
      const code = document.getElementById('rs-code')?.value || 'ASCE7';
      const a = document.getElementById('rs-asce'), e = document.getElementById('rs-ec8');
      if (a) a.style.display = code === 'ASCE7' ? '' : 'none';
      if (e) e.style.display = code === 'EC8'   ? '' : 'none';
    }
    document.getElementById('rs-code')?.addEventListener('change', rsSyncCode);

    document.getElementById('mode-spectrum')?.addEventListener('click', () => {
      if (!window.ResponseSpectrum) { toast('ResponseSpectrum not loaded', 'error'); return; }
      const out = document.getElementById('rs-out');
      if (out) { out.style.display = 'none'; out.innerHTML = ''; }
      openModal('modal-spectrum');
    });

    // The mode bar only opens in 2D, because the shape animation is 2D. The
    // spectrum itself works in both, so it gets its own way in from the
    // Analysis menu — otherwise a 3D model could never reach it.
    document.getElementById('dd-spectrum')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      document.getElementById('mode-spectrum')?.click();
    });
    document.getElementById('rs-close')?.addEventListener('click', () => closeModal('modal-spectrum'));

    document.getElementById('rs-run')?.addEventListener('click', () => {
      const out = document.getElementById('rs-out');
      if (!out) return;
      if (!beams.length) { toast('Model something first', 'warn'); return; }

      const code = document.getElementById('rs-code')?.value || 'ASCE7';
      const spectrum = code === 'EC8'
        ? { code: 'EC8', ag: rsNum('rs-ag', 0.25), S: rsNum('rs-s', 1.2),
            TB: rsNum('rs-tb', 0.15), TC: rsNum('rs-tc', 0.5),
            TD: rsNum('rs-td', 2.0), q: rsNum('rs-q', 4) }
        : { code: 'ASCE7', Sds: rsNum('rs-sds', 1.0), Sd1: rsNum('rs-sd1', 0.6),
            TL: rsNum('rs-tl', 8) };

      // EC8's design spectrum already carries q, so R and Ie stay at 1 there —
      // applying them as well would reduce the forces twice over.
      const opts = {
        spectrum,
        direction: document.getElementById('rs-dir')?.value || 'X',
        rule:      document.getElementById('rs-rule')?.value || 'CQC',
        damping:   rsNum('rs-zeta', 0.05),
        numModes:  parseInt(document.getElementById('rs-modes')?.value || '10', 10),
        R:  code === 'ASCE7' ? rsNum('rs-r', 3)  : 1,
        Ie: code === 'ASCE7' ? rsNum('rs-ie', 1) : 1,
        // §12.9.1.4 is an ASCE rule; EC8 has no counterpart, so the option is
        // simply not passed on a Eurocode run rather than passed and ignored.
        scaleToELF: code === 'ASCE7' && !!document.getElementById('rs-scale')?.checked,
        system:     document.getElementById('rs-system')?.value || 'other',
        S1:         rsNum('rs-s1', 0),
        // Same source as the mode bar, so the periods on the chips and the
        // periods in the spectrum table always describe one structure.
        ...massOptions()
      };

      // The 3D path runs on solver3d and the 6-DOF modal solver; the 2D path
      // on the originals. Both are exercised by the regression suite.
      opts.is3D = mode3D;
      const res = ResponseSpectrum.run(nodes, beams, sections, opts);
      out.style.display = '';
      if (res.error) {
        out.innerHTML = `<div style="color:#c62828;font-weight:600">${esc(res.error)}</div>`;
        toast('Response spectrum: ' + res.error, 'error');
        // Drop the previous run with it. Leaving it in place would let the
        // button build an E case out of the last result that happened to work,
        // under whatever parameters are now on screen.
        _spectrumData = null;
        const mk = document.getElementById('rs-make-case');
        if (mk) mk.disabled = true;
        return;
      }
      _spectrumData = res;
      const mkBtn = document.getElementById('rs-make-case');
      if (mkBtn) mkBtn.disabled = false;

      const f = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : '—');
      const modeRows = res.modes.map(m => {
        const cum = m.cumMassPct >= 90 ? 'color:#2e7d32;font-weight:700' : '';
        return `<tr><td>M${m.modeNum}</td><td>${f(m.period, 4)}</td><td>${f(m.SaG, 4)}</td>` +
               `<td>${f(m.massPct, 1)}%</td><td style="${cum}">${f(m.cumMassPct, 1)}%</td>` +
               `<td>${f(m.baseShear)}</td></tr>`;
      }).join('');

      // Rank members by combined moment — with the sign gone, the magnitude is
      // the whole story, so the largest few are what the engineer needs first.
      const worst = res.elemForces.slice()
        .sort((a, b) => Math.max(b.M1, b.M2) - Math.max(a.M1, a.M2))
        .slice(0, 8)
        .map(e => `<tr><td>${e.id}</td><td>${f(Math.max(e.N1, e.N2))}</td>` +
                  `<td>${f(Math.max(e.V1, e.V2))}</td><td>${f(Math.max(e.M1, e.M2))}</td></tr>`)
        .join('');

      out.innerHTML =
        `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:8px;font-size:12px">` +
          `<div><b>Base shear</b><br>${f(res.baseShear)} kN</div>` +
          `<div><b>Mass captured</b><br>${f(res.massCaptured, 1)}% ` +
            `<span style="font-size:10px;color:var(--text-sec)">of ${f(res.totalMass)} kN&middot;s&sup2;/m free</span></div>` +
          (res.appliedMass && res.appliedMass.total > 0
            ? `<div><b>Mass from loads</b><br>${f(res.appliedMass.total)} kN&middot;s&sup2;/m` +
              `<span style="font-size:10px;color:var(--text-sec)"> ` +
              `${Object.keys(res.appliedMass.breakdown).map(k =>
                `${esc(k)} ${f(res.appliedMass.breakdown[k], 0)}kN`).join(', ')}</span></div>`
            : '') +
          `<div><b>Rule</b><br>${esc(res.rule)} @ &zeta;=${f(res.damping * 100, 1)}%</div>` +
          `<div><b>Direction</b><br>${esc(res.direction)}</div>` +
          `<div><b>Spectrum</b><br>${esc(res.spectrum.code || '')}</div>` +
          (res.elf
            ? `<div><b>ELF (&sect;12.8)</b><br>${f(res.elf.V)} kN` +
              `<span style="font-size:10px;color:var(--text-sec)"> C<sub>s</sub>=${f(res.elf.Cs, 4)}, ` +
              `T=${f(res.elf.T, 3)} s</span></div>` +
              `<div><b>&sect;12.9.1.4 factor</b><br>${f(res.scaleFactor, 3)}</div>`
            : '') +
        `</div>` +
        `<table class="dtbl" style="width:100%;margin-bottom:8px"><thead><tr>` +
          `<th>Mode</th><th>T (s)</th><th>Sa (g)</th><th>Mass</th><th>&Sigma;Mass</th><th>V (kN)</th>` +
        `</tr></thead><tbody>${modeRows}</tbody></table>` +
        `<div style="font-weight:600;font-size:11px;margin:6px 0 3px">Largest combined member forces</div>` +
        `<table class="dtbl" style="width:100%"><thead><tr>` +
          `<th>Member</th><th>|N| kN</th><th>|V| kN</th><th>|M| kNm</th>` +
        `</tr></thead><tbody>${worst}</tbody></table>` +
        res.notes.map(n =>
          `<div style="margin-top:6px;font-size:11px;color:var(--text-sec);` +
          `border-left:3px solid #ff9800;padding-left:7px">${esc(n)}</div>`).join('');

      toast(`Spectrum: V = ${f(res.baseShear)} kN from ${res.modeCount} modes`, 'info');
    });

    // ── Turn the spectrum into an EQ load case ─────────────────────
    //
    // The combined member forces cannot be superposed — they are magnitudes
    // from a quadratic combination — so a load combination cannot factor them
    // directly. What it can factor is the equivalent static force set the
    // spectrum derives, applied as an ordinary EQ case. Its resultant is the
    // design base shear, so the combination sees the right total.
    //
    // Sign is gone, so the set is one sense of E. The generated seismic
    // combinations already carry both — ASCE 7 emits each of them twice, once
    // at +1.0E and once at −1.0E — so nothing further is needed as long as the
    // combinations come from the generator. Hand-built ones have to include
    // the reversal themselves, which is what the toast points at.
    document.getElementById('rs-make-case')?.addEventListener('click', () => {
      const res = _spectrumData;
      if (!res || !res.success || !Array.isArray(res.staticForces)) {
        toast('Run the spectrum first', 'warn'); return;
      }
      snapshot();
      const dirName = res.direction;
      const name = `E ${dirName} (spectrum)`;
      let lc = loadCases.find(c => c.name === name);
      if (lc) {
        // Replace the previous set rather than doubling it up: re-running the
        // spectrum with different parameters should update the case, not add
        // a second one that silently sums with the first.
        for (let i = loads.length - 1; i >= 0; i--)
          if (loads[i].caseId === lc.id) loads.splice(i, 1);
        lc.type = 'EQ';
      } else {
        lc = { id: nextId.lcase++, name, type: 'EQ', color: '#6a1b9a' };
        loadCases.push(lc);
      }

      let added = 0;
      for (const f of res.staticForces) {
        const has = ['fx', 'fy', 'fz', 'm', 'mx', 'my', 'mz']
          .some(k => Math.abs(f[k] || 0) > 1e-9);
        if (!has) continue;
        loads.push(Object.assign(
          { id: nextId.load++, type: 'nodal', caseId: lc.id, fx: 0, fy: 0, m: 0 },
          f
        ));
        added++;
      }

      updateCasesPane(); updateLoadTable(); updateNodeTable(); render();
      toast(`${name}: ${added} nodal forces, ${res.baseShear.toFixed(1)} kN total. ` +
            'Generated seismic combinations apply it at ±1.0; a hand-built ' +
            'combination must include both senses.', 'info');
    });

    // ── Story Forces (Analysis > Story Forces button) ─────────────────
    document.getElementById('dd-story-forces')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      openResultsTable();
      // Switch to story tab after modal opens
      setTimeout(() => {
        const storyTab = document.querySelector('.res-tab[data-tab="story"]');
        if (storyTab) storyTab.click();
      }, 50);
    });

    // ── Quick Summary (Analysis > Quick Summary button) ───────────────
    document.getElementById('dd-quick-summary')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tb-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      const res = getActiveResults();
      if (!res || !res.success) { toast('Solve the structure first', 'warn'); return; }
      // Remove existing then re-create (toggle)
      const existing = document.getElementById('quick-summary');
      if (existing) { existing.remove(); return; }
      updateQuickSummary(res);
    });

    // ── Section import / export buttons ─────────────────────────────
    const btnImportSec = document.getElementById('btn-import-sections');
    const secFileInput = document.getElementById('sections-file-input');
    if (btnImportSec && secFileInput) {
      btnImportSec.addEventListener('click', () => secFileInput.click());
      secFileInput.addEventListener('change', e => {
        if (e.target.files[0]) importSectionsFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
    const btnExportSecCsv = document.getElementById('btn-export-sections-csv');
    if (btnExportSecCsv) {
      btnExportSecCsv.addEventListener('click', () => {
        const header = 'Name,E_GPa,A_cm2,I_cm4,fy_MPa,rho_kNm3';
        const rows = sections.map(s =>
          `${s.name},${s.E},${s.A},${s.I},${s.fy||''},${s.rho||''}`
        );
        const csv = [header, ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'sections_db.csv';
        a.click();
        toast('Sections exported as CSV', 'success');
      });
    }

    // A shared link wins over the last session — the user followed it to see
    // that model. "Share URL" has always built a ?data= link, but nothing ever
    // read one back, so every link it produced opened on the recipient's own
    // model instead and the button may as well not have existed.
    //
    // The session it replaces is kept under a second key rather than dropped,
    // because following a link should not cost somebody their unsaved work.
    if (!loadSharedURLModel() && !restoreSession()) {
      if (window.AppGenerators && AppGenerators.generateDefaultStructure) {
        AppGenerators.generateDefaultStructure();
      } else {
        loadDemo();
      }
    }

    // Both paths rebuild loadCases, but neither refreshes the panes that list
    // them. The Loads-pane case filter kept the startup default ("Dead", id 1)
    // and so offered a case that no longer existed while omitting all the real
    // ones, making it impossible to filter loads by case.
    updateCasesPane(); populateDisplaySelector();

    // Runs after the session is loaded, since restoreSession() replaces the
    // sections array wholesale: repairs duplicate ids (which make a member
    // resolve to the wrong section) and the legacy 10×-low second moment.
    sanitizeLoadedSections();

    // The two Define dialogs read and write `sections` and `materials`
    // directly, so they are brought up to date here — explicitly, in this
    // order, and only now.
    //
    // Both used to do this off their own window 'load' listener. frame_sections.js
    // is loaded at the top of index.html and MAT_UI is an inline script near the
    // bottom, so the listeners fired in the order the file happens to be laid
    // out: sections were migrated before materials existed to link them to, and
    // both ran before restoreSession() had replaced the arrays they were
    // writing into. Materials first — sections resolve their material by id.
    window.MAT_UI?.migrate?.();
    window.FRAME_SEC?.init?.();

    updateSectionTable();

    // Several panels above are written into the page during init, after
    // a11y-labels.js has already made its pass. Their labels would stay
    // unattached — including the unit switcher, which is built into three
    // separate containers from here. Run it once more now everything exists.
    window.A11yLabels?.refresh?.();
  }

  // ── computeStoryForces — ETABS-style story shear / drift table ──────
  function computeStoryForces(res) {
    if (!res || !res.success || nodes.length < 2) return null;

    // Collect unique levels (tolerance = 0.1 m) along whichever axis is
    // vertical. This read nd.y unconditionally, so in a 3D or Z-lifted model —
    // where every nd.y is 0 — it found a single level, bailed out, and left both
    // the Story Forces table and the drift annotations permanently empty.
    const useZ = verticalIsZ();
    const ev = nd => useZ ? (nd.z || 0) : nd.y;

    const levels = [];
    for (const nd of nodes) {
      if (!levels.some(l => Math.abs(l - ev(nd)) < 0.1)) levels.push(ev(nd));
    }
    levels.sort((a, b) => a - b);
    if (levels.length < 2) return null;

    const stories = [];
    for (let i = 1; i < levels.length; i++) {
      const yBot = levels[i - 1];
      const yTop = levels[i];
      const h    = yTop - yBot;

      // Nodes at each level
      const topNodes = nodes.filter(nd => Math.abs(ev(nd) - yTop) < 0.1);
      const botNodes = nodes.filter(nd => Math.abs(ev(nd) - yBot) < 0.1);

      const avgUx = (nds) => !nds.length ? 0 :
        nds.reduce((s, nd) => s + (res.disp?.[nd.id]?.u || 0), 0) / nds.length;

      const driftM    = avgUx(topNodes) - avgUx(botNodes);  // m
      const driftRatio = h > 0.001 ? Math.abs(driftM) / h : 0;

      // Story shear = the ALGEBRAIC sum of the column shears spanning this
      // story, which by horizontal equilibrium equals the lateral load applied
      // above it.
      //
      // This summed magnitudes. Columns in a laterally loaded frame routinely
      // shear in opposite directions — the windward one can reverse while the
      // rest carry the load — and every reversal was then added instead of
      // subtracted. On this frame's top story the three columns carry
      // -11.835, +30.670 and +16.165 kN: the true shear is 35.0 kN, the
      // applied load above, and Sum|V| reported 58.67, over by 68%. The lower
      // story read correctly only because its columns happened to agree in
      // sign, which is what kept the error out of sight.
      let storyShear = 0;
      for (const bm of beams) {
        const ni = findNode(bm.node1), nj = findNode(bm.node2);
        if (!ni || !nj) continue;
        const yMin = Math.min(ni.y, nj.y), yMax = Math.max(ni.y, nj.y);
        if (Math.abs(yMin - yBot) < 0.1 && Math.abs(yMax - yTop) < 0.1) {
          const ef = (res.elemForces || []).find(f => f.id === bm.id);
          if (ef) storyShear += (ef.V1 || 0);
        }
      }
      // Direction follows the load; the magnitude is what gets reported.
      storyShear = Math.abs(storyShear);

      stories.push({ yBot, yTop, h, driftMM: driftM * 1000, driftRatio, storyShear });
    }
    return stories.length ? stories : null;
  }

  /**
   * Total applied force for whichever case or combination is on display,
   * in the same global axes as the reactions.
   *
   * Equilibrium is ΣR = −ΣF, so the residual is (ΣR + ΣF). The Quick Summary
   * used to test ΣR against zero instead, which is only true for an unloaded
   * model — so a correctly solved 6 m beam under 10 kN/m, with ΣRy = 60 kN
   * exactly as the solver regression suite asserts, was still reported as
   * "⚠ Check equilibrium".
   *
   * Member lengths come from the solved element forces, so a load on a member
   * that was not part of this solve contributes nothing.
   */
  function appliedTotals(res) {
    const lenOf = {};
    for (const ef of (res.elemForces || [])) lenOf[ef.id] = ef.L;

    const factorFor = l => {
      if (activeDisplay.type === 'case') return caseIdOf(l) === activeDisplay.id ? 1 : 0;
      const combo = loadCombos.find(c => c.id === activeDisplay.id);
      if (!combo) return 0;
      const f = (combo.factors || []).find(ff => ff.caseId === caseIdOf(l));
      return f ? f.factor : 0;
    };

    let x = 0, y = 0;
    for (const ld of loads) {
      const k = factorFor(ld);
      if (!k) continue;
      const L = lenOf[ld.elementId];
      if (ld.type === 'beam_dist') {
        if (L == null) continue;
        x += (ld.fx || 0) * L * k; y += (ld.fy || 0) * L * k;
      } else if (ld.type === 'beam_trap') {
        if (L == null) continue;
        const fx2 = ld.fx2 != null ? ld.fx2 : (ld.fx || 0);
        const fy2 = ld.fy2 != null ? ld.fy2 : (ld.fy || 0);
        x += ((ld.fx || 0) + fx2) / 2 * L * k;
        y += ((ld.fy || 0) + fy2) / 2 * L * k;
      } else if (ld.type === 'beam_point' || ld.type === 'nodal') {
        x += (ld.fx || 0) * k; y += (ld.fy || 0) * k;
      }
      // 'moment' applies no resultant force.
    }
    return { x, y };
  }

  // ── updateQuickSummary — floating results card (ETABS status area) ──
  function updateQuickSummary(res) {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;

    let box = document.getElementById('quick-summary');
    if (!res || !res.success) { if (box) box.remove(); return; }

    if (!box) {
      box = document.createElement('div');
      box.id = 'quick-summary';
      wrap.appendChild(box);
    }

    const disp  = res.disp        || {};
    const ef    = res.elemForces  || [];
    // reactions is an object keyed by node id; convert to array
    const reactArr = Object.values(res.reactions || {});

    // Node and end values only told half the story: on a simply supported span
    // every one of these is zero except the shear, so the card read "Max M 0.00"
    // under a beam carrying wL²/8. Take the span maxima, which include the ends.
    const sm = spanMaxima(res);
    const maxUx = Math.max(0, ...nodes.map(n => Math.abs(disp[n.id]?.u || 0))) * 1000;
    const maxUy = Math.max(
      Math.max(0, ...nodes.map(n => Math.abs(disp[n.id]?.v || 0))),
      Math.max(0, ...sm.map(x => x.dMax || 0))
    ) * 1000;
    const maxM  = Math.max(0, ...sm.map(x => x.Mmax));
    const maxV  = Math.max(0, ...sm.map(x => x.Vmax));
    const maxN  = Math.max(0, ...ef.map(e => Math.max(Math.abs(e.N1||0), Math.abs(e.N2||0))));
    const sumRx = reactArr.reduce((s, r) => s + (r.Rx || 0), 0);
    const sumRy = reactArr.reduce((s, r) => s + (r.Ry || 0), 0);

    const f2 = v => isFinite(v) ? v.toFixed(2) : '—';

    // Equilibrium is ΣR = ΣF_applied, not ΣR = 0. Testing the reactions against
    // zero meant every loaded model failed: this 6 m beam under 10 kN/m has
    // ΣRy = 60 kN — exactly right, and exactly what the solver regression suite
    // asserts — and the card still said "⚠ Check equilibrium".
    const applied = appliedTotals(res);
    const resid = { x: sumRx + applied.x, y: sumRy + applied.y };
    const scale = Math.max(0.01, Math.abs(applied.x), Math.abs(applied.y),
                           ...reactArr.map(r => Math.max(Math.abs(r.Rx||0), Math.abs(r.Ry||0))));
    const eqTol = Math.max(0.5, scale * 0.001);
    const eqOk = Math.abs(resid.x) < eqTol && Math.abs(resid.y) < eqTol;

    box.innerHTML =
      `<div class="qs-hdr"><span>&#128202; Quick Summary</span>` +
      `<button class="qs-close" title="Dismiss" onclick="document.getElementById('quick-summary').remove()">&#215;</button></div>` +
      `<table class="qs-tbl">` +
      `<tr><td>Max Ux</td><td>${f2(maxUx)} mm</td></tr>` +
      `<tr><td>Max Uy</td><td>${f2(maxUy)} mm</td></tr>` +
      `<tr class="qs-sep"><td>Max M</td><td>${f2(maxM)} kNm</td></tr>` +
      `<tr><td>Max V</td><td>${f2(maxV)} kN</td></tr>` +
      `<tr><td>Max N</td><td>${f2(maxN)} kN</td></tr>` +
      `<tr class="qs-sep"><td>&#931;Rx</td><td>${f2(sumRx)} kN</td></tr>` +
      `<tr><td>&#931;Ry</td><td>${f2(sumRy)} kN</td></tr>` +
      `<tr><td colspan="2" class="${eqOk ? 'qs-ok' : 'qs-warn'}">${eqOk ? '&#10003; Equilibrium OK' : '&#9888; Check equilibrium'}</td></tr>` +
      `</table>`;
  }

  function svgCenter() {
    const W = svg().clientWidth || 800, H = svg().clientHeight || 600;
    return { x: W/2, y: H/2 };
  }

  function zoomAt(sx, sy, factor) {
    pan.x = sx + (pan.x - sx) * factor;
    pan.y = sy + (pan.y - sy) * factor;
    scale = Math.max(5, Math.min(scale * factor, 2000));
    render();
  }

  // ── Demo structure ────────────────────────────────────────────────
  function loadDemo() {
    nodes = [
      { id:1, x:0,   y:0, support:'pin'    },
      { id:2, x:5,   y:0, support:'roller' },
      { id:3, x:2.5, y:3, support:'none'   }
    ];
    beams = [
      { id:1, node1:1, node2:2, sectionId:1, hingeStart:false, hingeEnd:false },
      { id:2, node1:1, node2:3, sectionId:1, hingeStart:false, hingeEnd:false },
      { id:3, node1:3, node2:2, sectionId:1, hingeStart:false, hingeEnd:false }
    ];
    loads = [
      { id:1, type:'beam_dist', elementId:1, fx:0, fy:-10, m:0, caseId:1 },
      { id:2, type:'nodal',     nodeId:3,    fx:0, fy:-20, m:0, caseId:1 }
    ];
    nextId = { node:4, beam:4, load:3, section:5, settlement:1, lcase:3, combo:1 };

    updateNodeTable(); updateBeamTable(); updateLoadTable();
    updateCasesPane(); populateDisplaySelector();
    fitToScreen(); render();
    snapshot();
  }

  // ── Push compound section into section library ────────────────────
  function _pushCompoundSection(r) {
    if (!r || !r.A) { toast('No section data', 'error'); return; }
    const name = `Compound §${sections.length + 1}`;
    // Use existing fy from first section if available, else 355 MPa default
    const fy  = sections.length > 0 ? (sections[0].fy  || 355)  : 355;
    const E   = sections.length > 0 ? (sections[0].E   || 210)  : 210;
    // rho used to be hardcoded to 1.0 — since self-weight is generated as
    // -rho*A, every beam using a section built here had its self-weight
    // silently understated by ~78x against the app's own steel default
    // (78.5 kN/m³, used everywhere else a section is missing one — see
    // cs-rho's own fallback a few hundred lines up). Same inherit-or-default
    // pattern as fy/E just above.
    const rho = sections.length > 0 ? (sections[0].rho || 78.5) : 78.5;
    const newSec = {
      id:   Date.now(),
      name,
      E,
      A:    +r.A.toFixed(4),
      Ix:   +r.Ix.toFixed(4),
      Iy:   +r.Iy && +r.Iy.toFixed(4),
      I:    +r.Ix.toFixed(4),   // alias
      fy,
      rho
    };
    sections.push(newSec);
    toast(`Section "${name}" added — A=${r.A.toFixed(1)} cm² Ix=${r.Ix.toFixed(0)} cm⁴`, 'success');
    snapshot();
    // Open change-section dialog for first beam if one is selected, so user can apply
    if (selBeam) _openChangeSection(selBeam);
  }

  // ── Part 3: ACI 318-19 Material Properties Calculator ───────────────
  function _buildAciMaterialsDialog() {
    const body = document.getElementById('aci-mat-body');
    if (!body) return;

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px;">

        <!-- Left: Input controls -->
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:8px;color:var(--accent)">
            Input Parameters
          </div>

          <!-- f'c slider -->
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;">
              f'c — Concrete Compressive Strength (MPa)
            </label>
            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
              <input type="range" id="aci-fc-slider" min="17" max="100" step="1" value="28"
                style="flex:1;" oninput="document.getElementById('aci-fc-num').value=this.value;App._refreshAciMat()">
              <input type="number" id="aci-fc-num" min="17" max="100" step="1" value="28"
                style="width:60px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);"
                oninput="document.getElementById('aci-fc-slider').value=this.value;App._refreshAciMat()">
              <span style="font-size:11px;color:var(--text-muted)">MPa</span>
            </div>
          </div>

          <!-- λ (lightweight factor) -->
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;">
              λ — Lightweight Concrete Factor
            </label>
            <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">
              <label style="font-size:12px;cursor:pointer;">
                <input type="radio" name="aci-lambda" value="1.0" checked
                  onchange="App._refreshAciMat()"> Normal-weight (λ=1.0)
              </label>
              <label style="font-size:12px;cursor:pointer;">
                <input type="radio" name="aci-lambda" value="0.85"
                  onchange="App._refreshAciMat()"> Sand-LW (λ=0.85)
              </label>
              <label style="font-size:12px;cursor:pointer;">
                <input type="radio" name="aci-lambda" value="0.75"
                  onchange="App._refreshAciMat()"> All-LW (λ=0.75)
              </label>
            </div>
          </div>

          <!-- fy (rebar) -->
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:600;">
              fy — Rebar Yield Strength (MPa)
            </label>
            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
              <select id="aci-fy-sel"
                style="flex:1;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);font-size:12px;"
                onchange="document.getElementById('aci-fy-num').value=this.value;App._refreshAciMat()">
                <option value="280">Grade 40 (280 MPa)</option>
                <option value="350">Grade 50 (350 MPa)</option>
                <option value="420" selected>Grade 60 (420 MPa)</option>
                <option value="520">Grade 75 (520 MPa)</option>
                <option value="690">Grade 100 (690 MPa)</option>
                <option value="">Custom →</option>
              </select>
              <input type="number" id="aci-fy-num" min="200" max="1000" step="10" value="420"
                style="width:70px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);"
                oninput="App._refreshAciMat()">
              <span style="font-size:11px;color:var(--text-muted)">MPa</span>
            </div>
          </div>

          <!-- Standard f'c grades quick-pick -->
          <div style="margin-bottom:8px;">
            <label style="font-size:12px;font-weight:600;">Quick f'c Grades (MPa):</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
              ${[17,21,24,28,35,42,48,56,70].map(v =>
                `<button class="btn-xs" onclick="document.getElementById('aci-fc-num').value=${v};document.getElementById('aci-fc-slider').value=${v};App._refreshAciMat()" style="font-size:11px;padding:2px 7px;">${v}</button>`
              ).join('')}
            </div>
          </div>
        </div>

        <!-- Right: Computed results -->
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:8px;color:var(--accent)">
            Computed Properties
          </div>
          <div id="aci-mat-results" style="font-size:12px;"></div>
        </div>
      </div>

      <!-- Bottom: Reference table -->
      <details style="margin-top:6px;">
        <summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--accent);padding:4px 0;">
          ▸ ACI 318-19 Standard Concrete Grades Reference Table
        </summary>
        <div style="overflow-x:auto;margin-top:6px;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="background:var(--panel-alt,#f0f4ff);font-weight:600;">
                <th style="padding:4px 8px;text-align:left;border:1px solid var(--border)">f'c (MPa)</th>
                <th style="padding:4px 8px;text-align:right;border:1px solid var(--border)">Ec (GPa)</th>
                <th style="padding:4px 8px;text-align:right;border:1px solid var(--border)">fr (MPa)</th>
                <th style="padding:4px 8px;text-align:right;border:1px solid var(--border)">β₁</th>
                <th style="padding:4px 8px;text-align:right;border:1px solid var(--border)">ρ_bal (Gr60, %)</th>
                <th style="padding:4px 8px;text-align:right;border:1px solid var(--border)">n = Es/Ec</th>
                <th style="padding:4px 8px;text-align:left;border:1px solid var(--border)">Common Use</th>
              </tr>
            </thead>
            <tbody>
              ${[
                [17,'f\'c=2500psi — light residential footings'],
                [21,'f\'c=3000psi — slabs, walls'],
                [24,'f\'c=3500psi — slabs, beams'],
                [28,'f\'c=4000psi — standard structural (most common)'],
                [35,'f\'c=5000psi — high-rise columns, PT slabs'],
                [42,'f\'c=6000psi — high-rise lower columns'],
                [48,'f\'c=7000psi — special HPC columns'],
                [56,'f\'c=8000psi — HPC bridges, parking'],
                [70,'f\'c=10000psi — ultra-high columns']
              ].map(([fc, use]) => {
                const Ec  = (4700*Math.sqrt(fc)/1000).toFixed(2);
                const fr  = (0.62*Math.sqrt(fc)).toFixed(2);
                const b1  = Math.max(0.65, 0.85-0.05*Math.max(0,fc-28)/7).toFixed(3);
                const rbal= (0.85*b1*fc/420*(200000*0.003/(200000*0.003+420))*100).toFixed(2);
                const n   = Math.round(200000/(4700*Math.sqrt(fc)));
                return `<tr style="border-bottom:1px solid var(--border);">
                  <td style="padding:3px 8px;border:1px solid var(--border);font-weight:600">${fc}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);text-align:right">${Ec}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);text-align:right">${fr}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);text-align:right">${b1}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);text-align:right">${rbal}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);text-align:right">${n}</td>
                  <td style="padding:3px 8px;border:1px solid var(--border);color:var(--text-muted)">${use}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </details>

      <div style="margin-top:10px;padding:8px;background:var(--panel-alt,#f0f4ff);border-radius:6px;font-size:11px;color:var(--text-muted)">
        <strong>Formulas (ACI 318M-19 SI):</strong>
        Ec = 4700√f'c [MPa] §19.2.2.1 &nbsp;|&nbsp;
        fr = 0.62λ√f'c [MPa] §19.2.3.1 &nbsp;|&nbsp;
        β₁: 0.85 (f'c≤28), −0.05/7MPa above 28, min 0.65 §22.2.2.4.3 &nbsp;|&nbsp;
        ε_cu = 0.003 §22.2.2.1 &nbsp;|&nbsp;
        ρ_bal = 0.85β₁(f'c/fy)·[ε_cu/(ε_cu+ε_y)] §R9.3.3.1
      </div>`;

    // Initial calculation
    _refreshAciMat();
  }

  function _refreshAciMat() {
    const fcEl = document.getElementById('aci-fc-num');
    const fyEl = document.getElementById('aci-fy-num');
    const resEl= document.getElementById('aci-mat-results');
    if (!fcEl || !resEl) return;

    const fc     = Math.max(17, Math.min(100, parseFloat(fcEl.value) || 28));
    const fy     = Math.max(200, Math.min(1000, parseFloat(fyEl.value) || 420));
    const lambdaEl = document.querySelector('input[name="aci-lambda"]:checked');
    const lambda = parseFloat(lambdaEl ? lambdaEl.value : 1.0);

    // ACI 318M-19 SI formulas
    const Ec     = 4700 * Math.sqrt(fc);                                   // MPa §19.2.2.1
    const fr     = 0.62 * lambda * Math.sqrt(fc);                          // MPa §19.2.3.1
    const beta1  = Math.max(0.65, 0.85 - 0.05 * Math.max(0, fc - 28) / 7); // §22.2.2.4.3
    const eps_cu = 0.003;                                                   // §22.2.2.1
    const Es     = 200000;                                                  // MPa §20.2.2.2
    const eps_y  = fy / Es;
    const rho_bal= 0.85 * beta1 * (fc / fy) * (eps_cu / (eps_cu + eps_y)); // balanced reinf ratio
    const rho_min= Math.max(0.25 * Math.sqrt(fc) / fy, 1.4 / fy);          // §9.6.1.2
    const rho_max= 0.75 * rho_bal;                                          // practical max ~ACI R9.3.3
    const n      = Math.round(Es / Ec);                                     // modular ratio

    // Practical limits
    const fcClass = fc <= 21 ? 'Low (f\'c ≤ 21 MPa)' :
                    fc <= 35 ? 'Normal (21–35 MPa)' :
                    fc <= 55 ? 'High-Strength (35–55 MPa)' :
                               'Ultra-High-Strength (>55 MPa)';

    const rows = [
      { lbl:'Ec — Elastic Modulus',       val:`${(Ec/1000).toFixed(3)} GPa`, sub:`= 4700√${fc} = ${Ec.toFixed(0)} MPa` },
      { lbl:'fr — Modulus of Rupture',    val:`${fr.toFixed(2)} MPa`,        sub:`= 0.62×${lambda}×√${fc}` },
      { lbl:'β₁ — Stress-block factor',  val:`${beta1.toFixed(3)}`,          sub: fc<=28 ? '= 0.85 (f\'c ≤ 28 MPa)' : `= 0.85 − 0.05×(${fc}−28)/7` },
      { lbl:'ε_cu — Ultimate strain',     val:`0.003`,                        sub:'ACI 318-19 §22.2.2.1 (constant)' },
      { lbl:'ε_y — Rebar yield strain',   val:`${eps_y.toFixed(4)}`,          sub:`= ${fy}/${Es} = ${(eps_y*1000).toFixed(2)} ‰` },
      { lbl:'n — Modular ratio Es/Ec',    val:`${n}`,                         sub:`= ${Es}/${Ec.toFixed(0)} ≈ ${n}` },
      { lbl:'ρ_bal — Balanced ratio',     val:`${(rho_bal*100).toFixed(3)} %`,sub:`= 0.85β₁(f'c/fy)·[ε_cu/(ε_cu+ε_y)]` },
      { lbl:'ρ_min — Min reinforcement',  val:`${(rho_min*100).toFixed(4)} %`,sub:`max(0.25√f'c/fy, 1.4/fy) §9.6.1.2` },
      { lbl:'ρ_max — Practical max',      val:`${(rho_max*100).toFixed(3)} %`,sub:`= 0.75ρ_bal (tension-controlled)` },
      { lbl:'Concrete class',             val:fcClass,                        sub:'' },
    ];

    resEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <tbody>
          ${rows.map((r, i) => `
            <tr style="background:${i%2===0?'var(--panel-alt,#f7f9ff)':'transparent'}">
              <td style="padding:5px 8px;font-weight:600;font-size:12px;border-bottom:1px solid var(--border);white-space:nowrap">${r.lbl}</td>
              <td style="padding:5px 8px;text-align:right;font-size:13px;font-weight:700;color:var(--accent);border-bottom:1px solid var(--border);white-space:nowrap">${r.val}</td>
              <td style="padding:5px 8px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border)">${r.sub}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── Part 4: ACI §6.6.3.1 Stiffness Modifiers — Bulk Apply / Clear ──────────
  function _applyAciStiffMods() {
    if (!window.PropertyModifiers) { toast('PropertyModifiers not loaded', 'error'); return; }
    const typeEl = document.getElementById('aci-mod-type');
    const mode   = typeEl ? typeEl.value : 'auto';

    let count = 0;
    for (const bm of beams) {
      const sec = sections.find(s => s.id === bm.sectionId);
      if (!sec) continue;

      // Determine if this member is concrete (RC or ACI section)
      const isAciSec = window.ACIDesign && ACIDesign.isACI(sec);
      const isRcSec  = window.RCDesign  && RCDesign.isRC(sec);
      const isConcrete = isAciSec || isRcSec;

      if (!isConcrete && mode === 'auto') continue; // skip non-concrete in auto mode

      let presetKey;
      if (mode !== 'auto') {
        // Explicit preset selected
        presetKey = mode;
      } else {
        // Auto-detect: use section name or geometry to pick preset
        const name = (sec.name || '').toUpperCase();
        if (/\bACI\s*C\b/.test(name)) {
          presetKey = 'aci_col';   // ACI column → 0.70 EI
        } else if (/\bACI\s*B\b/.test(name)) {
          presetKey = 'aci_beam';  // ACI beam   → 0.35 EI
        } else if (/SLAB|FLAT|TWO.?WAY/.test(name)) {
          presetKey = 'aci_slab';  // slab → 0.25 EI
        } else if (/WALL|SHEAR/.test(name)) {
          presetKey = 'aci_wall';  // wall → 0.35 EI + 0.80 EA
        } else {
          // Fallback: use d/b aspect ratio — tall = beam, squarish = column
          const d = sec.d  || sec.h  || 0;
          const b = sec.bf || sec.tw || sec.b || 1;
          presetKey = (d / b) > 1.5 ? 'aci_beam' : 'aci_col';
        }
      }

      PropertyModifiers.applyPreset(bm.id, presetKey);
      bm.modifiers = PropertyModifiers.get(bm.id);
      count++;
    }

    if (count === 0) {
      toast('No concrete members found. Check section assignments.', 'warn');
    } else {
      const presetNames = {
        auto:'Auto-detect', aci_beam:'Beam (0.35·EI)', aci_col:'Column (0.70·EI)',
        aci_slab:'Slab (0.25·EI)', aci_wall:'Wall (cracked, 0.35·EI)'
      };
      toast(`ACI §6.6.3.1 modifiers applied to ${count} member${count>1?'s':''} [${presetNames[mode]||mode}]`, 'success');
      snapshot();
      render();
    }
  }

  function _clearAciStiffMods() {
    if (!window.PropertyModifiers) { toast('PropertyModifiers not loaded', 'error'); return; }
    let count = 0;
    for (const bm of beams) {
      if (PropertyModifiers.isModified(bm.id)) {
        PropertyModifiers.remove(bm.id);
        delete bm.modifiers;
        count++;
      }
    }
    if (count === 0) {
      toast('No stiffness modifiers to clear.', 'info');
    } else {
      toast(`Cleared stiffness modifiers from ${count} member${count>1?'s':''}.`, 'success');
      snapshot();
      render();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ── DRAW PANE — Tool palette, generators, edit & modify ──────────
  // ═══════════════════════════════════════════════════════════════════

  // ── Selection & Edit — delegated to js/core/selection.js via window.AppEdit ──
  // Full implementations live in selection.js; these stubs forward calls so that
  // internal event handlers (initDrawPane, initEvents) don't need to know about
  // the module split.
  function selectAll()                          { window.AppEdit?.selectAll(); }
  function deselectAll()                        { window.AppEdit?.deselectAll(); }
  function invertSelection()                    { window.AppEdit?.invertSelection(); }
  function deleteSelected()                     { window.AppEdit?.deleteSelected(); }
  function moveSelection(dx, dy, dz)            { window.AppEdit?.moveSelection(dx, dy, dz); }
  function copySelection(dx, dy, dz)            { window.AppEdit?.copySelection(dx, dy, dz); }
  function rotateSelection(angleDeg)            { window.AppEdit?.rotateSelection(angleDeg); }
  function mirrorSelection(axis)                { window.AppEdit?.mirrorSelection(axis); }
  function splitBeam(beamId, n)                 { window.AppEdit?.splitBeam(beamId, n); }
  function insertNodeMidpoint(beamId)           { window.AppEdit?.insertNodeMidpoint(beamId); }
  function subdivideSelectedBeams(n)            { window.AppEdit?.subdivideSelectedBeams(n); }
  function mergeCoincidentNodes(tol)            { window.AppEdit?.mergeCoincidentNodes(tol); }
  function alignNodes(mode)                     { window.AppEdit?.alignNodes(mode); }
  function distributeNodes(axis)                { window.AppEdit?.distributeNodes(axis); }

  // ── Generators — delegated to js/core/generators.js via window.AppGenerators ──
  // Full implementations live in generators.js; these stubs forward calls so that
  // internal event handlers (initDrawPane) don't need to know about the module split.
  function generateFrame(bays, stories, bayW, storyH, supType) {
    window.AppGenerators?.generateFrame(bays, stories, bayW, storyH, supType);
  }
  function generateTruss(type, panels, panelW, h) {
    window.AppGenerators?.generateTruss(type, panels, panelW, h);
  }
  function generateContinuousBeam(spans, spanLen, udl, supStyle) {
    window.AppGenerators?.generateContinuousBeam(spans, spanLen, udl, supStyle);
  }

  // ── Panel resize handles ──────────────────────────────────────────
  function initResizers() {
    function makeResizer(resizerId, panelId, side) {
      const resizer = document.getElementById(resizerId);
      const panel   = document.getElementById(panelId);
      if (!resizer || !panel) return;

      let startX = 0, startW = 0;

      resizer.addEventListener('mousedown', e => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
          const dx   = ev.clientX - startX;
          const newW = side === 'left'
            ? Math.max(28, Math.min(startW + dx, 380))   // left panel
            : Math.max(200, Math.min(startW - dx, 500));  // right panel
          panel.style.width    = newW + 'px';
          panel.style.minWidth = newW + 'px';
          panel.style.maxWidth = newW + 'px';
        }
        function onUp() {
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
          // Redraw everything after panel resize
          render();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
      });
    }

    makeResizer('resizer-left',  'left-panel',  'left');
    makeResizer('resizer-right', 'side-panel',  'right');
  }

  // ── Import sections from Excel/CSV file ──────────────────────────
  /**
   * Turn one spreadsheet row into a section, or say why it cannot be one.
   *
   * Shared by the .xlsx and .csv paths, which had near-identical copies that
   * disagreed in one important way: SheetJS yields real numbers, the CSV
   * parser yields strings, and the old `row['E_GPa'] || row['E'] || 200` chain
   * treats a numeric 0 as absent but the string "0" as present. The same file
   * imported as .xlsx and as .csv produced different sections.
   *
   * Absent is not the same as zero, and neither is the same as "use 200".
   */
  function sectionFromImportRow(row, takenNames) {
    // First key that is actually present and non-blank. A value of 0 counts as
    // present — that is the whole point.
    const pick = (...keys) => {
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
      }
      return undefined;
    };

    const name = String(pick('Name', 'name') ?? '').trim();
    if (!name) return { skipped: 'row has no Name' };
    if (takenNames.has(name)) return { skipped: name + ' — a section of that name already exists' };

    // E, A and I are the section. Without them there is nothing to import, and
    // a made-up value would silently become somebody's design property.
    const required = { E: ['E_GPa', 'E'], A: ['A_cm2', 'A'], I: ['I_cm4', 'I'] };
    const out = { name };
    for (const label of Object.keys(required)) {
      const raw = pick.apply(null, required[label]);
      if (raw === undefined) return { skipped: name + ' — no ' + label + ' column' };
      const v = parseFloat(raw);
      if (!isFinite(v)) return { skipped: name + ' — ' + label + ' is not a number (' + raw + ')' };
      if (v <= 0) return { skipped: name + ' — ' + label + ' = ' + v + ', must be greater than zero' };
      out[label] = v;
    }

    // fy and density are not needed to draw the member, so a file without them
    // still imports — but the defaults are recorded and reported rather than
    // quietly becoming the section's strength.
    const defaulted = [];
    const optional = { fy: [['fy_MPa', 'fy'], 250], rho: [['rho_kNm3', 'rho'], 78.5] };
    for (const label of Object.keys(optional)) {
      const raw = pick.apply(null, optional[label][0]);
      const v = raw === undefined ? NaN : parseFloat(raw);
      if (!isFinite(v) || v < 0) { out[label] = optional[label][1]; defaulted.push(label); }
      else out[label] = v;
    }
    return { section: out, defaulted };
  }

  /** Apply parsed rows to the model and report honestly on what happened. */
  function applyImportedSections(rows, sourceLabel) {
    const taken = new Set(sections.map(s => s.name));
    const added = [], skipped = [], defaulted = [];
    for (const row of rows) {
      const r = sectionFromImportRow(row, taken);
      if (r.skipped) { skipped.push(r.skipped); continue; }
      taken.add(r.section.name);
      added.push(r.section);
      if (r.defaulted.length) defaulted.push(r.section.name + ' (' + r.defaulted.join(', ') + ')');
    }

    if (!added.length) {
      toast('Nothing imported from ' + sourceLabel + '. ' +
            (skipped.length
              ? skipped.length + ' row(s) rejected — ' + skipped[0] +
                (skipped.length > 1 ? ', and ' + (skipped.length - 1) + ' more' : '')
              : 'the file had no usable rows.'), 'error');
      return { added: 0, skipped: skipped.length, defaulted: defaulted.length };
    }

    // BEFORE mutating: snapshot() records the PRE-edit state, so calling it
    // after the push — as this did — left Ctrl+Z unable to undo an import.
    snapshot();
    added.forEach(sec => sections.push(Object.assign({ id: allocSectionId() }, sec, { Ix: sec.I })));
    updateSectionTable();
    render();

    let msg = 'Imported ' + added.length + ' section' + (added.length === 1 ? '' : 's') +
              ' from ' + sourceLabel + '.';
    if (skipped.length)   msg += ' ' + skipped.length + ' row' + (skipped.length === 1 ? '' : 's') + ' skipped.';
    if (defaulted.length) msg += ' ' + defaulted.length + ' took default fy/rho.';
    toast(msg, skipped.length ? 'warn' : 'success');

    // The detail belongs somewhere readable, not truncated into a toast.
    if (skipped.length || defaulted.length) {
      const parts = [];
      if (skipped.length)   parts.push('Skipped:\n  ' + skipped.join('\n  '));
      if (defaulted.length) parts.push('Used default fy = 250 MPa and/or rho = 78.5 kN/m3 for:\n  ' +
                                       defaulted.join('\n  '));
      console.warn('[Section import] ' + sourceLabel + '\n' + parts.join('\n\n'));
    }
    return { added: added.length, skipped: skipped.length, defaulted: defaulted.length };
  }

  /**
   * CSV to row objects, honouring quoted fields.
   *
   * The previous parser was `line.split(',')`, so a single quoted name
   * containing a comma shifted every later column by one and the row imported
   * with the wrong numbers in the wrong properties. It also dropped any row
   * with fewer than five commas without saying so.
   */
  function parseCSVRows(text) {
    const rows = [];
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) return rows;

    const splitLine = line => {
      const out = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch !== '"') { cur += ch; continue; }
          if (line[i + 1] === '"') { cur += '"'; i++; }   // "" is an escaped quote
          else inQ = false;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(v => v.trim());
    };

    const header = splitLine(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      const vals = splitLine(lines[i]);
      const row = {};
      header.forEach((h, j) => { if (h) row[h] = vals[j]; });
      rows.push(row);
    }
    return rows;
  }

  function importSectionsFromFile(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    if (ext === 'xlsx' || ext === 'xls') {
      if (!window.XLSX) { toast('SheetJS not loaded. Use CSV import instead.', 'error'); return; }
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'binary' });
          const rows = [];
          wb.SheetNames.forEach(sheetName => {
            rows.push.apply(rows, XLSX.utils.sheet_to_json(wb.Sheets[sheetName]));
          });
          applyImportedSections(rows, file.name);
        } catch (err) { toast('Error parsing Excel: ' + err.message, 'error'); }
      };
      reader.readAsBinaryString(file);
    } else if (ext === 'csv') {
      reader.onload = e => {
        try { applyImportedSections(parseCSVRows(e.target.result), file.name); }
        catch (err) { toast('Error parsing CSV: ' + err.message, 'error'); }
      };
      reader.readAsText(file);
    } else {
      toast('Unsupported file type. Use .xlsx or .csv', 'error');
    }
  }

  // ── Wire up Draw pane buttons ─────────────────────────────────────
  function initDrawPane() {
    // Left panel collapse toggle
    const btnCollapse = document.getElementById('btn-left-collapse');
    const leftPanel   = document.getElementById('left-panel');
    if (btnCollapse && leftPanel) {
      btnCollapse.addEventListener('click', () => {
        leftPanel.classList.toggle('collapsed');
        btnCollapse.title = leftPanel.classList.contains('collapsed')
          ? 'Expand draw panel' : 'Collapse draw panel';
      });
    }

    // Tool palette: clicking activates the same global tool
    document.querySelectorAll('.draw-tool-btn[data-draw-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.drawTool));
    });

    // Collapsible gen-cards
    ['gen-frame-hdr','gen-truss-hdr','gen-cbeam-hdr'].forEach(hdrId => {
      const hdr  = document.getElementById(hdrId);
      const body = hdr ? hdr.nextElementSibling : null;
      if (!hdr || !body) return;
      // Bay Frame starts open, others collapsed
      if (hdrId === 'gen-frame-hdr') {
        hdr.classList.add('open');
        body.classList.remove('collapsed');
      } else {
        body.classList.add('collapsed');
      }
      hdr.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        hdr.classList.toggle('open');
      });
    });

    // Generate Frame
    document.getElementById('btn-gen-frame').addEventListener('click', () => {
      const bays    = parseInt(document.getElementById('gen-bays').value)    || 3;
      const stories = parseInt(document.getElementById('gen-stories').value) || 3;
      const bayW    = parseFloat(document.getElementById('gen-bay-w').value) || 5;
      const storyH  = parseFloat(document.getElementById('gen-story-h').value) || 3;
      const sup     = document.getElementById('gen-frame-sup').value;
      generateFrame(bays, stories, bayW, storyH, sup);
    });

    // Generate Truss
    document.getElementById('btn-gen-truss').addEventListener('click', () => {
      const type   = document.getElementById('gen-truss-type').value;
      const panels = parseInt(document.getElementById('gen-truss-panels').value) || 6;
      const pw     = parseFloat(document.getElementById('gen-panel-w').value) || 2;
      const h      = parseFloat(document.getElementById('gen-truss-h').value) || 2;
      generateTruss(type, panels, pw, h);
    });

    // Generate Continuous Beam
    document.getElementById('btn-gen-beam').addEventListener('click', () => {
      const spans  = parseInt(document.getElementById('gen-spans').value)    || 3;
      const len    = parseFloat(document.getElementById('gen-span-len').value) || 6;
      const udl    = parseFloat(document.getElementById('gen-udl').value)    || 0;
      const sup    = document.getElementById('gen-beam-sup').value;
      generateContinuousBeam(spans, len, udl, sup);
    });

    // Select All / Deselect / Invert / Delete
    document.getElementById('btn-sel-all').addEventListener('click',    selectAll);
    document.getElementById('btn-sel-none').addEventListener('click',   deselectAll);
    document.getElementById('btn-sel-invert').addEventListener('click', invertSelection);
    document.getElementById('btn-del-selected').addEventListener('click', deleteSelected);

    // Move / Copy
    const getDelta = () => ({
      dx: parseFloat(document.getElementById('edit-dx').value) || 0,
      dy: parseFloat(document.getElementById('edit-dy').value) || 0,
      dz: parseFloat(document.getElementById('edit-dz').value) || 0,
    });
    document.getElementById('btn-move-sel').addEventListener('click', () => {
      const { dx, dy, dz } = getDelta(); moveSelection(dx, dy, dz);
    });
    document.getElementById('btn-copy-sel').addEventListener('click', () => {
      const { dx, dy, dz } = getDelta(); copySelection(dx, dy, dz);
    });

    // Rotate / Mirror
    document.getElementById('btn-rot-sel').addEventListener('click', () => {
      const ang = parseFloat(document.getElementById('edit-rot-angle').value) || 90;
      rotateSelection(ang);
    });
    document.getElementById('btn-mirror-h').addEventListener('click', () => mirrorSelection('H'));
    document.getElementById('btn-mirror-v').addEventListener('click', () => mirrorSelection('V'));

    // Split / Midpoint / Subdivide
    document.getElementById('btn-split-beam').addEventListener('click', () => {
      if (selBeam === null) { toast('Select a beam first', 'warn'); return; }
      const n = parseInt(document.getElementById('split-n').value) || 2;
      splitBeam(selBeam, n);
    });
    document.getElementById('btn-insert-mid').addEventListener('click', () => {
      if (selBeam === null) { toast('Select a beam first', 'warn'); return; }
      insertNodeMidpoint(selBeam);
    });
    document.getElementById('btn-subdivide').addEventListener('click', () => {
      const n = parseInt(document.getElementById('split-n').value) || 2;
      subdivideSelectedBeams(n);
    });

    // Merge Coincident Nodes
    document.getElementById('btn-merge-nodes').addEventListener('click', () => {
      const tol = parseFloat(document.getElementById('merge-tol').value) || 0.05;
      mergeCoincidentNodes(tol);
    });

    // Align
    document.getElementById('btn-align-left').addEventListener('click',   () => alignNodes('left'));
    document.getElementById('btn-align-right').addEventListener('click',  () => alignNodes('right'));
    document.getElementById('btn-align-top').addEventListener('click',    () => alignNodes('top'));
    document.getElementById('btn-align-bottom').addEventListener('click', () => alignNodes('bottom'));
    document.getElementById('btn-align-h').addEventListener('click',      () => alignNodes('hcenter'));
    document.getElementById('btn-align-v').addEventListener('click',      () => alignNodes('vcenter'));

    // Distribute
    document.getElementById('btn-distrib-h').addEventListener('click', () => distributeNodes('H'));
    document.getElementById('btn-distrib-v').addEventListener('click', () => distributeNodes('V'));

    // Show/hide Δz row depending on 3D mode
    function updateDzRow() {
      const row = document.getElementById('edit-dz-row');
      if (row) row.style.display = mode3D ? '' : 'none';
    }
    updateDzRow();
    // Hook called by the 3D toggle button handler to update the Δz row visibility
    window._drawPaneUpdateDzRow = updateDzRow;
  }

  // ── Runtime Namespace — live state + core functions for external modules ──
  // Populated here so generators.js, selection.js, indexeddb.js, etc. can
  // access the closure without being inside this IIFE.
  // Getters/setters ensure external modules always see the CURRENT value of
  // each closure variable (not a snapshot taken at load time).
  window.SA = {
    // ── Mutable arrays (push/splice work via reference; reassignment needs setter)
    get nodes()       { return nodes;       },  set nodes(v)       { nodes = v;       },
    get beams()       { return beams;       },  set beams(v)       { beams = v;       },
    // Setters on all of these: without them `SA.loads = []` was a silent no-op
    // (assigning to a getter-only property throws only in strict mode, and this
    // file is sloppy), so callers following the documented
    // `SA.x = SA.x.filter(...)` pattern got no error and no effect.
    get sections()    { return sections;    },  set sections(v)    { sections = v;    },
    // The one material library. MAT_UI mutates this array in place; there is no
    // second copy to fall out of step with it.
    get materials()   { return materials;   },  set materials(v)   { materials = v;   },
    get loads()       { return loads;       },  set loads(v)       { loads = v;       },
    get settlements() { return settlements; },  set settlements(v) { settlements = v; },
    get loadCases()   { return loadCases;   },  set loadCases(v)   { loadCases = v;   },
    get loadCombos()  { return loadCombos;  },  set loadCombos(v)  { loadCombos = v;  },
    // ── Primitive state (needs getter + setter)
    get results()     { return results;     },  set results(v)     { results = v;     },
    // Per-case and per-combination result sets. Exposed for the same reason as
    // the rest of the namespace — external modules and tooling could reach
    // `results` but not the underlying case/combo results it is selected from.
    get allCaseResults()  { return allCaseResults;  },
    get allComboResults() { return allComboResults; },
    get activeDisplay()   { return activeDisplay;   },
    get selNode()     { return selNode;     },  set selNode(v)      { selNode = v;     },
    get selBeam()     { return selBeam;     },  set selBeam(v)      { selBeam = v;     },
    get mode3D()      { return mode3D;      },
    // ── 3D view state (az/el angles — mutations via .property work)
    get view3D()      { return view3D;      },
    // ── Toggle 3D mode programmatically
    set mode3D(v) {
      if (v !== mode3D) document.getElementById('btn-3d') && document.getElementById('btn-3d').click();
    },
    // ── Object refs.
    // nextId and multiSel are REASSIGNED (new file, clear canvas, load project,
    // restore session), so they must be getters. Exposing them as plain values
    // captured the object that existed when this literal was built: after the
    // first reassignment window.SA kept handing out an orphaned copy, so
    // generators read a stale id counter (crashing generateContinuousBeam) and
    // selection.js mutated a Set the app no longer looked at.
    get nextId()   { return nextId;   },  set nextId(v)   { nextId = v;   },
    get multiSel() { return multiSel; },  set multiSel(v) { multiSel = v; },
    // cfg and views are never reassigned, so a plain ref is fine.
    cfg, views,
    // ── Core CRUD
    addNode, addBeam, findNode, findBeam, deleteNode, deleteBeam,
    allocSectionId,
    // Sections reference materials by id, so both stores need an allocator and
    // a lookup that the Define dialogs can share.
    allocMaterialId, findMaterial,
    // Shared so extrude.js colours solids the same way the wireframe does
    sectionColorIndex, sectionColor,
    // The one place a member's name is decided — C1 / B7 / BR3, or a custom
    // label. The Properties panel used to build its own 'M' + id and so called
    // the member you had just clicked on the canvas by a different name.
    getMemberLabel,
    // ── Core UI / render
    snapshot, render, toast,
    updateNodeTable, updateBeamTable, updateLoadTable, updateSectionTable,
    // Generators rebuild loadCases, so they need to refresh the panes that
    // list them — otherwise the Loads-pane case filter keeps stale case ids.
    updateCasesPane, populateDisplaySelector,
    fitToScreen,
    // ── Camera / projection state (for external renderers like extrude.js)
    get pan()    { return pan;   },
    get scale()  { return scale; },
    mToS3D_ext: (x,y,z) => mToS3D(x,y,z),  // public projection function
    mToS: (x,y) => mToS(x,y),              // 2D model → screen projection
    get unit() { return window.UnitSystem ? UnitSystem.currentId() : 'kN-m'; },
    // ── Working plane for 3D drawing
    get workPlane() { return _workPlane; },
    setWorkPlane,
    // ── Section assignment (used by Section draw tool and external callers)
    openChangeSection: (beamId) => App._openChangeSection(beamId),
    // ── Clear all analysis & design results, revert to unanalyzed state
    clearResults: () => {
      snapshot();
      results        = null;
      allCaseResults = {};
      allComboResults= {};
      designResults  = null;
      activeDisplay  = { type: 'case', id: loadCases.length ? loadCases[0].id : 1 };
      resetModeOverlay();
      const area = document.getElementById('results-area');
      if (area) area.innerHTML = '<p class="no-results">Run Solve to see results.</p>';
      updateDesignTable();
      const dsEl = document.getElementById('design-summary');
      if (dsEl) dsEl.textContent = 'Run design checks to see results.';
      const badge = document.getElementById('design-checks-badge');
      if (badge) badge.textContent = '';
      render();
      toast('Analysis results cleared — structure reverted to unanalyzed state', 'ok');
    },

    // ── Clear ALL applied loads (geometry kept intact) ────────────────
    clearAllLoads: () => {
      snapshot();
      loads = [];
      updateLoadTable();
      // Refresh count badges in status bar
      const ldEl = document.getElementById('sb-loads');
      if (ldEl) ldEl.textContent = '0';
      const cntEl = document.getElementById('expl-cnt-loads');
      if (cntEl) cntEl.textContent = '0';
      render();
      toast('All loads removed from the model', 'ok');
    },
  };

  // ── Public API ────────────────────────────────────────────────────
  return { init, _openCheckDetail, _openModifiers, _setLcr, _openChangeSection, _pushCompoundSection, _refreshAciMat };
})();

window.addEventListener('load', () => App.init());
