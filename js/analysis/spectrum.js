// ═══════════════════════════════════════════════════════════════════════
//  RESPONSE SPECTRUM ANALYSIS
//
//  Modal superposition against a design acceleration spectrum.
//
//  For each mode n and excitation direction j the code applies an
//  equivalent static force vector
//
//      F_n = Γ_nj · Sa(T_n) · M · φ_n            [φ mass-normalised]
//
//  and runs it through the ordinary static solver. Because K·φ = ω²·M·φ,
//  that recovers exactly the modal displacement Γ·Sa/ω²·φ — but it does so
//  through the member-force, release and rigid-zone code that is already
//  under test, instead of a second recovery path that could drift from it.
//  The per-mode responses are then combined by SRSS or CQC.
//
//  Sign is lost in the combination: every combined quantity is a magnitude,
//  and the real response may be of either sense. Members must be checked for
//  ±R, which is what the ±E load combinations in the codes are for.
//
//  Codes: ASCE 7-16 §11.4.5 / §12.9.1, EN 1998-1 §3.2.2.5.
// ═══════════════════════════════════════════════════════════════════════
const ResponseSpectrum = (() => {

  const G = 9.81;   // m/s², to turn spectral ordinates in g into accelerations

  // ═════════════════════════════════════════════════════════════════
  //  DESIGN SPECTRA  —  each returns Sa(T) in units of g
  // ═════════════════════════════════════════════════════════════════

  /**
   * ASCE 7-16 §11.4.5 design response spectrum.
   * @param {number} Sds  design spectral acceleration, short period (g)
   * @param {number} Sd1  design spectral acceleration, 1-second period (g)
   * @param {number} TL   long-period transition period (s), Fig. 22-14..17
   */
  function asce7Spectrum(Sds, Sd1, TL) {
    if (!(Sds > 0) || !(Sd1 > 0)) return null;
    TL = TL > 0 ? TL : 8;
    const Ts = Sd1 / Sds;
    const T0 = 0.2 * Ts;
    const fn = T => {
      if (T <= 0)  return 0.4 * Sds;
      if (T < T0)  return Sds * (0.4 + 0.6 * T / T0);
      if (T <= Ts) return Sds;
      if (T <= TL) return Sd1 / T;
      return Sd1 * TL / (T * T);
    };
    fn.meta = { code: 'ASCE 7-16 §11.4.5', Sds, Sd1, TL, T0, Ts };
    return fn;
  }

  /**
   * EN 1998-1 §3.2.2.5 horizontal design spectrum (behaviour factor q included).
   * @param {number} ag   design ground acceleration on type A ground (g)
   * @param {number} S    soil factor
   * @param {number} TB   lower limit of the constant-acceleration branch (s)
   * @param {number} TC   upper limit of the constant-acceleration branch (s)
   * @param {number} TD   start of the constant-displacement range (s)
   * @param {number} q    behaviour factor
   * @param {number} beta lower bound factor (recommended 0.2)
   */
  function ec8Spectrum(ag, S, TB, TC, TD, q, beta) {
    if (!(ag > 0) || !(q > 0)) return null;
    S    = S  > 0 ? S  : 1.0;
    TB   = TB > 0 ? TB : 0.15;
    TC   = TC > 0 ? TC : 0.5;
    TD   = TD > 0 ? TD : 2.0;
    beta = beta === undefined ? 0.2 : beta;
    const floor = beta * ag;
    const fn = T => {
      if (!(T > 0)) T = 0;
      if (T <= TB)      return ag * S * (2 / 3 + (T / TB) * (2.5 / q - 2 / 3));
      if (T <= TC)      return ag * S * 2.5 / q;
      if (T <= TD)      return Math.max(ag * S * (2.5 / q) * (TC / T), floor);
      return Math.max(ag * S * (2.5 / q) * (TC * TD / (T * T)), floor);
    };
    fn.meta = { code: 'EN 1998-1 §3.2.2.5', ag, S, TB, TC, TD, q, beta };
    return fn;
  }

  /**
   * User-supplied spectrum: {T, Sa} points in g, linearly interpolated and
   * held flat outside the supplied range.
   */
  function tableSpectrum(points) {
    if (!Array.isArray(points)) return null;
    const pts = points
      .filter(p => p && isFinite(p.T) && isFinite(p.Sa) && p.T >= 0)
      .sort((a, b) => a.T - b.T);
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1];
    const fn = T => {
      if (!(T > pts[0].T)) return pts[0].Sa;
      if (T >= last.T)     return last.Sa;
      for (let i = 1; i < pts.length; i++) {
        if (T <= pts[i].T) {
          const a = pts[i - 1], b = pts[i];
          const span = b.T - a.T;
          if (span <= 0) return b.Sa;
          return a.Sa + (T - a.T) / span * (b.Sa - a.Sa);
        }
      }
      return last.Sa;
    };
    fn.meta = { code: 'User-defined', points: pts.length, Tmin: pts[0].T, Tmax: last.T };
    return fn;
  }

  /** Build a spectrum function from a plain options object. */
  function buildSpectrum(spec) {
    if (!spec) return null;
    if (typeof spec === 'function') return spec;
    switch (spec.code) {
      case 'ASCE7': return asce7Spectrum(spec.Sds, spec.Sd1, spec.TL);
      case 'EC8':   return ec8Spectrum(spec.ag, spec.S, spec.TB, spec.TC, spec.TD, spec.q, spec.beta);
      case 'TABLE': return tableSpectrum(spec.points);
      default:      return null;
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  MODAL COMBINATION
  // ═════════════════════════════════════════════════════════════════

  /**
   * CQC cross-correlation coefficient for equal damping in both modes
   * (Der Kiureghian 1981):
   *
   *   ρ_ij = 8ζ²(1 + r)·r^1.5 / [(1 − r²)² + 4ζ²·r·(1 + r)²],   r = ω_i/ω_j
   *
   * ρ → 1 as r → 1 and falls away quickly once the periods separate, which is
   * why CQC and SRSS agree on well-spaced modes and diverge on close ones.
   */
  function cqcRho(wi, wj, zeta) {
    if (!(wj > 0) || !(wi > 0)) return 0;
    const r  = wi / wj;
    const r2 = 1 - r * r;
    const num = 8 * zeta * zeta * (1 + r) * Math.pow(r, 1.5);
    const den = r2 * r2 + 4 * zeta * zeta * r * (1 + r) * (1 + r);
    if (!(den > 1e-30)) return 1;   // identical undamped frequencies: fully correlated
    return num / den;
  }

  /**
   * Combine one response quantity across modes.
   * @param {number[]} r      per-mode signed responses
   * @param {number[]} omega  per-mode circular frequencies (rad/s)
   * @param {string}   rule   'SRSS' or 'CQC'
   * @param {number}   zeta   damping ratio (CQC only)
   * @returns {number} the combined magnitude — always ≥ 0
   */
  function combine(r, omega, rule, zeta) {
    const n = r.length;
    if (n === 0) return 0;
    if (rule === 'SRSS') {
      let s = 0;
      for (let i = 0; i < n; i++) s += r[i] * r[i];
      return Math.sqrt(s);
    }
    let s = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        s += r[i] * cqcRho(omega[i], omega[j], zeta) * r[j];
    // Rounding in ρ can leave the quadratic form a hair below zero when every
    // modal response is tiny; clamp rather than return NaN out of the sqrt.
    return Math.sqrt(Math.max(0, s));
  }

  // ═════════════════════════════════════════════════════════════════
  //  EQUIVALENT LATERAL FORCE  (ASCE 7-16 §12.8)
  //
  //  Needed only so the modal base shear can be checked against it, which
  //  §12.9.1.4 requires. Nothing here is inferred from the model except the
  //  height: the structural system picks C_t and x, and the engineer picks
  //  the system.
  // ═════════════════════════════════════════════════════════════════

  //  Table 12.8-2, SI (h_n in metres).
  const CT_TABLE = {
    steelMoment:    { Ct: 0.0724, x: 0.8,  name: 'Steel moment-resisting frame' },
    concreteMoment: { Ct: 0.0466, x: 0.9,  name: 'Concrete moment-resisting frame' },
    steelEBF:       { Ct: 0.0731, x: 0.75, name: 'Steel eccentrically braced frame' },
    steelBRB:       { Ct: 0.0731, x: 0.75, name: 'Steel buckling-restrained braced frame' },
    other:          { Ct: 0.0488, x: 0.75, name: 'All other structural systems' }
  };

  /** Table 12.8-1 — coefficient for the upper limit on the calculated period. */
  function cuFromSd1(Sd1) {
    if (Sd1 >= 0.4)  return 1.4;
    if (Sd1 >= 0.3)  return 1.4;
    if (Sd1 >= 0.2)  return 1.5;
    if (Sd1 >= 0.15) return 1.6;
    return 1.7;
  }

  /**
   * ASCE 7-16 §12.8.1 seismic base shear V = Cs·W.
   *
   * @param {Object} p
   *   Sds, Sd1, TL   design spectral values (g) and long-period transition (s)
   *   R, Ie          response modification and importance factors
   *   W              effective seismic weight (kN)
   *   hn             structural height above the base (m)
   *   Tcomputed      period from the modal analysis (s), optional
   *   system         key into CT_TABLE
   *   S1             mapped 1-s spectral acceleration (g), optional — only
   *                  matters where it reaches 0.6 g and Eq 12.8-6 kicks in
   */
  function elfBaseShear(p) {
    p = p || {};
    const Sds = p.Sds, Sd1 = p.Sd1;
    if (!(Sds > 0) || !(Sd1 > 0) || !(p.W > 0) || !(p.hn > 0)) return null;
    const R  = p.R  > 0 ? p.R  : 1;
    const Ie = p.Ie > 0 ? p.Ie : 1;
    const TL = p.TL > 0 ? p.TL : 8;
    const sys = CT_TABLE[p.system] || CT_TABLE.other;

    // §12.8.2.1 approximate period, and the ceiling §12.8.2 puts on the
    // computed one. A flexible bare-frame model can return a period well past
    // Cu·Ta, and using it unchecked would understate the design force.
    const Ta = sys.Ct * Math.pow(p.hn, sys.x);
    const Cu = cuFromSd1(Sd1);
    const Tmax = Cu * Ta;
    const Tcomp = p.Tcomputed > 0 ? p.Tcomputed : Tmax;
    const T = Math.min(Tcomp, Tmax);
    const capped = Tcomp > Tmax + 1e-12;

    const RIe = R / Ie;
    const Cs0 = Sds / RIe;                                    // Eq 12.8-2
    const CsMax = T <= TL ? Sd1 / (T * RIe)                   // Eq 12.8-3
                          : Sd1 * TL / (T * T * RIe);         // Eq 12.8-4
    let CsMin = Math.max(0.044 * Sds * Ie, 0.01);             // Eq 12.8-5
    // Eq 12.8-6 — only where S1 reaches 0.6 g.
    if (p.S1 >= 0.6) CsMin = Math.max(CsMin, 0.5 * p.S1 / RIe);

    const Cs = Math.max(Math.min(Cs0, CsMax), CsMin);
    return {
      system: sys.name, Ct: sys.Ct, x: sys.x,
      hn: p.hn, Ta, Cu, Tmax, Tcomputed: Tcomp, T, periodCapped: capped,
      Cs0, CsMax, CsMin, Cs, W: p.W, V: Cs * p.W,
      governedBy: Cs === CsMin && CsMin > Math.min(Cs0, CsMax) ? 'minimum (Eq 12.8-5/6)'
                : Cs0 <= CsMax ? 'Eq 12.8-2 (short period)'
                : 'Eq 12.8-3/4 (long period)'
    };
  }

  // ═════════════════════════════════════════════════════════════════
  //  ENTRY POINT
  // ═════════════════════════════════════════════════════════════════

  /**
   * @param {Array}  nodes
   * @param {Array}  beams
   * @param {Array}  sections
   * @param {Object} opts
   *   spectrum  {code:'ASCE7', Sds, Sd1, TL} | {code:'EC8', ag, S, TB, TC, TD, q}
   *             | {code:'TABLE', points:[{T,Sa}]} | function(T) → Sa in g
   *   is3D      analyse as a space frame                (default false)
   *   direction 'X' | 'Y' | 'Z'  ('Z' is 3D only)      (default 'X')
   *   numModes  modes to extract                       (default 10)
   *   rule      'CQC' | 'SRSS'                         (default 'CQC')
   *   damping   damping ratio                          (default 0.05)
   *   R         response modification factor           (default 1)
   *   Ie        importance factor                      (default 1)
   *   solve     static solver, injected for testing    (default solveFrame)
   *   modal     modal solver, injected for testing     (default ModeShapeAnalysis)
   */
  function run(nodes, beams, sections, opts) {
    opts = opts || {};
    const is3D   = !!opts.is3D;
    // Z is the vertical in 3D and does not exist in 2D, where the app calls
    // the vertical Y. Asking for Z on a 2D model quietly falls back to Y
    // rather than analysing a direction the model has no DOFs for.
    let dir = (opts.direction || 'X').toUpperCase();
    if (dir !== 'Y' && dir !== 'Z') dir = 'X';
    if (dir === 'Z' && !is3D) dir = 'Y';
    const rule   = (opts.rule || 'CQC').toUpperCase() === 'SRSS' ? 'SRSS' : 'CQC';
    const zeta   = opts.damping > 0 ? opts.damping : 0.05;
    const R      = opts.R  > 0 ? opts.R  : 1;
    const Ie     = opts.Ie > 0 ? opts.Ie : 1;
    const nModes = opts.numModes > 0 ? Math.floor(opts.numModes) : 10;

    const Sa = buildSpectrum(opts.spectrum);
    if (!Sa) return { error: 'No valid design spectrum. Supply Sds and Sd1 (ASCE 7), ' +
                             'ag and q (EC8), or a table of at least two (T, Sa) points.' };

    const modalSolver = opts.modal ||
      (typeof ModeShapeAnalysis !== 'undefined' ? ModeShapeAnalysis : null);
    if (!modalSolver) return { error: 'Mode shape module unavailable.' };

    const solve = opts.solve ||
      (is3D ? (typeof solveFrame3D !== 'undefined' ? solveFrame3D : null)
            : (typeof solveFrame   !== 'undefined' ? solveFrame   : null));
    if (!solve) return { error: `Static solver unavailable (${is3D ? '3D' : '2D'}).` };
    if (is3D && typeof modalSolver.computeModes3D !== 'function')
      return { error: '3D modal analysis unavailable.' };

    // ── Modes ──────────────────────────────────────────────────────
    const massOpts = {
      loads: opts.loads, loadCases: opts.loadCases, massFactors: opts.massFactors
    };
    const modal = is3D
      ? modalSolver.computeModes3D(nodes, beams, sections, nModes, massOpts)
      : modalSolver.computeModes(nodes, beams, sections, nModes, massOpts);
    if (modal.error) return { error: 'Modal analysis failed: ' + modal.error };
    const modes = modal.modes || [];
    if (modes.length === 0) return { error: 'Modal analysis returned no usable modes.' };

    const idNode   = nodes.map(nd => nd.id);
    const dpn      = is3D ? 6 : 3;
    const gammaKey = 'gamma' + dir;
    const pctKey   = 'u' + dir.toLowerCase() + 'Pct';
    const totMass  = modal['totalMass' + dir];
    const allMass  = modal['structuralMass' + dir];

    // ── One static solve per mode ──────────────────────────────────
    const modeResults = [];
    const omegas = [];
    let cumPct = 0;

    for (const md of modes) {
      const gamma = md[gammaKey] || 0;
      const T     = md.period;
      const SaG   = Sa(isFinite(T) ? T : 0);              // g
      // §12.9.1.2 keeps R and Ie outside the spectrum, so they are applied
      // here. The EC8 design spectrum already carries q, which is why R and Ie
      // default to 1 — that way this is a no-op rather than a silent second
      // reduction on top of the one the spectrum already made.
      const accel = SaG * G * Ie / R;                     // m/s²

      // F = Γ · Sa · M · φ  →  kN, since M is assembled in kN·s²/m.
      //
      // The whole vector is applied, not just its component along the
      // excitation. Only Γ = φᵀMr depends on the direction being shaken; the
      // inertia forces themselves act along whatever the mode actually does,
      // and in mode n that is φ_n, which has transverse and rotational parts
      // as well. Restricting F to the shaking direction breaks the identity
      // K·u = ω²·M·u that this whole approach rests on, and the answer stops
      // being the modal response at all.
      const mPhi  = md.mPhi || [];
      const loads = [];
      const k     = gamma * accel;
      // Kept so the modal force vectors can be combined into one equivalent
      // static set afterwards — that set is what a load combination can factor.
      const fvec  = new Array(idNode.length * dpn).fill(0);
      for (let i = 0; i < idNode.length; i++) {
        const b = i * dpn;
        const c = [];
        for (let j = 0; j < dpn; j++) c.push(k * (mPhi[b + j] || 0));
        for (let j = 0; j < dpn; j++) fvec[b + j] = c[j];
        if (c.every(v => !v)) continue;
        loads.push(is3D
          // solver3d spells a nodal load in the app's own axes, not in its DOF
          // order: fy is the VERTICAL (global Z, DOF 2) and fz is the depth
          // direction (global Y, DOF 1). Feeding the DOF vector straight in
          // would swap two of the three force components.
          ? { type: 'nodal', nodeId: idNode[i],
              fx: c[0], fz: c[1], fy: c[2],
              mx: c[3], my: c[4], mz: c[5] }
          : { type: 'nodal', nodeId: idNode[i], fx: c[0], fy: c[1], m: c[2] });
      }

      const res = solve(nodes, beams, sections, loads, []);
      if (!res || !res.success) continue;

      // Modal base shear V_n = Γ²·Sa — with φ mass-normalised the effective
      // modal mass is exactly Γ².
      omegas.push(md.omega);
      cumPct += md[pctKey] || 0;
      modeResults.push({
        modeNum: md.modeNum, period: T, omega: md.omega,
        SaG, accel, gamma,
        massPct: md[pctKey] || 0,
        cumMassPct: cumPct,
        effMass: gamma * gamma,
        baseShear: gamma * gamma * accel,
        fvec, res
      });
    }

    if (modeResults.length === 0)
      return { error: 'No mode produced a valid static solution. ' +
                      'Check supports and section properties.' };

    // ── Combine ────────────────────────────────────────────────────
    const cmb = arr => combine(arr, omegas, rule, zeta);
    const per = fn => modeResults.map(fn);

    // Which result fields exist depends on which solver produced them.
    const dispKeys = is3D ? ['u', 'v', 'w', 'θx', 'θy', 'θz', 'theta']
                          : ['u', 'v', 'theta'];
    const reacKeys = is3D ? ['Rx', 'Ry', 'Rz', 'Mx', 'My', 'Mz']
                          : ['Rx', 'Ry', 'M'];
    const efKeys   = is3D
      ? ['N1', 'Vy1', 'Vz1', 'Tx1', 'My1', 'Mz1',
         'N2', 'Vy2', 'Vz2', 'Tx2', 'My2', 'Mz2', 'M1', 'M2', 'V1', 'V2']
      : ['N1', 'V1', 'M1', 'N2', 'V2', 'M2'];

    const disp = {};
    for (const nd of nodes) {
      const d = {};
      for (const key of dispKeys)
        d[key] = cmb(per(m => (m.res.disp[nd.id] || {})[key] || 0));
      disp[nd.id] = d;
    }
    const elemForces = beams.map((bm, bi) => {
      const ref = modeResults[0].res.elemForces[bi] || {};
      const out = { id: bm.id, L: ref.L };
      for (const k of efKeys)
        out[k] = cmb(per(m => (m.res.elemForces[bi] || {})[k] || 0));
      return out;
    });

    const reactions = {};
    for (const nd of nodes) {
      if (!modeResults[0].res.reactions[nd.id]) continue;
      const rc = {};
      for (const key of reacKeys)
        rc[key] = cmb(per(m => (m.res.reactions[nd.id] || {})[key] || 0));
      reactions[nd.id] = rc;
    }

    // Base shear combines by the same rule. Summing the modal shears would
    // assume every mode peaks at the same instant, which overstates it badly.
    let baseShear = cmb(per(m => m.baseShear));

    // ── Equivalent static force set ────────────────────────────────
    //
    // Design work needs the earthquake as something a load combination can
    // factor alongside dead and live, and a set of combined member forces
    // cannot be superposed. So the modal force vectors are combined node by
    // node into one static set.
    //
    // Combining each node's force and then summing does not give the same
    // total as combining the base shears — the combination is not linear.
    // The set is therefore scaled so its resultant matches the base shear
    // reported above, which is the number the design is actually checked on.
    const compIdx = dir === 'X' ? 0 : dir === 'Y' ? 1 : 2;
    const staticF = new Array(idNode.length * dpn).fill(0);
    for (let j = 0; j < staticF.length; j++)
      staticF[j] = cmb(per(m => m.fvec[j] || 0));
    let resultant = 0;
    for (let i = 0; i < idNode.length; i++) resultant += staticF[i * dpn + compIdx];
    // staticF entries are combine()'d magnitudes (non-negative), so a resultant
    // this small means the equivalent static set has essentially no content in
    // this direction — dividing a near-zero vector by itself to hit a nonzero
    // baseShear is not a scale, it is nonsense. Leave it unscaled and say so
    // (below, once baseShear is known) rather than silently reporting a set
    // that is inconsistent with the base shear the design is actually checked on.
    const staticForceUnscalable = resultant <= 1e-12;
    const fScale = staticForceUnscalable ? 1 : baseShear / resultant;
    for (let j = 0; j < staticF.length; j++) staticF[j] *= fScale;

    // ── Notes the engineer has to see ──────────────────────────────
    const notes = [];
    if (cumPct < 90)
      notes.push(`Only ${cumPct.toFixed(1)}% of the mass in ${dir} is captured by ` +
                 `${modeResults.length} mode${modeResults.length === 1 ? '' : 's'}. ` +
                 'ASCE 7-16 §12.9.1.1 and EN 1998-1 §4.3.3.3.1 both want at least 90% — ' +
                 'extract more modes.');
    if (rule === 'SRSS') {
      let close = false;
      for (let i = 0; i < modeResults.length - 1; i++) {
        const Ti = modeResults[i].period, Tj = modeResults[i + 1].period;
        if (Ti > 0 && Math.abs(Ti - Tj) / Ti < 0.1) close = true;
      }
      if (close)
        notes.push('Modes closer than 10% in period are present. SRSS is unreliable for ' +
                   'closely spaced modes — use CQC (ASCE 7-16 §12.9.1.3).');
    }
    // Participation is measured against the mass that is free to move. Where a
    // real share of the structure sits on restrained DOFs, '99% captured' and
    // '99% of the building' are not the same statement, and the base shear is
    // the smaller of the two accordingly.
    if (allMass > 0 && totMass > 0 && totMass < 0.98 * allMass)
      notes.push(`Participation is measured against the ${totMass.toFixed(2)} kN·s²/m that is ` +
                 `free to move; the model holds ${allMass.toFixed(2)} kN·s²/m in total, the ` +
                 `difference being mass carried directly on restrained supports.`);
    notes.push('Combined values are magnitudes and carry no sign. Check members for both ' +
               'senses (±E).');
    if (staticForceUnscalable && baseShear > 1e-9)
      notes.push(`The equivalent static force set has a ~0 resultant in the ${dir} direction ` +
                 `and could not be scaled to match the reported ${baseShear.toFixed(2)} kN base ` +
                 'shear — treat the exported static forces as unreliable for this run; the ' +
                 'combined member forces/reactions above are unaffected.');
    const am = modal.appliedMass;
    if (am && am.total > 0) {
      const parts = Object.keys(am.breakdown)
        .map(k => `${k} ${am.breakdown[k].toFixed(1)} kN`).join(', ');
      notes.push(`Seismic mass is member self-weight plus ${am.total.toFixed(2)} kN·s²/m ` +
                 `lumped from applied loads (${parts}), factored per load case. ` +
                 'Check those factors against ASCE 7-16 §12.7.2 or EN 1998-1 §3.2.4.');
      if (am.unresolved > 0)
        notes.push(`${am.unresolved} load${am.unresolved === 1 ? '' : 's'} could not be matched ` +
                   'to a load case and were counted as dead at full mass — the safe way to ' +
                   'guess, but check that it is what you meant.');
    } else {
      notes.push('Seismic mass is taken from member self-weight only (section ρ × A). ' +
                 'Applied dead and live mass is not included — pass the load cases and ' +
                 'their mass factors to count it.');
    }
    if (!opts.scaleToELF)
      notes.push('ASCE 7-16 §12.9.1.4 requires the modal base shear to be scaled up to the ' +
                 'equivalent lateral force value where it falls short. That comparison was ' +
                 'not requested for this run.');

    // ── §12.9.1.4 — scale up to the equivalent lateral force result ────
    // The modal base shear is routinely lower than the ELF value, because the
    // ELF period is capped at Cu·Ta while the model is free to be as flexible
    // as it likes. ASCE 7-16 requires the modal results be scaled up to meet
    // it. Only offered for ASCE runs: EC8 has no equivalent rule, and applying
    // one there would be inventing a requirement.
    let elf = null, scaleFactor = 1, elfUnscalableFromZero = false;
    const wantsELF = opts.scaleToELF && (Sa.meta || {}).Sds > 0;
    if (wantsELF) {
      // Structural height above the lowest support — the only quantity here
      // taken from the model rather than from the engineer.
      // The vertical axis is Y in 2D and Z in 3D. Reading y in a 3D model
      // measured the plan depth and called it the building height, which then
      // fed Ta = Ct·hn^x and every ELF number after it.
      let base = Infinity, top = -Infinity;
      for (const nd of nodes) {
        const v = is3D ? (nd.z || 0) : (nd.y || 0);
        // A node restrained only via a custom 3D fixedDOF mask (support left
        // unset/'none') is still a support — missing it here can leave `base`
        // at +Infinity when every restrained node happens to be this kind,
        // turning hn into NaN and silently breaking every ELF number after it.
        if ((nd.support && nd.support !== 'none') || nd.fixedDOF) base = Math.min(base, v);
        top = Math.max(top, v);
      }
      const hn = isFinite(base) ? top - base : NaN;
      // W is a weight, and the mass matrix holds kN·s²/m, so multiply by g.
      const W = (allMass || totMass || 0) * G;
      elf = elfBaseShear({
        Sds: Sa.meta.Sds, Sd1: Sa.meta.Sd1, TL: Sa.meta.TL, R, Ie, W, hn,
        Tcomputed: modeResults[0] ? modeResults[0].period : 0,
        system: opts.system, S1: opts.S1
      });
      if (!elf) {
        notes.push('The equivalent lateral force comparison could not be made — it needs a ' +
                   'supported model with a real height above its base.');
      } else if (baseShear > 1e-9 && elf.V > baseShear) {
        scaleFactor = elf.V / baseShear;
      } else if (baseShear <= 1e-9 && elf.V > 1e-9) {
        // baseShear ~ 0 (negligible modal participation in this direction) but
        // ELF gives a real target. `elf.V / baseShear` would divide by ~zero,
        // and the "already meets" fallback below would be false in this case —
        // the structure was left unscaled while genuinely falling short, not
        // because it met the target. Say what actually happened instead.
        elfUnscalableFromZero = true;
        notes.push(`The modal base shear in the ${dir} direction is ~0 kN — negligible modal ` +
                   `participation — so it cannot be scaled to the equivalent lateral force ` +
                   `value of ${elf.V.toFixed(2)} kN per §12.9.1.4. Extract more modes or check ` +
                   'that mass is actually free to move in this direction; the result below ' +
                   'carries essentially no seismic demand.');
      }
    }

    if (scaleFactor > 1) {
      // Everything scales together: the response is linear in Sa, so one
      // factor on the whole set keeps displacements, forces and reactions
      // consistent with each other.
      for (const id in disp) {
        disp[id].u *= scaleFactor; disp[id].v *= scaleFactor;
        disp[id].theta *= scaleFactor;
      }
      for (const e of elemForces)
        for (const k of efKeys) e[k] *= scaleFactor;
      for (const id in reactions) {
        reactions[id].Rx *= scaleFactor; reactions[id].Ry *= scaleFactor;
        reactions[id].M  *= scaleFactor;
      }
      baseShear *= scaleFactor;
      // The equivalent static set is built before this point, from the
      // unscaled base shear. It has to move with it, or a load case created
      // from it would quietly be the version §12.9.1.4 rejected.
      for (let j = 0; j < staticF.length; j++) staticF[j] *= scaleFactor;
      notes.push(`Scaled by ${scaleFactor.toFixed(3)} to the equivalent lateral force base ` +
                 `shear of ${elf.V.toFixed(2)} kN per ASCE 7-16 §12.9.1.4 (Cs = ` +
                 `${elf.Cs.toFixed(4)}, governed by ${elf.governedBy}, T = ${elf.T.toFixed(3)} s` +
                 `${elf.periodCapped ? `, capped from ${elf.Tcomputed.toFixed(3)} s at Cu·Ta` : ''}).`);
    } else if (elf && !elfUnscalableFromZero) {
      notes.push(`The modal base shear of ${baseShear.toFixed(2)} kN already meets the ` +
                 `equivalent lateral force value of ${elf.V.toFixed(2)} kN, so no §12.9.1.4 ` +
                 'scaling applies.');
    }

    const r3 = v => +v.toFixed(3);
    return {
      success: true,
      is3D, direction: dir, rule, damping: zeta, R, Ie,
      spectrum: Sa.meta || { code: 'custom' },
      modes: modeResults.map(m => ({
        modeNum: m.modeNum,
        period:  +m.period.toFixed(4),
        freq:    +(m.omega / (2 * Math.PI)).toFixed(4),
        SaG:     +m.SaG.toFixed(5),
        accel:   +m.accel.toFixed(4),
        gamma:   +m.gamma.toFixed(5),
        massPct: +m.massPct.toFixed(2),
        cumMassPct: +m.cumMassPct.toFixed(2),
        effMass: +m.effMass.toFixed(4),
        baseShear: r3(m.baseShear)
      })),
      modeCount: modeResults.length,
      massCaptured: +cumPct.toFixed(2),
      totalMass: totMass ? +totMass.toFixed(4) : 0,          // free to move
      structuralMass: allMass ? +allMass.toFixed(4) : 0,     // whole model
      baseShear: r3(baseShear),
      elf, scaleFactor: +scaleFactor.toFixed(4),
      appliedMass: modal.appliedMass || null,
      disp, elemForces, reactions,
      // One nodal force per node, in the app's own load spelling, ready to
      // become an EQ load case. Magnitudes: apply as ±E.
      staticForces: idNode.map((id, i) => {
        const b = i * dpn;
        const q = k => +(staticF[b + k] || 0).toFixed(6);
        return is3D
          ? { nodeId: id, fx: q(0), fz: q(1), fy: q(2), mx: q(3), my: q(4), mz: q(5) }
          : { nodeId: id, fx: q(0), fy: q(1), m: q(2) };
      }),
      staticForceScale: +fScale.toFixed(5),
      notes
    };
  }

  return { run, combine, cqcRho, buildSpectrum, asce7Spectrum, ec8Spectrum, tableSpectrum,
           elfBaseShear, CT_TABLE };
})();

// Guarded — also importScripts()-ed into solver.worker.js, which has no `window`.
if (typeof window !== 'undefined') window.ResponseSpectrum = ResponseSpectrum;
