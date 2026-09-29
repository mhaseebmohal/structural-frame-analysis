// ACI 318-19 Chapter 4 — Design for Shear
// Reference: Arman, "Design of RC Structures", Ch.4
window.ACI_Ch4 = (function () {

  // ── Vc — ACI 318-14 simplified ────────────────────────────────────
  function Vc_14(fc_MPa, bw_mm, d_mm, lambda = 1.0) {
    return 0.17 * lambda * Math.sqrt(fc_MPa) * bw_mm * d_mm / 1000; // kN
  }

  // ── Vc — ACI 318-19 (with Av ≥ Av,min) ───────────────────────────
  function Vc_19(fc_MPa, bw_mm, d_mm, rho_w, Nu_kN = 0, lambda = 1.0) {
    const Nu_N  = Nu_kN * 1000;
    const Ag    = bw_mm * (d_mm / 0.875); // approx Ag assuming d≈0.875h
    const axial = Nu_N / (6 * Ag);
    const Vc    = (0.66 * lambda * Math.pow(rho_w, 1 / 3) * Math.sqrt(fc_MPa) + axial) * bw_mm * d_mm;
    const Vcmax = (0.42 * lambda * Math.sqrt(fc_MPa) + axial) * bw_mm * d_mm;
    return Math.min(Vc, Vcmax) / 1000; // kN
  }

  // ── Vc — ACI 318-19 (without Av, size effect) ────────────────────
  function Vc_19_noAv(fc_MPa, bw_mm, d_mm, rho_w, Nu_kN = 0, lambda = 1.0) {
    const lambdaS = d_mm <= 250 ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_mm)));
    const Nu_N    = Nu_kN * 1000;
    const Ag      = bw_mm * (d_mm / 0.875);
    const axial   = Nu_N / (6 * Ag);
    const Vc      = (0.66 * lambdaS * lambda * Math.pow(rho_w, 1 / 3) * Math.sqrt(fc_MPa) + axial) * bw_mm * d_mm;
    return Vc / 1000; // kN
  }

  // ── 4.2 Stirrup design ────────────────────────────────────────────
  function stirrupDesign(Vu_kN, Vc_kN, d_mm, bw_mm, fc_MPa, fyt_MPa, phi = 0.75) {
    const Vn_req = Vu_kN / phi;
    const Vs = Vn_req - Vc_kN;

    // Region check
    const Vc2 = Vc_kN / 2;
    if (Vu_kN <= phi * Vc2) {
      return { zone: 'No stirrups needed', needed: false, Vc_kN, Vu_kN };
    }

    // Minimum stirrups if Vc/2 < Vu ≤ Vc
    if (Vu_kN <= phi * Vc_kN) {
      const Av_s_min = Math.max(0.062 * Math.sqrt(fc_MPa) * bw_mm / fyt_MPa, 0.35 * bw_mm / fyt_MPa);
      const s_max = Math.min(d_mm / 2, 600);
      return { zone: 'Min stirrups only', needed: true, Vs: 0, Av_s: Av_s_min, s_max, Vc_kN, Vu_kN };
    }

    if (Vs <= 0) {
      return { error: 'Vc already ≥ Vu/ϕ — check inputs', needed: false };
    }

    const Av_s = Vs * 1000 / (fyt_MPa * d_mm); // mm²/mm

    // Spacing limits
    const Vs_limit = (1 / 3) * Math.sqrt(fc_MPa) * bw_mm * d_mm / 1000; // kN
    let s_max;
    if (Vs <= Vs_limit) {
      s_max = Math.min(d_mm / 2, 600);
    } else if (Vs <= 2 * Vs_limit) {
      s_max = Math.min(d_mm / 4, 300);
    } else {
      return { error: 'Vs > (2/3)√f\'c·bw·d — enlarge section', needed: true, Vs, Av_s };
    }

    // Max Vn check
    const Vn_max = Vc_kN + (0.66 * Math.sqrt(fc_MPa) * bw_mm * d_mm / 1000);
    if (Vu_kN > phi * Vn_max) {
      return { error: 'Vu > ϕ(Vc + 0.66√f\'c·bw·d) — enlarge section', needed: true };
    }

    // Minimum Av/s
    const Av_s_min = Math.max(0.062 * Math.sqrt(fc_MPa) * bw_mm / fyt_MPa, 0.35 * bw_mm / fyt_MPa);

    return {
      zone: 'Full shear design',
      needed: true,
      Vs,
      Av_s: Math.max(Av_s, Av_s_min),
      Av_s_required: Av_s,
      Av_s_min,
      s_max,
      Vc_kN, Vu_kN,
    };
  }

  // ── Stirrup size → required spacing ──────────────────────────────
  function stirrupSpacing(Av_s_mm2_per_mm, db_stirrup_mm, n_legs = 2) {
    const Ab = Math.PI / 4 * db_stirrup_mm * db_stirrup_mm;
    const Av = n_legs * Ab; // mm² per stirrup
    return Av / Av_s_mm2_per_mm; // mm spacing
  }

  // ── Critical section location ─────────────────────────────────────
  function criticalSectionDist(d_mm) {
    return d_mm; // at distance d from face of support
  }

  return { Vc_14, Vc_19, Vc_19_noAv, stirrupDesign, stirrupSpacing, criticalSectionDist };
})();
