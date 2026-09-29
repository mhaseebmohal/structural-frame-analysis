// ══════════════════════════════════════════════════════════════════════════════
//  beam_formulas.js — Quick Beam Formula Library
//  Closed-form solutions for common beam loading patterns
//  Ported from: engtools, tmgerard/vba-structural-engineering-math-library
//  Units: consistent SI (kN, m, kNm) — EI product in kN·m²
//         Input E [GPa], I [cm⁴] → EI = E×1e6 × I×1e-8 = E×I×0.01 [kN·m²]
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const BeamFormulas = (() => {

  // ── Helper: EI from section properties ───────────────────────────────────────
  function calcEI(E_GPa, I_cm4) {
    return E_GPa * 1e6 * I_cm4 * 1e-8;   // kN·m²
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  SIMPLY SUPPORTED BEAM  (both ends pinned)
  // ══════════════════════════════════════════════════════════════════════════════

  // ── SS1: Point load at any position ──────────────────────────────────────────
  // P [kN], L [m], a = distance from left support
  function ss_point(P, L, a) {
    const b  = L - a;
    const RA = P * b / L;
    const RB = P * a / L;
    const Mmax = RA * a;         // under load
    const xM   = a;
    return {
      case: 'SS — Point Load at x=a',
      RA, RB,
      Mmax, xM,
      reactions: { RA, RB },
      M: x => {
        if (x < 0 || x > L) return 0;
        return x <= a ? RA * x : RA * x - P * (x - a);
      },
      V: x => {
        if (x < 0 || x > L) return 0;
        return x < a ? RA : RA - P;
      },
      // Deflection: ymax (at xmax)
      //
      // The elastic curve y(x) = P·b·x·(L² − b² − x²)/(6·EI·L) describes the
      // segment on the side of length a, so its peak at x = √((L² − b²)/3) is
      // only inside that segment when a ≥ b. The case split was the other way
      // round, so an off-centre load used the peak of the wrong segment: a
      // 100 kN load 8 m along a 10 m span came out 19.6 % light. Correct at
      // mid-span, which is why it looked right.
      //
      // Written in terms of the SHORTER segment, the peak always lies in the
      // longer one and the same expression serves both cases.
      xMax: (a >= b)
        ? Math.sqrt((L * L - b * b) / 3)               // from the left support
        : L - Math.sqrt((L * L - a * a) / 3),          // mirror image
      deflFormula: (EI) => {
        const near = Math.min(a, b);                    // shorter segment
        const xm   = Math.sqrt((L * L - near * near) / 3);
        return { ymax: P * near * xm * (L * L - near * near - xm * xm) / (6 * EI * L),
                 yAt_a: P * a * a * b * b / (3 * EI * L) };
      }
    };
  }

  // ── SS2: Uniformly distributed load (full span) ───────────────────────────────
  // w [kN/m], L [m]
  function ss_udl(w, L) {
    const R = w * L / 2;
    const Mmax = w * L * L / 8;
    return {
      case: 'SS — Full UDL',
      RA: R, RB: R,
      Mmax, xM: L / 2,
      M: x => (x < 0 || x > L) ? 0 : w * x * (L - x) / 2,
      V: x => (x < 0 || x > L) ? 0 : R - w * x,
      deflFormula: (EI) => ({
        ymax: 5 * w * Math.pow(L, 4) / (384 * EI),
        slope_end: w * Math.pow(L, 3) / (24 * EI)
      })
    };
  }

  // ── SS3: Partial UDL (from a to b, measured from left support) ────────────────
  // w [kN/m], L, a = start, b = end of load
  function ss_partial_udl(w, L, a, b_end) {
    const lw = b_end - a;     // loaded length
    const W  = w * lw;
    const RA = W * (L - a - lw / 2) / L;
    const RB = W - RA;
    // Mmax (search in [a, b_end])
    let Mmax = 0, xM = 0;
    for (let xi = 0; xi <= L; xi += L / 1000) {
      let M;
      if (xi <= a)      M = RA * xi;
      else if (xi <= b_end) M = RA * xi - w * (xi - a) * (xi - a) / 2;
      else              M = RB * (L - xi);
      if (M > Mmax) { Mmax = M; xM = xi; }
    }
    return {
      case: 'SS — Partial UDL',
      RA, RB, Mmax, xM,
      M: x => {
        if (x < 0 || x > L) return 0;
        if (x <= a)      return RA * x;
        if (x <= b_end)  return RA * x - w * (x - a) * (x - a) / 2;
        return RB * (L - x);
      },
      V: x => {
        if (x < 0 || x > L) return 0;
        if (x < a)       return RA;
        if (x <= b_end)  return RA - w * (x - a);
        return -RB;
      }
    };
  }

  // ── SS4: Moment at any position ──────────────────────────────────────────────
  function ss_moment(M0, L, a) {
    const RA = M0 / L;
    const RB = -RA;
    return {
      case: 'SS — Applied Moment at x=a',
      RA, RB,
      Mmax: Math.max(RA * a, M0 - RA * a),
      xM: a,
      M: x => {
        if (x < 0 || x > L) return 0;
        return x <= a ? RA * x : RA * x - M0;
      },
      V: x => (x < 0 || x > L) ? 0 : RA
    };
  }

  // ── SS5: Triangular load (0 at left, wmax at right) ──────────────────────────
  function ss_triangular(wmax, L) {
    const RA = wmax * L / 6;
    const RB = wmax * L / 3;
    return {
      case: 'SS — Triangular Load (0→w)',
      RA, RB,
      // M(x) = RA·x − wmax·x³/(6L), peaking at x = L/√3. Evaluating it there
      // gives wmax·L²/(9√3); the reported figure was RA·L/√3, the first term
      // only — the load's own contribution had been dropped, leaving Mmax
      // exactly 50 % high. The M(x) function below was always correct, so the
      // diagram and the headline number disagreed.
      Mmax: wmax * L * L / (9 * Math.sqrt(3)),
      xM: L / Math.sqrt(3),
      M: x => (x < 0 || x > L) ? 0 : RA * x - wmax * x * x * x / (6 * L),
      V: x => (x < 0 || x > L) ? 0 : RA - wmax * x * x / (2 * L),
      deflFormula: (EI) => ({
        // Δmax = 0.01304·W·L³/EI with W the TOTAL load (= wmax·L/2), which is
        // 0.00652·wmax·L⁴/EI. The tabulated 0.01304 was used against wmax
        // rather than W, doubling the reported deflection.
        ymax: 0.00652 * wmax * Math.pow(L, 4) / EI,
        xMax: 0.5193 * L
      })
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  CANTILEVER BEAM  (left end fixed, right end free)
  // ══════════════════════════════════════════════════════════════════════════════

  // ── CL1: Point load at free end ───────────────────────────────────────────────
  function cl_point_end(P, L) {
    return {
      case: 'Cantilever — Point Load at Free End',
      RA: P, MA: -P * L,   // reactions at fixed end (neg moment = hogging)
      Mmax: P * L, xM: 0,
      M: x => (x < 0 || x > L) ? 0 : -P * (L - x),
      V: x => (x < 0 || x > L) ? 0 : P,
      deflFormula: (EI) => ({
        ymax: P * Math.pow(L, 3) / (3 * EI),
        slope_end: P * L * L / (2 * EI)
      })
    };
  }

  // ── CL2: Point load at any position from fixed end ───────────────────────────
  function cl_point_x(P, L, a) {
    return {
      case: 'Cantilever — Point Load at x=a',
      RA: P, MA: -P * a,
      Mmax: P * a, xM: 0,
      M: x => {
        if (x < 0 || x > L) return 0;
        return x <= a ? -P * (a - x) : 0;
      },
      V: x => (x < 0 || x > L) ? 0 : (x <= a ? P : 0),
      deflFormula: (EI) => ({
        ymax: P * a * a * (3 * L - a) / (6 * EI),
        yAt_a: P * Math.pow(a, 3) / (3 * EI)
      })
    };
  }

  // ── CL3: Full UDL ──────────────────────────────────────────────────────────
  function cl_udl(w, L) {
    return {
      case: 'Cantilever — Full UDL',
      RA: w * L, MA: -w * L * L / 2,
      Mmax: w * L * L / 2, xM: 0,
      M: x => (x < 0 || x > L) ? 0 : -w * (L - x) * (L - x) / 2,
      V: x => (x < 0 || x > L) ? 0 : w * (L - x),
      deflFormula: (EI) => ({
        ymax: w * Math.pow(L, 4) / (8 * EI),
        slope_end: w * Math.pow(L, 3) / (6 * EI)
      })
    };
  }

  // ── CL4: Triangular load (0 at fixed, wmax at free) ──────────────────────────
  function cl_triangular(wmax, L) {
    return {
      case: 'Cantilever — Triangular Load (0→w at free)',
      RA: wmax * L / 2, MA: -wmax * L * L / 6,
      Mmax: wmax * L * L / 6, xM: 0,
      M: x => {
        if (x < 0 || x > L) return 0;
        const dist = L - x;  // from free end
        return -wmax * dist * dist * dist / (6 * L);
      },
      V: x => (x < 0 || x > L) ? 0 : wmax * (L - x) * (L - x) / (2 * L),
      deflFormula: (EI) => ({
        ymax: wmax * Math.pow(L, 4) / (30 * EI)
      })
    };
  }

  // ── CL5: Moment at free end ────────────────────────────────────────────────
  function cl_moment_end(M0, L) {
    return {
      case: 'Cantilever — Moment at Free End',
      RA: 0, MA: -M0,
      Mmax: Math.abs(M0), xM: 0,
      M: x => (x < 0 || x > L) ? 0 : -M0,
      V: () => 0,
      deflFormula: (EI) => ({
        ymax: M0 * L * L / (2 * EI),
        slope_end: M0 * L / EI
      })
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  FIXED-FIXED BEAM
  // ══════════════════════════════════════════════════════════════════════════════

  // ── FF1: Point load at any position ──────────────────────────────────────────
  function ff_point(P, L, a) {
    const b = L - a;
    const RA = P * b * b * (L + 2 * a) / (L * L * L);
    const RB = P * a * a * (L + 2 * b) / (L * L * L);
    const MA = -P * a * b * b / (L * L);  // fixed-end moment left (hogging = neg)
    const MB = P * a * a * b / (L * L);   // fixed-end moment right
    return {
      case: 'Fixed-Fixed — Point Load at x=a',
      RA, RB, MA, MB,
      Mmax: Math.max(Math.abs(MA), Math.abs(MB), RA * a + MA),
      M: x => {
        if (x < 0 || x > L) return 0;
        if (x <= a) return MA + RA * x;
        return MA + RA * x - P * (x - a);
      },
      V: x => {
        if (x < 0 || x > L) return 0;
        return x < a ? RA : RA - P;
      },
      deflFormula: (EI) => {
        // Δmax = 2·P·a³·b² / (3·EI·(L + 2a)²) at x = 2aL/(L + 2a), with a taken
        // as the LONGER segment. The old expression was simply 2 × the
        // deflection under the load, which is not the peak of anything: at
        // mid-span it reported PL³/96EI where the true figure is PL³/192EI —
        // exactly double — and 73 % high for an off-centre load.
        const aa = Math.max(a, b), bb = Math.min(a, b);
        const denom = L + 2 * aa;
        return {
          ymax:  2 * P * Math.pow(aa, 3) * bb * bb / (3 * EI * denom * denom),
          xMax:  (a >= b) ? 2 * aa * L / denom : L - 2 * aa * L / denom,
          yAt_a: P * a * a * a * b * b * b / (3 * EI * L * L * L)
        };
      }
    };
  }

  // ── FF2: Full UDL ──────────────────────────────────────────────────────────
  function ff_udl(w, L) {
    const R = w * L / 2;
    const Mend = w * L * L / 12;     // fixed-end moment (hogging)
    const Mmid = w * L * L / 24;     // mid-span (sagging)
    return {
      case: 'Fixed-Fixed — Full UDL',
      RA: R, RB: R, MA: -Mend, MB: -Mend,
      Mmax: Mend,                     // at ends
      Mmid,
      M: x => (x < 0 || x > L) ? 0 : w * x * (L - x) / 2 - Mend,
      V: x => (x < 0 || x > L) ? 0 : R - w * x,
      deflFormula: (EI) => ({
        ymax: w * Math.pow(L, 4) / (384 * EI)
      })
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  PROPPED CANTILEVER (left fixed, right pinned)
  // ══════════════════════════════════════════════════════════════════════════════

  // ── PC1: Full UDL ─────────────────────────────────────────────────────────
  function pc_udl(w, L) {
    const RB = 3 * w * L / 8;        // prop reaction
    const RA = w * L - RB;
    const MA = -w * L * L / 8;       // fixed end moment (hogging)
    const xV0 = RA / w;              // zero shear position
    const Mmax = RA * xV0 - w * xV0 * xV0 / 2 + MA;
    return {
      case: 'Propped Cantilever — Full UDL',
      RA, RB, MA,
      Mmax, xM: xV0,
      M: x => (x < 0 || x > L) ? 0 : MA + RA * x - w * x * x / 2,
      V: x => (x < 0 || x > L) ? 0 : RA - w * x,
      deflFormula: (EI) => ({
        ymax: w * Math.pow(L, 4) / (185 * EI)  // ≈ at x=0.5785L
      })
    };
  }

  // ── PC2: Point load at free end ───────────────────────────────────────────
  // RA = 11P/16, RB = 5P/16, MA = −3PL/16 are the coefficients for a load at
  // MID-SPAN, which is also what the UI offers (it asks only for P and L). The
  // case was labelled "at Prop" and its M(x) never subtracted the load, so the
  // moment ran straight from MA to +PL/2 at the propped end — where a pin can
  // carry no moment at all — V was constant with no step under the load, and
  // the quoted deflection was the simply-supported PL³/48EI rather than the
  // propped-cantilever value.
  function pc_point_end(P, L) {
    const RB = 5 * P / 16;      // prop reaction
    const RA = P - RB;          // = 11P/16
    const MA = -3 * P * L / 16; // fixed-end moment (hogging)
    const a  = L / 2;           // load position
    return {
      case: 'Propped Cantilever — Point Load at Mid-span',
      RA, RB, MA,
      // Sagging peak sits under the load: MA + RA·L/2 = 5PL/32.
      Mmax: Math.max(Math.abs(MA), Math.abs(MA + RA * a)),
      M_sag: MA + RA * a,
      xM: 0,
      M: x => {
        if (x < 0 || x > L) return 0;
        return x <= a ? MA + RA * x : MA + RA * x - P * (x - a);
      },
      V: x => (x < 0 || x > L) ? 0 : (x < a ? RA : RA - P),
      deflFormula: (EI) => ({
        // Δmax = 0.009317·P·L³/EI at x ≈ 0.5528·L (≈ PL³/107EI).
        ymax: 0.009317 * P * Math.pow(L, 3) / EI,
        xMax: 0.5528 * L
      })
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  CONTINUOUS BEAM (2-span, equal spans, using 3-moment theorem)
  // ══════════════════════════════════════════════════════════════════════════════

  // ── 2-span with UDL on both spans ────────────────────────────────────────────
  // Three-moment equation, pinned outer ends (M0 = M2 = 0):
  //     2·M1·(L1 + L2) = −w·(L1³ + L2³)/4
  //  →  M1 = −w·(L1³ + L2³) / (8·(L1 + L2))
  //
  // Two errors compounded here. The factor 2 on the left was dropped, making M1
  // twice the true hogging moment, and the end reactions then ADDED M1/L rather
  // than subtracting it. For two 10 m spans under 20 kN/m the result was
  // RA = RC = 150 kN and RB = 100 kN against the correct 75 / 250 — the middle
  // support carrying 40 % of what it should. RB is formed by difference, so ΣR
  // still balanced the applied load and nothing looked obviously wrong.
  function two_span_udl(w, L1, L2) {
    const M1 = -w * (L1 * L1 * L1 + L2 * L2 * L2) / (8 * (L1 + L2));   // hogging, negative
    const RA  = w * L1 / 2 + M1 / L1;
    const RC  = w * L2 / 2 + M1 / L2;
    const RB  = w * L1 + w * L2 - RA - RC;

    // Moment at mid-span, and the true span peak (where shear crosses zero).
    const M_mid1 = RA * L1 / 2 - w * L1 * L1 / 8;
    const M_mid2 = RC * L2 / 2 - w * L2 * L2 / 8;
    const xp1 = w > 0 ? RA / w : 0, xp2 = w > 0 ? RC / w : 0;
    const Mpk1 = RA * xp1 - w * xp1 * xp1 / 2;
    const Mpk2 = RC * xp2 - w * xp2 * xp2 / 2;

    return {
      case: '2-Span Continuous — Equal UDL on Both Spans',
      RA, RB, RC, M1,
      M_mid1, M_mid2,
      M_peak1: Mpk1, M_peak2: Mpk2,
      x_peak1: xp1, x_peak2: xp2,
      Mmax_support: Math.abs(M1),
      // The sagging maximum is at zero shear, not at mid-span — for equal spans
      // it is 9wL²/128 at 0.375L, against wL²/16 at mid-span.
      Mmax_span: Math.max(Math.abs(Mpk1), Math.abs(Mpk2))
    };
  }

  // ── 2-span with point load at mid of each span ────────────────────────────────
  // Three-moment equation with a point load in each span. The load term for a
  // single load P at distance a from the far (outer) support of a span L is
  //     6·A·ā / L = P·a·(L² − a²) / L
  // which for a mid-span load reduces to 3PL²/8.
  //
  // The expression used before, P·a·b·(L² − a² − b²)/L, is not that term and is
  // not even dimensionally consistent with it — it carries an extra power of
  // length, so M1 came out as −PL²/16 instead of −3PL/16. For two 6 m spans
  // with 80 kN at each mid-span that put the middle reaction at −25 kN: a
  // support in tension under two downward loads.
  function two_span_point_mids(P1, L1, P2, L2) {
    const a1 = L1 / 2;   // load position from the outer support of span 1
    const a2 = L2 / 2;   // load position from the outer support of span 2
    const term1 = P1 * a1 * (L1 * L1 - a1 * a1) / L1;
    const term2 = P2 * a2 * (L2 * L2 - a2 * a2) / L2;
    const M1 = -(term1 + term2) / (2 * (L1 + L2));    // hogging, negative

    // Outer reactions: simple-span share plus the continuity correction.
    const RA = P1 * (L1 - a1) / L1 + M1 / L1;
    const RC = P2 * (L2 - a2) / L2 + M1 / L2;
    const RB = P1 + P2 - RA - RC;

    // Sagging moment under each load.
    const M_span1 = RA * a1;
    const M_span2 = RC * a2;

    return {
      case: '2-Span Continuous — Point Loads at Midspan',
      RA, RB, RC, M1,
      M_span1, M_span2,
      Mmax_support: Math.abs(M1),
      Mmax_span: Math.max(Math.abs(M_span1), Math.abs(M_span2))
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  DIAGRAM DATA GENERATOR  (for plotting M, V, δ along beam length)
  // ══════════════════════════════════════════════════════════════════════════════

  function generateDiagram(beamCase, L, EI, nPts = 100) {
    const dx = L / nPts;
    const pts = { x: [], M: [], V: [], d: [] };
    for (let i = 0; i <= nPts; i++) {
      const x = i * dx;
      pts.x.push(x);
      pts.M.push(beamCase.M ? beamCase.M(x) : 0);
      pts.V.push(beamCase.V ? beamCase.V(x) : 0);
    }
    // Numerical deflection by double integration (EI · d²y/dx² = M)
    // Central difference integration
    if (EI > 0) {
      const M_arr = pts.M;
      const d2y   = M_arr.map(m => m / EI);
      const dy    = new Array(nPts + 1).fill(0);
      const y     = new Array(nPts + 1).fill(0);
      // Simply integrate twice; BCs applied by finding the integration constants
      // Pass 1: integrate d2y to get dy (slope)
      for (let i = 1; i <= nPts; i++) dy[i] = dy[i-1] + 0.5 * (d2y[i-1] + d2y[i]) * dx;
      // Pass 2: integrate dy to get y (deflection)
      for (let i = 1; i <= nPts; i++) y[i] = y[i-1] + 0.5 * (dy[i-1] + dy[i]) * dx;
      // Apply BCs: force y[0]=0, y[nPts]=0 for SS; y[0]=0 for cantilever
      const yL = y[nPts];
      const c  = -yL / L;
      for (let i = 0; i <= nPts; i++) y[i] += c * i * dx;
      pts.d = y;
    }
    return pts;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  UI BUILDER
  // ══════════════════════════════════════════════════════════════════════════════

  const CASES = [
    { id:'ss_point',        label:'SS — Point Load (at any x)',       fn: ss_point,       params:[['P','Load P [kN]',100],['L','Span L [m]',6],['a','Distance a [m]',3]] },
    { id:'ss_udl',          label:'SS — Full UDL',                    fn: ss_udl,         params:[['w','UDL w [kN/m]',20],['L','Span L [m]',6]] },
    { id:'ss_partial_udl',  label:'SS — Partial UDL (a to b)',        fn: ss_partial_udl, params:[['w','UDL w [kN/m]',20],['L','Span L [m]',6],['a','Start a [m]',1],['b_end','End b [m]',4]] },
    { id:'ss_moment',       label:'SS — Applied Moment',              fn: ss_moment,      params:[['M0','Moment M [kNm]',50],['L','Span L [m]',6],['a','Pos a [m]',3]] },
    { id:'ss_triangular',   label:'SS — Triangular Load (0 to w)',    fn: ss_triangular,  params:[['wmax','Max load w [kN/m]',30],['L','Span L [m]',6]] },
    { id:'cl_point_end',    label:'Cantilever — Point at Free End',   fn: cl_point_end,   params:[['P','Load P [kN]',50],['L','Length L [m]',4]] },
    { id:'cl_point_x',      label:'Cantilever — Point at x=a',        fn: cl_point_x,     params:[['P','Load P [kN]',50],['L','Length L [m]',4],['a','Pos a [m]',2]] },
    { id:'cl_udl',          label:'Cantilever — Full UDL',            fn: cl_udl,         params:[['w','UDL w [kN/m]',15],['L','Length L [m]',4]] },
    { id:'cl_triangular',   label:'Cantilever — Triangular (0→w)',    fn: cl_triangular,  params:[['wmax','Max load w [kN/m]',20],['L','Length L [m]',4]] },
    { id:'cl_moment_end',   label:'Cantilever — Moment at Free End',  fn: cl_moment_end,  params:[['M0','Moment M [kNm]',30],['L','Length L [m]',4]] },
    { id:'ff_point',        label:'Fixed-Fixed — Point Load',         fn: ff_point,       params:[['P','Load P [kN]',100],['L','Span L [m]',6],['a','Pos a [m]',3]] },
    { id:'ff_udl',          label:'Fixed-Fixed — Full UDL',           fn: ff_udl,         params:[['w','UDL w [kN/m]',20],['L','Span L [m]',6]] },
    { id:'pc_udl',          label:'Propped Cantilever — Full UDL',    fn: pc_udl,         params:[['w','UDL w [kN/m]',20],['L','Span L [m]',6]] },
    { id:'pc_point_end',    label:'Propped Cantilever — Point Load',  fn: pc_point_end,   params:[['P','Load P [kN]',80],['L','Span L [m]',6]] },
    { id:'two_span_udl',    label:'2-Span Continuous — UDL',          fn: two_span_udl,   params:[['w','UDL w [kN/m]',20],['L1','Span 1 L1 [m]',6],['L2','Span 2 L2 [m]',6]] },
    { id:'two_span_pts',    label:'2-Span — Point Loads at Midspan',  fn: two_span_point_mids, params:[['P1','Load P1 [kN]',80],['L1','Span 1 [m]',6],['P2','Load P2 [kN]',80],['L2','Span 2 [m]',6]] }
  ];

  function buildDialogHTML() {
    const opts = CASES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
    return `
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700;font-size:11px;color:var(--text-sec);margin-bottom:6px">BEAM CASE</div>
        <select id="bf-case" style="width:100%;padding:5px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px">
          ${opts}
        </select>

        <div id="bf-inputs" style="margin-top:10px"></div>

        <div style="margin-top:8px;border-top:1px solid var(--border-tbl);padding-top:8px">
          <div style="font-weight:700;font-size:11px;color:var(--text-sec);margin-bottom:4px">SECTION (for deflection)</div>
          <div class="form-row"><label style="font-size:11px">E [GPa]</label>
            <input type="number" id="bf-E" value="210" step="5" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px"></div>
          <div class="form-row"><label style="font-size:11px">I [cm⁴]</label>
            <input type="number" id="bf-I" value="8356" step="100" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px"></div>
        </div>

        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="btn-xs btn-blue" id="bf-calc">&#9654; Calculate</button>
          <button class="btn-xs" id="bf-copy">&#128203; Copy</button>
        </div>
      </div>

      <div style="flex:1.6;min-width:240px">
        <div id="bf-results" style="font-size:12px;max-height:480px;overflow:auto">
          <p style="color:#888">Select a beam case, enter values, and click Calculate.</p>
        </div>
        <canvas id="bf-diagram" width="360" height="180" style="margin-top:8px;border:1px solid var(--border);border-radius:4px;display:none;background:var(--bg-canvas,#fff)"></canvas>
      </div>
    </div>`;
  }

  function buildResultHTML(res, EI, L) {
    const fmt = (v, d = 3) => v !== undefined && v !== null ? v.toFixed(d) : '—';
    const defl = (res.deflFormula && EI > 0) ? res.deflFormula(EI) : null;
    let html = `
    <div style="font-weight:700;font-size:12px;color:#1565c0;margin-bottom:6px">${res.case}</div>
    <table class="res-tbl" style="width:100%">
      <thead><tr><th>Quantity</th><th>Value</th><th>Unit</th></tr></thead>
      <tbody>`;
    if (res.RA !== undefined) html += `<tr><td>RA (left reaction)</td><td>${fmt(res.RA)}</td><td>kN</td></tr>`;
    if (res.RB !== undefined) html += `<tr class="alt"><td>RB (right/prop)</td><td>${fmt(res.RB)}</td><td>kN</td></tr>`;
    if (res.RC !== undefined) html += `<tr><td>RC (right reaction)</td><td>${fmt(res.RC)}</td><td>kN</td></tr>`;
    if (res.MA !== undefined) html += `<tr class="alt"><td>MA (fixed-end moment)</td><td>${fmt(res.MA)}</td><td>kNm</td></tr>`;
    if (res.MB !== undefined) html += `<tr><td>MB (right moment)</td><td>${fmt(res.MB)}</td><td>kNm</td></tr>`;
    if (res.M1 !== undefined) html += `<tr class="alt"><td>M₁ (interior support)</td><td>${fmt(res.M1)}</td><td>kNm</td></tr>`;
    html += `<tr><td><b>Mmax (max moment)</b></td><td><b>${fmt(res.Mmax)}</b></td><td>kNm</td></tr>`;
    if (res.xM !== undefined) html += `<tr class="alt"><td>x at Mmax</td><td>${fmt(res.xM)}</td><td>m</td></tr>`;
    if (res.Mmid !== undefined) html += `<tr><td>M mid-span (sagging)</td><td>${fmt(res.Mmid)}</td><td>kNm</td></tr>`;
    if (defl) {
      html += `<tr class="alt"><td><b>δmax (max deflection)</b></td><td><b>${(defl.ymax * 1000).toFixed(2)}</b></td><td>mm</td></tr>`;
      if (defl.slope_end) html += `<tr><td>θ end slope</td><td>${(defl.slope_end * 1000).toFixed(4)}</td><td>mrad</td></tr>`;
      if (defl.yAt_a) html += `<tr class="alt"><td>δ at load point</td><td>${(defl.yAt_a*1000).toFixed(2)}</td><td>mm</td></tr>`;
      // L/δ ratio
      const ld = defl.ymax > 0 ? L / defl.ymax : 0;
      html += `<tr><td>L/δ ratio</td><td>${ld.toFixed(0)}</td><td>—</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  function drawDiagram(res, L, EI) {
    const cvs = document.getElementById('bf-diagram');
    if (!cvs || !res.M) return;
    cvs.style.display = '';
    const ctx = cvs.getContext('2d');
    const W   = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);

    const nPts = 80;
    const data = generateDiagram(res, L, EI, nPts);

    const Mmax = Math.max(...data.M.map(Math.abs), 0.01);
    const Vmax = Math.max(...data.V.map(Math.abs), 0.01);
    const pad  = 20;
    const lineH = (H - 4 * pad) / 2;

    // Background
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    ctx.fillStyle = isDark ? '#1e1e1e' : '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // BMD
    const yBmd = pad + lineH / 2;
    ctx.fillStyle = 'rgba(21,101,192,0.15)';
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= nPts; i++) {
      const px = pad + (W - 2*pad) * i / nPts;
      const py = yBmd - data.M[i] / Mmax * (lineH / 2);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineTo(pad + W - 2*pad, yBmd); ctx.lineTo(pad, yBmd);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = isDark ? '#ccc' : '#333';
    ctx.font = '10px sans-serif';
    ctx.fillText('BMD (kNm)', pad, pad - 5);
    ctx.fillText(`Max: ${Mmax.toFixed(1)}`, W - 80, pad - 5);

    // Baseline
    ctx.strokeStyle = isDark ? '#555' : '#999';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(pad, yBmd); ctx.lineTo(W - pad, yBmd); ctx.stroke();

    // SFD
    const ySfd = pad * 2 + lineH + lineH / 2;
    ctx.fillStyle = 'rgba(46,125,50,0.15)';
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= nPts; i++) {
      const px = pad + (W - 2*pad) * i / nPts;
      const py = ySfd - data.V[i] / Vmax * (lineH / 2);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineTo(pad + W - 2*pad, ySfd); ctx.lineTo(pad, ySfd);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = isDark ? '#ccc' : '#333';
    ctx.fillText('SFD (kN)', pad, pad * 2 + lineH - 2);
    ctx.fillText(`Max: ${Vmax.toFixed(1)}`, W - 80, pad * 2 + lineH - 2);

    ctx.strokeStyle = isDark ? '#555' : '#999';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(pad, ySfd); ctx.lineTo(W - pad, ySfd); ctx.stroke();
  }

  function wireDialog() {
    const caseEl   = document.getElementById('bf-case');
    const inputsEl = document.getElementById('bf-inputs');

    function refreshInputs() {
      const cid = caseEl.value;
      const def = CASES.find(c => c.id === cid);
      if (!def) return;
      inputsEl.innerHTML = def.params.map(([id, lbl, val]) => `
        <div class="form-row" style="margin-bottom:4px">
          <label style="font-size:11px;color:var(--text-sec)">${lbl}</label>
          <input type="number" id="bf-p-${id}" value="${val}" step="any"
            style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;
                   background:var(--bg-pane);color:var(--text);font-size:12px">
        </div>`).join('');
    }
    caseEl.addEventListener('change', refreshInputs);
    refreshInputs();

    document.getElementById('bf-calc').addEventListener('click', () => {
      const cid = caseEl.value;
      const def = CASES.find(c => c.id === cid);
      if (!def) return;
      const args = def.params.map(([id]) => parseFloat(document.getElementById(`bf-p-${id}`).value) || 0);
      try {
        const res  = def.fn(...args);
        const E    = parseFloat(document.getElementById('bf-E').value) || 210;
        const I    = parseFloat(document.getElementById('bf-I').value) || 8356;
        const EI   = calcEI(E, I);
        const L    = args[def.params.findIndex(([id]) => id === 'L' || id === 'L1')] || 6;
        const resEl = document.getElementById('bf-results');
        resEl.innerHTML = buildResultHTML(res, EI, L);
        drawDiagram(res, L, EI);
        document.getElementById('bf-calc')._lastRes = { res, EI, L };
      } catch (err) {
        document.getElementById('bf-results').innerHTML =
          `<div style="color:#e53935;padding:8px">${err.message}</div>`;
      }
    });

    document.getElementById('bf-copy').addEventListener('click', () => {
      const stored = document.getElementById('bf-calc')._lastRes;
      if (!stored) return;
      const { res } = stored;
      const txt = `${res.case}\nRA=${res.RA?.toFixed(3)} kN\nRB=${res.RB?.toFixed(3)} kN\nMmax=${res.Mmax?.toFixed(3)} kNm`;
      navigator.clipboard?.writeText(txt).then(() => {
        const btn = document.getElementById('bf-copy');
        const o = btn.textContent; btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = o, 1500);
      });
    });
  }

  return {
    // Core formula functions
    ss_point, ss_udl, ss_partial_udl, ss_moment, ss_triangular,
    cl_point_end, cl_point_x, cl_udl, cl_triangular, cl_moment_end,
    ff_point, ff_udl,
    pc_udl, pc_point_end,
    two_span_udl, two_span_point_mids,
    // Utilities
    calcEI, generateDiagram,
    // UI
    CASES, buildDialogHTML, buildResultHTML, drawDiagram, wireDialog
  };

})();

window.BeamFormulas = BeamFormulas;
