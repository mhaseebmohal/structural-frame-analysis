// ══════════════════════════════════════════════════════════════════════════════
//  aci_checks.js  —  ACI 318-19 Reinforced Concrete Design Checks
//  Reference  : ACI 318-19 Building Code Requirements for Structural Concrete
//  Edition    : 2019 (SI / metric formulas — ACI 318M-19)
//  Units      : Input forces kN / kNm, dimensions m  (internal: N, mm, MPa)
//  Ref. code  : ACI 318-19 §21, §22, §9, §10
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const ACIDesign = (() => {

  // ── ACI φ (strength reduction) factors §21.2.1 ────────────────────────────
  const PHI_FLEX     = 0.90;   // tension-controlled flexure / flexure+axial
  const PHI_SHEAR    = 0.75;   // shear and torsion
  const PHI_COL_TIED = 0.65;   // compression-controlled tied column
  const PHI_COL_SPR  = 0.75;   // compression-controlled spiral column

  // ── Modular ratio and steel properties ────────────────────────────────────
  const Es = 200000;   // MPa (steel modulus)

  // ── Concrete material properties (ACI 318-19) ─────────────────────────────
  // fcprime : f'c in MPa (specified compressive strength, 28-day cylinder)
  function concreteMaterial(fcprime) {
    const lambda  = 1.0;     // lightweight modification factor, §19.2.4.2 (normalwt = 1.0)
    // Modulus of elasticity §19.2.2.1  (wc = 2320 kg/m³, normalwt concrete)
    const Ec      = 4700 * Math.sqrt(fcprime);          // MPa
    // Modulus of rupture §19.2.3.1
    const fr      = 0.62 * lambda * Math.sqrt(fcprime); // MPa
    // β₁ — equivalent rectangular stress block depth factor §22.2.2.4.3
    //   β₁ = 0.85 for f'c ≤ 28 MPa; decreases 0.05 per 7 MPa above 28 MPa; min 0.65
    const beta1   = Math.max(0.65, 0.85 - 0.05 * Math.max(0, fcprime - 28) / 7);
    // Extreme fiber concrete crushing strain §22.2.2.1
    const eps_cu  = 0.003;
    // Neutral-axis factor (for biaxial, not used in simplified checks)
    const eps_ty  = (420 / Es);   // approx. yield strain for Grade 60

    return { fcprime, Ec, fr, beta1, eps_cu, eps_ty, lambda };
  }

  // ── φ factor based on net tensile strain ε_t (ACI 318-19 Table 21.2.2) ───
  // eps_t      : net tensile strain in extreme tension steel at nominal strength
  // memberType : 'tied' or 'spiral'
  // fy_rebar   : rebar yield strength [MPa] — Table 21.2.2 defines the
  //              compression-controlled limit as ε_ty = fy/Es and the
  //              tension-controlled limit as ε_ty + 0.003, NOT the fixed
  //              0.002/0.005 this used to hardcode regardless of grade. Those
  //              constants are only correct for ε_ty ≈ 0.0021 (Grade 60,
  //              fy = 420 MPa) — a Grade 40 or Grade 80 column got the wrong
  //              φ (and therefore the wrong φMn/φPn) in the transition zone,
  //              while js/aci/ch6-columns.js's phi_col() already derived
  //              ε_ty per call and got this right. Defaults to Grade 60 so a
  //              caller that genuinely has no rebar grade in scope keeps the
  //              previous behaviour exactly.
  function phiFromEpst(eps_t, memberType = 'tied', fy_rebar = 420) {
    const phi_CC = memberType === 'spiral' ? PHI_COL_SPR : PHI_COL_TIED;
    const eps_CC = fy_rebar / Es;      // ε_ty — compression-controlled strain limit
    const eps_TC = eps_CC + 0.003;     // tension-controlled strain limit
    if (eps_t >= eps_TC) return { phi: PHI_FLEX, zone: 'tension-controlled' };
    if (eps_t <= eps_CC) return { phi: phi_CC,   zone: 'compression-controlled' };
    // Linear transition region
    const phi = phi_CC + (PHI_FLEX - phi_CC) * (eps_t - eps_CC) / (eps_TC - eps_CC);
    return { phi: +phi.toFixed(4), zone: 'transition' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MATERIAL SUMMARY  (informational check)
  // ═══════════════════════════════════════════════════════════════════════════
  function materialSummary(fcprime, fy_rebar) {
    const c = concreteMaterial(fcprime);
    const grade = Math.round(fy_rebar / 6.9);  // approx. US grade (e.g. 420/6.9 ≈ 60)
    return {
      check:      'ACI 318-19 Material Properties',
      fcprime_MPa: +fcprime.toFixed(1),
      fy_rebar_MPa:+fy_rebar.toFixed(1),
      Ec_MPa:     +c.Ec.toFixed(0),
      fr_MPa:     +c.fr.toFixed(3),
      beta1:      +c.beta1.toFixed(3),
      eps_cu:     +c.eps_cu.toFixed(3),
      lambda:     +c.lambda.toFixed(2),
      status:     'INFO',
      pass:       true,
      eta:        null,
      note: `f'c = ${fcprime} MPa (${Math.round(fcprime * 145)} psi). ` +
            `fy = ${fy_rebar} MPa (Grade ${grade}). ` +
            `Ec = ${c.Ec.toFixed(0)} MPa,  β₁ = ${c.beta1.toFixed(3)},  fr = ${c.fr.toFixed(2)} MPa`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FLEXURE CHECK  —  beams / one-way slabs (ACI 318-19 §9.3, §22.3)
  //  Inputs : M_Ed [kNm], b [m] (width), d [m] (effective depth),
  //           fcprime [MPa], fy_rebar [MPa]
  // ═══════════════════════════════════════════════════════════════════════════
  function flexureBeam(M_Ed, b, d, fcprime, fy_rebar) {
    const M    = M_Ed * 1e6;        // kNm → N·mm
    const bw   = b * 1000;          // m → mm
    const d_   = d * 1000;          // m → mm
    const conc = concreteMaterial(fcprime);

    // ── Minimum reinforcement (§9.6.1.2 SI) ──────────────────────────────
    const As_min_a = (0.25 * Math.sqrt(fcprime) / fy_rebar) * bw * d_;  // mm²
    const As_min_b = (1.4 / fy_rebar) * bw * d_;                        // mm²
    const As_min   = Math.max(As_min_a, As_min_b);

    // ── Required As from M_Ed (iterative, 3 passes) ───────────────────────
    let As_req = 0;
    if (M > 0) {
      let a_iter = 0.1 * d_;    // seed estimate
      for (let iter = 0; iter < 4; iter++) {
        As_req = M / (0.90 * fy_rebar * (d_ - a_iter / 2));
        a_iter = As_req * fy_rebar / (0.85 * fcprime * bw);
      }
    }
    As_req = Math.max(As_req, 0);

    // ── Capacity calculation at As_prov = max(As_req, As_min) ────────────
    const As_prov  = Math.max(As_req, As_min);
    const a        = As_prov * fy_rebar / (0.85 * fcprime * bw);   // mm
    const c        = a / conc.beta1;                                 // mm
    const eps_t    = (d_ - c) / c * conc.eps_cu;                   // net tensile strain

    const { phi, zone } = phiFromEpst(eps_t, 'tied', fy_rebar);
    const Mn_kNm   = As_prov * fy_rebar * (d_ - a / 2) / 1e6;     // kNm
    const phiMn    = phi * Mn_kNm;                                   // kNm

    const eta      = M_Ed / Math.max(phiMn, 0.001);

    // ACI §9.3.3.1: net tensile strain ε_t ≥ 0.004 for flexural members
    const strainOK = eps_t >= 0.004;

    const status = (!strainOK || eta > 1.0) ? 'FAIL'
                 : eta > 0.80               ? 'NEAR'
                 :                            'OK';

    return {
      check:        'Flexure (ACI §22.3)',
      M_Ed:         +M_Ed.toFixed(3),
      phi:          +phi.toFixed(3),
      phiMn:        +phiMn.toFixed(3),
      Mn_kNm:       +Mn_kNm.toFixed(3),
      As_req_mm2:   +As_req.toFixed(1),
      As_min_mm2:   +As_min.toFixed(1),
      As_prov_mm2:  +As_prov.toFixed(1),
      a_mm:         +a.toFixed(2),
      c_mm:         +c.toFixed(2),
      d_eff_mm:     +d_.toFixed(1),
      beta1:        +conc.beta1.toFixed(3),
      eps_t:        +eps_t.toFixed(5),
      phi_zone:     zone,
      eta:          +eta.toFixed(4),
      pass:         eta <= 1.0 && strainOK,
      status,
      note: !strainOK
        ? `⚠ ε_t = ${eps_t.toFixed(4)} < 0.004 — section may be over-reinforced. Increase depth or reduce reinforcement.`
        : `φMn = ${phiMn.toFixed(2)} kNm (η = ${eta.toFixed(3)}). ` +
          `Provide As ≥ ${As_prov.toFixed(0)} mm² [${zone}, φ = ${phi.toFixed(2)}].`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SHEAR CHECK  —  beams (ACI 318-19 §9.5.1, §22.5)
  //  Inputs : V_Ed [kN], bw [m], d [m], fcprime [MPa],
  //           fyt [MPa] (stirrup yield), As [mm²] (tension steel, optional),
  //           Nu [kN] (axial force; positive = compression)
  // ═══════════════════════════════════════════════════════════════════════════
  function shearBeam(V_Ed, bw, d, fcprime, fyt, As, Nu) {
    fyt = fyt || 420;
    As  = As  || 0;
    Nu  = Nu  || 0;
    const bw_mm = bw * 1000;   // mm
    const d_mm  = d  * 1000;   // mm
    const conc  = concreteMaterial(fcprime);
    const Ag_mm2 = bw_mm * (d_mm / 0.85);   // approx gross area h ≈ d / 0.85

    // ── Vc: simplified Table 22.5.5.1 (normalwt, Av ≥ Av,min) ───────────
    // SI form: Vc = [0.17·λ·√f'c + Nu/(6·Ag)] · bw · d   [N]
    const Nu_N = Nu * 1000;   // kN → N
    const Vc_N = (0.17 * conc.lambda * Math.sqrt(fcprime) +
                  Nu_N / (6 * Math.max(Ag_mm2, 1))) * bw_mm * d_mm;
    const Vc   = Math.max(0, Vc_N / 1000);   // kN (can't be negative)
    const phiVc = PHI_SHEAR * Vc;             // kN

    // ── Max shear reinforcement limit §22.5.1.2 ───────────────────────────
    // Vs,max = 0.66·√f'c·bw·d  [N] (2/3 × 0.66 = 0.44 in some refs; ACI = 0.66)
    const Vs_max_N   = 0.66 * Math.sqrt(fcprime) * bw_mm * d_mm;
    const Vs_max_kN  = Vs_max_N / 1000;

    // ── Required shear force in stirrups ─────────────────────────────────
    const Vs_req_kN  = Math.max(0, V_Ed - phiVc) / PHI_SHEAR;
    const strutsOK   = Vs_req_kN <= Vs_max_kN;

    // ── Av/s required ─────────────────────────────────────────────────────
    const Av_s_req   = Vs_req_kN > 0
      ? (Vs_req_kN * 1000) / (fyt * d_mm)   // mm²/mm
      : 0;

    // ── Minimum stirrups §9.6.3.4 (SI) ───────────────────────────────────
    // Required when Vu > 0.5·φVc for beams with h > 250 mm  §9.6.3.1
    const minLinksNeeded = V_Ed > 0.5 * phiVc;
    const Av_s_min_a = 0.062 * Math.sqrt(fcprime) * bw_mm / fyt;  // mm²/mm
    const Av_s_min_b = 0.35 * bw_mm / fyt;                        // mm²/mm
    const Av_s_min   = Math.max(Av_s_min_a, Av_s_min_b);

    // Design Av/s
    const Av_s_design = Math.max(Av_s_req, minLinksNeeded ? Av_s_min : 0);

    // ── Stirrup suggestions ───────────────────────────────────────────────
    const suggestions = suggestStirrups(Av_s_design, bw_mm, d_mm);

    // ── Utilization ───────────────────────────────────────────────────────
    const phiVn_avail = PHI_SHEAR * (Vc + Vs_max_kN);   // upper bound with max stirrups

    const noLinksNeeded = V_Ed <= 0.5 * phiVc;

    let status;
    if (!strutsOK || V_Ed > phiVn_avail) status = 'FAIL';
    else if (V_Ed > phiVc)              status = V_Ed > 1.5 * phiVc ? 'NEAR' : 'OK';
    else                                 status = 'OK';

    return {
      check:         'Shear (ACI §22.5)',
      V_Ed:          +V_Ed.toFixed(3),
      phi_shear:     PHI_SHEAR,
      phiVc:         +phiVc.toFixed(3),
      Vc_kN:         +Vc.toFixed(3),
      Vs_req_kN:     +Vs_req_kN.toFixed(3),
      Vs_max_kN:     +Vs_max_kN.toFixed(3),
      Av_s_req:      +Av_s_req.toFixed(4),
      Av_s_min:      +Av_s_min.toFixed(4),
      Av_s_design:   +Av_s_design.toFixed(4),
      d_eff_mm:      +d_mm.toFixed(1),
      bw_mm:         +bw_mm.toFixed(1),
      sqrt_fcprime:  +Math.sqrt(fcprime).toFixed(3),
      struts_ok:     strutsOK,
      no_links_needed: noLinksNeeded,
      eta:           +Math.min(V_Ed / Math.max(phiVc, 0.001), 9).toFixed(4),
      pass:          strutsOK && V_Ed <= phiVn_avail,
      status,
      note: noLinksNeeded
        ? `Vu ≤ 0.5·φVc — minimum stirrups may be omitted for shallow members. Av/s,min = ${Av_s_min.toFixed(3)} mm²/mm.`
        : V_Ed <= phiVc
        ? `Vu ≤ φVc — minimum stirrups required. Av/s ≥ ${Av_s_min.toFixed(3)} mm²/mm. ${suggestions[0]?.desc || ''}`
        : strutsOK
        ? `Stirrups required: Av/s ≥ ${Av_s_design.toFixed(3)} mm²/mm. ${suggestions[0]?.desc || ''}`
        : `⚠ Vs,req > Vs,max (${Vs_req_kN.toFixed(1)} > ${Vs_max_kN.toFixed(1)} kN) — increase section depth or width.`
    };
  }

  // Suggest practical US stirrup arrangements (US bar sizes: #3, #4, #5)
  function suggestStirrups(Av_s_req, bw_mm, d_mm) {
    // US bar sizes — 2-leg links: #3=9.53mm dia, #4=12.7mm, #5=15.9mm
    const bars = [
      { label: '#3', dia:  9.5, A2: 2 * Math.PI * (9.53 / 2) ** 2  },   // 2 legs × 71 mm²
      { label: '#4', dia: 12.7, A2: 2 * Math.PI * (12.7 / 2) ** 2  },   // 2 legs × 129 mm²
      { label: '#5', dia: 15.9, A2: 2 * Math.PI * (15.9 / 2) ** 2  },   // 2 legs × 200 mm²
    ];
    const maxS = Math.min(d_mm / 2, 600);   // §9.7.6.2.2: s ≤ d/2 and 600 mm
    const suggestions = [];
    for (const b of bars) {
      const spacing = Av_s_req > 0.001
        ? Math.floor(b.A2 / Av_s_req / 25) * 25
        : Math.min(maxS, 300);
      const s = Math.min(spacing, maxS);
      if (s >= 50) {
        suggestions.push({
          label: b.label, dia: b.dia, spacing: s,
          Av_s_prov: +(b.A2 / s).toFixed(3),
          desc: `2-leg ${b.label}@${s}mm  (Av/s = ${(b.A2 / s).toFixed(2)} mm²/mm)`
        });
        if (suggestions.length >= 3) break;
      }
    }
    return suggestions;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLUMN CHECK  (ACI 318-19 §10.6, §22.4)
  //  Inputs : N_Ed [kN] (compression +), M_Ed [kNm],
  //           b [m] (width), h [m] (total depth),
  //           fcprime [MPa], fy [MPa], Ast [mm²] provided steel (0 = design)
  //           tied  [bool] — true = tied column (default), false = spiral
  // ═══════════════════════════════════════════════════════════════════════════
  function columnCheck(N_Ed, M_Ed, b, h, fcprime, fy, Ast, tied) {
    tied = (tied !== false);
    const b_mm = b * 1000;
    const h_mm = h * 1000;
    const Ag   = b_mm * h_mm;                // mm² (gross area)

    // ── Reinforcement limits §10.6.1.1 ───────────────────────────────────
    const Ast_min  = 0.01 * Ag;   // ρg,min = 1%
    const Ast_max  = 0.08 * Ag;   // ρg,max = 8%
    const Ast_use  = Ast > 0 ? Math.max(Ast, Ast_min) : Ast_min;
    const rho_g    = Ast_use / Ag;

    // ── Generate P-M interaction curve to find capacity at demand point ──
    //  Uses full ACI §22.4 / §22.2.2 formulation with strain-based φ
    const colType = tied ? 'tied' : 'spiral';
    const alpha   = tied ? 0.80   : 0.85;
    const Es_col  = 200000;    // MPa
    const cover   = 50;        // mm — centroid of bars from face
    const d_col   = h_mm - cover;

    // ── Pure compression capacity §22.4.2 ────────────────────────────────
    const Pn0_N = alpha * (0.85 * fcprime * (Ag - Ast_use) + fy * Ast_use);
    const phiPn0 = phiFromEpst(-0.003, colType, fy).phi * Pn0_N / 1000;  // kN (all comp)

    const conc_col = concreteMaterial(fcprime);
    const beta1_c  = conc_col.beta1;

    // ── Pure bending capacity (ε_cu = 0.003, neutral axis at small c) ────
    const As_fl   = Math.max(Ast_use / 2,
                      (0.25 * Math.sqrt(fcprime) / fy) * b_mm * d_col);
    const a_col   = As_fl * fy / (0.85 * fcprime * b_mm);
    const Mn0_Nm  = As_fl * fy * (d_col - a_col / 2);     // N·mm
    // Neutral-axis depth is c = a / β₁ (ACI §22.2.2.4.1). This divided by a
    // magic 1.02 instead, which is not a β₁ value at any strength — β₁ runs
    // from 0.85 down to 0.65 — and understated c by ~22% for f'c = 30 MPa.
    // A smaller c means a larger apparent ε_t, which pushes the section toward
    // the tension-controlled φ = 0.90 and overstates φMn0.
    const c_col   = a_col / beta1_c;
    const eps_t0  = 0.003 * (d_col - c_col) / c_col;
    const phiMn0  = phiFromEpst(eps_t0, colType, fy).phi * Mn0_Nm / 1e6;  // kNm

    // ── Find strain-based φ at the demand point via P-M curve ────────────
    //
    // φ depends on the tensile strain ε_t, which depends on where the demand
    // sits on the interaction curve. The load path from the origin is a ray of
    // constant ECCENTRICITY e = M/P, so the demand's operating point is where
    // that ray crosses the curve — not the curve point that happens to lie
    // closest to it.
    //
    // The nearest-point-in-normalised-space search used before had no
    // relationship to the load path. For a 400×400 column at Pu = 900 kN,
    // Mu = 90 kNm (e = 100 mm) it selected the c = 0.05·d point — the
    // tension-controlled END of the curve, at φPn = 116 kN — and reported
    // φ = 0.90 for a column that is plainly compression-controlled and entitled
    // to no more than 0.65. Matching eccentricity puts it at c ≈ 0.83·d, where
    // ε_t ≈ 0.0006 and φ = 0.65.
    //
    // Note this value is REPORTED, not used: the utilisation below is the
    // Bresler-Rowe interaction between the φPn0 and φMn0 end points, each of
    // which carries its own φ.
    let   phi_at_demand = phiFromEpst(-0.003, colType, fy).phi;  // default (compression-controlled)
    let   eps_at_demand = -0.003;
    {
      // Nominal (unfactored) curve — eccentricity is a property of the section
      // and the load, so φ must not enter the ray comparison.
      const curve = [];
      for (let i = 1; i <= 240; i++) {
        const c     = (i / 240) * 6 * d_col;
        const a     = Math.min(beta1_c * c, h_mm);
        const eps_s = 0.003 * (d_col - c) / c;
        const fs    = Math.max(-fy, Math.min(fy, eps_s * Es_col));  // steel stress
        const Cc    = 0.85 * fcprime * a * b_mm;                    // N
        const Cs    = Ast_use / 2 * (fy - 0.85 * fcprime);          // N (comp steel)
        const T     = Ast_use / 2 * fs;                              // N (tension steel)
        const Pn    = (Cc + Cs - T) / 1000;                         // kN
        const Mn    = Math.abs((Cc * (h_mm/2 - a/2) + Cs * (d_col - h_mm/2)
                              + T * (d_col - h_mm/2)) / 1e6);       // kNm
        if (Pn <= 0) continue;
        curve.push({ e: Mn / Pn, eps: eps_s });   // e in m (Mn kNm / Pn kN)
      }
      if (curve.length) {
        if (N_Ed <= 0.001) {
          // Pure bending: the operating point is the flexural end of the curve,
          // the largest eccentricity available.
          eps_at_demand = curve.reduce((b, p) => (p.e > b.e ? p : b), curve[0]).eps;
        } else {
          const e_demand = M_Ed / N_Ed;   // m
          // Pick the curve point whose eccentricity is closest to the demand's.
          eps_at_demand = curve.reduce((best, p) =>
            Math.abs(p.e - e_demand) < Math.abs(best.e - e_demand) ? p : best,
            curve[0]).eps;
        }
        phi_at_demand = phiFromEpst(eps_at_demand, colType, fy).phi;
      }
    }
    const phi_col = phi_at_demand;
    const phi_zone = phiFromEpst(eps_at_demand, colType, fy).zone;

    // ── Interaction check ─────────────────────────────────────────────────
    //  Simplified linear Bresler-Rowe interaction:
    //    If N > 0.1·f'c·Ag (compression dominant) : N/φPn + M/φMn ≤ 1.0
    //    If N ≤ 0.1·f'c·Ag (flexure dominant)      : M/φMn + 0.5·N/φPn ≤ 1.0
    const N_balance = 0.1 * fcprime * Ag / 1000;   // kN
    let eta_combined, interaction_formula;
    if (N_Ed > N_balance) {
      eta_combined         = N_Ed / Math.max(phiPn0, 0.001) + M_Ed / Math.max(phiMn0, 0.001);
      interaction_formula  = 'P/φPn + M/φMn ≤ 1.0  (compression-dominant)';
    } else {
      eta_combined         = M_Ed / Math.max(phiMn0, 0.001) + 0.5 * N_Ed / Math.max(phiPn0, 0.001);
      interaction_formula  = '0.5·P/φPn + M/φMn ≤ 1.0  (flexure-dominant)';
    }

    const eta_P  = +(N_Ed  / Math.max(phiPn0, 0.001)).toFixed(4);
    const eta_M  = +(M_Ed  / Math.max(phiMn0, 0.001)).toFixed(4);
    const reinf_ok = rho_g >= 0.01 && rho_g <= 0.08;

    const pass   = eta_combined <= 1.0 && reinf_ok;
    const status = !pass        ? 'FAIL'
                 : eta_combined > 0.80 ? 'NEAR'
                 :                       'OK';

    return {
      check:              'Column (ACI §22.4)',
      N_Ed:               +N_Ed.toFixed(3),
      M_Ed:               +M_Ed.toFixed(3),
      phi_col:            +phi_col.toFixed(2),
      phi_zone,
      eps_t_demand:       +eps_at_demand.toFixed(5),
      e_demand_mm:        N_Ed > 0.001 ? +(M_Ed / N_Ed * 1000).toFixed(1) : null,
      phiPn0_kN:          +phiPn0.toFixed(2),
      phiMn0_kNm:         +phiMn0.toFixed(2),
      Ast_use_mm2:        +Ast_use.toFixed(1),
      Ast_min_mm2:        +Ast_min.toFixed(1),
      Ast_max_mm2:        +Ast_max.toFixed(1),
      rho_g_pct:          +(rho_g * 100).toFixed(3),
      reinf_ok,
      eta_P,
      eta_M,
      eta:                +Math.min(eta_combined, 9).toFixed(4),
      interaction_formula,
      // This used to read "Tied (φ = 0.65)" unconditionally, which contradicted
      // the phi_col field whenever the section was not compression-controlled.
      // 0.65 / 0.75 is the compression-controlled BOUND, not the φ in force.
      column_type:        tied
        ? `Tied  (φ = ${PHI_COL_TIED} compression-controlled → ${PHI_FLEX} tension-controlled)`
        : `Spiral  (φ = ${PHI_COL_SPR} compression-controlled → ${PHI_FLEX} tension-controlled)`,
      Ag_mm2:             +Ag.toFixed(0),
      pass,
      status,
      note: pass
        ? `η = ${eta_combined.toFixed(3)} ≤ 1.0  |  ρg = ${(rho_g*100).toFixed(2)}% ∈ [1%, 8%]  |  ${interaction_formula}`
        : !reinf_ok
        ? `ρg = ${(rho_g*100).toFixed(2)}% is out of [1%, 8%] per ACI §10.6.1.1.`
        : `η = ${eta_combined.toFixed(3)} > 1.0 — increase section or add steel. ${interaction_formula}`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REINFORCEMENT RATIO CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  function reinfRatioCheck(As_prov, bw_m, d_m, h_m, fcprime, fy, isColumn) {
    const bw_mm = bw_m * 1000, d_mm = d_m * 1000, h_mm = h_m * 1000;
    const conc  = concreteMaterial(fcprime);

    if (isColumn) {
      const Ag    = bw_mm * h_mm;
      const rho_g = As_prov / Ag;
      const ok    = rho_g >= 0.01 && rho_g <= 0.08;
      return {
        check:       'Reinforcement — Column (ACI §10.6.1.1)',
        rho_g_pct:   +(rho_g * 100).toFixed(3),
        Ast_mm2:     +As_prov.toFixed(1),
        Ag_mm2:      +Ag.toFixed(0),
        rho_min_pct: 1.0,
        rho_max_pct: 8.0,
        eta:         rho_g < 0.01 ? +(0.01 / Math.max(rho_g, 1e-6)).toFixed(4)
                                  : +(rho_g / 0.08).toFixed(4),
        pass:        ok,
        status:      ok ? 'OK' : 'FAIL',
        note: `ρg = ${(rho_g*100).toFixed(2)}% — must be 1% to 8% per ACI §10.6.1.1`
      };
    }

    // ── Beam ──────────────────────────────────────────────────────────────
    const As_min_a  = (0.25 * Math.sqrt(fcprime) / fy) * bw_mm * d_mm;
    const As_min_b  = (1.4 / fy) * bw_mm * d_mm;
    const As_min    = Math.max(As_min_a, As_min_b);

    // As,max from ε_t = 0.004 requirement (§9.3.3.1)
    // a_max/d from balanced: c/d = 0.003/(0.003+0.004) = 3/7; a_max = β₁·c_max
    const c_max_d   = 0.003 / (0.003 + 0.004);   // 3/7
    const a_max     = conc.beta1 * c_max_d * d_mm;
    const As_max    = 0.85 * fcprime * a_max * bw_mm / fy;   // §22.2.2

    const rho       = As_prov / (bw_mm * d_mm);
    const rho_min   = As_min  / (bw_mm * d_mm);
    const rho_max   = As_max  / (bw_mm * d_mm);
    const ok        = As_prov >= As_min && As_prov <= As_max;

    return {
      check:       'Reinforcement — Beam (ACI §9.6.1.2)',
      rho_pct:     +(rho    * 100).toFixed(4),
      rho_min_pct: +(rho_min * 100).toFixed(4),
      rho_max_pct: +(rho_max * 100).toFixed(4),
      As_prov_mm2: +As_prov.toFixed(1),
      As_min_mm2:  +As_min.toFixed(1),
      As_max_mm2:  +As_max.toFixed(1),
      eta:         As_prov > As_max
                     ? +(As_prov / As_max).toFixed(4)
                     : +(As_min / Math.max(As_prov, 0.001)).toFixed(4),
      pass:        ok,
      status:      ok ? 'OK' : 'FAIL',
      note: ok
        ? `ρ = ${(rho*100).toFixed(3)}% ∈ [${(rho_min*100).toFixed(3)}%, ${(rho_max*100).toFixed(3)}%] — OK`
        : As_prov < As_min
        ? `As = ${As_prov.toFixed(0)} mm² < As,min = ${As_min.toFixed(0)} mm² (ρ = ${(rho*100).toFixed(3)}%). Increase reinforcement.`
        : `As = ${As_prov.toFixed(0)} mm² > As,max = ${As_max.toFixed(0)} mm² (ε_t < 0.004). Increase section depth.`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEFLECTION  —  Minimum thickness check (ACI 318-19 Table 9.3.1.1)
  //  Simplified: if h ≥ h_min(table), no deflection calculation needed
  //  memberType : 'SS' | 'one-end' | 'both' | 'cant'
  // ═══════════════════════════════════════════════════════════════════════════
  function deflectionMinH(l_eff_m, h_m, memberType) {
    memberType = memberType || 'SS';
    const l_mm = l_eff_m * 1000;
    const h_mm = h_m * 1000;

    // Table 9.3.1.1 — Grade 60 (fy = 420 MPa), normal-weight concrete
    // Modification for other fy: multiply by (0.4 + fy/700)  §9.3.1.1.1
    const DIV = { 'SS': 16, 'one-end': 18.5, 'both': 21, 'cant': 8 };
    const divisor = DIV[memberType] || 16;
    const h_min   = l_mm / divisor;

    const ok = h_mm >= h_min;

    return {
      check:       'Deflection — Min h (ACI §9.3.1)',
      l_eff_m:     +l_eff_m.toFixed(3),
      h_actual_mm: +h_mm.toFixed(1),
      h_min_mm:    +h_min.toFixed(1),
      l_div_h:     +(l_mm / h_mm).toFixed(1),
      member_type: memberType,
      eta:         +(h_min / Math.max(h_mm, 1)).toFixed(4),
      pass:        ok,
      status:      ok ? 'OK' : 'NEAR',
      note: ok
        ? `h = ${h_mm.toFixed(0)} mm ≥ l/${divisor} = ${h_min.toFixed(0)} mm — deflection calculation not required.`
        : `h = ${h_mm.toFixed(0)} mm < l/${divisor} = ${h_min.toFixed(0)} mm — explicit deflection calculation required per ACI §24.2.`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P-M INTERACTION DIAGRAM  (ACI 318-19 §22.4 — Whitney stress block)
  //  Returns array of {phi_Pn_kN, phi_Mn_kNm, zone} envelope points.
  //  Rectangular section, symmetric reinforcement (As = As' = Ast/2 each face).
  //  b_mm, h_mm : section dimensions (mm)
  //  Ast_mm2    : total steel area (mm²)
  //  fcprime    : f'c (MPa)
  //  fy         : rebar yield stress (MPa)
  //  tied       : true = tied column, false = spiral
  // ═══════════════════════════════════════════════════════════════════════════
  function generatePMCurve(b_mm, h_mm, Ast_mm2, fcprime, fy, tied) {
    tied = (tied !== false);
    const conc   = concreteMaterial(fcprime);
    const beta1  = conc.beta1;
    const eps_cu = 0.003;
    const Es     = 200000;
    const cover  = 50;             // mm — centroid of bars from face
    const d      = h_mm - cover;   // tension steel centroid
    const dp     = cover;          // compression steel centroid
    const As     = Ast_mm2 / 2;    // steel area on each face
    const Ag     = b_mm * h_mm;
    const phi_col = tied ? PHI_COL_TIED : PHI_COL_SPR;
    const alpha   = tied ? 0.80 : 0.85;

    const pts = [];

    // ── Point A: pure axial compression (e = 0, §22.4.2) ────────────────
    const Pn0 = alpha * (0.85 * fcprime * (Ag - Ast_mm2) + fy * Ast_mm2);  // N
    pts.push({ phi_Pn: +(phi_col * Pn0 / 1000).toFixed(2), phi_Mn: 0, zone: 'compression-controlled' });

    // ── Sweep neutral axis depth c ───────────────────────────────────────
    // Log-space from 0.05*d to 20*d gives dense sampling near balanced point
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const c = d * Math.exp(Math.log(0.05) + (Math.log(20) - Math.log(0.05)) * i / N);

      const a     = Math.min(beta1 * c, h_mm);
      const eps_t = eps_cu * (d - c) / c;           // tension steel strain (+= tension)
      const eps_cp= eps_cu * (c - dp) / c;           // comp steel strain (+= comp)
      const fs    = Math.max(-fy, Math.min(fy, eps_t  * Es));  // tension steel stress
      const fsp   = Math.max(-fy, Math.min(fy, eps_cp * Es));  // comp steel stress

      // Forces (N, positive = compression)
      const Cc = 0.85 * fcprime * a * b_mm;
      // Comp steel — subtract concrete already in Cc if steel is inside stress block
      const Cs = As * (fsp - (a >= dp ? 0.85 * fcprime : 0));
      // Tension steel — positive = tension force; subtract from Pn
      const T  = As * fs;

      const Pn = Cc + Cs - T;

      // Moment about section centroid (h/2 from top)
      const Mn = Math.abs(
        Cc * (h_mm / 2 - a / 2) +
        Cs * (h_mm / 2 - dp) +
        T  * (d - h_mm / 2)
      );  // N·mm

      // φ factor based on ε_t (use phiFromEpst)
      const { phi: phi_raw, zone } = phiFromEpst(eps_t, tied ? 'tied' : 'spiral', fy);
      const phi_eff = Pn > 0 ? phi_raw : PHI_FLEX;

      pts.push({
        phi_Pn: +(phi_eff * Pn  / 1000).toFixed(2),
        phi_Mn: +(phi_eff * Mn  / 1e6 ).toFixed(3),
        zone,
        eps_t:  +eps_t.toFixed(5)
      });
    }

    // ── Point B: pure tension (c → 0, all steel yields in tension) ───────
    const Pn_t = -Ast_mm2 * fy;  // N (negative = tension)
    pts.push({ phi_Pn: +(PHI_FLEX * Pn_t / 1000).toFixed(2), phi_Mn: 0, zone: 'tension-controlled' });

    // Sort by descending phi_Pn (top of diagram first)
    pts.sort((a, b) => b.phi_Pn - a.phi_Pn);
    return pts;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEVELOPMENT LENGTH  (ACI 318-19 §25.4)
  //  db_mm     : bar diameter (mm)
  //  fcprime   : f'c (MPa)
  //  fy_rebar  : rebar yield (MPa)
  //  options   : { topBar, epoxy, lambda, confine }
  //    topBar  : true if more than 300 mm fresh concrete cast below bar (ψt = 1.3)
  //    epoxy   : true for epoxy-coated bars (ψe = 1.2)
  //    lambda  : lightweight factor (1.0 normal-wt, 0.75 lightweight)
  //    confine : (cb + Ktr)/db value (1.5 typical, max 2.5)
  // ═══════════════════════════════════════════════════════════════════════════
  function developmentLength(db_mm, fcprime, fy_rebar, options) {
    options    = options || {};
    const lambda  = options.lambda  || 1.0;
    const topBar  = options.topBar  || false;
    const epoxy   = options.epoxy   || false;

    // Modification factors §25.4.2.4
    const psi_t = topBar ? 1.3 : 1.0;                        // casting position
    const psi_e = epoxy  ? 1.2 : 1.0;                        // epoxy coating
    const psi_s = db_mm <= 19 ? 0.8 : 1.0;                   // bar size (#6 and smaller)
    const psi_g = fy_rebar <= 420 ? 1.0
               : fy_rebar <= 550 ? 1.15 : 1.3;               // grade factor
    const cb_ktr = Math.min(2.5, Math.max(1.5, options.confine || 1.5)); // confinement term

    // Cap on product psi_t * psi_e per §25.4.2.4 (max 1.7)
    const psi_te = Math.min(1.7, psi_t * psi_e);

    // ── Tension development length, ACI 318M-19 Table 25.4.2.3a (SI) ──────
    //
    //   ld = [ fy·ψt·ψe·ψs·ψg / (1.1·λ·√f'c·((cb+Ktr)/db)) ] · db      f'c, fy in MPa
    //
    // The coefficient here was 3/40 = 0.075, which belongs to the INCH-POUND
    // form of the same equation (f'c and fy in psi). Applied to MPa inputs it
    // understates ld by a factor of 1/1.1 ÷ 3/40 ≈ 12.1.
    //
    // Verified both ways for a #8 bar (db = 25 mm), f'c = 30 MPa, fy = 420 MPa,
    // (cb+Ktr)/db = 1.5:
    //   inch-pound formula evaluated in psi, converted back →  1154 mm
    //   SI formula with the 1.1 coefficient                  →  1162 mm
    //   the 3/40 version                                     →    96 mm
    // The 96 mm was then hidden by the 300 mm floor below, so the reported
    // figure looked like a plausible short length rather than an obvious error
    // — while still being roughly a quarter of the required anchorage. Lap
    // splices inherit it directly, since lap_A/lap_B are multiples of ld.
    //
    // The compression length below already uses the correct SI coefficients
    // (0.24 and 0.043), which is what flagged this one as the outlier.
    const ld_raw = (fy_rebar * psi_te * psi_s * psi_g) /
                   (1.1 * lambda * Math.sqrt(fcprime) * cb_ktr) * db_mm;
    const ld = Math.max(ld_raw, 300);   // §25.4.2.1b: minimum 300 mm

    // Standard 90° hook §25.4.3.1a (SI)
    // ldh = (0.24 × ψe × ψr × ψo × ψc × fy) / (λ√f'c) × db
    // Using ψr = ψo = ψc = 1.0 (standard conditions)
    const ldh_raw = 0.24 * psi_e * fy_rebar / (lambda * Math.sqrt(fcprime)) * db_mm;
    const ldh = Math.max(ldh_raw, Math.max(8 * db_mm, 150));  // §25.4.3.1d

    // Compression development length §25.4.9 (straight bars)
    // ldc = max(0.24·fy/(λ√f'c)·db, 0.043·fy·db)
    const ldc_a = 0.24 * fy_rebar / (lambda * Math.sqrt(fcprime)) * db_mm;
    const ldc_b = 0.043 * fy_rebar * db_mm;
    const ldc   = Math.max(ldc_a, ldc_b, 200);

    // Lap splices §25.5.2
    const lap_A = 1.0 * ld;   // Class A: ≤ 50% bars spliced
    const lap_B = 1.3 * ld;   // Class B: > 50% bars spliced (conservative)

    // Bar designation lookup
    const barName = db_mm <= 10 ? '#3'
                  : db_mm <= 13 ? '#4'
                  : db_mm <= 16 ? '#5'
                  : db_mm <= 19 ? '#6'
                  : db_mm <= 22 ? '#7'
                  : db_mm <= 25 ? '#8'
                  : db_mm <= 29 ? '#9'
                  : db_mm <= 32 ? '#10'
                  : '#11';

    return {
      check:        'Development Length (ACI §25.4)',
      bar:          `${barName} (db = ${db_mm} mm)`,
      ld_mm:        +ld.toFixed(0),
      ldh_mm:       +ldh.toFixed(0),
      ldc_mm:       +ldc.toFixed(0),
      lap_A_mm:     +lap_A.toFixed(0),
      lap_B_mm:     +lap_B.toFixed(0),
      psi_t, psi_e, psi_s, psi_g, cb_ktr,
      pass:         true,
      status:       'INFO',
      eta:          null,
      note: `${barName}: ld = ${ld.toFixed(0)} mm | hook = ${ldh.toFixed(0)} mm | comp = ${ldc.toFixed(0)} mm | lap-B = ${lap_B.toFixed(0)} mm`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SLENDER COLUMN — Moment Magnification (ACI 318-19 §6.6.4, non-sway)
  //  Pu_kN     : factored axial load (kN, compression +)
  //  M1_kNm    : smaller factored end moment (kNm)
  //  M2_kNm    : larger  factored end moment (kNm, |M2| ≥ |M1|)
  //  k         : effective length factor (0.5–2.0)
  //  lu_m      : unsupported column length (m)
  //  b_mm, h_mm: section dimensions (mm)
  //  fcprime   : f'c (MPa)
  //  betadns   : ratio factored sustained axial / total axial (0.0–1.0, default 0.6)
  // ═══════════════════════════════════════════════════════════════════════════
  function slenderColumnMagnify(Pu_kN, M1_kNm, M2_kNm, k, lu_m, b_mm, h_mm, fcprime, betadns) {
    betadns = betadns != null ? betadns : 0.6;

    // ACI defines M2 as the LARGER factored end moment and M1 as the smaller,
    // with M1/M2 taken negative for double curvature. The two arguments were
    // used positionally as the solver reports them — end 1 and end 2 — so a
    // member carrying its moment at end 1 arrived with M2 = 0. Mc = δns·M2
    // was then zero, and runACIChecks feeds Mc straight into the P-M check as
    // the design moment: a slender column with 60 kNm at its base was checked
    // at M = 0 and reported OK.
    //
    // §6.6.4.5.4 also sets a floor of M2,min = Pu·(15 + 0.03h) — the code's own
    // guard against a nominally zero end moment — which was never applied.
    const _mA = M1_kNm || 0, _mB = M2_kNm || 0;
    const _big = Math.abs(_mA) >= Math.abs(_mB) ? _mA : _mB;
    const _sml = Math.abs(_mA) >= Math.abs(_mB) ? _mB : _mA;
    const M2min_kNm = Math.abs(Pu_kN) * (15 + 0.03 * h_mm) / 1000;
    const M2_use = Math.max(Math.abs(_big), M2min_kNm);
    const M1_use = Math.abs(_sml);
    // Same sign at both ends means single curvature, which ACI takes as a
    // positive ratio; opposite signs mean double curvature and a negative one.
    const _dbl = (_mA * _mB) < 0;
    M1_kNm = (_dbl ? -1 : 1) * M1_use;
    M2_kNm = M2_use;

    // Radius of gyration for rectangular section §6.2.5: r = 0.30·h
    const r = 0.30 * h_mm;
    const klu_r = k * lu_m * 1000 / r;

    // §6.2.5 slenderness limit for non-sway frames: klu/r ≤ 34 − 12·(M1/M2)
    // M1/M2 positive if member bends in single curvature, negative if double
    const ratio_M = M2_kNm !== 0 ? M1_kNm / M2_kNm : 0;
    const slend_limit = Math.min(40, 34 - 12 * ratio_M);  // max 40 per §6.2.5

    if (klu_r <= slend_limit) {
      return {
        check:      'Slenderness (ACI §6.6.4)',
        klu_r:      +klu_r.toFixed(1),
        limit:      +slend_limit.toFixed(1),
        r_mm:       +r.toFixed(1),
        M2_orig_kNm: +M2_kNm.toFixed(3),
        M2_min_kNm:  +M2min_kNm.toFixed(3),
        M1_over_M2:  +ratio_M.toFixed(3),
        magnified:  false,
        delta_ns:   1.0,
        Mc_kNm:     M2_kNm,
        pass:       true,
        status:     'OK',
        eta:        +(klu_r / slend_limit).toFixed(3),
        note:       `klu/r = ${klu_r.toFixed(1)} ≤ ${slend_limit.toFixed(0)} — slenderness negligible (ACI §6.2.5)`
      };
    }

    // Effective flexural stiffness §6.6.4.4.4
    const Ec      = 4700 * Math.sqrt(fcprime);   // MPa
    const Ig      = b_mm * h_mm ** 3 / 12;       // mm⁴
    const EI_eff  = 0.4 * Ec * Ig / (1 + betadns);  // N·mm²

    // Critical buckling load §6.6.4.4.2
    const klu_mm = k * lu_m * 1000;
    const Pc_kN  = Math.PI ** 2 * EI_eff / (klu_mm ** 2) / 1000;  // kN

    // Equivalent moment correction factor §6.6.4.5.3a
    const Cm = Math.max(0.4, 0.6 - 0.4 * ratio_M);

    // Magnification factor §6.6.4.5.2
    const denom = 1 - Pu_kN / (0.75 * Math.max(Pc_kN, 0.001));
    const delta_ns = denom > 0.001 ? Math.max(1.0, Cm / denom) : 99;
    const Mc_kNm  = delta_ns * M2_kNm;   // M2_kNm is already |larger| and >= M2,min

    const stable = delta_ns < 50;

    return {
      check:         'Slenderness (ACI §6.6.4)',
      klu_r:         +klu_r.toFixed(1),
      limit:         +slend_limit.toFixed(1),
      r_mm:          +r.toFixed(1),
      k_factor:      k,
      EI_eff_MNm2:   +(EI_eff / 1e12).toFixed(4),
      Pc_kN:         +Pc_kN.toFixed(1),
      Cm:            +Cm.toFixed(3),
      delta_ns:      +Math.min(delta_ns, 99).toFixed(3),
      magnified:     true,
      M2_orig_kNm:   +M2_kNm.toFixed(3),
      M2_min_kNm:    +M2min_kNm.toFixed(3),
      M1_over_M2:    +ratio_M.toFixed(3),
      Mc_kNm:        +Mc_kNm.toFixed(3),
      stable,
      pass:          stable,
      status:        !stable ? 'FAIL' : delta_ns > 2.5 ? 'NEAR' : 'OK',
      eta:           +Math.min(delta_ns / 2.5, 9).toFixed(4),
      note: stable
        ? `klu/r = ${klu_r.toFixed(1)} > ${slend_limit.toFixed(0)} — slender column. δns = ${delta_ns.toFixed(3)}.  Mc = δns × M2 = ${Mc_kNm.toFixed(1)} kNm`
        : `⚠ Column unstable: Pu = ${Pu_kN.toFixed(1)} ≥ 0.75Pc = ${(0.75*Pc_kN).toFixed(1)} kN. Increase section or reduce klu.`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TORSION DESIGN  (ACI 318-19 §9.5.4, §22.7)
  //  Tu_kNm    : factored torsional moment (kNm)
  //  V_kN      : factored shear (kN) — for combined check §22.7.7
  //  bw_m, h_m : section dimensions (m)
  //  d_m       : effective depth (m)
  //  fcprime   : f'c (MPa)
  //  fyt       : stirrup yield (MPa)
  //  fy_long   : longitudinal rebar yield (MPa)
  // ═══════════════════════════════════════════════════════════════════════════
  function torsionBeam(Tu_kNm, V_kN, bw_m, h_m, d_m, fcprime, fyt, fy_long) {
    fyt    = fyt    || 420;
    fy_long = fy_long || fyt;
    const bw = bw_m * 1000, h = h_m * 1000, d = d_m * 1000;
    const Tu = Math.abs(Tu_kNm) * 1e6;   // N·mm
    const conc   = concreteMaterial(fcprime);
    const lambda = conc.lambda;

    // Section perimeter and area
    const Acp = bw * h;
    const pcp = 2 * (bw + h);

    // Cracking torsion §22.7.5.1: Tcr = λ√f'c · Acp²/pcp   [N·mm]
    const Tcr_kNm = lambda * Math.sqrt(fcprime) * Acp ** 2 / pcp / 1e6;

    // Threshold §9.5.4.1: neglect torsion if Tu ≤ φ·Tcr/4
    const Tu_thr = PHI_SHEAR * Tcr_kNm / 4;

    if (Math.abs(Tu_kNm) <= Tu_thr) {
      return {
        check:             'Torsion (ACI §22.7)',
        Tu_kNm:            +Tu_kNm.toFixed(3),
        Tcr_kNm:           +Tcr_kNm.toFixed(3),
        Tu_threshold_kNm:  +Tu_thr.toFixed(3),
        torsion_neglected: true,
        pass:  true, status: 'OK',
        eta:   +(Math.abs(Tu_kNm) / Math.max(Tu_thr, 0.001)).toFixed(4),
        note:  `Tu = ${Tu_kNm.toFixed(2)} kNm ≤ φTcr/4 = ${Tu_thr.toFixed(2)} kNm — torsion neglected (§9.5.4.1)`
      };
    }

    // Hollow thin-wall tube properties (§22.7.6)
    const cover = 40;
    const xo  = bw - 2 * cover, yo = h - 2 * cover;
    const Aoh = xo * yo;           // mm² inside hoop c.l.
    const ph  = 2 * (xo + yo);    // mm perimeter of Aoh
    const Ao  = 0.85 * Aoh;       // §22.7.6.1

    // Transverse steel per unit length §22.7.6.1a (θ = 45°)
    const At_s = Tu / (2 * PHI_SHEAR * Ao * fyt);   // mm²/mm each leg

    // Longitudinal steel §22.7.6.1b
    const Al_req = At_s * ph * (fyt / fy_long);    // mm²
    const Al_min = Math.max(
      0.42 * Math.sqrt(fcprime) * Acp / fy_long - At_s * ph * fyt / fy_long,
      0.175 * bw / fy_long * ph / ph   // simplified min per §22.7.6.2
    );
    const Al_design = Math.max(Al_req, 0, Al_min);

    // Combined shear + torsion strut check §22.7.7.1
    const Vc_kN = 0.17 * lambda * Math.sqrt(fcprime) * bw * d / 1000;   // kN
    const lhs = Math.sqrt(
      (V_kN * 1000 / (bw * d)) ** 2 + (Tu * ph / (1.7 * Aoh ** 2)) ** 2
    );
    const rhs = PHI_SHEAR * (Vc_kN * 1000 / (bw * d) + 0.66 * Math.sqrt(fcprime));
    const combined_ok = lhs <= rhs;
    const eta = lhs / Math.max(rhs, 0.001);

    return {
      check:             'Torsion (ACI §22.7)',
      Tu_kNm:            +Tu_kNm.toFixed(3),
      Tcr_kNm:           +Tcr_kNm.toFixed(3),
      Tu_threshold_kNm:  +Tu_thr.toFixed(3),
      torsion_neglected: false,
      Aoh_mm2:           +Aoh.toFixed(0),
      ph_mm:             +ph.toFixed(0),
      At_s_mm2_mm:       +At_s.toFixed(4),
      Al_req_mm2:        +Al_req.toFixed(0),
      Al_design_mm2:     +Al_design.toFixed(0),
      combined_ok,
      eta:               +Math.min(eta, 9).toFixed(4),
      pass:              combined_ok,
      status:            !combined_ok ? 'FAIL' : eta > 0.85 ? 'NEAR' : 'OK',
      note: combined_ok
        ? `Torsion required: At/s ≥ ${At_s.toFixed(3)} mm²/mm each leg; Al ≥ ${Al_design.toFixed(0)} mm²`
        : `⚠ Section too small for combined shear+torsion (η=${eta.toFixed(2)} > 1.0) — increase bw or h`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CRACK CONTROL  (ACI 318-19 §24.3)
  //  Bar spacing approach + Frosch (2001) crack width estimate
  //  M_s_kNm   : service (unfactored) moment (kNm). If 0, uses 2/3·fy for fs.
  //  As_mm2    : provided tension steel area (mm²)
  //  bw_m, d_m, h_m : section geometry (m)
  //  fcprime   : f'c (MPa)  [not directly used in §24.3.2 but for context]
  //  fy        : rebar yield (MPa)
  //  cover_mm  : clear cover to outer stirrup (mm)
  //  s_bar_mm  : clear bar spacing (mm); if 0 estimated from geometry
  // ═══════════════════════════════════════════════════════════════════════════
  function crackControl(M_s_kNm, As_mm2, bw_m, d_m, h_m, fy, cover_mm, s_bar_mm) {
    const bw = bw_m * 1000, d = d_m * 1000, h = h_m * 1000;
    cover_mm = cover_mm || 40;

    // Service steel stress
    const fs = (M_s_kNm > 0 && As_mm2 > 0)
      ? Math.min(fy, M_s_kNm * 1e6 / (0.9 * As_mm2 * d))
      : (2 / 3) * fy;

    // §24.3.2 maximum bar spacing limits (mm)
    const s_lim_a = 380 * (280 / Math.max(fs, 1)) - 2.5 * cover_mm;
    const s_lim_b = 300 * (280 / Math.max(fs, 1));
    const s_limit = Math.max(0, Math.min(s_lim_a, s_lim_b));

    // Estimated actual spacing (if not provided)
    const n_bars = As_mm2 > 0 ? Math.max(1, Math.round(As_mm2 / (Math.PI * (20 / 2) ** 2))) : 2;
    const s_actual = s_bar_mm > 0 ? s_bar_mm
      : (bw - 2 * cover_mm - 10) / Math.max(n_bars - 1, 1);

    const spacing_ok = s_actual <= s_limit;

    // ── Frosch (2001) crack width (mm) ─────────────────────────────────
    // wc = 2·β·(fs/Es)·√(dc² + (s/2)²)
    const Es   = 200000;
    const dc   = cover_mm + 10;   // approx: cover to outer bar centroid (+stirrup dia)
    const beta = 1 + dc / (0.7 * Math.max(h - d, 1));
    const wc   = 2 * beta * (fs / Es) * Math.sqrt(dc ** 2 + (s_actual / 2) ** 2);

    // ACI informational limit (not code-mandated): 0.33 mm interior, 0.25 mm exterior
    const wc_limit = 0.33;
    const wc_ok    = wc <= wc_limit;

    // eta tracks the CODE requirement, which is the bar spacing of §24.3.2.
    // It used to switch to wc/0.33 whenever the Frosch crack width exceeded
    // its limit — but that limit is informational, not mandated, so a beam
    // passing every ACI requirement reported eta = 1.38 and rolled that up as
    // the member's headline utilisation while its verdict stayed NEAR. The
    // crack width still raises NEAR below, and is reported in wc_mm.
    const eta = +(s_actual / Math.max(s_limit, 1)).toFixed(4);

    return {
      check:        'Crack Control (ACI §24.3)',
      fs_MPa:       +fs.toFixed(1),
      s_actual_mm:  +s_actual.toFixed(0),
      s_limit_mm:   +Math.max(s_limit, 0).toFixed(0),
      spacing_ok,
      wc_mm:        +wc.toFixed(4),
      wc_limit_mm:  wc_limit,
      wc_ok,
      eta:          +Math.min(eta, 9).toFixed(4),
      pass:         spacing_ok,
      status:       !spacing_ok ? 'FAIL' : !wc_ok ? 'NEAR' : 'OK',
      note: spacing_ok
        ? `s = ${s_actual.toFixed(0)} mm ≤ ${s_limit.toFixed(0)} mm ✓  |  wc ≈ ${wc.toFixed(3)} mm (Frosch)${wc_ok ? '' : ' > 0.33 mm limit'}`
        : `s = ${s_actual.toFixed(0)} mm > s_max = ${s_limit.toFixed(0)} mm at fs = ${fs.toFixed(0)} MPa — reduce bar spacing or add bars`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MASTER — runACIChecks
  //  ef      : element force object { M1, M2, V1, V2, N1, N2, L }
  //  sec     : section object (ACI type; sec.fy = f'c MPa, sec.d mm, sec.bf mm)
  //  options : {
  //    fy_rebar   [MPa]  rebar yield (default 420, Grade 60)
  //    fyt        [MPa]  stirrup yield  (default = fy_rebar)
  //    cover      [mm]   clear cover (default 40 mm)
  //    phi_bar    [mm]   longitudinal bar diameter (default 19 = #6)
  //    phi_stir   [mm]   stirrup diameter (default 10 = #3)
  //    memberType [str]  'SS' | 'one-end' | 'both' | 'cant'
  //  }
  // ═══════════════════════════════════════════════════════════════════════════
  function runACIChecks(ef, sec, options) {
    options = options || {};

    // Material parameters
    // f'c [MPa]. Resolved by the caller where the model and its materials are
    // visible; `sec.fy` is only a fallback, because on some concrete sections
    // it holds the rebar grade rather than the cylinder strength.
    const fcprime  = Math.min(options.fc || sec.fy || 28, 100);
    const fy_rebar = options.fy_rebar || 420;   // Grade 60 default
    const fyt      = options.fyt      || fy_rebar;

    // Geometry
    const b_m  = options.b   || (sec.bf ? sec.bf / 1000 : 0.3);   // m
    const h_m  = options.h   || (sec.d  ? sec.d  / 1000 : 0.5);   // m

    // Cover + bar details
    const cover_mm = options.cover    || 40;    // mm (ACI default ~40 mm)
    const phi_bar  = options.phi_bar  || 19;    // mm (#6 bar default)
    const phi_stir = options.phi_stir || 10;    // mm (#3 stirrup)

    // Effective depth
    const d_m = h_m - cover_mm / 1000 - phi_stir / 1000 - phi_bar / 2000;  // m

    // Detect column vs beam — priority: explicit flag → memberType → section name
    const isCol = options.isColumn !== undefined
      ? options.isColumn
      : (options.memberType === 'column')
      || (sec.name && /ACI\s*C\b|col.*\d|column/i.test(sec.name));

    const memberType = options.memberType || 'SS';

    // Peak demands
    const M_Ed   = Math.max(Math.abs(ef.M1 || 0), Math.abs(ef.M2 || 0));   // kNm
    const M1_kNm = ef.M1 || 0;
    const M2_kNm = ef.M2 || 0;
    const V_Ed   = Math.max(Math.abs(ef.V1 || 0), Math.abs(ef.V2 || 0));   // kN
    const Tu_kNm = Math.max(Math.abs(ef.T1 || 0), Math.abs(ef.T2 || 0));   // kNm torsion
    // solveFrame reports axial force COMPRESSION-POSITIVE: a 900 kN column comes
    // back as N1 = N2 = +900 (see the convention note in pdelta.js). Both of
    // these negated it, so N_comp was 0 for every compressed member — a 400×400
    // column under 900 kN was designed with zero axial load, took φ = 0.90
    // (tension-controlled) instead of 0.65, and its P-M check reported
    // "flexure-dominant" with eta_P = 0. Slenderness magnification and the
    // axial-enhanced Vc were zeroed out with it.
    const N_comp = Math.max(0, ef.N1 || 0, ef.N2 || 0);                     // kN compression
    const N_net  = Math.max(ef.N1 || 0, ef.N2 || 0);                        // kN (−=tension, +=comp)

    // Slenderness parameters from element geometry
    const lu_m    = ef.L || h_m * 3;     // unsupported length; fallback to 3 × depth
    const k_eff   = options.k || 1.0;    // effective length factor
    const betadns = options.betadns || 0.6;

    const checks = [];

    // ── 1. Material info ──────────────────────────────────────────────────
    checks.push(materialSummary(fcprime, fy_rebar));

    if (isCol) {
      // ── Column path ──────────────────────────────────────────────────────

      // 2. Slenderness check + moment magnification (§6.6.4)
      const slend = slenderColumnMagnify(
        N_comp, M1_kNm, M2_kNm, k_eff, lu_m,
        b_m * 1000, h_m * 1000, fcprime, betadns
      );
      checks.push(slend);
      // Use magnified moment for P-M check if applicable
      const M_design = slend.magnified ? slend.Mc_kNm : M_Ed;

      // 3. Column P-M check (with magnified moment)
      // options.Ast is the longitudinal steel the user laid out in
      // Define ▸ Sections ▸ Rebar. It used to be hardcoded 0, which this
      // function reads as "no layout given, assume rho,min = 1%" — so a
      // column detailed with 12 #9 bars was checked as if it had the bare
      // minimum, and reported far weaker than it is.
      const col = columnCheck(N_comp, M_design, b_m, h_m, fcprime, fy_rebar,
                              options.Ast > 0 ? options.Ast : 0, true);
      checks.push(col);

      // 4. Column shear check §22.5.1.1 (shear capacity with axial)
      //    Vc = [0.17·λ·√f'c + Nu/(6·Ag)]·bw·d  (Table 22.5.5.1, simplified, with Nu benefit)
      const sh_col = shearBeam(V_Ed, b_m, d_m, fcprime, fyt, col.Ast_use_mm2, N_comp);
      const sh_col_labeled = Object.assign({}, sh_col, {
        check: 'Shear — Column §22.5 (axial-enhanced Vc)',
        note: sh_col.note + (N_comp > 0 ? `  [Nu=${N_comp.toFixed(1)}kN increases Vc]` : '')
      });
      checks.push(sh_col_labeled);

      // 5. Reinforcement ratio check
      const rr = reinfRatioCheck(col.Ast_use_mm2, b_m, d_m, h_m, fcprime, fy_rebar, true);
      checks.push(rr);

      // 6. Development length for typical column bar (informational)
      const devLen = developmentLength(phi_bar, fcprime, fy_rebar, { topBar: false });
      checks.push(devLen);

    } else {
      // ── Beam path ─────────────────────────────────────────────────────────

      // 2. Flexure
      const fl = flexureBeam(M_Ed, b_m, d_m, fcprime, fy_rebar);
      checks.push(fl);

      // 3. Reinforcement ratio
      const rr = reinfRatioCheck(fl.As_prov_mm2, b_m, d_m, h_m, fcprime, fy_rebar, false);
      checks.push(rr);

      // 4. Shear
      const sh = shearBeam(V_Ed, b_m, d_m, fcprime, fyt, fl.As_prov_mm2, N_net);
      checks.push(sh);

      // 5. Torsion (skip if negligible)
      if (Tu_kNm > 0.001) {
        checks.push(torsionBeam(Tu_kNm, V_Ed, b_m, h_m, d_m, fcprime, fyt, fy_rebar));
      }

      // 6. Crack control (§24.3) — uses service moment ≈ Mu/1.4 as estimate
      const M_service = M_Ed / 1.4;
      checks.push(crackControl(M_service, fl.As_prov_mm2, b_m, d_m, h_m, fy_rebar, cover_mm, 0));

      // 7. Deflection — minimum depth check
      if (ef.L) checks.push(deflectionMinH(ef.L, h_m, memberType));

      // 8. Development length (informational)
      const devLen = developmentLength(phi_bar, fcprime, fy_rebar,
        { topBar: options.topBar || false });
      checks.push(devLen);
    }

    return checks;
  }

  // ── Detector: is this section an ACI 318-19 RC section? ─────────────────
  function isACI(sec) {
    if (!sec) return false;
    // Match ACI RC sections by name prefix "ACI B" or "ACI C"
    if (sec.name && /^ACI\s+(B|C)\b/i.test(sec.name)) return true;
    // Also catch user-named sections "ACI Beam ..." or "ACI Column ..."
    if (sec.name && /^ACI\s+(beam|col)/i.test(sec.name)) return true;
    return false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    concreteMaterial,
    phiFromEpst,
    materialSummary,
    flexureBeam,
    shearBeam,
    columnCheck,
    reinfRatioCheck,
    deflectionMinH,
    // ── NEW ACI 318-19 checks ─────────────────────────────────────────────
    generatePMCurve,           // P-M interaction diagram points
    developmentLength,         // §25.4 — straight, hook, lap splice
    slenderColumnMagnify,      // §6.6.4 — δns moment magnification
    torsionBeam,               // §22.7 — torsion + combined V+T check
    crackControl,              // §24.3 — bar spacing + Frosch wc
    runACIChecks,
    isACI,
    suggestStirrups,
    // Constants
    PHI_FLEX, PHI_SHEAR, PHI_COL_TIED, PHI_COL_SPR
  };

})();

window.ACIDesign = ACIDesign;
