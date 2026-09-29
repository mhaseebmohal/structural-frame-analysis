// ══════════════════════════════════════════════════════════════════════════════
//  fileio.js  —  Import / Export System
//  Formats: .frame (JSON), .csv (member forces), .dxf (simplified node/beam),
//           clipboard paste (JSON text)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const FileIO = (() => {

  // ── Current schema version ─────────────────────────────────────────────────
  const SCHEMA_VERSION = '2.0';

  // ── JSON Export ────────────────────────────────────────────────────────────
  function exportJSON(state) {
    const data = {
      _schema:      SCHEMA_VERSION,
      _software:    'FrameSolver',
      _exported:    new Date().toISOString(),
      nodes:        state.nodes,
      beams:        state.beams,
      sections:     state.sections,
      // Materials travel with the project now. Without them a file opened on
      // another machine resolved its sections against that machine's library.
      materials:    state.materials  || [],
      loads:        state.loads,
      settlements:  state.settlements || [],
      loadCases:    state.loadCases   || [],
      loadCombos:   state.loadCombos  || [],
      nextId:       state.nextId,
      // The node coordinates below are stored in whichever convention (Y- or
      // Z-elevation) this flag means — every save/share path funnels through
      // here, and none of them carried it, so re-opening a 3D model (on this
      // machine or another) rendered it flattened until the user manually
      // re-enabled 3D.
      mode3D:       !!state.mode3D,
      view3D:       state.view3D || null,
      // Named grid systems (Define ▸ Grids) used to live only in GRIDSYS's own
      // localStorage key — absent here, so a shared/saved .frame file lost its
      // grid lines even though every other model property travelled with it.
      grids:        state.grids || null,
      modifiers:    (window.PropertyModifiers ? PropertyModifiers.exportAll() : {}),
      meta: {
        title:      state.meta?.title    || 'Untitled Project',
        engineer:   state.meta?.engineer || '',
        company:    state.meta?.company  || '',
        date:       state.meta?.date     || new Date().toLocaleDateString(),
        notes:      state.meta?.notes    || ''
      }
    };
    return JSON.stringify(data, null, 2);
  }

  function downloadJSON(state, filename) {
    const json = exportJSON(state);
    const blob = new Blob([json], { type: 'application/json' });
    triggerDownload(blob, filename || 'structure.frame');
  }

  // ── JSON Import ────────────────────────────────────────────────────────────
  function importJSON(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      return { error: 'Invalid JSON: ' + e.message };
    }

    // A malformed .frame file or a crafted ?data= share link reaches this
    // trust boundary with a check on its JSON SYNTAX only, not its shape. The
    // array fields below used to fall back solely on a FALSY value
    // (data.nodes || []), which a plain object or a string still sails past
    // unchanged — migrateV1's own .map() calls a few lines down, or the
    // render path much later, then threw an unhandled TypeError instead of
    // this returning a message that says what is actually wrong.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: 'Not a valid structure file — expected a JSON object.' };
    }
    for (const f of ['nodes', 'beams', 'sections', 'materials', 'loads',
                      'settlements', 'loadCases', 'loadCombos']) {
      if (data[f] != null && !Array.isArray(data[f])) {
        return { error: `Not a valid structure file — "${f}" should be a list, not ${typeof data[f]}.` };
      }
    }

    // Migrate old schema (v1). Compare numerically: `data._schema < '2.0'` is a
    // string comparison, so '10.0' < '2.0' is true and a future v10 file would
    // be run through the v1 migration.
    const schemaNum = parseFloat(data._schema);
    if (!Number.isFinite(schemaNum) || schemaNum < 2.0) {
      data = migrateV1(data);
    }

    // Restore modifiers
    if (data.modifiers && window.PropertyModifiers) {
      PropertyModifiers.importAll(data.modifiers);
    }

    return {
      nodes:       data.nodes       || [],
      beams:       data.beams       || [],
      sections:    data.sections    || defaultSections(),
      // null, not [] — a file written before materials were part of the schema
      // has none, and the caller must keep its defaults rather than be handed
      // an empty library.
      materials:   (data.materials && data.materials.length) ? data.materials : null,
      loads:       data.loads       || [],
      settlements: data.settlements || [],
      loadCases:   data.loadCases   || [{ id:1, name:'Dead', type:'DL', color:'#1565C0' }],
      loadCombos:  data.loadCombos  || [],
      nextId:      data.nextId      || { node:1, beam:1, load:1, section:4, settlement:1, lcase:2, combo:1, material:10 },
      meta:        data.meta        || {},
      // Absent in a file written before this travelled — null, not false, so
      // a caller can tell "no view mode recorded" apart from "recorded as 2D"
      // and choose to leave the current session's mode alone instead of
      // forcing it to 2D.
      mode3D:      typeof data.mode3D === 'boolean' ? data.mode3D : null,
      view3D:      data.view3D || null,
      grids:       data.grids || null
    };
  }

  function migrateV1(old) {
    // Add caseId to loads if missing
    if (old.loads) {
      old.loads = old.loads.map(l => ({ ...l, caseId: l.caseId || 1 }));
    }
    // Add fy to sections if missing
    if (old.sections) {
      old.sections = old.sections.map(s => ({ ...s, fy: s.fy || 275 }));
    }
    return old;
  }

  function defaultSections() {
    return [
      { id:1, name:'Steel W200×100', E:210, A:127, I:113000, fy:250, rho:78.5 },
      { id:2, name:'Steel IPE 300',  E:210, A:53.8, I:8356,  fy:235, rho:78.5 },
      { id:3, name:'Concrete 30×60', E:30,  A:1800, I:540000,fy:25,  rho:25   }
    ];
  }

  // ── CSV Export (member forces) ─────────────────────────────────────────────
  function exportCSV(results, beams, nodes) {
    if (!results || !results.elemForces) return '';

    // 3D results use a different key set (w, θx/θy/θz on displacements;
    // Rz/Mx/My/Mz on reactions and no `M` at all). Reading r.M.toFixed()
    // unconditionally threw a TypeError, so exporting a solved 3D model
    // produced no file and only a console error. num() tolerates both shapes.
    const is3D = !!results.is3D;
    const num  = (v, mult = 1) => (typeof v === 'number' && isFinite(v))
      ? (v * mult).toFixed(4) : '';

    const lines = [
      '# FrameSolver — Member Forces Export',
      '# ' + new Date().toISOString(),
      '',
      'Beam ID,Node i,Node j,L (m),N1 (kN),V1 (kN),M1 (kNm),N2 (kN),V2 (kN),M2 (kNm)'
    ];

    for (const ef of results.elemForces) {
      const bm = beams.find(b => b.id === ef.id);
      lines.push([
        ef.id,
        bm ? bm.node1 : '',
        bm ? bm.node2 : '',
        num(ef.L),
        num(ef.N1), num(ef.V1), num(ef.M1),
        num(ef.N2), num(ef.V2), num(ef.M2)
      ].join(','));
    }

    lines.push('');
    lines.push(is3D
      ? 'Node ID,X (m),Y (m),Z (m),Support,u (mm),v (mm),w (mm),θx (mrad),θy (mrad),θz (mrad)'
      : 'Node ID,X (m),Y (m),Support,u (mm),v (mm),theta (mrad)');
    for (const nd of nodes) {
      const d = results.disp?.[nd.id] || {};
      lines.push(is3D ? [
        nd.id, num(nd.x), num(nd.y), num(nd.z || 0),
        nd.support || 'none',
        num(d.u, 1000), num(d.v, 1000), num(d.w, 1000),
        num(d['θx'], 1000), num(d['θy'], 1000), num(d['θz'], 1000)
      ].join(',') : [
        nd.id, num(nd.x), num(nd.y),
        nd.support || 'none',
        num(d.u, 1000), num(d.v, 1000), num(d.theta, 1000)
      ].join(','));
    }

    lines.push('');
    lines.push(is3D
      ? 'Node ID,Rx (kN),Ry (kN),Rz (kN),Mx (kNm),My (kNm),Mz (kNm)'
      : 'Node ID,Rx (kN),Ry (kN),M (kNm)');
    for (const nd of nodes) {
      if (!nd.support || nd.support === 'none') continue;
      const r = results.reactions?.[nd.id] || {};
      lines.push(is3D
        ? [nd.id, num(r.Rx), num(r.Ry), num(r.Rz), num(r.Mx), num(r.My), num(r.Mz)].join(',')
        : [nd.id, num(r.Rx), num(r.Ry), num(r.M)].join(','));
    }

    return lines.join('\n');
  }

  function downloadCSV(results, beams, nodes, filename) {
    const csv  = exportCSV(results, beams, nodes);
    const blob = new Blob([csv], { type: 'text/csv' });
    triggerDownload(blob, filename || 'results.csv');
  }

  // ── Design checks CSV ──────────────────────────────────────────────────────
  /**
   * @param codeLabel  which code produced these numbers. The header used to
   *   say "(EC3)" unconditionally, so a run under ACI 318 exported rows of
   *   ACI-RC results beneath a heading that claimed Eurocode 3 — a file that
   *   leaves the app and states the wrong standard on its face.
   */
  function exportDesignCSV(designResults, codeLabel) {
    if (!designResults) return '';
    const lines = [
      '# FrameSolver — Design Checks Export (' + (codeLabel || 'code not stated') + ')',
      '# ' + new Date().toISOString(),
      '',
      'Beam,Section,L (m),Class,Max η,Status,Flexure η,Shear η,Axial η,Interaction η'
    ];
    for (const b of designResults.byBeam) {
      const getEta = (name) => {
        const c = b.checks.find(c => c.check === name || c.check.startsWith(name));
        return c?.eta != null ? c.eta.toFixed(4) : '—';
      };
      lines.push([
        b.label, b.secName, b.L.toFixed(3), b.cls,
        b.maxEta.toFixed(4), b.overall,
        getEta('Flexure'), getEta('Shear'), getEta('Axial'), getEta('Combined')
      ].join(','));
    }
    return lines.join('\n');
  }

  function downloadDesignCSV(designResults, filename, codeLabel) {
    const csv  = exportDesignCSV(designResults, codeLabel);
    const blob = new Blob([csv], { type: 'text/csv' });
    triggerDownload(blob, filename || 'design_checks.csv');
  }

  // ── DXF Export (simplified, 2D lines only) ─────────────────────────────────
  function exportDXF(nodes, beams) {
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });

    const lines = [
      '0', 'SECTION',
      '2', 'HEADER',
      '0', 'ENDSEC',
      '0', 'SECTION',
      '2', 'ENTITIES'
    ];

    // The Z ordinate was hard-coded to zero. This app stores height in `z` for
    // Z-lifted models (nodes carry y = 0 and the height in z — the same
    // convention solver.js handles with dy_eff), and full 3D models use all
    // three. Writing 0 collapsed every such model onto a single plane: a 4 m
    // portal exported as a set of zero-length lines at the origin.
    //
    // DXF is a 3D format, so the real ordinates serve both conventions — a
    // conventional 2D model (height in y, z absent) still lands in the XY plane.
    const zOf = nd => (nd.z || 0).toFixed(6);

    for (const bm of beams) {
      const ni = nodeMap[bm.node1], nj = nodeMap[bm.node2];
      if (!ni || !nj) continue;
      lines.push(
        '0', 'LINE',
        '8', '0',                 // layer 0
        '10', ni.x.toFixed(6),   // x1
        '20', ni.y.toFixed(6),   // y1
        '30', zOf(ni),            // z1
        '11', nj.x.toFixed(6),   // x2
        '21', nj.y.toFixed(6),   // y2
        '31', zOf(nj)             // z2
      );
    }

    // Nodes as POINT entities
    for (const nd of nodes) {
      lines.push(
        '0', 'POINT',
        '8', 'NODES',
        '10', nd.x.toFixed(6),
        '20', nd.y.toFixed(6),
        '30', zOf(nd)
      );
    }

    lines.push('0', 'ENDSEC', '0', 'EOF');
    return lines.join('\n');
  }

  function downloadDXF(nodes, beams, filename) {
    const dxf  = exportDXF(nodes, beams);
    const blob = new Blob([dxf], { type: 'application/dxf' });
    triggerDownload(blob, filename || 'structure.dxf');
  }

  // ── SVG serialisation with styles baked in ────────────────────────────────
  // An SVG rasterised through an <img> is an isolated document: it cannot see
  // the page's stylesheets. This canvas styles ~a quarter of its elements by
  // class (.sv-node, .sv-label, .grid-minor, .sv-bmd …), so a plain
  // serializeToString() export lost every one of them — the grid disappeared
  // entirely (stroke defaults to none) and text/nodes fell back to black.
  // Copying the computed value of the render-affecting properties onto each
  // element makes the markup self-contained.
  const SVG_STYLE_PROPS = [
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
    'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'opacity', 'visibility', 'display', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
    'text-anchor', 'dominant-baseline', 'paint-order',
    'marker-start', 'marker-mid', 'marker-end'
  ];

  /**
   * Deep-clone an SVG with every computed style inlined.
   * Elements inside <defs> are left alone: they are not rendered, so their
   * computed styles are unreliable, and their own attributes already survive
   * the clone (markers keep their fill).
   */
  function cloneSvgWithInlineStyles(srcRoot) {
    const clone  = srcRoot.cloneNode(true);
    const srcAll = [srcRoot, ...srcRoot.querySelectorAll('*')];
    const dstAll = [clone,   ...clone.querySelectorAll('*')];

    for (let i = 0; i < srcAll.length; i++) {
      const src = srcAll[i], dst = dstAll[i];
      if (!dst || !dst.style) continue;
      if (src.closest && src.closest('defs')) continue;

      const cs = window.getComputedStyle(src);
      let css = dst.getAttribute('style') || '';
      for (const prop of SVG_STYLE_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v && v !== 'auto' && v !== 'normal') css += `${prop}:${v};`;
      }
      dst.setAttribute('style', css);
    }

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    const r = srcRoot.getBoundingClientRect();
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
    }
    clone.setAttribute('width',  Math.round(r.width));
    clone.setAttribute('height', Math.round(r.height));
    return clone;
  }

  /** Self-contained SVG markup for the given live SVG element. */
  function serializeStyledSVG(svgElement) {
    return new XMLSerializer().serializeToString(cloneSvgWithInlineStyles(svgElement));
  }

  /** Data URI of the styled SVG — used for embedding in the HTML report. */
  function svgDataURI(svgElement) {
    if (!svgElement) return null;
    try {
      return 'data:image/svg+xml;charset=utf-8,' +
             encodeURIComponent(serializeStyledSVG(svgElement));
    } catch (e) { return null; }
  }

  // ── PNG Export (SVG canvas capture) ───────────────────────────────────────
  // scale: pixel multiplier. Defaults to 2× for a crisp raster; the total is
  // capped so a very large canvas cannot blow up memory.
  function exportPNG(svgElement, filename, scale = 2, background) {
    if (!svgElement) { console.warn('No SVG element provided'); return; }
    const rect = svgElement.getBoundingClientRect();
    const MAX_PX = 16e6;                       // ~16 MP ceiling
    let s = Math.max(1, scale);
    if (rect.width * rect.height * s * s > MAX_PX) {
      s = Math.sqrt(MAX_PX / (rect.width * rect.height));
    }
    const W = Math.round(rect.width  * s);
    const H = Math.round(rect.height * s);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Match the current theme unless the caller asked for a specific colour.
    const bg = background !== undefined ? background
      : (document.documentElement.getAttribute('data-theme') === 'dark' ? '#181818' : '#ffffff');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }

    const svgBlob = new Blob([serializeStyledSVG(svgElement)],
                             { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => triggerDownload(blob, filename || 'structure.png'), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('PNG export failed. Try right-click → Save image.');
    };
    img.src = url;
  }

  // ── Clipboard import ──────────────────────────────────────────────────────
  async function importFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      return importJSON(text);
    } catch (e) {
      return { error: 'Clipboard read failed: ' + e.message };
    }
  }

  async function exportToClipboard(state) {
    try {
      await navigator.clipboard.writeText(exportJSON(state));
      return { success: true };
    } catch (e) {
      return { error: 'Clipboard write failed: ' + e.message };
    }
  }

  // ── File open dialog ──────────────────────────────────────────────────────
  function openFile(accept, callback) {
    const inp = document.createElement('input');
    inp.type   = 'file';
    inp.accept = accept || '.frame,.json';
    inp.addEventListener('change', () => {
      const file = inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => callback(e.target.result, file.name);
      reader.readAsText(file);
    });
    inp.click();
  }

  // ── Helper ────────────────────────────────────────────────────────────────
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href    = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ── URL share ─────────────────────────────────────────────────────────────
  //
  // This used to be `btoa(encodeURIComponent(exportJSON(state)))`, which is
  // three separate ways of making the payload bigger:
  //
  //   · exportJSON pretty-prints with a 2-space indent, for a URL nobody reads;
  //   · encodeURIComponent then escapes every `"` to %22 and every newline to
  //     %0A — tripling the characters it was only there to make ASCII-safe;
  //   · base64 adds its own third on top of that.
  //
  // A 9-node frame came to 5.4 kB of JSON and a 29.6 kB URL, so the 8 kB guard
  // rejected it and the button refused all but toy models. Encoding the UTF-8
  // bytes directly, from compact JSON, is ~1.37x instead of ~5.5x.
  //
  // The alphabet is URL-safe (RFC 4648 §5) so the link survives being pasted
  // into chat clients and issue trackers, which escape or linkify '+' and '/'.

  const B64URL_OUT = { '+': '-', '/': '_' };
  const B64URL_IN  = { '-': '+', _: '/' };

  function packB64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    // One chunk at a time: String.fromCharCode(...bytes) overflows the call
    // stack somewhere around 100 kB, which a large model would reach.
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/[+/]/g, c => B64URL_OUT[c]).replace(/=+$/, '');
  }

  function unpackB64(b64) {
    const norm = b64.replace(/[-_]/g, c => B64URL_IN[c]);
    const bin  = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, '='));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  const URL_LIMIT = 8000;   // servers commonly cap the request line near here

  function exportToURL(state) {
    try {
      // Compact: the indentation in exportJSON is for humans reading files.
      const json = JSON.stringify(JSON.parse(exportJSON(state)));
      const url  = `${window.location.origin}${window.location.pathname}?data=${packB64(json)}`;
      if (url.length > URL_LIMIT) {
        const over = Math.round((url.length / URL_LIMIT) * 10) / 10;
        return { error: `Model too large for URL sharing — it needs about ${over}x ` +
                        'the room a link has. Use File ▸ Save .frame and send the file.' };
      }
      return { url };
    } catch (e) {
      return { error: e.message };
    }
  }

  function importFromURL() {
    const params = new URLSearchParams(window.location.search);
    const b64 = params.get('data');
    if (!b64) return null;
    try {
      return importJSON(unpackB64(b64));
    } catch (e) {
      // Links made before the encoding changed are still out there.
      try { return importJSON(decodeURIComponent(atob(b64))); }
      catch (e2) { return { error: 'Failed to parse URL data: ' + e.message }; }
    }
  }

  return {
    SCHEMA_VERSION,
    exportJSON, downloadJSON, importJSON,
    exportCSV,  downloadCSV,
    exportDesignCSV, downloadDesignCSV,
    exportDXF,  downloadDXF,
    exportPNG, serializeStyledSVG, svgDataURI,
    importFromClipboard, exportToClipboard,
    openFile,
    exportToURL, importFromURL,
    triggerDownload
  };

})();

window.FileIO = FileIO;
