// ══════════════════════════════════════════════════════════════════════════════
//  pdelta.js  —  P-Delta (Geometric Nonlinearity) Analysis
//  Inspired by: JWock82/Pynite  (Python FEM library)
//  Method: Iterative correction via geometric stiffness matrix Kg
//  Ref: McGuire, Gallagher & Ziemian "Matrix Structural Analysis" 2nd ed.
//  Units: kN, m, kNm
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const PDeltaAnalysis = (() => {

  // ── Geometric stiffness matrix for a 2D beam-column element ───────────────
  // N: axial force, TENSION positive (kN) — see the note in runPDelta below
  // L: element length (m)
  // Returns 6×6 local geometric stiffness matrix (Kg_local)
  // Ref: Przemieniecki "Theory of Matrix Structural Analysis" Eq. 9.52;
  //      equivalently Cook, "Concepts and Applications of FEA", the N/(30L) form:
  //
  //        Kg = N/(30L) · ⎡ 36   3L  -36   3L ⎤   over [v1, θ1, v2, θ2]
  //                       ⎢ 3L  4L² -3L  -L² ⎥
  //                       ⎢-36  -3L   36  -3L ⎥
  //                       ⎣ 3L  -L² -3L  4L² ⎦
  //
  // The three rotation-coupled coefficients were each one factor of L too
  // large (N·L/10 for the v-θ term instead of N/10, and N·L²/30 and N·L²/60
  // for the θ-θ terms instead of N·L/15 and N·L/30). That made Kg
  // dimensionally inconsistent — the v-v term is a force per length while the
  // v-θ term was a moment — so the correction did not merely come out the
  // wrong size, it came out the wrong SIGN in aggregate: a compressed sway
  // frame got *stiffer* under P-Δ, and the second-order sway landed below the
  // linear sway. That is unconservative, and it is the failure the
  // "P-Delta sway >= linear sway" regression check now pins down.
  function geometricStiffnessLocal(N, L) {
    const k   = N / (30 * L);
    const a   = 36 * k;        // v–v      = 6N/5L
    const b   = 3 * L * k;     // v–θ      = N/10
    const c1  = 4 * L * L * k; // θ–θ same = 2NL/15
    const c2  = -L * L * k;    // θ–θ far  = -NL/30

    // 6×6 local geometric stiffness matrix
    // DOFs: [u1, v1, θ1, u2, v2, θ2]
    return [
      [ 0,  0,  0,  0,  0,  0 ],
      [ 0,  a,  b,  0, -a,  b ],
      [ 0,  b, c1,  0, -b, c2 ],
      [ 0,  0,  0,  0,  0,  0 ],
      [ 0, -a, -b,  0,  a, -b ],
      [ 0,  b, c2,  0, -b, c1 ]
    ];
  }

  // ── Transform local Kg to global ──────────────────────────────────────────
  function geometricStiffnessGlobal(N, L, c, s) {
    const Kg_l = geometricStiffnessLocal(N, L);
    const T = [
      [ c,  s, 0,  0,  0, 0],
      [-s,  c, 0,  0,  0, 0],
      [ 0,  0, 1,  0,  0, 0],
      [ 0,  0, 0,  c,  s, 0],
      [ 0,  0, 0, -s,  c, 0],
      [ 0,  0, 0,  0,  0, 1]
    ];
    // Kg_global = Tᵀ · Kg_l · T
    return mmul(mmul(mT(T), Kg_l), T);
  }

  // ── Run P-Delta analysis ──────────────────────────────────────────────────
  // Uses the existing solveFrame function for the linear base, then iteratively
  // adds geometric stiffness corrections until convergence (or max iterations).
  //
  // nodes, beams, sections, loads, settlements: same as solveFrame()
  // options.maxIter   : max iterations (default 20)
  // options.tolerance : convergence tolerance on displacements (default 1e-6)
  // options.verbose   : return iteration history
  //
  // Returns: same structure as solveFrame() + pdelta metadata
  // ── Planar element geometry ──────────────────────────────────────
  // Mirrors solver.js: structures built by the generators are "Z-lifted" —
  // elevation lives in nd.z with nd.y === 0. Reading nd.y unconditionally made
  // every column come out with dx = dy = 0, so L = 0, the element was skipped,
  // the stiffness matrix went singular and the whole P-Δ run returned zero
  // displacements with an empty iteration history — silently, as "success".
  // Returns null for zero-length members.
  function elemGeom2D(ni, nj) {
    const dx  = nj.x - ni.x;
    const dyR = nj.y - ni.y;
    const dzR = (nj.z || 0) - (ni.z || 0);
    const dy  = (Math.abs(dyR) < 1e-10 && Math.abs(dzR) > 1e-10) ? dzR : dyR;
    const L   = Math.hypot(dx, dy);
    if (L < 1e-10) return null;
    return { L, c: dx / L, s: dy / L };
  }

  // ── Fixed-end forces ─────────────────────────────────────────────
  // Delegates to solver.js's fefLocal2D so the load vector this module solves
  // with and the end forces it reports are always derived from the same
  // formulas. They used to be two separate inline copies: buildF projected the
  // load onto the member axes, computeElemForces did not and skipped beam_trap
  // outright — so a column under a horizontal UDL reported NaN end forces, and
  // a trapezoidal load gave M1 = −8.9 kNm where the linear solve said 33.1.
  // pdelta.js already hard-depends on solver.js for solveFrame; this is the
  // same dependency, resolved at call time (load order is irrelevant).
  function elemFEF(loads, elemId, L, c, s) {
    if (typeof fefLocal2D === 'function') return fefLocal2D(loads, elemId, L, c, s);
    return new Float64Array(6);   // solver.js absent — runPDelta already errors
  }

  // ── Flexible length with rigid end zones ─────────────────────────
  // Delegates to solver.js for the same reason elemFEF does: solveFrame and this
  // module have to agree on the stiffness, or the second-order answer differs
  // from the first-order one for reasons that have nothing to do with P-Δ.
  // Resolved at call time — index.html loads pdelta.js before solver.js.
  function elemFlexL(bm, sec, beams, secMap, L) {
    if (typeof rigidZoneLength === 'function') return rigidZoneLength(bm, sec, beams, secMap, L);
    return L;
  }

  // ── Member end releases ──────────────────────────────────────────
  // Same reason as elemFEF and elemFlexL: solveFrame condenses released
  // rotations out of the element, so this module has to as well or the
  // second-order run would silently analyse a different structure.
  function elemRelease(kl, fef, bm) {
    if (typeof applyEndReleases === 'function' && typeof releasedDofs2D === 'function')
      applyEndReleases(kl, fef, releasedDofs2D(bm));
  }

  // ── Second moment of area ────────────────────────────────────────
  // solver.js and modes.js both read `sec.Ix || sec.I`; this module read a bare
  // `sec.I`. Sections that carry only Ix (3D shapes, imported profiles) gave
  // `undefined / 1e8` → NaN, which propagated through the whole stiffness
  // matrix. NaN also defeats the singularity guard, since Math.abs(NaN) < tol
  // is false, so the run "succeeded" with NaN displacements.
  function secI(sec) {
    const I = (sec.Ix != null ? sec.Ix : sec.I);
    return Number.isFinite(+I) ? +I : 0;
  }

  // Mirrors app.js's isPlanarModel() — duplicated rather than shared because
  // this module has no access to that closure. Keep the two in sync: this is
  // what decides whether a model is safe to run through the 2D-only geometric
  // stiffness below, the same way isPlanarModel() decides whether the LINEAR
  // solve may use the 2D solver.
  function isPlanar2D(nodes, loads) {
    if (nodes.length < 2) return true;
    const TOL = 1e-9;
    const y0 = nodes[0].y || 0, z0 = nodes[0].z || 0;
    let flatY = true, flatZ = true;
    for (const nd of nodes) {
      if (nd.fixedDOF) return false;
      if (Math.abs((nd.y || 0) - y0) > TOL) flatY = false;
      if (Math.abs((nd.z || 0) - z0) > TOL) flatZ = false;
      if (!flatY && !flatZ) return false;
    }
    for (const ld of (loads || [])) {
      if (ld.fz != null || ld.mx != null || ld.my != null) return false;
    }
    return true;
  }

  function runPDelta(nodes, beams, sections, loads, settlements, options = {}) {
    if (typeof solveFrame === 'undefined' || typeof fefLocal2D !== 'function') {
      return { error: 'solveFrame not available. Load solver.js first.' };
    }
    // elemGeom2D below only ever builds a 2-coordinate (x, and y-or-z)
    // geometry — there is no 3D geometric-stiffness path. Silently collapsing
    // a genuinely non-planar model to that 2D geometry produced a "successful"
    // second-order result with no relationship to the real, out-of-plane
    // behaviour. The linear solve routes a model like this to solveFrame3D;
    // P-Δ has no equivalent yet, so it has to refuse instead of guessing.
    if (!isPlanar2D(nodes, loads)) {
      return { error: 'P-Δ (second-order) analysis does not yet support non-planar 3D models ' +
                      '— this structure has out-of-plane geometry, a custom 3D restraint mask, ' +
                      'or an out-of-plane load (fz/mx/my). Analyse it without P-Δ, or run it on ' +
                      'the planar sub-structure.' };
    }

    const maxIter = options.maxIter   || 20;
    const tol     = options.tolerance || 1e-6;

    const n    = nodes.length;
    const ndof = n * 3;
    const nIdx = {};
    nodes.forEach((nd, i) => { nIdx[nd.id] = i; });
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    // ── Step 1: Linear first-order solution ───────────────────────────
    let res0 = solveFrame(nodes, beams, sections, loads, settlements);
    if (!res0 || !res0.success) return { error: res0?.error || 'Linear solve failed', pdelta: false };

    // ── Step 2: Iterative P-Delta ──────────────────────────────────────
    let prevU = null;
    const history = [];
    // Declared outside the loop (and assigned via `iter = ...` below rather
    // than `let iter = ...` in the for-init) so its final value — and whether
    // a break happened at all — is still readable once the loop ends. Without
    // this the non-convergence path below had no way to tell "ran out of the
    // iteration budget" from "K_eff went singular after 2 iterations", and
    // reported iterations: maxIter for both.
    let iter;
    let bailReason = null;

    for (iter = 0; iter < maxIter; iter++) {
      // Build geometric stiffness matrix from current axial forces
      const Kg = zeros2d(ndof);

      for (const ef of (res0.elemForces || [])) {
        const bm = beams.find(b => b.id === ef.id);
        if (!bm) continue;
        const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
        if (!ni || !nj) continue;

        // Przemieniecki's Kg (used above) is formulated with N positive in
        // TENSION, and the effective stiffness is K + Kg: compression must give
        // a negative Kg so the structure softens.
        //
        // solver.js reports the OPPOSITE convention. Verified directly — a
        // single column carrying 100 kN of gravity returns N1 = N2 = +100, and
        // the same column under 100 kN of uplift returns −100. So elemForces
        // are compression-positive and must be negated before they reach Kg.
        // Feeding them in unnegated made compression stiffen the frame, and the
        // second-order sway came out BELOW the linear sway — unconservative,
        // and the reverse of what P-Δ is for.
        const N_axial = -(ef.N1 + ef.N2) / 2;   // → tension positive, as Kg expects
        if (Math.abs(N_axial) < 1e-6) continue;  // skip zero-force members

        const L = ef.L;
        const c = ef.c, s = ef.s;
        const Kg_e = geometricStiffnessGlobal(N_axial, L, c, s);
        const ii   = nIdx[bm.node1], ij = nIdx[bm.node2];
        const dofs  = [ii*3, ii*3+1, ii*3+2, ij*3, ij*3+1, ij*3+2];

        for (let a = 0; a < 6; a++)
          for (let b2 = 0; b2 < 6; b2++)
            Kg[dofs[a]][dofs[b2]] += Kg_e[a][b2];
      }

      // Build modified stiffness: K_eff = Ko + Kg (add geometric stiffness)
      // We need Ko from the underlying solver — we reconstruct it here
      const Ko_new = buildElasticK(nodes, beams, sections, nIdx, secMap, ndof);
      if (!Ko_new) { bailReason = 'singular'; break; }

      // Add geometric stiffness. Kg is built from a TENSION-positive axial
      // force, so compression contributes a negative Kg and correctly softens
      // the structure.
      const K_eff = Ko_new.map((row, i) => row.map((v, j) => v + Kg[i][j]));

      // Build load vector and solve via DOF partitioning (no penalty)
      const F = buildF(nodes, beams, sections, loads, settlements, nIdx, ndof);
      const U_new = solveWithPartition(K_eff, F, nodes, settlements, nIdx, ndof);
      if (!U_new) { bailReason = 'singular'; break; }

      // Check convergence: max displacement change
      const delta = prevU
        ? Math.max(...U_new.map((u, i) => Math.abs(u - prevU[i])))
        : Infinity;

      history.push({ iter: iter + 1, delta });

      if (delta < tol) {
        // Converged — compute element forces with final U
        const elemForces = computeElemForces(nodes, beams, sections, loads, U_new, nIdx, secMap);
        const reactions  = computeReactions(nodes, beams, sections, loads, settlements, U_new, nIdx, secMap, ndof);
        const disp = {};
        nodes.forEach(nd => {
          const i = nIdx[nd.id];
          disp[nd.id] = { u: U_new[i*3], v: U_new[i*3+1], theta: U_new[i*3+2] };
        });
        return {
          success: true, disp, elemForces, reactions,
          pdelta: true,
          iterations: iter + 1,
          converged: true,
          delta_final: delta,
          history
        };
      }
      prevU = [...U_new];

      // Update res0 with new forces for next Kg computation
      const ef2 = computeElemForces(nodes, beams, sections, loads, prevU, nIdx, secMap);
      res0 = { success: true, elemForces: ef2 };
    }

    // Did not converge (structure may be unstable)
    // Compute disp and reactions from last known displacement vector
    const lastU = prevU || new Array(ndof).fill(0);
    const ncDisp = {};
    nodes.forEach(nd => {
      const i = nIdx[nd.id];
      ncDisp[nd.id] = { u: lastU[i*3], v: lastU[i*3+1], theta: lastU[i*3+2] };
    });
    const ncElemForces = computeElemForces(nodes, beams, sections, loads, lastU, nIdx, secMap);
    const ncReactions  = computeReactions(nodes, beams, sections, loads, settlements, lastU, nIdx, secMap, ndof);
    // Iterations actually executed — iter+1 on an early break (bailReason set,
    // so the break fired partway through iteration `iter`), or plain `iter`
    // (== maxIter) when the loop ran to completion without ever converging.
    const iterationsRun = bailReason ? iter + 1 : iter;
    return {
      success:    true,
      disp:       ncDisp,
      elemForces: ncElemForces,
      reactions:  ncReactions,
      pdelta:     true,
      converged:  false,
      iterations: iterationsRun,
      history,
      warning: bailReason === 'singular'
        ? `P-Delta's effective (geometric) stiffness became singular after ` +
          `${iterationsRun} iteration${iterationsRun === 1 ? '' : 's'} — the structure has ` +
          'likely reached or passed its critical (buckling) load under this load case, ' +
          'rather than simply needing more iterations.'
        : `P-Delta did not converge within ${iterationsRun} iterations (tolerance ${tol}). ` +
          'The structure may be close to buckling, or may just need a higher options.maxIter.'
    };
  }

  // ── Helpers (mirror internal solver logic) ────────────────────────────────

  function zeros2d(n) {
    return Array.from({ length: n }, () => new Array(n).fill(0));
  }

  function mmul(A, B) {
    const m = A.length, k = A[0].length, n = B[0].length;
    const C = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let i = 0; i < m; i++)
      for (let p = 0; p < k; p++) {
        if (!A[i][p]) continue;
        for (let j = 0; j < n; j++) C[i][j] += A[i][p] * B[p][j];
      }
    return C;
  }
  function mT(A) { return A[0].map((_, j) => A.map(r => r[j])); }
  function mvmul(A, v) { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)); }

  function gaussSolve(Ain, bin) {
    const n = bin.length;
    const A = Ain.map(r => [...r]);
    const b = [...bin];
    for (let col = 0; col < n; col++) {
      let maxR = col;
      for (let r = col+1; r < n; r++)
        if (Math.abs(A[r][col]) > Math.abs(A[maxR][col])) maxR = r;
      [A[col], A[maxR]] = [A[maxR], A[col]];
      [b[col], b[maxR]] = [b[maxR], b[col]];
      const piv = A[col][col];
      if (Math.abs(piv) < 1e-30) return null;
      for (let r = col+1; r < n; r++) {
        const f = A[r][col] / piv;
        for (let j = col; j < n; j++) A[r][j] -= f * A[col][j];
        b[r] -= f * b[col];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n-1; i >= 0; i--) {
      if (Math.abs(A[i][i]) < 1e-30) return null;
      let s = b[i];
      for (let j = i+1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }
  // ── One element: geometry, local stiffness and fixed-end forces ──
  //
  // buildElasticK, buildF and computeElemForces each used to construct kl
  // themselves from the same six lines. That is exactly how the FEF and rigid-
  // zone bugs got in — three copies that drifted. Now they share this, so a
  // change to the element formulation cannot reach one path and miss another.
  //
  // Returns null for a member that cannot be formed (missing node or section,
  // zero length). kl and fef come back already condensed for end releases.
  function elemMatrices(bm, nodes, secMap, nIdx, beams, loads) {
    const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
    if (!ni || !nj) return null;
    const sec = secMap[bm.sectionId];
    if (!sec) return null;
    const g = elemGeom2D(ni, nj);
    if (!g) return null;

    const Lf = elemFlexL(bm, sec, beams, secMap, g.L);   // stiffness length
    const E  = sec.E * 1e6;
    // ?? not || — a modifier of 0 means no stiffness, not "unset".
    const A  = (sec.A / 1e4) * stiffMod(bm, sec, 'f11');
    const I  = (secI(sec) / 1e8) * stiffMod(bm, sec, 'fi3');
    const EAL = E*A/Lf, EIL = E*I/Lf, EIL2 = E*I/(Lf*Lf), EIL3 = E*I/(Lf*Lf*Lf);
    const kl = [
      [ EAL, 0, 0, -EAL, 0, 0 ],
      [ 0,  12*EIL3,  6*EIL2, 0, -12*EIL3,  6*EIL2 ],
      [ 0,   6*EIL2,   4*EIL, 0,  -6*EIL2,   2*EIL ],
      [-EAL, 0, 0,  EAL, 0, 0 ],
      [ 0, -12*EIL3, -6*EIL2, 0,  12*EIL3, -6*EIL2 ],
      [ 0,   6*EIL2,   2*EIL, 0,  -6*EIL2,   4*EIL ]];

    // Span loads act over the GEOMETRIC length, not the flexible one.
    const fef = Array.from(loads ? elemFEF(loads, bm.id, g.L, g.c, g.s)
                                 : new Float64Array(6));
    elemRelease(kl, fef, bm);

    const T = [[g.c,g.s,0,0,0,0],[-g.s,g.c,0,0,0,0],[0,0,1,0,0,0],
               [0,0,0,g.c,g.s,0],[0,0,0,-g.s,g.c,0],[0,0,0,0,0,1]];
    const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
    return { ni, nj, sec, L: g.L, c: g.c, s: g.s, Lf, kl, fef, T, ii, ij,
             dofs: [ii*3, ii*3+1, ii*3+2, ij*3, ij*3+1, ij*3+2] };
  }


  function buildElasticK(nodes, beams, sections, nIdx, secMap, ndof) {
    const K = zeros2d(ndof);
    for (const bm of beams) {
      const e = elemMatrices(bm, nodes, secMap, nIdx, beams, null);
      if (!e) continue;
      const Ke = mmul(mmul(mT(e.T), e.kl), e.T);
      for (let a=0;a<6;a++) for (let b2=0;b2<6;b2++) K[e.dofs[a]][e.dofs[b2]] += Ke[a][b2];
    }
    // ── Spring supports ──────────────────────────────────────────
    for (const nd of nodes) {
      if (nd.support !== 'spring') continue;
      const i = nIdx[nd.id];
      if (nd.springKx) K[i*3][i*3]     += nd.springKx;
      if (nd.springKy) K[i*3+1][i*3+1] += nd.springKy;
      if (nd.springKm) K[i*3+2][i*3+2] += nd.springKm;
    }
    return K;
  }

  function buildF(nodes, beams, sections, loads, settlements, nIdx, ndof) {
    const F = new Float64Array(ndof);
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });
    for (const bm of beams) {
      const e = elemMatrices(bm, nodes, secMap, nIdx, beams, loads);
      if (!e) continue;
      const fef_g = mvmul(mT(e.T), e.fef);   // already condensed for releases
      for (let a=0;a<6;a++) F[e.dofs[a]] += fef_g[a];
    }
    for (const ld of loads) {
      if (ld.type==='nodal'||ld.type==='moment') {
        const i = nIdx[ld.nodeId]; if (i===undefined) continue;
        F[i*3]+=ld.fx||0; F[i*3+1]+=ld.fy||0; F[i*3+2]+=ld.m||0;
      }
    }
    return Array.from(F);
  }

  // ── DOF-partition solve (replaces penalty method) ────────────────
  // Returns full U vector (zeros at constrained DOFs, solved at free DOFs)
  function solveWithPartition(K, F, nodes, settlements, nIdx, ndof) {
    const constrained = new Set();
    const settleVal   = new Map();
    for (const nd of nodes) {
      const i = nIdx[nd.id];
      if (nd.support === 'pin')     { constrained.add(i*3); constrained.add(i*3+1); }
      if (nd.support === 'fixed')   { constrained.add(i*3); constrained.add(i*3+1); constrained.add(i*3+2); }
      if (nd.support === 'roller')  { constrained.add(i*3+1); }
      if (nd.support === 'rollerH') { constrained.add(i*3); }
    }
    for (const st of (settlements || [])) {
      const i = nIdx[st.nodeId]; if (i === undefined) continue;
      const dof = i*3 + (st.dir==='u'?0:st.dir==='v'?1:2);
      constrained.add(dof); settleVal.set(dof, st.value || 0);
    }
    const freeDofs  = [];
    for (let d = 0; d < ndof; d++) if (!constrained.has(d)) freeDofs.push(d);
    const constArr  = [...constrained];
    const U_c       = constArr.map(d => settleVal.get(d) || 0);
    const K_ff = freeDofs.map(r => freeDofs.map(c => K[r][c]));
    const K_fc = freeDofs.map(r => constArr.map(c => K[r][c]));
    const RHS  = freeDofs.map((d, i) => {
      let rhs = F[d];
      for (let j = 0; j < U_c.length; j++) rhs -= K_fc[i][j] * U_c[j];
      return rhs;
    });
    const U_f = gaussSolve(K_ff, RHS);
    if (!U_f) return null;
    const U = new Array(ndof).fill(0);
    freeDofs.forEach((d, i)  => { U[d] = U_f[i]; });
    constArr.forEach((d, i)  => { U[d] = U_c[i]; });
    return U;
  }


  function computeElemForces(nodes, beams, sections, loads, U, nIdx, secMap) {
    const elemForces = [];
    for (const bm of beams) {
      const e = elemMatrices(bm, nodes, secMap, nIdx, beams, loads);
      if (!e) continue;
      const u_g = e.dofs.map(d => U[d]);
      const u_l = mvmul(e.T, u_g);
      // f = kl·u_l − fef, both condensed, so a released end reports zero moment.
      const f_l = e.kl.map((row, r) => row.reduce((s2, v, co) => s2 + v*u_l[co], 0) - e.fef[r]);
      elemForces.push({
        id: bm.id, N1: f_l[0], V1: f_l[1], M1: f_l[2],
        N2: -f_l[3], V2: -f_l[4], M2: -f_l[5],
        L: e.L, x1: e.ni.x, y1: e.ni.y, x2: e.nj.x, y2: e.nj.y, c: e.c, s: e.s,
        u1: U[e.ii*3], v1: U[e.ii*3+1], t1: U[e.ii*3+2],
        u2: U[e.ij*3], v2: U[e.ij*3+1], t2: U[e.ij*3+2],
        loads: loads.filter(l => l.elementId === bm.id)
      });
    }
    return elemForces;
  }

  function computeReactions(nodes, beams, sections, loads, settlements, U, nIdx, secMap, ndof) {
    // Build Ko
    const Ko = buildElasticK(nodes, beams, sections, nIdx, secMap, ndof);

    // R = Ko·U − F_ext, where F_ext holds every external action on the node.
    // Only the nodal loads were collected here, so the equivalent nodal loads
    // of a member load framing into a support were left in the reaction —
    // wind on a column reported sum(Rx) = −10 kN against 20 kN applied. The
    // linear solver has always included the FEF term; this now matches it.
    const F_ext = new Float64Array(ndof);
    for (const ld of loads) {
      if (ld.type==='nodal'||ld.type==='moment') {
        const i=nIdx[ld.nodeId]; if(i===undefined) continue;
        F_ext[i*3]+=ld.fx||0; F_ext[i*3+1]+=ld.fy||0; F_ext[i*3+2]+=ld.m||0;
      }
    }
    // Equivalent nodal loads must be the CONDENSED ones — the same fef the
    // load vector was built from. Using the raw fixed-end forces here while Ko
    // carried the released stiffness put the reaction at a released support at
    // 50 kN against the linear solve's 40 kN.
    for (const bm of beams) {
      const e = elemMatrices(bm, nodes, secMap, nIdx, beams, loads);
      if (!e) continue;
      const fef_g = mvmul(mT(e.T), e.fef);
      for (let a=0;a<6;a++) F_ext[e.dofs[a]] += fef_g[a];
    }
    // Ko carries the spring stiffnesses, so at a spring DOF `Ko·U − F_ext` is
    // identically zero and the spring force went unreported — ΣRy came out at
    // half the applied load. Removing the spring row's own contribution leaves
    // the force the spring applies to the structure, −k·u. Same fix as
    // solveFrame; the two reaction paths have to agree.
    const reactions = {};
    nodes.forEach(nd => {
      reactions[nd.id]={Rx:0,Ry:0,M:0};
      if (nd.support&&nd.support!=='none') {
        const i=nIdx[nd.id];
        for (let j=0;j<ndof;j++) {
          reactions[nd.id].Rx+=Ko[i*3][j]*U[j];
          reactions[nd.id].Ry+=Ko[i*3+1][j]*U[j];
          reactions[nd.id].M +=Ko[i*3+2][j]*U[j];
        }
        if (nd.support === 'spring') {
          reactions[nd.id].Rx -= (nd.springKx || 0) * U[i*3];
          reactions[nd.id].Ry -= (nd.springKy || 0) * U[i*3+1];
          reactions[nd.id].M  -= (nd.springKm || 0) * U[i*3+2];
        }
        reactions[nd.id].Rx-=F_ext[i*3];
        reactions[nd.id].Ry-=F_ext[i*3+1];
        reactions[nd.id].M -=F_ext[i*3+2];
      }
    });
    return reactions;
  }

  // ── Critical Load Multiplier (eigenvalue estimate) ────────────────────────
  // Approximate buckling load factor via Euler: λcr = Ncr / N_applied
  // For each member, reports how close it is to Euler buckling
  function criticalLoadFactors(elemForces, beams, sections) {
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    return elemForces.map(ef => {
      const bm  = beams.find(b => b.id === ef.id);
      const sec = bm ? secMap[bm.sectionId] : null;
      if (!sec) return null;

      const E  = sec.E * 1e6;
      const I  = (secI(sec) / 1e8) * stiffMod(bm, sec, 'fi3');
      const L  = ef.L;
      // elemForces are compression-positive (see the note in runPDelta), so the
      // compressive part is the positive part. Negating first — as this did —
      // made N_comp zero for every compressed member, which pinned λcr at
      // Infinity and reported risk 'LOW' for the whole structure regardless of
      // load.
      const N_comp = Math.max(0, (ef.N1 + ef.N2) / 2);   // average compression

      const Ncr = Math.PI * Math.PI * E * I / (L * L);    // Euler (pinned-pinned)
      const λcr = N_comp > 0.001 ? Ncr / N_comp : Infinity;

      return {
        beamId: ef.id,
        N_comp: +N_comp.toFixed(3),
        Ncr:    +Ncr.toFixed(2),
        lambda_cr: +Math.min(λcr, 999).toFixed(3),
        // EC3 §5.2.1(3): first-order analysis is only acceptable at αcr ≥ 10;
        // below that second-order effects must be accounted for, and below
        // about 3 they dominate. The old bands (1.5 / 3.0) called a frame at
        // αcr = 4.4 'LOW' risk while this function's own note said 'recommend
        // ≥ 10 for sway frames' — the rating contradicted the advice beside it.
        risk:   λcr < 3.0 ? 'HIGH' : λcr < 10.0 ? 'MODERATE' : 'LOW',
        note:   `λcr=${λcr < 999 ? λcr.toFixed(2) : '∞'} (recommend ≥ 10 for sway frames)`
      };
    }).filter(Boolean);
  }

  return {
    runPDelta,
    geometricStiffnessLocal,
    geometricStiffnessGlobal,
    criticalLoadFactors
  };

})();

// Guarded — also importScripts()-ed into solver.worker.js, which has no `window`.
if (typeof window !== 'undefined') window.PDeltaAnalysis = PDeltaAnalysis;
