// ACI 318-19 Chapter 5 — Development, Anchorage & Splicing
// Reference: Arman, "Design of RC Structures", Ch.5
window.ACI_Ch5 = (function () {

  // ── Development length — tension (ACI 318M-19 Table 25.4.2.3a, SI) ─
  // Simplified: assumes (cb + Ktr)/db = 1.5 (normal condition)
  //
  //   ld = [ fy·ψt·ψe·ψs / (1.1·λ·√f'c·((cb+Ktr)/db)) ] · db     f'c, fy in MPa
  //
  // The coefficient was 3/40, which is the INCH-POUND form of this equation
  // (f'c and fy in psi). Against MPa inputs that understates ld by ~12x — a
  // #8 bar at f'c = 30, fy = 420 came out at 96 mm against a correct 1162 mm,
  // then got hidden behind the 300 mm floor. Same defect as the copy in
  // design/aci_checks.js; ld_compression below already used SI coefficients.
  function ld_tension(db_mm, fy_MPa, fc_MPa, psi_t = 1.0, psi_e = 1.0, psi_s = null, lambda = 1.0) {
    const psi_s_val = psi_s !== null ? psi_s : (db_mm <= 19 ? 0.8 : 1.0);
    const cb_Ktr_db = 1.5; // conservative normal condition
    const ld = (fy_MPa * psi_t * psi_e * psi_s_val) /
               (1.1 * lambda * Math.sqrt(fc_MPa) * cb_Ktr_db) * db_mm;
    return Math.max(ld, 300); // ACI minimum 300mm
  }

  // ── Development length — compression (ACI 318-19 §25.4.9) ─────────
  function ld_compression(db_mm, fy_MPa, fc_MPa, lambda = 1.0) {
    const ld1 = 0.24 * fy_MPa * db_mm / (lambda * Math.sqrt(fc_MPa));
    const ld2 = 0.043 * fy_MPa * db_mm;
    return Math.max(ld1, ld2, 200); // min 200mm
  }

  // ── Standard hook — tension (ACI 318-19 §25.4.3) ──────────────────
  function ldh(db_mm, fy_MPa, fc_MPa, psi_e = 1.0, psi_r = 1.0, psi_o = 1.0, psi_c = 1.0, lambda = 1.0) {
    const lh = (0.24 * psi_e * psi_r * psi_o * psi_c * fy_MPa) / (lambda * Math.sqrt(fc_MPa)) * db_mm;
    return Math.max(lh, 8 * db_mm, 150); // min 8db or 150mm
  }

  // ── Lap splices — tension (ACI 318-19 §25.5.2) ────────────────────
  function lapSplice(ld_mm, classType = 'B') {
    const factor = classType === 'A' ? 1.0 : 1.3;
    return factor * ld_mm;
  }

  // ── Modification factors (common cases) ───────────────────────────
  const PSI_T = {
    'Top bars (> 300mm fresh concrete below)': 1.3,
    'Other bars': 1.0,
  };
  const PSI_E = {
    'Epoxy-coated, cover < 3db or clear < 6db': 1.5,
    'Epoxy-coated, other': 1.2,
    'Uncoated or zinc-coated': 1.0,
  };
  const PSI_S = {
    'No. 19 and smaller': 0.8,
    'No. 22 and larger': 1.0,
  };

  // ── Hook geometry (ACI 318-19 §25.3.2) ───────────────────────────
  function hookGeometry(db_mm, hookType = '90deg', barNum = 16) {
    if (hookType === '90deg') {
      const bend = 4 * db_mm;
      const ext  = barNum <= 16 ? Math.max(6 * db_mm, 75) : 12 * db_mm;
      return { bend_radius: bend / 2, extension: ext };
    }
    if (hookType === '180deg') {
      const bend = 4 * db_mm;
      const ext  = Math.max(4 * db_mm, 65);
      return { bend_radius: bend / 2, extension: ext };
    }
    return null;
  }

  return { ld_tension, ld_compression, ldh, lapSplice, PSI_T, PSI_E, PSI_S, hookGeometry };
})();
