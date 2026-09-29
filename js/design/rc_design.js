// ══════════════════════════════════════════════════════════════════════════════
//  rc_design.js  —  EC2 Reinforced Concrete Section Design
//  Source algorithms: fib-international/structuralcodes (EC2-2004)
//  Ref: EN 1992-1-1:2004  Units: N, mm, MPa  (converted from kN/m as needed)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const RCDesign = (() => {

  // ── Safety factors ─────────────────────────────────────────────────────────
  const γc  = 1.5;   // concrete
  const γs  = 1.15;  // reinforcement steel
  const αcc = 0.85;  // long-term compressive strength factor

  // ── Concrete material properties (EC2-2004 Table 3.1) ──────────────────────
  function concreteMaterial(fck) {
    // fck in MPa
    const fcm   = fck + 8;                                          // mean comp. strength
    const fcd   = αcc * fck / γc;                                   // design comp. strength
    const fctm  = fck <= 50
      ? 0.30 * Math.pow(fck, 2/3)
      : 2.12 * Math.log(1 + fcm / 10);                             // mean tensile strength
    const fctk5  = 0.7 * fctm;                                      // 5% fractile
    const fctk95 = 1.3 * fctm;                                      // 95% fractile
    const fctd   = fctk5 / γc;
    const Ecm    = 22000 * Math.pow(fcm / 10, 0.3);                // secant modulus MPa

    // Strain limits (parabolic-rectangular)
    const eps_c2  = fck <= 50 ? 2.0e-3 : (2.0 + 0.085 * Math.pow(fck - 50, 0.53)) * 1e-3;
    const eps_cu2 = fck <= 50 ? 3.5e-3 : (2.6 + 35 * Math.pow((90 - fck) / 100, 4)) * 1e-3;
    const n_exp   = fck <= 50 ? 2.0    : (1.4 + 23.4 * Math.pow((90 - fck) / 100, 4));
    // Bilinear / Sargin limit
    const eps_c1  = Math.min(0.7 * Math.pow(fcm, 0.31), 2.8) * 1e-3;
    const eps_cu1 = fck < 50 ? 3.5e-3 : (2.8 + 27 * Math.pow((98 - fcm) / 100, 4)) * 1e-3;

    return {
      fck, fcm, fcd, fctm, fctk5, fctk95, fctd, Ecm,
      eps_c2, eps_cu2, n_exp, eps_c1, eps_cu1,
      // Convenience
      ν: 0.6 * (1 - fck / 250),   // strength reduction factor (shear)
    };
  }

  // ── Reinforcement material properties ─────────────────────────────────────
  function steelMaterial(fyk, Es = 200000) {
    const fyd = fyk / γs;
    const eps_ud = 0.9 * (fyk / (γs * Es)) * 100 / 100;   // ≈ fyd/Es
    return { fyk, fyd, Es, eps_ud };
  }

  // ── Neutral axis depth (rectangular stress block) ──────────────────────────
  // λ (depth factor) and η (stress factor) per EC2 3.1.7
  function lambdaEta(fck) {
    const λ = fck <= 50 ? 0.8  : 0.8 - (fck - 50) / 400;
    const η = fck <= 50 ? 1.0  : 1.0 - (fck - 50) / 200;
    return { λ, η };
  }

  // ── BENDING REINFORCEMENT DESIGN (EC2 6.1) ────────────────────────────────
  // Inputs: M_Ed [kNm], b [m], d [m], fck [MPa], fyk [MPa]
  // Returns: As_req [mm²], K, z, compression_required, checks
  function bendingReinforcement(M_Ed, b, d, fck, fyk) {
    const M  = M_Ed * 1e6;           // kNm → Nmm
    const b_ = b * 1000;             // m → mm
    const d_ = d * 1000;             // m → mm

    const conc  = concreteMaterial(fck);
    const steel = steelMaterial(fyk);

    // K factor
    const K     = M / (conc.fcd * b_ * d_ * d_);

    // Limit K' (balanced, no compression reinforcement, δ=1)
    const K_lim = 0.167;   // EC2 simplified (ρ=1.0, δ=1)

    let compressionRequired = false;
    let K_eff = K;

    if (K > K_lim) {
      compressionRequired = true;
      K_eff = K_lim;   // design for singly-reinforced capacity, flag compression needed
    }

    // Lever arm z
    const z_ratio = 0.5 + Math.sqrt(0.25 - K_eff / 1.134);
    const z = Math.min(0.95, z_ratio) * d_;  // mm, z ≤ 0.95d

    // Required tensile steel
    const As_req = M / (steel.fyd * z);

    // Minimum and maximum steel
    const As_min = Math.max(0.26 * (conc.fctm / fyk) * b_ * d_, 0.0013 * b_ * d_);
    const As_max = 0.04 * b_ * d_;

    const As_design = Math.max(As_req, As_min);
    const status    = As_design > As_max ? 'FAIL (As > As,max)' : (compressionRequired ? 'WARN (doubly reinforced)' : 'OK');

    return {
      check:    'Bending Reinforcement (EC2 6.1)',
      M_Ed:     +M_Ed.toFixed(3),
      K:        +K.toFixed(5),
      K_lim:    +K_lim.toFixed(3),
      z_mm:     +z.toFixed(2),
      z_d:      +(z / d_).toFixed(3),
      As_req:   +As_req.toFixed(1),
      As_min:   +As_min.toFixed(1),
      As_max:   +As_max.toFixed(1),
      As_design: +As_design.toFixed(1),
      compressionRequired,
      fyd:      +steel.fyd.toFixed(2),
      fcd:      +conc.fcd.toFixed(2),
      fctm:     +conc.fctm.toFixed(3),
      status,
      pass:     !compressionRequired && K <= K_lim,
      eta:      +Math.min(K / K_lim, 2).toFixed(4),
      note:     compressionRequired
        ? 'K > K_lim: compression reinforcement required or increase section depth.'
        : `As,req = ${As_req.toFixed(0)} mm². Provide ≥ ${As_design.toFixed(0)} mm².`
    };
  }

  // ── SHEAR CAPACITY WITHOUT REINFORCEMENT VRd,c (EC2 Eq. 6.2) ─────────────
  // Inputs: d [m], Asl [mm²], bw [m], fck [MPa], NEd [kN], Ac [m²]
  function VRdc(d, Asl, bw, fck, NEd = 0, Ac = 0) {
    const d_  = d  * 1000;      // m→mm
    const bw_ = bw * 1000;      // m→mm
    const Ac_ = Ac * 1e6;       // m²→mm²
    const conc = concreteMaterial(fck);

    const CRdc = 0.18 / γc;
    const k    = Math.min(1 + Math.sqrt(200 / d_), 2.0);
    const ρl   = Math.min(Asl / (bw_ * d_), 0.02);
    const σcp  = Ac_ > 0 ? Math.min(NEd * 1000 / Ac_, 0.2 * conc.fcd) : 0;   // NEd kN→N
    const k1   = 0.15;

    const vmin = 0.035 * Math.pow(k, 1.5) * Math.sqrt(fck);
    const VRdc_formula = (CRdc * k * Math.pow(100 * ρl * fck, 1/3) + k1 * σcp) * bw_ * d_;
    const VRdc_min     = (vmin + k1 * σcp) * bw_ * d_;
    const VRdc_kN      = Math.max(VRdc_formula, VRdc_min) / 1000;

    return {
      VRdc:  +VRdc_kN.toFixed(3),
      k:     +k.toFixed(4),
      rho_l: +ρl.toFixed(6),
      sigma_cp: +σcp.toFixed(3),
      vmin:  +vmin.toFixed(4),
      CRdc:  +CRdc.toFixed(4)
    };
  }

  // ── SHEAR REINFORCEMENT DESIGN (EC2 Eq. 6.8–6.14) ─────────────────────────
  // Inputs: V_Ed [kN], bw [m], d [m], z [m], fck [MPa], fyk [MPa],
  //         theta [deg]=angle of compression strut, alpha [deg]=90 (vertical links)
  // Returns: full shear check object
  function shearDesign(V_Ed, bw, d, fck, fyk, theta_deg = 36, NEd = 0, Ac = 0) {
    const d_  = d  * 1000;      // mm
    const bw_ = bw * 1000;      // mm
    const z   = 0.9 * d_;       // lever arm: 0.9d (EC2 simplification)
    const V   = V_Ed * 1000;    // kN→N

    const conc  = concreteMaterial(fck);

    const fywd = Math.min(fyk, 435) / γs;   // design yield strength of links (EC2 cap 435)
    const alpha = Math.PI / 2;               // vertical links
    const theta = (theta_deg * Math.PI) / 180;

    // Check strut angle limits: 21.8° ≤ θ ≤ 45°
    const thetaClamped = Math.max(21.8 * Math.PI / 180, Math.min(45 * Math.PI / 180, theta));
    const cotTheta = 1 / Math.tan(thetaClamped);

    // VRd,c (without shear reinforcement)
    const vRdcResult = VRdc(d, 0, bw, fck, NEd, Ac);
    const VRdc_N     = vRdcResult.VRdc * 1000;

    // Strength reduction factor
    const ν = conc.ν;
    const αcw = 1.0;   // non-prestressed

    // VRd,max (max compression strut capacity) Eq. 6.9
    const VRdmax_N = αcw * bw_ * z * ν * conc.fcd * (cotTheta + 1/Math.tan(alpha)) /
                     (1 + cotTheta * cotTheta);

    // Required Asw/s (stirrup area per mm of length) Eq. 6.8 rearranged
    const Asw_s = V / (z * fywd * cotTheta);  // mm²/mm

    // VRd,s for given Asw/s Eq. 6.8
    const VRds_N = Asw_s * z * fywd * cotTheta;

    // Minimum Asw/s (EC2 9.2.2)
    const ρw_min  = 0.08 * Math.sqrt(fck) / fyk;
    const Asw_s_min = ρw_min * bw_;

    const Asw_s_design = Math.max(Asw_s, Asw_s_min);

    // Common stirrup spacings and their areas
    const linkSuggestions = suggestLinks(Asw_s_design, bw_);

    const noShearReinf = V <= VRdc_N;

    return {
      check:    'Shear Design (EC2 6.2)',
      V_Ed:     +V_Ed.toFixed(3),
      VRdc:     +(VRdc_N / 1000).toFixed(3),
      VRdmax:   +(VRdmax_N / 1000).toFixed(3),
      VRds:     +(VRds_N / 1000).toFixed(3),
      Asw_s:    +Asw_s.toFixed(4),
      Asw_s_min: +Asw_s_min.toFixed(4),
      Asw_s_design: +Asw_s_design.toFixed(4),
      theta_deg: theta_deg,
      cot_theta: +cotTheta.toFixed(3),
      z_mm:     +z.toFixed(1),
      fywd:     +fywd.toFixed(2),
      rho_w_min: +ρw_min.toFixed(6),
      linkSuggestions,
      noShearReinfRequired: noShearReinf,
      strut_ok: V <= VRdmax_N,
      eta:      +Math.min(V / VRdmax_N, 3).toFixed(4),
      pass:     V <= VRdmax_N,
      status:   noShearReinf ? 'OK (no links needed)' : (V <= VRdmax_N ? 'LINKS REQ.' : 'FAIL (strut)'),
      note: noShearReinf
        ? `No shear reinforcement required (V_Ed=${V_Ed.toFixed(2)} ≤ VRdc=${(VRdc_N/1000).toFixed(2)} kN). Provide minimum Asw/s=${Asw_s_min.toFixed(3)} mm²/mm.`
        : `Provide Asw/s ≥ ${Asw_s_design.toFixed(3)} mm²/mm. ${linkSuggestions[0]?.desc || ''}`
    };
  }

  // Suggest practical stirrup arrangements
  function suggestLinks(Asw_s_req, bw_mm) {
    // Standard bar diameters and areas (2-leg links)
    const bars = [
      { dia: 6,  Asw2: 2 * Math.PI * 9  },   // 2×π×3²
      { dia: 8,  Asw2: 2 * Math.PI * 16 },
      { dia: 10, Asw2: 2 * Math.PI * 25 },
      { dia: 12, Asw2: 2 * Math.PI * 36 },
      { dia: 16, Asw2: 2 * Math.PI * 64 }
    ];
    const suggestions = [];
    for (const b of bars) {
      const spacing = Math.floor(b.Asw2 / Asw_s_req / 25) * 25;   // round down to 25mm
      const s = Math.min(spacing, Math.floor(0.75 * bw_mm / 25) * 25, 300);
      if (s >= 50) {
        suggestions.push({
          dia:     b.dia,
          spacing: s,
          Asw_s_prov: +(b.Asw2 / s).toFixed(3),
          desc:    `T${b.dia}@${s}mm (Asw/s=${(b.Asw2/s).toFixed(2)} mm²/mm)`
        });
        if (suggestions.length >= 3) break;
      }
    }
    return suggestions;
  }

  // ── CRACK WIDTH CALCULATION (EC2 7.3, Eq. 7.8/7.9/7.11) ──────────────────
  // Inputs: sigma_s [MPa] steel stress at SLS, As [mm²], b [m], d [m], h [m],
  //         fck [MPa], Es [MPa], c [mm] cover, phi [mm] bar dia, kt (0.4 long, 0.6 short)
  function crackWidth(sigma_s, As, b, d, h, fck, fyk, c = 35, phi = 16, kt = 0.4) {
    const b_ = b * 1000, d_ = d * 1000, h_ = h * 1000;  // m→mm
    const conc  = concreteMaterial(fck);
    const steel = steelMaterial(fyk);
    const Es = steel.Es;
    const αe = Es / conc.Ecm;     // modular ratio

    // Effective concrete tension zone depth (EC2 7.3.2)
    // neutral axis depth (simplified elastic, uncracked):
    const x = (αe * As * (h_ - d_) + b_ * h_ * h_ / 2) / (αe * As + b_ * h_);
    const hc_eff = Math.min(2.5 * (h_ - d_), (h_ - x) / 3, h_ / 2);
    const Ac_eff = b_ * hc_eff;

    // Effective reinforcement ratio Eq. 7.10
    const rho_p_eff = As / Ac_eff;

    // Strain difference Eq. 7.9
    const fct_eff = conc.fctm;
    const eps_sm_ecm = Math.max(
      (sigma_s - kt * fct_eff * (1 + αe * rho_p_eff) / rho_p_eff) / Es,
      0.6 * sigma_s / Es
    );

    // Maximum crack spacing (EC2 7.3.4, Eq. 7.11)
    // k1=0.8 (high bond), k2=0.5 (bending), k3=3.4, k4=0.425
    const k1 = 0.8, k2 = 0.5, k3 = 3.4, k4 = 0.425;
    const sr_max = k3 * c + k1 * k2 * k4 * phi / rho_p_eff;

    // Crack width Eq. 7.8
    const wk = sr_max * eps_sm_ecm;

    // Allowable wk from EC2 Table 7.1N (XC1/XC2 as default)
    const wk_lim = 0.3;   // mm (quasi-permanent, XC2)

    return {
      check:       'Crack Width (EC2 7.3)',
      sigma_s:     +sigma_s.toFixed(2),
      rho_p_eff:   +rho_p_eff.toFixed(6),
      hc_eff_mm:   +hc_eff.toFixed(2),
      Ac_eff_mm2:  +Ac_eff.toFixed(1),
      alpha_e:     +αe.toFixed(3),
      eps_sm_ecm:  +eps_sm_ecm.toFixed(6),
      sr_max_mm:   +sr_max.toFixed(2),
      wk_mm:       +wk.toFixed(4),
      wk_lim_mm:   wk_lim,
      pass:        wk <= wk_lim,
      status:      wk <= wk_lim ? 'OK' : 'FAIL',
      eta:         +(wk / wk_lim).toFixed(4),
      note: `wk = ${wk.toFixed(3)} mm ${wk <= wk_lim ? '≤' : '>'} ${wk_lim} mm limit (XC2, quasi-permanent)`
    };
  }

  // ── DEFLECTION CHECK — simplified span/depth ratio (EC2 7.4) ──────────────
  function deflectionSpanDepth(l_eff, d, fck, fyk, As_prov, As_req, rho, beamType = 'simply-supported') {
    // Reference reinforcement ratio ρ₀ = √fck × 10⁻³
    const rho0 = Math.sqrt(fck) * 1e-3;
    // Modification factor for steel stress (EC2 7.4.2)
    const fyd_ref   = 310;   // reference fyk (≈ fyk/γs for fyk=355, simplified)
    const Ksteel    = Math.min(fyd_ref * As_req / (fyk / γs * As_prov), 1.5);

    // Base l/d ratio (EC2 Table 7.4N)
    const BASE = {
      'simply-supported':   20,
      'one-end-continuous': 26,
      'both-ends-continuous': 30,
      'cantilever':         8,
      'flat-slab':          24
    };
    let K_base = BASE[beamType] || 20;

    // Refined limit (EC2 Eq. 7.16/7.17)
    let ld_limit;
    if (rho <= rho0) {
      ld_limit = K_base * (11 + 1.5 * Math.sqrt(fck) * rho0 / rho +
                 3.2 * Math.sqrt(fck) * Math.pow(rho0 / rho - 1, 1.5));
    } else {
      ld_limit = K_base * (11 + 1.5 * Math.sqrt(fck) * rho0 / (rho - rho0) +
                 Math.sqrt(fck) / 12 * Math.sqrt(rho / rho0));
    }
    ld_limit *= Ksteel;   // apply steel modification factor

    const l_d_actual = (l_eff * 1000) / (d * 1000);
    return {
      check:      'Deflection (EC2 7.4 — l/d method)',
      l_eff_m:    +l_eff.toFixed(3),
      d_mm:       +(d * 1000).toFixed(1),
      l_d_actual: +l_d_actual.toFixed(2),
      l_d_limit:  +ld_limit.toFixed(2),
      rho:        +rho.toFixed(6),
      rho0:       +rho0.toFixed(6),
      K_base,
      K_steel:    +Ksteel.toFixed(4),
      beamType,
      pass:       Number.isFinite(ld_limit) ? l_d_actual <= ld_limit : true,
      status:     !Number.isFinite(ld_limit) ? 'INFO'
                  : l_d_actual <= ld_limit ? 'OK' : 'FAIL',
      eta:        Number.isFinite(ld_limit) && ld_limit > 0
                  ? +(l_d_actual / ld_limit).toFixed(4) : null,
      note:       Number.isFinite(ld_limit)
                  ? `l/d = ${l_d_actual.toFixed(1)} ${l_d_actual <= ld_limit ? '≤' : '>'} ${ld_limit.toFixed(1)} (limit)`
                  : 'No tension reinforcement to base a span/depth limit on — ' +
                    'EC2 7.4.2 does not apply to this member.'
    };
  }

  // ── FULL RC BEAM/COLUMN CHECK (calls all above) ────────────────────────────
  // sec: section object from app  { A, I, fy(=fck for RC), E(=Ec GPa), d, bf, tf, tw }
  // ef:  element force object     { M1, M2, V1, V2, N1, N2, L }
  // Returns: array of check results
  function runRCChecks(ef, sec, options = {}) {
    // The caller resolves this: `sec.fy` doubles as f'c on some concrete
    // sections and is a 420 MPa rebar grade on others, and reading it blind
    // designed those members to 420 MPa concrete — which collapses the N-M
    // envelope below into negative capacities. Only fall back to the section
    // when no caller supplied one, and never above the range EC2 covers.
    const fck  = Math.min(options.fck || sec.fck || sec.fy || 30, 100);   // MPa
    const fyk  = options.fyk || 500;          // MPa rebar yield
    const b    = options.b  || (sec.bf ? sec.bf / 1000 : 0.3);  // m (width)
    const h    = options.h  || (sec.d  ? sec.d  / 1000 : 0.6);  // m (total depth)
    const c    = options.cover || 35;         // mm cover
    const phi  = options.phi   || 16;         // mm main bar diameter
    const phi_l = options.phi_l || 8;         // mm link diameter
    const As   = options.As  || 0;            // mm² provided (if known)

    // Effective depth
    const d    = h - c / 1000 - phi_l / 1000 - phi / 2000;  // m

    // Peak forces
    const M_Ed = Math.max(Math.abs(ef.M1), Math.abs(ef.M2));
    const V_Ed = Math.max(Math.abs(ef.V1), Math.abs(ef.V2));
    // Compression-positive, matching solveFrame (a column under gravity returns
    // +N; see the convention note in pdelta.js). This negated it, so N_Ed was 0
    // for every compressed member and the axial benefit to shear resistance was
    // never credited.
    const N_Ed = Math.max(0, ef.N1 || 0, ef.N2 || 0);   // kN compression

    const checks = [];

    // 1. Bending
    const bnd = bendingReinforcement(M_Ed, b, d, fck, fyk);
    checks.push(bnd);

    // 2. Shear
    // NEd travels in kN all the way down: shearDesign hands it to VRdc, which
    // forms σcp = NEd·1000/Ac_mm². This divided by 1000 first, so σcp came out a
    // thousand times too small and the axial contribution to VRd,c was
    // effectively zero. It went unnoticed while N_Ed was itself always 0.
    const shr = shearDesign(V_Ed, b, d, fck, fyk, options.theta || 36, N_Ed, b * h);
    checks.push(shr);

    // 3. Crack width (SLS: use ~60% of ULS moment as quasi-permanent)
    const sigma_s_sls = bnd.As_design > 0
      ? (M_Ed * 0.6 * 1e6) / (bnd.As_design * bnd.z_mm / 1000 * 1e6) * 1e3
      : 0;   // approximate SLS steel stress
    if (sigma_s_sls > 0 && bnd.As_design > 0) {
      const crk = crackWidth(sigma_s_sls, bnd.As_design, b, d, h, fck, fyk, c, phi);
      checks.push(crk);
    }

    // 4. Span/depth (deflection) — beams and slabs only, per EC2 7.4.2.
    if (options.memberType !== 'column') {
      const rho_prov = bnd.As_design / (b * 1000 * d * 1000);
      const defl = deflectionSpanDepth(ef.L, d, fck, fyk,
        Math.max(As, bnd.As_design), bnd.As_req, rho_prov,
        options.beamType || 'simply-supported');
      checks.push(defl);
    }

    // 5. Column axial capacity + slenderness.
    //
    // runRCChecks ran the BEAM checks on every RC member and never called
    // columnDesign at all, so a concrete column under EC2 was reported on as if
    // it carried no axial load — bending, shear and span/depth only, with the
    // 900 kN sitting in the model and nothing looking at it. The ACI path has
    // always branched on member type; this brings EC2 into line.
    if (options.memberType === 'column' && N_Ed > 0) {
      const l0 = options.l0 || ef.L || h * 10;   // effective height (m)
      const colScreen = columnDesign(N_Ed, M_Ed, b, h, fck, fyk, l0, c, phi);
      checks.push(colScreen);

      // ── N-M interaction ────────────────────────────────────────────────
      // The screen above only compares N against the squash load. This checks
      // the actual (N, M) pair against the section's envelope, which is what
      // decides whether a column works. As comes from the same As,min the
      // screen sizes unless the caller supplies a real bar layout, so the two
      // checks describe the same section.
      const As_col = options.As_col > 0 ? options.As_col
                   : (colScreen.As_min_mm2 > 0 ? colScreen.As_min_mm2 : 0.01 * b * h * 1e6);
      checks.push(columnPMCheck(N_Ed, M_Ed, b, h, fck, fyk, As_col, c, phi));
    }

    return checks;
  }

  // ── COLUMN DESIGN (EC2 simplified) ────────────────────────────────────────
  //
  // Scope: an AXIAL CAPACITY and SLENDERNESS screen. It is deliberately not a
  // P-M interaction — NRd,0 below is the squash load — so it must be read
  // alongside the bending check that runRCChecks performs on the same member,
  // and the note says so. Anyone needing a true interaction diagram should use
  // the ACI path, which builds one.
  function columnDesign(N_Ed, M_Ed, b, h, fck, fyk, l0, c = 35, phi = 20) {
    // b, h in m; N_Ed kN; M_Ed kNm; l0 effective height m
    const conc  = concreteMaterial(fck);
    const steel = steelMaterial(fyk);
    const Ac    = b * h * 1e6;   // mm²
    const ic    = Math.sqrt(h * h / 12);        // radius of gyration (m)
    const λ     = l0 / ic;                       // slenderness ratio

    // EC2 5.8.3.1:  λlim = 20·A·B·C / √n   with  n = N_Ed / (Ac·fcd).
    // The A·B·C product was missing — the code used a bare 20/√n, which is
    // 1/(0.7·1.1·0.7) ≈ 1.86x too permissive, so columns that genuinely need a
    // second-order check were reported as short. A, B and C take their EC2
    // recommended values here (φef, ω and rm are not tracked by the model).
    const A_f = 0.7, B_f = 1.1, C_f = 0.7;
    const n_rel = N_Ed * 1000 / (conc.fcd * Ac);
    const λ_lim = n_rel > 1e-9
      ? 20 * A_f * B_f * C_f / Math.sqrt(n_rel)
      : Infinity;   // no axial load — slenderness is not the governing concern

    // NRd for given As,min
    const As_min = Math.max(0.10 * N_Ed * 1000 / steel.fyd, 0.002 * Ac);  // mm²
    const As_max = 0.04 * Ac;  // mm²

    const NRd_0   = conc.fcd * Ac + steel.fyd * As_min;  // N

    const slender = λ > λ_lim;
    const eta_N   = NRd_0 > 0 ? N_Ed * 1000 / NRd_0 : 0;
    const axOK    = N_Ed * 1000 <= NRd_0;

    const slendNote = !isFinite(λ_lim)
      ? `λ=${λ.toFixed(1)}; no axial load, slenderness check not applicable`
      : slender
        ? `λ=${λ.toFixed(1)} > λ_lim=${λ_lim.toFixed(1)}: second-order effects required (EC2 5.8)`
        : `λ=${λ.toFixed(1)} ≤ λ_lim=${λ_lim.toFixed(1)}: short column`;

    return {
      check:     'Column — Axial & Slenderness (EC2 5.8)',
      N_Ed:      +N_Ed.toFixed(3),
      M_Ed:      +M_Ed.toFixed(3),
      fcd:       +conc.fcd.toFixed(2),
      fyd:       +steel.fyd.toFixed(2),
      lambda:    +λ.toFixed(2),
      lambda_lim: isFinite(λ_lim) ? +λ_lim.toFixed(2) : null,
      n_rel:     +n_rel.toFixed(4),
      slender,
      As_min_mm2: +As_min.toFixed(1),
      As_max_mm2: +As_max.toFixed(1),
      NRd_kN:    +(NRd_0 / 1000).toFixed(2),
      eta_N:     +eta_N.toFixed(4),
      // Participates in the member's utilisation like every other check.
      eta:       +eta_N.toFixed(4),
      pass:      axOK,
      status:    !axOK ? 'FAIL' : slender ? 'WARN (slender—2nd order)' : 'OK',
      note: `${slendNote}  |  Axial screen only: NRd,0 is the squash load and ` +
            `carries no moment — read with the bending check on the same member.`
    };
  }

  // ── Utility: is section RC? ────────────────────────────────────────────────
  function isRC(sec) {
    return (sec._type === 'RC') ||
           (sec.name && /rc|concrete|beton/i.test(sec.name)) ||
           (sec.E && sec.E < 50);   // Ecm for concrete typically 25-35 GPa
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  COLUMN N-M INTERACTION  (EC2 EN 1992-1-1 §6.1)
  //
  //  columnDesign() above is an axial + slenderness screen: NRd,0 is the squash
  //  load and carries no moment, so it cannot say whether a column with both N
  //  and M is adequate. The ACI path has built a strain-compatibility diagram
  //  for a long time; this is the EC2 equivalent, so both codes now answer the
  //  same question.
  //
  //  Method — §6.1 with the rectangular stress block of §3.1.7(3):
  //    • plane sections, concrete crushing at eps_cu2 on the compressed face
  //    • concrete stress eta*fcd uniform over a depth lambda*x, no tension
  //    • bilinear steel, capped at fyd either way
  //  Sweeping the neutral-axis depth traces the envelope from pure tension,
  //  through the balanced point, to pure compression.
  //
  //  Reinforcement is taken as SYMMETRIC — As/2 at each face — which is the
  //  usual column arrangement and matches the As that columnDesign sizes.
  //
  //  b, h    : section width and depth  [m]
  //  As_mm2  : TOTAL longitudinal steel area [mm2]
  //  Returns { points: [{N_kN, M_kNm}] sorted by N, NRd_max, NRd_min }
  // ══════════════════════════════════════════════════════════════════════════
  function columnInteraction(b, h, fck, fyk, As_mm2, cover = 35, phi = 20, nPts = 80) {
    const conc  = concreteMaterial(fck);
    const steel = steelMaterial(fyk);
    const le    = lambdaEta(fck);
    const lam   = le['\u03bb'], eta_ = le['\u03b7'];

    const b_mm = b * 1000, h_mm = h * 1000;
    const As2  = Math.max(0, As_mm2) / 2;           // each face
    const d2   = cover + phi / 2;                    // bar centroid from a face
    const layers = [{ d: d2, As: As2 }, { d: h_mm - d2, As: As2 }];

    const sigS = eps => Math.max(-steel.fyd, Math.min(steel.fyd, steel.Es * eps));

    // One point on the envelope for a given neutral-axis depth x.
    function at(x_mm) {
      const a  = Math.max(0, Math.min(lam * x_mm, h_mm));
      const Cc = eta_ * conc.fcd * b_mm * a;                    // N, acting at a/2
      let N = Cc, M = Cc * (h_mm / 2 - a / 2);
      for (const L of layers) {
        const eps = conc.eps_cu2 * (x_mm - L.d) / x_mm;         // compression positive
        const F   = L.As * sigS(eps);
        N += F;
        M += F * (h_mm / 2 - L.d);
      }
      return { N_kN: N / 1000, M_kNm: Math.abs(M) / 1e6 };
    }

    // The sweep stops where the stress block just fills the section (a = h).
    // Past that the block cannot deepen, and EC2 pivots a fully compressed
    // section about eps_c2 rather than eps_cu2 — running the eps_cu2 sweep on
    // out would overshoot the true squash load.
    const xFull = h_mm / lam;
    const pts = [{ N_kN: -2 * As2 * steel.fyd / 1000, M_kNm: 0 }];   // pure tension
    for (let i = 1; i <= nPts; i++) pts.push(at((i / nPts) * xFull));

    // Pure compression: uniform eps_c2 over the whole section (§3.1.7).
    const NRd_max = (eta_ * conc.fcd * b_mm * h_mm + 2 * As2 * sigS(conc.eps_c2)) / 1000;
    pts.push({ N_kN: NRd_max, M_kNm: 0 });

    // Keep the envelope single-valued and ordered in N so M_Rd(N) is a lookup.
    pts.sort((p, q) => p.N_kN - q.N_kN);

    return { points: pts, NRd_max, NRd_min: -2 * As2 * steel.fyd / 1000,
             lambda: lam, eta: eta_, d2_mm: d2 };
  }

  // ── Check a demand against that envelope ──────────────────────────────────
  //  The moment capacity is read at the APPLIED axial load — the question an
  //  engineer asks of a P-M chart — and the utilisation is M_Ed / M_Rd(N_Ed).
  //  An axial load outside [NRd,min, NRd,max] fails on axial alone, so the
  //  reported utilisation takes the worse of the two ratios.
  function columnPMCheck(N_Ed, M_Ed, b, h, fck, fyk, As_mm2, cover = 35, phi = 20) {
    const dia = columnInteraction(b, h, fck, fyk, As_mm2, cover, phi);
    const P   = dia.points;
    const M   = Math.abs(M_Ed);

    // M_Rd at the applied N, by linear interpolation along the envelope.
    let MRd = 0;
    if (N_Ed <= P[0].N_kN)               MRd = P[0].M_kNm;
    else if (N_Ed >= P[P.length - 1].N_kN) MRd = P[P.length - 1].M_kNm;
    else {
      for (let i = 0; i < P.length - 1; i++) {
        const p = P[i], q = P[i + 1];
        if (N_Ed >= p.N_kN && N_Ed <= q.N_kN) {
          const span = q.N_kN - p.N_kN;
          const t = span > 1e-12 ? (N_Ed - p.N_kN) / span : 0;
          MRd = p.M_kNm + t * (q.M_kNm - p.M_kNm);
          break;
        }
      }
    }

    const axialOver = N_Ed > dia.NRd_max ? N_Ed / dia.NRd_max
                    : N_Ed < dia.NRd_min ? N_Ed / dia.NRd_min
                    : 0;
    const etaM = MRd > 1e-9 ? M / MRd : (M > 1e-9 ? 9 : 0);
    const eta  = Math.min(9, Math.max(etaM, axialOver));
    const pass = eta <= 1.0;

    // The balanced point is where the envelope peaks — useful context on a chart.
    const bal = P.reduce((a, p) => (p.M_kNm > a.M_kNm ? p : a), P[0]);

    return {
      check:      'Column N-M Interaction (EC2 6.1)',
      N_Ed:       +N_Ed.toFixed(3),
      M_Ed:       +M.toFixed(3),
      MRd_at_N:   +MRd.toFixed(2),
      NRd_max:    +dia.NRd_max.toFixed(2),
      NRd_min:    +dia.NRd_min.toFixed(2),
      N_balanced: +bal.N_kN.toFixed(2),
      M_balanced: +bal.M_kNm.toFixed(2),
      As_mm2:     +As_mm2.toFixed(0),
      e_mm:       Math.abs(N_Ed) > 1e-6 ? +(M_Ed / N_Ed * 1000).toFixed(1) : null,
      eta:        +eta.toFixed(4),
      pass,
      status:     !pass ? 'FAIL' : eta > 0.80 ? 'NEAR' : 'OK',
      points:     P,
      note: axialOver > 1
        ? `N_Ed = ${N_Ed.toFixed(0)} kN is outside the axial range ` +
          `[${dia.NRd_min.toFixed(0)}, ${dia.NRd_max.toFixed(0)}] kN.`
        : `M_Rd = ${MRd.toFixed(1)} kNm at N_Ed = ${N_Ed.toFixed(0)} kN ` +
          `(eta = ${eta.toFixed(3)}). Symmetric reinforcement, As = ${As_mm2.toFixed(0)} mm2.`
    };
  }


  // Public API
  return {
    concreteMaterial,
    steelMaterial,
    lambdaEta,        // EC2 3.1.7 stress-block factors (λ, η) — for fck > 50 MPa
    bendingReinforcement,
    VRdc,
    shearDesign,
    crackWidth,
    deflectionSpanDepth,
    columnDesign,
    columnInteraction,   // EC2 6.1 N-M envelope (strain compatibility)
    columnPMCheck,       // demand vs that envelope at constant eccentricity
    runRCChecks,
    suggestLinks,
    isRC,
    // constants
    γc, γs, αcc
  };

})();

window.RCDesign = RCDesign;
