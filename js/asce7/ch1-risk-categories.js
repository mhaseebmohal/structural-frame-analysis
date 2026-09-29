// ──────────────────────────────────────────────────────────────────
//  ASCE 7-16 Chapter 1 — General: Risk Categories & Importance Factors
//
//  Reference: ASCE/SEI 7-16 Minimum Design Loads and Associated
//  Criteria for Buildings and Other Structures
//    §1.5    Risk Category
//    §1.5.1  Table 1.5-1  Nature of Occupancy
//    §7.3.4  Table 7.3-1  Snow Importance Factor (Is)
//    §11.5.1 Table 11.5-1 Seismic Importance Factor (Ie)
//    §1.4.2  Eq.(1.4-1)   Notional Lateral Force (Fx = 0.01Wx)
//
//  Exposed as: window.ASCE7_Ch1
// ──────────────────────────────────────────────────────────────────
'use strict';

window.ASCE7_Ch1 = (() => {

  // ── §1.5 Risk Categories (Table 1.5-1) ───────────────────────────
  const RISK_CATEGORIES = {
    I: {
      id: 'I',
      label: 'Risk Category I',
      description: 'Low hazard to human life in the event of failure.',
      examples: [
        'Agricultural facilities',
        'Certain temporary facilities',
        'Minor storage facilities'
      ],
      // Importance factors
      Is: 0.80,   // Snow (§7.3.4, Table 7.3-1)
      Ie: 1.00,   // Seismic (§11.5.1, Table 11.5-1)
      // ASCE 7-10 onward dropped the wind importance factor and moved to
      // strength-level maps, one MRI per risk category (§26.5.1, Figs 26.5-1A
      // to 26.5-1D). These carried the pre-7-10 ASD return periods —
      // 10/50/100/700 — against a file that states ASCE 7-16 throughout, so the
      // panel named a wind map that edition does not contain.
      Iw: 'MRI-300',   // Wind: 300-year MRI map (Fig 26.5-1C)
      color: '#43a047'
    },
    II: {
      id: 'II',
      label: 'Risk Category II',
      description: 'Standard occupancy — applies to all buildings not listed in I, III, or IV. This is the default category.',
      examples: [
        'Most office buildings',
        'Residential buildings',
        'Retail facilities',
        'Standard industrial buildings'
      ],
      Is: 1.00,
      Ie: 1.00,
      Iw: 'MRI-700',   // Wind: 700-year MRI map (Fig 26.5-1A)
      color: '#1565c0'
    },
    III: {
      id: 'III',
      label: 'Risk Category III',
      description: 'Substantial hazard to human life in the event of failure.',
      examples: [
        'Buildings with assembly occupancy where L0 > 100 psf (4.79 kN/m²)',
        'Buildings with occupant load >5,000 persons',
        'Elementary/secondary/higher-education schools and daycare facilities with >250 occupants',
        'Healthcare facilities with ≥50 resident patients but without surgery or emergency treatment',
        'Jails and detention facilities',
        'Power-generating stations, water treatment facilities',
        'Telecommunications hubs'
      ],
      Is: 1.10,
      Ie: 1.25,
      Iw: 'MRI-1700',  // Wind: 1700-year MRI map (Fig 26.5-1B)
      color: '#fb8c00'
    },
    IV: {
      id: 'IV',
      label: 'Risk Category IV',
      description: 'Essential facilities — must remain operational after design events.',
      examples: [
        'Hospitals with surgery or emergency treatment facilities',
        'Fire, rescue, ambulance, and police stations',
        'Emergency response centers and emergency shelters',
        'Aviation control towers and air traffic control centers',
        'Buildings housing national defense systems',
        'Facilities with highly toxic or explosive substances'
      ],
      Is: 1.20,
      Ie: 1.50,
      Iw: 'MRI-3000',  // Wind: 3000-year MRI map (Fig 26.5-1D)
      color: '#c62828'
    }
  };

  // ── §1.2.2 Load Symbols used in ASCE 7-16 ────────────────────────
  // These map to load types used in load combination generation
  const LOAD_SYMBOLS = {
    D:   { name: 'Dead load',                    type: 'DL',   asce: '§3.1'  },
    L:   { name: 'Live load',                    type: 'LL',   asce: '§4.3'  },
    Lr:  { name: 'Roof live load',               type: 'LLr',  asce: '§4.8'  },
    S:   { name: 'Snow load',                    type: 'SL',   asce: '§7'    },
    R:   { name: 'Rain load',                    type: 'RL',   asce: '§8'    },
    W:   { name: 'Wind load',                    type: 'WL',   asce: '§26-31' },
    E:   { name: 'Earthquake load (Eh + Ev)',    type: 'EQ',   asce: '§12.4' },
    Eh:  { name: 'Horizontal seismic effect',    type: 'EQh',  asce: '§12.4.2' },
    Ev:  { name: 'Vertical seismic effect',      type: 'EQv',  asce: '§12.4.2' },
    H:   { name: 'Lateral earth/groundwater pressure', type: 'HP', asce: '§3.2' },
    F:   { name: 'Fluid load (well-defined pressures)', type: 'FL', asce: '§2.3.1' },
    N:   { name: 'Notional load (structural integrity)', type: 'NL', asce: '§1.4.2' },
    T:   { name: 'Self-straining (thermal/shrinkage)', type: 'TL', asce: '§2.3.4' },
  };

  // ── §1.4.2 Notional Lateral Force — Structural Integrity ─────────
  /**
   * Computes the minimum lateral force for structural integrity per §1.4.2 Eq.(1.4-1):
   *   Fx = 0.01 × Wx   (at each story level x)
   *
   * @param {Array<{id:number, x:number, y:number}>} nodes
   * @param {Array<{node1:number, node2:number, sectionId:number}>} beams
   * @param {Array<{id:number, E:number, A:number, rho:number}>} sections
   * @param {number} g - gravitational acceleration (m/s², default 9.81)
   * @returns {Array<{y:number, Wx_kN:number, Fx_kN:number}>}  Story-level notional forces
   */
  function computeNotionalLoads(nodes, beams, sections, g = 9.81) {
    if (!nodes.length || !beams.length) return [];

    // Group nodes by Y-coordinate (story level, rounded to 0.1m)
    const levels = {};
    nodes.forEach(nd => {
      const yk = Math.round(nd.y * 10) / 10;
      if (!levels[yk]) levels[yk] = { y: yk, nodeIds: [] };
      levels[yk].nodeIds.push(nd.id);
    });

    // Sort levels bottom-to-top (excluding ground)
    const sortedLevels = Object.values(levels).sort((a, b) => a.y - b.y);
    if (sortedLevels.length < 2) return [];

    // Compute tributary weight Wx at each level (beam self-weight attributed to nodes)
    const results = [];
    for (let li = 1; li < sortedLevels.length; li++) {
      const lvl = sortedLevels[li];
      const nodeSet = new Set(lvl.nodeIds);

      // Sum half-length × area × density for beams connected to nodes at this level
      let Wx_kN = 0;
      beams.forEach(bm => {
        const ni = nodes.find(n => n.id === bm.node1);
        const nj = nodes.find(n => n.id === bm.node2);
        if (!ni || !nj) return;
        const sec = sections.find(s => s.id === bm.sectionId);
        if (!sec || !sec.rho) return;

        const L  = Math.hypot(nj.x - ni.x, nj.y - ni.y);
        const A_m2 = (sec.A || 0) / 1e4;
        // Weight of beam (kN)
        const W_bm = sec.rho * A_m2 * L;  // rho [kN/m³] × A [m²] × L [m] = kN

        // Attribute to nodes at this level
        if (nodeSet.has(bm.node1) && nodeSet.has(bm.node2)) Wx_kN += W_bm;
        else if (nodeSet.has(bm.node1) || nodeSet.has(bm.node2)) Wx_kN += W_bm / 2;
      });

      const Fx_kN = 0.01 * Wx_kN;   // Eq.(1.4-1): Fx = 0.01Wx

      results.push({
        y: lvl.y,
        storyLabel: `Level ${li} (y = ${lvl.y.toFixed(1)} m)`,
        nodeCount: lvl.nodeIds.length,
        Wx_kN: +Wx_kN.toFixed(3),
        Fx_kN: +Fx_kN.toFixed(3)
      });
    }
    return results;
  }

  /**
   * Convert notional loads to the load format expected by the solver.
   * Returns an array of { type:'nodal', nodeId, fx } loads to be added to a load case.
   * Forces are distributed equally among nodes at each story level in the X-direction.
   */
  function notionalLoadsToSolverFormat(nodes, beams, sections) {
    const storyForces = computeNotionalLoads(nodes, beams, sections);
    const loads = [];

    // Group nodes by level
    const levels = {};
    nodes.forEach(nd => {
      const yk = Math.round(nd.y * 10) / 10;
      if (!levels[yk]) levels[yk] = [];
      levels[yk].push(nd.id);
    });

    storyForces.forEach(sf => {
      const nodesAtLevel = levels[sf.y] || [];
      if (!nodesAtLevel.length) return;
      const fxEach = sf.Fx_kN / nodesAtLevel.length;
      nodesAtLevel.forEach(nid => {
        // 'nodal' — the type the solvers match on; 'node' is silently ignored.
        loads.push({ type: 'nodal', nodeId: nid, fx: fxEach, fy: 0 });
      });
    });
    return loads;
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    RISK_CATEGORIES,
    LOAD_SYMBOLS,
    computeNotionalLoads,
    notionalLoadsToSolverFormat,

    /** Get importance factors for a risk category */
    getImportanceFactors(cat = 'II') {
      const rc = RISK_CATEGORIES[cat] || RISK_CATEGORIES['II'];
      return { Is: rc.Is, Ie: rc.Ie, Iw: rc.Iw };
    },

    /** Return sorted array of all risk categories for UI dropdowns */
    getCategoryList() {
      return ['I', 'II', 'III', 'IV'].map(k => ({
        id: k,
        label: RISK_CATEGORIES[k].label,
        description: RISK_CATEGORIES[k].description,
        Is: RISK_CATEGORIES[k].Is,
        Ie: RISK_CATEGORIES[k].Ie,
        color: RISK_CATEGORIES[k].color,
      }));
    }
  };
})();
