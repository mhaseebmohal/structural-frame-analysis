// ══════════════════════════════════════════════════════════════════════════════
//  checks.js  —  Detailed EC3 / AISC Structural Design Checks
//  Covers: Section Classification, Flexure (LTB), Shear, Axial/Buckling,
//          Torsion (St. Venant + Warping), Modification Factors, Interaction
//  Units : kN, m, kNm  (all internal)
//  Ref   : EN 1993-1-1:2005 + EN 1993-1-3, EN 1992-1-1 (RC notes)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const DesignChecks = (() => {

  // ── Member label helper (C=column, B=beam, BR=brace) ─────────────────────
  function _memberLabel(bm) {
    if (bm.memberType && bm.memberType !== 'auto') {
      if (bm.memberType === 'column') return 'C' + bm.id;
      if (bm.memberType === 'brace')  return 'BR' + bm.id;
      return 'B' + bm.id;
    }
    // Auto-detect from geometry stored on bm (ef has coordinates)
    return 'B' + bm.id; // fallback; App's getMemberLabel is more accurate
  }

  // ── Safety factors (EC3) ─────────────────────────────────────────────────
  const γM0 = 1.00;   // cross-section resistance
  const γM1 = 1.00;   // member stability
  const γM2 = 1.25;   // net cross-section / bolts

  // ── Buckling curve lookup (EC3 Table 6.2) ───────────────────────────────
  // Returns imperfection factor α for buckling curve a0/a/b/c/d
  const ALPHA = { a0: 0.13, a: 0.21, b: 0.34, c: 0.49, d: 0.76 };

  // ── EC3 Table 6.2 — buckling curve for rolled I-sections ─────────────────
  //
  //   h/b > 1.2   tf ≤  40 mm      y-y: a    z-z: b
  //               40 < tf ≤ 100    y-y: b    z-z: c
  //   h/b ≤ 1.2   tf ≤ 100 mm      y-y: b    z-z: c
  //   any         tf > 100 mm      y-y: d    z-z: d
  //
  // Thicknesses are compared in cm (the /10 below), so 4.0 = 40 mm and
  // 10.0 = 100 mm.
  //
  // The y-y lookup previously tested `tf <= 10.0` twice in the h/b ≤ 1.2
  // branch, making the second test unreachable, and returned curve 'c' for
  // very thick flanges with h/b > 1.2 where the table calls for 'd'. Curve 'c'
  // has α = 0.49 against 0.76 for 'd', so that path overestimated χ and
  // reported more axial capacity than EC3 allows.
  function _curveInputs(sec) {
    const h  = (sec.d  || 200) / 10;   // mm→cm
    const bf = (sec.bf || 100) / 10;
    const tf = (sec.tf || 10)  / 10;
    return { ratio: h / bf, tf };
  }

  function bucklingCurveY(sec) {
    if (sec._type === 'CHS' || sec._type === 'SHS') return 'a';
    const { ratio, tf } = _curveInputs(sec);
    if (tf > 10.0) return 'd';               // tf > 100 mm, either aspect ratio
    if (ratio > 1.2) return tf <= 4.0 ? 'a' : 'b';
    return 'b';
  }

  function bucklingCurveZ(sec) {
    if (sec._type === 'CHS' || sec._type === 'SHS') return 'a';
    const { ratio, tf } = _curveInputs(sec);
    if (tf > 10.0) return 'd';               // tf > 100 mm, either aspect ratio
    if (ratio > 1.2) return tf <= 4.0 ? 'b' : 'c';
    return 'c';
  }

  // χ (chi) from EC3 6.49 / 6.50 ──────────────────────────────────────────
  function chiFromLambda(lambdaBar, curve) {
    const α = ALPHA[curve] || 0.34;
    const Φ = 0.5 * (1 + α * (lambdaBar - 0.2) + lambdaBar * lambdaBar);
    const chi = 1 / (Φ + Math.sqrt(Φ * Φ - lambdaBar * lambdaBar));
    return Math.min(1.0, chi);
  }

  // ── Status classification ───────────────────────────────────────────────
  //
  // Checks across the three code modules report qualified statuses as well as
  // bare ones: 'FAIL (strut)', 'FAIL (punching)', 'FAIL (uplift)',
  // 'WARN (slender—2nd order)', 'OK (no links needed)'. Every consumer tested
  // `status === 'FAIL'` for exact equality, so a member whose EC2 compression
  // strut had crushed — or whose footing had failed in punching — carried a
  // check flagged FAIL (strut) and still rolled up to an overall verdict of OK.
  //
  // Returns one of 'FAIL' | 'NEAR' | 'OK' | 'INFO'. 'LINKS REQ.' is a normal
  // design outcome (provide the links), not a failure, so it maps to OK.
  function classifyStatus(status) {
    if (typeof status !== 'string') return 'INFO';
    const s = status.trim().toUpperCase();
    if (s.startsWith('FAIL')) return 'FAIL';
    if (s.startsWith('WARN') || s.startsWith('NEAR')) return 'NEAR';
    if (s.startsWith('INFO')) return 'INFO';
    return 'OK';
  }

  // ── Section classification (EC3 Table 5.2) ──────────────────────────────
  function classifySection(sec, N_Ed = 0) {
    const fy = (sec.fy  || 275);           // MPa = N/mm²
    const ε  = Math.sqrt(235 / fy);

    // EC3 classification describes the local buckling of thin STEEL plates, so
    // it needs real flange/web thicknesses. Without them the old code invented
    // tf = 10 mm and tw = 6 mm, which turned a solid 400×400 concrete column
    // into a Class 4 slender plate girder and reported FAIL on a member running
    // at 23 % utilisation. When there is no plate data, say "not applicable"
    // instead of inventing it — the same way the plate-buckling check does.
    if (sec.tf == null && sec.tw == null) {
      return {
        cls: null, notApplicable: true, epsilon: ε,
        note: 'Section classification not applicable — no flange/web thickness ' +
              'on this section (EC3 §5.5 applies to plated steel sections).'
      };
    }

    // Convert dimensions mm → mm (already mm in DB)
    const d  = sec.d  || sec.h  || 200;   // total depth mm
    const bf = sec.bf || sec.b  || 100;   // flange width mm
    const tf = sec.tf || 10;              // flange thickness mm
    const tw = sec.tw || 6;               // web thickness mm
    const r  = sec.r  || 0;              // root radius mm

    // Stress ratio α for web under combined N+M
    // simplified: ψ = -1 (pure bending) unless N_Ed is significant

    // ── Flange classification (outstand) ──────────────────────────────────
    // c = (bf - tw - 2r) / 2  [mm]
    const c_flange = (bf - tw - 2 * r) / 2;
    let flangeCls = 4;
    if (c_flange / tf <= 9  * ε) flangeCls = 1;
    else if (c_flange / tf <= 10 * ε) flangeCls = 2;
    else if (c_flange / tf <= 14 * ε) flangeCls = 3;

    // ── Web classification (internal) ─────────────────────────────────────
    // c_web = d - 2*tf - 2*r  [mm]
    const c_web = d - 2 * tf - 2 * r;
    let webCls = 4;
    // Pure bending limits (EC3 Table 5.2, sheet 1)
    if (c_web / tw <= 72 * ε) webCls = 1;
    else if (c_web / tw <= 83 * ε) webCls = 2;
    else if (c_web / tw <= 124 * ε) webCls = 3;

    // For CHS / SHS (simplified)
    let sectionCls = Math.max(flangeCls, webCls);
    if (sec._type === 'CHS') {
      const D = d, t = tf || tw;
      const Dt = D / t;
      if (Dt <= 50 * ε * ε)       sectionCls = 1;
      else if (Dt <= 70 * ε * ε)  sectionCls = 2;
      else if (Dt <= 90 * ε * ε)  sectionCls = 3;
      else                         sectionCls = 4;
      return { cls: sectionCls, epsilon: ε, flange: sectionCls, web: sectionCls,
               c_flange: D/2, c_web: D/2, note: `CHS D/t=${Dt.toFixed(1)}` };
    }

    return {
      cls: sectionCls,
      epsilon: +ε.toFixed(4),
      flange: flangeCls,
      web: webCls,
      c_flange: +c_flange.toFixed(1),
      c_web:    +c_web.toFixed(1),
      c_flange_ratio: +(c_flange / tf).toFixed(2),
      c_web_ratio:    +(c_web / tw).toFixed(2),
      limits_flange:  [+(9*ε).toFixed(2), +(10*ε).toFixed(2), +(14*ε).toFixed(2)],
      limits_web:     [+(72*ε).toFixed(2), +(83*ε).toFixed(2), +(124*ε).toFixed(2)]
    };
  }

  // ── Plastic / elastic moduli from section data ──────────────────────────
  function getSectionModuli(sec) {
    const A   = (sec.A  || 30) * 1e-4;          // cm²→m²
    const Ix  = (sec.Ix || sec.I || 10000) * 1e-8;  // cm⁴→m⁴
    const Iy  = (sec.Iy || 1000) * 1e-8;        // cm⁴→m⁴
    // Section modulus. Derive it from I and the depth when the section does not
    // carry one — W_el = I / (d/2) — rather than fall straight through to a
    // placeholder, for the same reason the radii below are derived: an invented
    // default here does not stay a display value, it becomes the bending
    // CAPACITY. A section with I = 20 000 cm⁴ and no modulus took W = 1000 cm³
    // whatever its depth; at d = 800 mm the true W_el is 500 cm³, so the
    // placeholder doubled Mc,Rd — unsafe, and silent.
    //
    // Depth is millimetres on the section, as the Define ▸ Sections dialog
    // stores it. Only W_el can be derived this way; W_pl depends on the shape,
    // so it falls back to W_el, which is the conservative of the two (W_pl ≥ W_el).
    const d_m = (+sec.d > 0) ? sec.d / 1000 : 0;
    const SxDerived = (Ix > 0 && d_m > 0) ? Ix / (d_m / 2) : null;
    const SxAssumed = !sec.Sx && !sec.Zx && SxDerived === null;

    const Sx  = sec.Sx ? sec.Sx * 1e-6
              : sec.Zx ? sec.Zx * 1e-6
              : (SxDerived !== null ? SxDerived : 1000 * 1e-6);  // elastic (Sx in DB = elastic)
    const Zx  = sec.Zx ? sec.Zx * 1e-6 : Sx;                     // plastic; W_pl ≥ W_el
    const SyDerived = (Iy > 0 && +sec.bf > 0) ? Iy / ((sec.bf / 1000) / 2) : null;
    const Sy  = sec.Sy ? sec.Sy * 1e-6
              : sec.Zy ? sec.Zy * 1e-6
              : (SyDerived !== null ? SyDerived : 200 * 1e-6);
    const Zy  = sec.Zy ? sec.Zy * 1e-6 : Sy;
    const J   = (sec.J  || 10) * 1e-8;          // cm⁴→m⁴ (St.Venant torsion)
    const Cw  = (sec.Cw || 1e4) * 1e-12;        // cm⁶→m⁶ (warping constant)
    // Radius of gyration is r = √(I/A) by definition, so derive it rather than
    // trust a field name. `ry` here is the MAJOR-axis radius (it pairs with Ix
    // below) while SectionDB stores the major one as `rx` and the minor as `ry`
    // — reading sec.ry gave the minor radius for both axes, so the reported
    // KL/r for the major axis was ~3.7x too slender on every library section.
    // Deriving also stops a section that carries no radii at all from falling
    // back to an invented 5 cm / 2 cm.
    const ry  = (A > 0 && Ix > 0) ? Math.sqrt(Ix / A) : (sec.rx || sec.ry || 5) / 100;
    const rz  = (A > 0 && Iy > 0) ? Math.sqrt(Iy / A) : (sec.ry || sec.rz || 2) / 100;
    return { A, Ix, Iy, Zx, Zy, Sx, Sy, J, Cw, ry, rz, SxAssumed };
  }

  // ── Apply property modifiers to effective stiffness ─────────────────────
  function applyModifiers(sec, mods) {
    if (!mods) return sec;
    const m = { ...sec };
    // Modifiers scale the underlying properties
    if (mods.f11 !== undefined) { m.A  = sec.A  * mods.f11; }
    if (mods.fi3 !== undefined) { m.Ix = sec.Ix ? sec.Ix * mods.fi3 : sec.I * mods.fi3;
                                   m.I  = (sec.I  || sec.Ix || 10000) * mods.fi3; }
    if (mods.fi2 !== undefined) { m.Iy = (sec.Iy || 1000) * mods.fi2; }
    if (mods.fm  !== undefined) { m.J  = (sec.J  || 10)   * mods.fm;  }
    if (mods.fmass !== undefined) { m._massMod = mods.fmass; }
    return m;
  }

  // ── Shear area (EC3 6.2.6) ──────────────────────────────────────────────
  function shearArea(sec) {
    // Use SectionDB helper if available, else compute here
    if (window.SectionDB) return window.SectionDB.shearAreaY(sec);
    const A  = (sec.A  || 30);      // cm²
    const bf = sec.bf || 100;       // mm
    const tf = sec.tf || 10;        // mm
    const tw = sec.tw || 6;         // mm
    const r  = sec.r  || 0;
    // EC3 6.2.6(3) for rolled I/H sections
    const Av_cm2 = A - 2 * (bf/10) * (tf/10) + ((tw + 2*r)/10) * (tf/10);
    return Math.max(Av_cm2, (sec.tw || 6) / 10 * (sec.d || 200) / 10 * 0.9);
  }

  // ── PHYSICAL SPANS ───────────────────────────────────────────────────────
  //
  // A deflection limit is written against a SPAN — the whole member between its
  // supports — not against whichever elements it happens to be modelled with.
  // These walk the model and chain elements that are collinear and joined at a
  // node that is not a support and has nothing else framing into it.
  //
  // Both halves of this matter. Measuring against the element chord alone makes
  // a span split into several elements report almost no sag, because each piece
  // is measured against its own chord. Measuring absolutely, as this did
  // before, counts the rigid-body movement of the ends as deflection: an
  // unloaded beam with one support settled 20 mm reads 20 mm while carrying no
  // moment at all. The span chord is the quantity that is right in both cases.

  /** Are two elements pointing along the same line (either direction)? */
  function _collinear(a, b) {
    const dot = (a.c || 0) * (b.c || 0) + (a.s || 0) * (b.s || 0);
    return Math.abs(dot) > 0.9999;
  }

  /**
   * Group elements into physical spans.
   *
   * Returns [{ elems:[id…], nodes:[id…], ends:[nodeA,nodeB], L }], elements in
   * order from one end of the span to the other. A node ends a span when it is
   * supported, carries a third member, or turns a corner.
   */
  function buildSpans(beams, elemForces, reactions, nodes) {
    const efById = {}; (elemForces || []).forEach(e => { efById[e.id] = e; });
    const bmById = {}; (beams || []).forEach(b => { bmById[b.id] = b; });

    const byNode = {};
    (beams || []).forEach(b => {
      if (!efById[b.id]) return;
      (byNode[b.node1] = byNode[b.node1] || []).push(b.id);
      (byNode[b.node2] = byNode[b.node2] || []).push(b.id);
    });

    // results.reactions carries an entry for EVERY node, zeroed at the free
    // ones, so its mere existence says nothing. Read the support from the node
    // itself; without the node list, fall back to a reaction that is actually
    // doing something, and failing that treat the node as a span end — the
    // conservative choice, since it only stops elements chaining.
    const supMap = {};
    (nodes || []).forEach(nd => { supMap[nd.id] = !!(nd.support && nd.support !== 'none'); });
    const haveNodes = (nodes || []).length > 0;
    const supported = n => {
      if (haveNodes) return !!supMap[n];
      const r = reactions && reactions[n];
      if (!r) return true;
      return Math.abs(r.Rx || 0) > 1e-9 || Math.abs(r.Ry || 0) > 1e-9 || Math.abs(r.M || 0) > 1e-9;
    };
    const other = (id, n) => (bmById[id].node1 === n ? bmById[id].node2 : bmById[id].node1);

    // The element continuing the span through node n, or null if n ends it.
    function nextThrough(id, n) {
      const at = byNode[n] || [];
      if (at.length !== 2 || supported(n)) return null;
      const nxt = at[0] === id ? at[1] : at[0];
      if (!efById[nxt] || !_collinear(efById[id], efById[nxt])) return null;
      return nxt;
    }

    const seen = new Set(), spans = [];
    for (const b of (beams || [])) {
      if (seen.has(b.id) || !efById[b.id]) continue;

      // Grow the chain outwards from this element in both directions.
      const chain = [b.id];
      seen.add(b.id);
      let endA = b.node1, endB = b.node2;
      for (const dir of [0, 1]) {
        let cur = b.id, node = dir ? b.node2 : b.node1;
        for (;;) {
          const nxt = nextThrough(cur, node);
          if (nxt == null || seen.has(nxt)) break;
          seen.add(nxt);
          if (dir) chain.push(nxt); else chain.unshift(nxt);
          node = other(nxt, node);
          cur = nxt;
        }
        if (dir) endB = node; else endA = node;
      }

      // Order the nodes along the chain from endA, and record for each element
      // whether its own node1 is the earlier of its two span nodes. The walk
      // knows this for free; nothing downstream has to infer it from geometry.
      const nodes = [endA], fwd = [];
      let node = endA, L = 0;
      for (const id of chain) {
        fwd.push(bmById[id].node1 === node);
        node = other(id, node);
        nodes.push(node);
        L += efById[id].L || 0;
      }
      spans.push({ elems: chain, nodes, fwd, ends: [endA, endB], L });
    }
    return spans;
  }

  /**
   * Peak deflection anywhere on a span, measured from the chord joining its two
   * deformed end nodes.
   *
   * Returns { v, x, L } — signed magnitude in metres, distance from the span's
   * first node, and the span length. EIof(elementId) supplies EI per element.
   */
  function spanDeflection(span, elemForces, EIof, samples) {
    const efById = {}; (elemForces || []).forEach(e => { efById[e.id] = e; });
    const n = span.elems.length;
    const first = efById[span.elems[0]], last = efById[span.elems[n - 1]];
    if (!first || !last) return { v: 0, x: 0, L: span.L };

    // Global displacement at each end of the span. span.fwd says which end of
    // the element is the span end.
    const d0 = span.fwd[0]     ? { u: first.u1 || 0, v: first.v1 || 0 }
                               : { u: first.u2 || 0, v: first.v2 || 0 };
    const d1 = span.fwd[n - 1] ? { u: last.u2  || 0, v: last.v2  || 0 }
                               : { u: last.u1  || 0, v: last.v1  || 0 };

    const lerp = t => ({ u: d0.u + (d1.u - d0.u) * t, v: d0.v + (d1.v - d0.v) * t });

    let best = 0, bestX = 0, run = 0;
    for (let i = 0; i < n; i++) {
      const ef = efById[span.elems[i]];
      if (!ef) continue;
      const L = ef.L || 0;
      const fwd = span.fwd[i];

      // Chord displacement at this element's own two ends, projected onto its
      // local transverse axis — the same projection maxDeflLocal2D applies to
      // the real end displacements, so the two are directly comparable.
      const tNear = span.L > 0 ? run / span.L : 0;
      const tFar  = span.L > 0 ? (run + L) / span.L : 0;
      const proj = g => -(ef.s || 0) * g.u + (ef.c !== undefined ? ef.c : 1) * g.v;
      const chord = fwd
        ? { v1: proj(lerp(tNear)), v2: proj(lerp(tFar)) }
        : { v1: proj(lerp(tFar)),  v2: proj(lerp(tNear)) };

      const pk = maxDeflLocal2D(ef, ef.loads || [], EIof(span.elems[i]), samples || 61, chord);
      if (Math.abs(pk.v) > Math.abs(best)) {
        best  = pk.v;
        bestX = run + (fwd ? pk.x : L - pk.x);
      }
      run += L;
    }
    return { v: best, x: bestX, L: span.L };
  }

  // ── INTERNAL FORCES ALONG A MEMBER ───────────────────────────────────────
  //
  // The single source of truth for what a member carries BETWEEN its ends.
  // ReportGenerator.sampleInternalForces delegates here, so the diagrams the
  // user sees and the forces the checks are run on cannot disagree.
  //
  //   ef   : element force record — local end forces {M1,V1,N1}, length L,
  //          direction cosines (c,s), and the span loads
  //   type : 'BMD' | 'SFD' | 'NFD'
  //   x    : station measured from end 1 (m)
  //
  // M1/V1/N1 are LOCAL end forces, so span loads must be resolved onto the
  // member's own axes before being added to them. With direction cosines (c,s):
  //     transverse  w_t = −fx·s + fy·c
  //     axial       w_a =  fx·c + fy·s
  // the same projection fefLocal2D uses, and then simple statics:
  //     V(x) = V1 + ∫w_t     M(x) = −M1 + V1·x + ∫∫w_t     N(x) = N1 + ∫w_a
  //
  // M1 is the END ACTION at node 1, which carries the opposite sign to the
  // internal moment at that section — the standard stiffness-method
  // convention — hence the leading −M1.
  function internalForceAt(ef, type, x) {
    const L = ef.L;
    const loads = ef.loads || [];
    const c = ef.c !== undefined ? ef.c : 1;
    const s = ef.s !== undefined ? ef.s : 0;
    const proj = ld => {
      const fx = ld.fx || 0, fy = ld.fy || 0;
      return { t: -fx * s + fy * c, a: fx * c + fy * s };
    };
    const proj2 = ld => {
      const fx = ld.fx2 !== undefined ? ld.fx2 : (ld.fx || 0);
      const fy = ld.fy2 !== undefined ? ld.fy2 : (ld.fy || 0);
      return { t: -fx * s + fy * c, a: fx * c + fy * s };
    };

    if (type === 'BMD') {
      let v = -ef.M1 + ef.V1 * x;
      for (const ld of loads) {
        if (ld.type === 'beam_dist') {
          v += proj(ld).t * x * x / 2;
        } else if (ld.type === 'beam_trap') {
          const w1 = proj(ld).t, w2 = proj2(ld).t;
          v += w1 * x * x / 2 + (w2 - w1) * x * x * x / (6 * L);
        } else if (ld.type === 'beam_point') {
          const a = Math.max(0, Math.min(ld.pos || 0, L));
          if (x >= a) v += proj(ld).t * (x - a);
        }
      }
      return v;
    }

    if (type === 'SFD') {
      let v = ef.V1;
      for (const ld of loads) {
        if (ld.type === 'beam_dist') {
          v += proj(ld).t * x;
        } else if (ld.type === 'beam_trap') {
          const w1 = proj(ld).t, w2 = proj2(ld).t;
          v += w1 * x + (w2 - w1) * x * x / (2 * L);
        } else if (ld.type === 'beam_point') {
          const a = Math.max(0, Math.min(ld.pos || 0, L));
          if (x >= a) v += proj(ld).t;
        }
      }
      return v;
    }

    // NFD — reported with compression negative, matching the convention used
    // elsewhere in the report.
    let N = ef.N1;
    for (const ld of loads) {
      if (ld.type === 'beam_dist') {
        N += proj(ld).a * x;
      } else if (ld.type === 'beam_trap') {
        const a1 = proj(ld).a, a2 = proj2(ld).a;
        N += a1 * x + (a2 - a1) * x * x / (2 * L);
      } else if (ld.type === 'beam_point') {
        const a = Math.max(0, Math.min(ld.pos || 0, L));
        if (x >= a) N += proj(ld).a;
      }
    }
    return -N;
  }

  // Evenly spaced stations from end 1 to end 2 — what the diagrams plot.
  function sampleInternalForces(ef, type = 'BMD', nSeg = 20) {
    const vals = [];
    for (let i = 0; i <= nSeg; i++) vals.push(internalForceAt(ef, type, (i / nSeg) * ef.L));
    return vals;
  }

  /**
   * Largest |internal force| anywhere on the member, ends included.
   *
   * The flexure and combined checks used to take
   *     M_Ed = max(|ef.M1|, |ef.M2|)
   * — the END moments only, despite a comment claiming "max of ends +
   * mid-span". For a simply supported member both ends are zero by definition,
   * so ANY simply supported beam under transverse load was checked at
   * M_Ed = 0 and reported η = 0.000 with status OK, however close to failure
   * it really was. A 6 m span under 10 kN/m carries wL²/8 = 45 kNm at
   * mid-span and was reported as carrying nothing.
   *
   * Stations are the evenly spaced ones plus every point-load position, since
   * the peak of a point-loaded span sits exactly at the load and would
   * otherwise fall between samples.
   */
  function maxInternalForce(ef, type, nSeg = 40) {
    let peak = 0;
    for (let i = 0; i <= nSeg; i++) {
      peak = Math.max(peak, Math.abs(internalForceAt(ef, type, (i / nSeg) * ef.L)));
    }
    for (const ld of (ef.loads || [])) {
      if (ld.type !== 'beam_point') continue;
      const a = Math.max(0, Math.min(ld.pos || 0, ef.L));
      // Shear steps at a point load: sample both sides.
      peak = Math.max(peak, Math.abs(internalForceAt(ef, type, a)),
                            Math.abs(internalForceAt(ef, type, Math.max(0, a - 1e-9))));
    }
    return peak;
  }

  /** Design bending moment for a member: the true maximum along the span. */
  function designMoment(ef) {
    const ends = Math.max(Math.abs(ef.M1), Math.abs(ef.M2));
    if (!ef.loads || !ef.loads.length) return ends;
    return Math.max(ends, maxInternalForce(ef, 'BMD'));
  }

  // ── FLEXURAL CHECK (EC3 6.2.5 + 6.3.2) ─────────────────────────────────
  // ef        : element force object {M1, M2, N1, N2, V1, V2, L, loads, ...}
  // sec       : section object (with mods applied)
  // Lcr       : effective buckling length for LTB (m), default = L
  // Returns   : detailed check object
  //
  // rho_V : EC3 §6.2.8 shear-reduction factor from shearCheck (0 when V_Ed ≤
  //         0.5·Vpl,Rd). It used to be derived and then only printed as a note,
  //         so a beam running at high shear kept its full moment capacity — the
  //         M-V interaction was displayed but never enforced.
  function flexuralCheck(ef, sec, Lcr, rho_V) {
    const fy   = (sec.fy || 275) * 1e3;   // kN/m²
    const E    = (sec.E  || 210) * 1e6;   // kN/m²
    const G    = E / (2 * (1 + 0.3));     // shear modulus kN/m²
    const m    = getSectionModuli(sec);
    const cls  = classifySection(sec);
    const Lcr_ = Lcr || ef.L;

    // Design bending moment: the true maximum along the span, not just the ends.
    const M_Ed = designMoment(ef);

    // Cross-section resistance
    //
    // classifySection returns cls === null when the section carries no
    // flange/web thickness, so EC3 plate classification does not apply. `null`
    // compares as 0 in JS, so `cls.cls <= 2` was TRUE for exactly those
    // sections and they silently took the plastic modulus — the most
    // favourable branch — on the strength of a missing value. Class 1/2 is a
    // claim about local buckling that unclassified data cannot support, so fall
    // back to the elastic modulus and say why.
    let Mc_Rd;
    let modulus_used, modulus_label;
    const unclassified = cls.notApplicable || cls.cls == null;
    if (unclassified) {
      Mc_Rd = m.Sx * fy / γM0;           // elastic — conservative
      modulus_used = m.Sx * 1e6;
      modulus_label = 'W_el,y (unclassified)';
    } else if (cls.cls <= 2) {
      Mc_Rd = m.Zx * fy / γM0;           // plastic
      modulus_used = m.Zx * 1e6;         // cm³ for display
      modulus_label = 'W_pl,y';
    } else if (cls.cls === 3) {
      Mc_Rd = m.Sx * fy / γM0;           // elastic
      modulus_used = m.Sx * 1e6;
      modulus_label = 'W_el,y';
    } else {
      // Class 4 — simplified: use 80% of elastic
      Mc_Rd = m.Sx * fy * 0.80 / γM0;
      modulus_used = m.Sx * 1e6 * 0.80;
      modulus_label = 'W_eff,y (est.)';
    }

    // Say so when the modulus — and therefore the whole bending capacity — is
    // a placeholder rather than the section's own. This happens for a section
    // entered with A and I but no depth, where W_el cannot be derived.
    const modulus_assumed = !!m.SxAssumed;
    if (modulus_assumed) modulus_label += ' — ASSUMED 1000 cm³, section has no modulus or depth';

    // ── Shear–moment interaction (EC3 §6.2.8) ────────────────────────────
    // Above V_Ed = 0.5·Vpl,Rd the web's contribution to bending is reduced:
    //   My,V,Rd = [Wpl,y − ρ·Aw²/(4·tw)]·fy/γM0  ≤  Mc,Rd
    // Falls back to the blunter (1 − ρ)·Mc,Rd when the section carries no web
    // dimensions to form Aw with.
    // The reduction is a statement about the WEB losing capacity to shear, so it
    // needs real web dimensions. Without them there is nothing to reduce and no
    // defensible way to guess — the same position classifySection takes. An
    // earlier draft fell back to (1 − ρ)·Mc,Rd, which at ρ = 1 zeroed the
    // capacity outright and made eta_M infinite for any section lacking a web.
    let mv_note = 'No M-V interaction (V_Ed ≤ 0.5·Vpl,Rd)';
    const rhoV = (typeof rho_V === 'number' && rho_V > 0) ? Math.min(rho_V, 1) : 0;
    if (rhoV > 0) {
      const tw_m = sec.tw ? sec.tw / 1000 : 0;
      const hw_m = (sec.d && sec.tf) ? (sec.d - 2 * sec.tf) / 1000 : 0;
      if (tw_m > 0 && hw_m > 0) {
        const Mc_full = Mc_Rd;
        const Aw   = hw_m * tw_m;                       // m²
        const Wred = m.Zx - rhoV * Aw * Aw / (4 * tw_m);
        // The flanges still carry moment even at ρ = 1, so Wred stays positive
        // for any real I-section; the guard is for pathological inputs only.
        Mc_Rd = Math.min(Mc_full, Math.max(0, Wred) * fy / γM0);
        mv_note = `Reduced for shear: ρ=${rhoV.toFixed(3)}, ` +
                  `Mc,Rd ${Mc_full.toFixed(1)} → ${Mc_Rd.toFixed(1)} kNm (EC3 §6.2.8)`;
      } else {
        mv_note = `V_Ed > 0.5·Vpl,Rd (ρ=${rhoV.toFixed(3)}) but §6.2.8 needs web ` +
                  `dimensions (tw, d, tf) — reduction not applied`;
      }
    }

    // ── Lateral-Torsional Buckling (EC3 6.3.2) ───────────────────────────
    // Mcr (elastic critical moment) — General method (Annex F / NCCI)
    // Mcr = C1 * (π²EIy/Lcr²) * √[ (Iz/Iy) * (Iw/Iz + Lcr²*GJ/(π²EIz)) ]
    // Simplified with C1 = 1.12 (uniform moment), C2=C3=0
    const C1 = 1.12;
    const pi2EI = Math.PI * Math.PI * E * m.Iy;
    const Mcr = C1 * (pi2EI / (Lcr_ * Lcr_)) *
                Math.sqrt(m.Cw / m.Iy + (Lcr_ * Lcr_ * G * m.J) / (Math.PI * Math.PI * E * m.Iy));

    // Non-dimensional slenderness λLT
    const lambdaLT = Math.sqrt((m.Zx * fy) / Mcr);

    // LTB curve — EC3 6.3.2.2
    // For rolled sections h/b ≤ 2 → curve 'a'; h/b > 2 → curve 'b'
    const hb = (sec.d || 200) / (sec.bf || 100);
    const ltbCurve = (hb <= 2) ? 'a' : 'b';
    const αLT = ALPHA[ltbCurve];
    const λLT0 = 0.4;   // EC3 6.3.2.3 plateau (rolled)
    const β    = 0.75;  // EC3 6.3.2.3 (rolled)

    let chiLT = 1.0;
    let MB_Rd = Mc_Rd;
    let ltb_note = 'No LTB (λLT ≤ λLT0)';

    if (lambdaLT > λLT0 && sec._type !== 'CHS' && sec._type !== 'SHS') {
      const ΦLT = 0.5 * (1 + αLT * (lambdaLT - λLT0) + β * lambdaLT * lambdaLT);
      chiLT = Math.min(1.0,
        1 / (ΦLT + Math.sqrt(ΦLT * ΦLT - β * lambdaLT * lambdaLT)));
      MB_Rd = chiLT * (!unclassified && cls.cls <= 2 ? m.Zx : m.Sx) * fy / γM1;
      ltb_note = `LTB governs (λLT=${lambdaLT.toFixed(3)}, χLT=${chiLT.toFixed(3)})`;
    }

    const Mb_Rd_governing = Math.min(Mc_Rd, MB_Rd);
    // Dividing by a zero capacity gives Infinity, and JSON turns that into null —
    // so the member's utilisation vanished from the summary instead of reporting
    // the failure that produced it. 999 stands in for "no capacity at all";
    // anything past 1.0 has failed and the exact figure carries no meaning.
    const eta_M = Mb_Rd_governing > 0 ? M_Ed / Mb_Rd_governing
                : M_Ed > 0            ? 999
                :                       0;

    return {
      check: 'Flexure',
      M_Ed:       +M_Ed.toFixed(3),
      Mc_Rd:      +Mc_Rd.toFixed(3),
      MB_Rd:      +MB_Rd.toFixed(3),
      Mb_Rd:      +Mb_Rd_governing.toFixed(3),
      eta:        +eta_M.toFixed(4),
      pass:       eta_M <= 1.0,
      status:     eta_M <= 0.80 ? 'OK' : eta_M <= 1.0 ? 'NEAR' : 'FAIL',
      cls:        cls.cls,
      modulus:    +(modulus_used).toFixed(1),
      modulus_label,
      modulus_assumed,
      Mcr:        +Mcr.toFixed(3),
      lambdaLT:   +lambdaLT.toFixed(4),
      chiLT:      +chiLT.toFixed(4),
      ltbCurve,
      ltb_note,
      rho_V:  +rhoV.toFixed(4),
      mv_note,
      section_cls: cls
    };
  }

  // ── SHEAR CHECK (EC3 6.2.6) ─────────────────────────────────────────────
  function shearCheck(ef, sec) {
    const fy  = (sec.fy || 275) * 1e3;   // kN/m²
    const Av  = shearArea(sec) * 1e-4;   // cm²→m²
    const Vpl_Rd = Av * fy / (Math.sqrt(3) * γM0);

    const V_Ed = (ef.loads && ef.loads.length)
      ? Math.max(Math.abs(ef.V1), Math.abs(ef.V2), maxInternalForce(ef, 'SFD'))
      : Math.max(Math.abs(ef.V1), Math.abs(ef.V2));

    // Shear buckling check (EC3 6.2.6(6)) — web slenderness
    const hw = (sec.d || 200) - 2 * (sec.tf || 10);   // mm
    const tw = sec.tw || 6;
    const eta_sb = hw / (tw * 72 * Math.sqrt(235 / (sec.fy || 275)));
    const shearBuckling = eta_sb > 1.0;

    // Reduced moment capacity due to shear (EC3 6.2.8)
    // EC3 defines ρ = (2·V_Ed/Vpl,Rd − 1)² over 0.5 < V_Ed/Vpl,Rd ≤ 1.0 only.
    // Past that the shear check has already failed and the expression runs away
    // — a member at 187x shear returns ρ ≈ 1.4e5. Clamp it to the physical
    // range so downstream consumers get a usable factor rather than a runaway.
    let rho_V = 0;
    const eta_shear_basic = V_Ed / Vpl_Rd;
    if (eta_shear_basic > 0.5) {
      rho_V = Math.min(1, Math.pow(2 * eta_shear_basic - 1, 2));  // reduction factor
    }

    const eta_V = V_Ed / Vpl_Rd;

    return {
      check:       'Shear',
      V_Ed:        +V_Ed.toFixed(3),
      Vpl_Rd:      +Vpl_Rd.toFixed(3),
      Av_cm2:      +(Av * 1e4).toFixed(2),
      eta:         +eta_V.toFixed(4),
      pass:        eta_V <= 1.0,
      status:      eta_V <= 0.80 ? 'OK' : eta_V <= 1.0 ? 'NEAR' : 'FAIL',
      hw_tw:       +(hw / tw).toFixed(2),
      shear_buckling_note: shearBuckling
        ? `⚠ Web shear buckling check required (hw/tw=${(hw/tw).toFixed(1)} > 72ε)`
        : `Web OK (hw/tw=${(hw/tw).toFixed(1)})`,
      rho_V:       +rho_V.toFixed(4),
      MV_reduction: rho_V > 0 ? `Moment capacity reduced by ρ=${rho_V.toFixed(3)}` : 'No M-V interaction'
    };
  }

  // ── PLATE BUCKLING CHECK (EC3 Table 4.1 / DNV-RP-C201) ─────────────────
  // For flat plates in compression — web & flange buckling
  function plateBucklingCheck(sec) {
    const fy  = (sec.fy  || 275);   // MPa
    const E   = (sec.E   || 210) * 1e3; // GPa→MPa
    const nu  = 0.3;
    const results = [];

    // ── Web plate: b = c_web, t = tw, k = 23.9 (bending), 4.0 (uniform compression)
    if (sec.tw && sec.d) {
      const hw = (sec.d || 200) - 2 * (sec.tf || 10);  // mm
      const tw = sec.tw;   // mm
      const k_web_bend = 23.9;   // pure bending
      const k_web_comp = 4.0;    // uniform compression
      const scr_bend = k_web_bend * Math.PI**2 * E / (12*(1-nu**2)) * (tw/hw)**2;
      const scr_comp = k_web_comp * Math.PI**2 * E / (12*(1-nu**2)) * (tw/hw)**2;
      // Plate slenderness λp = √(fy/σcr)
      const lp_bend = Math.sqrt(fy / scr_bend);
      const lp_comp = Math.sqrt(fy / scr_comp);
      // Reduction factor ρ (EC3 Eq. 4.2): ρ = (λp - 0.055*(3+ψ))/λp² ≤ 1
      const psi_bend = -1.0;  // linear bending: ψ = -1
      const rho_bend = lp_bend > 0.673
        ? Math.min(1, (lp_bend - 0.055*(3+psi_bend)) / (lp_bend**2))
        : 1.0;
      const rho_comp = lp_comp > 0.673
        ? Math.min(1, (lp_comp - 0.22) / (lp_comp**2))
        : 1.0;

      results.push({
        element: 'Web (bending)',
        b_t:     +(hw/tw).toFixed(1),
        k:       k_web_bend,
        sigma_cr:+scr_bend.toFixed(1),
        lambda_p:+lp_bend.toFixed(3),
        rho:     +rho_bend.toFixed(3),
        status:  lp_bend <= 0.673 ? 'OK' : rho_bend >= 0.85 ? 'NEAR' : 'FAIL'
      });
      results.push({
        element: 'Web (compression)',
        b_t:     +(hw/tw).toFixed(1),
        k:       k_web_comp,
        sigma_cr:+scr_comp.toFixed(1),
        lambda_p:+lp_comp.toFixed(3),
        rho:     +rho_comp.toFixed(3),
        status:  lp_comp <= 0.673 ? 'OK' : rho_comp >= 0.85 ? 'NEAR' : 'FAIL'
      });
    }

    // ── Flange plate (outstand): b = c_flange, t = tf, k = 0.43
    if (sec.tf && sec.bf) {
      const c_fl = (sec.bf - (sec.tw || 7) - 2*(sec.r || 0)) / 2;
      const tf   = sec.tf;
      const k_fl = 0.43;   // outstand flange, free edge
      const scr_fl = k_fl * Math.PI**2 * E / (12*(1-nu**2)) * (tf/c_fl)**2;
      const lp_fl  = Math.sqrt(fy / scr_fl);
      const rho_fl = lp_fl > 0.748
        ? Math.min(1, (lp_fl - 0.188) / (lp_fl**2))
        : 1.0;
      results.push({
        element: 'Flange outstand',
        b_t:     +(c_fl/tf).toFixed(1),
        k:       k_fl,
        sigma_cr:+scr_fl.toFixed(1),
        lambda_p:+lp_fl.toFixed(3),
        rho:     +rho_fl.toFixed(3),
        status:  lp_fl <= 0.748 ? 'OK' : rho_fl >= 0.85 ? 'NEAR' : 'FAIL'
      });
    }

    const overallFail = results.some(r => classifyStatus(r.status) === 'FAIL');
    const overallNear = results.some(r => classifyStatus(r.status) === 'NEAR');

    return {
      check:    'Plate Buckling (EC3 §4)',
      elements: results,
      status:   results.length === 0 ? 'INFO'
              : overallFail ? 'FAIL' : overallNear ? 'NEAR' : 'OK',
      pass:     !overallFail,
      // `eta` across every other check is a demand/capacity ratio, and
      // runDesignChecks takes the max of them as the member's utilisation. This
      // returned the largest plate SLENDERNESS λp instead, which is not a
      // utilisation at all: a slender girder reported maxEta = 6.42 while its
      // worst real ratio was 0.35, and that figure drove the member's headline
      // number and any sort by utilisation. Report λp under its own name.
      eta:      null,
      lambda_p_max: results.length > 0
        ? +(Math.max(...results.map(r => r.lambda_p))).toFixed(4) : null,
      note:     results.length === 0
        ? 'Plate buckling not applicable (no dimensional data in section)'
        : `${results.filter(r=>r.status!=='OK').length} of ${results.length} plate element(s) require attention`
    };
  }

  // ── AXIAL / BUCKLING CHECK (EC3 6.2.4 + 6.3.1) — with K-factors ─────────
  // Ky, Kz : effective length factors for major and minor axes (default 1.0)
  function axialCheck(ef, sec, L, Ky = 1.0, Kz = 1.0) {
    const fy = (sec.fy || 275) * 1e3;   // kN/m²
    const E  = (sec.E  || 210) * 1e6;   // kN/m²
    const m  = getSectionModuli(sec);
    // solveFrame reports axial force COMPRESSION-POSITIVE — a column carrying
    // 300 kN of gravity comes back as N1 = N2 = +300, uplift as −300 (see the
    // convention note in pdelta.js). This read it as tension-positive and
    // negated, so every compressed member landed in the tension branch below:
    // that 300 kN column was reported as "Axial (Tension), η = 0.20, OK" against
    // the full Npl,Rd, when the real answer is χ ≈ 0.39, Nb,Rd ≈ 583 kN and
    // η ≈ 0.52. The buckling check — the one that governs column sizing — could
    // never fire on any member in the model.
    const N_Ed = Math.max(ef.N1, ef.N2);   // peak compression (kN, +ve = compression)

    // Cross-section: Npl,Rd
    const Npl_Rd = m.A * fy / γM0;

    // Tension check (if N_Ed ≤ 0)
    const Nt_Rd = Npl_Rd;

    if (N_Ed <= 0) {
      const Ned_t = Math.max(0, -Math.min(ef.N1, ef.N2));   // peak tension
      const etaT  = Ned_t / Nt_Rd;
      return {
        check:   'Axial (Tension)',
        N_Ed:    +(-N_Ed).toFixed(3),
        Nt_Rd:   +Nt_Rd.toFixed(3),
        eta:     +etaT.toFixed(4),
        pass:    etaT <= 1.0,
        status:  etaT <= 0.80 ? 'OK' : etaT <= 1.0 ? 'NEAR' : 'FAIL',
        isTension: true,
        note:    'Tension — net-section check may govern for bolt holes'
      };
    }

    // ── Effective lengths ──────────────────────────────────────────────────
    const Lcr_y = Ky * L;   // major axis
    const Lcr_z = Kz * L;   // minor axis

    // Radii of gyration [m]
    const ry = m.ry;
    const rz = m.rz;

    // Slenderness ratios (geometric)
    const SRy = Lcr_y / ry;
    const SRz = Lcr_z / rz;

    // Euler critical loads
    const Ncr_y = Math.PI ** 2 * E * m.Ix / (Lcr_y ** 2);
    const Ncr_z = Math.PI ** 2 * E * m.Iy / (Lcr_z ** 2);

    // Non-dimensional slenderness  λ̄ = √(A·fy/Ncr)
    const lambda_y = Math.sqrt(m.A * fy / Ncr_y);
    const lambda_z = Math.sqrt(m.A * fy / Ncr_z);

    // ── Johnson Parabola (applies when λ < λc, i.e. short/intermediate columns)
    // λc = π√(E/fy) — transition slenderness
    const lambda_c_y = Math.PI * Math.sqrt(E / fy);  // in terms of geometric KL/r

    // Johnson Pcr for short columns (AISC / engineering-calcs ref):
    // Only used when SRy < λc (else Euler governs — already captured by EC3 χ)
    // Included informational; EC3 χ already handles this via the plateau
    const useJohnson_y = SRy < lambda_c_y;
    const Ncr_Johnson_y = useJohnson_y
      ? m.A * fy * (1 - fy * SRy ** 2 / (4 * Math.PI ** 2 * E))
      : Ncr_y;

    const curveY = bucklingCurveY(sec);
    const curveZ = bucklingCurveZ(sec);

    const chi_y = chiFromLambda(lambda_y, curveY);
    const chi_z = chiFromLambda(lambda_z, curveZ);
    const chi   = Math.min(chi_y, chi_z);

    const Nb_Rd = chi * m.A * fy / γM1;
    const eta_c = N_Ed / Nb_Rd;

    return {
      check:       'Axial (Compression/Buckling)',
      N_Ed:        +N_Ed.toFixed(3),
      Npl_Rd:      +Npl_Rd.toFixed(3),
      Nb_Rd:       +Nb_Rd.toFixed(3),
      eta:         +eta_c.toFixed(4),
      pass:        eta_c <= 1.0,
      status:      eta_c <= 0.80 ? 'OK' : eta_c <= 1.0 ? 'NEAR' : 'FAIL',
      Ncr_y:       +Ncr_y.toFixed(2),
      Ncr_z:       +Ncr_z.toFixed(2),
      lambda_y:    +lambda_y.toFixed(4),
      lambda_z:    +lambda_z.toFixed(4),
      SR_y:        +SRy.toFixed(1),
      SR_z:        +SRz.toFixed(1),
      chi_y:       +chi_y.toFixed(4),
      chi_z:       +chi_z.toFixed(4),
      chi:         +chi.toFixed(4),
      curveY, curveZ,
      Ky:          +Ky.toFixed(2),
      Kz:          +Kz.toFixed(2),
      Lcr_y:       +Lcr_y.toFixed(3),
      Lcr_z:       +Lcr_z.toFixed(3),
      johnson_note: useJohnson_y
        ? `Short column (KL/r=${SRy.toFixed(1)} < λc=${lambda_c_y.toFixed(1)}): Johnson Ncr=${Ncr_Johnson_y.toFixed(1)} kN — EC3 χ curve is conservative`
        : `Slender column (KL/r=${SRy.toFixed(1)} ≥ λc): Euler governs`,
      note: `Buckling governs on ${chi_y < chi_z ? 'major (y-y)' : 'minor (z-z)'} axis  |  KL/r(y)=${SRy.toFixed(1)}, KL/r(z)=${SRz.toFixed(1)}`
    };
  }

  // ── TORSION CHECK (EC3 6.2.7) ───────────────────────────────────────────
  // Simplified: St.Venant torsion only (warping check for open sections)
  function torsionCheck(ef, sec) {
    const fy = (sec.fy || 275) * 1e3;   // kN/m²
    const E  = (sec.E  || 210) * 1e6;
    const G  = E / (2 * (1 + 0.3));
    const m  = getSectionModuli(sec);
    const tw = (sec.tw || 6) / 1000;     // mm→m
    const tf = (sec.tf || 10) / 1000;

    // For a closed section (CHS/SHS) — shear flow approach
    // For open I-sections — St.Venant + warping
    const isOpen = sec._type !== 'CHS' && sec._type !== 'SHS' && sec._type !== 'RHS';

    // Torsional shear stress limit  τ_Rd = fy/(√3·γM0)
    const tau_Rd = fy / (Math.sqrt(3) * γM0);

    // For beam elements we only have N, V, M results (no torque from 2D analysis)
    // Return informational check with capacity
    // Plastic torsional resistance: Tt,pl,Rd = fy/(√3·γM0) · W_t
    // W_t (torsion modulus) ≈ J / (max distance to centroid)
    const t_min = Math.min(tw, tf) * 1000;  // back to mm for ratio
    const Wt = isOpen
      ? m.J / ((t_min / 1000) * 2)    // for thin-walled open
      : m.J / ((sec.d || 200) / 1000 / 2);  // for closed

    const Tt_pl_Rd = tau_Rd * Wt;

    // Note: 2D frame analysis gives no torsion — flag as "not calculated"
    return {
      check:      'Torsion',
      note:       '2D frame analysis: torsion not computed. Capacity shown for reference.',
      isOpenSection: isOpen,
      G_kNm2:     +(G / 1e6).toFixed(1),
      J_cm4:      +(m.J * 1e8).toFixed(2),
      Cw_cm6:     +(m.Cw * 1e12).toFixed(1),
      tau_Rd_kNm2: +(tau_Rd / 1e3).toFixed(1),
      Tt_pl_Rd:   +Tt_pl_Rd.toFixed(3),
      warning:    isOpen
        ? 'Open section (I/H): warping torsion significant — check Annex B EC3-1-1'
        : 'Closed section: primarily St.Venant torsion',
      status:     'INFO',
      pass:       true,
      eta:        null
    };
  }

  // ── COMBINED INTERACTION CHECK (EC3 6.3.3) ──────────────────────────────
  // Method 2 (conservative) from EC3 Annex B
  function interactionCheck(ef, sec, axCheck, flexCheck) {
    const fy   = (sec.fy || 275) * 1e3;
    const m    = getSectionModuli(sec);
    const chi  = axCheck.chi  || 1.0;
    const chiLT = flexCheck.chiLT || 1.0;

    // Compression-positive, matching solveFrame (see axialCheck). This was
    // negated, so N_Ed came out as 0 for every compressed member and the whole
    // interaction reduced to the bending term alone.
    const N_Ed = Math.max(0, ef.N1, ef.N2);   // compression
    const M_Ed = designMoment(ef);

    const Npl_Rd = m.A * fy / γM0;
    // Moment resistance must follow the SECTION CLASS, not assume Class 1/2.
    // Hardcoding the plastic modulus handed a Class 4 girder 1420 kNm where
    // flexuralCheck had correctly derived 994 kNm — 1.43x unconservative in
    // Eq. 6.61/6.62. Reuse what flexuralCheck already worked out.
    const Mpl_Rd = flexCheck.Mc_Rd > 0 ? flexCheck.Mc_Rd : m.Zx * fy / γM0;

    // Buckling resistance
    const Nb_Rd = axCheck.Nb_Rd  || Npl_Rd;
    const Mb_Rd = flexCheck.Mb_Rd || Mpl_Rd;

    // ── Characteristic resistances ────────────────────────────────────────
    // EC3 6.61/6.62 divide N_Rk and M_Rk (CHARACTERISTIC, no partial factor) by
    // γM1. Npl_Rd and Mpl_Rd above already carry /γM0, so dividing them by γM1
    // as well gave denominators of A·fy/(γM0·γM1) — a second partial factor
    // applied on top of the first. It happens to be exact while γM0 = γM1 = 1.00
    // and would silently over-penalise the moment any national annex sets 1.10.
    const N_Rk = Npl_Rd * γM0;   // = A·fy
    const M_Rk = Mpl_Rd * γM0;   // = W·fy, W per section class

    // Buckling reductions: 6.61 is the major-axis equation and 6.62 the minor,
    // so each takes its own χ. `chi` (= min of the two) is the fallback for
    // tension members, where axialCheck reports no per-axis values.
    const chi_y = axCheck.chi_y || chi;
    const chi_z = axCheck.chi_z || chi;

    // Interaction factors kyy, kzy (Method 2, Annex B, Table B.1)
    const lambda_y = axCheck.lambda_y || 0;

    // Equivalent moment factor Cmy = 0.9 (uniform, conservative)
    const Cmy = 0.9;

    const Nb_y = chi_y * N_Rk / γM1;
    const Nb_z = chi_z * N_Rk / γM1;
    const Mb_y = chiLT * M_Rk / γM1;

    // kyy
    const kyy = Cmy * (1 + (lambda_y - 0.2) * N_Ed / Nb_y);
    const kyy_c = Math.min(kyy, Cmy * (1 + 0.8 * N_Ed / Nb_y));

    // kzy
    const kzy = 0.6 * kyy_c;

    // EC3 Eq. 6.61 (major axis)
    const eta_61 = N_Ed / Nb_y + kyy_c * (M_Ed / Mb_y);

    // EC3 Eq. 6.62 (minor axis buckling)
    const eta_62 = N_Ed / Nb_z + kzy * (M_Ed / Mb_y);

    const eta = Math.max(eta_61, eta_62);

    return {
      check:     'Combined N+M Interaction',
      N_Ed:      +N_Ed.toFixed(3),
      M_Ed:      +M_Ed.toFixed(3),
      Nb_Rd:     +Nb_Rd.toFixed(3),
      Mb_Rd:     +Mb_Rd.toFixed(3),
      kyy:       +kyy_c.toFixed(4),
      kzy:       +kzy.toFixed(4),
      eta_6_61:  +eta_61.toFixed(4),
      eta_6_62:  +eta_62.toFixed(4),
      eta:       +eta.toFixed(4),
      governing: eta_61 >= eta_62 ? 'Eq.6.61 (major axis)' : 'Eq.6.62 (minor axis)',
      pass:      eta <= 1.0,
      status:    eta <= 0.80 ? 'OK' : eta <= 1.0 ? 'NEAR' : 'FAIL'
    };
  }

  // ── DEFLECTION CHECK ────────────────────────────────────────────────────
  // ── DEFLECTION CHECK ────────────────────────────────────────────────────
  // sec is required to obtain EI; without it the span term cannot be formed
  // and the check falls back to end values, which is flagged in the note.
  //
  // This used to take max(|v1|, |v2|) — the deflection at the END NODES. Those
  // sit on the supports of a simply-supported member, so the check reported
  // 0.00 mm and passed everything. An 8 m span under 20 kN/m deflects 187.5 mm
  // against an L/360 limit of 22.2 mm — a genuine 8.4x failure that was
  // reported as OK. Deflection frequently governs beam sizing, so the check
  // that mattered most was the one that could never fire.
  //
  // The true shape is the Hermite interpolation of the end DOFs plus the
  // fixed-end deflection under the span load; maxDeflLocal2D (solver.js)
  // samples it and returns the peak.
  const DEFL_LIMITS = {
    'simply-supported': 300,
    'cantilever':       150,
    'roof':             200,
    'floor':            360
  };

  /**
   * @param span  optional { v, x, L, members } from spanDeflection() — the peak
   *              measured from the chord of the WHOLE physical span, and that
   *              span's length. The limit is then L_span/denom, not
   *              L_element/denom: splitting a beam in two must not halve its
   *              allowance, and the sag at the split — an element END — must
   *              still be seen.
   */
  function deflectionCheck(ef, L, spanType = 'simply-supported', sec = null, span = null) {
    const denom = DEFL_LIMITS[spanType] || 300;
    const Lspan = span && span.L > 0 ? span.L : L;
    const limit = Lspan / denom;

    let v_max, x_at, approximate = false;
    const EI = sec ? (sec.E || 0) * 1e6 * (((sec.Ix || sec.I) || 0) / 1e8) : 0;

    if (span) {
      v_max = Math.abs(span.v);
      x_at  = span.x;
    } else if (EI > 0 && typeof maxDeflLocal2D === 'function') {
      const peak = maxDeflLocal2D(ef, ef.loads || [], EI, 41);
      v_max = Math.abs(peak.v);
      x_at  = peak.x;
    } else {
      // No section data — indicative only.
      v_max = Math.max(Math.abs(ef.v1 || 0), Math.abs(ef.v2 || 0));
      x_at = 0;
      approximate = true;
    }

    const eta = limit > 0 ? v_max / limit : 0;

    return {
      check:     'Deflection',
      v_max_mm:  +(v_max * 1000).toFixed(2),
      at_x_m:    +x_at.toFixed(3),
      limit_mm:  +(limit * 1000).toFixed(2),
      limit_frac: `L/${denom}`,
      span_type: spanType,
      L_m:       +Lspan.toFixed(3),
      span_members: span && span.members && span.members.length > 1 ? span.members.slice() : undefined,
      eta:       +eta.toFixed(4),
      pass:      eta <= 1.0,
      status:    eta <= 0.80 ? 'OK' : eta <= 1.0 ? 'NEAR' : 'FAIL',
      note:      approximate
        ? 'No section stiffness available — end-node deflection used, indicative only.'
        : `Peak δ = ${(v_max*1000).toFixed(2)} mm at x = ${x_at.toFixed(2)} m (limit L/${denom} = ${(limit*1000).toFixed(2)} mm).`
    };
  }

  // ── MODIFICATION FACTORS (detailed) ──────────────────────────────────────
  // Returns a descriptive object of all active modifiers and their effects
  function describeModifiers(mods, sec) {
    if (!mods) return { active: false, factors: [] };
    const factors = [];
    const all = {
      f11:   { name: 'Axial Stiffness (EA)',       prop: 'A',  unit: 'cm²' },
      f22:   { name: 'Shear Stiffness y (GAvy)',    prop: 'Avy', unit: 'cm²' },
      f33:   { name: 'Shear Stiffness z (GAvz)',    prop: 'Avz', unit: 'cm²' },
      fm:    { name: 'Torsional Stiffness (GJ)',    prop: 'J',   unit: 'cm⁴' },
      fi2:   { name: 'Bending Stiffness I2 (EI2)',  prop: 'Iy',  unit: 'cm⁴' },
      fi3:   { name: 'Bending Stiffness I3 (EI3)',  prop: 'Ix',  unit: 'cm⁴' },
      fmass: { name: 'Mass Modifier',               prop: 'mass',unit: '—'   },
      fwgt:  { name: 'Self-Weight Modifier',        prop: 'wgt', unit: '—'   }
    };
    for (const [key, info] of Object.entries(all)) {
      if (mods[key] !== undefined && mods[key] !== 1.0) {
        const nominal = key === 'fi3' ? (sec.Ix || sec.I || 10000)
                      : key === 'fi2' ? (sec.Iy || 1000)
                      : key === 'f11' ? (sec.A   || 30)
                      : key === 'fm'  ? (sec.J   || 10) : 1;
        const effective = nominal * mods[key];
        factors.push({
          key,
          name:      info.name,
          modifier:  mods[key],
          nominal:   +nominal.toFixed(2),
          effective: +effective.toFixed(2),
          unit:      info.unit,
          pct_change: +((mods[key] - 1) * 100).toFixed(1)
        });
      }
    }
    return { active: factors.length > 0, factors };
  }

  // ── MASTER FUNCTION ───────────────────────────────────────────────────────
  // Runs all checks for each beam element
  // results  : from solveFrame()
  // beams    : array of beam objects (with sectionId, modifiers)
  // sections : array of section objects
  // Returns  : { byBeam: [{id, name, checks[], overall}], summary }
  function runDesignChecks(results, beams, sections, nodes) {
    if (!results || !results.elemForces) return null;

    const secMap = {};
    sections.forEach(s => { secMap[s.id] = s; });

    // Physical spans, so a deflection limit is applied to the member a user
    // would point at rather than to whichever elements it is modelled with.
    const EIof = id => {
      const b = beams.find(x => x.id === id);
      const sc = b && secMap[b.sectionId];
      return sc ? (sc.E || 0) * 1e6 * (((sc.Ix || sc.I) || 0) / 1e8) : 0;
    };
    const spanOf = {};
    try {
      for (const sp of buildSpans(beams, results.elemForces, results.reactions, nodes)) {
        const d = spanDeflection(sp, results.elemForces, EIof, 61);
        d.members = sp.elems.slice();
        sp.elems.forEach(id => { spanOf[id] = d; });
      }
    } catch (e) { /* topology unavailable — fall back to per-element below */ }

    const byBeam = [];
    let globalPass = true, globalNear = false;

    for (const ef of results.elemForces) {
      const bm  = beams.find(b => b.id === ef.id);
      if (!bm) continue;

      let sec = secMap[bm.sectionId];
      if (!sec) continue;

      // Apply property modifiers if present
      if (bm.modifiers) sec = applyModifiers(sec, bm.modifiers);

      const checks = [];
      const Lcr = bm.Lcr || ef.L;          // effective buckling length (legacy override)
      const Ky  = bm.Ky  != null ? bm.Ky : 1.0;  // major-axis K-factor
      const Kz  = bm.Kz  != null ? bm.Kz : 1.0;  // minor-axis K-factor

      // 1. Section Classification
      const cls = classifySection(sec);
      checks.push({ check: 'Section Classification', cls: cls.cls,
        epsilon: cls.epsilon, flange: cls.flange, web: cls.web,
        c_flange_ratio: cls.c_flange_ratio, c_web_ratio: cls.c_web_ratio,
        limits_flange: cls.limits_flange, limits_web: cls.limits_web,
        note: cls.note,
        // A check that cannot be evaluated is reported as INFO and must not
        // drag the member's overall verdict to FAIL.
        status: cls.notApplicable ? 'INFO' : (cls.cls <= 3 ? 'OK' : 'FAIL'),
        pass:   cls.notApplicable ? true   : cls.cls <= 3,
        eta: null });

      // 2. Axial / Buckling (with K-factors)
      const ax = axialCheck(ef, sec, Lcr, Ky, Kz);
      checks.push(ax);

      // 3. Shear — evaluated BEFORE flexure so its §6.2.8 reduction factor can
      //    actually reach the moment capacity rather than just being printed.
      const sh = shearCheck(ef, sec);

      // 4. Flexure (LTB uses Lcr for lateral buckling length)
      const fl = flexuralCheck(ef, sec, Lcr, sh.rho_V);
      checks.push(fl);
      checks.push(sh);

      // 5. Plate Buckling (for sections with dimensional data)
      const pb = plateBucklingCheck(sec);
      checks.push(pb);

      // 6. Torsion (informational for 2D)
      const to = torsionCheck(ef, sec);
      checks.push(to);

      // 7. Combined interaction (only if compression present)
      if (Math.abs(ef.N1) > 0.01 || Math.abs(ef.N2) > 0.01) {
        const ix = interactionCheck(ef, sec, ax, fl);
        checks.push(ix);
      }

      // 8. Deflection — sec supplies EI, without which only end values are available
      const df = deflectionCheck(ef, ef.L, bm.spanType || 'simply-supported', sec, spanOf[ef.id]);
      checks.push(df);

      // 8. Modifier description
      if (bm.modifiers) {
        const md = describeModifiers(bm.modifiers, secMap[bm.sectionId]);
        checks.push({ check: 'Property Modifiers', ...md, status: 'INFO', pass: true, eta: null });
      }

      // Overall status for this beam
      const fails = checks.filter(c => classifyStatus(c.status) === 'FAIL').length;
      const nears = checks.filter(c => classifyStatus(c.status) === 'NEAR').length;
      const overall = fails > 0 ? 'FAIL' : nears > 0 ? 'NEAR' : 'OK';
      if (overall === 'FAIL') globalPass = false;
      if (overall === 'NEAR') globalNear = true;

      // Max utilization (excluding INFO/null)
      const etas = checks.map(c => c.eta).filter(e => e !== null && e !== undefined);
      const maxEta = etas.length > 0 ? Math.max(...etas) : 0;

      byBeam.push({
        id:      bm.id,
        label:   bm.label || _memberLabel(bm),
        secName: sec.name || sec.id,
        L:       +ef.L.toFixed(3),
        checks,
        overall,
        maxEta:  +maxEta.toFixed(4),
        cls:     cls.cls
      });
    }

    const summary = {
      total:  byBeam.length,
      pass:   byBeam.filter(b => b.overall === 'OK').length,
      near:   byBeam.filter(b => b.overall === 'NEAR').length,
      fail:   byBeam.filter(b => b.overall === 'FAIL').length,
      globalStatus: globalPass ? (globalNear ? 'NEAR' : 'OK') : 'FAIL'
    };

    return { byBeam, summary };
  }

  // ── Expose public API ────────────────────────────────────────────────────
  return {
    classifySection,
    flexuralCheck,
    shearCheck,
    axialCheck,
    plateBucklingCheck,
    torsionCheck,
    interactionCheck,
    deflectionCheck,
    describeModifiers,
    applyModifiers,
    runDesignChecks,
    getSectionModuli,
    classifyStatus,
    // Constants
    γM0, γM1, γM2,
    ALPHA,
    // Internal forces along a member. ReportGenerator delegates to these so the
    // diagrams and the checks are computed by one implementation.
    internalForceAt, sampleInternalForces, maxInternalForce, designMoment,
    // Physical spans — collinear elements chained between supports — and the
    // deflection measured from the whole span's chord.
    buildSpans, spanDeflection
  };

})();

// Global export
window.DesignChecks = DesignChecks;
