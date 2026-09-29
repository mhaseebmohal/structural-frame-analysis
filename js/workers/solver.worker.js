// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — FEM Solver Web Worker
//
//  Runs the stiffness-matrix solver off the main thread so the UI
//  never freezes during large-model or iterative (P-Δ, modes) jobs.
//
//  Message protocol (postMessage from main thread):
//    { type: 'solve',   model: { nodes, beams, sections, loads, settlements, use3D } }
//    { type: 'pdelta',  model: { nodes, beams, sections, loads, settlements },
//                       options: { maxIter, tol } }
//    { type: 'modes',   model: { nodes, beams, sections },
//                       options: { numModes } }
//
//  Response (postMessage back to main thread):
//    { type: 'solve_result',  results: <SolverResult> }
//    { type: 'pdelta_result', results: <SolverResult>, iterations: N }
//    { type: 'modes_result',  results: <ModesResult> }
//    { type: 'progress',      pct: 0-100, label: '...' }
//    { type: 'error',         error: '...', stack: '...' }
//
//  Usage in main thread:
//    const worker = new Worker('js/workers/solver.worker.js');
//    worker.onmessage = e => handleWorkerResult(e.data);
//    worker.postMessage({ type: 'solve', model: { nodes, beams, sections, loads, settlements } });
// ──────────────────────────────────────────────────────────────────

// Load solver scripts relative to this worker's location
// (adjust paths if worker location changes)
try {
  importScripts(
    '../solver.js',
    '../solver3d.js',
    '../analysis/pdelta.js',
    '../analysis/modes.js'
  );
} catch (e) {
  // Report missing scripts but continue — worker may still handle some types
  console.warn('[solver.worker] importScripts failed:', e.message);
}

self.onmessage = function(event) {
  const { type, model, options = {}, reqId } = event.data;

  try {
    switch (type) {

      // ── Linear static solve ─────────────────────────────────────
      case 'solve': {
        const { nodes, beams, sections, loads, settlements, use3D } = model;
        self.postMessage({ type: 'progress', pct: 10, label: 'Assembling stiffness matrix…', reqId });

        let results;
        if (use3D && typeof solveFrame3D === 'function') {
          results = solveFrame3D(nodes, beams, sections, loads, settlements);
        } else if (typeof solveFrame === 'function') {
          results = solveFrame(nodes, beams, sections, loads, settlements);
        } else {
          throw new Error('Solver not loaded — check importScripts paths.');
        }

        self.postMessage({ type: 'progress', pct: 100, label: 'Done.', reqId });
        self.postMessage({ type: 'solve_result', results, reqId });
        break;
      }

      // ── Linear static solve, every load case in one round trip ──
      // The UI solves all cases together; batching them here keeps the model
      // serialisation to a single copy instead of one per case.
      case 'solve_all': {
        const { nodes, beams, sections, settlements, cases, use3D } = model;
        const byCase = {};
        const errors = [];
        const n = (cases && cases.length) || 0;

        for (let i = 0; i < n; i++) {
          const c = cases[i];
          self.postMessage({
            type: 'progress',
            pct: Math.round((i / n) * 95) + 3,
            label: `Solving "${c.name || c.id}" (${i + 1}/${n})…`,
            reqId
          });

          let res;
          if (use3D && typeof solveFrame3D === 'function') {
            res = solveFrame3D(nodes, beams, sections, c.loads, settlements);
          } else if (typeof solveFrame === 'function') {
            res = solveFrame(nodes, beams, sections, c.loads, settlements);
          } else {
            throw new Error('Solver not loaded — check importScripts paths.');
          }

          if (res && res.success) byCase[c.id] = res;
          else errors.push(`"${c.name || c.id}": ${res && res.error}`);
        }

        self.postMessage({ type: 'progress', pct: 100, label: 'Done.', reqId });
        self.postMessage({ type: 'solve_all_result', results: { byCase, errors }, reqId });
        break;
      }

      // ── P-Delta iterative solve ──────────────────────────────────
      case 'pdelta': {
        const { nodes, beams, sections, loads, settlements } = model;
        const maxIter = options.maxIter || 20;
        const tol     = options.tol     || 0.001;

        self.postMessage({ type: 'progress', pct: 5, label: 'P-Δ: starting iterations…', reqId });

        let results;
        if (typeof PDeltaAnalysis !== 'undefined' && typeof PDeltaAnalysis.runPDelta === 'function') {
          // pdelta.js exposes runPDelta(nodes, beams, sections, loads, settlements, options)
          results = PDeltaAnalysis.runPDelta(nodes, beams, sections, loads, settlements,
                                             { maxIter, tolerance: tol });
        } else {
          // Fallback: run a plain linear solve
          results = solveFrame(nodes, beams, sections, loads, settlements);
          results._fallback = true;
        }

        self.postMessage({ type: 'progress', pct: 100, label: 'P-Δ complete.', reqId });
        self.postMessage({ type: 'pdelta_result', results, reqId });
        break;
      }

      // ── Natural frequencies & mode shapes ────────────────────────
      case 'modes': {
        const { nodes, beams, sections } = model;
        const numModes = options.numModes || 6;

        self.postMessage({ type: 'progress', pct: 5, label: 'Building mass matrix…', reqId });

        let results;
        if (typeof ModeShapeAnalysis !== 'undefined' &&
            typeof ModeShapeAnalysis.computeModes === 'function') {
          results = ModeShapeAnalysis.computeModes(nodes, beams, sections, numModes);
        } else {
          throw new Error('Mode-shape solver not loaded.');
        }

        self.postMessage({ type: 'progress', pct: 100, label: 'Mode shapes done.', reqId });
        self.postMessage({ type: 'modes_result', results, reqId });
        break;
      }

      default:
        throw new Error(`Unknown worker message type: "${type}"`);
    }

  } catch (err) {
    self.postMessage({ type: 'error', error: err.message, stack: err.stack, reqId });
  }
};
