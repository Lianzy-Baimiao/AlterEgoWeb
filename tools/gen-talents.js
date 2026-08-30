/*
 * WowAltBoard - tools/gen-talents.js
 *
 * 把 GearInsight_Talents 插件自带的 PopularTalents.lua 转成 app/talent-data.js，
 * 随发布包一起发（用户不用另外下载）。
 *
 * 为什么要预转换 + 重新编码：
 *   · 源文件 1.5 MB，直译成 JSON 反而更大（1.4 MB 实测）——一个专精里的几十套
 *     天赋高度相似（78 个节点里只差 8 个），照抄等于把同一份东西存 60 遍；
 *   · 所以每个专精存一套完整的「基准」，其余套只存与基准的差异。实测
 *     454082 个数字 → 83439 个，省 81.6%；
 *   · 服务器名 / 英雄天赋名重复度极高，单独做字符串池。
 *
 * 这个文件按需加载（点开「天赋」页签才载入），平时不占内存 —— 和 data/backups.js
 * 同一个套路。
 *
 * 用法：
 *   node tools\gen-talents.js
 *   node tools\gen-talents.js --lua "D:\...\GearInsight_Talents\PopularTalents.lua"
 *
 * ⚠ 天赋「树」的结构（节点坐标 / 图标 / 连线 / 名称）不在插件里 —— 插件是靠游戏
 *   运行时的 C_Traits API 现查的，网页拿不到。这里只产出「哪些 entryID 点了几点」，
 *   要画出树来还需要另一份天赋树数据，见 app/talent-tree.js 的说明。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.resolve(__dirname, '..');
var DEFAULT_LUA = 'E:\\World of Warcraft\\_retail_\\Interface\\AddOns\\GearInsight_Talents\\PopularTalents.lua';
var DEFAULT_TOC = 'E:\\World of Warcraft\\_retail_\\Interface\\AddOns\\GearInsight_Talents\\GearInsight_Talents.toc';

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
  new Function('global', 'window', src).call(g, g, g);
})();

if (!fs.existsSync(luaPath)) {
  console.error('找不到 PopularTalents.lua：' + luaPath);
  console.error('用 --lua <路径> 指定，或先装 GearInsight_Talents 插件。');
  process.exit(1);
}
var text = fs.readFileSync(luaPath, 'utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

var addonVersion = '';
try {
  var mv = /^##\s*Version:\s*(.+?)\s*$/m.exec(fs.readFileSync(tocPath, 'utf8'));
  if (mv) addonVersion = mv[1];
} catch (e) { /* 没 toc 不影响 */ }

var root = AE.extractLuaAssignment(text, 'GearInsightPopularTalents');
if (root == null) throw new Error('找不到 GearInsightPopularTalents');
var specs = AE.asMap(root);

// ---------------------------------------------------------------- 字符串池
function Pool() {
  this.list = [];
  this.index = Object.create(null);
}
Pool.prototype.at = function (s) {
  s = s == null ? '' : String(s);
  var i = this.index[s];
  if (i === undefined) { i = this.list.length; this.list.push(s); this.index[s] = i; }
  return i;
};

var servers = new Pool();
var heroes = new Pool();

// ------------------------------------------------------------------ 差异编码
// 一套天赋 = {dictIdx: rank}。基准取本专精第一套（引用次数无关，只要稳定）。
// 差异表是扁平的 [dictIdx, rank, ...]，rank=0 表示「基准点了但这套没点」。
function toMap(flat) {
  var m = Object.create(null);
  for (var i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1];
  return m;
}

function diff(base, cur) {
  var out = [];
  var seen = Object.create(null);
  var k;
  for (k in cur) {
    seen[k] = 1;
    if (base[k] !== cur[k]) out.push(+k, cur[k]);
  }
  for (k in base) {
    if (!seen[k]) out.push(+k, 0);
  }
  return out;
}

// 还原（生成期自检用，和 app/talents.js 里的实现必须一致）
function apply(base, delta) {
  var m = Object.create(null);
  var k;
  for (k in base) m[k] = base[k];
  for (var i = 0; i < delta.length; i += 2) {
    if (delta[i + 1] === 0) delete m[delta[i]];
    else m[delta[i]] = delta[i + 1];
  }
  return m;
}

function sameMap(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
  return true;
}

// ------------------------------------------------------------------ 转换
var out = {};
var stat = {
  specs: 0, builds: 0, players: 0, encounters: 0,
  rawNums: 0, encNums: 0, mismatches: []
};

var CATS = ['raid', 'mplusHigh', 'mplusFarm'];

Object.keys(specs).forEach(function (key) {
  var s = AE.asMap(specs[key]);
  var dict = AE.asArray(s.dict).map(Number);
  var pool = AE.asArray(s.pool).map(function (b) { return AE.asArray(b).map(Number); });
  if (!dict.length || !pool.length) return;

  stat.specs++;

  // 哪些 build 真的被引用了 —— 没引用的不必留
  var content = AE.asMap(s.content || {});
  var used = Object.create(null);
  CATS.forEach(function (cat) {
    AE.asArray(content[cat]).forEach(function (e) {
      AE.asArray(AE.asMap(e).list).forEach(function (p) {
        var b = AE.asMap(p).b;
        if (b) used[b] = 1;
      });
    });
  });
  var usedIdx = Object.keys(used).map(Number).sort(function (a, b) { return a - b; });
  if (!usedIdx.length) return;

  // 重新编号：源里的 pool 下标 -> 输出里的 build 下标
  var remap = Object.create(null);
  usedIdx.forEach(function (srcIdx, i) { remap[srcIdx] = i; });

  var maps = usedIdx.map(function (srcIdx) {
    var flat = pool[srcIdx - 1] || [];
    stat.rawNums += flat.length;
    return toMap(flat);
  });

  var baseMap = maps[0];
  var baseFlat = [];
  Object.keys(baseMap).forEach(function (k) { baseFlat.push(+k, baseMap[k]); });
  stat.encNums += baseFlat.length;

  var deltas = maps.map(function (m, i) {
    if (i === 0) return [];
    var d = diff(baseMap, m);
    stat.encNums += d.length;
    // 自检：还原不回去就是编码错了，不能悄悄发出去
    if (!sameMap(apply(baseMap, d), m)) {
      stat.mismatches.push(key + ' build#' + i);
    }
    return d;
  });
  stat.builds += deltas.length;

  var outContent = {};
  CATS.forEach(function (cat) {
    var list = AE.asArray(content[cat]);
    if (!list.length) return;
    outContent[cat] = list.map(function (e) {
      var em = AE.asMap(e);
      stat.encounters++;
      var players = AE.asArray(em.list).map(function (p) {
        var pm = AE.asMap(p);
        stat.players++;
        // [build下标, 英雄天赋池下标, 玩家名, 服务器池下标, 地区]
        return [
          remap[pm.b] != null ? remap[pm.b] : 0,
          heroes.at(pm.hero),
          pm.player || '',
          servers.at(pm.server),
          pm.region || ''
        ];
      });
      var row = { n: em.enc || '', en: em.encEn || '', p: players };
      if (em.m) row.m = em.m;
      return row;
    });
  });

  out[key] = {
    specId: s.specID || 0,
    dict: dict,
    base: baseFlat,
    builds: deltas,
    content: outContent
  };
});

if (stat.mismatches.length) {
  console.error('差异编码自检失败 ' + stat.mismatches.length + ' 处：');
  stat.mismatches.slice(0, 10).forEach(function (m) { console.error('  ' + m); });
  process.exit(1);
}

var payload = {
  addonVersion: addonVersion,
  servers: servers.list,
  heroes: heroes.list,
  specs: out
};

var header = [
  '/*',
  ' * WowAltBoard - app/talent-data.js  【自动生成，勿手改】',
  ' *',
  ' * 由 tools\\gen-talents.js 从 GearInsight_Talents 插件的 PopularTalents.lua 转来。',
  ' * 数据是 WarcraftLogs 顶尖玩家的真实天赋（团本 / 冲分 / 割草，每 boss 前 5）。',
  ' * 插件版本：' + (addonVersion || '(未知)'),
  ' *',
  ' * 编码：每个专精存一套完整基准 base，其余套只存与基准的差异 builds[i]',
  ' *       （扁平 [dictIdx, rank, ...]，rank=0 表示这套没点）。还原见 app/talents.js',
  ' *       的 AE.Talents.buildOf()，两边算法必须一致 —— 生成时已自检过一遍。',
  ' *',
  ' * 要更新：node tools\\gen-talents.js',
  ' */'
].join('\n');

var body = header + '\nwindow.AE_TALENTS = ' + JSON.stringify(payload) + ';\n';
var outPath = path.join(BASE, 'app', 'talent-data.js');
fs.writeFileSync(outPath, body, 'utf8');

// Buffer.byteLength，不是 .length —— 中文一个字符占 3 字节，按字符数报会少算一大截。
console.log('源文件        ' + (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('输出          app/talent-data.js  ' + (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('专精          ' + stat.specs);
console.log('天赋套数      ' + stat.builds + '（含基准 ' + stat.specs + ' 套）');
console.log('数字          ' + stat.rawNums + ' → ' + stat.encNums +
            '（省 ' + (100 - stat.encNums / stat.rawNums * 100).toFixed(1) + '%）');
console.log('boss/副本条目 ' + stat.encounters + '，玩家记录 ' + stat.players);
console.log('字符串池      服务器 ' + servers.list.length + '，英雄天赋 ' + heroes.list.length);
