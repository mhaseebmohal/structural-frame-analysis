// ACI 318-19 Chapter 1 — Materials & Properties
// Reference: Arman, "Design of RC Structures", Ch.1
window.ACI_Ch1 = (function () {

  // ── Concrete ─────────────────────────────────────────────────────────
  function Ec(fc_MPa, wc_kgm3 = 2300) {
    return wc_kgm3 === 2300
      ? 4700 * Math.sqrt(fc_MPa)
      : 0.043 * Math.pow(wc_kgm3, 1.5) * Math.sqrt(fc_MPa);
  }

  function fr(fc_MPa, lambda = 1.0) {
    return 0.62 * lambda * Math.sqrt(fc_MPa); // modulus of rupture
  }

  function ft(fc_MPa, lambda = 1.0) {
    return 0.33 * lambda * Math.sqrt(fc_MPa); // direct tensile strength
  }

  function beta1(fc_MPa) {
    if (fc_MPa <= 28) return 0.85;
    if (fc_MPa >= 56) return 0.65;
    return +(0.85 - 0.05 * (fc_MPa - 28) / 7).toFixed(4);
  }

  function eps_cu() { return 0.003; } // ACI max concrete strain

  // ── Steel ─────────────────────────────────────────────────────────────
  const Es = 200000; // MPa

  // Metric bar table (ACI/metric): db in mm, Ab in mm², W in kg/m
  const BARS = [
    { num:  6, db:  6, Ab:   28.27, W: 0.222 },
    { num:  8, db:  8, Ab:   50.27, W: 0.395 },
    { num: 10, db: 10, Ab:   78.54, W: 0.617 },
    { num: 12, db: 12, Ab:  113.10, W: 0.888 },
    { num: 14, db: 14, Ab:  153.94, W: 1.208 },
    { num: 16, db: 16, Ab:  201.06, W: 1.578 },
    { num: 18, db: 18, Ab:  254.47, W: 1.998 },
    { num: 20, db: 20, Ab:  314.16, W: 2.467 },
    { num: 22, db: 22, Ab:  380.13, W: 2.984 },
    { num: 25, db: 25, Ab:  490.87, W: 3.853 },
    { num: 32, db: 32, Ab:  804.25, W: 6.313 },
  ];

  function barArea(n_bars, db_mm) {
    const bar = BARS.find(b => b.db === db_mm);
    return bar ? n_bars * bar.Ab : n_bars * Math.PI / 4 * db_mm * db_mm;
  }

  // ── Cover (ACI 318-19 §20.6.1) ─────────────────────────────────────
  const COVER = {
    'Cast against & in contact with soil': 75,
    'Exposed to weather — bars >D16': 50,
    'Exposed to weather — bars ≤D16': 40,
    'Not exposed — beams & columns': 40,
    'Not exposed — slabs & walls (≤D35)': 20,
  };

  // ── Unit weights (§1) ────────────────────────────────────────────────
  const UNIT_WEIGHTS = {
    'Reinforced Concrete': 25.0,
    'Plain Concrete': 23.0,
    'Masonry / Stone': 27.0,
    'Concrete Blocks': 15.0,
    'Fill Under Tiles': 18.0,
    'Plastering / Rendering': 23.0,
  };

  // ── Load factors & ϕ factors (ACI 318-19 §21.2 / §5.3) ────────────
  const PHI = {
    'Flexure — tension controlled': 0.90,
    'Shear': 0.75,
    'Torsion': 0.75,
    'Axial (tied column)': 0.65,
    'Axial (spiral column)': 0.75,
    'Bearing': 0.65,
  };

  const LOAD_COMBOS_ACI = [
    '1.4 D',
    '1.2 D + 1.6 L + 0.5 Lr',
    '1.2 D + 1.6 Lr + 0.5 L',
    '1.2 D + 1.6 W + 0.5 L + 0.5 Lr',
    '1.2 D + 1.0 E + 0.5 L + 0.2 S',
    '0.9 D + 1.6 W',
    '0.9 D + 1.0 E',
  ];

  // ── Cracking moment ──────────────────────────────────────────────────
  function Mcr(fc_MPa, Ig_mm4, yt_mm, lambda = 1.0) {
    return fr(fc_MPa, lambda) * Ig_mm4 / yt_mm / 1e6; // kNm
  }

  return { Ec, fr, ft, beta1, eps_cu, Es, BARS, barArea, COVER, UNIT_WEIGHTS, PHI, LOAD_COMBOS_ACI, Mcr };
})();
