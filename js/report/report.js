// ══════════════════════════════════════════════════════════════════════════════
//  report.js  —  Full HTML Structural Analysis Report Generator
//  Features: editable title/engineer/date, section tables, BMD/SFD/NFD SVG
//             diagrams, design check tables, color-coded utilization bars,
//             Chart.js graphs, print/export
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const ReportGenerator = (() => {

  // ── Colour helpers ─────────────────────────────────────────────────────────
  const STATUS_COLOR = { OK: '#2e7d32', NEAR: '#e65100', FAIL: '#c62828', INFO: '#1565c0' };
  const STATUS_BG    = { OK: '#e8f5e9', NEAR: '#fff3e0', FAIL: '#ffebee', INFO: '#e3f2fd' };

  function etaBar(eta, status) {
    if (eta === null || eta === undefined) return '';
    const pct = Math.min(100, (eta * 100)).toFixed(1);
    const col = STATUS_COLOR[status] || '#555';
    return `
      <div style="display:flex;align-items:center;gap:6px;">
        <div style="width:90px;height:10px;background:#e0e0e0;border-radius:5px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${col};border-radius:5px;transition:width .3s;"></div>
        </div>
        <span style="font-size:12px;color:${col};font-weight:600;">${(eta).toFixed(3)}</span>
      </div>`;
  }

  function statusChip(status, label) {
    const col = STATUS_COLOR[status] || '#555';
    const bg  = STATUS_BG[status]  || '#eee';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;
      background:${bg};color:${col};font-size:11px;font-weight:700;border:1px solid ${col};">${label || status}</span>`;
  }

  // ── Number formatting ──────────────────────────────────────────────────────
  function fmt(v, d = 3) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (+v).toFixed(d);
  }

  // ── Internal forces sampled along one member ──────────────────────────────
  // Split out of beamDiagramSVG so the numbers can be checked directly rather
  // than by reading them back out of an SVG polyline.
  //   ef    : element force record (local end forces + direction cosines)
  //   type  : 'BMD' | 'SFD' | 'NFD'
  //   nSeg  : number of sampling intervals
  // Returns an array of nSeg+1 values from end 1 to end 2.
  // The maths lives in checks.js as DesignChecks.internalForceAt /
  // .sampleInternalForces, because the EC3 flexure check needs exactly these
  // numbers and a second copy here would be a second answer. checks.js is
  // loaded before this file everywhere it matters (index.html and the test
  // harness both load js/design/checks.js first).
  function sampleInternalForces(ef, type = 'BMD', nSeg = 20) {
    return DesignChecks.sampleInternalForces(ef, type, nSeg);
  }

  // ef.M1 / ef.M2 are END ACTIONS, whose sign is the negative of the internal
  // bending moment. Printing them raw made the report contradict its own
  // diagrams — and the on-screen tables — about which way a member bends.
  const Mstart = ef => DesignChecks.internalForceAt(ef, 'BMD', 0);
  const Mend   = ef => DesignChecks.internalForceAt(ef, 'BMD', ef.L);

  // ── Inline SVG diagram for a single beam (BMD / SFD / NFD) ────────────────
  function beamDiagramSVG(ef, type = 'BMD') {
    const W = 340, H = 90;
    const nSeg = 20;
    const vals = sampleInternalForces(ef, type, nSeg);

    const maxV = Math.max(...vals.map(Math.abs), 0.001);
    const margin = 20;
    const drawW = W - 2 * margin;
    const drawH = H - 2 * margin;
    const midY  = margin + drawH / 2;

    // Build polyline points
    const pts = vals.map((v, i) => {
      const px = margin + (i / nSeg) * drawW;
      const py = midY - (v / maxV) * (drawH / 2) * 0.85;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    }).join(' ');

    const color = type === 'BMD' ? '#1565c0' : type === 'SFD' ? '#e53935' : '#2e7d32';
    const label = type;

    // Fill polygon (close back along baseline)
    const fillPts = pts + ` ${(margin + drawW).toFixed(1)},${midY} ${margin},${midY}`;

    return `
      <svg width="${W}" height="${H}" style="display:block;font-family:sans-serif;">
        <rect width="${W}" height="${H}" rx="6" fill="#fafafa" stroke="#ddd"/>
        <line x1="${margin}" y1="${midY}" x2="${margin+drawW}" y2="${midY}"
              stroke="#999" stroke-width="1"/>
        <polygon points="${fillPts}" fill="${color}" fill-opacity="0.12"/>
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
        <text x="${margin}" y="${H-4}" font-size="10" fill="#555">${label} (max=${fmt(maxV,2)} ${type === 'BMD' ? 'kNm' : 'kN'})</text>
        <text x="${margin}" y="14" font-size="10" fill="#888">0</text>
        <text x="${margin+drawW-6}" y="14" font-size="10" fill="#888">L</text>
        <line x1="${margin}" y1="${margin}" x2="${margin}" y2="${H-margin}"
              stroke="#ccc" stroke-width="0.5"/>
        <line x1="${margin+drawW}" y1="${margin}" x2="${margin+drawW}" y2="${H-margin}"
              stroke="#ccc" stroke-width="0.5"/>
      </svg>`;
  }

  // ── Section classification table ───────────────────────────────────────────
  function clsTable(cls) {
    if (!cls) return '';
    const clsName = ['', 'Class 1 (Plastic)', 'Class 2 (Compact)', 'Class 3 (Semi-compact)', 'Class 4 (Slender)'];
    const color   = cls.cls <= 2 ? '#2e7d32' : cls.cls === 3 ? '#e65100' : '#c62828';
    return `
      <table class="rpt-table">
        <tr><th>Parameter</th><th>Value</th><th>Limit (Class 1)</th><th>Limit (Class 2)</th><th>Limit (Class 3)</th></tr>
        <tr>
          <td>ε = √(235/fᵧ)</td><td>${fmt(cls.epsilon,4)}</td><td colspan="3">—</td>
        </tr>
        <tr>
          <td>Flange c/t<sub>f</sub></td><td>${fmt(cls.c_flange_ratio,2)}</td>
          <td>${fmt(cls.limits_flange?.[0],2)}</td>
          <td>${fmt(cls.limits_flange?.[1],2)}</td>
          <td>${fmt(cls.limits_flange?.[2],2)}</td>
        </tr>
        <tr>
          <td>Web c/t<sub>w</sub></td><td>${fmt(cls.c_web_ratio,2)}</td>
          <td>${fmt(cls.limits_web?.[0],2)}</td>
          <td>${fmt(cls.limits_web?.[1],2)}</td>
          <td>${fmt(cls.limits_web?.[2],2)}</td>
        </tr>
        <tr>
          <td><strong>Section Class</strong></td>
          <td colspan="4" style="color:${color};font-weight:700;">${clsName[cls.cls] || 'Unknown'}</td>
        </tr>
      </table>`;
  }

  // ── Single check detail block ──────────────────────────────────────────────
  function checkDetail(c) {
    if (!c) return '';
    const hdrColor = STATUS_COLOR[c.status] || '#555';
    const hdrBg    = STATUS_BG[c.status]  || '#eee';

    let rows = '';

    if (c.check === 'Section Classification') {
      rows = clsTable(c);
    } else if (c.check === 'Flexure') {
      rows = `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Note</th></tr>
          <tr><td>M<sub>Ed</sub> (design moment)</td><td>${fmt(c.M_Ed)}</td><td>kNm</td><td>Max of end moments</td></tr>
          <tr><td>W<sub>pl/el</sub> (${c.modulus_label})</td><td>${fmt(c.modulus,1)}</td><td>cm³</td><td>Section ${c.cls <= 2 ? 'plastic' : 'elastic'} modulus</td></tr>
          <tr><td>M<sub>c,Rd</sub> (section capacity)</td><td>${fmt(c.Mc_Rd)}</td><td>kNm</td><td>fy·W/γM0</td></tr>
          <tr><td>M<sub>cr</sub> (elastic critical)</td><td>${fmt(c.Mcr)}</td><td>kNm</td><td>Lateral-torsional buckling</td></tr>
          <tr><td>λ̄<sub>LT</sub> (LTB slenderness)</td><td>${fmt(c.lambdaLT,4)}</td><td>—</td><td>Curve: ${c.ltbCurve}</td></tr>
          <tr><td>χ<sub>LT</sub> (LTB reduction)</td><td>${fmt(c.chiLT,4)}</td><td>—</td><td>${c.ltb_note}</td></tr>
          <tr><td><strong>M<sub>b,Rd</sub> (governing)</strong></td><td><strong>${fmt(c.Mb_Rd)}</strong></td><td>kNm</td><td></td></tr>
          <tr><td><strong>η = M<sub>Ed</sub>/M<sub>b,Rd</sub></strong></td>
              <td colspan="3">${etaBar(c.eta, c.status)}</td></tr>
        </table>`;
    } else if (c.check === 'Shear') {
      rows = `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Note</th></tr>
          <tr><td>V<sub>Ed</sub> (design shear)</td><td>${fmt(c.V_Ed)}</td><td>kN</td><td>Max of end shears</td></tr>
          <tr><td>A<sub>v</sub> (shear area)</td><td>${fmt(c.Av_cm2,2)}</td><td>cm²</td><td>EC3 6.2.6(3)</td></tr>
          <tr><td>V<sub>pl,Rd</sub> (plastic shear)</td><td>${fmt(c.Vpl_Rd)}</td><td>kN</td><td>Av·fy/(√3·γM0)</td></tr>
          <tr><td>h<sub>w</sub>/t<sub>w</sub></td><td>${fmt(c.hw_tw,2)}</td><td>—</td><td>${c.shear_buckling_note}</td></tr>
          <tr><td>M-V interaction ρ<sub>V</sub></td><td>${fmt(c.rho_V,4)}</td><td>—</td><td>${c.MV_reduction}</td></tr>
          <tr><td><strong>η = V<sub>Ed</sub>/V<sub>pl,Rd</sub></strong></td>
              <td colspan="3">${etaBar(c.eta, c.status)}</td></tr>
        </table>`;
    } else if (c.check && c.check.startsWith('Axial')) {
      if (c.isTension) {
        rows = `
          <table class="rpt-table">
            <tr><th>Parameter</th><th>Value</th><th>Unit</th></tr>
            <tr><td>N<sub>Ed</sub> (design tension)</td><td>${fmt(c.N_Ed)}</td><td>kN</td></tr>
            <tr><td>N<sub>t,Rd</sub> (tension capacity)</td><td>${fmt(c.Nt_Rd)}</td><td>kN</td></tr>
            <tr><td>${c.note}</td><td colspan="2">—</td></tr>
            <tr><td><strong>η</strong></td><td colspan="2">${etaBar(c.eta, c.status)}</td></tr>
          </table>`;
      } else {
        rows = `
          <table class="rpt-table">
            <tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Note</th></tr>
            <tr><td>N<sub>Ed</sub> (compression)</td><td>${fmt(c.N_Ed)}</td><td>kN</td><td></td></tr>
            <tr><td>N<sub>pl,Rd</sub> (cross-section)</td><td>${fmt(c.Npl_Rd)}</td><td>kN</td><td>A·fy/γM0</td></tr>
            <tr><td>N<sub>cr,y</sub> (Euler, major)</td><td>${fmt(c.Ncr_y,1)}</td><td>kN</td><td>π²EI/L²</td></tr>
            <tr><td>N<sub>cr,z</sub> (Euler, minor)</td><td>${fmt(c.Ncr_z,1)}</td><td>kN</td><td>π²EI/L²</td></tr>
            <tr><td>λ̄<sub>y</sub> / λ̄<sub>z</sub></td><td>${fmt(c.lambda_y,4)} / ${fmt(c.lambda_z,4)}</td><td>—</td><td>Curves: ${c.curveY}/${c.curveZ}</td></tr>
            <tr><td>χ<sub>y</sub> / χ<sub>z</sub></td><td>${fmt(c.chi_y,4)} / ${fmt(c.chi_z,4)}</td><td>—</td><td>Reduction factor</td></tr>
            <tr><td><strong>N<sub>b,Rd</sub> (buckling)</strong></td><td><strong>${fmt(c.Nb_Rd)}</strong></td><td>kN</td><td>${c.note}</td></tr>
            <tr><td>L<sub>cr</sub></td><td>${fmt(c.Lcr)}</td><td>m</td><td>Effective buckling length</td></tr>
            <tr><td><strong>η = N<sub>Ed</sub>/N<sub>b,Rd</sub></strong></td>
                <td colspan="3">${etaBar(c.eta, c.status)}</td></tr>
          </table>`;
      }
    } else if (c.check === 'Torsion') {
      rows = `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th><th>Unit</th></tr>
          <tr><td>G (shear modulus)</td><td>${fmt(c.G_kNm2,0)} GPa</td><td>kN/m²</td></tr>
          <tr><td>J (St.Venant constant)</td><td>${fmt(c.J_cm4,2)}</td><td>cm⁴</td></tr>
          <tr><td>C<sub>w</sub> (warping constant)</td><td>${fmt(c.Cw_cm6,1)}</td><td>cm⁶</td></tr>
          <tr><td>τ<sub>Rd</sub> (shear stress limit)</td><td>${fmt(c.tau_Rd_kNm2,1)}</td><td>MPa</td></tr>
          <tr><td>T<sub>t,pl,Rd</sub> (torsion capacity)</td><td>${fmt(c.Tt_pl_Rd,3)}</td><td>kNm</td></tr>
          <tr><td colspan="3" style="color:#1565c0;font-style:italic;">${c.warning}</td></tr>
          <tr><td colspan="3" style="color:#888;">${c.note}</td></tr>
        </table>`;
    } else if (c.check === 'Combined N+M Interaction') {
      rows = `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Note</th></tr>
          <tr><td>N<sub>Ed</sub></td><td>${fmt(c.N_Ed)}</td><td>kN</td><td>Compression</td></tr>
          <tr><td>M<sub>Ed</sub></td><td>${fmt(c.M_Ed)}</td><td>kNm</td><td>Max bending moment</td></tr>
          <tr><td>N<sub>b,Rd</sub></td><td>${fmt(c.Nb_Rd)}</td><td>kN</td><td>Buckling resistance</td></tr>
          <tr><td>M<sub>b,Rd</sub></td><td>${fmt(c.Mb_Rd)}</td><td>kNm</td><td>LTB resistance</td></tr>
          <tr><td>k<sub>yy</sub> / k<sub>zy</sub></td><td>${fmt(c.kyy,4)} / ${fmt(c.kzy,4)}</td><td>—</td><td>Interaction factors (Method 2)</td></tr>
          <tr><td>η (Eq.6.61)</td><td>${fmt(c.eta_6_61,4)}</td><td>—</td><td>Major axis</td></tr>
          <tr><td>η (Eq.6.62)</td><td>${fmt(c.eta_6_62,4)}</td><td>—</td><td>Minor axis</td></tr>
          <tr><td><strong>η governing</strong></td><td colspan="3">${etaBar(c.eta, c.status)} <em>${c.governing}</em></td></tr>
        </table>`;
    } else if (c.check === 'Deflection') {
      rows = `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th><th>Unit</th></tr>
          <tr><td>δ<sub>max</sub></td><td>${fmt(c.v_max_mm,2)}</td><td>mm</td></tr>
          <tr><td>Limit (${c.limit_frac})</td><td>${fmt(c.limit_mm,2)}</td><td>mm</td></tr>
          <tr><td>L</td><td>${fmt(c.L_m,3)}</td><td>m</td></tr>
          <tr><td colspan="3" style="color:#888;font-size:12px;">${c.note}</td></tr>
          <tr><td><strong>η</strong></td><td colspan="2">${etaBar(c.eta, c.status)}</td></tr>
        </table>`;
    } else if (c.check === 'Plate Buckling') {
      const elRows = (c.elements || []).map(el => `
        <tr>
          <td>${el.element}</td>
          <td>${el.type}</td>
          <td>${fmt(el.b_t, 2)}</td>
          <td>${fmt(el.k, 2)}</td>
          <td>${fmt(el.sigma_cr_MPa, 1)}</td>
          <td>${fmt(el.lambda_p, 4)}</td>
          <td>${fmt(el.rho, 4)}</td>
          <td style="color:${el.status==='OK'?'#2e7d32':'#c62828'};font-weight:700;">${el.status}</td>
        </tr>`).join('');
      rows = `
        <table class="rpt-table">
          <tr><th>Element</th><th>Type</th><th>b/t</th><th>k</th>
              <th>σ<sub>cr</sub> (MPa)</th><th>λ̄<sub>p</sub></th><th>ρ</th><th>Status</th></tr>
          ${elRows || '<tr><td colspan="8" style="color:#888;">No elements checked</td></tr>'}
        </table>
        <div style="margin-top:6px;font-size:12px;color:#555;">
          Plate buckling per EC3 §4. λ̄<sub>p</sub> &gt; 0.673 triggers effective-width reduction (ρ &lt; 1.0).
        </div>`;
    } else if (c.check === 'Property Modifiers') {
      if (!c.active) {
        rows = `<p style="color:#888;font-size:13px;">No property modifiers applied (all = 1.0)</p>`;
      } else {
        const fRows = c.factors.map(f => `
          <tr>
            <td>${f.name}</td><td>${f.modifier}</td><td>${f.nominal} ${f.unit}</td>
            <td>${f.effective.toFixed(2)} ${f.unit}</td>
            <td style="color:${f.pct_change < 0 ? '#c62828' : '#1565c0'};font-weight:600;">${f.pct_change > 0 ? '+' : ''}${f.pct_change}%</td>
          </tr>`).join('');
        rows = `
          <table class="rpt-table">
            <tr><th>Modifier</th><th>Factor</th><th>Nominal</th><th>Effective</th><th>Change</th></tr>
            ${fRows}
          </table>`;
      }
    } else if (rows === '' && c.check) {
      // Generic fallback for any check not explicitly handled
      const skipKeys = new Set(['check','status','eta','note']);
      const fRows = Object.entries(c)
        .filter(([k]) => !skipKeys.has(k) && typeof c[k] !== 'object')
        .map(([k,v]) => `<tr><td>${k.replace(/_/g,' ')}</td><td>${typeof v==='number'?fmt(v,4):v}</td></tr>`)
        .join('');
      rows = fRows ? `
        <table class="rpt-table">
          <tr><th>Parameter</th><th>Value</th></tr>${fRows}
        </table>` : '';
      if (c.eta !== undefined) rows += `<div style="margin-top:6px">${etaBar(c.eta, c.status)}</div>`;
    }

    return `
      <div class="check-block" style="margin-bottom:12px;border:1px solid ${hdrColor}44;border-radius:6px;overflow:hidden;">
        <div style="background:${hdrBg};padding:6px 12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:13px;color:${hdrColor};">${c.check}</span>
          ${c.status ? statusChip(c.status) : ''}
        </div>
        <div style="padding:10px 12px;">
          ${rows}
        </div>
      </div>`;
  }

  // ── Chart.js dataset builder (for the in-report chart section) ─────────────
  function buildChartDatasets(elemForces) {
    // Returns {labels, bmd, sfd, nfd} arrays for a Chart.js bar chart
    const labels = elemForces.map(ef => `B${ef.id}`);
    const bmd    = elemForces.map(ef => +Math.max(Math.abs(ef.M1), Math.abs(ef.M2)).toFixed(3));
    const sfd    = elemForces.map(ef => +Math.max(Math.abs(ef.V1), Math.abs(ef.V2)).toFixed(3));
    const nfd    = elemForces.map(ef => +Math.max(Math.abs(ef.N1), Math.abs(ef.N2)).toFixed(3));
    return { labels, bmd, sfd, nfd };
  }

  // ── Reactions table ────────────────────────────────────────────────────────
  function reactTable(reactions, nodes) {
    if (!reactions) return '';
    const rows = nodes
      .filter(nd => nd.support && nd.support !== 'none')
      .map(nd => {
        const r = reactions[nd.id] || { Rx:0, Ry:0, M:0 };
        return `
          <tr>
            <td>N${nd.id}</td>
            <td>${nd.support}</td>
            <td>${fmt(r.Rx)}</td>
            <td>${fmt(r.Ry)}</td>
            <td>${fmt(r.M)}</td>
          </tr>`;
      }).join('');
    return `
      <table class="rpt-table">
        <tr><th>Node</th><th>Support</th><th>R<sub>x</sub> (kN)</th><th>R<sub>y</sub> (kN)</th><th>M (kNm)</th></tr>
        ${rows}
      </table>`;
  }

  // ── Member forces table ────────────────────────────────────────────────────
  function memberForceTable(elemForces) {
    const rows = elemForces.map(ef => `
      <tr>
        <td>B${ef.id}</td>
        <td>${fmt(ef.L)}</td>
        <td>${fmt(ef.N1)}</td>
        <td>${fmt(ef.V1)}</td>
        <td>${fmt(Mstart(ef))}</td>
        <td>${fmt(ef.N2)}</td>
        <td>${fmt(ef.V2)}</td>
        <td>${fmt(Mend(ef))}</td>
      </tr>`).join('');
    return `
      <table class="rpt-table">
        <tr>
          <th>Beam</th><th>L (m)</th>
          <th>N₁ (kN)</th><th>V₁ (kN)</th><th>M₁ (kNm)</th>
          <th>N₂ (kN)</th><th>V₂ (kN)</th><th>M₂ (kNm)</th>
        </tr>
        ${rows}
      </table>`;
  }

  // ── Nodal displacement table ───────────────────────────────────────────────
  function dispTable(disp, nodes) {
    if (!disp) return '';
    const rows = nodes.map(nd => {
      const d = disp[nd.id] || { u:0, v:0, theta:0 };
      return `
        <tr>
          <td>N${nd.id}</td>
          <td>${fmt(nd.x)}</td>
          <td>${fmt(nd.y)}</td>
          <td>${(d.u * 1000).toFixed(4)}</td>
          <td>${(d.v * 1000).toFixed(4)}</td>
          <td>${(d.theta * 1000).toFixed(4)}</td>
        </tr>`;
    }).join('');
    return `
      <table class="rpt-table">
        <tr><th>Node</th><th>X (m)</th><th>Y (m)</th><th>u (mm)</th><th>v (mm)</th><th>θ (mrad)</th></tr>
        ${rows}
      </table>`;
  }

  // ── Design summary table ───────────────────────────────────────────────────
  function designSummaryTable(designResults) {
    if (!designResults) return '<p style="color:#888;">Run design checks to see results.</p>';
    const { byBeam, summary } = designResults;
    const rows = byBeam.map(b => `
      <tr style="background:${STATUS_BG[b.overall]}22;">
        <td>${b.label}</td>
        <td>${b.secName}</td>
        <td>${fmt(b.L)}</td>
        <td>Class ${b.cls}</td>
        <td>${etaBar(b.maxEta, b.overall)}</td>
        <td>${statusChip(b.overall)}</td>
      </tr>`).join('');

    return `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
        ${statusChip('OK',   `✓ ${summary.pass} OK`)}
        ${statusChip('NEAR', `⚠ ${summary.near} Near`)}
        ${statusChip('FAIL', `✗ ${summary.fail} Fail`)}
      </div>
      <table class="rpt-table">
        <tr><th>Member</th><th>Section</th><th>L (m)</th><th>Class</th><th>Max η</th><th>Status</th></tr>
        ${rows}
      </table>`;
  }

  // ── Table of Contents builder ──────────────────────────────────────────────
  function buildTOC(sections) {
    const items = sections.map(([num, anchor, label]) =>
      `<li><a href="#${anchor}" style="color:#1565c0;text-decoration:none;">
         <span style="min-width:28px;display:inline-block;">${num}</span>${label}
       </a></li>`).join('');
    return `
      <div style="background:#e3f2fd;border-radius:8px;padding:14px 20px;margin-bottom:24px;">
        <div style="font-weight:700;font-size:14px;color:#1565c0;margin-bottom:8px;">Contents</div>
        <ol style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:4px;">
          ${items}
        </ol>
      </div>`;
  }

  // ── Code-aware label helpers ───────────────────────────────────────────────
  function codeLabel(code) {
    if (code === 'ACI') return 'ACI 318-19';
    if (code === 'EC2') return 'EC2 EN 1992-1-1';
    return 'EC3 EN 1993-1-1';
  }
  function codeRef(code, check) {
    if (code === 'ACI') {
      const refs = {
        'Flexure': 'ACI §22.2', 'Shear': 'ACI §22.5', 'Axial': 'ACI §22.4',
        'Deflection': 'ACI §24.2', 'Combined': 'ACI §22.4.2'
      };
      return refs[check] || 'ACI 318-19';
    }
    if (code === 'EC2') return 'EC2 §6';
    return 'EC3 §6';
  }
  function codePartialFactors(code) {
    if (code === 'ACI') return 'φ (flexure) = 0.90, φ (shear) = 0.75, φ (axial) = 0.65';
    if (code === 'EC2') return 'γ<sub>C</sub> = 1.50, γ<sub>S</sub> = 1.15';
    return 'γ<sub>M0</sub> = 1.00, γ<sub>M1</sub> = 1.00, γ<sub>M2</sub> = 1.25';
  }
  function codeChecklist(code) {
    if (code === 'ACI') return [
      'Flexural strength φMn (ACI §22.2)', 'Shear strength φVn (ACI §22.5)',
      'Axial resistance φPn (ACI §22.4)', 'Combined N+M interaction (ACI §22.4.2)',
      'Serviceability deflection (ACI §24.2)'
    ];
    if (code === 'EC2') return [
      'Flexural resistance MRd (EC2 §6.1)', 'Shear resistance VRd (EC2 §6.2)',
      'Axial resistance NRd (EC2 §6.1)', 'Combined N+M interaction (EC2 §6.1)',
      'Serviceability deflection L/250 (EC2 §7.4)'
    ];
    return [
      'Section classification (EC3 Table 5.2)', 'Axial resistance and flexural buckling (EC3 §6.2.4, §6.3.1)',
      'Bending resistance with lateral-torsional buckling (EC3 §6.2.5, §6.3.2)',
      'Shear resistance including M-V interaction (EC3 §6.2.6)',
      'Plate element buckling — effective width method (EC3 §4)',
      'Combined axial force + bending (EC3 Eq.6.61/6.62)',
      'Serviceability deflection limit (L/250 default)'
    ];
  }

  // ── Utilization spectrum bar ───────────────────────────────────────────────
  function utilizationSpectrum(designResults) {
    if (!designResults || !designResults.byBeam || !designResults.byBeam.length) return '';
    const members = designResults.byBeam.slice().sort((a,b) => b.maxEta - a.maxEta);
    const maxEta = members[0].maxEta || 1;
    const bars = members.map(m => {
      const pct = Math.min(100, (m.maxEta / Math.max(maxEta, 1)) * 100).toFixed(1);
      const col = STATUS_COLOR[m.overall] || '#555';
      return `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
          <div style="width:42px;font-size:11px;font-weight:700;color:#333;text-align:right;">${m.label}</div>
          <div style="flex:1;height:14px;background:#e8e8e8;border-radius:4px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${col};border-radius:4px;transition:width .4s;"></div>
          </div>
          <div style="width:38px;font-size:11px;color:${col};font-weight:700;text-align:left;">η=${m.maxEta.toFixed(2)}</div>
          <div style="font-size:10px;">${statusChip(m.overall)}</div>
        </div>`;
    }).join('');
    return `
      <div style="margin:10px 0;">
        <div style="font-size:12px;color:#555;margin-bottom:6px;font-weight:600;">Utilization Spectrum (sorted by η)</div>
        ${bars}
      </div>`;
  }

  // ── SUMMARY REPORT (1-page fancy) ─────────────────────────────────────────
  function generateSummary(options) {
    const {
      title       = 'Structural Analysis Report',
      projectName = 'Untitled Project',
      engineer    = '',
      date        = new Date().toLocaleDateString(),
      company     = '',
      nodes       = [],
      beams       = [],
      loads       = [],
      results     = null,
      designResults = null,
      svgCanvas   = null,
      designCode  = 'EC3'
    } = options;

    const ef = results?.elemForces || [];
    const reactions = results?.reactions || {};
    const disp = results?.disp || {};
    const code = designCode || 'EC3';

    // ── Key Force Statistics ───────────────────────────────────────
    const maxM  = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.M1), Math.abs(e.M2)))) : 0;
    const maxV  = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.V1), Math.abs(e.V2)))) : 0;
    const maxN  = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.N1), Math.abs(e.N2)))) : 0;
    const maxDv = Object.values(disp).length ? Math.max(...Object.values(disp).map(d => Math.sqrt(d.u*d.u + d.v*d.v) * 1000)) : 0;

    const critM = ef.length ? ef.reduce((a,b) => Math.max(Math.abs(a.M1),Math.abs(a.M2)) >= Math.max(Math.abs(b.M1),Math.abs(b.M2)) ? a : b) : null;
    const critV = ef.length ? ef.reduce((a,b) => Math.max(Math.abs(a.V1),Math.abs(a.V2)) >= Math.max(Math.abs(b.V1),Math.abs(b.V2)) ? a : b) : null;

    // ── Overall design status ──────────────────────────────────────
    let overallStatus = 'INFO', overallLabel = 'Not checked', overallNote = '';
    if (designResults?.summary) {
      const { pass, near, fail } = designResults.summary;
      if (fail > 0)       { overallStatus = 'FAIL'; overallLabel = `⚠ ${fail} Member(s) FAIL`; }
      else if (near > 0)  { overallStatus = 'NEAR'; overallLabel = `~ ${near} Member(s) Near Limit`; }
      else if (pass > 0)  { overallStatus = 'OK';   overallLabel = `✓ All ${pass} Members PASS`; }
      overallNote = `${pass} OK · ${near} Near · ${fail} Fail`;
    }

    // ── Reactions summary ──────────────────────────────────────────
    let totalRx = 0, totalRy = 0;
    nodes.filter(n => n.support && n.support !== 'none').forEach(nd => {
      const r = reactions[nd.id] || {};
      totalRx += r.Rx || 0;
      totalRy += r.Ry || 0;
    });

    // ── Critical members table ─────────────────────────────────────
    const topMembers = designResults?.byBeam
      ? designResults.byBeam.slice().sort((a,b) => b.maxEta - a.maxEta).slice(0,5)
      : [];

    const topMemberRows = topMembers.map(m => {
      const col = STATUS_COLOR[m.overall] || '#555';
      const bg  = STATUS_BG[m.overall]  || '#eee';
      const pct = Math.min(100, m.maxEta * 100).toFixed(0);
      return `
        <tr style="background:${bg}33;">
          <td style="font-weight:700;color:#333;">${m.label}</td>
          <td style="color:#555;">${m.secName}</td>
          <td>${fmt(m.L)} m</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <div style="width:70px;height:10px;background:#e0e0e0;border-radius:4px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:${col};"></div>
              </div>
              <span style="font-size:12px;font-weight:700;color:${col};">${m.maxEta.toFixed(3)}</span>
            </div>
          </td>
          <td style="text-align:center;">${statusChip(m.overall)}</td>
        </tr>`;
    }).join('');

    // ── Force comparison mini-chart (SVG bar chart inline) ─────────
    function miniBarChart(values, labels, colors, title, unit) {
      const W = 340, H = 130, mg = 28, tw = 40;
      const max = Math.max(...values.map(Math.abs), 0.001);
      const barW = Math.max(8, Math.min(24, (W - mg*2 - tw) / values.length - 4));
      const barsHTML = values.map((v, i) => {
        const h = (Math.abs(v) / max) * (H - mg*2 - 18) * 0.9;
        const bx = mg + tw + i * ((W - mg - tw) / values.length) + (W - mg - tw) / values.length / 2 - barW/2;
        const by = H - mg - h;
        return `
          <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}"
                rx="2" fill="${colors[i % colors.length]}cc"/>
          <text x="${(bx+barW/2).toFixed(1)}" y="${(H-mg+10).toFixed(1)}"
                text-anchor="middle" font-size="9" fill="#555">${labels[i]}</text>
          <text x="${(bx+barW/2).toFixed(1)}" y="${(by-3).toFixed(1)}"
                text-anchor="middle" font-size="8.5" fill="${colors[i % colors.length]}"
                font-weight="600">${Math.abs(v).toFixed(1)}</text>`;
      }).join('');
      return `
        <svg width="${W}" height="${H}" style="display:block;font-family:sans-serif;overflow:visible;">
          <rect width="${W}" height="${H-16}" rx="6" fill="#fafafa" stroke="#e0e0e0"/>
          <text x="${mg/2}" y="${H/2-16}" text-anchor="middle" font-size="10" fill="#777"
                transform="rotate(-90,${mg/2},${H/2-16})">${unit}</text>
          <text x="${W/2}" y="12" text-anchor="middle" font-size="11" fill="#333" font-weight="600">${title}</text>
          <line x1="${mg+tw}" y1="${mg+6}" x2="${mg+tw}" y2="${H-mg}" stroke="#ccc"/>
          <line x1="${mg+tw}" y1="${H-mg}" x2="${W-4}" y2="${H-mg}" stroke="#ccc"/>
          ${barsHTML}
        </svg>`;
    }

    const chartLabels  = ef.slice(0,8).map(e => 'B'+e.id);
    const chartColors  = ['#1565c0','#1565c0','#e53935','#e53935','#2e7d32'];
    const bmChart = ef.length > 0 ? miniBarChart(
      ef.slice(0,8).map(e => Math.max(Math.abs(e.M1), Math.abs(e.M2))),
      chartLabels, chartColors.map(() => '#1565c0'), 'Bending Moments', 'kNm') : '';
    const sfChart = ef.length > 0 ? miniBarChart(
      ef.slice(0,8).map(e => Math.max(Math.abs(e.V1), Math.abs(e.V2))),
      chartLabels, chartColors.map(() => '#e53935'), 'Shear Forces', 'kN') : '';
    const nfChart = ef.length > 0 ? miniBarChart(
      ef.slice(0,8).map(e => Math.max(Math.abs(e.N1), Math.abs(e.N2))),
      chartLabels, chartColors.map(() => '#2e7d32'), 'Axial Forces', 'kN') : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Summary — ${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #222; background: #eef2f7; }
  .page { max-width: 1050px; margin: 0 auto; padding: 20px; }
  .no-print { }
  @media print { .no-print { display:none !important; } body { background:#fff; } .page { padding:0; } }
  /* ── Banner ── */
  .banner {
    background: linear-gradient(135deg, #1565c0 0%, #0d47a1 50%, #283593 100%);
    border-radius: 12px; padding: 24px 30px; color: #fff; margin-bottom: 16px;
    display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  }
  .banner h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .banner .sub { font-size: 12px; opacity: 0.8; display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  .banner .sub span { background: rgba(255,255,255,0.15); padding: 2px 10px; border-radius: 12px; }
  .banner .code-badge {
    background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4);
    border-radius: 8px; padding: 8px 14px; text-align: center; white-space: nowrap;
    font-size: 12px; font-weight: 600;
  }
  .banner .code-badge .code-name { font-size: 16px; font-weight: 800; display: block; margin-top: 2px; }
  /* ── KPI grid ── */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px,1fr)); gap: 10px; margin-bottom: 16px; }
  .kpi { background: #fff; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 4px #0001;
         border-left: 4px solid #1565c0; }
  .kpi .val { font-size: 22px; font-weight: 800; color: #1565c0; line-height: 1; }
  .kpi .lbl { font-size: 10px; color: #777; margin-top: 4px; font-weight: 600; text-transform: uppercase; }
  .kpi.green { border-color: #2e7d32; } .kpi.green .val { color: #2e7d32; }
  .kpi.red   { border-color: #c62828; } .kpi.red   .val { color: #c62828; }
  .kpi.orange{ border-color: #e65100; } .kpi.orange .val { color: #e65100; }
  /* ── Cards ── */
  .card { background:#fff; border-radius:10px; padding:16px; box-shadow:0 1px 4px #0001; }
  .card h3 { font-size:13px; color:#1565c0; font-weight:700; margin-bottom:10px;
             border-bottom:2px solid #e3f2fd; padding-bottom:5px; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px; }
  .three-col { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px; }
  .full-col { margin-bottom:16px; }
  @media (max-width:700px) { .two-col,.three-col { grid-template-columns:1fr; } }
  /* ── Tables ── */
  .sum-table { width:100%; border-collapse:collapse; font-size:12px; }
  .sum-table th { background:#1565c0; color:#fff; padding:6px 10px; text-align:left; font-size:11px; }
  .sum-table td { padding:5px 10px; border-bottom:1px solid #f0f0f0; }
  /* ── Status banner ── */
  .status-card {
    border-radius:10px; padding:14px 18px; display:flex; align-items:center; gap:14px;
    box-shadow: 0 1px 4px #0001; margin-bottom:16px;
  }
  .status-icon { font-size:36px; line-height:1; }
  .status-text h2 { font-size:18px; font-weight:800; }
  .status-text p  { font-size:12px; margin-top:3px; opacity:0.8; }
  /* ── Toolbar ── */
  .toolbar { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
  .toolbar button { padding:7px 16px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; }
  .btn-print  { background:#1565c0; color:#fff; }
  .btn-dl     { background:#2e7d32; color:#fff; }
  .btn-full   { background:#e65100; color:#fff; }
</style>
</head>
<body>
<div class="page">

<div class="toolbar no-print">
  <button class="btn-print" onclick="window.print()">🖨 Print / PDF</button>
  <button class="btn-dl"    onclick="downloadHTML()">⬇ Download HTML</button>
  <span style="color:#888;font-size:12px;align-self:center;">Summary Report — ${codeLabel(code)}</span>
</div>

<!-- Banner -->
<div class="banner">
  <div>
    <h1 id="rpt-title" contenteditable="true">${title}</h1>
    <div class="sub">
      <span>📁 ${projectName}</span>
      ${engineer ? `<span>👷 ${engineer}</span>` : ''}
      ${company  ? `<span>🏢 ${company}</span>`  : ''}
      <span>📅 ${date}</span>
      <span>⚙ FrameSolver v1</span>
    </div>
  </div>
  <div class="code-badge">
    Design Standard<span class="code-name">${codeLabel(code)}</span>
  </div>
</div>

<!-- Overall status -->
${designResults ? `
<div class="status-card" style="background:${STATUS_BG[overallStatus]};border:2px solid ${STATUS_COLOR[overallStatus]}44;">
  <div class="status-icon">${overallStatus==='OK'?'✅':overallStatus==='FAIL'?'❌':'⚠️'}</div>
  <div class="status-text">
    <h2 style="color:${STATUS_COLOR[overallStatus]};">${overallLabel}</h2>
    <p style="color:${STATUS_COLOR[overallStatus]};">${overallNote}</p>
  </div>
</div>` : `
<div class="status-card" style="background:#e3f2fd;border:2px solid #1565c044;">
  <div class="status-icon">ℹ️</div>
  <div class="status-text">
    <h2 style="color:#1565c0;">Analysis Complete${ef.length ? '' : ' — No Results'}</h2>
    <p style="color:#1565c0;">Run Design Checks to see member adequacy.</p>
  </div>
</div>`}

<!-- KPI grid -->
<div class="kpi-grid">
  <div class="kpi"><div class="val">${nodes.length}</div><div class="lbl">Nodes</div></div>
  <div class="kpi"><div class="val">${beams.length}</div><div class="lbl">Members</div></div>
  <div class="kpi"><div class="val">${loads.length}</div><div class="lbl">Loads</div></div>
  <div class="kpi"><div class="val">${nodes.filter(n=>n.support&&n.support!=='none').length}</div><div class="lbl">Supports</div></div>
  <div class="kpi ${maxM>0?'blue':''}"><div class="val">${fmt(maxM,2)}</div><div class="lbl">Max M (kNm)</div></div>
  <div class="kpi ${maxV>0?'orange':''}"><div class="val">${fmt(maxV,2)}</div><div class="lbl">Max V (kN)</div></div>
  <div class="kpi ${maxN>0?'green':''}"><div class="val">${fmt(maxN,2)}</div><div class="lbl">Max N (kN)</div></div>
  <div class="kpi"><div class="val">${maxDv > 0 ? maxDv.toFixed(2) : '—'}</div><div class="lbl">Max δ (mm)</div></div>
</div>

<!-- Charts + Spectrum -->
<div class="two-col">
  ${ef.length > 0 ? `
  <div class="card">
    <h3>📊 Force Distribution</h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${bmChart}${sfChart}${nfChart}
    </div>
  </div>` : `<div class="card"><h3>📊 Force Distribution</h3><p style="color:#aaa;padding:20px;text-align:center;">Solve to see results</p></div>`}
  <div class="card">
    <h3>📈 Utilization Spectrum</h3>
    ${designResults ? utilizationSpectrum(designResults) : '<p style="color:#aaa;padding:20px;text-align:center;">Run design checks</p>'}
    ${ef.length > 0 ? `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid #eee;">
      <div style="font-size:11px;color:#888;font-weight:600;margin-bottom:4px;">REACTIONS SUMMARY</div>
      <div style="display:flex;gap:16px;font-size:13px;">
        <div><span style="color:#555;">ΣRx:</span> <strong>${fmt(totalRx,2)} kN</strong></div>
        <div><span style="color:#555;">ΣRy:</span> <strong>${fmt(totalRy,2)} kN</strong></div>
      </div>
      ${critM ? `<div style="margin-top:6px;font-size:11px;color:#888;">Critical M: <strong style="color:#1565c0;">B${critM.id}</strong> — ${fmt(Math.max(Math.abs(critM.M1),Math.abs(critM.M2)),2)} kNm</div>` : ''}
      ${critV ? `<div style="font-size:11px;color:#888;">Critical V: <strong style="color:#e53935;">B${critV.id}</strong> — ${fmt(Math.max(Math.abs(critV.V1),Math.abs(critV.V2)),2)} kN</div>` : ''}
    </div>` : ''}
  </div>
</div>

${topMembers.length > 0 ? `
<div class="full-col card">
  <h3>🏗 Critical Members (top ${topMembers.length} by η)</h3>
  <table class="sum-table">
    <tr><th>Member</th><th>Section</th><th>Length</th><th>Utilization η</th><th>Status</th></tr>
    ${topMemberRows}
  </table>
</div>` : ''}

${svgCanvas ? `
<div class="full-col card">
  <h3>🗺 Structural Model</h3>
  <img src="${svgCanvas}" alt="Structural model" style="max-width:100%;border-radius:6px;border:1px solid #ddd;"/>
</div>` : ''}

<div class="full-col card" style="background:#f8f9ff;border:1px solid #c5cae9;">
  <h3>ℹ Design Basis — ${codeLabel(code)}</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px;line-height:1.7;">
    <div>
      <strong>Method:</strong> Direct Stiffness Method (2D/3D Frame)<br>
      <strong>Code:</strong> ${codeLabel(code)}<br>
      <strong>Partial factors:</strong> ${codePartialFactors(code)}
    </div>
    <div>
      <strong>Checks performed:</strong><br>
      ${codeChecklist(code).slice(0,3).map(c=>`• ${c}`).join('<br>')}
    </div>
  </div>
  <p style="margin-top:10px;font-size:11px;color:#888;">
    ⚠ Engineer should independently verify all outputs before use in design.
    All calculations are based on linear-elastic analysis valid for small deformations.
  </p>
</div>

<!-- Footer -->
<div style="text-align:center;font-size:11px;color:#aaa;margin-top:12px;padding-top:8px;border-top:1px solid #eee;">
  Generated by FrameSolver — Summary Report &nbsp;|&nbsp; ${codeLabel(code)} &nbsp;|&nbsp; ${date}
</div>

</div><!-- .page -->
<script>
function downloadHTML() {
  const blob = new Blob([document.documentElement.outerHTML], {type:'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'summary-report.html';
  a.click();
}
<\/script>
</body>
</html>`;
  }

  // ── Conclusions builder ────────────────────────────────────────────────────
  function buildConclusions(nodes, beams, sections, results, designResults, designCode) {
    const ef = results?.elemForces || [];
    const maxM = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.M1), Math.abs(e.M2)))) : 0;
    const maxV = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.V1), Math.abs(e.V2)))) : 0;
    const maxN = ef.length ? Math.max(...ef.map(e => Math.max(Math.abs(e.N1), Math.abs(e.N2)))) : 0;
    const maxBMbeam  = ef.length ? ef.reduce((a,b) => Math.max(Math.abs(a.M1),Math.abs(a.M2)) >= Math.max(Math.abs(b.M1),Math.abs(b.M2)) ? a : b) : null;

    const code = designCode || 'EC3';
    let ds = '';
    if (designResults) {
      const { byBeam, summary } = designResults;
      const fails = byBeam.filter(b => b.overall === 'FAIL');
      const near  = byBeam.filter(b => b.overall === 'NEAR');
      const maxEtaBeam = byBeam.reduce((a,b) => a.maxEta >= b.maxEta ? a : b, {maxEta:0});
      ds = `
        <li>${summary.pass} member(s) <strong style="color:#2e7d32;">PASS</strong> all ${codeLabel(code)} checks,
            ${summary.near} are <strong style="color:#e65100;">NEAR</strong> the limit (η&nbsp;&gt;&nbsp;0.85),
            ${summary.fail} <strong style="color:#c62828;">FAIL</strong>.</li>
        ${maxEtaBeam.label ? `<li>Critical member: <strong>${maxEtaBeam.label}</strong> (${maxEtaBeam.secName}) — η = ${maxEtaBeam.maxEta.toFixed(3)} [${maxEtaBeam.overall}].</li>` : ''}
        ${fails.length ? `<li style="color:#c62828;">⚠ Members requiring resizing: ${fails.map(b=>b.label).join(', ')}.</li>` : '<li>✓ All checked members are structurally adequate.</li>'}
        ${near.length ? `<li style="color:#e65100;">Members near capacity (check serviceability): ${near.map(b=>b.label).join(', ')}.</li>` : ''}`;
    }

    return `
      <ul style="line-height:1.9;padding-left:20px;font-size:13px;">
        <li>Structure comprises <strong>${nodes.length} nodes</strong>, <strong>${beams.length} members</strong>,
            <strong>${sections.length} section type(s)</strong>.</li>
        ${ef.length ? `
        <li>Maximum bending moment: <strong>${fmt(maxM)} kNm</strong>
            ${maxBMbeam ? `in member B${maxBMbeam.id}` : ''}.</li>
        <li>Maximum shear force: <strong>${fmt(maxV)} kN</strong>.</li>
        <li>Maximum axial force: <strong>${fmt(maxN)} kN</strong>.</li>` : '<li>No analysis results available.</li>'}
        ${ds}
        <li>Analysis method: <strong>Direct Stiffness Method (2D/3D Frame)</strong>, ${codeLabel(code)}.</li>
      </ul>`;
  }

  // ── Full HTML report ───────────────────────────────────────────────────────
  function generate(options) {
    const {
      title       = 'Structural Analysis Report',
      projectName = 'Untitled Project',
      engineer    = '',
      date        = new Date().toLocaleDateString(),
      company     = '',
      nodes       = [],
      beams       = [],
      sections    = [],
      loads       = [],
      results     = null,
      designResults = null,
      loadCases   = [],
      svgCanvas   = null,    // optional: current canvas SVG as data URI
      designCode  = 'EC3',   // 'EC3' | 'EC2' | 'ACI'
      spectrum    = null     // ResponseSpectrum.run() result, if one was run
    } = options;
    const code = designCode || 'EC3';

    const ef = results?.elemForces || [];
    const ds = buildChartDatasets(ef);

    // Per-beam diagrams (up to 10 shown inline)
    const beamDiagrams = ef.slice(0, 12).map(e => `
      <div style="margin-bottom:18px;padding:12px;background:#fafafa;border:1px solid #ddd;border-radius:8px;">
        <div style="font-weight:700;color:#333;margin-bottom:6px;">Beam B${e.id}
          — L=${fmt(e.L)} m | N=${fmt(e.N1)} kN | V=${fmt(e.V1)} kN | M=${fmt(Mstart(e))} kNm
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${beamDiagramSVG(e, 'BMD')}
          ${beamDiagramSVG(e, 'SFD')}
          ${beamDiagramSVG(e, 'NFD')}
        </div>
        <div style="font-size:11px;color:#888;margin-top:4px;">
          M₁=${fmt(Mstart(e))} kNm, M₂=${fmt(Mend(e))} kNm | V₁=${fmt(e.V1)} kN, V₂=${fmt(e.V2)} kN | N₁=${fmt(e.N1)} kN
        </div>
      </div>`).join('');

    // Per-beam design check details
    const beamChecks = (designResults?.byBeam || []).map(b => {
      const checkBlocks = b.checks.map(checkDetail).join('');
      return `
        <div style="margin-bottom:24px;border:2px solid ${STATUS_COLOR[b.overall]}55;border-radius:10px;overflow:hidden;">
          <div style="padding:10px 16px;background:${STATUS_BG[b.overall]};display:flex;justify-content:space-between;align-items:center;">
            <div>
              <span style="font-size:16px;font-weight:700;">${b.label}</span>
              <span style="margin-left:10px;font-size:13px;color:#555;">
                ${b.secName} &nbsp;|&nbsp; L=${fmt(b.L)} m &nbsp;|&nbsp; Class ${b.cls}
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${etaBar(b.maxEta, b.overall)}
              ${statusChip(b.overall)}
            </div>
          </div>
          <div style="padding:14px 16px;">
            ${checkBlocks}
          </div>
        </div>`;
    }).join('');

    // Chart.js script (embedded)
    const chartScript = ef.length > 0 ? `
      <script>
        (function() {
          const labels = ${JSON.stringify(ds.labels)};
          const bmd    = ${JSON.stringify(ds.bmd)};
          const sfd    = ${JSON.stringify(ds.sfd)};
          const nfd    = ${JSON.stringify(ds.nfd)};

          function makeChart(id, label, data, color) {
            const ctx = document.getElementById(id);
            if (!ctx) return;
            new Chart(ctx, {
              type: 'bar',
              data: {
                labels,
                datasets: [{
                  label,
                  data,
                  backgroundColor: color + '99',
                  borderColor:     color,
                  borderWidth:     1.5,
                  borderRadius:    4
                }]
              },
              options: {
                responsive: true,
                plugins: { legend: { display: false },
                  title: { display: true, text: label, font: { size: 13 } } },
                scales: { y: { beginAtZero: true } }
              }
            });
          }

          makeChart('chart-bmd', 'Max Bending Moment (kNm)', bmd, '#1565c0');
          makeChart('chart-sfd', 'Max Shear Force (kN)',      sfd, '#e53935');
          makeChart('chart-nfd', 'Max Axial Force (kN)',      nfd, '#2e7d32');
        })();
      </script>` : '';

    // Equilibrium check
    let eqCheck = '';
    // An envelope is not a single equilibrium state — each component is the
    // worst across different combinations — so ΣF will not close and reporting
    // a FAIL there would be meaningless.
    // ── Elastic critical load factors (P-Δ runs only) ────────────────────
    // criticalLoadFactors() lives in pdelta.js and had never been surfaced
    // anywhere. λcr is the factor the current axial forces would have to be
    // multiplied by to reach Euler buckling, so it is only meaningful once the
    // second-order axial forces exist — which is why it rides with the P-Δ run.
    let bucklingBlock = '';
    if (Array.isArray(results?.buckling) && results.buckling.length) {
      const risky = results.buckling
        // Only members actually in compression can buckle. Without this the
        // table fills with rows of λcr = ∞ for every tie and tension member,
        // which buries the two or three that matter.
        .filter(b => b && isFinite(b.lambda_cr) && b.N_comp > 0.001)
        .sort((a, b) => a.lambda_cr - b.lambda_cr)
        .slice(0, 12);
      if (!risky.length) {
        bucklingBlock = `
          <h2>Elastic Critical Load Factors (P-Δ)</h2>
          <p style="font-size:12px;color:#555">No member carries compression in this
          load case, so member buckling does not arise.</p>`;
      } else {
        const rows = risky.map(b => {
          const col = b.risk === 'HIGH' ? '#c62828'
                    : b.risk === 'MODERATE' ? '#e65100' : '#2e7d32';
          return `<tr><td>${b.beamId}</td><td>${fmt(b.N_comp, 1)}</td>` +
                 `<td>${fmt(b.Ncr, 1)}</td><td>${b.lambda_cr >= 999 ? '∞' : fmt(b.lambda_cr, 2)}</td>` +
                 `<td style="color:${col};font-weight:700">${b.risk}</td></tr>`;
        }).join('');
        bucklingBlock = `
          <h2>Elastic Critical Load Factors (P-Δ)</h2>
          <p style="font-size:12px;color:#555;margin:0 0 6px">
            λcr = N<sub>cr</sub> / N<sub>Ed</sub> per member, Euler pinned-pinned about the
            strong axis. A sway frame is normally expected to reach λcr ≥ 10;
            below about 3 the second-order effects dominate the design.
            Members in tension are omitted.</p>
          <table><thead><tr><th>Member</th><th>N<sub>Ed</sub> (kN)</th>
            <th>N<sub>cr</sub> (kN)</th><th>λ<sub>cr</sub></th><th>Risk</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
      }
    }

    // ── Response spectrum (only when one has been run) ───────────────────
    // Passed in separately from `results` because it is its own analysis, not
    // a property of the static load case being reported.
    let spectrumBlock = '';
    if (spectrum && spectrum.success && Array.isArray(spectrum.modes)) {
      const modeRows = spectrum.modes.map(m => {
        const cum = m.cumMassPct >= 90 ? 'color:#2e7d32;font-weight:700' : '';
        return `<tr><td>${m.modeNum}</td><td>${fmt(m.period, 4)}</td>` +
               `<td>${fmt(m.freq, 3)}</td><td>${fmt(m.SaG, 4)}</td>` +
               `<td>${fmt(m.massPct, 1)}</td><td style="${cum}">${fmt(m.cumMassPct, 1)}</td>` +
               `<td>${fmt(m.baseShear, 2)}</td></tr>`;
      }).join('');

      // Ranked by combined moment. The sign is gone, so magnitude is all there
      // is to rank on, and the largest few are what gets checked first.
      //
      // A space frame carries torsion and a second bending plane as well. The
      // spectrum combines them, and printing only the 2D aliases would leave a
      // twisting mode's whole effect out of the report that documents it.
      const sp3 = !!spectrum.is3D;
      const memHead = sp3
        ? '<th>Member</th><th>|N| (kN)</th><th>|V<sub>y</sub>| (kN)</th>' +
          '<th>|V<sub>z</sub>| (kN)</th><th>|T| (kNm)</th>' +
          '<th>|M<sub>y</sub>| (kNm)</th><th>|M<sub>z</sub>| (kNm)</th>'
        : '<th>Member</th><th>|N| (kN)</th><th>|V| (kN)</th><th>|M| (kNm)</th>';
      const pair = (e, a, b) => Math.max(e[a] || 0, e[b] || 0);
      const memRows = spectrum.elemForces.slice()
        .sort((a, b) => Math.max(b.M1, b.M2) - Math.max(a.M1, a.M2))
        .slice(0, 15)
        .map(e => sp3
          ? `<tr><td>${e.id}</td><td>${fmt(pair(e, 'N1', 'N2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'Vy1', 'Vy2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'Vz1', 'Vz2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'Tx1', 'Tx2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'My1', 'My2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'Mz1', 'Mz2'), 2)}</td></tr>`
          : `<tr><td>${e.id}</td><td>${fmt(pair(e, 'N1', 'N2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'V1', 'V2'), 2)}</td>` +
            `<td>${fmt(pair(e, 'M1', 'M2'), 2)}</td></tr>`).join('');

      const sp = spectrum.spectrum || {};
      const params = sp.code && sp.code.indexOf('1998') >= 0
        ? `a<sub>g</sub> = ${fmt(sp.ag, 3)} g, S = ${fmt(sp.S, 2)}, ` +
          `T<sub>B</sub> = ${fmt(sp.TB, 2)} s, T<sub>C</sub> = ${fmt(sp.TC, 2)} s, ` +
          `T<sub>D</sub> = ${fmt(sp.TD, 2)} s, q = ${fmt(sp.q, 2)}`
        : `S<sub>DS</sub> = ${fmt(sp.Sds, 3)} g, S<sub>D1</sub> = ${fmt(sp.Sd1, 3)} g, ` +
          `T<sub>L</sub> = ${fmt(sp.TL, 1)} s, R = ${fmt(spectrum.R, 2)}, ` +
          `I<sub>e</sub> = ${fmt(spectrum.Ie, 2)}`;

      spectrumBlock = `
        <h2>Response Spectrum Analysis</h2>
        <p style="font-size:12px;color:#555;margin:0 0 6px">
          ${sp.code || 'Custom spectrum'} &mdash; ${params}.<br>
          ${sp3 ? 'Space frame, e' : 'E'}xcitation in ${spectrum.direction},
          ${spectrum.modeCount} modes combined by
          ${spectrum.rule} at &zeta; = ${fmt(spectrum.damping * 100, 1)}%.
          Base shear <strong>${fmt(spectrum.baseShear, 2)} kN</strong>,
          participating mass ${fmt(spectrum.massCaptured, 1)}% of
          ${fmt(spectrum.totalMass, 2)} kN&middot;s&sup2;/m.</p>
        ${spectrum.elf ? `
        <p style="font-size:12px;color:#555;margin:0 0 6px">
          <strong>Equivalent lateral force (§12.8):</strong>
          ${spectrum.elf.system}, h<sub>n</sub> = ${fmt(spectrum.elf.hn, 2)} m,
          T<sub>a</sub> = ${fmt(spectrum.elf.Ta, 3)} s, C<sub>u</sub>T<sub>a</sub> =
          ${fmt(spectrum.elf.Tmax, 3)} s, T = ${fmt(spectrum.elf.T, 3)} s
          ${spectrum.elf.periodCapped ? '(capped from ' + fmt(spectrum.elf.Tcomputed, 3) + ' s)' : ''}.<br>
          C<sub>s</sub> = ${fmt(spectrum.elf.Cs, 4)} governed by ${spectrum.elf.governedBy},
          W = ${fmt(spectrum.elf.W, 1)} kN, V<sub>ELF</sub> =
          <strong>${fmt(spectrum.elf.V, 2)} kN</strong>.
          §12.9.1.4 factor applied: <strong>${fmt(spectrum.scaleFactor, 3)}</strong>.</p>` : ''}
        <table><thead><tr><th>Mode</th><th>T (s)</th><th>f (Hz)</th>
          <th>S<sub>a</sub> (g)</th><th>Mass %</th><th>&Sigma;Mass %</th>
          <th>V (kN)</th></tr></thead><tbody>${modeRows}</tbody></table>
        <h3 style="font-size:13px;margin:10px 0 4px">Largest combined member forces</h3>
        <table><thead><tr>${memHead}</tr></thead><tbody>${memRows}</tbody></table>
        ${(spectrum.notes || []).map(n =>
          `<p style="font-size:11px;color:#666;border-left:3px solid #ff9800;` +
          `padding-left:7px;margin:5px 0">${n}</p>`).join('')}`;
    }

    if (results?.isEnvelope) {
      eqCheck = `
        <div style="padding:8px 14px;background:#fff8e1;border-radius:6px;font-size:13px;">
          <strong>Equilibrium Check:</strong> not applicable to an envelope —
          each force component is the worst of ${results.sourceCount} combination(s),
          so they do not belong to one load state. Select an individual
          combination to verify equilibrium.
        </div>`;
    } else if (results?.reactions) {
      let sumRx = 0, sumRy = 0;
      let sumFx = 0, sumFy = 0;

      // 3D results report the vertical as Rz (Ry is the depth direction).
      const is3D = !!results.is3D;
      Object.values(results.reactions).forEach(r => {
        sumRx += r.Rx || 0;
        sumRy += (is3D ? r.Rz : r.Ry) || 0;
      });

      // Applied load must include MEMBER loads, not just nodal ones. Only
      // nodal loads were summed here, while the reactions on the other side of
      // the comparison carry the whole loading — so any model with a
      // distributed load (which is most of them) reported ΣFy equal to the
      // full reaction total and printed "⚠ Check loads/reactions" on a
      // perfectly balanced analysis. The default 3-bay frame showed
      // ΣFy = −199.92 kN and a FAIL chip while being in exact equilibrium.
      //
      // Member lengths come from elemForces, which is the same length the
      // solver integrated the load over.
      const lenOf = {};
      for (const ef of (results.elemForces || [])) lenOf[ef.id] = ef.L;

      for (const l of loads) {
        if (l.type === 'nodal' || l.type === 'moment') {
          sumFx += l.fx || 0; sumFy += l.fy || 0;
          continue;
        }
        const L = lenOf[l.elementId];
        if (!L) continue;                       // load on a member that did not solve
        if (l.type === 'beam_dist') {
          sumFx += (l.fx || 0) * L;  sumFy += (l.fy || 0) * L;
        } else if (l.type === 'beam_trap') {
          const fx2 = l.fx2 !== undefined ? l.fx2 : (l.fx || 0);
          const fy2 = l.fy2 !== undefined ? l.fy2 : (l.fy || 0);
          sumFx += ((l.fx || 0) + fx2) / 2 * L;
          sumFy += ((l.fy || 0) + fy2) / 2 * L;
        } else if (l.type === 'beam_point') {
          sumFx += l.fx || 0; sumFy += l.fy || 0;
        }
      }

      // Scale the tolerance with the size of the loading — a fixed 0.5 kN is
      // meaningless on a 20 MN structure and punitive on a 2 kN one.
      const scale = Math.max(Math.abs(sumFx), Math.abs(sumFy), 1);
      const tol   = Math.max(0.5, scale * 1e-4);
      const ok = Math.abs(sumRx + sumFx) < tol && Math.abs(sumRy + sumFy) < tol;
      eqCheck = `
        <div style="padding:8px 14px;background:${ok?'#e8f5e9':'#ffebee'};border-radius:6px;font-size:13px;">
          <strong>Equilibrium Check:</strong>
          ΣFx = ${fmt(sumRx+sumFx,4)} kN &nbsp;|&nbsp;
          ΣFy = ${fmt(sumRy+sumFy,4)} kN &nbsp;|&nbsp;
          ${statusChip(ok?'OK':'FAIL', ok?'✓ Equilibrium satisfied':'⚠ Check loads/reactions')}
        </div>`;
    }

    // Build TOC entries
    const tocSections = [
      ['0', 'sec-intro',   'Introduction'],
      ['1', 'sec-model',   'Model Summary'],
      ['2', 'sec-results', 'Analysis Results'],
    ];
    if (ef.length > 0) {
      tocSections.push(['3', 'sec-charts',  'Force Distribution Charts']);
      tocSections.push(['4', 'sec-diagrams','Member BMD / SFD / NFD Diagrams']);
    }
    tocSections.push(['5', 'sec-design',  `Design Checks (${codeLabel(code)})`]);
    tocSections.push(['6', 'sec-concl',   'Conclusions']);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #222; background: #f5f5f5; }
  .page { max-width: 1100px; margin: 0 auto; background: #fff; padding: 32px 40px; box-shadow: 0 2px 12px #0002; }
  .rpt-header { border-bottom: 3px solid #1565c0; padding-bottom: 16px; margin-bottom: 24px; }
  .rpt-header h1 { font-size: 26px; color: #1565c0; }
  .rpt-header .meta { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: #555; }
  .rpt-section { margin-bottom: 28px; scroll-margin-top: 16px; }
  .rpt-section h2 { font-size: 17px; color: #1565c0; border-bottom: 1px solid #1565c020; padding-bottom: 4px; margin-bottom: 12px; }
  .rpt-section h3 { font-size: 14px; color: #333; margin: 10px 0 6px; }
  .rpt-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
  .rpt-table th { background: #1565c0; color: #fff; padding: 6px 10px; text-align: left; }
  .rpt-table td { padding: 5px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
  .rpt-table tr:nth-child(even) td { background: #f8f9ff; }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .chart-box { background: #fafafa; border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; padding: 16px; max-width: none; }
    .no-print { display: none !important; }
    .rpt-section { page-break-inside: avoid; }
    .check-block { page-break-inside: avoid; }
    .page::after {
      content: counter(page);
      position: fixed; bottom: 10px; right: 16px;
      font-size: 11px; color: #999;
    }
    body { counter-reset: page; }
  }
  .edit-indicator { opacity: 0.5; font-size: 11px; cursor: pointer; }
  [contenteditable]:hover { outline: 2px dashed #1565c055; outline-offset: 2px; border-radius: 3px; }
  [contenteditable]:focus { outline: 2px solid #1565c0; outline-offset: 2px; border-radius: 3px; }
  .intro-box { background:#f8f9ff;border:1px solid #c5cae9;border-radius:8px;padding:14px 18px;font-size:13px;line-height:1.7; }
  .intro-box ul { padding-left:18px; }
  .struct-img { max-width:100%;border:1px solid #ddd;border-radius:8px;margin-top:10px; }
</style>
</head>
<body>
<div class="page">

  <!-- ── Toolbar ─────────────────────────────────────────────────────────── -->
  <div class="no-print" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
    <button onclick="window.print()"
      style="padding:7px 16px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">
      🖨 Print / Save PDF
    </button>
    <button onclick="downloadHTML()"
      style="padding:7px 16px;background:#2e7d32;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">
      ⬇ Download HTML
    </button>
    <span style="color:#888;font-size:12px;">Click any blue text to edit. Changes stay in this window only.</span>
  </div>

  <!-- ── Header ─────────────────────────────────────────────────────────── -->
  <div class="rpt-header">
    <h1 id="rpt-title" contenteditable="true">${title}</h1>
    <div class="meta">
      <span>📁 Project: <strong id="rpt-proj" contenteditable="true">${projectName}</strong></span>
      <span>👷 Engineer: <strong id="rpt-eng" contenteditable="true">${engineer || 'N/A'}</strong></span>
      <span>🏢 Company: <strong id="rpt-co" contenteditable="true">${company || 'N/A'}</strong></span>
      <span>📅 Date: <strong id="rpt-date" contenteditable="true">${date}</strong></span>
      <span>⚙ Software: <strong>FrameSolver v1 (DSM)</strong></span>
    </div>
  </div>

  <!-- ── Table of Contents ──────────────────────────────────────────────── -->
  ${buildTOC(tocSections)}

  <!-- ── §0 Introduction ────────────────────────────────────────────────── -->
  <div class="rpt-section" id="sec-intro">
    <h2>0. Introduction</h2>
    <div class="intro-box">
      <p>This report presents the results of a <strong>linear-elastic 2D structural frame analysis</strong>
         carried out using the <strong>Direct Stiffness Method (Matrix Stiffness Method)</strong>.
         Member forces, nodal displacements and support reactions have been computed for the applied loading,
         and where design data is available, member adequacy has been verified against
         <strong>${codeLabel(code)}</strong>.</p>
      <br>
      <p><strong>Scope of checks performed:</strong></p>
      <ul>
        ${codeChecklist(code).map(c=>`<li>${c}</li>`).join('\n        ')}
      </ul>
      <br>
      <p><strong>Design partial factors:</strong> ${codePartialFactors(code)}</p>
      ${svgCanvas ? `
      <p style="margin-top:10px;font-weight:600;">Structural Model:</p>
      <img src="${svgCanvas}" alt="Structural model" class="struct-img"/>` : ''}
    </div>
  </div>

  <!-- ── Model Summary ──────────────────────────────────────────────────── -->
  <div class="rpt-section" id="sec-model">
    <h2>1. Model Summary</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px;">
      ${[
        ['Nodes', nodes.length], ['Beams', beams.length], ['Sections', sections.length],
        ['Loads', loads.length], ['Load Cases', loadCases.length],
        ['Supports', nodes.filter(n=>n.support&&n.support!=='none').length]
      ].map(([k,v])=>`
        <div style="background:#e3f2fd;border-radius:8px;padding:10px 14px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#1565c0;">${v}</div>
          <div style="font-size:11px;color:#555;">${k}</div>
        </div>`).join('')}
    </div>

    <h3>1.1 Node Coordinates</h3>
    <table class="rpt-table">
      <tr><th>Node</th><th>X (m)</th><th>Y (m)</th><th>Support</th></tr>
      ${nodes.map(n=>`<tr><td>N${n.id}</td><td>${fmt(n.x)}</td><td>${fmt(n.y)}</td>
        <td>${n.support||'none'}</td></tr>`).join('')}
    </table>

    <h3>1.2 Beam Connectivity</h3>
    <table class="rpt-table">
      <tr><th>Beam</th><th>Node i</th><th>Node j</th><th>Section</th><th>L (m)</th></tr>
      ${beams.map(b=>{
        const ni = nodes.find(n=>n.id===b.node1), nj = nodes.find(n=>n.id===b.node2);
        const sec = sections.find(s=>s.id===b.sectionId);
        const L = ni && nj ? Math.hypot(nj.x-ni.x, nj.y-ni.y).toFixed(3) : '—';
        return `<tr><td>${b.label||'B'+b.id}</td><td>N${b.node1}</td><td>N${b.node2}</td>
          <td>${sec?sec.name:'?'}</td><td>${L}</td></tr>`;
      }).join('')}
    </table>

    <h3>1.3 Sections</h3>
    <table class="rpt-table">
      <tr><th>ID</th><th>Name</th><th>E (GPa)</th><th>A (cm²)</th><th>I (cm⁴)</th><th>fᵧ (MPa)</th></tr>
      ${sections.map(s=>`<tr><td>${s.id}</td><td>${s.name||'—'}</td>
        <td>${fmt(s.E,0)}</td><td>${fmt(s.A,2)}</td>
        <td>${fmt(s.I||s.Ix,1)}</td><td>${fmt(s.fy,0)}</td></tr>`).join('')}
    </table>

    <h3>1.4 Loads</h3>
    <table class="rpt-table">
      <tr><th>#</th><th>Type</th><th>Applied To</th><th>Fx / wy1</th><th>Fy / wy2</th><th>M / Pos</th><th>Case</th></tr>
      ${loads.map((l,i)=>{
        const cname = loadCases.find(c=>c.id===l.caseId)?.name || 'Case 1';
        const target = l.nodeId ? 'N'+l.nodeId : l.elementId ? 'B'+l.elementId : '—';
        return `<tr>
          <td>${i+1}</td><td>${l.type||'—'}</td><td>${target}</td>
          <td>${fmt(l.fx||l.fy,3)}</td>
          <td>${l.fy2!==undefined?fmt(l.fy2,3):'—'}</td>
          <td>${l.m!==undefined?fmt(l.m,3):l.pos!==undefined?fmt(l.pos,3):'—'}</td>
          <td>${cname}</td></tr>`;
      }).join('')}
    </table>
  </div>

  <!-- ── Analysis Results ────────────────────────────────────────────────── -->
  <div class="rpt-section" id="sec-results">
    <h2>2. Analysis Results</h2>

    ${!results ? '<p style="color:#e53935;">⚠ No analysis results. Run Solve first.</p>' : `

    ${bucklingBlock}
    ${spectrumBlock}
    ${eqCheck}

    <h3>2.1 Support Reactions</h3>
    ${reactTable(results.reactions, nodes)}

    <h3>2.2 Nodal Displacements</h3>
    ${dispTable(results.disp, nodes)}

    <h3>2.3 Member End Forces</h3>
    ${memberForceTable(ef)}
    `}
  </div>

  <!-- ── Charts ─────────────────────────────────────────────────────────── -->
  ${ef.length > 0 ? `
  <div class="rpt-section" id="sec-charts">
    <h2>3. Force Distribution Charts</h2>
    <div class="charts-grid">
      <div class="chart-box">
        <canvas id="chart-bmd" height="200"></canvas>
      </div>
      <div class="chart-box">
        <canvas id="chart-sfd" height="200"></canvas>
      </div>
      <div class="chart-box">
        <canvas id="chart-nfd" height="200"></canvas>
      </div>
    </div>
  </div>` : ''}

  <!-- ── Member Diagrams ────────────────────────────────────────────────── -->
  ${ef.length > 0 ? `
  <div class="rpt-section" id="sec-diagrams">
    <h2>4. Member BMD / SFD / NFD Diagrams</h2>
    ${beamDiagrams}
  </div>` : ''}

  <!-- ── Design Checks ──────────────────────────────────────────────────── -->
  <div class="rpt-section" id="sec-design">
    <h2>5. Design Checks (${codeLabel(code)})</h2>
    <h3>5.1 Summary</h3>
    ${designSummaryTable(designResults)}
    <h3 style="margin-top:16px;">5.2 Utilization Spectrum</h3>
    ${utilizationSpectrum(designResults)}
    <h3 style="margin-top:16px;">5.3 Detailed Checks per Member</h3>
    ${designResults ? beamChecks : '<p style="color:#888;">Run design checks to populate this section.</p>'}
  </div>

  <!-- ── Conclusions ────────────────────────────────────────────────────── -->
  <div class="rpt-section" id="sec-concl">
    <h2>6. Conclusions</h2>
    <div class="intro-box">
      ${buildConclusions(nodes, beams, sections, results, designResults, code)}
      <br>
      <p style="color:#888;font-size:12px;">
        All calculations performed using linear-elastic analysis. Results are valid for small deformations.
        Engineer should independently verify all outputs before use in design.
      </p>
    </div>
  </div>

  <!-- ── Footer ─────────────────────────────────────────────────────────── -->
  <div style="margin-top:40px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#999;display:flex;justify-content:space-between;">
    <span id="rpt-footer" contenteditable="true">Generated by FrameSolver — Direct Stiffness Method | ${codeLabel(code)}</span>
    <span>Prepared: ${date}</span>
  </div>

</div><!-- .page -->

${chartScript}
<script>
function downloadHTML() {
  const blob = new Blob([document.documentElement.outerHTML], {type: 'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('rpt-title').textContent || 'report') + '.html';
  a.click();
}
<\/script>
</body>
</html>`;
  }

  // ── Open full report in a new window ──────────────────────────────────────
  function openInWindow(options) {
    const html = generate(options);
    const win  = window.open('', '_blank', 'width=1200,height=900,scrollbars=yes');
    if (!win) { alert('Pop-up blocked. Please allow pop-ups and try again.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // ── Open summary report in a new window ───────────────────────────────────
  function openSummaryInWindow(options) {
    const html = generateSummary(options);
    const win  = window.open('', '_blank', 'width=1050,height=800,scrollbars=yes');
    if (!win) { alert('Pop-up blocked. Please allow pop-ups and try again.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  return { generate, generateSummary, openInWindow, openSummaryInWindow, buildChartDatasets,
           codeRef,        // clause lookup (ACI/EC2/EC3) — used by report consumers
           beamDiagramSVG, // exported so the sampled internal forces are testable
           sampleInternalForces };

})();

window.ReportGenerator = ReportGenerator;
