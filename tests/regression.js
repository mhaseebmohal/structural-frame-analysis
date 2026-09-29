// ══════════════════════════════════════════════════════════════════════════════
//  Solver regression harness  —  run with:  npm test   (or: node tests/regression.js)
//
//  The analysis modules are plain browser scripts with no exports, so each is
//  evaluated into a shared VM context exactly the way index.html loads them.
//  No DOM is touched by solver.js / solver3d.js / pdelta.js / modes.js, so they
//  run unmodified under Node.
//
//  The checks here are statics, not golden numbers: global equilibrium, the
//  agreement between the linear and second-order paths, and the error paths for
//  unstable models. Those are the invariants that were actually broken, and
//  they stay meaningful when section properties or tolerances change.
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const ctx = {
  console, Math, JSON, Number, Date, isFinite, parseFloat, parseInt,
  Float64Array, Array, Object, Set, Map, Infinity, NaN,
  // The design modules test section names with regexes and build note strings.
  String, Boolean, RegExp,
};
vm.createContext(ctx);
// pdelta.js and modes.js publish their namespace with `const X = (() => …)()`
// plus a guarded `window.X = X`. A top-level const is a lexical binding, not a
// property of the global object, so the `window` alias is the only way to reach
// them from outside the script — same as in the browser.
ctx.window = ctx;

for (const f of ['js/solver.js', 'js/solver3d.js', 'js/analysis/pdelta.js',
                 'js/analysis/modes.js', 'js/analysis/spectrum.js', 'js/db/indexeddb.js',
                 // The design modules touch no DOM either, and the axial sign
                 // convention they share with the solver is worth asserting.
                 'js/design/checks.js', 'js/design/aci_checks.js',
                 'js/design/rc_design.js', 'js/design/foundation.js',
                 'js/calc/beam_formulas.js', 'js/calc/pm_interaction.js',
                 'js/calc/mohrs_circle.js', 'js/calc/natural_freq.js',
                 'js/io/fileio.js', 'js/report/report.js', 'js/design/sections.js',
                 // Also pure logic, no DOM — previously never loaded here at all,
                 // so its ASCE7/EC0 combo generation had zero regression coverage.
                 'js/design/load_combos_generator.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { solveFrame, solveFrame3D, PDeltaAnalysis, ModeShapeAnalysis, ResponseSpectrum, StructDB,
        DesignChecks, ACIDesign, RCDesign, FoundationDesign, BeamFormulas,
        PMInteraction, MohrsCircle, NaturalFreq, FileIO, ReportGenerator,
        SectionDB, LoadCombosGenerator,
        // Resolves a member stiffness modifier, falling back to its section.
        stiffMod } = ctx;

// ── Tiny assertion helpers ────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else    { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function near(name, actual, expected, tol) {
  const a = Number(actual);
  const ok = Number.isFinite(a) && Math.abs(a - expected) <= tol;
  check(name, ok, ok ? '' : `expected ${expected} +/- ${tol}, got ${actual}`);
}
function group(title) { console.log(`\n${title}`); }

// Every group below is a plain top-level block, not a function this harness
// calls — there was nothing catching a thrown error (as opposed to a normal
// check() failure) partway through, so one bug in a test or in the code it
// exercises silently voided every group after it: the run ended in a raw
// stack trace instead of the usual pass/fail summary, and with no CI gating
// this file, a single crash could mask regressions across a large fraction
// of the suite with no clear signal they were skipped.
//
// Wrapping every one of the ~120 groups individually (so a crash in one
// still lets the rest run) would need a real per-group try/catch at each
// call site — this file is ~7500 lines and machine-editing that many
// boundaries by hand risks silently misattributing checks between adjacent
// groups in a way a passing check-count would not reveal. This wraps the
// whole run instead: still a hard stop on a real crash, but the report below
// says how far it got and what killed it, rather than leaving that to
// whatever Node happens to print.
try {

// ── Fixtures ──────────────────────────────────────────────────────────────────
const SEC = [{ id: 1, name: 'test', E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];

// Portal frame: two 4 m columns, one 6 m beam, both bases fixed.
function portal() {
  return {
    nodes: [
      { id: 1, x: 0, y: 0, support: 'fixed' },
      { id: 2, x: 0, y: 4, support: 'none'  },
      { id: 3, x: 6, y: 4, support: 'none'  },
      { id: 4, x: 6, y: 0, support: 'fixed' },
    ],
    beams: [
      { id: 1, node1: 1, node2: 2, sectionId: 1 },
      { id: 2, node1: 2, node2: 3, sectionId: 1 },
      { id: 3, node1: 3, node2: 4, sectionId: 1 },
    ],
  };
}
const sumR = (res, key) => Object.values(res.reactions).reduce((s, r) => s + (r[key] || 0), 0);

// ══════════════════════════════════════════════════════════════════════════════
group('2D linear solver — global equilibrium');
{
  const { nodes, beams } = portal();

  // Vertical UDL on the beam: 10 kN/m over 6 m = 60 kN down.
  const r1 = solveFrame(nodes, beams, SEC, [{ type: 'beam_dist', elementId: 2, fy: -10 }], []);
  near('UDL on beam: sum(Ry) balances applied load', sumR(r1, 'Ry'), 60, 1e-6);

  // Horizontal UDL on a column — the load lands directly on a supported node,
  // which is the case that exposed the missing fixed-end-force term.
  const r2 = solveFrame(nodes, beams, SEC, [{ type: 'beam_dist', elementId: 1, fx: 5 }], []);
  near('wind on column: sum(Rx) balances applied load', sumR(r2, 'Rx'), -20, 1e-4);

  // Trapezoidal 10 -> 20 kN/m over 6 m = 90 kN.
  const r3 = solveFrame(nodes, beams, SEC, [{ type: 'beam_trap', elementId: 2, fy: -10, fy2: -20 }], []);
  near('trapezoidal load: sum(Ry) balances applied load', sumR(r3, 'Ry'), 90, 1e-4);

  // Point load at mid-span.
  const r4 = solveFrame(nodes, beams, SEC, [{ type: 'beam_point', elementId: 2, fy: -50, pos: 3 }], []);
  near('point load: sum(Ry) balances applied load', sumR(r4, 'Ry'), 50, 1e-6);
}

group('2D linear solver — support handling');
{
  const { beams } = portal();
  const springs = [
    { id: 1, x: 0, y: 0, support: 'spring', springKx: 1e6, springKy: 1e6, springKm: 1e6 },
    { id: 2, x: 0, y: 4, support: 'none' },
    { id: 3, x: 6, y: 4, support: 'none' },
    { id: 4, x: 6, y: 0, support: 'spring', springKx: 1e6, springKy: 1e6, springKm: 1e6 },
  ];
  const r = solveFrame(springs, beams, SEC, [{ type: 'beam_dist', elementId: 2, fy: -10 }], []);
  check('spring-only supports solve instead of reporting a mechanism', !!r.success, r.error);

  // A genuinely unsupported model must still be rejected.
  const free = portal().nodes.map(n => ({ ...n, support: 'none' }));
  const rf = solveFrame(free, beams, SEC, [{ type: 'beam_dist', elementId: 2, fy: -10 }], []);
  check('unsupported 2D model is rejected', !!rf.error, `got success=${rf.success}`);
}

group('3D solver — reactions include member fixed-end forces');
{
  // Fixed-fixed beam, 6 m, 10 kN/m down. Each end takes 30 kN and 30 kNm.
  const nodes = [
    { id: 1, x: 0, y: 0, z: 0, support: 'fixed' },
    { id: 2, x: 6, y: 0, z: 0, support: 'fixed' },
  ];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const r = solveFrame3D(nodes, beams, SEC, [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
  check('3D solve succeeds', !!r.success, r.error);
  near('3D Rz at node 1', r.reactions[1].Rz, 30, 1e-3);
  near('3D Rz at node 2', r.reactions[2].Rz, 30, 1e-3);
  near('3D sum(Rz) balances applied load', sumR(r, 'Rz'), 60, 1e-3);
  near('3D fixed-end moment magnitude', Math.abs(r.reactions[1].My), 30, 1e-2);

  // Point load variant.
  const rp = solveFrame3D(nodes, beams, SEC, [{ type: 'beam_point', elementId: 1, fy: -50, pos: 0.5 }], []);
  near('3D point load: sum(Rz) balances applied load', sumR(rp, 'Rz'), 50, 1e-3);
}

group('3D solver — singular models are reported, not silently solved');
{
  const free  = [{ id: 1, x: 0, y: 0, z: 0, support: 'none' },
                 { id: 2, x: 6, y: 0, z: 0, support: 'none' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const r = solveFrame3D(free, beams, SEC, [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
  check('unsupported 3D model returns an error', !!r.error, `got success=${r.success}`);

  const huge = r.disp && Object.values(r.disp).some(d =>
    Object.values(d).some(v => Math.abs(v) > 1e6));
  check('unsupported 3D model does not return runaway displacements', !huge);
}

group('P-Delta — agrees with the linear solve and stays in equilibrium');
{
  const { nodes, beams } = portal();

  // Horizontal UDL on a column: previously NaN, because the fixed-end forces
  // were applied without projecting the load onto the member axes.
  const loadsW = [{ type: 'beam_dist', elementId: 1, fx: 5 }];
  const lin = solveFrame(nodes, beams, SEC, loadsW, []);
  const pd  = PDeltaAnalysis.runPDelta(nodes, beams, SEC, loadsW, []);
  check('P-Delta converges', !!pd.success && pd.converged !== false, pd.error || pd.warning);
  check('P-Delta member forces are finite', Number.isFinite(pd.elemForces[0].M1),
        `M1 = ${pd.elemForces[0].M1}`);
  near('P-Delta column M1 tracks the linear result', pd.elemForces[0].M1, lin.elemForces[0].M1, 0.5);
  near('P-Delta sum(Rx) balances applied load', sumR(pd, 'Rx'), -20, 1e-2);

  // Trapezoidal load — dropped entirely by the old end-force routine.
  const loadsT = [{ type: 'beam_trap', elementId: 2, fy: -10, fy2: -20 }];
  const linT = solveFrame(nodes, beams, SEC, loadsT, []);
  const pdT  = PDeltaAnalysis.runPDelta(nodes, beams, SEC, loadsT, []);
  near('P-Delta trapezoidal M1 tracks the linear result',
       pdT.elemForces[1].M1, linT.elemForces[1].M1, 0.5);
  near('P-Delta trapezoidal sum(Ry) balances applied load', sumR(pdT, 'Ry'), 90, 1e-2);

  // Second-order effects must amplify, never stiffen — and the amplification
  // must grow with gravity load. Getting this backwards is unconservative and
  // is exactly what a sign error in the geometric stiffness looks like.
  const sway = mult => {
    const lds = [{ type: 'beam_dist', elementId: 2, fy: -40 * mult },
                 { type: 'nodal', nodeId: 2, fx: 30 }];
    const l = solveFrame(nodes, beams, SEC, lds, []);
    const p = PDeltaAnalysis.runPDelta(nodes, beams, SEC, lds, []);
    return Math.abs(p.disp[2].u) / Math.abs(l.disp[2].u);
  };
  const amp1 = sway(1), amp4 = sway(4), amp8 = sway(8);
  check('P-Delta sway >= linear sway (second-order amplifies)',
        amp1 >= 1 - 1e-9, `amplification = ${amp1.toFixed(5)}`);
  check('P-Delta amplification grows with gravity load',
        amp8 > amp4 && amp4 > amp1,
        `1x ${amp1.toFixed(4)}, 4x ${amp4.toFixed(4)}, 8x ${amp8.toFixed(4)}`);
}

group('P-Delta — buckling risk');
{
  const { nodes, beams } = portal();
  const lds = [{ type: 'beam_dist', elementId: 2, fy: -100 }];
  const res = solveFrame(nodes, beams, SEC, lds, []);
  const cf  = PDeltaAnalysis.criticalLoadFactors(res.elemForces, beams, SEC);
  const col = cf.find(c => c.beamId === 1);
  check('compressed column reports non-zero compression',
        !!col && col.N_comp > 0, col ? `N_comp = ${col.N_comp}` : 'column missing');
  check('compressed column reports a finite critical load factor',
        !!col && Number.isFinite(col.lambda_cr) && col.lambda_cr < 999,
        col ? `lambda_cr = ${col.lambda_cr}` : 'column missing');
}

group('P-Delta — sections carrying only Ix');
{
  const { nodes, beams } = portal();
  const ixOnly = [{ id: 1, E: 210, A: 100, Ix: 20000 }];   // no `I` key at all
  const pd = PDeltaAnalysis.runPDelta(nodes, beams, ixOnly,
                                      [{ type: 'beam_dist', elementId: 2, fy: -10 }], []);
  check('Ix-only section does not produce NaN displacements',
        !!pd.success && Number.isFinite(pd.disp[2].v), `v = ${pd.disp && pd.disp[2] && pd.disp[2].v}`);
  near('Ix-only section: sum(Ry) balances applied load', sumR(pd, 'Ry'), 60, 1e-2);
}

group('Mode shapes');
{
  const { nodes, beams } = portal();
  const m = ModeShapeAnalysis.computeModes(nodes, beams, SEC, 3);
  check('modes computed', !m.error && m.modes && m.modes.length > 0, m.error);
  if (m.modes && m.modes.length) {
    check('frequencies are finite and ascending',
          m.modes.every(md => Number.isFinite(md.freq) && md.freq > 0) &&
          m.modes.every((md, i) => i === 0 || md.freq >= m.modes[i - 1].freq - 1e-9),
          m.modes.map(md => md.freq.toFixed(3)).join(', '));
    check('mode numbers are sequential with no gaps',
          m.modes.every((md, i) => md.modeNum === i + 1),
          m.modes.map(md => md.modeNum).join(', '));
  }

  // Spring supports carry stiffness rather than constraining a DOF. Without
  // that stiffness in K the frame has rigid-body modes near 0 Hz, and the
  // fundamental frequency collapses toward zero.
  const springNodes = portal().nodes.map(n =>
    n.support === 'fixed'
      ? { ...n, support: 'spring', springKx: 1e7, springKy: 1e7, springKm: 1e7 }
      : n);
  const ms = ModeShapeAnalysis.computeModes(springNodes, beams, SEC, 3);
  check('spring-supported model produces modes', !ms.error && ms.modes.length > 0, ms.error);
  if (ms.modes && ms.modes.length && m.modes && m.modes.length) {
    // Springs are softer than a rigid base, so f1 should sit below the fixed-base
    // value — but well clear of the ~0 Hz rigid-body mode of an unrestrained frame.
    const f1s = ms.modes[0].freq, f1f = m.modes[0].freq;
    check('spring-supported f1 is a real structural mode, not rigid-body',
          f1s > 0.1 && f1s <= f1f + 1e-6,
          `spring f1 = ${f1s.toFixed(4)} Hz vs fixed-base f1 = ${f1f.toFixed(4)} Hz`);
  }
}

group('Member deflection vs closed-form solutions');
{
  // A stiffness solution knows displacements at the NODES only. The shape
  // between them is the Hermite interpolation of the end DOFs PLUS the
  // fixed-end deflection under the span load. Dropping the second term made a
  // simply-supported member read zero sag, because both its end nodes sit on
  // supports — so the deflection check could never fail. These pin the recovery
  // against textbook results rather than against the previous behaviour.
  const E = 210, Icm4 = 20000;
  const S = [{ id: 1, E, A: 100, I: Icm4, Ix: Icm4 }];
  const EI = E * 1e6 * (Icm4 / 1e8);          // kN·m²
  const L = 8;
  const efOf = (r, id) => r.elemForces.find(e => e.id === id);
  const peak = (ef, lds) => Math.abs(ctx.maxDeflLocal2D(ef, lds, EI, 201).v);
  const rel  = (got, exact) => Math.abs(got / exact - 1);

  {   // Simply supported + UDL → 5wL⁴/384EI
    const w = 20;
    const r = solveFrame(
      [{id:1,x:0,y:0,support:'pin'},{id:2,x:L,y:0,support:'roller'}],
      [{id:1,node1:1,node2:2,sectionId:1}], S,
      [{type:'beam_dist',elementId:1,fy:-w}], []);
    const lds = [{type:'beam_dist',elementId:1,fy:-w}];
    check('SS + UDL matches 5wL^4/384EI',
          rel(peak(efOf(r,1), lds), 5*w*L**4/(384*EI)) < 0.015);
  }
  {   // Simply supported + central point load → PL³/48EI
    const P = 50;
    const lds = [{type:'beam_point',elementId:1,fy:-P,pos:L/2}];
    const r = solveFrame(
      [{id:1,x:0,y:0,support:'pin'},{id:2,x:L,y:0,support:'roller'}],
      [{id:1,node1:1,node2:2,sectionId:1}], S, lds, []);
    check('SS + central point load matches PL^3/48EI',
          rel(peak(efOf(r,1), lds), P*L**3/(48*EI)) < 0.015);
  }
  {   // Fixed-fixed + UDL → wL⁴/384EI
    const w = 20;
    const lds = [{type:'beam_dist',elementId:1,fy:-w},{type:'beam_dist',elementId:2,fy:-w}];
    const r = solveFrame(
      [{id:1,x:0,y:0,support:'fixed'},{id:2,x:L/2,y:0},{id:3,x:L,y:0,support:'fixed'}],
      [{id:1,node1:1,node2:2,sectionId:1},{id:2,node1:2,node2:3,sectionId:1}], S, lds, []);
    check('fixed-fixed + UDL matches wL^4/384EI',
          rel(Math.max(peak(efOf(r,1),lds), peak(efOf(r,2),lds)), w*L**4/(384*EI)) < 0.015);
  }
  {   // Simply supported + triangular load → 0.006522 wL⁴/EI
    const w = 20;
    const lds = [{type:'beam_trap',elementId:1,fy:0,fy2:-w}];
    const r = solveFrame(
      [{id:1,x:0,y:0,support:'pin'},{id:2,x:L,y:0,support:'roller'}],
      [{id:1,node1:1,node2:2,sectionId:1}], S, lds, []);
    check('SS + triangular load matches 0.006522wL^4/EI',
          rel(peak(efOf(r,1), lds), 0.0065222*w*L**4/EI) < 0.015);
  }

  // The check itself must now fail a genuinely over-deflecting member.
  {
    const dctx = { console, Math, JSON, Number, Array, Object, isFinite, NaN };
    vm.createContext(dctx); dctx.window = dctx;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/solver.js'), 'utf8'), dctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/design/checks.js'), 'utf8'), dctx);
    const w = 20;
    const lds = [{type:'beam_dist',elementId:1,fy:-w}];
    const r = dctx.solveFrame(
      [{id:1,x:0,y:0,support:'pin'},{id:2,x:L,y:0,support:'roller'}],
      [{id:1,node1:1,node2:2,sectionId:1}], S, lds, []);
    const ef = r.elemForces[0];
    const d  = dctx.DesignChecks.deflectionCheck(ef, L, 'floor', S[0]);
    check('deflection check reports a non-zero peak', d.v_max_mm > 1,
          `reported ${d.v_max_mm} mm`);
    check('deflection check FAILS a member over its L/360 limit',
          d.status === 'FAIL' && !d.pass,
          `status=${d.status}, eta=${d.eta}, v=${d.v_max_mm}mm, limit=${d.limit_mm}mm`);
    // And still passes an adequately stiff one.
    const stiff = [{ id: 1, E, A: 100, I: Icm4 * 40, Ix: Icm4 * 40 }];
    const r2 = dctx.solveFrame(
      [{id:1,x:0,y:0,support:'pin'},{id:2,x:L,y:0,support:'roller'}],
      [{id:1,node1:1,node2:2,sectionId:1}], stiff, lds, []);
    const d2 = dctx.DesignChecks.deflectionCheck(r2.elemForces[0], L, 'floor', stiff[0]);
    check('deflection check PASSES an adequately stiff member',
          d2.pass && d2.status === 'OK', `status=${d2.status}, v=${d2.v_max_mm}mm`);
  }
}

group('Solver routing — isPlanarModel()');
{
  // app.js is one large IIFE that needs a DOM, so the predicate is extracted
  // and bound to its two closure variables rather than loaded wholesale.
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const m = appSrc.match(/function isPlanarModel\(\)\s*\{[\s\S]*?\n  \}/);
  check('isPlanarModel is extractable from app.js', !!m,
        'the function moved or was renamed — this group is no longer testing it');

  if (m) {
    // eslint-disable-next-line no-new-func
    const planar = new Function('nodes', 'loads', m[0] + '\nreturn isPlanarModel();');
    const cases = [
      ['Z-lifted frame routes to the 2D solver',
       [{x:0,y:0,z:0},{x:6,y:0,z:0},{x:0,y:0,z:3.5},{x:6,y:0,z:3.5}], [], true],
      ['classic X-Y frame routes to the 2D solver',
       [{x:0,y:0,z:0},{x:6,y:0,z:0},{x:0,y:4,z:0},{x:6,y:4,z:0}], [], true],
      ['a genuinely 3D model routes to the 3D solver',
       [{x:0,y:0,z:0},{x:6,y:0,z:0},{x:0,y:4,z:0},{x:0,y:0,z:3}], [], false],
      // Flat geometry alone must not decide it — a grillage is flat but 3D.
      ['flat grillage with an out-of-plane load routes to the 3D solver',
       [{x:0,y:0,z:0},{x:4,y:0,z:0},{x:0,y:4,z:0}], [{type:'nodal',nodeId:1,fz:-50}], false],
      ['flat grid with in-plane loads only stays 2D',
       [{x:0,y:0,z:0},{x:4,y:0,z:0},{x:0,y:4,z:0}], [{type:'nodal',nodeId:1,fy:-50}], true],
      ['an out-of-plane moment routes to the 3D solver',
       [{x:0,y:0,z:0},{x:4,y:0,z:0}], [{type:'moment',nodeId:1,mx:10}], false],
      ['a custom 3D DOF mask routes to the 3D solver',
       [{x:0,y:0,z:0},{x:4,y:0,z:0,fixedDOF:[1,1,1,0,0,0]}], [], false],
      ['a single node is planar', [{x:0,y:0,z:0}], [], true],
    ];
    for (const [name, nds, lds, expect] of cases) {
      check(name, planar(nds, lds) === expect, `got ${planar(nds, lds)}, expected ${expect}`);
    }
  }
}

group('EC3 design checks');
{
  const dcSrc = fs.readFileSync(path.join(ROOT, 'js/design/checks.js'), 'utf8')
    // Widen the IIFE's export list to reach the two internal curve helpers.
    .replace(/\n(\s*)flexuralCheck,/, '\n$1bucklingCurveY, bucklingCurveZ,\n$1flexuralCheck,');
  const dctx = { console, Math, JSON, Number, Array, Object, isFinite, NaN };
  vm.createContext(dctx); dctx.window = dctx;
  vm.runInContext(dcSrc, dctx, { filename: 'checks.js' });
  const DC = dctx.DesignChecks;

  // EC3 Table 6.2, rolled I-sections. tf is compared in cm inside the lookup.
  const curves = [
    [400, 200,  20, 'a', 'b'],   // h/b > 1.2, tf <= 40 mm
    [400, 200,  60, 'b', 'c'],   // h/b > 1.2, 40 < tf <= 100
    [400, 200, 120, 'd', 'd'],   // tf > 100 mm
    [200, 200,  20, 'b', 'c'],   // h/b <= 1.2, tf <= 100
    [200, 200, 120, 'd', 'd'],   // tf > 100 mm
  ];
  for (const [d, bf, tf, ey, ez] of curves) {
    const y = DC.bucklingCurveY({ d, bf, tf }), z = DC.bucklingCurveZ({ d, bf, tf });
    check(`buckling curve h/b=${(d/bf).toFixed(1)} tf=${tf}mm`, y === ey && z === ez,
          `got y=${y} z=${z}, expected y=${ey} z=${ez}`);
  }

  // A section with no flange/web data cannot be claimed as Class 1/2, so the
  // flexural check must fall back to the elastic modulus, not the plastic one.
  const ef = { M1: 50, M2: -30, N1: 0, N2: 0, V1: 10, V2: 10, L: 6, loads: [] };
  const noPlate = { E: 25, A: 1600, I: 213333, Ix: 213333, fy: 420,
                    d: 400, bf: 400, Zx: 2000, Sx: 1200 };
  const fl = DC.flexuralCheck(ef, noPlate, 6);
  near('unclassified section uses the elastic modulus', fl.Mc_Rd, 1200e-6 * 420e3, 1);
  check('unclassified section is labelled as such',
        /unclassified/.test(fl.modulus_label || ''), fl.modulus_label);
}

group('ACI 318-19 checks');
{
  const actx = { console, Math, JSON, Number, Array, Object, isFinite, Infinity, NaN };
  vm.createContext(actx); actx.window = actx;
  for (const f of ['js/design/aci_checks.js', 'js/aci/ch5-development.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), actx, { filename: f });
  }
  const ACI = actx.ACIDesign, Ch5 = actx.ACI_Ch5;

  // ── Development length, ACI 318M-19 Table 25.4.2.3a ──────────────────────
  // #8 bar (db = 25 mm), f'c = 30 MPa, fy = 420 MPa, (cb+Ktr)/db = 1.5, all ψ = 1.
  // Cross-checked against the inch-pound form evaluated in psi: 1154 mm.
  // A coefficient from the wrong unit system yields ~96 mm, which the 300 mm
  // floor then disguises — so assert the real value, not merely "> 300".
  const dl = ACI.developmentLength(25, 30, 420, { confine: 1.5 });
  near('tension development length matches the SI equation', dl.ld_mm, 1162, 15);
  check('development length is not sitting on the 300 mm floor', dl.ld_mm > 400,
        `ld = ${dl.ld_mm} mm`);
  near('Class B lap splice is 1.3 x ld', dl.lap_B_mm, dl.ld_mm * 1.3, 2);

  const ld5 = Ch5.ld_tension(25, 420, 30);
  near('chapter-5 module agrees with the design module', ld5, dl.ld_mm, 15);

  // Smaller bars get ψs = 0.8, so ld must scale below the linear-in-db line.
  const dl4 = ACI.developmentLength(12, 30, 420, { confine: 1.5 });
  check('psi_s reduces development length for small bars',
        dl4.ld_mm < dl.ld_mm * (12 / 25), `ld(12mm) = ${dl4.ld_mm}`);

  // ── Column φ must track the strain state, not sit at one value ───────────
  const colPhi = (N, M) => ACI.columnCheck(N, M, 0.4, 0.4, 30, 420, 1600, true).phi_col;
  near('lightly loaded column is tension-controlled (phi = 0.90)', colPhi(100, 120), 0.90, 1e-6);
  near('heavily loaded column is compression-controlled (phi = 0.65)', colPhi(2500, 20), 0.65, 1e-6);
  check('column phi varies with axial load', colPhi(100, 120) !== colPhi(2500, 20));

  // ── Neutral-axis depth uses beta1, not a magic divisor ──────────────────
  // Softening f'c lowers beta1 (0.85 -> 0.65), which raises c and lowers eps_t.
  // A fixed divisor would leave phiMn0 insensitive to that.
  const m30 = ACI.columnCheck(0, 50, 0.4, 0.4, 30, 420, 1600, true).phiMn0_kNm;
  const m70 = ACI.columnCheck(0, 50, 0.4, 0.4, 70, 420, 1600, true).phiMn0_kNm;
  check('phiMn0 responds to beta1 changing with f\'c', m30 !== m70,
        `f'c=30 -> ${m30}, f'c=70 -> ${m70}`);

  // ── Flexure sanity: capacity rises with effective depth ─────────────────
  const f1 = ACI.flexureBeam(200, 0.3, 0.45, 30, 420);
  const f2 = ACI.flexureBeam(200, 0.3, 0.60, 30, 420);
  check('deeper beam needs less steel for the same moment',
        f2.As_req_mm2 < f1.As_req_mm2, `${f1.As_req_mm2} vs ${f2.As_req_mm2}`);
  check('beta1 follows ACI 22.2.2.4.3 (0.85 at 28 MPa, floor 0.65)',
        Math.abs(ACI.flexureBeam(10, .3, .5, 28, 420).beta1 - 0.85) < 1e-9 &&
        Math.abs(ACI.flexureBeam(10, .3, .5, 90, 420).beta1 - 0.65) < 1e-9);
}

group('Pad foundation (EC2 / EC7)');
{
  const fctx = { console, Math, JSON, Number, Array, Object, isFinite, Infinity, NaN };
  vm.createContext(fctx); fctx.window = fctx;
  for (const f of ['js/design/rc_design.js', 'js/design/foundation.js',
                 'js/calc/beam_formulas.js', 'js/calc/pm_interaction.js',
                 'js/calc/mohrs_circle.js', 'js/calc/natural_freq.js',
                 'js/io/fileio.js', 'js/report/report.js', 'js/design/sections.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), fctx, { filename: f });
  }
  const FD = fctx.FoundationDesign;

  // Eccentric footing: L = 3 m, column 0.4 m, ULS pressure 200 -> 40 kPa.
  const L = 3, colL = 0.4, qmax = 200, qmin = 40;
  const lc = (L - colL) / 2, slope = (qmax - qmin) / L;
  const qFace = qmax - slope * lc;

  const dm = FD.designMoment(qmax, qmin, L, colL);
  // Exact cantilever moment for a linearly varying pressure.
  near('design moment integrates the pressure over the critical cantilever',
       dm.M_Ed_pm, (lc * lc / 6) * (2 * qmax + qFace), 0.05);
  check('design moment exceeds the whole-footing-average value it used to give',
        dm.M_Ed_pm > ((qmax + qmin) / 2) * lc * lc / 2,
        `${dm.M_Ed_pm} vs ${(((qmax + qmin) / 2) * lc * lc / 2).toFixed(2)}`);
  // Concentric footing: both formulations must agree exactly.
  const dmC = FD.designMoment(150, 150, L, colL);
  near('concentric footing is unaffected', dmC.M_Ed_pm, 150 * lc * lc / 2, 0.01);

  // Transverse shear — critical section measured from the qmax edge.
  const d_eff = 0.44, lv = Math.max(0, lc - d_eff);
  const ts = FD.transverseShear(qmax, qmin, L, colL, 2, d_eff, 25, 500, 1000);
  near('transverse shear uses the pressure at the critical section',
       ts.V_Ed_pm, ((qmax + (qmax - slope * lv)) / 2) * lv, 0.05);
  // VRd,c is a stress (MPa) turned into kN per metre of width: v * b * d.
  // Dropping the 1000 mm width term leaves it ~1000x low, which fails every
  // footing. Pin the magnitude, not just the sign.
  check('VRd,c is a per-metre resistance of the right order (10s-100s kN/m)',
        ts.VRdc_pm > 50 && ts.VRdc_pm < 1000, `VRdc = ${ts.VRdc_pm} kN/m`);
  near('VRd,c equals vRd_c * d * 1000',
       ts.VRdc_pm, 0.035 * Math.pow(Math.min(1 + Math.sqrt(200 / (d_eff * 1000)), 2), 1.5)
                   * Math.sqrt(25) * d_eff * 1000, 60);

  // Punching shear — rho must be As/(1000·d), so it stays well under the cap.
  const ps = FD.punchingShear(1200, 0.4, 0.4, 0.44, 25, 500, 1000, 1000, 0, 0);
  near('punching rho_1 = As/(1000*d)', ps.rho_1, 1000 / (1000 * 440), 1e-6);
  check('punching rho_1 is not pinned at the 0.02 cap', ps.rho_1 < 0.02,
        `rho_1 = ${ps.rho_1}`);
  check('punching vRd,c is finite and positive',
        ps.vRd_c_MPa > 0 && isFinite(ps.vRd_c_MPa), `vRd_c = ${ps.vRd_c_MPa}`);

  // Minor-axis moment must reach the ULS design pressures, not just bearing.
  const base = FD.designPadFoundation({ L: 3, B: 3, N_G: 600, N_Q: 200, Mx_G: 100 });
  const withMy = FD.designPadFoundation({ L: 3, B: 3, N_G: 600, N_Q: 200, Mx_G: 100, My_G: 120 });
  check('a minor-axis moment changes the ULS design pressure',
        withMy.output.qmax_uls_kPa !== base.output.qmax_uls_kPa,
        `${base.output.qmax_uls_kPa} vs ${withMy.output.qmax_uls_kPa}`);
  check('pad foundation design completes with all checks finite',
        base.checks.length > 0 && base.checks.every(c => c.eta == null || isFinite(c.eta)));
}

group('Section properties vs exact rectangle decomposition');
{
  const sctx = { console, Math, JSON, Number, Array, Object, isFinite, Infinity, NaN, Error };
  vm.createContext(sctx); sctx.window = sctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/calc/section_props.js'), 'utf8'),
                  sctx, { filename: 'section_props.js' });
  const SP = sctx.SectionProps;

  // Independent reference. A rectangle has zero product of inertia about its
  // own centroidal axes, so a decomposition into rectangles gives A, Ix, Iy,
  // Ixy and the centroid exactly — no discretisation error to argue about.
  const ref = rects => {
    let A = 0, mx = 0, my = 0;
    for (const r of rects) {
      const a = (r.x1 - r.x0) * (r.y1 - r.y0);
      A += a; mx += a * (r.y0 + r.y1) / 2; my += a * (r.x0 + r.x1) / 2;
    }
    const yc = mx / A, xc = my / A;
    let Ix = 0, Iy = 0, Ixy = 0;
    for (const r of rects) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0, a = w * h;
      const cy = (r.y0 + r.y1) / 2, cx = (r.x0 + r.x1) / 2;
      Ix  += w * h * h * h / 12 + a * (cy - yc) ** 2;
      Iy  += h * w * w * w / 12 + a * (cx - xc) ** 2;
      Ixy += a * (cx - xc) * (cy - yc);
    }
    return { A, Ix, Iy, Ixy, xc, yc };
  };
  const rel = (got, exp) => Math.abs(exp) < 1e-9 ? Math.abs(got) : Math.abs(got / exp - 1);
  const cmp = (name, got, exp, keys) => {
    for (const k of keys) {
      check(`${name} ${k}`, rel(got[k], exp[k]) < 5e-3,
            `got ${got[k]}, exact ${exp[k]}`);
    }
  };

  cmp('rectangle', SP.rectangle(200, 300),
      ref([{ x0:0, y0:0, x1:200, y1:300 }]), ['A','Ix','Iy']);

  {
    const bo=200, ho=300, bi=160, hi=260, tx=(bo-bi)/2, ty=(ho-hi)/2;
    cmp('hollow rect', SP.hollowRectangle(bo,ho,bi,hi), ref([
      {x0:0,y0:0,x1:bo,y1:ty}, {x0:0,y0:ho-ty,x1:bo,y1:ho},
      {x0:0,y0:ty,x1:tx,y1:ho-ty}, {x0:bo-tx,y0:ty,x1:bo,y1:ho-ty}]), ['A','Ix','Iy']);
  }
  {
    const h=400, bf=200, tf=15, tw=10;
    cmp('I-section', SP.iSection(h,bf,tf,tw), ref([
      {x0:0,y0:0,x1:bf,y1:tf}, {x0:0,y0:h-tf,x1:bf,y1:h},
      {x0:(bf-tw)/2,y0:tf,x1:(bf+tw)/2,y1:h-tf}]), ['A','Ix','Iy']);
  }
  {
    const bf=200, tf=20, hw=280, tw=12;
    cmp('T-section', SP.tSection(bf,tf,hw,tw), ref([
      {x0:(bf-tw)/2,y0:0,x1:(bf+tw)/2,y1:hw},
      {x0:0,y0:hw,x1:bf,y1:hw+tf}]), ['A','Ix','Iy','yc']);
  }
  {
    // A channel has the same y-distribution as an I of equal h/bf/tf/tw, so
    // their strong-axis Ix must match exactly. It used to double-count the
    // web-flange overlap and came out 7.9% high.
    const h=300, bf=100, tf=15, tw=10;
    const ch = SP.channelSection(h,bf,tf,tw);
    cmp('channel', ch, ref([
      {x0:0,y0:0,x1:bf,y1:tf}, {x0:0,y0:h-tf,x1:bf,y1:h},
      {x0:0,y0:tf,x1:tw,y1:h-tf}]), ['A','Ix','Iy','xc']);
    near('channel Ix equals I-section Ix for the same dimensions',
         ch.Ix, SP.iSection(h,bf,tf,tw).Ix, ch.Ix * 1e-9);
  }
  {
    const b1=150, b2=100, t=12;
    const ang = SP.angleSection(b1,b2,t);
    const exact = ref([{x0:0,y0:0,x1:b1,y1:t}, {x0:0,y0:t,x1:t,y1:b2}]);
    cmp('angle', ang, exact, ['A','Ix','Iy','xc','yc']);
    // Ixy is negative for this orientation; sign matters as well as magnitude.
    check('angle Ixy matches exactly (sign included)',
          rel(ang.Ixy, exact.Ixy) < 5e-3 && Math.sign(ang.Ixy) === Math.sign(exact.Ixy),
          `got ${ang.Ixy.toFixed(0)}, exact ${exact.Ixy.toFixed(0)}`);
    // The reported principal angle must actually diagonalise the tensor.
    const th = ang.alpha * Math.PI / 180;
    const Ixy_rot = (ang.Ix - ang.Iy) / 2 * Math.sin(2*th) + ang.Ixy * Math.cos(2*th);
    const Ix_rot  = (ang.Ix + ang.Iy) / 2 + (ang.Ix - ang.Iy) / 2 * Math.cos(2*th)
                    - ang.Ixy * Math.sin(2*th);
    check('principal angle diagonalises the inertia tensor',
          Math.abs(Ixy_rot) < 1e-6 * ang.Ix, `Ixy_rotated = ${Ixy_rot}`);
    near('rotating by the principal angle yields I1', Ix_rot, ang.I1, ang.I1 * 1e-6);
    // An equal angle must come out at exactly 45 degrees.
    near('equal angle principal axis is 45 degrees',
         Math.abs(SP.angleSection(100,100,10).alpha), 45, 1e-6);
  }
}

group('Report equilibrium check');
{
  // report.js builds a whole HTML document and needs a DOM, so the equilibrium
  // block is extracted and evaluated against real solver output. The point of
  // the check is that applied load is compared against reactions on a like-for
  // -like basis; summing only nodal loads made every distributed-load model
  // print a FAIL chip.
  const rptSrc = fs.readFileSync(path.join(ROOT, 'js/report/report.js'), 'utf8');
  check('report.js still contains the equilibrium block',
        /Equilibrium Check/.test(rptSrc));
  check('equilibrium check accounts for beam_dist loads',
        /beam_dist/.test(rptSrc.slice(rptSrc.indexOf('// Equilibrium check'),
                                      rptSrc.indexOf('// Build TOC entries'))),
        'the block sums nodal loads only — distributed loads are unaccounted for');

  // Behavioural equivalent: a UDL-only frame must balance.
  const { nodes, beams } = portal();
  const lds = [{ type: 'beam_dist', elementId: 2, fy: -10 }];
  const res = solveFrame(nodes, beams, SEC, lds, []);
  const lenOf = {};
  for (const ef of res.elemForces) lenOf[ef.id] = ef.L;
  let sumRy = 0, sumFy = 0;
  Object.values(res.reactions).forEach(r => { sumRy += r.Ry; });
  for (const l of lds) sumFy += (l.fy || 0) * lenOf[l.elementId];
  near('member loads close the equilibrium sum', sumRy + sumFy, 0, 1e-6);
}

group('frame_sections.js property formulas');
{
  // frame_sections.js is a DOM-bound IIFE, so the two formulas that feed the
  // solver via _syncToSA() are extracted and checked against section_props.js,
  // which the group above pins to an exact decomposition.
  const fsSrc = fs.readFileSync(path.join(ROOT, 'js/features/frame_sections.js'), 'utf8');
  const sctx = { console, Math, JSON, Number, Array, Object, isFinite, Infinity, NaN, Error };
  vm.createContext(sctx); sctx.window = sctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/calc/section_props.js'), 'utf8'), sctx);
  const SP = sctx.SectionProps;

  const jm = fsSrc.match(/var _J_BETA = \[[\s\S]*?\n  \}/);
  check('_rectJ is extractable from frame_sections.js', !!jm);
  if (jm) {
    // eslint-disable-next-line no-new-func
    const rectJ = new Function(jm[0] + '\nreturn _rectJ;')();
    for (const [b, d] of [[0.3, 0.6], [0.4, 0.4], [0.2, 1.0]]) {
      near(`rect ${b*1000}x${d*1000} torsion constant`,
           rectJ(b, d) * 1e8, SP.rectangle(b*1000, d*1000).J / 1e4, 1);
    }
  }

  // The angle block must reduce to the centroidal axes. Without the −A·yc²
  // term it reported I33 87% high for an equal angle, and that value is
  // written into the model as I/Ix.
  // Search the whole source: slicing between `_isAngle(id)` and `_isTee(id)`
  // matched their function *definitions*, not the branch that uses them.
  check('angle I33 applies the parallel-axis reduction',
        /I33_edge\s*-\s*A_ang\s*\*\s*yc_a\s*\*\s*yc_a/.test(fsSrc), 'no −A·yc² term found');
  check('angle I22 applies the parallel-axis reduction',
        /I22_edge\s*-\s*A_ang\s*\*\s*xc_a\s*\*\s*xc_a/.test(fsSrc), 'no −A·xc² term found');

  // Reproduce the patched angle expressions and confirm they match exactly.
  const angleFS = (d, b, t) => {
    const A = t * (b + d - t);
    const yc = (d*d*t/2 + (b-t)*t*t/2) / A;
    const xc = (b*b*t/2 + (d-t)*t*t/2) / A;
    return {
      I33: (t*d**3/3 + (b-t)*t**3/3 - A*yc*yc) * 1e8,
      I22: (t*b**3/3 + (d-t)*t**3/3 - A*xc*xc) * 1e8,
    };
  };
  for (const [d, b, t] of [[0.1,0.1,0.01], [0.15,0.1,0.012], [0.2,0.1,0.015]]) {
    const g = angleFS(d, b, t), e = SP.angleSection(b*1000, d*1000, t*1000);
    near(`L${d*1000}x${b*1000}x${t*1000} I33`, g.I33, e.Ix/1e4, Math.abs(e.Ix/1e4)*5e-3);
    near(`L${d*1000}x${b*1000}x${t*1000} I22`, g.I22, e.Iy/1e4, Math.abs(e.Iy/1e4)*5e-3);
  }
  const eq = angleFS(0.1, 0.1, 0.01);
  near('equal angle has I33 === I22', eq.I33, eq.I22, 1e-6);
}

group('index.html inline design calculators');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // ── Spherical dome, membrane theory ────────────────────────────────────
  // Nθ = wR(1/(1+cos φ) − cos φ). The first numerator was cos φ, which removed
  // the compression→tension transition entirely, so As,hoop was never designed.
  check('dome hoop force uses 1/(1+cos φ), not cos φ/(1+cos φ)',
        /Ntheta = w \* R \* \(1\/\(1\+Math\.cos\(phi\)\) - Math\.cos\(phi\)\)/.test(html),
        'hoop-force expression does not match the membrane-theory form');

  const Ntheta = (w, R, deg) => {
    const p = deg * Math.PI / 180;
    return w * R * (1 / (1 + Math.cos(p)) - Math.cos(p));
  };
  // The textbook transition sits at φ = 51.83°, where cos φ = 1/(1+cos φ).
  near('dome hoop force is zero at the 51.83 degree transition',
       Ntheta(5, 15, 51.827), 0, 0.05);
  check('dome hoop force is compressive below the transition', Ntheta(5,15,45) < 0);
  check('dome hoop force is tensile above the transition',     Ntheta(5,15,60) > 0);
  near('dome hoop force at the springing (phi = 90)', Ntheta(5,15,90), 75, 1e-9);

  // ── Singly-reinforced discriminant guards ──────────────────────────────
  // Rn > 0.425·f'c makes 1 − 2Rn/(0.85f'c) negative; unguarded that is NaN.
  const guarded = html.match(/Math\.sqrt\(Math\.max\(0, disc\)\)/g) || [];
  check('both rho solvers clamp the discriminant', guarded.length >= 2,
        `found ${guarded.length} guarded call(s), expected 2`);
  const rho = (fc, fy, Rn) => 0.85*fc/fy * (1 - Math.sqrt(Math.max(0, 1 - 2*Rn/(0.85*fc))));
  check('over-stressed section yields a finite rho instead of NaN',
        Number.isFinite(rho(25, 420, 20)), `rho = ${rho(25, 420, 20)}`);

  // ── Footing punching shear stays in kN throughout ──────────────────────
  check('punching demand is computed in kN without a 1e3 mismatch',
        /const Vup = Pu - qu\*\(\(c\+d\)\/1000\)\*\*2;/.test(html),
        'Vup still mixes newtons and kilonewtons');
  {
    // Pu = 1000 kN, B = 2.5 m, c = 400 mm, d = 450 mm.
    const Pu = 1000, B = 2.5, c = 400, d = 450, qu = Pu / (B*B);
    const Vup = Pu - qu * ((c + d) / 1000) ** 2;
    near('punching demand deducts the pressure inside the perimeter', Vup, 884.4, 0.5);
    check('punching demand is below the gross column load', Vup < Pu);
  }
}

group('Load-combination envelope and governing-combination design');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  // Design must consider EVERY combination, not just the displayed one.
  check('runDesignChecks iterates the source sets',
        /designSourceSets\(\)/.test(appSrc) && /mergeWorstByBeam\(runs\)/.test(appSrc),
        'design still runs against a single result set');
  check('per-combination checking goes through checkAgainst',
        /function checkAgainst\(srcRes, codeMode\)/.test(appSrc));
  check('an envelope result exists and is selectable',
        /function buildEnvelope\(\)/.test(appSrc) &&
        /activeDisplay\.type === 'envelope'/.test(appSrc));

  // mergeWorstByBeam must be exactly the max utilisation per member.
  const mm = appSrc.match(/function mergeWorstByBeam\(runs\)\s*\{[\s\S]*?\n  \}/);
  check('mergeWorstByBeam is extractable', !!mm);
  if (mm) {
    // eslint-disable-next-line no-new-func
    const merge = new Function(mm[0] + '\nreturn mergeWorstByBeam;')();
    const runs = [
      { label: '1.4D',      out: { byBeam: [{ id:1, maxEta:0.30 }, { id:2, maxEta:0.90 }] } },
      { label: '1.2D+1.6L', out: { byBeam: [{ id:1, maxEta:0.86 }, { id:2, maxEta:0.40 }] } },
      { label: '0.9D+1.0W', out: { byBeam: [{ id:1, maxEta:0.55 }, { id:2, maxEta:0.75 }] } },
    ];
    const merged = merge(runs);
    const byId = Object.fromEntries(merged.map(b => [b.id, b]));
    near('member 1 takes its worst utilisation', byId[1].maxEta, 0.86, 1e-9);
    near('member 2 takes its worst utilisation', byId[2].maxEta, 0.90, 1e-9);
    check('member 1 records its governing combination', byId[1].governedBy === '1.2D+1.6L',
          byId[1].governedBy);
    check('member 2 records a different governing combination', byId[2].governedBy === '1.4D',
          byId[2].governedBy);
    check('members can be governed by different combinations',
          byId[1].governedBy !== byId[2].governedBy);
    // Degenerate inputs must not throw or invent members.
    check('merge tolerates an empty run list', merge([]).length === 0);
    check('merge skips runs with no byBeam',
          merge([{ label:'x', out:null }, runs[0]]).length === 2);
  }

  // An envelope is not an equilibrium state; the report must not test it as one.
  const rptSrc = fs.readFileSync(path.join(ROOT, 'js/report/report.js'), 'utf8');
  check('report skips the equilibrium check for an envelope',
        /results\?\.isEnvelope/.test(rptSrc) &&
        /not applicable to an envelope/.test(rptSrc),
        'an envelope would be reported as failing equilibrium');
}

group('Generators replace the model rather than appending');
{
  const gsrc = fs.readFileSync(path.join(ROOT, 'js/core/generators.js'), 'utf8');
  const templates = ['generateFrame','generateTruss','generateContinuousBeam',
                     'generateSimpleBeam','generateBracedFrame','generateArch',
                     'generateFloorGrid','generateVierendeel','generateLeanTo',
                     'generateColumnLine'];
  for (const t of templates) {
    const start = gsrc.indexOf('function ' + t + '(');
    const body  = start < 0 ? '' : gsrc.slice(start, gsrc.indexOf('\n  function ', start + 1));
    check(`${t} resets the model`, /resetModel\(app\)/.test(body),
          'template appends to the existing structure instead of replacing it');
    // The reset must come after the input-validation guard, or a bad call
    // wipes the user's work before bailing.
    if (/resetModel\(app\)/.test(body) && /toast\('Invalid/.test(body)) {
      check(`${t} validates input before resetting`,
            body.indexOf("toast('Invalid") < body.indexOf('resetModel(app)'),
            'reset happens before the parameter guard');
    }
  }
  check('generateDefaultStructure still clears explicitly',
        /generateDefaultStructure[\s\S]*?app\.nodes\s*=\s*\[\]/.test(gsrc));

  // resetModel must not call clearResults(): that helper snapshots as its first
  // statement, so calling it post-reset pushed an empty model onto the undo
  // stack and undo restored a blank canvas instead of the previous structure.
  const rmStart = gsrc.indexOf('function resetModel(app)');
  const rmBody  = gsrc.slice(rmStart, gsrc.indexOf('\n  }', rmStart));
  check('resetModel does not call clearResults (it snapshots)',
        rmStart >= 0 && !/^\s*[^/]*app\.clearResults\(\)/m.test(rmBody),
        'undo will restore an empty model');
}

group('Results-cache fingerprint responds to every solver input');
{
  const base = portal();
  const lds  = [{ type: 'beam_dist', elementId: 2, fy: -10 }];
  const h = (n, b, s, l) => StructDB.modelHash(n, b, s, l, []);
  const h0 = h(base.nodes, base.beams, SEC, lds);

  const clone = o => JSON.parse(JSON.stringify(o));
  const variants = {
    'section Ix':        () => { const s = clone(SEC); s[0].Ix = 99999;  return h(base.nodes, base.beams, s, lds); },
    'section Iy':        () => { const s = clone(SEC); s[0].Iy = 99999;  return h(base.nodes, base.beams, s, lds); },
    'section J':         () => { const s = clone(SEC); s[0].J  = 999;    return h(base.nodes, base.beams, s, lds); },
    'section rho':       () => { const s = clone(SEC); s[0].rho = 1;     return h(base.nodes, base.beams, s, lds); },
    'rigid end zone':    () => { const s = clone(SEC); s[0].rigidZone = true; return h(base.nodes, base.beams, s, lds); },
    'member modifiers':  () => { const b = clone(base.beams); b[0].modifiers = { fi3: 0.35 }; return h(base.nodes, b, SEC, lds); },
    'spring stiffness':  () => { const n = clone(base.nodes); n[0].support = 'spring'; n[0].springKy = 1e6; return h(n, base.beams, SEC, lds); },
    'custom 3D DOF mask':() => { const n = clone(base.nodes); n[1].fixedDOF = [1,1,1,0,0,0]; return h(n, base.beams, SEC, lds); },
  };

  for (const [name, fn] of Object.entries(variants)) {
    const hv = fn();
    check(`hash changes when ${name} changes`, hv !== h0, `both hashed to ${h0}`);
  }
  check('hash is stable for an unchanged model',
        h(base.nodes, base.beams, SEC, lds) === h0);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Support and stiffness invariants that no equilibrium check could catch
// ══════════════════════════════════════════════════════════════════════════════

group('Spring supports carry their share of the load');
{
  // Pin at one end, vertical spring at the other, 10 kN/m over 6 m = 60 kN.
  // A spring restrains by adding stiffness to K, so `K·U − F_ext` is identically
  // zero at its DOF and the spring force went unreported: ΣRy came back as 30.
  const nodes = [{ id: 1, x: 0, y: 0, support: 'pin' },
                 { id: 2, x: 6, y: 0, support: 'spring', springKy: 5000 }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const lds   = [{ type: 'beam_dist', elementId: 1, fy: -10 }];

  const r = solveFrame(nodes, beams, SEC, lds, []);
  check('spring model solves', !!r.success, r.error);
  if (r.success) {
    const sumRy = Object.values(r.reactions).reduce((s, R) => s + R.Ry, 0);
    near('spring support: ΣRy balances the applied load', sumRy, 60, 1e-6);
    near('the spring reaction equals −k·u',
         r.reactions[2].Ry, -5000 * r.disp[2].v, 1e-6);
  }

  const pd = PDeltaAnalysis.runPDelta(nodes, beams, SEC, lds, [],
                                      { maxIter: 30, tolerance: 1e-10 });
  check('spring model solves under P-Δ', !!pd.success, pd.error);
  if (pd.success) {
    const sumRy = Object.values(pd.reactions).reduce((s, R) => s + R.Ry, 0);
    near('P-Δ spring support: ΣRy balances the applied load', sumRy, 60, 1e-4);
  }
}

group('Rigid end zones stiffen the frame without inventing load');
{
  // Direction cosines used to be taken from the length AFTER the rigid-zone
  // reduction, so c² + s² came out as (L0/Leff)² and T stopped being a rotation.
  // Both the stiffness and the transformed fixed-end forces were inflated by it.
  const rzPortal = (rz) => ({
    nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 },
            { id: 3, x: 6, y: 4 }, { id: 4, x: 6, y: 0, support: 'fixed' }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
            { id: 2, node1: 2, node2: 3, sectionId: 1 },
            { id: 3, node1: 3, node2: 4, sectionId: 1 }],
    sections: [{ ...SEC[0], rigidZone: rz, d: 600 }],
  });

  const udl = [{ type: 'beam_dist', elementId: 2, fy: -10 }];   // 60 kN total
  for (const rz of [false, true]) {
    const m = rzPortal(rz);
    const r = solveFrame(m.nodes, m.beams, m.sections, udl, []);
    check(`rigidZone=${rz} solves`, !!r.success, r.error);
    if (!r.success) continue;
    const sumRy = Object.values(r.reactions).reduce((s, R) => s + R.Ry, 0);
    near(`rigidZone=${rz}: ΣRy equals the 60 kN applied`, sumRy, 60, 1e-6);
  }

  // Rigid zones must make the frame STIFFER, never softer.
  const sway = (rz) => {
    const m = rzPortal(rz);
    return solveFrame(m.nodes, m.beams, m.sections,
                      [{ type: 'nodal', nodeId: 2, fx: 50 }], []).disp[2].u;
  };
  const [uOff, uOn] = [sway(false), sway(true)];
  check('rigid end zones reduce sway', uOn < uOff, `${uOn} vs ${uOff}`);

  // The linear and second-order paths must assemble the SAME stiffness. P-Δ and
  // modes.js used to ignore rigid zones entirely, so switching P-Δ on quietly
  // reverted the model to full member lengths — a 49 % jump in sway.
  for (const rz of [false, true]) {
    const m  = rzPortal(rz);
    const l  = [{ type: 'nodal', nodeId: 2, fx: 50 }];
    const lin = solveFrame(m.nodes, m.beams, m.sections, l, []);
    const pd  = PDeltaAnalysis.runPDelta(m.nodes, m.beams, m.sections, l, [],
                                         { maxIter: 30, tolerance: 1e-12 });
    check(`rigidZone=${rz}: P-Δ starts from the same stiffness as the linear solve`,
          Math.abs(pd.disp[2].u - lin.disp[2].u) / Math.abs(lin.disp[2].u) < 0.01,
          `linear ${lin.disp[2].u}, P-Δ ${pd.disp[2].u}`);
  }
}

group('2D and 3D agree on member loads');
{
  // A planar frame analysed both ways must give the same answer. `pos` is metres
  // from the start in the UI and in solver.js; solveFrame3D read it as a 0–1
  // fraction and clamped it, so a load 1.5 m along a 6 m cantilever landed on the
  // far node and quadrupled the base moment.
  const cant2 = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 6, y: 0 }];
  const cant3 = [{ id: 1, x: 0, y: 0, z: 0, support: 'fixed' },
                 { id: 2, x: 6, y: 0, z: 0 }];
  const bm    = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];

  const pt = [{ type: 'beam_point', elementId: 1, fy: -60, pos: 1.5 }];
  const p2 = solveFrame(cant2, bm, SEC, pt, []);
  const p3 = solveFrame3D(cant3, bm, SEC, pt, []);
  near('2D: point load at 1.5 m gives M = P·a', Math.abs(p2.elemForces[0].M1), 90, 1e-6);
  near('3D reads `pos` as metres, like 2D',      Math.abs(p3.elemForces[0].Mz1), 90, 1e-6);
  near('3D point load: vertical reaction',        p3.reactions[1].Rz, 60, 1e-6);

  // fx on a member load was never read in 3D — only fy — so wind on a column
  // produced no reaction and no sway at all.
  const col2 = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 }];
  const col3 = [{ id: 1, x: 0, y: 0, z: 0, support: 'fixed' },
                { id: 2, x: 0, y: 0, z: 4 }];
  const wind = [{ type: 'beam_dist', elementId: 1, fx: 5, fy: 0 }];
  const w2 = solveFrame(col2, bm, SEC, wind, []);
  const w3 = solveFrame3D(col3, bm, SEC, wind, []);
  near('2D: horizontal UDL on a column',   w2.reactions[1].Rx, -20, 1e-6);
  near('3D applies fx on member loads too', w3.reactions[1].Rx, -20, 1e-6);
  check('3D horizontal UDL produces sway', Math.abs(w3.disp[2].u) > 1e-6,
        `u = ${w3.disp[2].u}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Design checks read the solver's axial sign convention
// ══════════════════════════════════════════════════════════════════════════════

group('Axial force is compression-positive, and the design codes know it');
{
  // solveFrame reports compression as POSITIVE. All three design modules read it
  // as tension-positive and negated, so every compressed member was checked as if
  // it were in tension: EC3 never ran a buckling check, and ACI designed columns
  // with zero axial load.
  const STEEL = [{ id: 1, name: 'IPE300', E: 210, fy: 275, A: 53.8,
                   Ix: 8356, Iy: 604, I: 8356, Zx: 628, Sx: 557, Zy: 125, Sy: 80.5,
                   J: 20.1, Cw: 126000, ry: 12.5, rz: 3.35,
                   d: 300, bf: 150, tf: 10.7, tw: 7.1, r: 15, rho: 78.5, _type: 'I' }];
  const nds  = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 }];
  const bms  = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];

  const grav = solveFrame(nds, bms, STEEL, [{ type: 'nodal', nodeId: 2, fy: -300 }], []);
  const upl  = solveFrame(nds, bms, STEEL, [{ type: 'nodal', nodeId: 2, fy:  300 }], []);
  near('gravity on a column returns +N (compression-positive)', grav.elemForces[0].N1, 300, 1e-6);
  near('uplift on the same column returns −N',                  upl.elemForces[0].N1, -300, 1e-6);

  const cChecks = DesignChecks.runDesignChecks(grav, bms, STEEL).byBeam[0].checks;
  const ax = cChecks.find(c => /^Axial/.test(c.check));
  check('EC3 checks a compressed column for BUCKLING, not tension',
        /Compression/.test(ax.check), `got "${ax.check}"`);
  near('EC3 axial demand equals the applied compression', ax.N_Ed, 300, 1e-3);
  check('buckling reduces the axial capacity below Npl,Rd',
        ax.Nb_Rd < ax.Npl_Rd, `Nb_Rd ${ax.Nb_Rd} vs Npl_Rd ${ax.Npl_Rd}`);
  check('a 4 m IPE300 under 300 kN is over half utilised',
        ax.eta > 0.4 && ax.eta < 0.7, `eta = ${ax.eta}`);

  // The RESULTS PANEL must name the sign the same way the solver does. It read
  // "N>0 = tension" and coloured positive green, so a frame whose columns were
  // all in compression — the normal case — was displayed as entirely in
  // tension, with the gravity load pointing the wrong way to anyone reading it.
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const cell = appSrc.slice(appSrc.indexOf('const axialCell ='),
                              appSrc.indexOf('const axialCell =') + 400);
    check('the panel colours POSITIVE axial as compression (orange #e65100)',
          /v > 0\.001 \? 'color:#e65100'/.test(cell), cell.slice(0, 160));
    check('and titles positive axial "Compression"',
          /v > 0\.001 \? ' title="Compression"'/.test(cell), cell.slice(0, 160));
    check('the caption no longer claims N>0 is tension',
          !/N&gt;0 = tension/.test(appSrc));
    check('and states positive = compression',
          /positive = compression/.test(appSrc));
  }

  // The same member in tension must still take the tension branch.
  const tChecks = DesignChecks.runDesignChecks(upl, bms, STEEL).byBeam[0].checks;
  const axT = tChecks.find(c => /^Axial/.test(c.check));
  check('EC3 still recognises a tension member', /Tension/.test(axT.check), axT.check);
  near('EC3 tension demand is the applied uplift', axT.N_Ed, 300, 1e-3);

  // ACI: a real column must see its axial load.
  const RC = { id: 1, name: 'ACI col 400x400', E: 25, fc: 30, A: 1600,
               Ix: 213333, I: 213333, d: 400, bf: 400, rho: 25 };
  const rcNds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }];
  const rcRes = solveFrame(rcNds, bms, [RC],
                  [{ type: 'nodal', nodeId: 2, fy: -900 },
                   { type: 'nodal', nodeId: 2, fx: 30 }], []);
  const aci = ACIDesign.runACIChecks(rcRes.elemForces[0], RC,
                { b: 0.4, h: 0.4, fy_rebar: 420, cover: 40, phi_bar: 19,
                  memberType: 'column' });
  const pm = (aci.checks || aci).find(c => /Column \(ACI/.test(c.check || ''));
  near('ACI column P-M sees the applied axial load', pm.N_Ed, 900, 1e-3);
  check('ACI column carries a non-zero axial utilisation', pm.eta_P > 0.3,
        `eta_P = ${pm.eta_P}`);
  check('ACI picks the compression-dominant interaction',
        /compression-dominant/.test(pm.interaction_formula), pm.interaction_formula);

  // EC2: axial compression raises VRd,c through σcp, so the same section must
  // show a HIGHER concrete shear resistance when it carries axial load. (The
  // check's `eta` is V/VRd,max, the strut-crushing ratio, which is independent
  // of N — VRdc is where the axial term lands.)
  const RC2 = { id: 1, name: 'RC 400x400', E: 25, fck: 30, A: 1600,
                Ix: 213333, I: 213333, d: 400, bf: 400, rho: 25 };
  const opt2 = { b: 0.4, h: 0.4, fyk: 500, cover: 35, phi: 16 };
  const ec2Of = ef => {
    const o = RCDesign.runRCChecks(ef, RC2, opt2);
    return (o.checks || o).find(c => /Shear/.test(c.check || ''));
  };
  const withN = ec2Of(rcRes.elemForces[0]);
  const noN   = ec2Of({ ...rcRes.elemForces[0], N1: 0, N2: 0 });
  check('EC2 credits axial compression to VRd,c', withN.VRdc > noN.VRdc,
        `with N ${withN.VRdc} kN vs without N ${noN.VRdc} kN`);
  // σcp = 900 kN / 160 000 mm² = 5.6 MPa, and k1·σcp·bw·d adds ~0.15·5.6·400·353
  // ≈ 119 kN. A thousand-fold unit slip would make the gain invisible.
  check('and the gain is of the right order, not 1000x too small',
        withN.VRdc - noN.VRdc > 50, `gain = ${(withN.VRdc - noN.VRdc).toFixed(2)} kN`);
  check('EC2 etas are all finite',
        (RCDesign.runRCChecks(rcRes.elemForces[0], RC2, opt2).checks ||
         RCDesign.runRCChecks(rcRes.elemForces[0], RC2, opt2))
          .every(c => c.eta == null || Number.isFinite(c.eta)));
}

group('Utilisation figures are demand/capacity ratios');
{
  // plateBucklingCheck returned the largest plate SLENDERNESS as `eta`, and
  // runDesignChecks takes the max `eta` as the member's utilisation — so a
  // slender girder reported maxEta = 6.42 against a worst real ratio of 0.35.
  const SLENDER = [{ id: 1, name: 'plate girder', E: 210, fy: 355, A: 100,
                     Ix: 200000, Iy: 2000, I: 200000, Zx: 4000, Sx: 3500,
                     J: 20, Cw: 1e7, ry: 30, rz: 4,
                     d: 1200, bf: 300, tf: 6, tw: 4, r: 0, rho: 78.5, _type: 'I' }];
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 6 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const res = solveFrame(nds, bms, SLENDER,
                [{ type: 'nodal', nodeId: 2, fy: -200 },
                 { type: 'nodal', nodeId: 2, fx: 40 }], []);
  const beam = DesignChecks.runDesignChecks(res, bms, SLENDER).byBeam[0];

  const pb = beam.checks.find(c => /Plate Buckling/.test(c.check));
  check('plate buckling reports no utilisation ratio', pb.eta === null, `eta = ${pb.eta}`);
  check('plate slenderness is still reported, under its own name',
        pb.lambda_p_max > 1, `lambda_p_max = ${pb.lambda_p_max}`);
  check('member utilisation stays a ratio', beam.maxEta < 1.5, `maxEta = ${beam.maxEta}`);

  // A Class 4 section must not be handed the plastic modulus by the interaction
  // check when flexuralCheck has already reduced it to an effective one.
  const fl = beam.checks.find(c => c.check === 'Flexure');
  const ix = beam.checks.find(c => /Interaction/.test(c.check));
  const ax = beam.checks.find(c => /^Axial/.test(c.check));
  check('flexure classifies the girder as Class 4', fl.cls === 4, `cls = ${fl.cls}`);
  check('the interaction check sees the member compression',
        Math.abs(ix.N_Ed - ax.N_Ed) < 1e-3, `interaction ${ix.N_Ed} vs axial ${ax.N_Ed}`);
  check('and it is non-zero', ix.N_Ed > 100, `N_Ed = ${ix.N_Ed}`);

  // Back out the moment resistance the interaction actually used. Eq. 6.61 is
  // N/Nb_y + kyy·M/(χLT·M_Rk), so with N, kyy and eta_6_61 reported we can
  // recover χLT·M_Rk and check which modulus went into it. Feeding it the
  // plastic modulus inflates M_Rk by Zx/(0.8·Sx) ≈ 1.43.
  const Nb_y    = ax.chi_y * ax.Npl_Rd;                   // γM0 = γM1 = 1
  const Mb_used = ix.kyy * ix.M_Ed / (ix.eta_6_61 - ix.N_Ed / Nb_y);
  const M_Rk_used = Mb_used / fl.chiLT;
  const M_Rk_class = fl.Mc_Rd;             // 0.8·Sx·fy for this Class 4 section
  const M_Rk_plastic = 4000e-6 * 355e3;    // Zx·fy — what it used to assume
  check('interaction uses the class-consistent moment resistance',
        Math.abs(M_Rk_used - M_Rk_class) / M_Rk_class < 0.02,
        `implied M_Rk ${M_Rk_used.toFixed(1)} vs class ${M_Rk_class} / plastic ${M_Rk_plastic}`);
  check('and not the plastic modulus',
        Math.abs(M_Rk_used - M_Rk_plastic) / M_Rk_plastic > 0.20,
        `implied M_Rk ${M_Rk_used.toFixed(1)} is indistinguishable from Zx·fy ${M_Rk_plastic}`);
  check('interaction is at least as onerous as the flexure check alone',
        ix.eta > fl.eta, `interaction ${ix.eta} vs flexure ${fl.eta}`);
}

group('Shear reduces moment capacity above 0.5·Vpl,Rd (EC3 §6.2.8)');
{
  // rho_V was derived and printed but never applied, so a beam running at high
  // shear kept its full moment capacity.
  const S = [{ id: 1, name: 'IPE300', E: 210, fy: 275, A: 53.8,
               Ix: 8356, Iy: 604, I: 8356, Zx: 628, Sx: 557,
               J: 20.1, Cw: 126000, ry: 12.5, rz: 3.35,
               d: 300, bf: 150, tf: 10.7, tw: 7.1, r: 15, rho: 78.5, _type: 'I' }];
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 1.2, y: 0 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];

  const lo = solveFrame(nds, bms, S, [{ type: 'nodal', nodeId: 2, fy: -20 }], []);
  const hi = solveFrame(nds, bms, S, [{ type: 'nodal', nodeId: 2, fy: -400 }], []);
  const flLo = DesignChecks.runDesignChecks(lo, bms, S).byBeam[0]
                 .checks.find(c => c.check === 'Flexure');
  const flHi = DesignChecks.runDesignChecks(hi, bms, S).byBeam[0]
                 .checks.find(c => c.check === 'Flexure');

  near('low shear leaves the moment capacity untouched', flLo.rho_V, 0, 1e-9);
  check('high shear triggers the §6.2.8 reduction', flHi.rho_V > 0, `rho_V = ${flHi.rho_V}`);
  check('and the reduction actually lowers Mc,Rd',
        flHi.Mc_Rd < flLo.Mc_Rd, `${flHi.Mc_Rd} vs ${flLo.Mc_Rd}`);

  // ρ is only defined for 0.5 < V_Ed/Vpl,Rd ≤ 1. Past that the expression runs
  // away — a member at 187x shear produced ρ ≈ 1.4e5. Assert on shearCheck's own
  // output, which is where the clamp lives.
  const huge = solveFrame(nds, bms, S, [{ type: 'nodal', nodeId: 2, fy: -40000 }], []);
  const hugeChecks = DesignChecks.runDesignChecks(huge, bms, S).byBeam[0].checks;
  const shHuge = hugeChecks.find(c => c.check === 'Shear');
  const flHuge = hugeChecks.find(c => c.check === 'Flexure');
  check('the shear check is genuinely off the scale', shHuge.eta > 10, `eta = ${shHuge.eta}`);
  check('shearCheck clamps rho_V to its physical range',
        shHuge.rho_V <= 1, `rho_V = ${shHuge.rho_V}`);
  check('a grossly overloaded member still reports a finite utilisation',
        Number.isFinite(flHuge.eta), `eta = ${flHuge.eta}`);

  // Direct guard test: a section whose web term swamps Wpl drives the reduced
  // modulus negative, so Mc,Rd clamps to zero. eta_M must stay finite — JSON
  // turns Infinity into null, which would erase the failure from the summary.
  const PATHO = { name: 'pathological', E: 210, fy: 275, A: 100, Ix: 10000, Iy: 500,
                  Zx: 1, Sx: 1, J: 10, Cw: 1e4, ry: 10, rz: 3,
                  d: 1000, bf: 300, tf: 10, tw: 50, r: 0, _type: 'I' };
  const efP = { M1: 500, M2: 0, N1: 0, N2: 0, V1: 0, V2: 0, L: 3, loads: [] };
  const flP = DesignChecks.flexuralCheck(efP, PATHO, 3, 1.0);
  near('a zero moment capacity is reachable in this fixture', flP.Mc_Rd, 0, 1e-9);
  check('and eta stays finite rather than becoming Infinity',
        Number.isFinite(flP.eta) && flP.eta > 1, `eta = ${flP.eta}`);
  check('the member is still reported as failing', flP.status === 'FAIL', flP.status);
}

group('Every utilisation stays a finite number');
{
  // JSON turns Infinity and NaN into null, so a capacity that reached zero made
  // the member's utilisation vanish from the summary instead of reporting the
  // failure. A bare concrete section pushed through the EC3 path — no web
  // dimensions, no moduli, grossly overloaded — is the awkward case.
  const BARE = [{ id: 1, name: 'Conc 9"x9"', E: 25, fy: 27.6, A: 522.6,
                  Ix: 22900, I: 22900, rho: 24 }];
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const res = solveFrame(nds, bms, BARE, [{ type: 'nodal', nodeId: 2, fy: -500 },
                                          { type: 'nodal', nodeId: 2, fx: 200 }], []);
  const beam = DesignChecks.runDesignChecks(res, bms, BARE).byBeam[0];

  const nonFinite = beam.checks.filter(c => c.eta != null && !Number.isFinite(c.eta));
  check('no check reports a non-finite eta', nonFinite.length === 0,
        nonFinite.map(c => `${c.check}=${c.eta}`).join(', '));
  check('the member utilisation is finite', Number.isFinite(beam.maxEta),
        `maxEta = ${beam.maxEta}`);
  check('and the overload is actually reported as a failure', beam.overall === 'FAIL',
        `overall = ${beam.overall}`);

  // §6.2.8 must not invent a reduction for a section with no web to reduce.
  const fl = beam.checks.find(c => c.check === 'Flexure');
  check('§6.2.8 says so plainly when web dimensions are missing',
        /No M-V interaction|needs web dimensions/.test(fl.mv_note), fl.mv_note);
}

group('Degenerate models are rejected, not answered');
{
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];

  const r = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'roller' }, { id: 2, x: 6, y: 0, support: 'roller' }],
    beams, SEC, [{ type: 'nodal', nodeId: 2, fx: 10 }], []);
  check('a horizontal mechanism is reported as an error', !!r.error, JSON.stringify(r.disp));

  // gaussSolve judged singularity with `Math.abs(piv) < 1e-30`. That comparison
  // is FALSE for NaN, so a NaN pivot sailed through both the elimination and the
  // back-substitution guard and the solve returned success:true carrying NaN
  // displacements. A node missing a coordinate — a plausible bad import — is
  // enough to produce one. The guard is now written so NaN fails it.
  const nan = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, y: 4 }],   // node 2 has no x
    beams, SEC, [{ type: 'nodal', nodeId: 2, fx: 10 }], []);
  check('a model with a non-finite coordinate errors instead of returning NaN',
        !!nan.error, `success with u2 = ${nan.disp && nan.disp[2].u}`);

  // A well-supported model of the same size must still solve.
  const ok = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 6, y: 0, support: 'roller' }],
    beams, SEC, [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
  check('a properly supported beam still solves', !!ok.success, ok.error);
  check('and its displacements are finite',
        ok.success && Object.values(ok.disp).every(d => Number.isFinite(d.v)));
}

group('ACI φ follows the demand eccentricity');
{
  // φ depends on ε_t, which depends on where the demand sits on the interaction
  // curve — the point at the demand's own eccentricity M/P. The old search took
  // the curve point nearest in normalised space, which has no relation to the
  // load path: a 400×400 column at Pu = 900 kN, Mu = 90 kNm was handed the
  // tension-controlled end of the curve and reported φ = 0.90.
  const RC = { id: 1, name: 'ACI col 400x400', E: 25, fc: 30, A: 1600,
               Ix: 213333, I: 213333, d: 400, bf: 400, rho: 25 };
  const phiAt = Pu => {
    const out = ACIDesign.runACIChecks(
      { N1: Pu, N2: Pu, M1: 90, M2: 0, V1: 30, V2: 30, L: 3, loads: [] }, RC,
      { b: 0.4, h: 0.4, fy_rebar: 420, cover: 40, phi_bar: 19, memberType: 'column' });
    return (out.checks || out).find(c => /Column \(ACI/.test(c.check || ''));
  };
  const light = phiAt(50), mid = phiAt(400), heavy = phiAt(900);

  near('a lightly loaded column is tension-controlled (φ = 0.90)', light.phi_col, 0.90, 1e-6);
  check('a heavily loaded column is compression-controlled (φ = 0.65)',
        Math.abs(heavy.phi_col - 0.65) < 1e-6, `φ = ${heavy.phi_col}, zone ${heavy.phi_zone}`);
  check('and the transition region sits between them',
        mid.phi_col > 0.65 && mid.phi_col < 0.90, `φ = ${mid.phi_col}`);
  check('φ never increases as axial load grows',
        light.phi_col >= mid.phi_col && mid.phi_col >= heavy.phi_col,
        `${light.phi_col} / ${mid.phi_col} / ${heavy.phi_col}`);
  near('the reported eccentricity is M/P', heavy.e_demand_mm, 100, 0.1);
}

group('EC2 checks concrete columns, not just beams');
{
  // runRCChecks ran the beam checks on every RC member and never called
  // columnDesign, so a concrete column under EC2 was reported on as though it
  // carried no axial load at all.
  const RC2 = { id: 1, name: 'RC 400x400', E: 25, fck: 30, A: 1600,
                Ix: 213333, I: 213333, d: 400, bf: 400, rho: 25 };
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const res = solveFrame(nds, bms, [RC2], [{ type: 'nodal', nodeId: 2, fy: -900 },
                                           { type: 'nodal', nodeId: 2, fx: 30 }], []);
  const run = mt => RCDesign.runRCChecks(res.elemForces[0], RC2,
                      { b: 0.4, h: 0.4, fyk: 500, cover: 35, phi: 16, memberType: mt });
  const colChecks  = run('column');
  const beamChecks = run('beam');
  const hasCol = cs => (cs.checks || cs).some(c => /Column/.test(c.check || ''));

  check('a column gets an axial + slenderness check', hasCol(colChecks));
  check('a beam does not', !hasCol(beamChecks));

  // Guarded: without this the assertions below throw on `undefined` and abort
  // the whole run instead of reporting one failed check.
  const col = (colChecks.checks || colChecks).find(c => /Column/.test(c.check)) || {};
  near('the column check sees the applied axial load', col.N_Ed, 900, 1e-3);
  check('and contributes a utilisation', Number.isFinite(col.eta) && col.eta > 0,
        `eta = ${col.eta}`);
  check('the note is explicit that this is not a P-M interaction',
        /squash load|Axial screen/.test(col.note || ''), col.note);

  // λlim = 20·A·B·C/√n with the EC2 recommended A=0.7, B=1.1, C=0.7. Dropping
  // A·B·C — as the code did — inflates it by 1/0.539 ≈ 1.86 and under-reports
  // slender columns.
  near('lambda_lim carries the A·B·C factor', col.lambda_lim,
       20 * 0.7 * 1.1 * 0.7 / Math.sqrt(col.n_rel || 1), 0.05);
}

group('Qualified pass/fail statuses are classified, not string-matched');
{
  // Design modules emit 'FAIL (strut)', 'FAIL (punching)', 'WARN (slender…)',
  // 'OK (no links needed)'. Consumers tested `status === 'FAIL'`, so every
  // qualified failure rolled up to an overall verdict of OK.
  const cs = DesignChecks.classifyStatus;
  const cases = [
    ['FAIL',                     'FAIL'], ['FAIL (strut)',        'FAIL'],
    ['FAIL (punching)',          'FAIL'], ['FAIL (uplift)',       'FAIL'],
    ['FAIL (column face)',       'FAIL'], ['FAIL (2d perimeter)', 'FAIL'],
    ['WARN (slender—2nd order)', 'NEAR'], ['NEAR',           'NEAR'],
    ['OK',                       'OK'],   ['OK (no links needed)','OK'],
    ['LINKS REQ.',               'OK'],   ['INFO',                'INFO'],
  ];
  for (const [raw, want] of cases)
    check(`"${raw}" classifies as ${want}`, cs(raw) === want, `got ${cs(raw)}`);
  check('a missing status is treated as informational', cs(undefined) === 'INFO');
}

group('Physically meaningless solutions are refused');
{
  // A near-mechanism is not singular: it factorises cleanly and returns a
  // number. Two collinear members with almost no bending stiffness gave 992 km
  // of mid-span deflection — a well-conditioned answer to a nonsense model.
  const chain = [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 3, x: 5, y: 0 },
                 { id: 2, x: 10, y: 0, support: 'pin' }];
  const cb = [{ id: 1, node1: 1, node2: 3, sectionId: 1 },
              { id: 2, node1: 3, node2: 2, sectionId: 1 }];
  const soft = [{ id: 1, E: 210, A: 100, I: 1e-4, Ix: 1e-4, rho: 0 }];
  const r = solveFrame(chain, cb, soft, [{ type: 'nodal', nodeId: 3, fy: -10 }], []);
  check('a near-mechanism is refused rather than answered', !!r.error,
        r.disp && `v3 = ${r.disp[3].v.toExponential(2)} m`);
  check('and the message says why', /mechanism/i.test(r.error || ''), r.error);

  // The bound must not fire on legitimately flexible structures. This cantilever
  // deflects 91 % of its own span and is a perfectly valid model.
  const flex = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 12, y: 0 }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 }],
    [{ id: 1, E: 210, A: 100, I: 500, Ix: 500, rho: 0 }],
    [{ type: 'nodal', nodeId: 2, fy: -20 }], []);
  check('a very flexible but real structure still solves', !!flex.success, flex.error);
  check('and its deflection is large but finite',
        Number.isFinite(flex.disp[2].v) && Math.abs(flex.disp[2].v) > 1,
        `v = ${flex.disp && flex.disp[2].v}`);
}

group('A footing with no net downward load reports uplift, not NaN');
{
  // ex = Mx/N is undefined at N = 0, and dividing anyway gave ex = Infinity and
  // q = (0/A)·(1 − Infinity) = NaN. That NaN reached bearingCheck's qmax and
  // eta, and the verdict fell out of `NaN < 0` being false — so a footing in
  // full uplift was labelled 'FAIL (overstress)', pointing at the wrong remedy.
  const bp0 = FoundationDesign.bearingPressureSLS(0, 40, 0, 3, 3);
  check('zero axial gives no contact rather than NaN pressures',
        bp0.noContact === true && Number.isFinite(bp0.qmax) && bp0.qmax === 0,
        `qmax = ${bp0.qmax}, ex = ${bp0.ex}`);

  for (const N of [0, -50]) {
    const c = FoundationDesign.bearingCheck(N, 40, 0, 3, 3, 200);
    const keys = ['qmax_kPa', 'qmin_kPa', 'qavg_kPa', 'eta', 'L_eff', 'B_eff'];
    check(`N = ${N} kN: every reported value is finite`,
          keys.every(k => Number.isFinite(c[k])),
          keys.map(k => `${k}=${c[k]}`).join(' '));
    check(`N = ${N} kN: reported as uplift`, c.status === 'FAIL (uplift)', c.status);
    check(`N = ${N} kN: not passed`, c.pass === false);
  }

  // And the ordinary case is untouched: 900 kN concentric on 3 × 3 = 100 kPa.
  const ok = FoundationDesign.bearingCheck(900, 0, 0, 3, 3, 200);
  near('a concentric footing still gives N/A', ok.qmax_kPa, 100, 1e-6);
  check('and passes against a 200 kPa allowable', ok.status === 'OK', ok.status);
  near('with eta = qmax/qa', ok.eta, 0.5, 1e-6);

  // A genuinely overstressed footing must still say overstress, not uplift.
  const over = FoundationDesign.bearingCheck(3000, 0, 0, 3, 3, 200);
  check('an overstressed footing is still reported as overstress',
        over.status === 'FAIL (overstress)', over.status);
}

group('Closed-form beam formulas match the exact elastic solution');
{
  // These feed the Beam Formulas calculator, which is what an engineer checks a
  // hand calc against — so they are verified against numerical integration of
  // y'' = M/EI rather than against themselves.
  const EI = 1e5, L = 10, P = 100, w = 20;

  // Simply supported: integrate from x=0 and remove the linear term so y(0)=y(L)=0.
  const ssDefl = (Mfn, n = 100000) => {
    const h = L / n; const y = new Float64Array(n + 1); let th = 0;
    for (let i = 0; i < n; i++) {
      const t2 = th + (Mfn(i * h) / EI + Mfn((i + 1) * h) / EI) / 2 * h;
      y[i + 1] = y[i] + (th + t2) / 2 * h; th = t2;
    }
    const c = y[n] / L;
    let best = 0;
    for (let i = 0; i <= n; i++) { const v = y[i] - c * (i * h); if (Math.abs(v) > Math.abs(best)) best = v; }
    return Math.abs(best);
  };
  // Fixed / propped: y(0)=y'(0)=0, M already carries the end moment.
  const fixedDefl = (Mfn, n = 100000) => {
    const h = L / n; let th = 0, y = 0, best = 0, yEnd = 0;
    for (let i = 0; i < n; i++) {
      const t2 = th + (Mfn(i * h) / EI + Mfn((i + 1) * h) / EI) / 2 * h;
      y += (th + t2) / 2 * h; th = t2;
      if (Math.abs(y) > Math.abs(best)) best = y;
    }
    yEnd = y;
    return { ymax: Math.abs(best), yEnd };
  };
  const pct = (g, e) => Math.abs(g - e) / Math.abs(e) * 100;

  // ── SS point load: the elastic curve peaks in the LONGER segment, so the
  // case split has to key off which segment that is. Reversed, an 8 m load on
  // a 10 m span came out 19.6 % light.
  for (const a of [5, 3, 2, 7, 8]) {
    const r = BeamFormulas.ss_point(P, L, a);
    check(`ss_point a=${a}m: ymax matches the exact curve`,
          pct(r.deflFormula(EI).ymax, ssDefl(r.M)) < 0.5,
          `${r.deflFormula(EI).ymax} vs ${ssDefl(r.M)}`);
  }
  near('ss_point at mid-span is PL³/48EI',
       BeamFormulas.ss_point(P, L, L / 2).deflFormula(EI).ymax,
       P * L ** 3 / (48 * EI), 1e-9);

  // ── SS triangular: Mmax had dropped the load term (50 % high) and the
  // deflection coefficient was applied to the peak intensity instead of the
  // total load (2x high).
  {
    const r = BeamFormulas.ss_triangular(w, L);
    near('ss_triangular Mmax = w·L²/(9√3)', r.Mmax, w * L * L / (9 * Math.sqrt(3)), 1e-6);
    check('ss_triangular Mmax agrees with its own M(x)',
          pct(r.Mmax, (() => { let m = 0; for (let x = 0; x <= L; x += L / 20000) m = Math.max(m, r.M(x)); return m; })()) < 0.5);
    check('ss_triangular ymax matches the exact curve',
          pct(r.deflFormula(EI).ymax, ssDefl(r.M)) < 0.5,
          `${r.deflFormula(EI).ymax} vs ${ssDefl(r.M)}`);
  }

  // ── Fixed-fixed point load: ymax was 2 × the deflection under the load.
  for (const a of [5, 3, 7]) {
    const r = BeamFormulas.ff_point(P, L, a);
    const num = fixedDefl(r.M);
    check(`ff_point a=${a}m: M(x) satisfies the far-end fixity`,
          Math.abs(num.yEnd) < 1e-9, `y(L) = ${num.yEnd}`);
    check(`ff_point a=${a}m: ymax matches the exact curve`,
          pct(r.deflFormula(EI).ymax, num.ymax) < 0.5,
          `${r.deflFormula(EI).ymax} vs ${num.ymax}`);
  }
  near('ff_point at mid-span is PL³/192EI',
       BeamFormulas.ff_point(P, L, L / 2).deflFormula(EI).ymax,
       P * L ** 3 / (192 * EI), 1e-9);

  // ── Propped cantilever point load: the moment ran to PL/2 at the pin, the
  // shear never stepped under the load, and the deflection was the
  // simply-supported value.
  {
    const r = BeamFormulas.pc_point_end(P, L);
    near('pc_point_end: moment is zero at the prop', r.M(L), 0, 1e-9);
    near('pc_point_end: hogging end moment is 3PL/16', Math.abs(r.MA), 3 * P * L / 16, 1e-9);
    near('pc_point_end: sagging moment is 5PL/32', r.M(L / 2), 5 * P * L / 32, 1e-9);
    near('pc_point_end: shear steps by P under the load',
         r.V(L / 2 - 0.01) - r.V(L / 2 + 0.01), P, 1e-6);
    const num = fixedDefl(r.M);
    check('pc_point_end: the prop end returns to zero deflection',
          Math.abs(num.yEnd) < 1e-9, `y(L) = ${num.yEnd}`);
    check('pc_point_end: ymax matches the exact curve',
          pct(r.deflFormula(EI).ymax, num.ymax) < 0.5,
          `${r.deflFormula(EI).ymax} vs ${num.ymax}`);
  }

  // ── Two-span continuous. Both cases had wrong three-moment terms; RB is
  // formed by difference, so ΣR balanced while the distribution was wrong.
  {
    const r = BeamFormulas.two_span_udl(w, L, L);
    near('two_span_udl: support moment is wL²/8', Math.abs(r.M1), w * L * L / 8, 1e-6);
    near('two_span_udl: end reactions are 3wL/8', r.RA, 3 * w * L / 8, 1e-6);
    near('two_span_udl: middle reaction is 10wL/8', r.RB, 10 * w * L / 8, 1e-6);
    near('two_span_udl: total reaction equals applied load', r.RA + r.RB + r.RC, 2 * w * L, 1e-6);
    near('two_span_udl: span peak is 9wL²/128', r.Mmax_span, 9 * w * L * L / 128, 1e-6);
    check('two_span_udl: the middle support is in compression', r.RB > 0, `RB = ${r.RB}`);
  }
  {
    const r = BeamFormulas.two_span_point_mids(P, L, P, L);
    near('two_span_point_mids: support moment is 3PL/16', Math.abs(r.M1), 3 * P * L / 16, 1e-6);
    near('two_span_point_mids: end reactions are 5P/16', r.RA, 5 * P / 16, 1e-6);
    near('two_span_point_mids: middle reaction is 22P/16', r.RB, 22 * P / 16, 1e-6);
    near('two_span_point_mids: total reaction equals applied load', r.RA + r.RB + r.RC, 2 * P, 1e-6);
    check('two_span_point_mids: the middle support is in compression', r.RB > 0, `RB = ${r.RB}`);
  }

  // ── Cases that were already right, kept so they stay that way.
  near('ss_udl ymax is 5wL⁴/384EI', BeamFormulas.ss_udl(w, L).deflFormula(EI).ymax,
       5 * w * L ** 4 / (384 * EI), 1e-9);
  near('cl_point_end ymax is PL³/3EI', BeamFormulas.cl_point_end(P, L).deflFormula(EI).ymax,
       P * L ** 3 / (3 * EI), 1e-9);
  near('cl_udl ymax is wL⁴/8EI', BeamFormulas.cl_udl(w, L).deflFormula(EI).ymax,
       w * L ** 4 / (8 * EI), 1e-9);
  near('cl_triangular ymax is wL⁴/30EI', BeamFormulas.cl_triangular(w, L).deflFormula(EI).ymax,
       w * L ** 4 / (30 * EI), 1e-9);
  near('ff_udl ymax is wL⁴/384EI', BeamFormulas.ff_udl(w, L).deflFormula(EI).ymax,
       w * L ** 4 / (384 * EI), 1e-9);

  // Reactions must balance the applied load in every case that reports them.
  near('ss_point reactions balance', (r => r.RA + r.RB)(BeamFormulas.ss_point(P, L, 3)), P, 1e-9);
  near('ss_udl reactions balance', (r => r.RA + r.RB)(BeamFormulas.ss_udl(w, L)), w * L, 1e-9);
  near('ss_triangular reactions balance', (r => r.RA + r.RB)(BeamFormulas.ss_triangular(w, L)), w * L / 2, 1e-9);
  near('ss_partial_udl reactions balance',
       (r => r.RA + r.RB)(BeamFormulas.ss_partial_udl(w, L, 2, 6)), w * 4, 1e-9);
  near('pc_udl reactions balance', (r => r.RA + r.RB)(BeamFormulas.pc_udl(w, L)), w * L, 1e-9);
  near('ff_point reactions balance', (r => r.RA + r.RB)(BeamFormulas.ff_point(P, L, 3)), P, 1e-9);
}

group('P-M interaction boundary follows EC3 §6.2.9.1(5)');
{
  // The strong- and weak-axis curves are different equations. Only the weak-axis
  // one was implemented, and it was drawn for both — so the strong-axis envelope
  // came out far too generous.
  const IPE300 = { name: 'IPE300', fy: 275, A: 53.8, Zx: 628, Zy: 125,
                   Ix: 8356, Iy: 604, d: 300, bf: 150, tf: 10.7, tw: 7.1 };
  const p = PMInteraction.sectionParams(IPE300);
  near('a = (A − 2·bf·tf)/A per EC3', p.a, (53.8 - 2 * 15 * 1.07) / 53.8, 1e-6);
  near('Npl = A·fy/10', p.Npl, 53.8 * 275 / 10, 1e-6);
  near('Mpl,y = Wpl·fy/1000', p.Mpl_y, 628 * 275 / 1000, 1e-6);

  const yy = PMInteraction.computeBoundary(p.Npl, p.Mpl_y, 'I', p.a, 20, 'y');
  const zz = PMInteraction.computeBoundary(p.Npl, p.Mpl_z, 'I', p.a, 20, 'z');
  const at = (pts, n) => pts.find(q => Math.abs(q.n - n) < 1e-9).m;

  for (const n of [0, 0.4, 0.5, 0.8, 1.0]) {
    near(`strong axis m(n=${n}) = (1−n)/(1−0.5a)`, at(yy, n),
         Math.max(0, Math.min(1, (1 - n) / (1 - 0.5 * p.a))), 1e-9);
    near(`weak axis m(n=${n}) follows the parabolic branch`, at(zz, n),
         n <= p.a ? 1 : Math.max(0, 1 - ((n - p.a) / (1 - p.a)) ** 2), 1e-9);
  }
  check('the strong-axis curve is the more onerous of the two',
        at(yy, 0.5) < at(zz, 0.5), `y ${at(yy, 0.5)} vs z ${at(zz, 0.5)}`);
  check('strong-axis boundary decreases monotonically',
        yy.every((q, i) => i === 0 || q.m <= yy[i - 1].m + 1e-12));
  near('pure bending gives the full plastic moment', at(yy, 0), 1, 1e-12);
  near('pure compression leaves no moment capacity', at(yy, 1), 0, 1e-12);
}

group('Mohr circle and the two frequency paths');
{
  const m = MohrsCircle.compute(100, 40, 30);
  const c = 70, R = Math.sqrt(30 * 30 + 30 * 30);
  near('circle centre',  m.c, c, 1e-9);
  near('circle radius',  m.R, R, 1e-9);
  near('sigma 1',        m.s1, c + R, 1e-9);
  near('sigma 2',        m.s2, c - R, 1e-9);
  near('tau max',        m.tmax, R, 1e-9);
  near('von Mises',      m.vm, Math.sqrt((c + R) ** 2 - (c + R) * (c - R) + (c - R) ** 2), 1e-9);
  // Pure shear: principal stresses ±τ at 45°.
  const ps = MohrsCircle.compute(0, 0, 50);
  near('pure shear sigma1', ps.s1,  50, 1e-9);
  near('pure shear sigma2', ps.s2, -50, 1e-9);
  near('pure shear angle',  ps.tp,  45, 1e-9);

  // The closed-form beam frequency and the FEM eigensolver are independent
  // implementations; they should land on the same answer for a simple span.
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, rho: 78.5 }];
  const span = 10, nEl = 12;
  const nodes = [], beams = [];
  for (let i = 0; i <= nEl; i++)
    nodes.push({ id: i + 1, x: i * span / nEl, y: 0,
                 support: i === 0 ? 'pin' : (i === nEl ? 'roller' : undefined) });
  for (let i = 0; i < nEl; i++)
    beams.push({ id: i + 1, node1: i + 1, node2: i + 2, sectionId: 1 });

  const closed = NaturalFreq.beamFrequencies(210, 8356, 53.8, span, 78.5, 'SS');
  const fem    = ModeShapeAnalysis.computeModes(nodes, beams, S, 3);
  check('the FEM eigensolver returns modes', !fem.error, fem.error);
  if (!fem.error) {
    const rel = Math.abs(fem.modes[0].freq - closed.modes[0].fn) / closed.modes[0].fn;
    check('closed-form and FEM fundamental frequencies agree', rel < 0.01,
          `closed ${closed.modes[0].fn} Hz vs FEM ${fem.modes[0].freq} Hz`);
  }
  // (βL)² = π² for the fundamental of a simple span.
  near('SS fundamental uses (βL)² = π²', NaturalFreq.BC_COEFF.SS.bl[0], Math.PI ** 2, 1e-3);
  // K = 1000 kN/m on 10 t gives ω = 10 rad/s exactly.
  const s = NaturalFreq.sdofFrequency(1000, 10);
  near('SDOF omega = sqrt(K/m)', s.omega, 10, 1e-6);
  near('SDOF f = omega/2pi', s.fn, 10 / (2 * Math.PI), 1e-3);
}

group('Export and round-trip keep the model intact');
{
  // DXF wrote a literal 0 for every Z ordinate. This app stores height in `z`
  // for Z-lifted models, so a 4 m portal exported as a set of zero-length lines
  // sitting at the origin.
  const nodes = [{ id: 1, x: 0, y: 0, z: 0 }, { id: 2, x: 0, y: 0, z: 4 },
                 { id: 3, x: 6, y: 0, z: 4 }, { id: 4, x: 6, y: 0, z: 0 }];
  const beams = [{ id: 1, node1: 1, node2: 2 }, { id: 2, node1: 2, node2: 3 },
                 { id: 3, node1: 3, node2: 4 }];
  const dxf = FileIO.exportDXF(nodes, beams).split('\n');
  const zs = new Set();
  for (let i = 0; i < dxf.length - 1; i++)
    if (dxf[i] === '30' || dxf[i] === '31') zs.add(parseFloat(dxf[i + 1]));
  check('DXF carries the real Z ordinates', zs.has(4), `wrote Z values: ${[...zs]}`);

  // No member may export as a zero-length line.
  let degenerate = 0;
  for (let i = 0; i < dxf.length; i++) {
    if (dxf[i] !== 'LINE') continue;
    const g = {};
    for (let j = i + 1; j < Math.min(i + 20, dxf.length - 1); j += 2) {
      if (dxf[j] === '0') break;
      g[dxf[j]] = parseFloat(dxf[j + 1]);
    }
    if (g['10'] === g['11'] && g['20'] === g['21'] && g['30'] === g['31']) degenerate++;
  }
  check('no member exports as a zero-length line', degenerate === 0,
        `${degenerate} degenerate LINE entities`);

  // JSON round-trip must preserve everything the solver and design checks read.
  const state = {
    nodes: [{ id: 1, x: 0, y: 0, support: 'spring', springKx: 10, springKy: 5000, springKm: 0,
              fixedDOF: [1, 1, 1, 0, 0, 0] },
            { id: 2, x: 6, y: 0, z: 3 }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1, modifiers: { fi3: 0.35, f11: 0.7 },
              Ky: 0.8, Kz: 1.2, spanType: 'cantilever', memberType: 'column' }],
    sections: [{ id: 1, name: 'S', E: 210, A: 100, I: 20000, Ix: 20000, Iy: 500,
                 J: 100, rho: 78.5, fy: 355, rigidZone: true, d: 300, bf: 150,
                 tf: 10.7, tw: 7.1 }],
    loads: [{ id: 1, type: 'beam_point', elementId: 1, fy: -60, pos: 1.5, caseId: 2 }],
    settlements: [{ nodeId: 1, dir: 'v', value: -0.01 }],
    loadCases: [{ id: 2, name: 'Dead', type: 'DL' }],
    loadCombos: [{ id: 1, name: 'ULS', factors: { 2: 1.35 } }],
    nextId: { node: 3, beam: 2, load: 2, section: 2 },
    meta: { title: 'T', engineer: 'E' }
  };
  const back = FileIO.importJSON(FileIO.exportJSON(state));
  check('round-trip preserves spring stiffnesses',
        back.nodes[0].springKy === 5000 && back.nodes[0].springKx === 10);
  check('round-trip preserves the custom 3D DOF mask',
        JSON.stringify(back.nodes[0].fixedDOF) === '[1,1,1,0,0,0]');
  check('round-trip preserves node z', back.nodes[1].z === 3);
  check('round-trip preserves member modifiers',
        back.beams[0].modifiers.fi3 === 0.35 && back.beams[0].modifiers.f11 === 0.7);
  check('round-trip preserves K factors and member type',
        back.beams[0].Ky === 0.8 && back.beams[0].memberType === 'column');
  check('round-trip preserves the rigid-zone flag', back.sections[0].rigidZone === true);
  check('round-trip preserves load position in metres', back.loads[0].pos === 1.5);
  check('round-trip preserves settlements', back.settlements[0].value === -0.01);
  check('round-trip preserves load cases and combinations',
        back.loadCases[0].type === 'DL' && back.loadCombos[0].factors['2'] === 1.35);

  // A future schema must not be run through the v1 migration. String comparison
  // would make '10.0' < '2.0' true.
  const future = JSON.parse(FileIO.exportJSON(state));
  future._schema = '10.0';
  future.loads[0].caseId = 7;
  const f2 = FileIO.importJSON(JSON.stringify(future));
  check('a future schema version is not down-migrated', f2.loads[0].caseId === 7,
        `caseId came back as ${f2.loads[0].caseId}`);
}

group('Report diagrams reproduce the internal forces');
{
  // The report re-derives M(x), V(x) and N(x) from the local end forces. It read
  // the GLOBAL ld.fy straight into the transverse terms, never looked at ld.fx,
  // carried a spurious −w·L·x/2, and started the moment sweep from +M1 instead
  // of −M1. A simply supported 8 m beam under 10 kN/m plotted 240 kNm at
  // mid-span against the true 80, and 320 at the support where it is zero.
  const S = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, rho: 0 }];
  const sample = (ef, t) => ReportGenerator.sampleInternalForces(ef, t, 20);
  const at = (arr, x, L) => arr[Math.round(x / L * 20)];
  const solve1 = (nodes, lds) => solveFrame(
    nodes, [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S, lds, []).elemForces[0];

  // Simply supported span under a UDL — the textbook parabola.
  {
    const ef = solve1([{ id: 1, x: 0, y: 0, support: 'pin' },
                       { id: 2, x: 8, y: 0, support: 'roller' }],
                      [{ type: 'beam_dist', elementId: 1, fy: -10 }]);
    const M = sample(ef, 'BMD'), V = sample(ef, 'SFD');
    near('SS beam: M at mid-span is wL²/8', Math.abs(at(M, 4, 8)), 80, 0.01);
    near('SS beam: M at the support is zero', at(M, 8, 8), 0, 0.01);
    near('SS beam: V at the support is wL/2', Math.abs(at(V, 0, 8)), 40, 0.01);
    near('SS beam: V crosses zero at mid-span', at(V, 4, 8), 0, 0.01);
  }
  // Central point load — PL/4, and zero at both supports.
  {
    const ef = solve1([{ id: 1, x: 0, y: 0, support: 'pin' },
                       { id: 2, x: 8, y: 0, support: 'roller' }],
                      [{ type: 'beam_point', elementId: 1, fy: -100, pos: 4 }]);
    const M = sample(ef, 'BMD');
    near('point load: M at mid-span is PL/4', Math.abs(at(M, 4, 8)), 200, 0.01);
    near('point load: M at the support is zero', at(M, 8, 8), 0, 0.01);
  }
  // Column under its own weight: axial only, no bending anywhere.
  {
    const ef = solve1([{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 8 }],
                      [{ type: 'beam_dist', elementId: 1, fy: -10 }]);
    const M = sample(ef, 'BMD'), N = sample(ef, 'NFD');
    near('column under gravity: no moment at mid-height', at(M, 4, 8), 0, 0.01);
    near('column under gravity: axial is full at the base', at(N, 0, 8), -80, 0.01);
    near('column under gravity: axial dies out at the top', at(N, 8, 8), 0, 0.01);
  }
  // Column under a horizontal UDL: real bending, entirely from fx.
  {
    const ef = solve1([{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 8 }],
                      [{ type: 'beam_dist', elementId: 1, fx: 5, fy: 0 }]);
    const M = sample(ef, 'BMD'), V = sample(ef, 'SFD');
    near('column under wind: M at the base is wL²/2', Math.abs(at(M, 0, 8)), 160, 0.01);
    near('column under wind: M at the free top is zero', at(M, 8, 8), 0, 0.01);
    near('column under wind: V at the base is wL', Math.abs(at(V, 0, 8)), 40, 0.01);
    near('column under wind: V at the free top is zero', at(V, 8, 8), 0, 0.01);
  }
  // Inclined member — only a correct projection closes the far end.
  {
    const ef = solve1([{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 6, y: 8 }],
                      [{ type: 'beam_dist', elementId: 1, fy: -10 }]);
    const M = sample(ef, 'BMD');
    near('inclined member: M closes to zero at the free end', at(M, ef.L, ef.L), 0, 0.01);
    near('inclined member: M at the fixed end matches the solver',
         Math.abs(at(M, 0, ef.L)), Math.abs(ef.M1), 0.01);
  }

  // General invariant, independent of any textbook case: whatever the member
  // orientation or load mix, the sampled diagram must start and finish on the
  // solver's own end forces. Sagging-positive means M runs from −M1 to −M2,
  // while V runs from V1 to V2.
  {
    const portal = {
      nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 },
              { id: 3, x: 6, y: 6 }, { id: 4, x: 9, y: 0, support: 'pin' }],
      beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
              { id: 2, node1: 2, node2: 3, sectionId: 1 },
              { id: 3, node1: 3, node2: 4, sectionId: 1 }]
    };
    const lds = [
      { type: 'beam_dist',  elementId: 1, fx: 4,  fy: 0 },      // wind on the column
      { type: 'beam_dist',  elementId: 2, fx: 0,  fy: -12 },    // gravity on the rafter
      { type: 'beam_dist',  elementId: 2, fx: 0,  fy: -3 },     // a second load on the same member
      { type: 'beam_trap',  elementId: 3, fy: -5, fy2: -15 },   // varying load on the inclined leg
      { type: 'beam_point', elementId: 2, fy: -40, pos: 2.5 }
    ];
    const res = solveFrame(portal.nodes, portal.beams, S, lds, []);
    check('the mixed-load frame solves', !!res.success, res.error);
    if (res.success) {
      let wM0 = 0, wML = 0, wV0 = 0, wVL = 0, bad = 0;
      for (const ef of res.elemForces) {
        const M = sample(ef, 'BMD'), V = sample(ef, 'SFD'), N = sample(ef, 'NFD');
        if ([...M, ...V, ...N].some(v => !Number.isFinite(v))) { bad++; continue; }
        wM0 = Math.max(wM0, Math.abs(M[0]  - (-ef.M1)));
        wML = Math.max(wML, Math.abs(M[20] - (-ef.M2)));
        wV0 = Math.max(wV0, Math.abs(V[0]  -   ef.V1));
        wVL = Math.max(wVL, Math.abs(V[20] -   ef.V2));
      }
      check('no diagram produces a non-finite ordinate', bad === 0, `${bad} members`);
      check('M starts on −M1 for every member', wM0 < 1e-9, `worst ${wM0}`);
      check('M closes on −M2 for every member', wML < 1e-9, `worst ${wML}`);
      check('V starts on V1 for every member',  wV0 < 1e-9, `worst ${wV0}`);
      check('V closes on V2 for every member',  wVL < 1e-9, `worst ${wVL}`);
    }
  }
}

group('Every generated template is sound geometry that solves');
{
  // The generator checks above read the SOURCE TEXT — they confirm resetModel is
  // called but never run a template. Nothing exercised the geometry, and the
  // Fink truss shipped with two coincident nodes joined by zero-length members
  // at the eaves (the roof profile is zero there, so the top node landed on the
  // tie), plus web indices derived as N/4 without rounding — a 6-panel truss
  // asked for top[1.5] and produced four members pointing at a node id that did
  // not exist.
  const genSrc = fs.readFileSync(path.join(ROOT, 'js/core/generators.js'), 'utf8');
  const gctx = {
    console, Math, JSON, Number, Date, isFinite, parseFloat, parseInt,
    Float64Array, Array, Object, Set, Map, Infinity, NaN, String, Boolean, RegExp,
    setTimeout: fn => { try { fn(); } catch (e) { /* stubbed timer */ } },
    requestAnimationFrame: fn => { try { fn(); } catch (e) { /* stubbed */ } },
  };
  const stubEl = { style: {}, value: '', checked: false, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, click() {} };
  gctx.document = { getElementById: () => stubEl, querySelector: () => stubEl,
    querySelectorAll: () => [], createElement: () => stubEl, body: stubEl };
  vm.createContext(gctx);
  gctx.window = gctx;
  vm.runInContext(genSrc, gctx, { filename: 'js/core/generators.js' });
  const Gen = gctx.Generators ||
              Object.values(gctx).find(v => v && typeof v === 'object' && v.generateFrame);

  const SECG = [{ id: 1, name: 'S', E: 210, A: 100, I: 20000, Ix: 20000,
                  Iy: 5000, J: 100, rho: 78.5, fy: 355 }];
  const makeApp = () => {
    const a = {
      nodes: [], beams: [], loads: [], settlements: [], sections: SECG.slice(),
      loadCases: [{ id: 1, name: 'Dead', type: 'DL' }], loadCombos: [], results: null,
      selNode: null, selBeam: null, multiSel: { nodes: new Set(), beams: new Set() },
      nextId: { node: 1, beam: 1, load: 1, section: 2, settlement: 1, lcase: 2, combo: 1 },
      mode: '2d', view: {},
      addNode(x, y) { const id = a.nextId.node++; a.nodes.push({ id, x, y }); return id; },
      addBeam(n1, n2) { const id = a.nextId.beam++; a.beams.push({ id, node1: n1, node2: n2, sectionId: 1 }); return id; },
      findNode: id => a.nodes.find(n => n.id === id),
      findBeam: id => a.beams.find(b => b.id === id),
      allocSectionId: () => a.nextId.section++,
      snapshot() {}, clearResults() { a.results = null; }, render() {}, fitToScreen() {},
      updateNodeTable() {}, updateBeamTable() {}, updateLoadTable() {}, updateSectionTable() {},
      toast() {}
    };
    return a;
  };

  const TEMPLATES = [
    ['frame 2×2 fixed',   () => Gen.generateFrame(2, 2, 6, 4, 'fixed')],
    ['frame 3×1 pinned',  () => Gen.generateFrame(3, 1, 5, 3.5, 'pin')],
    ['truss pratt',       () => Gen.generateTruss('pratt', 6, 2, 2.5)],
    ['truss howe',        () => Gen.generateTruss('howe', 6, 2, 2.5)],
    ['truss warren',      () => Gen.generateTruss('warren', 6, 2, 2.5)],
    ['truss king',        () => Gen.generateTruss('king', 4, 2, 2.5)],
    ['truss fink 4 panel',() => Gen.generateTruss('fink', 4, 2, 2.5)],
    ['truss fink 6 panel',() => Gen.generateTruss('fink', 6, 2, 2.5)],
    ['truss fink 8 panel',() => Gen.generateTruss('fink', 8, 2, 2.5)],
    ['continuous beam',   () => Gen.generateContinuousBeam(3, 6, -10, 'pin-roller')],
    ['simple beam',       () => Gen.generateSimpleBeam(8, 'pin', -10, -50, 4)],
    ['braced frame',      () => Gen.generateBracedFrame(2, 2, 6, 4, 'fixed', 'x')],
    ['arch',              () => Gen.generateArch(20, 4, 10, 'parabolic')],
    ['floor grid',        () => Gen.generateFloorGrid(3, 3, 5, 5, true)],
    ['vierendeel',        () => Gen.generateVierendeel(5, 3, 3, true)],
    ['lean-to',           () => Gen.generateLeanTo(2, 6, 4, 6, 'fixed')],
    ['column line',       () => Gen.generateColumnLine(4, 5, 4, true)],
  ];

  check('the generator module loads', !!Gen, 'Generators namespace not found');
  for (const [name, run] of TEMPLATES) {
    const app = makeApp();
    gctx.window.SA = app;
    let threw = null;
    try { run(); } catch (e) { threw = e.message; }
    if (threw) { check(`${name} generates without throwing`, false, threw); continue; }

    const N = app.nodes, B = app.beams;
    check(`${name} produces geometry`, N.length > 1 && B.length > 0,
          `${N.length} nodes, ${B.length} beams`);

    // No two members on the same node pair — a duplicate silently doubles that
    // element's stiffness in the assembled matrix.
    const pairs = new Set(); let dup = 0;
    for (const b of B) {
      const k = [b.node1, b.node2].sort((x, y) => x - y).join('-');
      if (pairs.has(k)) dup++; pairs.add(k);
    }
    check(`${name} has no duplicate members`, dup === 0, `${dup} duplicated`);

    // No two nodes at the same point.
    const seen = new Set(); let coincident = 0;
    for (const n of N) {
      const k = `${(n.x || 0).toFixed(6)},${(n.y || 0).toFixed(6)},${(n.z || 0).toFixed(6)}`;
      if (seen.has(k)) coincident++; seen.add(k);
    }
    check(`${name} has no coincident nodes`, coincident === 0, `${coincident} duplicated`);

    // Every member must reference real nodes and have a real length.
    let orphan = 0, zero = 0;
    for (const b of B) {
      const a = N.find(n => n.id === b.node1), c = N.find(n => n.id === b.node2);
      if (!a || !c) { orphan++; continue; }
      const dy = (a.y || 0) - (c.y || 0), dz = (a.z || 0) - (c.z || 0);
      if (Math.hypot((a.x || 0) - (c.x || 0), Math.abs(dy) > 1e-12 ? dy : dz) < 1e-9) zero++;
    }
    check(`${name} has no members on missing nodes`, orphan === 0, `${orphan} orphaned`);
    check(`${name} has no zero-length members`, zero === 0, `${zero} degenerate`);

    // And the template must actually be solvable under gravity, in equilibrium.
    const lds = B.map((b, i) => ({ id: i + 1, type: 'beam_dist', elementId: b.id, fy: -10 }));
    const res = solveFrame(N, B, SECG, lds, []);
    check(`${name} solves under gravity`, !!res.success, res.error);
    if (res.success) {
      let sumRy = 0;
      for (const k in res.reactions) sumRy += res.reactions[k].Ry;
      const applied = res.elemForces.reduce((t, ef) => t + 10 * ef.L, 0);
      check(`${name} is in vertical equilibrium`,
            Math.abs(sumRy - applied) < 1e-6 * Math.max(1, applied),
            `ΣRy ${sumRy.toFixed(3)} vs applied ${applied.toFixed(3)}`);
    }
  }

  // An unrecognised support style used to fall through every branch and leave
  // the beam with no supports at all.
  {
    const app = makeApp();
    gctx.window.SA = app;
    Gen.generateContinuousBeam(3, 6, -10, 'not-a-style');
    check('an unknown support style still yields a supported beam',
          app.nodes.some(n => n.support && n.support !== 'none'),
          'no node received a support');
  }
}

group('Section library data is internally consistent');
{
  // A hand-entered property table is exactly where transcription errors hide,
  // and nothing was checking it. Three separate faults were present:
  //   • IPE 80 / IPE 100 carried the ELASTIC modulus in the plastic (Zx) slot,
  //     leaving Sx 14 % light — and Sx drives Class 3/4 flexural capacity;
  //   • 45 of the 49 UB sections had a wrong weak-axis elastic modulus;
  //   • the glulam sections had Ix ten times too large, so a timber member came
  //     out ten times too stiff, and the RC rectangles had their moduli ten
  //     times too small while the RC circles had Ix ten times too large.
  // These identities are exact for the shapes involved, so they hold as
  // assertions rather than tolerances.
  const groups = SectionDB.groups;
  const I_GROUPS = ['IPE', 'HEA', 'HEB', 'UB', 'UC'];
  const pct = (g, e) => Math.abs(g - e) / Math.abs(e) * 100;
  const bad = { rx: [], ry: [], Sx: [], Sy: [], shape: [], axis: [], nonPos: [] };

  for (const [gname, items] of Object.entries(groups)) {
    for (const s of items) {
      for (const k of ['A', 'Ix', 'Iy', 'Sx', 'Zx', 'd', 'bf'])
        if (s[k] !== undefined && (!Number.isFinite(s[k]) || s[k] <= 0))
          bad.nonPos.push(`${gname}/${s.name}.${k}=${s[k]}`);

      // Radius of gyration is r = sqrt(I/A) by definition — no shape assumed.
      if (s.A > 0 && s.Ix > 0 && s.rx > 0 && pct(s.rx, Math.sqrt(s.Ix / s.A)) > 2)
        bad.rx.push(`${gname}/${s.name}: ${s.rx} vs ${Math.sqrt(s.Ix / s.A).toFixed(2)}`);
      if (s.A > 0 && s.Iy > 0 && s.ry > 0 && pct(s.ry, Math.sqrt(s.Iy / s.A)) > 2)
        bad.ry.push(`${gname}/${s.name}: ${s.ry} vs ${Math.sqrt(s.Iy / s.A).toFixed(2)}`);

      // Elastic modulus about each axis, exact for a doubly symmetric shape.
      if (s.Ix > 0 && s.d > 0 && s.Sx > 0 && pct(s.Sx, s.Ix / (s.d / 20)) > 4)
        bad.Sx.push(`${gname}/${s.name}: ${s.Sx} vs ${(s.Ix / (s.d / 20)).toFixed(1)}`);
      if (I_GROUPS.includes(gname) && s.Iy > 0 && s.bf > 0 && s.Sy > 0 &&
          pct(s.Sy, s.Iy / (s.bf / 20)) > 4)
        bad.Sy.push(`${gname}/${s.name}: ${s.Sy} vs ${(s.Iy / (s.bf / 20)).toFixed(1)}`);

      // Plastic/elastic shape factor: 1.10–1.20 for a rolled I, 1.5 for a solid
      // rectangle, 1.7 for a circle. Anything outside a generous band means the
      // two moduli have been swapped or scaled.
      if (s.Zx > 0 && s.Sx > 0) {
        const f = s.Zx / s.Sx;
        const hi = I_GROUPS.includes(gname) ? 1.35 : 1.75;
        if (f < 1.02 || f > hi)
          bad.shape.push(`${gname}/${s.name}: Zx/Sx = ${f.toFixed(3)}`);
      }
      if (s.Ix > 0 && s.Iy > 0 && s.Ix < s.Iy)
        bad.axis.push(`${gname}/${s.name}: Ix ${s.Ix} < Iy ${s.Iy}`);
    }
  }

  check(`all ${SectionDB.all.length} sections have positive properties`,
        bad.nonPos.length === 0, bad.nonPos.slice(0, 4).join('; '));
  check('rx = sqrt(Ix/A) for every section', bad.rx.length === 0,
        `${bad.rx.length} off: ${bad.rx.slice(0, 3).join('; ')}`);
  check('ry = sqrt(Iy/A) for every section', bad.ry.length === 0,
        `${bad.ry.length} off: ${bad.ry.slice(0, 3).join('; ')}`);
  check('Sx = Ix/(d/2) for every section', bad.Sx.length === 0,
        `${bad.Sx.length} off: ${bad.Sx.slice(0, 3).join('; ')}`);
  check('Sy = Iy/(bf/2) for every I-section', bad.Sy.length === 0,
        `${bad.Sy.length} off: ${bad.Sy.slice(0, 3).join('; ')}`);
  check('plastic/elastic shape factors are physical', bad.shape.length === 0,
        `${bad.shape.length} off: ${bad.shape.slice(0, 3).join('; ')}`);
  check('Ix is the strong axis everywhere', bad.axis.length === 0,
        bad.axis.slice(0, 3).join('; '));

  // Solid shapes are exact — check a rectangle and a circle against first
  // principles rather than against a tolerance.
  const rc = SectionDB.all.find(s => s.name === 'RC 300×600');
  if (rc) {
    near('RC 300×600 area',    rc.A,  30 * 60, 1);
    near('RC 300×600 Ix',      rc.Ix, 30 * Math.pow(60, 3) / 12, 1);
    near('RC 300×600 elastic', rc.Sx, 30 * 60 * 60 / 6, 1);
    near('RC 300×600 plastic', rc.Zx, 30 * 60 * 60 / 4, 1);
  }
  const circ = SectionDB.all.find(s => s.name === 'Circ Ø300');
  if (circ) {
    near('Circ Ø300 area', circ.A,  Math.PI * 30 * 30 / 4, 1);
    near('Circ Ø300 Ix',   circ.Ix, Math.PI * Math.pow(30, 4) / 64, 1);
    near('Circ Ø300 rx',   circ.rx, 30 / 4, 0.05);
  }
  const gl = SectionDB.all.find(s => s.name === 'GL 200×400');
  if (gl) {
    near('GL 200×400 Ix', gl.Ix, 20 * Math.pow(40, 3) / 12, 1);
    near('GL 200×400 rx', gl.rx, 40 / Math.sqrt(12), 0.02);
  }
  // A known steel section against its published values.
  const ipe = SectionDB.all.find(s => s.name === 'IPE 300');
  if (ipe) {
    near('IPE 300 Wel,y', ipe.Sx, 557, 1);
    near('IPE 300 Wpl,y', ipe.Zx, 628, 1);
  }
  const ipe80 = SectionDB.all.find(s => s.name === 'IPE 80');
  if (ipe80) {
    near('IPE 80 Wel,y', ipe80.Sx, 20.0, 0.1);
    near('IPE 80 Wpl,y', ipe80.Zx, 23.2, 0.1);
  }

  // shearAreaY returned m², not the cm² its caller assumed, so Av reached
  // Vpl,Rd a hundred times too small. checks.js has an inline fallback for when
  // SectionDB is missing and that one was right — which is exactly why this hid:
  // the suite did not load sections.js, so it exercised the correct path while
  // the browser, where SectionDB always exists, used the broken one. Pin the two
  // implementations to each other and to the published figure.
  {
    const ipe300 = SectionDB.all.find(s => s.name === 'IPE 300');
    near('shearAreaY returns cm² (IPE 300 Av = 25.7 cm²)',
         SectionDB.shearAreaY(ipe300), 25.67, 0.1);

    // The library rows carry geometry only — E, fy and rho come from the model.
    const S3 = { ...ipe300, id: 1, E: 210, fy: 275, rho: 78.5, _type: 'I',
                 I: ipe300.Ix, rz: ipe300.ry, ry: ipe300.rx };
    const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 2, y: 0 }];
    const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
    const res = solveFrame(nds, bms, [S3], [{ type: 'nodal', nodeId: 2, fy: -100 }], []);
    check('the IPE 300 cantilever solves', !!res.success, res.error);
    const dr = res.success ? DesignChecks.runDesignChecks(res, bms, [S3]) : null;
    const sh = dr ? dr.byBeam[0].checks.find(c => c.check === 'Shear') : null;
    check('the shear check ran', !!sh, 'no Shear check produced');
    if (sh) {
      near('the shear check uses that same Av', sh.Av_cm2, 25.67, 0.1);
      near('Vpl,Rd = Av·fy/(√3·γM0)', sh.Vpl_Rd, 25.67e-4 * 275e3 / Math.sqrt(3), 1);
      check('a 100 kN shear on an IPE 300 is a quarter utilised, not 24x',
            sh.eta > 0.2 && sh.eta < 0.3, `eta = ${sh.eta}`);
    }
  }
}

group('Frame-section properties survive the trip to the solver');
{
  // _compute() works out A, I33, I22, J, S33, S22, R33 and R22, and _flatten()
  // must hand ALL of it to the solver-facing fields. When only A and I33 were
  // forwarded, everything else hit the consumers' invented defaults: checks.js
  // substituted Iy = 1000 cm⁴, Zx = 1000 cm³ and radii of 5 cm / 2 cm, and
  // solveFrame3D took Iy = Ix with J ≈ 0. For a 300×600 rectangle the EC3 check
  // ran on Iy = 1000 against a true 135 000, giving χz = 0.011 and a member
  // reading 90 % utilised that is actually at 1.4 %.
  //
  // The module holds no sections of its own any more — the store IS
  // window.SA.sections — so the fixture provides the model first and asks
  // FRAME_SEC.init() to seed and compute into it.
  const fsSrc = fs.readFileSync(path.join(ROOT, 'js/features/frame_sections.js'), 'utf8');
  const stubEl = { style: {}, value: '', checked: false, textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, querySelector: () => null,
    querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
    click() {}, focus() {} };
  const store = {};
  const fctx = {
    console, Math, JSON, Number, Date, isFinite, isNaN, parseFloat, parseInt,
    Float64Array, Array, Object, Set, Map, Infinity, NaN, String, Boolean, RegExp,
    setTimeout: () => {}, clearTimeout: () => {}, addEventListener: () => {},
    localStorage: { getItem: k => store[k] || null,
                    setItem: (k, v) => { store[k] = String(v); },
                    removeItem: k => { delete store[k]; } },
    document: { getElementById: () => stubEl, querySelector: () => stubEl,
                querySelectorAll: () => [], createElement: () => stubEl, body: stubEl },
  };
  vm.createContext(fctx);
  fctx.window = fctx;
  vm.runInContext(fsSrc, fctx, { filename: 'js/features/frame_sections.js' });
  const FS = fctx.FRAME_SEC;
  check('the frame-section module loads', !!FS && typeof FS.getSections === 'function');

  if (FS) {
    // One store: the model owns the sections and the module writes into it.
    let _nextSec = 1;
    fctx.window.SA = {
      sections: [], materials: [], nextId: { section: 1 },
      allocSectionId: () => _nextSec++,
      updateSectionTable() {}, render() {}, snapshot() {}, toast() {},
    };
    FS.init();

    const secs = FS.getSections();
    check('the module reads and writes the model array',
          secs === fctx.window.SA.sections, 'getSections() returned a private copy');

    const src = secs.find(s => s.name === 'ConcBm-300x600');
    check('a 300×600 rectangle is present with computed properties',
          !!(src && src.props && src.props.I22 > 0), 'fixture section missing');

    // The definition and the solver-facing fields live on the SAME object, so
    // there is nothing left to sync and nothing that can drift apart.
    const out = src;
    check('the section reaches the solver list', !!out, 'nothing seeded');

    if (out && src) {
      const p = src.props;
      near('area is forwarded',                out.A,  p.A,   1e-9);
      near('major-axis inertia is forwarded',  out.Ix, p.I33, 1e-9);
      near('MINOR-axis inertia is forwarded',  out.Iy, p.I22, 1e-9);
      near('torsion constant is forwarded',    out.J,  p.J,   1e-9);
      near('major elastic modulus is forwarded', out.Sx, p.S33, 1e-9);
      near('major radius of gyration is forwarded', out.rx, p.R33, 1e-9);
      near('minor radius of gyration is forwarded', out.ry, p.R22, 1e-9);

      // And those must be the values the design checks actually consume — not
      // the fallbacks.
      const S = { ...out, E: 210, fy: 275, rho: 78.5, _type: 'I' };
      const m = DesignChecks.getSectionModuli(S);
      near('the design checks read the real Iy', m.Iy * 1e8, 135000, 1);
      near('and the real major radius (√(Ix/A))', m.ry * 100, Math.sqrt(540000 / 1800), 0.01);
      near('and the real minor radius (√(Iy/A))', m.rz * 100, Math.sqrt(135000 / 1800), 0.01);
      check('the minor-axis inertia is not the 1000 cm⁴ placeholder',
            Math.abs(m.Iy * 1e8 - 1000) > 1, `Iy = ${m.Iy * 1e8}`);
    }

    // ── The dialog must not overwrite the model ────────────────────
    // This module used to keep its own copy of the sections in localStorage
    // and push it into window.SA on close AND on a 1.5 s timer after every
    // page load, matching by name and assigning field by field. Anything the
    // user typed in the Sections table — or loaded from a .frame file — was
    // reverted to whatever that browser's copy happened to say, and the solver
    // then ran on the reverted numbers.
    {
      const SA = fctx.window.SA;

      // A GENERAL section: no shape, properties entered directly. Nothing may
      // ever recompute or overwrite these.
      SA.sections.push({ id: 9001, name: 'Typed by hand', A: 1234, I: 555555,
                         Ix: 555555, E: 99, fy: 111, rho: 22 });
      FS.init();
      FS.closeList();
      const gen = SA.sections.find(x => x.id === 9001);
      check('a hand-entered section survives init()',   gen && gen.A === 1234 && gen.I === 555555,
            gen ? `A = ${gen.A}, I = ${gen.I}` : 'section gone');
      check('and survives closing the dialog',          gen && gen.E === 99 && gen.fy === 111,
            gen ? `E = ${gen.E}, fy = ${gen.fy}` : 'section gone');
      check('and keeps no shape it did not ask for',    gen && !gen.shapeId, 'a shapeId appeared');

      // A PARAMETRIC section is the other half of the contract: its properties
      // are DERIVED, so they must track its dimensions exactly.
      const para = SA.sections.find(x => x.name === 'ConcBm-300x600');
      near('a parametric section derives A from its dimensions',
           para.A, para.d * para.b / 100, 1e-6);
      near('and derives I from them too',
           para.I, para.b * Math.pow(para.d, 3) / 12 / 1e4, 1);

      // Section count is stable across repeated inits — the seeding path used
      // to run on every load and could duplicate the presets.
      const before = SA.sections.length;
      FS.init(); FS.init();
      check('init() is idempotent', SA.sections.length === before,
            `${before} → ${SA.sections.length}`);
    }
  }

  // The radii are derived from I and A rather than read from an ambiguously
  // named field: SectionDB calls the major-axis radius `rx` while checks.js
  // wanted it as `ry`, so every library section reported its major-axis KL/r
  // using the MINOR radius — about 3.7x too slender for an IPE 300.
  {
    const ipe = SectionDB.all.find(s => s.name === 'IPE 300');
    const m = DesignChecks.getSectionModuli({ ...ipe, E: 210, fy: 275 });
    near('library section: major radius is sqrt(Ix/A)', m.ry * 100,
         Math.sqrt(ipe.Ix / ipe.A), 0.02);
    near('library section: minor radius is sqrt(Iy/A)', m.rz * 100,
         Math.sqrt(ipe.Iy / ipe.A), 0.02);
    check('the major radius is the larger of the two', m.ry > m.rz,
          `${m.ry} vs ${m.rz}`);
  }
}

group('A simply supported beam is designed for its SPAN moment, not its ends');
{
  // The flexure and combined checks took M_Ed = max(|M1|, |M2|) — the END
  // moments — despite a comment claiming "max of ends + mid-span". Both ends of
  // a simply supported span are zero by definition, so every such beam was
  // checked at M_Ed = 0 and reported eta = 0.000, status OK, however heavily
  // loaded. Hand values for w = 10 kN/m over L = 6 m, E = 200 GPa, I = 20000 cm4:
  //   R      = wL/2      = 30 kN
  //   M_max  = wL^2/8    = 45 kNm      (at mid-span)
  //   V_end  = wL/2      = 30 kN
  //   theta  = wL^3/24EI = 2.25 mrad
  //   delta  = 5wL^4/384EI = 4.2188 mm (at mid-span)
  const w = 10, L = 6;
  const sec = { id: 1, name: 'TEST', E: 200, A: 100, I: 20000, Ix: 20000, fy: 355, rho: 78.5 };
  const nds = [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: L, y: 0, support: 'roller' }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const lds = [{ id: 1, type: 'beam_dist', caseId: 1, elementId: 1, fx: 0, fy: -w, m: 0 }];
  const res = solveFrame(nds, bms, [sec], lds, []);
  check('the beam solves', !!res.success, res.error);

  if (res.success) {
    const EI = 200e6 * 20000e-8;                    // 40 000 kNm2
    near('each reaction is wL/2',      res.reactions[1].Ry, w * L / 2, 1e-6);
    near('and so is the other',        res.reactions[2].Ry, w * L / 2, 1e-6);
    near('end rotation is wL^3/24EI',  Math.abs(res.disp[1].theta), w * L ** 3 / (24 * EI), 1e-9);

    const ef = res.elemForces[0];
    check('both end moments are zero', Math.abs(ef.M1) < 1e-9 && Math.abs(ef.M2) < 1e-9,
          `M1 = ${ef.M1}, M2 = ${ef.M2}`);

    // The span moment the ends cannot show.
    const bmd = DesignChecks.sampleInternalForces(ef, 'BMD', 20);
    near('mid-span moment is wL^2/8', bmd[10], w * L * L / 8, 1e-6);
    near('designMoment() returns the SPAN maximum, not 0',
         DesignChecks.designMoment(ef), w * L * L / 8, 1e-6);
    check('the old end-only rule would have given zero',
          Math.max(Math.abs(ef.M1), Math.abs(ef.M2)) === 0);

    const sfd = DesignChecks.sampleInternalForces(ef, 'SFD', 20);
    near('shear at end 1 is +wL/2', sfd[0],  w * L / 2, 1e-6);
    near('shear at end 2 is -wL/2', sfd[20], -w * L / 2, 1e-6);
    near('shear at mid-span is zero', sfd[10], 0, 1e-9);

    const dr = DesignChecks.runDesignChecks(res, bms, [sec]);
    const flex = dr.byBeam[0].checks.find(c => c.check === 'Flexure');
    near('the flexure check is run on 45 kNm', flex.M_Ed, w * L * L / 8, 1e-6);
    check('and therefore reports a non-zero utilisation', flex.eta > 0.01,
          `eta = ${flex.eta}`);

    const defl = dr.byBeam[0].checks.find(c => c.check === 'Deflection');
    near('peak deflection is 5wL^4/384EI',
         defl.v_max_mm, 5 * w * L ** 4 / (384 * EI) * 1000, 0.01);
    near('and it is found at mid-span', defl.at_x_m, L / 2, 0.16);
  }

  // A section modulus that is neither given nor derivable is a placeholder, and
  // a placeholder must not silently become the bending capacity.
  {
    const noDepth = { A: 100, Ix: 20000, fy: 355, E: 200 };
    const m1 = DesignChecks.getSectionModuli(noDepth);
    check('an underdefined section is flagged, not silently defaulted', m1.SxAssumed === true);

    // With a depth, W_el = I/(d/2) is real geometry, not a guess.
    const d600 = { A: 1800, Ix: 540000, d: 600, fy: 25, E: 28.7 };
    const m2 = DesignChecks.getSectionModuli(d600);
    near('W_el is derived from I and d', m2.Sx * 1e6, 540000 * 20 / 600, 1e-6);
    check('a derived modulus is not flagged as assumed', m2.SxAssumed === false);
    check('W_pl falls back to W_el, never below it', m2.Zx >= m2.Sx);

    // 300x600 rectangle: bd^2/6 = 30*60^2/6 = 18 000 cm3.
    near('and it matches bd^2/6 for a rectangle', m2.Sx * 1e6, 18000, 1e-6);
  }
}

group('Results tables report the same signs as the diagrams');
{
  // Three separate sign defects lived in the results panel, all of them in the
  // DISPLAY rather than the solve:
  //
  //  · axial was captioned "N>0 = tension" and coloured positive green, while
  //    this solver is compression-positive — every gravity-loaded column read
  //    as if it were in tension;
  //  · ef.M1 / ef.M2 are END ACTIONS, whose sign is the negative of the
  //    internal bending moment, and the table printed them raw — so a
  //    fixed-fixed span under UDL showed +30 at the support and -15 at
  //    mid-span while the diagram beside it correctly showed -30 and +15;
  //  · the caption claimed "downward loads = positive, upward reactions =
  //    negative", which is backwards on both counts.
  const SEC1 = [{ id: 1, name: 't', E: 210, fy: 275, A: 53.8, I: 8356, Ix: 8356, rho: 0 }];

  // Propped cantilever with an off-centre point load: no symmetry to mask a flip.
  const r = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 2, y: 0 },
     { id: 3, x: 8, y: 0, support: 'roller' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 }, { id: 2, node1: 2, node2: 3, sectionId: 1 }],
    SEC1, [{ type: 'nodal', nodeId: 2, fy: -60 }], []);
  check('the propped cantilever solves', !!r.success, r.error);

  if (r.success) {
    // Reactions: upward is positive and they balance the applied load.
    check('upward reactions are positive', r.reactions[1].Ry > 0 && r.reactions[3].Ry > 0,
          `${r.reactions[1].Ry}, ${r.reactions[3].Ry}`);
    near('and they sum to the applied load', r.reactions[1].Ry + r.reactions[3].Ry, 60, 1e-6);

    // Displacement: a downward load moves the node down, so v is negative.
    check('downward load gives negative v', r.disp[2].v < 0, `v = ${r.disp[2].v}`);

    // Moment: end actions carry the opposite sign to the internal moment, and
    // the panel must show the internal one.
    for (const ef of r.elemForces) {
      const m0 = DesignChecks.internalForceAt(ef, 'BMD', 0);
      const mL = DesignChecks.internalForceAt(ef, 'BMD', ef.L);
      near(`member ${ef.id}: internal moment at the start is -M1`, m0, -ef.M1, 1e-6);
      near(`member ${ef.id}: internal moment at the end is -M2`,   mL, -ef.M2, 1e-6);
      // Shear needs no flip — it already agrees end for end.
      near(`member ${ef.id}: shear at the start equals V1`,
           DesignChecks.internalForceAt(ef, 'SFD', 0), ef.V1, 1e-6);
    }

    // The fixed support of a downward-loaded span HOGS, so its internal moment
    // is negative under the sagging-positive convention the diagram uses.
    const e1 = r.elemForces[0];
    check('the fixed support hogs (internal moment negative)',
          DesignChecks.internalForceAt(e1, 'BMD', 0) < 0,
          `got ${DesignChecks.internalForceAt(e1, 'BMD', 0)}`);
    check('the raw end action has the opposite sign', e1.M1 > 0, `M1 = ${e1.M1}`);
  }

  // Sagging positive / hogging negative, stated against closed-form values.
  {
    const ss = solveFrame(
      [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 6, y: 0, support: 'roller' }],
      [{ id: 1, node1: 1, node2: 2, sectionId: 1 }],
      SEC1, [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
    const bmd = DesignChecks.sampleInternalForces(ss.elemForces[0], 'BMD', 4);
    near('a simply supported span sags: +wL^2/8 at mid-span', bmd[2], 45, 1e-6);

    const cant = solveFrame(
      [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 4, y: 0 }],
      [{ id: 1, node1: 1, node2: 2, sectionId: 1 }],
      SEC1, [{ type: 'nodal', nodeId: 2, fy: -100 }], []);
    const cb = DesignChecks.sampleInternalForces(cant.elemForces[0], 'BMD', 4);
    near('a cantilever hogs: -PL at the support', cb[0], -400, 1e-6);
    near('and returns to zero at the free end',   cb[4], 0, 1e-6);
  }

  // The 3D solver unpacks end forces with the same structure, and aliases
  // Mz1/Mz2 as the 2D names, so the same negation applies to its moments.
  {
    const src = fs.readFileSync(path.join(ROOT, 'js/solver3d.js'), 'utf8');
    check('solver3d still aliases Mz as the 2D M1/M2',
          /M1:\s*f_l\[5\],\s*M2:\s*-f_l\[11\]/.test(src.replace(/\s+/g, ' ')),
          'the 3D→2D moment alias changed; re-check the panel sign convention');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    check('the 3D table negates its moments for display',
          /const mom = m => fM_\(-\(m \|\| 0\)\)/.test(app));
  }
}

group('Canvas labels and the report carry the same signs as the tables');
{
  // Every numeric display of bending moment printed the raw END ACTION, whose
  // sign is the negative of the internal moment. Worse, the canvas peak flag
  // used a third formula again — M1 + V1·x + ∫∫w instead of −M1 + V1·x + ∫∫w —
  // which is not a sign error but a 2·M1 error: a propped cantilever under
  // 10 kN/m over 6 m flagged its peak as 115.31 kNm against a true 25.31.
  const SEC1 = [{ id: 1, name: 't', E: 210, fy: 275, A: 53.8, I: 8356, Ix: 8356, rho: 0 }];
  const r = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 6, y: 0, support: 'roller' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 }],
    SEC1, [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
  check('the propped cantilever solves', !!r.success, r.error);

  if (r.success) {
    const ef = r.elemForces[0];
    // Closed form: fixed-end moment wL²/8 = 45 hogging; peak sagging
    // 9wL²/128 = 25.3125 at x = 5L/8 = 3.75 m; inflection at L/4.
    near('support moment is -wL^2/8 (hogging)', DesignChecks.internalForceAt(ef, 'BMD', 0), -45, 1e-6);
    near('peak sagging is 9wL^2/128',  DesignChecks.internalForceAt(ef, 'BMD', 3.75), 9 * 10 * 36 / 128, 1e-6);
    near('moment is zero at the inflection point (L/4)',
         DesignChecks.internalForceAt(ef, 'BMD', 1.5), 0, 1e-6);
    near('and zero at the roller', DesignChecks.internalForceAt(ef, 'BMD', 6), 0, 1e-6);

    // The discarded formulas, kept here so a regression is recognisable.
    const wrongPeak = ef.M1 + ef.V1 * 3.75 + (-10) * 3.75 * 3.75 / 2;
    check('the old peak formula really was 2*M1 out',
          Math.abs(wrongPeak - 25.3125 - 2 * ef.M1) < 1e-6, `wrongPeak = ${wrongPeak}`);

    // No raw end action may reach a label or the report any more.
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    check('the canvas peak reads internalForceAt, not M1 + V1x',
          !/const Mx = ef\.M1 \+ ef\.V1\*xpeak/.test(app));
    check('diagram end labels read internalForceAt',
          !/const startVal = type==='bmd' \? ef\.M1/.test(app));
    check('the member label box reads internalForceAt',
          !/US\.toDisplay\(ef\.Mz1 \|\| ef\.M1, 'moment'\)/.test(app));

    const rpt = fs.readFileSync(path.join(ROOT, 'js/report/report.js'), 'utf8');
    check('the report prints internal moments', /const Mstart = ef =>/.test(rpt));
    check('and no longer prints the raw end action', !/\$\{fmt\(ef\.M1\)\}/.test(rpt));
    check('SFD and NFD captions are no longer labelled kNm',
          /type === 'BMD' \? 'kNm' : 'kN'/.test(rpt));
  }
}

group('One-storey portal frame against hand calculation');
{
  // A(0,0) B(0,4) C(6,4) D(6,0); w = 20 kN/m on the beam; same section
  // throughout, E = 200 GPa, I = 20000 cm4 so EI = 40 000 kNm2.
  const SEC = [{ id:1, name:'S355', E:200, A:100, I:20000, Ix:20000, fy:355, rho:0 }];
  const EI = 200e6 * 20000e-8, h = 4, L = 6, w = 20;
  const geom = sup => [
    { id:1, x:0, y:0, support:sup[0] }, { id:2, x:0, y:h },
    { id:3, x:L, y:h }, { id:4, x:L, y:0, support:sup[1] }];
  const mem = [{ id:1, node1:1, node2:2, sectionId:1 },
               { id:2, node1:2, node2:3, sectionId:1 },
               { id:3, node1:3, node2:4, sectionId:1 }];
  const lds = [{ type:'beam_dist', elementId:2, fy:-w }];
  const Mat = (r, id, x) => DesignChecks.internalForceAt(r.elemForces.find(e => e.id === id), 'BMD', x);

  // ── Determinate: pin + roller. Only one horizontal restraint, so both
  // columns carry no shear and the beam is effectively simply supported.
  {
    const r = solveFrame(geom(['pin','roller']), mem, SEC, lds, []);
    check('determinate portal solves', !!r.success, r.error);
    if (r.success) {
      near('each vertical reaction is wL/2',   r.reactions[1].Ry, w*L/2, 1e-6);
      near('no horizontal reaction',           r.reactions[1].Rx, 0, 1e-9);
      near('beam end moment is zero',          Mat(r,2,0), 0, 1e-6);
      near('beam mid-span is wL^2/8',          Mat(r,2,L/2), w*L*L/8, 1e-6);
      near('the columns carry no moment',      Mat(r,1,h), 0, 1e-6);
      near('and take the full vertical load as compression',
           r.elemForces.find(e=>e.id===1).N1, w*L/2, 1e-6);
    }
  }

  // ── Indeterminate: fixed bases. Slope-deflection, symmetric frame and
  // symmetric load so there is no sway and theta_C = -theta_B:
  //   theta_B = (wL^2/12) / (4EI/h + 2EI/L)
  //   M_top   = (4EI/h)*theta_B     M_base = (2EI/h)*theta_B = M_top/2
  //   M_mid   = wL^2/8 - M_top      H_base = (M_top + M_base)/h
  {
    const thB    = (w*L*L/12) / (4*EI/h + 2*EI/L);
    const Mtop   = (4*EI/h) * thB;      // 45 kNm
    const Mbase  = (2*EI/h) * thB;      // 22.5 kNm
    const Mmid   = w*L*L/8 - Mtop;      // 45 kNm
    const Hbase  = (Mtop + Mbase) / h;  // 16.875 kN

    const r = solveFrame(geom(['fixed','fixed']), mem, SEC, lds, []);
    check('fixed-base portal solves', !!r.success, r.error);
    if (r.success) {
      near('vertical reaction is exactly wL/2', r.reactions[1].Ry, w*L/2, 1e-9);
      near('reactions balance the applied load',
           r.reactions[1].Ry + r.reactions[4].Ry, w*L, 1e-9);
      near('no net horizontal reaction', r.reactions[1].Rx + r.reactions[4].Rx, 0, 1e-9);

      // Slope-deflection ignores axial shortening; the solver does not, so the
      // frame gives slightly and the moments come in a shade under hand values.
      const tol = 0.02;   // 2 %
      check('beam end moment within 2% of (4EI/h)*theta_B',
            Math.abs(Math.abs(Mat(r,2,0))/Mtop - 1) < tol,
            `${Math.abs(Mat(r,2,0))} vs ${Mtop}`);
      check('beam mid-span within 2% of wL^2/8 - M_end',
            Math.abs(Mat(r,2,L/2)/Mmid - 1) < tol,
            `${Mat(r,2,L/2)} vs ${Mmid}`);
      check('column base is half the column top (carry-over)',
            Math.abs(Math.abs(Mat(r,1,0)) / Math.abs(Mat(r,1,h)) - 0.5) < 0.02,
            `${Mat(r,1,0)} / ${Mat(r,1,h)}`);
      check('horizontal thrust within 2% of (M_top + M_base)/h',
            Math.abs(Math.abs(r.reactions[1].Rx)/Hbase - 1) < tol,
            `${r.reactions[1].Rx} vs ${Hbase}`);
      check('the beam carries that thrust as axial force',
            Math.abs(Math.abs(r.elemForces.find(e=>e.id===2).N1) - Math.abs(r.reactions[1].Rx)) < 1e-6);

      // Convergence: stiffen the members axially and the solver must walk onto
      // the hand values, which proves the 1-2% gap is axial flexibility and not
      // an error in the bending solution.
      const RIGID = [{ ...SEC[0], A: 100 * 1e4 }];
      const rr = solveFrame(geom(['fixed','fixed']), mem, RIGID, lds, []);
      near('with axial deformation removed, beam end moment IS (4EI/h)*theta_B',
           Math.abs(Mat(rr,2,0)), Mtop, 1e-3);
      near('and mid-span IS wL^2/8 - M_end', Mat(rr,2,L/2), Mmid, 1e-3);
      near('and the thrust IS (M_top + M_base)/h', Math.abs(rr.reactions[1].Rx), Hbase, 1e-3);
    }
  }

  // ── Deflection is measured from the chord of the PHYSICAL SPAN ─────
  // Not absolutely, which counts the rigid-body movement of the member's ends
  // as bending, and not against each element's own chord, which loses the sag
  // of a span that has been split. DesignChecks.buildSpans chains collinear
  // elements between supports so the chord spans the whole member.
  {
    const S1 = [{ id:1, name:'t', E:210, fy:275, A:53.8, I:8356, Ix:8356, rho:0 }];
    const EI1 = 210e6 * 8356e-8, EIof = () => EI1;
    const peak = (nds, mems, r) => {
      const sp = DesignChecks.buildSpans(mems, r.elemForces, r.reactions, nds);
      return sp.map(x => ({
        members: x.elems, L: x.L,
        v: Math.abs(DesignChecks.spanDeflection(x, r.elemForces, EIof, 81).v),
      }));
    };

    // A straight member that only moves has no span deflection at all.
    {
      const nds = [{ id:1, x:0, y:0, support:'pin' }, { id:2, x:6, y:0, support:'roller' }];
      const mems = [{ id:1, node1:1, node2:2, sectionId:1 }];
      const r = solveFrame(nds, mems, S1, [], [{ nodeId:2, dir:'v', value:-0.020 }]);
      const bmd = DesignChecks.sampleInternalForces(r.elemForces[0], 'BMD', 8);
      check('a settled-but-unloaded member carries no moment',
            bmd.every(v => Math.abs(v) < 1e-6));
      near('and no span deflection either', peak(nds, mems, r)[0].v, 0, 1e-9);

      // And the user-facing check agrees.
      const dc = DesignChecks.runDesignChecks(r, mems, S1, nds);
      const df = dc.byBeam[0].checks.find(c => c.check === 'Deflection');
      near('the deflection CHECK reports zero', df.v_max_mm, 0, 1e-6);
      check('so it no longer fails a member that does not bend', df.eta < 1e-6,
            `eta = ${df.eta}`);
    }

    // Mesh independence: the same physical beam, modelled three ways.
    {
      const L8 = 8, w8 = 20;
      const exact = 5 * w8 * Math.pow(L8, 4) / (384 * EI1);

      const nA = [{ id:1, x:0, y:0, support:'pin' }, { id:2, x:L8, y:0, support:'roller' }];
      const mA = [{ id:1, node1:1, node2:2, sectionId:1 }];
      const rA = solveFrame(nA, mA, S1, [{ type:'beam_dist', elementId:1, fy:-w8 }], []);

      const nB = [{ id:1, x:0, y:0, support:'pin' }, { id:2, x:2, y:0 }, { id:3, x:4, y:0 },
                  { id:4, x:6, y:0 }, { id:5, x:L8, y:0, support:'roller' }];
      const mB = [1,2,3,4].map(i => ({ id:i, node1:i, node2:i+1, sectionId:1 }));
      const rB = solveFrame(nB, mB, S1, [1,2,3,4].map(i => ({ type:'beam_dist', elementId:i, fy:-w8 })), []);

      const pA = peak(nA, mA, rA), pB = peak(nB, mB, rB);
      check('one element gives one span',  pA.length === 1, `${pA.length}`);
      check('four elements also give ONE span', pB.length === 1,
            `${pB.length} spans — the chain did not form`);
      check('and the span is the full 8 m', Math.abs(pB[0].L - L8) < 1e-9, `${pB[0].L}`);
      near('one element matches 5wL^4/384EI', pA[0].v, exact, 1e-9);
      near('four elements give the SAME answer', pB[0].v, exact, 1e-9);

      // The limit must follow the span too, or splitting a beam silently
      // quadruples how strict its deflection check is.
      const dcB = DesignChecks.runDesignChecks(rB, mB, S1, nB);
      const dfB = dcB.byBeam[0].checks.find(c => c.check === 'Deflection');
      near('the limit is set by the SPAN length, not the element', dfB.L_m, L8, 1e-6);
      check('and the check names the members the span covers',
            (dfB.span_members || []).length === 4, JSON.stringify(dfB.span_members));
    }

    // The case that defeated the naive element-chord fix: the peak sits exactly
    // on a node, which is an element END.
    {
      const L8 = 8, w8 = 20;
      const nds = [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:L8/2, y:0 },
                   { id:3, x:L8, y:0, support:'fixed' }];
      const mems = [{ id:1, node1:1, node2:2, sectionId:1 },
                    { id:2, node1:2, node2:3, sectionId:1 }];
      const r = solveFrame(nds, mems, S1,
        [{ type:'beam_dist', elementId:1, fy:-w8 }, { type:'beam_dist', elementId:2, fy:-w8 }], []);
      const p = peak(nds, mems, r);
      check('a fixed-fixed span split in two is still ONE span', p.length === 1, `${p.length}`);
      near('and still shows wL^4/384EI at the middle',
           p[0].v, w8 * Math.pow(L8, 4) / (384 * EI1), 1e-9);
    }

    // A support in the middle DOES divide the spans — two spans, not one.
    {
      const nds = [{ id:1, x:0, y:0, support:'pin' }, { id:2, x:4, y:0, support:'roller' },
                   { id:3, x:8, y:0, support:'roller' }];
      const mems = [{ id:1, node1:1, node2:2, sectionId:1 },
                    { id:2, node1:2, node2:3, sectionId:1 }];
      const r = solveFrame(nds, mems, S1,
        [{ type:'beam_dist', elementId:1, fy:-20 }, { type:'beam_dist', elementId:2, fy:-20 }], []);
      const p = peak(nds, mems, r);
      check('an interior support splits the chain into two spans', p.length === 2, `${p.length}`);
      check('each span is 4 m', p.every(x => Math.abs(x.L - 4) < 1e-9), JSON.stringify(p.map(x=>x.L)));
    }

    // A corner does too — a portal's beam and columns are not one span.
    {
      const SECp = [{ id:1, name:'S', E:200, A:100, I:20000, Ix:20000, fy:355, rho:0 }];
      const nds = [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:0, y:4 },
                   { id:3, x:6, y:4 }, { id:4, x:6, y:0, support:'fixed' }];
      const mems = [{ id:1, node1:1, node2:2, sectionId:1 },
                    { id:2, node1:2, node2:3, sectionId:1 },
                    { id:3, node1:3, node2:4, sectionId:1 }];
      const r = solveFrame(nds, mems, SECp, [{ type:'beam_dist', elementId:2, fy:-20 }], []);
      const sp = DesignChecks.buildSpans(mems, r.elemForces, r.reactions, nds);
      check('a portal gives three spans, not one bent chain', sp.length === 3, `${sp.length}`);

      // Portal beam: 5wL^4/384EI minus the relief from its end moments, using
      // the solver's own end moment. Hand-checked at 3.386 mm.
      const beamSpan = sp.find(x => x.elems[0] === 2);
      const EIp = 200e6 * 20000e-8;
      const d = DesignChecks.spanDeflection(beamSpan, r.elemForces, () => EIp, 201);
      const eb = r.elemForces.find(e => e.id === 2);
      const Me = Math.abs(DesignChecks.internalForceAt(eb, 'BMD', 0));
      const closed = 5 * 20 * Math.pow(6, 4) / (384 * EIp) - Me * 36 / (8 * EIp);
      near('the portal beam matches the closed form for its end moments',
           Math.abs(d.v), closed, 1e-6);
    }
  }
}

group('Two-storey frame against hand calculation');
{
  //  N5(0,7)──B2──N6(6,7)      H2 = 50 kN at N5
  //   |C3           |C4
  //  N3(0,3.5)─B1──N4(6,3.5)   H1 = 100 kN at N3
  //   |C1           |C2
  //  N1(0,0) fixed  N2(6,0) fixed
  const h = 3.5, L = 6, EI = 200e6 * 20000e-8;
  const nds = [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:L, y:0, support:'fixed' },
               { id:3, x:0, y:h },   { id:4, x:L, y:h },
               { id:5, x:0, y:2*h }, { id:6, x:L, y:2*h }];
  const mems = [{ id:1, node1:1, node2:3, sectionId:1 }, { id:2, node1:2, node2:4, sectionId:1 },
                { id:3, node1:3, node2:5, sectionId:1 }, { id:4, node1:4, node2:6, sectionId:1 },
                { id:5, node1:3, node2:4, sectionId:2 }, { id:6, node1:5, node2:6, sectionId:2 }];
  const Mat = (r, id, x) => DesignChecks.internalForceAt(r.elemForces.find(e => e.id === id), 'BMD', x);

  // ── Lateral load, rigid beams ⇒ pure shear building ──────────────
  // storey stiffness k = 2·12EI/h³ ; drift = V/k ; column end moment = (V/2)·h/2
  {
    const COL = { id:1, name:'COL',   E:200, A:100 * 1e4, I:20000,       Ix:20000,       fy:355, rho:0 };
    const RIG = { id:2, name:'RIGID', E:200, A:100 * 1e4, I:20000 * 1e4, Ix:20000 * 1e4, fy:355, rho:0 };
    const r = solveFrame(nds, mems, [COL, RIG],
      [{ type:'nodal', nodeId:3, fx:100, fy:0 }, { type:'nodal', nodeId:5, fx:50, fy:0 }], []);
    check('the 2-storey frame solves under lateral load', !!r.success, r.error);

    if (r.success) {
      const k = 2 * 12 * EI / Math.pow(h, 3);
      const d1 = 150 / k, d2 = 50 / k;
      const tol = 1e-3;   // the "rigid" beams are 1e4× stiff, not infinite

      check('first-floor sway is V1/k',  Math.abs(r.disp[3].u / d1 - 1) < tol,
            `${r.disp[3].u} vs ${d1}`);
      check('roof sway is V1/k + V2/k',  Math.abs(r.disp[5].u / (d1 + d2) - 1) < tol,
            `${r.disp[5].u} vs ${d1 + d2}`);
      // The beam is 1e4x stiff axially, not infinitely, so the two columns sway
      // within ~2e-6 of each other rather than identically.
      check('both columns of a storey sway together (rigid beam)',
            Math.abs(r.disp[3].u - r.disp[4].u) / Math.abs(r.disp[3].u) < 1e-4,
            `${r.disp[3].u} vs ${r.disp[4].u}`);

      // Storey shear splits evenly between two identical columns.
      near('lower column shear is V1/2', Math.abs(r.elemForces.find(e=>e.id===1).V1), 75, 0.05);
      near('upper column shear is V2/2', Math.abs(r.elemForces.find(e=>e.id===3).V1), 25, 0.05);

      // Inflection at mid-height: equal magnitudes, opposite signs.
      const mb = Mat(r, 1, 0), mt = Mat(r, 1, h);
      near('lower column end moment is (V1/2)(h/2)', Math.abs(mb), 75 * h / 2, 0.05);
      check('and reverses sign over the height', mb * mt < 0, `${mb}, ${mt}`);
      near('mid-height is the inflection point', Mat(r, 1, h / 2), 0, 0.05);

      // Statics on the whole frame.
      near('base shears carry the applied load',
           Math.abs(r.reactions[1].Rx + r.reactions[2].Rx), 150, 1e-3);
      near('no net vertical reaction under pure lateral load',
           r.reactions[1].Ry + r.reactions[2].Ry, 0, 1e-6);
      check('the windward column lifts, the leeward one compresses',
            r.elemForces.find(e=>e.id===1).N1 * r.elemForces.find(e=>e.id===2).N1 < 0);
    }
  }

  // ── Gravity on both beams, real sections ⇒ slope-deflection ──────
  //   (4a + b)·θ₁ +      a·θ₂ = wL²/12     a = 2EI/h
  //        a·θ₁ + (2a + b)·θ₂ = wL²/12     b = 2EI/L
  {
    const w = 20, a = 2 * EI / h, b = 2 * EI / L, R = w * L * L / 12;
    const D = (4*a + b) * (2*a + b) - a*a;
    const th1 = R * ((2*a + b) - a) / D, th2 = R * ((4*a + b) - a) / D;
    const hand = {
      colLowerBase: a * th1,          colLowerTop: 2 * a * th1,
      colUpperBase: a * (2*th1 + th2), colUpperTop: a * (2*th2 + th1),
      beamFloorEnd: Math.abs(b * th1 - R), beamRoofEnd: Math.abs(b * th2 - R),
    };
    // The hand solution must satisfy joint equilibrium exactly, or the rest of
    // this comparison is meaningless.
    near('hand: floor joint is in equilibrium',
         2*a*th1 + a*(2*th1 + th2) + (b*th1 - R), 0, 1e-9);
    near('hand: roof joint is in equilibrium',
         a*(2*th2 + th1) + (b*th2 - R), 0, 1e-9);

    const lds = [{ type:'beam_dist', elementId:5, fy:-w }, { type:'beam_dist', elementId:6, fy:-w }];
    const gm = mems.map(m => ({ ...m, sectionId: 1 }));

    // Slope-deflection assumes members do not shorten. Remove axial flexibility
    // and the solver must land on the hand answer exactly.
    const RIGID = [{ id:1, name:'S', E:200, A:100 * 1e4, I:20000, Ix:20000, fy:355, rho:0 }];
    const rr = solveFrame(nds, gm, RIGID, lds, []);
    check('the gravity case solves', !!rr.success, rr.error);
    if (rr.success) {
      near('lower column base moment',  Math.abs(Mat(rr,1,0)),   hand.colLowerBase, 1e-3);
      near('lower column top moment',   Math.abs(Mat(rr,1,h)),   hand.colLowerTop,  1e-3);
      near('upper column base moment',  Math.abs(Mat(rr,3,0)),   hand.colUpperBase, 1e-3);
      near('upper column top moment',   Math.abs(Mat(rr,3,h)),   hand.colUpperTop,  1e-3);
      near('floor beam end moment',     Math.abs(Mat(rr,5,0)),   hand.beamFloorEnd, 1e-3);
      near('roof beam end moment',      Math.abs(Mat(rr,6,0)),   hand.beamRoofEnd,  1e-3);
      near('floor beam mid-span is wL^2/8 - M_end',
           Mat(rr,5,L/2), w*L*L/8 - hand.beamFloorEnd, 1e-3);
      near('roof beam mid-span is wL^2/8 - M_end',
           Mat(rr,6,L/2), w*L*L/8 - hand.beamRoofEnd, 1e-3);
      near('each base carries both beams: wL', rr.reactions[1].Ry, w * L, 1e-6);
      near('reactions balance the total load',
           rr.reactions[1].Ry + rr.reactions[2].Ry, 2 * w * L, 1e-6);
      near('symmetric gravity produces no net sway force',
           rr.reactions[1].Rx + rr.reactions[2].Rx, 0, 1e-9);
    }

    // With real areas the solver keeps axial deformation, which slope-deflection
    // drops — so the two must differ, and only slightly.
    const REAL = [{ id:1, name:'S', E:200, A:100, I:20000, Ix:20000, fy:355, rho:0 }];
    const r2 = solveFrame(nds, gm, REAL, lds, []);
    if (r2.success) {
      const d = Math.abs(Math.abs(Mat(r2,5,0)) / hand.beamFloorEnd - 1);
      check('axial flexibility shifts the floor beam moment by under 1%', d < 0.01,
            `${(d*100).toFixed(2)}%`);
      check('but it is not identical — axial deformation is really in there',
            Math.abs(Mat(r2,1,0)) !== Math.abs(Mat(rr,1,0)));
    }
  }

  // Every surface that prints a member moment must print the INTERNAL one.
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    check('the results-tables dialog prints internal moments, not end actions',
          !/\$\{cv\(ef\.M1,'moment'\)/.test(app) && /cv\(M1i,'moment'\)/.test(app));
  }
}

group('A bad section is named, and a zero modifier is honoured');
{
  // Two faults that both ended as "Structural matrix is singular — check that
  // every member is connected and that the supports prevent rigid-body
  // movement", sending the user to look at their supports:
  //
  //  · a section with a zero or negative E, A or I. The section table takes
  //    plain numbers with no minimum, so -100 for an area is one keystroke
  //    away, and the member was then dropped from the assembly in silence.
  //  · a stiffness modifier of exactly 0. `bm.modifiers?.f11 || 1` read that
  //    as "unset" and substituted 1, so a member the user had asked to carry
  //    no axial stiffness quietly kept all of it.
  const nds = [{ id:1, x:0, y:0, support:'pin' }, { id:2, x:6, y:0, support:'roller' }];
  const mem = [{ id:1, node1:1, node2:2, sectionId:1 }];
  const ld  = [{ type:'beam_dist', elementId:1, fy:-10 }];
  const good = { id:1, name:'Good', E:200, A:100, I:20000, Ix:20000, fy:355, rho:0 };

  const errFor = (sec, bmExtra) => {
    const m = bmExtra ? [Object.assign({}, mem[0], bmExtra)] : mem;
    const r = solveFrame(nds, m, [sec], ld, []);
    return r.error || '';
  };

  // The message must name the section and the property, and must NOT send the
  // reader off to check supports.
  for (const [label, sec] of [
    ['E = 0',        { ...good, E: 0 }],
    ['A negative',   { ...good, A: -100 }],
    ['I = 0',        { ...good, I: 0, Ix: 0 }],
  ]) {
    const e = errFor(sec);
    check(`${label}: the section is named`, /Good/.test(e), e);
    check(`${label}: the offending property is named`,
          /E, A and I must all be greater than zero/.test(e), e);
    check(`${label}: it no longer blames the supports`,
          !/supports prevent rigid-body/.test(e), e);
  }

  // A modifier of 0 must actually remove the stiffness, and say so.
  {
    const e = errFor(good, { modifiers: { f11: 0, fi3: 0 } });
    check('a zero modifier is applied, not read as "unset"', e !== '',
          'the member solved as though the modifier were 1');
    check('and the message points at the modifier', /modifier/.test(e), e);
  }

  // A modifier that is genuinely absent still defaults to 1.
  check('an absent modifier still means full stiffness', errFor(good) === '');

  // And a real modifier scales the stiffness rather than being ignored.
  {
    const full = solveFrame(nds, mem, [good], ld, []);
    const half = solveFrame(nds, [{ ...mem[0], modifiers: { fi3: 0.5 } }], [good], ld, []);
    const EI   = 200e6 * 20000e-8;
    near('halving fi3 doubles the deflection',
         Math.abs(ctx.maxDeflLocal2D(half.elemForces[0], half.elemForces[0].loads, EI * 0.5, 81).v) /
         Math.abs(ctx.maxDeflLocal2D(full.elemForces[0], full.elemForces[0].loads, EI, 81).v),
         2, 1e-6);
  }
}

group('Load combinations stay consistent with the model');
{
  // Two faults, both about combinations quietly disagreeing with the model.
  const app  = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // 1. The two generators choose a code family (EC0 / ASCE7 / IS456) from a
  //    different value set than the design-code selectors (ACI / EC2 / EC3),
  //    and each defaulted to whichever option happened to be listed first.
  //    cg-code lists ASCE7 first and agreed with the app; combo-gen-code lists
  //    EC0 first and did not — so Analysis ▸ Combos previewed Eurocode
  //    1.35D + 1.5L for a model whose own combinations were ACI 1.2D + 1.6L.
  check('the combination generators are mapped from the design code',
        /const COMBO_FAMILY = \{[^}]*ACI:\s*'ASCE7'/.test(html), 'COMBO_FAMILY missing');
  check('EC2 and EC3 map to the Eurocode family',
        /EC2:\s*'EC0'/.test(html) && /EC3:\s*'EC0'/.test(html));
  check('both generators are kept in step',
        /\['combo-gen-code', 'cg-code'\]/.test(html));
  check('and a family the user picked by hand is left alone',
        /userPicked/.test(html));
  // combo-gen-code still lists EC0 first, so only the sync keeps it honest.
  check('combo-gen-code still lists EC0 first, so the sync is load-bearing',
        /id="combo-gen-code"[\s\S]{0,200}?<option value="EC0"/.test(html));

  // 2. Deleting a load case left every combination that used it pointing at an
  //    id that no longer existed. The Factors column rendered "1.2×?" and at
  //    solve time the term contributed nothing, so 1.2D + 1.0W + L quietly
  //    became 1.2D + L while still calling itself the original name.
  // Slice to the end of the handler rather than a fixed byte count, so the
  // window cannot silently fall short of the lines being asserted.
  const delStart = app.indexOf("querySelectorAll('[data-del-lc]')");
  const delBlock = app.slice(delStart, app.indexOf('// Combos table', delStart));
  check('deleting a case names the combinations that use it',
        /load combination\$\{affected\.length === 1/.test(delBlock), 'no confirm listing');
  check('and it can be cancelled', /if \(!ok\) return;/.test(delBlock));
  check('the deleted case is stripped from every combination',
        /cb\.factors = \(cb\.factors \|\| \[\]\)\.filter\(f => f\.caseId !== id\)/.test(delBlock));
  check('combinations left with nothing are removed',
        /emptied/.test(delBlock) && /loadCombos = loadCombos\.filter/.test(delBlock));
  check('a combination whose content changed says so in its name',
        /\(−\$\{nm\}\)/.test(delBlock), 'no rename marker');
  check('stale combination results are dropped',
        /allComboResults = \{\};/.test(delBlock));
  check('the display stops pointing at something that has gone',
        /activeDisplay = \{ type: 'case'/.test(delBlock));
}

group('Deleting a node says what goes with it, and orphans nothing');
{
  // Deleting a node cascades to every member attached to it. Two problems:
  //
  //  · it happened in silence. Deleting a SECTION has always asked first and
  //    named the members using it; deleting a node — far more destructive —
  //    removed members and loads without a word.
  //  · `loads.filter(l => l.nodeId !== nid)` only caught NODAL loads. A
  //    beam_dist load has no nodeId, so `undefined !== nid` was true and the
  //    load survived, pointing at an elementId that no longer resolved to
  //    anything. It stayed in the Loads table attached to a missing member.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function deleteNode(nid)'),
                       app.indexOf('function nodeDeletionImpact'));

  check('deleted members take their loads with them',
        /goneMemberIds\.has\(l\.elementId\)/.test(fn), fn.slice(0, 200));
  check('nodal loads at the node still go too',
        /l\.nodeId !== nid/.test(fn));
  check('settlements at the node go too', /settlements\.filter\(s => s\.nodeId !== nid\)/.test(fn));
  check('the selection is cleared of what was removed',
        /multiSel\.nodes\.delete\(nid\)/.test(fn) && /multiSel\.beams\.delete/.test(fn));
  check('and it reports what it removed', /return \{ members: goneMembers/.test(fn));

  const tableBtn = app.slice(app.indexOf("querySelectorAll('[data-del-node]')"),
                             app.indexOf("querySelectorAll('[data-del-node]')") + 1400);
  check('the table delete asks first, naming the members',
        /nodeDeletionImpact/.test(tableBtn) && /confirm\(/.test(tableBtn), tableBtn.slice(0,160));
  check('and it can be cancelled', /if \(!ok\) return;/.test(tableBtn));

  // There is more than one delete-tool path — clicking a node marker, and
  // clicking the canvas with the tool armed. Both must report, and neither
  // may open a dialog.
  const delPaths = [...app.matchAll(/else if \(tool === 'delete'\) \{/g)]
    .map(m => app.slice(m.index, m.index + 700));
  check('every delete-tool path reports the deletion',
        delPaths.filter(b => /deleteNode/.test(b))
                .every(b => /reportNodeDeletion/.test(b)),
        `${delPaths.length} paths found`);
  check('and none of them opens a dialog', delPaths.every(b => !/confirm\(/.test(b)));
  check('the shared reporter points at undo',
        /Ctrl\+Z to undo/.test(app.slice(app.indexOf('function reportNodeDeletion'),
                                         app.indexOf('function reportNodeDeletion') + 700)));
}

group('Member end releases, springs and settlement against closed form');
{
  const S1 = [{ id:1, name:'t', E:210, fy:275, A:53.8, I:8356, Ix:8356, rho:0 }];
  const EI = 210e6 * 8356e-8;
  const Mat = (r, x) => DesignChecks.internalForceAt(r.elemForces[0], 'BMD', x);

  // ── Hinges ──────────────────────────────────────────────────────
  {
    const L = 6, w = 20;
    const nds = [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:L, y:0, support:'roller' }];
    const ld  = [{ type:'beam_dist', elementId:1, fy:-w }];
    const run = (hs, he) => solveFrame(nds,
      [{ id:1, node1:1, node2:2, sectionId:1, hingeStart:hs, hingeEnd:he }], S1, ld, []);

    const a = run(false, false);   // propped cantilever
    near('propped cantilever: fixing moment is -wL^2/8', Mat(a, 0), -w*L*L/8, 1e-6);
    near('propped cantilever: fixed reaction is 5wL/8',  a.reactions[1].Ry, 5*w*L/8, 1e-6);
    near('propped cantilever: prop reaction is 3wL/8',   a.reactions[2].Ry, 3*w*L/8, 1e-6);

    const b = run(true, false);    // release the moment AT the fixed support
    near('releasing the fixed end gives a simply supported span', Mat(b, 0), 0, 1e-9);
    near('and mid-span becomes wL^2/8',  Mat(b, L/2), w*L*L/8, 1e-6);
    near('with equal reactions',         b.reactions[1].Ry, w*L/2, 1e-6);
    near('and no fixing moment left',    b.reactions[1].M, 0, 1e-9);

    const c = run(false, true);    // a roller has no moment restraint to release
    near('releasing at a roller changes nothing', Mat(c, 0), Mat(a, 0), 1e-9);
  }

  // ── Spring support ──────────────────────────────────────────────
  // The cantilever's tip stiffness 3EI/L³ acts in parallel with the spring.
  {
    const L = 4, P = 100, k = 1000;
    const dh = P / (k + 3 * EI / L**3);
    const r = solveFrame(
      [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:L, y:0, support:'spring', springKy:k }],
      [{ id:1, node1:1, node2:2, sectionId:1 }], S1,
      [{ type:'nodal', nodeId:2, fy:-P }], []);
    check('the spring-supported cantilever solves', !!r.success, r.error);
    if (r.success) {
      near('tip deflection is P/(k + 3EI/L^3)', -r.disp[2].v, dh, 1e-9);
      near('the spring carries k·delta',        r.reactions[2].Ry, k * dh, 1e-6);
      near('the fixed end takes the rest',      r.reactions[1].Ry, P - k * dh, 1e-6);
      near('and its moment is (P - k·delta)·L', Math.abs(r.reactions[1].M), (P - k*dh) * L, 1e-6);
    }
  }

  // ── Support settlement ──────────────────────────────────────────
  // Propped cantilever, prop pushed down by d, no load at all.
  {
    const L = 6, d = 0.010;
    const r = solveFrame(
      [{ id:1, x:0, y:0, support:'fixed' }, { id:2, x:L, y:0, support:'roller' }],
      [{ id:1, node1:1, node2:2, sectionId:1 }], S1, [],
      [{ nodeId:2, dir:'v', value:-d }]);
    check('the settlement case solves', !!r.success, r.error);
    if (r.success) {
      near('the prop really moves by d',      r.disp[2].v, -d, 1e-12);
      near('fixing moment is 3EI·d/L^2',      Math.abs(r.reactions[1].M), 3*EI*d/L**2, 1e-6);
      near('prop reaction is 3EI·d/L^3',      Math.abs(r.reactions[2].Ry), 3*EI*d/L**3, 1e-6);
    }
  }
}

group('Section import rejects, defaults and reports honestly');
{
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  // The .xlsx and .csv paths were near-duplicates that disagreed: SheetJS
  // yields numbers, the CSV parser yields strings, and `row.E_GPa || row.E ||
  // 200` treats a numeric 0 as absent but the string "0" as present. The same
  // file imported two ways produced different sections.
  check('both import paths share one row parser',
        /function sectionFromImportRow/.test(app) &&
        (app.match(/applyImportedSections\(/g) || []).length >= 3,
        'parser not shared');
  // Check the CODE, not the prose — the old pattern is quoted in a comment
  // explaining why it went, and matching that would pass for the wrong reason.
  const importCode = app.slice(app.indexOf('function sectionFromImportRow'),
                               app.indexOf('function importSectionsFromFile'))
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/\/\/.*/g, '');   // . excludes newlines
  check('no numeric property is defaulted through a || chain any more',
        !/\|\|\s*(200|100|10000|250|78\.5)/.test(importCode), importCode.slice(0, 200));

  const parser = app.slice(app.indexOf('function sectionFromImportRow'),
                           app.indexOf('function applyImportedSections'));
  check('a value of 0 counts as present, not absent',
        /String\(v\)\.trim\(\) !== ''/.test(parser), parser.slice(0, 200));
  check('E, A and I are required — never invented',
        /no ' \+ label \+ ' column/.test(parser));
  check('and must be greater than zero',
        /must be greater than zero/.test(parser));
  check('fy and density may default, but the default is recorded',
        /defaulted\.push\(label\)/.test(parser));

  const apply = app.slice(app.indexOf('function applyImportedSections'),
                          app.indexOf('function parseCSVRows'));
  // snapshot() records the PRE-edit state, so the old call AFTER the push left
  // Ctrl+Z unable to undo an import at all.
  const snapAt = apply.indexOf('snapshot();');
  const pushAt = apply.indexOf('sections.push');
  check('snapshot is taken BEFORE the sections are added',
        snapAt > -1 && pushAt > -1 && snapAt < pushAt,
        `snapshot at ${snapAt}, push at ${pushAt}`);
  check('skipped rows are counted and surfaced',
        /skipped\.length/.test(apply) && /toast\(/.test(apply));
  check('and the per-row reasons are written out in full',
        /console\.warn\('\[Section import\]/.test(apply));

  // `line.split(',')` shifted every column after a quoted name containing a
  // comma, so the row imported with the wrong numbers in the wrong properties.
  const csvp = app.slice(app.indexOf('function parseCSVRows'),
                         app.indexOf('function importSectionsFromFile'));
  check('the CSV parser honours quoted fields', /inQ/.test(csvp), csvp.slice(0, 200));
  check('and doubled quotes inside them', /line\[i \+ 1\] === '"'/.test(csvp));
  check('and it no longer drops short rows silently',
        !/vals\.length < 5/.test(csvp));
  check('CRLF line endings are handled', csvp.includes('\\r?\\n'), 'no CRLF-tolerant split');
}

group('Natural frequencies match closed form');
{
  // Simply supported prismatic beam: omega_n = (n*pi/L)^2 * sqrt(EI/m).
  // The model also has axial freedom, so axial modes interleave with the
  // bending ones — a comparison that assumes every mode is bending will look
  // badly wrong at mode 3 when nothing is actually amiss.
  const L = 6, nEl = 8, E = 200, Icm4 = 20000, Acm2 = 100, rho = 78.5;
  const EI = E * 1e6 * Icm4 * 1e-8;
  const mLin = (rho * Acm2 / 1e4) / 9.80665;      // kN/m -> tonne/m
  const S = [{ id:1, name:'t', E, A:Acm2, I:Icm4, Ix:Icm4, fy:355, rho }];
  const nds = [], mems = [];
  for (let i = 0; i <= nEl; i++) {
    nds.push({ id:i+1, x:i*L/nEl, y:0,
               support: i === 0 ? 'pin' : (i === nEl ? 'roller' : undefined) });
  }
  for (let i = 0; i < nEl; i++) mems.push({ id:i+1, node1:i+1, node2:i+2, sectionId:1 });

  const bend = n => Math.pow(n*Math.PI/L, 2) * Math.sqrt(EI/mLin) / (2*Math.PI);
  const axial = n => (n / (4*L)) * Math.sqrt(E*1e6 / (rho/9.80665));   // fixed-free bar

  const res = ModeShapeAnalysis.computeModes(nds, mems, S, 6);
  check('modal analysis returns modes', !!(res && res.modes && res.modes.length >= 4), res && res.error);

  if (res && res.modes) {
    const f = res.modes.map(m => m.freq);
    const rel = (a, b) => Math.abs(a/b - 1);
    check('mode 1 is the first bending mode',  rel(f[0], bend(1)) < 0.01, `${f[0]} vs ${bend(1)}`);
    check('mode 2 is the second bending mode', rel(f[1], bend(2)) < 0.01, `${f[1]} vs ${bend(2)}`);
    check('mode 3 is the first AXIAL mode',    rel(f[2], axial(1)) < 0.01, `${f[2]} vs ${axial(1)}`);
    check('mode 4 is the third bending mode',  rel(f[3], bend(3)) < 0.01, `${f[3]} vs ${bend(3)}`);

    // Participation tells bending from axial, and symmetric from antisymmetric.
    check('the bending modes carry the vertical mass',
          res.modes[0].uyPct > 80 && res.modes[0].uxPct < 1e-6,
          `uy ${res.modes[0].uyPct}, ux ${res.modes[0].uxPct}`);
    check('the axial mode carries the horizontal mass',
          res.modes[2].uxPct > 80 && res.modes[2].uyPct < 1e-6,
          `ux ${res.modes[2].uxPct}, uy ${res.modes[2].uyPct}`);
    check('antisymmetric mode 2 carries none',
          res.modes[1].uxPct < 1e-6 && res.modes[1].uyPct < 1e-6);
    check('cumulative participation approaches 100%',
          res.modes.reduce((a,m)=>a+m.uyPct,0) > 95 &&
          res.modes.reduce((a,m)=>a+m.uxPct,0) > 90);
  }
}

group('3D axis buttons highlight the view they select');
{
  // VIEWS.XY sets el = +PI/2 while updateBtn tested (el + PI/2), which can only
  // match at el = -PI/2. Clicking XY therefore matched no branch at all and the
  // whole axis row went blank. Cosmetic, but it made the plan view look broken.
  const v3src = fs.readFileSync(path.join(ROOT, 'js/features/view3d.js'), 'utf8');

  // Camera angles come straight out of the VIEWS table, and the matching logic
  // straight out of updateBtn, so this tracks the source rather than a copy.
  const tableAt = v3src.indexOf('const VIEWS = {');
  const table   = v3src.slice(tableAt, v3src.indexOf('};', tableAt) + 2);
  const VIEWS   = new Function('return ' + table.slice(table.indexOf('{')))();
  check('the VIEWS table parses', !!(VIEWS && VIEWS.XY && VIEWS.ISO));

  // Start the slice at the helper block, not at `let active`: the classifier
  // now normalises the azimuth and uses a local `near()`, both declared above
  // that line, so cutting there produced a ReferenceError instead of a result.
  const btnAt   = v3src.indexOf('const el = SA.view3D.el;');
  const chain   = v3src.slice(btnAt, v3src.indexOf("['XY', 'XZ', 'YZ', 'ISO']", btnAt));
  const resolve = new Function('az0', 'el0',
    'const SA = { view3D: { az: az0, el: el0 } };' + chain + ' return active;');

  for (const key of ['XY', 'XZ', 'YZ', 'ISO']) {
    const v = VIEWS[key];
    check(`selecting ${key} highlights ${key}`, resolve(v.az, v.el) === key,
          `highlighted ${resolve(v.az, v.el)}`);
  }
}

group('3D solid renderer picks the right cross-section outline');
{
  // getSectionShape ended its I-beam pattern with a bare `steel`, and being
  // tested first it won every time — a section named "Steel CHS 168x5",
  // "Steel Pipe 200" or "Steel Rod 25" was extruded as a wide flange. The
  // shipped library names its round sections "CHS 219x8" with no material
  // prefix so it never showed there, but "Steel " prefixing is exactly what the
  // default sections use. Visual only — no analysis reads this.
  // The shape helpers are one contiguous block: the shapeId map, the
  // classifier, the profile generator and the two dimension helpers. Lift the
  // real source rather than restating it, so the checks below cannot drift
  // away from what the renderer actually does.
  const exSrc  = fs.readFileSync(path.join(ROOT, 'js/features/extrude.js'), 'utf8');
  const exBlk  = exSrc.slice(exSrc.indexOf('  const SHAPE_BY_ID = {'),
                             exSrc.indexOf('  // ── Colour-by-section'));
  const EX = new Function(exBlk +
    '; return { shapeOf: getSectionShape, profileOf: getCrossSection,' +
    '           hOf: getSectionH, wOf: getSectionW };')();
  const shapeOf = EX.shapeOf;

  const SHAPE_CASES = [
    ['Steel CHS 168x5', 'circ'], ['Steel Pipe 200', 'circ'],
    ['Steel Round Bar 40', 'circ'], ['Steel Rod 25', 'circ'],
    ['CHS 219x8', 'circ'], ['Circ Ø300', 'circ'],
    ['Steel W200x100', 'I'], ['Steel IPE 300', 'I'], ['HEB 300', 'I'],
    ['UC 203x203x46', 'I'],
    ['SHS 100x100x5', 'rect'], ['RHS 200x100x6', 'rect'],
    ['Steel SHS 90x90x4', 'rect'], ['Flat Bar 100x10', 'rect'],
    ['RC 300x600', 'rect'], ['GL 200x400', 'rect'],
  ];
  for (const [nm, want] of SHAPE_CASES)
    check(`"${nm}" extrudes as ${want}`, shapeOf({ name: nm }) === want,
          `got ${shapeOf({ name: nm })}`);

  // And every library section must still land on its correct outline.
  const EXPECT = { IPE:'I', HEA:'I', HEB:'I', UB:'I', UC:'I',
                   CHS:'circ', SHS:'rect', RC:'rect', ACI_RC:'rect', GL:'rect' };
  const wrongShape = [];
  for (const [g, items] of Object.entries(SectionDB.groups))
    for (const sec of items) {
      const want = /Circ/i.test(sec.name) ? 'circ' : EXPECT[g];
      if (shapeOf(sec) !== want) wrongShape.push(`${sec.name}->${shapeOf(sec)} (want ${want})`);
    }
  check(`all ${SectionDB.all.length} library sections extrude correctly`,
        wrongShape.length === 0, wrongShape.slice(0, 4).join('; '));

  // ── shapeId is authoritative ────────────────────────────────────
  // The classifier read only the section NAME. Define > Sections stores the
  // user's pick in shapeId and the dialog's own preview draws from it, so a
  // channel named "C 250x90" previewed as a channel and extruded as a solid
  // box: the same section, two different shapes, in two panels of one app.
  check('a channel picked in the dialog extrudes as a channel',
        shapeOf({ shapeId: 'SteelC', name: 'C 250x90' }) === 'C');
  check('and so does one whose name says nothing at all',
        shapeOf({ shapeId: 'SteelC', name: 'My Section 1' }) === 'C',
        'this is the case that used to come out rectangular');
  check('shapeId beats a name that disagrees with it',
        shapeOf({ shapeId: 'SteelC', name: 'Steel W200x100' }) === 'C');

  // Every shape the picker offers must reach a profile. Anything missing here
  // silently falls back to a rectangle, which is the whole defect.
  const BY_ID = {
    SteelW:'I', PrecastI:'I', SteelC:'C', ColdC:'C', ColdZ:'Z',
    SteelT:'T', ConcTee:'T', SteelL:'L', ConcL:'L', Steel2L:'2L',
    ConcCirc:'circ', ConcPipe:'circ', SteelPipe:'circ', SteelRod:'circ',
    ConcRect:'rect', ConcBox:'rect', SteelBox:'rect', SteelPlate:'rect'
  };
  Object.entries(BY_ID).forEach(([id, want]) =>
    check(`${id} extrudes as ${want}`, shapeOf({ shapeId: id }) === want,
          `got ${shapeOf({ shapeId: id })}`));

  // The picker's own catalogue is the list that has to be covered — if a
  // shape is added there and not here, this is what says so.
  const fsSrc = fs.readFileSync(path.join(ROOT, 'js/features/frame_sections.js'), 'utf8');
  const cat   = (fsSrc.match(/\{\s*id:\s*'([A-Za-z0-9]+)'\s*,\s*label:/g) || [])
                  .map(m => m.match(/'([A-Za-z0-9]+)'/)[1]);
  check('the shape catalogue was found', cat.length >= 18, `${cat.length} shapes`);
  const uncovered = cat.filter(id =>
    !/^(Nonprismatic|General)$/.test(id) && shapeOf({ shapeId: id }) === 'rect' && BY_ID[id] !== 'rect');
  check('every catalogue shape reaches a profile', uncovered.length === 0,
        `no outline for ${uncovered.join(', ')}`);

  // ── The profiles are the shapes they claim to be ────────────────
  // Shoelace area against the analytic area proves the polygon closes and
  // does not cross itself; the symmetry tests prove it is the right outline
  // and not just one of the right size.
  const D = 250, B = 90, TF = 15, TW = 10, TA = 12, TS = 14;   // mm
  const secOf = (shapeId) => ({ shapeId, d: D, b: B, tf: TF, tw: TW, ta: TA, ts: TS });
  const prof  = (shapeId) => EX.profileOf(secOf(shapeId), shapeOf({ shapeId }));
  const area  = (p) => Math.abs(p.reduce((a, v, i) => {
    const w = p[(i + 1) % p.length];
    return a + v[0] * w[1] - w[0] * v[1];
  }, 0)) / 2;
  const has   = (p, y, z) => p.some(v => Math.abs(v[0] - y) < 1e-9 && Math.abs(v[1] - z) < 1e-9);
  const mirrorY = (p) => p.every(v => has(p, -v[0],  v[1]));   // about the width axis
  const mirrorZ = (p) => p.every(v => has(p,  v[0], -v[1]));   // about the depth axis
  const point2  = (p) => p.every(v => has(p, -v[0], -v[1]));   // 180 degree rotation
  const cz = (p) => {                                           // centroid, width axis
    let a = 0, c = 0;
    for (let i = 0; i < p.length; i++) {
      const v = p[i], w = p[(i + 1) % p.length];
      const x = v[0] * w[1] - w[0] * v[1];
      a += x; c += (v[1] + w[1]) * x;
    }
    return c / (3 * a);
  };
  const d = D / 1000, b = B / 1000, tf = TF / 1000, tw = TW / 1000,
        ta = TA / 1000, ts = TS / 1000;

  const cP = prof('SteelC');
  near('the channel has a channel area', area(cP), 2*b*tf + (d - 2*tf)*tw, 1e-9);
  check('which is nothing like the box it used to draw',
        Math.abs(area(cP) - d*b) > d*b*0.5,
        `${(area(cP)*1e4).toFixed(1)} cm2 vs a solid ${(d*b*1e4).toFixed(1)} cm2`);
  check('its flanges match top to bottom', mirrorY(cP));
  check('but the web sits on one side, as a channel does', !mirrorZ(cP));
  check('so its centroid is off the width centreline',
        cz(cP) < -0.01, `${(cz(cP)*1000).toFixed(2)} mm`);

  const iP = prof('SteelW');
  near('the I-beam keeps the same area formula', area(iP), 2*b*tf + (d - 2*tf)*tw, 1e-9);
  check('and is symmetric both ways, which the channel is not',
        mirrorY(iP) && mirrorZ(iP));
  check('the two are genuinely different outlines',
        Math.abs(cz(iP) - cz(cP)) > 0.01,
        'equal area alone would not tell a C from an I');

  const zP = prof('ColdZ');
  check('the Z is point-symmetric', point2(zP));
  check('and mirror-symmetric neither way, which is what makes it a Z',
        !mirrorY(zP) && !mirrorZ(zP));
  near('its area is the two flanges plus the web',
       area(zP), 2*tf*(b/2 + tw/2) + tw*(d - 2*tf), 1e-9);

  const tP = prof('SteelT');
  near('the tee is flange plus stem', area(tP), b*tf + (d - tf)*ts, 1e-9);
  check('with a top and bottom that differ', !mirrorY(tP));
  check('and left/right that do not', mirrorZ(tP));

  const lP = prof('SteelL');
  near('the angle is two legs less the shared corner',
       area(lP), ta*(b + d - ta), 1e-9);
  check('and is symmetric about neither axis', !mirrorY(lP) && !mirrorZ(lP));

  const dP = prof('Steel2L');
  near('the double angle is two of them', area(dP), 2*(ta*(b/2 + d - ta)), 1e-9);
  check('back to back, so left and right match', mirrorZ(dP));

  near('a plain rectangle is still solid', area(prof('ConcRect')), d*b, 1e-9);
  check('and a round section is still round',
        prof('ConcCirc').length === 40 &&
        Math.abs(area(prof('ConcCirc')) - Math.PI*(d/2)*(d/2)) < 0.004,
        'a 40-gon is slightly inside the true circle');

  // A plate thicker than the section itself must not turn the profile inside
  // out. Bound it by the section's own bounding box, taken from the same
  // helpers the generator uses — they floor a small section at 60 mm, so a
  // literal 60x50 here would be measuring the wrong rectangle.
  const FAT = { shapeId: 'SteelC', d: 60, b: 50, tf: 90, tw: 80 };
  const fat = EX.profileOf(FAT, 'C');
  const fatH = EX.hOf(FAT), fatW = EX.wOf(FAT, fatH);
  check('an absurd flange thickness does not turn the profile inside out',
        area(fat) > 0 && area(fat) <= fatH * fatW + 1e-12,
        `${area(fat)} vs a solid ${fatH * fatW}`);
  check('and it still removes some material rather than filling the box',
        area(fat) < fatH * fatW);

  // ── The width typed into the dialog has to be used ──────────────
  // getSectionW read only `bf`, which the dialog never writes — it writes
  // `b`. Every width entered by hand was discarded and a width back-solved
  // from A and the depth used instead.
  // ── The dialog preview must draw the same shape ────────────────
  // The two pictures disagreeing is the whole complaint, so the Z tile gets
  // the same symmetry tests as the extruded profile. Its path was a
  // full-width top edge and a full-width bottom edge either side of a centred
  // web — a symmetric I-beam. The "Z" tile drew the "W" tile's picture.
  const zBranch = fsSrc.slice(fsSrc.indexOf("} else if (id === 'ColdZ') {"),
                              fsSrc.indexOf("} else if (_isChannel(id)) {",
                                            fsSrc.indexOf("} else if (id === 'ColdZ') {")));
  check('the Z preview branch was found', zBranch.length > 100);
  const zPts = [...zBranch.matchAll(/ctx\.(?:move|line)To\(([^,]+),([^)]+)\)/g)].map(m => {
    // In the preview pw is the section's full width and ph its full depth,
    // so feeding the real dimensions in makes its path directly comparable.
    const ev = (e) => Function('cx','cy','pw','ph','tf_px','tw_px', 'return ' + e)
                        (0, 0, B/1000, D/1000, TF/1000, TW/1000);
    // Canvas y grows downward, so negate it to compare against the profile's
    // depth axis; order is [depth, width] like getCrossSection returns.
    return [-ev(m[2]), ev(m[1])];
  });
  check('it traces eight corners, as a Z has', zPts.length === 8, `${zPts.length}`);
  check('the preview Z is point-symmetric too', point2(zPts));
  check('and mirror-symmetric neither way',
        !mirrorY(zPts) && !mirrorZ(zPts),
        'a full-width top and bottom edge is an I-beam, not a Z');
  near('and it has the same area as the extruded one',
       area(zPts), area(zP), 1e-12);

  near('a width typed into the dialog is used', EX.wOf({ d: 400, b: 150 }, 0.4), 0.15, 1e-12);
  near('the preset library still uses bf',      EX.wOf({ d: 400, bf: 200 }, 0.4), 0.20, 1e-12);
  check('and a section with neither still gets a sane width',
        EX.wOf({ A: 900 }, 0.3) > 0.05 && EX.wOf({ A: 900 }, 0.3) < 1.2);
}

group('ACI slenderness uses the code M1/M2 convention');
{
  // ACI defines M2 as the LARGER end moment and M1 as the smaller, signed for
  // curvature. The two were passed positionally as the solver reports them, so
  // a member carrying its moment at end 1 arrived with M2 = 0 — and Mc = δns·M2
  // is what runACIChecks hands the P-M check as the design moment. A slender
  // column with 60 kNm at its base was checked at M = 0 and reported OK.
  const S = [{ id: 1, name: 'ACI col 300x300', E: 25, fc: 30, A: 900,
               Ix: 67500, I: 67500, d: 300, bf: 300, rho: 25 }];
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const ef = solveFrame(nds, bms, S,
    [{ type: 'nodal', nodeId: 2, fy: -500 }, { type: 'nodal', nodeId: 2, fx: 15 }],
    []).elemForces[0];

  check('the fixture puts its moment entirely at end 1',
        Math.abs(ef.M1) > 50 && Math.abs(ef.M2) < 1e-6,
        `M1 ${ef.M1}, M2 ${ef.M2}`);

  const out = ACIDesign.runACIChecks(ef, S[0], {
    b: 0.3, h: 0.3, fy_rebar: 420, cover: 40, phi_bar: 19,
    memberType: 'column', k: 2.0 });
  const list = out.checks || out;
  const sl = list.find(c => /Slender/.test(c.check || ''));
  const pm = list.find(c => /Column \(ACI/.test(c.check || ''));

  near('M2 is the LARGER end moment, not end 2', sl.M2_orig_kNm, Math.abs(ef.M1), 0.01);
  check('the magnified moment is non-zero', sl.Mc_kNm > 0, `Mc = ${sl.Mc_kNm}`);
  check('the P-M check receives that moment, not zero', pm.M_Ed > 0, `M_Ed = ${pm.M_Ed}`);
  check('a column past its buckling load is reported as failing',
        pm.status === 'FAIL', `status ${pm.status}, eta ${pm.eta}`);

  // Direct checks on the helper across the cases that matter.
  const mag = (Pu, M1, M2, k, lu) =>
    ACIDesign.slenderColumnMagnify(Pu, M1, M2, k, lu, 400, 400, 30, 0.6);

  near('M2 picks the larger end regardless of order',
       mag(900, 80, 0, 2.0, 4).M2_orig_kNm, 80, 0.01);
  near('and the same the other way round',
       mag(900, 0, 80, 2.0, 4).M2_orig_kNm, 80, 0.01);
  near('single curvature gives a positive M1/M2',
       mag(900, 40, 80, 2.0, 4).M1_over_M2, 0.5, 0.001);
  near('double curvature gives a negative M1/M2',
       mag(900, -40, 80, 2.0, 4).M1_over_M2, -0.5, 0.001);
  near('the slenderness limit follows 34 - 12(M1/M2)',
       mag(900, 40, 80, 2.0, 4).limit, 34 - 12 * 0.5, 0.01);
  check('and is capped at 40', mag(900, -40, 80, 2.0, 4).limit <= 40);

  // §6.6.4.5.4 floor: M2 >= Pu(15 + 0.03h)
  const floored = mag(900, 0, 0, 2.0, 4);
  near('M2 is floored at Pu(15 + 0.03h)', floored.M2_orig_kNm, 900 * (15 + 0.03 * 400) / 1000, 0.01);
  check('so a nominally unloaded slender column still carries a design moment',
        floored.Mc_kNm > 0, `Mc = ${floored.Mc_kNm}`);

  // A short column reports the same fields rather than leaving them undefined.
  const short = mag(900, 80, 0, 1.0, 3);
  check('short columns are not magnified', short.magnified === false);
  near('short columns still report the larger M2', short.M2_orig_kNm, 80, 0.01);
  near('and pass M2 through as Mc', short.Mc_kNm, 80, 0.01);
}

group('Concrete column checks receive the member effective length');
{
  // The per-member Lcr override and Ky/Kz factors are set in the design table
  // and the member dialog, and EC3 has always used them — but neither concrete
  // branch was told, so every concrete column was checked as pinned-pinned over
  // its own length.
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  check('app.js derives an effective-length factor for the concrete branches',
        /const kEff\s*=/.test(appSrc), 'kEff not computed');
  check('the ACI branch is given k', /k:\s*kEff/.test(appSrc), 'ACI call has no k');
  check('the EC2 branch is given l0', /l0:\s*kEff \*/.test(appSrc), 'EC2 call has no l0');

  // And both checks must actually respond to it.
  const RC = { id: 1, name: 'RC 300x300', E: 25, fck: 30, fc: 30, A: 900,
               Ix: 67500, I: 67500, d: 300, bf: 300, rho: 25 };
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 4 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const ef = solveFrame(nds, bms, [RC],
    [{ type: 'nodal', nodeId: 2, fy: -500 }, { type: 'nodal', nodeId: 2, fx: 15 }],
    []).elemForces[0];

  const lam = k => {
    const o = RCDesign.runRCChecks(ef, RC, { b: 0.3, h: 0.3, fyk: 500, cover: 35,
                phi: 16, memberType: 'column', l0: k * ef.L });
    return (o.checks || o).find(c => /Column/.test(c.check)).lambda;
  };
  near('EC2 slenderness doubles when k doubles', lam(2.0), 2 * lam(1.0), 0.01);

  const klu = k => ACIDesign.slenderColumnMagnify(500, ef.M1, ef.M2, k, ef.L, 300, 300, 30, 0.6).klu_r;
  // klu_r is reported to one decimal, so doubling the rounded value can differ
  // from the rounded double by up to one unit in the last place.
  near('ACI klu/r doubles when k doubles', klu(2.0), 2 * klu(1.0), 0.15);
}

group('EC2 column N-M interaction (EN 1992-1-1 6.1)');
{
  // columnDesign is an axial + slenderness screen — NRd,0 is the squash load and
  // carries no moment, so it cannot say whether a column with both N and M is
  // adequate. This is the strain-compatibility envelope the ACI path has always
  // had, built on the same rectangular stress block the rest of the module uses.
  const b = 0.4, h = 0.4, fck = 30, fyk = 500, As = 2513, cov = 35, phi = 20;
  const dia   = RCDesign.columnInteraction(b, h, fck, fyk, As, cov, phi);
  const conc  = RCDesign.concreteMaterial(fck);
  const steel = RCDesign.steelMaterial(fyk);
  const P = dia.points;

  // ── Envelope shape ──────────────────────────────────────────────────────
  check('the envelope is ordered in N', P.every((p, i) => i === 0 || p.N_kN >= P[i-1].N_kN - 1e-9));
  check('moment capacity is never negative', P.every(p => p.M_kNm >= -1e-9));
  near('pure tension carries no moment', P[0].M_kNm, 0, 1e-6);
  near('pure compression carries no moment', P[P.length - 1].M_kNm, 0, 1e-6);

  // ── End points against first principles ─────────────────────────────────
  const sig = e => Math.max(-steel.fyd, Math.min(steel.fyd, steel.Es * e));
  near('NRd,min = -As.fyd', dia.NRd_min, -As * steel.fyd / 1000, 0.1);
  near('NRd,max = eta.fcd.Ac + As.sigma(eps_c2)', dia.NRd_max,
       (dia.eta * conc.fcd * 400 * 400 + As * sig(conc.eps_c2)) / 1000, 0.1);
  check('the squash load does not overshoot the eps_cu2 sweep',
        Math.max(...P.map(p => p.N_kN)) <= dia.NRd_max + 1e-6,
        `sweep peak ${Math.max(...P.map(p => p.N_kN))} vs NRd,max ${dia.NRd_max}`);

  // Pure bending against the ordinary singly-reinforced estimate As.fyd.0.9d.
  const MRd0 = RCDesign.columnPMCheck(0, 1, b, h, fck, fyk, As, cov, phi).MRd_at_N;
  check('pure-bending capacity is within 10% of As.fyd.0.9d',
        Math.abs(MRd0 - (As / 2) * steel.fyd * 0.9 * (400 - 45) / 1e6) / MRd0 < 0.10,
        `MRd = ${MRd0}`);

  // The balanced point is the peak of the envelope and sits in compression.
  const bal = P.reduce((a, p) => (p.M_kNm > a.M_kNm ? p : a), P[0]);
  check('the balanced point is in compression', bal.N_kN > 0, `N = ${bal.N_kN}`);
  check('and carries more moment than pure bending', bal.M_kNm > MRd0,
        `${bal.M_kNm} vs ${MRd0}`);

  // ── Utilisation ─────────────────────────────────────────────────────────
  const chk = (N, M) => RCDesign.columnPMCheck(N, M, b, h, fck, fyk, As, cov, phi);
  near('a demand ON the envelope is exactly fully utilised',
       chk(bal.N_kN, bal.M_kNm).eta, 1.0, 0.02);
  check('half that moment is about half utilised',
        Math.abs(chk(bal.N_kN, bal.M_kNm / 2).eta - 0.5) < 0.02,
        `eta = ${chk(bal.N_kN, bal.M_kNm / 2).eta}`);
  check('axial beyond NRd,max fails', chk(dia.NRd_max * 1.2, 10).status === 'FAIL');
  check('tension beyond NRd,min fails', chk(dia.NRd_min * 1.1, 0).status === 'FAIL');
  check('a lightly loaded column passes', chk(500, 50).status === 'OK',
        `eta = ${chk(500, 50).eta}`);

  // More steel must not reduce capacity.
  const small = RCDesign.columnPMCheck(1000, 100, b, h, fck, fyk, 1200, cov, phi);
  const large = RCDesign.columnPMCheck(1000, 100, b, h, fck, fyk, 4000, cov, phi);
  check('more reinforcement raises the moment capacity', large.MRd_at_N > small.MRd_at_N,
        `${large.MRd_at_N} vs ${small.MRd_at_N}`);
  check('and lowers the utilisation', large.eta < small.eta);

  // ── Wired into the EC2 member checks, columns only ──────────────────────
  const RC = { id: 1, name: 'RC 400x400', E: 25, fck: 30, A: 1600,
               Ix: 213333, I: 213333, d: 400, bf: 400, rho: 25 };
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }];
  const bms = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const ef = solveFrame(nds, bms, [RC],
    [{ type: 'nodal', nodeId: 2, fy: -900 }, { type: 'nodal', nodeId: 2, fx: 30 }],
    []).elemForces[0];
  const run = mt => {
    const o = RCDesign.runRCChecks(ef, RC, { b: 0.4, h: 0.4, fyk: 500, cover: 35,
                phi: 16, memberType: mt });
    return (o.checks || o).find(c => /N-M Interaction/.test(c.check || ''));
  };
  check('a column gets the N-M interaction check', !!run('column'));
  check('a beam does not', !run('beam'));
  const pm = run('column');
  if (pm) {
    near('it sees the applied axial load', pm.N_Ed, 900, 1e-3);
    near('and the applied moment', pm.M_Ed, Math.abs(ef.M1), 1e-3);
    check('it reports a moment capacity at that axial load', pm.MRd_at_N > 0);
    check('and a finite utilisation', Number.isFinite(pm.eta) && pm.eta > 0);
  }
}

group('Member end releases actually release');
{
  // The beam table, the canvas hinge tool, the drawn symbol and the .frame file
  // all carried hingeStart / hingeEnd from the beginning. No solver read them:
  // a propped cantilever with its fixed end released returned M1 = 80 kNm and
  // R1 = 50 kN either way, when releasing makes it simply supported at M1 = 0
  // and R1 = 40 kN. The control looked like it worked, which is the worst way
  // for it to fail. Released rotations are now condensed out of the element.
  const S = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
  const nds = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 8, y: 0, support: 'roller' }];
  const udl = [{ type: 'beam_dist', elementId: 1, fy: -10 }];
  const run = bm => solveFrame(nds, [{ id: 1, node1: 1, node2: 2, sectionId: 1, ...bm }],
                               S, udl, []);

  // Unreleased: propped cantilever.
  const plain = run({});
  near('propped cantilever: M at the fixed end is wL²/8',
       Math.abs(plain.elemForces[0].M1), 10 * 64 / 8, 0.01);
  near('and the fixed-end reaction is 5wL/8', plain.reactions[1].Ry, 5 * 10 * 8 / 8, 0.01);

  // Released: the same member becomes simply supported.
  const rel = run({ hingeStart: true });
  near('released end carries no moment', rel.elemForces[0].M1, 0, 1e-9);
  near('and both reactions become wL/2', rel.reactions[1].Ry, 10 * 8 / 2, 0.01);
  near('the far reaction too', rel.reactions[2].Ry, 10 * 8 / 2, 0.01);
  check('releasing changed the answer at all',
        Math.abs(plain.reactions[1].Ry - rel.reactions[1].Ry) > 1,
        'the release flag is still being ignored');

  // Both ends released: a link, no moment anywhere, still in equilibrium.
  const both = run({ hingeStart: true, hingeEnd: true });
  check('a member released at both ends still solves', !!both.success, both.error);
  if (both.success) {
    near('both ends released: M1 = 0', both.elemForces[0].M1, 0, 1e-9);
    near('both ends released: M2 = 0', both.elemForces[0].M2, 0, 1e-9);
    near('and vertical equilibrium still holds',
         both.reactions[1].Ry + both.reactions[2].Ry, 80, 1e-6);
    check('the dangling rotation is reported', both.releasedRotations >= 1,
          `releasedRotations = ${both.releasedRotations}`);
  }

  // A release stops moment reaching the node, so the adjacent span sees none.
  {
    const n3 = [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 8, y: 0, support: 'roller' },
                { id: 3, x: 16, y: 0, support: 'roller' }];
    const b3 = [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
                { id: 2, node1: 2, node2: 3, sectionId: 1, hingeStart: true }];
    const l3 = [{ type: 'beam_dist', elementId: 1, fy: -10 },
                { type: 'beam_dist', elementId: 2, fy: -10 }];
    const r = solveFrame(n3, b3, S, l3, []);
    near('the released span carries no moment at that end', r.elemForces[1].M1, 0, 1e-9);
    near('so the adjacent span becomes a simple span', r.elemForces[0].M2, 0, 1e-9);
    near('and the frame is still in equilibrium',
         r.reactions[1].Ry + r.reactions[2].Ry + r.reactions[3].Ry, 160, 1e-6);
  }

  // Every solve path has to condense the same way, or switching analysis type
  // silently changes the structure — the failure mode the rigid-zone work hit.
  {
    const pd = PDeltaAnalysis.runPDelta(nds,
      [{ id: 1, node1: 1, node2: 2, sectionId: 1, hingeStart: true }], S, udl, [],
      { maxIter: 30, tolerance: 1e-12 });
    check('P-Δ solves the released member', !!pd.success, pd.error);
    if (pd.success) {
      near('P-Δ: released end carries no moment', pd.elemForces[0].M1, 0, 1e-6);
      near('P-Δ reactions match the linear solve',
           pd.reactions[1].Ry, rel.reactions[1].Ry, 1e-3);
    }
  }
  {
    const n3d = [{ id: 1, x: 0, y: 0, z: 0, support: 'fixed' },
                 { id: 2, x: 8, y: 0, z: 0, support: 'pin' }];
    const plain3 = solveFrame3D(n3d, [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S, udl, []);
    const rel3   = solveFrame3D(n3d, [{ id: 1, node1: 1, node2: 2, sectionId: 1, hingeStart: true }],
                                S, udl, []);
    check('3D solves both', !!plain3.success && !!rel3.success, plain3.error || rel3.error);
    if (rel3.success) {
      near('3D: released end carries no bending moment', rel3.elemForces[0].Mz1, 0, 1e-6);
      check('3D: the release changed the reaction',
            Math.abs(plain3.reactions[1].Rz - rel3.reactions[1].Rz) > 1,
            `${plain3.reactions[1].Rz} vs ${rel3.reactions[1].Rz}`);
    }
  }

  // Modal: releasing both ends of a fixed-fixed beam must give the
  // simply-supported fundamental — (βL)² goes from 22.373 to 9.8696.
  {
    const mk = release => {
      const N = 10, nodes = [], beams = [];
      for (let i = 0; i <= N; i++)
        nodes.push({ id: i + 1, x: i * 10 / N, y: 0,
                     support: (i === 0 || i === N) ? 'fixed' : undefined });
      for (let i = 0; i < N; i++)
        beams.push({ id: i + 1, node1: i + 1, node2: i + 2, sectionId: 1,
                     hingeStart: release && i === 0, hingeEnd: release && i === N - 1 });
      return ModeShapeAnalysis.computeModes(nodes, beams, S, 3);
    };
    const cc = mk(false), ss = mk(true);

    // Pin/roller supports leave the end ROTATIONS free, so releasing the end
    // members strands them with no stiffness at all. Without the guard the
    // Cholesky inside the subspace iteration fails and every such model comes
    // back "No valid modes found" — the fixed-fixed case above cannot show this
    // because its end rotations are already constrained by the support.
    {
      const N = 8, nodes = [], beams = [];
      for (let i = 0; i <= N; i++)
        nodes.push({ id: i + 1, x: i * 10 / N, y: 0,
                     support: i === 0 ? 'pin' : (i === N ? 'roller' : undefined) });
      for (let i = 0; i < N; i++)
        beams.push({ id: i + 1, node1: i + 1, node2: i + 2, sectionId: 1,
                     hingeStart: i === 0, hingeEnd: i === N - 1 });
      const m = ModeShapeAnalysis.computeModes(nodes, beams, S, 3);
      check('a stranded rotation does not break modal analysis', !m.error, m.error);
      if (!m.error)
        check('and the fundamental is still sensible',
              m.modes[0].freq > 1 && m.modes[0].freq < 100, `f1 = ${m.modes[0].freq}`);
    }
    check('modal analysis handles released ends', !cc.error && !ss.error, cc.error || ss.error);
    if (!cc.error && !ss.error) {
      check('releasing both ends softens the beam', ss.modes[0].freq < cc.modes[0].freq,
            `${ss.modes[0].freq} vs ${cc.modes[0].freq}`);
      near('to exactly the simply-supported frequency ratio',
           ss.modes[0].freq / cc.modes[0].freq, 9.8696 / 22.373, 0.02);
    }
  }
}

group('Banded solver agrees with the dense one it replaced');
{
  // The stiffness matrix is symmetric, positive definite for a supported
  // structure, and its non-zeros hug the diagonal. Dense Gauss ignored all three
  // and cost O(n^3): a 1225-node frame took 7.35 s where its half-bandwidth was
  // only 108. Banded LDL^T is O(n.b^2) — the same frame now solves in 0.5 s —
  // and the dense path remains as the fallback whenever the band solve declines,
  // so the answer can never differ, only arrive sooner.
  const S = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, rho: 78.5 }];

  // Load solver.js a second time with the banded call removed, to compare paths.
  const solverSrc = fs.readFileSync(path.join(ROOT, 'js/solver.js'), 'utf8');
  const denseSrc  = solverSrc.replace(
    'if (nf > 12 && bw > 0 && bw < nf / 2) U_f = bandSolve(K, freeDofs, RHS, bw);', '');
  check('the banded call site is where the test expects it',
        denseSrc !== solverSrc, 'band solve call not found — test is stale');
  const dctx = { console, Math, JSON, Number, Date, isFinite, parseFloat, parseInt,
                 Float64Array, Int32Array, Uint8Array, Array, Object, Set, Map,
                 Infinity, NaN };
  vm.createContext(dctx); dctx.window = dctx;
  vm.runInContext(denseSrc, dctx, { filename: 'solver-dense' });
  const solveDense = dctx.solveFrame;

  const frame = (bays, storeys) => {
    const nodes = [], beams = [], grid = [];
    let id = 1, bid = 1;
    for (let y = 0; y <= storeys; y++) {
      grid[y] = [];
      for (let x = 0; x <= bays; x++) {
        nodes.push({ id, x: x * 6, y: y * 4, support: y === 0 ? 'fixed' : undefined });
        grid[y][x] = id++;
      }
    }
    for (let y = 0; y < storeys; y++) for (let x = 0; x <= bays; x++)
      beams.push({ id: bid++, node1: grid[y][x], node2: grid[y + 1][x], sectionId: 1 });
    for (let y = 1; y <= storeys; y++) for (let x = 0; x < bays; x++)
      beams.push({ id: bid++, node1: grid[y][x], node2: grid[y][x + 1], sectionId: 1 });
    return { nodes, beams };
  };

  for (const [bays, storeys] of [[3, 3], [6, 6], [9, 9]]) {
    const m = frame(bays, storeys);
    // Mixed loading so the comparison exercises axial and transverse terms.
    const lds = m.beams.map((b, i) => ({ id: i + 1, type: 'beam_dist',
                                         elementId: b.id, fy: -10, fx: 2 }));
    const rb = solveFrame(m.nodes, m.beams, S, lds, []);
    const rd = solveDense(m.nodes, m.beams, S, lds, []);
    const tag = `${m.nodes.length}-node frame`;
    check(`${tag}: both paths solve`, !!rb.success && !!rd.success, rb.error || rd.error);
    if (!rb.success || !rd.success) continue;

    let dU = 0, dR = 0, dM = 0;
    for (const k of Object.keys(rb.disp))
      dU = Math.max(dU, Math.abs(rb.disp[k].u - rd.disp[k].u),
                        Math.abs(rb.disp[k].v - rd.disp[k].v));
    for (const k of Object.keys(rb.reactions))
      dR = Math.max(dR, Math.abs(rb.reactions[k].Ry - rd.reactions[k].Ry));
    for (let i = 0; i < rb.elemForces.length; i++)
      dM = Math.max(dM, Math.abs(rb.elemForces[i].M1 - rd.elemForces[i].M1));

    check(`${tag}: displacements match the dense solve`, dU < 1e-9, `max Δ = ${dU}`);
    check(`${tag}: reactions match`,   dR < 1e-6, `max Δ = ${dR}`);
    check(`${tag}: member moments match`, dM < 1e-6, `max Δ = ${dM}`);

    // And the answer is still right in absolute terms, not just consistent.
    let sumRy = 0;
    for (const k of Object.keys(rb.reactions)) sumRy += rb.reactions[k].Ry;
    const applied = rb.elemForces.reduce((t, ef) => t + 10 * ef.L, 0);
    check(`${tag}: still in vertical equilibrium`,
          Math.abs(sumRy - applied) < 1e-6 * applied, `ΣRy ${sumRy} vs ${applied}`);
  }

  // Small systems stay on the dense path, and must still be exact.
  {
    const r = solveFrame(
      [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 8, y: 0, support: 'roller' }],
      [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S,
      [{ type: 'beam_dist', elementId: 1, fy: -10 }], []);
    near('a two-node beam still gives wL²/8', Math.abs(r.elemForces[0].M1), 0, 1e-9);
    near('and wL/2 at each support', r.reactions[1].Ry, 40, 1e-9);
  }

  // A mechanism is not positive definite, so the band solve declines and the
  // pivoting dense path reports it — the fallback has to stay wired up.
  {
    const r = solveFrame(
      [{ id: 1, x: 0, y: 0, support: 'roller' }, { id: 2, x: 6, y: 0, support: 'roller' }],
      [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S,
      [{ type: 'nodal', nodeId: 2, fx: 10 }], []);
    check('a mechanism is still reported through the fallback', !!r.error, JSON.stringify(r.disp));
  }
}

group('Critical load factors are computed and reported');
{
  // criticalLoadFactors() was finished and exported in pdelta.js with nothing
  // calling it — a buckling check on the shelf. It rides with the P-Δ run,
  // because λcr needs the second-order axial forces to be meaningful.
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, rho: 78.5 }];
  const nodes = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 8 },
                 { id: 3, x: 6, y: 8 }, { id: 4, x: 6, y: 0, support: 'fixed' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
                 { id: 2, node1: 2, node2: 3, sectionId: 1 },
                 { id: 3, node1: 3, node2: 4, sectionId: 1 }];
  const lds = [{ type: 'nodal', nodeId: 2, fy: -600 }, { type: 'nodal', nodeId: 3, fy: -600 },
               { type: 'nodal', nodeId: 2, fx: 25 }];
  const pd = PDeltaAnalysis.runPDelta(nodes, beams, S, lds, [], { maxIter: 30, tolerance: 1e-10 });
  check('the slender sway frame converges under P-Δ', !!pd.success && pd.converged, pd.error);

  const bk = PDeltaAnalysis.criticalLoadFactors(pd.elemForces, beams, S);
  check('a factor is produced for every member', bk.length === beams.length, `${bk.length}`);

  const cols = bk.filter(b => b.N_comp > 1);
  check('the compressed columns are identified', cols.length >= 2, `${cols.length} in compression`);
  for (const c of cols) {
    // λcr = Ncr/NEd with Ncr the Euler load π²EI/L². Each member has its own
    // length — the columns are 8 m, the rafter 6 m — so read it back from the
    // element rather than assuming one value for all three.
    const ef  = pd.elemForces.find(e => e.id === c.beamId);
    const Ncr = Math.PI ** 2 * 210e6 * (8356 / 1e8) / (ef.L * ef.L);
    near(`member ${c.beamId}: Ncr is the Euler load for its own length`, c.Ncr, Ncr, 1);
    // Both Ncr and N_comp are reported rounded to 3 dp, so compare the ratio
    // relatively rather than to a fixed absolute slack.
    const lcrExpect = Ncr / c.N_comp;
    check(`member ${c.beamId}: λcr = Ncr/N_Ed`,
          Math.abs(c.lambda_cr - lcrExpect) / lcrExpect < 1e-3,
          `${c.lambda_cr} vs ${lcrExpect}`);
  }
  // Tension members cannot buckle and must not be ranked as if they could.
  for (const b of bk)
    if (b.N_comp === 0) check(`member ${b.beamId} in tension reports no buckling risk`,
                              b.lambda_cr >= 999, `λcr = ${b.lambda_cr}`);

  // EC3 §5.2.1(3): first-order analysis needs αcr ≥ 10. The bands used to be
  // 1.5 / 3.0, which rated a frame at αcr = 4.4 as 'LOW' while the note printed
  // beside it said 'recommend ≥ 10 for sway frames'.
  const risks = Object.fromEntries(bk.map(b => [b.beamId, b.risk]));
  for (const b of bk) {
    const want = b.lambda_cr < 3 ? 'HIGH' : b.lambda_cr < 10 ? 'MODERATE' : 'LOW';
    check(`member ${b.beamId} risk band matches EC3 thresholds`, risks[b.beamId] === want,
          `λcr ${b.lambda_cr} rated ${risks[b.beamId]}, expected ${want}`);
  }

  // And the report surfaces it, but only for a P-Δ run and only for members
  // that are actually in compression.
  {
    const withB = Object.assign({}, pd, { buckling: bk });
    const html = ReportGenerator.generate({ nodes, beams, sections: S, loads: lds, results: withB });
    check('the report includes the buckling section', /Elastic Critical Load Factors/.test(html));
    check('and does not list tension members', !/>∞</.test(html), 'infinite λcr rows leaked in');

    const lin = solveFrame(nodes, beams, S, lds, []);
    const html2 = ReportGenerator.generate({ nodes, beams, sections: S, loads: lds, results: lin });
    check('a linear-only report omits it', !/Elastic Critical Load Factors/.test(html2));
  }
}

group('Model fingerprint covers everything the cache depends on');
{
  // The results cache is keyed on modelHash. Anything the solvers read that the
  // fingerprint misses would serve a stale answer — and member releases now
  // change the answer, so they have to be in there.
  const base = portal();
  const lds = [{ type: 'beam_dist', elementId: 2, fy: -10 }];
  const h = (n, b, s, l) => StructDB.modelHash(n, b, s, l, []);
  const h0 = h(base.nodes, base.beams, SEC, lds);
  const clone = o => JSON.parse(JSON.stringify(o));

  const moved = {
    'a start release': () => { const b = clone(base.beams); b[0].hingeStart = true;
                               return h(base.nodes, b, SEC, lds); },
    'an end release':   () => { const b = clone(base.beams); b[0].hingeEnd = true;
                               return h(base.nodes, b, SEC, lds); },
  };
  for (const [what, fn] of Object.entries(moved))
    check(`${what} changes the fingerprint`, fn() !== h0,
          'a cached result would be served for a different structure');
}

group('Design spectrum shapes follow the code branches');
{
  const RS = ResponseSpectrum;

  // ASCE 7-16 §11.4.5. Sds = 1.0 g, Sd1 = 0.6 g ⇒ Ts = 0.6 s, T0 = 0.12 s.
  const a = RS.asce7Spectrum(1.0, 0.6, 8);
  near('ASCE: Sa(0) = 0.4·Sds',            a(0),    0.4,  1e-12);
  near('ASCE: ramps up to Sds at T0',      a(0.12), 1.0,  1e-12);
  near('ASCE: the ramp is linear',         a(0.06), 0.7,  1e-12);
  near('ASCE: plateau holds out to Ts',    a(0.4),  1.0,  1e-12);
  near('ASCE: Sd1/T beyond Ts',            a(1.2),  0.5,  1e-12);
  near('ASCE: continuous across Ts',       a(0.6),  1.0,  1e-12);
  near('ASCE: Sd1·TL/T² beyond TL',        a(16),   0.6 * 8 / 256, 1e-12);
  near('ASCE: continuous across TL',       a(8),    0.075, 1e-12);
  check('ASCE: a missing Sd1 is refused',  RS.asce7Spectrum(1.0, 0) === null);

  // EN 1998-1 §3.2.2.5. ag = 0.25 g, S = 1.2, q = 4, beta = 0.2.
  const e = RS.ec8Spectrum(0.25, 1.2, 0.15, 0.5, 2.0, 4, 0.2);
  const plateau = 0.25 * 1.2 * 2.5 / 4;
  near('EC8: plateau = ag·S·2.5/q',          e(0.3),  plateau, 1e-12);
  near('EC8: starts from 2/3·ag·S at T = 0', e(0),    0.25 * 1.2 * 2 / 3, 1e-12);
  near('EC8: reaches the plateau at TB',     e(0.15), plateau, 1e-12);
  near('EC8: decays as TC/T',                e(1.0),  plateau * 0.5, 1e-12);
  near('EC8: decays as TC·TD/T² beyond TD',  e(4.0),  Math.max(plateau * 0.5 * 2 / 4, 0.05), 1e-12);
  // The beta·ag floor is the point of the lower bound — a long-period structure
  // must not end up designed for an arbitrarily small force. It has to bind on
  // BOTH decaying branches: with these parameters the TC/T branch drops under
  // the floor at about T = 1.85 s, well before TD at 2.0 s.
  near('EC8: the floor binds on the TC/T branch',    e(1.9), 0.2 * 0.25, 1e-12);
  near('EC8: and does not bind before it is due',    e(1.5), plateau * 0.5 / 1.5, 1e-12);
  near('EC8: the floor binds beyond TD as well',     e(2.5), 0.2 * 0.25, 1e-12);
  check('EC8: never drops below beta·ag', e(50) >= 0.2 * 0.25 - 1e-12, `${e(50)}`);
  check('EC8: q = 0 is refused',          RS.ec8Spectrum(0.25, 1.2, 0.15, 0.5, 2, 0) === null);

  // User-supplied table
  const t = RS.tableSpectrum([{ T: 0.2, Sa: 0.8 }, { T: 1.0, Sa: 0.4 }, { T: 2.0, Sa: 0.1 }]);
  near('table: interpolates linearly',            t(0.6), 0.6, 1e-12);
  near('table: holds flat below the first point', t(0.05), 0.8, 1e-12);
  near('table: holds flat above the last',        t(9),    0.1, 1e-12);
  near('table: returns a supplied point exactly', t(1.0),  0.4, 1e-12);
  check('table: unsorted input is sorted first',
        Math.abs(RS.tableSpectrum([{ T: 2, Sa: 0.1 }, { T: 0.2, Sa: 0.8 }])(1.1) - 0.45) < 1e-12);
  check('table: a single point is not a spectrum', RS.tableSpectrum([{ T: 1, Sa: 1 }]) === null);
}

group('Modal combination rules');
{
  const RS = ResponseSpectrum;

  // rho must be 1 on the diagonal and symmetric, or the quadratic form is not
  // a correlation matrix at all.
  near('CQC: rho = 1 for a mode with itself', RS.cqcRho(10, 10, 0.05), 1, 1e-12);
  near('CQC: rho is symmetric', RS.cqcRho(10, 30, 0.05), RS.cqcRho(30, 10, 0.05), 1e-12);
  check('CQC: rho decays as the modes separate',
        RS.cqcRho(10, 11, 0.05) > RS.cqcRho(10, 30, 0.05));
  check('CQC: rho stays inside [0, 1]',
        [[1, 1], [1, 1.05], [1, 2], [1, 10], [3, 1]].every(([i, j]) => {
          const r = RS.cqcRho(i, j, 0.05); return r >= 0 && r <= 1 + 1e-12;
        }));

  near('SRSS: root of 3² + 4² is 5', RS.combine([3, -4], [10, 40], 'SRSS', 0.05), 5, 1e-12);
  near('SRSS: one mode returns its own magnitude',
       RS.combine([-7], [10], 'SRSS', 0.05), 7, 1e-12);
  near('CQC: one mode returns its own magnitude',
       RS.combine([-7], [10], 'CQC', 0.05), 7, 1e-12);
  near('either rule on no modes is zero', RS.combine([], [], 'CQC', 0.05), 0, 1e-12);

  // Well-separated modes are nearly uncorrelated, so CQC collapses onto SRSS.
  // Closely-spaced ones do not — which is exactly when SRSS misleads.
  const wide = [10, 100], tight = [10, 10.2];
  near('CQC matches SRSS when the modes are far apart',
       RS.combine([3, 4], wide, 'CQC', 0.05), 5, 0.05);
  check('CQC exceeds SRSS for close, same-signed modes',
        RS.combine([3, 4], tight, 'CQC', 0.05) > RS.combine([3, 4], tight, 'SRSS', 0.05) + 0.5,
        `${RS.combine([3, 4], tight, 'CQC', 0.05)} vs ${RS.combine([3, 4], tight, 'SRSS', 0.05)}`);
  check('and falls below it for close, opposed modes',
        RS.combine([3, -4], tight, 'CQC', 0.05) < RS.combine([3, -4], tight, 'SRSS', 0.05),
        'opposing close modes have to partially cancel');
  check('both rules return magnitudes',
        RS.combine([-3, -4], wide, 'CQC', 0.05) > 0 &&
        RS.combine([-3, -4], wide, 'SRSS', 0.05) > 0);
}

group('Response spectrum reproduces the modal equations');
{
  const RS = ResponseSpectrum;
  const P = portal();
  // A flat spectrum gives every mode the same Sa, so any per-mode discrepancy
  // is the analysis rather than the shape of the curve.
  const flat = () => 1.0;
  flat.meta = { code: 'flat 1.0 g' };

  // Capture every static solve the module makes so each mode can be checked
  // against the equation it is meant to satisfy.
  const calls = [];
  const spy = (n, b, s, l, st) => {
    const res = solveFrame(n, b, s, l, st);
    calls.push({ loads: l, res });
    return res;
  };

  const out = RS.run(P.nodes, P.beams, SEC,
                     { spectrum: flat, direction: 'X', numModes: 6, rule: 'SRSS', solve: spy });
  check('the run succeeds', !!out.success, out.error);
  check('one static solve per reported mode', calls.length === out.modeCount,
        `${calls.length} solves against ${out.modeCount} modes`);

  const modal = ModeShapeAnalysis.computeModes(P.nodes, P.beams, SEC, 6);
  const g = 9.81;

  out.modes.forEach((md, k) => {
    const src  = modal.modes.find(m => m.modeNum === md.modeNum);
    const call = calls[k];

    // 1. The applied vector is F = Γ·Sa·M·φ, so its X components sum to
    //    Γ·Sa·(rᵀMφ) = Γ²·Sa — the modal base shear. Compare against the
    //    unrounded Γ from the modal solver: the reported one is trimmed to
    //    five decimals for display, which alone is worth a part in 10⁵ here.
    const G1    = src.gammaX;
    const sumFx = call.loads.reduce((s, l) => s + (l.fx || 0), 0);
    near(`mode ${md.modeNum}: the applied force sums to the modal base shear`,
         sumFx, G1 * G1 * g, Math.abs(G1 * G1 * g) * 1e-12 + 1e-14);
    near(`mode ${md.modeNum}: reported base shear is Γ²·Sa`,
         md.baseShear, G1 * G1 * g, 1e-3);

    // 2. Equilibrium: the supports return exactly what was applied.
    let sumRx = 0;
    for (const id in call.res.reactions) sumRx += call.res.reactions[id].Rx || 0;
    near(`mode ${md.modeNum}: the reactions balance the applied force`,
         sumRx, -sumFx, Math.abs(sumFx) * 1e-8 + 1e-9);

    // 3. The defining identity. Solving K·u = Γ·Sa·M·φ has to return
    //    u = (Γ·Sa/ω²)·φ, because K·φ = ω²·M·φ. This is what licenses pushing
    //    the equivalent forces through the ordinary static solver rather than
    //    writing a second displacement-recovery path that could drift from it.
    const scale = G1 * g / (src.omega * src.omega);
    let worst = 0, ref = 0;
    P.nodes.forEach((nd, i) => {
      const expect = scale * src.phiMass[i * 3];
      const got    = call.res.disp[nd.id].u;
      worst = Math.max(worst, Math.abs(got - expect));
      ref   = Math.max(ref, Math.abs(expect));
    });
    check(`mode ${md.modeNum}: u = (Γ·Sa/ω²)·φ at every node`,
          worst <= ref * 1e-9, `worst error ${worst} against a peak of ${ref}`);
  });

  // Effective modal mass is Γ², and those sum to the participating mass.
  // Both figures are reported rounded, so allow for that and no more.
  const sumEff = out.modes.reduce((s, m) => s + m.effMass, 0);
  near('the effective masses sum to the captured fraction',
       sumEff / out.totalMass * 100, out.massCaptured, 0.05);
  // Six modes on six free DOFs is the complete basis — every bit of mass is
  // accounted for, which is the sharpest available check on the participation
  // factors as a set.
  near('a complete modal basis captures all of the mass', out.massCaptured, 100, 0.01);
  check('the captured fraction is a real fraction',
        out.massCaptured > 0 && out.massCaptured <= 100.01, `${out.massCaptured}%`);

  // A combined value cannot be smaller than its largest contributor, nor
  // larger than all of them arriving together.
  const maxMode = Math.max(...out.modes.map(m => Math.abs(m.baseShear)));
  const sumMode = out.modes.reduce((s, m) => s + Math.abs(m.baseShear), 0);
  check('the combined base shear is bracketed by the modal values',
        out.baseShear >= maxMode - 1e-6 && out.baseShear <= sumMode + 1e-6,
        `${out.baseShear} falls outside [${maxMode}, ${sumMode}]`);
}

group('The report carries the response spectrum');
{
  const RS = ResponseSpectrum;
  const P = portal();
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };
  const rs = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, R: 3 });
  const lin = solveFrame(P.nodes, P.beams, SEC, [{ type: 'nodal', nodeId: 2, fx: 30 }], []);
  const base = { nodes: P.nodes, beams: P.beams, sections: SEC, loads: [], results: lin };

  const withRS = ReportGenerator.generate(Object.assign({}, base, { spectrum: rs }));
  check('the section appears once a spectrum has been run',
        /Response Spectrum Analysis/.test(withRS));
  check('the spectrum in force is named', /ASCE 7-16/.test(withRS));
  check('the base shear is stated', new RegExp(rs.baseShear.toFixed(2)).test(withRS));
  check('the combination rule is stated', /CQC/.test(withRS));
  check('R and Ie are stated, since they scale every number below them',
        /R = 3\.00/.test(withRS) && /I<sub>e<\/sub> = 1\.00/.test(withRS));
  check('every mode is listed', rs.modes.every(m => new RegExp('>' + m.modeNum + '<').test(withRS)));
  check('the caveats travel with the numbers',
        rs.notes.every(n => withRS.indexOf(n.slice(0, 40)) >= 0),
        'a note was dropped between the analysis and the report');

  // Absent a spectrum run the report must not imply one happened.
  const without = ReportGenerator.generate(base);
  check('and is absent when no spectrum was run',
        !/Response Spectrum Analysis/.test(without));
  check('a failed run is not reported as though it succeeded',
        !/Response Spectrum Analysis/.test(
          ReportGenerator.generate(Object.assign({}, base,
            { spectrum: { error: 'no spectrum' } }))));

  // A scaled run has to show its working: the ELF comparison is what justifies
  // every number in the tables above it being larger than the analysis gave.
  const sc = RS.run(P.nodes, P.beams, SEC,
    { spectrum: spec, numModes: 6, R: 3, scaleToELF: true, system: 'concreteMoment' });
  const scHtml = ReportGenerator.generate(Object.assign({}, base, { spectrum: sc }));
  check('the ELF block appears when the comparison was made',
        /Equivalent lateral force/.test(scHtml));
  check('the structural system behind Ta is named',
        /Concrete moment-resisting frame/.test(scHtml));
  check('the applied §12.9.1.4 factor is stated',
        new RegExp(sc.scaleFactor.toFixed(3)).test(scHtml), `factor ${sc.scaleFactor}`);
  check('and the ELF block is absent when no comparison was made',
        !/Equivalent lateral force/.test(withRS));

  // A space frame carries torsion and a second bending plane. The spectrum
  // combines them, so a report that printed only the 2D aliases would leave a
  // twisting mode's whole effect out of the document that records it.
  {
    const S3 = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
    const H = 4, B = 5, D = 6;
    const n3 = [[0,0,0],[B,0,0],[B,D,0],[0,D,0],[0,0,H],[B,0,H],[B,D,H],[0,D,H]]
      .map((q, i) => ({ id: i + 1, x: q[0], y: q[1], z: q[2],
                        support: i < 4 ? 'fixed' : 'none' }));
    const b3 = [[1,5],[2,6],[3,7],[4,8],[5,6],[6,7],[7,8],[8,5]]
      .map((e, i) => ({ id: i + 1, node1: e[0], node2: e[1], sectionId: 1 }));
    const rs3 = RS.run(n3, b3, S3, { spectrum: spec, is3D: true, numModes: 8, R: 3 });
    const lin3 = solveFrame3D(n3, b3, S3, [{ type: 'nodal', nodeId: 5, fx: 20 }], []);
    const h3 = ReportGenerator.generate({ nodes: n3, beams: b3, sections: S3,
                                          loads: [], results: lin3, spectrum: rs3 });
    check('a 3D report names the torsion column', /\|T\| \(kNm\)/.test(h3));
    check('and both bending planes',
          /\|M<sub>y<\/sub>\|/.test(h3) && /\|M<sub>z<\/sub>\|/.test(h3));
    check('and both shear components',
          /\|V<sub>y<\/sub>\|/.test(h3) && /\|V<sub>z<\/sub>\|/.test(h3));
    check('and says it is a space frame', /Space frame/.test(h3));

    // Headers alone prove only that the columns exist, not that the right
    // numbers sit under them. Shaking this symmetric box along X produces
    // strong-axis moment and no weak-axis moment at all, so the two columns
    // are told apart by their values, not just their labels.
    {
      const worst = rs3.elemForces.slice()
        .sort((a, b) => Math.max(b.M1, b.M2) - Math.max(a.M1, a.M2))[0];
      // Not identically zero: the torsional mode contributes a little weak-axis
      // bending, and combining magnitudes keeps it. Three orders down is still
      // more than enough to tell the two columns apart if they were swapped.
      const wMy = Math.max(worst.My1, worst.My2), wMz = Math.max(worst.Mz1, worst.Mz2);
      check('the box bends overwhelmingly one way',
            wMz > 0.1 && wMy < 0.01 * wMz, `My ${wMy}, Mz ${wMz}`);

      const row = (h3.match(/<tbody>[\s\S]*?<\/tr>/g) || []).pop() || '';
      const cells = (row.match(/<td>([^<]*)<\/td>/g) || [])
        .map(c => c.replace(/<[^>]+>/g, ''));
      check('the 3D member row carries seven cells', cells.length === 7, cells.join('|'));
      // Member, N, Vy, Vz, T, My, Mz
      near('the strong-axis moment lands in the Mz column',
           parseFloat(cells[6]), Math.max(worst.Mz1, worst.Mz2), 0.01);
      near('and the weak-axis column shows the weak-axis value',
           parseFloat(cells[5]), Math.max(worst.My1, worst.My2), 0.01);
      near('the axial column is the axial force',
           parseFloat(cells[1]), Math.max(worst.N1, worst.N2), 0.01);
    }

    check('a 2D report keeps its three force columns',
          /<th>\|M\| \(kNm\)<\/th>/.test(withRS) && !/\|T\| \(kNm\)/.test(withRS));
    check('and does not claim to be a space frame', !/Space frame/.test(withRS));
  }

  // An EC8 run must print the EC8 parameters, not the ASCE ones.
  const ec = RS.run(P.nodes, P.beams, SEC,
                    { spectrum: { code: 'EC8', ag: 0.25, S: 1.2, q: 4 }, numModes: 6 });
  const ecHtml = ReportGenerator.generate(Object.assign({}, base, { spectrum: ec }));
  check('an EC8 report names EN 1998-1', /EN 1998-1/.test(ecHtml));
  check('and prints q rather than R', /q = 4\.00/.test(ecHtml) && !/S<sub>DS<\/sub>/.test(ecHtml));
}

group('Response spectrum scaling, direction and guards');
{
  const RS = ResponseSpectrum;
  const P = portal();
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };
  const base = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6 });
  check('an ASCE 7 spectrum object is accepted', !!base.success, base.error);
  check('the spectrum in force is reported back', base.spectrum.code === 'ASCE 7-16 §11.4.5');

  // R and Ie enter linearly, so the whole answer scales with them. Anything
  // else means a factor is being applied twice, or not at all.
  const halved = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, R: 2 });
  near('R = 2 halves the base shear', halved.baseShear, base.baseShear / 2, base.baseShear * 1e-6);
  const imp = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, Ie: 1.5 });
  near('Ie = 1.5 raises it by half', imp.baseShear, base.baseShear * 1.5, base.baseShear * 1e-6);
  near('member forces scale with R too',
       halved.elemForces[0].M1, base.elemForces[0].M1 / 2,
       Math.abs(base.elemForces[0].M1) * 1e-6 + 1e-9);

  // Y excitation is a different problem with different participation.
  const y = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, direction: 'Y' });
  check('a Y-direction run succeeds', !!y.success, y.error);
  check('and reports its own direction', y.direction === 'Y');
  check('the two directions give different answers',
        Math.abs(y.baseShear - base.baseShear) > 1e-6,
        'X and Y produced the same base shear — the direction flag is being ignored');

  // Every combined quantity is a magnitude.
  check('displacements come back non-negative',
        Object.values(base.disp).every(d => d.u >= 0 && d.v >= 0 && d.theta >= 0));
  check('reactions come back non-negative',
        Object.values(base.reactions).every(r => r.Rx >= 0 && r.Ry >= 0 && r.M >= 0));
  check('member forces come back non-negative',
        base.elemForces.every(e => e.N1 >= 0 && e.M1 >= 0 && e.V2 >= 0));
  check('every member is represented', base.elemForces.length === P.beams.length);

  // Notes the engineer must not be able to miss.
  const joined = base.notes.join(' | ');
  check('the lost-sign warning is always present', /no sign|both senses/i.test(joined));
  check('the self-weight-only mass limit is stated', /self-weight/i.test(joined));
  check('the §12.9.1.4 scaling gap is stated', /12\.9\.1\.4/.test(joined));

  // Mass sitting on a fixed support cannot respond, so participation is
  // measured against the free partition only. The two totals differ, and the
  // reader has to be told which one '99% captured' refers to.
  check('the whole-model mass is reported alongside the free mass',
        base.structuralMass > base.totalMass,
        `free ${base.totalMass} vs model ${base.structuralMass}`);
  check('and the difference is explained when it is material',
        base.totalMass >= 0.98 * base.structuralMass ||
        base.notes.some(n => /free to move/.test(n)),
        'a real restrained-mass share went unmentioned');

  // A model whose supports carry a large share of the mass — a two-element
  // stub — must not claim the whole structure participated.
  const stub = {
    nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 },
            { id: 3, x: 0, y: 6, support: 'fixed' }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
            { id: 2, node1: 2, node2: 3, sectionId: 1 }]
  };
  const st = RS.run(stub.nodes, stub.beams, SEC, { spectrum: spec, numModes: 3 });
  if (st.success) {
    check('a heavily restrained model reports the shortfall',
          st.structuralMass > st.totalMass, `${st.totalMass} of ${st.structuralMass}`);
    check('and says so in the notes',
          st.notes.some(n => /free to move/.test(n)), 'the shortfall passed silently');
  }

  // The portal sways almost entirely in its first mode, so one mode there is
  // legitimately enough and must NOT be warned about. A uniform cantilever is
  // the opposite case: its first mode carries only about 60% of the mass.
  check('a model that really is single-mode draws no warning',
        !RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 1 })
          .notes.some(n => /90%/.test(n)),
        `portal mode 1 captures ${base.modes[0].massPct}% — no warning is due`);

  const mast = {
    nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 2 },
            { id: 3, x: 0, y: 4 }, { id: 4, x: 0, y: 6 }, { id: 5, x: 0, y: 8 }],
    beams: [1, 2, 3, 4].map(i => ({ id: i, node1: i, node2: i + 1, sectionId: 1 }))
  };
  const one = RS.run(mast.nodes, mast.beams, SEC, { spectrum: spec, numModes: 1 });
  check('the cantilever really does under-capture on one mode',
        one.massCaptured < 90, `captured ${one.massCaptured}%`);
  check('and that shortfall is called out',
        one.notes.some(n => /90%/.test(n)), 'the participation shortfall passed silently');
  const many = RS.run(mast.nodes, mast.beams, SEC, { spectrum: spec, numModes: 12 });
  check('more modes capture more mass', many.massCaptured > one.massCaptured,
        `${one.massCaptured}% then ${many.massCaptured}%`);
  check('and the warning goes away once enough is captured',
        many.massCaptured < 90 || !many.notes.some(n => /90%/.test(n)),
        `captured ${many.massCaptured}% but still warned`);

  // Guards
  check('a missing spectrum is refused', !!RS.run(P.nodes, P.beams, SEC, {}).error);
  check('an incomplete ASCE spectrum is refused',
        !!RS.run(P.nodes, P.beams, SEC, { spectrum: { code: 'ASCE7', Sds: 1 } }).error);
  check('an unrecognised code is refused',
        !!RS.run(P.nodes, P.beams, SEC, { spectrum: { code: 'NZS' } }).error);
  const bad = RS.run([{ id: 1, x: 0, y: 0, support: 'fixed' }], [], SEC, { spectrum: spec });
  check('a model with no elements is refused', !!bad.error, JSON.stringify(bad).slice(0, 80));
  check('the modal failure is explained rather than swallowed',
        /modal|element/i.test(bad.error || ''), bad.error);
}

group('CQC and SRSS diverge on repeated modes, as the theory says');
{
  const RS = ResponseSpectrum;
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };

  // Two identical cantilever masts, not connected to one another. Their modes
  // come in exact pairs, and that is the case that separates the two rules.
  //
  // What must NOT be asserted here is a particular ratio between CQC and SRSS.
  // For repeated eigenvalues the modal basis is not unique — any combination of
  // a degenerate pair is equally an eigenvector — and the ratio depends on
  // which combination the iteration happens to return. An earlier version of
  // this test pinned it at root 2 and broke the moment the starting subspace
  // changed, having asserted the eigensolver's arbitrary choice rather than
  // anything physical.
  //
  // The basis-independent statement is the one worth making: two identical
  // masts shaken by one ground motion respond in phase, so the pair must carry
  // exactly twice the base shear of one. CQC gets closer to that than SRSS,
  // which is the whole reason the codes prefer it for close modes.
  const twin = {
    nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }, { id: 3, x: 0, y: 6 },
            { id: 4, x: 9, y: 0, support: 'fixed' }, { id: 5, x: 9, y: 3 }, { id: 6, x: 9, y: 6 }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 }, { id: 2, node1: 2, node2: 3, sectionId: 1 },
            { id: 3, node1: 4, node2: 5, sectionId: 1 }, { id: 4, node1: 5, node2: 6, sectionId: 1 }]
  };
  const single = {
    nodes: twin.nodes.slice(0, 3),
    beams: twin.beams.slice(0, 2)
  };
  const c = RS.run(twin.nodes, twin.beams, SEC, { spectrum: spec, numModes: 8, rule: 'CQC' });
  const s = RS.run(twin.nodes, twin.beams, SEC, { spectrum: spec, numModes: 8, rule: 'SRSS' });
  const c1 = RS.run(single.nodes, single.beams, SEC, { spectrum: spec, numModes: 6, rule: 'CQC' });
  const s1 = RS.run(single.nodes, single.beams, SEC, { spectrum: spec, numModes: 6, rule: 'SRSS' });
  check('every run succeeds', !!c.success && !!s.success && !!c1.success && !!s1.success,
        c.error || s.error || c1.error || s1.error);

  check('the twin masts really do give repeated periods',
        Math.abs(c.modes[0].period - c.modes[1].period) < 1e-6,
        `${c.modes[0].period} and ${c.modes[1].period}`);

  const eCQC  = Math.abs(c.baseShear / c1.baseShear - 2);
  const eSRSS = Math.abs(s.baseShear / s1.baseShear - 2);
  near('CQC gives the pair twice one mast', c.baseShear / c1.baseShear, 2, 0.01);
  check('CQC is closer to it than SRSS', eCQC < eSRSS,
        `CQC off by ${eCQC}, SRSS off by ${eSRSS}`);
  check('and SRSS still errs low, as it does on correlated modes',
        s.baseShear <= c.baseShear + 1e-9,
        `SRSS ${s.baseShear} exceeded CQC ${c.baseShear}`);

  // The rule asked for is the rule applied — and is reported back, so a report
  // cannot claim CQC over numbers that were combined some other way.
  check('a CQC request is honoured', c.rule === 'CQC');
  check('an SRSS request is honoured', s.rule === 'SRSS');
  check('and CQC is the default', RS.run(twin.nodes, twin.beams, SEC,
                                         { spectrum: spec, numModes: 4 }).rule === 'CQC');

  // SRSS over modes this close is exactly what ASCE 7-16 §12.9.1.3 rules out.
  check('SRSS on repeated modes is called out',
        s.notes.some(n => /closely spaced|CQC/i.test(n)), 'no warning against SRSS here');
  check('and CQC draws no such warning',
        !c.notes.some(n => /closely spaced/i.test(n)));
}

group('Equivalent lateral force follows ASCE 7-16 §12.8');
{
  const RS = ResponseSpectrum;

  // A 30 m concrete moment frame, Sds = 1.0 g, Sd1 = 0.6 g, R = 5, Ie = 1,
  // W = 10 000 kN. Every number below is the code equation worked by hand.
  const p = { Sds: 1.0, Sd1: 0.6, TL: 8, R: 5, Ie: 1, W: 10000, hn: 30,
              system: 'concreteMoment', Tcomputed: 1.5 };
  const e = RS.elfBaseShear(p);
  check('the run produces a result', !!e, 'null returned');

  // Table 12.8-2: concrete moment frame, Ct = 0.0466, x = 0.9 (h_n in metres).
  const Ta = 0.0466 * Math.pow(30, 0.9);
  near('Ta = Ct·hn^x',                e.Ta, Ta, 1e-9);
  near('Cu = 1.4 for Sd1 = 0.6',      e.Cu, 1.4, 1e-12);
  near('the period ceiling is Cu·Ta', e.Tmax, 1.4 * Ta, 1e-9);

  // §12.8.2 caps the computed period at Cu·Ta. A bare frame model is usually
  // more flexible than the code allows credit for, and taking its period at
  // face value would understate the design force.
  check('a computed period past Cu·Ta is capped', e.periodCapped,
        `T = ${e.T} from a computed ${e.Tcomputed} against a ceiling of ${e.Tmax}`);
  near('and the capped value is what is used', e.T, Math.min(1.5, 1.4 * Ta), 1e-9);

  // Eq 12.8-2 / 12.8-3 / 12.8-5
  near('Cs = Sds/(R/Ie)',            e.Cs0,   1.0 / 5, 1e-12);
  near('Cs need not exceed Sd1/(T·R/Ie)', e.CsMax, 0.6 / (e.T * 5), 1e-12);
  near('Cs floor is 0.044·Sds·Ie',   e.CsMin, Math.max(0.044 * 1.0 * 1, 0.01), 1e-12);
  near('Cs is the capped, floored value',
       e.Cs, Math.max(Math.min(e.Cs0, e.CsMax), e.CsMin), 1e-12);
  near('V = Cs·W',                   e.V, e.Cs * 10000, 1e-9);

  // A short, stiff structure lands on the plateau instead.
  const short = RS.elfBaseShear(Object.assign({}, p, { hn: 6, Tcomputed: 0.2 }));
  near('a stiff building is governed by Eq 12.8-2', short.Cs, 1.0 / 5, 1e-12);
  check('and is reported as such', /12\.8-2/.test(short.governedBy), short.governedBy);

  // A very tall, flexible one drops onto the minimum.
  const tall = RS.elfBaseShear(Object.assign({}, p, { hn: 200, Tcomputed: 30, TL: 4 }));
  near('a very flexible building lands on the floor', tall.Cs, Math.max(0.044, 0.01), 1e-12);
  check('and is reported as such', /minimum/.test(tall.governedBy), tall.governedBy);
  check('past TL the ceiling uses Sd1·TL/T²',
        tall.CsMax < 0.6 / (tall.T * 5) + 1e-12, 'the T > TL branch was not taken');

  // Eq 12.8-6 only bites where S1 reaches 0.6 g.
  const hiS1 = RS.elfBaseShear(Object.assign({}, p, { S1: 0.8, hn: 200, Tcomputed: 30 }));
  near('S1 ≥ 0.6 g raises the floor to 0.5·S1/(R/Ie)', hiS1.Cs, 0.5 * 0.8 / 5, 1e-12);
  const loS1 = RS.elfBaseShear(Object.assign({}, p, { S1: 0.5, hn: 200, Tcomputed: 30 }));
  const noS1 = RS.elfBaseShear(Object.assign({}, p, { hn: 200, Tcomputed: 30 }));
  // Below 0.6 g the equation is inert, so S1 = 0.5 must give exactly what no
  // S1 at all gives. Merely being smaller than the S1 = 0.8 case would still
  // pass if the equation were applied at every S1.
  near('below 0.6 g Eq 12.8-6 does not apply at all', loS1.Cs, noS1.Cs, 1e-12);
  check('and at 0.8 g it does', hiS1.Cs > noS1.Cs, 'Eq 12.8-6 never took effect');

  // Table 12.8-2 has to actually distinguish the systems.
  const sys = ['steelMoment', 'concreteMoment', 'steelEBF', 'other']
    .map(k => RS.elfBaseShear(Object.assign({}, p, { system: k })).Ta);
  check('each structural system gives its own Ta', new Set(sys.map(t => t.toFixed(6))).size >= 3,
        sys.join(', '));
  check('an unknown system falls back to "all other"',
        Math.abs(RS.elfBaseShear(Object.assign({}, p, { system: 'nonsense' })).Ta -
                 RS.elfBaseShear(Object.assign({}, p, { system: 'other' })).Ta) < 1e-12);

  // Guards — every one of these makes V meaningless.
  check('no weight, no base shear',  RS.elfBaseShear(Object.assign({}, p, { W: 0 }))  === null);
  check('no height, no base shear',  RS.elfBaseShear(Object.assign({}, p, { hn: 0 })) === null);
  check('no Sds, no base shear',     RS.elfBaseShear(Object.assign({}, p, { Sds: 0 })) === null);
}

group('The spectrum yields a load case combinations can factor');
{
  const RS = ResponseSpectrum;
  const P = portal();
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };
  const r = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, R: 3 });
  check('a static force set comes back', Array.isArray(r.staticForces), 'no set');
  check('one force per node', r.staticForces.length === P.nodes.length);
  check('and each names its node',
        r.staticForces.every((f, i) => f.nodeId === P.nodes[i].id));

  // The point of the set is that it stands in for the earthquake in a load
  // combination, so its resultant has to be the base shear being designed to.
  // Combining node by node and then summing does NOT give that on its own —
  // the combination is not linear — which is why the set is scaled.
  const sumFx = r.staticForces.reduce((s2, f) => s2 + f.fx, 0);
  near('the set resolves to the reported base shear', sumFx, r.baseShear, 0.01);
  check('a scale factor is reported',
        r.staticForceScale > 0 && isFinite(r.staticForceScale), `${r.staticForceScale}`);

  // Every component is a magnitude out of the quadratic combination, so the
  // set is a single-sense lateral distribution. Summing the signed modal
  // forces instead would let higher modes cancel and turn some of them round —
  // and the scaling afterwards would hide it in the total.
  check('the set is all one sense',
        r.staticForces.every(f => f.fx >= -1e-12),
        r.staticForces.map(f => f.fx.toFixed(3)).join(', '));

  // The portal sways almost entirely in one mode, where combining node by node
  // and summing happens to give the base shear already, so its scale factor is
  // 1 and proves nothing. A cantilever mast spreads across modes and needs a
  // real correction.
  {
    const mast = {
      nodes: [1, 2, 3, 4, 5].map(i => ({ id: i, x: 0, y: (i - 1) * 2,
                                         support: i === 1 ? 'fixed' : undefined })),
      beams: [1, 2, 3, 4].map(i => ({ id: i, node1: i, node2: i + 1, sectionId: 1 }))
    };
    const rm = RS.run(mast.nodes, mast.beams, SEC, { spectrum: spec, numModes: 8, R: 3 });
    check('a multi-mode structure really does need scaling',
          Math.abs(rm.staticForceScale - 1) > 0.01, `factor ${rm.staticForceScale}`);
    const mSum = rm.staticForces.reduce((s2, f) => s2 + f.fx, 0);
    near('and the scaled set still resolves to its base shear', mSum, rm.baseShear, 0.005);
    check('its forces are one sense too', rm.staticForces.every(f => f.fx >= -1e-12),
          rm.staticForces.map(f => f.fx.toFixed(3)).join(', '));
    // A cantilever's inertia forces grow towards the free end.
    check('and grow up the height',
          rm.staticForces[4].fx > rm.staticForces[1].fx,
          `${rm.staticForces[1].fx} at the first level, ${rm.staticForces[4].fx} at the top`);

    // The total says nothing about the shape: rescaling to the base shear
    // would hide a wrong distribution completely. So derive the distribution
    // independently — Γ·Sa·Mφ per mode, combined with the same rule through
    // combine(), which is unit-tested on its own above — and compare node by
    // node. Summing the signed modal forces instead of combining them gives a
    // different shape with the same total, and only this catches it.
    const md = ModeShapeAnalysis.computeModes(mast.nodes, mast.beams, SEC, 8);
    const kept = rm.modes.map(x => md.modes.find(y => y.modeNum === x.modeNum));
    const omega = kept.map(x => x.omega);
    const perMode = (i, n) => {
      const src = kept[n];
      return src.gammaX * (rm.modes[n].SaG * 9.81 / 3) * (src.mPhi[i * 3] || 0);
    };
    const raw = mast.nodes.map((_, i) =>
      RS.combine(kept.map((_, n) => perMode(i, n)), omega, 'CQC', 0.05));
    const rawSum = raw.reduce((a, b) => a + b, 0);
    const expect = raw.map(v => v * (rm.baseShear / rawSum));
    let worst = 0;
    expect.forEach((v, i) => {
      worst = Math.max(worst, Math.abs(v - rm.staticForces[i].fx));
    });
    check('the distribution is the modal combination, not the modal sum',
          worst < 0.002 * rm.baseShear,
          `worst node error ${worst} against a base shear of ${rm.baseShear}`);
  }

  // Supports carry no inertia force of their own to apply.
  check('the forces sit on the free nodes',
        r.staticForces.filter(f => Math.abs(f.fx) > 1e-9).length > 0);

  // Applying the set statically must reproduce that base shear as reactions —
  // this is what will actually happen once it is a load case.
  {
    const loads = r.staticForces
      .filter(f => f.fx || f.fy || f.m)
      .map(f => ({ type: 'nodal', nodeId: f.nodeId, fx: f.fx, fy: f.fy, m: f.m }));
    const st = solveFrame(P.nodes, P.beams, SEC, loads, []);
    check('the set solves as an ordinary load case', !!st.success, st.error);
    let rx = 0;
    for (const id in st.reactions) rx += st.reactions[id].Rx || 0;
    near('and its base reaction is the design base shear', -rx, r.baseShear, 0.01);
  }

  // §12.9.1.4 scaling has to reach the set too, or a load case built from it
  // would be the version the code rejected.
  {
    const sc = RS.run(P.nodes, P.beams, SEC,
      { spectrum: spec, numModes: 6, R: 3, scaleToELF: true, system: 'steelMoment' });
    const scSum = sc.staticForces.reduce((s2, f) => s2 + f.fx, 0);
    near('the scaled set resolves to the scaled base shear', scSum, sc.baseShear, 0.02);
    check('which is larger than the unscaled one', sc.baseShear > r.baseShear,
          `${sc.baseShear} against ${r.baseShear}`);
    near('by exactly the §12.9.1.4 factor', scSum / sumFx, sc.scaleFactor, 1e-3);
  }

  // The rule chosen for the run has to reach the distribution too. Rescaling
  // to the base shear hides it in the total, and on well-separated modes the
  // two rules agree anyway — so this needs the repeated-mode case, where they
  // genuinely differ.
  {
    const twin = {
      nodes: [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 0, y: 3 }, { id: 3, x: 0, y: 6 },
              { id: 4, x: 9, y: 0, support: 'fixed' }, { id: 5, x: 9, y: 3 }, { id: 6, x: 9, y: 6 }],
      beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 }, { id: 2, node1: 2, node2: 3, sectionId: 1 },
              { id: 3, node1: 4, node2: 5, sectionId: 1 }, { id: 4, node1: 5, node2: 6, sectionId: 1 }]
    };
    const opt = { spectrum: spec, numModes: 8, R: 3 };
    const tc = RS.run(twin.nodes, twin.beams, SEC, Object.assign({ rule: 'CQC' }, opt));
    const ts = RS.run(twin.nodes, twin.beams, SEC, Object.assign({ rule: 'SRSS' }, opt));
    // Compare shapes, not totals: each set is scaled to its own base shear.
    const shape = r2 => r2.staticForces.map(f => f.fx / r2.baseShear);
    const sc = shape(tc), ss = shape(ts);
    const diff = Math.max(...sc.map((v, i) => Math.abs(v - ss[i])));
    check('the two rules give different force distributions on repeated modes',
          diff > 1e-4, `worst shape difference ${diff}`);
  }

  // In 3D the set has to be spelled the way solver3d reads a nodal load.
  {
    const S3 = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
    const H = 4, B = 5, D = 6;
    const n3 = [[0,0,0],[B,0,0],[B,D,0],[0,D,0],[0,0,H],[B,0,H],[B,D,H],[0,D,H]]
      .map((q, i) => ({ id: i + 1, x: q[0], y: q[1], z: q[2],
                        support: i < 4 ? 'fixed' : 'none' }));
    const b3 = [[1,5],[2,6],[3,7],[4,8],[5,6],[6,7],[7,8],[8,5]]
      .map((e, i) => ({ id: i + 1, node1: e[0], node2: e[1], sectionId: 1 }));
    const r3 = RS.run(n3, b3, S3, { spectrum: spec, is3D: true, numModes: 8, R: 3 });
    check('the 3D set carries all six components',
          ['fx', 'fy', 'fz', 'mx', 'my', 'mz'].every(k =>
            typeof r3.staticForces[4][k] === 'number'));
    const s3sum = r3.staticForces.reduce((s2, f) => s2 + f.fx, 0);
    near('and resolves to the 3D base shear', s3sum, r3.baseShear, 0.01);
    const st3 = solveFrame3D(n3, b3, S3,
      r3.staticForces.map(f => Object.assign({ type: 'nodal' }, f)), []);
    check('and solves through solver3d', !!st3.success, st3.error);
    let rx3 = 0;
    for (const id in st3.reactions) rx3 += st3.reactions[id].Rx || 0;
    near('reproducing the base shear as reactions', -rx3, r3.baseShear, 0.02);

    // Vertical excitation is where the 3D spelling bites. solver3d reads fy as
    // the vertical and fz as the depth direction, so a set written in raw DOF
    // order puts the whole earthquake sideways — invisible under X shaking,
    // where those components are near zero anyway.
    const rz = RS.run(n3, b3, S3,
      { spectrum: spec, is3D: true, numModes: 10, direction: 'Z', R: 3 });
    const vert  = rz.staticForces.reduce((s2, f) => s2 + f.fy, 0);
    const depth = rz.staticForces.reduce((s2, f) => s2 + f.fz, 0);
    near('the vertical set resolves to the vertical base shear', vert, rz.baseShear, 0.01);
    check('and is not the depth component wearing its name',
          Math.abs(depth - rz.baseShear) > 0.01 * rz.baseShear,
          `depth ${depth} against ${rz.baseShear}`);
    const stz = solveFrame3D(n3, b3, S3,
      rz.staticForces.map(f => Object.assign({ type: 'nodal' }, f)), []);
    let rz3 = 0;
    for (const id in stz.reactions) rz3 += stz.reactions[id].Rz || 0;
    near('and the vertical reactions balance it', -rz3, rz.baseShear, 0.02);
  }
}

group('§12.9.1.4 scaling of the modal result');
{
  const RS = ResponseSpectrum;
  const P = portal();
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };

  const plain = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 6, R: 3 });
  const scaled = RS.run(P.nodes, P.beams, SEC,
    { spectrum: spec, numModes: 6, R: 3, scaleToELF: true, system: 'steelMoment' });
  check('the scaled run succeeds', !!scaled.success, scaled.error);
  check('the ELF result is reported', !!scaled.elf, 'no ELF block came back');
  check('an unscaled run reports no ELF block', !plain.elf);

  // Whatever the comparison decides, it must never scale downward: §12.9.1.4
  // is a floor on the modal result, not a licence to reduce it.
  check('the factor is never below 1', scaled.scaleFactor >= 1, `${scaled.scaleFactor}`);
  near('the factor is V_elf / V_modal where it applies',
       scaled.scaleFactor,
       Math.max(1, scaled.elf.V / plain.baseShear), 1e-3);
  near('and the scaled base shear meets the ELF value',
       scaled.baseShear, Math.max(plain.baseShear, scaled.elf.V), 0.02);

  // The factor has to reach every quantity, or the reported forces stop
  // belonging to the reported displacements.
  // The factor is reported to four decimals but applied unrounded, so these
  // compare to a part in 10⁴ rather than to machine precision.
  const k = scaled.scaleFactor;
  const tol = v => Math.abs(v) * 1e-4 + 1e-12;
  near('member forces are scaled with it',
       scaled.elemForces[0].M1, plain.elemForces[0].M1 * k, tol(plain.elemForces[0].M1));
  near('displacements are scaled with it',
       scaled.disp[2].u, plain.disp[2].u * k, tol(plain.disp[2].u));
  const rid = Object.keys(plain.reactions)[0];
  near('reactions are scaled with it',
       scaled.reactions[rid].Rx, plain.reactions[rid].Rx * k, tol(plain.reactions[rid].Rx));

  // Ratios between quantities are untouched by a single global factor, and
  // that holds exactly regardless of how the factor is reported.
  near('scaling leaves the force distribution alone',
       scaled.elemForces[0].M1 / scaled.elemForces[1].M1,
       plain.elemForces[0].M1 / plain.elemForces[1].M1, 1e-9);

  // The rule is a floor, never a reduction. The physics makes ELF larger than
  // the modal result almost every time — that is why the rule exists — so the
  // opposite case is reached here with a spectrum whose curve is far above the
  // Sds/Sd1 in its own metadata. Artificial, but it is the only way to put the
  // guard under load.
  const wild = T => { void T; return 5.0; };
  wild.meta = { code: 'ASCE 7-16 §11.4.5', Sds: 0.05, Sd1: 0.03, TL: 8 };
  const over = RS.run(P.nodes, P.beams, SEC,
    { spectrum: wild, numModes: 6, R: 3, scaleToELF: true, system: 'steelMoment' });
  check('the ELF value really is the smaller one here',
        over.elf && over.elf.V < over.baseShear, `${over.elf && over.elf.V} vs ${over.baseShear}`);
  check('and the result is left alone rather than reduced', over.scaleFactor === 1,
        `factor ${over.scaleFactor} would have scaled the result down`);
  check('the notes say it already meets the requirement',
        over.notes.some(n => /already meets/.test(n)));

  // Whichever way it goes, the engineer is told.
  check('the outcome is stated in the notes',
        scaled.notes.some(n => /12\.9\.1\.4|already meets/.test(n)),
        'the comparison happened silently');
  check('an unscaled run still says the comparison was not made',
        plain.notes.some(n => /not requested/.test(n)));

  // EC8 has no such rule, so asking for it there must not invent one.
  const ec = RS.run(P.nodes, P.beams, SEC,
    { spectrum: { code: 'EC8', ag: 0.25, S: 1.2, q: 4 }, numModes: 6, scaleToELF: true });
  check('an EC8 run is left alone', ec.scaleFactor === 1 && !ec.elf,
        'an ASCE-only rule was applied to a Eurocode run');
  // Not attempted, as opposed to attempted and failed — the difference shows
  // up in the notes, and only the second one leaves a complaint behind.
  check('and the comparison is not even attempted',
        !ec.notes.some(n => /could not be made/.test(n)),
        'the ELF comparison was tried on a Eurocode run and failed');
}

group('Seismic mass from applied loads');
{
  const MS = ModeShapeAnalysis;
  const g = 9.81;
  const P = portal();          // node 2 (0,4) — node 3 (6,4), member 2 spans 6 m
  const cases = [{ id: 1, type: 'DL' }, { id: 2, type: 'LL' },
                 { id: 3, type: 'WL' }, { id: 4, type: 'SL' }];
  const mass = (loads, factors) =>
    MS.seismicMassFromLoads(P.nodes, P.beams, loads, { loadCases: cases, factors });

  // A nodal weight is mass = W/g at that node, and nowhere else.
  {
    const r = mass([{ type: 'nodal', nodeId: 2, fy: -98.1, caseId: 1 }]);
    near('a 98.1 kN dead weight is 10 kN·s²/m', r.total, 10, 1e-9);
    near('and it all lands on its own node', r.byNode[2], 10, 1e-9);
    check('leaving the other nodes alone', r.byNode[3] === undefined);
  }

  // Weight is downward. Uplift is not negative mass, and a horizontal load is
  // not mass at all — getting either wrong would quietly corrupt every period.
  {
    const up = mass([{ type: 'nodal', nodeId: 2, fy: +98.1, caseId: 1 }]);
    check('an uplift load contributes no mass', up.total === 0, `${up.total}`);
    const hz = mass([{ type: 'nodal', nodeId: 2, fx: -98.1, caseId: 1 }]);
    check('a horizontal load contributes no mass', hz.total === 0, `${hz.total}`);
    const mo = mass([{ type: 'moment', nodeId: 2, m: 500, caseId: 1 }]);
    check('a moment carries no weight', mo.total === 0, `${mo.total}`);
  }

  // A UDL lumps half to each end: statically consistent, and the total is
  // preserved.
  {
    const r = mass([{ type: 'beam_dist', elementId: 2, fy: -10, caseId: 1 }]);
    near('a 10 kN/m UDL over 6 m is 60 kN of weight', r.total * g, 60, 1e-9);
    near('half goes to each end', r.byNode[2], 30 / g, 1e-9);
    near('and the other half to the far end', r.byNode[3], 30 / g, 1e-9);
  }

  // A triangular load puts two thirds of its weight at the heavy end. Lumping
  // by lever arm has to preserve where the mass sits, not just how much.
  {
    const r = mass([{ type: 'beam_trap', elementId: 2, fy: 0, fy2: -12, caseId: 1 }]);
    near('the total is the mean intensity times the span', r.total * g, 6 * 12 / 2, 1e-9);
    // centroid of a triangle rising to the far end sits at 2L/3
    near('a third stays at the light end', r.byNode[2] * g, 36 * (1 / 3), 1e-9);
    near('two thirds go to the heavy end',  r.byNode[3] * g, 36 * (2 / 3), 1e-9);
  }

  // A point load splits by lever arm.
  {
    const r = mass([{ type: 'beam_point', elementId: 2, fy: -90, pos: 2, caseId: 1 }]);
    near('the whole load is accounted for', r.total * g, 90, 1e-9);
    near('two thirds to the near node',  r.byNode[2] * g, 60, 1e-9);
    near('one third to the far node',    r.byNode[3] * g, 30, 1e-9);
  }

  // The per-case factors are the whole mechanism: ASCE 7-16 §12.7.2 counts
  // dead in full, storage live at a quarter, and no wind at all.
  {
    const loads = [
      { type: 'nodal', nodeId: 2, fy: -100, caseId: 1 },   // DL
      { type: 'nodal', nodeId: 2, fy: -100, caseId: 2 },   // LL
      { type: 'nodal', nodeId: 2, fy: -100, caseId: 3 },   // WL
      { type: 'nodal', nodeId: 2, fy: -100, caseId: 4 }    // SL
    ];
    const r = mass(loads);
    near('dead 1.0 + live 0.25 + snow 0.2, wind nothing',
         r.total * g, 100 * (1.0 + 0.25 + 0.0 + 0.2), 1e-9);
    check('and the weight is broken down by case type',
          Math.abs(r.breakdown.DL - 100) < 1e-9 && Math.abs(r.breakdown.LL - 25) < 1e-9 &&
          Math.abs(r.breakdown.SL - 20) < 1e-9 && r.breakdown.WL === undefined,
          JSON.stringify(r.breakdown));

    // Overriding a factor has to actually change the answer — EN 1998-1 §3.2.4
    // uses a different share, and a Eurocode user has to be able to say so.
    const ec = mass(loads, { LL: 0.3, SL: 0 });
    near('the factors can be overridden', ec.total * g, 100 * (1.0 + 0.3), 1e-9);
    const none = mass(loads, { DL: 0, LL: 0, SL: 0 });
    check('and zeroed entirely', none.total === 0, `${none.total}`);
  }

  // A load whose case cannot be resolved is dead at full mass, not dropped.
  // Dropping it lowers the seismic mass, and lower mass means a lower base
  // shear — the wrong way to be wrong.
  {
    const orphan = mass([{ type: 'nodal', nodeId: 2, fy: -98.1, caseId: 77 }]);
    near('an unmatched case is counted as dead', orphan.total, 10, 1e-9);
    check('and is counted as such', orphan.unresolved === 1, `${orphan.unresolved}`);
    const untagged = mass([{ type: 'nodal', nodeId: 2, fy: -98.1 }]);
    near('so is a load with no case at all', untagged.total, 10, 1e-9);
    check('a properly tagged load is not flagged',
          mass([{ type: 'nodal', nodeId: 2, fy: -98.1, caseId: 1 }]).unresolved === 0);

    const rs = ResponseSpectrum.run(P.nodes, P.beams, SEC, {
      spectrum: { code: 'ASCE7', Sds: 1, Sd1: 0.6, TL: 8 }, numModes: 4,
      loads: [{ type: 'nodal', nodeId: 2, fy: -98.1, caseId: 77 }], loadCases: cases
    });
    check('and the spectrum says so rather than assuming it away',
          rs.notes.some(n => /could not be matched/.test(n)));
  }

  // Nothing to convert must not throw or invent mass.
  check('no loads means no mass', mass([]).total === 0);
  check('a load on a member that does not exist is skipped',
        mass([{ type: 'beam_dist', elementId: 999, fy: -10, caseId: 1 }]).total === 0);
  check('a load on a node that does not exist is skipped',
        mass([{ type: 'nodal', nodeId: 999, fy: -10, caseId: 1 }]).total === 0);
}

group('Applied mass changes the dynamics it should change');
{
  const MS = ModeShapeAnalysis;
  const P = portal();
  const cases = [{ id: 1, type: 'DL' }];
  const heavy = [{ type: 'beam_dist', elementId: 2, fy: -40, caseId: 1 }];

  const bare = MS.computeModes(P.nodes, P.beams, SEC, 4);
  const laden = MS.computeModes(P.nodes, P.beams, SEC, 4,
                                { loads: heavy, loadCases: cases });
  check('both runs succeed', !bare.error && !laden.error, bare.error || laden.error);

  // Adding mass without adding stiffness lowers every frequency. This is the
  // check that the mass reached the matrix rather than merely being counted.
  check('the fundamental period lengthens',
        laden.modes[0].period > bare.modes[0].period * 1.05,
        `${bare.modes[0].period} then ${laden.modes[0].period}`);
  check('and no mode gets stiffer',
        laden.modes.every((m, i) => !bare.modes[i] || m.omega <= bare.modes[i].omega + 1e-9));

  // The mass shows up in the totals, in both directions, because a lumped
  // mass resists shaking whichever way the ground moves.
  const added = laden.appliedMass.total;
  near('the applied mass is reported', added * 9.81, 40 * 6, 1e-6);
  near('and lands in the X total', laden.totalMassX, bare.totalMassX + added, 1e-6);
  near('and equally in the Y total', laden.totalMassY, bare.totalMassY + added, 1e-6);
  check('a bare run reports none', !bare.appliedMass);

  // Omitting the loads has to leave the old behaviour exactly as it was.
  const again = MS.computeModes(P.nodes, P.beams, SEC, 4);
  near('self-weight-only results are unchanged',
       again.modes[0].period, bare.modes[0].period, 1e-12);

  // And it reaches the response spectrum, where it matters most.
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };
  const rsBare  = ResponseSpectrum.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 4 });
  const rsLaden = ResponseSpectrum.run(P.nodes, P.beams, SEC,
    { spectrum: spec, numModes: 4, loads: heavy, loadCases: cases });
  check('the spectrum picks the extra mass up',
        rsLaden.baseShear > rsBare.baseShear * 1.5,
        `${rsBare.baseShear} then ${rsLaden.baseShear}`);
  check('and says where the mass came from',
        rsLaden.notes.some(n => /lumped from applied loads/.test(n)));
  check('while a bare run still says it is self-weight only',
        rsBare.notes.some(n => /self-weight only/.test(n)));
}

group('Asking for fewer 2D modes returns the same lowest ones');
{
  const MS = ModeShapeAnalysis;
  const P = portal();
  const few  = MS.computeModes(P.nodes, P.beams, SEC, 3);
  const many = MS.computeModes(P.nodes, P.beams, SEC, 6);
  check('both solve', !few.error && !many.error, few.error || many.error);
  for (let i = 0; i < Math.min(3, few.modes.length); i++)
    check(`2D mode ${i + 1} is the same whether 3 or 6 are requested`,
          Math.abs(few.modes[i].freq - many.modes[i].freq) / many.modes[i].freq < 1e-6,
          `${few.modes[i].freq} against ${many.modes[i].freq}`);

  // A section may declare rho = 0 to carry stiffness without mass. `||` would
  // quietly substitute the unit weight of steel and analyse a structure the
  // user never described.
  const weightless = MS.computeModes(P.nodes, P.beams,
    [Object.assign({}, SEC[0], { rho: 0 })], 3);
  check('an explicit rho of zero really means no mass', !!weightless.error,
        'rho = 0 was replaced by a default');
  check('and the reason given is the mass', /mass/i.test(weightless.error || ''),
        weightless.error);
}

group('3D modal analysis against closed-form cantilever results');
{
  const MS = ModeShapeAnalysis;
  // Distinct Ix and Iy so the two bending planes cannot be confused, and a
  // small J so the torsional mode lands among the first few.
  const S3 = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
  const L = 10, N = 10;
  const nodes = [], beams = [];
  for (let i = 0; i <= N; i++)
    nodes.push({ id: i + 1, x: 0, y: 0, z: i * L / N, support: i === 0 ? 'fixed' : 'none' });
  for (let i = 0; i < N; i++) beams.push({ id: i + 1, node1: i + 1, node2: i + 2, sectionId: 1 });

  const r = MS.computeModes3D(nodes, beams, S3, 8);
  check('the 3D run succeeds', !r.error, r.error);
  check('and is flagged as 3D', r.is3D === true);

  // Euler-Bernoulli cantilever: ω₁ = (1.875104)²·√(EI/(m̄L⁴)).
  const g = 9.81, A = 100 / 1e4, mbar = 78.5 * A / g;
  const E = 210e6, G = E / 2.6;
  const fBend = EI => Math.pow(1.875104, 2) * Math.sqrt(EI / (mbar * Math.pow(L, 4))) / (2 * Math.PI);
  const fWeak   = fBend(E * 5000  / 1e8);
  const fStrong = fBend(E * 20000 / 1e8);
  // Fixed-free torsion: ω₁ = (π/2L)·√(GJ/(ρIp)), with Ip the POLAR area moment.
  const fTors = (Math.PI / (2 * L)) *
                Math.sqrt((G * 100 / 1e8) / ((78.5 / g) * ((5000 + 20000) / 1e8))) / (2 * Math.PI);

  const near1 = (name, got, want, relTol) =>
    check(name, Math.abs(got - want) / want < relTol, `${got} against ${want}`);

  // Local y for a vertical member is global X (buildDCM3D uses global X as the
  // reference once a member is vertical), so X-sway bends about the strong axis
  // and Y-sway about the weak one. Getting these the wrong way round is the
  // easiest mistake to make here and the hardest to spot afterwards.
  near1('mode 1 is weak-axis sway',   r.modes[0].freq, fWeak,   1e-4);
  near1('mode 2 is strong-axis sway', r.modes[1].freq, fStrong, 1e-4);
  near1('mode 3 is the torsional mode', r.modes[2].freq, fTors, 2e-3);
  check('weak-axis sway is in Y', r.modes[0].uyPct > 60 && r.modes[0].uxPct < 1e-6,
        `ux ${r.modes[0].uxPct}, uy ${r.modes[0].uyPct}`);
  check('strong-axis sway is in X', r.modes[1].uxPct > 60 && r.modes[1].uyPct < 1e-6,
        `ux ${r.modes[1].uxPct}, uy ${r.modes[1].uyPct}`);
  // The torsional mode is the reason for doing this in 3D at all: it exists,
  // and it moves no mass in any translation.
  check('the torsional mode translates no mass',
        r.modes[2].uxPct < 1e-6 && r.modes[2].uyPct < 1e-6 && r.modes[2].uzPct < 1e-6,
        `${r.modes[2].uxPct}, ${r.modes[2].uyPct}, ${r.modes[2].uzPct}`);

  // Higher modes of a cantilever go as (βₙL)²: 4.694² / 1.875² = 6.267.
  near1('the second weak-axis mode follows the βL series',
        r.modes[3].freq, fWeak * Math.pow(4.694091 / 1.875104, 2), 2e-3);

  // Effective modal mass of a uniform cantilever's first mode is 0.6131·mL.
  // Participation is quoted against the free mass, so compare the mass itself.
  near1('the first mode carries the textbook effective mass',
        r.modes[0].uyPct / 100 * r.totalMassY, 0.6131 * mbar * L, 3e-3);

  // A mode shape has to be drawable. A purely torsional mode has no
  // translation anywhere, and normalising on max translation used to divide by
  // a 1e-20 floor and return rotations of order 1e21.
  const peak = Math.max(...r.modes[2].phi.map(v => Math.abs(v)));
  check('a rotation-only mode shape stays finite and normalised',
        isFinite(peak) && peak > 0.5 && peak < 2, `peak ordinate ${peak}`);
  check('every mode shape is finite',
        r.modes.every(m => m.phi.every(v => isFinite(v))));
}

group('3D and 2D agree on a frame that is genuinely planar');
{
  const MS = ModeShapeAnalysis;
  // The same portal twice: once in 2D (X-Y, Y up) and once in 3D (X-Z, Z up)
  // with every out-of-plane DOF restrained. Restraining v, θx and θz leaves
  // u, w and θy — the exact counterpart of the 2D u, v, θ. The two solvers
  // share no assembly code, so agreement is a real cross-check.
  const oop = [false, true, false, true, false, true];   // fix Y, θx, θz
  const P = portal();
  const n3 = P.nodes.map(nd => ({
    id: nd.id, x: nd.x, y: 0, z: nd.y,
    support: nd.support, fixedDOF: oop
  }));

  const r2 = MS.computeModes(P.nodes, P.beams, SEC, 5);
  const r3 = MS.computeModes3D(n3, P.beams, SEC, 5);
  check('both runs succeed', !r2.error && !r3.error, r2.error || r3.error);

  const k = Math.min(r2.modes.length, r3.modes.length);
  check('the same number of modes comes back', k >= 3, `${r2.modes.length} vs ${r3.modes.length}`);
  for (let i = 0; i < k; i++)
    check(`mode ${i + 1} matches the 2D solver`,
          Math.abs(r3.modes[i].freq - r2.modes[i].freq) / r2.modes[i].freq < 1e-6,
          `3D ${r3.modes[i].freq} against 2D ${r2.modes[i].freq}`);

  // In-plane sway is along X in both, and the vertical mass total should agree
  // too — 2D calls it Y, 3D calls it Z.
  near('the X participation agrees', r3.modes[0].uxPct, r2.modes[0].uxPct, 1e-6);
  near('and the vertical mass total agrees', r3.totalMassZ, r2.totalMassY, 1e-9);
}

group('3D modal analysis handles mass, supports and bad input');
{
  const MS = ModeShapeAnalysis;
  const S3 = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
  const mk = (sup) => ({
    nodes: [{ id: 1, x: 0, y: 0, z: 0, support: sup },
            { id: 2, x: 0, y: 0, z: 4 },
            { id: 3, x: 5, y: 0, z: 4 },
            { id: 4, x: 5, y: 0, z: 0, support: sup }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
            { id: 2, node1: 2, node2: 3, sectionId: 1 },
            { id: 3, node1: 3, node2: 4, sectionId: 1 }]
  });

  const F = mk('fixed');
  const base = MS.computeModes3D(F.nodes, F.beams, S3, 6);
  check('a fixed-base 3D portal solves', !base.error, base.error);
  check('mass is reported in all three directions',
        base.totalMassX > 0 && base.totalMassY > 0 && base.totalMassZ > 0);
  check('and the whole-model mass exceeds the free mass',
        base.structuralMassX > base.totalMassX);

  // A planar frame pinned at its bases really is a mechanism in 3D — nothing
  // stops it swinging out of plane — so the run must fail, and must say why in
  // terms the engineer can act on rather than pointing at section properties.
  const swings = MS.computeModes3D(mk('pin').nodes, mk('pin').beams, S3, 6);
  check('a planar frame on pins is refused', !!swings.error, 'a mechanism was analysed');
  check('and the planar cause is named', /one plane|out-of-plane/.test(swings.error || ''),
        swings.error);

  // Restrain the out-of-plane DOFs and it becomes a real structure again.
  const oop = [false, true, false, true, false, true];
  const held = sup => {
    const m = mk(sup);
    m.nodes = m.nodes.map(nd => Object.assign({}, nd, { fixedDOF: oop }));
    return m;
  };
  const pinned = MS.computeModes3D(held('pin').nodes, held('pin').beams, S3, 6);
  const fixedH = MS.computeModes3D(held('fixed').nodes, held('fixed').beams, S3, 6);
  check('a pinned base solves once it is held in plane', !pinned.error, pinned.error);
  check('and is more flexible than a fixed one',
        pinned.modes[0].period > fixedH.modes[0].period,
        `${pinned.modes[0].period} against ${fixedH.modes[0].period}`);

  // Applied load mass reaches the 3D matrix as well.
  const laden = MS.computeModes3D(F.nodes, F.beams, S3, 6, {
    loads: [{ type: 'beam_dist', elementId: 2, fy: -50, caseId: 1 }],
    loadCases: [{ id: 1, type: 'DL' }]
  });
  near('the applied mass is counted', laden.appliedMass.total * 9.81, 50 * 5, 1e-6);
  check('and lengthens the fundamental period',
        laden.modes[0].period > base.modes[0].period * 1.2,
        `${base.modes[0].period} then ${laden.modes[0].period}`);
  near('and shows up in the X total',
       laden.totalMassX, base.totalMassX + laden.appliedMass.total, 1e-6);

  // Member releases have to be condensed here as they are in the solver.
  const hinged = MS.computeModes3D(F.nodes,
    F.beams.map(b => b.id === 2 ? Object.assign({}, b, { hingeStart: true, hingeEnd: true }) : b),
    S3, 6);
  check('a released beam solves', !hinged.error, hinged.error);
  check('and softens the frame',
        hinged.modes[0].period > base.modes[0].period,
        `${hinged.modes[0].period} against ${base.modes[0].period}`);

  // A 3D roller holds the vertical only, so a frame standing on one slides
  // sideways and is far softer than the same frame on a pin. Confusing the two
  // would make every such model look stiffer than it is.
  {
    const onBase = sup => {
      const m = held('fixed');
      m.nodes = m.nodes.map(nd => nd.id === 4 ? Object.assign({}, nd, { support: sup }) : nd);
      return m;
    };
    const roll = MS.computeModes3D(onBase('roller').nodes, onBase('roller').beams, S3, 6);
    const pin  = MS.computeModes3D(onBase('pin').nodes,    onBase('pin').beams,    S3, 6);
    check('both solve', !roll.error && !pin.error, roll.error || pin.error);
    check('a roller base is softer than a pinned one',
          roll.modes[0].period > pin.modes[0].period * 1.05,
          `roller ${roll.modes[0].period} against pin ${pin.modes[0].period}`);
  }

  // Asking for fewer modes must return the SAME lowest modes, not a subset
  // that skips one. This is the invariant the starting subspace broke: a
  // cantilever asked for 8 modes silently omitted its own second mode, and
  // only asking for 16 brought it back.
  {
    const few  = MS.computeModes3D(F.nodes, F.beams, S3, 4);
    const many = MS.computeModes3D(F.nodes, F.beams, S3, 12);
    check('both solve', !few.error && !many.error, few.error || many.error);
    for (let i = 0; i < Math.min(4, few.modes.length); i++)
      check(`mode ${i + 1} is the same whether 4 or 12 are requested`,
            Math.abs(few.modes[i].freq - many.modes[i].freq) / many.modes[i].freq < 1e-6,
            `${few.modes[i].freq} against ${many.modes[i].freq}`);
  }

  // Guards
  check('one node is not a structure', !!MS.computeModes3D([F.nodes[0]], [], S3, 4).error);
  check('no elements is refused', !!MS.computeModes3D(F.nodes, [], S3, 4).error);
  const massless = MS.computeModes3D(F.nodes, F.beams,
    [{ id: 1, E: 210, A: 100, Ix: 20000, Iy: 5000, J: 100, rho: 0 }], 4);
  check('a model with no mass is refused', !!massless.error, JSON.stringify(massless).slice(0, 60));
  check('and says why', /mass/i.test(massless.error || ''), massless.error);
}

group('Response spectrum on a space frame');
{
  const RS = ResponseSpectrum;
  const S3 = [{ id: 1, E: 210, A: 100, I: 20000, Ix: 20000, Iy: 5000, J: 100, rho: 78.5 }];
  // A single-bay box: four columns and a ring of beams. Genuinely 3D, so it
  // has out-of-plane restraint in both horizontal directions.
  const H = 4, B = 5, D = 6;
  const nodes = [
    { id: 1, x: 0, y: 0, z: 0, support: 'fixed' }, { id: 2, x: B, y: 0, z: 0, support: 'fixed' },
    { id: 3, x: B, y: D, z: 0, support: 'fixed' }, { id: 4, x: 0, y: D, z: 0, support: 'fixed' },
    { id: 5, x: 0, y: 0, z: H }, { id: 6, x: B, y: 0, z: H },
    { id: 7, x: B, y: D, z: H }, { id: 8, x: 0, y: D, z: H }
  ];
  const beams = [
    { id: 1, node1: 1, node2: 5, sectionId: 1 }, { id: 2, node1: 2, node2: 6, sectionId: 1 },
    { id: 3, node1: 3, node2: 7, sectionId: 1 }, { id: 4, node1: 4, node2: 8, sectionId: 1 },
    { id: 5, node1: 5, node2: 6, sectionId: 1 }, { id: 6, node1: 6, node2: 7, sectionId: 1 },
    { id: 7, node1: 7, node2: 8, sectionId: 1 }, { id: 8, node1: 8, node2: 5, sectionId: 1 }
  ];
  const spec = { code: 'ASCE7', Sds: 1.0, Sd1: 0.6, TL: 8 };

  // Capture the per-mode solves so each can be checked against the equation it
  // is meant to satisfy — the same identity that caught the force vector being
  // wrongly restricted to the excitation direction in 2D.
  const calls = [];
  const spy = (n, b, s, l, st) => {
    const res = solveFrame3D(n, b, s, l, st);
    calls.push({ loads: l, res });
    return res;
  };
  const flat = () => 1.0;
  flat.meta = { code: 'flat 1.0 g' };

  const out = RS.run(nodes, beams, S3,
    { spectrum: flat, is3D: true, direction: 'X', numModes: 6, rule: 'SRSS', solve: spy });
  check('a 3D run succeeds', !!out.success, out.error);
  check('and reports itself as 3D', out.is3D === true);
  check('one solve per reported mode', calls.length === out.modeCount,
        `${calls.length} against ${out.modeCount}`);

  const modal = ModeShapeAnalysis.computeModes3D(nodes, beams, S3, 6);
  const g = 9.81;
  out.modes.forEach((md, k) => {
    const src  = modal.modes.find(m => m.modeNum === md.modeNum);
    const call = calls[k];
    const G1   = src.gammaX;

    // ΣFx over the applied vector is Γ·Sa·(rᵀMφ) = Γ²·Sa. In 3D this also
    // proves the fy/fz swap solver3d expects was made: get it wrong and the
    // X force lands in another direction and this sum collapses.
    const sumFx = call.loads.reduce((s, l) => s + (l.fx || 0), 0);
    near(`3D mode ${md.modeNum}: the applied force sums to Γ²·Sa`,
         sumFx, G1 * G1 * g, Math.abs(G1 * G1 * g) * 1e-9 + 1e-12);

    // Equilibrium in all three directions.
    let rx = 0, ry = 0, rz = 0;
    for (const id in call.res.reactions) {
      rx += call.res.reactions[id].Rx || 0;
      ry += call.res.reactions[id].Ry || 0;
      rz += call.res.reactions[id].Rz || 0;
    }
    const sumFy = call.loads.reduce((s, l) => s + (l.fz || 0), 0);   // global Y
    const sumFz = call.loads.reduce((s, l) => s + (l.fy || 0), 0);   // global Z
    const tol = v => Math.abs(v) * 1e-6 + 1e-6;
    near(`3D mode ${md.modeNum}: X reactions balance`, rx, -sumFx, tol(sumFx));
    near(`3D mode ${md.modeNum}: Y reactions balance`, ry, -sumFy, tol(sumFy));
    near(`3D mode ${md.modeNum}: Z reactions balance`, rz, -sumFz, tol(sumFz));

    // u = (Γ·Sa/ω²)·φ over all six DOF.
    const scale = G1 * g / (src.omega * src.omega);
    let worst = 0, ref = 0;
    nodes.forEach((nd, i) => {
      const got = call.res.disp[nd.id];
      [['u', 0], ['v', 1], ['w', 2]].forEach(([key, off]) => {
        const expect = scale * src.phiMass[i * 6 + off];
        worst = Math.max(worst, Math.abs(got[key] - expect));
        ref   = Math.max(ref, Math.abs(expect));
      });
    });
    check(`3D mode ${md.modeNum}: u = (Γ·Sa/ω²)·φ at every node`,
          worst <= ref * 1e-6 + 1e-12, `worst ${worst} against peak ${ref}`);
  });

  // The 3D result carries the fields a space frame has and 2D does not.
  const r = RS.run(nodes, beams, S3, { spectrum: spec, is3D: true, numModes: 8 });
  check('displacements carry all six components',
        ['u', 'v', 'w', 'θx', 'θy', 'θz'].every(k => typeof r.disp[5][k] === 'number'));
  check('reactions carry all six components',
        ['Rx', 'Ry', 'Rz', 'Mx', 'My', 'Mz'].every(k => typeof r.reactions[1][k] === 'number'));
  check('member forces carry torsion and both bending planes',
        ['Tx1', 'My1', 'Mz1', 'Vy1', 'Vz1'].every(k => typeof r.elemForces[0][k] === 'number'));
  check('and everything is a magnitude',
        r.elemForces.every(e => e.Tx1 >= 0 && e.My1 >= 0 && e.Mz1 >= 0));

  // Presence alone proves little: a missing field combines to zero and still
  // types as a number. Pin the default run against one handed solveFrame3D
  // explicitly, on a quantity only the 3D solver can produce.
  {
    const injected = RS.run(nodes, beams, S3,
      { spectrum: spec, is3D: true, numModes: 8, solve: solveFrame3D });
    check('the 3D results are not trivially zero',
          injected.elemForces[0].Mz1 > 1e-6 && injected.elemForces[0].N1 > 1e-6,
          `Mz1 ${injected.elemForces[0].Mz1}, N1 ${injected.elemForces[0].N1}`);
    near('the default 3D run uses the 3D solver',
         r.elemForces[0].Mz1, injected.elemForces[0].Mz1,
         Math.abs(injected.elemForces[0].Mz1) * 1e-9 + 1e-12);
    near('and agrees on the vertical displacement too',
         r.disp[5].w, injected.disp[5].w, Math.abs(injected.disp[5].w) * 1e-9 + 1e-15);
  }

  // All three excitation directions work and give their own answer.
  const dirs = ['X', 'Y', 'Z'].map(d =>
    RS.run(nodes, beams, S3, { spectrum: spec, is3D: true, numModes: 8, direction: d }));
  check('every direction runs', dirs.every(d => d.success), dirs.map(d => d.error).join('|'));
  check('and each reports its own', dirs.map(d => d.direction).join() === 'X,Y,Z');
  check('X and Y differ on a rectangular plan',
        Math.abs(dirs[0].baseShear - dirs[1].baseShear) > 1e-6,
        'a 5×6 m plan gave identical X and Y base shears');
  check('vertical excitation is not the same as horizontal',
        Math.abs(dirs[2].baseShear - dirs[0].baseShear) > 1e-6);

  // Z is meaningless in 2D — the app calls the vertical Y there — so asking
  // for it must fall back rather than analyse DOFs the model does not have.
  const P = portal();
  const z2d = RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 4, direction: 'Z' });
  check('a 2D run asked for Z falls back to Y', z2d.direction === 'Y', z2d.direction);
  near('and gives exactly the Y answer', z2d.baseShear,
       RS.run(P.nodes, P.beams, SEC, { spectrum: spec, numModes: 4, direction: 'Y' }).baseShear,
       1e-9);

  // Applied mass and the ELF scaling both reach the 3D path.
  const laden = RS.run(nodes, beams, S3, {
    spectrum: spec, is3D: true, numModes: 8,
    loads: [{ type: 'beam_dist', elementId: 5, fy: -30, caseId: 1 }],
    loadCases: [{ id: 1, type: 'DL' }]
  });
  near('load mass is counted in 3D', laden.appliedMass.total * 9.81, 30 * B, 1e-6);
  check('and raises the base shear', laden.baseShear > r.baseShear,
        `${r.baseShear} then ${laden.baseShear}`);
  const scaled = RS.run(nodes, beams, S3,
    { spectrum: spec, is3D: true, numModes: 8, R: 3, scaleToELF: true, system: 'steelMoment' });
  check('the ELF comparison works in 3D', !!scaled.elf, 'no ELF block in 3D');
  check('and the height is taken from the model', Math.abs(scaled.elf.hn - H) < 1e-9,
        `hn ${scaled.elf.hn} against ${H}`);
}

group('A simply supported beam with one point load');
{
  // The plainest model there is, and the one a new user builds first. Every
  // number here is closed-form, so nothing about it is a matter of opinion.
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, rho: 78.5 }];
  const L = 6, P = 50;
  const nodes = [{ id: 1, x: 0, y: 0, support: 'pin' },
                 { id: 2, x: L, y: 0, support: 'roller' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const r = solveFrame(nodes, beams, S,
                       [{ type: 'beam_point', elementId: 1, fy: -P, pos: L / 2 }], []);
  check('it solves', !!r.success, r.error);
  near('each support carries half the load', r.reactions[1].Ry, P / 2, 1e-9);
  near('and so does the other',              r.reactions[2].Ry, P / 2, 1e-9);
  near('no horizontal reaction',             r.reactions[1].Rx, 0, 1e-9);
  // A simply supported beam carries no end moment — the PL/4 peak is at
  // midspan, which is not an end force and must not appear as one.
  near('no moment at the pin',    r.elemForces[0].M1, 0, 1e-9);
  near('no moment at the roller', r.elemForces[0].M2, 0, 1e-9);
  near('end shear is the reaction', r.elemForces[0].V1, P / 2, 1e-9);
  // θ = PL²/16EI at each end.
  const EI = 210e6 * 8356 / 1e8;
  near('end rotation is PL²/16EI', Math.abs(r.disp[1].theta), P * L * L / (16 * EI), 1e-9);

  // Splitting the beam at midspan and applying the load to the node must give
  // the identical answer — and here the peak moment IS an end force.
  const n3 = [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: L / 2, y: 0 },
              { id: 3, x: L, y: 0, support: 'roller' }];
  const b3 = [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
              { id: 2, node1: 2, node2: 3, sectionId: 1 }];
  const r3 = solveFrame(n3, b3, S, [{ type: 'nodal', nodeId: 2, fy: -P }], []);
  check('the split model solves', !!r3.success, r3.error);
  near('same reactions', r3.reactions[1].Ry, P / 2, 1e-9);
  near('midspan moment is PL/4', Math.abs(r3.elemForces[0].M2), P * L / 4, 1e-9);
  near('midspan deflection is PL³/48EI',
       Math.abs(r3.disp[2].v), P * L * L * L / (48 * EI), 1e-9);
}

group('A singular model says which restraint is missing');
{
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, rho: 78.5 }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const ld = [{ type: 'beam_point', elementId: 1, fy: -50, pos: 3 }];
  const run = (s1, s2) => solveFrame(
    [{ id: 1, x: 0, y: 0, support: s1 }, { id: 2, x: 6, y: 0, support: s2 }],
    beams, S, ld, []);

  // Two rollers is the classic near-miss: it looks simply supported, and it
  // slides. 'Check supports / connectivity' left the engineer to find that.
  const rr = run('roller', 'roller');
  check('two rollers is refused', !!rr.error, 'a sliding frame was solved');
  check('and the missing horizontal restraint is named',
        /horizontal|slide/i.test(rr.error), rr.error);
  check('with something to actually do about it', /pin/i.test(rr.error), rr.error);

  const hh = run('rollerH', 'rollerH');
  check('two horizontal rollers are refused', !!hh.error);
  check('and the missing vertical restraint is named',
        /vertical|drop/i.test(hh.error), hh.error);

  // A lone pin holds both translations but not rotation, so the frame pivots
  // about it. Reaching this branch needs a support that DOES hold X and Y —
  // a lone roller trips the horizontal test first, and rightly so.
  const one = run('pin', 'none');
  check('a single pin is refused', !!one.error, 'a frame free to pivot was solved');
  check('and the spin is explained', /spin|rotat/i.test(one.error), one.error);

  // The genuinely correct cases must still solve, or the diagnostic is just
  // a nicer way of being wrong.
  for (const [a, b] of [['pin', 'roller'], ['pin', 'pin'], ['fixed', 'none'],
                        ['pin', 'fixed']])
    check(`${a} + ${b} still solves`, !!run(a, b).success, run(a, b).error);

  // Fixed at both ends of a TWO-node beam leaves no free DOF at all — there is
  // nothing to solve, and an earlier guard says so rather than reaching the
  // singularity check. Give it an interior node and it solves, with the
  // closed-form fixed-fixed answer.
  const ff2 = run('fixed', 'fixed');
  check('a two-node fixed-fixed beam is refused as fully constrained',
        !!ff2.error && /All DOFs constrained/.test(ff2.error), ff2.error);
  const ff3 = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 3, y: 0 },
     { id: 3, x: 6, y: 0, support: 'fixed' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
     { id: 2, node1: 2, node2: 3, sectionId: 1 }], S,
    [{ type: 'nodal', nodeId: 2, fy: -50 }], []);
  check('with an interior node it solves', !!ff3.success, ff3.error);
  near('end moment is PL/8', Math.abs(ff3.elemForces[0].M1), 50 * 6 / 8, 1e-9);
  near('midspan deflection is PL³/192EI', Math.abs(ff3.disp[2].v),
       50 * 216 / (192 * 210e6 * 8356 / 1e8), 1e-9);
}

group('A member the solver cannot use is named, not dropped in silence');
{
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, Iy: 604, J: 20, rho: 78.5 }];
  const N = [{ id: 10, x: 0, y: 0, z: 0, support: 'pin' },
             { id: 11, x: 6, y: 0, z: 0, support: 'roller' }];
  const ld = [{ type: 'beam_dist', elementId: 12, fy: -10 }];
  const beam = extra => [Object.assign({ id: 12, node1: 10, node2: 11 }, extra)];

  // The reported case: one member, correct supports, and nothing to solve
  // because the member carries no section. This used to surface as
  // 'Structural matrix is singular. Check supports / connectivity' — which
  // points at the one part of the model that was right.
  const noSec = solveFrame(N, beam({ sectionId: null }), S, ld, []);
  check('a member with no section is refused', !!noSec.error, 'it solved anyway');
  check('the member is named', /member 12/.test(noSec.error), noSec.error);
  check('the reason is the section', /no section assigned/.test(noSec.error), noSec.error);
  check('and the fix is given', /Sections/.test(noSec.error), noSec.error);
  check('without blaming the supports', !/supports \/ connectivity/.test(noSec.error),
        noSec.error);

  const badSec = solveFrame(N, beam({ sectionId: 999 }), S, ld, []);
  check('a member pointing at a missing section is refused', !!badSec.error);
  check('and says which section', /999/.test(badSec.error), badSec.error);

  const badNode = solveFrame(N, [{ id: 12, node1: 10, node2: 77, sectionId: 1 }], S, ld, []);
  check('a member on a missing node is refused', !!badNode.error);
  check('and says so', /node that does not exist/.test(badNode.error), badNode.error);

  // One good member alongside a bad one: the model may still solve, but the
  // dropped member must not vanish without trace if it does not.
  const mixed = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 3, y: 0 },
     { id: 3, x: 6, y: 0, support: 'roller' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
     { id: 2, node1: 2, node2: 3, sectionId: null }], S,
    [{ type: 'nodal', nodeId: 2, fy: -50 }], []);
  check('a partly unusable model reports the singularity with the cause',
        !!mixed.error && /member 2/.test(mixed.error), mixed.error);

  // The 3D solver has to be as forthcoming as the 2D one.
  const N3 = [{ id: 10, x: 0, y: 0, z: 0, support: 'fixed' },
              { id: 11, x: 0, y: 0, z: 4, support: 'none' },
              { id: 12, x: 5, y: 0, z: 4, support: 'none' },
              { id: 13, x: 5, y: 3, z: 4, support: 'fixed' }];
  const b3 = [{ id: 1, node1: 10, node2: 11, sectionId: null },
              { id: 2, node1: 11, node2: 12, sectionId: null },
              { id: 3, node1: 12, node2: 13, sectionId: null }];
  const r3 = solveFrame3D(N3, b3, S, [{ type: 'nodal', nodeId: 11, fx: 10 }], []);
  check('the 3D solver refuses a sectionless model', !!r3.error);
  check('and names the members', /member 1/.test(r3.error), r3.error);
  // When EVERY member is unusable the message must lead with that and carry
  // the fix, not describe it as a singular matrix that dropped a few members.
  check('and leads with the real problem',
        /No member could be analysed/.test(r3.error), r3.error);
  check('and tells the user what to do', /Assign a section/.test(r3.error), r3.error);

  // And the correct model still solves, so none of this is a new obstacle.
  const ok = solveFrame(N, beam({ sectionId: 1 }), S, ld, []);
  check('a properly assigned member still solves', !!ok.success, ok.error);
  near('with the right reaction', ok.reactions[10].Ry, 30, 1e-9);
}

group('Every solver message a user can hit has guidance behind it');
{
  // The issues dialog matches the message text against a table of patterns to
  // decide which explanation and steps to show. That coupling is silent — a
  // reworded error simply stops matching and the user gets the bare message
  // again. Keep a copy of the patterns here and check the real messages
  // against them, so rewording one without the other fails loudly.
  const GUIDE = [
    /has no section assigned|does not exist(?!.*node)|No member could be analysed/i,
    /references a node that does not exist/i,
    /zero length/i,
    /Nothing restrains horizontal movement/i,
    /Nothing restrains vertical movement/i,
    /can spin about it|does not resist rotation/i,
    /All DOFs constrained/i,
    /one plane|out-of-plane/i,
    /no longer exists/i,
    /No supports defined/i,
    /No nodes defined|No beams defined/i,
    /No mass in model/i,
    /did not converge/i,
    /singular/i
  ];
  const covered = m => GUIDE.some(re => re.test(m));

  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, Iy: 604, J: 20, rho: 78.5 }];
  const N = [{ id: 10, x: 0, y: 0, support: 'pin' }, { id: 11, x: 6, y: 0, support: 'roller' }];
  const ld = [{ type: 'beam_dist', elementId: 12, fy: -10 }];
  const bm = extra => [Object.assign({ id: 12, node1: 10, node2: 11 }, extra)];
  const sup = (a, b) => [{ id: 10, x: 0, y: 0, support: a }, { id: 11, x: 6, y: 0, support: b }];

  const messages = {
    'no section':      solveFrame(N, bm({ sectionId: null }), S, ld, []).error,
    'missing section': solveFrame(N, bm({ sectionId: 999 }), S, ld, []).error,
    'missing node':    solveFrame(N, [{ id: 12, node1: 10, node2: 77, sectionId: 1 }], S, ld, []).error,
    'two rollers':     solveFrame(sup('roller', 'roller'), bm({ sectionId: 1 }), S, ld, []).error,
    'no vertical':     solveFrame(sup('rollerH', 'rollerH'), bm({ sectionId: 1 }), S, ld, []).error,
    'lone pin':        solveFrame(sup('pin', 'none'), bm({ sectionId: 1 }), S, ld, []).error,
    'fully fixed':     solveFrame(sup('fixed', 'fixed'), bm({ sectionId: 1 }), S, ld, []).error,
    'no nodes':        solveFrame([], [], S, [], []).error,
    'no elements':     solveFrame(N, [], S, [], []).error
  };
  for (const [name, msg] of Object.entries(messages)) {
    check(`${name} produces a message`, !!msg, 'it solved instead');
    check(`${name} has guidance behind it`, covered(msg || ''), msg);
  }

  // The 3D planar diagnostic too.
  const p3 = solveFrame3D(
    [{ id: 1, x: 0, y: 0, z: 0, support: 'pin' }, { id: 2, x: 6, y: 0, z: 0, support: 'roller' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S,
    [{ type: 'beam_point', elementId: 1, fy: -50, pos: 3 }], []);
  check('the 3D planar message is produced', !!p3.error);
  check('and has guidance behind it', covered(p3.error || ''), p3.error);

  // A modal failure the dialog should also explain.
  const noMass = ModeShapeAnalysis.computeModes(
    portal().nodes, portal().beams,
    [Object.assign({}, SEC[0], { rho: 0 })], 3).error;
  check('a massless model produces a message', !!noMass);
  check('and has guidance behind it', covered(noMass || ''), noMass);
}

group('A load must never be dropped for belonging to no case');
{
  // The app filtered a load into its case with `(l.caseId || 1) === lc.id`,
  // which assumes a case with id 1 exists. The startup template numbers its
  // cases 3, 4, 5 — so a load with a missing or zero caseId matched nothing,
  // was left out of every case AND every combination, and the model solved to
  // all-zero with the load still drawn on the member.
  //
  // app.js owns that resolution and is not loadable here (it touches the DOM),
  // so this pins the rule the fix depends on: resolution must fall back to a
  // case that exists, never to a hard-coded id.
  const cases = [{ id: 3, name: 'Dead', type: 'DL' },
                 { id: 4, name: 'Live', type: 'LL' }];
  const caseIdOf = (l, cs) =>
    cs.some(c => c.id === l.caseId) ? l.caseId : (cs.length ? cs[0].id : l.caseId);

  check('a valid case is left alone',      caseIdOf({ caseId: 4 }, cases) === 4);
  check('a missing case falls back to a real one', caseIdOf({}, cases) === 3);
  check('so does zero',                    caseIdOf({ caseId: 0 }, cases) === 3);
  check('and an id that no longer exists', caseIdOf({ caseId: 1 }, cases) === 3);
  check('the old rule would have lost it',
        !cases.some(c => c.id === (({ caseId: 0 }).caseId || 1)),
        'a case with id 1 existed, so this fixture does not reproduce the bug');

  // Every load ends up in exactly one case — none lost, none double-counted.
  const loads = [{ id: 1, caseId: 3 }, { id: 2, caseId: 4 },
                 { id: 3, caseId: 0 }, { id: 4 }, { id: 5, caseId: 99 }];
  const placed = cases.map(c => loads.filter(l => caseIdOf(l, cases) === c.id));
  near('every load is placed', placed.reduce((n, g) => n + g.length, 0), loads.length, 0);
  const ids = placed.flat().map(l => l.id).sort();
  check('and none is counted twice', new Set(ids).size === loads.length, ids.join(','));

  // The physics the user was missing: 10 kN at midspan of a 6 m span.
  const S = [{ id: 1, E: 210, A: 53.8, I: 8356, Ix: 8356, rho: 78.5 }];
  const r = solveFrame(
    [{ id: 1, x: 0, y: 0, support: 'pin' }, { id: 2, x: 6, y: 0, support: 'roller' }],
    [{ id: 1, node1: 1, node2: 2, sectionId: 1 }], S,
    [{ type: 'beam_point', elementId: 1, fy: -10, pos: 3 }], []);
  check('the load solves once it reaches the solver', !!r.success, r.error);
  near('each support takes half', r.reactions[1].Ry, 5, 1e-9);
  check('and the answer is not zero', Math.abs(r.reactions[1].Ry) > 1e-6,
        'a load that reaches the solver must move something');
}

group('Form controls are named from the labels already on the page');
{
  // 565 of the 654 controls in index.html had no accessible name: the markup
  // writes `<div class="form-row"><label>Node</label><select id=…>`, a visible
  // and correct label that carries no `for`, so nothing connects the two.
  // js/core/a11y-labels.js wires them at load.
  //
  // The failure that matters is not a control left unnamed — it is one given a
  // confident WRONG name lifted from a neighbour, which a screen reader then
  // announces as fact. Both early versions of the pass did exactly that: the
  // grid line-STYLE dropdown came out "Grid line color" (read past the colour
  // swatch's label) and the member-type filter came out "None" (read off a
  // deselect button two siblings back). So the real module runs here, over a
  // small DOM, and is asked to stay silent wherever it cannot be sure.
  const { makeDocument } = require('./mini-dom.js');
  const A11Y_SRC = fs.readFileSync(path.join(ROOT, 'js/core/a11y-labels.js'), 'utf8');

  /** Run the shipped module over a fresh fixture. */
  function wire(children) {
    const doc = makeDocument(children);
    const c = { console, Math, JSON, Object, Array, Set, String, Boolean, RegExp,
                document: doc, CSS: { escape: v => String(v) } };
    c.window = c;
    vm.createContext(c);
    vm.runInContext(A11Y_SRC, c, { filename: 'js/core/a11y-labels.js' });
    return { doc, api: c.window.A11yLabels };
  }
  const byId    = (doc, id) => doc.getElementById(id);
  const labelOf = (doc, id) => {
    const l = doc.querySelector('label[for="' + id + '"]');
    return l ? l.textContent.trim() : (byId(doc, id).getAttribute('aria-label') || null);
  };

  // ── the ordinary case: one label, one field ──────────────────────────────
  {
    const { doc } = wire([['div', { class: 'form-row' },
      ['label', {}, 'Node'], ' ', ['select', { id: 'settle-node-sel' }]]]);
    check('a visible label is attached to the field beside it',
          labelOf(doc, 'settle-node-sel') === 'Node', labelOf(doc, 'settle-node-sel'));
  }

  // ── several pairs in one container take their own labels, in order ───────
  {
    const { doc } = wire([['div', { class: 'grid' },
      ['label', {}, 'Bays'],    ['input', { id: 'b', type: 'number' }],
      ['label', {}, 'Storeys'], ['input', { id: 's', type: 'number' }],
      ['label', {}, 'Height'],  ['input', { id: 'h', type: 'number' }]]]);
    check('each label goes to its own field',     labelOf(doc, 'b') === 'Bays');
    check('and the next to the next',             labelOf(doc, 's') === 'Storeys');
    check('and they do not all share the first',  labelOf(doc, 'h') === 'Height');
  }

  // ── one label, two controls: the second is NOT given the first's name ────
  {
    const { doc, api } = wire([['div', { class: 'set-row' },
      ['label', { class: 'set-lbl' }, 'Grid line color'],
      ['input', { id: 'cfg-grid-color', type: 'color' }],
      ['select', { id: 'cfg-grid-style' }]]]);
    check('a label shared by two controls names only the first',
          labelOf(doc, 'cfg-grid-color') === 'Grid line color');
    check('the second is left unnamed rather than mislabelled',
          labelOf(doc, 'cfg-grid-style') === null, labelOf(doc, 'cfg-grid-style'));
    check('and it is reported so it can be named by hand',
          api.unnamed(doc).some(e => e.id === 'cfg-grid-style'));
  }

  // ── a neighbouring button's caption is not somebody else's name ──────────
  {
    const { doc } = wire([['div', { class: 'row' },
      ['button', {}, 'All'], ['button', {}, 'None'], ['span', { style: 'flex:1' }],
      ['select', { id: 'sm-filter-type' }]]]);
    check('a button caption is never taken as a control name',
          labelOf(doc, 'sm-filter-type') === null, labelOf(doc, 'sm-filter-type'));
  }

  // ── plain text before a control is fair game, though ─────────────────────
  {
    const { doc } = wire([['div', { class: 'unit-switcher' },
      ['span', {}, 'Units:'], ['select', { id: 'u' }]]]);
    check('leading text does name a control', labelOf(doc, 'u') === 'Units',
          labelOf(doc, 'u'));
  }

  // ── a placeholder must not block the real label ──────────────────────────
  {
    const { doc } = wire([['div', { class: 'form-row' },
      ['label', {}, 'Start position'],
      ['input', { id: 'wiz-x0', type: 'number', placeholder: 'X (m)' }]]]);
    check('a placeholder does not stop the visible label being attached',
          labelOf(doc, 'wiz-x0') === 'Start position', labelOf(doc, 'wiz-x0'));
  }

  // ── an explicit name is never overwritten ────────────────────────────────
  {
    const { doc } = wire([['div', { class: 'form-row' },
      ['label', {}, 'Node'], ['select', { id: 'x', 'aria-label': 'Node 3 support' }]]]);
    check('an aria-label already on a control wins',
          byId(doc, 'x').getAttribute('aria-label') === 'Node 3 support');
  }

  // ── the checkbox convention: label after the control ─────────────────────
  {
    const { doc } = wire([['div', { class: 'set-row' },
      ['input', { id: 'cfg-snap', type: 'checkbox' }], ['label', {}, 'Snap to grid']]]);
    check('a label written after its checkbox is attached too',
          labelOf(doc, 'cfg-snap') === 'Snap to grid', labelOf(doc, 'cfg-snap'));
  }

  // ── a label cannot reach into the next row ───────────────────────────────
  {
    const { doc } = wire([
      ['div', { class: 'form-row' }, ['label', {}, 'Section heading']],
      ['div', { class: 'form-row' }, ['input', { id: 'far', type: 'number' }]]]);
    check('a label with no field of its own leaves the next row alone',
          labelOf(doc, 'far') === null, labelOf(doc, 'far'));
  }

  // ── a field with no id still gets one, so the label can point at it ──────
  {
    const { doc } = wire([['div', { class: 'form-row' },
      ['label', {}, 'Force (kN)'], ['input', { type: 'number' }]]]);
    const inp = doc.querySelector('input');
    check('a field with no id is given one', /^a11y-f\d+$/.test(inp.id), inp.id);
    check('and the label points at it', labelOf(doc, inp.id) === 'Force (kN)');
  }

  // ── nothing to go on: say so, do not invent ──────────────────────────────
  {
    const { doc, api } = wire([['div', {}, ['select', { id: 'lonely' }]]]);
    check('a control with nothing near it is left alone',
          labelOf(doc, 'lonely') === null, labelOf(doc, 'lonely'));
    check('and is reported as unnamed', api.unnamed(doc).length === 1);
  }

  // ── no label may point at an id that does not exist ──────────────────────
  {
    const { doc } = wire([['div', { class: 'form-row' },
      ['label', {}, 'A'], ['input', { id: 'a', type: 'number' }],
      ['label', {}, 'B'], ['select', {}]]]);
    const dead = doc.querySelectorAll('label[for]')
      .filter(l => !byId(doc, l.getAttribute('for')));
    check('every for attribute resolves to a real field', dead.length === 0,
          dead.map(l => l.getAttribute('for')).join(','));
  }
}

group('index.html keeps the structure the label wiring depends on');
{
  // Associating a label with `for` is only sound while ids are unique: two
  // elements sharing one id, and every label pointing at it names the wrong
  // control — silently.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const seen = Object.create(null);
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen[m[1]] = (seen[m[1]] || 0) + 1;
  const dupes = Object.keys(seen).filter(k => seen[k] > 1);
  check('no id appears twice', dupes.length === 0, dupes.join(', '));
  check('and there are ids to speak of', Object.keys(seen).length > 500);

  const dead = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)]
    .map(m => m[1]).filter(id => !seen[id]);
  check('every hand-written label[for] resolves', dead.length === 0, dead.join(', '));

  // The controls the JS tables emit are named in their renderers — there is no
  // label on the page for the pass to find.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
  [['function updateNodeTable()',    'function updateBeamTable()',    4],
   ['function updateBeamTable()',    'function updateSectionTable()', 4],
   ['function updateSectionTable()', 'function updateLoadTable(',     6]]
    .forEach(([from, to, least]) => {
      const body = slice(from, to);
      const ctrls = (body.match(/<(?:input|select)\b/g) || []).length;
      const named = (body.match(/aria-label="/g) || []).length;
      check(from.replace('function ', '').replace('()', '') +
            ' names every control it writes', ctrls >= least && named >= ctrls,
            named + ' names for ' + ctrls + ' controls');
    });

  // A section called `Conc 9"×9"` — the app's own default — closed the value
  // attribute early, so the table showed `Conc 9`, and a change to any cell in
  // that row wrote the truncated name back over the real one.
  const esc = v => String(v).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  check('the section table escapes the name it renders',
        app.includes('value="${escapeIssue(sc.name)}"'),
        'an unescaped name truncates at its first quote');
  check('and escaping round-trips the default section name',
        esc('Conc 9"×9"') === 'Conc 9&quot;×9&quot;');
}

group('A model and its materials must travel together');
{
  // Sections reference their material by `materialId` and take E, fy and rho
  // from it, so the two are one thing. Three of the four paths that write or
  // read a model left `materials` behind:
  //
  //   · saveFile()      — Save, to localStorage
  //   · exportToURL()   — Share URL
  //   · clipboard import
  //
  // Reproduced end to end: a project saved with A36 steel (E = 200 GPa,
  // fy = 250) was reopened after the library had been edited, and came back
  // as aluminium — E = 70 GPa, fy = 240. Deflections 2.9x out, the design
  // check against the wrong yield strength, no warning of any kind.
  //
  // app.js owns those three call sites and cannot be loaded here, so this
  // pins the rule they now follow, and the shapes that made the bug invisible.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const at = (needle, span) => {
    const i = app.indexOf(needle);
    return i < 0 ? '' : app.slice(i, i + span);
  };

  const saveBody = at('function saveFile()', 700);
  check('saveFile writes materials with the model',
        /const data = \{[^}]*\bmaterials\b/.test(saveBody),
        'a saved project without its materials resolves against whatever library is loaded');

  const loadBody = at('function loadFile(name)', 1200);
  check('loadFile takes the materials back', loadBody.includes('adoptMaterials('));

  const shareBody = at("FileIO.exportToURL({", 260);
  check('the share link carries materials too', /\bmaterials\b/.test(shareBody));

  // The legacy file-load button, "file-import-json" and clipboard paste used
  // to each inline this sequence by hand and had already drifted apart (the
  // older file-load handler skipped sanitizeLoadedSections()/adoptMaterials()
  // entirely) — they now all go through one applyImportedModel() helper
  // instead, so a call to adoptMaterials from clipboard paste itself is one
  // level of indirection away. Checking the helper actually calls it, and
  // that clipboard paste calls the helper, pins the same guarantee without
  // pinning the old copy-pasted shape.
  const helperBody = at('function applyImportedModel(', 1600);
  check('the shared import helper takes materials back', helperBody.includes('adoptMaterials('));
  const clipBody = at('FileIO.importFromClipboard()', 500);
  check('clipboard import goes through that helper', clipBody.includes('applyImportedModel('));

  // Every path goes through one helper, so they cannot drift apart again.
  check('all load paths share one helper',
        (app.match(/adoptMaterials\(/g) || []).length >= 4,
        'expected the definition plus a call on each independent load path ' +
        '(applyImportedModel, loadFile, loadSharedURLModel)');

  // A file written before materials travelled has none. Keeping the current
  // library is the only sane answer, but a section pointing at a material that
  // library does not have must not pass in silence.
  const adopt = at('function adoptMaterials(', 1400);
  check('a file with no materials keeps the current library',
        /if \(Array\.isArray\(incoming\) && incoming\.length\)/.test(adopt));
  check('and unresolvable references are reported, not ignored',
        adopt.includes('orphans') && /toast\(/.test(adopt));

  // The rule itself, independent of how it is spelled: resolving a section
  // against the wrong library changes the number the solver is handed.
  const libA = [{ id: 4, name: 'A36 Steel',      E: 200, fy: 250 }];
  const libB = [{ id: 4, name: 'Aluminium 6061', E: 70,  fy: 240 }];
  const resolve = (sec, lib) => (lib.find(m => m.id === sec.materialId) || {}).E;
  const sec = { materialId: 4 };
  check('the same materialId means different things in different libraries',
        resolve(sec, libA) !== resolve(sec, libB));
  near('and the error is the full ratio between them',
        resolve(sec, libA) / resolve(sec, libB), 200 / 70, 1e-12);
}

group('A share link must be readable by the app that wrote it');
{
  // "Share URL" built a ?data= link and copied it to the clipboard, but
  // nothing ever read one back: importFromURL existed and had no caller, so
  // every link the button produced opened on the recipient's own model. The
  // button appeared to work and could not.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  // Matching the name alone is not enough — the function's own definition
  // contains it, so a check for that passes even with every caller removed.
  // The init path has to actually consult it, and before the last session.
  check('startup consults the shared link before restoring the last session',
        /if \(!loadSharedURLModel\(\) && !restoreSession\(\)\)/.test(app),
        'importFromURL existed for the whole life of the feature with no caller');
  const fn = app.slice(app.indexOf('function loadSharedURLModel()'), app.indexOf('function restoreSession()'));
  check('a shared link does not silently discard the open session',
        fn.includes("SA_AUTOSAVE_KEY + '_replaced'"));
  check('and it redraws the panels it just replaced',
        fn.includes('updateNodeTable()') && fn.includes('updateBeamTable()') &&
        fn.includes('updateLoadTable()') && fn.includes('fitToScreen()'),
        'the model loaded but the tables stayed empty and the canvas kept its default zoom');

  // The encoding. btoa(encodeURIComponent(prettyJSON)) inflated 5.4 kB of
  // model into a 29.6 kB URL — 5.5x — so the 8 kB guard rejected a 9-node
  // frame and the button refused all but toy models.
  const io = fs.readFileSync(path.join(ROOT, 'js/io/fileio.js'), 'utf8');
  check('the URL payload is not pretty-printed',
        /JSON\.stringify\(JSON\.parse\(exportJSON\(state\)\)\)/.test(io));
  check('and it is not percent-escaped before base64',
        !/btoa\(encodeURIComponent/.test(io.slice(io.indexOf('function exportToURL'))));
  check('the alphabet is URL-safe', io.includes("B64URL_OUT") && io.includes("replace(/=+$/, '')"));
  check('links made with the old encoding still open',
        io.slice(io.indexOf('function importFromURL')).includes('decodeURIComponent(atob(b64))'));

  // Base64 of raw UTF-8 bytes is 4/3; the old chain was more than five times
  // the payload. This is the property that decides whether a model fits.
  const bytes = 5368;                       // the 9-node frame, compact
  const newLen = Math.ceil(bytes / 3) * 4;
  check('a 9-node frame now fits in a link', newLen < 8000, newLen + ' chars');
  check('and would not have before', 29560 > 8000);
}

group('Referential integrity across the stores');
{
  // Every cross-store reference in a model: member to node and section,
  // section to material, load to case and to node or member, combination to
  // case. A dangling one of these is how a model solves against properties
  // nobody chose.
  const integrity = (S) => {
    const ids = a => new Set((a || []).map(x => x.id));
    const N = ids(S.nodes), B = ids(S.beams), SEC = ids(S.sections),
          MAT = ids(S.materials), LC = ids(S.loadCases);
    const bad = [];
    (S.beams || []).forEach(b => {
      if (!N.has(b.node1) || !N.has(b.node2)) bad.push('member ' + b.id + ': missing node');
      if (b.sectionId != null && !SEC.has(b.sectionId)) bad.push('member ' + b.id + ': missing section');
      if (b.node1 === b.node2) bad.push('member ' + b.id + ': zero length');
    });
    (S.sections || []).forEach(s => {
      if (s.materialId != null && !MAT.has(s.materialId)) bad.push('section ' + s.id + ': missing material');
    });
    (S.loads || []).forEach(l => {
      if (l.caseId != null && !LC.has(l.caseId)) bad.push('load ' + l.id + ': missing case');
      if (l.nodeId != null && !N.has(l.nodeId)) bad.push('load ' + l.id + ': missing node');
      if (l.elementId != null && !B.has(l.elementId)) bad.push('load ' + l.id + ': missing member');
    });
    (S.loadCombos || []).forEach(c => {
      // factors is an ARRAY of {caseId, factor}; reading it as a keyed object
      // turns the array indices into case ids and reports every combination
      // in a healthy model as broken.
      (Array.isArray(c.factors) ? c.factors : []).forEach(f => {
        if (!LC.has(f.caseId)) bad.push('combo ' + c.name + ': missing case ' + f.caseId);
      });
    });
    ['nodes', 'beams', 'sections', 'materials', 'loadCases', 'loads'].forEach(k => {
      const seen = {};
      (S[k] || []).forEach(x => { if (seen[x.id]) bad.push(k + ': duplicate id ' + x.id); seen[x.id] = 1; });
    });
    return bad;
  };

  const good = {
    nodes: [{ id: 1 }, { id: 2 }],
    beams: [{ id: 1, node1: 1, node2: 2, sectionId: 1 }],
    sections: [{ id: 1, materialId: 1 }],
    materials: [{ id: 1 }],
    loadCases: [{ id: 3 }],
    loads: [{ id: 1, caseId: 3, elementId: 1 }],
    loadCombos: [{ name: '1.4D', factors: [{ caseId: 3, factor: 1.4 }] }]
  };
  check('a sound model reports nothing', integrity(good).length === 0, integrity(good).join('; '));

  const clone = () => JSON.parse(JSON.stringify(good));
  let m;
  m = clone(); m.beams[0].sectionId = 99;
  check('a member on a deleted section is caught', integrity(m).length === 1);
  m = clone(); m.sections[0].materialId = 99;
  check('a section on a deleted material is caught', integrity(m).length === 1);
  m = clone(); m.loads[0].caseId = 99;
  check('a load in a deleted case is caught', integrity(m).length === 1);
  m = clone(); m.loadCombos[0].factors[0].caseId = 99;
  check('a combination on a deleted case is caught', integrity(m).length === 1);
  m = clone(); m.nodes.push({ id: 1 });
  check('a duplicate id is caught', integrity(m).some(s => /duplicate/.test(s)));
  m = clone(); m.beams[0].node2 = 1;
  check('a zero-length member is caught', integrity(m).some(s => /zero length/.test(s)));
}

group('The IndexedDB project store is gone, and stays gone');
{
  // StructDB shipped a `projects` store with saveProject / loadProject /
  // listProjects / deleteProject. Nothing ever called one of them: projects
  // go to localStorage under `sa_file_*` via saveFile(), and the Saved Files
  // dialog reads them back from there. The store was created on every install
  // and was empty on all of them — confirmed against a real profile before
  // removing it.
  //
  // Removing only the createObjectStore call would have left the store behind
  // in every browser that had already opened the app, so v2 deletes it.
  const io = fs.readFileSync(path.join(ROOT, 'js/db/indexeddb.js'), 'utf8');

  ['saveProject', 'loadProject', 'listProjects', 'deleteProject'].forEach(fn => {
    check(`StructDB no longer exposes ${fn}`, typeof StructDB[fn] === 'undefined');
  });
  check('and the two live stores are still there',
        typeof StructDB.getCachedResults === 'function' &&
        typeof StructDB.saveSections === 'function' &&
        typeof StructDB.modelHash === 'function');

  // The store is dropped, not merely left uncreated.
  check('the upgrade deletes the projects store',
        /db\.deleteObjectStore\('projects'\)/.test(io),
        'without this, every existing browser keeps an orphan store forever');
  check('and the delete is guarded for a fresh install',
        /if \(db\.objectStoreNames\.contains\('projects'\)\)/.test(io));
  check('nothing creates it any more', !/createObjectStore\('projects'/.test(io));

  // Deleting a store only runs inside an upgrade, so the version has to move.
  const ver = /const DB_VERSION = (\d+);/.exec(io);
  check('the DB version was bumped so the upgrade actually runs',
        ver && +ver[1] >= 2, ver ? ver[1] : 'no DB_VERSION found');

  // js/core/constants.js used to carry a second copy of DB_NAME, DB_VERSION
  // and the store names "kept in sync with indexeddb.js" by hand. Nothing ever
  // read them, so the sync was unverifiable and one-directional. The file is
  // gone; indexeddb.js is the only place these are written.
  check('there is only one copy of the DB version',
        !fs.existsSync(path.join(ROOT, 'js/core/constants.js')),
        'a second hand-maintained copy can only drift');

  // The stores the app actually uses must both survive the upgrade.
  check('sections survives', /createObjectStore\('sections'/.test(io));
  check('results_cache survives', /createObjectStore\('results_cache'/.test(io));

  // No caller anywhere — the reason it could be removed at all.
  let src = '';
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); }
      else if (e.name.endsWith('.js') && p !== path.join(ROOT, 'js/db/indexeddb.js'))
        src += '\n' + fs.readFileSync(p, 'utf8');
    }
  })(path.join(ROOT, 'js'));
  src += '\n' + fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ['saveProject', 'loadProject', 'listProjects', 'deleteProject'].forEach(fn => {
    check(`nothing calls StructDB.${fn}`, !src.includes(fn + '('), 'a caller would now throw');
  });
}

group('Concrete strength must never be read off a rebar grade');
{
  // Both code paths took a concrete section's cylinder strength from `sec.fy`.
  // That holds for the built-in Conc 9"x9" (fy = 27.6 MPa) but not for the
  // sections the default frame generator writes, which carry fy: 420 — a REBAR
  // grade. Every check on those members ran with 420 MPa concrete.
  //
  // Under ACI it quietly inflated capacity: a column read 0.858 OK that reads
  // 1.917 FAIL at its real 30 MPa. Under EC2 it destroyed the N-M envelope —
  // NRd,max came out NEGATIVE and the check returned its "way over" sentinel
  // of eta = 9 for every column in the model.
  //
  // EN 1992-1-1 covers C12/15 to C90/105, so anything above 100 MPa is not a
  // concrete strength.
  const envelope = (fck, As) => RCDesign.columnInteraction(0.4, 0.4, fck, 500, As, 35, 20);

  check('the whole EC2 strength range gives a positive squash load',
        [12, 20, 30, 50, 70, 90].every(f => envelope(f, 1600).NRd_max > 0));
  check('and a compression capacity above the tension capacity',
        [12, 20, 30, 50, 70, 90].every(f => {
          const d = envelope(f, 1600); return d.NRd_max > d.NRd_min;
        }));

  // The failure the clamp exists to prevent.
  const broken = RCDesign.columnInteraction(0.4, 0.4, 420, 500, 1600, 35, 20);
  check('a rebar grade used as fck would invert the envelope', broken.NRd_max < 0,
        'if this ever passes, the clamp is no longer the thing protecting the check');

  // runRCChecks clamps whatever reaches it, so no caller can reproduce that.
  const ef = { N1: 31, N2: 31, M1: -18, M2: 18, V1: 5, V2: 5, L: 3.5 };
  const sec = { name: 'Col 400x400', A: 1600, I: 213333, E: 25, d: 400, bf: 400, fy: 420 };
  const viaFy = RCDesign.runRCChecks(ef, sec, { b: 0.4, h: 0.4, memberType: 'column' });
  const pm = viaFy.find(c => /N-M Interaction/.test(c.check || ''));
  check('a section still carrying fy = 420 is clamped, not trusted',
        !!pm && pm.NRd_max > 0, pm ? 'NRd_max = ' + pm.NRd_max : 'no N-M check ran');
  check('and the sentinel eta of 9 is gone', !!pm && pm.eta < 9, pm && pm.eta);

  // The resolved value wins over the section's own field.
  const viaOpt = RCDesign.runRCChecks(ef, sec,
    { b: 0.4, h: 0.4, fck: 30, memberType: 'column' });
  const pm2 = viaOpt.find(c => /N-M Interaction/.test(c.check || ''));
  check('an explicit fck from the caller is what gets used',
        !!pm2 && pm2.eta > 0 && pm2.eta < 9, pm2 && pm2.eta);

  // The same section under ACI: options.fc must win over sec.fy too.
  const aci = ACIDesign.runACIChecks(ef, sec,
    { b: 0.4, h: 0.4, fc: 30, fy_rebar: 420, memberType: 'column' });
  const mat = aci.find(c => /Material/i.test(c.check || ''));
  check('ACI takes the resolved f\'c as well', !!aci.length);
  check('and does not report 420 MPa concrete',
        !JSON.stringify(mat || {}).includes('420') ||
        (mat && (mat.fc_MPa === 30 || mat.fcprime_MPa === 30)),
        JSON.stringify(mat || {}).slice(0, 120));
}

group('A check may not return a verdict it did not compute');
{
  // EC2 7.4.2 divides by the tension reinforcement ratio. A column has no
  // bending steel, so rho was 0, the limit came out NaN, and the check
  // reported FAIL with the note "l/d = 10.0 > NaN (limit)". That single false
  // failure is what made every concrete column read FAIL while its utilisation
  // sat at 0.03 — a contradiction on the face of the design table.
  const noSteel = RCDesign.deflectionSpanDepth(3.5, 0.35, 30, 500, 0, 0, 0, 'simply-supported');
  check('no reinforcement to work from is not a failure', noSteel.status !== 'FAIL',
        noSteel.status);
  check('and reports no utilisation rather than a NaN one',
        noSteel.eta === null || Number.isFinite(noSteel.eta), noSteel.eta);
  check('and says why', /does not apply|no tension reinforcement/i.test(noSteel.note || ''),
        noSteel.note);

  // A real beam still gets a real answer.
  const beam = RCDesign.deflectionSpanDepth(6, 0.55, 30, 500, 1200, 1100, 0.0073, 'simply-supported');
  check('a beam is still checked', Number.isFinite(beam.eta) && beam.eta > 0, beam.eta);
  check('and passes when it should', beam.status === 'OK', beam.status);

  // Span/depth is a beam and slab rule; it must not be run on a column at all.
  const ef  = { N1: 62, N2: 62, M1: 0, M2: 0, V1: 0, V2: 0, L: 3.5 };
  const sec = { name: 'Col 400x400', A: 1600, I: 213333, E: 25, d: 400, bf: 400, fy: 420 };
  const col  = RCDesign.runRCChecks(ef, sec, { b: 0.4, h: 0.4, fck: 30, memberType: 'column' });
  const bm   = RCDesign.runRCChecks(ef, sec, { b: 0.4, h: 0.4, fck: 30, memberType: 'beam' });
  const hasLd = cs => cs.some(c => /Deflection \(EC2 7\.4/.test(c.check || ''));
  check('a column is not span/depth checked', !hasLd(col));
  check('a beam still is',                     hasLd(bm));
  check('and the column no longer fails on it',
        !col.some(c => /FAIL/.test(c.status || '') && c.eta == null),
        col.filter(c => /FAIL/.test(c.status || '')).map(c => c.check).join(', '));
}

group('Reported utilisation must agree with the verdict');
{
  // Crack control switched eta to wc/0.33 whenever the Frosch crack width
  // exceeded its limit. That limit is informational, not mandated — ACI
  // requires the BAR SPACING of 24.3.2, which is what decides pass or fail.
  // So a beam meeting every ACI requirement reported eta = 1.38 and rolled it
  // up as the member's headline number, next to a verdict of NEAR.
  const ef  = { N1: 0, N2: 0, M1: -120, M2: 120, V1: 60, V2: 60, L: 6 };
  const sec = { name: 'Beam 300x600', A: 1800, I: 540000, E: 25, d: 600, bf: 300, fy: 420 };
  const cs  = ACIDesign.runACIChecks(ef, sec,
    { b: 0.3, h: 0.6, fc: 30, fy_rebar: 420, memberType: 'beam' });

  const crack = cs.find(c => /Crack Control/.test(c.check || ''));
  check('crack control still runs', !!crack);
  if (crack) {
    // eta tracks the mandated spacing check, so it cannot exceed 1 while the
    // spacing requirement is met.
    check('its utilisation tracks the requirement that decides the verdict',
          !(crack.eta > 1 && crack.spacing_ok),
          `eta = ${crack.eta}, spacing_ok = ${crack.spacing_ok}`);
    check('and the advisory crack width is still reported',
          crack.wc_mm != null && crack.wc_limit_mm != null);
  }

  // The invariant across every check either code produces: a utilisation at or
  // under 1 is not a failure, and one above 1 is not a pass.
  const all = [].concat(cs,
    RCDesign.runRCChecks(ef, sec, { b: 0.3, h: 0.6, fck: 30, memberType: 'beam' }));
  const cls = s => DesignChecks.classifyStatus(s);
  const contradictions = all.filter(c =>
    Number.isFinite(c.eta) &&
    ((c.eta <= 1.0 && cls(c.status) === 'FAIL') ||
     (c.eta >  1.0 && cls(c.status) === 'OK')));
  check('no check contradicts its own utilisation', contradictions.length === 0,
        contradictions.map(c => `${c.check}: eta=${c.eta} -> ${c.status}`).join('; '));
}

group('An exported file must state the code it was produced under');
{
  // The design CSV header was the literal string "(EC3)" whatever code had
  // run. Checking a model to ACI 318 and exporting it produced rows of ACI-RC
  // results — Max eta 1.917 on a column — beneath a heading claiming Eurocode
  // 3. Unlike a wrong label inside the app, this one leaves on a file that
  // someone else opens.
  const dr = {
    byBeam: [{
      label: 'C1', secName: 'Col 400x400', L: 3.5, cls: 'ACI-RC',
      maxEta: 1.917, overall: 'FAIL',
      checks: [{ check: 'Shear (ACI 22.5)', eta: 0.5527, status: 'OK' }]
    }]
  };

  const aci = FileIO.exportDesignCSV(dr, 'ACI 318-19');
  const ec2 = FileIO.exportDesignCSV(dr, 'EC2');
  const ec3 = FileIO.exportDesignCSV(dr, 'EC3');

  check('the header names the code it was given', aci.split('\n')[0].includes('ACI 318-19'),
        aci.split('\n')[0]);
  check('and follows the code, rather than being fixed',
        ec2.split('\n')[0].includes('EC2') && ec3.split('\n')[0].includes('EC3'));
  check('an ACI export no longer claims EC3', !aci.split('\n')[0].includes('EC3'),
        aci.split('\n')[0]);

  // A caller that forgets to say must not have a standard invented for it.
  const bare = FileIO.exportDesignCSV(dr);
  check('an unlabelled export says so rather than guessing',
        /not stated/i.test(bare.split('\n')[0]) && !/EC3|ACI|EC2/.test(bare.split('\n')[0]),
        bare.split('\n')[0]);

  // The rows themselves still carry the data.
  check('the rows still export', aci.split('\n').length >= 5);
  check('and carry the member and its utilisation',
        aci.includes('C1') && aci.includes('1.9170'));

  // Nothing to export is not an empty header — it is nothing.
  check('no results exports nothing at all', FileIO.exportDesignCSV(null) === '');
}

group('Every export produces content, not an empty file');
{
  // A silently empty export is worse than a failed one: the file arrives, it
  // is just useless. These run the real generators over a solved model.
  const S = [{ id: 1, name: 'test', E: 210, A: 100, I: 20000, Ix: 20000, rho: 78.5 }];
  const nodes = [{ id: 1, x: 0, y: 0, support: 'pin' },
                 { id: 2, x: 6, y: 0, support: 'roller' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const res = solveFrame(nodes, beams, S, [{ type: 'beam_udl', elementId: 1, w: -10 }], []);
  check('the fixture solves', !!res.success, res.error);

  const json = FileIO.exportJSON({ nodes, beams, sections: S, loads: [], settlements: [],
                                   loadCases: [], loadCombos: [], nextId: {} });
  const csv  = FileIO.exportCSV(res, beams, nodes);
  const dxf  = FileIO.exportDXF(nodes, beams);

  [['JSON', json], ['forces CSV', csv], ['DXF', dxf]].forEach(([name, txt]) => {
    check(`${name} produces content`, typeof txt === 'string' && txt.length > 50, (txt || '').length);
    check(`${name} carries no NaN or undefined`, !/NaN|undefined/.test(txt || ''),
          (txt || '').slice(0, 80));
  });

  // Each in the shape its consumer expects.
  check('the JSON parses', (() => { try { JSON.parse(json); return true; } catch (e) { return false; } })());
  check('the CSV has a header row and a data row', csv.split('\n').filter(l => l.includes(',')).length >= 2);
  check('the DXF is a real section/entities file',
        dxf.includes('SECTION') && dxf.includes('ENTITIES') && dxf.includes('LINE'));
  check('and holds one LINE per member',
        (dxf.match(/\nLINE\n/g) || []).length >= beams.length);
}

group('A member has one name everywhere');
{
  // getMemberLabel decides what a member is called — C1, B7, BR3, or whatever
  // custom label the user set. The canvas, the members table, the design
  // results, the CSV and the report all went through it. The Properties panel
  // did not: it built 'M' + id in three separate places, so selecting B7 on
  // the canvas opened a panel headed "Member M7", and the design table
  // reporting that member's failure called it B7 again. Two names, one member,
  // no way to tell they were the same.
  const app  = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  check('the naming function is published for other files to use',
        /^\s*getMemberLabel,\s*$/m.test(app),
        'the Properties panel lives in index.html and cannot reach it otherwise');

  // No one may mint a member name from the raw id again.
  const minted = [
    ["'\\U0001f529 Member M' + bid", /Member M' \+ bid/],
    ['props-value">M\' + beam.id',   /props-value">M' \+ beam\.id/],
    ["'M' + beamId",                 /'M' \+ beamId/],
    ["'M' + _beamId",                /'M' \+ _beamId/]
  ].filter(([, re]) => re.test(html)).map(([label]) => label);
  check('no site builds its own M-prefixed member name', minted.length === 0,
        minted.join(', '));

  // Every one of those sites now asks for the label.
  const propsBlock = html.slice(html.indexOf('props-hdr-title'));
  check('the Properties header asks for the label',
        /getMemberLabel\(beam\)/.test(propsBlock));
  check('so does the ID row it shows underneath',
        (html.match(/getMemberLabel\(beam\)/g) || []).length >= 2);
  check('and the member-type confirmations the user reads back',
        (html.match(/getMemberLabel\(bm\)/g) || []).length >= 2);

  // The rule the label itself follows, so a custom name is never overridden.
  const label = (bm, type) => bm.label ? bm.label
              : type === 'column' ? 'C' + bm.id
              : type === 'brace'  ? 'BR' + bm.id : 'B' + bm.id;
  check('a column is C-prefixed',        label({ id: 1 }, 'column') === 'C1');
  check('a beam is B-prefixed',          label({ id: 7 }, 'beam')   === 'B7');
  check('a brace is BR-prefixed',        label({ id: 3 }, 'brace')  === 'BR3');
  check('and a custom label wins over all of them',
        label({ id: 7, label: 'PLINTH-1' }, 'beam') === 'PLINTH-1');
}

group('Results on screen must describe the model on screen');
{
  // discardStaleResults() drops the solved arrays and removes the Quick
  // Summary and the mode-shape overlay when the model changes under them. It
  // did not touch the Results pane, which keeps whatever table
  // showResultsPanel() last wrote — so moving a single node left 52 rows of
  // reactions, displacements and member end forces for the geometry that
  // existed before the move, with nothing on screen saying so.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const fn  = app.slice(app.indexOf('function discardStaleResults()'),
                        app.indexOf('// Results overlay'));

  check('the solved results are dropped', /results = null/.test(fn));
  check('the Quick Summary goes with them', /quick-summary/.test(fn));
  check('the mode-shape overlay too',       /sv-mode-shape/.test(fn));
  check('and so does the Results pane', /showResultsPanel\(null\)/.test(fn),
        'the pane holds its own rendered copy and is not rebuilt by render()');
  check('the user is told, not left to notice',
        /no longer describe it/.test(fn) && /toast\(/.test(fn));

  // The staleness test itself: results are current only while the model has
  // not moved on, and only while there is a model to describe.
  const current = (resRev, modelRev, nNodes, nBeams) =>
    resRev === modelRev && nNodes > 0 && nBeams > 0;
  check('untouched since the solve counts as current', current(5, 5, 9, 10));
  check('one edit later it does not',                  !current(5, 6, 9, 10));
  check('and an emptied model never does',             !current(5, 5, 0, 0),
        'this is what left 80 kN of reaction reported for a cleared canvas');
}

group('The panel has only the tabs it can honour');
{
  // The side panel carried eleven .ptab buttons: four real ones and seven
  // hidden "phantoms" created by a compatibility shim, so that legacy
  // querySelector('[data-pane=nodes|beams|sections|loads|design|tools|aci]')
  // calls would be redirected to the consolidated panes.
  //
  // Those callers are gone — the only pane selectors left anywhere are
  // properties, cases and results — so the shim redirected nothing. The `aci`
  // phantom opened a floating panel whose markup had been emptied: #pane-aci
  // had no children and the document contains no [data-ch] chapter buttons
  // for it to navigate to. The real ACI content is the modal-calc-* dialogs.
  // Comments are stripped first: the notes left behind explaining WHY these
  // were removed necessarily name the things they removed, and a check that
  // trips over its own explanation tests nothing.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/<!--[\s\S]*?-->/g, '')
                        .replace(/^[ 	]*\/\/.*$/gm, '');
  const html = strip(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  const css  = strip(fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8'));

  const tabs = [...html.matchAll(/class="ptab[^"]*"[^>]*data-pane="([a-z]+)"/g)].map(m => m[1]);
  check('four tabs are declared', tabs.length === 4, tabs.join(', '));
  check('and they are the four that exist',
        ['explorer', 'properties', 'cases', 'results'].every(p => tabs.includes(p)),
        tabs.join(', '));

  check('nothing manufactures extra tabs at runtime',
        !/className = 'ptab'/.test(html) && !/phantom\.appendChild/.test(html));
  check('the redirect map is gone',   !/const REDIRECT = \{/.test(html));
  check('the empty pane is gone',     !/id="pane-aci"/.test(html));
  check('and its openers with it',
        !/window\.openAciPanel = function/.test(html) &&
        !/window\.closeAciPanel = function/.test(html));
  check('the CSS that styled it went too',
        !/#pane-aci \{/.test(css) && !/#aci-float-hdr/.test(css));

  // What must survive: the panes that became sections inside other panes,
  // and the chapter styling the working calculators rely on.
  ['pane-nodes', 'pane-beams', 'pane-sections', 'pane-loads', 'pane-design']
    .forEach(id => check(`${id} is still in the markup`, html.includes('id="' + id + '"')));
  check('the ACI chapter styling is untouched, the calculators use it',
        /\.aci-chapter \{/.test(css) && /\.aci-chapter\.active/.test(css));
  check('and the chapters themselves remain',
        (html.match(/class="aci-chapter/g) || []).length >= 15);

  // No selector may point at a pane the panel cannot show.
  const used = new Set([...html.matchAll(/data-pane=["']?([a-z]+)/g)].map(m => m[1]));
  const strays = [...used].filter(p => !tabs.includes(p));
  check('every pane selector in the file names a real tab', strays.length === 0,
        strays.join(', '));
}

group('Running the checks shows the checks');
{
  // The design results live in a section of the Results pane. Running them
  // from the Design ribbon tab filled that table in and left the user on
  // whichever pane they started from, with only a toast to say anything had
  // happened — a button that computes something and does not show it.
  //
  // runDesignChecks() has exactly one caller (the pnl-run-design button, which
  // the ribbon button clicks too), so navigating from inside it cannot
  // surprise a background caller.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const fn  = app.slice(app.indexOf('function runDesignChecks()'),
                        app.indexOf('function updateDesignTable()'));

  check('the checks navigate to the pane that shows them',
        /switchPane\('results'\)/.test(fn));
  check('and bring the design section into view',
        /getElementById\('pane-design'\)[\s\S]{0,60}scrollIntoView/.test(fn));

  // Order matters: navigate only after there is something to look at.
  const iTable = fn.indexOf('updateDesignTable()');
  const iNav   = fn.indexOf("switchPane('results')");
  check('the table is built before the pane is shown',
        iTable > -1 && iNav > iTable, `table at ${iTable}, nav at ${iNav}`);

  // And not at all when the run bailed out.
  const iBail = fn.indexOf("toast('No results to check'");
  check('a run with nothing to check returns before navigating',
        iBail > -1 && iBail < iNav, `bail at ${iBail}, nav at ${iNav}`);
  check('that early return is a return, not a fall-through',
        /No results to check[^;]*;\s*return;/.test(fn));

  // One caller only — the premise the whole change rests on.
  const callers = (app.match(/runDesignChecks(?!\s*\()/g) || []).length;
  check('runDesignChecks is only wired to its button',
        /addEventListener\('click', runDesignChecks\)/.test(app) && callers <= 3,
        callers + ' bare references');
}

group("A material's Poisson ratio reaches the analysis");
{
  // Define ▸ Materials has always offered Poisson's Ratio, and nothing read
  // it: solver3d.js and modes.js both hardcoded 0.30 when forming
  // G = E / 2(1+nu). Concrete at nu = 0.2 was analysed with steel's shear
  // modulus, and the field looked like an input while changing nothing.
  //
  // L-frame in plan: member 1 runs along X from a fixed base, member 2 along
  // Y off its tip. A load on member 2 twists member 1 about its own axis, so
  // the answer is governed by G and therefore by nu.
  const lframe = (nu) => {
    const sec = { id: 1, name: 't', E: 30, A: 160, I: 21333, Ix: 21333,
                  Iy: 21333, J: 36000, rho: 0 };
    if (nu != null) sec.nu = nu;
    const nodes = [{ id: 1, x: 0, y: 0, z: 0, support: 'fixed' },
                   { id: 2, x: 3, y: 0, z: 0, support: 'none' },
                   { id: 3, x: 3, y: 2, z: 0, support: 'none' }];
    const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 },
                   { id: 2, node1: 2, node2: 3, sectionId: 1 }];
    const r = solveFrame3D(nodes, beams, [sec],
      [{ type: 'beam_dist', elementId: 2, fy: -10 }], []);
    return { ok: r.success, twist: r.disp && r.disp[2] ? r.disp[2]['\u03b8x'] : null };
  };

  const a = lframe(0.20), b = lframe(0.30), c = lframe(0.45), d = lframe(null);
  check('the L-frame solves', a.ok && b.ok && c.ok && d.ok);
  check('Poisson ratio changes the answer', a.twist !== b.twist,
        'it was hardcoded, so every material twisted identically');

  // Twist is inversely proportional to G, and G goes as 1/(1+nu), so the
  // twist ratio is exactly the ratio of (1+nu). This is the physics, not a
  // golden number — it holds whatever the section or the load.
  near('nu 0.30 vs 0.20 twists in proportion to (1+nu)',
       b.twist / a.twist, 1.30 / 1.20, 1e-9);
  near('and so does nu 0.45',
       c.twist / a.twist, 1.45 / 1.20, 1e-9);
  check('a softer material twists more',
        Math.abs(c.twist) > Math.abs(b.twist) && Math.abs(b.twist) > Math.abs(a.twist));

  // A section with no material linked must behave exactly as before.
  near('no Poisson ratio still means 0.30', d.twist, b.twist, 1e-12);

  // Out-of-range values are not physical and must not be trusted.
  const io3 = fs.readFileSync(path.join(ROOT, 'js/solver3d.js'), 'utf8');
  const md  = fs.readFileSync(path.join(ROOT, 'js/analysis/modes.js'), 'utf8');
  check('the static solver range-checks it', /sec\.nu > 0 && sec\.nu < 0\.5/.test(io3));
  check('and the modal solver uses the same rule', /sec\.nu > 0 && sec\.nu < 0\.5/.test(md));
  check('neither hardcodes 0.30 any more',
        !/2 \* \(1 \+ 0\.30\)/.test(io3) && !/2 \* \(1 \+ 0\.30\)/.test(md));
}

group('The materials dialog offers only what the app can use');
{
  // Define ▸ Materials carried four fields nothing in the application read:
  // Directional Symmetry (a read-only word), Coefficient of Thermal Expansion
  // (there is no thermal analysis — "TL" is a load-case label the user fills
  // in by hand), Ultimate Stress fu (no check consults it), and Modulus of
  // Rupture (the ACI Materials calculator derives fr from f'c itself).
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const h = strip(html);

  ['mp-sym', 'mp-alpha', 'mp-fu', 'mp-rupture', 'mp-concrete-extra'].forEach(id =>
    check(`${id} is gone from the dialog`, !h.includes('id="' + id + '"')));

  // Removing a field must not delete what users already stored: gv() returns
  // null for a missing element and `parseFloat(null) || null` is null, so the
  // assignment has to go with the input.
  check('and nothing writes null over the stored values',
        !/mat\.fu\s*=/.test(h) && !/mat\.alpha\s*=/.test(h),
        'a leftover assignment would wipe the value on the next save');

  // What the app does consume must still be there.
  ['mp-name', 'mp-type', 'mp-color', 'mp-weight', 'mp-E', 'mp-nu', 'mp-fy', 'mp-fc']
    .forEach(id => check(`${id} is kept`, h.includes('id="' + id + '"')));

  // Opening "Modify/Show Material" is not an edit. onTypeChange() derived Ec
  // from f'c unconditionally and openProps() calls it right after loading the
  // stored value, so opening the dialog on a concrete material with
  // E = 28.7 GPa showed 23.5 and OK wrote that back — an 18% stiffness change
  // from an action that reads as look-but-do-not-touch.
  check('E is only re-derived on a real type change',
        /function onTypeChange\(deriveE\)/.test(h) && /if \(deriveE\)/.test(h));
  check('opening the dialog does not re-derive', /onTypeChange\(false\)/.test(h));
  check('but changing the material type does',   /onTypeChange\(true\)/.test(h));

  // The derivation itself is ACI 19.2.2.1.
  near("Ec = 4700 sqrt(f'c) at 25 MPa", 4700 * Math.sqrt(25) / 1000, 23.50, 0.005);
  near('and at 40 MPa',                 4700 * Math.sqrt(40) / 1000, 29.73, 0.005);
}

group('Section stiffness modifiers must reach the solver');
{
  // Modifiers can be set in two places, under two sets of key names:
  //
  //   per MEMBER   bm.modifiers  { f11, f22, f33, fm, fi2, fi3, fmass, fwgt }
  //   per SECTION  sec.mods      { A,   AS2, AS3, J,  I22, I33, mass,  weight }
  //
  // Every analysis path read only the member set, so Define > Sections >
  // Modifiers — the dialog that offers "ACI 318 recommended modifiers" —
  // wrote values nothing looked at. Applying the ACI cracked-section factors
  // (I33 = 0.70) to the columns of a two-storey frame left its sway at
  // 1.0489 mm, the uncracked answer to four decimals.
  const nodes = [{ id: 1, x: 0, y: 0, support: 'fixed' },
                 { id: 2, x: 0, y: 3.5, support: 'none' }];
  const push  = [{ type: 'nodal', nodeId: 2, fx: 10 }];
  const BASE  = { id: 1, name: 'c', E: 30, A: 1600, I: 213333, Ix: 213333, rho: 0 };
  const sway  = (secExtra, bmExtra) => {
    const bm  = Object.assign({ id: 1, node1: 1, node2: 2, sectionId: 1 }, bmExtra);
    const sec = Object.assign({}, BASE, secExtra);
    const r = solveFrame(nodes, [bm], [sec], push, []);
    return r.success ? Math.abs(r.disp[2].u) : null;
  };

  const plain = sway({}, {});
  check('the cantilever solves', plain > 0, plain);

  const viaSection = sway({ mods: { I33: 0.70 } }, {});
  const viaMember  = sway({}, { modifiers: { fi3: 0.70 } });
  check('a section modifier changes the answer', viaSection !== plain,
        'it used to be written to a store nothing read');
  near('and agrees with the member modifier', viaSection, viaMember, 1e-12);
  near('0.70 on EI gives 1/0.70 the sway', viaSection / plain, 1 / 0.70, 1e-9);

  // The member is the more specific statement, so it wins.
  const both = sway({ mods: { I33: 0.50 } }, { modifiers: { fi3: 1.00 } });
  near('a member modifier overrides its section', both, plain, 1e-12);

  // A modifier of exactly 0 is a real input meaning "no stiffness here", and
  // must not be read as "unset".
  check('zero is honoured, not treated as absent',
        typeof stiffMod === 'function' && stiffMod({ modifiers: { fi3: 0 } }, {}, 'fi3') === 0);
  check('an unset modifier is 1', stiffMod({}, {}, 'fi3') === 1);
  check('a section value is used when the member has none',
        stiffMod({}, { mods: { I33: 0.35 } }, 'fi3') === 0.35);
  const all2 = { mods: { A: 2, AS2: 2, AS3: 2, J: 2, I22: 2, I33: 2, mass: 2, weight: 2 } };
  check('and every key maps across',
        ['f11', 'f22', 'f33', 'fm', 'fi2', 'fi3', 'fmass', 'fwgt']
          .every(k => stiffMod({}, all2, k) === 2));
}

group('The results cache must notice everything that changes the answer');
{
  // The fingerprint carried each member's modifiers but nothing of its
  // section's, so applying cracked-section factors and pressing Solve handed
  // back the uncracked results out of the cache. Poisson's ratio now drives
  // G in the 3D solver, so it belongs in the key for the same reason.
  const N = [{ id: 1, x: 0, y: 0, support: 'fixed' }, { id: 2, x: 3, y: 0, support: 'none' }];
  const B = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const L = [{ type: 'beam_dist', elementId: 1, fy: -10 }];
  const base = { id: 1, name: 'c', E: 30, A: 1600, I: 213333, Ix: 213333, rho: 0 };
  const h = (sec) => StructDB.modelHash(N, B, [sec], L, []);

  check('an unchanged model hashes the same', h(base) === h(Object.assign({}, base)));
  check('a section modifier changes the fingerprint',
        h(base) !== h(Object.assign({}, base, { mods: { I33: 0.70 } })),
        'otherwise Solve returns the pre-modifier results');
  check('and so does the Poisson ratio',
        h(base) !== h(Object.assign({}, base, { nu: 0.20 })),
        'it changes G, and therefore the 3D answer');
  check('different modifiers hash differently',
        h(Object.assign({}, base, { mods: { I33: 0.70 } })) !==
        h(Object.assign({}, base, { mods: { I33: 0.35 } })));
  check('a rename does not bust the cache',
        h(base) === h(Object.assign({}, base, { name: 'renamed' })));
}

group('A rebar layout is what the column is checked against');
{
  // Define > Sections > Rebar records a full arrangement — bars per face, bar
  // and corner areas, cover, confinement — and no check read a line of it.
  // Both codes substituted their own minimum: ACI rho,min = 1%, EC2
  // max(0.10 NEd/fyd, 0.002 Ac) which is about 0.2%. A 400x400 column
  // detailed with real bars was checked as though it held the bare minimum,
  // so EC2 reported an N-M utilisation of 8.5 on an adequate column.
  //
  // Perimeter count: the faces share their corners, so n = 2*n3 + 2*n2 - 4.
  const areaOf = (r) => {
    if (!r) return 0;
    const n3 = Math.max(2, +r.barsAlong3 || 0), n2 = Math.max(2, +r.barsAlong2 || 0);
    const total = 2 * n3 + 2 * n2 - 4;
    if (!(total > 0)) return 0;
    const Abar = +r.barArea > 0 ? +r.barArea : 0;
    const Ac   = +r.cornerBarArea > 0 ? +r.cornerBarArea : Abar;
    return 4 * Ac + Math.max(0, total - 4) * Abar;
  };
  check('3 by 3 is eight bars, not twelve',
        areaOf({ barsAlong3: 3, barsAlong2: 3, barArea: 510 }) === 8 * 510,
        'the four corner bars are shared between the two faces');
  check('3 by 5 is twelve bars',
        areaOf({ barsAlong3: 3, barsAlong2: 5, barArea: 645 }) === 12 * 645);
  check('corner bars may differ in size',
        areaOf({ barsAlong3: 3, barsAlong2: 3, barArea: 510, cornerBarArea: 645 })
          === 4 * 645 + 4 * 510);
  check('no layout means no area, so the code minimum still applies',
        areaOf(null) === 0 && areaOf({}) === 0);

  // The steel genuinely changes the verdict: same column, same forces.
  const bare = RCDesign.columnPMCheck(31, 185, 0.4, 0.4, 30, 500, 320, 35, 20);
  const real = RCDesign.columnPMCheck(31, 185, 0.4, 0.4, 30, 500, 4080, 35, 20);
  check('the minimum-steel column fails', bare.eta > 1, bare.eta);
  check('the detailed one does better', real.eta < bare.eta, real.eta + ' vs ' + bare.eta);
  check('because its moment capacity is larger', real.MRd_at_N > bare.MRd_at_N,
        real.MRd_at_N + ' vs ' + bare.MRd_at_N + ' kNm');

  // Both callers must pass the layout through rather than hardcoding zero.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const aci = fs.readFileSync(path.join(ROOT, 'js/design/aci_checks.js'), 'utf8');
  check('app.js computes the area from the layout', /function rebarAreaOf\(sec\)/.test(app));
  check('and hands it to ACI', /Ast:\s*rebarAreaOf\(sec\)/.test(app));
  check('and to EC2',          /As_col:\s*rebarAreaOf\(sec\)/.test(app));
  check('the ACI column check no longer hardcodes zero steel',
        !/fy_rebar, 0, true\)/.test(aci));
}

group('Applying a load must hit the members that were asked for');
{
  // The Dead Load calculator read the selection as
  //     const sel = SA.multiSel ? Array.from(SA.multiSel) : [];
  // but multiSel is { nodes: Set, beams: Set }, not a Set. Array.from() on a
  // plain object with no length yields [], so `sel.length > 0` was never true
  // and "Selected Beams" fell through to `beams` — every member in the model.
  // Asking for two beams put a floor UDL on all ten, six of them columns.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function applyToModel()'),
                        html.indexOf('function applyToModel()') + 2200);

  check('the selection is read from multiSel.beams',
        /SA\.multiSel\.beams \? \[\.\.\.SA\.multiSel\.beams\]/.test(fn),
        'Array.from(multiSel) is always empty');
  check('and "selected" no longer falls through to every member',
        !/applyTo === 'selected' && sel\.length > 0/.test(fn));
  check('an empty selection is refused rather than widened',
        /applyTo === 'selected' && !sel\.length/.test(fn) &&
        /No members are selected/.test(fn));

  // Array.from on the real shape, so the premise cannot rot.
  const multiSel = { nodes: new Set([1, 2]), beams: new Set([7, 8]) };
  check('Array.from(multiSel) really is empty', Array.from(multiSel).length === 0,
        'if this ever changes, the old code was not broken after all');
  check('but its beams set is not', [...multiSel.beams].length === 2);

  // ── snapshot ordering ────────────────────────────────────────────────
  // snapshot() records the PRE-edit state, so it has to be taken before the
  // mutation. Taken after, it recorded the loads as though they had always
  // been there and Ctrl+Z could not remove them. Self-weight, which applies
  // loads the same way, got this right and was the comparison that showed it.
  const iSnap = fn.indexOf('SA.snapshot');
  const iPush = fn.indexOf('target.forEach');
  check('the snapshot is taken before the loads are pushed',
        iSnap > -1 && iPush > -1 && iSnap < iPush,
        `snapshot at ${iSnap}, push at ${iPush}`);
  check('and only once', (fn.match(/SA\.snapshot && SA\.snapshot\(\)/g) || []).length === 1);

  // The load itself: a dead load acts downward, in the DL case.
  check('the UDL is applied downward', /fy: dir === 'fy' \? -udl : 0/.test(fn),
        'a positive fy would push the floor up');
  check('and into a dead-load case', /lc\.type === 'DL'/.test(fn));

  // The arithmetic the preview shows: pressure x tributary width.
  const total = 0.2 * 23.56;            // 200 mm of normal-weight concrete
  near('0.2 m of NWC is 4.712 kN/m2', total, 4.712, 5e-4);
  near('over a 3 m tributary width that is 14.136 kN/m', total * 3, 14.136, 2e-3);
}

group('Story shear is the algebraic sum, not the sum of magnitudes');
{
  // Story shear was accumulated as storyShear += Math.abs(ef.V1), so a column
  // shearing back against the others was added instead of subtracted. In a
  // laterally loaded frame that reversal is routine — the windward column
  // commonly takes negative shear while the rest carry the load.
  //
  // On the two-storey frame under wind (20 kN at 3.5 m, 35 kN at 7 m) the top
  // story's three columns carry -11.835, +30.670 and +16.165 kN. Horizontal
  // equilibrium of everything above that level fixes the shear at 35.0 kN —
  // the load applied above it. Sum|V| reported 58.67, over by 68%. The lower
  // story read 55.00 correctly only because its columns happened to agree in
  // sign, which is what kept the error out of sight.
  const V = [-11.835, 30.670, 16.165];
  const algebraic = V.reduce((a, v) => a + v, 0);
  const magnitudes = V.reduce((a, v) => a + Math.abs(v), 0);
  near('the algebraic sum is the applied load above', Math.abs(algebraic), 35.0, 1e-3);
  near('the sum of magnitudes is not', magnitudes, 58.67, 1e-3);
  check('and the two differ whenever a column reverses', Math.abs(algebraic - magnitudes) > 1,
        'with no reversal they agree, which is why one story looked right');

  // A story whose columns all shear the same way is unaffected by the fix.
  const same = [55, 0, 0];
  near('a story with no reversal is unchanged',
       same.reduce((a, v) => a + v, 0), same.reduce((a, v) => a + Math.abs(v), 0), 1e-12);

  // The code must sum signed values and take the magnitude only at the end.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function computeStoryForces('),
                       app.indexOf('function computeStoryForces(') + 3000);
  check('shears accumulate signed', /storyShear \+= \(ef\.V1 \|\| 0\)/.test(fn),
        'Math.abs inside the loop is the bug');
  check('and the magnitude is taken once, afterwards',
        /storyShear = Math\.abs\(storyShear\)/.test(fn));
  check('no absolute value is taken inside the accumulation',
        !/storyShear \+= Math\.abs/.test(fn));

  // Equilibrium is the property being protected: the shear in any story
  // equals the lateral load applied above it.
  const applied = [{ y: 3.5, fx: 20 }, { y: 7.0, fx: 35 }];
  const shearAbove = (level) => applied.filter(l => l.y > level).reduce((a, l) => a + l.fx, 0);
  near('above 3.5 m, 35 kN is applied', shearAbove(3.5), 35, 1e-12);
  near('above ground, 55 kN is applied', shearAbove(0), 55, 1e-12);
}

group('The P-Delta engine amplifies as theory says it must');
{
  // The engine itself is sound — this pins it, because the way the app drives
  // it is not (see solvePDeltaAll, which runs P-Delta per load CASE).
  //
  // Cantilever column, lateral load at the tip plus axial P. Second-order
  // sway is amplified by roughly 1 / (1 - P/Pcr) with Pcr the fixed-free
  // Euler load.
  const E = 25, I = 213333, L = 3.5;             // GPa, cm4, m
  const EI  = E * 1e6 * I / 1e8;                 // kN.m2
  const Pcr = Math.PI * Math.PI * EI / Math.pow(2 * L, 2);
  const SEC = [{ id: 1, name: 'c', E: E, A: 1600, I: I, Ix: I, rho: 0 }];
  const nodes = [{ id: 1, x: 0, y: 0, support: 'fixed' },
                 { id: 2, x: 0, y: L, support: 'none' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const P = 2000;
  const loads = [{ type: 'nodal', nodeId: 2, fx: 10, fy: -P }];

  const lin = solveFrame(nodes, beams, SEC, loads, []);
  const pd  = PDeltaAnalysis.runPDelta(nodes, beams, SEC, loads, []);
  check('both paths solve', !!lin.success && !!pd.success, lin.error || pd.error);

  const uLin = Math.abs(lin.disp[2].u), uPd = Math.abs(pd.disp[2].u);
  check('second order is larger than first order', uPd > uLin,
        `${(uPd * 1000).toFixed(4)} mm vs ${(uLin * 1000).toFixed(4)} mm`);
  near('and by the amplifier theory predicts', uPd / uLin, 1 / (1 - P / Pcr), 0.01);
  check('the iteration converged', pd.converged !== false, pd.iterations);

  // With no axial load there is nothing to amplify.
  const noAxial = PDeltaAnalysis.runPDelta(nodes, beams, SEC,
    [{ type: 'nodal', nodeId: 2, fx: 10 }], []);
  near('no axial load means no amplification',
       Math.abs(noAxial.disp[2].u) / uLin, 1, 0.02);
}

group('A second-order combination must be solved, not superposed');
{
  // solvePDeltaAll() ran P-delta once per load CASE and then added the case
  // results together for each combination. That is exact for a linear system
  // and meaningless for a nonlinear one: P-delta is the interaction between
  // axial force and lateral drift, so gravity and wind have to be present in
  // the structure at the same time for the effect to exist at all.
  //
  // Dead alone has axial force but no sway to amplify. Wind alone has sway
  // but almost no axial force. Neither case shows the effect, and adding two
  // answers that lack it cannot create it — on a two-storey frame the
  // "second-order" 1.2D + 1.0W + L came out 1% SMALLER than first-order.
  //
  // This is the demonstration: a portal carrying gravity and a lateral push.
  const SEC = [{ id: 1, name: 'c', E: 25, A: 1600, I: 213333, Ix: 213333, rho: 0 }];
  const nodes = [{ id: 1, x: 0, y: 0, support: 'fixed' },
                 { id: 2, x: 0, y: 3.5, support: 'none' }];
  const beams = [{ id: 1, node1: 1, node2: 2, sectionId: 1 }];
  const GRAV = [{ type: 'nodal', nodeId: 2, fy: -2000 }];
  const WIND = [{ type: 'nodal', nodeId: 2, fx: 10 }];
  const BOTH = [{ type: 'nodal', nodeId: 2, fy: -2000 }, { type: 'nodal', nodeId: 2, fx: 10 }];
  const u = (r) => (r && r.success && r.disp && r.disp[2]) ? r.disp[2].u : null;

  // Per-case P-delta, then superposed — what the old code produced.
  const pdGrav = PDeltaAnalysis.runPDelta(nodes, beams, SEC, GRAV, []);
  const pdWind = PDeltaAnalysis.runPDelta(nodes, beams, SEC, WIND, []);
  check('each case solves on its own', !!pdGrav.success && !!pdWind.success);
  const superposed = u(pdGrav) + u(pdWind);

  // The combination solved directly — what it produces now.
  const pdBoth = PDeltaAnalysis.runPDelta(nodes, beams, SEC, BOTH, []);
  check('the combination solves', !!pdBoth.success, pdBoth.error);

  // And the first-order answer to compare both against.
  const linear = solveFrame(nodes, beams, SEC, BOTH, []);
  check('the linear reference solves', !!linear.success, linear.error);

  check('superposing the cases loses the effect entirely',
        Math.abs(superposed - u(linear)) < 1e-9,
        'gravity alone produces no sway to amplify, so the sum is just first-order');
  check('solving the combination does not',
        Math.abs(u(pdBoth)) > Math.abs(u(linear)),
        `${(u(pdBoth) * 1000).toFixed(4)} mm vs ${(u(linear) * 1000).toFixed(4)} mm`);
  check('which is the whole difference between the two approaches',
        Math.abs(u(pdBoth)) > Math.abs(superposed));

  // The amplification is the one theory predicts for this column.
  const EI  = 25e6 * 213333 / 1e8;
  const Pcr = Math.PI * Math.PI * EI / Math.pow(2 * 3.5, 2);
  near('and matches 1/(1 - P/Pcr)', u(pdBoth) / u(linear), 1 / (1 - 2000 / Pcr), 0.01);
}

group('Combination factors scale forces and nothing else');
{
  // factoredLoadsFor() gathers each case's loads scaled by that case's factor.
  // Only the force-carrying fields scale: `pos` is a position along the
  // member and the ids say what the load acts on, so scaling either would
  // move the load rather than change it.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  check('the helper exists', /function factoredLoadsFor\(combo\)/.test(app));

  const keys = (app.match(/const LOAD_FORCE_KEYS = \[([^\]]*)\]/) || [])[1] || '';
  ['fx', 'fy', 'fz', 'fx2', 'fy2', 'm', 'mx', 'my', 'mz'].forEach(k =>
    check(`${k} is scaled`, keys.includes(`'${k}'`), keys));
  check('pos is not scaled', !/'pos'/.test(keys),
        'it is a position ratio, not a force');
  check('and neither are the ids',
        !/'id'|'caseId'|'nodeId'|'elementId'/.test(keys));

  // Each combination is solved rather than superposed, and a failure is
  // reported rather than quietly replaced by a first-order answer.
  // Comments stripped: the note explaining what this used to do necessarily
  // names combineCaseResults, and a check that trips on its own explanation
  // tests nothing.
  const fn = app.slice(app.indexOf('function solvePDeltaAll()'),
                       app.indexOf('function solvePDeltaAll()') + 3800)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^[ 	]*\/\/.*$/gm, '');
  check('combinations go to the P-delta solver',
        /factoredLoadsFor\(cb\)/.test(fn) && /runPDelta\(nodes, beams, sections, cLoads/.test(fn));
  check('they are no longer superposed from case results',
        !/combineCaseResults\(cb\)/.test(fn),
        'superposition of a nonlinear analysis is the bug');
  check('a combination that fails to converge is reported',
        /did not converge/.test(fn));
  check('and is not silently replaced by a linear result',
        !/fallback|combineCaseResults/.test(fn));

  // The scaling rule itself.
  const scale = (l, f) => {
    const c = { ...l };
    ['fx', 'fy', 'fz', 'fx2', 'fy2', 'm', 'mx', 'my', 'mz']
      .forEach(k => { if (typeof c[k] === 'number') c[k] = c[k] * f; });
    return c;
  };
  const dl = { id: 1, type: 'beam_dist', elementId: 7, fy: -8.33, caseId: 3 };
  near('a dead load at 1.2 becomes 9.996', scale(dl, 1.2).fy, -9.996, 1e-9);
  check('its target is untouched', scale(dl, 1.2).elementId === 7);
  const pt = { id: 2, type: 'beam_point', elementId: 7, fy: -50, pos: 0.5 };
  near('a point load scales', scale(pt, 1.6).fy, -80, 1e-9);
  near('but its position does not', scale(pt, 1.6).pos, 0.5, 1e-12);
}

group('Every display control drives something the renderer reads');
{
  // The Views dialog offers fifteen checkboxes and three sliders. Each has to
  // reach a flag that render() consults, or it is a switch wired to nothing —
  // the failure this audit found repeatedly elsewhere (section modifiers, the
  // rebar layout, Poisson's ratio).
  //
  // Verified in the browser by toggling each flag and diffing the canvas:
  // all of them change what is drawn. This pins the wiring so a control
  // cannot become orphaned without the suite saying so.
  const app  = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // dialog id -> the views flag it sets
  const WIRING = {
    'view-bmd': 'bmd', 'view-sfd': 'sfd', 'view-nfd': 'nfd',
    'view-defl': 'defl', 'view-react': 'react', 'view-vals': 'vals',
    'view-fill': 'fill', 'view-peaks': 'peaks', 'view-stress': 'stress',
    'view-energy': 'energy', 'view-lengths': 'lengths', 'view-local': 'local',
    'view-drift': 'drift', 'view-scale': 'scale', 'view-defl-sc': 'deflScale',
    'view-color-by': 'colorBy'
  };

  Object.keys(WIRING).forEach(id =>
    check(`${id} exists in the dialog`, html.includes('id="' + id + '"')));

  // Each flag must be read by the renderer, not merely written by the dialog.
  Object.entries(WIRING).forEach(([id, flag]) => {
    const re = new RegExp('views\\.' + flag + '\\b');
    check(`views.${flag} is read when drawing`, re.test(app),
          `${id} would be a control wired to nothing`);
  });

  // And the dialog has to write them back, or Apply does nothing.
  Object.keys(WIRING).forEach(id =>
    check(`${id} is read back on Apply`, app.includes("'" + id + "'"),
          'the Apply handler lives in app.js'));

  // The defaults the app ships with, so a change of mind here is deliberate.
  const defs = app.slice(app.indexOf('let views'), app.indexOf('let views') + 700);
  check('BMD is on by default',       /bmd:\s*true/.test(defs));
  check('reactions are on',           /react:\s*true/.test(defs));
  check('station values are on',      /vals:\s*true/.test(defs));
  check('SFD and NFD are off',        /sfd:\s*false/.test(defs) && /nfd:\s*false/.test(defs));
  check('stress and energy are off',  /stress:\s*false/.test(defs) && /energy:\s*false/.test(defs));

  // "Peak value flags" only draws while station values are hidden: with vals
  // on, toggling peaks leaves the canvas byte-identical (24 numeric labels
  // either way); with vals off it adds the two span peaks. Both ship on, so
  // the control is inert in the default configuration. Recorded rather than
  // changed — the numbers are right, the checkbox is just redundant there.
  check('the peak flag is still drawn somewhere',
        /views\.peaks !== false/.test(app),
        'if this goes, the control is dead outright rather than redundant');
}

group('Show / Hide toggles must hide what they name');
{
  // View > Show / Hide offers Grid, Labels, Loads and Supports. VIEW_CTL set
  // views.loads and views.supports, neither of which was declared on `views`
  // or read by the renderer — so the arrows and the support glyphs stayed on
  // the canvas while a toast announced "Loads: OFF". A control that reports a
  // state it did not produce is worse than one that does nothing quietly.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  const defs = app.slice(app.indexOf('let views = {'), app.indexOf('let views = {') + 1200);
  check('views declares loads',    /loads:\s*true/.test(defs));
  check('and declares supports',   /supports:\s*true/.test(defs));

  // The draw functions have to consult them.
  const dl = app.slice(app.indexOf('function drawLoads()'),
                       app.indexOf('function drawLoads()') + 700);
  const ds = app.slice(app.indexOf('function drawSupports()'),
                       app.indexOf('function drawSupports()') + 700);
  check('drawLoads honours the flag',    /views\.loads === false/.test(dl));
  check('drawSupports honours the flag', /views\.supports === false/.test(ds));

  // `!== false`, not truthiness: a model saved before the flags existed has
  // neither key and must still draw both.
  check('an older model with no flag still draws loads',
        !/if \(!views\.loads\)/.test(dl));
  check('and still draws supports',
        !/if \(!views\.supports\)/.test(ds));

  // Both toggles exist and write the flags they claim to.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('toggleLoads writes views.loads',       /toggleLoads[\s\S]{0,200}views\.loads/.test(html));
  check('toggleSupports writes views.supports', /toggleSupports[\s\S]{0,200}views\.supports/.test(html));
}

group('Member classification follows the configured thresholds');
{
  // Settings offered "Column angle" and "Beam angle" and getMemberType()
  // hardcoded 70 and 20, so moving either changed nothing. Member type is not
  // cosmetic: it picks the C / B / BR label, the colour, the per-type ACI
  // stiffness modifiers, and whether a member gets column or beam checks.
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const fn  = app.slice(app.indexOf('function getMemberType(bm)'),
                        app.indexOf('function getMemberType(bm)') + 1100);

  check('the classifier reads the configured column angle', /cfg\.colAngle/.test(fn));
  check('and the configured beam angle',                    /cfg\.beamAngle/.test(fn));
  check('70 and 20 are no longer hardcoded in the test',
        !/ang >= 70/.test(fn) && !/ang <= 20/.test(fn));
  check('but remain the defaults',
        /colAngle:\s*70/.test(app) && /beamAngle:\s*20/.test(app));

  // The dialog has to load and save them or the fields are decorative again.
  check('Settings loads the current values',
        /caEl\.value = cfg\.colAngle/.test(app) && /baEl\.value = cfg\.beamAngle/.test(app));
  check('and writes them back on Apply',
        /cfg\.colAngle = ca/.test(app) && /cfg\.beamAngle = ba/.test(app));

  // A column threshold at or below the beam threshold inverts the brace band.
  check('an inverted pair is refused', /ca > 0 && ba > 0 && ca > ba/.test(app));
  check('and the user is told why',    /must be steeper than the beam/.test(app));

  // The classification rule itself, at the angles that matter.
  const classify = (ang, colA, beamA) =>
    ang >= colA ? 'column' : ang <= beamA ? 'beam' : 'brace';
  check('a vertical member is a column', classify(90, 70, 20) === 'column');
  check('a horizontal member is a beam', classify(0,  70, 20) === 'beam');
  check('a 30 degree diagonal is a brace by default',
        classify(30.3, 70, 20) === 'brace');
  check('the same diagonal is a column at a 25 degree threshold',
        classify(30.3, 25, 20) === 'column');
  check('and a beam at a 40 degree one',
        classify(30.3, 70, 40) === 'beam');
  check('the boundaries are inclusive',
        classify(70, 70, 20) === 'column' && classify(20, 70, 20) === 'beam');
}

// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);

group('The standard-view buttons highlight the view you are actually at');
{
  // The highlight tells you which named view the camera is sitting on. XZ
  // always tested BOTH angles, but YZ and ISO tested only the azimuth, so the
  // view cube's TOP-RIGHT edge (az 90, el +45) lit "YZ Side" although it is a
  // 45 degree oblique, and its FRONT-RIGHT edge (az 45, el 0) lit "Isometric"
  // although it is a flat elevation. A highlight naming a view you are not
  // looking at is worse than no highlight.
  const src = fs.readFileSync(path.join(ROOT, 'js/features/view3d.js'), 'utf8');
  const fn  = src.slice(src.indexOf('function updateBtn()'),
                        src.indexOf('function genDefault()'));

  // Lift the real classifier out of the module so the cases below run the
  // shipped rule rather than a restatement of it.
  const body = fn.slice(fn.indexOf('const el = SA.view3D.el;'),
                        fn.indexOf("['XY', 'XZ', 'YZ', 'ISO'].forEach"));
  const pick = new Function('SA',
    'let active = null;' + body.replace('let active = null;', '') + 'return active;');
  const at = (az, el) => pick({ view3D: { az, el } });

  const PI = Math.PI, ISO_EL = 0.6155;

  // The four named views must each light their own button.
  check('XZ front lights XZ',  at(0, 0) === 'XZ');
  check('YZ side lights YZ',   at(PI/2, 0) === 'YZ');
  check('XY plan lights XY',   at(0, PI/2) === 'XY');
  check('ISO lights ISO',      at(PI/4, ISO_EL) === 'ISO');

  // The view cube's other snap targets are NOT these views and must not
  // claim to be. These four are the regressions.
  check('a 45 degree oblique at az 90 is not the YZ elevation',
        at(PI/2, 0.785) !== 'YZ', `got ${at(PI/2, 0.785)}`);
  check('nor is the one below it',
        at(PI/2, -0.785) !== 'YZ', `got ${at(PI/2, -0.785)}`);
  check('a flat 45 degree azimuth is not isometric',
        at(0.785, 0) !== 'ISO', `got ${at(0.785, 0)}`);
  check('and neither is a 45 degree azimuth at 20 degrees up',
        at(0.785, 0.35) !== 'ISO', `got ${at(0.785, 0.35)}`);

  // Opposite sides of the same plane still name that plane, which is the
  // rule the XY branch already used for the view from below.
  check('BACK is the XZ plane from behind',   at(PI, 0) === 'XZ');
  check('LEFT is the YZ plane from the left', at(-PI/2, 0) === 'YZ');
  check('BOTTOM is the plan from below',      at(0, -PI/2) === 'XY');
  check('every isometric corner is isometric',
        [[PI/4, ISO_EL], [-PI/4, ISO_EL], [3*PI/4, ISO_EL], [-3*PI/4, ISO_EL],
         [PI/4, -ISO_EL], [-PI/4, -ISO_EL], [3*PI/4, -ISO_EL], [-3*PI/4, -ISO_EL]]
          .every(([a, e]) => at(a, e) === 'ISO'));

  // A wrapped azimuth is the same camera and must classify the same way.
  check('the azimuth is wrapped before it is tested',
        at(PI/2 + 2*PI, 0) === 'YZ' && at(-3*PI/2, 0) === 'YZ',
        'atan2 normalisation');

  // An ordinary orbited camera matches nothing, which is the honest answer.
  check('a camera between the standard views lights nothing',
        at(1.1, 0.4) === null, `got ${at(1.1, 0.4)}`);
}

group('Everything that means "go back to the 3D view" agrees where that is');
{
  // Four controls mean it — the Isometric button, the view cube's Home
  // button and Home key, the orbit reset button and the R key — plus the
  // camera the app enters 3D with. Two of them used el = PI/6 (30 degrees),
  // which is dimetric, not isometric, so pressing R landed somewhere the
  // button labelled "Isometric" never went.
  const app  = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const v3d  = fs.readFileSync(path.join(ROOT, 'js/features/view3d.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const gen  = fs.readFileSync(path.join(ROOT, 'js/core/generators.js'), 'utf8');

  // True isometric elevation is atan(1/sqrt(2)); 0.6155 is that to 4 places.
  near('0.6155 is the isometric elevation', Math.atan(1/Math.SQRT2), 0.6155, 5e-5);
  check('and PI/6 is not it', Math.abs(Math.PI/6 - Math.atan(1/Math.SQRT2)) > 0.09,
        'PI/6 is 30 degrees, isometric is 35.26');

  // app.js routes every default camera through one named constant.
  check('app.js names the isometric camera once',
        /const ISO_AZ = Math\.PI \/ 4, ISO_EL = 0\.6155;/.test(app));
  const sites = (app.match(/view3D = \{ az: ISO_AZ, el: ISO_EL \}/g) || []).length;
  check('and every default-camera site uses it', sites === 4, `${sites} of 4`);
  check('no camera is left at PI/6',
        !/view3D = \{ az: Math\.PI\s*\/\s*4, el: Math\.PI\s*\/\s*6 \}/.test(app),
        'the orbit reset, the R key and the 2D->3D entry all used it');

  // The other modules already agreed; this pins them so they keep agreeing.
  check('the ribbon Isometric button uses it',
        /ISO:\s*\{ az: Math\.PI \/ 4,\s*el: 0\.6155/.test(v3d));
  check('the 2D/3D toggle restores it',    /SA\.view3D\.el = 0\.6155/.test(v3d));
  check('the view cube starts at it',      /var _az=0\.7854, _el=0\.6155/.test(html));
  check('its Home button snaps to it',     /type:'home'[\s\S]{0,120}el:0\.6155/.test(html));
  check('its Home key snaps to it',        /e\.key==='Home'[\s\S]{0,120}el:0\.6155/.test(html));
  check('and the generators leave it there', /v\.el = 0\.6155/.test(gen));
}

group('The view controls describe what they actually do');
{
  const app  = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Extrusion is drawn only in 3D — render() consults mode3D before the flag.
  check('extrusion is gated on 3D', /mode3D && views\.extrude/.test(app));

  // So in 2D the toggle flipped the flag, redrew nothing and still announced
  // "3D Extrusion on". Verified in the browser: the canvas was unchanged.
  const fn = app.slice(app.indexOf('const btnExtrude = document.getElementById'),
                       app.indexOf('// Undo / Redo'));
  check('the toggle checks whether 3D is on before reporting',
        /if \(!mode3D && views\.extrude\)/.test(fn));
  check('and says the view has to change to show it',
        /switch to 3D/.test(fn));
  check('while in 3D it still reports plainly',
        /3D Extrusion \$\{views\.extrude \? 'on' : 'off'\}/.test(fn));

  // Right-drag orbits in 3D and pans in 2D — measured in the browser. The
  // hint claimed "right-click=pan" for both and never mentioned orbit at all,
  // which is the primary 3D interaction.
  const hint = (html.match(/Canvas: scroll=zoom[^<]*/) || [''])[0];
  check('the canvas hint exists', hint.length > 20, hint);
  check('it no longer calls right-drag a pan outright',
        !/right-click=pan/.test(hint), hint);
  check('it names orbit',   /orbit/i.test(hint), hint);
  check('and still names zoom and pan', /zoom/.test(hint) && /pan/.test(hint), hint);
}


group('Split and Copy carry everything that makes a member behave as it does');
{
  // A member carries more than its endpoints: stiffness modifiers the solver
  // applies, effective-length factors and an unbraced length the design
  // checks read, and a column/beam/brace override. Split and Copy carried
  // only sectionId and the two hinges, so both quietly produced members that
  // analyse and check differently from the one they came from. Verified in
  // the browser: splitting a member with fi3 = 0.35 gave back three segments
  // with modifiers = null, Ky/Kz/Lcr = null and memberType reset to 'auto'.
  const sel = fs.readFileSync(path.join(ROOT, 'js/core/selection.js'), 'utf8');

  const list = (sel.match(/const MEMBER_PROPS = \[([^\]]*)\]/) || [])[1] || '';
  ['modifiers', 'Ky', 'Kz', 'Lcr', 'memberType'].forEach(k =>
    check(`${k} is carried`, list.includes(`'${k}'`), list));
  check('the member name is not carried', !/'name'/.test(list),
        'a name identifies one member; a copy is a different member');

  // Both operations must actually call the helper.
  const cp = sel.slice(sel.indexOf('function copySelection'), sel.indexOf('// ── Rotate'));
  const sp = sel.slice(sel.indexOf('function splitBeam'), sel.indexOf('function insertNodeMidpoint'));
  check('Copy carries them',  /carryMemberProps\(bm, nb\)/.test(cp));
  check('Split carries them', /carryMemberProps\(srcProps, nb\)/.test(sp));
  check('Split snapshots them before the member is deleted',
        sp.indexOf('const srcProps') < sp.indexOf('app.deleteBeam'),
        'deleteBeam takes the member out of the array');

  // modifiers is an object: each member needs its own or they alias.
  check('modifiers is copied, not shared by reference',
        /\{ \.\.\.v \}/.test(sel),
        'three sub-beams sharing one modifiers object would move together');
  const helper = sel.slice(sel.indexOf('function carryMemberProps'),
                           sel.indexOf('function copySelection'));
  check('an absent property is left absent',
        /v === undefined \|\| v === null/.test(helper),
        'writing undefined would mask a section-level default');

  // ── What it costs when they are lost ────────────────────────────
  // Simply supported 6 m beam under 20 kN/m, split into three. The middle
  // node's deflection is the check: with the cracked-section factor carried
  // it is the same structure, without it the model is 1/0.35 stiffer.
  const SEC = [{ id: 1, name: 'B', E: 25, A: 1800, I: 540000, Ix: 540000, rho: 0 }];
  const build = (mods) => {
    const nodes = [], beams = [], loads = [];
    for (let i = 0; i <= 3; i++)
      nodes.push({ id: i+1, x: 2*i, y: 0,
                   support: i === 0 ? 'pin' : (i === 3 ? 'roller' : 'none') });
    for (let i = 0; i < 3; i++) {
      const b = { id: i+1, node1: i+1, node2: i+2, sectionId: 1 };
      if (mods) b.modifiers = mods;
      beams.push(b);
      loads.push({ type: 'beam_dist', elementId: i+1, fy: -20 });
    }
    return solveFrame(nodes, beams, SEC, loads, []);
  };
  const kept    = build({ fi3: 0.35 });
  const dropped = build(null);
  check('both solve', !!kept.success && !!dropped.success);

  // v at the 1/3 point of a simply supported UDL span: w.x.(L^3 - 2.L.x^2 + x^3)/(24.EI)
  const EI = 25e6 * 540000e-8;
  const d13 = (ei) => -20 * 2 * (Math.pow(6,3) - 2*6*4 + 8) / (24 * ei);
  near('the carried modifier gives the cracked-section deflection',
       kept.disp[2].v, d13(EI * 0.35), 1e-6);
  near('dropping it gives the uncracked one',
       dropped.disp[2].v, d13(EI), 1e-6);
  near('which is stiffer by exactly 1/0.35',
       kept.disp[2].v / dropped.disp[2].v, 1/0.35, 1e-6);
  check('so a dropped modifier understates deflection by about 65%',
        Math.abs(1 - dropped.disp[2].v / kept.disp[2].v) > 0.6,
        `${((1 - dropped.disp[2].v/kept.disp[2].v)*100).toFixed(1)}%`);
}

group('Merging nodes does not silently delete applied load');
{
  // Duplicate and zero-length members are spliced out of the beams array
  // directly rather than through deleteBeam(), which is what normally deals
  // with a member's loads. Their loads were left pointing at an element id
  // that no longer existed — the solver finds no such member and ignores
  // them, while they stay in the model, the load table and the saved file.
  // Reproduced in the browser: a 99 kN/m line load survived its member.
  const sel = fs.readFileSync(path.join(ROOT, 'js/core/selection.js'), 'utf8');
  const fn  = sel.slice(sel.indexOf('function mergeCoincidentNodes'),
                        sel.indexOf('// ── Align Nodes'));

  check('the dropped members are tracked', /const reassign = new Map\(\)/.test(fn));
  check('and so are the ones that collapsed to a point', /const zeroLen  = new Set\(\)/.test(fn));
  check('a duplicate\'s load moves to the member that replaced it',
        /ld\.elementId = reassign\.get\(ld\.elementId\)/.test(fn));
  check('rather than being deleted',
        !/if \(droppedBeams\.has\(ld\.elementId\)\) \{ orphaned\+\+; return false/.test(fn),
        'dropping applied load understates demand, and leaves no trace');
  check('the user is told to look for doubled-up loads',
        /doubled-up loads/.test(fn));
  check('a load whose member collapsed to zero length is removed',
        /zeroLen\.has\(ld\.elementId\)/.test(fn) && /return false/.test(fn));
  check('and that removal is reported too',
        /collapsed to zero length/.test(fn));

  // Run the REAL function, not a restatement of it. The first version of this
  // group checked the source with regexes and re-implemented the rule beside
  // it; every check passed while the shipped code threw "seen.set is not a
  // function" on the first click and merged nothing at all. A test that only
  // reads the source cannot see that. selection.js touches no DOM — it goes
  // through the `app` object — so it runs under Node against a stub.
  const edCtx = { console, Math, JSON, Object, Array, Set, Map, Number, isFinite };
  edCtx.window = edCtx;
  vm.createContext(edCtx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/core/selection.js'), 'utf8'),
                  edCtx, { filename: 'js/core/selection.js' });
  const AppEdit = edCtx.AppEdit;
  check('the edit module loads', !!(AppEdit && AppEdit.mergeCoincidentNodes));

  const toasts = [];
  const app = {
    // Two nodes 10 mm apart, plus a third that the pair both connect to.
    nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 6, y: 0 }, { id: 3, x: 0.01, y: 0 }],
    beams: [{ id: 1, node1: 1, node2: 2 }, { id: 2, node1: 3, node2: 2 }],
    loads: [{ id: 1, elementId: 1, fy: -10 }, { id: 2, elementId: 2, fy: -99 },
            { id: 3, nodeId: 2, fy: -2 }],
    settlements: [], multiSel: { nodes: new Set(), beams: new Set() },
    selNode: null, selBeam: null, results: {},
    findNode(id) { return this.nodes.find(n => n.id === id); },
    findBeam(id) { return this.beams.find(b => b.id === id); },
    snapshot() {}, updateNodeTable() {}, updateBeamTable() {}, render() {},
    toast(m, k) { toasts.push(`${k}: ${m}`); }
  };
  edCtx.SA = app;

  AppEdit.mergeCoincidentNodes(0.05);

  check('it ran without throwing', toasts.length > 0, JSON.stringify(toasts));
  check('the coincident node is gone', app.nodes.length === 2, JSON.stringify(app.nodes));
  check('and so is the duplicate member', app.beams.length === 1, JSON.stringify(app.beams));

  const live = new Set(app.beams.map(b => b.id));
  check('no member load points at a member that is gone',
        app.loads.every(l => l.elementId == null || live.has(l.elementId)),
        JSON.stringify(app.loads));
  check("the duplicate's 99 kN/m load survived, on the surviving member",
        app.loads.some(l => l.fy === -99 && l.elementId === app.beams[0].id),
        JSON.stringify(app.loads));
  check('the original load is still there too',
        app.loads.some(l => l.fy === -10 && l.elementId === app.beams[0].id));
  check('and the nodal load is untouched', app.loads.some(l => l.nodeId === 2));
  check('the user is warned to check for doubled-up loads',
        toasts.some(t => /doubled-up/.test(t)), JSON.stringify(toasts));

  // A member whose two ends merge onto one node has no length and no
  // survivor, so its load has nothing left to act on.
  const t2 = [];
  const app2 = {
    nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 0.01, y: 0 }],
    beams: [{ id: 1, node1: 1, node2: 2 }],
    loads: [{ id: 1, elementId: 1, fy: -5 }],
    settlements: [], multiSel: { nodes: new Set(), beams: new Set() },
    selNode: null, selBeam: null, results: {},
    findNode(id) { return this.nodes.find(n => n.id === id); },
    findBeam(id) { return this.beams.find(b => b.id === id); },
    snapshot() {}, updateNodeTable() {}, updateBeamTable() {}, render() {},
    toast(m, k) { t2.push(`${k}: ${m}`); }
  };
  edCtx.SA = app2;
  AppEdit.mergeCoincidentNodes(0.05);
  check('a member collapsed to a point is removed', app2.beams.length === 0);
  check('and its load goes with it, reported', app2.loads.length === 0 &&
        t2.some(t => /zero length/.test(t)), JSON.stringify(t2));

  // The guard that stopped a missing tolerance collapsing the whole model.
  const t3 = [];
  const app3 = {
    nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 6, y: 0 }, { id: 3, x: 12, y: 0 }],
    beams: [{ id: 1, node1: 1, node2: 2 }, { id: 2, node1: 2, node2: 3 }],
    loads: [], settlements: [], multiSel: { nodes: new Set(), beams: new Set() },
    selNode: null, selBeam: null, results: {},
    findNode(id) { return this.nodes.find(n => n.id === id); },
    findBeam(id) { return this.beams.find(b => b.id === id); },
    snapshot() {}, updateNodeTable() {}, updateBeamTable() {}, render() {},
    toast(m, k) { t3.push(`${k}: ${m}`); }
  };
  edCtx.SA = app3;
  AppEdit.mergeCoincidentNodes();          // no tolerance at all
  check('a call with no tolerance does not collapse the model',
        app3.nodes.length === 3 && app3.beams.length === 2, JSON.stringify(app3.nodes));
}

group('Mirror H and Mirror V say which way they flip');
{
  // mirror-h flips Y (top to bottom) and mirror-v flips X (left to right) —
  // measured in the browser on nodes at (0,0) and (6,3.5). Both buttons were
  // labelled the other way round: "Mirror horizontally" with a left-right
  // arrow on the one that moves things up and down, and the reverse on its
  // partner. The behaviour is the CAD convention (H names the mirror axis,
  // not the direction of travel); only the wording and the icons were wrong.
  const sel  = fs.readFileSync(path.join(ROOT, 'js/core/selection.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const fn = sel.slice(sel.indexOf('function mirrorSelection'),
                       sel.indexOf('// ── Split Beam'));
  check("'H' flips Y", /axis === 'H'\) nd\.y = 2 \* cy - nd\.y/.test(fn));
  check("and 'V' flips X", /else\s+nd\.x = 2 \* cx - nd\.x/.test(fn));

  // Each button's own markup must name the axis and the motion consistently.
  const btn = (id) => (html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[^<]*`)) || [''])[0];
  const h = btn('btn-mirror-h'), v = btn('btn-mirror-v');
  check('the H button exists', h.length > 10);
  check('H says it mirrors about the horizontal axis', /horizontal axis/.test(h), h);
  check('and that the selection flips top to bottom',  /top ↔ bottom/.test(h), h);
  check('V says it mirrors about the vertical axis',   /vertical axis/.test(v), v);
  check('and that the selection flips left to right',  /left ↔ right/.test(v), v);

  // The arrows have to show the motion, not contradict it.
  check('H carries the up-down arrow',    /&#8597;/.test(h), h);
  check('V carries the left-right arrow', /&#8596;/.test(v), v);
  // Strip HTML comments first: the note explaining this fix quotes the old
  // wording, and matching that would be matching the explanation, not the UI.
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  check('neither still claims the old direction',
        !/Mirror horizontally/.test(htmlNoComments) &&
        !/Mirror vertically/.test(htmlNoComments));

  // The ribbon duplicates these buttons and had the same two icons swapped.
  const ribH = (html.match(/<button[^>]*btn-mirror-h[^>]*>\s*<span class="rib-icon">(.)</) || [])[1];
  const ribV = (html.match(/<button[^>]*btn-mirror-v[^>]*>\s*<span class="rib-icon">(.)</) || [])[1];
  check('the ribbon H icon points up and down',    ribH === '⇕', ribH);
  check('the ribbon V icon points left and right', ribV === '⇔', ribV);

  // And the toast must not go back to the directional wording.
  check('the toast names the axis', /about the \$\{axis === 'H' \? 'horizontal' : 'vertical'\}/.test(fn));
  check('and the motion',           /top ↔ bottom.*left ↔ right/.test(fn));
}


group('Grid System — naming, selection and persistence');
{
  // GRIDSYS lives inline in index.html and drives the ETABS-style named grid
  // lines. It is run here rather than read, because the last round of this
  // audit shipped a Set-used-as-a-Map that every source-regex check waved
  // through. It touches the DOM only through getElementById, so a handful of
  // stubs is enough to execute the real module.
  const src  = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const at   = src.indexOf('window.GRIDSYS = (function(){');
  const end  = src.indexOf('\n})();', at);
  check('the module was found in the page', at > 0 && end > at);
  const modSrc = src.slice(at, end + 6);

  const noop = () => {};
  const ctx2d = new Proxy({}, { get: () => noop, set: () => true });
  const els = {};
  const mkEl = (id) => ({
    id, value: '', innerHTML: '', checked: false, width: 300, height: 200,
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    getContext: () => ctx2d, appendChild: noop, addEventListener: noop
  });
  const store = new Map();
  // loadSaved() is private to the module and runs only on the window `load`
  // event, so the stub captures that handler the way a browser would —
  // firing it is what "reload the page" means here.
  const makeCtx = (elements) => {
    const onLoad = [];
    const c = {
      console, Math, JSON, Number, String, Object, Array, Set, Map, parseInt, parseFloat,
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
      },
      CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
      document: {
        getElementById: (id) => (elements[id] || (elements[id] = mkEl(id))),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: noop, dispatchEvent: noop, createElement: mkEl
      },
      addEventListener: (ev, fn) => { if (ev === 'load') onLoad.push(fn); }
    };
    c.window = c;
    vm.createContext(c);
    vm.runInContext(modSrc, c, { filename: 'index.html#GRIDSYS' });
    return { GS: c.GRIDSYS, fireLoad: () => onLoad.forEach(f => f()) };
  };

  const first = makeCtx(els);
  const GS = first.GS;
  check('the module evaluates', !!(GS && GS.addX && GS.sortX));

  const xs   = () => GS.getGrids().xLines;
  const tags = () => xs().map(l => `${l.id}@${l.ord}`);
  const reset = () => { GS.getGrids().xLines.length = 0; GS.getGrids().yLines.length = 0; };

  // ── Names run past Z ────────────────────────────────────────────
  // String.fromCharCode(65 + n) walked straight off the alphabet: the 27th
  // grid line was named '[', the 28th '\' and the 29th ']'.
  reset();
  for (let i = 0; i < 29; i++) GS.addX();
  const names = xs().map(l => l.id);
  check('the first line is A',  names[0] === 'A');
  check('the 26th is Z',        names[25] === 'Z');
  check('the 27th is AA',       names[26] === 'AA', names[26]);
  check('then AB and AC',       names[27] === 'AB' && names[28] === 'AC');
  check('no punctuation leaks in',
        names.every(n => /^[A-Z]+$/.test(n)),
        names.filter(n => !/^[A-Z]+$/.test(n)).join(' '));

  // ── Names stay unique ───────────────────────────────────────────
  // The name came from the line COUNT, so deleting B from A, B, C and adding
  // produced a second C.
  reset();
  GS.addX(); GS.addX(); GS.addX();
  check('three lines are A, B, C', xs().map(l => l.id).join(',') === 'A,B,C');
  GS.toggleSel('x', 1); GS.delX();
  check('deleting the middle leaves A, C', xs().map(l => l.id).join(',') === 'A,C');
  GS.addX();
  const after = xs().map(l => l.id);
  check('adding does not repeat a name', new Set(after).size === after.length, after.join(','));
  check('it reuses the freed name instead', after.join(',') === 'A,C,B', after.join(','));

  // ── The new line goes past the furthest one ─────────────────────
  reset();
  GS.addX(); GS.addX();
  xs()[0].ord = 100;                       // unsorted: the biggest is now first
  GS.addX();
  check('a new line clears the furthest line, not the last row',
        Math.max(...xs().map(l => l.ord)) === 106, tags().join(' '));

  // ── Sorting must carry the selection with it ────────────────────
  // The selection is a set of ROW INDICES. Sorting re-pointed it at whatever
  // landed on those rows, so select A at x = 30, press Sort, press Delete,
  // and D at x = 0 was what disappeared — the wrong grid line, silently.
  reset();
  GS.addX(); GS.addX(); GS.addX(); GS.addX();
  xs()[0].ord = 30; xs()[1].ord = 20; xs()[2].ord = 10; xs()[3].ord = 0;
  GS.toggleSel('x', 0);                    // the user picks A, at x = 30
  GS.sortX();
  check('sorting orders by ordinate', tags().join(' ') === 'D@0 C@10 B@20 A@30', tags().join(' '));
  GS.delX();
  check('and Delete removes the line that was selected',
        !tags().includes('A@30'), tags().join(' '));
  check('leaving the other three alone',
        tags().join(' ') === 'D@0 C@10 B@20', tags().join(' '));

  // Sorting an empty selection must not invent one.
  reset(); GS.addX(); GS.addX();
  xs()[0].ord = 9; xs()[1].ord = 1;
  GS.sortX(); GS.delX();
  check('a sort with nothing selected deletes nothing', xs().length === 2, tags().join(' '));

  // ── An applied grid survives a reload ───────────────────────────
  // app.js refuses to draw named grids unless isApplied() is true, and
  // loadSaved() restored the lines without restoring that flag. A grid the
  // user had applied came back into the dialog and the preview while the
  // canvas quietly reverted to the plain background grid.
  reset();
  GS.addX(); GS.addX();
  GS.apply();
  check('applying marks the grid applied', GS.isApplied() === true);
  check('and writes it to storage', !!store.get('sa_grids_v1'));
  const saved = JSON.parse(store.get('sa_grids_v1'));
  check('what is stored has the lines', saved.xLines.length === 2);

  // Re-evaluate the module against the same storage: that is a page reload.
  const second = makeCtx({});
  check('a fresh load starts unapplied', second.GS.isApplied() === false,
        'nothing has been restored yet');
  second.fireLoad();
  check('the saved lines come back', second.GS.getGrids().xLines.length === 2);
  check('and the grid is applied again, so the canvas keeps drawing it',
        second.GS.isApplied() === true,
        'this is what made an applied grid vanish on reload');

  // An empty saved grid must not claim to be applied.
  store.set('sa_grids_v1', JSON.stringify({ xLines: [], yLines: [] }));
  const third = makeCtx({});
  third.fireLoad();
  check('an empty saved grid stays unapplied', third.GS.isApplied() === false);
  store.delete('sa_grids_v1');

  // ── Quick Start ─────────────────────────────────────────────────
  // The fields are labelled "X bays"/"Y bays", so n bays is n+1 grid lines.
  els['gs-qx-n'] = mkEl('gs-qx-n'); els['gs-qx-n'].value = '3';
  els['gs-qx-s'] = mkEl('gs-qx-s'); els['gs-qx-s'].value = '6';
  els['gs-qy-n'] = mkEl('gs-qy-n'); els['gs-qy-n'].value = '2';
  els['gs-qy-s'] = mkEl('gs-qy-s'); els['gs-qy-s'].value = '4';
  GS.quickStart();
  check('3 X bays give 4 grid lines', tags().join(' ') === 'A@0 B@6 C@12 D@18', tags().join(' '));
  check('2 Y bays give 3',
        GS.getGrids().yLines.map(l => `${l.id}@${l.ord}`).join(' ') === '1@0 2@4 3@8');
  check('Quick Start clears any previous selection',
        (GS.delX(), xs().length === 4), tags().join(' '));

  // 27 bays would have run off the alphabet here too.
  els['gs-qx-n'].value = '30';
  GS.quickStart();
  check('Quick Start names stay alphabetic past Z',
        xs().every(l => /^[A-Z]+$/.test(l.id)) && xs()[26].id === 'AA',
        xs().slice(25, 29).map(l => l.id).join(','));
}


group('Seismic site coefficients follow ASCE 7-16, not one value per site class');
{
  // Fa and Fv depend on the site class AND the mapped acceleration. The site
  // dropdown carried one hardcoded pair per class — "D (Fa=1.6, Fv=2.4)" —
  // which are the values at the BOTTOM of Tables 11.4-1 and 11.4-2, for
  // Ss <= 0.25 and S1 <= 0.1. At the accelerations the calculator ships with
  // they are badly off: Site D at Ss = 1.0 takes Fa = 1.1, not 1.6, so SDS
  // came out 45% high. Everything downstream — base shear, drift limits, the
  // seismic design category — is computed from SDS and SD1.
  //
  // The shipped code runs here, not a restatement of it.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const from = html.indexOf('  const SITE_FA = {');
  const to   = html.indexOf('  // ── Ch.13');
  check('the seismic block was found', from > 0 && to > from);

  const noop = () => {};
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, value: '', innerHTML: '' }));
  const sCtx = { console, Math, Number, String, Object, parseFloat, parseInt,
                 document: { getElementById: el } };
  vm.createContext(sCtx);
  vm.runInContext(html.slice(from, to) + '\n;this.__ch12 = ch12;', sCtx,
                  { filename: 'index.html#ch12' });
  const ch12 = sCtx.__ch12;
  check('ch12 evaluates', !!(ch12 && ch12.spectra && ch12.baseShear));

  const spectra = (cls, Ss, S1) => {
    el('eq-ss').value = String(Ss); el('eq-s1').value = String(S1);
    el('eq-site').value = cls;
    ch12.spectra();
    const t = el('eq-result').innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
    return { Fa: +(t.match(/Fa = ([\d.]+)/) || [])[1],
             Fv: +(t.match(/Fv = ([\d.]+)/) || [])[1],
             SDS: +(t.match(/SDS = ([\d.]+)/) || [])[1],
             SD1: +(t.match(/SD1 = ([\d.]+)/) || [])[1],
             siteSpecific: /11\.4\.8|20\.3\.1/.test(t), text: t };
  };

  // ── Table 11.4-1 (Fa) at its anchors ────────────────────────────
  const FA = {
    A: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
    B: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    C: [1.3, 1.3, 1.2, 1.2, 1.2, 1.2],
    D: [1.6, 1.4, 1.2, 1.1, 1.0, 1.0],
    E: [2.4, 1.7, 1.3, 1.1, 1.0, 0.8]
  };
  const SS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
  const badFa = [];
  Object.entries(FA).forEach(([cls, row]) => row.forEach((want, i) => {
    const got = spectra(cls, SS[i], 0.1).Fa;
    if (Math.abs(got - want) > 1e-9) badFa.push(`${cls}@Ss=${SS[i]}: ${got} want ${want}`);
  }));
  check('every Fa anchor in Table 11.4-1 matches', badFa.length === 0, badFa.slice(0, 4).join('; '));

  // ── Table 11.4-2 (Fv) at its anchors ────────────────────────────
  const FV = {
    A: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
    B: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
    C: [1.5, 1.5, 1.5, 1.5, 1.5, 1.4],
    D: [2.4, 2.2, 2.0, 1.9, 1.8, 1.7],
    E: [4.2, 3.3, 2.8, 2.4, 2.2, 2.0]
  };
  const S1S = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const badFv = [];
  Object.entries(FV).forEach(([cls, row]) => row.forEach((want, i) => {
    const got = spectra(cls, 0.25, S1S[i]).Fv;
    if (Math.abs(got - want) > 1e-9) badFv.push(`${cls}@S1=${S1S[i]}: ${got} want ${want}`);
  }));
  check('every Fv anchor in Table 11.4-2 matches', badFv.length === 0, badFv.slice(0, 4).join('; '));

  // ── Straight-line interpolation between anchors ─────────────────
  near('Site D halfway between Ss = 0.75 and 1.0 gives Fa = 1.15',
       spectra('D', 0.875, 0.1).Fa, 1.15, 1e-9);
  near('and a quarter of the way gives 1.175',
       spectra('D', 0.8125, 0.1).Fa, 1.175, 1e-9);
  near('Site D halfway between S1 = 0.3 and 0.4 gives Fv = 1.95',
       spectra('D', 0.25, 0.35).Fv, 1.95, 1e-9);

  // ── Clamped outside the tables ──────────────────────────────────
  near('below the first anchor holds the first value',
       spectra('D', 0.05, 0.02).Fa, 1.6, 1e-9);
  near('above the last holds the last',  spectra('D', 3.0, 0.1).Fa, 1.0, 1e-9);
  near('and the same for Fv',            spectra('D', 0.25, 1.2).Fv, 1.7, 1e-9);

  // ── The defect itself ───────────────────────────────────────────
  const d10 = spectra('D', 1.0, 0.1);
  near('Site D at Ss = 1.0 now takes Fa = 1.1', d10.Fa, 1.1, 1e-9);
  near('so SDS is 2/3 x 1.1 x 1.0', d10.SDS, +(2/3 * 1.1).toFixed(3), 2e-3);
  check('the old hardcoded Fa = 1.6 would have been 45% high',
        Math.abs((2/3 * 1.6 * 1.0) / d10.SDS - 1.4545) < 0.01,
        `${(2/3*1.6).toFixed(3)} vs ${d10.SDS}`);

  // ── §11.4.8 is declared where the tables are shaded ─────────────
  check('Site D with S1 >= 0.2 is flagged',  spectra('D', 0.5, 0.2).siteSpecific);
  check('Site D with S1 < 0.2 is not',      !spectra('D', 0.5, 0.1).siteSpecific);
  check('Site E with S1 >= 0.1 is flagged',  spectra('E', 0.5, 0.1).siteSpecific);
  check('Site E with Ss >= 1.0 is flagged',  spectra('E', 1.0, 0.05).siteSpecific);
  check('Site C is not flagged',            !spectra('C', 1.5, 0.6).siteSpecific);
  const f = spectra('F', 1.0, 0.4);
  check('Site F refuses to tabulate at all',
        /20\.3\.1/.test(f.text) && !Number.isFinite(f.SDS), f.text.slice(0, 80));

  // The dropdown must no longer carry baked-in coefficients.
  const opts = (html.match(/<select id="eq-site"[\s\S]*?<\/select>/) || [''])[0];
  check('the site dropdown carries plain classes', /value="D"/.test(opts), opts.slice(0, 120));
  check('and no hardcoded Fa/Fv pairs', !/value="1\.6_2\.4"/.test(opts));
  check('Site F is offered', /value="F"/.test(opts));
}

group('Base shear applies the Eq. 12.8-6 floor');
{
  // ASCE 7-16 Eq. 12.8-6 sets a minimum Cs of 0.5.S1/(R/Ie) wherever
  // S1 >= 0.6g. It was missing, and it is a FLOOR, so leaving it out
  // understates the base shear — the unconservative direction. For an
  // ordinary RC moment frame (R = 3) at S1 = 0.9 it is 2.8x the Eq. 12.8-5
  // minimum that was being applied.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const from = html.indexOf('  const SITE_FA = {');
  const to   = html.indexOf('  // ── Ch.13');
  const els  = {};
  const el   = (id) => (els[id] || (els[id] = { id, value: '', innerHTML: '' }));
  const sCtx = { console, Math, Number, String, Object, parseFloat, parseInt,
                 document: { getElementById: el } };
  vm.createContext(sCtx);
  vm.runInContext(html.slice(from, to) + '\n;this.__ch12 = ch12;', sCtx,
                  { filename: 'index.html#ch12' });
  const ch12 = sCtx.__ch12;

  const V = (SDS, SD1, S1, T, R, Ie, W) => {
    el('eqv-sds').value = String(SDS); el('eqv-sd1').value = String(SD1);
    el('eqv-s1').value  = String(S1);  el('eqv-t').value   = String(T);
    el('eqv-r').value   = String(R);   el('eqv-ie').value  = String(Ie);
    el('eqv-w').value   = String(W);
    ch12.baseShear();
    const t = el('eqv-result').innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<');
    return { Cs: +(t.match(/Cs = ([\d.]+)\s+— governed/) || [])[1],
             V:  +(t.match(/V = Cs · W = ([\d.]+)/) || [])[1],
             by: (t.match(/governed by ([^<]+?)\s{2,}/) || t.match(/governed by (.+)/) || [])[1],
             text: t };
  };
  // Independent restatement of ASCE 7-16 §12.8.1.1.
  const want = (SDS, SD1, S1, T, R, Ie) => {
    const c1 = SDS / (R / Ie), c2 = SD1 / (T * R / Ie);
    const c5 = Math.max(0.044 * SDS * Ie, 0.01);
    const c6 = S1 >= 0.6 ? 0.5 * S1 / (R / Ie) : 0;
    return Math.max(Math.min(c1, c2), Math.max(c5, c6));
  };

  const CASES = [
    [1.2, 0.56, 0.9, 3.0, 3, 1.0, 10000],   // 12.8-6 governs hardest
    [1.2, 0.56, 0.6, 2.0, 5, 1.0, 10000],
    [1.0, 0.60, 0.75, 1.0, 5, 1.5, 10000],
    [0.733, 0.507, 0.4, 0.5, 8, 1.0, 10000], // below the S1 threshold
    [1.0, 0.56, 0.3, 0.3, 8, 1.0, 10000],    // 12.8-2 governs
    [0.3, 0.12, 0.1, 2.0, 8, 1.0, 10000],    // 12.8-5 floor governs
  ];
  CASES.forEach(([SDS, SD1, S1, T, R, Ie, W]) => {
    const got = V(SDS, SD1, S1, T, R, Ie, W);
    near(`Cs for R=${R}, S1=${S1}, T=${T}, Ie=${Ie}`, got.Cs, +want(SDS, SD1, S1, T, R, Ie).toFixed(4), 1e-4);
    near(`and V = Cs.W`, got.V, +(want(SDS, SD1, S1, T, R, Ie) * W).toFixed(1), 0.2);
  });

  // The floor applies only at or above 0.6g, and it is a floor, not a cap.
  const hi = V(1.2, 0.56, 0.9, 3.0, 3, 1.0, 10000);
  const lo = V(1.2, 0.56, 0.59, 3.0, 3, 1.0, 10000);
  near('at S1 = 0.9 the Eq. 12.8-6 floor governs', hi.Cs, 0.15, 1e-4);
  check('and is named as the governing equation', /12\.8-6/.test(hi.by || hi.text), hi.by);
  check('just below 0.6g it does not apply', /does not apply/.test(lo.text), lo.text.slice(0, 90));
  check('so Cs drops back to the old value', lo.Cs < hi.Cs, `${lo.Cs} vs ${hi.Cs}`);
  near('which is what was being used before', lo.Cs, 0.0622, 1e-3);
  check('the floor raises the answer by 2.4x in that case',
        hi.Cs / lo.Cs > 2.3, `${(hi.Cs / lo.Cs).toFixed(2)}x`);

  // The long-period cap is not implemented; omitting it is conservative, and
  // the calculator has to say so rather than look complete.
  check('the missing Eq. 12.8-4 cap is disclosed',
        /12\.8-4/.test(hi.text) && /conservative/.test(hi.text));
}


group('Generated frames are planar, bracing included');
{
  // The Home ribbon's Generate menu builds ten template structures. The
  // braced frame lifted its nodes into the XZ plane from a hand-written list
  // of the GRID nodes, which missed the apex node that K and V bracing add to
  // each panel. Those were left at y = elevation, z = 0 while the frame around
  // them moved to y = 0, z = elevation: on a 2-bay x 3-storey frame the apexes
  // stood 7.5 m out of the plane of a 9 m frame. The braces ran sideways out
  // of the structure, so the thing generated was not a braced frame at all.
  //
  // generators.js reaches the DOM only through #btn-3d, so the shipped module
  // runs here against a stub.
  const noop = () => {};
  const gCtx = { console, Math, Number, String, Object, Array, Set, Map, JSON,
                 // enable3D() defers its camera work; the geometry is already
                 // final by then, so the stub simply does not run it.
                 setTimeout: noop, clearTimeout: noop,
                 document: { getElementById: (id) => (id === 'btn-3d' ? { click: noop } : null) } };
  gCtx.window = gCtx;
  vm.createContext(gCtx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/core/generators.js'), 'utf8'),
                  gCtx, { filename: 'js/core/generators.js' });
  const GEN = gCtx.AppGenerators;
  check('the generator module loads', !!(GEN && GEN.generateBracedFrame));

  const makeApp = () => {
    const app = {
      nodes: [], beams: [], loads: [], settlements: [], loadCases: [],
      results: null, selNode: null, selBeam: null,
      // liftToZ only runs when no 2D->3D toggle is pending, i.e. already in 3D.
      // That is the path the bug lived on.
      mode3D: true,
      nextId: { node: 1, beam: 1, load: 1, lcase: 1 },
      multiSel: { nodes: new Set(), beams: new Set() },
      addNode(x, y, z) { const n = { id: this.nextId.node++, x, y, z: z || 0, support: 'none' };
                         this.nodes.push(n); return n.id; },
      addBeam(a, b) { if (a === b || a == null || b == null) return null;
                      const e = this.beams.find(m => (m.node1===a&&m.node2===b)||(m.node1===b&&m.node2===a));
                      if (e) return e.id;
                      const m = { id: this.nextId.beam++, node1: a, node2: b, sectionId: 1 };
                      this.beams.push(m); return m.id; },
      findNode(id) { return this.nodes.find(n => n.id === id); },
      findBeam(id) { return this.beams.find(b => b.id === id); },
      snapshot: noop, updateNodeTable: noop, updateBeamTable: noop, updateLoadTable: noop,
      render: noop, toast: noop, fitToScreen: noop
    };
    gCtx.SA = app;
    return app;
  };

  const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  const geom = (app) => ({
    nodes: app.nodes.length, members: app.beams.length,
    ySpread: +spread(app.nodes.map(n => n.y || 0)).toFixed(6),
    zSpread: +spread(app.nodes.map(n => n.z || 0)).toFixed(6)
  });

  // Every brace type must leave a flat frame: elevation in Z, nothing in Y.
  ['x', 'diagonal', 'k', 'v', 'none'].forEach(brace => {
    const app = makeApp();
    GEN.generateBracedFrame(2, 3, 5, 3, 'fixed', brace);
    const g = geom(app);
    check(`${brace} bracing leaves the frame planar`, g.ySpread === 0,
          `y spread ${g.ySpread} m across a ${g.zSpread} m frame`);
    check(`${brace} bracing keeps the height in Z`, Math.abs(g.zSpread - 9) < 1e-9, `${g.zSpread}`);
  });

  // Nothing may be left behind by the lift — every node belongs to the frame.
  const kApp = makeApp();
  GEN.generateBracedFrame(2, 3, 5, 3, 'fixed', 'k');
  check('K bracing adds an apex per panel', kApp.nodes.length === 12 + 6, `${kApp.nodes.length}`);
  check('and every one of them is in plane',
        kApp.nodes.every(n => (n.y || 0) === 0),
        JSON.stringify(kApp.nodes.filter(n => (n.y || 0) !== 0).slice(0, 2)));
  check('the apexes sit mid-storey',
        kApp.nodes.filter(n => Math.abs(n.z - 1.5) < 1e-9).length === 2,
        'two panels per storey at z = 1.5');

  const vApp = makeApp();
  GEN.generateBracedFrame(2, 3, 5, 3, 'fixed', 'v');
  check('V bracing is planar too', vApp.nodes.every(n => (n.y || 0) === 0));
  check('with its apexes at storey level',
        vApp.nodes.filter(n => Math.abs(n.x - 2.5) < 1e-9).every(n => n.z % 3 === 0));

  // Member counts, so a brace silently vanishing is caught as well.
  const counts = {};
  ['none', 'diagonal', 'x', 'k', 'v'].forEach(b => {
    const a = makeApp(); GEN.generateBracedFrame(2, 3, 5, 3, 'fixed', b);
    counts[b] = a.beams.length;
  });
  check('an unbraced frame is columns plus beams', counts.none === (2+1)*3 + 2*3, `${counts.none}`);
  check('one diagonal per panel adds 6',  counts.diagonal === counts.none + 6, `${counts.diagonal}`);
  check('X adds two per panel',           counts.x === counts.none + 12, `${counts.x}`);
  check('K adds four per panel',          counts.k === counts.none + 24, `${counts.k}`);
  check('and so does V',                  counts.v === counts.none + 24, `${counts.v}`);

  // Every other template must stay planar too.
  const TEMPLATES = [
    ['frame',        (g) => g.generateFrame(3, 2, 6, 3.5, 'fixed')],
    ['truss pratt',  (g) => g.generateTruss('pratt', 8, 2, 2)],
    ['arch',         (g) => g.generateArch(20, 4, 12, 'parabolic')],
    ['vierendeel',   (g) => g.generateVierendeel(6, 2, 2, true)],
    ['lean-to',      (g) => g.generateLeanTo(2, 5, 4, 3, 'fixed')],
    ['column line',  (g) => g.generateColumnLine(4, 5, 4, true)],
    ['cont. beam',   (g) => g.generateContinuousBeam(4, 5, 10, 'pin')]
  ];
  TEMPLATES.forEach(([name, build]) => {
    const app = makeApp();
    try { build(GEN); } catch (e) { check(`${name} generates`, false, e.message); return; }
    const g = geom(app);
    check(`${name} is planar`, g.ySpread === 0 || g.zSpread === 0,
          `y ${g.ySpread}, z ${g.zSpread}`);
  });
}

group('Bracing actually braces');
{
  // Geometry alone does not prove the braces work — they have to carry the
  // sway. With the apexes out of plane the K and V diagonals ran off sideways
  // and resisted nothing in the frame's own plane. This is the structural
  // consequence, solved rather than asserted.
  //
  // A 2-bay x 3-storey frame, 5 m bays, 3 m storeys, 50 kN at the top.
  const SEC = [{ id: 1, name: 'S', E: 200, A: 100, I: 20000, Ix: 20000, rho: 0 }];
  const build = (brace) => {
    const nodes = [], beams = [];
    const grid = [];
    let nid = 1, bid = 1;
    for (let s = 0; s <= 3; s++) { grid[s] = [];
      for (let c = 0; c < 3; c++) {
        nodes.push({ id: nid, x: c * 5, y: s * 3, support: s === 0 ? 'fixed' : 'none' });
        grid[s][c] = nid++;
      } }
    for (let s = 0; s < 3; s++) for (let c = 0; c < 3; c++)
      beams.push({ id: bid++, node1: grid[s][c], node2: grid[s+1][c], sectionId: 1 });
    for (let s = 1; s <= 3; s++) for (let c = 0; c < 2; c++)
      beams.push({ id: bid++, node1: grid[s][c], node2: grid[s][c+1], sectionId: 1 });
    for (let s = 0; s < 3; s++) for (let c = 0; c < 2; c++) {
      const bl = grid[s][c], br = grid[s][c+1], tl = grid[s+1][c], tr = grid[s+1][c+1];
      if (brace === 'x') { beams.push({ id: bid++, node1: bl, node2: tr, sectionId: 1 });
                           beams.push({ id: bid++, node1: br, node2: tl, sectionId: 1 }); }
      else if (brace === 'k') {
        nodes.push({ id: nid, x: (c + 0.5) * 5, y: (s + 0.5) * 3, support: 'none' });
        const mid = nid++;
        [[bl, mid], [br, mid], [mid, tl], [mid, tr]].forEach(([a, b]) =>
          beams.push({ id: bid++, node1: a, node2: b, sectionId: 1 }));
      }
    }
    const loads = [{ type: 'nodal', nodeId: grid[3][0], fx: 50 }];
    return solveFrame(nodes, beams, SEC, loads, []);
  };
  const sway = (brace) => { const r = build(brace);
    return r.success ? Math.abs(r.disp[brace === 'k' ? 10 : 10].u) * 1000 : null; };

  const un = build('none'), x = build('x'), k = build('k');
  check('all three solve', !!un.success && !!x.success && !!k.success);
  const uUn = Math.abs(un.disp[10].u) * 1000,
        uX  = Math.abs(x.disp[10].u)  * 1000,
        uK  = Math.abs(k.disp[10].u)  * 1000;
  check('the unbraced frame sways the most', uUn > uX && uUn > uK,
        `${uUn.toFixed(2)} / ${uX.toFixed(2)} / ${uK.toFixed(2)} mm`);
  check('X bracing stiffens it by more than an order of magnitude',
        uUn / uX > 10, `${(uUn / uX).toFixed(1)}x`);
  check('and K bracing likewise', uUn / uK > 10, `${(uUn / uK).toFixed(1)}x`);
  check('the two are comparable, as they should be',
        Math.abs(uX - uK) / Math.max(uX, uK) < 0.5,
        `${uX.toFixed(3)} vs ${uK.toFixed(3)} mm`);
}

group('EC0 EQU combo includes the actual lateral case, not just DL');
{
  // Regression for a real bug: the EQU (equilibrium) block gated on
  // `WL || EQ` but only ever populated a WL factor regardless of which case
  // triggered it, so an EQ-only model still produced a combo — labelled
  // "1.5<seismic case name>" is right, but it used to say "1.5WL" — whose
  // factors were DL alone, with the seismic case silently absent. See
  // load_combos_generator.js's generateEC0_ULS for the fix itself.
  const dl = { id: 1, name: 'Dead',           type: 'DL' };
  const eq = { id: 2, name: 'Seismic (EQ)',   type: 'EQ' };
  const wl = { id: 3, name: 'Wind',           type: 'WL' };
  const ll = { id: 4, name: 'Live',           type: 'LL' };

  const eqOnly = LoadCombosGenerator.generateEC0_ULS([dl, eq]);
  const eqEqu  = eqOnly.filter(c => c.code === 'EC0 EQU');
  check('an EQ-only model still gets EQU combos', eqEqu.length === 2,
        JSON.stringify(eqEqu.map(c => c.name)));
  check('and they are labelled with the seismic case, not WL',
        eqEqu.length > 0 && eqEqu.every(c => /Seismic \(EQ\)/.test(c.name) && !/WL/.test(c.name)),
        JSON.stringify(eqEqu.map(c => c.name)));
  check('the seismic case itself carries a real factor in EQU, not just DL',
        eqEqu.length > 0 && eqEqu.every(c => c.factors[eq.id] === 1.5),
        JSON.stringify(eqEqu.map(c => c.factors)));

  const wlOnly = LoadCombosGenerator.generateEC0_ULS([dl, wl]);
  const wlEqu  = wlOnly.filter(c => c.code === 'EC0 EQU');
  check('a WL-only model is unaffected by the fix',
        wlEqu.length === 2 && wlEqu.every(c => c.factors[wl.id] === 1.5 && /Wind/.test(c.name)),
        JSON.stringify(wlEqu.map(c => c.name)));

  const both = LoadCombosGenerator.generateEC0_ULS([dl, wl, eq]);
  const bothEqu = both.filter(c => c.code === 'EC0 EQU');
  check('wind and seismic each get their own EQU pair, not combined into one',
        bothEqu.length === 4, JSON.stringify(bothEqu.map(c => c.name)));
  check('neither pair drops the other\'s factor',
        bothEqu.some(c => c.factors[wl.id] === 1.5) && bothEqu.some(c => c.factors[eq.id] === 1.5));

  const neither = LoadCombosGenerator.generateEC0_ULS([dl, ll]);
  check('no EQU combo at all when neither WL nor EQ is present',
        neither.filter(c => c.code === 'EC0 EQU').length === 0);
}

} catch (e) {
  // See the comment on the opening `try` above: this is a hard crash (a bug
  // in a test, or in code it exercises), not a normal check() failure, and
  // nothing after the group that threw ran. Say that plainly instead of
  // leaving whoever is reading CI output to work it out from a bare stack
  // trace, or worse, from the last "ok" line and silence after it.
  console.log(`\nCRASHED after ${passed} check${passed === 1 ? '' : 's'} passed` +
              `${failures.length ? ` (${failures.length} FAILED before the crash)` : ''}: ${e && e.message}`);
  console.log((e && e.stack) || e);
  console.log('\nEverything after this point in the file did not run. This is an ' +
              'uncaught error, not an assertion failure — fix it and re-run.');
  process.exitCode = 1;
  process.exit(1);
}

if (failures.length === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
