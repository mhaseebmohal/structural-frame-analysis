// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — IndexedDB Manager (StructDB)
//
//  Two object stores:
//    sections      — full section library with material index + fast name search
//    results_cache — hash → solved results so unchanged models skip re-solving
//
//  There was a third, `projects`, with saveProject / loadProject /
//  listProjects / deleteProject. Nothing ever called any of them: projects are
//  saved to localStorage under `sa_file_*` by saveFile() in app.js, and the
//  Saved Files dialog reads them from there. The store was created on every
//  install and stayed empty on all of them. Version 2 removes it.
//
//  All methods return Promises. Callers must await or .then().
// ──────────────────────────────────────────────────────────────────
'use strict';

window.StructDB = (() => {
  const DB_NAME    = 'StructuralAnalyser';
  const DB_VERSION = 2;
  let _db = null;

  // ── Open / upgrade ────────────────────────────────────────────────
  function open() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db = e.target.result;

        // sections: key = auto-increment id, indexes on material + nameSearch
        if (!db.objectStoreNames.contains('sections')) {
          const ss = db.createObjectStore('sections', { keyPath: 'id', autoIncrement: true });
          ss.createIndex('material',   'material',   { unique: false });
          ss.createIndex('nameSearch', 'nameSearch', { unique: false });
          ss.createIndex('name',       'name',       { unique: false });
        }

        // results_cache: key = model fingerprint hash
        if (!db.objectStoreNames.contains('results_cache')) {
          db.createObjectStore('results_cache', { keyPath: 'hash' });
        }

        // v1 created a `projects` store that nothing ever wrote to. Dropping
        // the createObjectStore call alone would leave it behind in every
        // browser that has already opened this app, so it is deleted here.
        // Guarded, because a fresh install never had one.
        if (db.objectStoreNames.contains('projects')) {
          db.deleteObjectStore('projects');
        }
      };

      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Helper: run a transaction and collect all results ─────────────
  function _getAll(storeName, mode = 'readonly') {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(storeName, mode).objectStore(storeName).getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function _put(storeName, value) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    }));
  }

  // ── Sections ─────────────────────────────────────────────────────

  /**
   * Replace the entire sections store with sectionsArray.
   * Call after importing from Excel/CSV so subsequent lookups are fast.
   */
  async function saveSections(sectionsArray) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('sections', 'readwrite');
      const store = tx.objectStore('sections');
      store.clear();
      for (const sec of sectionsArray) {
        store.put({
          ...sec,
          material:   _guessMaterial(sec),
          nameSearch: (sec.name || '').toLowerCase()
        });
      }
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  /** Return all sections, optionally filtered by material and/or name substring. */
  async function searchSections(query = '', material = 'all') {
    const all = await _getAll('sections');
    let res = all;
    if (material && material !== 'all') {
      res = res.filter(s => s.material === material);
    }
    if (query) {
      const q = query.toLowerCase();
      res = res.filter(s => (s.nameSearch || '').includes(q));
    }
    return res;
  }

  /** Return all sections (no filter). */
  function getAllSections() {
    return _getAll('sections');
  }

  /** Return one section by its DB id. */
  function getSectionById(id) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('sections', 'readonly').objectStore('sections').get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  // ── Results cache ─────────────────────────────────────────────────

  /**
   * Retrieve cached analysis results for a given model hash.
   * Returns null on cache miss.
   */
  function getCachedResults(hash) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction('results_cache', 'readonly').objectStore('results_cache').get(hash);
      req.onsuccess = e => resolve(e.target.result ? e.target.result.results : null);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  /** Store solved results against model hash for future retrieval. */
  function cacheResults(hash, results) {
    return _put('results_cache', { hash, results, cachedAt: Date.now() });
  }

  /** Clear the entire results cache (e.g. after a major model edit). */
  function clearResultsCache() {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('results_cache', 'readwrite');
      tx.objectStore('results_cache').clear();
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    }));
  }

  // ── Model fingerprinting ──────────────────────────────────────────

  /**
   * Compute a fast hash of the model geometry + loads.
   * Used as the cache key — only the parts that affect analysis results.
   *
   * Every input the solvers read must appear here, or an edit to it will hit a
   * stale cache entry and silently return the previous model's results. The
   * original fingerprint covered only E/A/I and support type, so changing a
   * stiffness modifier, a spring constant, a custom 3D support mask, or any of
   * the 3D section properties (Ix/Iy/J) produced an identical hash.
   */
  function modelHash(nodes, beams, sections, loads, settlements) {
    const fingerprint = JSON.stringify({
      nodes: nodes.map(n => ({
        id:n.id, x:n.x, y:n.y, z:n.z||0, sup:n.support,
        // Spring supports contribute stiffness directly to K.
        kx:n.springKx||0, ky:n.springKy||0, km:n.springKm||0,
        // Custom 3D support mask (solver3d.js reads node.fixedDOF).
        fx:n.fixedDOF || null
      })),
      beams: beams.map(b => ({
        id:b.id, n1:b.node1, n2:b.node2, sec:b.sectionId,
        hS:b.hingeStart, hE:b.hingeEnd,
        // ETABS-style stiffness modifiers scale EA and EI per member.
        mods:b.modifiers || null
      })),
      sections: sections.map(s => ({
        id:s.id, E:s.E, A:s.A, I:s.I,
        // 3D solver reads Ix/Iy/J; the 2D solver prefers Ix over I.
        Ix:s.Ix, Iy:s.Iy, J:s.J, rho:s.rho,
        // Rigid end zones shorten the effective member length.
        rz:s.rigidZone || false, d:s.d,
        // Section-level stiffness modifiers (Define ▸ Sections ▸ Modifiers).
        // Members carried theirs in the fingerprint above but sections did
        // not, so applying ACI cracked-section factors and pressing Solve
        // returned the uncracked results straight back out of the cache.
        mods:s.mods || null,
        // Poisson's ratio drives G in the 3D solver, so it changes the answer.
        nu:s.nu ?? null
      })),
      loads,
      settlements: (settlements || [])
    });
    let h = 0x811c9dc5;  // FNV-1a 32-bit
    for (let i = 0; i < fingerprint.length; i++) {
      h ^= fingerprint.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // ── Internal helpers ──────────────────────────────────────────────

  function _guessMaterial(sec) {
    const name = (sec.name || '').toLowerCase();
    if (sec.E >= 180 || /steel|w\d|ipe|hea|heb|uc|ub|chs|rhs/.test(name)) return 'steel';
    if (/timber|wood|glulam|lvl/.test(name)) return 'timber';
    if (/alum/.test(name)) return 'aluminium';
    return 'concrete';  // default
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    open,
    // Sections
    saveSections, searchSections, getAllSections, getSectionById,
    // Results cache
    getCachedResults, cacheResults, clearResultsCache, modelHash
  };
})();
