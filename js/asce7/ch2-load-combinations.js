// ──────────────────────────────────────────────────────────────────
//  ASCE 7-16 Chapter 2 — Combinations of Loads
//
//  Reference: ASCE/SEI 7-16
//    §2.3   Load Combinations for Strength Design (LRFD)
//    §2.3.1 Basic Combinations (1–5)
//    §2.3.6 Seismic Combinations (6–7)
//    §2.4   Load Combinations for Allowable Stress Design (ASD)
//    §2.4.1 Basic Combinations (1–7)
//    §2.4.5 Seismic Combinations (8–10)
//    §2.5   Extraordinary Event Combinations
//
//  Load symbols (§2.2):
//    D = Dead  |  L = Live  |  Lr = Roof Live  |  S = Snow
//    R = Rain  |  W = Wind  |  E = Earthquake  |  H = Earth pressure
//    N = Notional (§1.4)
//
//  Exposed as: window.ASCE7_Ch2
// ──────────────────────────────────────────────────────────────────
'use strict';

window.ASCE7_Ch2 = (() => {

  // ──────────────────────────────────────────────────────────────
  //  LRFD — §2.3 Strength Design Basic Combinations
  //  Notation: each combo is { id, label, expression, terms[] }
  //  terms[] drives the linear superposition in the solver:
  //    { caseType, factor }  — caseType matches loadCase.type
  // ──────────────────────────────────────────────────────────────

  /** §2.3.1 LRFD Basic Combinations 1–5 */
  const LRFD_BASIC = [
    {
      id: 'LRFD-1',
      ref: '§2.3.1 Comb. 1',
      label: '1.4D',
      expression: '1.4D',
      governs: 'Gravity (dead-load dominated)',
      terms: [{ type: 'DL', factor: 1.4 }]
    },
    {
      id: 'LRFD-2a',
      ref: '§2.3.1 Comb. 2',
      label: '1.2D + 1.6L + 0.5Lr',
      expression: '1.2D + 1.6L + 0.5Lr',
      governs: 'Gravity (live-load dominated, roof live companion)',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'LL', factor: 1.6 }, { type: 'LLr', factor: 0.5 }]
    },
    {
      id: 'LRFD-2b',
      ref: '§2.3.1 Comb. 2',
      label: '1.2D + 1.6L + 0.5S',
      expression: '1.2D + 1.6L + 0.5S',
      governs: 'Gravity (live-load dominated, snow companion)',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'LL', factor: 1.6 }, { type: 'SL', factor: 0.5 }]
    },
    {
      id: 'LRFD-2c',
      ref: '§2.3.1 Comb. 2',
      label: '1.2D + 1.6L + 0.5R',
      expression: '1.2D + 1.6L + 0.5R',
      governs: 'Gravity (live-load dominated, rain companion)',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'LL', factor: 1.6 }, { type: 'RL', factor: 0.5 }]
    },
    {
      id: 'LRFD-3a',
      ref: '§2.3.1 Comb. 3',
      label: '1.2D + 1.6Lr + L',
      expression: '1.2D + 1.6Lr + L',
      governs: 'Roof live dominant',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'LLr', factor: 1.6 }, { type: 'LL', factor: 1.0 }]
    },
    {
      id: 'LRFD-3b',
      ref: '§2.3.1 Comb. 3',
      label: '1.2D + 1.6S + L',
      expression: '1.2D + 1.6S + L',
      governs: 'Snow dominant',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'SL', factor: 1.6 }, { type: 'LL', factor: 1.0 }]
    },
    {
      id: 'LRFD-3c',
      ref: '§2.3.1 Comb. 3',
      label: '1.2D + 1.6R + L',
      expression: '1.2D + 1.6R + L',
      governs: 'Rain dominant',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'RL', factor: 1.6 }, { type: 'LL', factor: 1.0 }]
    },
    {
      id: 'LRFD-3d',
      ref: '§2.3.1 Comb. 3',
      label: '1.2D + 1.6Lr + 0.5W',
      expression: '1.2D + 1.6Lr + 0.5W',
      governs: 'Roof live dominant, wind companion',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'LLr', factor: 1.6 }, { type: 'WL', factor: 0.5 }]
    },
    {
      id: 'LRFD-3e',
      ref: '§2.3.1 Comb. 3',
      label: '1.2D + 1.6S + 0.5W',
      expression: '1.2D + 1.6S + 0.5W',
      governs: 'Snow dominant, wind companion',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'SL', factor: 1.6 }, { type: 'WL', factor: 0.5 }]
    },
    {
      id: 'LRFD-4a',
      ref: '§2.3.1 Comb. 4',
      label: '1.2D + 1.0W + L + 0.5Lr',
      expression: '1.2D + 1.0W + L + 0.5Lr',
      governs: 'Wind dominant, gravity companion',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'WL', factor: 1.0 }, { type: 'LL', factor: 1.0 }, { type: 'LLr', factor: 0.5 }]
    },
    {
      id: 'LRFD-4b',
      ref: '§2.3.1 Comb. 4',
      label: '1.2D + 1.0W + L + 0.5S',
      expression: '1.2D + 1.0W + L + 0.5S',
      governs: 'Wind dominant, snow companion',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'WL', factor: 1.0 }, { type: 'LL', factor: 1.0 }, { type: 'SL', factor: 0.5 }]
    },
    {
      id: 'LRFD-5a',
      ref: '§2.3.1 Comb. 5',
      label: '0.9D + 1.0W',
      expression: '0.9D + 1.0W',
      governs: 'Wind uplift / overturning (minimum dead)',
      terms: [{ type: 'DL', factor: 0.9 }, { type: 'WL', factor: 1.0 }]
    },
    {
      id: 'LRFD-5b',
      ref: '§2.3.1 Comb. 5',
      label: '0.9D − 1.0W',
      expression: '0.9D − 1.0W',
      governs: 'Wind reversal (suction side check)',
      terms: [{ type: 'DL', factor: 0.9 }, { type: 'WL', factor: -1.0 }]
    }
  ];

  /** §2.3.6 LRFD Seismic Combinations 6–7 */
  const LRFD_SEISMIC = [
    {
      id: 'LRFD-6a',
      ref: '§2.3.6 Comb. 6',
      label: '1.2D + Ev + Eh + L + 0.2S',
      expression: '(1.2 + 0.2Sds)D + ρQe + L + 0.2S',
      governs: 'Seismic (additive vertical effect)',
      notes: 'Ev = 0.2·Sds·D  |  Eh = ρ·Qe  (Chapter 12)',
      terms: [{ type: 'DL', factor: 1.2 }, { type: 'EQv', factor: 1.0 }, { type: 'EQh', factor: 1.0 }, { type: 'LL', factor: 1.0 }, { type: 'SL', factor: 0.2 }]
    },
    {
      id: 'LRFD-7a',
      ref: '§2.3.6 Comb. 7',
      label: '0.9D − Ev + Eh',
      expression: '(0.9 − 0.2Sds)D + ρQe',
      governs: 'Seismic (overturning/uplift check)',
      notes: 'Ev = 0.2·Sds·D  |  Eh = ρ·Qe  (Chapter 12)',
      terms: [{ type: 'DL', factor: 0.9 }, { type: 'EQv', factor: -1.0 }, { type: 'EQh', factor: 1.0 }]
    }
  ];

  // ──────────────────────────────────────────────────────────────
  //  ASD — §2.4 Allowable Stress Design Combinations
  // ──────────────────────────────────────────────────────────────

  /** §2.4.1 ASD Basic Combinations 1–7 */
  const ASD_BASIC = [
    {
      id: 'ASD-1',
      ref: '§2.4.1 Comb. 1',
      label: 'D',
      expression: 'D',
      governs: 'Dead load only',
      terms: [{ type: 'DL', factor: 1.0 }]
    },
    {
      id: 'ASD-2',
      ref: '§2.4.1 Comb. 2',
      label: 'D + L',
      expression: 'D + L',
      governs: 'Dead + live',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 1.0 }]
    },
    {
      id: 'ASD-3a',
      ref: '§2.4.1 Comb. 3',
      label: 'D + Lr',
      expression: 'D + Lr',
      governs: 'Dead + roof live',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LLr', factor: 1.0 }]
    },
    {
      id: 'ASD-3b',
      ref: '§2.4.1 Comb. 3',
      label: 'D + S',
      expression: 'D + S',
      governs: 'Dead + snow',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'SL', factor: 1.0 }]
    },
    {
      id: 'ASD-3c',
      ref: '§2.4.1 Comb. 3',
      label: 'D + R',
      expression: 'D + R',
      governs: 'Dead + rain',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'RL', factor: 1.0 }]
    },
    {
      id: 'ASD-4a',
      ref: '§2.4.1 Comb. 4',
      label: 'D + 0.75L + 0.75Lr',
      expression: 'D + 0.75L + 0.75Lr',
      governs: 'Dead + 75% live + 75% roof live',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 0.75 }, { type: 'LLr', factor: 0.75 }]
    },
    {
      id: 'ASD-4b',
      ref: '§2.4.1 Comb. 4',
      label: 'D + 0.75L + 0.75S',
      expression: 'D + 0.75L + 0.75S',
      governs: 'Dead + 75% live + 75% snow',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 0.75 }, { type: 'SL', factor: 0.75 }]
    },
    {
      id: 'ASD-5a',
      ref: '§2.4.1 Comb. 5',
      label: 'D + 0.6W',
      expression: 'D + 0.6W',
      governs: 'Dead + wind (ASD wind factor)',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'WL', factor: 0.6 }]
    },
    {
      id: 'ASD-5b',
      ref: '§2.4.1 Comb. 5',
      label: 'D + 0.7E',
      expression: 'D + 0.7E',
      governs: 'Dead + earthquake (ASD seismic factor)',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'EQ', factor: 0.7 }]
    },
    {
      id: 'ASD-6a',
      ref: '§2.4.1 Comb. 6',
      label: 'D + 0.75L + 0.75(0.6W) + 0.75Lr',
      expression: 'D + 0.75L + 0.45W + 0.75Lr',
      governs: 'Dead + live + wind + roof live (companion)',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 0.75 }, { type: 'WL', factor: 0.45 }, { type: 'LLr', factor: 0.75 }]
    },
    {
      id: 'ASD-6b',
      ref: '§2.4.1 Comb. 6',
      label: 'D + 0.75L + 0.75(0.6W) + 0.75S',
      expression: 'D + 0.75L + 0.45W + 0.75S',
      governs: 'Dead + live + wind + snow (companion)',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 0.75 }, { type: 'WL', factor: 0.45 }, { type: 'SL', factor: 0.75 }]
    },
    {
      id: 'ASD-6c',
      ref: '§2.4.1 Comb. 6',
      label: 'D + 0.75L + 0.75(0.7E) + 0.75S',
      expression: 'D + 0.75L + 0.525E + 0.75S',
      governs: 'Dead + live + seismic + snow (companion)',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'LL', factor: 0.75 }, { type: 'EQ', factor: 0.525 }, { type: 'SL', factor: 0.75 }]
    },
    {
      id: 'ASD-7a',
      ref: '§2.4.1 Comb. 7',
      label: '0.6D + 0.6W',
      expression: '0.6D + 0.6W',
      governs: 'Wind overturning (minimum dead load)',
      terms: [{ type: 'DL', factor: 0.6 }, { type: 'WL', factor: 0.6 }]
    },
    {
      id: 'ASD-7b',
      ref: '§2.4.1 Comb. 7',
      label: '0.6D + 0.7E',
      expression: '0.6D + 0.7E',
      governs: 'Seismic overturning (minimum dead load)',
      terms: [{ type: 'DL', factor: 0.6 }, { type: 'EQ', factor: 0.7 }]
    }
  ];

  /** §2.4.5 ASD Seismic Combinations 8–10 */
  const ASD_SEISMIC = [
    {
      id: 'ASD-8',
      ref: '§2.4.5 Comb. 8',
      label: '1.0D + 0.7Ev + 0.7Eh',
      expression: '(1.0 + 0.14Sds)D + 0.7ρQe',
      governs: 'ASD seismic (additive vertical)',
      notes: 'Ev = 0.2·Sds·D × 0.7 factor applied',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'EQv', factor: 0.7 }, { type: 'EQh', factor: 0.7 }]
    },
    {
      id: 'ASD-9',
      ref: '§2.4.5 Comb. 9',
      label: '1.0D + 0.525Ev + 0.525Eh + 0.75L + 0.75S',
      expression: '(1.0 + 0.105Sds)D + 0.525ρQe + 0.75L + 0.75S',
      governs: 'ASD seismic with gravity companions',
      notes: 'Full companion load case',
      terms: [{ type: 'DL', factor: 1.0 }, { type: 'EQv', factor: 0.525 }, { type: 'EQh', factor: 0.525 }, { type: 'LL', factor: 0.75 }, { type: 'SL', factor: 0.75 }]
    },
    {
      id: 'ASD-10',
      ref: '§2.4.5 Comb. 10',
      label: '0.6D + 0.7Ev + 0.7Eh',
      expression: '(0.6 − 0.14Sds)D + 0.7ρQe',
      governs: 'ASD seismic overturning (minimum dead)',
      notes: 'Critical for cantilevered or tall structures',
      terms: [{ type: 'DL', factor: 0.6 }, { type: 'EQv', factor: -0.7 }, { type: 'EQh', factor: 0.7 }]
    }
  ];

  /** §2.5 Extraordinary Event Combinations */
  const EXTRAORDINARY = [
    {
      id: 'EXT-1',
      ref: '§2.5.2.1',
      label: '(0.9 or 1.2)D + Ak + L + 0.2S',
      expression: '(0.9 or 1.2)D + Ak + L + 0.2S',
      governs: 'Capacity check under extraordinary event',
      notes: 'Ak = load effect from extraordinary event (blast, impact, etc.)'
    },
    {
      id: 'EXT-2',
      ref: '§2.5.2.2',
      label: '(0.9 or 1.2)D + 0.5L + Ak',
      expression: '(0.9 or 1.2)D + 0.5L + Ak',
      governs: 'Residual capacity check post extraordinary event'
    }
  ];

  // ──────────────────────────────────────────────────────────────
  //  Generator: build a filtered set of combos based on which
  //  load types are actually present in the model
  // ──────────────────────────────────────────────────────────────

  /**
   * Given a set of load case types present in the model, return
   * only the combinations whose terms include at least one matching type.
   *
   * @param {string[]} presentTypes  e.g. ['DL','LL','WL']
   * @param {'LRFD'|'ASD'|'both'} method
   * @param {boolean} includeSeismic
   * @returns {Array}  filtered combination objects
   */
  function generateCombinations(presentTypes, method = 'LRFD', includeSeismic = false) {
    const has = t => presentTypes.includes(t);
    const relevant = combo => combo.terms && combo.terms.some(t => has(t.type));

    let result = [];
    if (method === 'LRFD' || method === 'both') {
      result = result.concat(LRFD_BASIC.filter(relevant));
      if (includeSeismic && (has('EQh') || has('EQ'))) result = result.concat(LRFD_SEISMIC);
    }
    if (method === 'ASD' || method === 'both') {
      result = result.concat(ASD_BASIC.filter(relevant));
      if (includeSeismic && (has('EQh') || has('EQ'))) result = result.concat(ASD_SEISMIC);
    }
    return result;
  }

  /**
   * Convert an ASCE 7-16 combination definition into the app's
   * loadCombo format for use with the existing solver.
   *
   * @param {object} combo   — from LRFD_BASIC / ASD_BASIC etc.
   * @param {object[]} loadCases — app's current load cases array
   * @param {number} nextComboId — next ID to assign
   * @returns {object|null}  loadCombo object or null if no matching cases
   */
  function comboToAppFormat(combo, loadCases, nextComboId) {
    const factors = {};
    let matched = false;
    combo.terms.forEach(term => {
      const lc = loadCases.find(c => c.type === term.type);
      if (lc) {
        factors[lc.id] = (factors[lc.id] || 0) + term.factor;
        matched = true;
      }
    });
    if (!matched) return null;
    return {
      id: nextComboId,
      name: combo.label,
      ref: combo.ref,
      description: combo.governs || '',
      method: combo.id.startsWith('ASD') ? 'ASD' : 'LRFD',
      factors   // { lcId: factor, ... }
    };
  }

  /**
   * Auto-generate all applicable ASCE 7-16 combinations for the
   * current app model and append to loadCombos.
   *
   * @param {object[]} loadCases   app load cases
   * @param {'LRFD'|'ASD'|'both'} method
   * @param {boolean} includeSeismic
   * @returns {object[]}  new combos (not yet added to app state)
   */
  function autoGenerateCombos(loadCases, method = 'LRFD', includeSeismic = false) {
    const presentTypes = loadCases.map(lc => lc.type);
    const comboDefs = generateCombinations(presentTypes, method, includeSeismic);

    let id = 100; // start IDs at 100 to avoid clashing with existing
    const result = [];
    comboDefs.forEach(def => {
      const combo = comboToAppFormat(def, loadCases, id);
      if (combo) { result.push(combo); id++; }
    });
    return result;
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    LRFD_BASIC,
    LRFD_SEISMIC,
    ASD_BASIC,
    ASD_SEISMIC,
    EXTRAORDINARY,
    generateCombinations,
    comboToAppFormat,
    autoGenerateCombos,

    /** Return all defined combinations (for documentation rendering) */
    getAllCombinations() {
      return {
        lrfd_basic:   LRFD_BASIC,
        lrfd_seismic: LRFD_SEISMIC,
        asd_basic:    ASD_BASIC,
        asd_seismic:  ASD_SEISMIC,
        extraordinary: EXTRAORDINARY
      };
    }
  };
})();
