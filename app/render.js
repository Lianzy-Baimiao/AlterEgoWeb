/*
 * WowAltBoard - app/render.js
 *
 * Builds the table DOM exactly once, then drives all show/hide through a single
 * generated <style> block. With ~16 rows x ~60 columns there are ~960 cells;
 * regenerating them on every checkbox click is what makes a page like this feel
 * laggy, and virtualization at this size would only break Ctrl+F, text
 * selection and printing. One style recalc instead.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;
  var doc = global.document;

  var state = {
    model: null,
    settings: null,
    columns: null,
    rows: [],           // {ch, tr}
    styleEl: null,
    ctx: null
  };

  AE.state = state;

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function save() { AE.saveSettings(state.settings); }

  // ------------------------------------------------------------------ filtering

  /** Is this character currently visible under the active filters? */
  function isVisible(ch) {
    var s = state.settings;
    if (s.hiddenSources[ch.sourceId]) return false;
    if (s.hiddenRealms[ch.realm]) return false;
    if (s.hiddenCharacters[ch.key]) return false;

    if (s.enabledMode === 'game' && !ch.enabled) return false;

    if (s.minLevel && ch.level < s.minLevel) return false;
    if (s.hideZeroRating && !ch.mp.rating) return false;
    if (s.hideStaleDays && ch.lastUpdateDays != null && ch.lastUpdateDays > s.hideStaleDays) return false;

    if (s.search) {
      var q = s.search.toLowerCase();
      var hay = (ch.name + ' ' + ch.realm + ' ' + ch.className + ' ' + ch.guildName).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }

    if (s.weeklyActiveOnly && !isWeeklyActive(ch)) return false;

    return true;
  }

  /**
   * "Active this week" answers the question the dashboard actually exists for:
   * who still owes a vault slot or a key run. Refreshed-since-reset plus any
   * unfinished vault row.
   */
  function isWeeklyActive(ch) {
    var reset = state.model.weeklyReset;
    // weeklyReset is the epoch of the NEXT reset, so the current week began a
    // week earlier.
    var weekStart = reset ? reset - 7 * 86400 : 0;
    if (weekStart && ch.lastUpdate < weekStart) return false;
    if (ch.mp.runsThisWeek.total > 0) return true;
    if (ch.vault.hasAvailableRewards) return true;
    var any = false;
    L.vaultTypeOrder.forEach(function (t) {
      var s = AE.vaultSummary(ch, t);
      if (s && s.unlocked > 0) any = true;
    });
    return any;
  }

  function visibleCharacters() {
    return state.model.characters.filter(isVisible);
  }

  // ------------------------------------------------------------------- sorting

  function colById(id) {
    for (var i = 0; i < state.columns.length; i++) {
      if (state.columns[i].id === id) return state.columns[i];
    }
    return null;
  }

  function applySort() {
    var s = state.settings;
    var col = colById(s.sortColumn) || colById('mpRating');
    var dir = s.sortDir === 'asc' ? 1 : -1;

    var sorted = state.rows.slice().sort(function (a, b) {
      var va = col.sort(a.ch), vb = col.sort(b.ch);
      if (typeof va === 'string' || typeof vb === 'string') {
        var r = String(va).localeCompare(String(vb), 'zh-Hans-CN');
        if (r !== 0) return r * dir;
      } else {
        if (va !== vb) return (va < vb ? -1 : 1) * dir;
      }
      // Stable, meaningful tie-break. Beats multi-level sort at this row count.
      var rr = a.ch.realm.localeCompare(b.ch.realm, 'zh-Hans-CN');
      if (rr !== 0) return rr;
      return a.ch.name.localeCompare(b.ch.name, 'zh-Hans-CN');
    });

    var tbody = doc.getElementById('tbody');
    sorted.forEach(function (r) { tbody.appendChild(r.tr); });

    // Header arrows.
    var ths = doc.querySelectorAll('#thead th[data-col]');
    for (var i = 0; i < ths.length; i++) {
      ths[i].classList.remove('sorted-asc', 'sorted-desc');
      if (ths[i].getAttribute('data-col') === col.id) {
        ths[i].classList.add(s.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    }
  }

  // ------------------------------------------------- visibility via one <style>

  function updateVisibility() {
    var s = state.settings;
    var parts = [];
    var visiblePerGroup = {};

    state.columns.forEach(function (c) {
      var hidden = s.hiddenGroups[c.group] || s.hiddenColumns[c.id];
      if (hidden) {
        parts.push('[data-col="' + cssEscape(c.id) + '"]{display:none}');
      } else {
        visiblePerGroup[c.group] = (visiblePerGroup[c.group] || 0) + 1;
      }
    });

    // The group band spans its group's columns, so its colSpan must track the
    // VISIBLE count. display:none removes a cell from the row entirely, so a
    // stale colSpan shifts every band to the right of a hidden column -- which
    // is exactly the "宝库 sitting under 大秘境" misalignment.
    var bands = doc.querySelectorAll('#thead tr.group-band th[data-group]');
    for (var i = 0; i < bands.length; i++) {
      var g = bands[i].getAttribute('data-group');
      var n = visiblePerGroup[g] || 0;
      if (n === 0) {
        bands[i].style.display = 'none';
      } else {
        bands[i].style.display = '';
        bands[i].colSpan = n;
      }
    }

    // Freezing follows the leftmost VISIBLE column instead of a fixed one: any
    // group can be dragged to the front now, and a frozen column sitting in the
    // middle of the table just looks broken.
    var sid = stickyColumnId();
    if (sid !== state.stickyId) {
      setSticky(state.stickyId, false);
      setSticky(sid, true);
      state.stickyId = sid;
    }

    var shown = 0;
    state.rows.forEach(function (r) {
      if (isVisible(r.ch)) { r.tr.style.display = ''; shown++; }
      else { r.tr.style.display = 'none'; }
    });

    state.styleEl.textContent = parts.join('\n');
    renderFooter(shown);
  }

  // Column ids contain ':' and '/', which are not valid unquoted in a selector.
  // We always quote the attribute value, so only " and \ need escaping.
  function cssEscape(v) { return String(v).replace(/(["\\])/g, '\\$1'); }

  /** The leftmost column that is not hidden -- the one that gets frozen. */
  function stickyColumnId() {
    var s = state.settings;
    for (var i = 0; i < state.columns.length; i++) {
      var c = state.columns[i];
      if (!s.hiddenGroups[c.group] && !s.hiddenColumns[c.id]) return c.id;
    }
    return null;
  }

  function setSticky(id, on) {
    if (!id) return;
    var nodes = doc.querySelectorAll('#grid [data-col="' + cssEscape(id) + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sticky-col', on);
  }

  function renderFooter(shown) {
    var total = state.model.characters.length;
    var vis = visibleCharacters();
    var gold = 0;
    vis.forEach(function (ch) { gold += ch.gold; });

    var f = doc.getElementById('footer-info');
    f.textContent = '显示 ' + shown + ' / ' + total + ' 个角色' +
      (vis.length ? '　·　金币合计 ' + AE.fmt.group3(gold) : '');
  }

  // ------------------------------------------------------------- table building

  function buildTable() {
    var table = doc.getElementById('grid');
    table.innerHTML = '';

    var ctx = state.ctx;
    var colgroup = el('colgroup');
    state.columns.forEach(function (c) {
      var cg = el('col');
      cg.style.width = c.width + 'px';
      cg.setAttribute('data-col', c.id);
      colgroup.appendChild(cg);
    });
    table.appendChild(colgroup);

    // ---- two header rows: group band, then column names
    var thead = el('thead');
    thead.id = 'thead';

    // Bands come from contiguous RUNS of the ordered columns, not from AE.GROUPS:
    // whole groups can be dragged around now, and a group with no columns at all
    // (no BagSync -> no 专业) must not leave an empty band behind. Ordering
    // guarantees one run per group -- see AE.orderColumns.
    var bandRow = el('tr', 'group-band');
    var run = null;
    state.columns.forEach(function (c) {
      var g = AE.groupById(c.group);
      if (run && run.group === c.group) {
        run.n++;
        run.th.colSpan = run.n;
        return;
      }
      var th = el('th', 'band band-' + c.group);
      th.setAttribute('data-group', c.group);
      th.colSpan = 1;
      th.title = (g ? g.label : c.group) +
                 '\n（按住左右拖动可以整组换位置）';
      run = { group: c.group, n: 1, th: th };
      // A wide group (36 currency columns) would centre its label far off to the
      // right, out of the viewport. Sticky keeps it visible while scrolling.
      th.appendChild(el('span', 'band-label', g ? g.label : c.group));
      bandRow.appendChild(th);
    });
    thead.appendChild(bandRow);

    state.stickyId = stickyColumnId();

    var headRow = el('tr');
    state.columns.forEach(function (c) {
      var th = el('th', 'col-' + c.group + (c.id === state.stickyId ? ' sticky-col' : ''));
      th.setAttribute('data-col', c.id);
      th.setAttribute('data-group', c.group);
      th.style.textAlign = c.align;
      th.appendChild(el('span', null, AE.colLabel(c, ctx)));
      th.title = AE.colHeadTitle(c, ctx) +
                 '\n（点击排序；按住左右拖动可以在本组内换位置）';
      th.addEventListener('click', function () {
        if (state.settings.sortColumn === c.id) {
          state.settings.sortDir = state.settings.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.settings.sortColumn = c.id;
          state.settings.sortDir = 'desc';
        }
        save();
        applySort();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // ---- body
    var tbody = el('tbody');
    tbody.id = 'tbody';
    state.rows = [];

    state.model.characters.forEach(function (ch) {
      var tr = el('tr');
      tr.setAttribute('data-guid', ch.guid);
      // Row identity is source+guid, since the same GUID could in principle turn
      // up under two account folders. export.js reads this back.
      tr.setAttribute('data-rowkey', ch.key);
      if (ch.vault.hasAvailableRewards) tr.className = 'has-reward';

      state.columns.forEach(function (c) {
        var td = el('td', 'col-' + c.group + (c.id === state.stickyId ? ' sticky-col' : ''));
        td.setAttribute('data-col', c.id);
        td.style.textAlign = c.align;
        try {
          c.render(td, ch, ctx);
        } catch (e) {
          td.textContent = '!';
          td.title = '渲染出错: ' + e.message;
        }
        tr.appendChild(td);
      });

      tr.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('a')) return;
        AE.openDrawer(ch);
      });

      tbody.appendChild(tr);
      state.rows.push({ ch: ch, tr: tr });
    });

    table.appendChild(tbody);
  }

  // ------------------------------------------------------------------- header

  function renderTopBar() {
    var m = state.model;
    doc.getElementById('scan-time').textContent = m.scannedAtLocal || '?';
    var seasonEl = doc.getElementById('season-info');
    seasonEl.textContent = (m.season && m.season.label) || ('赛季 ' + m.activeSeason);
    seasonEl.title = '赛季 ID ' + m.activeSeason +
      (m.season && m.season.english ? '\n' + m.season.english : '') +
      '\n中文名是从宝库要求文案里还原的';

    // Version label first and unconditionally. It used to be written by
    // renderUpdateBanner(), which is called at the END of the warnings block --
    // below an early return. So dismissing the 「注意」 banner took the version
    // number away with it, and on a clean scan the update notice never appeared
    // at all. It is the one thing every bug report needs, so it is now the one
    // thing nothing can suppress.
    var ver = doc.getElementById('version-info');
    if (ver) {
      var u = m.update || {};
      ver.textContent = 'v' + (m.toolVersion || '?');
      var tip = ['看板 v' + (m.toolVersion || '?')];
      tip.push('AlterEgo 插件 ' + (m.addonVersion || '未知'));
      tip.push('扫描于 ' + (m.scannedAtLocal || '?'));
      if (u.checked && u.latestVersion) tip.push('最新发布 ' + u.latestVersion);
      else if (u.error) tip.push('更新检查未完成：' + u.error);
      ver.title = tip.join('\n');
    }

    renderWarnings(m);
    renderUpdateBanner();
  }

  function renderWarnings(m) {
    var warn = [];
    m.sources.forEach(function (s) {
      if (s.parseError) warn.push(s.displayName + '：解析失败');
      else if (s.seasonMismatch) warn.push(s.displayName + '：旧赛季数据');
      else if (s.stale) warn.push(s.displayName + '：' + s.ageDays + ' 天未更新');
      if (s.degraded) warn.push(s.displayName + '：使用了备份文件');
    });
    m.scanErrors.forEach(function (e) { warn.push('读取失败：' + e.path); });

    var box = doc.getElementById('warnings');
    var text = warn.join('　·　');
    // Keyed by content, so dismissing today's warning does not hide a different
    // one tomorrow.
    var sig = signature(text);
    if (!warn.length || state.settings.dismissedWarning === sig) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    doc.getElementById('warning-text').textContent = text;
    var close = doc.getElementById('warning-close');
    close.onclick = function () {
      state.settings.dismissedWarning = sig;
      save();
      box.style.display = 'none';
    };
  }

  function signature(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  }

  /**
   * Update notice as a dismissible banner, matching the 注意 banner.
   *
   * Deliberately silent when the check did not succeed: on a Chinese network
   * api.github.com is frequently unreachable, and "couldn't check for updates"
   * every single launch is noise, not information. The version number in the
   * header is written by renderTopBar regardless, so nothing is hidden.
   */
  function renderUpdateBanner() {
    var m = state.model;
    var u = m.update || {};

    var box = doc.getElementById('update-banner');
    if (!box) return;

    if (!u.checked || !u.latestVersion) { box.style.display = 'none'; return; }

    var latest = String(u.latestVersion).replace(/^v/, '');
    var cur = String(u.currentVersion || m.toolVersion || '').replace(/^v/, '');
    if (compareVersions(latest, cur) <= 0) { box.style.display = 'none'; return; }

    var sig = 'update:' + latest;
    if (state.settings.dismissedUpdate === sig) { box.style.display = 'none'; return; }

    box.style.display = '';
    doc.getElementById('update-text').textContent =
      '有新版本 ' + u.latestVersion + '（当前 v' + cur + '）' +
      (u.publishedAt ? '　发布于 ' + u.publishedAt.slice(0, 10) : '');
    var link = doc.getElementById('update-link');
    link.href = u.url;
    doc.getElementById('update-close').onclick = function () {
      // Keyed by version, so the next release still announces itself.
      state.settings.dismissedUpdate = sig;
      save();
      box.style.display = 'none';
    };
  }

  /** Numeric-segment version compare; non-numeric suffixes are ignored. */
  function compareVersions(a, b) {
    var pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
      if (isNaN(na)) na = 0;
      if (isNaN(nb)) nb = 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  }

  AE.compareVersions = compareVersions;

  // ------------------------------------------------------------- appearance

  /**
   * Skin, font and size are applied as CSS custom properties on <html> so a
   * change is one style recalculation, never a re-render.
   */
  function applyAppearance() {
    var s = state.settings;
    var root = doc.documentElement;

    doc.body.setAttribute('data-theme', s.theme);
    doc.body.setAttribute('data-skin', s.skin);

    var skin = null;
    for (var i = 0; i < AE.SKINS.length; i++) { if (AE.SKINS[i].id === s.skin) skin = AE.SKINS[i]; }
    if (skin) {
      root.style.setProperty('--accent', skin.accent);
      root.style.setProperty('--bg', s.theme === 'light' ? skin.light : skin.dark);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--bg');
    }

    var font = null;
    for (var j = 0; j < AE.FONTS.length; j++) { if (AE.FONTS[j].id === s.fontFamily) font = AE.FONTS[j]; }
    root.style.setProperty('--font', font ? font.css : AE.FONTS[0].css);

    var size = Math.max(10, Math.min(18, Number(s.fontSize) || 12));
    root.style.setProperty('--table-size', size + 'px');
    root.style.setProperty('--ui-size', (size + 1) + 'px');

    applyThemeColor();
  }

  /**
   * Hand the current header colour to the browser as <meta name="theme-color">.
   *
   * The launcher opens the page with --app=, and a Chromium app window paints
   * its title bar from theme-color. Without this the title bar follows the OS
   * setting, so a dark page could sit under a white title bar (and vice versa).
   * --bg2 is the <header> background, so the title bar and the button strip
   * directly beneath it read as one surface. Reading it back from the cascade
   * rather than duplicating the value here keeps it right for every skin/theme
   * combination without a second colour table.
   */
  function applyThemeColor() {
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var c = global.getComputedStyle(doc.body).getPropertyValue('--bg2');
    c = String(c || '').trim();
    if (c) meta.setAttribute('content', c);
  }

  AE.applyAppearance = applyAppearance;

  // -------------------------------------------------------------- public entry

  AE.render = function (model, settings) {
    state.model = model;
    state.settings = settings;
    state.columns = AE.orderColumns(AE.buildColumns(model), settings);
    state.ctx = { model: model, settings: settings };

    // Seed column defaults on first run: honour the addon's own hidden-currency
    // choice, each column's defaultHidden, and hide previous expansions'
    // currencies (30+ columns of dead crests otherwise).
    if (!Object.keys(settings.hiddenColumns).length) {
      var offSeason = model.columns.offSeasonCurrencies || {};
      state.columns.forEach(function (c) {
        if (c.defaultHidden) settings.hiddenColumns[c.id] = true;
        if (!c.currencyId) return;
        if (model.gamePrefs.hiddenCurrencies.indexOf(c.currencyId) >= 0) {
          settings.hiddenColumns[c.id] = true;
        }
        if (offSeason[c.currencyId]) settings.hiddenColumns[c.id] = true;
      });
    }

    if (!state.styleEl) {
      state.styleEl = el('style');
      state.styleEl.id = 'visibility-rules';
      doc.head.appendChild(state.styleEl);
    }

    applyAppearance();
    renderTopBar();
    buildTable();
    AE.buildSettingsPanel();
    updateVisibility();
    applySort();
  };

  /** Re-apply everything that can change without rebuilding cells. */
  AE.refresh = function () {
    applyAppearance();
    updateVisibility();
    applySort();
    save();
    // Hiding a column changes the layout's shape, so the picker's
    // 当前（未保存） state has to follow. Guarded: layouts.js loads after this.
    if (AE.renderLayoutPicker) AE.renderLayoutPicker();
  };

  /** Header text depends on settings (abbr vs full), so this needs a rebuild. */
  AE.rebuild = function () {
    // Re-derive the column list every time, so a drag-reorder, a layout switch
    // and a header-mode change all go down one code path.
    state.columns = AE.orderColumns(AE.buildColumns(state.model), state.settings);
    save();
    buildTable();
    updateVisibility();
    applySort();
    if (AE.renderLayoutPicker) AE.renderLayoutPicker();
  };

  AE.isWeeklyActive = isWeeklyActive;
  AE.visibleCharacters = visibleCharacters;
  AE.colById = colById;

})(typeof window !== 'undefined' ? window : globalThis);
