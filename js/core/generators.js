// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — Structure Generators
//
//  Generates parametric structural templates:
//    generateFrame           — multi-bay, multi-story moment frame
//    generateTruss           — Pratt / Howe / Warren / King / Fink roof truss
//    generateContinuousBeam  — N-span continuous beam with optional UDL
//    generateSimpleBeam      — single span, choice of supports + optional loads
//    generateBracedFrame     — moment frame with X / diagonal / K / V bracing
//    generateArch            — parabolic or circular arch, N segments
//    generateFloorGrid       — rectangular grid of beams (floor framing)
//    generateVierendeel      — rectangular-panel truss, no diagonals
//    generateLeanTo          — mono-pitch shed frame (unequal column heights)
//    generateColumnLine      — vertical column stack, optional floor beams
//    generateDefaultStructure — the startup 2-bay/2-storey demo frame
//
//  All functions reach into the live app state via window.SA, which
//  app.js populates before window.load fires.
//
//  Exposed as: window.AppGenerators = { generateFrame, generateTruss,
//    generateContinuousBeam, generateSimpleBeam, generateBracedFrame,
//    generateArch, generateFloorGrid, generateVierendeel, generateLeanTo,
//    generateColumnLine, generateDefaultStructure }
// ──────────────────────────────────────────────────────────────────
'use strict';

window.AppGenerators = (() => {

  // Convenience: retrieve the live SA namespace (populated by app.js)
  function sa() { return window.SA; }

  // ── resetModel ───────────────────────────────────────────────────
  // Every function here builds a TEMPLATE, and a template replaces the model
  // rather than adding to it. Only generateDefaultStructure used to do this;
  // the other ten appended their geometry to whatever was already on the
  // canvas, so picking a template from the Generate menu layered it on top of
  // the existing structure. Three clicks of "Arch" produced 36 nodes and 34
  // members with nine sets of exactly-coincident nodes — three arches stacked
  // on each other plus the frame that was there before. The overlapping
  // members are invisible on screen but all present in the stiffness matrix.
  //
  // Sections are preserved (they are a library, not geometry). Load cases are
  // preserved too, because several generators write their loads into
  // app.loadCases[0] and would otherwise have nowhere to put them — but at
  // least one case is guaranteed to exist.
  function resetModel(app) {
    app.nodes       = [];
    app.beams       = [];
    app.loads       = [];
    app.settlements = [];
    app.results     = null;
    app.selNode     = null;
    app.selBeam     = null;
    if (app.multiSel) { app.multiSel.nodes.clear(); app.multiSel.beams.clear(); }
    if (!app.loadCases || app.loadCases.length === 0) {
      app.loadCases = [{ id: app.nextId.lcase++, name: 'Dead', type: 'DL', color: '#1565C0' }];
    }
    // Deliberately NOT app.clearResults(): that helper takes its own snapshot()
    // as its first statement, so calling it here pushed the just-emptied model
    // onto the undo stack. Undo then restored an empty canvas instead of the
    // previous structure, and it took a second undo to get back. Clearing
    // `results` above is all this needs — every generator re-renders on exit.
  }

  // ── toggleWillMigrate ────────────────────────────────────────────
  // True when the pending enable3DXZ() call will actually fire the #btn-3d
  // handler, which performs its own Y→Z migration on every node.
  // liftToZ and enable3DXZ must agree on this, so both ask the same question.
  function toggleWillMigrate(app) {
    return !!(document.getElementById('btn-3d') && app && !app.mode3D);
  }

  // ── liftToZ ──────────────────────────────────────────────────────
  // Sets nd.z = nd.y so the structure is visible as vertical in 3D XZ view.
  //   nd.z = nd.y  (height copied to Z — 3D vertical axis)
  //   nd.y = 0     (XZ plane — no depth)
  // Skipped when a 2D→3D toggle is still pending: the #btn-3d handler applies
  // the identical migration, and doing both swaps the axes straight back
  // (elevation would land in Y again, leaving the frame lying flat).
  function liftToZ(nodeIds, app) {
    if (toggleWillMigrate(app)) return;
    nodeIds.forEach(function(id) {
      const nd = app.findNode(id);
      if (!nd) return;
      nd.z = nd.y;   // height → Z  (3D: Z is the vertical axis)
      nd.y = 0;      // XZ plane — no depth (y=0 keeps YZ side view clean)
    });
  }

  // ── enable3D ─────────────────────────────────────────────────────
  // Switches to 3D mode and frames the model.
  //
  // `iso` selects the landing view. az = el = 0 is a pure front elevation, in
  // which every member is seen exactly edge-on: sections project to flat
  // rectangles with no visible depth, so a freshly generated model looked 2D
  // and the extruded solids appeared to have a missing edge. Generators that
  // build a planar frame in the XZ plane now land on a standard isometric
  // (45° / 35.26°) so the depth is actually visible.
  function enable3D(app, iso) {
    if (toggleWillMigrate(app)) document.getElementById('btn-3d').click();
    setTimeout(function() {
      const v = app && app.view3D;
      if (v) {
        if (iso === false) { v.az = 0; v.el = 0; }
        else               { v.az = Math.PI / 4; v.el = 0.6155; }
      }
      app && app.render && app.render();
      app && app.fitToScreen && app.fitToScreen();
    }, 180);
  }

  // Backwards-compatible alias for the previous name.
  function enable3DXZ(app) { enable3D(app, true); }

  // ── generateFrame ─────────────────────────────────────────────────
  // Creates a regular rectangular moment frame.
  // supType: 'fixed' | 'pin' | 'roller' (roller = first col pin, rest roller)
  function generateFrame(bays, stories, bayW, storyH, supType) {
    const app = sa();
    if (!bays || !stories || !bayW || !storyH) {
      app.toast('Invalid frame parameters', 'warn'); return;
    }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends

    const cols = bays + 1;
    const grid = [];   // grid[story][col] = nodeId

    // ── Nodes ───────────────────────────────────────────────────────
    for (let s = 0; s <= stories; s++) {
      grid[s] = [];
      for (let c = 0; c < cols; c++) {
        grid[s][c] = app.addNode(c * bayW, s * storyH);
      }
    }

    // ── Base supports ───────────────────────────────────────────────
    for (let c = 0; c < cols; c++) {
      const nd = app.findNode(grid[0][c]);
      if (!nd) continue;
      if (supType === 'roller') nd.support = c === 0 ? 'pin' : 'roller';
      else                      nd.support = supType;  // 'fixed' | 'pin'
    }

    // ── Columns (vertical members) ──────────────────────────────────
    for (let s = 0; s < stories; s++) {
      for (let c = 0; c < cols; c++) {
        app.addBeam(grid[s][c], grid[s + 1][c]);
      }
    }

    // ── Beams (horizontal members) ──────────────────────────────────
    for (let s = 1; s <= stories; s++) {
      for (let c = 0; c < bays; c++) {
        app.addBeam(grid[s][c], grid[s][c + 1]);
      }
    }

    // Lift all nodes to Z-axis (columns vertical in 3D XZ view)
    const allNodeIds = [];
    for (let s = 0; s <= stories; s++) for (let c = 0; c < cols; c++) allNodeIds.push(grid[s][c]);
    liftToZ(allNodeIds, app);

    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(
      `Generated ${bays}-bay × ${stories}-story frame — ` +
      `${app.nodes.length} nodes, ${app.beams.length} beams`, 'success'
    );
  }

  // ── generateTruss ─────────────────────────────────────────────────
  // type: 'pratt' | 'howe' | 'warren' | 'king' | 'fink'
  function generateTruss(type, panels, panelW, h) {
    const app = sa();
    if (!panels || !panelW || !h) { app.toast('Invalid truss parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends

    const L = panels * panelW;

    if (type === 'pratt' || type === 'howe') {
      const top = [], bot = [];
      for (let i = 0; i <= panels; i++) {
        bot.push(app.addNode(i * panelW, 0));
        top.push(app.addNode(i * panelW, h));
      }
      app.findNode(bot[0]).support     = 'pin';
      app.findNode(bot[panels]).support = 'roller';

      // Top & bottom chords
      for (let i = 0; i < panels; i++) { app.addBeam(top[i], top[i + 1]); app.addBeam(bot[i], bot[i + 1]); }
      // Verticals
      for (let i = 0; i <= panels; i++) app.addBeam(bot[i], top[i]);
      // Diagonals
      const mid = panels / 2;
      for (let i = 0; i < panels; i++) {
        if (type === 'pratt') {
          if (i < mid) app.addBeam(bot[i], top[i + 1]);
          else         app.addBeam(top[i], bot[i + 1]);
        } else {  // howe
          if (i < mid) app.addBeam(top[i], bot[i + 1]);
          else         app.addBeam(bot[i], top[i + 1]);
        }
      }

    } else if (type === 'warren') {
      const top = [], bot = [];
      for (let i = 0; i <= panels; i++) bot.push(app.addNode(i * panelW, 0));
      for (let i = 0; i <  panels; i++) top.push(app.addNode((i + 0.5) * panelW, h));
      app.findNode(bot[0]).support     = 'pin';
      app.findNode(bot[panels]).support = 'roller';

      for (let i = 0; i < panels - 1; i++) app.addBeam(top[i], top[i + 1]);
      for (let i = 0; i < panels;     i++) app.addBeam(bot[i], bot[i + 1]);
      for (let i = 0; i < panels;     i++) {
        app.addBeam(bot[i], top[i]);
        app.addBeam(top[i], bot[i + 1]);
      }

    } else if (type === 'king') {
      // King post: 2 rafters + king post + bottom tie
      const A = app.addNode(0,    0);
      const B = app.addNode(L,    0);
      const C = app.addNode(L/2,  h);
      const D = app.addNode(L/2,  0);
      app.findNode(A).support = 'pin';
      app.findNode(B).support = 'roller';
      app.addBeam(A, B); app.addBeam(A, C); app.addBeam(B, C); app.addBeam(C, D);

    } else if (type === 'fink') {
      // Fink roof truss: sloping top chord meeting the tie at the eaves, with
      // inner diagonals.
      //
      // The top chord profile h·(1 − |2x/L − 1|) is ZERO at both eaves, so
      // generating a separate top node at i = 0 and i = N put a second node on
      // top of each end of the bottom tie and then joined each pair with a
      // zero-length member. Every Fink truss carried two coincident nodes and
      // two degenerate members — invisible on screen, and the solver skips
      // zero-length elements, so the joints simply sat there unconnected.
      //
      // The web indices were also derived as q = N/4 without rounding. N is
      // forced even, not a multiple of four, so a 6-panel truss asked for
      // top[1.5] — undefined — and produced four members referencing a
      // non-existent node id.
      const N   = Math.max(4, Math.round(panels / 2) * 2);
      const top = [], bot = [];
      for (let i = 0; i <= N; i++) bot.push(app.addNode(i * L / N, 0));

      // The eaves are shared with the tie; only the interior top nodes are new.
      top[0] = bot[0];
      top[N] = bot[N];
      for (let i = 1; i < N; i++) {
        const xp = i * L / N;
        top[i] = app.addNode(xp, h * (1 - Math.abs(2 * xp / L - 1)));
      }
      app.findNode(bot[0]).support = 'pin';
      app.findNode(bot[N]).support = 'roller';

      for (let i = 0; i < N; i++) { app.addBeam(top[i], top[i + 1]); app.addBeam(bot[i], bot[i + 1]); }
      // Verticals only where the chords are genuinely apart.
      for (let i = 1; i < N; i++) app.addBeam(bot[i], top[i]);

      const q   = Math.max(1, Math.round(N / 4));
      const mid = N / 2;                      // N is even, so this is an integer
      // At q = 1 the eaves diagonal runs from bot[0] to top[1], which is exactly
      // the first top-chord segment (top[0] IS bot[0]) — adding it again puts a
      // duplicate member on the same node pair, doubling that element's
      // stiffness in the assembled matrix. Only draw it once the web is deep
      // enough for the two to differ.
      if (q > 1) {
        app.addBeam(bot[0], top[q]);
        app.addBeam(bot[N], top[N - q]);
      }
      app.addBeam(top[mid], bot[q]); app.addBeam(top[mid], bot[N - q]);
    }

    // Lift to Z-axis (chords vertical in 3D XZ view) — same reason as
    // generateFrame. Without this, building a truss while the app happens to
    // already be in 3D mode left its rise in Y, which the 3D camera reads as
    // DEPTH rather than height: a perfectly flat, correctly-shaped truss
    // rendered as though it climbed diagonally away from the viewer instead
    // of standing upright. Reading every current node rather than tracking
    // top/bot arrays by hand avoids double-lifting the shared eaves nodes the
    // Fink branch reuses (top[0] === bot[0], top[N] === bot[N]).
    liftToZ(app.nodes.map(function (n) { return n.id; }), app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(
      `Generated ${type} truss — ${app.nodes.length} nodes, ${app.beams.length} beams`, 'success'
    );
  }

  // ── generateContinuousBeam ────────────────────────────────────────
  // supStyle: 'pin-roller' | 'fixed-free' | 'fixed-fixed' | 'fixed-roller'
  function generateContinuousBeam(spans, spanLen, udl, supStyle) {
    const app = sa();
    if (!spans || !spanLen) { app.toast('Invalid beam parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends

    // Use the ids addNode() hands back rather than predicting them from the id
    // counter — the counter is not a reliable oracle and the other generators
    // already collect returned ids this way.
    const nodeIds = [];

    // ── Nodes + supports ───────────────────────────────────────────
    for (let i = 0; i <= spans; i++) {
      const id = app.addNode(i * spanLen, 0);
      nodeIds.push(id);
      const nd = app.findNode(id);
      if (!nd) continue;
      // An unrecognised style used to fall through every branch and leave the
      // model with no supports at all — a mechanism, reported only as a solver
      // error with nothing pointing back at the generator. The dialog offers
      // just these four, so this is a guard rather than a live path.
      if (supStyle === 'fixed-free')        nd.support = i === 0 ? 'fixed' : 'none';
      else if (supStyle === 'fixed-fixed')  nd.support = (i === 0 || i === spans) ? 'fixed' : 'none';
      else if (supStyle === 'fixed-roller') nd.support = i === 0 ? 'fixed' : 'roller';
      else                                  nd.support = i === 0 ? 'pin' : 'roller';  // pin-roller
    }

    // ── Beams + optional UDL loads ─────────────────────────────────
    const lcId = app.loadCases.length > 0 ? app.loadCases[0].id : 1;
    for (let i = 0; i < spans; i++) {
      const newBm = app.findBeam(app.addBeam(nodeIds[i], nodeIds[i + 1]));
      if (udl !== 0 && newBm) {
        app.loads.push({
          id: app.nextId.load++, type: 'beam_dist',
          elementId: newBm.id,  caseId: lcId,
          fy: udl, fy2: udl,   pos: 0
        });
      }
    }

    app.results = null;
    app.updateNodeTable(); app.updateBeamTable(); app.updateLoadTable();
    app.fitToScreen(); app.render();
    app.toast(
      `Generated ${spans}-span continuous beam${udl ? ` with ${udl} kN/m UDL` : ''}`, 'success'
    );
  }

  // ── generateSimpleBeam ────────────────────────────────────────────
  // A single span beam with a choice of supports and optional loads.
  function generateSimpleBeam(length, sup, udl, pointLoad, pointPos) {
    const app = sa();
    if (!length) { app.toast('Invalid beam length', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const nA = app.addNode(0, 0);
    const nB = app.addNode(length, 0);
    const A  = app.findNode(nA); const B = app.findNode(nB);
    if (sup === 'fixed-free')   { A.support = 'fixed'; B.support = 'none'; }
    else if (sup === 'fixed-fixed') { A.support = 'fixed'; B.support = 'fixed'; }
    else if (sup === 'fixed-roller'){ A.support = 'fixed'; B.support = 'roller'; }
    else                        { A.support = 'pin'; B.support = 'roller'; }
    const beamObj = app.findBeam(app.addBeam(nA, nB));
    const lcId = app.loadCases.length > 0 ? app.loadCases[0].id : 1;
    if (!beamObj) { app.toast('Failed to create beam', 'error'); return; }
    if (udl !== 0) app.loads.push({ id: app.nextId.load++, type: 'beam_dist', elementId: beamObj.id, caseId: lcId, fy: udl, fy2: udl, pos: 0 });
    if (pointLoad !== 0) app.loads.push({ id: app.nextId.load++, type: 'beam_point', elementId: beamObj.id, caseId: lcId, fy: pointLoad, pos: pointPos });
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable(); app.updateLoadTable();
    app.fitToScreen(); app.render();
    app.toast(`Generated simple beam L=${length}m`, 'success');
  }

  // ── generateBracedFrame ──────────────────────────────────────────
  // Moment frame with diagonal bracing members added.
  // braceType: 'x' | 'diagonal' | 'k' | 'v'
  function generateBracedFrame(bays, stories, bayW, storyH, sup, braceType) {
    const app = sa();
    if (!bays || !stories || !bayW || !storyH) { app.toast('Invalid parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const cols  = bays + 1;
    const grid  = [];
    for (let s = 0; s <= stories; s++) {
      grid[s] = [];
      for (let c = 0; c < cols; c++) grid[s][c] = app.addNode(c * bayW, s * storyH);
    }
    for (let c = 0; c < cols; c++) {
      const nd = app.findNode(grid[0][c]);
      if (!nd) continue;
      if (sup === 'roller') nd.support = c === 0 ? 'pin' : 'roller';
      else                  nd.support = sup;
    }
    for (let s = 0; s < stories; s++) for (let c = 0; c < cols; c++) app.addBeam(grid[s][c], grid[s+1][c]);
    for (let s = 1; s <= stories; s++) for (let c = 0; c < bays;  c++) app.addBeam(grid[s][c], grid[s][c+1]);
    // Bracing — apply to each bay × story panel
    for (let s = 0; s < stories; s++) {
      for (let c = 0; c < bays; c++) {
        const bl = grid[s][c], br = grid[s][c+1], tl = grid[s+1][c], tr = grid[s+1][c+1];
        if (braceType === 'x')        { app.addBeam(bl, tr); app.addBeam(br, tl); }
        else if (braceType === 'diagonal') app.addBeam(bl, tr);
        else if (braceType === 'k')   { const mid = app.addNode((c+0.5)*bayW, (s+0.5)*storyH); app.addBeam(bl,mid); app.addBeam(br,mid); app.addBeam(mid,tl); app.addBeam(mid,tr); }
        else if (braceType === 'v')   { const mid = app.addNode((c+0.5)*bayW, s*storyH); app.addBeam(bl,mid); app.addBeam(br,mid); app.addBeam(mid,tl); app.addBeam(mid,tr); }
      }
    }
    // Lift to Z-axis (columns vertical in 3D XZ view).
    //
    // Every node in the model, not just the grid: resetModel() cleared the
    // model at the top, so everything here belongs to this frame. Listing the
    // grid nodes by hand missed the apex node that K and V bracing add per
    // panel, and those were left behind at y = elevation, z = 0 while the
    // frame around them moved to y = 0, z = elevation. The result was not a
    // planar braced frame at all — on a 2-bay × 3-storey frame the apexes
    // stood 7.5 m out of the plane of a 9 m frame, so the braces ran sideways
    // out of the structure and carried nothing the bracing was meant to carry.
    liftToZ(app.nodes.map(function (n) { return n.id; }), app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(`Generated ${bays}-bay × ${stories}-story braced frame (${braceType})`, 'success');
  }

  // ── generateArch ─────────────────────────────────────────────────
  // Parabolic arch with N segments; pin-roller supports at base.
  function generateArch(span, rise, segments, type) {
    const app = sa();
    if (!span || !rise || segments < 3) { app.toast('Invalid arch parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const ids = [];
    for (let i = 0; i <= segments; i++) {
      const x = i * span / segments;
      let y;
      if (type === 'parabolic') {
        const t = x / span;
        y = 4 * rise * t * (1 - t);
      } else {    // circular
        const R = (span * span / 4 + rise * rise) / (2 * rise);
        const cx = span / 2, cy = -R + rise;
        y = Math.sqrt(Math.max(0, R * R - (x - cx) * (x - cx))) + cy;
      }
      ids.push(app.addNode(x, y));
    }
    app.findNode(ids[0]).support          = 'pin';
    app.findNode(ids[segments]).support   = 'roller';
    for (let i = 0; i < segments; i++) app.addBeam(ids[i], ids[i + 1]);
    // Lift to Z-axis — same reason as generateFrame/generateTruss: an arch's
    // rise belongs in Z (height) once the app is in 3D mode, not Y (depth).
    liftToZ(app.nodes.map(function (n) { return n.id; }), app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(`Generated ${type} arch L=${span}m, rise=${rise}m, ${segments} segments`, 'success');
  }

  // ── generateFloorGrid ─────────────────────────────────────────────
  // Rectangular grid of beams (floor framing / grillage).
  // All perimeter nodes along one edge get pin/roller supports if addSup=true.
  function generateFloorGrid(rows, cols, bayW, bayD, addSup) {
    const app = sa();
    if (!rows || !cols || !bayW || !bayD) { app.toast('Invalid grid parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const grid = [];
    for (let r = 0; r <= rows; r++) {
      grid[r] = [];
      for (let c = 0; c <= cols; c++) grid[r][c] = app.addNode(c * bayW, r * bayD);
    }
    if (addSup) {
      for (let c = 0; c <= cols; c++) app.findNode(grid[0][c]).support = c === 0 ? 'pin' : 'roller';
    }
    // X-beams (along columns direction)
    for (let r = 0; r <= rows; r++) for (let c = 0; c < cols;  c++) app.addBeam(grid[r][c], grid[r][c+1]);
    // Y-beams (along rows direction)
    for (let r = 0; r < rows;  r++) for (let c = 0; c <= cols; c++) app.addBeam(grid[r][c], grid[r+1][c]);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    app.fitToScreen(); app.render();
    app.toast(`Generated ${rows}×${cols} floor grid — ${app.nodes.length} nodes, ${app.beams.length} beams`, 'success');
  }

  // ── generateVierendeel ───────────────────────────────────────────
  // Vierendeel truss: rectangular panels, no diagonals.
  function generateVierendeel(panels, panelW, h, topSup) {
    const app = sa();
    if (!panels || !panelW || !h) { app.toast('Invalid parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const top = [], bot = [];
    for (let i = 0; i <= panels; i++) {
      top.push(app.addNode(i * panelW, h));
      bot.push(app.addNode(i * panelW, 0));
    }
    if (topSup) { app.findNode(top[0]).support = 'pin'; app.findNode(top[panels]).support = 'roller'; }
    else        { app.findNode(bot[0]).support = 'pin'; app.findNode(bot[panels]).support = 'roller'; }
    for (let i = 0; i < panels; i++) { app.addBeam(top[i], top[i+1]); app.addBeam(bot[i], bot[i+1]); }
    for (let i = 0; i <= panels; i++) app.addBeam(bot[i], top[i]);
    // Lift to Z-axis — same reason as generateFrame/generateTruss.
    liftToZ(app.nodes.map(function (n) { return n.id; }), app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(`Generated Vierendeel truss — ${panels} panels`, 'success');
  }

  // ── generateLeanTo ───────────────────────────────────────────────
  // Lean-to (mono-pitch shed) frame: columns of different heights + sloping roof.
  function generateLeanTo(bays, bayW, hLeft, hRight, sup) {
    const app = sa();
    if (!bays || !bayW || !hLeft || !hRight) { app.toast('Invalid parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const cols  = bays + 1;
    const baseY = 0;
    const nodeIds = [];
    // Base nodes (ground)
    for (let c = 0; c < cols; c++) nodeIds.push(app.addNode(c * bayW, baseY));
    // Supports at base
    for (let c = 0; c < cols; c++) {
      const nd = app.findNode(nodeIds[c]);
      if (sup === 'pin')    nd.support = 'pin';
      else if (sup === 'roller') nd.support = c === 0 ? 'pin' : 'roller';
      else nd.support = 'fixed';
    }
    // Top nodes (sloping ridge)
    const topIds = [];
    for (let c = 0; c < cols; c++) {
      const t = c / bays;
      const h = hLeft + (hRight - hLeft) * t;
      topIds.push(app.addNode(c * bayW, h));
    }
    // Columns
    for (let c = 0; c < cols; c++) app.addBeam(nodeIds[c], topIds[c]);
    // Roof beams
    for (let c = 0; c < bays;  c++) app.addBeam(topIds[c], topIds[c+1]);
    liftToZ([...nodeIds, ...topIds], app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(`Generated lean-to frame ${bays} bays, h: ${hLeft}m → ${hRight}m`, 'success');
  }

  // ── generateColumnLine ───────────────────────────────────────────
  // Vertical column stack with optional floor beams at each level.
  function generateColumnLine(colCount, spacing, height, addBeams) {
    const app = sa();
    if (!colCount || !spacing || !height) { app.toast('Invalid parameters', 'warn'); return; }
    app.snapshot();
    resetModel(app);   // template replaces the model, never appends
    const baseIds = [];
    for (let c = 0; c < colCount; c++) {
      baseIds.push(app.addNode(c * spacing, 0));
      app.findNode(baseIds[c]).support = 'fixed';
    }
    const topIds = [];
    for (let c = 0; c < colCount; c++) topIds.push(app.addNode(c * spacing, height));
    for (let c = 0; c < colCount; c++) app.addBeam(baseIds[c], topIds[c]);
    if (addBeams) for (let c = 0; c < colCount - 1; c++) app.addBeam(topIds[c], topIds[c+1]);
    liftToZ([...baseIds, ...topIds], app);
    app.results = null;
    app.updateNodeTable(); app.updateBeamTable();
    enable3DXZ(app);
    app.toast(`Generated ${colCount} column line, h=${height}m`, 'success');
  }

  // ── generateDefaultStructure ─────────────────────────────────────
  // 2-storey, 2-bay moment frame, ACI 318 sections, DL+LL+WL cases,
  // vertical (50 kN) + lateral loads, ACI 318 load combinations.
  function generateDefaultStructure() {
    const app = sa();
    app.snapshot();

    // Replace, don't append. This is a TEMPLATE — the button that calls it says
    // "Current work will be cleared" — but it used to add its geometry on top of
    // whatever was already there, so each use stacked another identical frame
    // (three clicks gave 27 nodes / 30 members / 54 loads, all overlapping).
    // Duplicate section definitions were accumulating the same way.
    app.nodes  = [];
    app.beams  = [];
    app.loads  = [];
    app.settlements = [];
    app.loadCases  = [];
    app.loadCombos = [];
    app.sections = app.sections.filter(function(s){
      return s.name !== 'Col 400×400' && s.name !== 'Beam 300×600';
    });
    app.results = null;
    app.selNode = null;
    app.selBeam = null;

    // ── 1. Sections (concrete) ─────────────────────────────────────
    // I values here were an order of magnitude too small (mm⁴→cm⁴ is ÷1e4, not
    // ÷1e5), which made every default member 10× too flexible and made the 3D
    // extruder — which back-solves depth from sqrt(12I/A) — draw a 400×400
    // column as a 1.26m × 0.13m slab. d and bf are supplied explicitly so the
    // renderer uses real dimensions instead of inferring them.
    // Columns 400×400: A = 1600 cm², I = 400⁴/12 = 2.133e9 mm⁴ = 213,333 cm⁴
    // `fy: 420` here is the REBAR grade. Both design codes used to read a
    // concrete section's f'c out of `fy`, so these two members were checked
    // as though the concrete were 420 MPa — which under EC2 produced a
    // negative squash load and an eta of 9 on every column. fck states the
    // concrete strength explicitly so neither code has to guess.
    const colSec = { id: app.allocSectionId(), name: 'Col 400×400', E: 25,
                     A: 1600, I: 213333, Ix: 213333, d: 400, bf: 400,
                     fck: 30, fy: 420, rho: 25 };
    // Beams 300×600: A = 1800 cm², I = 300×600³/12 = 5.4e9 mm⁴ = 540,000 cm⁴
    const bmSec  = { id: app.allocSectionId(), name: 'Beam 300×600', E: 25,
                     A: 1800, I: 540000, Ix: 540000, d: 600, bf: 300,
                     fck: 30, fy: 420, rho: 25 };
    app.sections.push(colSec, bmSec);

    // ── 2. Frame geometry (2 bays × 2 stories) ─────────────────────
    const bays = 2, stories = 2, bayW = 6, storyH = 3.5;
    const cols = bays + 1;
    const grid = [];
    for (let s = 0; s <= stories; s++) {
      grid[s] = [];
      for (let c = 0; c < cols; c++) {
        grid[s][c] = app.addNode(c * bayW, s * storyH);
      }
    }
    // Supports: pin at left column, roller at middle & right columns
    for (let c = 0; c < cols; c++) {
      const nd = app.findNode(grid[0][c]);
      if (nd) nd.support = c === 0 ? 'pin' : 'roller';
    }
    // Columns — assign column section
    for (let s = 0; s < stories; s++) {
      for (let c = 0; c < cols; c++) {
        const bm = app.findBeam(app.addBeam(grid[s][c], grid[s+1][c]));
        if (bm) { bm.sectionId = colSec.id; bm.memberType = 'column'; }
      }
    }
    // Beams — assign beam section
    for (let s = 1; s <= stories; s++) {
      for (let c = 0; c < bays; c++) {
        const bm = app.findBeam(app.addBeam(grid[s][c], grid[s][c+1]));
        if (bm) { bm.sectionId = bmSec.id; bm.memberType = 'beam'; }
      }
    }

    // ── 3. Load cases ─────────────────────────────────────────────
    app.loadCases.length = 0; // clear default single DL case
    const lcDL = { id: app.nextId.lcase++, name: 'Dead (DL)',  type: 'DL', color: '#1565C0' };
    const lcLL = { id: app.nextId.lcase++, name: 'Live (LL)',  type: 'LL', color: '#2e7d32' };
    const lcWL = { id: app.nextId.lcase++, name: 'Wind (WL)',  type: 'WL', color: '#e65100' };
    app.loadCases.push(lcDL, lcLL, lcWL);

    // ── 4. Vertical loads (positive = downward in this app) ───────
    // DL = 8.33 kN/m (≈ 50 kN / 6 m span), LL = 5 kN/m on all beams
    const beamMembers = app.beams.filter(b => b.memberType === 'beam');
    beamMembers.forEach(bm => {
      // Dead load UDL — positive downward
      app.loads.push({ id: app.nextId.load++, type: 'beam_dist',
        elementId: bm.id, caseId: lcDL.id, fy: 8.33, fy2: 8.33, pos: 0 });
      // Live load UDL — positive downward
      app.loads.push({ id: app.nextId.load++, type: 'beam_dist',
        elementId: bm.id, caseId: lcLL.id, fy: 5.0, fy2: 5.0, pos: 0 });
    });

    // ── 5. Horizontal wind loads at each story level ──────────────
    // Triangular wind profile: Story 1 = 20 kN, Story 2 = 35 kN (positive = rightward)
    // Applied as nodal Fx at the LEFT column node of each storey
    const windFx = [20, 35]; // kN, increasing with height
    for (let s = 1; s <= stories; s++) {
      const nid = grid[s][0]; // left column node at each storey
      // 'nodal' is the type every solver matches on (solver.js, solver3d.js,
      // pdelta.js). Emitting 'node' meant these wind loads were silently
      // dropped from the load vector and the wind case produced no response.
      app.loads.push({ id: app.nextId.load++, type: 'nodal',
        nodeId: nid, caseId: lcWL.id, fx: windFx[s - 1] || 0, fy: 0 });
    }

    // ── 6. ACI 318-19 Load Combinations ──────────────────────────
    const dl = lcDL.id, ll = lcLL.id, wl = lcWL.id;
    // Factors MUST use { caseId, factor }. That is the shape every consumer
    // expects — combineCaseResults, the combo dialog, the results table and the
    // report all read those names. These were written as { id, f }, so
    // combineCaseResults destructured undefined, skipped every term, and each
    // combination was silently dropped: the model solved its 3 cases and
    // produced 0 of its 5 ACI combinations.
    const combos = [
      { name:'1.4D',              factors:[{caseId:dl,factor:1.4}] },
      { name:'1.2D + 1.6L',       factors:[{caseId:dl,factor:1.2},{caseId:ll,factor:1.6}] },
      { name:'1.2D + 1.0W + L',   factors:[{caseId:dl,factor:1.2},{caseId:wl,factor:1.0},{caseId:ll,factor:1.0}] },
      { name:'0.9D + 1.0W',       factors:[{caseId:dl,factor:0.9},{caseId:wl,factor:1.0}] },
      { name:'1.2D + 1.6L (env)', factors:[{caseId:dl,factor:1.2},{caseId:ll,factor:1.6}] },
    ];
    combos.forEach(cb => {
      app.loadCombos.push({ id: app.nextId.combo++, name: cb.name, factors: cb.factors });
    });

    // ── 7. Lift all nodes to Z-axis (columns vertical in 3D XZ view) ─
    // nd.z = storey height, nd.y = 0 → frame lies in the XZ plane
    const allIds = app.nodes.map(n => n.id);
    liftToZ(allIds, app);

    app.results = null;
    app.updateNodeTable(); app.updateBeamTable(); app.updateLoadTable(); app.updateSectionTable();
    // This function replaces loadCases wholesale, so the panes listing them
    // must be rebuilt too. Without this the Loads-pane case filter still
    // offered the previous ids and silently fell back to "no filter".
    app.updateCasesPane && app.updateCasesPane();
    app.populateDisplaySelector && app.populateDisplaySelector();

    // Auto-switch to 3D mode + XZ front elevation
    enable3DXZ(app);

    app.toast('Default 2-storey frame loaded (XZ axis) — ACI 318-19 · DL+LL+WL · 5 combos', 'ok');
  }

  return {
    generateFrame, generateTruss, generateContinuousBeam,
    generateSimpleBeam, generateBracedFrame, generateArch,
    generateFloorGrid, generateVierendeel, generateLeanTo, generateColumnLine,
    generateDefaultStructure
  };
})();
