/*
 * WowAltBoard - app/layouts.js
 *
 * Named column layouts: save the shape of the table, switch between saved ones.
 *
 * A layout stores ONLY the shape -- group order, per-group column order, and what
 * is hidden. Filters, sorting and appearance are deliberately left out: switching
 * to 「大秘境」 should rearrange columns, not quietly change which characters you
 * are looking at.
 *
 * There is no "current layout" pointer to keep in sync. Whether a layout is
 * active is DERIVED by comparing the live shape against each saved one, so any
 * drag or checkbox immediately reads as 「当前（未保存）」 without every one of
 * those code paths having to remember to invalidate something.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;

  function sortedCopy(o) {
    var out = {};
    Object.keys(o || {}).sort().forEach(function (k) { out[k] = o[k]; });
    return out;
  }

  /** Canonical form, so two equal shapes always stringify identically. */
  function norm(x) {
    x = x || {};
    var co = {};
    Object.keys(x.columnOrder || {}).sort().forEach(function (g) {
      co[g] = (x.columnOrder[g] || []).slice();
    });
    return {
      groupOrder: (x.groupOrder || []).slice(),
      columnOrder: co,
      hiddenColumns: sortedCopy(x.hiddenColumns),
      hiddenGroups: sortedCopy(x.hiddenGroups)
    };
  }

  AE.layoutShape = function (s) { return norm(s); };

  AE.sameLayout = function (a, b) {
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  };

  function list() {
    var s = AE.state.settings;
    if (!Array.isArray(s.layouts)) s.layouts = [];
    return s.layouts;
  }

  AE.layouts = list;
  /** Name of the saved layout the table currently matches, or '' for none. */
  AE.activeLayoutName = function () {
    var live = norm(AE.state.settings);
    var hit = '';
    list().forEach(function (l) {
      if (!hit && l && AE.sameLayout(live, l)) hit = l.name;
    });
    return hit;
  };

  AE.applyLayout = function (name) {
    var s = AE.state.settings;
    var found = null;
    list().forEach(function (l) { if (l && l.name === name) found = l; });
    if (!found) return false;

    var sh = norm(found);
    s.groupOrder = sh.groupOrder;
    s.columnOrder = sh.columnOrder;
    s.hiddenColumns = sh.hiddenColumns;
    s.hiddenGroups = sh.hiddenGroups;
    s.activeLayout = name;
    AE.rebuild();
    // The checkbox tree mirrors hiddenColumns / hiddenGroups, so it has to follow.
    AE.buildSettingsPanel();
    return true;
  };

  /** Save the live shape under `name`, replacing a same-named layout. */
  AE.saveLayout = function (name) {
    name = String(name || '').trim();
    if (!name) return false;
    var s = AE.state.settings;
    var entry = norm(s);
    entry.name = name;

    var all = list();
    var at = -1;
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].name === name) at = i;
    if (at >= 0) all[at] = entry; else all.push(entry);

    s.activeLayout = name;
    AE.saveSettings(s);
    return true;
  };

  AE.deleteLayout = function (name) {
    var s = AE.state.settings;
    s.layouts = list().filter(function (l) { return !l || l.name !== name; });
    if (s.activeLayout === name) s.activeLayout = '';
    AE.saveSettings(s);
    return true;
  };

  AE.renameLayout = function (from, to) {
    to = String(to || '').trim();
    if (!to || to === from) return false;
    var all = list();
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].name === to) return false;      // would collide
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j] && all[j].name === from) { all[j].name = to; break; }
    }
    var s = AE.state.settings;
    if (s.activeLayout === from) s.activeLayout = to;
    AE.saveSettings(s);
    return true;
  };

  /** Back to the registry order. Visibility is left alone -- a different knob. */
  AE.resetColumnOrder = function () {
    var s = AE.state.settings;
    s.groupOrder = [];
    s.columnOrder = {};
    AE.rebuild();
  };
  // The header picker only exists once there is something to pick, so the bar
  // stays as it was for anyone who never saves a layout.
  AE.renderLayoutPicker = function () {
    var sel = doc.getElementById('layout-pick');
    var wrap = doc.getElementById('layout-pick-wrap') || sel;
    if (!sel) return;
    var all = list().filter(function (l) { return l && l.name; });
    if (!all.length) { wrap.style.display = 'none'; return; }

    var active = AE.activeLayoutName();
    sel.innerHTML = '';
    if (!active) {
      var cur = doc.createElement('option');
      cur.value = '';
      cur.textContent = '当前（未保存）';
      cur.selected = true;
      sel.appendChild(cur);
    }
    all.forEach(function (l) {
      var op = doc.createElement('option');
      op.value = l.name;
      op.textContent = l.name;
      if (l.name === active) op.selected = true;
      sel.appendChild(op);
    });
    wrap.style.display = '';
    sel.title = '布局方案' + (active ? '：' + active : '（当前的改动还没保存）');

    sel.onchange = function () {
      if (!sel.value) return;                  // the synthetic 当前 entry
      AE.applyLayout(sel.value);
    };
  };

})(typeof window !== 'undefined' ? window : globalThis);
