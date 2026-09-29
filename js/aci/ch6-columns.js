// ACI 318-19 Chapter 6 — Combined Compression & Bending (Columns)
// Reference: Arman, "Design of RC Structures", Ch.6
window.ACI_Ch6 = (function () {


  // ── ϕ factor for columns ──────────────────────────────────────────
  function phi_col(et, ety, type = 'tied') {
    if (et >= ety + 0.003) return 0.90;
    if (et <= ety) return type === 'spiral' ? 0.75 : 0.65;
    const base  = type === 'spiral' ? 0.75 : 0.65;
    const delta = type === 'spiral' ? 0.15 : 0.25;
    return base + delta * (et - ety) / 0.003;
  }

  // ── Pure axial capacity ───────────────────────────────────────────
  function Pn_pure(fc_MPa, fy_MPa, Ag_mm2, Ast_mm2, type = 'tied') {
    const k = type === 'spiral' ? 0.85 : 0.80;
    return k * (0.85 * fc_MPa * (Ag_mm2 - Ast_mm2) + Ast_mm2 * fy_MPa) / 1000; // kN
  }

  // ── Interaction diagram — single point ────────────────────────────
  // For rectangular section with symmetric steel (n_bars bars, total Ast)
  function interactionPoint(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm, c_mm) {
    const beta1 = window.ACI_Ch1 ? ACI_Ch1.beta1(fc_MPa) : 0.85;
    const d     = h_mm - cover_mm; // to tension steel centroid
    const dp    = cover_mm;        // compression steel centroid
    const a     = Math.min(beta1 * c_mm, h_mm);
    const Es_   = 200000;

    const et  = 0.003 * (d - c_mm) / c_mm;
    const ep  = 0.003 * (c_mm - dp) / c_mm;
    const ety = fy_MPa / Es_;

    const fs  = Math.min(Math.max(et  * Es_, -fy_MPa), fy_MPa);
    const fsp = Math.min(Math.max(ep  * Es_, -fy_MPa), fy_MPa);

    const Ast_half = Ast_mm2 / 2;
    const Cc = 0.85 * fc_MPa * b_mm * a;
    const Ts = Ast_half * fs;
    const Cs = Ast_half * fsp; // compression steel (net: subtract displaced concrete if needed)

    const Pn = (Cc + Cs - Ts) / 1000; // kN
    // Moment about centroid of section
    const Mn = (Cc * (h_mm / 2 - a / 2) + Cs * (h_mm / 2 - dp) - Ts * (h_mm / 2 - d)) / 1e6; // kNm

    const phi = phi_col(et, ety, 'tied');
    return { c_mm, a, et, ep, fs, fsp, Pn, Mn, phi, phiPn: phi * Pn, phiMn: phi * Mn };
  }

  // ── Full interaction diagram ───────────────────────────────────────
  function interactionDiagram(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm, n_points = 20) {
    const d     = h_mm - cover_mm;
    const points = [];

    // Pure compression point (c = ∞ effectively)
    const Ag  = b_mm * h_mm;
    const phi0 = 0.65;
    const Pn0  = 0.80 * (0.85 * fc_MPa * (Ag - Ast_mm2) + Ast_mm2 * fy_MPa) / 1000;
    points.push({ Pn: Pn0, Mn: 0, phiPn: phi0 * Pn0, phiMn: 0, label: 'Pure Compression' });

    // Sweep c from large to small
    const c_min = 0.001 * d;
    const c_max = 2.0 * h_mm;
    for (let i = 0; i <= n_points; i++) {
      const c = c_max - (c_max - c_min) * i / n_points;
      const pt = interactionPoint(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm, c);
      if (pt.Pn < -100) break; // deep tension
      points.push(pt);
    }

    // Pure bending (Pn = 0)
    const pt_bend = interactionPoint(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm, 0.001 * d);
    points.push({ ...pt_bend, label: 'Pure Bending' });

    return points;
  }

  // ── Balanced point ────────────────────────────────────────────────
  function balancedPoint(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm) {
    const ety = fy_MPa / 200000;
    const d   = h_mm - cover_mm;
    const cb  = 0.003 * d / (0.003 + ety);
    return interactionPoint(fc_MPa, fy_MPa, b_mm, h_mm, Ast_mm2, cover_mm, cb);
  }

  // ── Spiral reinforcement ratio (ACI 318-19 §25.7.3) ─────────────
  function rho_s_spiral(Ag_mm2, Ac_mm2, fc_MPa, fyt_MPa) {
    return 0.45 * (Ag_mm2 / Ac_mm2 - 1) * (fc_MPa / fyt_MPa);
  }

  // ── Tie spacing (ACI 318-19 §25.7.2) ──────────────────────────────
  function tieSpacing(db_long_mm, db_tie_mm, col_dim_mm) {
    return Math.min(16 * db_long_mm, 48 * db_tie_mm, col_dim_mm);
  }

  // ── Biaxial bending — Bresler reciprocal ─────────────────────────
  function biaxial(Pnx_kN, Pny_kN, Pno_kN) {
    return 1 / (1 / Pnx_kN + 1 / Pny_kN - 1 / Pno_kN);
  }

  return { phi_col, Pn_pure, interactionPoint, interactionDiagram, balancedPoint, rho_s_spiral, tieSpacing, biaxial };
})();
