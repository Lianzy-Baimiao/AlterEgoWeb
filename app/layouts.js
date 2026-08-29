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

  // A layout's SCOPE decides how much it carries:
  //   'cols' -- group order, per-group column order, what is hidden
  //   'all'  -- the above plus the filters and the appearance
  //
  // 'cols' is the default and stays the default. A preset that silently changes
  // which characters are in the table is a real footgun, so carrying filters is
  // opt-in per preset, and every row says which kind it is.
  var FILTER_KEYS = ['enabledMode', 'minLevel', 'hideZeroRating', 'hideStaleDays',
                     'search', 'weeklyActiveOnly',
                     'hiddenCharacters', 'hiddenRealms', 'hiddenSources'];
  var LOOK_KEYS = ['theme', 'skin', 'fontFamily', 'fontSize',
                   'classColors', 'headerMode', 'currencyShowCap'];

  AE.LAYOUT_FILTER_KEYS = FILTER_KEYS;
  AE.LAYOUT_LOOK_KEYS = LOOK_KEYS;

  /** Deep clone with every object's keys sorted, so equal states stringify equal. */
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { o[k] = canon(v[k]); });
      return o;
    }
    return v;
  }

  // canon() at the end, not just per value: without it the keys come out in
  // FILTER_KEYS order here but alphabetical when read back through canon(), and
  // the two JSON strings never match -- so a preset would never look active.
  function pick(src, keys) {
    var o = {};
    keys.forEach(function (k) { o[k] = src[k]; });
    return canon(o);
  }

  function scopeOf(x) { return (x && x.scope === 'all') ? 'all' : 'cols'; }

  /** The live settings, as a layout of the given scope. */
  function liveShape(s, scope) {
    var out = {
      scope: scopeOf({ scope: scope }),
      groupOrder: (s.groupOrder || []).slice(),
      columnOrder: canon(s.columnOrder || {}),
      hiddenColumns: canon(s.hiddenColumns || {}),
      hiddenGroups: canon(s.hiddenGroups || {})
    };
    if (out.scope === 'all') {
      out.filters = pick(s, FILTER_KEYS);
      out.look = pick(s, LOOK_KEYS);
    }
    return out;
  }

  /** A stored entry, re-canonicalised so it compares against liveShape. */
  function savedShape(e) {
    e = e || {};
    var out = {
      scope: scopeOf(e),
      groupOrder: (e.groupOrder || []).slice(),
      columnOrder: canon(e.columnOrder || {}),
      hiddenColumns: canon(e.hiddenColumns || {}),
      hiddenGroups: canon(e.hiddenGroups || {})
    };
    if (out.scope === 'all') {
      out.filters = canon(e.filters || {});
      out.look = canon(e.look || {});
    }
    return out;
  }

  AE.layoutScope = scopeOf;

  /** What a row should say it stores. */
  AE.layoutScopeLabel = function (e) {
    return scopeOf(e) === 'all' ? '列 + 筛选 + 外观' : '列';
  };

  /** Does the live table already match this stored layout, at its own scope? */
  AE.sameLayout = function (s, saved) {
    return JSON.stringify(liveShape(s, scopeOf(saved))) === JSON.stringify(savedShape(saved));
  };

  function list() {
    var s = AE.state.settings;
    if (!Array.isArray(s.layouts)) s.layouts = [];
    return s.layouts;
  }

  AE.layouts = list;
  /**
   * Which saved layout `s` currently matches, or '' for none.
   *
   * Prefers the one last applied or saved (`s.activeLayout`) as long as it still
   * matches. Two presets can legitimately be indistinguishable at the NARROWER
   * one's scope -- a 'cols' preset matches whenever its columns match, whatever a
   * wider preset did to the filters -- so taking the first hit in array order
   * made the wider preset look like it never switched: you picked 方案3, the
   * filters and skin did change, and the label snapped back to 方案1.
   *
   * Pure on purpose (takes settings, reads no module state) so it is testable.
   */
  AE.pickActiveLayout = function (s) {
    var all = ((s && s.layouts) || []).filter(function (l) { return l && l.name; });
    var i;
    for (i = 0; i < all.length; i++) {
      if (all[i].name === s.activeLayout && AE.sameLayout(s, all[i])) return all[i].name;
    }
    for (i = 0; i < all.length; i++) {
      if (AE.sameLayout(s, all[i])) return all[i].name;
    }
    return '';
  };

  /** Name of the saved layout the table currently matches, or '' for none. */
  AE.activeLayoutName = function () {
    return AE.pickActiveLayout(AE.state.settings);
  };

  AE.applyLayout = function (name) {
    var s = AE.state.settings;
    var found = null;
    list().forEach(function (l) { if (l && l.name === name) found = l; });
    if (!found) return false;

    var sh = savedShape(found);
    s.groupOrder = sh.groupOrder;
    s.columnOrder = sh.columnOrder;
    s.hiddenColumns = sh.hiddenColumns;
    s.hiddenGroups = sh.hiddenGroups;

    if (sh.scope === 'all') {
      // Only keys the preset actually stored, so a preset written by an older
      // build does not blank a setting it never heard of.
      FILTER_KEYS.forEach(function (k) {
        if (sh.filters[k] !== undefined) s[k] = sh.filters[k];
      });
      LOOK_KEYS.forEach(function (k) {
        if (sh.look[k] !== undefined) s[k] = sh.look[k];
      });
    }

    s.activeLayout = name;
    AE.rebuild();
    if (sh.scope === 'all') {
      // rebuild() does not touch appearance or the row filter.
      AE.refresh();
      if (AE.repaintThemeSwitch) AE.repaintThemeSwitch();
    }
    // The checkbox tree mirrors hiddenColumns / hiddenGroups, so it has to follow.
    AE.buildSettingsPanel();
    return true;
  };

  /**
   * Save the live state under `name`, replacing a same-named layout.
   * `scope` defaults to the existing entry's scope when overwriting, so 覆盖 never
   * silently promotes a columns-only preset into one that also moves your filters.
   */
  AE.saveLayout = function (name, scope) {
    name = String(name || '').trim();
    if (!name) return false;
    var s = AE.state.settings;

    var all = list();
    var at = -1;
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].name === name) at = i;
    if (scope === undefined) scope = (at >= 0) ? scopeOf(all[at]) : 'cols';

    var entry = liveShape(s, scope);
    entry.name = name;
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
