// ──────────────────────────────────────────────────────────────────
//  Structural Analyser — Selection & Edit Operations
//
//  All operations that act on the current selection (multi-select
//  rubber-band or single-selected element):
//
//    selectAll / deselectAll / invertSelection / deleteSelected
//    moveSelection / copySelection / rotateSelection / mirrorSelection
//    splitBeam / insertNodeMidpoint / subdivideSelectedBeams
//    mergeCoincidentNodes / alignNodes / distributeNodes
//
//  Exposed as: window.AppEdit = { ...all functions }
//  Reads/writes live state through window.SA (populated by app.js).
// ──────────────────────────────────────────────────────────────────
'use strict';

window.AppEdit = (() => {

  function sa() { return window.SA; }

  // ── Select All / Deselect / Invert ───────────────────────────────

  function selectAll() {
    const app = sa();
    app.nodes.forEach(nd => app.multiSel.nodes.add(nd.id));
    app.beams.forEach(bm => app.multiSel.beams.add(bm.id));
    app.render();
    app.toast(`Selected ${app.multiSel.nodes.size} nodes, ${app.multiSel.beams.size} beams`, 'info');
  }

  function deselectAll() {
    const app = sa();
    app.multiSel.nodes.clear(); app.multiSel.beams.clear();
    app.selNode = null; app.selBeam = null;
    app.render();
    app.toast('Selection cleared', 'info');
  }

  function invertSelection() {
    const app = sa();
    app.nodes.forEach(nd => {
      if (app.multiSel.nodes.has(nd.id)) app.multiSel.nodes.delete(nd.id);
      else                               app.multiSel.nodes.add(nd.id);
    });
    app.beams.forEach(bm => {
      if (app.multiSel.beams.has(bm.id)) app.multiSel.beams.delete(bm.id);
      else                               app.multiSel.beams.add(bm.id);
    });
    app.render();
  }

  function deleteSelected() {
    const app = sa();
    if (app.multiSel.nodes.size === 0 && app.multiSel.beams.size === 0) {
      app.toast('Nothing selected — use Select All or rubber-band on canvas', 'warn'); return;
    }
    app.snapshot();
    app.multiSel.beams.forEach(bid => app.deleteBeam(bid));
    app.multiSel.nodes.forEach(nid => app.deleteNode(nid));
    app.multiSel.nodes.clear(); app.multiSel.beams.clear();
    app.updateNodeTable(); app.updateBeamTable(); app.updateLoadTable(); app.render();
    app.toast('Selected elements deleted', 'success');
  }

  // ── Move ──────────────────────────────────────────────────────────

  function moveSelection(dx, dy, dz) {
    const app = sa();
    const ids = app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                (app.selNode !== null ? new Set([app.selNode]) : null);
    if (!ids || ids.size === 0) { app.toast('No nodes selected', 'warn'); return; }
    app.snapshot();
    ids.forEach(nid => {
      const nd = app.findNode(nid);
      if (!nd) return;
      nd.x += dx; nd.y += dy;
      if (app.mode3D) nd.z = (nd.z || 0) + dz;
    });
    app.results = null;
    app.updateNodeTable(); app.render();
    app.toast(`Moved ${ids.size} node(s) by (${dx}, ${dy}${app.mode3D ? ', ' + dz : ''}) m`, 'success');
  }

  // ── Copy ──────────────────────────────────────────────────────────

  // ── Per-member properties ─────────────────────────────────────────
  // Everything beyond its endpoints that makes a member behave the way the
  // user set it up. sectionId and the two hinges were always carried across a
  // Split or a Copy; none of the rest were, so both operations quietly
  // produced members that analyse and check differently from the one they
  // came from:
  //   modifiers  — the stiffness modifiers the solver applies through
  //                stiffMod(). A beam with fi3 = 0.35 split into three
  //                segments came back 2.86x stiffer (1/0.35) and its
  //                deflection was understated by 65%.
  //   Ky/Kz/Lcr  — effective length factors and unbraced length, read by the
  //                design checks for buckling.
  //   memberType — the column/beam/brace override the design checks classify
  //                by; it reverted to 'auto'.
  // `name` is deliberately not carried: it identifies one particular member,
  // and a copy or a sub-beam is a different member.
  const MEMBER_PROPS = ['modifiers', 'Ky', 'Kz', 'Lcr', 'memberType'];

  function carryMemberProps(src, dst) {
    if (!src || !dst) return;
    MEMBER_PROPS.forEach(k => {
      const v = src[k];
      if (v === undefined || v === null) return;
      // modifiers is an object: give each member its own, or the sub-beams
      // would share one and editing any of them would change them all.
      dst[k] = (k === 'modifiers') ? { ...v } : v;
    });
  }

  function copySelection(dx, dy, dz) {
    const app = sa();
    const nodeIds = app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                    (app.selNode !== null ? new Set([app.selNode]) : null);
    if (!nodeIds || nodeIds.size === 0) { app.toast('No nodes selected', 'warn'); return; }
    app.snapshot();

    const idMap = new Map();  // old id → new id
    nodeIds.forEach(nid => {
      const nd = app.findNode(nid);
      if (!nd) return;
      const newId = app.addNode(nd.x + dx, nd.y + dy, (nd.z || 0) + dz);
      const newNd = app.findNode(newId);
      if (newNd) newNd.support = 'none';  // copies don't inherit supports
      idMap.set(nid, newId);
    });

    // Copy beams whose both endpoints are in the selection
    let copiedBeams = 0;
    const copyBeamIfInside = bm => {
      if (idMap.has(bm.node1) && idMap.has(bm.node2)) {
        const nb = app.findBeam(app.addBeam(idMap.get(bm.node1), idMap.get(bm.node2)));
        if (!nb) return;
        nb.sectionId  = bm.sectionId;
        nb.hingeStart = bm.hingeStart;
        nb.hingeEnd   = bm.hingeEnd;
        carryMemberProps(bm, nb);
        copiedBeams++;
      }
    };
    if (app.multiSel.beams.size > 0) {
      app.multiSel.beams.forEach(bid => { const bm = app.findBeam(bid); if (bm) copyBeamIfInside(bm); });
    } else {
      // No explicit beam selection → copy all beams that connect selected nodes
      const origBeams = app.beams.slice();
      origBeams.forEach(copyBeamIfInside);
    }

    // Re-select the newly created nodes
    app.multiSel.nodes.clear(); app.multiSel.beams.clear();
    idMap.forEach(newId => app.multiSel.nodes.add(newId));
    app.updateNodeTable(); app.updateBeamTable(); app.render();
    app.toast(`Copied ${idMap.size} node(s), ${copiedBeams} beam(s)`, 'success');
  }

  // ── Rotate ────────────────────────────────────────────────────────

  function rotateSelection(angleDeg) {
    const app = sa();
    const ids = app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                (app.selNode !== null ? new Set([app.selNode]) : null);
    if (!ids || ids.size === 0) { app.toast('No nodes selected', 'warn'); return; }

    // Compute centroid
    let cx = 0, cy = 0, count = 0;
    ids.forEach(nid => { const nd = app.findNode(nid); if (nd) { cx += nd.x; cy += nd.y; count++; } });
    if (!count) return;
    cx /= count; cy /= count;

    const rad  = angleDeg * Math.PI / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    app.snapshot();
    ids.forEach(nid => {
      const nd = app.findNode(nid);
      if (!nd) return;
      const rx = nd.x - cx, ry = nd.y - cy;
      nd.x = cx + rx * cosA - ry * sinA;
      nd.y = cy + rx * sinA + ry * cosA;
    });
    app.results = null; app.updateNodeTable(); app.render();
    app.toast(`Rotated ${count} node(s) by ${angleDeg}°`, 'success');
  }

  // ── Mirror ────────────────────────────────────────────────────────
  // axis: 'H' (flip Y about centroid) | 'V' (flip X about centroid)

  function mirrorSelection(axis) {
    const app = sa();
    const ids = app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                (app.selNode !== null ? new Set([app.selNode]) : null);
    if (!ids || ids.size === 0) { app.toast('No nodes selected', 'warn'); return; }

    let cx = 0, cy = 0, count = 0;
    ids.forEach(nid => { const nd = app.findNode(nid); if (nd) { cx += nd.x; cy += nd.y; count++; } });
    if (!count) return;
    cx /= count; cy /= count;

    app.snapshot();
    ids.forEach(nid => {
      const nd = app.findNode(nid);
      if (!nd) return;
      if (axis === 'H') nd.y = 2 * cy - nd.y;
      else              nd.x = 2 * cx - nd.x;
    });
    app.results = null; app.updateNodeTable(); app.render();
    // Name the axis and the resulting motion. "Mirrored horizontally" for a
    // flip that moves things up and down is what made the pair confusing.
    app.toast(`Mirrored ${count} node(s) about the ${axis === 'H' ? 'horizontal' : 'vertical'} ` +
              `axis (${axis === 'H' ? 'top ↔ bottom' : 'left ↔ right'})`, 'success');
  }

  // ── Split Beam ────────────────────────────────────────────────────

  function splitBeam(beamId, n) {
    const app = sa();
    const bm = app.findBeam(beamId);
    if (!bm) { app.toast('No beam selected', 'warn'); return; }
    if (n < 2) { app.toast('Parts must be ≥ 2', 'warn'); return; }
    const ni = app.findNode(bm.node1), nj = app.findNode(bm.node2);
    if (!ni || !nj) return;

    app.snapshot();
    const dx = (nj.x - ni.x) / n;
    const dy = (nj.y - ni.y) / n;
    const dz = ((nj.z || 0) - (ni.z || 0)) / n;
    const { sectionId, hingeStart: hS, hingeEnd: hE } = bm;
    // Snapshot the rest before deleteBeam() takes the member out of the array.
    // Splitting is mesh refinement: the sub-beams are the same physical member,
    // so they must analyse the same way it did.
    const srcProps = {}; MEMBER_PROPS.forEach(k => { srcProps[k] = bm[k]; });

    // Member loads must be captured BEFORE deleteBeam(), which drops every load
    // carrying this elementId. Splitting a loaded beam used to discard its
    // loading silently — the model looked the same but solved as if unloaded.
    const oldLoads = app.loads.filter(l => l.elementId === beamId);
    const Ltot     = Math.hypot(nj.x - ni.x, nj.y - ni.y, (nj.z || 0) - (ni.z || 0));
    const Lseg     = Ltot / n;

    // Create n-1 intermediate nodes
    const chain = [bm.node1];
    for (let i = 1; i < n; i++) {
      chain.push(app.addNode(ni.x + dx * i, ni.y + dy * i, (ni.z || 0) + dz * i));
    }
    chain.push(bm.node2);

    // Replace original beam with n sub-beams
    app.deleteBeam(beamId);
    const newIds = [];
    for (let i = 0; i < n; i++) {
      const nb = app.findBeam(app.addBeam(chain[i], chain[i + 1]));
      if (!nb) continue;
      nb.sectionId  = sectionId;
      nb.hingeStart = i === 0     ? hS : false;
      nb.hingeEnd   = i === n - 1 ? hE : false;
      carryMemberProps(srcProps, nb);
      newIds.push(nb.id);
    }

    // ── Re-apply the original member loads to the sub-beams ──────────
    //   beam_dist  — same intensity on every segment
    //   beam_trap  — linearly interpolated at each segment's own ends
    //   beam_point — lands on the segment containing it, position made local
    for (const ld of oldLoads) {
      if (ld.type === 'beam_point') {
        const pos = Math.max(0, Math.min(ld.pos || 0, Ltot));
        let seg = Lseg > 0 ? Math.floor(pos / Lseg) : 0;
        if (seg > newIds.length - 1) seg = newIds.length - 1;   // exactly at the far end
        if (newIds[seg] === undefined) continue;
        app.loads.push({ ...ld, id: app.nextId.load++,
                         elementId: newIds[seg], pos: pos - seg * Lseg });
      } else if (ld.type === 'beam_trap') {
        const lerp = (a, b, f) => a + (b - a) * f;
        const fx1 = ld.fx || 0,  fy1 = ld.fy || 0;
        const fx2 = ld.fx2 !== undefined ? ld.fx2 : fx1;
        const fy2 = ld.fy2 !== undefined ? ld.fy2 : fy1;
        newIds.forEach((bid, i) => {
          const f0 = i / n, f1 = (i + 1) / n;
          app.loads.push({ ...ld, id: app.nextId.load++, elementId: bid,
                           fx:  lerp(fx1, fx2, f0), fy:  lerp(fy1, fy2, f0),
                           fx2: lerp(fx1, fx2, f1), fy2: lerp(fy1, fy2, f1) });
        });
      } else {
        newIds.forEach(bid => app.loads.push({ ...ld, id: app.nextId.load++, elementId: bid }));
      }
    }

    app.selBeam = null;
    app.updateNodeTable(); app.updateBeamTable(); app.render();
    app.toast(`Split beam into ${n} equal parts`, 'success');
  }

  function insertNodeMidpoint(beamId) { splitBeam(beamId, 2); }

  function subdivideSelectedBeams(n) {
    const app = sa();
    const bids = Array.from(app.multiSel.beams);
    if (bids.length === 0 && app.selBeam !== null) bids.push(app.selBeam);
    if (bids.length === 0) { app.toast('No beams selected', 'warn'); return; }
    app.snapshot();
    bids.forEach(bid => splitBeam(bid, n));
    app.toast(`Subdivided ${bids.length} beam(s) into ${n} parts each`, 'success');
  }

  // ── Merge Coincident Nodes ────────────────────────────────────────

  function mergeCoincidentNodes(tol) {
    const app = sa();

    // tol had no default, so a call without one made every comparison
    // `dist > undefined` — always false — and merged EVERY pair: a 9-node frame
    // collapsed to a single node. The toolbar passes a value, but this is a
    // public API (AppEdit.mergeCoincidentNodes) and destroying the model on a
    // missing argument is not an acceptable failure mode.
    const t = (Number.isFinite(+tol) && +tol > 0) ? +tol : 0.05;

    app.snapshot();

    // Union-find over the coincidence pairs.
    //
    // A plain pairwise `merged.set(lose, keep)` map cannot express a chain: with
    // A≈B≈C it produced B→A and C→B, then deleted B — so every beam that
    // pointed at C was remapped onto a node that no longer existed, leaving
    // dangling endpoints and a model that would not solve. Resolving each node
    // to the root of its cluster first makes chains collapse correctly, and it
    // also removes the order-dependence of which node in a cluster survives.
    const parent = new Map();
    const find = id => {
      let r = id;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
      // Path compression, so long chains stay cheap.
      let cur = id;
      while (parent.has(cur) && parent.get(cur) !== r) {
        const nxt = parent.get(cur); parent.set(cur, r); cur = nxt;
      }
      return r;
    };
    const union = (x, y, preferY) => {
      const rx = find(x), ry = find(y);
      if (rx === ry) return;
      // preferY keeps the supported node as the cluster root.
      if (preferY) parent.set(rx, ry); else parent.set(ry, rx);
    };

    const nodes = app.nodes;
    nodes.forEach(nd => parent.set(nd.id, nd.id));

    // Spatial hash instead of an O(n²) all-pairs scan: bucket nodes into cells
    // sized 2·tol, so two nodes within tol of each other are guaranteed to
    // land in the same cell or a face/edge/corner-adjacent one, and each node
    // only has to be compared against the ~27 cells around it rather than
    // every other node in the model. This is a user-triggered action, not a
    // render-loop cost, but a generator-produced grid or a large import
    // easily reaches hundreds to thousands of nodes, and merge is exactly the
    // operation reached for right after either.
    //
    // Each true coincident pair can be discovered from both nodes' own
    // neighbourhood scan (a from b's cells, and b from a's), so `pairs` may
    // double-count — harmless, since it is only ever read as `pairs > 0`
    // below, never as an exact count, and `union()` no-ops on an already-
    // merged pair regardless of how many times it is called.
    const cell = t > 0 ? t * 2 : 0.1;
    const keyOf = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    const buckets = new Map();
    nodes.forEach(nd => {
      const k = keyOf(nd.x, nd.y || 0, nd.z || 0);
      let bucket = buckets.get(k);
      if (!bucket) { bucket = []; buckets.set(k, bucket); }
      bucket.push(nd);
    });

    let pairs = 0;
    const OFFSETS = [-1, 0, 1];
    for (const a of nodes) {
      const cx = Math.floor(a.x / cell), cy = Math.floor((a.y || 0) / cell), cz = Math.floor((a.z || 0) / cell);
      for (const dx of OFFSETS) for (const dy of OFFSETS) for (const dz of OFFSETS) {
        const bucket = buckets.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
        if (!bucket) continue;
        for (const b of bucket) {
          if (b === a) continue;
          const dist = Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
          if (!(dist <= t)) continue;   // NaN-safe: skip unless genuinely within tol
          // Keep the node that has a real support (or the first one)
          union(a.id, b.id, !!(b.support && b.support !== 'none'));
          pairs++;
        }
      }
    }

    // loser id → surviving keeper id, with every chain already resolved
    const merged = new Map();
    if (pairs > 0) {
      nodes.forEach(nd => {
        const root = find(nd.id);
        if (root !== nd.id) merged.set(nd.id, root);
      });
    }
    if (merged.size === 0) { app.toast('No coincident nodes found within tolerance', 'info'); return; }

    // Remap beam endpoints and load/settlement references
    app.beams.forEach(bm => {
      if (merged.has(bm.node1)) bm.node1 = merged.get(bm.node1);
      if (merged.has(bm.node2)) bm.node2 = merged.get(bm.node2);
    });
    app.loads.forEach(ld => { if (merged.has(ld.nodeId)) ld.nodeId = merged.get(ld.nodeId); });
    if (app.settlements) {
      app.settlements.forEach(s => { if (merged.has(s.nodeId)) s.nodeId = merged.get(s.nodeId); });
    }

    // Remove merged nodes
    const lost = new Set(merged.keys());
    app.nodes = app.nodes.filter(nd => !lost.has(nd.id));

    // Remove zero-length or duplicate beams.
    //
    // These are spliced straight out of the array rather than going through
    // deleteBeam(), which is what normally deals with a member's loads. So
    // their loads were left pointing at an element id that no longer existed:
    // the solver finds no such member and silently ignores them, while they
    // stay in the model, in the load table and in the saved file. A 99 kN/m
    // line load that vanishes from the analysis but not from the model is
    // exactly the kind of difference nobody notices.
    //
    // The duplicate's load is moved onto the member that survives in its
    // place, not deleted. Merging welds nodes; it is not a decision to remove
    // load, and quietly dropping applied load understates demand. Stacking
    // the two is conservative instead, and it shows up as two rows on one
    // member so it can be seen and undone — which a deleted load cannot.
    const seen = new Map();              // canonical node pair → surviving id
    const reassign = new Map();          // dropped beam id → surviving beam id
    const zeroLen  = new Set();          // collapsed to a point: no survivor
    app.beams = app.beams.filter(bm => {
      if (bm.node1 === bm.node2) { zeroLen.add(bm.id); return false; }
      const k = bm.node1 < bm.node2 ? `${bm.node1}-${bm.node2}` : `${bm.node2}-${bm.node1}`;
      if (seen.has(k)) { reassign.set(bm.id, seen.get(k)); return false; }
      seen.set(k, bm.id); return true;
    });

    let moved = 0, dropped = 0;
    if (reassign.size || zeroLen.size) {
      app.loads = app.loads.filter(ld => {
        if (ld.elementId == null) return true;
        if (reassign.has(ld.elementId)) { ld.elementId = reassign.get(ld.elementId); moved++; }
        // A member both of whose ends merged onto one node has no length and
        // no survivor, so there is nothing left to carry its load.
        else if (zeroLen.has(ld.elementId)) { dropped++; return false; }
        return true;
      });
      if (moved) {
        app.toast(`${moved} load(s) moved onto the member that replaced the duplicate — ` +
                  `check for doubled-up loads.`, 'warn');
      }
      if (dropped) {
        app.toast(`${dropped} load(s) removed: their member collapsed to zero length.`, 'warn');
      }
    }

    app.results = null;
    app.updateNodeTable(); app.updateBeamTable(); app.render();
    app.toast(`Merged ${merged.size} node(s) within ${t} m tolerance`, 'success');
  }

  // ── Align Nodes ───────────────────────────────────────────────────
  // mode: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

  function alignNodes(mode) {
    const app = sa();
    const ids = Array.from(app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                           (app.selNode !== null ? [app.selNode] : []));
    if (ids.length < 2) { app.toast('Select ≥ 2 nodes to align', 'warn'); return; }
    const nds = ids.map(id => app.findNode(id)).filter(Boolean);
    app.snapshot();
    if (mode === 'left')    { const x = Math.min(...nds.map(n => n.x)); nds.forEach(n => n.x = x); }
    if (mode === 'right')   { const x = Math.max(...nds.map(n => n.x)); nds.forEach(n => n.x = x); }
    if (mode === 'top')     { const y = Math.max(...nds.map(n => n.y)); nds.forEach(n => n.y = y); }
    if (mode === 'bottom')  { const y = Math.min(...nds.map(n => n.y)); nds.forEach(n => n.y = y); }
    if (mode === 'hcenter') { const y = nds.reduce((s, n) => s + n.y, 0) / nds.length; nds.forEach(n => n.y = y); }
    if (mode === 'vcenter') { const x = nds.reduce((s, n) => s + n.x, 0) / nds.length; nds.forEach(n => n.x = x); }
    app.results = null; app.updateNodeTable(); app.render();
    app.toast(`Aligned ${nds.length} nodes (${mode})`, 'success');
  }

  // ── Distribute Nodes ──────────────────────────────────────────────
  // axis: 'H' (equal horizontal spacing) | 'V' (equal vertical spacing)

  function distributeNodes(axis) {
    const app = sa();
    const ids = Array.from(app.multiSel.nodes.size > 0 ? app.multiSel.nodes :
                           (app.selNode !== null ? [app.selNode] : []));
    if (ids.length < 3) { app.toast('Select ≥ 3 nodes to distribute', 'warn'); return; }
    const nds = ids.map(id => app.findNode(id)).filter(Boolean);
    app.snapshot();
    if (axis === 'H') {
      nds.sort((a, b) => a.x - b.x);
      const x0 = nds[0].x, x1 = nds[nds.length - 1].x;
      const step = (x1 - x0) / (nds.length - 1);
      nds.forEach((n, i) => n.x = x0 + step * i);
    } else {
      nds.sort((a, b) => a.y - b.y);
      const y0 = nds[0].y, y1 = nds[nds.length - 1].y;
      const step = (y1 - y0) / (nds.length - 1);
      nds.forEach((n, i) => n.y = y0 + step * i);
    }
    app.results = null; app.updateNodeTable(); app.render();
    app.toast(`Distributed ${nds.length} nodes equally (${axis === 'H' ? 'horizontal' : 'vertical'})`, 'success');
  }

  return {
    selectAll, deselectAll, invertSelection, deleteSelected,
    moveSelection, copySelection, rotateSelection, mirrorSelection,
    splitBeam, insertNodeMidpoint, subdivideSelectedBeams,
    mergeCoincidentNodes, alignNodes, distributeNodes
  };
})();
