/*
 * WowAltBoard - tools/fetch-maxroll.js
 *
 * 从 maxroll.gg 抓每个专精的「最佳」装备推荐，产出 app/maxroll-data.js。
 *
 * 为什么是 maxroll
 * ---------------
 * raider.io 给的是**实战分布**（榜上的人在穿什么，带真实样本量），
 * 那回答的是「大家穿什么」。maxroll 给的是**编辑给出的排序**
 * （Best in Slot / Farmable Alternatives），回答的是「应该穿什么」。
 * 两件事不一样，所以这份数据不替换 app/rio-data.js，是另一个视角。
 *
 * 网络（本机 2026-08 实测）
 * ------------------------
 * maxroll.gg **直连 200，不用代理**。原始 HTML 缓存在 tools/.maxroll-raw/
 * （每篇 600~750 KB，70 篇约 45 MB），存在就跳过，所以中断能续。
 * 那个目录已进 .gitignore 和 build-release.ps1 的排除名单 —— 产出物只有
 * app/maxroll-data.js，上游 HTML 是人家的编辑作品，没有理由进仓库。
 *
 * 五个会咬人的地方，全是探针实测出来的（每条都别删，删了下次还得再量一遍）
 * ----------------------------------------------------------------------
 *  ① **类名带构建哈希**。`_tabsV2_8e8q7_1`、`_headerText_8e8q7_57` 中间那段
 *     （`8e8q7`）是前端构建产生的，**换一次部署就会变**。只能按前缀匹配
 *     `_tabsV2_[a-z0-9]+_\d+`，写死完整类名下次就抓不到。
 *  ② **切块时会切到自己**。找「下一个 tab 块从哪开始」必须用整个
 *     `'<div class="_tabsV2_'` 去找，不能只找 `'_tabsV2_'` ——
 *     后者在本块开头 start+12 处就有，每次都命中自己，切出来的段只有 12 字节，
 *     结果 8 篇全部报「装备块 0」。
 *  ③ **不能按标签文字认 BiS 表**。8 篇样本里 7 篇写 `Best in Slot`，
 *     1 篇写 `Overall BiS`。按位置认：装备块里第一张 `Slot|Item|Location`
 *     表是 BiS，第二张是可刷替代。标签只用来做一致性校验，对不上就报出来。
 *  ④ **不能按 slug 后缀筛指南**。`devourer-demon-hunter-mythic-guide`
 *     是唯一的 `-mythic-guide` 变体（恶魔猎手新专精），写死
 *     `raid|mythic-plus` 会把它漏掉。按「能不能解出 specID」筛。
 *  ⑤ **槽位名有 9 种拼法，不许手写映射**。非武器槽位干净（14 个名字在
 *     16 次里每次都出现），武器一塌糊涂：`Weapon` / `Off-Hand` / `Off-hand` /
 *     `Off hand` / `Main-hand` / `One-Hand Weapon` / `Two-Hand Weapon` /
 *     `1h Weapon` / `Weapon Off-Hand`。大小写、连字符、空格都不统一。
 *     手写必然漏，而且漏了不报错，只会让某个部位静默消失。
 *     做法见下面 deriveSlotMap()：拿 rio 的真值当桥推导。
 *
 * 用法
 * ----
 *   node tools\fetch-maxroll.js            抓全部 70 篇（有缓存的跳过）
 *   node tools\fetch-maxroll.js --limit 8  只抓前 8 篇（开发用）
 *   node tools\fetch-maxroll.js --report   只用现有缓存重算，不联网
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');

var ROOT = path.join(__dirname, '..');
var CACHE = path.join(__dirname, '.maxroll-raw');
var OUT = path.join(ROOT, 'app', 'maxroll-data.js');
var LIST_FILE = path.join(CACHE, 'class-guides.html');
var BASE = 'https://maxroll.gg';
var LIST_URL = BASE + '/wow/class-guides';

var argv = process.argv.slice(2);
var LIMIT = (function () {
  var i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1]) : 0;
})();
var REPORT_ONLY = argv.indexOf('--report') >= 0;

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

/* ---------------------------------------------------------------- 网络 */

function get(url, cb) {
  var req = https.get(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'en' }
  }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      get(new URL(res.headers.location, url).href, cb);
      return;
    }
    var bufs = [];
    res.on('data', function (d) { bufs.push(d); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(bufs).toString('utf8')); });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
}

// 缓存优先。返回 (err, html, fromCache)
function fetchPage(file, url, cb) {
  if (fs.existsSync(file)) { cb(null, fs.readFileSync(file, 'utf8'), true); return; }
  if (REPORT_ONLY) { cb(new Error('--report 模式下没有缓存: ' + path.basename(file))); return; }
  get(url, function (e, code, body) {
    if (e) { cb(e); return; }
    // 404 = 这篇指南真不存在（推导出来的候选里会有），和「请求失败」分开报。
    if (code === 404) { cb(null, null, false, true); return; }
    if (code !== 200) { cb(new Error('HTTP ' + code + ' ' + url)); return; }
    fs.writeFileSync(file, body);
    cb(null, body, false);
  });
}

/* -------------------------------------------------------------- HTML 解析 */

function strip(h) {
  return h.replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// tab 块。坑 ①②：类名按前缀匹配；找下一块要用完整的 '<div class="_tabsV2_'。
function tabBlocks(html) {
  var out = [];
  var re = /<div class="_tabsV2_[a-z0-9]+_\d+"/g, m;
  while ((m = re.exec(html))) {
    var start = m.index;
    var nxt = html.indexOf('<div class="_tabsV2_', start + 1);
    var seg = html.slice(start, nxt < 0 ? html.length : nxt);
    var labels = [];
    var lre = /class="_headerText_[a-z0-9]+_\d+"[^]*?<span>([\s\S]*?)<\/span>/g, lm;
    while ((lm = lre.exec(seg))) labels.push(strip(lm[1]));
    out.push({ labels: labels, tables: seg.match(/<table[\s\S]*?<\/table>/g) || [] });
  }
  return out;
}

// 表格 → 单元格原始 HTML 的二维数组（保留 HTML，itemId 在属性里）
function rawRows(tbl) {
  return (tbl.match(/<tr>[\s\S]*?<\/tr>/g) || []).map(function (tr) {
    return tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [];
  });
}

// 坑 ⑥：**冒号是可选的**。装备格里是 `data-wow-item="271874:<base64>"`（带 bonusID 串），
// 附魔格里是 `data-wow-item="243951"`（光秃秃一个 id）。第一版正则写死了冒号，
// 结果附魔表整张静默变空 —— 8 篇里 fury-warrior 报「附魔 0」就是这么来的，
// 而其余 7 篇「附魔 8~10」也是漏报（只捞到了碰巧带冒号的那些）。
function itemIdsIn(htmlFrag) {
  var ids = [], re = /data-wow-item="(\d+)/g, m;
  while ((m = re.exec(htmlFrag))) ids.push(Number(m[1]));
  return ids;
}

function isGearTable(tbl) {
  var r = rawRows(tbl)[0] || [];
  return strip(r[0] || '') === 'Slot' && strip(r[1] || '') === 'Item';
}

// 装备块 = 含 Slot|Item 表头的 tab 块
function gearBlock(html) {
  var blocks = tabBlocks(html);
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].tables.some(isGearTable)) return blocks[i];
  }
  return null;
}

/* -------------------------------------------------- 槽位映射（坑 ⑤：推导，不手写） */

// 载入 app/rio-data.js 里的 AE_RIO 当真值桥梁。
// 它的 specs[*].slots 是「暴雪槽位编号 → 物品行」，等于给出 itemId → 槽位编号。
function loadRio() {
  var f = path.join(ROOT, 'app', 'rio-data.js');
  if (!fs.existsSync(f)) throw new Error('缺 app/rio-data.js —— 槽位映射要靠它当真值桥梁，先跑 fetch-rio.js');
  var win = {};
  new Function('window', fs.readFileSync(f, 'utf8'))(win); // eslint-disable-line no-new-func
  return win.AE_RIO;
}

// itemId → 槽位编号（rio 侧真值，同一件出现在多个槽位时取票数最高的）
function rioSlotOf(RIO) {
  var acc = {};
  Object.keys(RIO.specs).forEach(function (sid) {
    var slots = RIO.specs[sid].slots || {};
    Object.keys(slots).forEach(function (sn) {
      (slots[sn].d || []).forEach(function (row) {
        var id = row[0];
        acc[id] = acc[id] || {};
        acc[id][sn] = (acc[id][sn] || 0) + (row[1] || 1);
      });
    });
  });
  var best = {};
  Object.keys(acc).forEach(function (id) {
    var m = acc[id], b = null;
    Object.keys(m).forEach(function (s) { if (b === null || m[s] > m[b]) b = s; });
    best[id] = Number(b);
  });
  return best;
}

// 天生分不开的槽位：戒指和饰品可以互换，靠物品投票必然是 50~65%。
// 它们按**表内出现顺序**定，不靠投票 —— 顺序是表格自带的信息，不是猜的。
//
// 带编号的直接读编号：
var POSITIONAL = { 'Ring 1': 11, 'Ring 2': 12, 'Trinket 1': 13, 'Trinket 2': 14 };
// 不带编号的（实测 4 篇死骑指南用光秃秃的 `Ring`，占两行）按第几次出现定。
// 实测证据：那两行 rio 给的槽位是**反的**（第 10 行→12、第 11 行→11），
// 因为榜上的人左右手戴哪个纯属随机 —— 投票在这种槽位上没有意义。
var POSITIONAL_FAMILY = {
  Ring: [11, 12], Rings: [11, 12],
  Trinket: [13, 14], Trinkets: [13, 14]
};

// 解析时给每一行算出「这是本表里这个名字的第几次出现」，交给这里定槽位。
// 返回 undefined = 这个名字不是位置型的，走投票。
function positionalSlot(slotName, occ) {
  if (POSITIONAL[slotName] !== undefined) return POSITIONAL[slotName];
  var fam = POSITIONAL_FAMILY[slotName];
  if (fam) return fam[Math.min(occ, fam.length - 1)];
  return undefined;
}

/* ------------------------------------------- 附魔表的槽位名：另一套拼法，另一条推导 */

// 附魔表用的名字和装备表**不是一套**（实测 80 篇：Waist×56、Shoulders×37、Helm×14
// 在装备表里从来没出现过）。投票在这里用不上 —— 附魔物品不在 rio 的装备池里，查不到槽位。
//
// 所以走第二条独立推导：拿**暴雪自己的槽位键名**做规范化匹配。
// 键表来源 app/bis.js 的 SLOT_KEY（INVSLOT 编号 → HEADSLOT / WAISTSLOT 那套），
// 去掉 SLOT 后缀、转小写、去掉复数尾巴，两边对齐。
// 实测这一步能自动接上 Waist→6、Shoulders→3，不用手写。
var SLOT_KEY = {
  1: 'HEADSLOT', 2: 'NECKSLOT', 3: 'SHOULDERSLOT', 5: 'CHESTSLOT',
  6: 'WAISTSLOT', 7: 'LEGSSLOT', 8: 'FEETSLOT', 9: 'WRISTSLOT',
  10: 'HANDSSLOT', 11: 'FINGER0SLOT', 12: 'FINGER1SLOT',
  13: 'TRINKET0SLOT', 14: 'TRINKET1SLOT', 15: 'BACKSLOT',
  16: 'MAINHANDSLOT', 17: 'SECONDARYHANDSLOT'
};

function normSlotWord(s) {
  return String(s).toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
}

var BLIZZ_BY_WORD = (function () {
  var m = {};
  Object.keys(SLOT_KEY).forEach(function (n) {
    m[normSlotWord(SLOT_KEY[n].replace(/SLOT$/, ''))] = Number(n);
  });
  return m;
})();

// 规范化也接不上的同义词。**只放规范化真的解决不了的**，而且每一条都要有实测依据 ——
// 手写映射的危险在于「漏了不报错」，所以这张表故意只有一条，
// 其余同义词（Belt / Cloak / Boots / Gloves）在装备表里出现过，已经由投票覆盖。
// Helm：实测 14 次，全部出现在附魔表第一行，配的是「Enchant Helm - …」头部附魔。
var SLOT_SYNONYM = { helm: 1 };

// 附魔槽位名 → INVSLOT。三条路依次试：装备表投票出来的 map、暴雪键规范化、同义词。
function enchantSlot(slotName, slotMap) {
  if (slotMap[slotName] !== undefined) return slotMap[slotName];
  var w = normSlotWord(slotName);
  if (BLIZZ_BY_WORD[w] !== undefined) return BLIZZ_BY_WORD[w];
  if (SLOT_SYNONYM[w] !== undefined) return SLOT_SYNONYM[w];
  return undefined;
}

// 投票推导 maxroll 槽位名 → 暴雪槽位编号。
// 判据：POSITIONAL 之外的名字，最高票必须 100%；掉下来就抛错，不静默接受。
// 阈值定在 95%，不是 100%。理由是实测出来的：
// itemId 271537（深渊末日猎犬的无情凝视）在 maxroll 排颈部，rio 的多数票说它是头部 ——
// 160 张 Neck 票里就这 1 张脏。要求 100% 会因为**上游一件物品的分歧**否掉整张映射表，
// 那是过度敏感。但脏票必须打印出来，不许静默吞掉。
var VOTE_MIN = 0.95;

function deriveSlotMap(pairs, rioSlot) {
  var vote = {}, miss = 0;
  pairs.forEach(function (p) {
    if (p.slot in POSITIONAL || p.slot in POSITIONAL_FAMILY) return;   // 位置型不参与投票
    var s = rioSlot[p.id];
    if (s === undefined) { miss++; return; }
    vote[p.slot] = vote[p.slot] || {};
    vote[p.slot][s] = (vote[p.slot][s] || 0) + 1;
  });

  var map = {}, weak = [], dirty = [];
  Object.keys(vote).forEach(function (nm) {
    var v = vote[nm], tot = 0, b = null;
    Object.keys(v).forEach(function (s) { tot += v[s]; if (b === null || v[s] > v[b]) b = s; });
    var pct = v[b] / tot;
    map[nm] = Number(b);

    var isWeapon = /weapon|hand/i.test(nm);
    if (isWeapon) {
      // 武器名天生会混（同一张表第二行的 `Weapon` 其实是副手），比例不作要求，
      // 但**必须落在主手或副手上**，落到别处就是推错了。
      if (Number(b) !== 16 && Number(b) !== 17) {
        weak.push(nm + ' 推出了槽位 ' + b + '，武器只该是 16 或 17（' + tot + ' 票）');
      }
    } else if (pct < VOTE_MIN) {
      weak.push(nm + ' 最高票只占 ' + Math.round(pct * 100) + '%（' + tot + ' 票，'
        + Object.keys(v).sort(function (a, c) { return v[c] - v[a]; })
          .map(function (s) { return s + '×' + v[s]; }).join(' ') + '）');
    } else if (pct < 1) {
      dirty.push(nm + ' → ' + b + '（' + Math.round(pct * 100) + '%，'
        + (tot - v[b]) + '/' + tot + ' 票和 rio 的多数票不一致）');
    }
  });

  Object.keys(POSITIONAL).forEach(function (nm) { map[nm] = POSITIONAL[nm]; });
  Object.keys(POSITIONAL_FAMILY).forEach(function (nm) { map[nm] = POSITIONAL_FAMILY[nm][0]; });

  if (weak.length) {
    throw new Error('槽位映射推导不可信，拒绝生成：\n  ' + weak.join('\n  '));
  }
  return { map: map, miss: miss, dirty: dirty };
}

/* ------------------------------------------------ slug → specId（坑 ④：不按后缀猜） */

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

// 用 rio 的 40 个专精建「<专精>-<职业>」→ specId。
// 筛指南靠这张表命中，而不是靠 slug 后缀是不是 -raid-guide。
function buildSpecIndex(RIO) {
  var idx = {};
  Object.keys(RIO.specs).forEach(function (sid) {
    var s = RIO.specs[sid];
    idx[slugify(s.specEn) + '-' + slugify(s.cls)] = Number(sid);
  });
  return idx;
}

// 从 slug 里解出 specId 和内容类型。解不出来返回 null（升级指南、职业落地页都走这条）。
function resolveSlug(slug, specIdx) {
  var kind = /-raid-guide$/.test(slug) ? 'raid'
    : /-mythic-plus-guide$/.test(slug) ? 'mplus'
      : /-mythic-guide$/.test(slug) ? 'mplus'
        : null;
  if (!kind) return null;
  if (/-leveling-guide$/.test(slug)) return null;
  var stem = slug.replace(/-(raid|mythic-plus|mythic)-guide$/, '');
  var sid = specIdx[stem];
  if (sid === undefined) return null;
  return { specId: sid, kind: kind };
}

function listSlugs(html) {
  var re = /\/wow\/class-guides\/([a-z0-9-]+)/g, m, seen = {};
  while ((m = re.exec(html))) seen[m[1]] = 1;
  return Object.keys(seen).sort();
}

// **列表页不全**（本机实测）：class-guides 页面只列出 70 篇，
// 但按 <专精>-<职业>-{raid,mythic-plus}-guide 推导出来的 URL 里，
// 列表页没提到的 10 篇**全部直连 200**（holy-paladin 两篇、protection-warrior 两篇、
// feral-druid 两篇、brewmaster-monk 两篇、fury-warrior mplus、havoc-demon-hunter mplus，
// 各 519~761 KB 真页面）。所以候选集 = 推导的 80 篇 ∪ 列表页解出来的，
// 404 才算「这篇真不存在」。只靠列表页会静默少 14% 的专精。
function deriveTargets(RIO, listHtml, specIdx) {
  var byKey = {};   // slug → {slug, specId, kind}
  function add(slug, specId, kind) {
    if (!byKey[slug]) byKey[slug] = { slug: slug, specId: specId, kind: kind };
  }

  // ① 从 40 个专精推导
  Object.keys(RIO.specs).forEach(function (sid) {
    var s = RIO.specs[sid];
    var stem = slugify(s.specEn) + '-' + slugify(s.cls);
    add(stem + '-raid-guide', Number(sid), 'raid');
    add(stem + '-mythic-plus-guide', Number(sid), 'mplus');
  });

  // ② 列表页里能解出 specId 的补进来（捞 devourer 那种 -mythic-guide 变体）
  listSlugs(listHtml).forEach(function (slug) {
    var r = resolveSlug(slug, specIdx);
    if (r) add(slug, r.specId, r.kind);
  });

  return Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
}

/* --------------------------------------------------------------- 单篇解析 */

// 装备块里 4 张表，位置固定（8/8 样本一致）：
//   表 0  Slot|Item|Location   Best in Slot
//   表 1  Slot|Item|Location   Farmable Alternatives
//   表 2  Rank|Trinkets        饰品分级
//   表 3  第一格是槽位名        附魔
// 坑 ③：按位置认，标签只做校验。
function parseGuide(html, slug) {
  var blk = gearBlock(html);
  if (!blk) return { error: '没有装备块' };

  var gearTables = blk.tables.filter(isGearTable);
  if (gearTables.length < 1) return { error: '装备块里没有 Slot|Item 表' };

  // occ = 这个槽位名在本表里第几次出现（从 0 起）。
  // 光秃秃的 `Ring` 占两行，靠它区分主副戒指 —— 顺序只有解析时知道，
  // 所以必须在这里记下来，不能等到聚合阶段再猜。
  function readGear(tbl) {
    var out = [], seen = {};
    var rs = rawRows(tbl);
    for (var i = 1; i < rs.length; i++) {
      var cells = rs[i];
      if (cells.length < 2) continue;
      var slotName = strip(cells[0]);
      if (!slotName) continue;
      var ids = itemIdsIn(cells[1]);
      if (!ids.length) continue;
      var occ = seen[slotName] || 0;
      seen[slotName] = occ + 1;
      out.push({ slotName: slotName, occ: occ, ids: ids, loc: strip(cells[2] || '') });
    }
    return out;
  }

  var bis = readGear(gearTables[0]);
  var alt = gearTables.length > 1 ? readGear(gearTables[1]) : [];

  // 标签一致性校验：第一个标签应该是 BiS 那类说法。不匹配只记警告，不当失败
  // （已知 8 篇里有 1 篇写 Overall BiS 而不是 Best in Slot）。
  var warn = null;
  var lab0 = (blk.labels[0] || '');
  if (!/best in slot|overall bis|bis/i.test(lab0)) {
    warn = slug + ' 第一个标签是「' + lab0 + '」，不像 BiS 表，位置和标签可能错位';
  }

  // 附魔表：第 3 张表，第一格是槽位名，不是 Slot 表头
  var ench = [];
  blk.tables.forEach(function (t) {
    if (isGearTable(t)) return;
    var rs = rawRows(t), hdr = (rs[0] || []).map(strip);
    if (hdr[0] === 'Rank') return;    // 饰品分级表
    for (var i = 0; i < rs.length; i++) {
      var cells = rs[i];
      if (cells.length < 2) continue;
      var nm = strip(cells[0]);
      var ids = itemIdsIn(cells[1]);
      if (nm && ids.length) ench.push({ slotName: nm, ids: ids });
    }
  });

  // 饰品分级表：表头 Rank|Trinkets
  var tiers = [];
  blk.tables.forEach(function (t) {
    var rs = rawRows(t), hdr = (rs[0] || []).map(strip);
    if (hdr[0] !== 'Rank') return;
    for (var i = 1; i < rs.length; i++) {
      var cells = rs[i];
      if (cells.length < 2) continue;
      var rank = strip(cells[0]);
      var ids = itemIdsIn(cells[1]);
      if (rank && ids.length) tiers.push({ rank: rank, ids: ids });
    }
  });

  return { bis: bis, alt: alt, ench: ench, tiers: tiers, labels: blk.labels, warn: warn };
}

/* ------------------------------------------------------------------- 主流程 */

function main() {
  var RIO = loadRio();
  var specIdx = buildSpecIndex(RIO);
  var rioSlot = rioSlotOf(RIO);
  console.log('rio 真值：' + Object.keys(RIO.specs).length + ' 个专精，'
    + Object.keys(rioSlot).length + ' 件物品带槽位');

  fetchPage(LIST_FILE, LIST_URL, function (e, listHtml) {
    if (e) { console.error('列表页失败：' + e.message); process.exit(1); }

    var listOnly = listSlugs(listHtml).filter(function (s) { return resolveSlug(s, specIdx); }).length;
    var targets = deriveTargets(RIO, listHtml, specIdx);
    console.log('候选指南 ' + targets.length + ' 篇（列表页只能解出 ' + listOnly + ' 篇，'
      + '差额靠 40 个专精推导补上）'
      + '：raid ' + targets.filter(function (t) { return t.kind === 'raid'; }).length
      + ' / mplus ' + targets.filter(function (t) { return t.kind === 'mplus'; }).length);

    if (LIMIT) targets = targets.slice(0, LIMIT);
    if (REPORT_ONLY) {
      targets = targets.filter(function (t) { return fs.existsSync(path.join(CACHE, t.slug + '.html')); });
      console.log('--report：只用现有缓存 ' + targets.length + ' 篇');
    }

    var parsed = [], failed = [], warns = [], pairs = [], downloaded = 0, absent = [];

    (function loop(i) {
      if (i >= targets.length) return finish();
      var t = targets[i];
      fetchPage(path.join(CACHE, t.slug + '.html'), BASE + '/wow/class-guides/' + t.slug,
        function (err, html, cached, notFound) {
          if (err) {
            failed.push(t.slug + '：' + err.message);
            console.log('  ✗ ' + t.slug + ' —— ' + err.message);
            return next(true);
          }
          if (notFound) {
            absent.push(t.slug);
            return next(false);
          }
          if (!cached) downloaded++;
          var g = parseGuide(html, t.slug);
          if (g.error) {
            failed.push(t.slug + '：' + g.error);
            console.log('  ✗ ' + t.slug + ' —— ' + g.error);
            return next(cached);
          }
          if (g.warn) warns.push(g.warn);
          g.bis.concat(g.alt).forEach(function (r) {
            r.ids.forEach(function (id) { pairs.push({ slot: r.slotName, id: id }); });
          });
          parsed.push({ t: t, g: g });
          console.log('  ✓ ' + t.slug + (cached ? '（缓存）' : '（新下）')
            + '  BiS ' + g.bis.length + ' 行 / 替代 ' + g.alt.length
            + ' 行 / 附魔 ' + g.ench.length + ' / 饰品 ' + g.tiers.length);
          next(cached);
        });

      function next(wasCached) {
        // 只在真的联网之后才限速
        setTimeout(function () { loop(i + 1); }, wasCached ? 0 : 700);
      }
    })(0);

    function finish() {
      console.log('\n解析成功 ' + parsed.length + ' 篇，失败 ' + failed.length
        + '，404 不存在 ' + absent.length + ' 篇，新下载 ' + downloaded + ' 篇');
      if (absent.length) console.log('  （404：' + absent.join('，') + '）');
      if (!parsed.length) { console.error('一篇都没解析成功，不生成产物'); process.exit(1); }

      var d = deriveSlotMap(pairs, rioSlot);
      var slotMap = d.map;
      console.log('槽位映射推导：' + Object.keys(slotMap).length + ' 个名字，'
        + d.miss + ' 条配对在 rio 真值里查不到');
      if (d.dirty.length) {
        console.log('  脏票（推导仍然可信，但上游两家对这些物品的槽位有分歧）：');
        d.dirty.forEach(function (x) { console.log('     ' + x); });
      }

      writeOut(parsed, slotMap, RIO, { failed: failed, warns: warns, total: targets.length });
    }
  });
}

/* ------------------------------------------------------------------- 产物 */

function writeOut(parsed, slotMap, RIO, meta) {
  // 物品池：中文名 / 图标 / 品质 先复用 rio 已经查好的 2432 件。
  // rio 里没有的（实测 36 件，多是附魔和只在 maxroll 出现的替代件）从**暴雪 DB2**
  // 的 ItemSparse.csv 补中文名 —— 那份 CSV 已经是 fetch-rio.js 下好的本地缓存，
  // 不用多联一次网。图标名 DB2 里没有，留空，由 tools/fetch-icons.js 那条路补。
  var items = {}, unknown = {};
  function noteItem(id) {
    if (items[id]) return;
    var r = RIO.items[id];
    if (r) items[id] = { n: r.n, i: r.i, q: r.q };
    else { items[id] = { n: '', i: '', q: 0 }; unknown[id] = 1; }
  }

  var specs = {};
  var unmapped = {}, unmappedEnch = {};
  parsed.forEach(function (p) {
    var sid = p.t.specId, kind = p.t.kind;
    var s = specs[sid] = specs[sid] || {
      cls: RIO.specs[sid].cls, specEn: RIO.specs[sid].specEn, views: {}
    };
    var v = s.views[kind] = { slug: p.t.slug, bis: {}, alt: {}, ench: {}, tiers: [] };

    function put(target, rowList) {
      rowList.forEach(function (r) {
        // 位置型槽位（Ring / Trinket 那些）优先按表内出现次序定，
        // 剩下的才查投票推出来的 slotMap。
        var sn = positionalSlot(r.slotName, r.occ || 0);
        if (sn === undefined) sn = slotMap[r.slotName];
        if (sn === undefined) { unmapped[r.slotName] = (unmapped[r.slotName] || 0) + 1; return; }
        // 同一槽位在表里可能出现两行（双戒指/双武器），按出现顺序追加
        target[sn] = target[sn] || [];
        r.ids.forEach(function (id) {
          noteItem(id);
          if (target[sn].indexOf(id) < 0) target[sn].push(id);
        });
      });
    }
    put(v.bis, p.g.bis);
    put(v.alt, p.g.alt);

    p.g.ench.forEach(function (r) {
      // 附魔表用的是另一套拼法，走 enchantSlot 的三条路（见它的注释）。
      // 映射不到不算致命，但**必须报出来**，否则某个部位的附魔会静默消失。
      var sn = enchantSlot(r.slotName, slotMap);
      if (sn === undefined) { unmappedEnch[r.slotName] = (unmappedEnch[r.slotName] || 0) + 1; return; }
      v.ench[sn] = v.ench[sn] || [];
      r.ids.forEach(function (id) { noteItem(id); if (v.ench[sn].indexOf(id) < 0) v.ench[sn].push(id); });
    });
    p.g.tiers.forEach(function (r) {
      r.ids.forEach(noteItem);
      v.tiers.push([r.rank, r.ids]);
    });
  });

  // 补 rio 池里查不到的中文名。CSV 不在就跳过（并说出来），不当失败 ——
  // 那只是「这台机器还没下过 DB2」，不是数据错。
  var db2Hit = 0, db2Want = Object.keys(unknown).length, db2Skipped = false;
  if (db2Want) {
    var csv = path.join(__dirname, '.db2-names', 'ItemSparse.csv');
    if (!fs.existsSync(csv)) {
      db2Skipped = true;
    } else {
      var want = {};
      Object.keys(unknown).forEach(function (id) { want[String(id)] = 1; });
      var txt = fs.readFileSync(csv, 'utf8');
      var nl = txt.indexOf('\n');
      var head = txt.slice(0, nl).replace(/\r$/, '').split(',');
      var iId = head.indexOf('ID'), iName = head.indexOf('Display_lang');
      if (iId !== 0 || iName < 0) {
        throw new Error('ItemSparse.csv 表头变了（ID 不在第 0 列或缺 Display_lang）—— 上游改表了');
      }
      var pos = nl + 1;
      while (pos < txt.length) {
        var end = txt.indexOf('\n', pos);
        if (end < 0) end = txt.length;
        var comma = txt.indexOf(',', pos);
        if (comma > pos && comma < end) {
          var id = txt.slice(pos, comma);
          if (want[id]) {
            // 名字里可能有逗号和引号，所以命中之后才按 CSV 规则切整行
            var line = txt.slice(pos, end).replace(/\r$/, '');
            var f = [], cur = '', q = false;
            for (var ci = 0; ci < line.length; ci++) {
              var ch = line[ci];
              if (q) {
                if (ch === '"') { if (line[ci + 1] === '"') { cur += '"'; ci++; } else q = false; }
                else cur += ch;
              } else if (ch === '"') q = true;
              else if (ch === ',') { f.push(cur); cur = ''; }
              else cur += ch;
            }
            f.push(cur);
            if (f[iId] === id && f[iName]) { items[id].n = f[iName]; db2Hit++; }
          }
        }
        pos = end + 1;
      }
    }
  }

  var data = {
    v: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'maxroll.gg 职业指南（Best in Slot / Farmable Alternatives 两张表 + 附魔 + 饰品分级）',
    itemNameSource: '复用 app/rio-data.js 的物品池（暴雪 DB2 ItemSparse locale=zhCN）',
    note: '这是**编辑给出的推荐排序**，不是使用率统计 —— 没有样本量，'
      + 'bis / alt 两个列表都按 maxroll 表里的顺序排。槽位编号沿用暴雪 INVSLOT，'
      + '和 app/rio-data.js、app/bis-data.js 同一套。',
    fmt: {
      specs: 'specId → {cls, specEn, views}',
      views: 'raid | mplus → {slug, bis 槽位→[itemId…], alt 同, ench 槽位→[itemId…], tiers [[分级, [itemId…]]…]}',
      items: 'itemId → {n 中文名, i 图标名, q 品质}（名字空字符串 = rio 池里没有，待补）'
    },
    guides: parsed.length,
    slotMap: slotMap,
    items: items,
    specs: specs
  };

  var body = '/* 自动生成，勿手改。生成器：tools/fetch-maxroll.js */\n'
    + 'window.AE_MAXROLL = ' + JSON.stringify(data) + ';\n';
  fs.writeFileSync(OUT, body);

  console.log('\n产物 app/maxroll-data.js  '
    + (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1) + ' KB');
  console.log('  专精 ' + Object.keys(specs).length + ' / 40，物品池 '
    + Object.keys(items).length + ' 件');
  if (db2Want) {
    console.log('  rio 池里没有的 ' + db2Want + ' 件：'
      + (db2Skipped ? '跳过补名（本机没有 tools\\.db2-names\\ItemSparse.csv）'
        : 'DB2 补上 ' + db2Hit + ' 个中文名'));
  }
  var noName = Object.keys(items).filter(function (id) { return !items[id].n; }).length;
  if (noName) console.log('  仍然没有中文名的：' + noName + ' 件');
  var noIcon = Object.keys(items).filter(function (id) { return !items[id].i; }).length;
  if (noIcon) console.log('  没有图标名的：' + noIcon + ' 件（跑 tools\\fetch-icons.js 补）');
  if (Object.keys(unmapped).length) {
    console.log('  ⚠ 装备表里映射不到的槽位名：'
      + Object.keys(unmapped).map(function (k) { return k + '×' + unmapped[k]; }).join('，'));
  }
  if (Object.keys(unmappedEnch).length) {
    console.log('  ⚠ 附魔表里映射不到的槽位名（这些部位的附魔会缺）：'
      + Object.keys(unmappedEnch).map(function (k) { return k + '×' + unmappedEnch[k]; }).join('，'));
  }
  if (meta.warns.length) {
    console.log('  ⚠ 标签校验警告 ' + meta.warns.length + ' 条：');
    meta.warns.slice(0, 5).forEach(function (w) { console.log('     ' + w); });
  }
  if (meta.failed.length) {
    console.log('  ⚠ 失败 ' + meta.failed.length + '/' + meta.total + ' 篇：');
    meta.failed.slice(0, 10).forEach(function (f) { console.log('     ' + f); });
  }
}

main();
