/*
 * WowAltBoard - app/settings.js
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
      // 列的默认显隐**播种过了没有**。判据必须是这个标记，不能拿
      // 「hiddenColumns 是不是空的」当首次运行 —— 设置里「全部显示」/「只留基础」
      // 那两个按钮干的事正好是把它清空，于是那两个按钮的效果活不过一次刷新
      // （第 20 轮实测：33 列会悄悄回到隐藏）。播种代码在 app/render.js。
      columnsSeeded: false,
      hiddenGroups: {},

      // Column layout. Both orders are PARTIAL on purpose: anything they do not
      // mention keeps its registry position, appended after the ids they do. That
      // is what stops a newly shipped column -- a new season's dungeon, a
      // profession that only just appeared in BagSync -- from silently vanishing
      // because an old saved layout never heard of it.
      groupOrder: [],                // [groupId, ...]
      columnOrder: {},               // {groupId: [columnId, ...]}

      // Named layouts. Each one stores ONLY the shape of the table:
      // {name, groupOrder, columnOrder, hiddenColumns, hiddenGroups}. Filters,
      // sorting and appearance deliberately stay outside, so switching layout
      // never quietly changes which characters you are looking at.
      layouts: [],
      activeLayout: '',
      // Authoring choice for the NEXT saved layout, not a property of any
      // existing one -- each layout carries its own scope. Defaults to on: a
      // "layout" people save is almost always the whole view they had set up,
      // and a preset that silently drops the filters and skin it was saved with
      // is the more surprising of the two behaviours.
      layoutSaveAll: true,

      // Which settings tab was open last. See PANEL_TABS in panel.js.
      panelTab: 'filter',

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

      // Same for raid names. Raid lockouts expire every week, and the localized
      // name only exists while the lockout does, so without this the raid
      // headers fell back to English after every reset.
      learnedRaidNames: {},

      // Learned localized class names, harvested from ch.info.class.name. Only 9
      // of 13 classes ship built-in (labels.js explains why), so this is what
      // fills in the rest as you scan characters of those classes.
      learnedClassNames: {},

      // User corrections to spec labels, keyed by specID. GearInsight's own
      // table calls 死亡骑士/冰霜 "冰法" and has no row for PRESERVATION or
      // DISCIPLINE; these win over it. See L.specZh in labels.js.
      specNameOverrides: {},

      // User corrections to dungeon labels.
      dungeonNameOverrides: {},

      // 毕业装备 / 天赋面板: last selection, so reopening lands where you left.
      bisTab: 'gear',                // 'gear' | 'talents'
      bisSpec: '',                   // 'DEATHKNIGHT/BLOOD/Deathbringer'
      // 'maxroll' | 'rio'。第 16 轮撤掉了 GearInsight 的两个视角（'raid' / 'mplus'）,
      // 默认值也跟着换 —— 留着 'raid' 的话新用户第一次打开时存的是一个界面上
      // 已经没有按钮的视角名，靠 openBis() 的迁移兜着，能用但不该这么绕。
      bisView: 'maxroll',
      bisTalentCat: 'raid',          // 'raid' | 'mplusHigh' | 'mplusFarm'
      bisChar: '',                   // which character's gear to compare against
      // 天赋页看团本还是大秘境那一份 maxroll 指南。'' = 跟着数据走（有大秘境
      // 就用大秘境）。同页的 mrBuild / mrSub 是数组下标，**故意不存**，
      // 原因见 app/bis.js 里 state 那段注释。
      bisMrKind: '',                 // '' | 'mplus' | 'raid'
      // 天赋页「榜上热门天赋串」看团本还是大秘境那一份**榜单数据**（上面那个
      // bisMrKind 管的是 maxroll 指南，两个开关同名不同事）。
      // **这一条必须留在默认表里**：hydrate() 是 Object.keys(defaults()).forEach，
      // 不在表里的键会被整个丢掉 —— 第 20 轮实测就是这样：bis.js 那边照常写进
      // localStorage，下次加载被过滤掉，读取那一行成了死代码，点过的「团本」
      // 活不过一次刷新。
      bisLoKind: '',                 // '' | 'mplus' | 'raid'

      // Optional data sources for the 毕业装备 panel. Both are empty by default:
      // everything the panel needs to work ships inside the release, and an
      // empty setting means "never touch the network".
      //
      // remoteDataUrl: a base URL holding replacement copies of bis-data.js /
      //   talent-data.js / talent-tree.js / item-icons.js. Files found there win
      //   over the bundled ones, which is how a new season's data (or the talent
      //   tree, which cannot be extracted from the addon at all) gets in without
      //   shipping a new release. They are loaded with <script src>, not fetch():
      //   file:// pages cannot fetch, so each file must assign to its global.
      // iconBaseUrl: a base URL for <name>.jpg icon images. Empty means "use the
      //   bundled app/icons/" -- 469 files, ~1 MB, downloaded at build time by
      //   tools/fetch-icons.js. It is NOT a switch for having icons at all:
      //   pointing a browser in mainland China at wowhead's image host returns
      //   403 (measured), so runtime fetching is not an option and the icons
      //   have to ship. This setting only exists for swapping in your own host.
      remoteDataUrl: '',
      iconBaseUrl: ''
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
      o.columnsSeeded = false;                   // 列状态清了，播种也要重新来
      o.schemaVersion = SCHEMA;
    }
    /*
     * 老存档里没有 columnsSeeded 这个键。**不能让它们重新播种一次** ——
     * 那会把用户手动打开过的 defaultHidden 列（职业 / 种族 / 护甲…）和
     * 上赛季货币列重新按默认隐藏一遍，等于悄悄改掉他的选择。
     * 判据：已经有隐藏列了，就说明播种早就发生过。
     */
    if (o.columnsSeeded === undefined) {
      o.columnsSeeded = !!(o.hiddenColumns && Object.keys(o.hiddenColumns).length);
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
   * The entry worth adopting out of a bucket that belongs to other paths.
   *
   * Pure, and exported, so the adoption rule can be tested without a browser or
   * a real localStorage.
   *
   * @param {Array<{key: string, raw: string}>} entries  every key in the bucket
   * @param {string} myKey  our own key; never adopted from, since a caller only
   *                        asks when its own entry is missing or unusable
   * @returns {{data: object, from: string}|null}
   */
  AE.pickAdoptable = function (entries, myKey) {
    var best = null, bestKey = '', bestAt = -1;
    for (var i = 0; i < (entries || []).length; i++) {
      var k = entries[i] && entries[i].key;
      if (!k || k === myKey || k.indexOf('AEW:v1:') !== 0) continue;
      if (k.indexOf(':probe') >= 0) continue;
      var o = null;
      try { o = JSON.parse(entries[i].raw); } catch (e) { continue; }
      // migrate() inside the loop, not after: an entry written by a NEWER build
      // is unusable, and skipping it here lets an older usable one still win.
      o = migrate((o && typeof o === 'object') ? o : null);
      if (!o) continue;
      var at = Number(o.savedAt) || 0;
      if (at > bestAt) { bestAt = at; best = o; bestKey = k; }
    }
    return best ? { data: best, from: bestKey } : null;
  };

  /**
   * This folder's own entry, or the newest adoptable one from another path.
   *
   * The key is namespaced by folder path because on file:// every local page
   * shares ONE localStorage bucket -- two copies of this tool on one machine
   * would otherwise clobber each other's settings.
   *
   * The price is that MOVING or RENAMING the folder changes the key, and every
   * setting looks wiped. It is not: the old entry is still sitting in the same
   * bucket under the old path's hash. So when our own key is empty, adopt the
   * newest AEW:v1:* entry there is and write it under our key. That happens once;
   * afterwards both copies are back to writing their own key, so the isolation is
   * not given up -- it just stops treating a moved folder as a fresh install.
   *
   * @returns {{data: object|null, from: string}}
   */
  function readLocalOrAdopt() {
    var mine = migrate(readLocal());
    if (mine) return { data: mine, from: '' };

    var entries = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k) continue;
        entries.push({ key: k, raw: global.localStorage.getItem(k) });
      }
    } catch (e) { return { data: null, from: '' }; }

    var hit = AE.pickAdoptable(entries, LS_KEY);
    if (!hit) return { data: null, from: '' };
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(hit.data)); } catch (e) { /* read-only */ }
    return hit;
  }

  /**
   * Load settings, preferring whichever store has the newer savedAt.
   * @returns {{settings: object, origin: string, storageOk: boolean, adoptedFrom: string}}
   */
  AE.loadSettings = function () {
    var fromFile = migrate(global.AE_SETTINGS || null);
    var adopted = readLocalOrAdopt();
    var fromLocal = adopted.data;

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
      if (localAt > fileAt) {
        pick = fromLocal;
        origin = adopted.from ? ('localStorage（从旧路径迁移）') : 'localStorage';
      } else {
        pick = fromFile;
        origin = 'data/settings.js';
      }
    }

    return {
      settings: hydrate(pick),
      origin: origin,
      storageOk: storageOk,
      // Non-empty only when the adopted entry is the one actually in use.
      adoptedFrom: (pick === fromLocal) ? adopted.from : ''
    };
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
    return '// WowAltBoard settings. Place this file at data/settings.js.\n' +
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

  /**
   * Other paths' settings still sitting in the shared bucket.
   *
   * Automatic adoption only fires when our own key is EMPTY, which is the right
   * default -- silently overwriting settings you are actively using would be
   * worse than the problem. But that leaves the case where the folder moved and
   * you then made a few changes at the new path: the old, carefully tuned entry
   * is still there and now unreachable. This is what the 其他 tab lists so you
   * can take one over on purpose.
   *
   * `store` and `myKey` are injection points for the tests only -- tests.html runs
   * in a real browser, and a test that swept the actual localStorage would be
   * inspecting (and could adopt from) the user's live settings.
   *
   * @returns {Array<{key: string, savedAt: number, hiddenColumns: number, layouts: number}>}
   *          newest first; never includes our own key
   */
  AE.listForeignSettings = function (store, myKey) {
    store = store || global.localStorage;
    myKey = myKey || LS_KEY;
    var out = [];
    try {
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (!k || k === myKey || k.indexOf('AEW:v1:') !== 0) continue;
        if (k.indexOf(':probe') >= 0) continue;
        var o = null;
        try { o = JSON.parse(store.getItem(k)); } catch (e) { continue; }
        if (!o || typeof o !== 'object') continue;
        out.push({
          key: k,
          savedAt: Number(o.savedAt) || 0,
          // Enough to tell two candidates apart without dumping the whole blob.
          hiddenColumns: o.hiddenColumns ? Object.keys(o.hiddenColumns).length : 0,
          layouts: (o.layouts && o.layouts.length) || 0,
          usable: !!migrate(JSON.parse(JSON.stringify(o)))
        });
      }
    } catch (e) { return []; }
    out.sort(function (a, b) { return b.savedAt - a.savedAt; });
    return out;
  };

  /**
   * Copy another path's entry over ours. Caller reloads.
   * @returns {object|null} the adopted settings, or null if it is unusable
   */
  AE.adoptSettingsFrom = function (key, store, myKey) {
    store = store || global.localStorage;
    myKey = myKey || LS_KEY;
    var o = null;
    try { o = JSON.parse(store.getItem(key)); } catch (e) { return null; }
    o = migrate((o && typeof o === 'object') ? o : null);
    if (!o) return null;
    // Stamped as ours, and NEWER than any data/settings.js, so the deliberate
    // choice is not immediately undone by an old settings file on next load.
    o.savedAt = Math.floor(Date.now() / 1000);
    try { store.setItem(myKey, JSON.stringify(o)); } catch (e) { return null; }
    return hydrate(o);
  };

})(typeof window !== 'undefined' ? window : globalThis);
