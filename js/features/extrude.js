// ============================================================
//  extrude.js  —  High-quality 3D section extrusion rendering
//
//  Features:
//  • I-beam / W-shape cross-sections for steel
//  • Solid rectangle for concrete / rebar
//  • Phong shading (ambient + diffuse + specular highlight)
//  • Two-light setup (key + fill)
//  • Per-face depth sort (painter's algorithm)
//  • Selection highlight + design utilisation tinting
//  • Edge outlines for crispness
// ============================================================
'use strict';

(function () {

  // ── Lighting constants ─────────────────────────────────────────
  // The key light rides with the camera — a CAD "headlight" — offset up and to
  // the left so faces at different orientations separate clearly.
  //
  // Two earlier approaches both failed: a FIXED world-space key left half of
  // every member at pure ambient (near-black) whenever the light fell behind
  // the camera, and switching to |n·L| cured the blackness but lit opposing
  // faces *identically* — a box's left and right faces came out the same value,
  // so the solids read as flat grey ribbons. A camera-relative key gives every
  // visible face real, varying illumination, which is what reads as solid.
  // Shading spans roughly 0.52–1.0 of the base colour rather than 0.26–1.0.
  // A floor that low multiplied a saturated section colour down to near-black
  // (rgb(28,47,29) on a green member), which reads as muddy rather than shaded.
  // Analysis packages shade over a narrow band: enough to show form, never
  // enough to lose the member's colour.
  const KA = 0.52;   // ambient floor
  const KD = 0.46;   // diffuse
  const KS = 0.12;   // specular
  const SPEC_EXP = 20;

  // Fill light: fixed in world space, weak, purely for modelling.
  const FILL_LIGHT = norm3([-0.80, 0.60, 0.30]);

  // viewDir points from the scene toward the eye (visible faces satisfy
  // n·viewDir > 0), so offsetting it upward puts the key above the viewer.
  function keyLightFor(viewDir) {
    // viewDir runs eye -> scene, so the direction from a surface back toward the
    // camera is -viewDir. The key light sits just off that axis, lifted well
    // above, which is what puts a bright top face and two progressively darker
    // sides on each member. It used to be built from +viewDir: that lights the
    // faces pointing AWAY from the camera, which only looked right while the
    // back-face cull was inverted and those were the faces being drawn.
    const v = norm3(viewDir);
    return norm3([-v[0] - 0.40, -v[1] - 0.30, -v[2] + 0.75]);
  }

  // ── Material palettes ──────────────────────────────────────────
  // [R, G, B] base colour for each material category
  const MAT = {
    concrete: [178, 176, 170],   // warm grey
    steel:    [108, 158, 200],   // steel blue
    timber:   [193, 154,  99],   // warm tan
    rebar:    [170,  80,  70],   // rust red
    default:  [130, 175, 210]    // fallback blue
  };

  // ── Helpers ────────────────────────────────────────────────────
  function norm3(v) {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
    return l < 1e-9 ? v : [v[0]/l, v[1]/l, v[2]/l];
  }
  function dot3(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function cross3(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  }

  // Phong shading for a face with a given outward normal
  function shade(normal, baseR, baseG, baseB, viewDir, alpha) {
    const n = norm3(normal);
    const v = norm3(viewDir);

    let r = KA, g = KA, b = KA;

    // Key light — camera-relative, so every visible face is lit but by an amount
    // that varies with its orientation (see the note on KA above).
    const KEY = keyLightFor(v);
    const nDotKey = Math.max(0, dot3(n, KEY));
    r += KD * nDotKey;
    g += KD * nDotKey;
    b += KD * nDotKey;
    // Specular (key)
    // h = normalize(L + V) with V pointing surface -> viewer (= -viewDir).
    const h1 = norm3([KEY[0]-v[0], KEY[1]-v[1], KEY[2]-v[2]]);
    const spec1 = Math.pow(Math.max(0, dot3(n, h1)), SPEC_EXP);
    r += KS * spec1;  g += KS * spec1;  b += KS * spec1;

    // Fill light — two-sided so faces turned away from the key never go black.
    const nDotFill = Math.abs(dot3(n, FILL_LIGHT));
    r += KD * 0.22 * nDotFill;
    g += KD * 0.22 * nDotFill;
    b += KD * 0.22 * nDotFill;

    r = Math.min(1, r);  g = Math.min(1, g);  b = Math.min(1, b);

    const fr = Math.round(baseR * r);
    const fg = Math.round(baseG * g);
    const fb = Math.round(baseB * b);
    const a  = (alpha !== undefined) ? alpha : 1;
    return `rgba(${fr},${fg},${fb},${a})`;
  }

  // ── Section detection ──────────────────────────────────────────
  // Returns: 'I' | 'C' | 'Z' | 'T' | 'L' | '2L' | 'circ' | 'rect'
  //
  // shapeId is what Define ▸ Sections stores when the user picks a profile from
  // the shape grid, so it is the authoritative answer and is consulted first.
  // It used to be ignored entirely: the shape was guessed from the section
  // NAME, so a channel called "C 250x90" matched no pattern, fell through to
  // the rectangular default and extruded as a solid box — while the dialog's
  // own preview, which does read shapeId, drew the channel correctly. The two
  // views disagreed about the same section.
  const SHAPE_BY_ID = {
    SteelW:   'I',    PrecastI: 'I',
    SteelC:   'C',    ColdC:    'C',    ColdZ:   'Z',
    SteelT:   'T',    ConcTee:  'T',
    SteelL:   'L',    ConcL:    'L',    Steel2L: '2L',
    ConcCirc: 'circ', ConcPipe: 'circ', SteelPipe: 'circ', SteelRod: 'circ',
    // Hollow and solid rectangles share one outer silhouette, which is all an
    // extruded prism can show.
    ConcRect: 'rect', ConcBox:  'rect', SteelBox:  'rect', SteelPlate: 'rect'
  };

  function getSectionShape(sec) {
    if (!sec) return 'rect';

    // The user's explicit choice beats any guess made from the name.
    const byId = SHAPE_BY_ID[sec.shapeId];
    if (byId) return byId;

    // No shapeId: imported models, and the shipped preset library, which carry
    // a name and nothing else. Fall back to reading the name.
    const name = (sec.name || '').toLowerCase();

    // Specific shape words are tested BEFORE the generic material word. The
    // I-beam pattern below used to end with a bare `steel`, and being first it
    // won every time: a section called "Steel CHS 168x5", "Steel Pipe 200" or
    // "Steel Rod 25" was drawn as a wide flange. The shipped library names its
    // round sections "CHS 219x8" with no material prefix, which is why it never
    // showed there — but "Steel " prefixing is exactly what the default
    // sections use ("Steel W200x100", "Steel IPE 300").
    if (/circ|pipe|chs|round|circular|hollow.round|\brod\b|\bdia\b|ø/i.test(name)) return 'circ';

    // Hollow rectangular / square profiles draw as a plain rectangle.
    if (/\brhs|\bshs|\bhss|box/i.test(name)) return 'rect';

    // Open profiles, named the way catalogues name them: "PFC 250",
    // "C 200x75", "UA 100x100x10", "L150x90x12", "T 140x140".
    if (/\bpfc\b|\bcfc\b|channel|\bc\s*\d+\s*x/i.test(name)) return 'C';
    if (/\bua\b|\bea\b|angle|\bl\s*\d+\s*x/i.test(name))     return 'L';
    if (/\btee\b|\bbt\b|\bt\s*\d+\s*x/i.test(name))          return 'T';

    // Wide-flange / I-beam / H-section indicators.
    if (/\bw\d|\bh\d|ipe|ipn|hea|heb|hec|uc |ub |wb|wf|wide.flange|i.beam|i-beam/i.test(name)) {
      return 'I';
    }

    // Bare "steel" with no shape word left: a wide flange is the likeliest.
    if (/steel/i.test(name)) return 'I';

    // Rectangular concrete / timber default
    return 'rect';
  }

  // ── Cross-section vertex generator ────────────────────────────
  // Returns array of 2D [ey, ez] offsets for the cross-section perimeter
  // ey = strong-axis (depth direction), ez = weak-axis (width direction)
  function getCrossSection(sec, shape) {
    const sH = getSectionH(sec);  // depth (mm → m handled inside)
    const sW = getSectionW(sec, sH);
    const hH = sH / 2, hW = sW / 2;

    // Plate thicknesses. The dialog collects these — tf/tw for flanged shapes,
    // ts for a tee stem, ta for an angle leg — and where the user left one
    // blank we fall back to the same proportions the dialog's own preview
    // assumes, so the two pictures agree.
    const mm = (v) => (v > 0 ? v / 1000 : 0);
    const tf = mm(sec && sec.tf) || Math.max(0.008, sH / 12);
    const tw = mm(sec && sec.tw) || Math.max(0.006, sW / 10);
    const ts = mm(sec && sec.ts) || Math.max(0.008, sW / 5);
    const ta = mm(sec && sec.ta) || Math.max(0.006, Math.min(sH, sW) / 8);

    // A plate thicker than the half-depth would turn the profile inside out —
    // the flanges would cross the centreline and the polygon self-intersect —
    // so every thickness is capped short of it.
    const cf  = Math.min(tf, sH * 0.45);
    const cw  = Math.min(tw, sW * 0.9);
    const cs  = Math.min(ts, sW * 0.9);
    const cta = Math.min(ta, Math.min(sH, sW) * 0.45);

    if (shape === 'I') {
      return [
        // Bottom flange (CCW when looking along member axis). Every profile
        // below is traversed the same way, starting at the bottom-left.
        [-hH, -hW], [-hH,  hW],
        [-hH + cf,  hW], [-hH + cf,  cw/2],
        [ hH - cf,  cw/2], [ hH - cf,  hW],
        [ hH,  hW], [ hH, -hW],
        [ hH - cf, -hW], [ hH - cf, -cw/2],
        [-hH + cf, -cw/2], [-hH + cf, -hW],
      ];
    }

    if (shape === 'C') {
      // Channel: web down the -z face, both flanges reaching out to +z —
      // the orientation the dialog preview draws.
      return [
        [-hH, -hW], [-hH,  hW],
        [-hH + cf,  hW], [-hH + cf, -hW + cw],
        [ hH - cf, -hW + cw], [ hH - cf,  hW],
        [ hH,  hW], [ hH, -hW],
      ];
    }

    if (shape === 'Z') {
      // Antisymmetric: bottom flange reaches to -z, top flange to +z.
      return [
        [-hH, -hW], [-hH,  cw/2],
        [ hH - cf,  cw/2], [ hH - cf,  hW],
        [ hH,  hW], [ hH, -cw/2],
        [-hH + cf, -cw/2], [-hH + cf, -hW],
      ];
    }

    if (shape === 'T') {
      // Flange across the top, stem hanging below it.
      return [
        [-hH, -cs/2], [-hH,  cs/2],
        [ hH - cf,  cs/2], [ hH - cf,  hW],
        [ hH,  hW], [ hH, -hW],
        [ hH - cf, -hW], [ hH - cf, -cs/2],
      ];
    }

    if (shape === 'L') {
      // Angle: vertical leg on the -z face, horizontal leg along the bottom.
      return [
        [-hH, -hW], [-hH,  hW],
        [-hH + cta,  hW], [-hH + cta, -hW + cta],
        [ hH, -hW + cta], [ hH, -hW],
      ];
    }

    if (shape === '2L') {
      // Two equal angles back to back: the vertical legs meet on the
      // centreline, the horizontal legs reach out either way.
      return [
        [-hH, -hW], [-hH,  hW],
        [-hH + cta,  hW], [-hH + cta,  cta],
        [ hH,  cta], [ hH, -cta],
        [-hH + cta, -cta], [-hH + cta, -hW],
      ];
    }

    if (shape === 'circ') {
      // 40 segments: 24 was still visibly faceted on a large-diameter column
      // zoomed in close — the silhouette (a straight-edge convex hull) showed
      // flats along its curve instead of reading as round.
      const r = hH;
      const SEG = 40;
      const pts = [];
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return pts;
    }

    // Rectangle (concrete, timber, etc.)
    return [[-hH,-hW],[-hH,hW],[hH,hW],[hH,-hW]];
  }

  function getSectionH(sec) {
    if (!sec) return 0.30;
    if (sec.d  > 0) return Math.min(2.0, Math.max(0.06, sec.d  / 1000));
    const Av = (sec.A||900) * 1e-4;
    const Iv = ((sec.Ix||sec.I||1000)) * 1e-8;
    return Math.max(0.06, Math.min(2.0, Math.sqrt(12 * Iv / Av)));
  }

  function getSectionW(sec, sH) {
    if (!sec) return 0.20;
    // Define ▸ Sections writes the width field to `sec.b`; only the preset
    // library carries `bf`. Reading bf alone meant every width typed into the
    // dialog was discarded and the extruder back-solved one out of A and the
    // depth instead, so editing a section's width changed nothing on screen.
    const bw = sec.bf > 0 ? sec.bf : (sec.b > 0 ? sec.b : 0);
    if (bw > 0) return Math.min(1.4, Math.max(0.06, bw / 1000));
    const Av = (sec.A||900) * 1e-4;
    return Math.max(0.06, Math.min(1.2, Av / sH));
  }

  // ── Colour-by-section ─────────────────────────────────────────
  // Mirrors the wireframe's "View by Colour > Section" mode, which the solid
  // renderer previously ignored — pressing "By Section" recoloured the
  // centrelines but left every extruded member the same material grey.
  // Only for the case where app.js has not published SA yet — the real
  // palette lives there and is reached through SA.sectionColor().
  const SECTION_COLOUR_FALLBACK = '#1565c0';

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }

  // The wireframe palette is tuned for thin strokes on white, so it is too dark
  // to survive Phong shading as a fill. Lift it toward white to leave headroom.
  function lighten(rgb, t) {
    return rgb.map(function(c){ return Math.round(c + (255 - c) * t); });
  }

  function sectionColour(sec, bm) {
    const SA = window.SA;
    const id = sec ? sec.id : (bm && bm.sectionId);
    // app.js owns both the palette and the slot assignment (order of first use
    // among members), so the solids and the wireframe never disagree about
    // which colour a section is. This used to take the slot from app.js but
    // the palette from APP_CONSTANTS — a second copy of the same twelve
    // colours, which only agreed with app.js's copy for as long as nobody
    // edited one of them. Ask app.js for the finished colour instead.
    const hex = (SA && typeof SA.sectionColor === 'function')
      ? SA.sectionColor(id)
      : SECTION_COLOUR_FALLBACK;
    // Only a light lift toward white: at 0.42 the palette washed out to pastel.
    // Keeping it saturated matches how ETABS/SAP colour members by section.
    return lighten(hexToRgb(hex), 0.28);
  }

  // ── Base colour from section/material ─────────────────────────
  function getBaseColour(sec, bm, designResults, isSel) {
    if (isSel) return [229, 57, 53];  // bright red selection

    // Design tint
    if (designResults) {
      const bd = designResults.byBeam && designResults.byBeam.find(function(b){return b.id===bm.id;});
      if (bd && bd.maxEta != null) {
        if (bd.maxEta > 0.95) return [230, 48,  48];
        if (bd.maxEta > 0.80) return [255, 143, 10];
      }
    }

    // "View by Colour > Section" — one distinct colour per section, so members
    // sharing a section read as a group. Takes precedence over the material
    // palette but not over selection or a design overstress tint.
    const SA = window.SA;
    if (SA && SA.views && SA.views.colorBy === 'section' &&
        !SA.views.stress && !SA.views.energy) {
      return sectionColour(sec, bm);
    }

    const name = sec ? (sec.name || '').toLowerCase() : '';
    const mtype = (bm.memberType || '').toLowerCase();

    // Classify by material properties first — the name regex alone got this
    // wrong (a concrete "Col 400×400" matched the steel pattern and rendered
    // steel-blue). E in GPa and unit weight in kN/m³ are unambiguous:
    // concrete ≈ 20–40 GPa / 23–25, steel ≈ 200–210 GPa / 78.5, timber ≈ 7–14.
    const E = sec ? +sec.E || 0 : 0;
    const rho = sec ? +sec.rho || 0 : 0;
    if (E > 0) {
      if (E >= 150) return MAT.steel;                       // steel / alloy
      if (E >= 15 && E <= 60) {
        if (rho > 0 && rho < 15) return MAT.timber;          // light + stiff-ish
        return MAT.concrete;
      }
      if (E < 15) return MAT.timber;
    }

    if (/concr|c\d+|fc|psi|mpa/i.test(name)) return MAT.concrete;
    if (/steel|w\d|h\d|ipe|hea|heb|a36|a572|a992/i.test(name)) return MAT.steel;
    if (/timber|glulam|lvl|wood/i.test(name)) return MAT.timber;
    if (/rebar|a615|a416|gr60|gr40|grade/i.test(name)) return MAT.rebar;
    if (mtype === 'column') return [145, 185, 215];
    if (mtype === 'brace')  return [200, 130,  80];
    return MAT.default;
  }

  // ── Build prism faces from cross-section profile ───────────────
  // Returns array of { verts:[{sx,sy}], normal:[nx,ny,nz], depth, colour, alpha }
  function buildFaces(profile2d, ni, nj, ex, ey, ez, project3D, viewDir,
                      sec, bm, designResults, isSel) {
    const [baseR, baseG, baseB] = getBaseColour(sec, bm, designResults, isSel);
    const n = profile2d.length;
    const faces = [];

    // Project profile at start (i) and end (j) nodes
    function profileVert(node, eyOff, ezOff) {
      const wx = node.x + eyOff*ey[0] + ezOff*ez[0];
      const wy = node.y + eyOff*ey[1] + ezOff*ez[1];
      const wz = (node.z||0) + eyOff*ey[2] + ezOff*ez[2];
      return project3D(wx, wy, wz);
    }

    const pI = profile2d.map(function(p){ return profileVert(ni, p[0], p[1]); });
    const pJ = profile2d.map(function(p){ return profileVert(nj, p[0], p[1]); });

    // Cap faces (start and end)
    const endNormI = [-ex[0], -ex[1], -ex[2]];
    const endNormJ = [ ex[0],  ex[1],  ex[2]];
    // Opaque. The solids used to be drawn at 0.92/0.95 alpha, so the grid and
    // whatever lay behind showed through them — no analysis package renders an
    // extruded view semi-transparent, and it is what made members read as flat
    // tinted ribbons rather than solid volumes.
    const capAlpha = 1;

    // Cull consistently with the side faces below. Caps used a permissive
    // > -0.05 while sides used >= 0.04, so at grazing angles a cap could be
    // kept while the side faces sharing its edges were dropped (or the reverse),
    // leaving the section outline inconsistent from one view angle to the next.
    //
    // A face is visible when its outward normal turns back toward the camera,
    // and viewDir runs eye -> scene, so that is n.viewDir < 0. Both tests had
    // the sign the other way and kept the three faces pointing AWAY from the
    // camera: the silhouette still came out right, so the members looked solid,
    // but you were seeing the far side of each box. The give-away is the
    // internal edges, which met at the hidden back corner instead of the near
    // one — the missing near corner edge — and a column showing its underside
    // cap while viewed from above.
    const CULL_EPS = 0.02;
    if (dot3(endNormI, viewDir) < -CULL_EPS) {
      faces.push({
        verts: pI.slice().reverse(),
        normal: endNormI,
        depth: pI.reduce(function(s,p){return s+(p.d||0);},0)/n,
        col: shade(endNormI, baseR, baseG, baseB, viewDir, capAlpha),
        segments: n
      });
    }
    if (dot3(endNormJ, viewDir) < -CULL_EPS) {
      faces.push({
        verts: pJ,
        normal: endNormJ,
        depth: pJ.reduce(function(s,p){return s+(p.d||0);},0)/n,
        col: shade(endNormJ, baseR, baseG, baseB, viewDir, capAlpha),
        segments: n
      });
    }

    // Side faces (quad per profile edge)
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const sI0 = pI[k], sI1 = pI[k2];
      const sJ0 = pJ[k], sJ1 = pJ[k2];

      // Face normal from cross product of two edges
      const ep  = profile2d[k];
      const ep2 = profile2d[k2];
      const midEy = (ep[0] + ep2[0]) / 2;
      const midEz = (ep[1] + ep2[1]) / 2;
      const faceNorm = norm3([
        midEy * ey[0] + midEz * ez[0],
        midEy * ey[1] + midEz * ez[1],
        midEy * ey[2] + midEz * ez[2]
      ]);

      if (dot3(faceNorm, viewDir) >= -CULL_EPS) continue;  // back-face cull

      const quad = [sI0, sI1, sJ1, sJ0];
      const depth = quad.reduce(function(s,p){return s+(p.d||0);},0)/4;
      const col   = shade(faceNorm, baseR, baseG, baseB, viewDir, 1);
      faces.push({ verts: quad, normal: faceNorm, depth, col, segments: n });
    }

    // The member's true outline: the convex hull of every projected profile
    // vertex at both ends. Per-face outlines only cover faces that survive
    // back-face culling, so a silhouette edge shared with a culled face had
    // nothing drawing it — that is the edge that kept going missing. For a
    // convex section this hull is exactly the member's boundary.
    const hull = convexHull2D(pI.concat(pJ));
    if (hull) {
      // Ride at the member's frontmost face depth so the silhouette is occluded
      // by anything genuinely in front of it, rather than floating above.
      const dMax = faces.reduce(function(m,f){ return Math.max(m, f.depth); },
                                -Infinity);
      faces.silhouette = { hull: hull, depth: isFinite(dMax) ? dMax : 0 };
    }
    return faces;
  }

  // ── Convex hull (Andrew monotone chain) of projected points ────
  // Used for the member silhouette; input/output are {sx, sy} vertices.
  function convexHull2D(points) {
    const p = points.filter(function(q){ return q && isFinite(q.sx) && isFinite(q.sy); })
                    .map(function(q){ return [q.sx, q.sy]; })
                    .sort(function(a,b){ return a[0]-b[0] || a[1]-b[1]; });
    if (p.length < 3) return null;
    const cross = function(o,a,b){ return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); };
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], q) <= 0) upper.pop();
      upper.push(q);
    }
    lower.pop(); upper.pop();
    const hull = lower.concat(upper);
    return hull.length >= 3 ? hull : null;
  }

  // ── SVG polygon from face verts ────────────────────────────────
  function facePoly(verts) {
    return verts.map(function(p){ return p.sx.toFixed(1)+','+p.sy.toFixed(1); }).join(' ');
  }

  // ── Main draw function ─────────────────────────────────────────
  function drawExtrudedBeams() {
    const SA = window.SA; if (!SA) return;

    // Access app internals via SA
    const g = document.getElementById('layer-extrude');
    if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);

    if (!SA.mode3D || !SA.views || !SA.views.extrude) return;

    const beams   = SA.beams   || [];
    const nodes   = SA.nodes   || [];
    const sections= SA.sections|| [];
    const selBeam = SA.selBeam;
    const mSel    = SA.multiSel;
    const designResults = SA.results && SA.results.designResults || window._lastDesignResults;

    // Camera view direction (eye → scene)
    const az = SA.view3D ? SA.view3D.az : 0;
    const el = SA.view3D ? SA.view3D.el : 0;
    const viewDir = [Math.sin(az)*Math.cos(el), Math.cos(az)*Math.cos(el), -Math.sin(el)];

    // project3D — use the exposed SA.mToS3D_ext (exact same math as the app's mToS3D)
    function project3D(wx, wy, wz) {
      if (SA.mToS3D_ext) {
        const p = SA.mToS3D_ext(wx, wy, wz);
        // mToS3D returns {x, y} (screen coords)
        const ca=Math.cos(az),sa=Math.sin(az),ce=Math.cos(el),se=Math.sin(el);
        const y2 = sa*wx + ca*wy;
        // Depth INCREASES toward the viewer, so an ascending sort paints
        // far-to-near as the painter's algorithm needs, and a face's max depth
        // is its frontmost point. This was ce*y2 - se*wz, the distance *into*
        // the scene, so every sort ran nearest-first and members behind others
        // painted over the top of them.
        const d  = se*wz - ce*y2;
        return { sx: p.x, sy: p.y, d };  // Note: mToS3D uses x/y keys
      }
      // Fallback: use pan/scale if exposed
      const pan = SA.pan || {x:400,y:300};
      const sc  = SA.scale || 80;
      const ca=Math.cos(az),sa2=Math.sin(az),ce=Math.cos(el),se=Math.sin(el);
      const x2=ca*wx-sa2*wy, y2=sa2*wx+ca*wy;
      return {
        sx: pan.x + x2*sc,
        sy: pan.y - (se*y2+ce*wz)*sc,
        d:  se*wz - ce*y2
      };
    }

    // Collect ALL faces from all members, then depth-sort and render
    const allFaces = [];
    const silhouettes = [];   // one closed outline per member

    // Built once per draw() call rather than re-scanning nodes/sections with
    // .find() for every beam — that was O(beams × nodes), re-run in full on
    // every mousemove while orbiting or panning in 3D, and it is the biggest
    // single cost in this function on a model of any real size.
    const nodeById = new Map(nodes.map(function(n){ return [n.id, n]; }));
    const secById  = new Map(sections.map(function(s){ return [s.id, s]; }));

    beams.forEach(function(bm) {
      const ni = nodeById.get(bm.node1);
      const nj = nodeById.get(bm.node2);
      if (!ni || !nj) return;
      const sec = secById.get(bm.sectionId);

      const dx=nj.x-ni.x, dy=nj.y-ni.y, dz=(nj.z||0)-(ni.z||0);
      const L=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (L<1e-9) return;

      const ex=[dx/L,dy/L,dz/L];
      const isVert=Math.abs(ex[2])>0.95;
      const ref=isVert?[1,0,0]:[0,0,1];

      let ezv=cross3(ex,ref);
      const ezLen=Math.sqrt(ezv[0]*ezv[0]+ezv[1]*ezv[1]+ezv[2]*ezv[2]);
      if(ezLen<1e-9) return;
      ezv=[ezv[0]/ezLen,ezv[1]/ezLen,ezv[2]/ezLen];
      const eyv=cross3(ezv,ex);

      const shape   = getSectionShape(sec);
      const profile = getCrossSection(sec, shape);
      const isSel   = bm.id===selBeam || !!(mSel&&mSel.beams&&mSel.beams.has(bm.id));

      const faces = buildFaces(
        profile, ni, nj, ex, eyv, ezv, project3D, viewDir,
        sec, bm, designResults, isSel
      );
      if (faces.silhouette) silhouettes.push(faces.silhouette);
      allFaces.push(...faces);
    });

    // ── Sort all faces back→front (painter's algorithm) ────────────
    allFaces.sort(function(a,b){return a.depth-b.depth;});

    // ── Render each face ───────────────────────────────────────────
    const NS = 'http://www.w3.org/2000/svg';
    // Edges were rgba(...,0.35) at 0.8px — so faint that the boundary between a
    // member's top and side face was invisible and you could not read the actual
    // section outline. A near-opaque hairline makes the prism legible.
    const EDGE_COL = 'rgba(18,26,40,0.85)';

    // ONE depth-ordered stream: each face emits its fill immediately followed by
    // its own outline, and each member's silhouette rides at the depth of its
    // frontmost face.
    //
    // Getting this order right took two attempts. Fill+outline interleaved
    // naively lost edges; hoisting ALL outlines above ALL fills fixed that but
    // made the view x-ray — outlines of members hidden behind others drew over
    // the top of them. Emitting an outline directly after its own fill gives
    // both: a face can never erase its own edges, while a nearer member's fill
    // still correctly hides whatever sits behind it.
    const OUTLINE = { w: '1.1', sil: '1.4' };
    function strokeAttrs(el, width) {
      el.setAttribute('fill','none');
      el.setAttribute('stroke', EDGE_COL);
      el.setAttribute('stroke-width', width);
      el.setAttribute('stroke-linejoin','miter');   // crisp corners, not rounded
      el.setAttribute('shape-rendering','geometricPrecision');
      el.setAttribute('vector-effect','non-scaling-stroke');
      el.setAttribute('pointer-events','none');
    }

    // Silhouettes enter the same ordered stream, keyed to their member's
    // frontmost face so they are occluded like everything else.
    const stream = allFaces.map(function(f){ return { kind:'face', depth:f.depth, face:f }; });
    silhouettes.forEach(function(s){
      stream.push({ kind:'sil', depth:s.depth, hull:s.hull });
    });
    stream.sort(function(a,b){ return a.depth - b.depth; });

    stream.forEach(function(item) {
      if (item.kind === 'sil') {
        const sil = document.createElementNS(NS,'polygon');
        sil.setAttribute('points', item.hull.map(function(p){
          return p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' '));
        strokeAttrs(sil, OUTLINE.sil);
        g.appendChild(sil);
        return;
      }

      const face = item.face;
      const pts = facePoly(face.verts);
      if (!pts) return;

      const poly = document.createElementNS(NS,'polygon');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', face.col);
      // Hairline of the fill colour closes sub-pixel seams between facets. At
      // 0.5px (screen units — this SVG has no viewBox, so 1 unit = 1 CSS px)
      // it covered less than half a device pixel's anti-alias fringe on a 2x/3x
      // display, so adjacent faces still showed a faint seam where the
      // background peeked through between their independently-antialiased
      // edges. 1.2px reliably closes it at any pixel ratio without visibly
      // thickening the shape (it's the same colour as the fill either side).
      poly.setAttribute('stroke', face.col);
      poly.setAttribute('stroke-width','1.2');
      // Matches the outline strokes below — without it the fill's own edge
      // antialiased more softly than the crisp hairline drawn on top of it,
      // so the two never quite lined up.
      poly.setAttribute('shape-rendering','geometricPrecision');
      poly.setAttribute('pointer-events','none');
      g.appendChild(poly);

      // Outline low-segment profiles (a rectangle needs its corners drawn) but
      // not finely tessellated ones — 24 strokes around a circular column read
      // as a dark smudge rather than an edge.
      if (face.segments === undefined || face.segments <= 12) {
        const line = document.createElementNS(NS,'polygon');
        line.setAttribute('points', pts);
        strokeAttrs(line, OUTLINE.w);
        g.appendChild(line);
      }
    });
  }

  // ── Hook into app render cycle ─────────────────────────────────
  // app.js's render() calls window.EXTRUDE.draw() directly, so no patching is
  // needed. The previous version wrapped SA.render 1.2s after load, which meant
  // extrusion was missing until then and every external SA.render() drew the
  // solids twice (once from app.js's fallback, then again over the top).
  window.drawExtrudedBeams = drawExtrudedBeams;

  // Expose for manual call
  window.EXTRUDE = { draw: drawExtrudedBeams };

})();
