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

// ------------------------------------------------------- 升级轨道（「英雄 6/6」那种）
//
// BisData 里 3963 行装备全部带 bonusIDs，但那串数字在插件里**只有一个用途**：
// 拼游戏内的 `|Hitem:...` 链接，让游戏自己的 tooltip 显示正确装等。网页没有这个
// 机制，而装等本来就已经在行里（ilvl / mx）。所以原样存那 19 KB 是白花的。
//
// 有价值的是把它**解开**：AlterEgo 自带一张赛季轨道表（Data/UpgradeTracks.lua，
// 作者注明抄自 raidbots 的 bonuses.json），形如
//   {name = "Hero", bonusIDs = {12841, ..., 12846}}
// 数组下标就是升级等级 1..6。拿它去撞 BisData 的 bonusIDs，本机实测 3601/3963 行
// 能解出「英雄 6/6」这种标签，而且**没有一行同时命中两个轨道**，不存在歧义。
//
// 为什么不能从装等推：实测单看装等有 3 个值对应两种轨道（308 / 318 / 321），
// 连 (装等, 来源分类) 都还有 5/24 组歧义（321/raid 是 Hero 6/6 ×528 vs Myth 2/6 ×10）。
// 推不出来，只能存。存「轨道下标 + 等级」压成一个小整数，比存原始 bonusIDs 省。
//
// 中文名同样不许手写。两处**互相独立**的 shipped zhCN locale 完全一致：
//   EllesmereUILocales/zhCN.lua       L["Hero"] = "英雄"
//   ItemInfoOverlay/Locales/zhCN.lua  L["color.itemLevel.itemUpgrade.hero"] = "英雄"
// 两边都读，不一致就停 —— 一致才敢用。
//（ItemInfoOverlay/Utils.lua 的代码注释里把 Myth 写成「史诗」，那是注释不是 locale；
//  两个 locale 都写「神话」，所以按 locale。）
function harvestTracks() {
  // luaPath = ...\AddOns\GearInsight\core\BisData.lua → 上三层是 AddOns
  var addonsDir = path.dirname(path.dirname(path.dirname(luaPath)));
  var trackPath = path.join(addonsDir, 'AlterEgo', 'Data', 'UpgradeTracks.lua');
  var euiPath   = path.join(addonsDir, 'EllesmereUILocales', 'zhCN.lua');
  var iioPath   = path.join(addonsDir, 'ItemInfoOverlay', 'Locales', 'zhCN.lua');

  var txt;
  try { txt = fs.readFileSync(trackPath, 'utf8'); }
  catch (e) { return { err: '读不到 ' + trackPath }; }

  // 按 seasonID 分段，段内再抳 {name = "X", bonusIDs = {a, b, ...}}
  var tracks = [];
  var seasonRe = /seasonID\s*=\s*(\d+)([\s\S]*?)(?=seasonID\s*=\s*\d+|$)/g;
  var sm;
  while ((sm = seasonRe.exec(txt))) {
    var season = Number(sm[1]);
    var body = sm[2];
    var tr = /\{\s*name\s*=\s*"([A-Za-z]+)"\s*,\s*bonusIDs\s*=\s*\{([\d,\s]+)\}/g;
    var tm;
    while ((tm = tr.exec(body))) {
      var ids = tm[2].split(',').map(function (x) { return Number(x.trim()); })
                     .filter(function (x) { return x > 0; });
      if (ids.length) tracks.push({ en: tm[1], season: season, ids: ids });
    }
  }
  if (!tracks.length) return { err: 'UpgradeTracks.lua 里没解析出任何轨道' };

  function readL(p, keyOf) {
    var s;
    try { s = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
    var out = {};
    var re = /L\["([^"]+)"\]\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(s))) {
      var k = keyOf(m[1]);
      if (k) out[k] = m[2];
    }
    return out;
  }
  var eui = readL(euiPath, function (k) {
    return /^(Adventurer|Veteran|Champion|Hero|Myth|Explorer)$/.test(k) ? k : null;
  });
  var iio = readL(iioPath, function (k) {
    var m = /^color\.itemLevel\.itemUpgrade\.([a-z]+)$/.exec(k);
    if (!m) return null;
    var map = { veteran: 'Veteran', champion: 'Champion', hero: 'Hero', myth: 'Myth' };
    return map[m[1]] || null;
  });
  if (!eui) return { err: '读不到 ' + euiPath };
  if (!iio) return { err: '读不到 ' + iioPath };

  var cn = {}, disagree = [];
  Object.keys(eui).forEach(function (k) { cn[k] = eui[k]; });
  Object.keys(iio).forEach(function (k) {
    if (cn[k] && cn[k] !== iio[k]) disagree.push(k + ': ' + cn[k] + ' vs ' + iio[k]);
    else cn[k] = iio[k];
  });
  if (disagree.length) return { err: '两个 locale 的轨道中文名不一致：' + disagree.join('; ') };

  var noCn = [];
  tracks.forEach(function (t) {
    if (!cn[t.en] && noCn.indexOf(t.en) < 0) noCn.push(t.en);
  });
  if (noCn.length) return { err: '这些轨道没有中文名：' + noCn.join(', ') };

  // 轨道池 + bonusID 索引。同一个 bonusID 不该属于两个轨道，撞了就停。
  var pool = [], byBonus = {}, dup = [];
  tracks.forEach(function (t) {
    var idx = pool.length;
    pool.push([t.en, cn[t.en], t.season]);
    t.ids.forEach(function (id, i) {
      if (byBonus[id]) dup.push(String(id));
      byBonus[id] = (idx + 1) * 10 + (i + 1);   // 下标 1 起，等级 1..6
    });
  });
  if (dup.length) return { err: '同一个 bonusID 属于多个轨道：' + dup.join(', ') };

  return { pool: pool, byBonus: byBonus };
}

var tracksInfo = harvestTracks();
if (tracksInfo.err) {
  console.error('升级轨道表没抄成：' + tracksInfo.err);
  console.error('轨道名（勇士 / 英雄 / 神话…）不允许手写，见 app/labels.js 头部的规矩。');
  console.error('需要这三个文件：AlterEgo/Data/UpgradeTracks.lua、');
  console.error('              EllesmereUILocales/zhCN.lua、ItemInfoOverlay/Locales/zhCN.lua');
  process.exit(1);
}
var trackStats = { withBonus: 0, decoded: 0, multi: 0 };

/** bonusIDs 数组 → 轨道码（(下标+1)*10 + 等级），解不出来返回 0。 */
function trackCode(bonusIDs) {
  var ids = AE.asArray(bonusIDs || []);
  if (!ids.length) return 0;
  trackStats.withBonus++;
  var hit = 0, n = 0;
  ids.forEach(function (id) {
    var c = tracksInfo.byBonus[Number(id)];
    if (c) { hit = c; n++; }
  });
  if (n > 1) trackStats.multi++;
  if (hit) trackStats.decoded++;
  return hit;
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

// 部位条目：[itemId, ilvl, 使用率, 来源下标, 可升级上限, 轨道码]
// 后两位可以省，但**不能跳着省** —— 有轨道码时 mx 必须占住位置（没有就写 0），
// 否则 r[4] 到底是 mx 还是轨道码就得靠数组长度猜，那种格式迟早出错。
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
                 internSource(it),
                 it.mx != null ? it.mx : 0,
                 trackCode(it.bonusIDs)];
      while (row.length > 4 && row[row.length - 1] === 0) row.pop();
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

// -------------------------------------------- 补齐缺失的来源分类中文名
//
// 插件 meta 里的 sourceCategories 只有 5 个键（raid / mplus / crafted / world / other），
// 但实际数据里的 sourceCategory 有 7 种 —— **少了 `tier` 和 `quest`**，
// 这两类合计 297 行（套装 292 + 任务 5），面板上会把徽章画成英文 `tier` / `quest`。
// 这是上游的漏洞，不是转换丢的。
//
// 中文名不许手写。找短标签的路也走不通：`Quest` → 「任务」在 5 个 locale 里都有，
// 但「套装」只在 Syndicator 一处（`KEYWORD_SET`），而 EllesmereUI 里
// `L["Set"] = "设置"` —— 同一个英文词在另一个语境是完全不同的意思。
// 靠通用词查表迟早出事。
//
// 所以改成从**数据自己的 `source` 文本**取：每个缺失分类下的所有行如果 `source`
// 完全一致，就用那个词（`tier` → 「套装转换」，`quest` → 「奇点声望任务」）。
// 不一致就不猜，留英文，并在下面的报告里说出来。
var catSources = Object.create(null);
srcs.forEach(function (row) {
  var cat = row[1], text = row[0];
  if (!cat || srcCats[cat] || !text) return;
  (catSources[cat] || (catSources[cat] = [])).push(text);
});
var catFilled = [], catUnsure = [];
Object.keys(catSources).forEach(function (cat) {
  var uniq = catSources[cat].filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (uniq.length === 1) { srcCats[cat] = uniq[0]; catFilled.push(cat + '→' + uniq[0]); }
  else catUnsure.push(cat + '（' + uniq.length + ' 种说法）');
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
  tracks: tracksInfo.pool,
  tracks: tracksInfo.pool,
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
// 用字节数而不是 out.length —— 后者是字符数，中文一个字符 3 字节，报出来的
// 「KB」会小掉一成多（实测 196.3 KB 的文件报成 181.4 KB）。
console.log('源文件      ' + (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('输出        app/bis-data.js  ' + (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('专精        ' + specKeys.length);
console.log('装备池      ' + nItems + ' 件（去重后）');
console.log('来源组合    ' + srcs.length + ' 种（去重后）');
console.log('部位条目    ' + nSlots + ' 个部位 / ' + nRows + ' 行');
console.log('消耗品      ' + outConsum.length);
console.log('来源分类    ' + Object.keys(srcCats).length + ' 种' +
            (catFilled.length ? '（插件表里缺、从 source 文本补上的：' + catFilled.join('、') + '）' : '') +
            (catUnsure.length ? '（补不了，会显示英文：' + catUnsure.join('、') + '）' : ''));
console.log('升级轨道    ' + tracksInfo.pool.length + ' 条，解出 ' + trackStats.decoded +
            '/' + trackStats.withBonus + ' 行（' +
            (trackStats.withBonus ? (trackStats.decoded / trackStats.withBonus * 100).toFixed(1) : '0') +
            '%），一行命中多个轨道 ' + trackStats.multi + ' 次');
console.log('数据日期    ' + (meta.updatedAt || '?') + '   赛季 ' + (outSpecs[specKeys[0]] || {}).zone);
