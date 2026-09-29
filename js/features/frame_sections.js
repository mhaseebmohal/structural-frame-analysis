// ============================================================
//  frame_sections.js  — ETABS-style Frame Section Property Data
//  Full dynamic implementation:
//    • Real-time cross-section preview on every input change
//    • Visual shape picker (like ETABS shape type dialog)
//    • Shape-specific dimension fields
//    • ACI-based modifier suggestions
//    • Rebar only for concrete sections
//    • Computed properties update live
// ============================================================
'use strict';

window.FRAME_SEC = (function () {

  // ── Constants ──────────────────────────────────────────────────
  const SHAPE_GROUPS = {
    'Concrete': [
      { id:'ConcRect',  label:'Concrete Rectangular', icon:'▬',  color:'#78909c' },
      { id:'ConcCirc',  label:'Concrete Circular',    icon:'●',  color:'#78909c' },
      { id:'ConcTee',   label:'Concrete T-Beam',      icon:'⊤',  color:'#78909c' },
      { id:'ConcL',     label:'Concrete L-Shape',     icon:'⌐',  color:'#78909c' },
      { id:'ConcBox',   label:'Concrete Box',         icon:'□',  color:'#78909c' },
      { id:'ConcPipe',  label:'Concrete Pipe',        icon:'○',  color:'#78909c' },
      { id:'PrecastI',  label:'Precast I',            icon:'I',  color:'#78909c' },
    ],
    'Steel': [
      { id:'SteelW',    label:'Steel I / Wide Flange', icon:'I',  color:'#1565c0' },
      { id:'SteelC',    label:'Steel Channel',         icon:'C',  color:'#1565c0' },
      { id:'SteelT',    label:'Steel Tee',             icon:'T',  color:'#1565c0' },
      { id:'SteelL',    label:'Steel Angle',           icon:'L',  color:'#1565c0' },
      { id:'Steel2L',   label:'Steel Double Angle',    icon:'2L', color:'#1565c0' },
      { id:'SteelBox',  label:'Steel Box / RHS',       icon:'□',  color:'#1565c0' },
      { id:'SteelPipe', label:'Steel Pipe / CHS',      icon:'○',  color:'#1565c0' },
      { id:'SteelPlate',label:'Steel Plate',           icon:'▬',  color:'#1565c0' },
      { id:'SteelRod',  label:'Steel Rod',             icon:'●',  color:'#1565c0' },
    ],
    'Cold Formed': [
      { id:'ColdC',     label:'Cold Formed C',         icon:'C',  color:'#00838f' },
      { id:'ColdZ',     label:'Cold Formed Z',         icon:'Z',  color:'#00838f' },
    ],
    'Special': [
      { id:'Nonprismatic', label:'Nonprismatic',        icon:'◇',  color:'#607d8b' },
      { id:'General',      label:'General (User-Defined)', icon:'*', color:'#607d8b' },
    ]
  };

  // Flat map: id → {label, color}
  const SHAPE_MAP = {};
  Object.values(SHAPE_GROUPS).forEach(function(grp) {
    grp.forEach(function(s){ SHAPE_MAP[s.id] = { label: s.label, color: s.color }; });
  });

  // Helper: full label for a shape id
  function _getShapeLabel(shapeId) {
    var entry = SHAPE_MAP[shapeId];
    // A section with no shape is not incomplete — its properties were entered
    // directly (Excel import, "+ Section" in the explorer). ETABS calls that a
    // General section, and "Select Shape..." wrongly implied something was
    // missing now that these appear in this list at all.
    return entry ? entry.label : (shapeId || 'General');
  }

  // Helper: display color for a shape id
  function _shapeColor(shapeId) {
    var entry = SHAPE_MAP[shapeId];
    if (entry) return entry.color;
    if (_isConcrete(shapeId)) return '#78909c';
    if (/Steel/i.test(shapeId || '')) return '#1565c0';
    if (/Cold/i.test(shapeId || '')) return '#00838f';
    return '#607d8b';
  }

  // ACI 318 recommended modifiers per member type
  const ACI_MODS = {
    Beam:   { A:1, AS2:0.35, AS3:1, J:0.35, I33:0.35, I22:1,  mass:1, weight:1 },
    Column: { A:1, AS2:0.70, AS3:1, J:0.70, I33:0.70, I22:0.70, mass:1, weight:1 },
    Wall:   { A:1, AS2:0.70, AS3:1, J:0.70, I33:0.70, I22:0.35, mass:1, weight:1 },
    Slab:   { A:1, AS2:0.25, AS3:1, J:0.25, I33:0.25, I22:0.25, mass:1, weight:1 },
    Default:{ A:1, AS2:1,    AS3:1, J:1,    I33:1,    I22:1,    mass:1, weight:1 },
  };

  // ── Section store ──────────────────────────────────────────────
  // There is no private array. The store IS window.SA.sections — the same one
  // the model explorer lists, the Section Manager assigns from, and the solver
  // reads. This dialog used to keep its own copy in localStorage
  // ('sa_frame_secs_v5') and push it into SA on close and 1.5 s after every
  // page load, matching by name and overwriting field by field. Anything the
  // user changed in the explorer table — or loaded from a .frame file — was
  // silently reverted to whatever this browser's copy said.
  function _secs() { var SA = window.SA; return (SA && SA.sections) || []; }
  function _newId() { var SA = window.SA; return SA && SA.allocSectionId ? SA.allocSectionId() : Date.now(); }
  // Record for undo; the app's debounced autosave persists it.
  function _commit() { var SA = window.SA; SA && SA.snapshot && SA.snapshot(); }
  function _refreshModel() {
    var SA = window.SA;
    SA && SA.updateSectionTable && SA.updateSectionTable();
    SA && SA.render && SA.render();
  }
  var _selId  = null;
  var _editId = null;
  var _filterType = 'All';
  var _filterText = '';

  // Presets  (AISC shapes include `props` with accurate tabulated values)
  const PRESETS = [
    // Concrete beams
    { name:'ConcBm-300x600', mat:'C25 (4000Psi)', shapeId:'ConcRect', d:600, b:300 },
    { name:'ConcBm-250x500', mat:'C25 (4000Psi)', shapeId:'ConcRect', d:500, b:250 },
    { name:'ConcBm-200x450', mat:'C25 (4000Psi)', shapeId:'ConcRect', d:450, b:200 },
    // Concrete columns
    { name:'ConcCol-400x400', mat:'C30 (5000Psi)', shapeId:'ConcRect', d:400, b:400 },
    { name:'ConcCol-500x500', mat:'C30 (5000Psi)', shapeId:'ConcRect', d:500, b:500 },
    { name:'ConcCol-600x600', mat:'C35',            shapeId:'ConcRect', d:600, b:600 },
    { name:'ConcCol-Circ-400',mat:'C30 (5000Psi)', shapeId:'ConcCirc', d:400, b:400 },
    // Steel — AISC W-shapes with accurate tabulated properties + real tf/tw from AISC tables
    // tf = flange thickness, tw = web thickness (all mm, rounded from AISC inch values)
    { name:'W8x31',  mat:'A992Fy50', shapeId:'SteelW', d:203, b:203, tf:11, tw: 7, props:{A:58.9,  I33:8580,   I22:1100,  J:2.18, S33:84.5,  S22:10.9, R33:12.1, R22:4.32} },
    { name:'W8x48',  mat:'A992Fy50', shapeId:'SteelW', d:216, b:206, tf:15, tw: 9, props:{A:91.0,  I33:13700,  I22:1820,  J:6.94, S33:127,   S22:17.7, R33:12.3, R22:4.47} },
    { name:'W10x33', mat:'A992Fy50', shapeId:'SteelW', d:264, b:201, tf:11, tw: 7, props:{A:62.6,  I33:17000,  I22:2360,  J:1.27, S33:129,   S22:23.4, R33:16.5, R22:6.14} },
    { name:'W10x45', mat:'A992Fy50', shapeId:'SteelW', d:275, b:203, tf:15, tw: 9, props:{A:85.8,  I33:23900,  I22:3200,  J:2.81, S33:174,   S22:31.5, R33:16.7, R22:6.10} },
    { name:'W12x53', mat:'A992Fy50', shapeId:'SteelW', d:313, b:254, tf:15, tw: 9, props:{A:101,   I33:38800,  I22:5540,  J:4.32, S33:248,   S22:43.6, R33:19.6, R22:7.41} },
    { name:'W14x68', mat:'A992Fy50', shapeId:'SteelW', d:356, b:254, tf:18, tw:10, props:{A:129,   I33:74400,  I22:8700,  J:6.19, S33:418,   S22:68.5, R33:24.0, R22:8.20} },
    { name:'W16x77', mat:'A992Fy50', shapeId:'SteelW', d:406, b:255, tf:19, tw:11, props:{A:146,   I33:127000, I22:9840,  J:6.42, S33:625,   S22:77.1, R33:29.5, R22:8.18} },
  ];

  // ── Legacy store (read once, never written again) ──────────────
  var STORE_KEY    = 'sa_frame_secs_v5';
  var MIGRATED_KEY = 'sa_frame_secs_migrated_v1';

  // Auto-correct corrupt shapeId based on section name heuristics
  function _fixShapeId(s) {
    var nm = (s.name||'').toLowerCase();
    var id = s.shapeId||'';

    // Concrete section named "Conc*" but has a steel shapeId
    if (/conc/i.test(nm) && /Steel|Cold/i.test(id)) {
      if (/circ/i.test(nm) || /pipe/i.test(nm))       s.shapeId = 'ConcCirc';
      else if (/tee|tbeam/i.test(nm))                  s.shapeId = 'ConcTee';
      else if (/l.?shap|lshape/i.test(nm))             s.shapeId = 'ConcL';
      else if (/box/i.test(nm))                        s.shapeId = 'ConcBox';
      else                                             s.shapeId = 'ConcRect';
    }

    // Steel section named "W*x*" or "Steel*" but has a concrete shapeId
    if (/^w\d+x\d+$/i.test(nm) && _isConcrete(id)) s.shapeId = 'SteelW';
    if (/^steel/i.test(nm)      && _isConcrete(id)) s.shapeId = 'SteelW';

    // SteelRod named "Conc*Circ*" — data corruption — fix to ConcCirc
    if (id === 'SteelRod' && /conc/i.test(nm) && /circ/i.test(nm)) s.shapeId = 'ConcCirc';

    return s;
  }

  // Guess correct material from section name when data is corrupt.
  // Deliberately narrow: only the two combinations that cannot be intentional
  // are corrected, so a section a user has deliberately put on an unusual
  // material is left alone.
  function _fixMaterial(s) {
    var MU = window.MAT_UI; if (!MU) return s;
    var nm  = (s.name||'').toLowerCase();
    var cur = MU.getMaterialById(s.materialId);
    var byName = function(n){ var m = MU.getMaterialByName(n); return m ? m.id : s.materialId; };
    if (!cur) return s;
    // Concrete section carrying a steel material
    if (/conc|col.*\d+x\d+/.test(nm) && cur.type === 'Steel') {
      s.materialId = byName(/c35|c30/i.test(nm) ? 'C35' : /c25/i.test(nm) ? 'C25 (4000Psi)' : 'C30 (5000Psi)');
    }
    // W-shape carrying a concrete material
    if (/^w\d+x\d+$/i.test(nm) && cur.type === 'Concrete') {
      s.materialId = byName('A992Fy50');
    }
    return s;
  }

  /** The shapeId / material / thickness repairs, applied to one section. */
  /**
   * Repair one parametric section and recompute its derived properties.
   *
   * Safe to run on every load now that the explorer's derived cells are
   * read-only: recomputing can no longer discard something the user typed,
   * and it guarantees a section's stored A/I actually match its dimensions.
   */
  function _repair(sec) {
    _fixShapeId(sec);
    if ((_isIBeam(sec.shapeId)||_isChannel(sec.shapeId)||_isTee(sec.shapeId)) && !sec.tf) {
      sec.tf = Math.max(8, Math.round(sec.d/12));
      sec.tw = Math.max(6, Math.round((sec.b||sec.d)/10));
    }
    if (_isBox(sec.shapeId)||_isCircular(sec.shapeId)) { if(!sec.t) sec.t = Math.max(6,Math.round(Math.min(sec.d,sec.b||sec.d)/10)); }
    if (_isAngle(sec.shapeId)) { if(!sec.ta) sec.ta = Math.max(6,Math.round(Math.min(sec.d,sec.b||sec.d)/8)); }
    if (_isTee(sec.shapeId))   { if(!sec.ts) sec.ts = Math.max(8,Math.round((sec.b||sec.d)/5)); }
    sec.color = _shapeColor(sec.shapeId);
    _compute(sec);
    return sec;
  }

  /**
   * Bring the model's sections up to what this dialog needs, once per load.
   *
   *  · sections that predate `materialId` get one resolved from their old
   *    `material` name string;
   *  · parametric sections get their shape data repaired and recomputed;
   *  · sections with no shapeId — Excel imports, "+ Section" in the explorer —
   *    are left exactly as they are. Their properties were typed in directly,
   *    and inventing a shape for them would overwrite real numbers with
   *    derived ones. They still appear in the list, badged "General".
   */
  function _init() {
    var SA = window.SA; if (!SA || !SA.sections) return;
    _migrateLegacy();
    _secs().forEach(function(sec){
      _linkMaterial(sec);
      if (sec.shapeId) _repair(sec);
    });
    if (!_selId && _secs().length) _selId = _secs()[0].id;
  }

  /**
   * Give a section a materialId, resolving the legacy `material` name string
   * if that is all it has.
   *
   * Sections used to name their material ('A992Fy50'), so renaming a material
   * detached every section built on it and two materials sharing a name were
   * indistinguishable. The name is left on the object untouched — it is dead
   * weight, not a second source of truth.
   */
  function _linkMaterial(sec) {
    var MU = window.MAT_UI; if (!MU || !MU.getMaterials().length) return;
    if (sec.materialId == null) {
      var byName = sec.material ? MU.getMaterialByName(sec.material) : null;
      if (byName) sec.materialId = byName.id;
    }
    if (sec.materialId == null || !MU.getMaterialById(sec.materialId)) {
      // Nothing usable: attach it to a material of the right family rather than
      // leave it floating, so a later material edit still reaches it.
      var want = _isConcrete(sec.shapeId, sec.name) ? 'Concrete' : 'Steel';
      var fallback = (MU.getMaterials()||[]).find(function(m){ return m.type === want; })
                  || MU.getMaterials()[0];
      if (fallback) sec.materialId = fallback.id;
    }
    _fixMaterial(sec);
  }

  /**
   * One-time import of the browser-local section store into the model.
   *
   * Merged by name onto whatever the model already has, so a project that
   * already carries a section keeps the project's copy as the identity and
   * only gains the shape definition. The old key is left in place rather than
   * deleted — nothing is lost if this build is rolled back.
   */
  function _migrateLegacy() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) { _seedIfEmpty(); return; }
      var raw = localStorage.getItem(STORE_KEY);
      localStorage.setItem(MIGRATED_KEY, '1');
      if (!raw) { _seedIfEmpty(); return; }
      var d = JSON.parse(raw);
      if (!d || !d.secs || !d.secs.length) { _seedIfEmpty(); return; }
      var lib = _secs(), added = 0;
      d.secs.forEach(function(old){
        var hit = lib.find(function(x){ return x.name === old.name; });
        if (hit) {
          // Keep the model's id and its own solver properties; take only the
          // shape definition the model never had.
          ['shapeId','d','b','t','tf','tw','ts','ta','material','mods','rebar','rigidZone','notes','color','_presetProps']
            .forEach(function(k){ if (old[k] !== undefined && hit[k] === undefined) hit[k] = old[k]; });
        } else {
          var copy = Object.assign({}, old, { id: _newId() });
          lib.push(copy); added++;
        }
      });
      _seedIfEmpty();
      if (added) {
        var SA = window.SA;
        SA && SA.toast && SA.toast('Imported ' + added + ' section' + (added===1?'':'s') +
          ' from this browser into the model', 'info');
      }
    } catch(_) { _seedIfEmpty(); }
  }

  /** A model with no sections at all gets the shipped presets. */
  function _seedIfEmpty() {
    if (_secs().length) return;
    PRESETS.forEach(function(p){ _secs().push(_makeSection(p.name,p.mat,p.shapeId,p.d,p.b,p.props,p.tf,p.tw)); });
    if(_secs().length) _selId = _secs()[0].id;
  }

  // ── Saint-Venant torsion constant for a solid rectangle ──────────
  // J = β·a·c³ with a = long side, c = short side, β from the standard table
  // (Roark / Timoshenko). The previous code used a fixed β = 0.141 — the value
  // for a SQUARE — and always cubed `d` regardless of which side was shorter.
  // For a 300×600 beam that returned 913,680 cm⁴ against a true 370,980 cm⁴,
  // 146% high. β rises from 0.141 at a/c = 1 toward 1/3 for a thin strip.
  var _J_BETA = [[1,0.1406],[1.5,0.1959],[2,0.2290],[3,0.2633],
                 [4,0.2817],[6,0.2985],[10,0.3120],[Infinity,1/3]];
  function _rectJ(side1, side2) {
    var a = Math.max(side1, side2), c = Math.min(side1, side2);
    if (!(c > 0)) return 0;
    var ratio = a / c, beta = 1/3;
    for (var i = 0; i < _J_BETA.length - 1; i++) {
      if (ratio <= _J_BETA[i][0]) { beta = _J_BETA[i][1]; break; }
      if (ratio < _J_BETA[i+1][0]) {
        var f = (ratio - _J_BETA[i][0]) / (_J_BETA[i+1][0] - _J_BETA[i][0]);
        beta = _J_BETA[i][1] + f * (_J_BETA[i+1][1] - _J_BETA[i][1]);
        break;
      }
    }
    return beta * a * c * c * c;
  }

  function _makeSection(name, mat, shapeId, d, b, presetProps, presetTf, presetTw) {
    var id = shapeId||'ConcRect';
    // Default thickness values based on shape and dimensions
    var defTf = null, defTw = null, defT = null, defTs = null, defTa = null;
    if (_isIBeam(id)||_isChannel(id)||_isTee(id)) {
      let dn=d||400, bn=b||400;
      defTf = presetTf || Math.max(8, Math.round(dn/12));
      defTw = presetTw || Math.max(6, Math.round(bn/10));
    }
    if (_isTee(id))    { defTs = Math.max(8, Math.round((b||400)/5)); }
    if (_isBox(id)||_isCircular(id)) { defT  = Math.max(6, Math.round(Math.min(d||400,b||400)/10)); }
    if (_isAngle(id))  { defTa = Math.max(6, Math.round(Math.min(d||400,b||400)/8)); }
    var MU = window.MAT_UI;
    var matObj = MU && MU.getMaterialByName ? MU.getMaterialByName(mat) : null;
    var s = { id:_newId(), name:name, materialId: matObj ? matObj.id : null, shapeId:id,
              d:d||400, b:b||400, color:_shapeColor(id),
              tf:defTf, tw:defTw, t:defT, ts:defTs, ta:defTa,
              rigidZone:false,
              mods: Object.assign({},ACI_MODS.Default),
              rebar: _defaultRebar(), notes:'' };
    _compute(s);
    // Override computed props with accurate preset values if provided
    if (presetProps) {
      Object.assign(s.props, presetProps);
      s._presetProps = Object.assign({}, presetProps); // store for recompute guard
    }
    return s;
  }

  function _defaultRebar() {
    return { designType:'column', config:'rectangular', confineType:'ties',
             checkDesign:'design', longMat:'A615Gr60', confMat:'A615Gr60',
             cover:40, barsAlong3:3, barsAlong2:5,
             barSize:'#9', barArea:645, cornerBarSize:'#9', cornerBarArea:645,
             confBarSize:'#4', confBarArea:129, confSpacing:150, confBars3:3, confBars2:3 };
  }

  // ── Section shape predicates ────────────────────────────────────
  function _isConcrete(id, secName){
    return /Conc|Precast/i.test(id||'') || /Conc|concrete/i.test(secName||'');
  }
  // Circular: ConcCirc, ConcPipe, SteelPipe/CHS, SteelRod (solid circle)
  function _isCircular(id, nm){
    return /Circ|Pipe/i.test(id||'') || id==='SteelRod' ||
           /Circ/i.test(nm||'');   // fallback: name contains "Circ"
  }
  // Solid rod (no wall thickness — distinct from hollow pipe)
  function _isSolidRod(id){ return id==='SteelRod' || /^ConcCirc$/i.test(id||''); }
  function _isIBeam(id)   { return /SteelW|Precast/i.test(id||''); }
  function _isChannel(id) { return id==='SteelC'||id==='ColdC'||id==='ColdZ'; }
  function _isAngle(id)   { return id==='SteelL'||id==='ConcL'; }
  function _isDouble2L(id){ return id==='Steel2L'; }
  function _isTee(id)     { return id==='SteelT'||id==='ConcTee'; }
  function _isBox(id)     { return id==='SteelBox'||id==='ConcBox'; }
  function _isPlate(id)   { return id==='SteelPlate'; }

  function _compute(sec) {
    var d  = sec.d/1000, b = (sec.b||sec.d)/1000;
    var p  = {}; var id = sec.shapeId||'ConcRect';

    // User-specified thickness values (mm → m), fall back to proportional defaults
    var u_tf = sec.tf ? sec.tf/1000 : null;
    var u_tw = sec.tw ? sec.tw/1000 : null;
    var u_t  = sec.t  ? sec.t/1000  : null;
    var u_ts = sec.ts ? sec.ts/1000 : null;
    var u_ta = sec.ta ? sec.ta/1000 : null;

    if (_isCircular(id, sec.name)) {
      let r = d/2;
      if (!_isSolidRod(id) && u_t && u_t < r) {
        // ── Hollow pipe / CHS ──────────────────────────────────────
        var ri = r - u_t;
        p.A  = +(Math.PI*(r*r - ri*ri)*1e4).toFixed(1);
        p.I33= +(Math.PI*(Math.pow(r,4)-Math.pow(ri,4))/4*1e8).toFixed(0); p.I22=p.I33;
        p.J  = +(Math.PI*(Math.pow(r,4)-Math.pow(ri,4))/2*1e8).toFixed(0);
      } else {
        // ── Solid circle (ConcCirc, SteelRod, unthickened pipe) ────
        p.A  = +(Math.PI*r*r*1e4).toFixed(1);
        p.I33= +(Math.PI*Math.pow(r,4)/4*1e8).toFixed(0); p.I22=p.I33;
        p.J  = +(Math.PI*Math.pow(r,4)/2*1e8).toFixed(0);
      }
    } else if (_isIBeam(id)) {
      // ── I-beam / Wide Flange / Precast I ───────────────────────
      let tf = u_tf || Math.max(0.008, d/12);
      let tw = u_tw || Math.max(0.006, b/10);
      let hw = d - 2*tf;
      p.A  = +((2*b*tf + hw*tw)*1e4).toFixed(1);
      p.I33= +((b*Math.pow(d,3)/12 - (b-tw)*Math.pow(hw,3)/12)*1e8).toFixed(0);
      p.I22= +((2*tf*Math.pow(b,3)/12 + hw*Math.pow(tw,3)/12)*1e8).toFixed(0);
      p.J  = +((2*b*Math.pow(tf,3)/3 + hw*Math.pow(tw,3)/3)*1e8).toFixed(0);
    } else if (_isChannel(id)) {
      // ── C-Channel / Cold-Formed C / Cold-Formed Z ──────────────
      let tf = u_tf || Math.max(0.008, d/10);
      let tw = u_tw || Math.max(0.006, b/8);
      if (id==='ColdZ') {
        // Z-section: anti-symmetric flanges — use same formula as C for principal props
        p.A  = +((2*b*tf + (d-2*tf)*tw)*1e4).toFixed(1);
      } else {
        p.A  = +((2*b*tf + (d-2*tf)*tw)*1e4).toFixed(1);
      }
      p.I33= +((b*Math.pow(d,3)/12 - (b-tw)*Math.pow(d-2*tf,3)/12)*1e8).toFixed(0);
      p.I22= +((2*tf*Math.pow(b,3)/12 + (d-2*tf)*Math.pow(tw,3)/12)*1e8).toFixed(0);
      p.J  = +((2*b*Math.pow(tf,3)/3 + (d-2*tf)*Math.pow(tw,3)/3)*1e8).toFixed(0);
    } else if (_isDouble2L(id)) {
      // ── Steel Double Angle (2L) — two equal-leg angles back-to-back ──
      let ta = u_ta || Math.max(0.006, Math.min(d,b)/8);
      // Single-angle CENTROIDAL properties, then combined. As with the single
      // angle above, these were left about the outer edges, overstating I33 by
      // ~87% for equal legs.
      let A1    = ta*(b + d - ta);
      let yc1   = (d*d*ta/2 + (b-ta)*ta*ta/2) / A1;
      let xc1   = (b*b*ta/2 + (d-ta)*ta*ta/2) / A1;
      let I33a  = ta*Math.pow(d,3)/3 + (b-ta)*Math.pow(ta,3)/3 - A1*yc1*yc1;
      let I22a  = ta*Math.pow(b,3)/3 + (d-ta)*Math.pow(ta,3)/3 - A1*xc1*xc1;
      let J1    = (d+b-ta)*Math.pow(ta,3)/3;
      p.A   = +(2*A1*1e4).toFixed(1);
      // Both angles share the horizontal axis, so I33 simply doubles.
      p.I33 = +(2*I33a*1e8).toFixed(0);
      // About the vertical axis they sit back-to-back, each offset by its own
      // centroid distance from the shared back — that parallel-axis term was
      // missing, which UNDERstated I22 for the pair.
      p.I22 = +(2*(I22a + A1*xc1*xc1)*1e8).toFixed(0);
      p.J   = +(2*J1*1e8).toFixed(0);
    } else if (_isAngle(id)) {
      // ── Angle / L-shape (Steel or Concrete) ────────────────────
      // I33/I22 must be about the CENTROIDAL axes. The previous expressions
      // stopped at the outer-edge values and never applied the parallel-axis
      // reduction −A·yc² / −A·xc², so an L100×100×10 reported I33 = 336 cm⁴
      // against a true 180 cm⁴ (87% high) and I22 = 246 cm⁴ (37% high). These
      // values are pushed straight into the solver by _flatten() as I and Ix,
      // so the error became member stiffness — unsafe, since it understates
      // deflection and misplaces load in an indeterminate frame.
      // An equal angle must give I33 === I22; that is the quickest sanity check.
      let t = u_ta || Math.max(0.006, Math.min(d,b)/8);
      let A_ang = t*(b + d - t);
      // Centroid from the outer corner: vertical leg is d tall, horizontal b wide.
      let yc_a = (d*d*t/2 + (b-t)*t*t/2) / A_ang;
      let xc_a = (b*b*t/2 + (d-t)*t*t/2) / A_ang;
      let I33_edge = t*Math.pow(d,3)/3 + (b-t)*Math.pow(t,3)/3;   // about the base
      let I22_edge = t*Math.pow(b,3)/3 + (d-t)*Math.pow(t,3)/3;   // about the left edge
      p.A  = +(A_ang*1e4).toFixed(1);
      p.I33= +((I33_edge - A_ang*yc_a*yc_a)*1e8).toFixed(0);
      p.I22= +((I22_edge - A_ang*xc_a*xc_a)*1e8).toFixed(0);
      p.J  = +((d+b-t)*Math.pow(t,3)/3*1e8).toFixed(0);
    } else if (_isTee(id)) {
      // ── T-section (Steel Tee / Concrete T-Beam) ────────────────
      let tf = u_tf || Math.max(0.05, d*0.25);
      let ts = u_ts || Math.max(0.008, b*0.2);   // stem (web) width
      let ycg = (b*tf*(d-tf/2) + (d-tf)*ts*(d-tf)/2) / (b*tf + (d-tf)*ts);
      p.A  = +((b*tf + (d-tf)*ts)*1e4).toFixed(1);
      p.I33= +((b*Math.pow(tf,3)/12 + b*tf*Math.pow(d-ycg-tf/2,2) +
               ts*Math.pow(d-tf,3)/12 + ts*(d-tf)*Math.pow(ycg-(d-tf)/2,2))*1e8).toFixed(0);
      p.I22= +((tf*Math.pow(b,3)/12 + (d-tf)*Math.pow(ts,3)/12)*1e8).toFixed(0);
      p.J  = +((b*Math.pow(tf,3)/3 + ts*Math.pow(d-tf,3)/3)*1e8).toFixed(0);
    } else if (_isBox(id)) {
      // ── Hollow rectangular (Steel Box / Concrete Box) ──────────
      let t = u_t || Math.max(0.006, Math.min(d,b)*0.1);
      let do_ = d-2*t, bo_ = b-2*t;
      p.A  = +((d*b - do_*bo_)*1e4).toFixed(1);
      p.I33= +((b*Math.pow(d,3)/12 - bo_*Math.pow(do_,3)/12)*1e8).toFixed(0);
      p.I22= +((d*Math.pow(b,3)/12 - do_*Math.pow(bo_,3)/12)*1e8).toFixed(0);
      let Aenc = (d-t)*(b-t), perim = 2*((d-t)+(b-t));
      p.J  = +(4*Aenc*Aenc/(perim/t)*1e8).toFixed(0);
    } else if (_isPlate(id)) {
      // ── Steel Plate — thin flat rectangle (t=depth, b=width) ───
      p.A  = +(b*d*1e4).toFixed(1);
      p.I33= +(b*Math.pow(d,3)/12*1e8).toFixed(0);   // weak bending (thin)
      p.I22= +(d*Math.pow(b,3)/12*1e8).toFixed(0);   // strong bending
      // Thin open rectangle: J ≈ (1/3)·long·short³. This had the sides the
      // wrong way round (d·b³/3), which for a plate — where d is the thickness
      // — overstates J by (b/d)², i.e. orders of magnitude.
      p.J  = +(_rectJ(b, d)*1e8).toFixed(0);
    } else {
      // ── Rectangle (Concrete Rect / default) ────────────────────
      p.A  = +(b*d*1e4).toFixed(1);
      p.I33= +(b*Math.pow(d,3)/12*1e8).toFixed(0);
      p.I22= +(d*Math.pow(b,3)/12*1e8).toFixed(0);
      p.J  = +(_rectJ(b, d)*1e8).toFixed(0);  // Saint-Venant torsion
    }
    var safeA=p.A||1;
    p.S33=+((p.I33||0)/Math.max(d*100/2,0.001)).toFixed(1);
    p.S22=+((p.I22||0)/Math.max(b*100/2,0.001)).toFixed(1);
    p.R33=+(Math.sqrt((p.I33||0)/safeA)).toFixed(2);
    p.R22=+(Math.sqrt((p.I22||0)/safeA)).toFixed(2);
    sec.props = p;
    // Restore accurate preset props if they exist (preserves AISC tabulated values)
    if (sec._presetProps) {
      Object.assign(sec.props, sec._presetProps);
    }
    // Flatten LAST, so the solver reads the AISC tabulated values rather than
    // the ones derived from the nominal outline.
    _flatten(sec);
    // Set color consistently based on shape group
    sec.color = _shapeColor(id);
  }

  // ── List dialog ─────────────────────────────────────────────────
  function openList() {
    _init();
    // The selection may name a section that an undo or a project import has
    // taken away, so settle it against what is actually there.
    if (!_secs().some(function(x){ return x.id === _selId; })) _selId = _secs().length ? _secs()[0].id : null;
    _renderList();
    document.getElementById('modal-frame-properties').classList.add('open');
  }
  function closeList() {
    // Nothing to push anywhere — the edits went straight into the model. Just
    // record them for undo and let the debounced autosave write them out.
    _commit(); _refreshModel();
    document.getElementById('modal-frame-properties').classList.remove('open');
  }

  function _renderList() {
    var list=document.getElementById('fsec-list'); if(!list)return;
    var flt=(_filterText||'').toLowerCase();
    var items=_secs().filter(function(s){
      let typeOK=_filterType==='All'||(_filterType==='Concrete'&&_isConcrete(s.shapeId,s.name))||(_filterType==='Steel'&&/Steel/i.test(s.shapeId||''));
      return typeOK&&(!flt||s.name.toLowerCase().includes(flt));
    });
    list.innerHTML=items.map(function(s){
      let shLabel=_getShapeLabel(s.shapeId);
      // Short type badge: first meaningful word of shape label
      let typeTag=shLabel.replace('Concrete ','C.').replace('Steel ','S.').replace('Cold Formed ','CF.');
      let tip = s.shapeId
        ? s.name+' — '+shLabel+', '+(s.d||'?')+'×'+(s.b||'?')+' mm. Properties are derived from these dimensions.'
        : s.name+' — General section: properties were entered directly, not derived from a shape.';
      return '<div class="fsec-item'+(s.id===_selId?' selected':'')+'" title="'+tip.replace(/"/g,'&quot;')+'"'+
        ' onclick="FRAME_SEC.select('+s.id+')" ondblclick="FRAME_SEC.openData()">' +
        '<span class="fsec-color" style="background:'+(s.color||'#9e9e9e')+'"></span>' +
        '<span class="fsec-name">'+s.name+'</span>' +
        '<span class="fsec-type">'+typeTag+'</span></div>';
    }).join('')||'<div style="padding:10px;color:#aaa;font-size:10px;text-align:center">No sections — click Add New</div>';
  }

  function select(id){ _selId=id; _renderList(); }
  function filterType(t){ _filterType=t; _renderList(); }
  function filterText(t){ _filterText=t; _renderList(); }

  // Section library Add/Copy/Delete were the one place in this app that
  // still used the browser's native prompt()/alert()/confirm() — no styling,
  // no focus trap, no dialog role, skipping the shared .modal-overlay system
  // every other dialog here gets automatically from dialog-ux.js. QuickModal
  // (js/core/quick-modal.js) is that same system's own accessible replacement;
  // falling back to the native dialog only if it somehow is not loaded.
  function _qmConfirm(msg, title) {
    return window.QuickModal ? window.QuickModal.confirm(msg, title) : Promise.resolve(confirm(msg));
  }
  function _qmPrompt(msg, def, title) {
    return window.QuickModal ? window.QuickModal.prompt(msg, def, title) : Promise.resolve(prompt(msg, def));
  }
  function _qmAlert(msg, title) {
    return window.QuickModal ? window.QuickModal.confirm(msg, title || 'Notice') : Promise.resolve(alert(msg));
  }

  async function addNew() {
    var n = await _qmPrompt('New section name:', 'Sec'+(_secs().length+1), 'New Section');
    if(!n) return;
    var s=_makeSection(n,'C25 (4000Psi)','ConcRect',400,400); _secs().push(s); _selId=s.id;
    _renderList(); _refreshModel(); _commit(); openData();
  }
  async function addCopy() {
    var src=_secs().find(function(s){return s.id===_selId;});
    if(!src){ await _qmAlert('Select a section first.'); return; }
    var c=JSON.parse(JSON.stringify(src)); c.id=_newId(); c.name=src.name+' Copy'; _secs().push(c); _selId=c.id;
    _renderList(); _refreshModel(); _commit(); openData();
  }
  async function deleteSec() {
    var lib=_secs();
    var idx=lib.findIndex(function(s){return s.id===_selId;}); if(idx<0)return;
    var sec=lib[idx];
    // Deleting here now deletes from the model, so a member still assigned to
    // this section would be left pointing at nothing — which the solver reads
    // as no stiffness and reports as a singular matrix, a long way from the
    // cause. Previously the delete only touched this dialog's private copy and
    // the model kept the section forever; neither is right.
    var SA=window.SA;
    var users=((SA&&SA.beams)||[]).filter(function(b){ return b.sectionId===sec.id; });
    if (users.length) {
      await _qmAlert('"'+sec.name+'" is assigned to '+users.length+' member'+(users.length===1?'':'s')+
            ' (B'+users.slice(0,10).map(function(b){return b.id;}).join(', B')+
            (users.length>10?', …':'')+').\n\nAssign those members a different section first.',
            'Cannot Delete');
      return;
    }
    var ok = await _qmConfirm('Delete "'+sec.name+'"?', 'Delete Section');
    if(!ok) return;
    lib.splice(idx,1); _selId=lib.length?lib[Math.max(0,idx-1)].id:null;
    _renderList(); _refreshModel(); _commit();
  }

  // ── Section Property Data dialog ───────────────────────────────
  async function openData() {
    var sec=_secs().find(function(s){return s.id===_selId;});
    if(!sec){ await _qmAlert('Select a section first.'); return; }
    _editId=sec.id; _fillDataForm(sec);
    document.getElementById('modal-frame-sec-data').classList.add('open');
  }

  function _fillDataForm(sec) {
    function sv(id,v){ var e=document.getElementById(id); if(e&&v!=null) e.value=v; else if(e) e.value=''; }
    sv('fsd-name',  sec.name);
    sv('fsd-depth', sec.d);
    sv('fsd-width', sec.b);
    sv('fsd-t',  sec.t  || '');
    sv('fsd-tf', sec.tf || '');
    sv('fsd-tw', sec.tw || '');
    sv('fsd-ts', sec.ts || '');
    sv('fsd-ta', sec.ta || '');
    // Rigid zone checkbox
    var rzEl = document.getElementById('fsd-rigid-zone');
    if (rzEl) rzEl.checked = !!sec.rigidZone;
    // Shape button label — show full descriptive name
    var shapeLbl=document.getElementById('fsd-shape-btn-lbl');
    if(shapeLbl) shapeLbl.textContent=_getShapeLabel(sec.shapeId);
    // Material dropdown
    _populateMaterialDropdown(sec.materialId);
    // Shape-specific fields (shows/hides extra rows)
    _updateDimFields(sec.shapeId);
    // Preview
    _drawPreview(sec);
    // Modifier status
    _updateModLabel(sec);
    // Live computed props
    _updateInlineProps(sec);
  }

  // Option values are material IDS, not names. Keying on the name meant a
  // section lost its material the moment that material was renamed, and two
  // materials sharing a name were indistinguishable.
  function _populateMaterialDropdown(selId) {
    var sel=document.getElementById('fsd-material'); if(!sel)return;
    var mats=window.MAT_UI?MAT_UI.getMaterials():[];
    sel.innerHTML=mats.map(function(m){
      return '<option value="'+m.id+'"'+(m.id===selId?' selected':'')+'>'+m.name+' ('+m.type+')</option>';
    }).join('')||'<option value="">(no materials defined)</option>';
  }

  function _updateDimFields(shapeId) {
    var depthLbl = document.getElementById('fsd-depth-lbl');
    var widthRow = document.getElementById('fsd-width-row');
    var widthLbl = document.getElementById('fsd-width-lbl');
    if (!depthLbl) return;

    var editSec = _secs().find(function(s){ return s.id===_editId; });
    var secNm   = editSec ? editSec.name : '';

    var circ   = _isCircular(shapeId, secNm);
    var rod    = _isSolidRod(shapeId);
    var ibeam  = _isIBeam(shapeId);
    var chan   = _isChannel(shapeId);
    var tee    = _isTee(shapeId);
    var box    = _isBox(shapeId);
    var ang    = _isAngle(shapeId);
    var d2l    = _isDouble2L(shapeId);
    var plate  = _isPlate(shapeId);
    var coldZ  = shapeId === 'ColdZ';

    // ── Depth label ──────────────────────────────────────────────
    depthLbl.textContent =
      circ  ? 'Diameter (d)'       :
      ang   ? 'Leg Depth (d)'      :
      d2l   ? 'Leg Depth (d)'      :
      tee   ? 'Total Depth (d)'    :
      plate ? 'Thickness (t)'      : 'Depth (d)';

    // ── Width row — hidden for circular sections ──────────────────
    if (widthRow) widthRow.classList.toggle('hidden', circ);
    if (widthLbl) widthLbl.textContent =
      ang  ? 'Leg Width (b)'   :
      d2l  ? 'Leg Width (b)'   :
      tee  ? 'Flange Width (b)':
      plate? 'Width (b)'       : 'Width (b)';

    // ── Wall thickness row — hollow pipe/CHS and Box sections ────
    // Not shown for SteelRod (solid) or ConcCirc (solid)
    var tRow = document.getElementById('fsd-t-row');
    var showT = (box) || (circ && !rod);
    if (tRow) tRow.classList.toggle('hidden', !showT);
    var tLbl = document.getElementById('fsd-t-lbl');
    if (tLbl) tLbl.textContent = 'Wall Thickness (t)';

    // ── Flange thickness — I-beam, Channel (inc. ColdZ), Tee ──────
    var tfRow = document.getElementById('fsd-tf-row');
    if (tfRow) tfRow.classList.toggle('hidden', !(ibeam || chan || tee || coldZ));
    var tfLbl = document.getElementById('fsd-tf-lbl');
    if (tfLbl) tfLbl.textContent = 'Flange Thickness (tf)';

    // ── Web thickness — I-beam, Channel (inc. ColdZ) ─────────────
    var twRow = document.getElementById('fsd-tw-row');
    if (twRow) twRow.classList.toggle('hidden', !(ibeam || chan || coldZ));
    var twLbl = document.getElementById('fsd-tw-lbl');
    if (twLbl) twLbl.textContent = coldZ ? 'Web Width (tw)' : 'Web Thickness (tw)';

    // ── Stem width — Tee only ────────────────────────────────────
    var tsRow = document.getElementById('fsd-ts-row');
    if (tsRow) tsRow.classList.toggle('hidden', !tee);
    var tsLbl = document.getElementById('fsd-ts-lbl');
    if (tsLbl) tsLbl.textContent = 'Stem Width (ts)';

    // ── Leg thickness — Angle and Double Angle ───────────────────
    var taRow = document.getElementById('fsd-ta-row');
    if (taRow) taRow.classList.toggle('hidden', !(ang || d2l));
    var taLbl = document.getElementById('fsd-ta-lbl');
    if (taLbl) taLbl.textContent = d2l ? 'Leg Thickness (t)' : 'Leg Thickness (t)';

    // ── Reinforcement section — only for concrete members ────────
    // Steel, Cold-Formed, Nonprismatic, General → hide entire section
    var rebarSec = document.getElementById('fsd-rebar-section');
    if (rebarSec) {
      let showRebar = _isConcrete(shapeId, secNm);
      rebarSec.style.display = showRebar ? '' : 'none';
    }
  }

  // Called on every input change — updates preview + computed props live
  function onInputChange() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    // Read current form values into sec (temporary, not saved yet)
    var d=parseFloat(document.getElementById('fsd-depth').value);  if(d>0) sec.d=d;
    var b=parseFloat(document.getElementById('fsd-width').value);  if(b>0) sec.b=b;
    var t =parseFloat(document.getElementById('fsd-t').value);     sec.t  = t>0?t:null;
    var tf=parseFloat(document.getElementById('fsd-tf').value);    sec.tf = tf>0?tf:null;
    var tw=parseFloat(document.getElementById('fsd-tw').value);    sec.tw = tw>0?tw:null;
    var ts=parseFloat(document.getElementById('fsd-ts').value);    sec.ts = ts>0?ts:null;
    var ta=parseFloat(document.getElementById('fsd-ta').value);    sec.ta = ta>0?ta:null;
    var matEl=document.getElementById('fsd-material'); if(matEl&&matEl.value)sec.materialId=+matEl.value;
    // Changing dimensions clears preset props so computed values are used
    delete sec._presetProps;
    _compute(sec);
    _drawPreview(sec);
    _updateInlineProps(sec);
  }

  function _updateInlineProps(sec) {
    var p=sec.props||{}; if(!p.A)return;
    function st(id,v){ var e=document.getElementById(id); if(e)e.textContent=v!=null?v:'—'; }
    st('fsd-prop-A',   p.A+' cm²');
    st('fsd-prop-I33', p.I33+' cm⁴');
    st('fsd-prop-I22', p.I22+' cm⁴');
    st('fsd-prop-J',   p.J+' cm⁴');
    st('fsd-prop-R33', p.R33+' cm');
    st('fsd-prop-R22', p.R22+' cm');
  }

  function _updateModLabel(sec) {
    var lbl=document.getElementById('fsd-mod-label'); if(!lbl)return;
    var mods=sec.mods||{}; var def=ACI_MODS.Default;
    var isDefault=Object.keys(def).every(function(k){return Math.abs((mods[k]||1)-(def[k]||1))<0.001;});
    lbl.textContent=isDefault?'Currently Default':'Modified ✓';
    lbl.style.color=isDefault?'var(--text-sec)':'#2e7d32';
  }

  function saveData() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    sec.name     = document.getElementById('fsd-name').value||sec.name;
    var matEl=document.getElementById('fsd-material'); if(matEl&&matEl.value)sec.materialId=+matEl.value;
    sec.d        = parseFloat(document.getElementById('fsd-depth').value)||sec.d;
    sec.b        = parseFloat(document.getElementById('fsd-width').value)||sec.b;
    // Extra thickness fields
    var t =parseFloat(document.getElementById('fsd-t').value);     sec.t  = t>0?t:sec.t;
    var tf=parseFloat(document.getElementById('fsd-tf').value);    sec.tf = tf>0?tf:sec.tf;
    var tw=parseFloat(document.getElementById('fsd-tw').value);    sec.tw = tw>0?tw:sec.tw;
    var ts=parseFloat(document.getElementById('fsd-ts').value);    sec.ts = ts>0?ts:sec.ts;
    var ta=parseFloat(document.getElementById('fsd-ta').value);    sec.ta = ta>0?ta:sec.ta;
    // Rigid zone flag
    var rzEl = document.getElementById('fsd-rigid-zone');
    sec.rigidZone = rzEl ? rzEl.checked : false;
    _compute(sec); _renderList(); _refreshModel(); _commit();
    document.getElementById('modal-frame-sec-data').classList.remove('open');
    var SA=window.SA; SA&&SA.toast&&SA.toast('Section "'+sec.name+'" saved','ok');
  }

  // ── Shape Picker dialog ────────────────────────────────────────
  function openShapePicker() {
    var modal=document.getElementById('modal-shape-picker'); if(!modal)return;
    var container=document.getElementById('shape-picker-grid'); if(!container)return;
    var sec=_secs().find(function(s){return s.id===_editId;});
    var curId=sec?sec.shapeId:'ConcRect';
    container.innerHTML=Object.entries(SHAPE_GROUPS).map(function(entry){
      let groupName=entry[0], shapes=entry[1];
      let items=shapes.map(function(sh){
        var active=sh.id===curId;
        return '<div class="shape-tile'+(active?' active':'')+
          '" onclick="FRAME_SEC.selectShape(\''+sh.id+'\')" title="'+sh.label+
          '" style="'+(active?'border-color:'+sh.color+';':'')+'">'+
          '<div class="shape-icon" style="color:'+sh.color+'">'+sh.icon+'</div>'+
          '<div class="shape-lbl">'+sh.label+'</div></div>';
      }).join('');
      return '<div class="shape-group-title">'+groupName+'</div>'+
             '<div class="shape-grid">'+items+'</div>';
    }).join('');
    modal.classList.add('open');
  }

  function selectShape(shapeId) {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    sec.shapeId=shapeId;
    // Changing shape invalidates any preset props (user is customising)
    delete sec._presetProps;
    // Set sensible default thicknesses for the new shape if not set
    var dv = sec.d, bv = sec.b||sec.d;
    if (_isIBeam(shapeId)||_isChannel(shapeId)||_isTee(shapeId)||(shapeId==='ColdZ')) {
      if (!sec.tf) sec.tf = Math.max(8, Math.round(dv/12));
      if (!sec.tw) sec.tw = Math.max(6, Math.round(bv/10));
    } else { sec.tf=null; sec.tw=null; }
    if (_isTee(shapeId)) {
      if (!sec.ts) sec.ts = Math.max(8, Math.round(bv/5));
    } else { sec.ts=null; }
    if (_isBox(shapeId)||(_isCircular(shapeId)&&!_isSolidRod(shapeId))) {
      if (!sec.t) sec.t = Math.max(6, Math.round(Math.min(dv,bv)/10));
    } else { sec.t=null; }
    if (_isAngle(shapeId)||_isDouble2L(shapeId)) {
      if (!sec.ta) sec.ta = Math.max(6, Math.round(Math.min(dv,bv)/8));
    } else { sec.ta=null; }
    _compute(sec);
    // Repopulate thickness inputs
    function sv(id,v){ var e=document.getElementById(id); if(e) e.value=v||''; }
    sv('fsd-t',sec.t); sv('fsd-tf',sec.tf); sv('fsd-tw',sec.tw);
    sv('fsd-ts',sec.ts); sv('fsd-ta',sec.ta);
    // Update form — show full descriptive name
    var shapeLbl=document.getElementById('fsd-shape-btn-lbl');
    if(shapeLbl) shapeLbl.textContent=_getShapeLabel(shapeId);
    _updateDimFields(shapeId);
    _drawPreview(sec);
    _updateInlineProps(sec);
    document.getElementById('modal-shape-picker').classList.remove('open');
  }

  // ── Preview canvas ─────────────────────────────────────────────
  function _drawPreview(sec) {
    var cv = document.getElementById('fsd-preview'); if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    // White background + subtle grid
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e8eaf0'; ctx.lineWidth = 0.5;
    for (var gx = 0; gx <= W; gx += 20) { ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
    for (var gy = 0; gy <= H; gy += 20) { ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }

    var id  = sec.shapeId || 'ConcRect';
    var d   = sec.d, b = sec.b || sec.d;

    // Actual thickness values (use user-set, else proportional default)
    var u_tf = sec.tf || Math.max(8,  d / 12);
    var u_tw = sec.tw || Math.max(6,  b / 10);
    var u_t  = sec.t  || Math.max(6,  Math.min(d,b) / 10);
    var u_ts = sec.ts || Math.max(8,  b / 5);
    var u_ta = sec.ta || Math.max(6,  Math.min(d,b) / 8);

    // Drawing area — leave 28px margin all round for dimension labels
    var MG = 26;
    var sc = Math.min((W - 2*MG) / b, (H - 2*MG) / d) * 0.82;

    var cx = W / 2, cy = H / 2;
    var ph = d * sc,  pw = b * sc;   // section pixel height/width
    var pTf = u_tf * sc, pTw = u_tw * sc;
    var pT  = u_t  * sc, pTs = u_ts * sc, pTa = u_ta * sc;

    // Material-based colors — use section name as fallback when shapeId is wrong
    var isConc = _isConcrete(id, sec.name);
    var fillC, strokeC;
    if (isConc) { fillC='rgba(180,190,200,0.32)'; strokeC='#546e7a'; }
    else if (/Steel/i.test(id)) { fillC='rgba(21,101,192,0.20)'; strokeC='#1565c0'; }
    else if (/Cold/i.test(id))  { fillC='rgba(0,131,143,0.20)';  strokeC='#00838f'; }
    else if (/Precast/i.test(id)){ fillC='rgba(109,76,65,0.22)'; strokeC='#5d4037'; }
    else { fillC='rgba(100,100,100,0.18)'; strokeC='#607d8b'; }

    ctx.fillStyle = fillC; ctx.strokeStyle = strokeC;
    ctx.lineWidth = 1.8; ctx.lineJoin = 'miter'; ctx.lineCap = 'square';

    // ── Draw section outline ──────────────────────────────────────
    if (_isCircular(id, sec.name)) {
      // ── Solid circle (ConcCirc, SteelRod) or hollow (Pipe/CHS) ──
      let r = ph / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      if (!_isSolidRod(id) && sec.t && sec.t > 0 && pT < r) {
        // Hollow core for Pipe/CHS
        var ri = Math.max(r - pT, 2);
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = strokeC; ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI*2); ctx.stroke();
      }
      // Rebar for concrete circular (ring pattern)
      if (isConc) {
        ctx.fillStyle = '#e53935';
        var nBar = 8, barR = r * 0.72;
        for (var bi=0; bi<nBar; bi++) {
          var ang_ = (bi/nBar)*Math.PI*2;
          ctx.beginPath(); ctx.arc(cx+barR*Math.cos(ang_), cy+barR*Math.sin(ang_), 2.5, 0, Math.PI*2); ctx.fill();
        }
      }
    } else if (_isIBeam(id)) {
      // ── Wide Flange / I-beam / Precast I ─────────────────────────
      let tf_px = Math.max(pTf, 5), tw_px = Math.max(pTw, 3);
      _pathIBeam(ctx, cx, cy, pw, ph, tf_px, tw_px);
      ctx.fill(); ctx.stroke();
    } else if (id === 'ColdZ') {
      // ── Cold-Formed Z — antisymmetric flanges ─────────────────────
      // The path used to run the top edge and the bottom edge across the full
      // width either side of a centred web, which is a symmetric I-beam: the
      // "Z" tile drew the same picture as the "W" tile. A Z has one flange
      // reaching right off the top of the web and the other reaching left off
      // the bottom, and that is what the extruded 3D view now draws too.
      let tf_px = Math.max(pTf, 4), tw_px = Math.max(pTw, 3);
      ctx.beginPath();
      ctx.moveTo(cx-tw_px/2,cy-ph/2); ctx.lineTo(cx+pw/2,cy-ph/2);
      ctx.lineTo(cx+pw/2,cy-ph/2+tf_px); ctx.lineTo(cx+tw_px/2,cy-ph/2+tf_px);
      ctx.lineTo(cx+tw_px/2,cy+ph/2); ctx.lineTo(cx-pw/2,cy+ph/2);
      ctx.lineTo(cx-pw/2,cy+ph/2-tf_px); ctx.lineTo(cx-tw_px/2,cy+ph/2-tf_px);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (_isChannel(id)) {
      // ── C-Channel / Cold-Formed C ────────────────────────────────
      let tf_px = Math.max(pTf, 4), tw_px = Math.max(pTw, 3);
      ctx.beginPath();
      ctx.moveTo(cx-pw/2,cy-ph/2); ctx.lineTo(cx+pw/2,cy-ph/2);
      ctx.lineTo(cx+pw/2,cy-ph/2+tf_px); ctx.lineTo(cx-pw/2+tw_px,cy-ph/2+tf_px);
      ctx.lineTo(cx-pw/2+tw_px,cy+ph/2-tf_px); ctx.lineTo(cx+pw/2,cy+ph/2-tf_px);
      ctx.lineTo(cx+pw/2,cy+ph/2); ctx.lineTo(cx-pw/2,cy+ph/2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (_isDouble2L(id)) {
      // ── Steel Double Angle (2L) — two back-to-back L angles ──────
      let ta_px = Math.max(pTa, 4), gap = 3;
      // Left angle (mirror of right)
      ctx.beginPath();
      ctx.moveTo(cx-gap/2,cy-ph/2); ctx.lineTo(cx-gap/2-ta_px,cy-ph/2);
      ctx.lineTo(cx-gap/2-ta_px,cy+ph/2-ta_px); ctx.lineTo(cx-pw/2,cy+ph/2-ta_px);
      ctx.lineTo(cx-pw/2,cy+ph/2); ctx.lineTo(cx-gap/2,cy+ph/2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // Right angle
      ctx.beginPath();
      ctx.moveTo(cx+gap/2,cy-ph/2); ctx.lineTo(cx+gap/2+ta_px,cy-ph/2);
      ctx.lineTo(cx+gap/2+ta_px,cy+ph/2-ta_px); ctx.lineTo(cx+pw/2,cy+ph/2-ta_px);
      ctx.lineTo(cx+pw/2,cy+ph/2); ctx.lineTo(cx+gap/2,cy+ph/2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (_isAngle(id)) {
      // ── Single Angle / L-shape (steel or concrete) ────────────────
      let ta_px = Math.max(pTa, 4);
      ctx.beginPath();
      ctx.moveTo(cx-pw/2,cy-ph/2); ctx.lineTo(cx-pw/2+ta_px,cy-ph/2);
      ctx.lineTo(cx-pw/2+ta_px,cy+ph/2-ta_px); ctx.lineTo(cx+pw/2,cy+ph/2-ta_px);
      ctx.lineTo(cx+pw/2,cy+ph/2); ctx.lineTo(cx-pw/2,cy+ph/2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (_isTee(id)) {
      // ── T-section (Steel Tee / Concrete T-Beam) ──────────────────
      let tf_px = Math.max(pTf, 5), ts_px = Math.max(pTs, 6);
      ctx.beginPath();
      ctx.moveTo(cx-pw/2,cy-ph/2); ctx.lineTo(cx+pw/2,cy-ph/2);
      ctx.lineTo(cx+pw/2,cy-ph/2+tf_px); ctx.lineTo(cx+ts_px/2,cy-ph/2+tf_px);
      ctx.lineTo(cx+ts_px/2,cy+ph/2); ctx.lineTo(cx-ts_px/2,cy+ph/2);
      ctx.lineTo(cx-ts_px/2,cy-ph/2+tf_px); ctx.lineTo(cx-pw/2,cy-ph/2+tf_px);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (_isBox(id)) {
      // ── Hollow box (Steel RHS / Concrete Box) ────────────────────
      let t_px = Math.max(pT, 3);
      ctx.fillRect(cx-pw/2,cy-ph/2,pw,ph); ctx.strokeRect(cx-pw/2,cy-ph/2,pw,ph);
      let iw = pw - 2*t_px, ih = ph - 2*t_px;
      if (iw > 0 && ih > 0) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(cx-iw/2,cy-ih/2,iw,ih);
        ctx.strokeStyle = strokeC; ctx.strokeRect(cx-iw/2,cy-ih/2,iw,ih);
      }
    } else if (_isPlate(id)) {
      // ── Steel Plate — very flat rectangle ────────────────────────
      ctx.fillRect(cx-pw/2,cy-ph/2,pw,ph); ctx.strokeRect(cx-pw/2,cy-ph/2,pw,ph);
      // Cross-hatch to indicate it's a plate
      ctx.save(); ctx.strokeStyle = strokeC; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.3;
      for (var hx=cx-pw/2; hx<=cx+pw/2; hx+=8) { ctx.beginPath(); ctx.moveTo(hx,cy-ph/2); ctx.lineTo(hx,cy+ph/2); ctx.stroke(); }
      ctx.restore();
    } else {
      // ── Rectangle (Concrete Rect / Nonprismatic / General) ───────
      ctx.beginPath(); ctx.rect(cx-pw/2,cy-ph/2,pw,ph); ctx.fill(); ctx.stroke();
      if (isConc) _drawRebar(ctx, cx-pw/2, cy-ph/2, pw, ph, Math.max(6, ph*0.08));
    }

    // ── Centroidal axes (dashed red lines through centroid) ───────
    ctx.save();
    ctx.setLineDash([4, 3]); ctx.lineWidth = 0.9; ctx.strokeStyle = '#e53935';
    // 3-3 axis (horizontal)
    ctx.beginPath(); ctx.moveTo(cx-pw/2-10, cy); ctx.lineTo(cx+pw/2+10, cy); ctx.stroke();
    // 2-2 axis (vertical)
    ctx.beginPath(); ctx.moveTo(cx, cy-ph/2-10); ctx.lineTo(cx, cy+ph/2+10); ctx.stroke();
    ctx.setLineDash([]);
    // Centroid dot
    ctx.fillStyle='#e53935'; ctx.beginPath(); ctx.arc(cx,cy,2.5,0,Math.PI*2); ctx.fill();
    ctx.restore();

    // ── Axis labels ───────────────────────────────────────────────
    ctx.font = 'bold 8px Arial'; ctx.textAlign = 'center';
    ctx.fillStyle = '#e53935';
    ctx.fillText('3', cx + pw/2 + 14, cy + 3);
    ctx.fillText('2', cx, cy - ph/2 - 13);

    // ── Dimension annotations ─────────────────────────────────────
    ctx.strokeStyle = '#455a64'; ctx.fillStyle = '#455a64';
    ctx.lineWidth = 0.8; ctx.font = '8px Arial';

    var dStr = d >= 1000 ? (d/1000).toFixed(2)+'m' : d+'mm';
    var bStr = b >= 1000 ? (b/1000).toFixed(2)+'m' : b+'mm';

    // Depth dimension (left side, vertical)
    _dimLine(ctx, cx-pw/2-14, cy-ph/2, cx-pw/2-14, cy+ph/2, dStr, 'v');
    // Width dimension (bottom, horizontal)
    _dimLine(ctx, cx-pw/2, cy+ph/2+14, cx+pw/2, cy+ph/2+14, bStr, 'h');

    // Flange/web thickness annotations for steel I, Channel, Tee
    if ((_isIBeam(id)||_isChannel(id)||_isTee(id)) && sec.tf && sec.tw) {
      ctx.font = '7px Arial'; ctx.fillStyle = '#0277bd'; ctx.textAlign = 'left';
      ctx.fillText('tf='+sec.tf+'mm', cx+pw/2+4, cy-ph/2+Math.max(pTf, 5)/2+2);
      ctx.fillText('tw='+sec.tw+'mm', cx+pw/2+4, cy+4);
    }
    // Wall thickness for Box/Pipe
    if ((_isBox(id)||_isCircular(id)) && sec.t) {
      ctx.font = '7px Arial'; ctx.fillStyle = '#0277bd'; ctx.textAlign = 'left';
      ctx.fillText('t='+sec.t+'mm', cx+pw/2+4, cy+3);
    }
  }

  // ── Dimension line helper (arrow at both ends) ─────────────────
  function _dimLine(ctx, x1, y1, x2, y2, label, dir) {
    var AH = 3; // arrowhead size
    ctx.save();
    ctx.strokeStyle = '#455a64'; ctx.fillStyle = '#455a64';
    ctx.lineWidth = 0.8;
    // Main line
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    if (dir === 'v') {
      // Arrows top & bottom
      ctx.beginPath(); ctx.moveTo(x1-AH,y1+AH*2); ctx.lineTo(x1,y1); ctx.lineTo(x1+AH,y1+AH*2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2-AH,y2-AH*2); ctx.lineTo(x2,y2); ctx.lineTo(x2+AH,y2-AH*2); ctx.stroke();
      // Extension ticks
      ctx.beginPath(); ctx.moveTo(x1-3,y1); ctx.lineTo(x1+3,y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2-3,y2); ctx.lineTo(x2+3,y2); ctx.stroke();
      // Label
      ctx.save(); ctx.translate(x1-1,(y1+y2)/2); ctx.rotate(-Math.PI/2);
      ctx.textAlign='center'; ctx.font='8px Arial';
      ctx.fillText(label, 0, -2);
      ctx.restore();
    } else {
      // Arrows left & right
      ctx.beginPath(); ctx.moveTo(x1+AH*2,y1-AH); ctx.lineTo(x1,y1); ctx.lineTo(x1+AH*2,y1+AH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2-AH*2,y2-AH); ctx.lineTo(x2,y2); ctx.lineTo(x2-AH*2,y2+AH); ctx.stroke();
      // Extension ticks
      ctx.beginPath(); ctx.moveTo(x1,y1-3); ctx.lineTo(x1,y1+3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2,y2-3); ctx.lineTo(x2,y2+3); ctx.stroke();
      // Label
      ctx.textAlign='center'; ctx.font='8px Arial';
      ctx.fillText(label, (x1+x2)/2, y1+10);
    }
    ctx.restore();
  }

  function _pathIBeam(ctx,cx,cy,pw,ph,tf,tw){
    ctx.beginPath();
    ctx.moveTo(cx-pw/2,cy-ph/2);ctx.lineTo(cx+pw/2,cy-ph/2);
    ctx.lineTo(cx+pw/2,cy-ph/2+tf);ctx.lineTo(cx+tw/2,cy-ph/2+tf);
    ctx.lineTo(cx+tw/2,cy+ph/2-tf);ctx.lineTo(cx+pw/2,cy+ph/2-tf);
    ctx.lineTo(cx+pw/2,cy+ph/2);ctx.lineTo(cx-pw/2,cy+ph/2);
    ctx.lineTo(cx-pw/2,cy+ph/2-tf);ctx.lineTo(cx-tw/2,cy+ph/2-tf);
    ctx.lineTo(cx-tw/2,cy-ph/2+tf);ctx.lineTo(cx-pw/2,cy-ph/2+tf);
    ctx.closePath();
  }

  function _drawRebar(ctx,x,y,pw,ph,cov) {
    var saved = ctx.fillStyle;
    ctx.fillStyle='#e53935';
    var rows=3, cols=3;
    for(var ri=0;ri<rows;ri++){ for(var ci=0;ci<cols;ci++){
      let px = x+cov+(ci*(pw-2*cov)/(cols-1));
      let py = y+cov+(ri*(ph-2*cov)/(rows-1));
      ctx.beginPath(); ctx.arc(px,py,2.5,0,Math.PI*2); ctx.fill();
    }}
    ctx.fillStyle = saved;
  }

  // ── Modifiers dialog ───────────────────────────────────────────
  function openModifiers() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    var m=sec.mods||ACI_MODS.Default;
    function sv(id,v){ var e=document.getElementById(id); if(e)e.value=v; }
    sv('mod-A',m.A);sv('mod-AS2',m.AS2);sv('mod-AS3',m.AS3);
    sv('mod-J',m.J);sv('mod-I33',m.I33);sv('mod-I22',m.I22);
    sv('mod-mass',m.mass);sv('mod-wt',m.weight);
    document.getElementById('modal-frame-modifiers').classList.add('open');
  }

  function applyACIMods(type) {
    var m=ACI_MODS[type]||ACI_MODS.Default;
    function sv(id,v){ var e=document.getElementById(id); if(e)e.value=v; }
    sv('mod-A',m.A);sv('mod-AS2',m.AS2);sv('mod-AS3',m.AS3);
    sv('mod-J',m.J);sv('mod-I33',m.I33);sv('mod-I22',m.I22);
    sv('mod-mass',m.mass);sv('mod-wt',m.weight);
  }

  function saveModifiers() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    function gn(id){ var e=document.getElementById(id); return e?parseFloat(e.value)||1:1; }
    sec.mods={A:gn('mod-A'),AS2:gn('mod-AS2'),AS3:gn('mod-AS3'),
              J:gn('mod-J'),I33:gn('mod-I33'),I22:gn('mod-I22'),
              mass:gn('mod-mass'),weight:gn('mod-wt')};
    _updateModLabel(sec);
    document.getElementById('modal-frame-modifiers').classList.remove('open');
    var SA=window.SA; SA&&SA.toast&&SA.toast('Modifiers saved','ok');
  }

  function resetModifiers() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    sec.mods=Object.assign({},ACI_MODS.Default); applyACIMods('Default');
  }

  // ── Rebar dialog ───────────────────────────────────────────────
  function openRebar() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    var r=sec.rebar||_defaultRebar();
    function sv(id,v){ var e=document.getElementById(id); if(e)e.value=v; }
    var mats=window.MAT_UI?MAT_UI.getMaterials().filter(function(m){return m.type==='Rebar';}):[];
    ['rb-long-mat','rb-conf-mat'].forEach(function(id){
      let el=document.getElementById(id); if(!el)return;
      el.innerHTML=mats.map(function(m){return '<option value="'+m.name+'">'+m.name+'</option>';}).join('');
      el.value=r.longMat||'A615Gr60';
    });
    var dtEl=document.getElementById('rb-'+r.designType); if(dtEl)dtEl.checked=true;
    var cfEl=document.getElementById('rb-'+r.config);     if(cfEl)cfEl.checked=true;
    var ctEl=document.getElementById('rb-'+r.confineType);if(ctEl)ctEl.checked=true;
    var cdEl=document.getElementById('rb-'+r.checkDesign);if(cdEl)cdEl.checked=true;
    sv('rb-cover',r.cover);sv('rb-bars3',r.barsAlong3);sv('rb-bars2',r.barsAlong2);
    sv('rb-bar-size',r.barSize);sv('rb-bar-area',r.barArea);
    sv('rb-corner-size',r.cornerBarSize);sv('rb-corner-area',r.cornerBarArea);
    sv('rb-conf-size',r.confBarSize);sv('rb-conf-area',r.confBarArea);
    sv('rb-conf-sp',r.confSpacing);sv('rb-conf-3',r.confBars3);sv('rb-conf-2',r.confBars2);
    document.getElementById('modal-frame-rebar').classList.add('open');
  }

  function saveRebar() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    function gv(id){ var e=document.getElementById(id); return e?e.value:null; }
    function gr(name){ var els=document.querySelectorAll('input[name="'+name+'"]'); for(var i=0;i<els.length;i++)if(els[i].checked)return els[i].value; return null; }
    sec.rebar={
      designType:gr('rb-design')||'column', config:gr('rb-config')||'rectangular',
      confineType:gr('rb-confine')||'ties', checkDesign:gr('rb-check')||'design',
      longMat:gv('rb-long-mat')||'A615Gr60', confMat:gv('rb-conf-mat')||'A615Gr60',
      cover:parseFloat(gv('rb-cover'))||40, barsAlong3:parseInt(gv('rb-bars3'))||3, barsAlong2:parseInt(gv('rb-bars2'))||5,
      barSize:gv('rb-bar-size')||'#9', barArea:parseFloat(gv('rb-bar-area'))||645,
      cornerBarSize:gv('rb-corner-size')||'#9', cornerBarArea:parseFloat(gv('rb-corner-area'))||645,
      confBarSize:gv('rb-conf-size')||'#4', confBarArea:parseFloat(gv('rb-conf-area'))||129,
      confSpacing:parseFloat(gv('rb-conf-sp'))||150, confBars3:parseInt(gv('rb-conf-3'))||3, confBars2:parseInt(gv('rb-conf-2'))||3
    };
    document.getElementById('modal-frame-rebar').classList.remove('open');
    var SA=window.SA; SA&&SA.toast&&SA.toast('Reinforcement data saved','ok');
  }

  // ── Show Section Properties ────────────────────────────────────
  function showProps() {
    var sec=_secs().find(function(s){return s.id===_editId;}); if(!sec)return;
    _compute(sec); var p=sec.props||{};
    var mat=window.MAT_UI?MAT_UI.getMaterialById(sec.materialId):null;
    var E=mat?mat.E:(sec.E||25);
    var rows=[
      ['Area, A', p.A, 'cm²'],['Shear Area 2 (AS2)',(+(p.A*0.833).toFixed(1)),'cm²'],
      ['Shear Area 3 (AS3)',(+(p.A*0.833).toFixed(1)),'cm²'],
      ['I33 (Major)', p.I33,'cm⁴'],['I22 (Minor)', p.I22,'cm⁴'],
      ['J (Torsional)', p.J,'cm⁴'],['S33+', p.S33,'cm³'],['S33-', p.S33,'cm³'],
      ['S22+', p.S22,'cm³'],['S22-', p.S22,'cm³'],
      ['R33', p.R33,'cm'],['R22', p.R22,'cm'],
      ['Depth (d)', sec.d,'mm'],['Width (b)', sec.b,'mm'],['E', E,'GPa']
    ];
    var tbl=document.getElementById('fsd-props-table'); if(!tbl)return;
    tbl.innerHTML=rows.map(function(r){
      return '<tr><td style="padding:3px 8px;border-bottom:1px solid var(--border);font-size:11px">'+r[0]+'</td>'+
             '<td style="padding:3px 8px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;text-align:right">'+r[1]+'</td>'+
             '<td style="padding:3px 8px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-sec)">'+r[2]+'</td></tr>';
    }).join('');
    document.getElementById('modal-frame-show-props').classList.add('open');
  }

  /**
   * Flatten a section's computed shape properties into the fields the solver,
   * the design checks and the explorer table read.
   *
   * This used to be _syncToSA(): a separate pass over a separate array that
   * matched by name and ran on dialog close and 1.5 s after page load. It is
   * part of _compute() now, so the definition and the numbers derived from it
   * are written in the same step to the same object and cannot disagree.
   *
   * _compute() works out the FULL property set — A, I33, I22, J, S33, S22,
   * R33, R22 — and all of it is handed over. When only A and I33 were,
   * solveFrame3D took Iy = Ix (weak axis as stiff as the strong one) and
   * J = 0.01 cm⁴, while checks.js substituted Iy = 1000 cm⁴, Zx = 1000 cm³ and
   * radii of gyration of 5 cm and 2 cm. For a 300×600 rectangle the EC3 check
   * ran on Iy = 1000 against a true 135 000 and Zx = 1000 against 27 000,
   * giving χz = 0.011 and a capacity roughly two orders out.
   *
   * Naming follows SectionDB: rx is the strong-axis radius, ry the weak.
   */
  function _flatten(sec) {
    var p = sec.props || {};
    var MU  = window.MAT_UI;
    var mat = MU && sec.materialId != null ? MU.getMaterialById(sec.materialId) : null;
    if (mat) {
      sec.E   = mat.E;
      sec.fy  = mat.fy || mat.fc || sec.fy || 420;
      sec.rho = mat.weight;
      if (mat.nu > 0) sec.nu = mat.nu;   // 3D torsional stiffness, G = E/2(1+nu)
    }
    var derived = {
      A  : p.A   != null ? p.A   : sec.A,
      I  : p.I33 != null ? p.I33 : sec.I,
      Ix : p.I33 != null ? p.I33 : sec.Ix,
      Iy : p.I22, J : p.J, Sx : p.S33, Sy : p.S22, rx : p.R33, ry : p.R22,
      d  : sec.d, bf : sec.b
    };
    // Leave a consumer's own fallback in place for anything _compute did not
    // supply, rather than writing an explicit undefined over it.
    Object.keys(derived).forEach(function(k){
      if (derived[k] !== undefined && derived[k] !== null) sec[k] = derived[k];
    });
  }

  // ── Init ───────────────────────────────────────────────────────
  // app.js calls init() at the end of App.init(), once the session has been
  // restored and the material library exists. Nothing runs on a timer any
  // more: the old `setTimeout(_syncToSA, 1500)` is what overwrote a freshly
  // loaded project's section properties a second and a half after it opened.

  return { init:function(){ _init(); _refreshModel(); },
           openList,closeList,select,filterType,filterText,addNew,addCopy,deleteSec,
           openData,saveData,onInputChange,openShapePicker,selectShape,
           openModifiers,saveModifiers,applyACIMods,resetModifiers,
           openRebar,saveRebar,showProps,
           getSections:function(){return _secs();},
           // Recompute every parametric section — used after a material change.
           recomputeAll:function(){ _secs().forEach(function(s){ if(s.shapeId) _compute(s); }); },
           // Repaint after the model is swapped under us (undo, project import).
           refresh:function(){
             if (document.getElementById('modal-frame-properties')?.classList.contains('open')) {
               _init(); _renderList();
             }
           } };
})();
