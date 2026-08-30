/*
 * WowAltBoard - tools/gen-bis.js
 *
 * 把 GearInsight 插件自带的 core/BisData.lua 转成 app/bis-data.js，随发布包一起发。
 *
 * 为什么要预转换、而不是运行时读插件的 Lua：
 *   · BisData.lua 是 1.4 MB 源文本，转出来只有 ~200 KB —— 浏览器不用每次开面板
 *     都解析一遍 1.4 MB；
 *   · 装备数据是「赛季参照表」，一个赛季里基本不变，不像角色数据需要每次重扫；
 *   · 用户没装 GearInsight 也能用（数据在包里，不用另外下载）。
 *
 * 用法（数据更新了、或者换赛季了就重跑一次）：
 *   node tools\gen-bis.js
 *   node tools\gen-bis.js --lua "D:\...\GearInsight\core\BisData.lua"
 *
 * 复用 app/lua-parser.js —— 项目自己的解析器已经有测试，不另写一个。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.resolve(__dirname, '..');
var DEFAULT_LUA = 'E:\\World of Warcraft\\_retail_\\Interface\\AddOns\\GearInsight\\core\\BisData.lua';
var DEFAULT_TOC = 'E:\\World of Warcraft\\_retail_\\Interface\\AddOns\\GearInsight\\GearInsight.toc';

// ------------------------------------------------------------------ 参数
var argv = process.argv.slice(2);
var luaPath = DEFAULT_LUA;
var tocPath = DEFAULT_TOC;
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--lua' && argv[i + 1]) { luaPath = argv[++i]; }
  else if (argv[i] === '--toc' && argv[i + 1]) { tocPath = argv[++i]; }
}

// -------------------------------------------------------------- 加载解析器
var AE = {};
(function () {
  var src = fs.readFileSync(path.join(BASE, 'app', 'lua-parser.js'), 'utf8');
  var g = { AE: AE };
  // lua-parser.js 是 (function (global) {...})(this || window) 形式
  new Function('global', 'window', src).call(g, g, g);
})();
if (typeof AE.extractLuaAssignment !== 'function') {
  throw new Error('lua-parser.js 没有导出 extractLuaAssignment');
}

// ---------------------------------------------------------------- 读源文件
if (!fs.existsSync(luaPath)) {
  console.error('找不到 BisData.lua：' + luaPath);
  console.error('用 --lua <路径> 指定，或先装 GearInsight 插件。');
  process.exit(1);
}
var text = fs.readFileSync(luaPath, 'utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

var addonVersion = '';
try {
  var toc = fs.readFileSync(tocPath, 'utf8');
  var mv = /^##\s*Version:\s*(.+?)\s*$/m.exec(toc);
  if (mv) addonVersion = mv[1];
} catch (e) { /* 没 toc 就算了，不是必需的 */ }

function grab(name) {
  var v = AE.extractLuaAssignment(text, name);
  if (v == null) throw new Error('BisData.lua 里找不到 ' + name);
  return v;
}

var meta       = grab('local BisData');
var specs      = AE.asMap(grab('BisData.specs'));
var mplus      = AE.asMap(grab('BisData.mplusBySlot'));
var consum     = AE.asArray(grab('BisData.consumables'));
var specIds    = AE.asMap(grab('BisData.specIds'));
var specRawCN  = AE.asMap(grab('BisData.specRawToCN'));
var classArmor = AE.asMap(grab('BisData.classArmor'));
var weaponCfg  = AE.asMap(grab('BisData.weaponConfig'));
var statMeta   = AE.asMap(meta.statMeta || {});
var srcCats    = AE.asMap(meta.sourceCategories || {});

// ------------------------------------------- 部位名 / 属性名（抄插件的 zhCN 表）
// 这些词一个字都不许我自己写。GearInsight 的 locales/zhCN.lua 里那份是照着国服
// 客户端来的（文件头明确写了「中文版要求 byte-for-byte 不变」），
// core/GearReader.lua 里有 slotId -> SLOT_xxx 的权威对应表。两边都直接读。
function harvestLocale() {
  var dir = path.dirname(luaPath);                 // ...\GearInsight\core
  var addonRoot = path.dirname(dir);
  var zhPath = path.join(addonRoot, 'locales', 'zhCN.lua');
  var readerPath = path.join(addonRoot, 'core', 'GearReader.lua');
  var slotNames = {}, statNames = {};

  var zh = '';
  try { zh = fs.readFileSync(zhPath, 'utf8'); } catch (e) { return null; }

  // L["SLOT_HEAD"] = "头盔"
  var strings = {};
  var re = /L\["([A-Z0-9_]+)"\]\s*=\s*"([^"]*)"/g, m;
  while ((m = re.exec(zh))) strings[m[1]] = m[2];

  // [1] = "SLOT_HEAD"
  var reader = '';
  try { reader = fs.readFileSync(readerPath, 'utf8'); } catch (e) { return null; }
  var re2 = /\[(\d+)\]\s*=\s*"(SLOT_[A-Z0-9_]+)"/g;
  while ((m = re2.exec(reader))) {
    var got = strings[m[2]];
    if (got) slotNames[m[1]] = got;
  }

  ['crit', 'haste', 'mastery', 'versatility',
   'strength', 'agility', 'intellect', 'stamina'].forEach(function (k) {
    var got = strings['STAT_' + k.toUpperCase()];
    if (got) statNames[k] = got;
  });

  return { slots: slotNames, stats: statNames };
}

var locale = harvestLocale();
if (!locale || Object.keys(locale.slots).length < 16 || Object.keys(locale.stats).length < 8) {
  console.error('没能从插件的 locales/zhCN.lua + core/GearReader.lua 抄全部位名/属性名。');
  console.error('抄到部位 ' + (locale ? Object.keys(locale.slots).length : 0) +
                ' 个、属性 ' + (locale ? Object.keys(locale.stats).length : 0) + ' 个。');
  console.error('这些词不允许手写（见 app/labels.js 头部的规矩），所以这里直接停。');
  process.exit(1);
}

// ------------------------------------------------------- 装备池（跨两套去重）
// 同一个 itemId 在 40 个专精 × 两套视角里反复出现。哪些字段真的「跟着物品走」
// 不是我拍脑袋定的 —— 第一版把 source/bossName/encounterId 也当成静态字段，
// 结果下面的一致性检查在真数据上抓出 166 处冲突：
//
//   271536 → source: 「烈毒之渊（团本）」 vs 「烈毒之渊（团本）-盘魂者内克扎莉/迷失的探险者」
//
// 同一件装备会从多个 boss 掉落，不同专精记的归属也不一样。所以只有
// 名字 / 持手 / 使用效果 / 副属性 进池子，掉落归属按「来源组合」另外去重
// （srcs 表），每个部位条目存一个下标。检查保留着 —— 以后数据换了格式会立刻报错。
var pool = Object.create(null);
var conflicts = [];

// 来源组合池：[来源文本, 分类, boss名, instanceId, encounterId, 是否套装]
var srcs = [];
var srcIndex = Object.create(null);

function internSource(it) {
  var row = [
    it.source || '',
    it.sourceCategory || '',
    it.bossName || '',
    it.instanceId != null ? it.instanceId : 0,
    it.encounterId != null ? it.encounterId : 0,
    it.isTier ? 1 : 0
  ];
  var key = row.join('\u0001');
  var at = srcIndex[key];
  if (at === undefined) { at = srcs.length; srcs.push(row); srcIndex[key] = at; }
  return at;
}

function statsOf(it) {
  var s = AE.asMap(it.stats || {});
  var out = null;
  ['crit', 'haste', 'mastery', 'versatility'].forEach(function (k) {
    if (s[k] != null) { out = out || {}; out[k] = s[k]; }
  });
  return out;
}

function sameStats(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
  return true;
}

function intern(it, where) {
  var id = it.itemId;
  if (id == null) return null;
  var rec = pool[id];
  var fresh = {
    n: it.itemName || '',
    h: it.handedness || undefined,
    u: it.onUse ? 1 : undefined,
    st: statsOf(it)
  };
  if (!rec) { pool[id] = fresh; return id; }
  // 验一致性：不一致说明「静态字段」的假设错了，得改格式而不是悄悄取第一个
  var bad = [];
  ['n', 'h', 'u'].forEach(function (k) {
    if (rec[k] !== fresh[k]) bad.push(k + ': ' + rec[k] + ' vs ' + fresh[k]);
  });
  if (!sameStats(rec.st, fresh.st)) bad.push('stats');
  if (bad.length) conflicts.push(id + ' @' + where + ' → ' + bad.join('; '));
  return id;
}

// 部位条目：[itemId, ilvl, 使用率, 来源下标, 可升级上限?]
function convertSlots(bySlot, where) {
  var out = {};
  var slots = AE.asMap(bySlot || {});
  Object.keys(slots).forEach(function (slotId) {
    var list = AE.asArray(slots[slotId]);
    if (!list.length) return;
    out[slotId] = list.map(function (it) {
      intern(it, where);
      var row = [it.itemId, it.ilvl != null ? it.ilvl : 0,
                 it.usagePct != null ? Math.round(it.usagePct * 10) / 10 : 0,
                 internSource(it)];
      if (it.mx != null) row.push(it.mx);
      return row;
    });
  });
  return out;
}

// ------------------------------------------------------------------ 专精
var outSpecs = {};
var specKeys = Object.keys(specs);

specKeys.forEach(function (key) {
  var s = AE.asMap(specs[key]);
  var parts = key.split('/');
  var cls = s.className || parts[0];
  var spec = s.specName || parts[1];
  var hero = s.heroTalent || parts[2] || '';
  var base = cls + '/' + spec;

  var gems = AE.asArray(s.gems).map(function (g) {
    return [g.id, g.nameCn || '', g.usagePct != null ? Math.round(g.usagePct * 10) / 10 : 0];
  });

  var ench = {};
  var em = AE.asMap(s.enchants || {});
  Object.keys(em).forEach(function (slotId) {
    var list = AE.asArray(em[slotId]);
    if (!list.length) return;
    ench[slotId] = list.map(function (e) {
      return [e.id, e.nameCn || '', e.usagePct != null ? Math.round(e.usagePct * 10) / 10 : 0,
              e.item != null ? e.item : 0];
    });
  });

  outSpecs[key] = {
    cls: cls,
    spec: spec,
    hero: hero,
    specId: specIds[base] != null ? specIds[base] : 0,
    specCn: specRawCN[spec] || spec,
    ilvl: s.graduationItemLevel || 0,
    zone: s.zoneName || '',
    tol: s.statTolerancePct != null ? s.statTolerancePct : null,
    weights: AE.asMap(s.statWeights || {}),
    target: {
      raid: AE.asMap(s.targetStatPercents || {}),
      high: AE.asMap(s.targetStatPercentsMplus || {}),
      farm: AE.asMap(s.targetStatPercentsMplusFarm || {})
    },
    weapon: AE.asMap(weaponCfg[base] || {}),
    armor: classArmor[cls] || '',
    raid: convertSlots(s.bisBySlot, key + ' raid'),
    mplus: convertSlots(mplus[key], key + ' mplus'),
    gems: gems,
    ench: ench
  };
});

if (conflicts.length) {
  console.error('装备池去重发现字段冲突 ' + conflicts.length + ' 处，格式假设不成立：');
  conflicts.slice(0, 20).forEach(function (c) { console.error('  ' + c); });
  process.exit(1);
}

// ---------------------------------------------------------------- 消耗品
var outConsum = consum.map(function (c) {
  return {
    id: c.itemId != null ? c.itemId : 0,
    n: c.name || '',
    icon: c.icon || '',
    kind: c.kind || c.category || c.slot || '',
    stat: c.stat || '',
    q: c.quality != null ? c.quality : undefined
  };
});

// ------------------------------------------------------------------ 输出
var payload = {
  bisVersion: meta.version || '',
  updatedAt: meta.updatedAt || '',
  source: meta.source || '',
  addonVersion: addonVersion,
  statMeta: statMeta,
  sourceCategories: srcCats,
  slotNames: locale.slots,
  statNames: locale.stats,
  specRawToCN: specRawCN,
  items: pool,
  srcs: srcs,
  specs: outSpecs,
  consumables: outConsum
};

// 手写 JSON.stringify 的 replacer 去掉 undefined 已经够了；不美化，体积优先。
var json = JSON.stringify(payload);

var header = [
  '/*',
  ' * WowAltBoard - app/bis-data.js  【自动生成，勿手改】',
  ' *',
  ' * 由 tools\\gen-bis.js 从 GearInsight 插件的 core/BisData.lua 转换而来。',
  ' * 数据来源：' + (meta.source || '(未知)'),
  ' * 数据日期：' + (meta.updatedAt || '(未知)') + '   BisData 版本：' + (meta.bisVersion || meta.version || '(未知)'),
  ' * GearInsight 插件版本：' + (addonVersion || '(未知)'),
  ' *',
  ' * 要更新：node tools\\gen-bis.js',
  ' */'
].join('\n');

var out = header + '\nwindow.AE_BIS = ' + json + ';\n';
var outPath = path.join(BASE, 'app', 'bis-data.js');
fs.writeFileSync(outPath, out, 'utf8');

// ------------------------------------------------------------------ 报告
var nItems = Object.keys(pool).length;
var nSlots = 0, nRows = 0;
Object.keys(outSpecs).forEach(function (k) {
  ['raid', 'mplus'].forEach(function (v) {
    Object.keys(outSpecs[k][v]).forEach(function (s) {
      nSlots++; nRows += outSpecs[k][v][s].length;
    });
  });
});
console.log('源文件      ' + (text.length / 1024).toFixed(1) + ' KB');
console.log('输出        app/bis-data.js  ' + (out.length / 1024).toFixed(1) + ' KB');
console.log('专精        ' + specKeys.length);
console.log('装备池      ' + nItems + ' 件（去重后）');
console.log('来源组合    ' + srcs.length + ' 种（去重后）');
console.log('部位条目    ' + nSlots + ' 个部位 / ' + nRows + ' 行');
console.log('消耗品      ' + outConsum.length);
console.log('数据日期    ' + (meta.updatedAt || '?') + '   赛季 ' + (outSpecs[specKeys[0]] || {}).zone);
