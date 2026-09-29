// ══════════════════════════════════════════════════════════════════════════════
//  compound_section.js  —  Compound Section Builder
//  Builds composite cross-sections from primitives using parallel axis theorem.
//  Inspired by PLANE (MarkPThomas/MPT.SE.CrossSection) repository approach.
//  Outputs: A, x̄, ȳ, Ix, Iy, Sx, Sy, rx, ry
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const CompoundSection = (() => {

  // ── Primitive property calculator (at own centroid) ────────────────────────
  function primitiveProps(s) {
    const cx = s.cx || 0, cy = s.cy || 0;
    let A = 0, Ix = 0, Iy = 0, xc = cx, yc = cy;

    if (s.type === 'rect') {
      A  = s.b * s.h;
      Ix = s.b * Math.pow(s.h, 3) / 12;
      Iy = s.h * Math.pow(s.b, 3) / 12;

    } else if (s.type === 'circle') {
      const r = s.d / 2;
      A = Math.PI * r * r;
      Ix = Iy = Math.PI * Math.pow(r, 4) / 4;

    } else if (s.type === 'hollow_rect') {
      A  = s.bo * s.ho - s.bi * s.hi;
      Ix = (s.bo * Math.pow(s.ho, 3) - s.bi * Math.pow(s.hi, 3)) / 12;
      Iy = (s.ho * Math.pow(s.bo, 3) - s.hi * Math.pow(s.bi, 3)) / 12;

    } else if (s.type === 'hollow_circle') {
      const ro = s.do / 2, ri = s.di / 2;
      A  = Math.PI * (ro * ro - ri * ri);
      Ix = Iy = Math.PI * (Math.pow(ro, 4) - Math.pow(ri, 4)) / 4;

    } else if (s.type === 'i_section') {
      // Built-up I: two flanges b×tf + web hw×tw
      const h = s.hw + 2 * s.tf;
      A  = 2 * s.b * s.tf + s.hw * s.tw;
      Ix = (s.b * Math.pow(h, 3) - (s.b - s.tw) * Math.pow(s.hw, 3)) / 12;
      Iy = (2 * s.tf * Math.pow(s.b, 3) + s.hw * Math.pow(s.tw, 3)) / 12;

    } else if (s.type === 'channel') {
      // C-channel: two flanges b×tf + web hw×tw (open on one side)
      const h = s.hw + 2 * s.tf;
      A  = 2 * s.b * s.tf + s.hw * s.tw;
      Ix = (s.b * Math.pow(h, 3) - (s.b - s.tw) * Math.pow(s.hw, 3)) / 12;
      // Shear centre x offset: for open channel, Iy computed about the web face
      const xcLocal = (2 * s.tf * s.b * s.b / 2 + s.hw * s.tw * s.tw / 2) / A;
      Iy = (2 * s.tf * Math.pow(s.b, 3) / 3 + s.hw * Math.pow(s.tw, 3) / 3) - A * xcLocal * xcLocal;
      xc = cx + xcLocal;

    } else if (s.type === 'tee') {
      // T-section: flange b×tf on top, stem tw×hs below
      const Af = s.b * s.tf, As = s.tw * s.hs;
      A = Af + As;
      const ycLocal = (Af * (s.hs + s.tf / 2) + As * (s.hs / 2)) / A;
      const Ixf = s.b * Math.pow(s.tf, 3) / 12 + Af * Math.pow(s.hs + s.tf / 2 - ycLocal, 2);
      const Ixs = s.tw * Math.pow(s.hs, 3) / 12 + As * Math.pow(s.hs / 2 - ycLocal, 2);
      Ix = Ixf + Ixs;
      Iy = s.tf * Math.pow(s.b, 3) / 12 + s.hs * Math.pow(s.tw, 3) / 12;
      yc = cy + ycLocal;
    }

    return { A, Ix, Iy, xc, yc };
  }

  // ── Compound section computation ───────────────────────────────────────────
  function compute(shapes) {
    if (!shapes || !shapes.length) return null;

    const comps = shapes.map(s => ({ ...primitiveProps(s), type: s.type, shape: s }));

    const A_total = comps.reduce((sum, c) => sum + c.A, 0);
    if (A_total <= 0) return null;

    const xbar = comps.reduce((sum, c) => sum + c.A * c.xc, 0) / A_total;
    const ybar = comps.reduce((sum, c) => sum + c.A * c.yc, 0) / A_total;

    // Parallel axis theorem for Ix and Iy about compound centroid
    let Ix = 0, Iy = 0;
    const details = comps.map(c => {
      const dx = c.xc - xbar;
      const dy = c.yc - ybar;
      const dIx = c.A * dy * dy;
      const dIy = c.A * dx * dx;
      Ix += c.Ix + dIx;
      Iy += c.Iy + dIy;
      return { ...c, dx, dy, dIx, dIy, Ix_total: c.Ix + dIx, Iy_total: c.Iy + dIy };
    });

    // Bounding box for extreme fibre distances
    const bounds = _bounds(shapes);
    const yTop_dist  = bounds.yTop  - ybar;
    const yBot_dist  = ybar - bounds.yBot;
    const xRgt_dist  = bounds.xRight - xbar;
    const xLft_dist  = xbar - bounds.xLeft;

    const Sx = Ix / Math.max(Math.max(yTop_dist, yBot_dist), 1e-10);
    const Sy = Iy / Math.max(Math.max(xRgt_dist, xLft_dist), 1e-10);
    const Sx_top = Ix / Math.max(yTop_dist, 1e-10);
    const Sx_bot = Ix / Math.max(yBot_dist, 1e-10);
    const rx = Math.sqrt(Ix / A_total);
    const ry = Math.sqrt(Iy / A_total);

    return {
      A: A_total, xbar, ybar, Ix, Iy, Sx, Sy, Sx_top, Sx_bot, rx, ry,
      details, bounds
    };
  }

  // ── Helper: bounding box of all shapes ────────────────────────────────────
  // Extents below are given relative to (cx, cy) as [xLo, xHi, yLo, yHi], NOT
  // assumed symmetric — tee and channel are defined from a local origin at one
  // EDGE (the stem's bottom, the web's outer face), matching primitiveProps'
  // own xc = cx + xcLocal / yc = cy + ycLocal, not from their own centroid.
  // Treating every shape as symmetric about (cx, cy) here gave a tee a
  // bounding box twice its real height, centred on empty space below the stem
  // instead of on the shape itself — which fed straight into the extreme-fibre
  // distances (Sx/Sy) and the preview's scale and centring.
  function _bounds(shapes) {
    let xLeft = Infinity, xRight = -Infinity, yBot = Infinity, yTop = -Infinity;
    for (const s of shapes) {
      const cx = s.cx || 0, cy = s.cy || 0;
      let xLo = 0, xHi = 0, yLo = 0, yHi = 0;
      if (s.type === 'rect') {
        xLo = -s.b / 2; xHi = s.b / 2; yLo = -s.h / 2; yHi = s.h / 2;
      } else if (s.type === 'circle') {
        xLo = -s.d / 2; xHi = s.d / 2; yLo = -s.d / 2; yHi = s.d / 2;
      } else if (s.type === 'hollow_rect') {
        xLo = -s.bo / 2; xHi = s.bo / 2; yLo = -s.ho / 2; yHi = s.ho / 2;
      } else if (s.type === 'hollow_circle') {
        xLo = -s.do / 2; xHi = s.do / 2; yLo = -s.do / 2; yHi = s.do / 2;
      } else if (s.type === 'i_section') {
        const h = s.hw + 2 * s.tf;
        xLo = -s.b / 2; xHi = s.b / 2; yLo = -h / 2; yHi = h / 2;
      } else if (s.type === 'channel') {
        // Origin at the web's outer face: spans 0..b in x (open toes at +x),
        // symmetric in y like i_section (same vertical material distribution).
        const h = s.hw + 2 * s.tf;
        xLo = 0; xHi = s.b; yLo = -h / 2; yHi = h / 2;
      } else if (s.type === 'tee') {
        // Origin at the stem's bottom: spans 0..(hs+tf) in y, symmetric in x.
        xLo = -s.b / 2; xHi = s.b / 2; yLo = 0; yHi = s.hs + s.tf;
      } else {
        continue;
      }
      xLeft  = Math.min(xLeft,  cx + xLo);
      xRight = Math.max(xRight, cx + xHi);
      yBot   = Math.min(yBot,   cy + yLo);
      yTop   = Math.max(yTop,   cy + yHi);
    }
    return { xLeft, xRight, yBot, yTop };
  }

  // ── SVG preview ────────────────────────────────────────────────────────────
  const FILL_COLORS = [
    '#1565c040', '#2e7d3240', '#c6282840', '#e6510040', '#880e4f40',
    '#0277bd40', '#558b2f40', '#f5750040'
  ];
  const STROKE_COLORS = [
    '#1565c0', '#2e7d32', '#c62828', '#e65100', '#880e4f',
    '#0277bd', '#558b2f', '#f57500'
  ];

  function buildPreviewSVG(shapes, result, W, H) {
    W = W || 300; H = H || 270;
    if (!shapes.length) {
      return `<svg width="${W}" height="${H}" style="border:1px solid #ddd;border-radius:6px;background:#fafafa;">
        <text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13" fill="#bbb">Add shapes to preview</text>
      </svg>`;
    }

    const pad = 30;
    const bounds = result ? result.bounds : _bounds(shapes);
    const bw = (bounds.xRight - bounds.xLeft) || 2;
    const bh = (bounds.yTop - bounds.yBot) || 2;
    const sc = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    const offX = pad + ((W - 2 * pad) - bw * sc) / 2;
    const offY = pad + ((H - 2 * pad) - bh * sc) / 2;

    const sx = x => offX + (x - bounds.xLeft) * sc;
    const sy = y => H - offY - (y - bounds.yBot) * sc;

    let html = `<svg width="${W}" height="${H}" style="border:1px solid #ddd;border-radius:6px;background:#fafafa;display:block;">`;

    // Shapes
    shapes.forEach((s, i) => {
      const cx = s.cx || 0, cy = s.cy || 0;
      const fill   = FILL_COLORS[i % FILL_COLORS.length];
      const stroke = STROKE_COLORS[i % STROKE_COLORS.length];

      if (s.type === 'rect') {
        html += `<rect x="${sx(cx - s.b/2).toFixed(1)}" y="${sy(cy + s.h/2).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.h*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

      } else if (s.type === 'circle') {
        html += `<circle cx="${sx(cx).toFixed(1)}" cy="${sy(cy).toFixed(1)}"
          r="${(s.d/2*sc).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

      } else if (s.type === 'hollow_rect') {
        html += `<rect x="${sx(cx - s.bo/2).toFixed(1)}" y="${sy(cy + s.ho/2).toFixed(1)}"
          width="${(s.bo*sc).toFixed(1)}" height="${(s.ho*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        html += `<rect x="${sx(cx - s.bi/2).toFixed(1)}" y="${sy(cy + s.hi/2).toFixed(1)}"
          width="${(s.bi*sc).toFixed(1)}" height="${(s.hi*sc).toFixed(1)}"
          fill="#fafafa" stroke="${stroke}" stroke-width="1" stroke-dasharray="3,2"/>`;

      } else if (s.type === 'hollow_circle') {
        html += `<circle cx="${sx(cx).toFixed(1)}" cy="${sy(cy).toFixed(1)}"
          r="${(s.do/2*sc).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        html += `<circle cx="${sx(cx).toFixed(1)}" cy="${sy(cy).toFixed(1)}"
          r="${(s.di/2*sc).toFixed(1)}" fill="#fafafa" stroke="${stroke}" stroke-width="1" stroke-dasharray="3,2"/>`;

      } else if (s.type === 'i_section') {
        const h = s.hw + 2 * s.tf;
        // Top flange
        html += `<rect x="${sx(cx - s.b/2).toFixed(1)}" y="${sy(cy + h/2).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.tf*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        // Web
        html += `<rect x="${sx(cx - s.tw/2).toFixed(1)}" y="${sy(cy + s.hw/2).toFixed(1)}"
          width="${(s.tw*sc).toFixed(1)}" height="${(s.hw*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        // Bottom flange
        html += `<rect x="${sx(cx - s.b/2).toFixed(1)}" y="${sy(cy - s.hw/2).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.tf*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

      } else if (s.type === 'channel') {
        // Same vertical geometry as i_section (identical Ix formula) but the
        // web sits at the local origin (x=0, the closed/web face) instead of
        // being centred — the flanges span 0..b, open toward +x.
        const h = s.hw + 2 * s.tf;
        // Top flange
        html += `<rect x="${sx(cx).toFixed(1)}" y="${sy(cy + h/2).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.tf*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        // Web
        html += `<rect x="${sx(cx).toFixed(1)}" y="${sy(cy + s.hw/2).toFixed(1)}"
          width="${(s.tw*sc).toFixed(1)}" height="${(s.hw*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        // Bottom flange
        html += `<rect x="${sx(cx).toFixed(1)}" y="${sy(cy - s.hw/2).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.tf*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

      } else if (s.type === 'tee') {
        // Stem first, then flange
        html += `<rect x="${sx(cx - s.tw/2).toFixed(1)}" y="${sy(cy + s.hs).toFixed(1)}"
          width="${(s.tw*sc).toFixed(1)}" height="${(s.hs*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        html += `<rect x="${sx(cx - s.b/2).toFixed(1)}" y="${sy(cy + s.hs + s.tf).toFixed(1)}"
          width="${(s.b*sc).toFixed(1)}" height="${(s.tf*sc).toFixed(1)}"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
      }
    });

    // Centroid crosshair + neutral axes
    if (result) {
      const cxS = sx(result.xbar), cyS = sy(result.ybar);
      html += `
        <line x1="${pad}" y1="${cyS.toFixed(1)}" x2="${(W-pad)}" y2="${cyS.toFixed(1)}"
          stroke="#1565c0" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>
        <line x1="${cxS.toFixed(1)}" y1="${pad}" x2="${cxS.toFixed(1)}" y2="${(H-pad)}"
          stroke="#43a047" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>
        <circle cx="${cxS.toFixed(1)}" cy="${cyS.toFixed(1)}" r="5"
          fill="none" stroke="#e53935" stroke-width="2"/>
        <line x1="${(cxS-7).toFixed(1)}" y1="${cyS.toFixed(1)}" x2="${(cxS+7).toFixed(1)}" y2="${cyS.toFixed(1)}"
          stroke="#e53935" stroke-width="2"/>
        <line x1="${cxS.toFixed(1)}" y1="${(cyS-7).toFixed(1)}" x2="${cxS.toFixed(1)}" y2="${(cyS+7).toFixed(1)}"
          stroke="#e53935" stroke-width="2"/>
        <text x="${(cxS+8).toFixed(1)}" y="${(cyS-8).toFixed(1)}" font-size="10" fill="#e53935" font-weight="700">C</text>`;
    }

    html += `<text x="6" y="14" font-size="10" fill="#aaa">Preview (cm)</text>`;
    html += `</svg>`;
    return html;
  }

  // ── Shape parameter definitions ────────────────────────────────────────────
  const SHAPE_PARAMS = {
    rect:         [{ id:'b', lbl:'Width b',         val:20,  step:1   },
                   { id:'h', lbl:'Height h',         val:30,  step:1   }],
    circle:       [{ id:'d', lbl:'Diameter d',       val:20,  step:1   }],
    hollow_rect:  [{ id:'bo',lbl:'Outer width b_o',  val:20,  step:1   },
                   { id:'ho',lbl:'Outer height h_o', val:30,  step:1   },
                   { id:'bi',lbl:'Inner width b_i',  val:16,  step:1   },
                   { id:'hi',lbl:'Inner height h_i', val:26,  step:1   }],
    hollow_circle:[{ id:'do',lbl:'Outer dia. d_o',   val:20,  step:1   },
                   { id:'di',lbl:'Inner dia. d_i',   val:16,  step:1   }],
    i_section:    [{ id:'b', lbl:'Flange width b',   val:20,  step:1   },
                   { id:'tf',lbl:'Flange t_f',       val:1.4, step:0.1 },
                   { id:'hw',lbl:'Web height h_w',   val:25,  step:1   },
                   { id:'tw',lbl:'Web t_w',           val:0.9, step:0.1 }],
    channel:      [{ id:'b', lbl:'Flange width b',   val:15,  step:1   },
                   { id:'tf',lbl:'Flange t_f',       val:1.2, step:0.1 },
                   { id:'hw',lbl:'Web height h_w',   val:20,  step:1   },
                   { id:'tw',lbl:'Web t_w',           val:0.8, step:0.1 }],
    tee:          [{ id:'b', lbl:'Flange width b',   val:15,  step:1   },
                   { id:'tf',lbl:'Flange t_f',       val:1.2, step:0.1 },
                   { id:'hs',lbl:'Stem height h_s',  val:15,  step:1   },
                   { id:'tw',lbl:'Stem t_w',          val:0.9, step:0.1 }],
  };

  // ── Dialog HTML ────────────────────────────────────────────────────────────
  function buildDialogHTML() {
    return `
      <div style="display:flex;gap:12px;flex-wrap:wrap;min-height:440px;">

        <!-- Left panel -->
        <div style="flex:0 0 300px;display:flex;flex-direction:column;gap:8px;">

          <!-- Shape list -->
          <div>
            <div style="font-weight:700;font-size:11px;color:#555;text-transform:uppercase;margin-bottom:4px;">Components</div>
            <div id="ccs-list" style="min-height:52px;max-height:180px;overflow-y:auto;border:1px solid var(--border-tbl);border-radius:6px;padding:4px;background:var(--bg-tbl-alt);font-size:11px;">
              <div id="ccs-no-shapes" style="color:#bbb;padding:8px 4px;text-align:center;">No shapes — add below</div>
            </div>
          </div>

          <!-- Add shape form -->
          <div style="border:1px solid var(--border-tbl);border-radius:6px;padding:10px;background:var(--bg-tbl-alt);flex:1;">
            <div style="font-weight:700;font-size:11px;color:#555;text-transform:uppercase;margin-bottom:6px;">Add Shape</div>

            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <label style="font-size:11px;min-width:42px;">Type</label>
              <select id="ccs-type" style="flex:1;font-size:11px;padding:3px 4px;">
                <option value="rect">Rectangle</option>
                <option value="circle">Circle</option>
                <option value="hollow_rect">Hollow Rect (RHS)</option>
                <option value="hollow_circle">Hollow Circle (CHS)</option>
                <option value="i_section">I-Section (built-up)</option>
                <option value="channel">Channel (C)</option>
                <option value="tee">T-Section</option>
              </select>
            </div>

            <div id="ccs-params" style="margin-bottom:6px;"></div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:4px;font-size:11px;">
                <label style="min-width:38px;">Offset x</label>
                <input type="number" id="ccs-cx" value="0" step="0.5" style="width:55px;font-size:11px;padding:3px 4px;">
                <span style="color:#888;">cm</span>
              </div>
              <div style="display:flex;align-items:center;gap:4px;font-size:11px;">
                <label style="min-width:38px;">Offset y</label>
                <input type="number" id="ccs-cy" value="0" step="0.5" style="width:55px;font-size:11px;padding:3px 4px;">
                <span style="color:#888;">cm</span>
              </div>
            </div>

            <button class="btn-xs btn-blue" id="ccs-add" style="width:100%;">+ Add Shape</button>
          </div>

          <!-- Quick presets -->
          <div>
            <div style="font-weight:700;font-size:11px;color:#555;text-transform:uppercase;margin-bottom:4px;">Quick Presets</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
              <button class="btn-xs" id="ccs-preset-box" style="font-size:10px;padding:3px 7px;">□ RHS 200×150×8</button>
              <button class="btn-xs" id="ccs-preset-i"   style="font-size:10px;padding:3px 7px;">I IPE 300</button>
              <button class="btn-xs" id="ccs-preset-box2" style="font-size:10px;padding:3px 7px;">⊞ Twin RHS</button>
              <button class="btn-xs" id="ccs-preset-tee" style="font-size:10px;padding:3px 7px;">T Plate Girder</button>
            </div>
          </div>
        </div>

        <!-- Right panel -->
        <div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:8px;">

          <div>
            <div style="font-weight:700;font-size:11px;color:#555;text-transform:uppercase;margin-bottom:4px;">Section Preview</div>
            <div id="ccs-preview"></div>
          </div>

          <div style="flex:1;">
            <div style="font-weight:700;font-size:11px;color:#555;text-transform:uppercase;margin-bottom:4px;">Computed Properties</div>
            <div id="ccs-results">
              <div style="color:#bbb;font-size:12px;padding:8px 4px;text-align:center;">Add shapes to compute.</div>
            </div>
          </div>

          <button class="btn-xs btn-green" id="ccs-use-btn" style="width:100%;" disabled>
            ✓ Push to Section Library
          </button>
        </div>
      </div>`;
  }

  // ── Wire dialog ────────────────────────────────────────────────────────────
  function wireDialog() {
    let shapes = [];

    function renderParamInputs(type) {
      const params = SHAPE_PARAMS[type] || [];
      document.getElementById('ccs-params').innerHTML = params.map(p => `
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;font-size:11px;">
          <label style="min-width:106px;flex-shrink:0;">${p.lbl}</label>
          <input type="number" id="ccs-p-${p.id}" value="${p.val}" step="${p.step}"
            style="width:58px;font-size:11px;padding:3px 4px;">
          <span style="color:#888;">cm</span>
        </div>`).join('');
    }

    function readCurrentShape() {
      const type = document.getElementById('ccs-type').value;
      const params = SHAPE_PARAMS[type] || [];
      const shape = { type };
      for (const p of params) {
        const el = document.getElementById(`ccs-p-${p.id}`);
        if (el) shape[p.id] = parseFloat(el.value) || 0;
      }
      shape.cx = parseFloat(document.getElementById('ccs-cx').value) || 0;
      shape.cy = parseFloat(document.getElementById('ccs-cy').value) || 0;
      return shape;
    }

    function fmtN(v, d) {
      if (v == null || isNaN(v)) return '—';
      return (+v).toFixed(d != null ? d : 3);
    }

    function update() {
      const result = compute(shapes);

      // Preview SVG
      document.getElementById('ccs-preview').innerHTML = buildPreviewSVG(shapes, result, 300, 240);

      // Shape list
      const listEl = document.getElementById('ccs-list');
      if (!shapes.length) {
        listEl.innerHTML = '<div id="ccs-no-shapes" style="color:#bbb;padding:8px 4px;text-align:center;">No shapes — add below</div>';
      } else {
        listEl.innerHTML = shapes.map((s, i) => {
          const lbl = s.type.replace(/_/g,' ');
          const col = STROKE_COLORS[i % STROKE_COLORS.length];
          return `<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 5px;border-bottom:1px solid var(--border-tbl);">
            <span>
              <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col};margin-right:4px;vertical-align:middle;"></span>
              <strong>${i+1}.</strong> ${lbl} @ (${s.cx||0}, ${s.cy||0}) cm
            </span>
            <button onclick="window._ccs_remove(${i})" style="font-size:10px;padding:1px 6px;background:#ffebee;color:#c62828;border:none;border-radius:3px;cursor:pointer;line-height:1.4;">✕</button>
          </div>`;
        }).join('');
      }

      // Results
      const resEl = document.getElementById('ccs-results');
      const useBtn = document.getElementById('ccs-use-btn');
      if (!result) {
        resEl.innerHTML = '<div style="color:#bbb;font-size:12px;padding:8px 4px;text-align:center;">Add shapes to compute.</div>';
        useBtn.disabled = true;
        return;
      }

      // Parallel axis detail table (compact)
      const detailRows = result.details.map((d, i) => {
        const col = STROKE_COLORS[i % STROKE_COLORS.length];
        return `<tr>
          <td style="padding:2px 6px;">
            <span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${col};margin-right:3px;"></span>
            ${i+1}
          </td>
          <td style="padding:2px 6px;text-align:right;">${fmtN(d.A, 2)}</td>
          <td style="padding:2px 6px;text-align:right;">${fmtN(d.Ix, 1)}</td>
          <td style="padding:2px 6px;text-align:right;">${fmtN(d.dIx, 1)}</td>
          <td style="padding:2px 6px;text-align:right;">${fmtN(d.Ix_total, 1)}</td>
        </tr>`;
      }).join('');

      resEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px;">
          <thead><tr style="background:#1565c0;color:#fff;">
            <th style="padding:4px 6px;text-align:left;font-weight:600;">Property</th>
            <th style="padding:4px 6px;text-align:right;font-weight:600;">Value</th>
            <th style="padding:4px 6px;text-align:left;color:#aaddff;">Unit</th>
          </tr></thead>
          <tbody>
            <tr><td style="padding:3px 6px;">A (total area)</td>
                <td style="padding:3px 6px;text-align:right;font-weight:700;">${fmtN(result.A, 2)}</td>
                <td style="padding:3px 6px;color:#888;">cm²</td></tr>
            <tr style="background:#f8f9ff;"><td style="padding:3px 6px;">x̄ (centroid)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.xbar, 3)}</td>
                <td style="padding:3px 6px;color:#888;">cm</td></tr>
            <tr><td style="padding:3px 6px;">ȳ (centroid)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.ybar, 3)}</td>
                <td style="padding:3px 6px;color:#888;">cm</td></tr>
            <tr style="background:#f8f9ff;"><td style="padding:3px 6px;font-weight:600;color:#1565c0;">I<sub>x</sub> (major axis)</td>
                <td style="padding:3px 6px;text-align:right;font-weight:700;color:#1565c0;">${fmtN(result.Ix, 1)}</td>
                <td style="padding:3px 6px;color:#888;">cm⁴</td></tr>
            <tr><td style="padding:3px 6px;font-weight:600;color:#2e7d32;">I<sub>y</sub> (minor axis)</td>
                <td style="padding:3px 6px;text-align:right;font-weight:700;color:#2e7d32;">${fmtN(result.Iy, 1)}</td>
                <td style="padding:3px 6px;color:#888;">cm⁴</td></tr>
            <tr style="background:#f8f9ff;"><td style="padding:3px 6px;">S<sub>x</sub> (el. modulus)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.Sx, 2)}</td>
                <td style="padding:3px 6px;color:#888;">cm³</td></tr>
            <tr><td style="padding:3px 6px;">S<sub>y</sub> (el. modulus)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.Sy, 2)}</td>
                <td style="padding:3px 6px;color:#888;">cm³</td></tr>
            <tr style="background:#f8f9ff;"><td style="padding:3px 6px;">r<sub>x</sub> (radius of gyration)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.rx, 3)}</td>
                <td style="padding:3px 6px;color:#888;">cm</td></tr>
            <tr><td style="padding:3px 6px;">r<sub>y</sub> (radius of gyration)</td>
                <td style="padding:3px 6px;text-align:right;">${fmtN(result.ry, 3)}</td>
                <td style="padding:3px 6px;color:#888;">cm</td></tr>
          </tbody>
        </table>

        <details style="font-size:11px;color:#555;">
          <summary style="cursor:pointer;font-weight:600;margin-bottom:4px;">Parallel Axis Theorem detail</summary>
          <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px;">
            <tr style="background:#e3f2fd;"><th style="padding:2px 6px;">#</th><th style="padding:2px 6px;text-align:right;">A (cm²)</th>
              <th style="padding:2px 6px;text-align:right;">I_self</th><th style="padding:2px 6px;text-align:right;">A·d²</th>
              <th style="padding:2px 6px;text-align:right;">I_total (cm⁴)</th></tr>
            ${detailRows}
          </table>
        </details>`;

      useBtn.disabled = false;
      useBtn._result = result;
    }

    // Expose remove function
    window._ccs_remove = (i) => { shapes.splice(i, 1); update(); };

    // Initial param form
    renderParamInputs(document.getElementById('ccs-type').value);
    update();

    // Type change
    document.getElementById('ccs-type').addEventListener('change', e => {
      renderParamInputs(e.target.value);
    });

    // Add shape
    document.getElementById('ccs-add').addEventListener('click', () => {
      const shape = readCurrentShape();
      const first = (shape.b || shape.d || shape.bo || shape.do || 0);
      if (first <= 0) { alert('Enter a valid primary dimension.'); return; }
      shapes.push(shape);
      update();
    });

    // Presets
    document.getElementById('ccs-preset-box').addEventListener('click', () => {
      shapes = [{ type:'hollow_rect', bo:20, ho:15, bi:18.4, hi:13.4, cx:0, cy:0 }];
      update();
    });
    document.getElementById('ccs-preset-i').addEventListener('click', () => {
      // IPE 300: b=150, tf=10.7, hw=278.6, tw=7.1 (mm → cm)
      shapes = [{ type:'i_section', b:15, tf:1.07, hw:27.86, tw:0.71, cx:0, cy:0 }];
      update();
    });
    document.getElementById('ccs-preset-box2').addEventListener('click', () => {
      shapes = [
        { type:'hollow_rect', bo:15, ho:10, bi:13.2, hi:8.2, cx:-9, cy:0 },
        { type:'hollow_rect', bo:15, ho:10, bi:13.2, hi:8.2, cx: 9, cy:0 }
      ];
      update();
    });
    document.getElementById('ccs-preset-tee').addEventListener('click', () => {
      // Welded plate girder: top flange 300×20mm, web 600×12mm, bottom flange 400×25mm
      shapes = [
        { type:'rect', b:40, h:2.5, cx:0, cy:0 },          // bottom flange 400×25
        { type:'rect', b:1.2, h:60, cx:0, cy:31.25 },       // web 12×600
        { type:'rect', b:30, h:2.0, cx:0, cy:62.25 }        // top flange 300×20
      ];
      update();
    });

    // Push to section library
    document.getElementById('ccs-use-btn').addEventListener('click', () => {
      const r = document.getElementById('ccs-use-btn')._result;
      if (!r) return;
      if (window.App && window.App._pushCompoundSection) {
        window.App._pushCompoundSection(r);
      } else {
        alert(`A=${r.A.toFixed(2)} cm²  Ix=${r.Ix.toFixed(1)} cm⁴  Iy=${r.Iy.toFixed(1)} cm⁴`);
      }
    });
  }

  return { compute, buildPreviewSVG, buildDialogHTML, wireDialog };

})();

window.CompoundSection = CompoundSection;
