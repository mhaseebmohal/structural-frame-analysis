// ============================================================
//  view3d.js  —  Axis view buttons + 2D/3D toggle
//
//  Axis buttons (XZ/XY/YZ/ISO) behaviour:
//  • In 3D mode  → changes camera angle + fitToScreen
//  • In 2D mode  → XZ is the plane the canvas already draws, so it just
//    refits. XY, YZ and ISO need a third dimension the 2D canvas does not
//    have — a 2D model is flat, z spans nothing — so they switch to 3D and
//    apply the angle there.
//
//  This used to record the choice, highlight the button and refit, without
//  changing the drawing at all: clicking 'Plan' lit the Plan button and left
//  the elevation on screen, which reads as a broken button rather than as an
//  unavailable view.
// ============================================================
'use strict';

window.VIEW3D_RIB = (function () {

  // Standard 3D camera angles (az=azimuth, el=elevation in radians)
  const VIEWS = {
    XY:  { az: 0,            el: +Math.PI / 2, label: 'XY Plan (Top View)'   },  // +π/2 = look DOWN from above
    XZ:  { az: 0,            el: 0,            label: 'XZ Front Elevation'    },
    YZ:  { az: Math.PI / 2,  el: 0,            label: 'YZ Side Elevation'     },
    ISO: { az: Math.PI / 4,  el: 0.6155,       label: 'Isometric (45° / 35°)' }
  };

  // ── Apply a standard view ─────────────────────────────────────────
  function setView(name) {
    const v  = VIEWS[name]; if (!v) return;
    const SA = window.SA;   if (!SA) return;

    if (!SA.mode3D) {
      // XZ is the plane the 2D canvas draws, so there is nothing to change.
      if (name === 'XZ') {
        _last2DView = name;
        if (SA.fitToScreen) SA.fitToScreen();
        SA.render && SA.render();
        SA.toast && SA.toast('View: ' + v.label + ' (2D)', 'info');
        updateBtn();
        return;
      }

      // Everything else needs the axis 2D does not have. Rather than lighting
      // the button over an unchanged drawing, go and show the view they asked
      // for: switch to 3D, then set the camera. The 2D/3D button puts them
      // back in one click.
      SA.toast && SA.toast(v.label + ' needs 3D — switching', 'info');
      const btn3d = document.getElementById('btn-3d');
      if (!btn3d) {
        SA.toast && SA.toast('3D mode unavailable', 'warn');
        return;
      }
      btn3d.click();
      // The app's handler runs synchronously, so the camera can be set right
      // away. It is set again on a short delay because toggle2D3D schedules an
      // 80 ms callback of its own that restores a default angle: without the
      // second pass, a mode-button click followed quickly by an axis click
      // leaves the earlier callback landing last and the wrong view on screen.
      const apply = function () {
        if (!SA.mode3D) return;
        if (SA.view3D) { SA.view3D.az = v.az; SA.view3D.el = v.el; }
        fitToScreen3D(SA);
        updateBtn();
      };
      apply();
      setTimeout(apply, 120);
      return;
    }

    // ── 3D mode: change camera angle then fit ────────────────────────
    const v3d = SA.view3D;
    if (v3d) { v3d.az = v.az; v3d.el = v.el; }
    fitToScreen3D(SA);
    SA.toast && SA.toast('View: ' + v.label, 'info');
    updateBtn();
  }

  // ── Proper fit-to-screen for 3D (uses current view angles) ─────────
  function fitToScreen3D(SA) {
    if (!SA || !SA.nodes || !SA.nodes.length) {
      SA && SA.render && SA.render(); return;
    }
    // SA.fitToScreen already projects with the current view3D angles, so it is
    // the single source of truth for framing — this used to recompute the
    // projected bounds here and then discard them.
    if (SA.fitToScreen) SA.fitToScreen();
    else SA.render && SA.render();
  }

  // ── 2D / 3D toggle with canvas update ──────────────────────────────
  function toggle2D3D() {
    const SA    = window.SA;
    const btn3d = document.getElementById('btn-3d');
    if (!btn3d) return;
    btn3d.click();
    setTimeout(function () {
      if (SA && SA.mode3D && SA.view3D) {
        // Restore a sensible 3D angle if angles are at zero
        if (Math.abs(SA.view3D.az) < 0.01 && Math.abs(SA.view3D.el) < 0.01) {
          SA.view3D.az = Math.PI / 4;
          SA.view3D.el = 0.6155;
        }
        fitToScreen3D(SA);
      } else if (SA && !SA.mode3D) {
        // Back in 2D — just fitToScreen
        if (SA.fitToScreen) SA.fitToScreen();
        else SA.render && SA.render();
      }
      updateBtn();
    }, 80);
  }

  // Track last selected axis in 2D mode
  var _last2DView = 'XZ';

  // ── Ribbon button visual sync ───────────────────────────────────────
  function updateBtn() {
    const SA   = window.SA;
    const is3D = !!(SA && SA.mode3D);

    // 2D/3D mode button
    const btn  = document.getElementById('rib-btn-2d3d');
    const icon = document.getElementById('rib-2d3d-icon');
    const lbl  = document.getElementById('rib-2d3d-lbl');
    if (btn) {
      btn.style.background  = is3D ? '#1565c0' : '';
      btn.style.color       = is3D ? '#fff' : '';
      btn.style.borderColor = is3D ? '#1565c0' : '';
    }
    // Label the DESTINATION, not the current state: in 3D the button reads
    // "2D" because that is where clicking takes you, and vice versa. The blue
    // highlight still marks 3D as the mode you are in.
    if (icon) icon.textContent = is3D ? '2D' : '3D';
    if (lbl)  lbl.textContent  = is3D ? 'Go to 2D' : 'Go to 3D';

    if (is3D && SA && SA.view3D) {
      // 3D mode: highlight the standard view the camera is actually at.
      //
      // VIEWS.XY sets el = +PI/2, so testing (el + PI/2) can only match at
      // el = -PI/2 — the XY plan button never highlighted after being
      // clicked, and no other branch matched either, so the whole axis row
      // went blank. Matching |el| picks up the view from above or below.
      //
      // The azimuth alone is not enough for the other three. XZ always
      // tested both angles, but YZ and ISO tested only az, so the view cube's
      // TOP-RIGHT edge (az = 90 deg, el = +45 deg) lit "YZ Side" although it
      // is a 45 degree oblique, and its FRONT-RIGHT edge (az = 45 deg, el = 0)
      // lit "Isometric" although it is a flat elevation. A highlight that
      // names a view you are not looking at is worse than none.
      const el = SA.view3D.el;
      // Azimuth wrapped to (-PI, PI] so that, say, 3*PI/4 and -5*PI/4 agree.
      const az = Math.atan2(Math.sin(SA.view3D.az), Math.cos(SA.view3D.az));
      const near = function (a, b, tol) { return Math.abs(a - b) < tol; };
      const ISO_EL = 0.6155;              // atan(1/sqrt(2)) — true isometric

      let active = null;
      if (near(Math.abs(el), Math.PI / 2, 0.1)) {
        active = 'XY';                    // plan, from above or below
      } else if (Math.abs(el) < 0.1) {
        // A true elevation: level camera, so only the azimuth decides which.
        // BACK is the XZ plane seen from behind and LEFT the YZ plane seen
        // from the other side, so both light their plane's button.
        if (near(Math.abs(az), 0, 0.1) || near(Math.abs(az), Math.PI, 0.1))    active = 'XZ';
        else if (near(Math.abs(az), Math.PI / 2, 0.1))                          active = 'YZ';
      } else if (near(Math.abs(el), ISO_EL, 0.12)) {
        // Any of the eight isometric corners, not just the one ISO sets.
        if (near(Math.abs(az), Math.PI / 4, 0.15) ||
            near(Math.abs(az), 3 * Math.PI / 4, 0.15))                          active = 'ISO';
      }
      ['XY', 'XZ', 'YZ', 'ISO'].forEach(function (k) {
        const b = document.getElementById('rib-axis-' + k);
        if (b) b.classList.toggle('active', k === active);
      });
    } else {
      // 2D mode: highlight last clicked axis button
      ['XY', 'XZ', 'YZ', 'ISO'].forEach(function (k) {
        const b = document.getElementById('rib-axis-' + k);
        if (b) b.classList.toggle('active', k === _last2DView);
      });
    }
  }

  // ── Default frame generator ─────────────────────────────────────────
  function genDefault() {
    const SA = window.SA;
    if (!confirm('Load default 2-storey frame? Current work will be cleared.')) return;
    window.AppGenerators &&
      AppGenerators.generateDefaultStructure &&
      AppGenerators.generateDefaultStructure();
    // Switch to XZ front view in 3D after loading
    setTimeout(function () {
      if (SA && SA.mode3D) setView('XZ');
    }, 300);
  }

  // ── Watch mode changes for button sync ─────────────────────────────
  function watchMode() {
    const btn3d = document.getElementById('btn-3d');
    if (btn3d) {
      new MutationObserver(updateBtn)
        .observe(btn3d, { attributes: true, attributeFilter: ['class'] });
    }
    setInterval(updateBtn, 600);
    updateBtn();
  }

  window.addEventListener('load', function () { setTimeout(watchMode, 800); });

  return { setView, toggle2D3D, updateBtn, genDefault, VIEWS };

})();
