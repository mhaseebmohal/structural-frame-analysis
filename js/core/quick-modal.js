/* ══════════════════════════════════════════════════════════════════════
   quick-modal.js — Promise-based confirm()/prompt() replacements built on
   the app's own #modal-quick-prompt (index.html) instead of the browser's
   native dialogs.

   Native confirm()/prompt() cannot be styled, are not consistent with the
   rest of the UI, and — the specific bug this exists to fix — skip the
   focus trap, role="dialog" and close button dialog-ux.js gives every other
   .modal-overlay. Section-library Add/Copy/Delete were the one place in the
   app that still used them.

   window.QuickModal.confirm(message, title?) -> Promise<boolean>
   window.QuickModal.prompt(message, defaultValue?, title?) -> Promise<string|null>

   Load AFTER dialog-ux.js, so #modal-quick-prompt is already retrofitted by
   the time a caller can reach here.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ov, titleEl, bodyEl, inputRow, inputEl, okBtn, cancelBtn;
  var _resolve   = null;
  var _isPrompt  = false;
  var _wired     = false;

  function ensure() {
    if (_wired) return !!ov;
    ov = document.getElementById('modal-quick-prompt');
    if (!ov) return false;
    _wired    = true;
    titleEl   = document.getElementById('qp-title');
    bodyEl    = document.getElementById('qp-body');
    inputRow  = document.getElementById('qp-input-row');
    inputEl   = document.getElementById('qp-input');
    okBtn     = document.getElementById('qp-ok');
    cancelBtn = document.getElementById('qp-cancel');

    okBtn.addEventListener('click', function () { finish(_isPrompt ? inputEl.value : true); });
    cancelBtn.addEventListener('click', function () { finish(_isPrompt ? null : false); });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(inputEl.value); }
    });

    // Escape, the backdrop, or the ✕ dialog-ux.js injects all just remove
    // .open directly — none of them know about a pending promise here, so
    // without this a caller doing `await QuickModal.confirm(...)` would hang
    // forever the moment the user dismissed the dialog any way other than
    // clicking these two buttons.
    new MutationObserver(function () {
      if (!ov.classList.contains('open') && _resolve) {
        var r = _resolve; _resolve = null;
        r(_isPrompt ? null : false);
      }
    }).observe(ov, { attributes: true, attributeFilter: ['class'] });

    return true;
  }

  function finish(value) {
    ov.classList.remove('open');
    var r = _resolve;
    _resolve = null;
    if (r) r(value);
  }

  function open(title, message, isPrompt, defaultValue) {
    if (!ensure()) {
      // #modal-quick-prompt missing (should not happen outside a stripped-down
      // test harness) — fail closed rather than leave the caller hanging.
      return Promise.resolve(isPrompt ? null : false);
    }
    titleEl.textContent = title;
    bodyEl.textContent  = message;
    _isPrompt = !!isPrompt;
    inputRow.style.display = _isPrompt ? '' : 'none';
    if (_isPrompt) inputEl.value = defaultValue || '';
    ov.classList.add('open');
    return new Promise(function (resolve) { _resolve = resolve; });
  }

  window.QuickModal = {
    confirm: function (message, title) {
      return open(title || 'Confirm', message, false);
    },
    prompt: function (message, defaultValue, title) {
      return open(title || 'Input needed', message, true, defaultValue);
    }
  };
})();
