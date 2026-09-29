// ══════════════════════════════════════════════════════════════════════════════
//  solver3d.js  —  3D Space Frame Solver (Matrix Stiffness Method)
//  6 DOF per node: [u, v, w, θx, θy, θz]  (translations + rotations in global XYZ)
//  Units: kN, m, kNm  (E in GPa→kN/m², A in cm²→m², I in cm⁴→m⁴)
//  Reference: McGuire, Gallagher & Ziemian "Matrix Structural Analysis" 2nd Ed.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ── 12×12 Local element stiffness (Euler-Bernoulli, local DOF order):
// [u1, v1, w1, θx1, θy1, θz1,  u2, v2, w2, θx2, θy2, θz2]
//  0   1   2    3    4    5    6   7   8    9   10   11
function buildKlocal3D(EA, GJ, EIy, EIz, L) {
  const K = Array.from({ length: 12 }, () => new Float64Array(12));
  const L2 = L * L, L3 = L2 * L;

  // ── Axial: u1 (0) ↔ u2 (6)
  K[0][0] = K[6][6] = EA / L;
  K[0][6] = K[6][0] = -EA / L;

  // ── Torsion: θx1 (3) ↔ θx2 (9)
  K[3][3] = K[9][9] = GJ / L;
  K[3][9] = K[9][3] = -GJ / L;

  // ── Bending in local x-y plane (about z-axis): v, θz  → DOF 1,5,7,11
  const az = EIz / L3;
  K[1][1] = K[7][7]   =  12 * az;
  K[1][7] = K[7][1]   = -12 * az;
  K[1][5] = K[5][1]   =   6 * az * L;
  K[1][11]= K[11][1]  =   6 * az * L;
  K[7][5] = K[5][7]   =  -6 * az * L;
  K[7][11]= K[11][7]  =  -6 * az * L;
  K[5][5] = K[11][11] =   4 * az * L2;
  K[5][11]= K[11][5]  =   2 * az * L2;

  // ── Bending in local x-z plane (about y-axis): w, θy  → DOF 2,4,8,10
  // Note: coupling has opposite sign due to right-hand rule for θy
  const ay = EIy / L3;
  K[2][2] = K[8][8]   =  12 * ay;
  K[2][8] = K[8][2]   = -12 * ay;
  K[2][4] = K[4][2]   =  -6 * ay * L;   // negative coupling
  K[2][10]= K[10][2]  =  -6 * ay * L;
  K[8][4] = K[4][8]   =   6 * ay * L;
  K[8][10]= K[10][8]  =   6 * ay * L;
  K[4][4] = K[10][10] =   4 * ay * L2;
  K[4][10]= K[10][4]  =   2 * ay * L2;

  return K;
}

// ── 3×3 Direction cosine matrix for the local axes of a 3D beam element
// Returns { λ, ex, ey, ez } where λ is [ex; ey; ez] (rows are local axis unit vectors)
function buildDCM3D(dx, dy, dz, L) {
  // Local x: along beam
  const ex = [dx / L, dy / L, dz / L];

  // Choose reference vector to build local y perpendicular to beam
  // Convention: local y ≈ in the vertical plane (global Z is up — ETABS/SAP2000)
  //   If beam is (nearly) vertical, use global X as reference instead
  let ref;
  const verticalness = Math.abs(ex[2]);  // |dot(ex, globalZ)| — Z is up
  if (verticalness > 0.999) {
    ref = [1, 0, 0];  // nearly vertical beam → use global X as ref
  } else {
    ref = [0, 0, 1];  // normal case → use global Z (up)
  }

  // Local z = normalise(ex × ref)  [horizontal perpendicular]
  const ez = cross3(ex, ref);
  const ezL = Math.hypot(...ez);
  ez[0] /= ezL; ez[1] /= ezL; ez[2] /= ezL;

  // Local y = ez × ex  [nearly vertical, in the vertical plane through beam]
  const ey = cross3(ez, ex);
  // ey is already unit since ex and ez are orthonormal

  // λ[i][j]: row i is local axis i, col j is global j
  const λ = [
    [ex[0], ex[1], ex[2]],
    [ey[0], ey[1], ey[2]],
    [ez[0], ez[1], ez[2]]
  ];
  return { λ, ex, ey, ez };
}

// ── Build 12×12 transformation matrix T from DCM λ
// T = blkdiag(λ, λ, λ, λ)  maps global→local DOFs
function buildT3D(λ) {
  const T = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        T[b * 3 + i][b * 3 + j] = λ[i][j];
  }
  return T;
}

// ── Cross product of two 3D vectors
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

// ── Matrix multiply (dense, for 12×12 max)
function mmul3D(A, B) {
  const m = A.length, k = A[0].length, n = B[0].length;
  const C = Array.from({ length: m }, () => new Float64Array(n));
  for (let i = 0; i < m; i++)
    for (let p = 0; p < k; p++) {
      if (A[i][p] === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += A[i][p] * B[p][j];
    }
  return C;
}

// ── Transpose of a matrix
function mT3D(A) {
  const m = A.length, n = A[0].length;
  const B = Array.from({ length: n }, () => new Float64Array(m));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) B[j][i] = A[i][j];
  return B;
}

// ── Matrix-vector multiply
function mvmul3D(A, v) {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

// ── Gauss elimination with partial pivoting (shared with 2D solver)
//
// Returns null when the matrix is singular — i.e. the model is a mechanism or
// is missing supports. This used to `continue` past a zero pivot and set the
// corresponding x[i] to 0, which meant the function could never return a falsy
// value and the caller's `if (!U)` guard was dead code. An unsupported 3D frame
// came back as success:true carrying displacements around 2e14 m.
//
// Singularity is judged against an implicit row scale (the largest magnitude in
// each original row) rather than an absolute floor. The penalty method puts
// entries of ~1e14 on supported diagonals, so any fixed absolute threshold is
// meaningless here: it is either swamped by the penalty rows or trips on
// legitimately soft DOFs.
function gaussSolve3D(Ain, bin) {
  const n = bin.length;
  const A = Ain.map(r => Float64Array.from(r));
  const b = Float64Array.from(bin);

  // Row scale factors for implicit scaled pivoting / singularity detection.
  const rowScale = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) { const v = Math.abs(A[i][j]); if (v > m) m = v; }
    rowScale[i] = m;
  }

  // Track which original row ends up as each pivot so the scale follows it.
  const scaleOf = Array.from({ length: n }, (_, i) => rowScale[i]);

  const REL_TOL = 1e-12;

  for (let col = 0; col < n; col++) {
    // Scaled partial pivoting: compare |A[r][col]| relative to the row's own
    // magnitude so a penalty row does not automatically win every contest.
    let maxR = col, best = -1;
    for (let r = col; r < n; r++) {
      const sc = scaleOf[r] > 0 ? scaleOf[r] : 1;
      const v  = Math.abs(A[r][col]) / sc;
      if (v > best) { best = v; maxR = r; }
    }
    const tmpA = A[col]; A[col] = A[maxR]; A[maxR] = tmpA;
    const tmpB = b[col]; b[col] = b[maxR]; b[maxR] = tmpB;
    const tmpS = scaleOf[col]; scaleOf[col] = scaleOf[maxR]; scaleOf[maxR] = tmpS;

    const piv   = A[col][col];
    const scale = scaleOf[col] > 0 ? scaleOf[col] : 1;
    // Written as "not >=" rather than "<" so a NaN pivot (from a bad section
    // property or a degenerate row combining with the penalty method's 1e14
    // terms) is caught too — any comparison against NaN is false, so "<" would
    // let it through silently and the solve would return a NaN/Infinity result
    // as if it were a normal answer. Same fix as solver.js's gaussSolve.
    if (!(Math.abs(piv) >= REL_TOL * scale)) return null;   // singular (or NaN)

    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / piv;
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[r][j] -= f * A[col][j];
      b[r] -= f * b[col];
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const scale = scaleOf[i] > 0 ? scaleOf[i] : 1;
    if (!(Math.abs(A[i][i]) >= REL_TOL * scale)) return null;   // singular (or NaN)
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return Array.from(x);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main 3D solver
// ══════════════════════════════════════════════════════════════════════════════
function solveFrame3D(nodes, beams, sections, loads, settlements) {
  const n = nodes.length;
  if (n === 0) return { error: 'No nodes defined.' };
  if (beams.length === 0) return { error: 'No beams defined.' };

  const ndof = n * 6;

  const nIdx = {};
  nodes.forEach((nd, i) => { nIdx[nd.id] = i; });

  const secMap = {};
  sections.forEach(s => { secMap[s.id] = s; });

  // Allocate global K and F
  const Ko = Array.from({ length: ndof }, () => new Float64Array(ndof));
  const F  = new Float64Array(ndof);

  const elemData = [];
  // Same as the 2D solver: a member the assembly cannot use is named, not
  // dropped in silence to resurface as a singular matrix.
  const skipped = [];

  // ── Assemble element stiffness matrices ────────────────────────────
  for (const bm of beams) {
    const ni = nodes[nIdx[bm.node1]];
    const nj = nodes[nIdx[bm.node2]];
    if (!ni || !nj) {
      skipped.push(`member ${bm.id} references a node that does not exist`);
      continue;
    }

    const sec = secMap[bm.sectionId];
    if (!sec) {
      skipped.push(bm.sectionId == null
        ? `member ${bm.id} has no section assigned`
        : `member ${bm.id} uses section ${bm.sectionId}, which does not exist`);
      continue;
    }

    const dx = nj.x - ni.x;
    const dy = nj.y - ni.y;
    const dz = (nj.z || 0) - (ni.z || 0);
    const L  = Math.hypot(dx, dy, dz);
    if (L < 1e-10) continue;

    // Material & section properties
    const E  = (sec.E  || 210) * 1e6;           // GPa → kN/m²
    // Poisson's ratio comes from the section's material (Define ▸ Materials)
    // and is carried onto the section alongside E. It was hardcoded at 0.30,
    // so concrete — 0.2 — was given a torsional stiffness ~8% too low. 0.30
    // remains the fallback for a section with no material linked.
    const ν  = (sec.nu > 0 && sec.nu < 0.5) ? sec.nu : 0.30;
    const G  = E / (2 * (1 + ν));               // shear modulus
    const A  = (sec.A  || 10)  / 1e4;           // cm² → m²
    const Iy = ((sec.Iy || sec.I || sec.Ix || 1000)) / 1e8;  // cm⁴ → m⁴ (weak axis)
    const Iz = ((sec.Ix || sec.I || 1000))       / 1e8;  // cm⁴ → m⁴ (strong axis)
    const J  = (sec.J  || 0.01) / 1e8;          // cm⁴ → m⁴ (St. Venant torsion)

    const EA = E * A, GJ = G * J, EIy = E * Iy, EIz = E * Iz;

    // Local stiffness & direction cosines
    const kl = buildKlocal3D(EA, GJ, EIy, EIz, L);
    const { λ } = buildDCM3D(dx, dy, dz, L);
    const T  = buildT3D(λ);
    const Tt = mT3D(T);

    const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
    const dofs = [
      ii*6, ii*6+1, ii*6+2, ii*6+3, ii*6+4, ii*6+5,
      ij*6, ij*6+1, ij*6+2, ij*6+3, ij*6+4, ij*6+5
    ];

    // ── Fixed-end forces from element loads ───────────────────────
    //
    // A member load is a global vector, and the app spells it the same way in
    // 2D and 3D:  fx → global X,  fy → the vertical (global Z here, Z-up),
    // fz → global Y (the depth direction). Only `fy` was ever read, so the whole
    // horizontal component of a member load was dropped without a word: a column
    // under a 5 kN/m wind UDL returned a base reaction of exactly 0 and no sway
    // at all, where the 2D solver reports the full 20 kN.
    //
    // Projecting the global vector onto all three local axes also picks up the
    // AXIAL component, which was likewise missing — an inclined member under
    // gravity carries axial load, not just bending.
    const fef_l = new Float64Array(12);  // local coords
    const bmLoads = loads.filter(ld => ld.elementId === bm.id);

    // Global (X, Y, Z) → local (x, y, z) for a load component triple.
    const toLocal = (gx, gyDepth, gzVert) => ({
      x: gx * λ[0][0] + gyDepth * λ[0][1] + gzVert * λ[0][2],   // axial
      y: gx * λ[1][0] + gyDepth * λ[1][1] + gzVert * λ[1][2],   // local y
      z: gx * λ[2][0] + gyDepth * λ[2][1] + gzVert * λ[2][2]    // local z
    });
    // Accumulate the FEF of a transverse pair (r1, m1, r2, m2) onto both
    // bending planes, plus the axial pair (n1, n2). Signs follow the local
    // stiffness ordering: local-y bending couples to θz (+m), local-z bending to
    // θy with the opposite sign, matching buildKlocal3D.
    const addFEF = (wl, r1, m1, r2, m2, n1, n2) => {
      if (Math.abs(wl.y) > 1e-12) {
        fef_l[1]  += wl.y * r1;  fef_l[5]  += wl.y * m1;
        fef_l[7]  += wl.y * r2;  fef_l[11] -= wl.y * m2;
      }
      if (Math.abs(wl.z) > 1e-12) {
        fef_l[2]  += wl.z * r1;  fef_l[4]  -= wl.z * m1;
        fef_l[8]  += wl.z * r2;  fef_l[10] += wl.z * m2;
      }
      if (Math.abs(wl.x) > 1e-12) {
        fef_l[0] += wl.x * n1;   fef_l[6] += wl.x * n2;
      }
    };

    for (const ld of bmLoads) {
      const hasVec = ld.fx != null || ld.fy != null || ld.fz != null;

      if (ld.type === 'beam_dist' && hasVec) {
        const w = toLocal(ld.fx || 0, ld.fz || 0, ld.fy || 0);
        addFEF(w, L / 2, L * L / 12, L / 2, L * L / 12, L / 2, L / 2);
      }

      // ── Concentrated load on the member ───────────────────────────
      // Previously unhandled: solveFrame3D matched only beam_dist, so every
      // point load on a member was silently dropped from the load vector — a
      // fixed-fixed beam with a 50 kN mid-span load solved to exactly zero
      // moment. The 2D solver has always supported this.
      //
      // `pos` is METRES FROM THE START, the same as in solver.js and the same as
      // the UI's "Pos [m from start]" field. This read it as a 0–1 fraction and
      // clamped it, so any load more than 1 m along landed on the far node: a
      // 60 kN load at 1.5 m on a 6 m cantilever gave a base moment of 360 kNm
      // instead of 90.
      else if (ld.type === 'beam_point' && hasVec) {
        const P  = toLocal(ld.fx || 0, ld.fz || 0, ld.fy || 0);
        const aP = Math.max(0, Math.min(ld.pos != null ? ld.pos : L / 2, L));
        const bP = L - aP;
        if (L > 1e-12) {
          const L2 = L * L, L3 = L2 * L;
          // Standard fixed-end forces for a point load at distance a:
          //   R1 = P·b²(3a+b)/L³ , M1 = P·a·b²/L²
          addFEF(P,
            bP * bP * (3 * aP + bP) / L3, aP * bP * bP / L2,
            aP * aP * (aP + 3 * bP) / L3, aP * aP * bP / L2,
            bP / L, aP / L);
        }
      }

      // ── Trapezoidal / linearly varying distributed load ───────────
      // Also unhandled before. Superpose a uniform part (w1) and a triangular
      // part (w2 − w1) using their standard fixed-end forces.
      else if (ld.type === 'beam_trap' && hasVec) {
        const w1 = toLocal(ld.fx || 0, ld.fz || 0, ld.fy || 0);
        const w2 = toLocal(ld.fx2 != null ? ld.fx2 : (ld.fx || 0),
                           ld.fz2 != null ? ld.fz2 : (ld.fz || 0),
                           ld.fy2 != null ? ld.fy2 : (ld.fy || 0));
        const dw = { x: w2.x - w1.x, y: w2.y - w1.y, z: w2.z - w1.z };
        // uniform: wL/2, wL²/12 ; triangular (0→w at far end): 3wL/20 & 7wL/20,
        // wL²/30 & wL²/20 ; axial triangular: wL/6 & wL/3
        addFEF(w1, L / 2, L * L / 12, L / 2, L * L / 12, L / 2, L / 2);
        addFEF(dw, 3 * L / 20, L * L / 30, 7 * L / 20, L * L / 20, L / 6, L / 3);
      }
    }

    // ── Member end releases (moment hinges) ─────────────────────────
    // A release frees BOTH bending rotations at that end — axial, shear and
    // torsion still transfer. Condensed together with the fixed-end forces,
    // and before Ke is formed, exactly as the 2D solver does.
    if (typeof applyEndReleases === 'function' && typeof releasedDofs3D === 'function')
      applyEndReleases(kl, fef_l, releasedDofs3D(bm));

    // Global stiffness: Ke = Tᵀ · kl · T, from the CONDENSED kl
    const Ke = mmul3D(mmul3D(Tt, kl), T);
    for (let a = 0; a < 12; a++)
      for (let b2 = 0; b2 < 12; b2++)
        Ko[dofs[a]][dofs[b2]] += Ke[a][b2];

    // Transform FEF to global and add to F
    const fef_g = mvmul3D(Tt, Array.from(fef_l));
    for (let a = 0; a < 12; a++) F[dofs[a]] += fef_g[a];

    elemData.push({ bm, ni, nj, ii, ij, L, λ, T, Tt, kl, Ke,
                    fef: Array.from(fef_l), dofs, dx, dy, dz });
  }

  // ── Nodal loads ────────────────────────────────────────────────────
  // The fz/mx/my/mz block below used to sit outside the type test, keyed only on
  // `nodeId` being resolvable. Changing an existing load's type in the UI sets
  // `elementId` without clearing the old `nodeId`, so a member load carrying a
  // stale nodeId had its fz applied a second time as a nodal force. Gate the
  // whole loop on the load actually being a nodal one.
  for (const ld of loads) {
    if (ld.type !== 'nodal' && ld.type !== 'moment') continue;
    const i = nIdx[ld.nodeId];
    if (i === undefined) continue;
    // Z-up convention: fx→DOF0 (global X), fy→DOF2 (global Z = vertical/gravity), m→DOF5 (Mz)
    F[i*6]   += ld.fx || 0;   // global X force
    F[i*6+2] += ld.fy || 0;   // fy = vertical (gravity) → global Z (DOF 2)
    F[i*6+5] += ld.m  || 0;   // in-plane moment Mz
    // Explicit 3D loads: fz = depth-direction (global Y, DOF 1)
    if (ld.fz != null) F[i*6+1] += ld.fz;
    if (ld.mx != null) F[i*6+3] += ld.mx;
    if (ld.my != null) F[i*6+4] += ld.my;
    if (ld.mz != null) F[i*6+5] += ld.mz;
  }

  // ── Copy Ko to K then apply BCs (penalty method) ──────────────────
  const K = Ko.map(r => Float64Array.from(r));
  const P = 1e14;

  const suppDofs = new Set();
  for (const nd of nodes) {
    const i = nIdx[nd.id];
    const s = nd.support;
    // A node can carry a custom fixedDOF mask independent of `support` — skip
    // only when NEITHER is present. Checking just `support` here let a node
    // with support unset/'none' but a real fixedDOF mask fall straight through,
    // silently dropping its restraint from the static solve while modes.js's
    // constrainedDofs3D (built to match this function) correctly kept it.
    if ((!s || s === 'none') && !nd.fixedDOF) continue;

    let fixed = [];
    if (s === 'pin')     fixed = [0, 1, 2];          // u, v, w — all translations
    if (s === 'fixed')   fixed = [0, 1, 2, 3, 4, 5]; // all DOFs
    if (s === 'roller')  fixed = [2];                 // w only — vertical Z (Z-up)
    if (s === 'rollerH') fixed = [0];                 // u only — horizontal X
    if (s === 'pinZ')    fixed = [0, 1, 2, 4, 5];    // 3D pin about Z only
    // Custom 3D support masks stored on node.fixedDOF = [bool×6]
    if (nd.fixedDOF) {
      nd.fixedDOF.forEach((fix, d) => { if (fix) fixed.push(d); });
      fixed = [...new Set(fixed)];
    }
    for (const d of fixed) suppDofs.add(i * 6 + d);
  }

  // ── Rotational DOFs left with no stiffness by a moment release ───
  // Mirrors solver.js's guard: a node whose only framing member has both
  // bending rotations released at that end (e.g. a hinged cantilever tip
  // aligned with a global axis) has an exactly-zero row in Ko for the global
  // rotation(s) perpendicular to the member axis — genuinely no stiffness,
  // not a mechanism, since nothing resists or needs to resist that rotation.
  // Under the penalty method a zero row is not "excluded" the way DOF
  // partitioning excludes it in 2D, so it would trip the singularity check
  // and reject an otherwise perfectly solvable hinged 3D model. With no
  // stiffness AND no applied moment the equation is 0 = 0, so pinning the DOF
  // to zero via the same penalty every support uses changes no real result.
  for (const nd of nodes) {
    const i = nIdx[nd.id];
    for (const localD of [3, 4, 5]) {           // θx, θy, θz
      const d = i * 6 + localD;
      if (suppDofs.has(d)) continue;
      let touched = false;
      for (let j = 0; j < ndof; j++) { if (Ko[d][j] !== 0) { touched = true; break; } }
      if (!touched && Math.abs(F[d]) < 1e-12) suppDofs.add(d);
    }
  }

  // ── Prescribed support displacements (settlements) ────────────────
  // solveFrame3D previously ignored settlements entirely — it did not even
  // accept them — so a settlement defined in the UI worked in 2D and was
  // silently dropped in 3D. With the penalty method the fix is direct: drive
  // the penalised DOF toward the prescribed value instead of zero.
  //   dir 'u' → global X (DOF 0), 'v' → vertical, global Z (DOF 2, Z-up),
  //   anything else → in-plane rotation Mz (DOF 5) — matching the load convention.
  const prescribed = {};
  for (const st of (settlements || [])) {
    const i = nIdx[st.nodeId];
    if (i === undefined) continue;
    const d = st.dir === 'u' ? 0 : st.dir === 'v' ? 2 : 5;
    prescribed[i * 6 + d] = st.value || 0;
  }

  for (const dof of suppDofs) {
    K[dof][dof] += P;
    F[dof] = P * (prescribed[dof] || 0);
  }

  // ── Solve K·U = F ────────────────────────────────────────────────
  const U = gaussSolve3D(K, Array.from(F));
  if (!U) {
    // The most common cause by far is a planar frame analysed in 3D: the 2D
    // support types restrain nothing out of plane, so the structure is free to
    // swing about the vertical axis. Say so rather than just "check supports".
    const ys = nodes.map(nd => nd.y || 0), zs = nodes.map(nd => nd.z || 0);
    const flat = (a) => Math.max(...a) - Math.min(...a) < 1e-9;
    const hint = (flat(ys) || flat(zs))
      ? ' The model is planar — every node lies in one plane — so it has no out-of-plane restraint. Analyse it with the 2D solver, or add supports that restrain the out-of-plane DOFs.'
      : ' Check supports and connectivity for an unrestrained mechanism.';
    if (skipped.length === beams.length && beams.length > 0)
      return { error: `No member could be analysed: ${skipped.join('; ')}. ` +
                      'Assign a section to every member, then solve again.' };
    if (skipped.length)
      return { error: `Structural matrix is singular. ${skipped.length} member` +
                      `${skipped.length === 1 ? ' was' : 's were'} left out of the ` +
                      `analysis: ${skipped.join('; ')}.` };
    return { error: 'Structural matrix is singular.' + hint };
  }

  // ── Sanity bound on the answer ───────────────────────────────────
  // Same guard as the 2D solver (solver.js): a near-mechanism is not singular
  // under the penalty method — it factorises cleanly and returns a number —
  // but two members with almost no bending stiffness can come back with
  // kilometre-scale displacements as a perfectly "successful" solve. Compare
  // the largest displacement against the model's own 3D extent.
  {
    const xs = nodes.map(nd => nd.x || 0);
    const ys = nodes.map(nd => nd.y || 0);
    const zs = nodes.map(nd => nd.z || 0);
    const span = Math.hypot(Math.max(...xs) - Math.min(...xs),
                             Math.max(...ys) - Math.min(...ys),
                             Math.max(...zs) - Math.min(...zs));
    if (span > 0) {
      let uMax = 0;
      for (let j = 0; j < U.length; j++) {
        const v = Math.abs(U[j]);
        if (v > uMax) uMax = v;
      }
      if (uMax > 100 * span) {
        return { error: 'Structure is effectively a mechanism — the solution is ' +
                        `physically meaningless (peak displacement ${uMax.toExponential(2)} m ` +
                        `against a ${span.toFixed(2)} m model). Check supports, releases ` +
                        'and that every member has a real section.' };
      }
    }
  }

  // ── Reactions:  R = Ko·U − F_ext ──────────────────────────────────
  // F_ext must carry EVERY external action on the node, which means the
  // equivalent nodal loads (fixed-end forces) of member loads as well as the
  // directly applied nodal loads. Only the nodal part was subtracted before,
  // so a member load framing into a support left its whole FEF share sitting
  // in the reaction: a fixed-fixed beam under a 10 kN/m UDL reported Rz = 0 at
  // both ends instead of 30 kN. The 2D solver has always done this correctly.
  const F_ext = new Float64Array(ndof);

  // Mirrors the load-vector loop above exactly — including its type gate, or the
  // reactions would be corrected for loads the solve never applied.
  for (const ld of loads) {
    if (ld.type !== 'nodal' && ld.type !== 'moment') continue;
    const i = nIdx[ld.nodeId];
    if (i === undefined) continue;
    F_ext[i*6]   += ld.fx || 0;   // global X
    F_ext[i*6+2] += ld.fy || 0;   // fy = vertical → global Z
    F_ext[i*6+5] += ld.m  || 0;   // in-plane moment Mz
    if (ld.fz != null) F_ext[i*6+1] += ld.fz;
    if (ld.mx != null) F_ext[i*6+3] += ld.mx;
    if (ld.my != null) F_ext[i*6+4] += ld.my;
    if (ld.mz != null) F_ext[i*6+5] += ld.mz;
  }

  // Equivalent nodal loads from member loads, in global coords.
  for (const ed of elemData) {
    const fef_g = mvmul3D(ed.Tt, ed.fef);
    for (let a = 0; a < 12; a++) F_ext[ed.dofs[a]] += fef_g[a];
  }

  const reactions = {};
  nodes.forEach(nd => {
    const i = nIdx[nd.id];
    reactions[nd.id] = { Rx: 0, Ry: 0, Rz: 0, Mx: 0, My: 0, Mz: 0 };
    // Same fix as the suppDofs loop above: a node restrained only via a custom
    // fixedDOF mask, with `support` unset/'none', was skipped here entirely —
    // solved correctly (the DOF was genuinely restrained) but reported as
    // carrying no reaction at all, silently dropping real support forces.
    if ((nd.support && nd.support !== 'none') || nd.fixedDOF) {
      let Rx = 0, Ry = 0, Rz = 0, Mx = 0, My = 0, Mz = 0;
      for (let j = 0; j < ndof; j++) {
        Rx += Ko[i*6]   [j] * U[j];
        Ry += Ko[i*6+1] [j] * U[j];
        Rz += Ko[i*6+2] [j] * U[j];
        Mx += Ko[i*6+3] [j] * U[j];
        My += Ko[i*6+4] [j] * U[j];
        Mz += Ko[i*6+5] [j] * U[j];
      }
      reactions[nd.id].Rx = Rx - F_ext[i*6];
      reactions[nd.id].Ry = Ry - F_ext[i*6+1];
      reactions[nd.id].Rz = Rz - F_ext[i*6+2];
      reactions[nd.id].Mx = Mx - F_ext[i*6+3];
      reactions[nd.id].My = My - F_ext[i*6+4];
      reactions[nd.id].Mz = Mz - F_ext[i*6+5];
    }
  });

  // ── Element end forces (in LOCAL coords) ─────────────────────────
  const elemForces = [];
  for (const ed of elemData) {
    const { bm, ii, ij, L, T, kl, fef, dofs } = ed;
    const u_g = dofs.map(d => U[d]);
    const u_l = mvmul3D(T, u_g);

    // f_local = kl·u_l − fef  (subtract fixed-end forces to get true end forces)
    const f_l = kl.map((row, r) => row.reduce((s, v, c) => s + v * u_l[c], 0) - fef[r]);

    // Unpack: [N1, Vy1, Vz1, Tx1, My1, Mz1, N2, Vy2, Vz2, Tx2, My2, Mz2]
    elemForces.push({
      id:  bm.id,
      // End 1 (local)
      N1:  f_l[0],  Vy1: f_l[1],  Vz1: f_l[2],
      Tx1: f_l[3],  My1: f_l[4],  Mz1: f_l[5],
      // End 2 (local) — note sign flip on axial (internal convention)
      N2: -f_l[6],  Vy2:-f_l[7],  Vz2:-f_l[8],
      Tx2:-f_l[9],  My2:-f_l[10], Mz2:-f_l[11],
      // Expose as legacy 2D names for compatibility
      M1: f_l[5],   M2: -f_l[11],
      V1: f_l[1],   V2: -f_l[7],
      N1_ax: f_l[0],
      L,
      x1: ed.ni.x, y1: ed.ni.y, z1: ed.ni.z || 0,
      x2: ed.nj.x, y2: ed.nj.y, z2: ed.nj.z || 0,
      λ: ed.λ,
      // Displacements at nodes
      u1:U[ii*6], v1:U[ii*6+1], w1:U[ii*6+2],
      θx1:U[ii*6+3], θy1:U[ii*6+4], θz1:U[ii*6+5],
      u2:U[ij*6], v2:U[ij*6+1], w2:U[ij*6+2],
      θx2:U[ij*6+3], θy2:U[ij*6+4], θz2:U[ij*6+5],
    });
  }

  // ── Nodal displacements ───────────────────────────────────────────
  const disp = {};
  nodes.forEach(nd => {
    const i = nIdx[nd.id];
    disp[nd.id] = {
      u: U[i*6], v: U[i*6+1], w: U[i*6+2],
      θx: U[i*6+3], θy: U[i*6+4], θz: U[i*6+5],
      // 2D aliases
      theta: U[i*6+5]
    };
  });

  return { success: true, disp, elemForces, reactions, is3D: true };
}

// Guarded: this file is also importScripts()-ed into solver.worker.js, where
// `window` does not exist. An unguarded assignment throws and aborts the rest
// of the worker's importScripts list.
if (typeof window !== 'undefined') window.solveFrame3D = solveFrame3D;
