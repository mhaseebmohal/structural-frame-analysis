/* ══════════════════════════════════════════════════════════════════════
   dialog-ux.js — shared behaviour for the 60 .modal-overlay dialogs.

   index.html declares each dialog as
       <div class="modal-overlay" id="modal-x">
         <div class="modal-box"><div class="modal-title">Title</div> … </div>
       </div>
   and app.js opens and closes them by toggling the .open class. None of them
   carried a close button, a dialog role, or any focus handling, so:

     · dismissing meant finding Cancel in the footer, pressing Esc, or
       clicking the backdrop — nothing in the title bar said "closeable";
     · a screen reader announced the dialog as an anonymous <div>;
     · focus stayed on whatever opened the dialog, so Tab walked the ribbon
       behind it and Enter fired a button the user could not see.

   This module retrofits all three onto every dialog from the outside, without
   touching the 60 markup blocks. Closing via the ✕ does exactly what Escape
   does in app.js's closeTopModal() — drop .open and clear any inline display —
   so the two dismissal paths cannot diverge.

   Load AFTER app.js. Exposes window.DialogUX.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), ' +
                  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // What opened the dialog, so focus can go back there when it closes.
  var returnFocusTo = null;

  function isOpen(ov) {
    return getComputedStyle(ov).display !== 'none';
  }

  // Top-most open dialog, matching app.js's own z-index ordering. The shape
  // picker opens from inside Frame Properties and sits at z-index 2200.
  function topOpen() {
    var open = [].slice.call(document.querySelectorAll('.modal-overlay')).filter(isOpen);
    if (!open.length) return null;
    open.sort(function (a, b) {
      return (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0);
    });
    return open[open.length - 1];
  }

  function focusablesIn(ov) {
    return [].slice.call(ov.querySelectorAll(FOCUSABLE)).filter(function (el) {
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function close(ov) {
    ov.classList.remove('open');
    if (ov.style.display) ov.style.display = '';   // same as app.js closeTopModal()
  }

  // ── One-time markup retrofit ────────────────────────────────────────
  function prepare(ov) {
    if (ov.dataset.dialogUx) return;
    ov.dataset.dialogUx = '1';

    var box   = ov.querySelector('.modal-box') || ov.firstElementChild;
    var title = ov.querySelector('.modal-title');

    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');

    if (title) {
      // The title is a bare text node; .modal-title is now a flex row, so wrap
      // it to keep it as one item next to the close button.
      if (!title.querySelector('.modal-title-text')) {
        var span = document.createElement('span');
        span.className = 'modal-title-text';
        while (title.firstChild) span.appendChild(title.firstChild);
        title.appendChild(span);
        if (!span.id) span.id = (ov.id || 'dlg') + '-title';
        ov.setAttribute('aria-labelledby', span.id);
      }
      if (!title.querySelector('.modal-x')) {
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'modal-x';
        x.innerHTML = '&#10005;';
        // Named, because a bare glyph tells a screen reader nothing about
        // which of the stacked dialogs it would close. Titles open with a
        // decorative glyph — "▌ Retaining Wall Design", "📐 Frame Properties" —
        // which a screen reader would spell out in the middle of the name.
        var name = (title.textContent || 'dialog').replace(/^[^A-Za-z0-9]+/, '').trim() || 'dialog';
        var label = 'Close ' + name;
        x.setAttribute('aria-label', label);
        x.title = label + '  (Esc)';
        x.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          close(ov);
        });
        title.appendChild(x);
      }
    }

    if (box && !box.hasAttribute('tabindex')) box.tabIndex = -1;
  }

  // ── Open / close transitions ────────────────────────────────────────
  function onOpened(ov) {
    if (ov.dataset.uxOpen === '1') return;
    ov.dataset.uxOpen = '1';

    // Only remember the opener for the first dialog in a stack, so closing the
    // shape picker returns to Frame Properties rather than to the ribbon.
    var active = document.activeElement;
    if (active && active !== document.body && !active.closest('.modal-overlay')) {
      returnFocusTo = active;
    }

    // Land on the first real control. Skipping the close button means Enter
    // still does the useful thing rather than dismissing the dialog.
    var items = focusablesIn(ov).filter(function (el) { return !el.classList.contains('modal-x'); });
    var first = items.filter(function (el) {
      return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    })[0] || items[0] || ov.querySelector('.modal-box');

    if (first) {
      try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); }
      if (first.tagName === 'INPUT' && /^(text|number|search)$/.test(first.type)) {
        try { first.select(); } catch (err) { /* some builds refuse on number */ }
      }
    }
  }

  function onClosed(ov) {
    if (ov.dataset.uxOpen !== '1') return;
    ov.dataset.uxOpen = '0';

    // Another dialog underneath is still up — leave focus to it.
    if (topOpen()) return;

    if (returnFocusTo && document.contains(returnFocusTo)) {
      try { returnFocusTo.focus({ preventScroll: true }); } catch (err) { /* gone */ }
    }
    returnFocusTo = null;
  }

  // ── Focus trap ──────────────────────────────────────────────────────
  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    var ov = topOpen();
    if (!ov) return;

    var items = focusablesIn(ov);
    if (!items.length) return;

    var firstEl = items[0];
    var lastEl  = items[items.length - 1];
    var active  = document.activeElement;

    // Focus escaped the dialog (backdrop click, or it started outside).
    if (!ov.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? lastEl : firstEl).focus();
      return;
    }
    if (e.shiftKey && active === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
  }

  // ── Wiring ──────────────────────────────────────────────────────────
  function watch(ov) {
    prepare(ov);
    if (isOpen(ov)) onOpened(ov);

    new MutationObserver(function () {
      if (isOpen(ov)) onOpened(ov); else onClosed(ov);
    }).observe(ov, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  function init() {
    [].forEach.call(document.querySelectorAll('.modal-overlay'), watch);
    // Capture phase: app.js's own keydown handler returns early while a dialog
    // is open, but a stray Tab must be caught before anything else sees it.
    document.addEventListener('keydown', onKeydown, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DialogUX = {
    // Call after adding a .modal-overlay to the DOM at runtime.
    refresh: function () { [].forEach.call(document.querySelectorAll('.modal-overlay'), watch); },
    close: close,
    topOpen: topOpen
  };
})();
