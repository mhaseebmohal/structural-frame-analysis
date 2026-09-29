// ══════════════════════════════════════════════════════════════════
//  modes.js — Natural Frequency & Mode Shape Analysis
//  Method: Bathe Subspace Iteration (Bathe, FE Procedures §12.3)
//          — same algorithm used by ETABS / SAP2000 / Abaqus
//  Mass:   Consistent (Hermitian) mass matrix
//  Units:  kN, m  →  frequencies in rad/s and Hz
// ══════════════════════════════════════════════════════════════════
'use strict';

const ModeShapeAnalysis = (() => {

  // ═══════════════════════════════════════════════════════════════
  //  MATRIX UTILITIES
  // ═══════════════════════════════════════════════════════════════

  function zeros2d(m, n) {
    return Array.from({ length: m }, () => new Array(n).fill(0));
  }
  // square alias (used by mass/stiffness builders)
  function zeros2d_m(n) { return zeros2d(n, n); }

  // General matrix multiply  A(m×k) · B(k×p) → C(m×p)
  function matmul(A, B) {
    const m = A.length, k = A[0].length, p = B[0].length;
    const C = zeros2d(m, p);
    for (let i = 0; i < m; i++)
      for (let t = 0; t < k; t++) {
        if (A[i][t] === 0) continue;
        for (let j = 0; j < p; j++) C[i][j] += A[i][t] * B[t][j];
      }
    return C;
  }

  // Aliases kept for mass/stiffness builders
  function mmul_m(A, B) { return matmul(A, B); }

  // Transpose  A(m×n) → Aᵀ(n×m)
  function transpose(A) { return A[0].map((_, j) => A.map(r => r[j])); }
  function mT_m(A) { return transpose(A); }

  // Matrix–vector  A(m×n) · v(n) → w(m)
  function mvmul(A, v) { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)); }

  // Dot product
  function dot(a, b) { return a.reduce((s, v, i) => s + v * b[i], 0); }

  // ═══════════════════════════════════════════════════════════════
  //  CHOLESKY FACTORISATION  A = L · Lᵀ
  //  Returns L (lower-triangular n×n) or null if not positive-definite
  // ═══════════════════════════════════════════════════════════════
  function cholesky(A) {
    const n = A.length;
    const L = zeros2d(n, n);
    for (let j = 0; j < n; j++) {
      let sum = A[j][j];
      for (let k = 0; k < j; k++) sum -= L[j][k] * L[j][k];
      if (sum <= 0) return null;            // not positive-definite
      L[j][j] = Math.sqrt(sum);
      for (let i = j + 1; i < n; i++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        L[i][j] = s / L[j][j];
      }
    }
    return L;
  }

  // Forward substitution: solve  L · x = b
  function forwardSub(L, b) {
    const n = b.length, x = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let j = 0; j < i; j++) s -= L[i][j] * x[j];
      x[i] = s / L[i][i];
    }
    return x;
  }

  // Back substitution: solve  Lᵀ · x = b
  function backSubT(L, b) {
    const n = b.length, x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j];
      x[i] = s / L[i][i];
    }
    return x;
  }

  // Solve  (L·Lᵀ) · x = b  (L already factored)
  function choleskySolve(L, b) {
    return backSubT(L, forwardSub(L, b));
  }

  // Solve  (L·Lᵀ) · X = B  column-by-column
  // B is n×q (array of n rows, each length q); returns X n×q
  function choleskySolveMat(L, B) {
    const n = L.length, q = B[0].length;
    const X = zeros2d(n, q);
    for (let col = 0; col < q; col++) {
      const b_col = B.map(r => r[col]);
      const x_col = choleskySolve(L, b_col);
      for (let i = 0; i < n; i++) X[i][col] = x_col[i];
    }
    return X;
  }


  // ═══════════════════════════════════════════════════════════════
  //  SYMMETRIC JACOBI EIGENDECOMPOSITION  (standard, small q×q)
  //  Solves: S · v = λ · v  where S is symmetric
  //  Returns { d: eigenvalues (length q), V: eigenvectors (q×q, col = eigenvec) }
  // ═══════════════════════════════════════════════════════════════
  function jacobiEig(S_in, q) {
    const S = S_in.map(r => [...r]);        // working copy
    const V = zeros2d(q, q);               // eigenvectors — start as identity
    for (let i = 0; i < q; i++) V[i][i] = 1;

    const maxSweeps = 50;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      // Check off-diagonal norm
      let offNorm = 0;
      for (let i = 0; i < q - 1; i++)
        for (let j = i + 1; j < q; j++)
          offNorm += S[i][j] * S[i][j];
      if (offNorm < 1e-24) break;

      // One sweep: rotate all (p,r) pairs above diagonal
      for (let p = 0; p < q - 1; p++) {
        for (let r = p + 1; r < q; r++) {
          if (Math.abs(S[p][r]) < 1e-14) continue;

          const Spp = S[p][p], Srr = S[r][r], Spr = S[p][r];
          const tau = (Srr - Spp) / (2 * Spr);
          const t   = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
          const c   = 1 / Math.sqrt(1 + t * t);
          const sj  = t * c;

          // Update diagonals and zero target
          S[p][p] = Spp - t * Spr;
          S[r][r] = Srr + t * Spr;
          S[p][r] = S[r][p] = 0;

          // Update remaining off-diagonal entries
          for (let i = 0; i < q; i++) {
            if (i === p || i === r) continue;
            const Sip = S[i][p], Sir = S[i][r];
            S[i][p] = S[p][i] = c * Sip - sj * Sir;
            S[i][r] = S[r][i] = sj * Sip + c * Sir;
          }

          // Accumulate rotation into V
          for (let i = 0; i < q; i++) {
            const Vip = V[i][p], Vir = V[i][r];
            V[i][p] = c * Vip - sj * Vir;
            V[i][r] = sj * Vip + c * Vir;
          }
        }
      }
    }

    const d = S.map((r, i) => r[i]);
    return { d, V };
  }

  // ═══════════════════════════════════════════════════════════════
  //  GENERALISED JACOBI EIGENDECOMPOSITION  (small q×q)
  //  Solves: K_hat · Q = M_hat · Q · Λ
  //  Via:
  //    1. Cholesky  M_hat = Lm · Lmᵀ
  //    2. B = Lm⁻¹ · K_hat · Lm⁻ᵀ   (standard symmetric)
  //    3. Standard Jacobi on B → d, Z
  //    4. Q = Lm⁻ᵀ · Z              (Qᵀ · M_hat · Q = I)
  //  Returns { d: eigenvalues, Q: q×q matrix (cols = eigenvectors) }
  //  or null on failure
  // ═══════════════════════════════════════════════════════════════
  function generalizedJacobiEig(K_hat, M_hat, q) {
    // Cholesky of M_hat (add small ridge if needed for roundoff)
    let Lm = cholesky(M_hat);
    if (!Lm) {
      const M2 = M_hat.map((r, i) => r.map((v, j) => i === j ? v + 1e-10 * Math.abs(v) + 1e-14 : v));
      Lm = cholesky(M2);
      if (!Lm) return null;
    }

    // Build Lm⁻¹ by solving Lm · x = e_j for each unit vector
    const Lm_inv = zeros2d(q, q);
    for (let col = 0; col < q; col++) {
      const e = new Array(q).fill(0); e[col] = 1;
      const x = forwardSub(Lm, e);
      for (let i = 0; i < q; i++) Lm_inv[i][col] = x[i];
    }
    const Lm_invT = transpose(Lm_inv);   // = (Lm⁻¹)ᵀ = Lm⁻ᵀ

    // B = Lm⁻¹ · K_hat · Lm⁻ᵀ
    const B = matmul(matmul(Lm_inv, K_hat), Lm_invT);

    // Symmetrize B to remove numerical noise
    for (let i = 0; i < q; i++)
      for (let j = i + 1; j < q; j++) {
        const avg = (B[i][j] + B[j][i]) * 0.5;
        B[i][j] = B[j][i] = avg;
      }

    // Standard Jacobi on B
    const { d, V: Z } = jacobiEig(B, q);

    // Back-transform eigenvectors: Q = Lm⁻ᵀ · Z
    const Q = matmul(Lm_invT, Z);

    return { d, Q };
  }

  // ═══════════════════════════════════════════════════════════════
  //  STARTING VECTORS  (Bathe §12.3.1)
  //  Choose q DOFs with smallest K_ii / M_ii ratio → unit vectors
  // ═══════════════════════════════════════════════════════════════
  function buildStartingVectors(K_ff, M_ff, nf, q) {
    const ratio = new Array(nf);
    for (let i = 0; i < nf; i++) {
      const kii = K_ff[i][i], mii = M_ff[i][i];
      ratio[i] = (mii > 1e-30) ? kii / mii : 1e30;
    }
    const sorted = Array.from({ length: nf }, (_, i) => i)
      .sort((a, b) => ratio[a] - ratio[b]);

    // Bathe's starting subspace, and the three parts each do a job.
    //
    // Unit vectors at the softest DOFs alone — which is all this used to be —
    // can leave an eigenvector with NO component in the starting subspace, and
    // an iteration cannot recover a direction it never had. A vertical
    // cantilever showed it plainly: asked for 8 modes it returned the weak-axis
    // and torsional series and silently omitted strong-axis bending, the second
    // mode of the structure. Asking for 16 modes widened the subspace and the
    // missing mode reappeared, which is the signature of a deficient start
    // rather than a wrong matrix.
    const X = zeros2d(nf, q);
    if (q < 1) return X;

    // Column 0: the mass diagonal. It has a component along every mode that
    // carries any mass, which is exactly the set worth finding.
    for (let i = 0; i < nf; i++) X[i][0] = M_ff[i][i];

    // Middle columns: unit vectors at the DOFs with the smallest k/m, which is
    // where the lowest modes have their largest amplitudes.
    const last = q - 1;
    for (let j = 1; j < last; j++) X[sorted[Math.min(j - 1, nf - 1)]][j] = 1.0;

    // Final column: alternating signs, so no eigenvector can be orthogonal to
    // the whole starting subspace. Deterministic rather than random — the same
    // model must give the same modes every run.
    if (last > 0) for (let i = 0; i < nf; i++) X[i][last] = (i % 2 === 0) ? 1 : -1;
    return X;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SORT EIGENPAIRS by eigenvalue (ascending)
  //  d  : array of length q (eigenvalues)
  //  V  : m×q matrix (columns = eigenvectors)
  //  Returns { d, X } sorted
  // ═══════════════════════════════════════════════════════════════
  function sortEigenPairs(d, V, m, q) {
    const order = Array.from({ length: q }, (_, i) => i)
      .sort((a, b) => d[a] - d[b]);
    const d_s = order.map(i => d[i]);
    const V_s = zeros2d(m, q);
    for (let j = 0; j < q; j++) {
      const src = order[j];
      for (let i = 0; i < m; i++) V_s[i][j] = V[i][src];
    }
    return { d: d_s, X: V_s };
  }

  // ═══════════════════════════════════════════════════════════════
  //  BATHE SUBSPACE ITERATION
  //  Finds the p lowest eigenpairs of  K_ff · φ = ω² · M_ff · φ
  //  q = min(2p, p+8)  [Bathe's recommended subspace size]
  //
  //  Each iteration:
  //    a.  Z     = M_ff · X          (nf×q)
  //    b.  X_bar = K_ff⁻¹ · Z       (q Cholesky solves; K factored once)
  //    c.  K̂    = X_barᵀ · Z        (q×q)  — note: K·X_bar = Z
  //    d.  M̂    = X_barᵀ · M · X_bar (q×q)
  //    e.  Solve K̂·Q = M̂·Q·Λ       (generalised Jacobi, q×q)
  //    f.  Sort by λ ascending
  //    g.  X = X_bar · Q             (updated Ritz vectors)
  //    h.  Converge if |λ_new - λ_old|/λ_new < tol for all p modes
  //
  //  Returns { d: p eigenvalues, X: nf×q Ritz vectors } or null
  // ═══════════════════════════════════════════════════════════════
  function subspaceIteration(K_ff, M_ff, p, nf, maxIter, tol) {
    // The subspace is widened past the p modes wanted so the ones being kept
    // converge cleanly, but it cannot be wider than the space it sits in.
    // Without the nf clamp a small model — a portal frame has six free DOFs —
    // asked for a normal number of modes bailed out here and surfaced as
    // 'Mode shape iteration did not converge', which points the engineer at
    // their supports instead of at this line. With q = nf the subspace spans
    // everything and the iteration reduces to a full eigensolve, which is
    // exact.
    const q = Math.min(2 * p, p + 8, nf);
    if (q < p || q < 1) return null;

    // Cholesky of K_ff — done ONCE, reused every iteration
    const L_K = cholesky(K_ff);
    if (!L_K) return null;

    // Starting vectors  X (nf × q)
    let X = buildStartingVectors(K_ff, M_ff, nf, q);

    let lambda_prev = new Array(p).fill(Infinity);
    let X_final = null, d_final = null;
    let converged = false;

    for (let iter = 0; iter < maxIter; iter++) {

      // ── (a)  Z = M_ff · X   (nf × q) ──────────────────────────
      const Z = zeros2d(nf, q);
      for (let j = 0; j < q; j++) {
        const xj = X.map(r => r[j]);
        const zj = mvmul(M_ff, xj);
        for (let i = 0; i < nf; i++) Z[i][j] = zj[i];
      }

      // ── (b)  X_bar = K_ff⁻¹ · Z ────────────────────────────────
      const X_bar = choleskySolveMat(L_K, Z);

      // ── (c)  K̂ = X_barᵀ · Z   (since K·X_bar = Z) ─────────────
      //         K̂[i][j] = Σ_k  X_bar[k][i] · Z[k][j]
      const K_hat = zeros2d(q, q);
      for (let i = 0; i < q; i++)
        for (let j = 0; j < q; j++)
          for (let k = 0; k < nf; k++)
            K_hat[i][j] += X_bar[k][i] * Z[k][j];

      // ── (d)  M̂ = X_barᵀ · M · X_bar ───────────────────────────
      const MXbar = zeros2d(nf, q);
      for (let j = 0; j < q; j++) {
        const xj = X_bar.map(r => r[j]);
        const mj = mvmul(M_ff, xj);
        for (let i = 0; i < nf; i++) MXbar[i][j] = mj[i];
      }
      const M_hat = zeros2d(q, q);
      for (let i = 0; i < q; i++)
        for (let j = 0; j < q; j++)
          for (let k = 0; k < nf; k++)
            M_hat[i][j] += X_bar[k][i] * MXbar[k][j];

      // Symmetrize both reduced matrices
      for (let i = 0; i < q; i++)
        for (let j = i + 1; j < q; j++) {
          const avgK = (K_hat[i][j] + K_hat[j][i]) * 0.5;
          K_hat[i][j] = K_hat[j][i] = avgK;
          const avgM = (M_hat[i][j] + M_hat[j][i]) * 0.5;
          M_hat[i][j] = M_hat[j][i] = avgM;
        }

      // ── (e)  Reduced generalised eigenproblem (q×q) ─────────────
      const eigen = generalizedJacobiEig(K_hat, M_hat, q);
      if (!eigen) return null;

      // ── (f)  Sort ascending ─────────────────────────────────────
      // eigen.Q is q×q — columns are eigenvectors in reduced space
      const { d, X: Q_sorted } = sortEigenPairs(eigen.d, eigen.Q, q, q);

      // ── (g)  New Ritz vectors: X = X_bar · Q_sorted ─────────────
      const X_new = zeros2d(nf, q);
      for (let i = 0; i < nf; i++)
        for (let j = 0; j < q; j++)
          for (let k = 0; k < q; k++)
            X_new[i][j] += X_bar[i][k] * Q_sorted[k][j];

      X       = X_new;
      X_final = X_new;
      d_final = d;

      // ── (h)  Convergence check for first p eigenvalues ──────────
      if (iter > 0) {
        let ok = true;
        for (let i = 0; i < p; i++) {
          const lam = Math.abs(d[i]);
          if (lam < 1e-20) continue;   // near-zero: skip
          if (Math.abs(d[i] - lambda_prev[i]) / lam > tol) { ok = false; break; }
        }
        if (ok) { converged = true; break; }
      }

      for (let i = 0; i < p; i++) lambda_prev[i] = d[i];
    }

    // Exhausting maxIter without ever passing the check above is a silent
    // failure mode if it looks the same as a converged result: the caller only
    // sees a non-null return either way. A model whose frequencies haven't
    // actually settled to within `tol` needs to say so rather than being
    // presented as an ordinary, trustworthy answer.
    return { d: d_final, X: X_final, converged };
  }

  // ═══════════════════════════════════════════════════════════════
  //  ELEMENT GEOMETRY (planar)
  //  Mirrors the convention in solver.js: structures produced by the
  //  generators are "Z-lifted" — height lives in nd.z with nd.y === 0.
  //  Without this, a lifted column has dx = dy = 0, so it drops out of
  //  K and M entirely and the eigen-iteration cannot converge.
  //  Returns null for zero-length members.
  // ═══════════════════════════════════════════════════════════════
  function elemGeom(ni, nj) {
    const dx  = nj.x - ni.x;
    const dyR = nj.y - ni.y;
    const dzR = (nj.z || 0) - (ni.z || 0);
    const dy  = (Math.abs(dyR) < 1e-10 && Math.abs(dzR) > 1e-10) ? dzR : dyR;
    const L   = Math.hypot(dx, dy);
    if (L < 1e-10) return null;
    return { L, c: dx / L, s: dy / L };
  }

  /**
   * Scale factor that makes a mode shape drawable: the largest translation
   * becomes 1.0.
   *
   * A mode can have no translation at all — a cantilever twisting about its
   * own axis is pure rotation from end to end — and dividing by that zero
   * (floored at 1e-20) produced rotations of order 1e21 and an animation that
   * flew off the screen. Where translation is negligible against the shape's
   * own scale, normalise on the largest component instead.
   */
  function displayScale(phi, nNodes, dofPerNode) {
    let maxT = 0, maxAny = 0;
    for (let i = 0; i < nNodes; i++) {
      const b = i * dofPerNode;
      const t = dofPerNode >= 6
        ? Math.hypot(phi[b] || 0, phi[b+1] || 0, phi[b+2] || 0)
        : Math.hypot(phi[b] || 0, phi[b+1] || 0);
      if (t > maxT) maxT = t;
    }
    for (let k = 0; k < phi.length; k++) {
      const a = Math.abs(phi[k] || 0);
      if (a > maxAny) maxAny = a;
    }
    const ref = maxT > 1e-9 * maxAny ? maxT : maxAny;
    return ref > 1e-30 ? 1 / ref : 1;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEISMIC MASS FROM APPLIED LOADS
  //
  //  Member self-weight alone badly understates the seismic mass of a real
  //  building: a 5 kPa floor loading usually dwarfs the frame carrying it.
  //  Codes take the effective seismic weight as the dead load plus a share of
  //  the others — ASCE 7-16 §12.7.2, EN 1998-1 §3.2.4 — so the share is a
  //  per-load-case factor the engineer sets, not something inferred here.
  //
  //  Mass comes from WEIGHT, so only the downward part of a gravity load
  //  counts. An uplift load is not negative mass, and a horizontal load is not
  //  mass at all. The resulting mass then resists shaking in every direction,
  //  which is the entire reason for including it.
  // ═══════════════════════════════════════════════════════════════

  /** ASCE 7-16 §12.7.2 as a starting point. Dead in full, storage live at a
   *  quarter, flat-roof snow at a fifth; wind, thermal and the seismic case
   *  itself contribute no mass. */
  const DEFAULT_MASS_FACTORS = { DL: 1.0, LL: 0.25, SL: 0.2, WL: 0, EQ: 0, TL: 0, OTHER: 0 };

  /**
   * Convert applied loads into lumped nodal masses.
   *
   * Element loads are lumped to the two end nodes by lever arm, which
   * preserves both the total mass and where it sits along the member — the
   * usual treatment, and accurate for the translational modes that carry the
   * participation.
   *
   * @param {Array} nodes
   * @param {Array} beams
   * @param {Array} loads
   * @param {Object} opts
   *   loadCases  [{ id, type }] — to look a load's case type up
   *   factors    { DL: 1.0, LL: 0.25, … } overriding DEFAULT_MASS_FACTORS
   * @returns {{ byNode: Object, total: number, breakdown: Object }}
   *   byNode maps node id → mass in kN·s²/m
   */
  function seismicMassFromLoads(nodes, beams, loads, opts) {
    opts = opts || {};
    const g = 9.81;
    const factors = Object.assign({}, DEFAULT_MASS_FACTORS, opts.factors || {});
    const caseType = {};
    (opts.loadCases || []).forEach(lc => { caseType[lc.id] = lc.type; });

    const byNode = {}, breakdown = {};
    let unresolved = 0;
    let total = 0;
    if (!Array.isArray(loads) || !loads.length) return { byNode, total, breakdown, unresolved: 0 };

    const nIdx = {};
    nodes.forEach((nd, i) => { nIdx[nd.id] = i; });
    const bIdx = {};
    (beams || []).forEach(bm => { bIdx[bm.id] = bm; });

    // Weight is a downward force, and fy is negative downward.
    const down = fy => Math.max(0, -(fy || 0));

    const add = (nodeId, w, type) => {
      if (!(w > 0) || nodeId === undefined || nIdx[nodeId] === undefined) return;
      const m = w / g;
      byNode[nodeId] = (byNode[nodeId] || 0) + m;
      breakdown[type] = (breakdown[type] || 0) + w;
      total += m;
    };

    for (const ld of loads) {
      // A load whose case cannot be resolved is counted as dead. Dropping it
      // instead would quietly lower the mass, and lower mass means a lower
      // base shear — the unsafe direction to guess in. The count travels with
      // the result so it can be reported rather than assumed away.
      let type = caseType[ld.caseId];
      if (!type) { type = 'DL'; unresolved++; }
      const f = factors[type];
      if (!(f > 0)) continue;

      if (ld.type === 'nodal') { add(ld.nodeId, down(ld.fy) * f, type); continue; }
      if (ld.type === 'moment') continue;   // a couple carries no weight

      const bm = bIdx[ld.elementId];
      if (!bm) continue;
      const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
      if (!ni || !nj) continue;
      // Include z: the same converter serves the 3D modal analysis, where a
      // column's whole length lies in z and a 2D hypot would call it zero.
      const L = Math.hypot(nj.x - ni.x, nj.y - ni.y, (nj.z || 0) - (ni.z || 0));
      if (!(L > 1e-12)) continue;

      if (ld.type === 'beam_dist' || ld.type === 'beam_trap') {
        // A trapezoid from w1 to w2: total is the mean times the length, and
        // its centroid sits at L(w1 + 2w2)/(3(w1 + w2)) from the first end.
        const w1 = down(ld.fy);
        const w2 = down(ld.fy2 !== undefined ? ld.fy2 : ld.fy);
        const W  = (w1 + w2) / 2 * L * f;
        if (!(W > 0)) continue;
        const sum = w1 + w2;
        const xbar = sum > 1e-12 ? L * (w1 + 2 * w2) / (3 * sum) : L / 2;
        add(bm.node1, W * (1 - xbar / L), type);
        add(bm.node2, W * (xbar / L),     type);
      } else if (ld.type === 'beam_point') {
        const P = down(ld.fy) * f;
        if (!(P > 0)) continue;
        const a = Math.max(0, Math.min(ld.pos || 0, L));
        add(bm.node1, P * (1 - a / L), type);
        add(bm.node2, P * (a / L),     type);
      }
    }
    return { byNode, total, breakdown, unresolved };
  }

  // ═══════════════════════════════════════════════════════════════
  //  BUILD CONSISTENT (HERMITIAN) MASS MATRIX
  //  DOF order per element: [u1, v1, θ1, u2, v2, θ2]
  //  Axial:       rhoAL/6 · [2,1; 1,2]
  //  Transverse:  Hermitian shape function integrals (156/420, …)
  //  Rotational:  comes from θ shape functions (physically correct)
  // ═══════════════════════════════════════════════════════════════
  function buildMassMatrix(nodes, beams, sections, nIdx, extraMass) {
    const n = nodes.length, ndof = n * 3;
    const M = zeros2d_m(ndof);

    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    for (const bm of beams) {
      const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
      if (!ni || !nj) continue;
      const sec = secMap[bm.sectionId];
      if (!sec) continue;

      const geom = elemGeom(ni, nj);
      if (!geom) continue;
      const L = geom.L;

      // ?? not || — a section may legitimately declare rho = 0 to contribute
      // stiffness without mass, and `||` silently replaced that with the unit
      // weight of steel. Only an absent value should take the default.
      const rho    = sec.rho ?? 78.5;           // kN/m³ (unit weight)
      const A      = (sec.A  || 0) / 1e4;       // cm² → m²
      const rhoAL  = rho * A * L / 9.81;        // kN·s²/m  (mass of element)

      const L2 = L * L;
      // Consistent 6×6 mass matrix in local coordinates
      const ml = [
        //  u1          v1           θ1             u2           v2           θ2
        [  2/6,          0,           0,           1/6,           0,           0     ],
        [    0,   156/420,    22*L/420,               0,    54/420,   -13*L/420      ],
        [    0,  22*L/420,   4*L2/420,               0,  13*L/420,   -3*L2/420      ],
        [  1/6,          0,           0,           2/6,           0,           0     ],
        [    0,    54/420,    13*L/420,               0,   156/420,   -22*L/420      ],
        [    0, -13*L/420,  -3*L2/420,               0, -22*L/420,    4*L2/420      ]
      ];
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++)
          ml[i][j] *= rhoAL;

      // Rotate to global: Me = Tᵀ · ml · T
      const c = geom.c, s = geom.s;
      const T = [
        [ c,  s, 0,  0,  0, 0],
        [-s,  c, 0,  0,  0, 0],
        [ 0,  0, 1,  0,  0, 0],
        [ 0,  0, 0,  c,  s, 0],
        [ 0,  0, 0, -s,  c, 0],
        [ 0,  0, 0,  0,  0, 1]
      ];
      const Me = mmul_m(mmul_m(mT_m(T), ml), T);

      const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
      const dofs = [ii*3, ii*3+1, ii*3+2, ij*3, ij*3+1, ij*3+2];
      for (let a = 0; a < 6; a++)
        for (let b = 0; b < 6; b++)
          M[dofs[a]][dofs[b]] += Me[a][b];
    }

    // Lumped mass from applied loads, added to both translational DOFs. A
    // mass has inertia in every direction, so a floor load resists horizontal
    // shaking too — that is the whole point of counting it. No rotary inertia
    // is added: a lumped mass has none, and the consistent element terms above
    // already supply what the members contribute.
    if (extraMass) {
      for (const id in extraMass) {
        const i = nIdx[id];
        if (i === undefined) continue;
        const m = extraMass[id];
        if (!(m > 0)) continue;
        M[i*3][i*3]     += m;
        M[i*3+1][i*3+1] += m;
      }
    }
    return M;
  }

  // ═══════════════════════════════════════════════════════════════
  //  BUILD ELASTIC STIFFNESS  (same conventions as solver.js)
  // ═══════════════════════════════════════════════════════════════
  function buildElasticK(nodes, beams, sections, nIdx, ndof) {
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });
    const K = zeros2d_m(ndof);

    for (const bm of beams) {
      const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
      if (!ni || !nj) continue;
      const sec = secMap[bm.sectionId];
      if (!sec) continue;

      const geom = elemGeom(ni, nj);
      if (!geom) continue;
      // Rigid end zones shorten the flexible length for stiffness only (mass
      // still spans the whole member, so the mass matrix keeps geom.L). This
      // module ignored them while solveFrame applied them, so frequencies were
      // computed from a softer frame than the one being analysed. Delegated to
      // solver.js so all three paths share one definition; resolved at call time
      // because index.html loads modes.js before solver.js.
      const L = (typeof rigidZoneLength === 'function')
        ? rigidZoneLength(bm, sec, beams, secMap, geom.L)
        : geom.L;
      const c = geom.c, s = geom.s;

      const E   = (sec.E  || 0) * 1e6;
      const A   = (sec.A  || 0) / 1e4;
      const Iv  = ((sec.Ix || sec.I) || 0) / 1e8;

      // ?? not || — a modifier of 0 means no stiffness, not "unset".
      const mf11 = stiffMod(bm, sec, 'f11');
      const mfi3 = stiffMod(bm, sec, 'fi3');
      const EA   = E * A * mf11;
      const EI   = E * Iv * mfi3;
      if (EA < 1e-20 || EI < 1e-20) continue;

      const EAL  = EA / L;
      const EIL  = EI / L;
      const EIL2 = EI / (L * L);
      const EIL3 = EI / (L * L * L);

      const kl = [
        [  EAL,         0,        0,    -EAL,         0,        0  ],
        [    0,  12*EIL3,  6*EIL2,       0,  -12*EIL3,  6*EIL2  ],
        [    0,   6*EIL2,   4*EIL,       0,   -6*EIL2,   2*EIL  ],
        [ -EAL,         0,        0,     EAL,         0,        0  ],
        [    0, -12*EIL3, -6*EIL2,       0,   12*EIL3, -6*EIL2  ],
        [    0,   6*EIL2,   2*EIL,       0,   -6*EIL2,   4*EIL  ]
      ];
      const T = [
        [ c,  s, 0,  0,  0, 0],
        [-s,  c, 0,  0,  0, 0],
        [ 0,  0, 1,  0,  0, 0],
        [ 0,  0, 0,  c,  s, 0],
        [ 0,  0, 0, -s,  c, 0],
        [ 0,  0, 0,  0,  0, 1]
      ];
      // Released rotations carry no stiffness here either — solveFrame condenses
      // them, so the modal model has to match or the frequencies describe a
      // structure the user never built.
      if (typeof applyEndReleases === 'function' && typeof releasedDofs2D === 'function')
        applyEndReleases(kl, null, releasedDofs2D(bm));

      const Ke = mmul_m(mmul_m(mT_m(T), kl), T);

      const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
      const dofs = [ii*3, ii*3+1, ii*3+2, ij*3, ij*3+1, ij*3+2];
      for (let a = 0; a < 6; a++)
        for (let b = 0; b < 6; b++)
          K[dofs[a]][dofs[b]] += Ke[a][b];
    }

    // ── Spring supports ──────────────────────────────────────────
    // A spring restrains the structure by adding stiffness to K, not by
    // constraining a DOF, so computeModes leaves its DOFs free. Omitting the
    // stiffness left the structure genuinely unrestrained, K_ff singular, and
    // the Cholesky factorisation inside the subspace iteration failed — every
    // spring-supported model returned "Mode shape iteration did not converge"
    // rather than any modes at all. With the stiffness assembled, a stiff
    // spring (k = 1e7) lands just under the fixed-base frequency as it should
    // (19.17 vs 19.20 Hz), and a soft one (k = 1e3) drops it to 4.18 Hz.
    // solver.js has always assembled these.
    for (const nd of nodes) {
      if (nd.support !== 'spring') continue;
      const i = nIdx[nd.id];
      if (nd.springKx) K[i*3]  [i*3]   += nd.springKx;
      if (nd.springKy) K[i*3+1][i*3+1] += nd.springKy;
      if (nd.springKm) K[i*3+2][i*3+2] += nd.springKm;
    }
    return K;
  }

  // ═══════════════════════════════════════════════════════════════
  //  3D MODAL ANALYSIS
  //
  //  Same eigenproblem as the 2D case — K·φ = ω²·M·φ by subspace iteration —
  //  on the 6 DOF/node space frame. Worth having separately because the modes
  //  that matter most in 3D are the ones 2D cannot represent at all: torsion
  //  about the vertical axis, and the coupling between it and translation that
  //  makes an irregular plan behave badly in an earthquake.
  //
  //  Local DOF order matches solver3d.js exactly:
  //    [u1, v1, w1, θx1, θy1, θz1, u2, v2, w2, θx2, θy2, θz2]
  //  as do the property mappings and the sign convention on the two bending
  //  planes — z-bending couples positively, y-bending negatively. A mass
  //  matrix that disagreed with the stiffness on either would give modes that
  //  look plausible and are wrong.
  //
  //  3D is Z-up: X and Y are horizontal, Z is vertical.
  // ═══════════════════════════════════════════════════════════════

  /** Section properties, read exactly as solver3d.js reads them. */
  function props3D(sec) {
    const E = (sec.E || 210) * 1e6;             // GPa → kN/m²
    // Same rule as solver3d.js, or the modal and static paths would assume
    // different torsional stiffness for one member.
    const nu = (sec.nu > 0 && sec.nu < 0.5) ? sec.nu : 0.30;
    const G = E / (2 * (1 + nu));
    return {
      E, G,
      A:  (sec.A  || 10) / 1e4,                                  // cm² → m²
      Iy: ((sec.Iy || sec.I || sec.Ix || 1000)) / 1e8,           // weak axis
      Iz: ((sec.Ix || sec.I || 1000)) / 1e8,                     // strong axis
      J:  (sec.J  || 0.01) / 1e8,
      rho: sec.rho ?? 78.5                                        // kN/m³ (see buildMassMatrix)
    };
  }

  /** The two solver3d helpers this needs, resolved at call time — modes.js is
   *  parsed before solver3d.js in index.html, so they cannot be captured up
   *  front, only called later once everything has loaded. */
  function have3DHelpers() {
    return typeof buildKlocal3D === 'function' && typeof buildDCM3D === 'function' &&
           typeof buildT3D      === 'function' && typeof mmul3D     === 'function' &&
           typeof mT3D          === 'function';
  }

  /**
   * 12×12 consistent mass matrix in local coordinates.
   *
   * Axial and torsional terms are the two-node bar form ρ·q·L/6·[2 1; 1 2];
   * the two bending planes use the Hermitian integrals, mirroring the sign
   * convention buildKlocal3D uses for each.
   */
  function mlocal3D(rhoA, rhoIp, L) {
    const m = Array.from({ length: 12 }, () => new Float64Array(12));
    const L2 = L * L;
    const mt = rhoA * L / 420;      // bending / translation scale
    const ma = rhoA * L / 6;        // axial
    const mo = rhoIp * L / 6;       // torsion (polar, about the member axis)

    // Axial: u1 (0) ↔ u2 (6)
    m[0][0] = m[6][6] = 2 * ma;
    m[0][6] = m[6][0] = 1 * ma;

    // Torsion: θx1 (3) ↔ θx2 (9). Rotary inertia about the member's own axis,
    // which is what makes a torsional mode possible at all.
    m[3][3] = m[9][9] = 2 * mo;
    m[3][9] = m[9][3] = 1 * mo;

    // Bending in the local x-y plane (about z): v, θz → 1, 5, 7, 11.
    // Positive rotation coupling, matching K[1][5] = +6·az·L.
    m[1][1]  = m[7][7]   =  156 * mt;
    m[1][7]  = m[7][1]   =   54 * mt;
    m[1][5]  = m[5][1]   =   22 * L * mt;
    m[1][11] = m[11][1]  =  -13 * L * mt;
    m[7][5]  = m[5][7]   =   13 * L * mt;
    m[7][11] = m[11][7]  =  -22 * L * mt;
    m[5][5]  = m[11][11] =    4 * L2 * mt;
    m[5][11] = m[11][5]  =   -3 * L2 * mt;

    // Bending in the local x-z plane (about y): w, θy → 2, 4, 8, 10.
    // Negative rotation coupling, matching K[2][4] = −6·ay·L.
    m[2][2]  = m[8][8]   =  156 * mt;
    m[2][8]  = m[8][2]   =   54 * mt;
    m[2][4]  = m[4][2]   =  -22 * L * mt;
    m[2][10] = m[10][2]  =   13 * L * mt;
    m[8][4]  = m[4][8]   =  -13 * L * mt;
    m[8][10] = m[10][8]  =   22 * L * mt;
    m[4][4]  = m[10][10] =    4 * L2 * mt;
    m[4][10] = m[10][4]  =   -3 * L2 * mt;

    return m;
  }

  /** Assemble the global 3D mass matrix. */
  function buildMassMatrix3D(nodes, beams, sections, nIdx, extraMass) {
    const ndof = nodes.length * 6;
    const M = zeros2d(ndof, ndof);
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    for (const bm of beams) {
      const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
      if (!ni || !nj) continue;
      const sec = secMap[bm.sectionId];
      if (!sec) continue;

      const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = (nj.z || 0) - (ni.z || 0);
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-10) continue;

      const p = props3D(sec);
      const rhoA  = p.rho * p.A / 9.81;               // kN·s²/m per metre
      // Polar AREA moment for the rotary inertia — Iy + Iz, not the St Venant
      // torsion constant J. They coincide only for a circle, and using J for a
      // wide flange would understate the torsional inertia several times over.
      const rhoIp = p.rho * (p.Iy + p.Iz) / 9.81;

      const ml = mlocal3D(rhoA, rhoIp, L);
      const { λ } = buildDCM3D(dx, dy, dz, L);
      const T = buildT3D(λ);
      const Me = mmul3D(mmul3D(mT3D(T), ml), T);

      const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
      const dofs = [ii*6, ii*6+1, ii*6+2, ii*6+3, ii*6+4, ii*6+5,
                    ij*6, ij*6+1, ij*6+2, ij*6+3, ij*6+4, ij*6+5];
      for (let a = 0; a < 12; a++)
        for (let b = 0; b < 12; b++)
          M[dofs[a]][dofs[b]] += Me[a][b];
    }

    // Lumped mass from applied loads acts in all three translations.
    if (extraMass) {
      for (const id in extraMass) {
        const i = nIdx[id];
        if (i === undefined) continue;
        const m = extraMass[id];
        if (!(m > 0)) continue;
        M[i*6][i*6]     += m;
        M[i*6+1][i*6+1] += m;
        M[i*6+2][i*6+2] += m;
      }
    }
    return M;
  }

  /** Assemble the global 3D elastic stiffness, mirroring solver3d.js. */
  function buildElasticK3D(nodes, beams, sections, nIdx, ndof) {
    const K = zeros2d(ndof, ndof);
    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    for (const bm of beams) {
      const ni = nodes[nIdx[bm.node1]], nj = nodes[nIdx[bm.node2]];
      if (!ni || !nj) continue;
      const sec = secMap[bm.sectionId];
      if (!sec) continue;

      const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = (nj.z || 0) - (ni.z || 0);
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-10) continue;

      const p = props3D(sec);
      const mod = bm.modifiers || {};
      const kl = buildKlocal3D(p.E * p.A * (mod.fa || 1),
                               p.G * p.J * (mod.fj || 1),
                               p.E * p.Iy * (mod.fi2 ?? 1),
                               p.E * p.Iz * (mod.fi3 ?? 1), L);
      // A released end carries no moment in the modal problem either, so the
      // same static condensation the solver uses applies here.
      if (typeof applyEndReleases === 'function' && typeof releasedDofs3D === 'function')
        applyEndReleases(kl, null, releasedDofs3D(bm));

      const { λ } = buildDCM3D(dx, dy, dz, L);
      const T = buildT3D(λ);
      const Ke = mmul3D(mmul3D(mT3D(T), kl), T);

      const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
      const dofs = [ii*6, ii*6+1, ii*6+2, ii*6+3, ii*6+4, ii*6+5,
                    ij*6, ij*6+1, ij*6+2, ij*6+3, ij*6+4, ij*6+5];
      for (let a = 0; a < 12; a++)
        for (let b = 0; b < 12; b++)
          K[dofs[a]][dofs[b]] += Ke[a][b];
    }
    return K;
  }

  /** Support restraints, matching solver3d.js exactly. */
  function constrainedDofs3D(nodes, nIdx) {
    const c = new Set();
    for (const nd of nodes) {
      const i = nIdx[nd.id];
      const s = nd.support;
      if (!s || s === 'none') { if (!nd.fixedDOF) continue; }
      let fixed = [];
      if (s === 'pin')     fixed = [0, 1, 2];
      if (s === 'fixed')   fixed = [0, 1, 2, 3, 4, 5];
      if (s === 'roller')  fixed = [2];
      if (s === 'rollerH') fixed = [0];
      if (s === 'pinZ')    fixed = [0, 1, 2, 4, 5];
      if (nd.fixedDOF) {
        nd.fixedDOF.forEach((fix, d) => { if (fix) fixed.push(d); });
        fixed = [...new Set(fixed)];
      }
      for (const d of fixed) c.add(i * 6 + d);
    }
    return c;
  }

  /**
   * 3D natural frequencies and mode shapes.
   *
   * @param {Object} opts  as computeModes: loads / loadCases / massFactors
   * @returns modes with uxPct, uyPct, uzPct and the participation data the
   *          response spectrum needs, or { error }.
   */
  function computeModes3D(nodes, beams, sections, numModes, opts) {
    opts = opts || {};
    numModes = numModes || 8;
    const n = nodes.length;
    if (n < 2) return { error: 'Need at least 2 nodes.' };
    if (!beams || !beams.length) return { error: 'No elements defined.' };
    if (!have3DHelpers())
      return { error: '3D solver not loaded — solver3d.js must be present for 3D modes.' };

    const ndof = n * 6;
    const nIdx = {};
    nodes.forEach((nd, i) => { nIdx[nd.id] = i; });

    const constrained = constrainedDofs3D(nodes, nIdx);
    const K_full = buildElasticK3D(nodes, beams, sections, nIdx, ndof);

    // Any DOF nothing resists takes part in no mode, and would sink the
    // Cholesky inside the iteration. In 3D this is routine rather than a
    // corner case: a run of collinear members has no stiffness about its own
    // axis once the torsion constant is small, and a pinned base leaves three
    // rotations free at every support.
    for (let d = 0; d < ndof; d++) {
      if (constrained.has(d)) continue;
      let rowMax = 0;
      for (let j = 0; j < ndof; j++) { const v = Math.abs(K_full[d][j]); if (v > rowMax) rowMax = v; }
      if (rowMax < 1e-20) constrained.add(d);
    }

    const freeDofs = [];
    for (let d = 0; d < ndof; d++) if (!constrained.has(d)) freeDofs.push(d);
    const nf = freeDofs.length;
    if (nf < 1) return { error: 'All DOFs constrained — no dynamic DOFs.' };
    if (nf < numModes) numModes = nf;

    const massFromLoads = opts.loads
      ? seismicMassFromLoads(nodes, beams, opts.loads,
                             { loadCases: opts.loadCases, factors: opts.massFactors })
      : null;
    const M_full = buildMassMatrix3D(nodes, beams, sections, nIdx,
                                     massFromLoads && massFromLoads.byNode);

    const K_ff = freeDofs.map(r => freeDofs.map(c => K_full[r][c]));
    const M_ff = freeDofs.map(r => freeDofs.map(c => M_full[r][c]));
    for (let i = 0; i < nf; i++) {
      if (K_ff[i][i] < 1e-20) K_ff[i][i] = 1e-20;
      if (M_ff[i][i] < 1e-30) M_ff[i][i] = 1e-30;
    }
    let hasMass = false;
    for (let i = 0; i < nf; i++) if (M_ff[i][i] > 1e-20) { hasMass = true; break; }
    if (!hasMass)
      return { error: 'No mass in model. Check section unit weight (rho) and area (A).' };

    // A planar model analysed in 3D is the usual reason this goes wrong, and
    // the generic message sends people to look at their sections. Say what is
    // actually happening: nothing restrains the out-of-plane direction, so the
    // frame is free to swing about its supports and has no lowest mode at all.
    const planar = (() => {
      const same = k => nodes.every(nd => Math.abs((nd[k] || 0) - (nodes[0][k] || 0)) < 1e-9);
      return same('x') || same('y') || same('z');
    })();
    const planarHint = planar
      ? ' Every node lies in one plane, so nothing restrains the out-of-plane' +
        ' direction and the model can swing freely about its supports. Analyse it' +
        ' in 2D, or restrain the out-of-plane DOFs.'
      : ' Check supports and connectivity for an unrestrained mechanism.';

    const maxIter3 = opts.maxIter   || 100;
    const tol3     = opts.tolerance || 1e-8;
    const result = subspaceIteration(K_ff, M_ff, numModes, nf, maxIter3, tol3);
    if (!result || !result.d)
      return { error: 'Mode shape iteration did not converge.' + planarHint };
    const { d, X } = result;

    // Influence vectors for the three global translations. Z is vertical.
    const r = [new Array(nf).fill(0), new Array(nf).fill(0), new Array(nf).fill(0)];
    for (let i = 0; i < nf; i++) {
      const k = freeDofs[i] % 6;
      if (k < 3) r[k][i] = 1;
    }
    const Mr   = r.map(v => mvmul(M_ff, v));
    const Mtot = r.map((v, k) => dot(v, Mr[k]));

    let MallX = 0, MallY = 0, MallZ = 0;
    for (let a = 0; a < ndof; a++)
      for (let b = 0; b < ndof; b++) {
        if (a % 6 === 0 && b % 6 === 0) MallX += M_full[a][b];
        if (a % 6 === 1 && b % 6 === 1) MallY += M_full[a][b];
        if (a % 6 === 2 && b % 6 === 2) MallZ += M_full[a][b];
      }

    const modes = [];
    for (let mi = 0; mi < numModes; mi++) {
      const omega_sq = d[mi];
      if (!isFinite(omega_sq) || omega_sq <= 1e-12) continue;
      const omega  = Math.sqrt(omega_sq);
      const freq   = omega / (2 * Math.PI);
      const period = freq > 1e-6 ? 1 / freq : Infinity;

      const phi_ff = X.map(row => row[mi]);
      const gamma  = Mr.map(v => dot(phi_ff, v));
      const pct    = gamma.map((g, k) => Mtot[k] > 1e-20 ? (g * g / Mtot[k]) * 100 : 0);

      const phi_full  = new Array(ndof).fill(0);
      const mPhi_full = new Array(ndof).fill(0);
      const mPhi_ff   = mvmul(M_ff, phi_ff);
      freeDofs.forEach((dof, i) => { phi_full[dof] = phi_ff[i]; mPhi_full[dof] = mPhi_ff[i]; });

      const sc = displayScale(phi_full, n, 6);

      modes.push({
        modeNum: modes.length + 1, omega, freq, period,
        phi: phi_full.map(v => v * sc),
        uxPct: pct[0], uyPct: pct[1], uzPct: pct[2],
        gammaX: gamma[0], gammaY: gamma[1], gammaZ: gamma[2],
        phiMass: phi_full, mPhi: mPhi_full
      });
    }
    if (!modes.length)
      return { error: 'No valid modes found — every candidate came back as a rigid-body' +
                      ' motion with zero frequency.' + planarHint };

    return {
      modes, freeDofs: nf, dofMap: freeDofs, ndof, is3D: true,
      totalMassX: Mtot[0], totalMassY: Mtot[1], totalMassZ: Mtot[2],
      structuralMassX: MallX, structuralMassY: MallY, structuralMassZ: MallZ,
      appliedMass: massFromLoads, converged: result.converged
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  ENTRY POINT
  // ═══════════════════════════════════════════════════════════════
  /**
   * @param {Object} opts  optional
   *   loads / loadCases / massFactors — applied loads to count as seismic
   *   mass (see seismicMassFromLoads); omitted, the mass is member
   *   self-weight alone, as it always was.
   */
  function computeModes(nodes, beams, sections, numModes, opts) {
    opts = opts || {};
    numModes = numModes || 8;
    const n = nodes.length;
    if (n < 2) return { error: 'Need at least 2 nodes.' };
    if (!beams || beams.length === 0) return { error: 'No elements defined.' };

    const ndof = n * 3;
    const nIdx = {};
    nodes.forEach((nd, i) => { nIdx[nd.id] = i; });

    // ── Identify constrained DOFs ──────────────────────────────
    const constrained = new Set();
    for (const nd of nodes) {
      const i = nIdx[nd.id];
      if (!nd.support) continue;
      if (nd.support === 'fixed')   { constrained.add(i*3); constrained.add(i*3+1); constrained.add(i*3+2); }
      else if (nd.support === 'pin')     { constrained.add(i*3); constrained.add(i*3+1); }
      else if (nd.support === 'roller')  { constrained.add(i*3+1); }
      else if (nd.support === 'rollerH') { constrained.add(i*3); }
    }

    // ── Rotations left with no stiffness by an end release ───────
    // K has to be built before the free set can be worked out, because
    // releasing every member at a node leaves that node's rotation attached to
    // nothing. Such a DOF has no stiffness AND no mass coupling that matters,
    // so the Cholesky inside the subspace iteration failed and every model with
    // released ends came back "No valid modes found". Constraining them is
    // exact: a rotation nothing resists takes part in no mode.
    const K_probe = buildElasticK(nodes, beams, sections, nIdx, ndof);
    for (const nd of nodes) {
      const d = nIdx[nd.id] * 3 + 2;
      if (constrained.has(d)) continue;
      let rowMax = 0;
      for (let j = 0; j < ndof; j++) { const v = Math.abs(K_probe[d][j]); if (v > rowMax) rowMax = v; }
      if (rowMax < 1e-20) constrained.add(d);
    }

    const freeDofs = [];
    for (let d = 0; d < ndof; d++) if (!constrained.has(d)) freeDofs.push(d);
    const nf = freeDofs.length;
    if (nf < 1) return { error: 'All DOFs constrained — no dynamic DOFs.' };
    if (nf < numModes) numModes = nf;

    // ── Build and partition K, M ───────────────────────────────
    const K_full = K_probe;   // already assembled above
    const massFromLoads = opts.loads
      ? seismicMassFromLoads(nodes, beams, opts.loads,
                             { loadCases: opts.loadCases, factors: opts.massFactors })
      : null;
    const M_full = buildMassMatrix(nodes, beams, sections, nIdx,
                                   massFromLoads && massFromLoads.byNode);

    const K_ff = freeDofs.map(r => freeDofs.map(c => K_full[r][c]));
    const M_ff = freeDofs.map(r => freeDofs.map(c => M_full[r][c]));

    // Guard: K_ff must be positive definite
    // Small diagonal perturbation if any K_ii is zero/negative (rigid body)
    for (let i = 0; i < nf; i++)
      if (K_ff[i][i] < 1e-20) K_ff[i][i] = 1e-20;

    // Guard: M_ff diagonal must be > 0 (elements need mass defined)
    let hasMass = false;
    for (let i = 0; i < nf; i++) if (M_ff[i][i] > 1e-20) { hasMass = true; break; }
    if (!hasMass)
      return { error: 'No mass in model. Check section unit weight (rho) and area (A).' };

    // Ensure no zero diagonal in M (rotational DOFs may have small but valid mass)
    for (let i = 0; i < nf; i++)
      if (M_ff[i][i] < 1e-30) M_ff[i][i] = 1e-30;

    // ── Bathe Subspace Iteration ───────────────────────────────
    const maxIter = opts.maxIter    || 100;
    const tol     = opts.tolerance  || 1e-8;

    const result = subspaceIteration(K_ff, M_ff, numModes, nf, maxIter, tol);
    if (!result || !result.d)
      return { error: 'Mode shape iteration did not converge. Check model stability.' };
    // A non-null result only means the Cholesky factorisation succeeded — the
    // subspace iteration itself may still have exhausted maxIter without ever
    // meeting `tol`. That is not fatal (the last iterate is usually a close
    // estimate), so the modes below are still built and returned, but
    // `converged: false` travels with them rather than presenting an
    // unsettled answer as an ordinary, trustworthy one.

    const { d, X } = result;   // d: numModes eigenvalues, X: nf×q Ritz vectors (mass-normalised)

    // ── Mass participation setup ───────────────────────────────
    // Influence vectors in free-DOF space:
    //   r_x[i] = 1 if freeDofs[i] is an X-translational DOF (dof % 3 === 0)
    //   r_y[i] = 1 if freeDofs[i] is a Y-translational DOF  (dof % 3 === 1)
    const r_x = new Array(nf).fill(0);
    const r_y = new Array(nf).fill(0);
    for (let i = 0; i < nf; i++) {
      if (freeDofs[i] % 3 === 0) r_x[i] = 1;
      if (freeDofs[i] % 3 === 1) r_y[i] = 1;
    }
    const Mr_x    = mvmul(M_ff, r_x);
    const Mr_y    = mvmul(M_ff, r_y);
    const Mtot_x  = dot(r_x, Mr_x);   // unrestrained mass in X
    const Mtot_y  = dot(r_y, Mr_y);   // unrestrained mass in Y

    // The same sums over every DOF, restrained ones included. Mass lumped onto
    // a fixed support genuinely cannot respond, so participation is rightly
    // measured against the free partition — but the two totals differ, and a
    // reader told '99% of the mass' deserves to know which mass that is.
    let MallX = 0, MallY = 0;
    for (let a = 0; a < ndof; a++)
      for (let b = 0; b < ndof; b++) {
        if (a % 3 === 0 && b % 3 === 0) MallX += M_full[a][b];
        if (a % 3 === 1 && b % 3 === 1) MallY += M_full[a][b];
      }

    // ── Assemble output modes ──────────────────────────────────
    const modes = [];
    for (let modeIdx = 0; modeIdx < numModes; modeIdx++) {
      const omega_sq = d[modeIdx];
      if (!isFinite(omega_sq) || omega_sq <= 1e-12) continue;

      const omega  = Math.sqrt(omega_sq);        // rad/s
      const freq   = omega / (2 * Math.PI);      // Hz
      const period = freq > 1e-6 ? 1.0 / freq : Infinity;

      // Mass-normalised free-DOF vector (columns of X from subspace iteration)
      const phi_ff = X.map(r => r[modeIdx]);

      // Participation factors: Γ_j = φᵀ · M · r_j
      const gamma_x = dot(phi_ff, Mr_x);
      const gamma_y = dot(phi_ff, Mr_y);
      const uxPct   = Mtot_x > 1e-20 ? (gamma_x * gamma_x / Mtot_x) * 100 : 0;
      const uyPct   = Mtot_y > 1e-20 ? (gamma_y * gamma_y / Mtot_y) * 100 : 0;

      // Expand to full ndof
      const phi_full = new Array(ndof).fill(0);
      freeDofs.forEach((dof, i) => { phi_full[dof] = phi_ff[i]; });

      // Normalise for display: max translational displacement = 1.0
      const sc       = displayScale(phi_full, n, 3);
      const phi_norm = phi_full.map(v => v * sc);

      // Number sequentially over the modes actually kept. Using modeIdx + 1
      // left gaps whenever a near-zero (rigid-body) eigenvalue was skipped
      // above, so the UI listed "Mode 1, Mode 3, Mode 4".
      // A response spectrum needs more than the picture. Keep the
      // mass-normalised shape (φᵀMφ = 1) alongside the display-normalised one,
      // the raw participation factors, and M·φ — that product is what turns a
      // spectral acceleration into a force vector, and rebuilding the mass
      // matrix outside this module to get it would risk the two drifting apart.
      const mPhi_ff   = mvmul(M_ff, phi_ff);
      const mPhi_full = new Array(ndof).fill(0);
      const phiM_full = new Array(ndof).fill(0);
      freeDofs.forEach((dof, i) => { mPhi_full[dof] = mPhi_ff[i]; phiM_full[dof] = phi_ff[i]; });

      modes.push({
        modeNum: modes.length + 1, omega, freq, period, phi: phi_norm, uxPct, uyPct,
        gammaX: gamma_x, gammaY: gamma_y,   // Γ = φᵀ M r   (mass-normalised φ)
        phiMass: phiM_full,                 // φ with φᵀMφ = 1, expanded to ndof
        mPhi: mPhi_full                     // M·φ, expanded to ndof
      });
    }

    if (modes.length === 0)
      return { error: 'No valid modes found. Check that elements have E, A, I, rho defined.' };

    // freeDofs stays the *count* — the UI has always read it that way. The
    // actual index list goes out under its own name.
    return { modes, freeDofs: nf, dofMap: freeDofs, ndof,
             totalMassX: Mtot_x, totalMassY: Mtot_y,
             structuralMassX: MallX, structuralMassY: MallY,
             appliedMass: massFromLoads, converged: result.converged };
  }

  // ─────────────────────────────────────────────────────────────
  return { computeModes, computeModes3D, seismicMassFromLoads, DEFAULT_MASS_FACTORS };
})();

// Guarded — also importScripts()-ed into solver.worker.js, which has no `window`.
if (typeof window !== 'undefined') window.ModeShapeAnalysis = ModeShapeAnalysis;
