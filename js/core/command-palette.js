/* ══════════════════════════════════════════════════════════════════════
   command-palette.js — Ctrl+K search over every ribbon command.

   The ribbon holds 146 commands spread across 10 tabs (Home 29, ACI 318 24,
   Display 17, View 16, File 16, Modify 15 …). Reaching "Development Length" or
   "Retaining Wall" meant already knowing which tab hides it, and the ACI tab
   alone stacks 24 calculators into 9 unlabelled-at-a-glance groups.

   No command is declared here. Every ribbon button already carries the three
   things a palette needs —

       <div class="rib-group">
         <div class="rib-btns">
           <button class="rib-btn" title="Draw Beam [E]"><span class="rib-icon">─</span>Beam</button>
         </div>
         <div class="rib-group-lbl">DRAW TOOLS</div>
       </div>

   — a label, a description, and its shortcut in brackets, inside a labelled
   group inside a named tab. The index is read straight off that markup, so a
   button added to index.html is searchable with no change here, and a command
   can never drift from the button it claims to be.

   Running a command switches to its ribbon tab before clicking, so the ribbon
   visibly moves to where the command lives — the palette teaches the ribbon
   rather than replacing it.

   Load AFTER app.js. Exposes window.CommandPalette.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var RECENT_KEY = 'sa_cmdpalette_recent_v1';
  var MAX_RECENT = 8;
  var MAX_RESULTS = 60;

  var overlay, input, list, hint;
  var commands = [];
  var shown    = [];
  var active   = 0;
  var open     = false;

  // ── Index ───────────────────────────────────────────────────────────

  function tabLabel(panelId) {
    var rib = panelId.replace(/^rib-/, '');
    var tab = document.querySelector('.rib-tab[data-rib="' + rib + '"]');
    return { key: rib, name: tab ? tab.textContent.trim() : rib };
  }

  function buildIndex() {
    commands = [];
    var seen = Object.create(null);

    [].forEach.call(document.querySelectorAll('.rib-panel'), function (panel) {
      var tab = tabLabel(panel.id);

      [].forEach.call(panel.querySelectorAll('.rib-group'), function (group) {
        var lbl     = group.querySelector('.rib-group-lbl');
        var groupNm = lbl ? lbl.textContent.trim() : '';

        [].forEach.call(group.querySelectorAll('.rib-btn, .rib-btn-lg'), function (btn) {
          var icon = btn.querySelector('.rib-icon');
          // The label is the button's own text with the icon glyph removed —
          // taking textContent whole would prefix every entry with "▶", "●"…
          var label = '';
          [].forEach.call(btn.childNodes, function (n) {
            if (n.nodeType === 3) label += n.textContent;
            else if (n !== icon) label += n.textContent;
          });
          label = label.replace(/\s+/g, ' ').trim();
          if (!label) label = (btn.getAttribute('title') || '').split('[')[0].trim();
          if (!label) return;

          var title = (btn.getAttribute('title') || '').trim();
          // Shortcuts are written into the tooltip as a trailing "[E]".
          var m   = title.match(/\[([^\]]{1,12})\]\s*$/);
          var key = m ? m[1] : '';
          var desc = (m ? title.slice(0, m.index) : title).trim();
          // A tooltip that only restates the label adds nothing to the row.
          if (desc.toLowerCase() === label.toLowerCase()) desc = '';

          var id = tab.key + '|' + label;
          if (seen[id]) return;
          seen[id] = 1;

          commands.push({
            id: id,
            el: btn,
            label: label,
            desc: desc,
            key: key,
            icon: icon ? icon.textContent.trim() : '',
            tab: tab.name,
            tabKey: tab.key,
            group: groupNm,
            // One string to score against, so a search for "aci column" finds
            // Columns in the ACI 318 tab even though neither word is its label.
            haystack: (label + ' ' + groupNm + ' ' + tab.name + ' ' + desc).toLowerCase()
          });
        });

        // The Generate dropdown's own commands (Simple Beam, Truss, Arch, …)
        // are plain <button onclick="..."> elements inside a nested dropdown
        // menu, with none of the rib-btn classes above, so the scan two lines
        // up never saw them — a search for "arch" or "truss" found nothing,
        // directly contradicting this module's own claim (see the file
        // header) that any ribbon button is searchable with no extra wiring.
        [].forEach.call(group.querySelectorAll('.gen-dd-menu button'), function (btn) {
          var label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (!label) return;

          var id = tab.key + '|' + label;
          if (seen[id]) return;
          seen[id] = 1;

          commands.push({
            id: id,
            el: btn,
            label: label,
            desc: 'Generate',
            key: '',
            icon: '',
            tab: tab.name,
            tabKey: tab.key,
            group: groupNm || 'Generate',
            haystack: (label + ' generate template ' + groupNm + ' ' + tab.name).toLowerCase()
          });
        });
      });
    });
    return commands;
  }

  // ── Recents ─────────────────────────────────────────────────────────

  function readRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch (e) { return []; }
  }

  function pushRecent(id) {
    try {
      var r = readRecent().filter(function (x) { return x !== id; });
      r.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, MAX_RECENT)));
    } catch (e) { /* private mode, quota — recents are a convenience only */ }
  }

  function recentCommands() {
    var byId = Object.create(null);
    commands.forEach(function (c) { byId[c.id] = c; });
    return readRecent().map(function (id) { return byId[id]; })
                       .filter(Boolean);
  }

  // ── Scoring ─────────────────────────────────────────────────────────
  // Ranked so that typing a few letters of a command's own name always beats
  // an incidental hit in some other command's group or tooltip.

  function score(cmd, q) {
    var label = cmd.label.toLowerCase();
    var i = label.indexOf(q);
    if (i === 0) return 1000 - label.length;                       // "sol" → Solve
    if (i > 0) {
      var wordStart = /[\s\-/(]/.test(label.charAt(i - 1));
      return (wordStart ? 800 : 600) - label.length;               // "wall" → Retaining Wall
    }
    if (cmd.haystack.indexOf(q) !== -1) return 400 - label.length; // group / tab / tooltip
    // Subsequence, so "dvl" still reaches Dev.Length.
    var qi = 0;
    for (var k = 0; k < label.length && qi < q.length; k++) {
      if (label.charAt(k) === q.charAt(qi)) qi++;
    }
    if (qi === q.length) return 200 - label.length;
    return -1;
  }

  // With no query the palette is a browsable list, not an empty box: recents
  // first if there are any, then the ribbon's own order. A first-time user
  // pressing Ctrl+K sees what the app can do rather than "no match".
  function browse() {
    var recents = recentCommands();
    var rest = commands.filter(function (c) { return recents.indexOf(c) === -1; });
    var groups = [];
    if (recents.length) groups.push({ title: 'Recent', items: recents });
    groups.push({ title: recents.length ? 'All commands' : null, items: rest });
    return groups;
  }

  function search(raw) {
    var q = raw.trim().toLowerCase();
    if (!q) return null;                 // caller falls back to browse()

    // Every space-separated term must hit somewhere, so "aci shear" narrows
    // rather than widening the way a plain OR would.
    var terms = q.split(/\s+/);
    var out = [];
    commands.forEach(function (c) {
      var total = 0;
      for (var i = 0; i < terms.length; i++) {
        var s = score(c, terms[i]);
        if (s < 0) return;
        total += s;
      }
      out.push({ c: c, s: total });
    });
    out.sort(function (a, b) { return b.s - a.s || a.c.label.localeCompare(b.c.label); });
    return out.slice(0, MAX_RESULTS).map(function (x) { return x.c; });
  }

  // ── Rendering ───────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Marks the characters the query actually matched, so a low-ranked
  // subsequence hit visibly explains why it is in the list.
  function highlight(text, q) {
    if (!q) return esc(text);
    var lower = text.toLowerCase();
    var i = lower.indexOf(q);
    if (i !== -1) {
      return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) +
             '</mark>' + esc(text.slice(i + q.length));
    }
    var out = '', qi = 0;
    for (var k = 0; k < text.length; k++) {
      if (qi < q.length && lower.charAt(k) === q.charAt(qi)) {
        out += '<mark>' + esc(text.charAt(k)) + '</mark>';
        qi++;
      } else out += esc(text.charAt(k));
    }
    return qi === q.length ? out : esc(text);
  }

  function rowHTML(c, i, q) {
    return '<div class="cmdp-item' + (i === 0 ? ' active' : '') + '" data-i="' + i + '" role="option">' +
             '<span class="cmdp-icon" aria-hidden="true">' + esc(c.icon) + '</span>' +
             '<span class="cmdp-main">' +
               '<span class="cmdp-label">' + highlight(c.label, q) + '</span>' +
               (c.desc ? '<span class="cmdp-desc">' + esc(c.desc) + '</span>' : '') +
             '</span>' +
             '<span class="cmdp-path">' + esc(c.tab) + (c.group ? ' › ' + esc(c.group) : '') + '</span>' +
             (c.key ? '<kbd class="cmdp-key">' + esc(c.key) + '</kbd>' : '') +
           '</div>';
  }

  function render() {
    var raw    = input.value.trim().toLowerCase();
    var first  = raw.split(/\s+/)[0] || '';
    var hits   = search(input.value);
    var groups = hits ? [{ title: null, items: hits }] : browse();

    // One flat list behind the sections, so the arrow keys and data-i indices
    // run straight through the headings.
    shown = groups.reduce(function (a, g) { return a.concat(g.items); }, []);
    active = 0;

    if (!shown.length) {
      list.innerHTML = '<div class="cmdp-empty">No command matches “' + esc(input.value.trim()) + '”</div>';
      hint.textContent = '';
      return;
    }

    var html = '', i = 0;
    groups.forEach(function (g) {
      if (!g.items.length) return;
      if (g.title) html += '<div class="cmdp-section">' + esc(g.title) + '</div>';
      g.items.forEach(function (c) { html += rowHTML(c, i++, first); });
    });

    list.innerHTML = html;
    hint.textContent = shown.length + (shown.length === 1 ? ' command' : ' commands');
  }

  function setActive(i) {
    var items = list.querySelectorAll('.cmdp-item');
    if (!items.length) return;
    active = (i + items.length) % items.length;
    [].forEach.call(items, function (el, n) { el.classList.toggle('active', n === active); });
    var el = items[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ── Run ─────────────────────────────────────────────────────────────

  function run(cmd) {
    if (!cmd || !cmd.el) return;
    hide();
    pushRecent(cmd.id);

    // Show the ribbon tab the command lives on before firing it: the button is
    // inside a display:none panel until then, and seeing the ribbon move is
    // how the palette stays a shortcut to the UI rather than a parallel one.
    var tab = document.querySelector('.rib-tab[data-rib="' + cmd.tabKey + '"]');
    if (tab && !tab.classList.contains('active')) tab.click();

    // Next frame, so the panel is laid out for any handler that measures it.
    requestAnimationFrame(function () {
      if (cmd.el.disabled) {
        if (window.SA && window.SA.toast) window.SA.toast(cmd.label + ' is not available right now', 'warn');
        return;
      }
      cmd.el.click();
    });
  }

  // ── Open / close ────────────────────────────────────────────────────

  function show() {
    if (open) return;
    buildIndex();
    open = true;
    overlay.classList.add('open');
    input.value = '';
    render();
    input.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    overlay.classList.remove('open');
  }

  function anyDialogOpen() {
    return [].some.call(document.querySelectorAll('.modal-overlay'), function (m) {
      return getComputedStyle(m).display !== 'none';
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────

  function build() {
    overlay = document.createElement('div');
    overlay.id = 'cmdp-overlay';
    overlay.innerHTML =
      '<div class="cmdp-box" role="dialog" aria-modal="true" aria-label="Command search">' +
        '<div class="cmdp-search">' +
          '<span class="cmdp-search-icon" aria-hidden="true">⌕</span>' +
          '<input id="cmdp-input" type="text" autocomplete="off" spellcheck="false" ' +
                 'role="combobox" aria-expanded="true" aria-controls="cmdp-list" ' +
                 'aria-label="Search commands" placeholder="Search commands…">' +
        '</div>' +
        '<div id="cmdp-list" class="cmdp-list" role="listbox" aria-label="Commands"></div>' +
        '<div class="cmdp-foot">' +
          '<span class="cmdp-count"></span>' +
          '<span class="cmdp-legend"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> run · <kbd>Esc</kbd> close</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    input = overlay.querySelector('#cmdp-input');
    list  = overlay.querySelector('#cmdp-list');
    hint  = overlay.querySelector('.cmdp-count');

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) hide(); });

    list.addEventListener('mousemove', function (e) {
      var item = e.target.closest('.cmdp-item');
      if (item) setActive(+item.dataset.i);
    });
    list.addEventListener('click', function (e) {
      var item = e.target.closest('.cmdp-item');
      if (item) run(shown[+item.dataset.i]);
    });

    input.addEventListener('input', render);
  }

  // ── Keys ────────────────────────────────────────────────────────────

  function onKeydown(e) {
    var mod = e.ctrlKey || e.metaKey;

    if (!open) {
      // Ctrl+K and Ctrl+P, both preventDefault'd — Chrome would otherwise take
      // K to the omnibox and P to the print dialog.
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) {
        if (anyDialogOpen()) return;     // a dialog owns the keyboard while it is up
        e.preventDefault();
        e.stopPropagation();
        show();
      }
      return;
    }

    // Open: the palette owns every key, so app.js's single-letter tool
    // shortcuts cannot fire behind it while the user is typing a query.
    e.stopPropagation();

    if (e.key === 'Escape')      { e.preventDefault(); hide(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && !input.value) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End'  && !input.value) { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === 'Enter')  { e.preventDefault(); run(shown[active]); }
    else if (e.key === 'Tab')    { e.preventDefault(); setActive(active + (e.shiftKey ? -1 : 1)); }
    else if (mod && (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); hide();       // same chord toggles back out
    }
  }

  // ── Init ────────────────────────────────────────────────────────────

  function init() {
    build();
    document.addEventListener('keydown', onKeydown, true);

    // Discoverability: the status bar already advertises "? = shortcuts".
    var tip = document.getElementById('sb-shortcut-hint') ||
              document.querySelector('.sbar-hint, #statusbar .sb-hint');
    if (tip && !/ctrl/i.test(tip.textContent)) {
      tip.textContent = 'Ctrl+K = commands · ? = shortcuts';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CommandPalette = {
    open: show,
    close: hide,
    // Re-read the ribbon. Only needed if buttons are added after load; show()
    // rebuilds the index on every open anyway.
    reindex: buildIndex,
    get commands() { return commands.slice(); }
  };
})();
