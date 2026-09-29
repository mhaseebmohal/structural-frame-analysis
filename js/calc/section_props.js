// ══════════════════════════════════════════════════════════════════════════════
//  section_props.js — Cross-Section Property Calculator
//  Ported/inspired from engtools & StructuralTools repositories
//  Supports: Rectangle, Hollow Rectangle, Circle, Hollow Circle (tube),
//            I/H Section, T Section, L Angle, Channel (C), Z Section
//  All dimensions in mm — returns properties in standard section units:
//    A [mm²], Ix/Iy [mm⁴], Sx/Sy [mm³], rx/ry [mm], J [mm⁴], Cw [mm⁶]
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const SectionProps = (() => {

  // ─── Rectangle (solid) ──────────────────────────────────────────────────────
  // b = width, h = height
  function rectangle(b, h) {
    if (b <= 0 || h <= 0) throw new Error('Dimensions must be positive');
    const A  = b * h;
    const Ix = (b * h * h * h) / 12;
    const Iy = (h * b * b * b) / 12;
    const Sx = Ix / (h / 2);
    const Sy = Iy / (b / 2);
    const rx = Math.sqrt(Ix / A);
    const ry = Math.sqrt(Iy / A);
    // Torsional constant J (St Venant — approximate for solid rectangle)
    // J = β · b · h³  where β depends on h/b ratio
    const ratio = h > b ? h / b : b / h;
    const betaTable = [[1,0.1406],[1.5,0.1959],[2,0.2290],[3,0.2633],[4,0.2817],[6,0.2985],[10,0.3120],[Infinity,1/3]];
    let beta = 1 / 3;
    for (let i = 0; i < betaTable.length - 1; i++) {
      if (ratio <= betaTable[i][0]) { beta = betaTable[i][1]; break; }
      if (ratio < betaTable[i+1][0]) {
        const t = (ratio - betaTable[i][0]) / (betaTable[i+1][0] - betaTable[i][0]);
        beta = betaTable[i][1] + t * (betaTable[i+1][1] - betaTable[i][1]);
        break;
      }
    }
    const hh = Math.max(b, h), bMin = Math.min(b, h);
    const J  = beta * hh * bMin * bMin * bMin;
    const yc = h / 2;                 // centroid y from bottom
    const xc = b / 2;                 // centroid x from left
    return { shape:'Rectangle', b, h, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw: 0, yc, xc,
             Zx: A * h / 4, Zy: A * b / 4 };  // plastic section moduli
  }

  // ─── Hollow Rectangle (box section) ──────────────────────────────────────────
  // bo, ho = outer; bi, hi = inner (wall thicknesses tx=(bo-bi)/2, ty=(ho-hi)/2)
  function hollowRectangle(bo, ho, bi, hi) {
    if (bo <= 0 || ho <= 0) throw new Error('Outer dims must be positive');
    if (bi >= bo || hi >= ho) throw new Error('Inner dims must be less than outer');
    const A  = bo * ho - bi * hi;
    const Ix = (bo * ho * ho * ho - bi * hi * hi * hi) / 12;
    const Iy = (ho * bo * bo * bo - hi * bi * bi * bi) / 12;
    const Sx = Ix / (ho / 2);
    const Sy = Iy / (bo / 2);
    const rx = Math.sqrt(Ix / A);
    const ry = Math.sqrt(Iy / A);
    // Thin-wall torsion: J ≈ 4A²_enclosed / (Σ ds/t)
    const Ap    = bi * hi;  // enclosed area by mid-line
    const tx    = (bo - bi) / 2;
    const ty    = (ho - hi) / 2;
    const perim = 2 * (bi / tx + hi / ty);  // Σ ds/t
    const J     = 4 * Ap * Ap / perim;
    const yc = ho / 2, xc = bo / 2;
    // Plastic moduli (approximate for box)
    const Zx = (bo * ho * ho / 4 - bi * hi * hi / 4);
    const Zy = (ho * bo * bo / 4 - hi * bi * bi / 4);
    return { shape:'Box Section', bo, ho, bi, hi, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw: 0, yc, xc, Zx, Zy };
  }

  // ─── Solid Circle ────────────────────────────────────────────────────────────
  function circle(d) {
    if (d <= 0) throw new Error('Diameter must be positive');
    const r  = d / 2;
    const A  = Math.PI * r * r;
    const Ix = Math.PI * r * r * r * r / 4;
    const Iy = Ix;
    const Sx = Ix / r;
    const Sy = Sx;                            // circle is fully symmetric
    const rx = r / 2;
    const ry = rx;
    const J  = Math.PI * r * r * r * r / 2;  // polar moment = 2Ix
    const Zx = (4 * r * r * r) / 3;           // plastic modulus
    return { shape:'Circle', d, r, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw: 0,
             yc: r, xc: r, Zx, Zy: Zx };
  }

  // ─── Hollow Circle (CHS / pipe) ───────────────────────────────────────────────
  function hollowCircle(do_, di) {
    if (do_ <= 0) throw new Error('Outer diameter must be positive');
    if (di >= do_) throw new Error('Inner diameter must be less than outer');
    const ro = do_ / 2, ri = di / 2;
    const A  = Math.PI * (ro * ro - ri * ri);
    const Ix = Math.PI * (Math.pow(ro, 4) - Math.pow(ri, 4)) / 4;
    const Iy = Ix;
    const Sx = Ix / ro;
    const Sy = Sx;
    const rx = Math.sqrt(Ix / A);
    const ry = rx;
    const J  = 2 * Ix;
    const Zx = (4 / 3) * (ro * ro * ro - ri * ri * ri);
    return { shape:'Circular Hollow (CHS)', do: do_, di, ro, ri, A, Ix, Iy, Sx, Sy,
             rx, ry, J, Cw: 0, yc: ro, xc: ro, Zx, Zy: Zx };
  }

  // ─── I / H Section (symmetric, doubly-symmetric) ─────────────────────────────
  // bf  = flange width, tf = flange thickness, tw = web thickness, h = total height
  function iSection(h, bf, tf, tw) {
    if (h <= 0 || bf <= 0 || tf <= 0 || tw <= 0) throw new Error('All dims must be positive');
    if (2 * tf >= h) throw new Error('Flange thickness too large for given height');
    const hw = h - 2 * tf;                     // web height (clear)
    const A  = 2 * bf * tf + hw * tw;
    // Strong axis (x-x): bending about horizontal axis
    const Ix = (bf * h * h * h - (bf - tw) * hw * hw * hw) / 12;
    const Sx = Ix / (h / 2);
    const rx = Math.sqrt(Ix / A);
    // Weak axis (y-y): bending about vertical axis
    const Iy = (2 * tf * bf * bf * bf / 12) + (hw * tw * tw * tw / 12);
    const Sy = Iy / (bf / 2);
    const ry = Math.sqrt(Iy / A);
    // St Venant torsional constant J ≈ Σ (1/3) b t³
    const J  = (2 * bf * tf * tf * tf + hw * tw * tw * tw) / 3;
    // Warping constant Cw
    const Cw = tf * Math.pow(bf, 3) * Math.pow(h - tf, 2) / 24;
    // Plastic moduli
    const Zx = bf * tf * (h - tf) + tw * hw * hw / 4;
    const Zy = bf * bf * tf / 2 + tw * tw * hw / 4;
    const yc = h / 2;
    return { shape:'I/H Section', h, bf, tf, tw, hw, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw,
             yc, xc: bf / 2, Zx, Zy };
  }

  // ─── T Section (symmetric about y-axis, stem down) ────────────────────────────
  // bf = flange width, tf = flange thickness, hw = web(stem) height, tw = stem width
  function tSection(bf, tf, hw, tw) {
    if (bf <= 0 || tf <= 0 || hw <= 0 || tw <= 0) throw new Error('All dims must be positive');
    const h  = tf + hw;
    const Af = bf * tf;
    const Aw = hw * tw;
    const A  = Af + Aw;
    // Centroid from bottom of stem
    const yc = (Af * (hw + tf / 2) + Aw * hw / 2) / A;
    // Strong axis (x-x)
    const If  = bf * tf * tf * tf / 12 + Af * Math.pow(hw + tf / 2 - yc, 2);
    const Iw  = tw * hw * hw * hw / 12 + Aw * Math.pow(hw / 2 - yc, 2);
    const Ix  = If + Iw;
    const Sx_bot = Ix / yc;
    const Sx_top = Ix / (h - yc);
    const Sx     = Math.min(Sx_bot, Sx_top);
    const rx     = Math.sqrt(Ix / A);
    // Weak axis (y-y)
    const Iy = tf * bf * bf * bf / 12 + hw * tw * tw * tw / 12;
    const Sy = Iy / (bf / 2);
    const ry = Math.sqrt(Iy / A);
    // Torsional constant
    const J  = (bf * tf * tf * tf + hw * tw * tw * tw) / 3;
    const Cw = 0;  // simplified
    return { shape:'T Section', bf, tf, hw, tw, h, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw,
             yc, xc: bf / 2, Sx_bot, Sx_top };
  }

  // ─── L Section (equal or unequal angle) ───────────────────────────────────────
  // b1 = horizontal leg width, b2 = vertical leg height, t = thickness (uniform)
  function angleSection(b1, b2, t) {
    if (b1 <= 0 || b2 <= 0 || t <= 0) throw new Error('All dims must be positive');
    if (t >= b1 || t >= b2) throw new Error('Thickness must be less than leg dimensions');
    const A  = t * (b1 + b2 - t);
    // Centroid from bottom-left corner (outer)
    const xc = (b1 * b1 * t / 2 + (b2 - t) * t * t / 2) / A;
    const yc = (b2 * b2 * t / 2 + (b1 - t) * t * t / 2) / A;
    // Ix about horizontal axis through centroid
    const Ixo_h = t * b2 * b2 * b2 / 3 + (b1 - t) * t * t * t / 3;
    const Ix = Ixo_h - A * yc * yc;
    // Iy about vertical axis through centroid
    const Iyo_v2 = t * b1 * b1 * b1 / 3 + (b2 - t) * t * t * t / 3;
    const Iy = Iyo_v2 - A * xc * xc;
    const Sx = Ix / Math.max(yc, b2 - yc);
    const Sy = Iy / Math.max(xc, b1 - xc);
    const rx = Math.sqrt(Ix / A);
    const ry = Math.sqrt(Iy / A);
    // Torsional constant (thin-wall approx)
    const J  = t * t * t * (b1 + b2 - t) / 3;
    // ── Product of inertia about the centroidal axes ────────────────────
    // Computed from the same two-rectangle decomposition the rest of this
    // function uses, which is exact: a rectangle has zero product of inertia
    // about its own centroidal axes, so only the parallel-axis terms remain.
    //
    //   leg 1 (horizontal): x ∈ [0, b1],  y ∈ [0, t]
    //   leg 2 (vertical)  : x ∈ [0, t],   y ∈ [t, b2]
    //
    // The closed form previously used returned +415,141 mm⁴ for a 150×100×12
    // angle where the true value is −2,296,134 mm⁴ — wrong sign and 5.5x out.
    // Ixy feeds I1/I2 and the principal-axis angle, which is what governs an
    // angle's buckling capacity, so the error propagated straight into those.
    const A1 = b1 * t,        cx1 = b1 / 2,  cy1 = t / 2;
    const A2 = (b2 - t) * t,  cx2 = t / 2,   cy2 = (t + b2) / 2;
    const Ixy = A1 * (cx1 - xc) * (cy1 - yc) + A2 * (cx2 - xc) * (cy2 - yc);

    // Principal moments of inertia
    const Iavg = (Ix + Iy) / 2;
    const Idiff = (Ix - Iy) / 2;
    const I1 = Iavg + Math.sqrt(Idiff * Idiff + Ixy * Ixy);
    const I2 = Iavg - Math.sqrt(Idiff * Idiff + Ixy * Ixy);
    // Rotation to the principal axes: tan(2α) = −2·Ixy / (Ix − Iy), from
    // dIx'/dα = 0 for Ix' = (Ix+Iy)/2 + (Ix−Iy)/2·cos2α − Ixy·sin2α.
    // The sign on the numerator was inverted, mirroring the reported angle.
    const alpha = 0.5 * Math.atan2(-2 * Ixy, Ix - Iy) * 180 / Math.PI;  // deg
    return { shape:'L Angle', b1, b2, t, A, Ix, Iy, Sx, Sy, rx, ry, J, Cw: 0,
             yc, xc, I1, I2, alpha, Ixy };
  }

  // ─── Channel (C Section) ─────────────────────────────────────────────────────
  // h = total height, bf = flange width, tf = flange thickness, tw = web thickness
  function channelSection(h, bf, tf, tw) {
    if (h <= 0 || bf <= 0 || tf <= 0 || tw <= 0) throw new Error('All dims must be positive');
    const hw = h - 2 * tf;
    const A  = 2 * bf * tf + hw * tw;
    // Centroid from back of web (x-direction)
    const xc = (2 * bf * tf * (bf / 2) + hw * tw * (tw / 2)) / A;
    const yc = h / 2;  // symmetric about y-axis
    // Strong axis Ix — "full rectangle minus the two side voids", the same
    // construction iSection() uses. A channel has exactly the same material
    // distribution in y as an I-section of the same h/bf/tf/tw, so the two must
    // agree; they did not.
    //
    // The previous form took a web of the FULL height h (tw·h³/12) and then
    // added two flanges of the full width bf. The tw × tf patch where each
    // flange crosses the web was therefore counted twice, inflating Ix by 7.9%
    // for a 300×100×15×10 channel — an error in the unsafe direction, since Ix
    // drives both deflection and bending stress. Note the area on the line
    // above already uses the clear web height hw, so A and Ix disagreed about
    // what the section was.
    const Ix = (bf * h * h * h - (bf - tw) * hw * hw * hw) / 12;
    const Sx = Ix / (h / 2);
    const rx = Math.sqrt(Ix / A);
    // Weak axis Iy (about centroid)
    const Iy_web   = hw * tw * tw * tw / 12 + hw * tw * Math.pow(xc - tw / 2, 2);
    const Iy_flange= 2 * (tf * bf * bf * bf / 12 + tf * bf * Math.pow(bf / 2 - xc, 2));
    const Iy = Iy_web + Iy_flange;
    const Sy = Iy / Math.max(xc, bf - xc);
    const ry = Math.sqrt(Iy / A);
    // Shear centre (xo from centroid) — for channel section
    const e0 = (3 * tf * bf * bf) / (hw * tw + 6 * tf * bf);  // from web
    const xo = -(e0);  // shear centre to the left of centroid
    // Torsional constant
    const J  = (2 * bf * tf * tf * tf + hw * tw * tw * tw) / 3;
    // Warping constant Cw
    const Cw = tf * h * h * bf * bf * bf / 12 * (1 - 3 * tf * bf / (h * tw + 6 * tf * bf));
    return { shape:'Channel (C)', h, bf, tf, tw, hw, A, Ix, Iy, Sx, Sy, rx, ry,
             J, Cw, yc, xc, e0, xo };
  }

  // ─── Composite: Double Channel (back-to-back) ─────────────────────────────────
  function doubleChannel(h, bf, tf, tw, gap) {
    gap = gap || 0;
    const ch = channelSection(h, bf, tf, tw);
    const A  = 2 * ch.A;
    const Ix = 2 * ch.Ix;
    const Iy = 2 * (ch.Iy + ch.A * Math.pow(ch.xc + gap / 2, 2));
    const Sx = Ix / (h / 2);
    const Sy = Iy / (bf + gap / 2);
    const rx = Math.sqrt(Ix / A);
    const ry = Math.sqrt(Iy / A);
    const J  = 2 * ch.J;
    return { shape:'2× Channel (back-to-back)', A, Ix, Iy, Sx, Sy, rx, ry, J, Cw: 0,
             yc: h / 2, xc: 0, gap, ch };
  }

  // ─── Compute all derived quantities ───────────────────────────────────────────
  function enrichResult(props) {
    // Ensure section moduli exist
    props.Sx = props.Sx || (props.Ix / Math.max(props.yc, 0.001));
    props.Sy = props.Sy || (props.Iy / Math.max(props.xc, 0.001));
    // Radii of gyration
    props.rx = props.rx || Math.sqrt(props.Ix / props.A);
    props.ry = props.ry || Math.sqrt(props.Iy / props.A);
    // Area in cm² (standard structural unit)
    props.A_cm2   = props.A   / 100;
    props.Ix_cm4  = props.Ix  / 10000;
    props.Iy_cm4  = props.Iy  / 10000;
    props.Sx_cm3  = props.Sx  / 1000;
    props.Sy_cm3  = props.Sy  / 1000;
    props.rx_cm   = props.rx  / 10;
    props.ry_cm   = props.ry  / 10;
    props.J_cm4   = (props.J  || 0) / 10000;
    props.Cw_cm6  = (props.Cw || 0) / 1e6;
    props.Zx_cm3  = props.Zx ? props.Zx / 1000 : null;
    props.Zy_cm3  = props.Zy ? props.Zy / 1000 : null;
    return props;
  }

  // ─── Section compactness check (simplified EC3 / AISC) ───────────────────────
  function compactCheck(props, fy_MPa, standard = 'EC3') {
    const result = { standard, fy: fy_MPa, checks: [] };
    if (props.shape === 'I/H Section') {
      if (standard === 'EC3') {
        const eps = Math.sqrt(235 / fy_MPa);
        // Flange outstand c/tf
        const c_tf = ((props.bf - props.tw) / 2) / props.tf;
        const flangeClass = c_tf <= 9 * eps ? 1 : c_tf <= 10 * eps ? 2 : c_tf <= 14 * eps ? 3 : 4;
        // Web c/tw
        const c_tw = props.hw / props.tw;
        const webClass = c_tw <= 72 * eps ? 1 : c_tw <= 83 * eps ? 2 : c_tw <= 124 * eps ? 3 : 4;
        const overall = Math.max(flangeClass, webClass);
        result.epsilon = eps;
        result.flange  = { ratio: c_tf, class: flangeClass, limits: [9*eps, 10*eps, 14*eps] };
        result.web     = { ratio: c_tw, class: webClass,    limits: [72*eps, 83*eps, 124*eps] };
        result.class   = overall;
        result.label   = `Class ${overall}${overall === 1 ? ' (Plastic)' : overall === 2 ? ' (Compact)' : overall === 3 ? ' (Semi-compact)' : ' (Slender — eff. width)'}`;
      } else if (standard === 'AISC') {
        const lambda_pf = 0.38 * Math.sqrt(200000 / fy_MPa);
        const lambda_rf = Math.sqrt(200000 / fy_MPa);
        const c_tf = ((props.bf - props.tw) / 2) / props.tf;
        const flange = c_tf <= lambda_pf ? 'Compact' : c_tf <= lambda_rf ? 'Non-compact' : 'Slender';
        const lambda_pw = 3.76 * Math.sqrt(200000 / fy_MPa);
        const lambda_rw = 5.70 * Math.sqrt(200000 / fy_MPa);
        const c_tw = props.hw / props.tw;
        const web = c_tw <= lambda_pw ? 'Compact' : c_tw <= lambda_rw ? 'Non-compact' : 'Slender';
        result.flange = { ratio: c_tf, class: flange, limits: [lambda_pf, lambda_rf] };
        result.web    = { ratio: c_tw, class: web,    limits: [lambda_pw, lambda_rw] };
        result.class  = (flange === 'Compact' && web === 'Compact') ? 'Compact' : 'Non-compact or Slender';
      }
    }
    return result;
  }

  // ─── HTML table builder ────────────────────────────────────────────────────────
  function buildResultHTML(props, compact) {
    const p = props;
    const fmt = (v, d=3) => (v !== null && v !== undefined) ? (+v).toFixed(d) : '—';

    let html = `
    <div style="margin-top:8px">
      <div style="font-weight:700;font-size:13px;color:#1565c0;margin-bottom:6px">
        ${p.shape} — Properties
      </div>
      <table class="res-tbl" style="width:100%">
        <thead><tr><th>Property</th><th>Value</th><th>Unit</th><th>Value</th><th>Unit</th></tr></thead>
        <tbody>
          <tr><td><b>Area A</b></td><td>${fmt(p.A,1)}</td><td>mm²</td><td>${fmt(p.A_cm2,4)}</td><td>cm²</td></tr>
          <tr class="alt"><td><b>Ix (strong)</b></td><td>${fmt(p.Ix,0)}</td><td>mm⁴</td><td>${fmt(p.Ix_cm4,2)}</td><td>cm⁴</td></tr>
          <tr><td><b>Iy (weak)</b></td><td>${fmt(p.Iy,0)}</td><td>mm⁴</td><td>${fmt(p.Iy_cm4,2)}</td><td>cm⁴</td></tr>
          <tr class="alt"><td><b>Sx (elastic)</b></td><td>${fmt(p.Sx,1)}</td><td>mm³</td><td>${fmt(p.Sx_cm3,2)}</td><td>cm³</td></tr>
          <tr><td><b>Sy (elastic)</b></td><td>${fmt(p.Sy,1)}</td><td>mm³</td><td>${fmt(p.Sy_cm3,2)}</td><td>cm³</td></tr>
          ${p.Zx_cm3 ? `<tr class="alt"><td><b>Zx (plastic)</b></td><td>${fmt(p.Zx,1)}</td><td>mm³</td><td>${fmt(p.Zx_cm3,2)}</td><td>cm³</td></tr>` : ''}
          ${p.Zy_cm3 ? `<tr><td><b>Zy (plastic)</b></td><td>${fmt(p.Zy,1)}</td><td>mm³</td><td>${fmt(p.Zy_cm3,2)}</td><td>cm³</td></tr>` : ''}
          <tr class="alt"><td><b>rx (x-gyration)</b></td><td>${fmt(p.rx,2)}</td><td>mm</td><td>${fmt(p.rx_cm,3)}</td><td>cm</td></tr>
          <tr><td><b>ry (y-gyration)</b></td><td>${fmt(p.ry,2)}</td><td>mm</td><td>${fmt(p.ry_cm,3)}</td><td>cm</td></tr>
          <tr class="alt"><td><b>J (torsion)</b></td><td>${fmt(p.J,0)}</td><td>mm⁴</td><td>${fmt(p.J_cm4,2)}</td><td>cm⁴</td></tr>
          ${p.Cw ? `<tr><td><b>Cw (warping)</b></td><td>${fmt(p.Cw,0)}</td><td>mm⁶</td><td>${fmt(p.Cw_cm6,2)}</td><td>cm⁶</td></tr>` : ''}
          ${p.yc !== undefined ? `<tr class="alt"><td><b>Centroid yc</b></td><td>${fmt(p.yc,2)}</td><td>mm</td><td colspan="2">from bottom</td></tr>` : ''}
          ${p.xc !== undefined ? `<tr><td><b>Centroid xc</b></td><td>${fmt(p.xc,2)}</td><td>mm</td><td colspan="2">from left</td></tr>` : ''}
          ${p.e0 ? `<tr class="alt"><td><b>Shear centre e₀</b></td><td>${fmt(p.e0,2)}</td><td>mm</td><td colspan="2">from web back</td></tr>` : ''}
          ${p.I1 ? `<tr><td><b>I₁ (principal)</b></td><td>${fmt(p.I1,0)}</td><td>mm⁴</td><td>α = ${fmt(p.alpha,1)}°</td><td></td></tr>` : ''}
        </tbody>
      </table>`;

    // Compact check
    if (compact) {
      const cls = compact.class;
      const color = (typeof cls === 'number')
        ? [null,'#2e7d32','#558b2f','#ef6c00','#c62828'][cls] || '#555'
        : cls === 'Compact' ? '#2e7d32' : '#ef6c00';
      html += `
      <div style="margin-top:8px;padding:8px;border-radius:6px;background:${color}18;border:1px solid ${color}40">
        <div style="font-weight:700;color:${color}">${compact.label || compact.class}</div>
        ${compact.flange ? `<div style="font-size:11px;margin-top:4px">
          Flange c/tf = ${compact.flange.ratio.toFixed(2)} → ${compact.flange.class}
          &nbsp;|&nbsp; Web c/tw = ${compact.web.ratio.toFixed(2)} → ${compact.web.class}
          ${compact.epsilon ? `&nbsp;|&nbsp; ε = ${compact.epsilon.toFixed(3)}` : ''}
        </div>` : ''}
      </div>`;
    }

    html += '</div>';
    return html;
  }

  // ─── SVG cross-section sketch ─────────────────────────────────────────────────
  function buildSketchSVG(props, width = 160, height = 120) {
    const p  = props;
    const W  = width, H = height;
    const cx = W / 2, cy = H / 2;
    let svgContent = '';

    const fillSection  = 'rgba(21,101,192,0.18)';
    const strokeColor  = '#1565c0';
    const axisColor    = '#ccc';
    const sw           = 1.5;

    // Axes
    svgContent += `
      <line x1="${cx}" y1="4" x2="${cx}" y2="${H-4}" stroke="${axisColor}" stroke-dasharray="4,3" stroke-width="1"/>
      <line x1="4" y1="${cy}" x2="${W-4}" y2="${cy}" stroke="${axisColor}" stroke-dasharray="4,3" stroke-width="1"/>`;

    if (p.shape === 'Rectangle' || p.shape === 'Box Section') {
      const bOuter = p.bo || p.b;
      const hOuter = p.ho || p.h;
      const scl  = Math.min((W - 20) / bOuter, (H - 20) / hOuter) * 0.85;
      const bS   = bOuter * scl, hS = hOuter * scl;
      const x0   = cx - bS / 2, y0 = cy - hS / 2;
      svgContent += `<rect x="${x0}" y="${y0}" width="${bS}" height="${hS}" fill="${fillSection}" stroke="${strokeColor}" stroke-width="${sw}"/>`;
      if (p.bi) {
        const biS = p.bi * scl, hiS = p.hi * scl;
        svgContent += `<rect x="${cx-biS/2}" y="${cy-hiS/2}" width="${biS}" height="${hiS}" fill="var(--bg-canvas,white)" stroke="${strokeColor}" stroke-width="${sw}"/>`;
      }
    } else if (p.shape === 'Circle' || p.shape.includes('CHS')) {
      const ro = (p.ro || p.r);
      const ri = p.ri || 0;
      const scl = Math.min((W - 20), (H - 20)) / (2 * ro) * 0.85;
      svgContent += `<circle cx="${cx}" cy="${cy}" r="${ro * scl}" fill="${fillSection}" stroke="${strokeColor}" stroke-width="${sw}"/>`;
      if (ri > 0) svgContent += `<circle cx="${cx}" cy="${cy}" r="${ri * scl}" fill="var(--bg-canvas,white)" stroke="${strokeColor}" stroke-width="${sw}"/>`;
    } else if (p.shape === 'I/H Section') {
      const scl = Math.min((W-20)/p.bf, (H-20)/p.h) * 0.9;
      const bS  = p.bf * scl, hS = p.h * scl, twS = p.tw * scl, tfS = p.tf * scl;
      const x0  = cx - bS / 2, y0 = cy - hS / 2;
      // top flange + bottom flange + web as polygon
      const pts = [
        [x0, y0],                          // top-left
        [x0+bS, y0],                        // top-right
        [x0+bS, y0+tfS],                    // tf drop right
        [cx+twS/2, y0+tfS],                 // web-TR
        [cx+twS/2, y0+hS-tfS],              // web-BR
        [x0+bS, y0+hS-tfS],                 // bf drop right
        [x0+bS, y0+hS],                     // bot-right
        [x0, y0+hS],                        // bot-left
        [x0, y0+hS-tfS],                    // bf drop left
        [cx-twS/2, y0+hS-tfS],              // web-BL
        [cx-twS/2, y0+tfS],                 // web-TL
        [x0, y0+tfS]                        // tf drop left
      ].map(([px, py]) => `${px},${py}`).join(' ');
      svgContent += `<polygon points="${pts}" fill="${fillSection}" stroke="${strokeColor}" stroke-width="${sw}"/>`;
    } else if (p.shape === 'Channel (C)') {
      const scl = Math.min((W-20)/p.bf, (H-20)/p.h) * 0.9;
      const bS  = p.bf * scl, hS = p.h * scl, twS = p.tw * scl, tfS = p.tf * scl;
      const x0  = cx - bS * 0.3, y0 = cy - hS / 2;
      const pts = [
        [x0, y0], [x0+bS, y0], [x0+bS, y0+tfS], [x0+twS, y0+tfS],
        [x0+twS, y0+hS-tfS], [x0+bS, y0+hS-tfS], [x0+bS, y0+hS],
        [x0, y0+hS]
      ].map(([px,py]) => `${px},${py}`).join(' ');
      svgContent += `<polygon points="${pts}" fill="${fillSection}" stroke="${strokeColor}" stroke-width="${sw}"/>`;
    } else if (p.shape === 'L Angle') {
      const scl = Math.min((W-20)/p.b1, (H-20)/p.b2) * 0.9;
      const b1S = p.b1 * scl, b2S = p.b2 * scl, tS = p.t * scl;
      const x0  = cx - b1S / 2, y0 = cy - b2S / 2;
      const pts = [
        [x0, y0], [x0+b1S, y0], [x0+b1S, y0+tS], [x0+tS, y0+tS],
        [x0+tS, y0+b2S], [x0, y0+b2S]
      ].map(([px,py]) => `${px},${py}`).join(' ');
      svgContent += `<polygon points="${pts}" fill="${fillSection}" stroke="${strokeColor}" stroke-width="${sw}"/>`;
    }

    // Centroid marker
    if (p.yc !== undefined) {
      svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="#e53935"/>`;
      svgContent += `<text x="${cx+5}" y="${cy-5}" font-size="9" fill="#e53935">C</text>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
      style="background:var(--bg-canvas,#f8f8f8);border:1px solid var(--border);border-radius:4px">
      ${svgContent}</svg>`;
  }

  // ─── Master compute function ───────────────────────────────────────────────────
  function compute(shapeId, params) {
    let props;
    switch (shapeId) {
      case 'rectangle':      props = rectangle(params.b, params.h);                              break;
      case 'box':            props = hollowRectangle(params.bo, params.ho, params.bi, params.hi); break;
      case 'circle':         props = circle(params.d);                                           break;
      case 'chs':            props = hollowCircle(params.do, params.di);                         break;
      case 'isection':       props = iSection(params.h, params.bf, params.tf, params.tw);        break;
      case 'tsection':       props = tSection(params.bf, params.tf, params.hw, params.tw);       break;
      case 'angle':          props = angleSection(params.b1, params.b2, params.t);               break;
      case 'channel':        props = channelSection(params.h, params.bf, params.tf, params.tw);  break;
      case 'double_channel': props = doubleChannel(params.h, params.bf, params.tf, params.tw, params.gap); break;
      default: throw new Error(`Unknown section shape: ${shapeId}`);
    }
    return enrichResult(props);
  }

  // ─── Build the calculator dialog HTML ─────────────────────────────────────────
  function buildDialogHTML() {
    return `
    <div style="display:flex;gap:12px;flex-wrap:wrap;padding:4px 0">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:700;font-size:11px;color:var(--text-sec);margin-bottom:6px">SECTION TYPE</div>
        <select id="sp-shape" style="width:100%;padding:5px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px">
          <option value="isection">I / H Section</option>
          <option value="rectangle">Rectangle (solid)</option>
          <option value="box">Box / Hollow Rectangle</option>
          <option value="circle">Circle (solid)</option>
          <option value="chs">Circular Hollow (CHS / Pipe)</option>
          <option value="tsection">T Section</option>
          <option value="angle">L Angle</option>
          <option value="channel">Channel (C)</option>
          <option value="double_channel">2× Channel (back-to-back)</option>
        </select>

        <div id="sp-inputs" style="margin-top:10px"></div>

        <div style="margin-top:8px">
          <label style="font-size:11px;color:var(--text-sec)">Steel grade (for compactness)</label>
          <select id="sp-grade" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px;margin-top:3px">
            <option value="235">S235 (fy=235 MPa)</option>
            <option value="275" selected>S275 (fy=275 MPa)</option>
            <option value="355">S355 (fy=355 MPa)</option>
            <option value="420">S420 (fy=420 MPa)</option>
            <option value="460">S460 (fy=460 MPa)</option>
          </select>
          <select id="sp-compact-std" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-pane);color:var(--text);font-size:12px;margin-top:4px">
            <option value="EC3">EC3 (Eurocode)</option>
            <option value="AISC">AISC (US)</option>
          </select>
        </div>

        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-xs btn-blue" id="sp-calc">&#9654; Calculate</button>
          <button class="btn-xs" id="sp-use-sec">&#43; Use in Model</button>
          <button class="btn-xs" id="sp-copy-csv">&#128203; Copy CSV</button>
        </div>
      </div>

      <div style="flex:1.4;min-width:220px">
        <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
          <div id="sp-sketch" style="flex-shrink:0"></div>
          <div id="sp-results" style="flex:1;font-size:12px;overflow:auto;max-height:420px">
            <p style="color:#888">Select a section type, enter dimensions, and click Calculate.</p>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ─── Shape-specific input panel ───────────────────────────────────────────────
  const SHAPE_INPUTS = {
    rectangle: [
      { id:'b', label:'Width b [mm]',  val:100, step:5 },
      { id:'h', label:'Height h [mm]', val:200, step:5 }
    ],
    box: [
      { id:'bo', label:'Outer width bo [mm]',  val:150, step:5 },
      { id:'ho', label:'Outer height ho [mm]', val:200, step:5 },
      { id:'bi', label:'Inner width bi [mm]',  val:130, step:5 },
      { id:'hi', label:'Inner height hi [mm]', val:180, step:5 }
    ],
    circle: [
      { id:'d', label:'Diameter d [mm]', val:100, step:5 }
    ],
    chs: [
      { id:'do', label:'Outer diameter [mm]', val:168.3, step:5 },
      { id:'di', label:'Inner diameter [mm]', val:154.1, step:5 }
    ],
    isection: [
      { id:'h',  label:'Total height h [mm]',   val:300, step:5  },
      { id:'bf', label:'Flange width bf [mm]',   val:150, step:5  },
      { id:'tf', label:'Flange thick tf [mm]',   val:10.7, step:0.5 },
      { id:'tw', label:'Web thick tw [mm]',       val:7.1,  step:0.5 }
    ],
    tsection: [
      { id:'bf', label:'Flange width bf [mm]',   val:150, step:5  },
      { id:'tf', label:'Flange thick tf [mm]',   val:12,  step:1  },
      { id:'hw', label:'Web (stem) height [mm]', val:200, step:5  },
      { id:'tw', label:'Stem thick tw [mm]',     val:10,  step:1  }
    ],
    angle: [
      { id:'b1', label:'Horizontal leg b1 [mm]', val:100, step:5 },
      { id:'b2', label:'Vertical leg b2 [mm]',   val:100, step:5 },
      { id:'t',  label:'Thickness t [mm]',        val:10,  step:1 }
    ],
    channel: [
      { id:'h',  label:'Total height h [mm]',    val:200, step:5  },
      { id:'bf', label:'Flange width bf [mm]',   val:75,  step:5  },
      { id:'tf', label:'Flange thick tf [mm]',   val:11.5,step:0.5 },
      { id:'tw', label:'Web thick tw [mm]',       val:7,   step:0.5 }
    ],
    double_channel: [
      { id:'h',   label:'Height h [mm]',          val:200, step:5  },
      { id:'bf',  label:'Flange width bf [mm]',   val:75,  step:5  },
      { id:'tf',  label:'Flange thick tf [mm]',   val:11.5,step:0.5 },
      { id:'tw',  label:'Web thick tw [mm]',       val:7,   step:0.5 },
      { id:'gap', label:'Gap between webs [mm]',  val:0,   step:2  }
    ]
  };

  function buildInputHTML(shapeId) {
    const inputs = SHAPE_INPUTS[shapeId] || [];
    return inputs.map(inp => `
      <div class="form-row" style="margin-bottom:4px">
        <label style="font-size:11px;color:var(--text-sec)">${inp.label}</label>
        <input type="number" id="sp-${inp.id}" value="${inp.val}" step="${inp.step}"
          style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;
                 background:var(--bg-pane);color:var(--text);font-size:12px">
      </div>`
    ).join('');
  }

  // ─── Wire the dialog ───────────────────────────────────────────────────────────
  function wireDialog(onUseSection) {
    const shapeEl  = document.getElementById('sp-shape');
    const inputsEl = document.getElementById('sp-inputs');
    const resEl    = document.getElementById('sp-results');
    const sketchEl = document.getElementById('sp-sketch');

    function refreshInputs() {
      const sid = shapeEl.value;
      inputsEl.innerHTML = buildInputHTML(sid);
    }
    shapeEl.addEventListener('change', refreshInputs);
    refreshInputs();

    document.getElementById('sp-calc').addEventListener('click', () => {
      const sid = shapeEl.value;
      const inputs = SHAPE_INPUTS[sid] || [];
      const params = {};
      for (const inp of inputs) {
        params[inp.id] = parseFloat(document.getElementById(`sp-${inp.id}`).value) || 0;
      }
      try {
        const props   = compute(sid, params);
        const fy      = +document.getElementById('sp-grade').value || 275;
        const std     = document.getElementById('sp-compact-std').value;
        const compact = (sid === 'isection' || sid === 'tsection') ? compactCheck(props, fy, std) : null;
        resEl.innerHTML   = buildResultHTML(props, compact);
        sketchEl.innerHTML= buildSketchSVG(props);
        // Store last result for "Use in Model"
        document.getElementById('sp-calc')._lastProps = props;
      } catch (err) {
        resEl.innerHTML = `<div style="color:#e53935;padding:8px">${err.message}</div>`;
      }
    });

    document.getElementById('sp-use-sec').addEventListener('click', () => {
      const props = document.getElementById('sp-calc')._lastProps;
      if (!props || typeof onUseSection !== 'function') return;
      // Convert mm to cm for A [cm²] and I [cm⁴], E in GPa is app standard
      onUseSection({
        name: props.shape,
        A:    props.A_cm2,
        I:    props.Ix_cm4,
        E:    210,  // default steel
        fy:   275,
        rho:  78.5
      });
    });

    document.getElementById('sp-copy-csv').addEventListener('click', () => {
      const props = document.getElementById('sp-calc')._lastProps;
      if (!props) return;
      const csv = `Property,mm,cm\n` +
        `A,${props.A.toFixed(2)},${props.A_cm2.toFixed(4)}\n` +
        `Ix,${props.Ix.toFixed(0)},${props.Ix_cm4.toFixed(2)}\n` +
        `Iy,${props.Iy.toFixed(0)},${props.Iy_cm4.toFixed(2)}\n` +
        `Sx,${props.Sx.toFixed(1)},${props.Sx_cm3.toFixed(2)}\n` +
        `Sy,${props.Sy.toFixed(1)},${props.Sy_cm3.toFixed(2)}\n` +
        `rx,${props.rx.toFixed(2)},${props.rx_cm.toFixed(3)}\n` +
        `ry,${props.ry.toFixed(2)},${props.ry_cm.toFixed(3)}\n` +
        `J,${props.J.toFixed(0)},${props.J_cm4.toFixed(2)}\n`;
      navigator.clipboard?.writeText(csv).then(() => {
        const btn = document.getElementById('sp-copy-csv');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    });
  }

  return {
    compute,
    rectangle, hollowRectangle, circle, hollowCircle,
    iSection, tSection, angleSection, channelSection, doubleChannel,
    compactCheck, enrichResult,
    buildResultHTML, buildSketchSVG,
    buildDialogHTML, buildInputHTML, wireDialog,
    SHAPE_INPUTS
  };

})();

window.SectionProps = SectionProps;
