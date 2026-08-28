/*
 * AlterEgoWeb - app/main.js
 *
 * Boot: check the capability probe, load settings, build the model, render.
 * Everything that can fail says so on the page rather than leaving a blank table.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;

  function fatal(title, detail) {
    var box = doc.getElementById('fatal');
    box.style.display = '';
    doc.getElementById('fatal-title').textContent = title;
    doc.getElementById('fatal-detail').textContent = detail || '';
    doc.getElementById('app').style.display = 'none';
  }

  function boot() {
    var probe = global.__AE_PROBE || {};

    // The encoding trap: file:// has no Content-Type, so a script with no BOM is
    // decoded using the document's encoding. On a zh-CN machine a missing
    // <meta charset> means every Chinese character mojibakes.
    if (probe.encoding && probe.encoding.toUpperCase() !== 'UTF-8') {
      fatal('页面编码不是 UTF-8（当前 ' + probe.encoding + '）',
            '中文会显示为乱码。请确认 index.html 的 <meta charset="utf-8"> 在 <head> 的最前面。');
      return;
    }

    if (!global.AE_DATA) {
      fatal('数据未加载', '没有找到 data/data.js。请先双击文件夹里的启动脚本（start.bat）来扫描游戏目录。');
      return;
    }

    var loaded;
    try {
      loaded = AE.loadSettings();
    } catch (e) {
      loaded = { settings: AE.settingsDefaults(), origin: '默认', storageOk: false };
    }
    AE.settingsOrigin = loaded.origin;
    AE.storageOk = loaded.storageOk && probe.storage !== false;

    var model;
    try {
      model = AE.buildModel(global.AE_DATA,
                            loaded.settings.learnedDungeonNames,
                            loaded.settings.dungeonNameOverrides);
    } catch (e) {
      fatal('数据解析失败', e.message);
      if (global.console) global.console.error(e);
      return;
    }

    if (!model.characters.length) {
      fatal('没有找到任何角色',
            '扫描到 ' + model.sources.length + ' 个数据源，但里面没有角色记录。' +
            '需要装了 AlterEgo 并且登录过游戏，插件才会写入数据。');
      return;
    }

    // Remember the localized dungeon names we just harvested, so they survive
    // after the lockouts that revealed them expire.
    var learnedChanged = false;
    Object.keys(model.dungeonNames).forEach(function (k) {
      if (loaded.settings.learnedDungeonNames[k] !== model.dungeonNames[k]) {
        loaded.settings.learnedDungeonNames[k] = model.dungeonNames[k];
        learnedChanged = true;
      }
    });

    try {
      AE.render(model, loaded.settings);
    } catch (e) {
      fatal('渲染失败', e.message);
      if (global.console) global.console.error(e);
      return;
    }

    if (learnedChanged) AE.saveSettings(loaded.settings);
    wireChrome();
  }

  // Every slide-over panel, so open/close/click-outside is handled in one place
  // instead of three near-copies.
  var PANELS = [
    { id: 'panel',  onClose: null },
    { id: 'drawer', onClose: null },
    { id: 'trend',  onClose: null },
    { id: 'vault',  onClose: null }
  ];

  function closeAll(except) {
    PANELS.forEach(function (p) {
      if (p.id === except) return;
      var node = doc.getElementById(p.id);
      if (node) node.classList.remove('open');
    });
    updateBackdrop();
  }

  function anyOpen() {
    for (var i = 0; i < PANELS.length; i++) {
      var n = doc.getElementById(PANELS[i].id);
      if (n && n.classList.contains('open')) return true;
    }
    return false;
  }

  function updateBackdrop() {
    var bd = doc.getElementById('backdrop');
    if (!bd) return;
    if (anyOpen()) bd.classList.add('on');
    else bd.classList.remove('on');
  }

  AE.togglePanel = function (id) {
    var node = doc.getElementById(id);
    if (!node) return;
    var willOpen = !node.classList.contains('open');
    closeAll(willOpen ? id : null);
    if (willOpen) node.classList.add('open');
    else node.classList.remove('open');
    updateBackdrop();
  };

  AE.openPanel = function (id) {
    closeAll(id);
    var node = doc.getElementById(id);
    if (node) node.classList.add('open');
    updateBackdrop();
  };

  AE.closeAllPanels = function () { closeAll(null); };
  AE.updateBackdrop = updateBackdrop;

  function wireChrome() {
    doc.getElementById('btn-settings').addEventListener('click', function () {
      AE.togglePanel('panel');
    });
    doc.getElementById('panel-close').addEventListener('click', function () { closeAll(null); });
    doc.getElementById('drawer-close').addEventListener('click', function () { closeAll(null); });
    doc.getElementById('trend-close').addEventListener('click', function () { closeAll(null); });
    doc.getElementById('vault-close').addEventListener('click', function () { closeAll(null); });

    doc.getElementById('btn-trends').addEventListener('click', function () { AE.openTrends(); });
    doc.getElementById('btn-vault').addEventListener('click', function () { AE.openVault(); });
    doc.getElementById('trend-metric').addEventListener('change', AE.rerenderTrends);

    // Click anywhere outside an open panel closes it. The backdrop covers the
    // page while a panel is open, so this needs no hit-testing.
    doc.getElementById('backdrop').addEventListener('mousedown', function () { closeAll(null); });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });

    doc.getElementById('btn-print').addEventListener('click', function () {
      global.print();
    });
    doc.getElementById('btn-xlsx').addEventListener('click', AE.exportXlsx);
    doc.getElementById('btn-csv').addEventListener('click', AE.exportCsv);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
