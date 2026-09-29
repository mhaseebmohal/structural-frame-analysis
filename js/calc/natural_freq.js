// ══════════════════════════════════════════════════════════════════════════════
//  natural_freq.js  —  Natural Frequency & Modal Analysis Calculator
//
//  Two modes:
//  1. Single-beam analytical — closed-form fn for common BC combos
//  2. Global Rayleigh quotient — uses assembled K from last solve, lumped masses
//
//  Ref: Clough & Penzien; Chopra "Dynamics of Structures"; Blevins "Formulas
//       for Natural Frequency and Mode Shape"
//  Units: E[GPa], I[cm⁴], A[cm²], L[m], ρ[kN/m³], mass[tonne=kN·s²/m]
//         fn[Hz], ω[rad/s]
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const NaturalFreq = (() => {

  // ── Beam boundary condition coefficients (β·L)² for first 3 modes ─────────
  //  fn = (βn·L)² / (2π·L²) · √(EI / (ρA))
  const BC_COEFF = {
    'SS':    { label:'Simply supported',          bl: [9.8696, 39.478, 88.826]  },  // (nπ)²
    'CC':    { label:'Fixed–Fixed',               bl: [22.373, 61.673, 120.903] },
    'CF':    { label:'Cantilever (Fixed–Free)',   bl: [3.5160, 22.034, 61.697]  },
    'CS':    { label:'Fixed–Pinned',              bl: [15.418, 49.965, 104.248] },
    'FF':    { label:'Free–Free',                 bl: [22.373, 61.673, 120.903] },
    'GG':    { label:'Guided–Guided',             bl: [9.8696, 39.478, 88.826]  },
  };

  // ── Single beam — analytical ───────────────────────────────────────────────
  // E [GPa], I [cm⁴], A [cm²], L [m], rho [kN/m³]
  // Returns { fn_hz: [f1,f2,f3], omega: [ω1,ω2,ω3], Tn: [T1,T2,T3] }
  function beamFrequencies(E_GPa, I_cm4, A_cm2, L_m, rho_kNm3, bc = 'SS') {
    const coeff = BC_COEFF[bc];
    if (!coeff) return null;

    // Bending stiffness  EI  [kN·m²]  (GPa→kN/m² · cm⁴→m⁴)
    const EI = BeamFormulas.calcEI(E_GPa, I_cm4);

    // Linear mass density  m = ρ·A  [kN/m] → [tonne/m = kN·s²/m²]
    // ρ [kN/m³] · A [cm²] = kN/m·100² → /100² gives kN/m... then ÷g for mass
    // γ = ρ in kN/m³, A in cm² = 1e-4 m²
    // m_dist = γ·A / g  [tonne/m]  (g = 9.81 m/s²)
    const g = 9.81;
    const m_dist = (rho_kNm3 * A_cm2 * 1e-4) / g;   // kN·s²/m² = tonne/m

    if (m_dist < 1e-12 || EI < 1e-12 || L_m < 0.01) return null;

    // fn = (βnL)² / (2π L²) · √(EI/m)
    // Where EI [kN·m²], m [tonne/m] = kN·s²/m²
    // √(EI/m) has units √(kN·m²/(kN·s²/m)) = √(m³/s²) = m^1.5/s
    // (βnL)²/L² is 1/m², so whole thing = 1/s = Hz ... let's verify:
    // ω² = (βnL)⁴·EI/(m·L⁴) → ω = (βnL)²√(EI/(mL⁴))
    const results = coeff.bl.map(bl2 => {
      const omega = (bl2 / (L_m * L_m)) * Math.sqrt(EI / m_dist);
      const fn    = omega / (2 * Math.PI);
      const Tn    = 1 / fn;
      return { omega: +omega.toFixed(4), fn: +fn.toFixed(4), Tn: +Tn.toFixed(4) };
    });

    return {
      bc: coeff.label,
      EI: +EI.toFixed(2),
      m_dist: +m_dist.toFixed(6),
      modes: results
    };
  }

  // ── Single DOF — spring-mass ───────────────────────────────────────────────
  // K [kN/m], mass [tonne]
  function sdofFrequency(K_kNm, mass_t) {
    if (K_kNm <= 0 || mass_t <= 0) return null;
    const omega = Math.sqrt(K_kNm / mass_t);   // √(kN/m / tonne) = √(1/s²) = rad/s
    const fn    = omega / (2 * Math.PI);
    return { omega: +omega.toFixed(4), fn: +fn.toFixed(4), Tn: +(1/fn).toFixed(4) };
  }

  // ── Rayleigh quotient (global) ─────────────────────────────────────────────
  // Given stiffness matrix K, mass matrix M, trial vector φ
  // ω² ≈ φᵀKφ / φᵀMφ
  // Approximation only — useful for fundamental mode estimate
  function rayleighQuotient(K, M_diag, phi) {
    const n = phi.length;
    let Kq = 0, Mq = 0;
    for (let i = 0; i < n; i++) {
      let Krow = 0;
      for (let j = 0; j < n; j++) Krow += K[i][j] * phi[j];
      Kq += phi[i] * Krow;
      Mq += phi[i] * M_diag[i] * phi[i];
    }
    if (Mq < 1e-20) return null;
    const omega2 = Kq / Mq;
    const omega  = Math.sqrt(Math.abs(omega2));
    const fn     = omega / (2 * Math.PI);
    return { omega: +omega.toFixed(4), fn: +fn.toFixed(4), Tn: +(1/fn).toFixed(4) };
  }

  // ── Build dialog HTML ──────────────────────────────────────────────────────
  function buildDialogHTML() {
    const bcOptions = Object.entries(BC_COEFF)
      .map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');

    return `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">

  <!-- ── Single beam ── -->
  <div style="border:1px solid var(--border-tbl);border-radius:6px;padding:10px">
    <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:8px">&#9135; Single Beam — Analytical</div>
    <div class="form-row"><label style="width:120px">E [GPa]</label><input type="number" id="nf-E" value="210" step="10" min="0.1" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">I [cm⁴]</label><input type="number" id="nf-I" value="8356" step="100" min="0.01" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">A [cm²]</label><input type="number" id="nf-A" value="53.8" step="1" min="0.01" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">L [m]</label><input type="number" id="nf-L" value="5" step="0.5" min="0.1" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">ρ [kN/m³]</label><input type="number" id="nf-rho" value="78.5" step="0.5" min="0.1" style="width:80px"></div>
    <div class="form-row">
      <label style="width:120px">Boundary cond.</label>
      <select id="nf-bc" style="flex:1;font-size:11px;padding:3px 5px">${bcOptions}</select>
    </div>
    <button class="btn-xs btn-blue" id="nf-calc-beam" style="margin-top:6px">&#9654; Calculate</button>
    <div id="nf-beam-results" style="margin-top:8px;font-size:11px"></div>
  </div>

  <!-- ── Single DOF ── -->
  <div style="border:1px solid var(--border-tbl);border-radius:6px;padding:10px">
    <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:8px">&#9675; SDOF — Spring-Mass</div>
    <div class="form-row"><label style="width:120px">Stiffness K [kN/m]</label><input type="number" id="nf-K" value="5000" step="100" min="1" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">Mass m [tonne]</label><input type="number" id="nf-m" value="2.5" step="0.5" min="0.01" style="width:80px"></div>
    <button class="btn-xs btn-blue" id="nf-calc-sdof" style="margin-top:6px">&#9654; Calculate</button>
    <div id="nf-sdof-results" style="margin-top:8px;font-size:11px"></div>

    <hr style="margin:12px 0;border-color:var(--border-tbl)">

    <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:8px">&#128200; Period / Frequency Converter</div>
    <div class="form-row"><label style="width:120px">f [Hz]</label><input type="number" id="nf-conv-f" value="" step="0.01" placeholder="enter f or T" style="width:80px"></div>
    <div class="form-row"><label style="width:120px">T [s]</label><input type="number" id="nf-conv-T" value="" step="0.01" placeholder="enter f or T" style="width:80px"></div>
    <div id="nf-conv-results" style="margin-top:6px;font-size:11px;color:var(--text-sec)">Fill in either field.</div>
  </div>

</div>

<!-- ── Mode shape diagram ── -->
<div id="nf-modeshape" style="margin-top:10px"></div>

<div style="margin-top:8px;padding:8px;background:var(--bg-tbl-alt);border-radius:5px;font-size:10px;color:var(--text-sec);border:1px solid var(--border-tbl)">
  <b>Formula:</b> ωₙ = (βₙL)²·√(EI/m̄)/L² where m̄ = ρA/g [tonne/m].
  (βₙL)² depends on boundary conditions: SS→(nπ)², Cantilever→3.516,22.03,61.7 (first 3 modes).
</div>`;
  }

  // ── Mode shape SVG for beam ────────────────────────────────────────────────
  function buildModeShapeSVG(bc, modes, W = 660, H = 120) {
    const n = Math.min(modes.length, 3);
    const segW = W / n;
    const L = [];

    for (let m = 0; m < n; m++) {
      const ox = m * segW + 10;
      const ow = segW - 20;
      const oy = H / 2;
      const amp = H * 0.35;

      // Beam axis
      L.push(`<line x1="${ox}" y1="${oy}" x2="${ox+ow}" y2="${oy}" stroke="#ccc" stroke-width="1.5"/>`);

      // Mode shape (sine wave approximation)
      const nHalfWaves = m + 1;
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const t  = i / 40;
        const x  = ox + t * ow;
        const y  = oy - amp * Math.sin(nHalfWaves * Math.PI * t);
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      L.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#1565C0" stroke-width="2"/>`);

      // Label
      L.push(`<text x="${ox+ow/2}" y="14" font-size="10" fill="#555" text-anchor="middle">Mode ${m+1}: f=${modes[m].fn} Hz</text>`);
      L.push(`<text x="${ox+ow/2}" y="26" font-size="9" fill="#888" text-anchor="middle">T=${modes[m].Tn} s</text>`);
    }

    return `<div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">Mode Shapes (schematic)</div>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:var(--bg-tbl-alt,#f5f5f5);border-radius:5px;display:block">${L.join('')}</svg>`;
  }

  // ── Wire dialog ────────────────────────────────────────────────────────────
  function wireDialog() {

    // Single beam
    document.getElementById('nf-calc-beam').addEventListener('click', () => {
      const E   = parseFloat(document.getElementById('nf-E').value)   || 210;
      const I   = parseFloat(document.getElementById('nf-I').value)   || 8356;
      const A   = parseFloat(document.getElementById('nf-A').value)   || 53.8;
      const L   = parseFloat(document.getElementById('nf-L').value)   || 5;
      const rho = parseFloat(document.getElementById('nf-rho').value) || 78.5;
      const bc  = document.getElementById('nf-bc').value;

      const res = beamFrequencies(E, I, A, L, rho, bc);
      const el  = document.getElementById('nf-beam-results');

      if (!res) { el.innerHTML = `<p style="color:red">Invalid inputs.</p>`; return; }

      const modeRows = res.modes.map((md, i) =>
        `<tr style="${i%2?'background:var(--bg-tbl-alt)':''}">
          <td style="padding:3px 6px">Mode ${i+1}</td>
          <td style="padding:3px 6px;font-weight:700">${md.fn.toFixed(4)} Hz</td>
          <td style="padding:3px 6px">${md.Tn.toFixed(4)} s</td>
          <td style="padding:3px 6px">${md.omega.toFixed(4)} rad/s</td>
        </tr>`).join('');

      el.innerHTML = `
<div style="font-size:10px;color:#888;margin-bottom:4px">
  EI=${res.EI} kN·m²&nbsp; m̄=${res.m_dist.toFixed(5)} t/m&nbsp; BC: ${res.bc}
</div>
<table style="border-collapse:collapse;width:100%;font-size:11px">
  <thead><tr style="background:var(--bg-tbl-alt)">
    <th style="padding:3px 6px;text-align:left">Mode</th>
    <th style="padding:3px 6px;text-align:left">f [Hz]</th>
    <th style="padding:3px 6px;text-align:left">T [s]</th>
    <th style="padding:3px 6px;text-align:left">ω [rad/s]</th>
  </tr></thead>
  <tbody>${modeRows}</tbody>
</table>`;

      document.getElementById('nf-modeshape').innerHTML =
        buildModeShapeSVG(bc, res.modes);
    });

    // SDOF
    document.getElementById('nf-calc-sdof').addEventListener('click', () => {
      const K = parseFloat(document.getElementById('nf-K').value) || 5000;
      const m = parseFloat(document.getElementById('nf-m').value) || 2.5;
      const r = sdofFrequency(K, m);
      const el = document.getElementById('nf-sdof-results');
      if (!r) { el.innerHTML = `<p style="color:red">Invalid K or m.</p>`; return; }
      el.innerHTML = `<table style="border-collapse:collapse;font-size:11px;width:100%">
        <tr><td style="padding:2px 4px;color:var(--text-sec)">ω</td><td style="font-weight:700;padding:2px 4px">${r.omega} rad/s</td></tr>
        <tr style="background:var(--bg-tbl-alt)"><td style="padding:2px 4px;color:var(--text-sec)">f</td><td style="font-weight:700;padding:2px 4px">${r.fn} Hz</td></tr>
        <tr><td style="padding:2px 4px;color:var(--text-sec)">T</td><td style="font-weight:700;padding:2px 4px">${r.Tn} s</td></tr>
      </table>`;
    });

    // Converter
    const convF = document.getElementById('nf-conv-f');
    const convT = document.getElementById('nf-conv-T');
    const convR = document.getElementById('nf-conv-results');
    convF.addEventListener('input', () => {
      const f = parseFloat(convF.value);
      if (f > 0) {
        const T = 1/f, w = 2*Math.PI*f;
        convT.value = T.toFixed(4);
        convR.innerHTML = `ω = ${w.toFixed(4)} rad/s &nbsp;|&nbsp; T = ${T.toFixed(4)} s`;
      }
    });
    convT.addEventListener('input', () => {
      const T = parseFloat(convT.value);
      if (T > 0) {
        const f = 1/T, w = 2*Math.PI*f;
        convF.value = f.toFixed(4);
        convR.innerHTML = `ω = ${w.toFixed(4)} rad/s &nbsp;|&nbsp; f = ${f.toFixed(4)} Hz`;
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    beamFrequencies,
    sdofFrequency,
    rayleighQuotient,
    BC_COEFF,
    buildDialogHTML,
    buildModeShapeSVG,
    wireDialog
  };
})();

window.NaturalFreq = NaturalFreq;
