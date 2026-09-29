// ESLint flat config — plain browser scripts loaded via <script> tags in
// index.html (no bundler, no modules). Cross-file communication happens
// through the globals listed below, so they are declared here to keep
// no-undef meaningful rather than noisy.
'use strict';

// Globals published by one file and consumed by others.
const projectGlobals = [
  'ACIDesign', 'ACI_Ch1', 'ACI_Ch3', 'ACI_Ch4', 'ACI_Ch5', 'ACI_Ch6',
  'ASCE7_Ch1', 'ASCE7_Ch2', 'ASCE7_Ch3',
  'App', 'AppEdit', 'AppGenerators', 'BeamFormulas', 'CompoundSection',
  'DEFL_INSP', 'DesignChecks', 'EXTRUDE', 'FRAME_SEC', 'FileIO',
  'FormulaLibrary', 'FoundationDesign', 'LoadCombosGenerator',
  'ModeShapeAnalysis', 'MohrsCircle', 'NaturalFreq', 'PDeltaAnalysis',
  'PMInteraction', 'PerfMonitor', 'PropertyModifiers', 'RCDesign',
  'ReportGenerator', 'ResponseSpectrum', 'SA', 'SectionDB', 'SectionProps',
  'StructDB',
  'UnitSystem', 'VIEW3D_RIB',
  // fefLocal2D is published by solver.js and consumed by pdelta.js so the
  // load vector and the reported end forces share one set of formulas.
  // rigidZoneLength is published the same way and consumed by pdelta.js and
  // modes.js, so all three analysis paths assemble the same stiffness.
  'drawExtrudedBeams', 'solveFrame', 'solveFrame3D', 'fefLocal2D', 'spanDeflLocal2D', 'hermiteLocal2D', 'maxDeflLocal2D',
  'rigidZoneLength',
  // Resolves a member's stiffness modifier, falling back to its section's.
  'stiffMod',
  // applyEndReleases / releasedDofs* are published by solver.js and consumed by
  // solver3d.js, pdelta.js and modes.js so every path condenses the same way.
  'applyEndReleases', 'releasedDofs2D', 'releasedDofs3D',
  // The 3D element builders live in solver3d.js and are consumed by the 3D
  // modal analysis in modes.js, so the mass matrix and the stiffness matrix
  // are built on one set of axes and one sign convention.
  'buildKlocal3D', 'buildDCM3D', 'buildT3D', 'mmul3D', 'mT3D',
  // Defined by inline <script> blocks in index.html
  'GRIDSYS', 'WORKPLANE', 'WIZ', 'MAT_UI',
  'XLSX',   // SheetJS, loaded from CDN
];

const browserGlobals = [
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'console', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange',
  'fetch', 'Blob', 'File', 'FileReader', 'URL', 'FormData', 'Image',
  'Worker', 'performance', 'getComputedStyle', 'matchMedia',
  'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser',
  'XMLSerializer', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AudioContext', 'webkitAudioContext', 'ResizeObserver', 'MutationObserver',
  'HTMLElement', 'SVGElement', 'Node', 'btoa', 'atob', 'structuredClone',
  'CSS',   // CSS.escape, used to build safe attribute selectors
];

const toReadonly = (names) =>
  Object.fromEntries(names.map((n) => [n, 'readonly']));

module.exports = [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...toReadonly(browserGlobals),
        ...toReadonly(projectGlobals),
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // Correctness — these catch real defects.
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-compare-neg-zero': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-fallthrough': 'error',
      'no-const-assign': 'error',
      'no-class-assign': 'error',
      'no-import-assign': 'error',
      'no-setter-return': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-optional-chaining': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'warn',

      // Hygiene — surfaced as warnings so they never block the build.

      // The drawing/property code declares `var` once per branch of a long
      // else-if chain. Function-scoped and always assigned before use, so this
      // is style, not a defect. builtinGlobals off: several files legitimately
      // declare the cross-file globals listed above.
      'no-redeclare': ['warn', { builtinGlobals: false }],
      // app.js deliberately wraps solve() to route through P-Δ when enabled.
      'no-func-assign': 'warn',

      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // solver.js publishes solveFrame as a top-level function declaration, which
    // becomes a global that app.js, pdelta.js and the worker all call. ESLint
    // sees only this file, so the declaration looks unused.
    files: ['js/solver.js'],
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^(_|solveFrame$|fefLocal2D$|spanDeflLocal2D$|hermiteLocal2D$|maxDeflLocal2D$|rigidZoneLength$|applyEndReleases$|releasedDofs2D$|releasedDofs3D$)' }],
    },
  },
  {
    // Web Worker — no DOM, its own global surface.
    files: ['js/workers/*.js'],
    languageOptions: {
      globals: {
        ...toReadonly(['self', 'postMessage', 'importScripts', 'console',
                       'performance', 'setTimeout', 'clearTimeout']),
        ...toReadonly(projectGlobals),
      },
    },
  },
];
