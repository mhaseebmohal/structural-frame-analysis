// ══════════════════════════════════════════════════════════════════════════════
//  pm_interaction.js  —  Axial-Bending (P-M) Interaction Diagram
//  EC3 EN 1993-1-1 §6.2.9: N-M interaction for Class 1 & 2 sections
//  Strong-axis (y-y) and weak-axis (z-z) boundaries
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const PMInteraction = (() => {


  // ── Compute N-M boundary (50 points) for one axis ─────────────────────────
  // axis: 'y' (strong) or 'z' (weak). EN 1993-1-1 §6.2.9.1(5) gives a DIFFERENT
  // curve for each:
  //     MN,y,Rd = Mpl,y,Rd·(1 − n)/(1 − 0.5a),  capped at Mpl,y,Rd
  //     MN,z,Rd = Mpl,z,Rd                                   for n ≤ a
  //     MN,z,Rd = Mpl,z,Rd·[1 − ((n − a)/(1 − a))²]          for n > a
  //
  // Only the second was implemented, and it was used for BOTH curves under a
  // comment claiming it was the strong-axis one. The weak-axis form is much the
  // flatter of the two, so the strong-axis boundary was drawn far too generous:
  // for an IPE300 at n = 0.5 it showed m = 0.97 where EC3 gives 0.63 — a member
  // 56 % over its N-M capacity plotted comfortably inside the envelope.
  function computeBoundary(Npl, Mpl, sectionType, a, nPts, axis) {
    nPts = nPts || 60;
    axis = axis || 'y';
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
      const n = i / nPts;  // 0 = pure bending, 1 = pure compression
      let m;
      if (sectionType === 'I' || sectionType === 'H') {
        if (axis === 'z') {
          m = n <= a ? 1.0 : Math.max(0, 1 - ((n - a) / (1 - a)) ** 2);
        } else {
          m = Math.max(0, Math.min(1, (1 - n) / (1 - 0.5 * a)));
        }
      } else if (sectionType === 'box' || sectionType === 'RHS') {
        // EC3 §6.2.9(7): rectangular hollow sections
        m = Math.max(0, (1 - n ** 1.66));
      } else if (sectionType === 'CHS') {
        // Circular hollow sections: m = 1 − n^1.7
        m = Math.max(0, (1 - n ** 1.7));
      } else {
        // Conservative bilinear / parabolic for unknown sections
        m = Math.max(0, 1 - n * n);
      }
      pts.push({ n, m });
    }
    return pts;
  }

  // ── Classify section type from properties ──────────────────────────────────
  function classifyType(sec) {
    const name = (sec.name || '').toUpperCase();
    if (/^IPE|^HEA|^HEB|^HEM|^UB|^UC|^W\d/.test(name)) return 'I';
    if (/^SHS|^RHS/.test(name)) return 'RHS';
    if (/^CHS/.test(name)) return 'CHS';
    if (name.includes('RECT') || name.includes('SLAB')) return 'RHS';
    return 'general';
  }

  // ── Compute section parameters from properties ─────────────────────────────
  function sectionParams(sec) {
    const fy   = sec.fy || 355;  // MPa = kN/cm²
    const A    = sec.A  || 0;    // cm²
    const Wpl  = sec.Zx || sec.Wpl || (sec.Ix ? sec.Ix / (sec.d ? sec.d/20 : 10) : 0); // cm³
    const WplZ = sec.Zy || sec.WplZ || (sec.Iy ? sec.Iy / (sec.bf ? sec.bf/20 : 5) : 0);

    // Actually: A [cm²] × fy [MPa = N/mm²] / 10 = kN
    // 1 cm² = 100 mm², so A[cm²]×fy[N/mm²] = A×fy [N×100/100 mm²] ... let me be careful.
    // Npl [kN] = A [mm²] × fy [N/mm²] / 1000
    // A [cm²] × 100 = A [mm²]
    // Npl [kN] = A[cm²] × 100 × fy[MPa] / 1000 = A[cm²] × fy[MPa] / 10
    const Npl_kN = A * fy / 10;        // kN
    // Mpl [kNm] = Wpl [cm³] × fy [MPa] / (1000) ... Wpl[mm³] = Wpl[cm³]×1000
    // Mpl [kNm] = Wpl[cm³] × 1000 [mm³/cm³] × fy[N/mm²] / 1e6 [Nmm→kNm] = Wpl×fy/1000
    const Mpl_y = Wpl  * fy / 1000;   // kNm
    const Mpl_z = WplZ * fy / 1000;   // kNm

    // EC3 §6.2.9.1(5) defines a = (A − 2·b·tf)/A, capped at 0.5 — the part of
    // the area that is NOT flange, which includes the root fillets. Using the
    // bare web rectangle hw·tw instead leaves the fillets out of both terms and
    // understates a (0.368 vs 0.403 for an IPE300). Fall back to the web
    // rectangle only when flange dimensions are missing.
    let a_frac = 0;
    if (A > 0) {
      if (sec.bf != null && sec.tf != null) {
        const bf_cm = sec.bf / 10, tf_cm = sec.tf / 10;   // mm → cm
        a_frac = (A - 2 * bf_cm * tf_cm) / A;
      } else {
        const hw_cm = (sec.d != null && sec.tf != null)
          ? (sec.d - 2 * sec.tf) / 10
          : (sec.hw_cm || 0);
        const tw_cm = sec.tw != null ? sec.tw / 10 : (sec.tw_cm || 0);
        a_frac = (hw_cm * tw_cm) / A;
      }
    }
    const a_simple = Math.min(0.5, a_frac);

    return { Npl: Npl_kN, Mpl_y, Mpl_z, a: Math.max(0, a_simple) };
  }

  // ── Build SVG plot (W × H pixels) ─────────────────────────────────────────
  function buildSVG(sec, demands, W, H) {
    W = W || 480; H = H || 380;
    const pad = { t: 30, r: 24, b: 50, l: 60 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    const type = classifyType(sec);
    const { Npl, Mpl_y, Mpl_z, a } = sectionParams(sec);

    // Boundaries
    const ptsY = computeBoundary(Npl, Mpl_y, type, a, 60, 'y');

    // Scale: x = M/Mpl_y, y = N/Npl
    const toX = m => pad.l + m * pw;
    const toY = n => pad.t + (1 - n) * ph;

    const pathY = ptsY.map((p, i) => `${i===0?'M':'L'}${toX(p.m).toFixed(1)},${toY(p.n).toFixed(1)}`).join(' ');
    // Close by connecting back to origin
    const pathYClosed = pathY + ` L${toX(0).toFixed(1)},${toY(1).toFixed(1)} L${toX(0).toFixed(1)},${toY(0).toFixed(1)} Z`;

    // Weak axis boundary (dashed)
    const ptsWeak = computeBoundary(Npl, Mpl_z, type, a, 60, 'z');
    const pathZ = ptsWeak.map((p, i) => {
      const mx = p.m * Mpl_z / Math.max(Mpl_y, 0.001);  // normalise to strong-axis scale
      return `${i===0?'M':'L'}${toX(mx).toFixed(1)},${toY(p.n).toFixed(1)}`;
    }).join(' ');

    // Grid lines
    let grid = '';
    [0, 0.25, 0.5, 0.75, 1.0].forEach(v => {
      const gx = toX(v), gy = toY(v);
      grid += `<line x1="${gx.toFixed(1)}" y1="${pad.t}" x2="${gx.toFixed(1)}" y2="${pad.t+ph}" stroke="#ddd" stroke-width="1"/>`;
      grid += `<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${pad.l+pw}" y2="${gy.toFixed(1)}" stroke="#ddd" stroke-width="1"/>`;
      grid += `<text x="${(gx-1).toFixed(1)}" y="${pad.t+ph+14}" font-size="10" fill="#888" text-anchor="middle">${v.toFixed(2)}</text>`;
      grid += `<text x="${(pad.l-6).toFixed(1)}" y="${(gy+4).toFixed(1)}" font-size="10" fill="#888" text-anchor="end">${v.toFixed(2)}</text>`;
    });

    // Demand points
    let demandSVG = '';
    (demands || []).forEach((d, i) => {
      if (!d.N_Ed && !d.M_Ed) return;
      const n = Math.abs(d.N_Ed) / Math.max(Npl, 1);
      const m = Math.abs(d.M_Ed) / Math.max(Mpl_y, 1);
      const cx = toX(m), cy = toY(n);
      const inside = m <= 1 && n <= 1;
      const col = inside ? '#2e7d32' : '#c62828';
      demandSVG += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5"
        fill="${col}" stroke="#fff" stroke-width="1.5"/>`;
      demandSVG += `<text x="${(cx+7).toFixed(1)}" y="${(cy+4).toFixed(1)}"
        font-size="9" fill="${col}" font-weight="700">B${d.beamId || (i+1)}</text>`;
    });

    // Utilisation ray from origin to first demand point (if exists)
    let rayLine = '';
    if (demands && demands.length > 0) {
      const d0 = demands[0];
      const n0 = Math.abs(d0.N_Ed) / Math.max(Npl, 1);
      const m0 = Math.abs(d0.M_Ed) / Math.max(Mpl_y, 1);
      if (m0 > 0.001 || n0 > 0.001) {
        rayLine = `<line x1="${toX(0)}" y1="${toY(0)}" x2="${toX(m0).toFixed(1)}" y2="${toY(n0).toFixed(1)}"
          stroke="#aaa" stroke-width="1" stroke-dasharray="3,2"/>`;
      }
    }

    const fy    = sec.fy || 355;
    const sname = sec.name || 'Section';

    return `<svg width="${W}" height="${H}" style="font-family:sans-serif;display:block;background:#fafafa;border:1px solid #ddd;border-radius:6px;">
      <!-- Grid -->
      ${grid}

      <!-- Axes -->
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+ph}" stroke="#555" stroke-width="1.5"/>
      <line x1="${pad.l}" y1="${pad.t+ph}" x2="${pad.l+pw}" y2="${pad.t+ph}" stroke="#555" stroke-width="1.5"/>

      <!-- Axis labels -->
      <text x="${pad.l+pw/2}" y="${H-6}" font-size="11" fill="#333" text-anchor="middle">M / M<tspan dy="-3" font-size="9">pl,y</tspan><tspan dy="3"> (utilisation)</tspan></text>
      <text x="12" y="${pad.t+ph/2}" font-size="11" fill="#333" text-anchor="middle"
        transform="rotate(-90,12,${pad.t+ph/2})">N / N<tspan dy="-3" font-size="9">pl</tspan><tspan dy="3"> (utilisation)</tspan></text>

      <!-- Weak axis boundary (dashed) -->
      <path d="${pathZ}" fill="none" stroke="#fb8c00" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.7"/>

      <!-- Strong axis boundary (filled) -->
      <path d="${pathYClosed}" fill="#1565c015" stroke="#1565c0" stroke-width="2"/>

      <!-- Demand ray -->
      ${rayLine}

      <!-- Demand points -->
      ${demandSVG}

      <!-- Title -->
      <text x="${pad.l+pw/2}" y="18" font-size="12" fill="#333" text-anchor="middle" font-weight="700">
        P-M Interaction — ${sname} (f<tspan dy="-3" font-size="9">y</tspan><tspan dy="3">=${fy} MPa, N<tspan dy="-3" font-size="9">pl</tspan><tspan dy="3">=${Npl.toFixed(0)} kN, M<tspan dy="-3" font-size="9">pl</tspan><tspan dy="3">=${Mpl_y.toFixed(0)} kNm</tspan>)</text>

      <!-- Legend -->
      <rect x="${pad.l+pw-130}" y="${pad.t+8}" width="130" height="52" rx="4" fill="white" stroke="#ddd"/>
      <line x1="${pad.l+pw-118}" y1="${pad.t+20}" x2="${pad.l+pw-100}" y2="${pad.t+20}" stroke="#1565c0" stroke-width="2"/>
      <text x="${pad.l+pw-96}" y="${pad.t+24}" font-size="10" fill="#1565c0">Strong axis (y-y)</text>
      <line x1="${pad.l+pw-118}" y1="${pad.t+34}" x2="${pad.l+pw-100}" y2="${pad.t+34}" stroke="#fb8c00" stroke-width="1.5" stroke-dasharray="4,2"/>
      <text x="${pad.l+pw-96}" y="${pad.t+38}" font-size="10" fill="#fb8c00">Weak axis (z-z)</text>
      <circle cx="${pad.l+pw-109}" cy="${pad.t+50}" r="5" fill="#2e7d32" stroke="#fff" stroke-width="1"/>
      <text x="${pad.l+pw-96}" y="${pad.t+54}" font-size="10" fill="#2e7d32">Demand (inside)</text>
    </svg>`;
  }

  // ── Build utilisation summary table ───────────────────────────────────────
  function buildSummaryHTML(sec, demands) {
    const { Npl, Mpl_y } = sectionParams(sec);
    const type = classifyType(sec);
    const a = sectionParams(sec).a;

    const rows = (demands || []).map(d => {
      const n = Math.abs(d.N_Ed) / Math.max(Npl, 1);
      const m = Math.abs(d.M_Ed) / Math.max(Mpl_y, 1);
      const pts = computeBoundary(Npl, Mpl_y, type, a, 60, 'y');

      // Interpolate boundary m at given n
      let mBound = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        if (pts[i].n <= n && pts[i+1].n >= n) {
          const t = (n - pts[i].n) / (pts[i+1].n - pts[i].n);
          mBound = pts[i].m + t * (pts[i+1].m - pts[i].m);
          break;
        }
      }

      const eta_nm = mBound > 0 ? m / mBound : (n >= 1 ? Infinity : 0);
      const ok = eta_nm <= 1.0;
      const col = ok ? '#2e7d32' : '#c62828';
      return `<tr>
        <td style="padding:3px 8px;">B${d.beamId}</td>
        <td style="padding:3px 8px;text-align:right;">${d.N_Ed.toFixed(1)}</td>
        <td style="padding:3px 8px;text-align:right;">${d.M_Ed.toFixed(1)}</td>
        <td style="padding:3px 8px;text-align:right;">${n.toFixed(3)}</td>
        <td style="padding:3px 8px;text-align:right;">${m.toFixed(3)}</td>
        <td style="padding:3px 8px;text-align:right;font-weight:700;color:${col};">${eta_nm.toFixed(3)}</td>
        <td style="padding:3px 8px;">${ok?'<span style="color:#2e7d32">✓ OK</span>':'<span style="color:#c62828">✗ FAIL</span>'}</td>
      </tr>`;
    }).join('');

    return `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">
      <tr style="background:#1565c0;color:#fff;">
        <th style="padding:4px 8px;">Beam</th>
        <th style="padding:4px 8px;text-align:right;">N<sub>Ed</sub> (kN)</th>
        <th style="padding:4px 8px;text-align:right;">M<sub>Ed</sub> (kNm)</th>
        <th style="padding:4px 8px;text-align:right;">n = N/N<sub>pl</sub></th>
        <th style="padding:4px 8px;text-align:right;">m = M/M<sub>pl</sub></th>
        <th style="padding:4px 8px;text-align:right;">η (N-M)</th>
        <th style="padding:4px 8px;">Status</th>
      </tr>
      ${rows || '<tr><td colspan="7" style="padding:8px;color:#aaa;text-align:center;">No demand data — run Solve first</td></tr>'}
    </table>
    <div style="font-size:10px;color:#888;margin-top:4px;">
      EC3 §6.2.9 interaction. η = m / m_boundary(n). Type: ${type}, a = ${sectionParams(sec).a.toFixed(3)}.
    </div>`;
  }

  // ── Dialog HTML ────────────────────────────────────────────────────────────
  function buildDialogHTML(sec, demands, allSections) {
    const secOpts = (allSections || []).map(s =>
      `<option value="${s.id}"${sec && s.id === sec.id ? ' selected' : ''}>${s.name}</option>`
    ).join('');

    return `
      <div style="display:flex;flex-direction:column;gap:12px;">

        <!-- Section selector -->
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="font-size:12px;font-weight:700;min-width:80px;">Section:</label>
          <select id="pmi-sec-sel" style="flex:1;font-size:12px;padding:4px 6px;min-width:200px;">
            ${secOpts}
          </select>
          <div style="font-size:11px;color:#888;" id="pmi-sec-info">—</div>
        </div>

        <!-- Demand input / override -->
        <div style="background:var(--bg-tbl-alt);border:1px solid var(--border-tbl);border-radius:6px;padding:10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
          <span style="font-size:11px;font-weight:700;color:#555;min-width:80px;">Override demand:</span>
          <label style="font-size:11px">N<sub>Ed</sub></label>
          <input type="number" id="pmi-ned" value="0" step="10" style="width:70px;font-size:11px;padding:3px 5px;">
          <label style="font-size:11px">kN &nbsp;&nbsp;M<sub>Ed</sub></label>
          <input type="number" id="pmi-med" value="0" step="1" style="width:70px;font-size:11px;padding:3px 5px;">
          <label style="font-size:11px">kNm</label>
          <button class="btn-xs btn-blue" id="pmi-add-pt" style="font-size:11px;padding:3px 10px;">+ Add Point</button>
          <button class="btn-xs" id="pmi-clear-pts" style="font-size:11px;padding:3px 10px;">Clear</button>
        </div>

        <!-- Diagram -->
        <div id="pmi-diagram"></div>

        <!-- Table -->
        <div id="pmi-table"></div>
      </div>`;
  }

  // ── Wire dialog ────────────────────────────────────────────────────────────
  function wireDialog(allSections, allDemands) {
    // allSections: array of section objects from the model
    // allDemands: array of { beamId, N_Ed, M_Ed, sectionId }

    let extraPts = [];

    function getSelectedSec() {
      const sel = document.getElementById('pmi-sec-sel');
      if (!sel) return allSections && allSections[0];
      const id = parseInt(sel.value) || sel.value;
      return allSections && (allSections.find(s => s.id == id) || allSections[0]);
    }

    function getCurrentDemands(sec) {
      const relevant = (allDemands || []).filter(d => !sec || d.sectionId === sec.id);
      return [...relevant, ...extraPts];
    }

    function refresh() {
      const sec = getSelectedSec();
      if (!sec) return;

      const params = sectionParams(sec);
      const info = document.getElementById('pmi-sec-info');
      if (info) info.textContent = `N_pl=${params.Npl.toFixed(0)} kN  M_pl,y=${params.Mpl_y.toFixed(0)} kNm  a=${params.a.toFixed(3)}`;

      const demands = getCurrentDemands(sec);
      document.getElementById('pmi-diagram').innerHTML = buildSVG(sec, demands, 500, 360);
      document.getElementById('pmi-table').innerHTML   = buildSummaryHTML(sec, demands);
    }

    const sel = document.getElementById('pmi-sec-sel');
    if (sel) sel.addEventListener('change', refresh);

    document.getElementById('pmi-add-pt').addEventListener('click', () => {
      const ned = parseFloat(document.getElementById('pmi-ned').value) || 0;
      const med = parseFloat(document.getElementById('pmi-med').value) || 0;
      extraPts.push({ beamId: '★', N_Ed: ned, M_Ed: med, sectionId: null });
      refresh();
    });

    document.getElementById('pmi-clear-pts').addEventListener('click', () => {
      extraPts = [];
      refresh();
    });

    refresh();
  }

  return { computeBoundary, sectionParams, buildSVG, buildSummaryHTML, buildDialogHTML, wireDialog };

})();

window.PMInteraction = PMInteraction;
