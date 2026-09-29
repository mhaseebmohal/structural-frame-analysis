// ══════════════════════════════════════════════════════════════════════════════
//  mohrs_circle.js  —  2-D Mohr's Circle & Principal Stress Calculator
//  Inputs : σx, σy, τxy  (any consistent unit — MPa recommended)
//  Outputs: σ1, σ2, τmax, θp, von-Mises σVM
//  Ref    : Mechanics of Materials (Hibbeler / Beer-Johnston)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const MohrsCircle = (() => {

  // ── Core computation ───────────────────────────────────────────────────────
  function compute(sx, sy, txy) {
    const c   = (sx + sy) / 2;
    const R   = Math.sqrt(((sx - sy) / 2) ** 2 + txy ** 2);
    const s1  = c + R;
    const s2  = c - R;
    const tmax = R;
    // Angle from x-face to principal plane (anti-clockwise positive), degrees
    const tp  = 0.5 * Math.atan2(2 * txy, sx - sy) * 180 / Math.PI;
    const tp2 = tp >= 0 ? tp - 90 : tp + 90;   // second principal plane
    // Centre shear stress at σ_avg
    const s_avg = c;
    // Von Mises (plane stress σz=0)
    const vm  = Math.sqrt(s1 ** 2 - s1 * s2 + s2 ** 2);
    // Max shear centre occurs at σ = c
    return { sx, sy, txy, c, R, s1, s2, tmax, tp, tp2, s_avg, vm };
  }

  // ── SVG circle diagram ─────────────────────────────────────────────────────
  function buildSVG(r, W = 340, H = 260) {
    const { c, R, s1, s2, sx, sy, txy, tmax } = r;
    const pad  = 44;
    const avail = Math.min(W, H) / 2 - pad;
    const sc   = R > 1e-9 ? avail / R : avail;   // px per unit
    const ox   = W / 2;   // origin x (σ axis)
    const oy   = H / 2;   // origin y (τ axis)

    const toX = v => ox + (v - c) * sc;
    const toY = v => oy - v * sc;           // positive τ upward

    const L = [];
    const ln  = (x1,y1,x2,y2,attr='') => L.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ${attr}/>`);
    const dot = (x,y,col,rr=4)        => L.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr}" fill="${col}"/>`);
    const txt = (x,y,s,attr='')       => L.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" ${attr}>${s}</text>`);

    // Axes
    ln(pad, oy, W-pad, oy, `stroke="#aaa" stroke-width="1"`);
    ln(ox, pad, ox, H-pad, `stroke="#aaa" stroke-width="1"`);
    txt(W-pad+2, oy+4, 'σ', `fill="#888"`);
    txt(ox+3, pad-4,  'τ', `fill="#888"`);

    // Circle
    const rPx = R * sc;
    L.push(`<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="${Math.max(rPx,1).toFixed(1)}" fill="#e3f2fd" stroke="#1565C0" stroke-width="2"/>`);

    // Centre
    dot(ox, oy, '#1565C0', 3);
    txt(ox+4, oy-5, `C=${c.toFixed(1)}`, `fill="#1565C0"`);

    // Point A  (σx, +τxy)
    const ax = toX(sx), ay = toY(txy);
    dot(ax, ay, '#e53935');
    txt(ax+6, ay-3, `A(σx,τxy)`, `fill="#c62828"`);

    // Point B  (σy, -τxy)
    const bx = toX(sy), by = toY(-txy);
    dot(bx, by, '#2e7d32');
    txt(bx+6, by+12, `B(σy,−τxy)`, `fill="#2e7d32"`);

    // Diameter A-B
    ln(ax, ay, bx, by, `stroke="#aaa" stroke-width="1" stroke-dasharray="3,2"`);

    // Principal stress points on σ axis
    const p1x = toX(s1), p2x = toX(s2);
    L.push(`<circle cx="${p1x.toFixed(1)}" cy="${oy.toFixed(1)}" r="5" fill="none" stroke="#e65100" stroke-width="2"/>`);
    L.push(`<circle cx="${p2x.toFixed(1)}" cy="${oy.toFixed(1)}" r="5" fill="none" stroke="#e65100" stroke-width="2"/>`);
    txt(p1x+6, oy-8, `σ₁=${s1.toFixed(1)}`, `fill="#e65100"`);
    txt(p2x-6, oy-8, `σ₂=${s2.toFixed(1)}`, `fill="#e65100" text-anchor="end"`);

    // Max shear points (top & bottom of circle)
    const tmy = oy - rPx;
    L.push(`<circle cx="${ox.toFixed(1)}" cy="${tmy.toFixed(1)}" r="4" fill="none" stroke="#7b1fa2" stroke-width="2"/>`);
    txt(ox+6, tmy+2, `τmax=${tmax.toFixed(1)}`, `fill="#7b1fa2"`);

    // 2θp angle arc indicator
    if (R > 0.1) {
      const angA  = Math.atan2(-(ay - oy), ax - ox);   // angle from ox to A in SVG space
      const arcR  = Math.min(rPx * 0.35, 28);
      const sx2   = ox + arcR * Math.cos(angA);
      const sy2   = oy + arcR * Math.sin(angA);
      L.push(`<path d="M ${(ox + arcR).toFixed(1)} ${oy.toFixed(1)} A ${arcR.toFixed(1)} ${arcR.toFixed(1)} 0 0 ${angA > 0 ? 0 : 1} ${sx2.toFixed(1)} ${sy2.toFixed(1)}" fill="none" stroke="#ff6f00" stroke-width="1" stroke-dasharray="3,2"/>`);
      const angMid = angA / 2;
      txt(ox + (arcR+8)*Math.cos(angMid), oy + (arcR+8)*Math.sin(angMid), `2θp`, `fill="#e65100" font-size="9"`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:var(--bg-tbl-alt,#f5f5f5);border-radius:6px;display:block">${L.join('')}</svg>`;
  }

  // ── Results table HTML ─────────────────────────────────────────────────────
  function buildResultHTML(r) {
    const rows = [
      ['Centre C  = (σx+σy)/2', `${r.c.toFixed(3)}`, ''],
      ['Radius R', `${r.R.toFixed(3)}`, ''],
      ['σ₁  (max principal)', `${r.s1.toFixed(3)}`, '#c62828'],
      ['σ₂  (min principal)', `${r.s2.toFixed(3)}`, '#1565C0'],
      ['τ_max  = R', `${r.tmax.toFixed(3)}`, '#7b1fa2'],
      ['σ_avg  at τ_max face', `${r.s_avg.toFixed(3)}`, ''],
      ['θ_p  (to σ₁ plane)', `${r.tp.toFixed(2)}°`, ''],
      ['θ_p₂ (to σ₂ plane)', `${r.tp2.toFixed(2)}°`, ''],
      ['σ_VM  (von Mises)', `${r.vm.toFixed(3)}`, '#e65100'],
    ];
    return `<table style="border-collapse:collapse;width:100%;font-size:11px">
      ${rows.map((rw, i) => `<tr style="${i%2?'background:var(--bg-tbl-alt,#f5f5f5)':''}">
        <td style="padding:3px 6px;color:${rw[2]||'var(--text-sec)'};font-weight:${rw[2]?700:400}">${rw[0]}</td>
        <td style="padding:3px 6px;font-weight:700;color:${rw[2]||'var(--text)'}">${rw[1]}</td>
      </tr>`).join('')}
    </table>`;
  }

  // ── Dialog HTML (injected into modal body) ─────────────────────────────────
  function buildDialogHTML() {
    return `
<div style="display:grid;grid-template-columns:240px 1fr;gap:12px;align-items:start">
  <!-- Left: inputs + results -->
  <div>
    <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">Stress State</div>
    <div class="form-row"><label style="width:110px">σ<sub>x</sub></label><input type="number" id="mc-sx"  value="80"  step="5" style="width:80px"> <span style="font-size:11px;color:#888;margin-left:4px">MPa</span></div>
    <div class="form-row"><label style="width:110px">σ<sub>y</sub></label><input type="number" id="mc-sy"  value="-40" step="5" style="width:80px"> <span style="font-size:11px;color:#888;margin-left:4px">MPa</span></div>
    <div class="form-row"><label style="width:110px">τ<sub>xy</sub></label><input type="number" id="mc-txy" value="30"  step="5" style="width:80px"> <span style="font-size:11px;color:#888;margin-left:4px">MPa</span></div>
    <div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn-xs btn-blue" id="mc-calc">&#9654; Calculate</button>
      <button class="btn-xs" id="mc-copy">&#128203; Copy</button>
    </div>
    <div id="mc-results">
      <p style="color:#888;font-size:11px">Click Calculate.</p>
    </div>
  </div>
  <!-- Right: Mohr's circle SVG -->
  <div id="mc-diagram" style="display:flex;align-items:center;justify-content:center;min-height:200px">
    <p style="color:#888;font-size:11px">Diagram appears after calculation.</p>
  </div>
</div>
<div style="margin-top:10px;padding:8px;background:var(--bg-tbl-alt);border-radius:5px;font-size:10px;color:var(--text-sec);border:1px solid var(--border-tbl)">
  <b>Sign convention:</b> Normal stresses positive in tension. Shear stress τxy positive when acting upward on the right face.
  θp = angle from x-axis to σ₁ plane (CCW positive). τ_max acts on faces at 45° to principal planes.
</div>`;
  }

  // ── Wire dialog events ─────────────────────────────────────────────────────
  function wireDialog() {
    let lastResult = null;

    const doCalc = () => {
      const sx  = parseFloat(document.getElementById('mc-sx').value)  || 0;
      const sy  = parseFloat(document.getElementById('mc-sy').value)  || 0;
      const txy = parseFloat(document.getElementById('mc-txy').value) || 0;
      lastResult = compute(sx, sy, txy);
      document.getElementById('mc-results').innerHTML = buildResultHTML(lastResult);
      document.getElementById('mc-diagram').innerHTML = buildSVG(lastResult, 340, 260);
    };

    document.getElementById('mc-calc').addEventListener('click', doCalc);

    // Enter key on any input triggers calculation
    ['mc-sx','mc-sy','mc-txy'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') doCalc();
      });
    });

    document.getElementById('mc-copy').addEventListener('click', () => {
      if (!lastResult) return;
      const r = lastResult;
      const txt = [
        `Mohr's Circle`,
        `Input:  σx=${r.sx}  σy=${r.sy}  τxy=${r.txy}  MPa`,
        `Centre  C = ${r.c.toFixed(3)} MPa`,
        `Radius  R = ${r.R.toFixed(3)} MPa`,
        `σ₁ = ${r.s1.toFixed(3)} MPa`,
        `σ₂ = ${r.s2.toFixed(3)} MPa`,
        `τmax = ${r.tmax.toFixed(3)} MPa`,
        `θp = ${r.tp.toFixed(2)}°`,
        `σVM = ${r.vm.toFixed(3)} MPa`
      ].join('\n');
      navigator.clipboard.writeText(txt).catch(() => {});
      if (window.App && App.toast) App.toast('Copied to clipboard', 'ok');
    });

    // Auto-run on open
    doCalc();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return { compute, buildSVG, buildDialogHTML, buildResultHTML, wireDialog };
})();

window.MohrsCircle = MohrsCircle;
