// ACI 318-19 Chapter 3 — Ultimate Design: Flexure in Beams
// Reference: Arman, "Design of RC Structures", Ch.3
window.ACI_Ch3 = (function () {

  function _beta1(fc) { return window.ACI_Ch1 ? ACI_Ch1.beta1(fc) : (fc <= 28 ? 0.85 : fc >= 56 ? 0.65 : 0.85 - 0.05*(fc-28)/7); }
  function _phi(et, ety) {
    if (et >= ety + 0.003) return 0.90;
    if (et <= ety) return 0.65;
    return 0.65 + 0.25 * (et - ety) / 0.003;
  }

  // ── 3.1 Analysis — singly reinforced rectangular ──────────────────
  function analyzeRect(As_mm2, b_mm, d_mm, fc_MPa, fy_MPa, lambda = 1.0) {
    const beta1 = _beta1(fc_MPa);
    const ety   = fy_MPa / 200000;
    const a     = As_mm2 * fy_MPa / (0.85 * fc_MPa * b_mm);
    const c     = a / beta1;
    const et    = 0.003 * (d_mm - c) / c;
    const phi   = _phi(et, ety);
    const Mn    = As_mm2 * fy_MPa * (d_mm - a / 2) / 1e6; // kNm
    return {
      a, c, beta1, et, ety,
      phi, Mn, phiMn: phi * Mn,
      tension_controlled: et >= ety + 0.003,
      classification: et >= ety + 0.003 ? 'Tension-controlled' : et <= ety ? 'Compression-controlled' : 'Transition',
    };
  }

  // ── 3.2 Design — singly reinforced rectangular ────────────────────
  function designRect(Mu_kNm, b_mm, d_mm, fc_MPa, fy_MPa) {
    const Mu_Nmm = Mu_kNm * 1e6;
    const beta1  = _beta1(fc_MPa);
    const rhoMin = Math.max(0.25 * Math.sqrt(fc_MPa) / fy_MPa, 1.4 / fy_MPa);
    const rhoMax = 0.375 * beta1 * 0.85 * fc_MPa / fy_MPa; // εt = 0.005 limit
    const rhoBalance = 0.6 * beta1 * 0.85 * fc_MPa / fy_MPa; // εt = ety ≈ 0.002

    // ρ from Mu = ϕ Rn bd², Rn = Mu/(ϕ bd²), ρ = (0.85f'c/fy)[1 - √(1 - 2Rn/0.85f'c)]
    const phi = 0.90;
    const Rn  = Mu_Nmm / (phi * b_mm * d_mm * d_mm);
    const disc = 1 - 2 * Rn / (0.85 * fc_MPa);
    if (disc < 0) return { error: 'Section too small — increase b or d' };

    const rho = (0.85 * fc_MPa / fy_MPa) * (1 - Math.sqrt(disc));
    const rhoUse = Math.max(rho, rhoMin);
    const As    = rhoUse * b_mm * d_mm;

    // Verify
    const check = analyzeRect(As, b_mm, d_mm, fc_MPa, fy_MPa);
    return { rho, rhoMin, rhoMax, rhoBalance, rhoUse, As, check,
      ok: rhoUse <= rhoMax && check.phiMn >= Mu_kNm * 0.999 };
  }

  // ── 3.3 Minimum beam thickness (ACI 318-19 Table 9.3.1.1) ─────────
  const MIN_THICKNESS = {
    'Simply supported': { slab: 20, beam: 16 },
    'One end continuous': { slab: 24, beam: 18.5 },
    'Both ends continuous': { slab: 28, beam: 21 },
    'Cantilever': { slab: 10, beam: 8 },
  };

  function minThickness(L_mm, supportCond, fy_MPa, member = 'beam') {
    const table = MIN_THICKNESS[supportCond];
    if (!table) return null;
    const divisor = table[member];
    const h = (L_mm / divisor) * (0.4 + fy_MPa / 700);
    return h; // mm
  }

  // ── 3.5 ρmax for singly reinforced (εt = 0.005) ──────────────────
  function rhoMax(fc_MPa, fy_MPa) {
    return 0.375 * _beta1(fc_MPa) * 0.85 * fc_MPa / fy_MPa;
  }

  // ── 3.6 T-beam effective flange width (ACI 318-14 Table 6.3.2.1) ─
  function effectiveFlangeWidth(bw_mm, hf_mm, sw_mm, Ln_mm, side = 'both') {
    if (side === 'both') {
      const each = Math.min(8 * hf_mm, sw_mm / 2, Ln_mm / 8);
      return bw_mm + 2 * each;
    } else { // one side (L-beam)
      const one = Math.min(6 * hf_mm, sw_mm / 2, Ln_mm / 12);
      return bw_mm + one;
    }
  }

  // ── 3.7 Analysis — doubly reinforced rectangular ──────────────────
  function analyzeDoubly(As_mm2, Asp_mm2, b_mm, d_mm, dp_mm, fc_MPa, fy_MPa) {
    const beta1 = _beta1(fc_MPa);
    const ety   = fy_MPa / 200000;
    // Assume both steel layers yield; iterate if needed
    let a = (As_mm2 - Asp_mm2) * fy_MPa / (0.85 * fc_MPa * b_mm);
    let c = a / beta1;
    // Check compression steel strain
    const ep = 0.003 * (c - dp_mm) / c;
    const fsp = Math.min(ep * 200000, fy_MPa);
    // Revise if compression steel doesn't yield
    a = (As_mm2 * fy_MPa - Asp_mm2 * fsp) / (0.85 * fc_MPa * b_mm);
    c = a / beta1;
    const et  = 0.003 * (d_mm - c) / c;
    const phi = _phi(et, ety);
    const Mn  = (0.85 * fc_MPa * b_mm * a * (d_mm - a / 2) + Asp_mm2 * fsp * (d_mm - dp_mm)) / 1e6;
    return { a, c, et, fsp, phi, Mn, phiMn: phi * Mn };
  }

  // ── 3.10 ACI coefficients for continuous beams/slabs ─────────────
  const ACI_COEFF = {
    // [location, wuln²/N, condition]
    moment: [
      { label: 'Pos. — end span (disc. end)',    coeff: 1/11, type: 'pos' },
      { label: 'Pos. — end span (integral end)', coeff: 1/14, type: 'pos' },
      { label: 'Pos. — interior spans',          coeff: 1/16, type: 'pos' },
      { label: 'Neg. — ext. face 1st int. sup.', coeff: -1/10, type: 'neg' },
      { label: 'Neg. — ext. face — ≥2 spans',   coeff: -1/11, type: 'neg' },
      { label: 'Neg. — int. face ext. sup. (integral)', coeff: -1/24, type: 'neg' },
      { label: 'Neg. — interior supports',       coeff: -1/11, type: 'neg' },
      { label: 'Neg. — face of col./beam support', coeff: -1/10, type: 'neg' },
    ],
    shear: [
      { label: 'Ext. face 1st int. support', coeff: 1.15 / 2 },
      { label: 'Face of all other supports', coeff: 1 / 2 },
    ],
  };

  function aciCoefficients(wu_kNm, Ln_m) {
    const Ln2 = Ln_m * Ln_m;
    return {
      moments: ACI_COEFF.moment.map(r => ({ ...r, value: r.coeff * wu_kNm * Ln2 })),
      shears:  ACI_COEFF.shear.map(r => ({ ...r, value: r.coeff * wu_kNm * Ln_m })),
    };
  }

  return {
    analyzeRect, designRect, minThickness, rhoMax,
    effectiveFlangeWidth, analyzeDoubly, aciCoefficients,
    MIN_THICKNESS, ACI_COEFF,
  };
})();
