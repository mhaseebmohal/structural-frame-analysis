// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — Performance Monitor
//  Wraps performance.now() timers around the solve pipeline so
//  engineers can see how long each analysis step takes.
//  Usage: PerfMonitor.start('solve'); ... PerfMonitor.end('solve');
// ──────────────────────────────────────────────────────────────────
'use strict';

window.PerfMonitor = (() => {
  const _timers = {};
  const _log    = [];   // rolling last-100 entries
  const MAX_LOG = 100;

  /** Start a named timer. */
  function start(label) {
    _timers[label] = performance.now();
  }

  /**
   * Stop a named timer. Returns elapsed ms.
   * Automatically shows a toast-style overlay if elapsed > warnMs.
   */
  function end(label, warnMs = 500) {
    if (!_timers[label]) return 0;
    const elapsed = performance.now() - _timers[label];
    delete _timers[label];
    _log.push({ label, elapsed, ts: Date.now() });
    if (_log.length > MAX_LOG) _log.shift();
    _showOverlay(label, elapsed, elapsed > warnMs);
    return elapsed;
  }

  /** Return last N log entries as plain objects. */
  function getLog(n = 20) {
    return _log.slice(-n).map(e => ({
      label:   e.label,
      ms:      +e.elapsed.toFixed(2),
      at:      new Date(e.ts).toLocaleTimeString()
    }));
  }

  /** Console-formatted report of the last 20 timings. */
  function report() {
    return getLog(20).map(e => `${e.label}: ${e.ms}ms  [${e.at}]`).join('\n');
  }

  // ── Internal overlay element ───────────────────────────────────────
  let _overlayEl = null;
  let _hideTimer = null;

  function _showOverlay(label, elapsed, warn) {
    if (!_overlayEl) {
      _overlayEl = document.createElement('div');
      _overlayEl.id = 'perf-overlay';
      document.body.appendChild(_overlayEl);
    }
    _overlayEl.className = warn ? 'perf-overlay warn' : 'perf-overlay';
    _overlayEl.textContent = `⏱ ${label}: ${elapsed.toFixed(0)} ms`;
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => { if (_overlayEl) _overlayEl.textContent = ''; }, 3500);
  }

  return { start, end, getLog, report };
})();
