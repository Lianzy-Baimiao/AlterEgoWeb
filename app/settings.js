/*
 * AlterEgoWeb - app/settings.js
 *
 * Settings live in two places on purpose:
 *
 *   localStorage      fast, written on every toggle -- but on file:// ALL pages
 *                     share one storage bucket with no per-file partitioning.
 *                     Two copies of this folder collide, any other local HTML
 *                     can clobber it, and it does NOT travel with the folder.
 *                     So it is a working cache, never the system of record.
 *
 *   data/settings.js  a plain <script src> that sets window.AE_SETTINGS. Lives
 *                     inside the folder, so it survives being copied to a USB
 *                     stick or another machine.
 *
 * At boot whichever has the newer savedAt wins. "保存设置到文件" downloads a
 * settings.js, and scan.ps1 sweeps the Downloads folder on its next run and
 * moves it into data/ -- one click in the browser, absorbed on next launch.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};

  var SCHEMA = 1;
  // Namespaced by folder location, because all file:// pages share one bucket.
  var LS_KEY = 'AEW:v1:' + (function () {
    try {
      var p = String(global.location && global.location.pathname || '').toLowerCase();
      var h = 0;
      for (var i = 0; i < p.length; i++) { h = ((h << 5) - h + p.charCodeAt(i)) | 0; }
      return (h >>> 0).toString(36);
    } catch (e) { return 'default'; }
  })();

  function defaults() {
    return {
      schemaVersion: SCHEMA,
      savedAt: 0,

      // Data sources: {sourceId: false} to hide, {sourceId: "别名"} to rename.
      hiddenSources: {},
      sourceAliases: {},

      // Character selection.
      hiddenCharacters: {},          // {characterKey: true}
      hiddenRealms: {},              // {realmName: true}
      enabledMode: 'custom',         // 'custom' | 'game' | 'all'
      minLevel: 80,
      hideZeroRating: false,
      hideStaleDays: 0,              // 0 = off
      search: '',
      weeklyActiveOnly: false,

      // Columns: {columnId: true} means hidden.
      hiddenColumns: {},
      hiddenGroups: {},

      // Appearance.
      theme: 'dark',
      skin: 'slate',                 // see AE.SKINS in labels.js
      fontFamily: 'system',          // see AE.FONTS
      fontSize: 12,                  // px, table body
      classColors: true,
      headerMode: 'short',           // 'short' 中文缩写 | 'full' 中文全名 | 'en' 英文缩写
      currencyShowCap: true,

      // External profile links.
      links: {
        region: 'cn',
        rioBase: 'https://raider.io/characters',
        wclBase: 'https://www.warcraftlogs.com/character',
        realmForm: 'localized'       // 'localized' | 'slug'
      },

      // Dismissed banners, keyed by content/version so a NEW one still shows.
      dismissedWarning: '',
      dismissedUpdate: '',

      // 备份箱: user-added {name, content} entries for any addon's export string.
      vaultEntries: [],

      // Sorting.
      sortColumn: 'mpRating',
      sortDir: 'desc',

      // Learned localized dungeon names, so they survive lockout expiry.
      learnedDungeonNames: {},

      // User corrections to dungeon labels.
      dungeonNameOverrides: {}
    };
  }

  AE.settingsDefaults = defaults;

  function readLocal() {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }

  function migrate(o) {
    if (!o || typeof o !== 'object') return null;
    var v = Number(o.schemaVersion) || 0;
    if (v > SCHEMA) return null;                 // written by a newer build
    if (v < SCHEMA) {
      // Column ids change every season, so a version bump resets column state
      // but keeps the character/source choices, which stay meaningful.
      o.hiddenColumns = {};
      o.hiddenGroups = {};
      o.schemaVersion = SCHEMA;
    }
    // headerMode gained a third value; the old 'abbr' meant the English one.
    if (o.headerMode === 'abbr') o.headerMode = 'en';
    return o;
  }

  /** Merge a partial settings object over the defaults. */
  function hydrate(o) {
    var d = defaults();
    if (!o) return d;
    Object.keys(d).forEach(function (k) {
      if (o[k] === undefined || o[k] === null) return;
      if (typeof d[k] === 'object' && !Array.isArray(d[k])) {
        if (typeof o[k] === 'object') d[k] = o[k];
      } else if (typeof o[k] === typeof d[k]) {
        d[k] = o[k];
      }
    });
    return d;
  }

  /**
   * Load settings, preferring whichever store has the newer savedAt.
   * @returns {{settings: object, origin: string, storageOk: boolean}}
   */
  AE.loadSettings = function () {
    var fromFile = migrate(global.AE_SETTINGS || null);
    var fromLocal = migrate(readLocal());

    var storageOk = false;
    try {
      global.localStorage.setItem(LS_KEY + ':probe', '1');
      global.localStorage.removeItem(LS_KEY + ':probe');
      storageOk = true;
    } catch (e) { storageOk = false; }

    var pick = null, origin = 'defaults';
    var fileAt = fromFile ? Number(fromFile.savedAt) || 0 : -1;
    var localAt = fromLocal ? Number(fromLocal.savedAt) || 0 : -1;

    if (fileAt >= 0 || localAt >= 0) {
      if (localAt > fileAt) { pick = fromLocal; origin = 'localStorage'; }
      else { pick = fromFile; origin = 'data/settings.js'; }
    }

    return { settings: hydrate(pick), origin: origin, storageOk: storageOk };
  };

  /** Persist to localStorage. Silently no-ops when storage is unavailable. */
  AE.saveSettings = function (settings) {
    settings.schemaVersion = SCHEMA;
    settings.savedAt = Math.floor(Date.now() / 1000);
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(settings));
      return true;
    } catch (e) { return false; }
  };

  /** The text of a data/settings.js the user can download. */
  AE.settingsFileText = function (settings) {
    var copy = JSON.parse(JSON.stringify(settings));
    copy.schemaVersion = SCHEMA;
    copy.savedAt = Math.floor(Date.now() / 1000);
    return '// AlterEgoWeb settings. Place this file at data/settings.js.\n' +
           '// tools/scan.ps1 also picks it up automatically from your Downloads folder.\n' +
           'window.AE_SETTINGS = ' + JSON.stringify(copy, null, 2) + ';\n';
  };

  /** Trigger a browser download. <a download> works on file://. */
  AE.downloadText = function (filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = global.document.createElement('a');
    a.href = url;
    a.download = filename;
    global.document.body.appendChild(a);
    a.click();
    global.document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  };

  AE.resetSettings = function () {
    try { global.localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    return defaults();
  };

  AE.settingsStorageKey = LS_KEY;

})(typeof window !== 'undefined' ? window : globalThis);
