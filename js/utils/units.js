// ══════════════════════════════════════════════════════════════════════════════
//  units.js  —  ETABS-style Unit System Manager
//  One-click switching across the entire interface
//  Supported systems: SI | Imperial | kN-mm | kip-ft | N-mm | kN-cm
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const UnitSystem = (() => {

  // ── Unit system definitions ────────────────────────────────────────────────
  // Each system defines how to display and convert from the internal base
  // Internal base: kN, m, kNm, kN/m², kN/m³, m², m⁴, cm², cm⁴, GPa, MPa, kN/m
  const SYSTEMS = {
    'kN-m': {
      label:   'kN, m',
      name:    'SI (kN, m)',
      short:   'kN·m',
      // Display labels
      force:   'kN',
      length:  'm',
      moment:  'kNm',
      stress:  'kPa',
      pressure:'kN/m²',
      distLoad:'kN/m',
      area:    'm²',
      inertia: 'm⁴',
      secArea: 'cm²',
      secI:    'cm⁴',
      modulus: 'GPa',
      density: 'kN/m³',
      // Conversion FROM internal (kN, m, kNm ...) TO display
      toDisp: {
        force:   1,          // kN → kN
        length:  1,          // m → m
        moment:  1,          // kNm → kNm
        stress:  1,          // kPa → kPa (kN/m²)
        distLoad:1,          // kN/m → kN/m
        secArea: 1,          // cm² → cm²
        secI:    1,          // cm⁴ → cm⁴
        modulus: 1,          // GPa → GPa
        density: 1,          // kN/m³ → kN/m³
        displacement: 1000,  // m → mm for display
        dispUnit:'mm'
      },
      // Conversion FROM display TO internal
      fromDisp: {
        force:   1, length:  1, moment:  1, stress:  1,
        distLoad:1, secArea: 1, secI:    1, modulus: 1, density: 1,
        displacement: 0.001
      },
      decimals: { force:3, length:3, moment:3, stress:2, distLoad:3, displacement:2 }
    },

    'kN-mm': {
      label:   'kN, mm',
      name:    'kN, mm',
      short:   'kN·mm',
      force:   'kN',   length:  'mm',  moment:  'kNmm',
      // distLoad label was 'kN/m' while toDisp.distLoad converts to kN/mm,
      // so a 10 kN/m load rendered as "0.01 kN/m".
      stress:  'MPa',  pressure:'MPa', distLoad:'kN/mm',
      area:    'mm²',  inertia: 'mm⁴', secArea: 'mm²',
      secI:    'mm⁴',  modulus: 'MPa', density: 'kN/m³',
      toDisp: {
        force:   1,           // kN → kN
        length:  1000,        // m → mm
        moment:  1000,        // kNm → kNmm. Was 1 (labelled 'kNm'), the only
                              // system where moment != force x length, so a
                              // results table mixed mm lengths with kN·m moments.
        stress:  0.001,       // kPa -> MPa (1 kPa = 0.001 MPa)
        distLoad:0.001,       // kN/m → kN/mm
        secArea: 100,         // cm² → mm² ×100 (1cm²=100mm²)
        secI:    10000,       // cm⁴ → mm⁴ ×10000
        modulus: 1000,        // GPa → MPa ×1000 wait GPa = 1e6 kPa = 1e3 MPa
        density: 1,
        displacement: 1000, dispUnit:'mm'
      },
      fromDisp: {
        force:1, length:0.001, moment:0.001, stress:1000,   // MPa -> kPa
        distLoad:1000, secArea:0.01, secI:0.0001, modulus:0.001, density:1,
        displacement:0.001
      },
      decimals: { force:3, length:1, moment:0, stress:3, distLoad:4, displacement:2 }
    },

    'kip-ft': {
      label:   'kip, ft',
      name:    'Imperial (kip, ft)',
      short:   'kip·ft',
      force:   'kip',  length:  'ft',   moment:  'kip·ft',
      stress:  'ksf',  pressure:'ksf',  distLoad:'kip/ft',
      area:    'ft²',  inertia: 'ft⁴',  secArea: 'in²',
      secI:    'in⁴',  modulus: 'ksi',  density: 'pcf',
      toDisp: {
        force:   0.2248089,     // kN → kip (1 kip = 4.44822 kN)
        length:  3.28084,       // m → ft
        moment:  0.7375621,     // kNm → kip·ft (1 kip·ft = 1.35582 kNm)
        stress:  0.020885,      // kPa → ksf (1 ksf = 47.8803 kPa)
        distLoad:0.06852,       // kN/m → kip/ft (1 kip/ft = 14.5939 kN/m)
        secArea: 0.15500,       // cm² → in² (1 in² = 6.4516 cm²)
        secI:    0.024025,      // cm⁴ → in⁴ (1 in⁴ = 41.623 cm⁴)
        modulus: 145.0377,      // GPa -> ksi. Was 0.14504, which is GPa -> Msi.
                                // The label says ksi and fromDisp (0.00689476 =
                                // ksi -> GPa) already assumed ksi, so E displayed
                                // 1000x low: 200 GPa steel read 29 ksi instead of
                                // 29008 ksi, and the round trip did not close.
        density: 6.36588,       // kN/m³ → pcf (1 pcf = 0.157087 kN/m³)
        displacement: 39.3701,  // m → in
        dispUnit: 'in'
      },
      fromDisp: {
        force:4.44822, length:0.3048, moment:1.35582, stress:47.8803,
        distLoad:14.5939, secArea:6.4516, secI:41.623, modulus:6.89476e-3,
        density:0.157087, displacement:0.0254
      },
      decimals: { force:4, length:3, moment:4, stress:4, distLoad:4, displacement:3 }
    },

    'kip-in': {
      label:   'kip, in',
      name:    'Imperial (kip, in)',
      short:   'kip·in',
      force:   'kip',  length:  'in',   moment:  'kip·in',
      stress:  'ksi',  pressure:'ksi',  distLoad:'kip/in',
      area:    'in²',  inertia: 'in⁴',  secArea: 'in²',
      secI:    'in⁴',  modulus: 'ksi',  density: 'pcf',
      toDisp: {
        force:   0.2248089,
        length:  39.3701,       // m → in
        moment:  8.85075,       // kNm → kip·in (1 kip·in = 0.112985 kNm)
        stress:  0.000145038,   // kPa -> ksi (exact, so the round trip closes)
        distLoad:0.005710,      // kN/m → kip/in
        secArea: 0.15500,       // cm² → in²
        secI:    0.024025,      // cm⁴ → in⁴
        modulus: 145.0377,      // GPa -> ksi (0.14504 was GPa -> Msi)
        density: 6.36588,
        displacement: 39.3701, dispUnit: 'in'
      },
      fromDisp: {
        force:4.44822, length:0.0254, moment:0.112985, stress:6894.76,
        distLoad:175.127, secArea:6.4516, secI:41.623, modulus:6.89476e-3,
        density:0.157087, displacement:0.0254
      },
      decimals: { force:4, length:3, moment:3, stress:5, distLoad:5, displacement:3 }
    },

    'N-mm': {
      label:   'N, mm',
      name:    'N, mm (fine)',
      short:   'N·mm',
      force:   'N',    length:  'mm',   moment:  'Nmm',
      stress:  'MPa',  pressure:'MPa',  distLoad:'N/mm',
      area:    'mm²',  inertia: 'mm⁴',  secArea: 'mm²',
      secI:    'mm⁴',  modulus: 'MPa',  density: 'kN/m³',
      toDisp: {
        force:   1000,          // kN → N
        length:  1000,          // m → mm
        moment:  1e6,           // kNm → Nmm
        stress:  0.001,         // kPa -> MPa (N/mm2 = MPa = 1000 kPa). The old
                                // value of 1 left this labelled MPa while still
                                // carrying kPa, i.e. 1000x too large.
        distLoad:1,             // kN/m → N/mm (1 kN/m = 1 N/mm)
        secArea: 100,           // cm² → mm²
        secI:    10000,         // cm⁴ → mm⁴
        modulus: 1000,          // GPa → MPa (×1000)
        density: 1,
        displacement: 1000, dispUnit: 'mm'
      },
      fromDisp: {
        force:0.001, length:0.001, moment:1e-6, stress:1000,  // MPa -> kPa
        distLoad:1, secArea:0.01, secI:0.0001, modulus:0.001, density:1,
        displacement:0.001
      },
      decimals: { force:1, length:1, moment:0, stress:3, distLoad:4, displacement:2 }
    },

    'kN-cm': {
      label:   'kN, cm',
      name:    'kN, cm',
      short:   'kN·cm',
      force:   'kN',   length:  'cm',   moment:  'kNcm',
      stress:  'kN/cm²', pressure:'kN/cm²', distLoad:'kN/cm',
      area:    'cm²',  inertia: 'cm⁴',  secArea: 'cm²',
      secI:    'cm⁴',  modulus: 'kN/cm²', density:'kN/m³',
      toDisp: {
        force:   1,
        length:  100,           // m → cm
        moment:  100,           // kNm → kNcm
        stress:  1e-4,          // kPa → kN/cm². 1 kN/cm² = 1e4 kN/m² = 1e4 kPa,
                                // so the factor is 1/1e4. The old value of 0.1
                                // was 1000x too large — 250 MPa read as 25000
                                // kN/cm² instead of 25. The round trip closed
                                // (0.1 x 10 = 1), so only displayed stress was
                                // wrong, which is why it went unnoticed.
        distLoad:0.01,          // kN/m → kN/cm
        secArea: 1,             // cm² → cm²
        secI:    1,             // cm⁴ → cm⁴
        modulus: 100,           // GPa → kN/cm² (1 GPa = 1e6 kPa = 100 kN/cm²)
        density: 1,
        displacement: 100, dispUnit: 'cm'
      },
      fromDisp: {
        force:1, length:0.01, moment:0.01, stress:1e4,
        distLoad:100, secArea:1, secI:1, modulus:0.01, density:1,
        displacement:0.01
      },
      decimals: { force:3, length:2, moment:2, stress:4, distLoad:4, displacement:2 }
    }
  };

  // ── Current active system ──────────────────────────────────────────────────
  let _current = 'kN-m';   // default SI (kN, m) — standard for structural engineering
  const _listeners = [];   // callbacks when unit changes

  // ── Core API ───────────────────────────────────────────────────────────────
  function current()   { return SYSTEMS[_current]; }
  function currentId() { return _current; }
  function all()       { return SYSTEMS; }

  // Convert a value from internal base to display
  function toDisplay(value, quantity) {
    const sys = SYSTEMS[_current];
    const factor = sys.toDisp[quantity] || 1;
    return value * factor;
  }

  // Convert a value from display to internal base
  function fromDisplay(value, quantity) {
    const sys = SYSTEMS[_current];
    const factor = sys.fromDisp[quantity] || 1;
    return value * factor;
  }

  // Format a number for display with the right decimals
  function fmt(value, quantity, decimals) {
    const sys = SYSTEMS[_current];
    const d   = decimals !== undefined ? decimals : (sys.decimals[quantity] || 3);
    return toDisplay(value, quantity).toFixed(d);
  }

  // Label for a quantity in current units
  function label(quantity) {
    const sys = SYSTEMS[_current];
    return sys[quantity] || '';
  }

  // Switch unit system and notify listeners
  function switchTo(systemId, silent = false) {
    if (!SYSTEMS[systemId]) { console.warn('Unknown unit system:', systemId); return; }
    _current = systemId;
    localStorage.setItem('framesolver_units', systemId);
    if (!silent) _listeners.forEach(fn => fn(systemId, SYSTEMS[systemId]));
  }

  function onSwitch(fn) { _listeners.push(fn); }

  // Load saved preference — fall back to kN-m if no valid saved value
  function loadSaved() {
    const saved = localStorage.getItem('framesolver_units');
    if (saved && SYSTEMS[saved]) {
      switchTo(saved, true);
    } else {
      switchTo('kN-m', true); // default SI
    }
  }

  // ── Update DOM elements with [data-unit] attributes ───────────────────────
  // Elements with data-unit="force" get their text set to the current unit label
  // Elements with data-unit-val="force" and data-val-base="123" get converted value
  function updateDOM() {
    const sys = SYSTEMS[_current];

    // Update unit label spans: <span data-unit="force"></span>
    document.querySelectorAll('[data-unit]').forEach(el => {
      const q = el.dataset.unit;
      el.textContent = sys[q] || el.textContent;
    });

    // Update displayed values: <span data-unit-val="force" data-val-base="10.5"></span>
    document.querySelectorAll('[data-unit-val]').forEach(el => {
      const q    = el.dataset.unitVal;
      const base = parseFloat(el.dataset.valBase);
      if (!isNaN(base)) {
        const d = sys.decimals[q] || 3;
        el.textContent = (base * (sys.toDisp[q] || 1)).toFixed(d);
      }
    });

    // Update input placeholders / labels in tables
    document.querySelectorAll('[data-unit-label]').forEach(el => {
      const q = el.dataset.unitLabel;
      // The markup already supplies the surrounding brackets, e.g.
      // <th>X [<span data-unit-label="length">m</span>]</th> — adding another
      // pair here rendered "X [[m]]".
      el.textContent = sys[q] || '';
    });
  }

  // ── Build the toolbar unit switcher dropdown HTML ─────────────────────────
  function buildSwitcherHTML() {
    const opts = Object.entries(SYSTEMS).map(([id, s]) =>
      `<option value="${id}" ${id === _current ? 'selected' : ''}>${s.name}</option>`
    ).join('');
    return `
      <div class="unit-switcher" style="
        display:flex;align-items:center;gap:4px;padding:0 6px;
        border-left:1px solid var(--border-panel);border-right:1px solid var(--border-panel);">
        <span style="font-size:10px;color:var(--text-sec);white-space:nowrap">Units:</span>
        <select class="unit-system-sel" aria-label="Unit system" style="
          font-size:11px;padding:2px 4px;border:1px solid var(--border);
          border-radius:3px;background:var(--bg-pane);color:var(--text);
          cursor:pointer;max-width:130px;">
          ${opts}
        </select>
      </div>`;
  }

  // Wire ALL unit switcher selects after DOM is ready
  function wire() {
    loadSaved();
    // Wire every instance of unit-system-sel (there may be several)
    function wireAll() {
      document.querySelectorAll('.unit-system-sel').forEach(sel => {
        sel.value = _current;
        // Remove old listener to avoid duplicates
        sel._unitWired = true;
        sel.addEventListener('change', function() {
          switchTo(this.value);
        });
      });
    }
    wireAll();
    // Keep all selects in sync whenever the unit changes
    onSwitch(() => {
      updateDOM();
      document.querySelectorAll('.unit-system-sel').forEach(sel => {
        sel.value = _current;
      });
    });
  }

  // Scale every numeric own-property of `obj`, choosing the factor per key.
  // Non-numeric values (matrices, ids) are copied through untouched.
  function scaleKeys(obj, factorFor) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      out[k] = (typeof v === 'number' && isFinite(v)) ? v * factorFor(k) : v;
    }
    return out;
  }

  // ── Convert entire results object to display units ─────────────────────────
  // Returns a shallow copy with converted values for display in tables/report
  function convertResults(results) {
    if (!results || !results.elemForces) return results;
    const s = SYSTEMS[_current];
    const fF  = s.toDisp.force  || 1;
    const fM  = s.toDisp.moment || 1;
    const fL  = s.toDisp.length || 1;
    const fD  = s.toDisp.displacement || 1;

    return {
      ...results,
      elemForces: results.elemForces.map(ef => ({
        ...ef,
        N1: ef.N1 * fF, V1: ef.V1 * fF, M1: ef.M1 * fM,
        N2: ef.N2 * fF, V2: ef.V2 * fF, M2: ef.M2 * fM,
        L:  ef.L  * fL
      })),
      // 3D results carry Rx/Ry/Rz + Mx/My/Mz and w/θx/θy/θz. Converting a fixed
      // 2D key list dropped every extra component to undefined, so switching
      // units blanked half the reaction table on a 3D model. Scale whichever
      // keys are actually present: R* as a force, M*/θ* as a moment/rotation.
      reactions: Object.fromEntries(
        Object.entries(results.reactions || {}).map(([id, r]) => [
          id, scaleKeys(r, k => (k[0] === 'R' ? fF : fM))
        ])
      ),
      disp: Object.fromEntries(
        Object.entries(results.disp || {}).map(([id, d]) => [
          // Rotations (theta, θx/θy/θz) stay in radians; u/v/w are lengths.
          id, scaleKeys(d, k => (k === 'theta' || k.startsWith('θ') ? 1 : fD))
        ])
      )
    };
  }

  // ── Quick reference: convert a force from any system to internal (kN) ──────
  const FORCE_TO_KN  = { kN:1, N:0.001, kip:4.44822, lb:0.004448, tf:9.80665 };
  const LENGTH_TO_M  = { m:1, mm:0.001, cm:0.01, ft:0.3048, 'in':0.0254 };
  const STRESS_TO_KPA= { kPa:1, MPa:1000, GPa:1e6, ksi:6894.76, psi:6.89476, ksf:47.88 };

  function convertForce(v, fromUnit)  { return v * (FORCE_TO_KN[fromUnit]  || 1); }
  function convertLength(v, fromUnit) { return v * (LENGTH_TO_M[fromUnit]  || 1); }
  function convertStress(v, fromUnit) { return v * (STRESS_TO_KPA[fromUnit]|| 1); }

  // ── Unit info card HTML (for help dialogs) ────────────────────────────────
  function buildUnitInfoHTML() {
    const sys = SYSTEMS[_current];
    return `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:12px;padding:8px;">
        ${['force','length','moment','stress','distLoad','secArea','secI','modulus','density']
          .map(q => `<div style="background:var(--bg-tbl-alt);padding:5px 8px;border-radius:5px;">
            <div style="color:var(--text-sec);font-size:10px;text-transform:uppercase">${q}</div>
            <div style="font-weight:700;color:#1565c0;">${sys[q] || '—'}</div>
          </div>`).join('')}
      </div>`;
  }

  return {
    SYSTEMS,
    current, currentId, all,
    toDisplay, fromDisplay, fmt, label,
    switchTo, onSwitch, loadSaved,
    updateDOM,
    buildSwitcherHTML,
    wire,
    convertResults,
    convertForce, convertLength, convertStress,
    buildUnitInfoHTML
  };

})();

window.UnitSystem = UnitSystem;
