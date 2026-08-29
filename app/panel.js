/*
 * AlterEgoWeb - app/panel.js
 *
 * The settings drawer (left) and the per-character detail drawer (right).
 * All checkboxes are generated from the column registry in columns.js, so
 * adding a column never means touching this file.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;
  var doc = global.document;

  var SUPPORT_URL = 'https://ifdian.net/a/lianzy';

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // `key` is a stable identity for the section, independent of the title -- the
  // titles carry counts ('角色（12）') that change between builds, so they cannot
  // be used to match a section to its previous open/closed state.
  function section(key, title, opts) {
    var d = el('details', 'sec');
    d.setAttribute('data-sec', key);
    if (opts && opts.open) d.open = true;
    d.appendChild(el('summary', null, title));
    return d;
  }

  // Every checkbox built by check() below, with the getter that decides its
  // state. The bulk 全选 / 全不选 buttons flip a lot of settings at once and then
  // need the boxes to agree with them; re-reading the getters does that without
  // rebuilding the panel. Rebuilding is what used to make the drawer jump back
  // to the top -- clearing #panel-body resets its scrollTop and collapses every
  // <details> the user had opened.
  var checkBoxes = [];

  AE.syncSettingsChecks = function () {
    for (var i = 0; i < checkBoxes.length; i++) {
      checkBoxes[i].box.checked = !!checkBoxes[i].get();
    }
  };

  /** Checkbox row. `get` reads current state, `set(v)` applies it. */
  function check(label, get, set, hint) {
    var lab = el('label', 'chk');
    var box = el('input');
    box.type = 'checkbox';
    box.checked = !!get();
    box.addEventListener('change', function () { set(box.checked); });
    checkBoxes.push({ box: box, get: get });
    lab.appendChild(box);
    lab.appendChild(el('span', null, label));
    if (hint) {
      var h = el('span', 'hint', hint);
      lab.appendChild(h);
    }
    return lab;
  }

  function numberInput(label, value, min, max, onChange) {
    var wrap = el('label', 'field');
    wrap.appendChild(el('span', null, label));
    var inp = el('input');
    inp.type = 'number';
    inp.value = value;
    if (min != null) inp.min = min;
    if (max != null) inp.max = max;
    inp.addEventListener('change', function () { onChange(Number(inp.value)); });
    wrap.appendChild(inp);
    return wrap;
  }

  /** Labelled <select> bound to a settings key. */
  function selectField(label, value, options, onChange, hint) {
    var wrap = el('div', 'field');
    wrap.appendChild(el('span', null, label));
    var sel = el('select');
    options.forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      if (String(value) === String(o[0])) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    wrap.appendChild(sel);
    if (hint) wrap.appendChild(el('span', 'hint', hint));
    return wrap;
  }

  /** Labelled text input bound to a settings key. */
  function textField(label, value, placeholder, onChange) {
    var wrap = el('label', 'field');
    wrap.appendChild(el('span', null, label));
    var inp = el('input');
    inp.type = 'text';
    inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('change', function () { onChange(inp.value.trim()); });
    wrap.appendChild(inp);
    return wrap;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls || null, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ------------------------------------------------------------------- panel

  // A full rebuild is still needed when the panel's own contents change shape
  // (the 角色显示依据 dropdown rewrites the filter fields; a reparse changes the
  // column list). Carry the scroll offset and the open sections across it so the
  // rebuild is invisible. Both are read and reapplied in one synchronous pass, so
  // the browser never paints the intermediate state.
  function capturePanelState(panel) {
    var open = {};
    var secs = panel.querySelectorAll('details.sec');
    for (var i = 0; i < secs.length; i++) {
      var k = secs[i].getAttribute('data-sec');
      if (k) open[k] = secs[i].open;
    }
    return { top: panel.scrollTop, open: open };
  }

  function restorePanelState(panel, prev) {
    if (!prev) return;
    var secs = panel.querySelectorAll('details.sec');
    for (var i = 0; i < secs.length; i++) {
      var k = secs[i].getAttribute('data-sec');
      if (k && Object.prototype.hasOwnProperty.call(prev.open, k)) secs[i].open = prev.open[k];
    }
    panel.scrollTop = prev.top;
  }

  AE.buildSettingsPanel = function () {
    var st = AE.state;
    var s = st.settings;
    var m = st.model;
    var panel = doc.getElementById('panel-body');
    var prev = panel.childNodes.length ? capturePanelState(panel) : null;
    panel.innerHTML = '';
    checkBoxes = [];

    // ---- filters ---------------------------------------------------------
    var filt = section('filters', '筛选', { open: true });

    var searchWrap = el('label', 'field');
    searchWrap.appendChild(el('span', null, '搜索'));
    var search = el('input');
    search.type = 'search';
    search.placeholder = '角色 / 服务器 / 公会';
    search.value = s.search;
    search.addEventListener('input', function () {
      s.search = search.value.trim();
      AE.refresh();
    });
    searchWrap.appendChild(search);
    filt.appendChild(searchWrap);

    filt.appendChild(check('只看本周活跃', function () { return s.weeklyActiveOnly; },
      function (v) { s.weeklyActiveOnly = v; AE.refresh(); },
      '本周登录过且有进度'));

    filt.appendChild(check('隐藏 0 评分角色', function () { return s.hideZeroRating; },
      function (v) { s.hideZeroRating = v; AE.refresh(); }));

    filt.appendChild(numberInput('最低等级', s.minLevel, 1, 90, function (v) {
      s.minLevel = v; AE.refresh();
    }));

    filt.appendChild(numberInput('隐藏 N 天未更新（0=关闭）', s.hideStaleDays, 0, 3650, function (v) {
      s.hideStaleDays = v; AE.refresh();
    }));

    // The addon's own `enabled` flag is NOT trustworthy as a default here: on
    // this machine a level-80 character is enabled:false while a level-10 one is
    // enabled:true. So it is offered, not assumed.
    var modeWrap = el('div', 'field');
    modeWrap.appendChild(el('span', null, '角色显示依据'));
    var sel = el('select');
    [['custom', '自定义（按上面的筛选）'], ['game', '跟随游戏内设置'], ['all', '全部显示']]
      .forEach(function (o) {
        var op = el('option', null, o[1]);
        op.value = o[0];
        if (s.enabledMode === o[0]) op.selected = true;
        sel.appendChild(op);
      });
    sel.addEventListener('change', function () {
      s.enabledMode = sel.value;
      if (sel.value === 'all') { s.minLevel = 1; s.hideZeroRating = false; s.hideStaleDays = 0; }
      AE.buildSettingsPanel();
      AE.refresh();
    });
    modeWrap.appendChild(sel);
    filt.appendChild(modeWrap);
    panel.appendChild(filt);

    // ---- data sources ----------------------------------------------------
    var src = section('sources', '数据源（' + m.sources.length + '）', { open: true });
    m.sources.forEach(function (so) {
      var row = el('div', 'source-row');

      var head = el('div', 'source-head');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = !s.hiddenSources[so.id];
      box.addEventListener('change', function () {
        if (box.checked) delete s.hiddenSources[so.id];
        else s.hiddenSources[so.id] = true;
        AE.refresh();
      });
      head.appendChild(box);

      var alias = el('input', 'alias');
      alias.type = 'text';
      alias.value = s.sourceAliases[so.id] || '';
      alias.placeholder = so.account;
      alias.title = '给这个战网账号起个好记的别名';
      alias.addEventListener('change', function () {
        var v = alias.value.trim();
        if (v) s.sourceAliases[so.id] = v;
        else delete s.sourceAliases[so.id];
        AE.rebuild();
      });
      head.appendChild(alias);
      row.appendChild(head);

      var meta = el('div', 'source-meta');
      meta.appendChild(el('span', null, so.charCount + ' 个角色'));
      meta.appendChild(el('span', null, 'dbVer ' + so.dbVersion));
      meta.appendChild(el('span', null, so.mtimeLocal));
      row.appendChild(meta);

      // Warnings here are the difference between "the tool is broken" and "this
      // account's data is 155 days old".
      var flags = el('div', 'source-flags');
      if (so.parseError) flags.appendChild(el('span', 'badge bad', '解析失败'));
      if (so.seasonMismatch) flags.appendChild(el('span', 'badge warn', '旧赛季 ' + so.seasons.join('/')));
      if (so.stale) flags.appendChild(el('span', 'badge warn', so.ageDays + ' 天未更新'));
      if (so.degraded) flags.appendChild(el('span', 'badge warn', '使用备份'));
      if (flags.childNodes.length) row.appendChild(flags);

      var path = el('div', 'source-path', so.path);
      path.title = so.path;
      row.appendChild(path);

      src.appendChild(row);
    });
    panel.appendChild(src);

    // ---- realms ----------------------------------------------------------
    var realmSec = section('realms', '服务器（' + m.realms.length + '）');
    m.realms.forEach(function (r) {
      realmSec.appendChild(check(r.name,
        function () { return !s.hiddenRealms[r.name]; },
        function (v) {
          if (v) delete s.hiddenRealms[r.name];
          else s.hiddenRealms[r.name] = true;
          AE.refresh();
        },
        r.count + ' 个'));
    });
    panel.appendChild(realmSec);

    // ---- characters ------------------------------------------------------
    var charSec = section('chars', '角色（' + m.characters.length + '）');
    var quick = el('div', 'row-buttons');
    quick.appendChild(button('全选', 'mini', function () {
      s.hiddenCharacters = {};
      AE.syncSettingsChecks();
      AE.refresh();
    }));
    quick.appendChild(button('全不选', 'mini', function () {
      m.characters.forEach(function (ch) { s.hiddenCharacters[ch.key] = true; });
      AE.syncSettingsChecks();
      AE.refresh();
    }));
    charSec.appendChild(quick);

    m.characters.slice().sort(function (a, b) {
      var r = a.realm.localeCompare(b.realm, 'zh-Hans-CN');
      return r !== 0 ? r : a.name.localeCompare(b.name, 'zh-Hans-CN');
    }).forEach(function (ch) {
      var lab = check(ch.name,
        function () { return !s.hiddenCharacters[ch.key]; },
        function (v) {
          if (v) delete s.hiddenCharacters[ch.key];
          else s.hiddenCharacters[ch.key] = true;
          AE.refresh();
        },
        ch.realm + ' · ' + ch.level + ' 级');
      var dot = lab.querySelector('span');
      if (dot) dot.style.color = ch.classColor;
      charSec.appendChild(lab);
    });
    panel.appendChild(charSec);

    // ---- columns ---------------------------------------------------------
    var colSec = section('columns', '显示的列');

    // The group checkbox hides the whole band in one go; 全选 / 全不选 operate on
    // the individual columns inside it. They are different things: unchecking the
    // group keeps your per-column choices for when you switch it back on.
    var colTop = el('div', 'row-buttons');
    colTop.appendChild(button('全部显示', 'mini', function () {
      s.hiddenGroups = {};
      s.hiddenColumns = {};
      AE.syncSettingsChecks();
      AE.refresh();
    }));
    colTop.appendChild(button('只留基础', 'mini', function () {
      s.hiddenGroups = {};
      s.hiddenColumns = {};
      AE.GROUPS.forEach(function (g) {
        if (g.id !== 'base') s.hiddenGroups[g.id] = true;
      });
      AE.syncSettingsChecks();
      AE.refresh();
    }));
    colSec.appendChild(colTop);

    AE.GROUPS.forEach(function (g) {
      var groupCols = st.columns.filter(function (c) { return c.group === g.id; });
      if (!groupCols.length) return;

      var box = el('div', 'col-group');

      var head = el('div', 'col-group-head');
      head.appendChild(check(g.label + '（' + groupCols.length + '）',
        function () { return !s.hiddenGroups[g.id]; },
        function (v) {
          if (v) delete s.hiddenGroups[g.id];
          else s.hiddenGroups[g.id] = true;
          AE.refresh();
        }));

      var groupBtns = el('span', 'col-group-btns');
      groupBtns.appendChild(button('全选', 'mini', function () {
        groupCols.forEach(function (c) { delete s.hiddenColumns[c.id]; });
        delete s.hiddenGroups[g.id];
        AE.syncSettingsChecks();
        AE.refresh();
      }));
      groupBtns.appendChild(button('全不选', 'mini', function () {
        groupCols.forEach(function (c) { s.hiddenColumns[c.id] = true; });
        AE.syncSettingsChecks();
        AE.refresh();
      }));
      head.appendChild(groupBtns);
      box.appendChild(head);

      var sub = el('div', 'col-list');
      groupCols.forEach(function (c) {
        sub.appendChild(check(AE.colLabel(c, st.ctx),
          function () { return !s.hiddenColumns[c.id]; },
          function (v) {
            if (v) delete s.hiddenColumns[c.id];
            else s.hiddenColumns[c.id] = true;
            AE.refresh();
          }));
      });
      box.appendChild(sub);
      colSec.appendChild(box);
    });
    panel.appendChild(colSec);

    // ---- appearance ------------------------------------------------------
    var look = section('look', '显示效果');

    look.appendChild(selectField('皮肤', s.skin,
      AE.SKINS.map(function (k) { return [k.id, k.label]; }),
      function (v) { s.skin = v; AE.refresh(); }));

    look.appendChild(selectField('明暗', s.theme,
      [['dark', '深色'], ['light', '浅色']],
      function (v) {
        s.theme = v;
        AE.refresh();
        if (AE.repaintThemeSwitch) AE.repaintThemeSwitch();
      }));

    look.appendChild(selectField('字体', s.fontFamily,
      AE.FONTS.map(function (f) { return [f.id, f.label]; }),
      function (v) { s.fontFamily = v; AE.refresh(); }));

    var sizeWrap = el('div', 'field');
    sizeWrap.appendChild(el('span', null, '字号'));
    var range = el('input');
    range.type = 'range';
    range.min = 10;
    range.max = 18;
    range.step = 1;
    range.value = s.fontSize;
    var sizeLabel = el('span', 'hint', s.fontSize + ' px');
    range.addEventListener('input', function () {
      s.fontSize = Number(range.value);
      sizeLabel.textContent = s.fontSize + ' px';
      AE.applyAppearance();
    });
    range.addEventListener('change', function () { AE.refresh(); });
    sizeWrap.appendChild(range);
    sizeWrap.appendChild(sizeLabel);
    look.appendChild(sizeWrap);

    look.appendChild(check('职业颜色',
      function () { return s.classColors; },
      function (v) { s.classColors = v; AE.rebuild(); }));

    look.appendChild(check('货币显示上限（当前/上限）',
      function () { return s.currencyShowCap; },
      function (v) { s.currencyShowCap = v; AE.rebuild(); },
      '关掉只显示持有量'));

    // The real constraint with 60 columns is width, not row height -- so the
    // knob offered here is header length, not density.
    look.appendChild(selectField('副本表头', s.headerMode,
      [['short', '中文缩写（毒牙）'], ['full', '中文全名（毒牙祭坛）'], ['en', '英文缩写（AOF）']],
      function (v) { s.headerMode = v; AE.rebuild(); }));

    panel.appendChild(look);

    // ---- external links --------------------------------------------------
    var links = section('links', '外部主页');
    links.appendChild(el('p', 'note',
      'Raider.IO 的链接格式已经实测可用（服务器名用中文也能打开）。' +
      'Warcraft Logs 拒绝脚本访问，它的格式没能在本机验证，第一次点击请确认一下，' +
      '不对就在下面改地址。'));
    links.appendChild(textField('区域代码', s.links.region, 'cn',
      function (v) { s.links.region = v || 'cn'; AE.rebuild(); }));
    links.appendChild(textField('Raider.IO 前缀', s.links.rioBase,
      'https://raider.io/characters',
      function (v) { s.links.rioBase = v; AE.rebuild(); }));
    links.appendChild(textField('Warcraft Logs 前缀', s.links.wclBase,
      'https://www.warcraftlogs.com/character',
      function (v) { s.links.wclBase = v; AE.rebuild(); }));
    links.appendChild(selectField('服务器名形式', s.links.realmForm,
      [['localized', '中文原名（推荐）'], ['slug', '英文小写连字符']],
      function (v) { s.links.realmForm = v; AE.rebuild(); }));
    panel.appendChild(links);

    // ---- dungeon names ---------------------------------------------------
    var needFix = m.columns.dungeonIds.filter(function (id) {
      return L.dungeonNeedsTranslation(id, s.dungeonNameOverrides, m.dungeonNames);
    });
    var nameSec = section('dungeon-names', '副本名称' + (needFix.length ? '（' + needFix.length + ' 个缺中文名）' : ''));
    nameSec.appendChild(el('p', 'note',
      '中文名是从游戏自己的字符串里还原的：副本锁定记录，以及你身上钥石的物品名。' +
      '两个来源都没覆盖到的副本会显示英文名，可以在这里手动填写。' +
      '括号里是表头用的缩写。'));
    m.columns.dungeonIds.forEach(function (id) {
      var meta = m.tables.dungeonById[id];
      var wrap = el('label', 'field');
      var auto = L.dungeonLabel(id, meta, null, m.dungeonNames);
      // Show the Chinese name as the label; the English abbreviation alone made
      // this list unreadable.
      var short = m.dungeonShortNames[id] || '';
      var lab = el('span', null, auto + (short && short !== auto ? '（' + short + '）' : ''));
      lab.title = (meta && meta.abbr ? meta.abbr + '　' : '') +
                  (meta && meta.name ? meta.name + '　' : '') + 'cmID ' + id;
      wrap.appendChild(lab);
      var inp = el('input');
      inp.type = 'text';
      inp.placeholder = auto;
      inp.value = s.dungeonNameOverrides[id] || '';
      inp.addEventListener('change', function () {
        var v = inp.value.trim();
        if (v) s.dungeonNameOverrides[id] = v;
        else delete s.dungeonNameOverrides[id];
        AE.rebuild();
      });
      wrap.appendChild(inp);
      nameSec.appendChild(wrap);
    });
    panel.appendChild(nameSec);

    // ---- config ----------------------------------------------------------
    var cfg = section('config', '配置');
    cfg.appendChild(el('p', 'note',
      '浏览器的本地存储不会随文件夹一起复制。要把设置带走，点“保存设置到文件”，' +
      '下次运行启动脚本时会自动从下载文件夹收进 data/settings.js。'));

    var btns = el('div', 'row-buttons');
    btns.appendChild(button('保存设置到文件', null, function () {
      AE.downloadText('settings.js', AE.settingsFileText(s), 'text/javascript');
      AE.toast({
        title: '已导出 settings.js',
        body: '下次运行启动器时会自动从下载文件夹收进 data/settings.js。',
        kind: 'good', ms: 3000
      });
    }));
    btns.appendChild(button('导出 JSON', null, function () {
      AE.downloadText('alteregoweb-settings.json', JSON.stringify(s, null, 2), 'application/json');
      AE.toast({ title: '已导出 alteregoweb-settings.json', kind: 'good', ms: 3000 });
    }));

    var importBtn = button('导入 JSON', null, function () { fileInput.click(); });
    var fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.js';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var text = String(fr.result).replace(/^[\s\S]*?window\.AE_SETTINGS\s*=\s*/, '').replace(/;\s*$/, '');
          var o = JSON.parse(text);
          AE.applyImportedSettings(o);
        } catch (e) {
          global.alert('导入失败：' + e.message);
        }
      };
      fr.readAsText(f, 'utf-8');
    });
    btns.appendChild(importBtn);
    btns.appendChild(fileInput);

    btns.appendChild(button('恢复默认', 'danger', function () {
      if (!global.confirm('恢复所有设置为默认值？')) return;
      AE.applyImportedSettings(AE.settingsDefaults());
    }));
    cfg.appendChild(btns);

    cfg.appendChild(el('p', 'note',
      '设置来源：' + (AE.settingsOrigin || '默认') +
      (AE.storageOk ? '' : '　（浏览器本地存储不可用，改动不会被记住）')));

    // ---- update ----------------------------------------------------------
    // A real re-check needs the network, and file:// has none -- fetch and XHR
    // are both blocked. So the page can only report what the last scan found and
    // send the user somewhere useful; the actual re-check lives in the tray menu,
    // which can run scan.ps1 again.
    var up = (m.update || {});
    var upBox = el('div', 'update-box');
    var line = '当前 v' + (m.toolVersion || '?');
    if (up.checked && up.latestVersion) {
      var newer = AE.compareVersions(
        String(up.latestVersion).replace(/^v/, ''),
        String(up.currentVersion || m.toolVersion || '').replace(/^v/, '')) > 0;
      line += '　·　最新 ' + up.latestVersion + (newer ? '（有更新）' : '（已是最新）');
    } else if (up.error) {
      line += '　·　上次检查没成功';
    } else {
      line += '　·　未检查';
    }
    upBox.appendChild(el('div', null, line));
    if (up.error) {
      upBox.appendChild(el('div', 'hint2', String(up.error).slice(0, 120)));
    }

    var upBtns = el('div', 'row-buttons');
    upBtns.appendChild(button('检查更新', null, function () {
      // Opening an https URL from a file:// page is allowed; fetching is not.
      var url = (up.url && up.url.indexOf('http') === 0)
        ? up.url
        : ('https://github.com/' + (m.repo || 'Lianzy-Baimiao/AlterEgoWeb') + '/releases');
      global.open(url, '_blank', 'noopener');
      AE.toast({
        title: '已打开发布页',
        body: '网页本身不能联网（file:// 下 fetch 被禁）。要让程序重新查一次，' +
              '用托盘图标右键的「检查更新」。',
        ms: 5000
      });
    }));
    upBtns.appendChild(button('复制仓库地址', 'mini', function () {
      AE.copyWithToast('https://github.com/' + (m.repo || 'Lianzy-Baimiao/AlterEgoWeb'), null);
    }));
    upBox.appendChild(upBtns);
    cfg.appendChild(upBox);

    var about = el('p', 'note');
    about.appendChild(doc.createTextNode(
      'AlterEgoWeb v' + (m.toolVersion || '?') + '　作者 ' + (m.author || '白描') + '　'));
    if (m.repo) {
      var a = el('a', null, m.repo);
      a.href = 'https://github.com/' + m.repo;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      about.appendChild(a);
    }
    cfg.appendChild(about);
    panel.appendChild(cfg);

    // ---- support ----------------------------------------------------------
    // file:// can OPEN an https URL, it just cannot fetch one, so the button
    // works. 复制链接 is the fallback for a machine where the app-mode window has
    // nothing to hand the URL off to.
    var fund = section('support', '赞赏');
    fund.appendChild(el('p', 'note',
      '这个工具是免费的，没有广告也没有内购。如果它帮你省下了每周翻小号的时间，' +
      '可以去爱发电请我喝一杯 —— 完全自愿，不赞赏功能也一个都不少。'));
    var fundBtns = el('div', 'row-buttons');
    fundBtns.appendChild(button('打开赞赏页', null, function () {
      global.open(SUPPORT_URL, '_blank', 'noopener');
    }));
    fundBtns.appendChild(button('复制链接', 'mini', function () {
      AE.copyWithToast(SUPPORT_URL, '赞赏页地址');
    }));
    fund.appendChild(fundBtns);

    var fundLink = el('p', 'note');
    var fa = el('a', null, SUPPORT_URL);
    fa.href = SUPPORT_URL;
    fa.target = '_blank';
    fa.rel = 'noopener noreferrer';
    fundLink.appendChild(fa);
    fund.appendChild(fundLink);
    panel.appendChild(fund);

    restorePanelState(panel, prev);
  };

  AE.applyImportedSettings = function (o) {
    AE.saveSettings(o);
    global.location.reload();
  };

  // ------------------------------------------------------------------ drawer

  function kv(dl, k, v) {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v == null ? '·' : String(v)));
  }

  AE.openDrawer = function (ch) {
    var st = AE.state;
    var m = st.model;
    var s = st.settings;
    var d = doc.getElementById('drawer');
    var body = doc.getElementById('drawer-body');
    body.innerHTML = '';

    var title = doc.getElementById('drawer-title');
    title.textContent = ch.name;
    title.style.color = s.classColors ? ch.classColor : '';
    doc.getElementById('drawer-sub').textContent =
      ch.realm + '　·　' + ch.level + ' 级 ' + ch.raceName + ch.className +
      '　·　' + (s.sourceAliases[ch.sourceId] || ch.sourceName);

    // -- summary
    var sum = el('dl', 'kv');
    kv(sum, '装等', Math.ceil(ch.ilvl.value) + '（平均 ' + ch.ilvl.level.toFixed(1) +
      ' / 已装备 ' + ch.ilvl.equipped.toFixed(1) + '）');
    kv(sum, '大秘境评分', ch.mp.rating || '·');
    kv(sum, '赛季最佳', ch.mp.bestSeasonScore || '·');
    kv(sum, '公会', ch.guildName ? (ch.guildName + (ch.guildRank ? ' · ' + ch.guildRank : '')) : '·');
    kv(sum, '护甲类型', ch.armorType || '·');
    kv(sum, '金币', AE.fmt.group3(ch.gold));
    kv(sum, '最后更新', ch.lastUpdate ? new Date(ch.lastUpdate * 1000).toLocaleString() : '·');
    kv(sum, '数据赛季', ch.season || '未记录');
    body.appendChild(sum);

    // -- best runs per dungeon
    var runs = m.columns.dungeonIds.map(function (id) {
      return { id: id, d: ch.mp.byDungeon[id] };
    }).filter(function (x) { return x.d && (x.d.level || x.d.rating); });

    if (runs.length) {
      body.appendChild(el('h3', null, '各副本最佳'));
      var t = el('table', 'mini-table');
      var hr = el('tr');
      ['副本', '层数', '分数', '用时', '词缀', '日期'].forEach(function (h) {
        hr.appendChild(el('th', null, h));
      });
      t.appendChild(hr);
      runs.forEach(function (x) {
        var meta = m.tables.dungeonById[x.id];
        var best = x.d.bestTimedRun || x.d.bestNotTimedRun;
        var tr = el('tr');
        tr.appendChild(el('td', null,
          L.dungeonLabel(x.id, meta, s.dungeonNameOverrides, m.dungeonNames)));
        tr.appendChild(el('td', x.d.timed ? null : 'overtime',
          (x.d.level || '·') + (x.d.timed ? '' : ' 超时')));
        tr.appendChild(el('td', null, x.d.rating || '·'));
        tr.appendChild(el('td', null, best && best.durationSec
          ? Math.floor(best.durationSec / 60) + ':' + String(best.durationSec % 60).padStart(2, '0')
          : '·'));
        tr.appendChild(el('td', null, best && best.affixIDs
          ? AE.asArray(best.affixIDs).join(', ') : '·'));
        var cd = best && best.completionDate;
        tr.appendChild(el('td', null, cd && cd.year
          ? cd.year + '-' + String(cd.month).padStart(2, '0') + '-' + String(cd.monthDay).padStart(2, '0')
          : '·'));
        t.appendChild(tr);
      });
      body.appendChild(t);
    }

    // -- vault detail
    var anyVault = L.vaultTypeOrder.some(function (ty) { return AE.vaultSummary(ch, ty); });
    if (anyVault) {
      body.appendChild(el('h3', null, '宝库'));
      L.vaultTypeOrder.forEach(function (ty) {
        var vs = AE.vaultSummary(ch, ty);
        if (!vs) return;
        var blk = el('div', 'vault-block');
        blk.appendChild(el('h4', null, L.vaultTypeZh[ty] + '　' + vs.unlocked + '/' + vs.total));
        vs.slots.forEach(function (slot) {
          var line = el('div', 'vault-slot' + (slot.unlocked ? ' on' : ''));
          var lead = slot.progress + ' / ' + slot.threshold;
          line.appendChild(el('b', null, lead));
          var detail = '';
          if (slot.unlocked) {
            if (ty === L.VAULT_MPLUS && slot.level) {
              var ilvl = AE.vaultItemLevel(m, slot.level);
              detail = '钥石 +' + slot.level + (ilvl ? '　→ ' + ilvl + ' 装等' : '');
            } else if (ty === L.VAULT_RAID && slot.level) {
              detail = L.raidDifficultyZh[slot.level] || ('难度 ' + slot.level);
            } else if (ty === L.VAULT_WORLD && slot.level) {
              detail = slot.level + ' 层';
            }
            if (slot.exampleReward && slot.exampleReward.name) {
              var it = el('span', 'item-name', slot.exampleReward.name);
              if (slot.exampleReward.color) it.style.color = slot.exampleReward.color;
              line.appendChild(el('span', null, '　' + detail + '　'));
              line.appendChild(it);
              detail = '';
            }
          } else {
            detail = AE.vaultRequirement(ty, slot.threshold, slot.raidString);
          }
          if (detail) line.appendChild(el('span', null, '　' + detail));
          blk.appendChild(line);
        });
        body.appendChild(blk);
      });
    }

    // -- delves + treasure map
    if (ch.delves.tiers.length || ch.treasureMap) {
      body.appendChild(el('h3', null, '地下堡 / 藏宝图'));
      var dl = el('dl', 'kv');
      if (ch.delves.tiers.length) {
        kv(dl, '最高层数', ch.delves.maxTier + ' 层');
        kv(dl, '积分合计', ch.delves.points);
        ch.delves.tiers.forEach(function (t) {
          kv(dl, '难度 ' + t.difficulty, t.numPoints + ' 分');
        });
      }
      if (ch.treasureMap) {
        kv(dl, '藏宝图', ch.treasureMap.name);
        kv(dl, '背包持有', ch.treasureMap.bagCount + ' 张');
        kv(dl, '本周是否已用', ch.treasureMap.used ? '已用' : '未用');
        kv(dl, 'buff 在身', ch.treasureMap.hasBuff ? '生效中' : '无');
      }
      AE.asArray(ch.currencies.byType.delve).forEach(function (c) {
        kv(dl, c.name, AE.fmt.group3(c.quantity) + (c.maxQuantity ? ' / ' + AE.fmt.group3(c.maxQuantity) : ''));
      });
      body.appendChild(dl);
    }

    // -- raid lockouts
    var raidKeys = Object.keys(ch.raids.byKey);
    if (raidKeys.length) {
      body.appendChild(el('h3', null, '团队副本进度'));
      raidKeys.forEach(function (k) {
        var r = ch.raids.byKey[k];
        var blk = el('div', 'raid-block');
        blk.appendChild(el('h4', null, r.name + '　' + r.difficultyName + '　' + r.progress + '/' + r.total));
        var ul = el('div', 'boss-list');
        r.encounters.forEach(function (e) {
          ul.appendChild(el('span', 'boss' + (e.killed ? ' killed' : ''), e.name));
        });
        blk.appendChild(ul);
        body.appendChild(blk);
      });
    }

    // -- dungeon lockouts (heroic/mythic/timewalking) are kept out of the raid
    //    columns but are still worth showing here.
    if (ch.raids.dungeonLockouts.length) {
      body.appendChild(el('h3', null, '地下城锁定'));
      var dt = el('table', 'mini-table');
      var dhr = el('tr');
      ['副本', '难度', '进度'].forEach(function (h) { dhr.appendChild(el('th', null, h)); });
      dt.appendChild(dhr);
      ch.raids.dungeonLockouts.forEach(function (d2) {
        var tr = el('tr');
        tr.appendChild(el('td', null, d2.name));
        tr.appendChild(el('td', null, d2.difficultyName));
        tr.appendChild(el('td', null, d2.progress + '/' + d2.total));
        dt.appendChild(tr);
      });
      body.appendChild(dt);
    }

    // -- currencies
    var curTypes = Object.keys(ch.currencies.byType);
    if (curTypes.length) {
      body.appendChild(el('h3', null, '货币'));
      var ct = el('table', 'mini-table');
      var chr = el('tr');
      ['货币', '类别', '当前', '上限', '本周'].forEach(function (h) { chr.appendChild(el('th', null, h)); });
      ct.appendChild(chr);
      curTypes.forEach(function (ty) {
        ch.currencies.byType[ty].forEach(function (c) {
          var tr = el('tr');
          tr.appendChild(el('td', null, c.name));
          tr.appendChild(el('td', null, L.currencyTypeZh[ty] || ty));
          tr.appendChild(el('td', 'num', AE.fmt.group3(c.quantity)));
          tr.appendChild(el('td', 'num', c.maxQuantity ? AE.fmt.group3(c.maxQuantity) : '·'));
          tr.appendChild(el('td', 'num', c.maxWeekly ? (c.earnedThisWeek + '/' + c.maxWeekly) : '·'));
          ct.appendChild(tr);
        });
      });
      body.appendChild(ct);
    }

    // -- equipment
    var slots = L.slotOrder.filter(function (sl) { return ch.equipment[sl]; });
    if (slots.length) {
      body.appendChild(el('h3', null, '装备（' + slots.length + '/16）'));
      var et = el('table', 'mini-table');
      var ehr = el('tr');
      ['槽位', '物品', '装等', '升级'].forEach(function (h) { ehr.appendChild(el('th', null, h)); });
      et.appendChild(ehr);
      L.slotOrder.forEach(function (sl) {
        var it = ch.equipment[sl];
        var tr = el('tr');
        tr.appendChild(el('td', null, L.slotLabel(sl)));
        if (!it) {
          var empty = el('td', 'empty', '空');
          empty.colSpan = 3;
          tr.appendChild(empty);
        } else {
          var nameTd = el('td', null, it.name);
          if (it.quality != null && L.qualityColors[it.quality]) {
            nameTd.style.color = L.qualityColors[it.quality];
          }
          tr.appendChild(nameTd);
          tr.appendChild(el('td', 'num', Math.round(it.itemLevel) || '·'));
          tr.appendChild(el('td', null, it.track
            ? it.track + (it.upgradeMax ? ' ' + it.upgradeLevel + '/' + it.upgradeMax : '')
            : '·'));
        }
        et.appendChild(tr);
      });
      body.appendChild(et);
    }

    // -- prey, grouped by difficulty
    if (ch.prey.seen) {
      body.appendChild(el('h3', null, '狩猎　' + ch.prey.done + '/' + ch.prey.seen));
      ['PREY_DIFFICULTY_NORMAL', 'PREY_DIFFICULTY_HARD', 'PREY_DIFFICULTY_NIGHTMARE']
        .forEach(function (diff) {
          var d = ch.prey.byDifficulty[diff];
          if (!d) return;
          var blk = el('div', 'prey-block');
          blk.appendChild(el('h4', null,
            L.preyDifficultyLabel(diff) + '　' + d.done + ' / ' + d.total));
          var pl = el('div', 'prey-list');
          // Completed first: the unfinished list is 30+ entries and the question
          // is almost always "what did I already do this week".
          d.entries.slice().sort(function (a, b) {
            if (a.done !== b.done) return a.done ? -1 : 1;
            return a.questID - b.questID;
          }).forEach(function (e) {
            var item = el('span', 'prey' + (e.done ? ' done' : ''), e.name);
            item.title = e.rawName + '\nquestID ' + e.questID;
            pl.appendChild(item);
          });
          blk.appendChild(pl);
          body.appendChild(blk);
        });
      body.appendChild(el('p', 'note',
        '狩猎首领名字来自插件自带的英文表，游戏存档里没有中文名。'));
    }

    AE.openPanel('drawer');
  };

  AE.closeDrawer = function () {
    doc.getElementById('drawer').classList.remove('open');
    if (AE.updateBackdrop) AE.updateBackdrop();
  };

})(typeof window !== 'undefined' ? window : globalThis);
