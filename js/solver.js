// ──────────────────────────────────────────────────────────────────
//  2D Frame Solver — Direct Stiffness Method (FEM)
//  Boundary conditions: DOF partitioning (NOT penalty method)
//  Units: kN, m, kNm  (E in GPa stored → kN/m², A in cm²→m², I in cm⁴→m⁴)
//
//  Method: K is partitioned into free (f) and constrained (c) DOFs:
//    [K_ff  K_fc] [U_f]   [F_f]
//    [K_cf  K_cc] [U_c] = [F_c]
//  Known: U_c (= 0 or settlement), F_f (external loads on free DOFs)
//  Solve: K_ff · U_f = F_f − K_fc · U_c  (exact, no ill-conditioning)
//  Reactions: R_c = K_cf · U_f + K_cc · U_c − F_ext_c
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
//  Fixed-end forces for one 2D element, in LOCAL coordinates.
//
//  This is the single definition used by both the linear solver and the
//  P-Δ module (pdelta.js). It used to be inlined in three places that had
//  drifted apart: pdelta.js applied ld.fy straight to the transverse DOF
//  without projecting onto the member axes, so a column carrying a
//  horizontal (fx) load produced NaN end forces, and it ignored beam_trap
//  entirely. Keeping one copy is what stops that recurring.
//
//  loads  : the full load array (filtered here by elementId)
//  L      : element length (m)
//  c, s   : direction cosines of the member (cosθ, sinθ)
//  Returns Float64Array(6) — [N1, V1, M1, N2, V2, M2] in local coords.
//
//  Sign convention: global load components (fx, fy) are resolved into
//    transverse  wt = -fx·s + fy·c
//    axial       wa =  fx·c + fy·s
// ──────────────────────────────────────────────────────────────────
function fefLocal2D(loads, elemId, L, c, s) {
  const fef = new Float64Array(6);
  if (!(L > 0)) return fef;

  for (const ld of loads) {
    if (ld.elementId !== elemId) continue;

    if (ld.type === 'beam_dist') {
      const gfx = ld.fx || 0, gfy = ld.fy || 0;
      const wt = -gfx * s + gfy * c;   // local transverse intensity
      const wa =  gfx * c + gfy * s;   // local axial intensity
      fef[1] += wt * L / 2;
      fef[2] += wt * L * L / 12;
      fef[4] += wt * L / 2;
      fef[5] -= wt * L * L / 12;
      fef[0] += wa * L / 2;
      fef[3] += wa * L / 2;

    } else if (ld.type === 'beam_trap') {
      const gfx1 = ld.fx  || 0, gfy1 = ld.fy  || 0;
      const gfx2 = ld.fx2 !== undefined ? ld.fx2 : gfx1;
      const gfy2 = ld.fy2 !== undefined ? ld.fy2 : gfy1;
      const wt1 = -gfx1 * s + gfy1 * c;
      const wt2 = -gfx2 * s + gfy2 * c;
      const wa1 =  gfx1 * c + gfy1 * s;
      const wa2 =  gfx2 * c + gfy2 * s;
      fef[1] += L * (7*wt1 + 3*wt2) / 20;
      fef[2] += L * L * (3*wt1 + 2*wt2) / 60;
      fef[4] += L * (3*wt1 + 7*wt2) / 20;
      fef[5] -= L * L * (2*wt1 + 3*wt2) / 60;
      fef[0] += (2*wa1 + wa2) * L / 6;
      fef[3] += (wa1 + 2*wa2) * L / 6;

    } else if (ld.type === 'beam_point') {
      const a  = Math.max(0, Math.min(ld.pos || 0, L));
      const b2 = L - a;
      const Fy = ld.fy || 0, Fx = ld.fx || 0;
      // Project global load to local beam axes
      const Fy_loc = -Fx * s + Fy * c;  // local transverse
      const Fx_loc =  Fx * c + Fy * s;  // local axial
      fef[0] += Fx_loc * b2 / L;
      fef[1] += Fy_loc * b2*b2*(3*a + b2) / (L*L*L);
      fef[2] += Fy_loc * a * b2*b2 / (L*L);
      fef[3] += Fx_loc * a  / L;
      fef[4] += Fy_loc * a*a*(a + 3*b2) / (L*L*L);
      fef[5] -= Fy_loc * a*a*b2 / (L*L);
    }
  }
  return fef;
}

// ──────────────────────────────────────────────────────────────────
//  Transverse deflection WITHIN a member, from its span loads.
//
//  A stiffness solution gives displacements at the NODES only. Between them
//  the deflected shape is the cubic Hermite interpolation of the end DOFs plus
//  the deflection the member would have if its ends were built in — the
//  particular solution for the span load. Omit that second term and a
//  simply-supported beam modelled as one element appears to have zero sag,
//  because both of its end nodes sit on supports.
//
//  Returns the FIXED-END deflection at distance x, in local transverse
//  coordinates and the same sign convention as the load. Add it to the Hermite
//  term to get the true deflected shape:
//
//      v(x) = hermite(v1, θ1, v2, θ2) + spanDeflLocal2D(...)
//
//  Verified against the closed forms: for a simply-supported span the Hermite
//  term contributes 4wL⁴/384EI and this contributes wL⁴/384EI, summing to the
//  textbook 5wL⁴/384EI.
//
//  loads : full load array (filtered here by elementId)
//  L     : member length (m)
//  c, s  : direction cosines, used to project global load components onto the
//          member's local transverse axis — the same projection fefLocal2D uses
//  EI    : flexural rigidity in kN·m²
// ──────────────────────────────────────────────────────────────────
function spanDeflLocal2D(loads, elemId, L, c, s, EI, x) {
  if (!(L > 0) || !(EI > 0) || !isFinite(x)) return 0;
  const xx = Math.max(0, Math.min(x, L));
  let v = 0;

  for (const ld of loads) {
    if (ld.elementId !== elemId) continue;

    if (ld.type === 'beam_dist') {
      // Fixed-fixed under UDL:  v = w·x²·(L−x)² / (24·EI)
      const w = -(ld.fx || 0) * s + (ld.fy || 0) * c;
      v += w * xx * xx * (L - xx) * (L - xx) / (24 * EI);

    } else if (ld.type === 'beam_trap') {
      // Superpose a uniform part (w1) and a triangular part (w2 − w1).
      const w1  = -(ld.fx || 0) * s + (ld.fy || 0) * c;
      const fx2 = ld.fx2 !== undefined ? ld.fx2 : (ld.fx || 0);
      const fy2 = ld.fy2 !== undefined ? ld.fy2 : (ld.fy || 0);
      const w2  = -fx2 * s + fy2 * c;
      const dw  = w2 - w1;

      v += w1 * xx * xx * (L - xx) * (L - xx) / (24 * EI);
      // Fixed-fixed under a load rising 0 → dw across the span. From
      // EI·v'''' = dw·x/L with v = v' = 0 at both ends; peaks at x = 0.5247L
      // where it equals dw·L⁴/764EI, the standard result.
      v += dw * (Math.pow(xx, 5) / (120 * L)
                 - L * Math.pow(xx, 3) / 40
                 + L * L * xx * xx / 60) / EI;

    } else if (ld.type === 'beam_point') {
      // Fixed-fixed under a point load at a from end 1 (b = L − a):
      //   x ≤ a :  v = P·b²·x²·(3aL − (3a+b)x) / (6·L³·EI)
      // and the mirror image beyond it. At mid-span this gives PL³/192EI.
      const P = -(ld.fx || 0) * s + (ld.fy || 0) * c;
      const a = Math.max(0, Math.min(ld.pos || 0, L));
      const b = L - a;
      const L3 = L * L * L;
      if (xx <= a) {
        v += P * b * b * xx * xx * (3 * a * L - (3 * a + b) * xx) / (6 * L3 * EI);
      } else {
        const xm = L - xx;
        v += P * a * a * xm * xm * (3 * b * L - (3 * b + a) * xm) / (6 * L3 * EI);
      }
    }
  }
  return v;
}

// ──────────────────────────────────────────────────────────────────
//  Effective (flexible) length of a member with automatic rigid end zones.
//
//  ETABS-style: when the section is flagged rigidZone, the joint region is
//  treated as rigid, so the member's flexible length drops by half the depth of
//  the deepest other member framing into each end node.
//
//  This is the single definition used by solveFrame, pdelta.js and modes.js.
//  It used to be inlined in solveFrame only, so a rigid-zone model solved
//  linearly at one stiffness and under P-Δ or modal analysis at another: the
//  same portal gave a linear sway of 3.45 mm and a second-order sway of 5.13 mm,
//  with the second-order figure LOWER-bounded by the wrong stiffness rather than
//  by the physics.
//
//  Returns L unchanged when no rigid zone applies. Only the STIFFNESS should use
//  this length — span loads still act over the full geometric length.
// ──────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────
//  stiffMod — the stiffness modifier for one member and one property.
//
//  There are two places to set a modifier and they used different key names:
//
//    per MEMBER   bm.modifiers  { f11, f22, f33, fm, fi2, fi3, fmass, fwgt }
//                 Assign ▸ Mods, and the ⚙ button in the design table.
//    per SECTION  sec.mods      { A, AS2, AS3, J, I22, I33, mass, weight }
//                 Define ▸ Sections ▸ Modify/Show ▸ Modifiers.
//
//  Every analysis path read only the member set, so the section dialog — the
//  one offering "ACI 318 recommended modifiers" — wrote values nothing looked
//  at. Applying the ACI cracked-section factors (I33 = 0.70) to the columns of
//  a two-storey frame left its sway at 1.0489 mm, exactly the uncracked
//  answer; the same factor as a member modifier gives 1.2232 mm.
//
//  A member modifier is the more specific statement, so it wins. The section
//  value is the default beneath it, and 1.0 the default beneath that.
//
//  `?? not ||` throughout: a modifier of exactly 0 is a real ETABS input
//  meaning "no stiffness in this direction".
// ──────────────────────────────────────────────────────────────────
const SEC_MOD_KEY = {
  f11: 'A', f22: 'AS2', f33: 'AS3', fm: 'J',
  fi2: 'I22', fi3: 'I33', fmass: 'mass', fwgt: 'weight'
};

function stiffMod(bm, sec, key) {
  const own = bm && bm.modifiers ? bm.modifiers[key] : undefined;
  if (own != null) return own;
  const sk = SEC_MOD_KEY[key];
  const shared = sk && sec && sec.mods ? sec.mods[sk] : undefined;
  return shared != null ? shared : 1;
}

function rigidZoneLength(bm, sec, beams, secMap, L) {
  if (!sec || !sec.rigidZone || !(L > 0)) return L;
  let iOff = 0, jOff = 0;
  for (const other of beams) {
    if (other.id === bm.id) continue;
    const oSec = secMap[other.sectionId];
    if (!oSec) continue;
    const oDepth = (oSec.d || 0) / 1000;   // mm → m
    if (other.node1 === bm.node1 || other.node2 === bm.node1) iOff = Math.max(iOff, oDepth / 2);
    if (other.node1 === bm.node2 || other.node2 === bm.node2) jOff = Math.max(jOff, oDepth / 2);
  }
  const Leff = L - iOff - jOff;
  return Leff > 0.05 * L ? Leff : L;   // cap: never reduce by more than 95%
}

// ──────────────────────────────────────────────────────────────────
//  Member end releases (moment hinges) — static condensation.
//
//  The beam table, the canvas hinge tool and the .frame file have carried
//  hingeStart / hingeEnd from the beginning, and the renderer draws the little
//  circle at the released end. No solver ever read them: a propped cantilever
//  with its fixed end released returned M1 = 80 kNm and R1 = 50 kN either way,
//  when releasing it makes the member simply supported at M1 = 0, R1 = 40 kN.
//  The control looked like it worked, which is the worst way for it to fail.
//
//  A release means the member cannot transmit moment at that end while the node
//  itself keeps rotating. That is the released DOF having zero force, so it is
//  condensed out of the element before assembly:
//
//      k*_ij = k_ij − k_ir · k_rj / k_rr        (r = released DOF)
//      f*_i  = f_i  − k_ir · f_r  / k_rr
//
//  Releases are condensed one at a time, each on the result of the last, so
//  releasing both ends works. The row and column are then zeroed: the DOF is
//  still there in the global numbering, it simply no longer couples.
//
//  Note for the modal path: only the STIFFNESS is condensed, not the mass.
//  The released rotation keeps its share of the consistent mass matrix, which
//  is the usual static-condensation approximation. Its effect is small — a
//  fixed-fixed beam with both ends released reproduces the simply-supported
//  fundamental to 0.1 % — but it is an approximation, not an identity.
//
//  kl   : local stiffness (mutated in place)
//  fef  : local fixed-end forces (mutated in place)
//  dofs : local DOF indices to release
// ──────────────────────────────────────────────────────────────────
function applyEndReleases(kl, fef, dofs) {
  if (!dofs || !dofs.length) return;
  const n = kl.length;
  for (const r of dofs) {
    if (r < 0 || r >= n) continue;
    const krr = kl[r][r];
    if (!(Math.abs(krr) > 1e-20)) continue;   // already released, or no stiffness there
    const fr = fef ? fef[r] : 0;
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      const kir = kl[i][r];
      if (kir === 0) continue;
      for (let j = 0; j < n; j++) {
        if (j === r) continue;
        kl[i][j] -= kir * kl[r][j] / krr;
      }
      if (fef) fef[i] -= kir * fr / krr;
    }
    for (let i = 0; i < n; i++) { kl[i][r] = 0; kl[r][i] = 0; }
    if (fef) fef[r] = 0;
  }
}

// Which local DOFs a member's release flags correspond to.
//   2D (6 DOF/node-pair): the in-plane rotation, 2 at end 1 and 5 at end 2.
//   3D (12): both bending rotations at that end — a moment release frees
//   bending about y and z while axial, shear and torsion still transfer.
function releasedDofs2D(bm) {
  const d = [];
  if (bm && bm.hingeStart) d.push(2);
  if (bm && bm.hingeEnd)   d.push(5);
  return d;
}
function releasedDofs3D(bm) {
  const d = [];
  if (bm && bm.hingeStart) d.push(4, 5);
  if (bm && bm.hingeEnd)   d.push(10, 11);
  return d;
}


// Cubic Hermite interpolation of the end DOFs at ξ = x/L (local transverse).
function hermiteLocal2D(xi, L, v1, th1, v2, th2) {
  const x2 = xi * xi, x3 = x2 * xi;
  const N1 = 1 - 3 * x2 + 2 * x3;
  const N2 = L * (xi - 2 * x2 + x3);
  const N3 = 3 * x2 - 2 * x3;
  const N4 = L * (x3 - x2);
  return N1 * v1 + N2 * th1 + N3 * v2 + N4 * th2;
}

// ──────────────────────────────────────────────────────────────────
//  Peak transverse deflection along a member, in metres.
//  Samples the deflected shape (Hermite + particular) and returns the largest
//  magnitude together with where it occurs.
//
//  `chord` — optional { v1, v2 }: the transverse displacement of the SPAN's
//  chord at this element's own two ends, already projected onto this element's
//  local transverse axis. Supply it and the result is measured from that chord,
//  which is what a span deflection limit (L/250, L/300 …) is written against.
//
//  Without it the result is the ABSOLUTE transverse displacement, which
//  includes the rigid-body translation and rotation of the member's ends — an
//  unloaded simply supported beam with one support settled 20 mm carries zero
//  moment and stays perfectly straight, yet measures 20 mm. Subtracting the
//  chord of the ELEMENT alone is not the answer either: a span split into
//  several elements then measures each piece against its own chord and the real
//  sag disappears.
//
//  DesignChecks.buildSpans chains collinear elements between supports and
//  DesignChecks.spanDeflection walks the chain supplying this chord, so both
//  the design check and the results panel measure the whole physical member.
//  Callers that pass no chord still get the old absolute value.
// ──────────────────────────────────────────────────────────────────
function maxDeflLocal2D(ef, loads, EI, samples, chord) {
  const L = ef && ef.L;
  if (!(L > 0)) return { v: 0, x: 0 };
  const n = samples || 21;
  const c = ef.c !== undefined ? ef.c : 1;
  const s = ef.s !== undefined ? ef.s : 0;

  // End displacements are global; project onto the local transverse axis.
  const v1g = (ef.w1 !== undefined) ? ef.w1 : (ef.v1 || 0);
  const v2g = (ef.w2 !== undefined) ? ef.w2 : (ef.v2 || 0);
  const v1 = -s * (ef.u1 || 0) + c * v1g;
  const v2 = -s * (ef.u2 || 0) + c * v2g;
  const th1 = ef.t1 !== undefined ? ef.t1 : (ef['θz1'] || 0);
  const th2 = ef.t2 !== undefined ? ef.t2 : (ef['θz2'] || 0);

  const lds = loads || ef.loads || [];
  // The span chord is straight, so within this element it is linear between the
  // two values supplied. hermiteLocal2D reproduces a rigid-body move exactly,
  // so what is left after the subtraction is pure bending.
  const k1 = chord ? (chord.v1 || 0) : 0;
  const k2 = chord ? (chord.v2 || 0) : 0;
  const at = x => hermiteLocal2D(x / L, L, v1, th1, v2, th2)
                - (k1 + (k2 - k1) * (x / L))
                + (EI > 0 ? spanDeflLocal2D(lds, ef.id, L, c, s, EI, x) : 0);

  let best = 0, bestX = 0;
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * L;
    const v = at(x);
    if (Math.abs(v) > Math.abs(best)) { best = v; bestX = x; }
  }

  // Refine within the bracketing interval — a coarse grid rarely lands on the
  // peak, and the reported location is shown to the user. Ternary search on
  // |v| over [bestX − h, bestX + h] converges in a handful of steps.
  let lo = Math.max(0, bestX - L / n), hi = Math.min(L, bestX + L / n);
  for (let k = 0; k < 40 && hi - lo > 1e-9 * L; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (Math.abs(at(m1)) < Math.abs(at(m2))) lo = m1; else hi = m2;
  }
  const xr = (lo + hi) / 2, vr = at(xr);
  if (Math.abs(vr) > Math.abs(best)) { best = vr; bestX = xr; }

  return { v: best, x: bestX };
}

function solveFrame(nodes, beams, sections, loads, settlements) {
  const n = nodes.length;
  if (n === 0) return { error: 'No nodes defined.' };
  if (beams.length === 0) return { error: 'No beams defined.' };

  const ndof = n * 3;

  // ── Index maps ───────────────────────────────────────────────────
  const nIdx = {};
  nodes.forEach((nd, i) => { nIdx[nd.id] = i; });
  const secMap = {};
  sections.forEach(s => { secMap[s.id] = s; });

  // ── Global K and load vector ─────────────────────────────────────
  const K = zeros2d(ndof);   // full stiffness matrix (no penalty)
  // Which DOFs actually receive stiffness. Recording this during assembly
  // costs nothing; deriving it afterwards means scanning every row of a dense
  // ndof x ndof matrix, which was 46 % of total solve time on an 841-node
  // frame — more than the factorisation it was meant to protect.
  const touched = new Uint8Array(ndof);
  const F = new Float64Array(ndof);
  const elemData = [];

  // Members the assembly could not use. Skipping them silently is what turns a
  // simple modelling slip into 'Structural matrix is singular': a beam with no
  // section contributes no stiffness, so a one-member model has nothing left to
  // solve and the error names neither the member nor the reason.
  const skipped = [];

  // ── Assemble element stiffness matrices ──────────────────────────
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

    const dx  = nj.x - ni.x;
    const dy  = nj.y - ni.y;
    const dzZ = (nj.z || 0) - (ni.z || 0);
    // Z-lifted 2D structures: height stored in nd.z with nd.y===0.
    // Use dz as the vertical component when dy is zero but dz is not.
    const dy_eff = (Math.abs(dy) < 1e-10 && Math.abs(dzZ) > 1e-10) ? dzZ : dy;
    const L0 = Math.hypot(dx, dy_eff);   // true geometric length
    if (L0 < 1e-10) {
      skipped.push(`member ${bm.id} has zero length — its two nodes are at the same point`);
      continue;
    }

    // Direction cosines come from the GEOMETRIC length and nothing else. They
    // used to be taken after the rigid-zone reduction below, from the shortened
    // L, so c² + s² came out as (L0/Leff)² — 1.29 for a 5 m member with 0.6 m of
    // offsets — instead of 1. T stopped being a rotation, which inflated every
    // term of Ke by that factor on top of the intended shortening and inflated
    // the transformed fixed-end forces with it: a portal with a 60 kN UDL
    // reported 66.7 kN of reaction. Global equilibrium is insensitive to the
    // scaling of c and s (Ke still annihilates rigid-body translation whatever
    // T is), which is why no equilibrium check ever caught it.
    const c = dx / L0, s = dy_eff / L0;

    // ── Automatic Rigid Zone (ETABS-style) ─────────────────────────
    // Only the STIFFNESS uses the reduced length — the span load still acts over
    // the full physical member, so the fixed-end forces below are formed on L0.
    const L = rigidZoneLength(bm, sec, beams, secMap, L0);

    // Unit conversions: E [GPa→kN/m²] ×1e6, A [cm²→m²] ÷1e4, I [cm⁴→m⁴] ÷1e8
    const E  = (sec.E  || 0) * 1e6;
    const A  = (sec.A  || 0) / 1e4;
    const Iv = ((sec.Ix || sec.I) || 0) / 1e8;   // use Ix if present (3D sections)

    // Apply stiffness modifiers (same as ETABS modifier feature)
    // ?? not || : a modifier of exactly 0 is a real ETABS input meaning "no
    // stiffness in this direction", and `|| 1` silently turned it into full
    // stiffness. The degenerate-section branch below now reports it instead.
    const mf11 = stiffMod(bm, sec, 'f11');
    const mfi3 = stiffMod(bm, sec, 'fi3');
    const EA  = E * A * mf11;
    const EI  = E * Iv * mfi3;

    // A section with a non-positive E, A or I carries no stiffness. This used
    // to `continue` silently, so the member vanished from the assembly and the
    // solve failed further down as 'Structural matrix is singular — check that
    // every member is connected and that the supports prevent rigid-body
    // movement'. That sends the user hunting through their supports when the
    // real cause is a zero or negative number in the section table, which the
    // inputs happily accept. Name the section and the offending value instead,
    // the way the missing-node and zero-length cases above already do.
    if (EA < 1e-20 || EI < 1e-20) {
      const bad = [];
      if (!(+sec.E > 0)) bad.push(`E = ${sec.E}`);
      if (!(+sec.A > 0)) bad.push(`A = ${sec.A}`);
      const Iraw = (sec.Ix != null ? sec.Ix : sec.I);
      if (!(+Iraw > 0)) bad.push(`I = ${Iraw}`);
      if (bad.length) {
        skipped.push(`member ${bm.id} uses section "${sec.name || sec.id}" with ` +
                     `${bad.join(', ')} — E, A and I must all be greater than zero`);
      } else {
        // Properties are fine, so a stiffness modifier has zeroed them.
        skipped.push(`member ${bm.id} has a stiffness modifier that leaves it with ` +
                     `no stiffness (f11 = ${mf11}, fi3 = ${mfi3})`);
      }
      continue;
    }

    const EAL  = EA / L;
    const EIL  = EI / L;
    const EIL2 = EI / (L * L);
    const EIL3 = EI / (L * L * L);

    // Local 6×6 stiffness (Euler-Bernoulli beam-column)
    const kl = [
      [ EAL,        0,        0,     -EAL,        0,        0    ],
      [   0,  12*EIL3,  6*EIL2,        0,  -12*EIL3,  6*EIL2   ],
      [   0,   6*EIL2,   4*EIL,        0,   -6*EIL2,   2*EIL   ],
      [-EAL,        0,        0,      EAL,        0,        0    ],
      [   0, -12*EIL3, -6*EIL2,        0,   12*EIL3, -6*EIL2   ],
      [   0,   6*EIL2,   2*EIL,        0,   -6*EIL2,   4*EIL   ]
    ];

    // Rotation matrix (local → global)
    const T = [
      [ c,  s, 0,  0,  0, 0],
      [-s,  c, 0,  0,  0, 0],
      [ 0,  0, 1,  0,  0, 0],
      [ 0,  0, 0,  c,  s, 0],
      [ 0,  0, 0, -s,  c, 0],
      [ 0,  0, 0,  0,  0, 1]
    ];

    // ── Fixed-End Forces (FEF) from distributed/point loads ─────────
    // Formed on the FULL length: a UDL acts over the whole physical member
    // whether or not its ends sit in rigid zones, and ΣFEF must equal the load
    // actually applied or global equilibrium breaks.
    const fef = fefLocal2D(loads, bm.id, L0, c, s);

    // ── Member end releases (moment hinges) ─────────────────────────
    // Condense the released rotations out of kl and fef TOGETHER, before Ke
    // and the load vector are formed from them — the element then carries no
    // moment at that end and its equivalent nodal loads are the released ones.
    applyEndReleases(kl, fef, releasedDofs2D(bm));

    // Ke = Tᵀ · kl · T  (global 6×6), from the CONDENSED kl
    const Ke = mmul(mmul(mT(T), kl), T);

    const ii = nIdx[bm.node1], ij = nIdx[bm.node2];
    const dofs = [ii*3, ii*3+1, ii*3+2, ij*3, ij*3+1, ij*3+2];

    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++)
        K[dofs[a]][dofs[b]] += Ke[a][b];
    for (let a = 0; a < 6; a++) if (Ke[a][a] !== 0) touched[dofs[a]] = 1;

    // Equivalent nodal loads in global coords → add to F
    const fef_g = mvmul(mT(T), Array.from(fef));
    for (let a = 0; a < 6; a++) F[dofs[a]] += fef_g[a];

    // L reported downstream is the physical length — diagrams, deflection
    // sampling and design checks all span the real member, not the flexible part.
    elemData.push({ bm, ni, nj, ii, ij, L: L0, c, s, T, kl, Ke, fef: Array.from(fef), dofs });
  }

  // ── Nodal loads ──────────────────────────────────────────────────
  for (const ld of loads) {
    if (ld.type === 'nodal' || ld.type === 'moment') {
      const i = nIdx[ld.nodeId];
      if (i === undefined) continue;
      F[i*3]   += ld.fx || 0;
      F[i*3+1] += ld.fy || 0;
      F[i*3+2] += ld.m  || 0;
    }
  }

  // ── Spring supports — add stiffness to K directly ────────────────
  // Remember what was added per DOF: the reaction recovery below needs to take
  // it back out again (see the note there).
  const springK = new Float64Array(ndof);
  for (const nd of nodes) {
    if (nd.support !== 'spring') continue;
    const i = nIdx[nd.id];
    if (nd.springKx) { K[i*3]  [i*3]   += nd.springKx; springK[i*3]   += nd.springKx; }
    if (nd.springKy) { K[i*3+1][i*3+1] += nd.springKy; springK[i*3+1] += nd.springKy; }
    if (nd.springKm) { K[i*3+2][i*3+2] += nd.springKm; springK[i*3+2] += nd.springKm; }
    if (nd.springKx) touched[i*3]   = 1;
    if (nd.springKy) touched[i*3+1] = 1;
    if (nd.springKm) touched[i*3+2] = 1;
  }

  // ── Identify constrained DOFs and settlement values ──────────────
  const constrained = new Set();   // DOFs with prescribed displacement
  const settleVal   = new Map();   // dof → settlement value (m or rad)

  for (const nd of nodes) {
    const i = nIdx[nd.id];
    if (nd.support === 'pin')     { constrained.add(i*3); constrained.add(i*3+1); }
    if (nd.support === 'fixed')   { constrained.add(i*3); constrained.add(i*3+1); constrained.add(i*3+2); }
    if (nd.support === 'roller')  { constrained.add(i*3+1); }
    if (nd.support === 'rollerH') { constrained.add(i*3); }
  }
  for (const st of (settlements || [])) {
    const i = nIdx[st.nodeId];
    if (i === undefined) continue;
    const dof = i*3 + (st.dir === 'u' ? 0 : st.dir === 'v' ? 1 : 2);
    constrained.add(dof);
    settleVal.set(dof, st.value || 0);
  }

  // ── Rotations left with no stiffness by an end release ───────────
  // Releasing every member framing into a node leaves that node's rotation
  // attached to nothing: its row in K is all zeros. That is not a mechanism —
  // the rotation genuinely has no effect on anything — but a zero pivot would
  // fail the solve, so a pin-jointed truss modelled with releases could never
  // be analysed. Constrain those DOFs instead; with no stiffness AND no
  // applied moment the equation is 0 = 0 and fixing them changes no result.
  //
  // A DOF with no stiffness but a real applied moment IS a mechanism, so it is
  // deliberately left free for the singularity check to catch.
  let danglingRot = 0;
  for (const nd of nodes) {
    const d = nIdx[nd.id] * 3 + 2;          // the rotational DOF
    if (constrained.has(d)) continue;
    if (!touched[d] && Math.abs(F[d]) < 1e-12) { constrained.add(d); danglingRot++; }
  }

  // ── DOF partitioning ─────────────────────────────────────────────
  const freeDofs = [];
  for (let d = 0; d < ndof; d++) if (!constrained.has(d)) freeDofs.push(d);
  const nf = freeDofs.length;

  // Say this before anything else. A model whose members were all discarded
  // cannot be solved, and the reason is concrete and fixable — far more use
  // than the singular-matrix message it would otherwise reach.
  if (skipped.length === beams.length && beams.length > 0)
    return { error: `No member could be analysed: ${skipped.join('; ')}. ` +
                    'Assign a section to every member (Define ▸ Sections), then solve again.' };

  if (nf === 0) return { error: 'All DOFs constrained — check supports.' };
  // A spring support restrains the structure by adding stiffness to K rather
  // than by constraining a DOF, so nf === ndof is legitimate when springs are
  // present. Rejecting it outright made every spring-supported model fail with
  // "add supports" even though it was perfectly solvable — the singularity
  // check on gaussSolve below still catches a genuine mechanism.
  const hasSpring = nodes.some(nd => nd.support === 'spring' &&
                                     (nd.springKx || nd.springKy || nd.springKm));
  if (nf === ndof && !hasSpring) return { error: 'Structure is a mechanism — add supports.' };

  // Prescribed displacement vector (zeros for fixed DOFs, settlement value for settlements)
  const U_c = [];
  [...constrained].forEach(d => U_c.push(settleVal.get(d) || 0));
  const constArr = [...constrained];

  // RHS: F_f − K_fc · U_c   (only the constrained columns are needed)
  const RHS = freeDofs.map((d) => {
    let rhs = F[d];
    for (let j = 0; j < constArr.length; j++) rhs -= K[d][constArr[j]] * U_c[j];
    return rhs;
  });

  // ── Solve K_ff · U_f = RHS ───────────────────────────────────────
  // Banded LDLᵀ first: same answer, O(n·b²) instead of O(n³), and it never
  // materialises K_ff. It declines (returns null) when the matrix is not
  // positive definite — a mechanism, or numerically nasty — and the dense
  // pivoting path then decides, so this can only ever be faster, not different.
  let U_f = null;
  const bw = bandwidthOf(elemData, freeDofs, ndof);
  if (nf > 12 && bw > 0 && bw < nf / 2) U_f = bandSolve(K, freeDofs, RHS, bw);
  if (!U_f) {
    const K_ff = freeDofs.map(r => freeDofs.map(c2 => K[r][c2]));
    U_f = gaussSolve(K_ff, RHS);
  }
  if (!U_f) {
    // 'Check supports / connectivity' tells the engineer nothing they had not
    // already guessed. Almost every singular 2D frame is missing restraint in
    // one specific direction, and that is cheap to work out from the supports
    // that are there — so say which one.
    let holdsX = false, holdsY = false, holdsR = false, nSup = 0;
    for (const nd of nodes) {
      const sp = nd.support;
      const spr = nd.spring || {};
      if (sp && sp !== 'none') nSup++;
      if (sp === 'pin' || sp === 'fixed' || sp === 'rollerH' || spr.kx > 0) holdsX = true;
      if (sp === 'pin' || sp === 'fixed' || sp === 'roller'  || spr.ky > 0) holdsY = true;
      if (sp === 'fixed' || spr.kr > 0) holdsR = true;
    }
    let why;
    if (nSup === 0)      why = 'No supports are defined, so the frame is free to move as a rigid body.';
    else if (!holdsX)    why = 'Nothing restrains horizontal movement — every support is a roller, ' +
                               'so the frame can slide sideways. Make one of them a pin.';
    else if (!holdsY)    why = 'Nothing restrains vertical movement, so the frame can drop as a ' +
                               'rigid body. Add a pin, a roller or a fixed support.';
    else if (nSup === 1 && !holdsR)
                         why = 'Only one support, and it does not resist rotation, so the frame ' +
                               'can spin about it. Add a second support or fix the first.';
    else                 why = 'Check that every member is connected and that the supports ' +
                               'prevent rigid-body movement.';
    // A partly-assembled model is the likeliest cause of the rest, so lead
    // with the members that were dropped rather than the supports.
    if (skipped.length)
      return { error: `Structural matrix is singular. ${skipped.length} member` +
                      `${skipped.length === 1 ? ' was' : 's were'} left out of the analysis: ` +
                      `${skipped.join('; ')}.` };
    return { error: 'Structural matrix is singular. ' + why };
  }

  // ── Sanity bound on the answer ───────────────────────────────────
  //
  // A near-mechanism is not singular — it factorises cleanly and returns a
  // number. Two collinear members with almost no bending stiffness, pinned at
  // both ends, come back with 992 km of mid-span deflection: a perfectly
  // well-conditioned solution to a model that is physically a mechanism. The
  // pivot test cannot see this, because nothing about the arithmetic is
  // degenerate — only the answer is absurd.
  //
  // Compare the largest displacement against the model's own size. A structure
  // deflecting further than 100x its own extent is not a structure, and saying
  // so is far more useful than handing back a plausible-looking table of
  // enormous numbers.
  let span = 0;
  {
    const xs = nodes.map(nd => nd.x || 0);
    const ys = nodes.map(nd => (Math.abs(nd.y || 0) > 1e-12 ? nd.y : (nd.z || 0)));
    span = Math.hypot(Math.max(...xs) - Math.min(...xs),
                      Math.max(...ys) - Math.min(...ys));
  }
  if (span > 0) {
    let uMax = 0;
    for (let i = 0; i < U_f.length; i++) {
      const v = Math.abs(U_f[i]);
      if (v > uMax) uMax = v;
    }
    if (uMax > 100 * span) {
      return { error: 'Structure is effectively a mechanism — the solution is ' +
                      `physically meaningless (peak displacement ${uMax.toExponential(2)} m ` +
                      `against a ${span.toFixed(2)} m model). Check supports, releases ` +
                      'and that every member has a real section.' };
    }
  }

  // ── Reconstruct full displacement vector ─────────────────────────
  const U = new Array(ndof).fill(0);
  freeDofs.forEach((d, i) => { U[d] = U_f[i]; });
  constArr.forEach((d, i)  => { U[d] = U_c[i]; });

  // ── Reactions: R_c = K_cf · U_f + K_cc · U_c − F_ext_c ─────────
  // Build F_ext (external forces, no FEF) for reaction correction
  const F_ext = new Float64Array(ndof);
  for (const ld of loads) {
    if (ld.type === 'nodal' || ld.type === 'moment') {
      const i = nIdx[ld.nodeId];
      if (i === undefined) continue;
      F_ext[i*3]   += ld.fx || 0;
      F_ext[i*3+1] += ld.fy || 0;
      F_ext[i*3+2] += ld.m  || 0;
    }
  }
  for (const ed of elemData) {
    const fef_g = mvmul(mT(ed.T), ed.fef);
    for (let a = 0; a < 6; a++) F_ext[ed.dofs[a]] += fef_g[a];
  }

  // A spring's stiffness lives inside K, so at a spring DOF the equilibrium
  // equation K·U = F is satisfied exactly and `K·U − F_ext` is identically
  // zero — the spring force never appeared in the reaction at all. A pin-plus-
  // spring beam under 60 kN reported ΣRy = 30. The reaction wanted is the force
  // the spring applies to the structure, −k·u, which is what removing the spring
  // row's own contribution leaves behind:
  //     R = (K − K_spring)·U − F_ext = −k·u
  const reactions = {};
  nodes.forEach(nd => {
    reactions[nd.id] = { Rx: 0, Ry: 0, M: 0 };
    if (!nd.support || nd.support === 'none') return;
    const i = nIdx[nd.id];
    // Reaction = K_struct · U - F_ext  (at support rows — exact with DOF partitioning)
    let Rx = 0, Ry = 0, M = 0;
    for (let j = 0; j < ndof; j++) {
      Rx += K[i*3]   [j] * U[j];
      Ry += K[i*3+1] [j] * U[j];
      M  += K[i*3+2] [j] * U[j];
    }
    Rx -= springK[i*3]   * U[i*3];
    Ry -= springK[i*3+1] * U[i*3+1];
    M  -= springK[i*3+2] * U[i*3+2];
    reactions[nd.id].Rx = Rx - F_ext[i*3];
    reactions[nd.id].Ry = Ry - F_ext[i*3+1];
    reactions[nd.id].M  = M  - F_ext[i*3+2];
  });

  // ── Element end forces ────────────────────────────────────────────
  const elemForces = [];
  for (const ed of elemData) {
    const { bm, ii, ij, L, T, kl, fef, dofs } = ed;
    const u_g = dofs.map(d => U[d]);
    const u_l = mvmul(T, u_g);

    // f = kl·u_l − fef  (recover true member forces correcting for FEF)
    const f_l = kl.map((row, r) => row.reduce((s, v, c) => s + v * u_l[c], 0) - fef[r]);

    elemForces.push({
      id:  bm.id,
      N1:  f_l[0],  V1:  f_l[1],  M1:  f_l[2],
      N2: -f_l[3],  V2: -f_l[4],  M2: -f_l[5],
      L,
      x1: ed.ni.x, y1: ed.ni.y, z1: ed.ni.z || 0,
      x2: ed.nj.x, y2: ed.nj.y, z2: ed.nj.z || 0,
      c: ed.c, s: ed.s,
      // Nodal displacements in global coords (v = vertical/Z direction)
      u1: U[ii*3], v1: U[ii*3+1], t1: U[ii*3+2],
      u2: U[ij*3], v2: U[ij*3+1], t2: U[ij*3+2],
      loads: loads.filter(ld => ld.elementId === bm.id)
    });
  }

  const disp = {};
  nodes.forEach(nd => {
    const i = nIdx[nd.id];
    disp[nd.id] = { u: U[i*3], v: U[i*3+1], theta: U[i*3+2] };
  });

  return { success: true, disp, elemForces, reactions,
           // How many node rotations an end release left with no stiffness.
           // Useful when a model behaves unexpectedly after adding hinges.
           releasedRotations: danglingRot };
}

// ── Matrix utilities ──────────────────────────────────────────────
function zeros2d(n) {
  // Float64Array rows rather than plain Arrays: a contiguous typed buffer with
  // no boxing, allocated zeroed. On a 3675-DOF frame this cut the assembly
  // allocation from 158 ms to a few, and the rows stay cache-friendly for the
  // banded extraction that follows.
  return Array.from({ length: n }, () => new Float64Array(n));
}

function mmul(A, B) {
  const m = A.length, k = A[0].length, n = B[0].length;
  const C = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i++)
    for (let p = 0; p < k; p++) {
      if (A[i][p] === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += A[i][p] * B[p][j];
    }
  return C;
}

function mT(A) {
  return A[0].map((_, j) => A.map(r => r[j]));
}

function mvmul(A, v) {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

// ──────────────────────────────────────────────────────────────────
//  Banded symmetric solver (LDLᵀ) for the free-DOF system.
//
//  A stiffness matrix is symmetric and, for a properly supported structure,
//  positive definite — and its non-zeros hug the diagonal, because a DOF only
//  couples to DOFs on members that touch it. Dense Gauss ignores both facts and
//  costs O(n³): a 1225-node frame (3675 DOF) took 7.4 s and 206 MB, while its
//  half-bandwidth was only 108.
//
//  Working inside the band costs O(n·b²) instead. Measured on the same matrices:
//  37x faster at 3675 DOF, agreeing with the dense result to 1.8e-15, and the
//  gap widens as n²/b². It also avoids ever materialising K_ff (nf² doubles) or
//  the working copy gaussSolve makes of it.
//
//  LDLᵀ takes no pivots, which is safe for a positive-definite matrix and is
//  what keeps the band intact — pivoting would destroy it. A non-positive pivot
//  means the matrix is NOT positive definite, i.e. a mechanism or something
//  badly conditioned; the caller then falls back to the pivoting dense path so
//  behaviour is never worse than before.
//
//  Returns null when the band solve is not applicable or not trustworthy.
// ──────────────────────────────────────────────────────────────────
// The band only ever comes from element connectivity — K has an entry at (i,j)
// exactly when some element joins those two DOFs. Deriving it from elemData is
// O(elements) instead of the O(nf x ndof) scan of a dense matrix that reading
// it back out of K required.
function bandwidthOf(elemData, freeDofs, ndof) {
  const pos = new Int32Array(ndof).fill(-1);
  for (let i = 0; i < freeDofs.length; i++) pos[freeDofs[i]] = i;
  let bw = 0;
  for (const ed of elemData) {
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < ed.dofs.length; a++) {
      const q = pos[ed.dofs[a]];
      if (q < 0) continue;                 // constrained — not in the reduced system
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }
    if (hi > lo && hi - lo > bw) bw = hi - lo;
  }
  return bw;
}

function bandSolve(K, freeDofs, rhs, bw) {
  const n = freeDofs.length;
  if (n === 0) return null;

  // Upper band, row-major: A[i][j] holds K_ff[i][i+j] for j = 0..bw.
  const A = [];
  for (let i = 0; i < n; i++) A.push(new Float64Array(bw + 1));
  for (let i = 0; i < n; i++) {
    const row = K[freeDofs[i]];
    const hi = Math.min(bw, n - 1 - i);
    for (let j = 0; j <= hi; j++) A[i][j] = row[freeDofs[i + j]];
  }

  // Scale reference for judging pivots, same spirit as the dense path.
  let scale = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(A[i][0]); if (v > scale) scale = v; }
  if (!(scale > 0)) return null;
  const TOL = 1e-12 * scale;

  // LDLᵀ in place: A[i][0] becomes d_i, A[i][j>0] becomes L's off-diagonals
  // scaled by d_i (stored as the original u_ij so the substitutions stay simple).
  for (let i = 0; i < n; i++) {
    // Subtract the contributions of the previous rows within the band.
    const lo = Math.max(0, i - bw);
    for (let k = lo; k < i; k++) {
      const off = i - k;
      const u = A[k][off];
      if (u === 0) continue;
      const lik = u / A[k][0];
      const hi = Math.min(bw, n - 1 - i);
      for (let j = 0; j <= hi; j++) {
        const kj = off + j;
        if (kj <= bw) A[i][j] -= lik * A[k][kj];
      }
    }
    if (!(Math.abs(A[i][0]) > TOL) || A[i][0] < 0) return null;   // not positive definite
  }

  // Forward: L·z = b  (L unit lower, l_ki = A[k][i-k]/A[k][0])
  const z = Float64Array.from(rhs);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - bw);
    for (let k = lo; k < i; k++) {
      const u = A[k][i - k];
      if (u !== 0) z[i] -= (u / A[k][0]) * z[k];
    }
  }
  // Diagonal then back substitution: D·Lᵀ·x = z
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i] / A[i][0];
    const hi = Math.min(bw, n - 1 - i);
    for (let j = 1; j <= hi; j++) s -= (A[i][j] / A[i][0]) * x[i + j];
    x[i] = s;
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return Array.from(x);
}


// Gauss elimination with partial pivoting — solves Ax = b in place
//
// Singularity is judged against each row's own magnitude, not an absolute
// floor. Stiffness entries run to ~1e6 kN/m, so the old `|piv| < 1e-30` test
// could not fire on anything a real model produces: a near-mechanism factorises
// with a pivot around 1e-4 in absolute terms, passes the test, and returns
// enormous displacements that look like an answer. solver3d.js already judges
// it this way; the 2D path had been left behind.
function gaussSolve(Ain, bin) {
  const n = bin.length;
  const A = Ain.map(r => [...r]);
  const b = [...bin];

  const REL_TOL = 1e-12;
  // Row scale = largest magnitude in the original row; follows its row through
  // the pivot swaps.
  const scaleOf = A.map(row => {
    let m = 0;
    for (let j = 0; j < n; j++) { const v = Math.abs(row[j]); if (v > m) m = v; }
    return m;
  });

  for (let col = 0; col < n; col++) {
    // Scaled partial pivoting — compare each candidate against its own row's
    // magnitude so a stiff row does not automatically win every contest.
    let maxR = col, best = -1;
    for (let r = col; r < n; r++) {
      const sc = scaleOf[r] > 0 ? scaleOf[r] : 1;
      const v  = Math.abs(A[r][col]) / sc;
      if (v > best) { best = v; maxR = r; }
    }
    [A[col], A[maxR]] = [A[maxR], A[col]];
    [b[col], b[maxR]] = [b[maxR], b[col]];
    [scaleOf[col], scaleOf[maxR]] = [scaleOf[maxR], scaleOf[col]];

    const piv   = A[col][col];
    const scale = scaleOf[col] > 0 ? scaleOf[col] : 1;
    if (!(Math.abs(piv) >= REL_TOL * scale)) return null;   // singular (or NaN)

    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / piv;
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[r][j] -= f * A[col][j];
      b[r] -= f * b[col];
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const scale = scaleOf[i] > 0 ? scaleOf[i] : 1;
    if (!(Math.abs(A[i][i]) >= REL_TOL * scale)) return null;
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}
