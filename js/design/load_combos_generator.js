// ══════════════════════════════════════════════════════════════════════════════
//  load_combos_generator.js  —  Auto Load Combination Generator
//  Standards: EN 1990:2002 (EC0), ASCE 7-22, ACI 318-19
//  Inspired by: Wosad.Design (AISC/ASCE pattern) + structuralcodes (EC2)
//  Generates complete ULS/SLS/ASD combinations from load case types
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const LoadCombosGenerator = (() => {

  // ── EC0 Combination equations ──────────────────────────────────────────────
  // EN 1990 Table A1.2(B) — Design values, STR/GEO (persistent/transient)
  // Format: { name, eq, factors: { caseType: factor, ... }, ψ_table }

  const ψ0 = {  // EC0 Table A1.1 combination factor ψ₀
    LL: 0.7,   // Imposed (offices)
    SL: 0.5,   // Snow (H ≤ 1000m)
    WL: 0.6,   // Wind
    TL: 0.6,   // Thermal
    EQ: 0.0,   // Seismic (not combined with wind usually)
    OTHER: 0.7
  };
  const ψ1 = {  // frequent ψ₁
    LL: 0.5, SL: 0.2, WL: 0.2, TL: 0.5, EQ: 0.0, OTHER: 0.5
  };
  const ψ2 = {  // quasi-permanent ψ₂
    LL: 0.3, SL: 0.0, WL: 0.0, TL: 0.5, EQ: 0.3, OTHER: 0.3
  };

  // EC0 ULS STR (Eq. 6.10) — single equation version
  // γG·Gk + γQ·Qk,1 + Σ(γQ·ψ0,i·Qk,i)
  function generateEC0_ULS(loadCases) {
    const combos = [];
    const DL_cases = loadCases.filter(lc => lc.type === 'DL');
    const VAR_cases = loadCases.filter(lc => lc.type !== 'DL');

    // Need at least one permanent case
    if (DL_cases.length === 0) return combos;

    // EC0 Eq. 6.10 (simplified — single equation per variable case as leading)
    for (let lead = 0; lead < VAR_cases.length; lead++) {
      const leadCase = VAR_cases[lead];
      const name = `ULS-STR: 1.35DL + 1.5${leadCase.name}` +
        (VAR_cases.length > 1 ? ` + ψ₀·others` : '');

      const factors = {};
      DL_cases.forEach(lc => { factors[lc.id] = 1.35; });
      VAR_cases.forEach((lc, idx) => {
        factors[lc.id] = (idx === lead) ? 1.5 : 1.5 * (ψ0[lc.type] || 0.7);
      });
      combos.push({ name, type: 'ULS', code: 'EC0 Eq.6.10', factors });
    }

    // Also generate the unfavourable permanent-only case
    if (VAR_cases.length === 0) {
      const factors = {};
      DL_cases.forEach(lc => { factors[lc.id] = 1.35; });
      combos.push({ name: 'ULS-STR: 1.35DL (perm. only)', type: 'ULS', code: 'EC0 Eq.6.10', factors });
    }

    // EC0 Eq. 6.10a / 6.10b (alternative — when used, gives reduction for DL-dominated)
    for (let lead = 0; lead < VAR_cases.length; lead++) {
      const leadCase = VAR_cases[lead];
      const factors_a = {}, factors_b = {};
      DL_cases.forEach(lc => { factors_a[lc.id] = 1.35; factors_b[lc.id] = 1.35 * 0.85; });
      VAR_cases.forEach((lc, idx) => {
        factors_a[lc.id] = 1.5 * (ψ0[lc.type] || 0.7);
        factors_b[lc.id] = (idx === lead) ? 1.5 : 1.5 * (ψ0[lc.type] || 0.7);
      });
      combos.push({ name: `ULS-STR Eq.6.10a: 1.35DL + ψ₀·${leadCase.name}`, type: 'ULS', code: 'EC0 Eq.6.10a', factors: factors_a });
      combos.push({ name: `ULS-STR Eq.6.10b: 0.85·1.35DL + 1.5${leadCase.name}`, type: 'ULS', code: 'EC0 Eq.6.10b', factors: factors_b });
    }

    // EQU (equilibrium check) — different DL factors. One pair per lateral
    // case (WL or EQ) rather than lumped together: combining wind and seismic
    // in the same check overstates demand (see ψ0.EQ's note above — they are
    // not meant to combine), and the previous version only ever populated the
    // WL factor regardless of which case triggered the block. An EQ-only
    // model still passed the `WL || EQ` gate but matched nothing in the WL
    // filter, so factors_sup/inf carried DL alone while the combo was still
    // labelled "1.5WL" — a materially wrong, mislabeled equilibrium check
    // with the seismic load silently absent from its own factors.
    VAR_cases.filter(lc => lc.type === 'WL' || lc.type === 'EQ').forEach(lc => {
      const factors_sup = {}, factors_inf = {};
      DL_cases.forEach(d => { factors_sup[d.id] = 1.1; factors_inf[d.id] = 0.9; });
      factors_sup[lc.id] = 1.5; factors_inf[lc.id] = 1.5;
      combos.push({ name: `ULS-EQU: 1.1DL + 1.5${lc.name} (unfav.)`, type: 'ULS', code: 'EC0 EQU', factors: factors_sup });
      combos.push({ name: `ULS-EQU: 0.9DL + 1.5${lc.name} (fav.)`,   type: 'ULS', code: 'EC0 EQU', factors: factors_inf });
    });

    return combos;
  }

  // EC0 SLS Combinations
  function generateEC0_SLS(loadCases) {
    const combos = [];
    const DL_cases  = loadCases.filter(lc => lc.type === 'DL');
    const VAR_cases = loadCases.filter(lc => lc.type !== 'DL');
    if (DL_cases.length === 0) return combos;

    // Characteristic SLS: DL + Q,1 + Σψ₀,i·Q,i
    for (let lead = 0; lead < VAR_cases.length; lead++) {
      const leadCase = VAR_cases[lead];
      const factors = {};
      DL_cases.forEach(lc  => { factors[lc.id] = 1.0; });
      VAR_cases.forEach((lc, idx) => {
        factors[lc.id] = (idx === lead) ? 1.0 : (ψ0[lc.type] || 0.7);
      });
      combos.push({ name: `SLS-Char: DL + ${leadCase.name} + ψ₀·others`, type: 'SLS-Char', code: 'EC0 Eq.6.14', factors });
    }

    // Frequent SLS: DL + ψ₁,1·Q,1 + Σψ₂,i·Q,i
    for (let lead = 0; lead < VAR_cases.length; lead++) {
      const leadCase = VAR_cases[lead];
      const factors = {};
      DL_cases.forEach(lc  => { factors[lc.id] = 1.0; });
      VAR_cases.forEach((lc, idx) => {
        factors[lc.id] = (idx === lead) ? (ψ1[lc.type] || 0.5) : (ψ2[lc.type] || 0.3);
      });
      combos.push({ name: `SLS-Freq: DL + ψ₁·${leadCase.name} + ψ₂·others`, type: 'SLS-Freq', code: 'EC0 Eq.6.15', factors });
    }

    // Quasi-permanent SLS: DL + Σψ₂,i·Q,i
    const factors_qp = {};
    DL_cases.forEach(lc  => { factors_qp[lc.id] = 1.0; });
    VAR_cases.forEach(lc => { factors_qp[lc.id] = ψ2[lc.type] || 0.3; });
    combos.push({ name: 'SLS-QP: DL + Σψ₂·Q (quasi-permanent)', type: 'SLS-QP', code: 'EC0 Eq.6.16', factors: factors_qp });

    return combos;
  }

  // ── ASCE 7-16 Combinations — §2.3 LRFD & §2.4 ASD ───────────────────────
  // options: { method: 'LRFD'|'ASD'|'both', includeSeismic: bool }
  function generateASCE7(loadCases, options = {}) {
    const combos = [];
    const { method = 'LRFD', includeSeismic = false } = options;
    const get = t => loadCases.filter(lc => lc.type === t);
    const DL = get('DL'), LL = get('LL'), WL = get('WL'), SL = get('SL'), EQ = get('EQ');

    function mf(pairs) {  // makeFactors: [[lcArr, factor], ...]
      const f = {};
      for (const [arr, fac] of pairs) arr.forEach(lc => { if (fac !== 0) f[lc.id] = fac; });
      return f;
    }
    const has = arr => arr.length > 0;

    // ── §2.3 LRFD Strength Design ──────────────────────────────────
    if (method === 'LRFD' || method === 'both') {

      // §2.3.1 Combo 1: 1.4D
      if (has(DL))
        combos.push({ name:'LRFD-1: 1.4D', type:'ULS', code:'ASCE7-16 §2.3.1(1)',
          factors: mf([[DL,1.4]]) });

      // §2.3.1 Combo 2: 1.2D + 1.6L + 0.5(S or 0)
      if (has(DL) && has(LL)) {
        combos.push({ name:'LRFD-2: 1.2D + 1.6L', type:'ULS', code:'ASCE7-16 §2.3.1(2)',
          factors: mf([[DL,1.2],[LL,1.6]]) });
        if (has(SL))
          combos.push({ name:'LRFD-2: 1.2D + 1.6L + 0.5S', type:'ULS', code:'ASCE7-16 §2.3.1(2)',
            factors: mf([[DL,1.2],[LL,1.6],[SL,0.5]]) });
      }

      // §2.3.1 Combo 3: 1.2D + 1.6S + (L or 0.5W)
      if (has(DL) && has(SL)) {
        if (has(LL))
          combos.push({ name:'LRFD-3a: 1.2D + 1.6S + L', type:'ULS', code:'ASCE7-16 §2.3.1(3)',
            factors: mf([[DL,1.2],[SL,1.6],[LL,1.0]]) });
        if (has(WL))
          combos.push({ name:'LRFD-3b: 1.2D + 1.6S + 0.5W', type:'ULS', code:'ASCE7-16 §2.3.1(3)',
            factors: mf([[DL,1.2],[SL,1.6],[WL,0.5]]) });
        if (!has(LL) && !has(WL))
          combos.push({ name:'LRFD-3: 1.2D + 1.6S', type:'ULS', code:'ASCE7-16 §2.3.1(3)',
            factors: mf([[DL,1.2],[SL,1.6]]) });
      }

      // §2.3.1 Combo 4: 1.2D + 1.0W + L + 0.5S  (both ±W)
      if (has(DL) && has(WL)) {
        combos.push({ name:'LRFD-4: 1.2D + 1.0W + L + 0.5S', type:'ULS', code:'ASCE7-16 §2.3.1(4)',
          factors: mf([[DL,1.2],[WL,1.0],[LL,1.0],[SL,0.5]]) });
        combos.push({ name:'LRFD-4: 1.2D − 1.0W + L + 0.5S', type:'ULS', code:'ASCE7-16 §2.3.1(4) −W',
          factors: mf([[DL,1.2],[WL,-1.0],[LL,1.0],[SL,0.5]]) });

        // §2.3.1 Combo 6: 0.9D ± 1.0W (uplift / overturning)
        combos.push({ name:'LRFD-6: 0.9D + 1.0W (uplift)', type:'ULS', code:'ASCE7-16 §2.3.1(6)',
          factors: mf([[DL,0.9],[WL,1.0]]) });
        combos.push({ name:'LRFD-6: 0.9D − 1.0W (uplift)', type:'ULS', code:'ASCE7-16 §2.3.1(6) −W',
          factors: mf([[DL,0.9],[WL,-1.0]]) });
      }

      // §2.3.1 Combo 5 / 7: Seismic (only if requested and EQ case exists)
      if (includeSeismic && has(DL) && has(EQ)) {
        combos.push({ name:'LRFD-5: 1.2D + 1.0E + L + 0.2S', type:'ULS', code:'ASCE7-16 §2.3.1(5)',
          factors: mf([[DL,1.2],[EQ,1.0],[LL,1.0],[SL,0.2]]) });
        combos.push({ name:'LRFD-5: 1.2D − 1.0E + L + 0.2S', type:'ULS', code:'ASCE7-16 §2.3.1(5) −E',
          factors: mf([[DL,1.2],[EQ,-1.0],[LL,1.0],[SL,0.2]]) });
        combos.push({ name:'LRFD-7: 0.9D + 1.0E (seismic uplift)', type:'ULS', code:'ASCE7-16 §2.3.1(7)',
          factors: mf([[DL,0.9],[EQ,1.0]]) });
        combos.push({ name:'LRFD-7: 0.9D − 1.0E (seismic uplift)', type:'ULS', code:'ASCE7-16 §2.3.1(7) −E',
          factors: mf([[DL,0.9],[EQ,-1.0]]) });
      }
    }

    // ── §2.4 ASD Allowable Stress Design ───────────────────────────
    if (method === 'ASD' || method === 'both') {

      // §2.4.1 Combo 1: D
      if (has(DL))
        combos.push({ name:'ASD-1: D', type:'SLS', code:'ASCE7-16 §2.4.1(1)',
          factors: mf([[DL,1.0]]) });

      // §2.4.1 Combo 2: D + L
      if (has(DL) && has(LL))
        combos.push({ name:'ASD-2: D + L', type:'SLS', code:'ASCE7-16 §2.4.1(2)',
          factors: mf([[DL,1.0],[LL,1.0]]) });

      // §2.4.1 Combo 3: D + S (roof live/snow)
      if (has(DL) && has(SL))
        combos.push({ name:'ASD-3: D + S', type:'SLS', code:'ASCE7-16 §2.4.1(3)',
          factors: mf([[DL,1.0],[SL,1.0]]) });

      // §2.4.1 Combo 4: D + 0.75L + 0.75S
      if (has(DL) && (has(LL) || has(SL)))
        combos.push({ name:'ASD-4: D + 0.75L + 0.75S', type:'SLS', code:'ASCE7-16 §2.4.1(4)',
          factors: mf([[DL,1.0],[LL,0.75],[SL,0.75]]) });

      // §2.4.1 Combo 5a: D ± 0.6W
      if (has(DL) && has(WL)) {
        combos.push({ name:'ASD-5a: D + 0.6W', type:'SLS', code:'ASCE7-16 §2.4.1(5a)',
          factors: mf([[DL,1.0],[WL,0.6]]) });
        combos.push({ name:'ASD-5a: D − 0.6W', type:'SLS', code:'ASCE7-16 §2.4.1(5a) −W',
          factors: mf([[DL,1.0],[WL,-0.6]]) });

        // §2.4.1 Combo 6a: D + 0.75(0.6W) + 0.75L + 0.75S = D + 0.45W + 0.75L + 0.75S
        combos.push({ name:'ASD-6a: D + 0.45W + 0.75L + 0.75S', type:'SLS', code:'ASCE7-16 §2.4.1(6a)',
          factors: mf([[DL,1.0],[WL,0.45],[LL,0.75],[SL,0.75]]) });
        combos.push({ name:'ASD-6a: D − 0.45W + 0.75L + 0.75S', type:'SLS', code:'ASCE7-16 §2.4.1(6a) −W',
          factors: mf([[DL,1.0],[WL,-0.45],[LL,0.75],[SL,0.75]]) });

        // §2.4.1 Combo 7a: 0.6D ± 0.6W (overturning / uplift)
        combos.push({ name:'ASD-7a: 0.6D + 0.6W (uplift)', type:'SLS', code:'ASCE7-16 §2.4.1(7a)',
          factors: mf([[DL,0.6],[WL,0.6]]) });
        combos.push({ name:'ASD-7a: 0.6D − 0.6W (uplift)', type:'SLS', code:'ASCE7-16 §2.4.1(7a) −W',
          factors: mf([[DL,0.6],[WL,-0.6]]) });
      }

      // §2.4.1 Combos 5b / 6b / 7b: Seismic ASD
      if (includeSeismic && has(DL) && has(EQ)) {
        combos.push({ name:'ASD-5b: D + 0.7E', type:'SLS', code:'ASCE7-16 §2.4.1(5b)',
          factors: mf([[DL,1.0],[EQ,0.7]]) });
        combos.push({ name:'ASD-5b: D − 0.7E', type:'SLS', code:'ASCE7-16 §2.4.1(5b) −E',
          factors: mf([[DL,1.0],[EQ,-0.7]]) });
        combos.push({ name:'ASD-6b: D + 0.525E + 0.75L + 0.75S', type:'SLS', code:'ASCE7-16 §2.4.1(6b)',
          factors: mf([[DL,1.0],[EQ,0.525],[LL,0.75],[SL,0.75]]) });
        combos.push({ name:'ASD-7b: 0.6D + 0.7E (uplift)', type:'SLS', code:'ASCE7-16 §2.4.1(7b)',
          factors: mf([[DL,0.6],[EQ,0.7]]) });
        combos.push({ name:'ASD-7b: 0.6D − 0.7E (uplift)', type:'SLS', code:'ASCE7-16 §2.4.1(7b) −E',
          factors: mf([[DL,0.6],[EQ,-0.7]]) });
      }
    }

    return combos;
  }

  // ── IS 456 / IS 875 (Indian Standard) ────────────────────────────────────
  function generateIS456(loadCases) {
    const combos = [];
    const get = (type) => loadCases.filter(lc => lc.type === type);
    const DL = get('DL'), LL = get('LL'), WL = get('WL'), EQ = get('EQ');

    function makeFactors(pairs) {
      const f = {};
      for (const [lcs, factor] of pairs) lcs.forEach(lc => { f[lc.id] = factor; });
      return f;
    }

    if (DL.length && LL.length) {
      combos.push({ name:'1.5(DL + LL)', type:'ULS', code:'IS 456 Table 18', factors: makeFactors([[DL,1.5],[LL,1.5]]) });
    }
    if (DL.length && WL.length) {
      combos.push({ name:'1.5(DL + WL)', type:'ULS', code:'IS 456', factors: makeFactors([[DL,1.5],[WL,1.5]]) });
      combos.push({ name:'1.2(DL + LL + WL)', type:'ULS', code:'IS 456', factors: makeFactors([[DL,1.2],[LL,1.2],[WL,1.2]]) });
      combos.push({ name:'0.9DL + 1.5WL (uplift)', type:'ULS', code:'IS 456', factors: makeFactors([[DL,0.9],[WL,1.5]]) });
    }
    if (DL.length && EQ.length) {
      combos.push({ name:'1.5(DL + EQ)', type:'ULS', code:'IS 1893', factors: makeFactors([[DL,1.5],[EQ,1.5]]) });
      combos.push({ name:'1.2(DL + LL + EQ)', type:'ULS', code:'IS 1893', factors: makeFactors([[DL,1.2],[LL,1.2],[EQ,1.2]]) });
      combos.push({ name:'0.9DL + 1.5EQ (uplift)', type:'ULS', code:'IS 1893', factors: makeFactors([[DL,0.9],[EQ,1.5]]) });
    }
    return combos;
  }

  // ── Master generator ───────────────────────────────────────────────────────
  // standard: 'EC0' | 'ASCE7' | 'IS456'
  // Returns array of combo objects ready to push into loadCombos
  function generate(loadCases, standard = 'EC0', options = {}) {
    let raw = [];

    switch (standard.toUpperCase()) {
      case 'EC0':   raw = [...generateEC0_ULS(loadCases), ...generateEC0_SLS(loadCases)]; break;
      case 'ASCE7': raw = generateASCE7(loadCases, options); break;
      case 'IS456': raw = generateIS456(loadCases); break;
      default:      raw = [...generateEC0_ULS(loadCases), ...generateEC0_SLS(loadCases)];
    }

    // Filter by type if requested
    if (options.ulsOnly)  raw = raw.filter(c => c.type === 'ULS');
    if (options.slsOnly)  raw = raw.filter(c => c.type !== 'ULS');
    if (options.minCombos) {
      // De-duplicate by keeping highest factor for each load case set
      raw = deduplicateCombos(raw);
    }

    return raw;
  }

  function deduplicateCombos(combos) {
    // Keep unique names, prefer ULS
    const seen = new Set();
    return combos.filter(c => {
      const key = c.name;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  // ── Convert generated combos to app loadCombos format ─────────────────────
  // loadCases: the app's loadCases array (with .id and .type)
  // nextComboId: starting ID for new combos
  function toAppFormat(generatedCombos, nextComboId = 1) {
    return generatedCombos.map((c, i) => ({
      id:      nextComboId + i,
      name:    c.name,
      type:    c.type,
      code:    c.code,
      // factors: array of { caseId, factor } for the combo dialog
      factors: Object.entries(c.factors).map(([caseId, factor]) => ({
        caseId: +caseId,
        factor: +factor.toFixed(4)
      }))
    }));
  }

  // ── HTML summary table ─────────────────────────────────────────────────────
  function buildSummaryHTML(combos, loadCases) {
    if (!combos.length) return '<p style="color:#888">No combinations generated.</p>';

    const TYPE_COL = { ULS:'#c62828', 'SLS-Char':'#1565c0', 'SLS-Freq':'#2e7d32', 'SLS-QP':'#6a1b9a', SLS:'#1565c0' };
    const header = loadCases.map(lc => `<th style="min-width:40px" title="${lc.name} (${lc.type})">${lc.name}</th>`).join('');

    const rows = combos.map(c => {
      const col  = TYPE_COL[c.type] || '#555';
      const fCells = loadCases.map(lc => {
        const f = c.factors[lc.id];
        if (!f || f === 0) return `<td style="color:#bbb;text-align:center">0</td>`;
        const weight = Math.abs(f) > 1 ? 700 : 400;
        return `<td style="text-align:center;font-weight:${weight};color:${f<0?'#e53935':col}">${f.toFixed(2)}</td>`;
      }).join('');
      return `<tr>
        <td style="font-weight:600;color:${col};white-space:nowrap">${c.name}</td>
        <td style="font-size:10px;color:#888">${c.code||''}</td>
        ${fCells}
      </tr>`;
    }).join('');

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#1565c0;color:#fff;">
            <th style="text-align:left;padding:5px 8px">Combination</th>
            <th>Code</th>
            ${header}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ── ψ factor reference tables ─────────────────────────────────────────────
  const PSI_TABLE = {
    'Offices (LL)':      { ψ0:0.7, ψ1:0.5, ψ2:0.3 },
    'Parking (LL)':      { ψ0:0.7, ψ1:0.7, ψ2:0.6 },
    'Shopping (LL)':     { ψ0:0.7, ψ1:0.7, ψ2:0.6 },
    'Roofs (LL)':        { ψ0:0.7, ψ1:0.5, ψ2:0.3 },
    'Snow (SL) ≤1000m':  { ψ0:0.5, ψ1:0.2, ψ2:0.0 },
    'Snow (SL) >1000m':  { ψ0:0.7, ψ1:0.5, ψ2:0.2 },
    'Wind (WL)':         { ψ0:0.6, ψ1:0.2, ψ2:0.0 },
    'Thermal (TL)':      { ψ0:0.6, ψ1:0.5, ψ2:0.5 },
    'Seismic (EQ)':      { ψ0:1.0, ψ1:0.3, ψ2:0.3 }
  };

  return {
    generate,
    generateEC0_ULS,
    generateEC0_SLS,
    generateASCE7,
    generateIS456,
    toAppFormat,
    buildSummaryHTML,
    PSI_TABLE,
    ψ0, ψ1, ψ2
  };

})();

window.LoadCombosGenerator = LoadCombosGenerator;
