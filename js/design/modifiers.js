// ══════════════════════════════════════════════════════════════════════════════
//  modifiers.js  —  Property Modifier UI System (ETABS-style)
//  Manages per-beam stiffness modifiers: f11, fi2, fi3, fm, f22, f33, fmass, fwgt
//  Source of truth for modifier presets (SectionDB.modifierPresets derives
//  from PRESETS below). Integrates with DesignChecks.describeModifiers
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const PropertyModifiers = (() => {

  // Default (unity) modifiers
  const DEFAULTS = {
    f11:   1.0,   // Axial stiffness   EA
    f22:   1.0,   // Shear stiffness   GAv,y
    f33:   1.0,   // Shear stiffness   GAv,z
    fm:    1.0,   // Torsional stiffness GJ
    fi2:   1.0,   // Bending stiffness  EI2 (weak axis)
    fi3:   1.0,   // Bending stiffness  EI3 (strong axis) ← most used
    fmass: 1.0,   // Mass modifier
    fwgt:  1.0    // Weight modifier
  };

  // Human-readable labels for each factor
  const LABELS = {
    f11:   { label: 'Axial (EA)',        symbol: 'f₁₁', desc: 'Multiplier on axial stiffness EA — reduces column/brace area contribution' },
    f22:   { label: 'Shear y (GAvy)',    symbol: 'f₂₂', desc: 'Multiplier on shear stiffness along local 2-axis (out-of-plane shear)' },
    f33:   { label: 'Shear z (GAvz)',    symbol: 'f₃₃', desc: 'Multiplier on shear stiffness along local 3-axis (in-plane shear)' },
    fm:    { label: 'Torsion (GJ)',       symbol: 'fₘ',  desc: 'Multiplier on torsional stiffness GJ — critical for open sections' },
    fi2:   { label: 'Bending I₂ (weak)', symbol: 'fᵢ₂', desc: 'Multiplier on weak-axis bending stiffness EI₂' },
    fi3:   { label: 'Bending I₃ (strong)', symbol: 'fᵢ₃', desc: 'Multiplier on strong-axis bending stiffness EI₃ — most commonly reduced for cracked RC' },
    fmass: { label: 'Mass',              symbol: 'fₘₐₛₛ', desc: 'Multiplier on element mass (affects seismic weight, self-weight)' },
    fwgt:  { label: 'Weight',            symbol: 'fᵥᵧₜ', desc: 'Multiplier on element self-weight loading' }
  };

  // Preset definitions — the single source of truth for modifier presets
  const PRESETS = {
    'none': {
      name: 'None (Unity)',
      desc: 'All modifiers = 1.0 (no reduction)',
      values: { ...DEFAULTS }
    },
    'cracked_beam': {
      name: 'Cracked RC Beam (EC2)',
      desc: 'EI reduced to 35% for cracked concrete beams (EC2 / ETABS default)',
      values: { ...DEFAULTS, fi3: 0.35, fi2: 0.35 }
    },
    'cracked_col': {
      name: 'Cracked RC Column (EC2)',
      desc: 'EI reduced to 70% for cracked concrete columns under combined N+M',
      values: { ...DEFAULTS, fi3: 0.70, fi2: 0.70 }
    },
    'cracked_wall': {
      name: 'Cracked RC Wall (EC2)',
      desc: 'EI reduced to 35% for cracked shear walls (in-plane stiffness)',
      values: { ...DEFAULTS, fi3: 0.35, fi2: 0.35, f11: 0.80 }
    },
    'steel_seismic': {
      name: 'Steel (Seismic — P-Delta)',
      desc: 'Slight stiffness reduction to account for connection flexibility',
      values: { ...DEFAULTS, fi3: 0.90, fi2: 0.90 }
    },
    'timber_service': {
      name: 'Timber (Service Class 2)',
      desc: 'Kdef = 0.8 effective stiffness for long-term loading (EC5)',
      values: { ...DEFAULTS, f11: 0.80, fi3: 0.80, fi2: 0.80 }
    },
    'pinned_ends': {
      name: 'Pinned-End Beam (moment release)',
      desc: 'Zero bending stiffness at ends — use End Releases instead; this reduces EI uniformly',
      values: { ...DEFAULTS, fi3: 0.50 }
    },
    'semi_rigid': {
      name: 'Semi-Rigid Frame',
      desc: 'AISC: moderate connection rigidity, ~80% frame stiffness',
      values: { ...DEFAULTS, fi3: 0.80, fi2: 0.80, f11: 0.95 }
    },
    // ── ACI 318-19 §6.6.3.1.1 cracked section stiffness modifiers ────────────
    'aci_beam': {
      name: 'ACI §6.6.3.1 — Beam / One-Way Slab  (0.35·EI)',
      desc: 'Cracked beam stiffness: Ie = 0.35·Ig  per ACI 318-19 §6.6.3.1.1(a)',
      values: { ...DEFAULTS, fi3: 0.35, fi2: 0.35 }
    },
    'aci_col': {
      name: 'ACI §6.6.3.1 — Column  (0.70·EI)',
      desc: 'Cracked column stiffness: Ie = 0.70·Ig  per ACI 318-19 §6.6.3.1.1(b)',
      values: { ...DEFAULTS, fi3: 0.70, fi2: 0.70 }
    },
    'aci_wall': {
      name: 'ACI §6.6.3.1 — Shear Wall (cracked, 0.35·EI)',
      desc: 'Cracked shear wall: Ie = 0.35·Ig, Ae = 0.80·Ag  per ACI 318-19 §6.6.3.1.1(c)',
      values: { ...DEFAULTS, fi3: 0.35, fi2: 0.35, f11: 0.80 }
    },
    'aci_slab': {
      name: 'ACI §6.6.3.1 — Two-Way Slab / Flat Plate  (0.25·EI)',
      desc: 'Cracked slab stiffness: Ie = 0.25·Ig  per ACI 318-19 §6.6.3.1.1(e)',
      values: { ...DEFAULTS, fi3: 0.25, fi2: 0.25 }
    }
  };

  // Per-beam modifier storage: beamId → modifiers object
  const _store = new Map();

  // ── Get / Set ─────────────────────────────────────────────────────────────
  function get(beamId) {
    return _store.get(beamId) || { ...DEFAULTS };
  }

  function set(beamId, mods) {
    // Clamp all values to [0.01, 100]
    const clamped = {};
    for (const [k, v] of Object.entries(mods)) {
      clamped[k] = Math.max(0.01, Math.min(100, +v || 1.0));
    }
    _store.set(beamId, { ...DEFAULTS, ...clamped });
  }

  function applyPreset(beamId, presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return;
    _store.set(beamId, { ...preset.values });
  }

  function remove(beamId) {
    _store.delete(beamId);
  }

  function isModified(beamId) {
    const m = _store.get(beamId);
    if (!m) return false;
    return Object.entries(m).some(([k, v]) => Math.abs(v - 1.0) > 1e-6);
  }

  function exportAll() {
    const obj = {};
    for (const [id, mods] of _store) obj[id] = { ...mods };
    return obj;
  }

  function importAll(data) {
    _store.clear();
    for (const [id, mods] of Object.entries(data || {})) {
      _store.set(+id, { ...DEFAULTS, ...mods });
    }
  }

  // ── HTML Dialog Builder ────────────────────────────────────────────────────
  // Creates the content for the property modifier dialog for a given beam
  // Returns an HTML string ready to inject into a modal body
  function buildDialogHTML(beamId, currentSection) {
    const mods    = get(beamId);
    const secName = currentSection ? (currentSection.name || 'Unknown section') : '—';

    const presetOptions = Object.entries(PRESETS).map(([key, p]) =>
      `<option value="${key}">${p.name}</option>`
    ).join('');

    const rows = Object.entries(LABELS).map(([key, info]) => {
      const val    = (mods[key] !== undefined ? mods[key] : 1.0);
      const pct    = ((val - 1) * 100).toFixed(0);
      const color  = val < 1.0 ? '#e53935' : val > 1.0 ? '#1565c0' : '#388e3c';
      const badge  = val !== 1.0
        ? `<span style="color:${color};font-size:11px;">(${val < 1 ? '' : '+'}${pct}%)</span>`
        : `<span style="color:#666;font-size:11px;">(unity)</span>`;
      return `
        <tr>
          <td title="${info.desc}">
            <strong>${info.symbol}</strong>
            <span style="font-size:12px;color:var(--text-muted,#666)">${info.label}</span>
          </td>
          <td>
            <input type="number" class="mod-input" data-key="${key}"
              min="0.01" max="100" step="0.05" value="${val}"
              style="width:80px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);">
            ${badge}
          </td>
          <td>
            <input type="range" class="mod-slider" data-key="${key}"
              min="0.01" max="2" step="0.01" value="${Math.min(2, val)}"
              style="width:120px;vertical-align:middle;">
          </td>
        </tr>`;
    }).join('');

    return `
      <div style="font-size:13px;color:var(--text-muted,#666);margin-bottom:8px;">
        Section: <strong>${secName}</strong>
      </div>

      <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <label style="font-weight:600;font-size:13px;">Quick Preset:</label>
        <select id="mod-preset-sel" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);">
          <option value="">— select preset —</option>
          ${presetOptions}
        </select>
        <button id="mod-preset-apply" class="btn-secondary" style="padding:4px 10px;font-size:12px;">Apply</button>
      </div>

      <table style="width:100%;border-collapse:collapse;" id="mod-table">
        <thead>
          <tr style="border-bottom:2px solid var(--border);font-size:12px;color:var(--text-muted,#666);">
            <th style="text-align:left;padding:4px 6px;">Factor</th>
            <th style="text-align:left;padding:4px 6px;">Value</th>
            <th style="text-align:left;padding:4px 6px;">Slider (0–2)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div style="margin-top:10px;padding:8px;background:var(--panel-alt,#f0f4ff);border-radius:6px;font-size:12px;color:var(--text-muted,#555);">
        <strong>Note:</strong> Modifiers affect structural stiffness only. Design checks use
        <em>nominal</em> section properties (unmodified) for capacity calculations per EC3.
        To modify capacity, change fy or section geometry.
      </div>`;
  }

  // Wires up the dialog events after HTML is inserted into DOM
  function wireDialog(beamId, onSave) {
    // Sync slider ↔ number input
    document.querySelectorAll('.mod-input').forEach(inp => {
      const key = inp.dataset.key;
      const slider = document.querySelector(`.mod-slider[data-key="${key}"]`);
      inp.addEventListener('input', () => {
        if (slider) slider.value = Math.min(2, parseFloat(inp.value) || 1);
      });
      if (slider) {
        slider.addEventListener('input', () => {
          inp.value = parseFloat(slider.value).toFixed(2);
        });
      }
    });

    // Preset application
    const presetBtn = document.getElementById('mod-preset-apply');
    if (presetBtn) {
      presetBtn.addEventListener('click', () => {
        const key = document.getElementById('mod-preset-sel').value;
        if (!key) return;
        const preset = PRESETS[key];
        if (!preset) return;
        document.querySelectorAll('.mod-input').forEach(inp => {
          const k = inp.dataset.key;
          const v = preset.values[k] !== undefined ? preset.values[k] : 1.0;
          inp.value = v;
          const sl = document.querySelector(`.mod-slider[data-key="${k}"]`);
          if (sl) sl.value = Math.min(2, v);
        });
      });
    }

    // Save callback
    const saveBtn = document.getElementById('mod-save-btn');
    if (saveBtn && onSave) {
      saveBtn.addEventListener('click', () => {
        const mods = {};
        document.querySelectorAll('.mod-input').forEach(inp => {
          mods[inp.dataset.key] = parseFloat(inp.value) || 1.0;
        });
        set(beamId, mods);
        if (onSave) onSave(beamId, get(beamId));
      });
    }
  }

  // ── Summary table row (for beam table display) ───────────────────────────
  function summaryBadge(beamId) {
    if (!isModified(beamId)) return '';
    const mods = get(beamId);
    const parts = Object.entries(mods)
      .filter(([k, v]) => Math.abs(v - 1.0) > 1e-6)
      .map(([k, v]) => `${LABELS[k]?.symbol || k}=${v}`)
      .join(', ');
    return `<span class="mod-badge" title="${parts}" style="font-size:10px;padding:1px 5px;background:#fff3cd;border-radius:3px;color:#856404;cursor:pointer;">⚙ mods</span>`;
  }

  return {
    DEFAULTS,
    LABELS,
    PRESETS,
    get,
    set,
    applyPreset,
    remove,
    isModified,
    exportAll,
    importAll,
    buildDialogHTML,
    wireDialog,
    summaryBadge
  };

})();

window.PropertyModifiers = PropertyModifiers;
