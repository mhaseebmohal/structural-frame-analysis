// ──────────────────────────────────────────────────────────────────
//  ASCE 7-16 Chapter 3 — Dead Loads
//
//  Reference: ASCE/SEI 7-16
//    §3.1      Dead Loads — definition and scope
//    §3.1.1    Self-weight of construction
//    §3.2      Soil lateral pressure
//    Table C3-1 Minimum Densities for Design Loads
//    Table 3.1-1 Minimum Design Dead Loads
//
//  Exposed as: window.ASCE7_Ch3
// ──────────────────────────────────────────────────────────────────
'use strict';

window.ASCE7_Ch3 = (() => {

  // ── Table C3-1 + Table 3.1-1 Material Database ───────────────────
  // format: { id, name, category, unit, density_kNm3?, load_kNm2?, note }
  //   density_kNm3  → volumetric material: user enters thickness (m)
  //   load_kNm2     → area load: fixed value, no thickness needed
  //   unit for display: 'kN/m³' or 'kN/m²'

  const MATERIALS = [

    // ── Structural / Framing ──────────────────────────────────────
    { id:'conc_nw',    category:'Concrete',     name:'Normal-weight Concrete (NWC)',        density_kNm3: 23.56, note:'ASCE T.C3-1 — 150 pcf; includes reinforcement allowance' },
    { id:'conc_lw110', category:'Concrete',     name:'Lightweight Concrete — 110 pcf',     density_kNm3: 17.27, note:'ASCE T.C3-1 — 110 pcf (1760 kg/m³)' },
    { id:'conc_lw100', category:'Concrete',     name:'Lightweight Concrete — 100 pcf',     density_kNm3: 15.71, note:'ASCE T.C3-1 — 100 pcf (1600 kg/m³)' },
    { id:'steel',      category:'Metal',        name:'Steel',                               density_kNm3: 77.01, note:'ASCE T.C3-1 — 490 pcf' },
    { id:'alum',       category:'Metal',        name:'Aluminum',                            density_kNm3: 26.60, note:'ASCE T.C3-1 — 169 pcf' },
    { id:'cast_iron',  category:'Metal',        name:'Cast Iron',                           density_kNm3: 71.17, note:'ASCE T.C3-1 — 450 pcf' },
    { id:'brick_sw',   category:'Masonry',      name:'Brick (solid, clay)',                 density_kNm3: 18.85, note:'ASCE T.C3-1 — 120 pcf' },
    { id:'cmu_norm',   category:'Masonry',      name:'CMU Block (normal-weight)',           density_kNm3: 17.27, note:'ASCE T.C3-1 — 110 pcf' },
    { id:'cmu_lw',     category:'Masonry',      name:'CMU Block (lightweight fill)',        density_kNm3: 11.78, note:'ASCE T.C3-1 — 75 pcf' },
    { id:'granite',    category:'Stone',        name:'Granite / Marble',                   density_kNm3: 26.38, note:'ASCE T.C3-1 — 167.7 pcf' },
    { id:'limestone',  category:'Stone',        name:'Limestone',                           density_kNm3: 23.56, note:'ASCE T.C3-1 — 150 pcf' },
    { id:'sandstone',  category:'Stone',        name:'Sandstone',                           density_kNm3: 21.21, note:'ASCE T.C3-1 — 135 pcf' },
    { id:'timber_df',  category:'Timber',       name:'Timber — Douglas Fir',                density_kNm3:  5.65, note:'ASCE T.C3-1 — 36 pcf' },
    { id:'timber_sp',  category:'Timber',       name:'Timber — Southern Pine',              density_kNm3:  6.28, note:'ASCE T.C3-1 — 40 pcf' },
    { id:'timber_oak', category:'Timber',       name:'Timber — Oak',                        density_kNm3:  7.71, note:'ASCE T.C3-1 — 49 pcf' },
    { id:'glass',      category:'Glass',        name:'Glass',                               density_kNm3: 25.13, note:'ASCE T.C3-1 — 160 pcf' },

    // ── Floor Finishes / Toppings ─────────────────────────────────
    { id:'tile_cer_25', category:'Floor Finish', name:'Ceramic / Quarry Tile 25 mm',       load_kNm2: 0.53,  note:'ASCE T.3.1-1 — 11 psf' },
    { id:'tile_cer_13', category:'Floor Finish', name:'Ceramic / Quarry Tile 13 mm',       load_kNm2: 0.27,  note:'ASCE T.3.1-1 — 5.5 psf' },
    { id:'hardwood_25', category:'Floor Finish', name:'Hardwood Flooring 25 mm',            load_kNm2: 0.14,  note:'ASCE T.3.1-1 — 2.8 psf' },
    { id:'carpet',      category:'Floor Finish', name:'Carpet + pad',                       load_kNm2: 0.05,  note:'ASCE T.3.1-1 — 1.0 psf' },
    { id:'vinyl_tile',  category:'Floor Finish', name:'Vinyl Tile 3 mm',                    load_kNm2: 0.05,  note:'ASCE T.3.1-1 — 1.0 psf' },
    { id:'mortar_25',   category:'Floor Finish', name:'Mortar Bed 25 mm (setting bed)',    load_kNm2: 0.57,  note:'ASCE T.3.1-1 — 12 psf' },
    { id:'screed_40',   category:'Floor Finish', name:'Leveling Screed 40 mm',             load_kNm2: 0.96,  note:'~2.5 kN/m³ × 0.04m × density of screed' },

    // ── Ceiling / Soffit ──────────────────────────────────────────
    { id:'ceil_gypsum', category:'Ceiling',     name:'Gypsum Board 16 mm (1 layer)',        load_kNm2: 0.24,  note:'ASCE T.3.1-1 — 5 psf' },
    { id:'ceil_plaster', category:'Ceiling',   name:'Plaster on Metal Lath',               load_kNm2: 0.34,  note:'ASCE T.3.1-1 — 7 psf' },
    { id:'ceil_acous',  category:'Ceiling',     name:'Acoustic Tile (suspended metal)',     load_kNm2: 0.10,  note:'ASCE T.3.1-1 — 2 psf' },
    { id:'ceil_conc',   category:'Ceiling',     name:'Concrete Plank Ceiling (100 mm)',     load_kNm2: 2.20,  note:'~23.6 × 0.10 m; monolithic reference' },

    // ── MEP / Services ────────────────────────────────────────────
    { id:'mep_light',   category:'MEP',         name:'MEP Allowance (light — residential)', load_kNm2: 0.20, note:'Typical allowance; not in ASCE table — engineering judgment' },
    { id:'mep_medium',  category:'MEP',         name:'MEP Allowance (medium — office)',     load_kNm2: 0.30, note:'Typical allowance; not in ASCE table' },
    { id:'mep_heavy',   category:'MEP',         name:'MEP Allowance (heavy — hospital)',    load_kNm2: 0.50, note:'Typical allowance; not in ASCE table' },

    // ── Roofing ───────────────────────────────────────────────────
    { id:'roof_bur',    category:'Roofing',     name:'Built-up Roofing (BUR membrane)',     load_kNm2: 0.35, note:'ASCE T.3.1-1 — 7 psf' },
    { id:'roof_gravel', category:'Roofing',     name:'Gravel Ballast 25 mm',                load_kNm2: 0.43, note:'ASCE T.3.1-1 — 9 psf' },
    { id:'roof_insul',  category:'Roofing',     name:'Rigid Insulation 25 mm (polyiso)',    load_kNm2: 0.02, note:'ASCE T.3.1-1 — 0.5 psf' },
    { id:'roof_tile_c', category:'Roofing',     name:'Concrete Roof Tile',                  load_kNm2: 0.77, note:'ASCE T.3.1-1 — 16 psf' },
    { id:'roof_tile_cl',category:'Roofing',     name:'Clay Roof Tile',                      load_kNm2: 0.65, note:'ASCE T.3.1-1 — 13.5 psf' },
    { id:'roof_metal',  category:'Roofing',     name:'Metal Deck (corrugated steel)',        load_kNm2: 0.14, note:'ASCE T.3.1-1 — 3 psf' },
    { id:'roof_shingle',category:'Roofing',     name:'Asphalt Shingles',                    load_kNm2: 0.14, note:'ASCE T.3.1-1 — 3 psf' },
    { id:'roof_slate',  category:'Roofing',     name:'Slate Roofing 10 mm',                 load_kNm2: 0.34, note:'ASCE T.3.1-1 — 7 psf' },

    // ── Partitions / Walls ────────────────────────────────────────
    { id:'part_asce',   category:'Partition',   name:'Movable Partition (ASCE 7-16 §4.3.2)',load_kNm2: 0.96, note:'Min. 20 psf (0.96 kN/m²) per §4.3.2 for movable partitions' },
    { id:'wall_brick4', category:'Partition',   name:'Brick Wall 100 mm',                   load_kNm2: 1.89, note:'18.85 kN/m³ × 0.10 m' },
    { id:'wall_cmu200', category:'Partition',   name:'CMU Wall 200 mm (normal weight)',     load_kNm2: 3.45, note:'17.27 kN/m³ × 0.20 m' },
    { id:'wall_gyp2x',  category:'Partition',   name:'Gypsum Board Partition (2 × 16 mm)',  load_kNm2: 0.48, note:'ASCE T.3.1-1 — 10 psf (wall self-weight distributed on area)' },

    // ── Soil / Earth ──────────────────────────────────────────────
    { id:'soil_dry',    category:'Soil',        name:'Soil (dry sand/gravel)',               density_kNm3: 15.71, note:'ASCE T.C3-1 — 100 pcf' },
    { id:'soil_sat',    category:'Soil',        name:'Soil (saturated, compact)',            density_kNm3: 18.85, note:'ASCE T.C3-1 — 120 pcf' },
    { id:'soil_gravel', category:'Soil',        name:'Gravel Fill',                          density_kNm3: 16.50, note:'ASCE T.C3-1 — ~105 pcf' },
    { id:'soil_clay',   category:'Soil',        name:'Clay (saturated)',                     density_kNm3: 17.27, note:'ASCE T.C3-1 — 110 pcf' },
  ];

  const CATEGORIES = [...new Set(MATERIALS.map(m => m.category))];

  // ── Unit Conversions ──────────────────────────────────────────────
  const KNM2_TO_PSF = 20.885;

  function kNm2_to_psf(v) { return +(v * KNM2_TO_PSF).toFixed(2); }
  function psf_to_kNm2(v) { return +(v / KNM2_TO_PSF).toFixed(4); }

  // ── Dead Load Layer Calculator ────────────────────────────────────
  /**
   * Compute area load (kN/m²) for a single layer.
   * @param {string} materialId
   * @param {number} thickness_m  — required for density-based materials; ignored for fixed area loads
   * @returns {{ load_kNm2, load_psf, material }}
   */
  function computeLayerLoad(materialId, thickness_m = 0) {
    const mat = MATERIALS.find(m => m.id === materialId);
    if (!mat) return null;

    let load_kNm2;
    if (mat.density_kNm3 !== undefined) {
      load_kNm2 = mat.density_kNm3 * thickness_m;
    } else {
      load_kNm2 = mat.load_kNm2;
    }
    return {
      load_kNm2: +load_kNm2.toFixed(4),
      load_psf:  kNm2_to_psf(load_kNm2),
      material:  mat
    };
  }

  /**
   * Compute total dead load for a stack of layers.
   * @param {Array<{materialId, thickness_m?}>} layers
   * @returns {{ total_kNm2, total_psf, layers: [{name, load_kNm2, load_psf}] }}
   */
  function computeFloorSystem(layers) {
    const results = [];
    let total = 0;
    for (const layer of layers) {
      const r = computeLayerLoad(layer.materialId, layer.thickness_m || 0);
      if (r) {
        results.push({ name: r.material.name, load_kNm2: r.load_kNm2, load_psf: r.load_psf });
        total += r.load_kNm2;
      }
    }
    return {
      total_kNm2: +total.toFixed(4),
      total_psf:  kNm2_to_psf(total),
      layers: results
    };
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    MATERIALS,
    CATEGORIES,
    computeLayerLoad,
    computeFloorSystem,
    kNm2_to_psf,
    psf_to_kNm2,

    /** Get materials filtered by category */
    getByCategory(cat) {
      return cat ? MATERIALS.filter(m => m.category === cat) : MATERIALS;
    },

    /** Get material by id */
    getById(id) {
      return MATERIALS.find(m => m.id === id) || null;
    }
  };
})();
