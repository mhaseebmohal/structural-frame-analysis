// ══════════════════════════════════════════════════════════════════════════════
//  foundation.js  —  Pad / Eccentric / Combined Foundation Design
//  Source algorithms: kunle009/FoundationDesign (EC2 + Eurocode approach)
//  Ref: EN 1992-1-1:2004, EN 1997-1:2004
//  Units: kN, m, MPa  (internally converts as needed)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const FoundationDesign = (() => {

  // ── Safety factors ─────────────────────────────────────────────────────────
  const γG  = 1.35;   // permanent unfavourable
  const γQ  = 1.50;   // variable unfavourable
  const γc  = 1.50;   // concrete
  const αcc = 0.85;

  // ── BEARING PRESSURE (SLS) with eccentricity ──────────────────────────────
  // Biaxial eccentricity — 4-corner pressure formula
  // Inputs: N_sls [kN], Mx_sls [kNm], My_sls [kNm], L [m], B [m]
  // Returns: q1..q4 pressures at corners [kPa]
  function bearingPressureSLS(N_sls, Mx_sls, My_sls, L, B) {
    const A  = L * B;

    // A footing with no net downward load has no bearing contact at all, and
    // eccentricity M/N is undefined there. Dividing anyway gave ex = Infinity
    // and then q = (0/A)·(1 − Infinity) = NaN, which propagated into
    // bearingCheck's qmax and eta and left the verdict resting on `NaN < 0`
    // being false. A footing whose permanent load is exactly offset by wind
    // uplift reaches this, and so does any pure-moment combination.
    //
    // Net uplift is likewise not a bearing problem — reporting a positive qmax
    // for a footing being pulled off the ground is worse than reporting none.
    if (!(N_sls > 0) || !isFinite(N_sls)) {
      return {
        q1: 0, q2: 0, q3: 0, q4: 0,
        qmax: 0, qmin: 0, qavg: 0,
        ex: null, ey: null,
        inKern: false, noContact: true,
        A: +A.toFixed(4)
      };
    }

    const ex = Mx_sls / N_sls;   // eccentricity x [m]
    const ey = My_sls / N_sls;   // eccentricity y [m]

    // Check kern: ex < L/6, ey < B/6
    const inKern = (Math.abs(ex) < L / 6) && (Math.abs(ey) < B / 6);

    // 4-corner pressures (positive = compression on soil)
    const q1 = (N_sls / A) * (1 - 6 * ex / L - 6 * ey / B);
    const q2 = (N_sls / A) * (1 - 6 * ex / L + 6 * ey / B);
    const q3 = (N_sls / A) * (1 + 6 * ex / L - 6 * ey / B);
    const q4 = (N_sls / A) * (1 + 6 * ex / L + 6 * ey / B);

    return {
      q1: +q1.toFixed(3), q2: +q2.toFixed(3),
      q3: +q3.toFixed(3), q4: +q4.toFixed(3),
      qmax: +Math.max(q1, q2, q3, q4).toFixed(3),
      qmin: +Math.min(q1, q2, q3, q4).toFixed(3),
      qavg: +(N_sls / A).toFixed(3),
      ex: +ex.toFixed(4), ey: +ey.toFixed(4),
      inKern, A: +A.toFixed(4)
    };
  }

  // ── BEARING CAPACITY CHECK ────────────────────────────────────────────────
  function bearingCheck(N_sls, Mx_sls, My_sls, L, B, qa_kPa, GWT_depth = 10, Df = 1.0, γsoil = 18) {
    const bp = bearingPressureSLS(N_sls, Mx_sls, My_sls, L, B);

    // Effective area (Meyerhof eccentricity reduction) — optional.
    // ex/ey are null when there is no contact, and Math.abs(null) is 0, which
    // would quietly report the FULL area as effective for a footing that is not
    // bearing at all. Fall back to the gross dimensions and let noContact carry
    // the meaning instead.
    const L_eff = bp.ex == null ? L : Math.max(0.1, L - 2 * Math.abs(bp.ex));
    const B_eff = bp.ey == null ? B : Math.max(0.1, B - 2 * Math.abs(bp.ey));
    const A_eff = L_eff * B_eff;

    // Net foundation pressure (subtract overburden)
    const q_overburden = γsoil * Df;   // kPa
    const qnet = Math.max(bp.qmax - q_overburden, 0);

    // No contact at all is a distinct outcome from overstress, and calling it
    // 'FAIL (overstress)' — which is where the old NaN comparison landed —
    // pointed the engineer at the wrong remedy entirely.
    const pass = !bp.noContact && bp.qmax <= qa_kPa && bp.qmin >= 0;
    const status = bp.noContact ? 'FAIL (uplift)'
                 : pass         ? 'OK'
                 : bp.qmin < 0  ? 'FAIL (uplift)'
                 :                'FAIL (overstress)';

    return {
      check:      'Bearing Capacity (EC7 SLS)',
      qmax_kPa:   +bp.qmax.toFixed(3),
      qmin_kPa:   +bp.qmin.toFixed(3),
      qavg_kPa:   +bp.qavg.toFixed(3),
      qa_kPa:     +qa_kPa.toFixed(3),
      qnet_kPa:   +qnet.toFixed(3),
      ex_m:       bp.ex != null ? +bp.ex.toFixed(4) : null,
      ey_m:       bp.ey != null ? +bp.ey.toFixed(4) : null,
      inKern:     bp.inKern,
      noContact:  !!bp.noContact,
      L_eff:      +L_eff.toFixed(3),
      B_eff:      +B_eff.toFixed(3),
      A_eff:      +A_eff.toFixed(4),
      uplift:     bp.noContact || bp.qmin < 0,
      pass,
      status,
      eta:        qa_kPa > 0 ? +(bp.qmax / qa_kPa).toFixed(4) : 0,
      note: bp.noContact
        ? '⚠ No net downward load — the footing is in full uplift. Bearing does ' +
          'not govern; check holding-down and the uplift load path.'
        : bp.inKern
          ? `Eccentricity within kern. qmax=${bp.qmax.toFixed(1)} kPa vs qa=${qa_kPa} kPa`
          : `⚠ Eccentricity outside kern — partial contact. Check soil model.`
    };
  }

  // ── ULS BASE PRESSURES ────────────────────────────────────────────────────
  function bearingPressureULS(N_G, N_Q, N_W, Mx_G, Mx_Q, Mx_W, My_G, My_Q, My_W, L, B) {
    const N_uls  = γG * N_G  + γQ * N_Q  + γQ * N_W;
    const Mx_uls = γG * Mx_G + γQ * Mx_Q + γQ * Mx_W;
    const My_uls = γG * My_G + γQ * My_Q + γQ * My_W;
    return { N_uls, Mx_uls, My_uls,
             ...bearingPressureSLS(N_uls, Mx_uls, My_uls, L, B) };
  }

  // ── BENDING MOMENT AT COLUMN FACE ────────────────────────────────────────
  // For a pad footing under ULS net pressure qnet [kPa]:
  // cantilever length from column face = (L - col_L) / 2
  function designMoment(qmax_uls, qmin_uls, L, col_L) {
    // Cantilever at critical section (column face)
    const lc = (L - col_L) / 2;   // cantilever length [m]

    // The critical cantilever is the one on the qmax side, and the pressure
    // under it runs from qmax at the free edge down to q_face at the column
    // face — it does NOT drop all the way to qmin, which occurs at the far
    // edge of the footing.
    //
    // This used q_avg = (qmax + qmin)/2, the average over the WHOLE footing.
    // For an eccentric footing that is always below the true average over the
    // critical cantilever, so the design moment came out low — 101 vs 140
    // kNm/m (27% under) for L = 3 m, col = 0.4 m, q running 200 → 40 kPa.
    // Its own comment claimed the opposite ("conservative: use avg = qmax").
    //
    // Exact moment about the column face for a linearly varying pressure:
    //   M = ∫₀^lc q(x)·(lc − x) dx = lc²/6 · (2·qmax + q_face)
    const slope  = (qmax_uls - qmin_uls) / L;          // kPa per m
    const q_face = qmax_uls - slope * lc;              // pressure at the column face
    const M_Ed   = (lc * lc / 6) * (2 * qmax_uls + q_face);   // kNm/m
    const q_avg  = (qmax_uls + q_face) / 2;            // mean over the cantilever

    return {
      M_Ed_pm: +M_Ed.toFixed(3),
      lc:      +lc.toFixed(3),
      q_avg:   +q_avg.toFixed(3),
      q_face:  +q_face.toFixed(3)
    };
  }

  // ── BENDING REINFORCEMENT (from rc_design.js) ─────────────────────────────
  function foundationReinforcement(M_Ed_pm, B, d_eff, fck, fyk, b_strip = 1.0) {
    if (!window.RCDesign) return { error: 'RCDesign module not loaded' };
    // M_Ed_pm is moment per metre width; multiply by B for full footing width
    // Design for unit-width strip (b=1m)
    const M_strip = M_Ed_pm;   // kNm per metre width
    return RCDesign.bendingReinforcement(M_strip, b_strip, d_eff, fck, fyk);
  }

  // ── TRANSVERSE SHEAR CHECK at d from column face (EC2 6.2) ───────────────
  function transverseShear(qmax_uls, qmin_uls, L, col_L, B, d_eff, fck, fyk, As_mm2_pm) {
    if (!window.RCDesign) return { error: 'RCDesign module not loaded' };
    // Critical section: at d from column face
    const lc = (L - col_L) / 2;
    const lv = Math.max(0, lc - d_eff);   // distance from edge to critical section
    // The critical section sits lv from the qmax EDGE, so the pressure there is
    // qmax minus the drop over that distance. Adding the drop to qmin instead
    // measured from the opposite edge and returned a pressure near qmin — for
    // L = 3 m with q running 200 → 40 kPa it gave 86 kPa where the true value
    // is 154 kPa, understating the shear by ~19%.
    const slope  = (qmax_uls - qmin_uls) / L;          // kPa per m
    const q_crit = qmax_uls - slope * lv;              // pressure at crit section
    const V_Ed   = ((qmax_uls + q_crit) / 2) * lv;   // kN/m

    // VRd,c check
    const ρl = Math.min(As_mm2_pm / (1000 * d_eff * 1000), 0.02);  // As in mm²/m
    const CRdc = 0.18 / 1.5;
    const k    = Math.min(1 + Math.sqrt(200 / (d_eff * 1000)), 2.0);
    // vRd,c is a stress in MPa (N/mm²). Converting it to a resistance per metre
    // of width needs b = 1000 mm and d = d_eff·1000 mm, then N → kN:
    //   V [kN/m] = vRd_c · 1000 · (d_eff·1000) / 1000 = vRd_c · d_eff · 1000
    //
    // The trailing `* 1 * d_eff * 1000 / 1000` cancelled to just `* d_eff`, so
    // the width term was missing entirely and VRd,c came out 1000x too small —
    // 0.21 kN/m against a 142 kN/m demand. Every pad footing therefore failed
    // transverse shear with η ≈ 669, which also pinned the whole design's
    // summary to FAIL regardless of how the other checks came out.
    const vRd_c_MPa = Math.max(CRdc * k * Math.pow(100 * ρl * fck, 1/3),
                               0.035 * Math.pow(k, 1.5) * Math.sqrt(fck));   // MPa
    const VRdc = vRd_c_MPa * d_eff * 1000;   // kN per metre width

    return {
      check:      'Transverse Shear (EC2 6.2)',
      V_Ed_pm:    +V_Ed.toFixed(3),
      VRdc_pm:    +VRdc.toFixed(3),
      lv_m:       +lv.toFixed(3),
      d_eff_m:    +d_eff.toFixed(4),
      rho_l:      +ρl.toFixed(6),
      pass:       V_Ed <= VRdc,
      status:     V_Ed <= VRdc ? 'OK (no shear links needed)' : 'FAIL (add shear links or increase depth)',
      eta:        +(V_Ed / Math.max(VRdc, 0.001)).toFixed(4),
      note: `V_Ed=${V_Ed.toFixed(2)} kN/m at d=${(d_eff*1000).toFixed(0)}mm from column face`
    };
  }

  // ── PUNCHING SHEAR (EC2 6.4) ──────────────────────────────────────────────
  // At column face and at 2d control perimeter
  function punchingShear(N_uls, col_L, col_B, d_eff, fck, fyk, As_x_mm2pm, As_y_mm2pm, e_x = 0, e_y = 0, opts = {}) {
    if (!window.RCDesign) return { error: 'RCDesign module not loaded' };
    // N_uls is the factored COLUMN load. If opts.L and opts.B (footing plan
    // dimensions, m) are given, the 2d-perimeter demand is the net load
    // (EC2 6.4.2(1) / ACI 318 22.6): V_Ed = N - q_net * A_inside_perimeter,
    // with q_net = N/(L*B) taken as uniform (moment effects are carried by
    // beta). Without them the full load is used (conservative, old behaviour).
    const c1  = col_L * 1000, c2 = col_B * 1000;  // mm
    const d_  = d_eff * 1000;                        // mm

    // Strength reduction factor ν
    const ν   = 0.6 * (1 - fck / 250);
    const fcd = αcc * fck / γc;
    const vRd_max = 0.5 * ν * fcd;   // MPa — at column face

    // Column perimeter u0
    const u0 = 2 * (c1 + c2);  // mm

    // Critical perimeter at 2d (EC2 Fig. 6.13)
    const u1 = 2 * (c1 + c2) + 2 * Math.PI * 2 * d_;  // mm (rounded corners)

    // Reinforcement ratio (geometric mean), ρ = As / (b·d).
    //
    // As_x_mm2pm / As_y_mm2pm are areas per METRE width, so the width term is
    // 1000 mm — not 1. Dividing by `1 * d_` inflated ρ by 1000x, which then hit
    // the 0.02 cap, so ρ1 was pinned at the code maximum for essentially every
    // footing. Since vRd,c ∝ ρ^(1/3), that overstated the punching resistance
    // by ~93% for a typical As = 1000 mm²/m at d = 400 mm (0.75 vs 0.39 MPa).
    // transverseShear() above already divides by (1000 · d), which is what
    // marked this one as the outlier.
    const ρx  = Math.min(As_x_mm2pm / (1000 * d_), 0.02);
    const ρy  = Math.min(As_y_mm2pm / (1000 * d_), 0.02);
    const ρ1  = Math.min(Math.sqrt(ρx * ρy), 0.02);

    // k factor
    const k = Math.min(1 + Math.sqrt(200 / d_), 2.0);
    const vmin = 0.035 * Math.pow(k, 1.5) * Math.sqrt(fck);

    // vRd,c at control perimeter (EC2 6.4.4)
    const vRd_c = Math.max(0.12 * k * Math.pow(100 * ρ1 * fck, 1/3), vmin);  // MPa

    // Applied shear stress at column face
    // Eccentricity factor β (EC2 6.4.3)
    // For rectangular column with moment:
    const e   = Math.hypot(e_x * 1000, e_y * 1000);   // mm
    const β   = e > 0 ? Math.max(1, 1 + 0.6 * Math.PI * e / (c1 + c2 + 4 * d_)) : 1.0;

    // Area inside the 2d control perimeter (rectangle + 2d strips + 4 quarter
    // circles of radius 2d), capped at the footing area.
    const A_ctrl_m2 = (c1 * c2 + 4 * d_ * (c1 + c2) + Math.PI * 4 * d_ * d_) / 1e6;
    const hasArea   = opts && opts.L > 0 && opts.B > 0;
    const A_fdn     = hasArea ? opts.L * opts.B : 0;
    const A_in      = hasArea ? Math.min(A_ctrl_m2, A_fdn) : 0;
    const q_net     = hasArea ? N_uls / A_fdn : 0;               // kPa
    const V_red_kN  = hasArea ? Math.max(0, N_uls - q_net * A_in) : N_uls;

    const V_Ed_N  = N_uls * 1000;   // N — full load at column face (EC2 6.4.5)
    const v_Ed_face = β * V_Ed_N / (u0 * d_);          // MPa at column face
    const v_Ed_2d   = β * (V_red_kN * 1000) / (u1 * d_);  // MPa at 2d perimeter

    const pass_face = v_Ed_face <= vRd_max;
    const pass_2d   = v_Ed_2d   <= vRd_c;

    return {
      check:       'Punching Shear (EC2 6.4)',
      N_uls_kN:    +N_uls.toFixed(3),
      col_dims_mm: `${(col_L*1000).toFixed(0)}×${(col_B*1000).toFixed(0)}`,
      d_eff_mm:    +d_.toFixed(1),
      u0_mm:       +u0.toFixed(1),
      u1_mm:       +u1.toFixed(1),
      beta:        +β.toFixed(4),
      V_Ed_2d_kN:  +V_red_kN.toFixed(3),
      A_ctrl_m2:   +A_ctrl_m2.toFixed(4),
      rho_1:       +ρ1.toFixed(6),
      k:           +k.toFixed(4),
      vRd_max_MPa: +vRd_max.toFixed(3),
      vRd_c_MPa:   +vRd_c.toFixed(3),
      v_Ed_face_MPa: +v_Ed_face.toFixed(4),
      v_Ed_2d_MPa:   +v_Ed_2d.toFixed(4),
      pass_face,
      pass_2d,
      pass:        pass_face && pass_2d,
      status:      pass_face && pass_2d ? 'OK' : (!pass_face ? 'FAIL (column face)' : 'FAIL (2d perimeter)'),
      eta:         +(Math.max(v_Ed_face / vRd_max, v_Ed_2d / vRd_c)).toFixed(4),
      note: `β=${β.toFixed(3)} (eccentricity). Face: ${v_Ed_face.toFixed(3)}/${vRd_max.toFixed(3)} MPa. 2d: ${v_Ed_2d.toFixed(3)}/${vRd_c.toFixed(3)} MPa`
    };
  }

  // ── SLIDING RESISTANCE (EC7) ─────────────────────────────────────────────
  function slidingCheck(N_uls, H_Ed, φ_deg, c_kPa = 0, L, B) {
    const φ_rad = φ_deg * Math.PI / 180;
    const A     = L * B;
    // Horizontal resistance: Rd = N·tan(φ') + c·A
    const Rd    = N_uls * Math.tan(φ_rad) + c_kPa * A;
    return {
      check:    'Sliding Resistance (EC7)',
      H_Ed:     +H_Ed.toFixed(3),
      Rd:       +Rd.toFixed(3),
      phi_deg:  φ_deg,
      c_kPa,
      pass:     H_Ed <= Rd,
      status:   H_Ed <= Rd ? 'OK' : 'FAIL',
      eta:      +(H_Ed / Math.max(Rd, 0.001)).toFixed(4)
    };
  }

  // ── MAIN DESIGN FUNCTION ──────────────────────────────────────────────────
  // Runs complete pad foundation design
  // Inputs: all dimensions in m, forces in kN/kNm, stresses in kPa or MPa
  function designPadFoundation(params) {
    const {
      // Geometry
      L   = 2.0,    // foundation length [m]
      B   = 2.0,    // foundation width [m]
      h_f = 0.5,    // foundation thickness [m]
      col_L = 0.3,  // column length [m]
      col_B = 0.3,  // column width [m]
      // Soil
      qa  = 150,    // allowable bearing capacity [kPa]
      Df  = 1.0,    // founding depth [m]
      γsoil = 18,   // soil unit weight [kN/m³]
      φ_soil = 30,  // angle of internal friction [deg]
      c_soil = 0,   // cohesion [kPa]
      // Loading (SLS — unfactored)
      N_G  = 500,   // permanent axial [kN]
      N_Q  = 200,   // variable axial [kN]
      N_W  = 0,     // wind axial [kN]
      Mx_G = 0,     // perm. moment X [kNm]
      Mx_Q = 0,     // var. moment X [kNm]
      Mx_W = 0,     // wind moment X [kNm]
      My_G = 0,     // perm. moment Y [kNm]
      My_Q = 0,     // var. moment Y [kNm]
      H_G  = 0,     // horizontal load perm. [kN]
      H_Q  = 0,     // horizontal load var. [kN]
      // Materials
      fck  = 25,    // concrete MPa
      fyk  = 500,   // rebar MPa
      cover = 50,   // concrete cover mm
      phi  = 16,    // main bar diameter mm
    } = params;

    const checks = [];

    // Foundation self-weight (add to permanent)
    const γc_conc = 25;   // kN/m³
    const W_fdn   = L * B * h_f * γc_conc;
    const W_soil  = L * B * (Df - h_f) * γsoil;

    // Total SLS vertical load (including foundation + soil)
    const N_sls = N_G + N_Q + N_W + W_fdn + W_soil;
    const Mx_sls = Mx_G + Mx_Q + Mx_W + H_G * h_f / 2 + H_Q * h_f / 2;
    // My_G / My_Q are accepted as inputs, so carry them through rather than
    // dropping them. bearingPressureSLS is already biaxial (it derives ex, ey
    // and the kern check from both axes); pinning this to 0 silently ignored
    // any minor-axis moment the caller supplied.
    const My_sls = My_G + My_Q;

    // Total ULS
    const N_uls  = γG * N_G + γQ * N_Q + γQ * N_W + γG * (W_fdn + W_soil);
    const Mx_uls = γG * Mx_G + γQ * Mx_Q + γQ * Mx_W + γG * H_G * h_f / 2 + γQ * H_Q * h_f / 2;
    // My was factored at SLS but dropped at ULS, so a minor-axis moment moved
    // the bearing check and then vanished from the pressures that drive the
    // flexural, shear and punching design.
    const My_uls = γG * My_G + γQ * My_Q;
    const H_uls  = γG * H_G + γQ * H_Q;

    // Effective depth
    const d_eff  = h_f - cover / 1000 - phi / 2 / 1000;  // m

    // ── 1. Bearing ─────────────────────────────────────────────────────
    const bear = bearingCheck(N_sls, Mx_sls, My_sls, L, B, qa, Df, Df, γsoil);
    checks.push(bear);

    // ── 2. Sliding ─────────────────────────────────────────────────────
    const slide = slidingCheck(N_uls, H_uls, φ_soil, c_soil, L, B);
    checks.push(slide);

    // ── 3. ULS base pressures ──────────────────────────────────────────
    const bp_uls = bearingPressureSLS(N_uls, Mx_uls, My_uls, L, B);

    // ── 4. Design bending moment (per m width at column face) ──────────
    const dm = designMoment(bp_uls.qmax, bp_uls.qmin, L, col_L);
    // Transverse (Y) direction, mirroring the X-direction calc above with L/col_L
    // swapped for B/col_B. This used to be skipped entirely — the Y-direction
    // reinforcement was just the X-direction value copied over "for square
    // footings", so a rectangular footing (L !== B, col_L !== col_B) had its
    // transverse direction reported as checked when it was never calculated.
    const dm_y = designMoment(bp_uls.qmax, bp_uls.qmin, B, col_B);

    // ── 5. Bending reinforcement (X and Y directions) ───────────────────
    const reinf_x = foundationReinforcement(dm.M_Ed_pm, B, d_eff, fck, fyk);
    if (reinf_x) {
      reinf_x.check = 'Flexural Reinforcement X-dir (EC2 6.1)';
      checks.push(reinf_x);
    }
    const reinf_y = foundationReinforcement(dm_y.M_Ed_pm, L, d_eff, fck, fyk);
    if (reinf_y) {
      reinf_y.check = 'Flexural Reinforcement Y-dir (EC2 6.1)';
      checks.push(reinf_y);
    }

    // ── 6. Transverse shear check (X and Y directions) ──────────────────
    const As_x = reinf_x?.As_design || 1000;   // mm²/m
    const As_y = reinf_y?.As_design || 1000;   // mm²/m
    if (window.RCDesign) {
      const shear = transverseShear(bp_uls.qmax, bp_uls.qmin, L, col_L, B, d_eff, fck, fyk, As_x);
      checks.push(shear);
      const shear_y = transverseShear(bp_uls.qmax, bp_uls.qmin, B, col_B, L, d_eff, fck, fyk, As_y);
      shear_y.check = 'Transverse Shear Y-dir (EC2 6.2)';
      checks.push(shear_y);
    }

    // ── 7. Punching shear ──────────────────────────────────────────────
    // e_y used to be hardcoded 0, dropping My_uls from the eccentricity
    // factor β entirely — understating punching demand for any biaxially
    // loaded footing. As_y_mm2pm was also a guessed `As_x * (L/B)` rather
    // than the real Y-direction design above.
    // Column load only: footing/soil self-weight is carried by the soil directly
    // beneath it and does not punch. Demand at 2d is net of the soil pressure
    // inside the control perimeter, so enlarging the footing cannot worsen it.
    const N_col_uls = γG * N_G + γQ * N_Q + γQ * N_W;
    const punch = punchingShear(N_col_uls, col_L, col_B, d_eff, fck, fyk,
      As_x, As_y, N_col_uls > 0 ? Mx_uls / N_col_uls : 0, N_col_uls > 0 ? My_uls / N_col_uls : 0, { L, B });
    checks.push(punch);

    // ── Summary ─────────────────────────────────────────────────────────
    const fails = checks.filter(c => c.status && c.status.includes('FAIL')).length;
    const warns = checks.filter(c => c.status && c.status.includes('WARN')).length;
    const etas  = checks.map(c => c.eta).filter(e => e != null);
    const maxEta = etas.length ? Math.max(...etas) : 0;

    return {
      type: 'Pad Foundation',
      params: { L, B, h_f, col_L, col_B, fck, fyk, qa, Df },
      inputs: { N_sls, Mx_sls, N_uls, Mx_uls, H_uls, d_eff, W_fdn, W_soil },
      checks,
      summary: {
        pass:   fails === 0,
        status: fails > 0 ? 'FAIL' : warns > 0 ? 'NEAR' : 'OK',
        maxEta: +maxEta.toFixed(4),
        fails, warns
      },
      // Key design outputs for display
      output: {
        As_x_mm2pm: reinf_x?.As_design || null,
        As_y_mm2pm: reinf_y?.As_design || null,
        d_eff_mm:   +(d_eff * 1000).toFixed(1),
        qmax_uls_kPa: +bp_uls.qmax.toFixed(2),
        N_sls_kN:   +N_sls.toFixed(1),
        N_uls_kN:   +N_uls.toFixed(1),
        M_Ed_pm_kNmpm: dm.M_Ed_pm,
        M_Ed_pm_y_kNmpm: dm_y.M_Ed_pm
      }
    };
  }

  // ── SIZE OPTIMIZATION ─────────────────────────────────────────────────────
  // Tries L×B combinations to find minimum acceptable size
  function optimizeSize(params, minL = 0.5, maxL = 6.0, step = 0.25) {
    for (let L = minL; L <= maxL; L += step) {
      const B = L;  // square footing
      const result = designPadFoundation({ ...params, L, B });
      if (result.summary.pass) {
        return { recommended_L: L, recommended_B: B, result };
      }
    }
    return { error: `No feasible square footing up to ${maxL}m. Increase qa or reduce loads.` };
  }

  // ── HTML REPORT BUILDER ───────────────────────────────────────────────────
  function buildReportHTML(result) {
    if (!result || !result.checks) return '<p>No results</p>';
    const STATUS_COL = { OK:'#2e7d32', FAIL:'#c62828', NEAR:'#e65100', WARN:'#e65100' };
    const p = result.params;
    const inp = result.inputs;

    let html = `
      <div style="background:#e3f2fd;padding:10px 14px;border-radius:8px;margin-bottom:12px;">
        <strong>Pad Foundation Summary</strong>
        &nbsp; ${p.L}×${p.B}×${p.h_f}m &nbsp;|&nbsp;
        fck=${p.fck}MPa fyk=${p.fyk}MPa &nbsp;|&nbsp;
        qa=${p.qa}kPa &nbsp;|&nbsp;
        N_sls=${inp.N_sls?.toFixed(1)}kN N_uls=${inp.N_uls?.toFixed(1)}kN
        <span style="float:right;font-weight:700;color:${STATUS_COL[result.summary.status]};">
          ${result.summary.status} (η=${result.summary.maxEta})
        </span>
      </div>`;

    for (const c of result.checks) {
      const col = STATUS_COL[c.status?.split(' ')[0]] || '#555';
      const eta = c.eta != null
        ? `<div style="width:80px;height:8px;background:#e0e0e0;border-radius:4px;display:inline-block;vertical-align:middle;margin-right:6px;">
            <div style="width:${Math.min(100,c.eta*100).toFixed(0)}%;height:100%;background:${col};border-radius:4px;"></div></div>
           <span style="font-size:11px;color:${col};font-weight:700;">${c.eta.toFixed(3)}</span>` : '';
      const rows = Object.entries(c)
        .filter(([k,v]) => !['check','status','pass','note','eta'].includes(k) && v !== null && v !== undefined && typeof v !== 'object')
        .map(([k,v]) => `<tr><td style="color:#555;padding:3px 8px;width:55%">${k}</td><td style="padding:3px 8px;font-weight:600;">${typeof v==='number'?v.toFixed(4):v}</td></tr>`)
        .join('');
      html += `<div style="margin-bottom:10px;border:1px solid ${col}44;border-radius:6px;overflow:hidden;">
        <div style="background:${col}15;padding:6px 12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;color:${col}">${c.check}</span>
          <div>${eta} <span style="padding:1px 7px;border-radius:10px;background:${col}22;color:${col};font-size:11px;">${c.status||''}</span></div>
        </div>
        <div style="padding:6px 10px;"><table style="width:100%;font-size:12px;border-collapse:collapse;">${rows}</table>
          ${c.note?`<p style="margin:4px 0 0;font-size:12px;color:#555;font-style:italic;">${c.note}</p>`:''}</div>
      </div>`;
    }

    if (result.output?.As_x_mm2pm) {
      html += `<div style="background:#e8f5e9;padding:10px 14px;border-radius:6px;font-size:13px;">
        <strong>Design Output:</strong>
        As,x = <strong>${result.output.As_x_mm2pm.toFixed(0)} mm²/m</strong> &nbsp;|&nbsp;
        d_eff = <strong>${result.output.d_eff_mm} mm</strong> &nbsp;|&nbsp;
        M_Ed = <strong>${result.output.M_Ed_pm_kNmpm?.toFixed(2)} kNm/m</strong>
      </div>`;
    }
    return html;
  }

  return {
    bearingPressureSLS,
    bearingCheck,
    bearingPressureULS,
    designMoment,
    foundationReinforcement,
    transverseShear,
    punchingShear,
    slidingCheck,
    designPadFoundation,
    optimizeSize,
    buildReportHTML
  };

})();

window.FoundationDesign = FoundationDesign;
