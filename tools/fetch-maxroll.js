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

// 解码器提到模块作用域：toGameLoadout 要拿它当「削尾之后还能不能解开」的闸。
// 放在 writeOut 里的局部变量拿不到（那个函数在后面）。
var DEC_MOD = require('./decode-talent-string.js');
var DEC_ORDER = null;
function decOrder() {
  if (!DEC_ORDER) DEC_ORDER = DEC_MOD.loadOrder();
  return DEC_ORDER;
}

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

/**
 * 页面的**结构树**。天赋方案分单体 / AOE、每个首领的说明、优先级列表 ——
 * 这三样都不在渲染后的 HTML 里，它们在 `__remixContext` 的
 * `branch-posts.post.gutenbergBlock` 里：一棵 WordPress block 树，
 * `innerBlocks` 是真的嵌套，每个 embed 的**祖先链**才带得出「这是哪个场景 /
 * 哪个首领的」。
 *
 * 为什么不继续用正则扒渲染后的 HTML（上一版就是）：场景标签写在 tab 头里，
 * 而 tab 是**嵌套**的（外层 `Single Target ・ Templar`，里层 `Radiant Glory`），
 * 拿「往前找最近的一个」会取到里层那个，实测 833 个 embed 一个场景都认不出来。
 * 走树才能拿到整条祖先链。
 *
 * 实测（81 篇缓存）：80 篇能解出这棵树，1 篇解不出（那一篇的 blob 里有
 * JSON.parse 咽不下的东西）—— 解不出就退回原来那条正则路，不让整篇丢掉。
 *
 * 截取用**括号配平**，不用正则：这段 JSON 里嵌着大量 HTML 和转义引号，
 * 正则截不了嵌套结构（试过 `[\s\S]*?\]`，截出来的是半截）。
 */
function guideBlocks(html) {
  var i = html.indexOf('"gutenbergBlock":');
  if (i < 0) return null;
  var start = html.indexOf('[', i);
  if (start < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var k = start; k < html.length; k++) {
    var c = html.charAt(k);
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, k + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/** block 的 innerHTML 里那一段 tab 头 / 标题 / figcaption 的纯文本。 */
function blockLabel(ih) {
  var hdr = /advgb-tab-body-header[^>]*>([\s\S]{0,400}?)<\/div>/.exec(ih);
  if (hdr) return { kind: 'tab', text: stripRich(hdr[1]) };
  var h = /<(h[234])[^>]*>([\s\S]{0,300}?)<\/\1>/.exec(ih);
  if (h) return { kind: h[1], text: stripRich(h[2]) };
  return null;
}

/**
 * 比 strip() 多做两件事，专给 block 树用：
 *   · `<br>` 换成「・」而不是删掉 —— tab 头是 `Single Target<br><span…>Templar</span>`，
 *     直接删会粘成「Single TargetTemplar」，场景词就认不出来了；
 *   · 认 `&lt;br&gt;`（blob 里是二次转义的）。
 */
function stripRich(h) {
  return String(h).replace(/<br\s*\/?>/gi, ' ・ ').replace(/&lt;br&gt;/gi, ' ・ ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------- 技能名换中文（见 walkGuide） */

// 官方中文名表。跑 tools\fetch-spell-names.js 生成；没有就整段留英文
// （**不报错**：面板画得出来，只是没中文，而下面的统计会把这件事说出来）。
var SPELL_ZH = (function () {
  var p = path.join(__dirname, 'spell-names-zh.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).names || {}; } catch (e) { return {}; }
})();

// 替换统计 + 给 fetch-spell-names.js 用的 ID 清单。
// 这两样都是「让漏掉的东西看得见」用的：光看产物没法分辨
// 「这段本来就没技能名」和「表里缺这个技能」。
var subst = { hit: 0, miss: 0, refs: {} };

/**
 * 把正文里的技能 span 换成中文名。**必须在 stripRich 之前调用** ——
 * stripRich 会把标签连 data-wow-id 一起扒掉，之后就只剩英文名可认了，
 * 而按英文名匹配就是在猜（同名不同技能、复数形式、大小写都会咬人）。
 *
 * ID 可能带后缀（实测 139 处形如 `126519:AJAC`），取前面的数字部分。
 */
function substSpells(h) {
  return String(h).replace(
    /<span class="wow-(?:spell|trait)" data-wow-id="(\d+)(?::[A-Za-z0-9]+)?"[^>]*>([^<]{1,80})<\/span>/g,
    function (all, id, en) {
      var clean = en.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
      subst.refs[id] = { en: clean, kind: all.indexOf('wow-trait') >= 0 ? 'trait' : 'spell' };
      var zh = SPELL_ZH[id];
      if (zh) { subst.hit++; return zh; }
      subst.miss++;
      return all;                      // 查不到就原样留着，让 stripRich 取出英文名
    });
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
/**
 * 天赋方案。**每套方案是一个独立的 embed，各带自己的串** —— 这一点是实测出来的，
 * 上一轮把整页的串混在一起统计，得到的结论全是废的。
 *
 *   <div class="wow-embed" data-wow-type="talents" data-wow-data="C6DAmxqme2N…">
 *   <figcaption><span class="wow-trait" data-wow-id="123341">Sunfury</span>
 *               <strong>… Arcane Mage Single-Target Raid Build</strong>
 *
 * 方案名取 figcaption 的纯文本。名字是这一步的**主要产物**：现在界面上只有
 * 「团本 / 冲分 / 割草」三个笼统的类别，而 maxroll 给的是「Sunfury 奥法单目标团本」
 * 这种一眼能选的名字。
 *
 * 串**原样保留**（只做 URL-safe → 标准 base64 的换字，见 normalizeB64 的注释），
 * 不在这里解码：解码要整棵天赋树，那是 app/talent-tree.js 的活，浏览器端和
 * 校验器各自解一遍还能互相对账。
 */
/**
 * 走 block 树，把三样**祖先链才带得出来的东西**抓下来。
 *
 * 一、天赋方案的**场景**（单体 / AOE / 顺劈 / 多目标）。
 *   实测这件事的形状和我以为的不一样：maxroll **不是每个专精都按场景分天赋**。
 *   80 篇里只有 **28 篇**这么分（230 条去重串里 72 条带场景标签，2 条被标成两个场景）。
 *   剩下的专精按「英雄天赋」分（`Soul Harvester` / `Hellcaller`）或按「副本」分
 *   （`Altar of Fangs` / `Murder Row`）。所以场景是**可选字段**，不是每套都有；
 *   面板见到没有场景的方案就不画那个标签，而不是编一个「单体」上去。
 *
 * 二、每个首领的说明（Boss Tips）。这是三样里最全的：**563 个小节、252 个有正文、
 *   涉及 71/80 篇**。祖先链的形状是 `首领名 > Boss Tips`（团本）或
 *   `副本名 > Boss Tips`（大秘境），所以首领 / 副本名取祖先链上倒数第二个。
 *
 * 三、优先级列表（Priority List）：**229 个小节，216 个能取到正文**。
 *   它就是「技能时间轴」的文字版 —— 图形时间轴那 226 个 rotation embed 是另一种
 *   编码（`embed-tools/rotation=…`），而正文里是同一份内容且**可读**，
 *   所以取正文，不去啃那个编码。
 *
 * 技能名换中文，句子留英文（第 19 轮定的）
 * ---------------------------------------
 * 这两块正文原先**整段留英文**，理由是「本机没有技能名的中英对照表」。
 * 那个理由只对了一半：本机翻遍 5339 个插件文件，1929 条英中对照里确实一条技能名
 * 都没有 —— 但 maxroll 的正文把每个技能都标了 ID：
 *
 *     <span class="wow-spell" data-wow-id="686">Shadow Bolt</span>
 *
 * 有 ID 就不用猜。tools/fetch-spell-names.js 按 ID 备了一张官方中文名表
 * （天赋来自 app/talent-tree.js 的暴雪 DB2 名，基础技能来自 Wowhead locale=4），
 * 这里按 ID 替换 —— **查不到的留英文，一个字都不猜**。
 *
 * 只换名词，**句子仍然是英文原文**。整句翻译得由人来做：像
 * 「hold this ability unless the boss requires otherwise」这种，机翻把
 * 「除非」翻反了，用户照着打就是错的，而界面上看不出来。名词替换不会翻反 ——
 * 它要么换对，要么原样不动。
 */
function walkGuide(blocks) {
  var out = { scen: {}, boss: [], prio: [] };
  if (!blocks) return out;

  // 场景词 → 短码。写成一张表而不是 if 链，因为 maxroll 的拼法不统一
  // （实测 `Single Target` / `Single-Target` / `Aoe` / `AoE` / `Multi-Target`
  // / `Multitarget` / `Cleave` 七种都出现过）。
  var SCEN_RE = /(single[ -]?target|aoe|cleave|multi[ -]?target|multitarget)/i;
  function scenOf(text) {
    var m = SCEN_RE.exec(text || '');
    if (!m) return '';
    var x = m[1].toLowerCase().replace(/[ -]/g, '');
    if (x === 'singletarget') return 'st';
    if (x === 'aoe') return 'aoe';
    if (x === 'cleave') return 'cleave';
    return 'multi';
  }

  /**
   * 标题后面**同级**的正文，直到下一个标题为止。
   *
   * 为什么不取 innerBlocks：Priority List 和 Boss Tips 的正文是标题的**兄弟节点**，
   * 不是子节点（WordPress 的 heading block 没有子块）。取子节点会得到空串 ——
   * 而空串会让「有 252 个首领说明」变成「有 0 个」，还不报错。
   */
  function bodyAfter(list, idx, cap) {
    var parts = [];
    for (var i = idx + 1; i < list.length; i++) {
      var ih = list[i].innerHTML || '';
      if (/<h[234][^>]*>/.test(ih)) break;          // 下一个标题，停
      // substSpells 在 stripRich 之前：见它自己的注释，顺序颠倒就只能按英文名猜了。
      var t = stripRich(substSpells(ih));
      if (t) parts.push(t);
      if (parts.join(' ').length > cap) break;
    }
    return parts.join(' ').slice(0, cap).trim();
  }

  /**
   * 「Priority List」标题后面跟的是分页容器时，一页一条出手顺序。
   *
   * 形状（实测）：`advgb/adv-tabs`，页名在 attributes.tabHeaders（HTML 串），
   * 正文在每个 `advgb/tab` 的 innerBlocks 里。**tab 自己的 innerHTML 只有页名**
   * （那个 advgb-tab-body-header），所以正文必须从 innerBlocks 取，
   * 从 tab 自己的 innerHTML 取只会又拿到页名。
   *
   * 不是分页容器就返回空数组，让调用者走原来那条路。
   */
  function tabPrio(blk, trail) {
    if (!blk || !/adv-tabs/.test(blk.blockName || '')) return [];
    var heads = (blk.attributes && blk.attributes.tabHeaders) || [];
    var out2 = [];
    (blk.innerBlocks || []).forEach(function (tab, i) {
      var body = (tab.innerBlocks || []).map(function (c) {
        return stripRich(substSpells(c.innerHTML || ''));
      }).filter(Boolean).join(' ').slice(0, 900).trim();
      if (!body) return;
      var nm = stripRich(substSpells(heads[i] || '')) || ('第 ' + (i + 1) + ' 页');
      out2.push({ n: nm, s: scenOf(trail.concat([nm]).join(' | ')), t: body });
    });
    return out2;
  }

  function walk(list, trail) {
    (list || []).forEach(function (b, idx) {
      var ih = b.innerHTML || '';
      var lab = blockLabel(ih);
      var next = lab ? trail.concat([lab.text]) : trail;

      // ---- 天赋 embed：场景来自**整条祖先链 + 自己的 figcaption**
      var url = b.attributes && b.attributes.url;
      var km = url && /embed-tools\/(\w+)=([A-Za-z0-9_\-]+)/.exec(url);
      if (km && km[1] === 'talents') {
        var cap = /<figcaption[^>]*>([\s\S]{0,400}?)<\/figcaption>/.exec(ih);
        var ctx = next.concat([cap ? stripRich(cap[1]) : '']).join(' | ');
        var sc = scenOf(ctx);
        if (sc) {
          var key = normalizeB64(km[2]);
          (out.scen[key] || (out.scen[key] = {}))[sc] = 1;
        }
      }

      if (lab && lab.kind !== 'tab') {
        // ---- 每个首领 / 副本的说明
        if (/^boss tips$/i.test(lab.text)) {
          var body = bodyAfter(list, idx, 700);
          // 祖先链倒数第二个就是首领名（最后一个是 'Boss Tips' 自己）。
          // 首领名里可能挂着 maxroll 编辑器留下的空 <a>（实测
          // `Den of Nalorakk<a href="Legacy of Tyr"></a>`），stripRich 去标签时
          // 会把 href 里的字留下来 —— 这里再切一刀。
          var who = next.length > 1 ? next[next.length - 2] : '';
          if (body && who) out.boss.push({ w: who, t: body });
        }
        // ---- 优先级列表（技能时间轴的文字版）
        if (/priority/i.test(lab.text)) {
          // 标题后面**可能是一个分页容器**而不是正文（实测 215 个 Priority 标题里
          // 有 3 个这样：防护骑双份 + 织雾僧）。那时候取兄弟节点抓到的是分页
          // 标签本身 —— 防护骑因此产出过一条正文只有「Lightsmith Templar」的
          // 假条目，而真正的两份出手顺序（铸光者 / 圣殿骑士各一份）一条都没收。
          //
          // 这个 bug 藏了一整轮，藏在校验器的字数下界里：那句标签 18 个字符，
          // 而下界是 10。下界现在按实测收紧到 40（真实出手顺序最短 67 字），
          // 这种形状再也过不去了。
          var tabbed = tabPrio(list[idx + 1], next);
          if (tabbed.length) {
            tabbed.forEach(function (r) { out.prio.push(r); });
          } else {
            var pb = bodyAfter(list, idx, 900);
            if (pb) {
              // 祖先链里带场景的话记下来，界面才能分「单体优先级 / AOE 优先级」。
              var ps = scenOf(next.join(' | '));
              out.prio.push({ n: next[next.length - 2] || lab.text, s: ps, t: pb });
            }
          }
        }
      }
      walk(b.innerBlocks, next);
    });
  }
  walk(blocks, []);
  return out;
}

function talentBuilds(html) {
  var out = [], seen = {};
  var re = /<div class="wow-embed"[^>]*data-wow-type="talents"[^>]*data-wow-data="([^"]+)"[^>]*>/g;
  var m;
  while ((m = re.exec(html))) {
    var str = m[1];
    // 方案名在 embed **后面**的 figcaption 里。往后找一段就够 —— 实测同一个
    // embed 和它的 figcaption 之间不到 2 KB；找太远会串到下一套方案的名字上。
    var tail = html.slice(m.index, m.index + 4000);
    var fc = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(tail);
    var name = fc ? strip(fc[1]).replace(/\s+/g, ' ').trim() : '';
    // 同一页会重复引用同一套方案（正文里讲一次、总结里再讲一次）。
    // 去重的键是「串 + 名字」：同一串挂两个不同名字时两条都留着，
    // 因为名字是给人看的主要信息，合并会丢掉其中一个。
    var key = str + '|' + name;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ str: str, name: name });
  }
  return out;
}

/**
 * maxroll 的串用 **URL-safe** base64（`-` `_`），游戏和 raider.io 用标准表（`+` `/`）。
 * 这不是猜的：raider.io 那 3960 条串里出现 `-` 或 `_` 的是 0 条，出现 `+` `/` 的有 7 条；
 * 不换字的话 207 条串会报「base64 表外的字符」，换完只剩真正解不开的那些。
 */
function normalizeB64(s) {
  return String(s).replace(/-/g, '+').replace(/_/g, '/');
}

/* ---------------------------------------------- 串头改写：变成能导进游戏的串 */

var B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64ToBits(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var v = B64_ALPHA.indexOf(s.charAt(i));
    if (v < 0) return null;
    for (var b = 0; b < 6; b++) out.push((v >> b) & 1);
  }
  return out;
}

function bitsToB64(a) {
  var s = '';
  for (var i = 0; i < a.length; i += 6) {
    var v = 0;
    for (var b = 0; b < 6; b++) v |= (a[i + b] || 0) << b;
    s += B64_ALPHA.charAt(v);
  }
  return s;
}

/**
 * maxroll 页面里那个 blob → **能粘进游戏的导入串**。
 *
 * 这件事上一轮判断错了，记清楚为什么
 * ------------------------------------
 * 上一轮的结论是「maxroll 的串不能导入，因为版本字节是 130 而游戏只认 2」。
 * 前半句的事实没错，**结论错了** —— 我只看了 `data-wow-data` 那个 blob（那是他们
 * 编辑器的状态），没注意每张天赋卡片下面还有一个 `Export (12.1.0.69111)` 按钮，
 * 那个按钮给的是另一串，而它的版本字节就是 2。
 *
 * 用户把惩戒骑 AOE 那一条 Export 出来给我，逐位比完发现：
 *   **两串的节点位逐位相同，差别只有串头里两个字段** ——
 *   版本字节 130 → 2，128 位 treeHash → **全 0**，再去掉尾部一个纯填充字符。
 * 也就是说 Export 按钮就是在做这一次改写，不是另算一份数据。这也解释了为什么
 * 用户说「点了立刻就复制好，没有等」：那一下根本不联网。
 *
 * treeHash 填 0 是对的，有两组本机数据作证：raider.io 的 3960 条真实玩家串、
 * 本机游戏自己导出的 32 条，**treeHash 全都是 0**（版本也全都是 2）。
 * 游戏不校验这个字段。
 *
 * 为什么是「改串头」而不是「解码后重新编码」
 * --------------------------------------
 * 因为**解码器还有一段没建模的位**：raider.io 3722 条里有 84 条（2.3%）在节点流
 * 之后还有非零位，集中在 6 个专精（65/66/70 骑士三系、252 死骑邪恶、
 * 254/255 猎人射击生存），`leftBits` 最多到 13 —— 纯填充用不了那么多。
 * 那多半是这一版新加的 Apex Talents（maxroll 页面里有这一节），而
 * app/talent-tree.js 比它旧。惩戒骑正好是 70。
 *
 * 解码后重编会把那段位**静默丢掉**（读不到就写不回）。而改串头只动前 152 位,
 * 尾部原样留着 —— 实测 167 条改完之后，第 152 位往后**一位都没变**，
 * 那 5 条尾部带非零位的也都保住了。所以这条路是无损的，重编不是。
 */
function toGameLoadout(s) {
  var bits = b64ToBits(s);
  if (!bits) return null;
  for (var i = 0; i < 8; i++) bits[i] = (2 >> i) & 1;      // 版本字节 → 2
  for (var j = 0; j < 128; j++) bits[24 + j] = 0;          // treeHash → 全 0
  var out = bitsToB64(bits);
  // 尾部纯填充字符（'A' = 6 个 0 位）去掉，和 Export 按钮的输出对齐。
  //
  // 两道闸，缺一不可：
  //  ① 削掉的那些位必须真的全是 0（不然是在丢信息）；
  //  ② **削完之后解码器还要能走完整个 nodeOrder**。
  //
  // ② 是被两个专精逼出来的（恶魔猎手 Fel-Scarred、恢复德 Keeper of the Grove）：
  // 尾部那串 0 看着是填充，其实是「最后几个节点没选」——「没选」这件事本身
  // 就是用 0 位表示的。削掉之后解码器读到一半位就用完了，报「位读完了但节点
  // 还剩 2 个没走到」。只有 ① 的话这两个专精的串会被削坏，而产物看起来一切正常。
  var order = decOrder();
  while (out.length > 26 && out.charAt(out.length - 1) === 'A') {
    var cut = (out.length - 1) * 6;
    var allZero = true;
    for (var k = cut; k < bits.length; k++) {
      if (bits[k]) { allZero = false; break; }
    }
    if (!allZero) break;
    var shorter = out.slice(0, -1);
    if (order) {
      var probe = DEC_MOD.decode(shorter, order);
      if (probe.err) break;
    }
    out = shorter;
  }
  return out;
}

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

  // block 树：场景 / 首领说明 / 优先级列表。解不出来就是空的三个字段
  // （实测 81 篇里 1 篇解不出），装备和天赋照旧 —— 不让一篇的 blob 坏掉
  // 拖垮整篇。
  var tree = walkGuide(guideBlocks(html));

  return {
    bis: bis, alt: alt, ench: ench, tiers: tiers,
    talents: talentBuilds(html),
    scen: tree.scen, boss: tree.boss, prio: tree.prio,
    labels: blk.labels, warn: warn
  };
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

/**
 * 把一页里的天赋方案筛成「面板真能画出来的那些」，并记下可校验的声明。
 *
 * 为什么在生成器里筛：面板要画树就得先解串，解不开的方案放进产物只会变成一条
 * 点不动的按钮。所以**解不开的直接不收**，并把条数打出来 —— 静默丢弃会让
 * 「上游改了编码」看起来像「maxroll 少写了几套」。
 *
 * 每套记 {n 方案名, s 串, p 点数, h 点亮的英雄子树 id}。p 和 h 是**声明**：
 * 浏览器端会自己解一遍串，校验器拿它俩和自己解出来的对账，两边不一致就报错。
 * 一份什么都不声明的数据文件是没法校验的。
 *
 * 实测（80 篇缓存）：833 套里 626 套解得开，207 套报「位读完了但节点还剩 1 个
 * 没走到」—— 那批是照着**上一版天赋树**编的，跟本地这版差一个节点。
 */
/**
 * 首领说明 / 优先级列表的去重。
 *
 * 同一段文字在一篇指南里会出现好几次（正文讲一次、每个英雄天赋的 tab 里再讲一次）。
 * 键是「名字 + 正文」：名字不同而正文相同的两条**都留着**（那是「Templar 下的
 * Nek'zali」和「Herald 下的 Nek'zali」，说的是同一件事但归属不同），
 * 正文和名字都相同才算重复。
 */
function dedupeNotes(list, stat, kind) {
  var out = [], seen = {};
  list.forEach(function (r) {
    var name = String(r.w || r.n || '').replace(/\s+/g, ' ').trim();
    // 首领名里可能挂着 maxroll 编辑器留下的空链接（实测
    // `Den of Nalorakk<a href="Legacy of Tyr"></a>` → 去标签后会粘上 href 里的字）。
    // 只取到第一个「大写字母开头的词组」结束为止是行不通的（首领名本身就带空格），
    // 所以按已知的杂讯形状切：出现 `<` 之后的全丢。
    name = name.split('<')[0].trim();
    var text = String(r.t || '').replace(/\s+/g, ' ').trim();
    if (!name || !text) return;
    var key = name + '\u0000' + text;
    if (seen[key]) { stat[kind + 'Dupe']++; return; }
    seen[key] = 1;
    stat[kind]++;
    var rec = { n: name, t: text };
    if (r.s) { rec.s = r.s; stat.prioScen++; }
    out.push(rec);
  });
  return out;
}

function collectTalents(list, specId, dec, ORDER, subOf, stat, scenMap) {
  var out = [], byStr = {}, badStr = {};
  list.forEach(function (b) {
    var s = normalizeB64(b.str);
    // **按串去重。**
    //
    // 同一套方案在一篇指南里会挂在很多小节下面：每个副本一个 embed、每个首领一个
    // embed，而 maxroll 给的是同一条串。实测第一版产物 587 套里有 420 套是这种重复
    // —— 界面上就是 9~13 行名字几乎一样的按钮（「… in Altar of Fangs」「… in
    // Murder Row」…），点开画的是同一棵树。用户一眼看到的就是「这页怪怪的」。
    //
    // 所以去重的键是**串本身**，不是「串 + 名字」（那是上一版，它保留了每个小节的
    // 名字，正是重复的来源）。名字只留第一个 —— 页面里通用那套排在最前面，
    // 副本/首领专用的排在后面。共用同一条串的小节数记成 c，界面可以据此说清
    // 「这一套通用于 9 个小节」，而不是把同一套画 9 遍。
    if (byStr[s]) { byStr[s].c++; stat.dupe++; return; }
    if (badStr[s]) { badStr[s]++; stat.dupe++; return; }

    var o;
    try { o = dec.decode(s, ORDER); } catch (e) { o = null; }
    if (!o) { badStr[s] = 1; stat.threw++; return; }
    if (o.err) { badStr[s] = 1; stat.undecodable++; return; }
    if (o.spec !== specId) { badStr[s] = 1; stat.wrongSpec++; return; }
    var pts = 0, subs = {};
    o.nodes.forEach(function (n) {
      if (!n.purchased) return;
      // 只算**本专精自己的**节点。fullNodeOrder 是按整个职业排的，位流里会读到
      // 同职业其他专精的节点；那些节点谁也不画，算进点数只会让声明值虚高。
      // 实测：不筛的话 16 套方案的声明点数比浏览器端解出来的多 6～23 点，
      // 而两边解出的节点表是逐个一致的 —— 差的全是专精外的节点。
      if (!n.inSpec) return;
      pts += (typeof n.rank === 'number' ? n.rank : 1);
      var sub = subOf[String(n.id)];
      if (sub) subs[sub] = 1;
    });
    var h = Object.keys(subs).map(Number).sort(function (x, y) { return x - y; });
    if (!h.length) { badStr[s] = 1; stat.noHero++; return; }
    if (h.length > 1) stat.bundle++;
    stat.kept++;
    // g = 能粘进游戏的导入串（串头改写，见 toGameLoadout 的注释）。
    // s 留着不动：面板画树用的是它，而且它是产物和上游页面的对应关系，
    // 换赛季重抓时对账要靠它。两个字段都存，各有各的用途。
    var game = toGameLoadout(s);
    var rec = { n: b.name, s: s, p: pts, h: h, c: 1 };
    if (game) { rec.g = game; stat.game++; }
    else stat.gameFail++;
    // 场景（单体 / AOE / 顺劈 / 多目标）是**可选的**：实测 80 篇里只有 28 篇
    // 按场景分天赋，其余按英雄天赋或副本分。没有就不写这个字段 ——
    // 写个空串会让面板画出一个空标签，写 'st' 更糟（那是编的）。
    var sc = scenMap && scenMap[s] ? Object.keys(scenMap[s]).sort() : [];
    if (sc.length) {
      rec.sc = sc;
      stat.scen++;
      if (sc.length > 1) stat.scenMulti++;
    }
    byStr[s] = rec;
    out.push(rec);
  });
  return out;
}

function writeOut(parsed, slotMap, RIO, meta) {
  // 解码器 + 天赋树。两个都是提交进仓库的，缺了就是仓库不完整，直接报错 ——
  // 「跳过天赋」会让产物看起来正常而天赋页空着。
  var dec = DEC_MOD;
  var TREE = dec.loadTree();
  if (!TREE) throw new Error('读不到 app/talent-tree.js —— 天赋方案没法筛，先跑 tools\\fetch-talent-tree.js');
  var ORDER = dec.loadOrder();
  if (!ORDER) throw new Error('loadOrder() 返回空 —— app/talent-tree.js 里没有 nodeOrder');
  // specId → {nodeId: subTreeId}。英雄节点的子树号在 nodeFormat 的第 [6] 格。
  var subOfSpec = {};
  Object.keys(TREE.specs).forEach(function (sid) {
    var t = TREE.specs[sid], m = {};
    (t.heroNodes || []).concat(t.subNodes || []).forEach(function (id) {
      var n = TREE.nodes[id];
      if (n && n[6]) m[String(id)] = n[6];
    });
    subOfSpec[sid] = m;
  });
  var tStat = { kept: 0, undecodable: 0, wrongSpec: 0, noHero: 0, bundle: 0, threw: 0, dupe: 0,
    scen: 0, scenMulti: 0, game: 0, gameFail: 0 };
  var nStat = { boss: 0, bossDupe: 0, prio: 0, prioDupe: 0, prioScen: 0 };


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
    var v = s.views[kind] = {
      slug: p.t.slug, bis: {}, alt: {}, ench: {}, tiers: [],
      talents: collectTalents(p.g.talents || [], sid, dec, ORDER,
        subOfSpec[String(sid)] || {}, tStat, p.g.scen || {}),
      // 首领 / 副本说明和优先级列表：技能名已换中文、句子留英文（见 walkGuide）。
      // 去重：同一段说明在页面里会重复出现（正文讲一次、总结再讲一次）。
      boss: dedupeNotes(p.g.boss || [], nStat, 'boss'),
      prio: dedupeNotes(p.g.prio || [], nStat, 'prio')
    };

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
    talentNote: '天赋方案是 maxroll 页面里每个 embed **原样**的串（只把 URL-safe base64 的 '
      + '- _ 换回标准表的 + /），生成时用 tools\\decode-talent-string.js 解过一遍，'
      + '解不开的不收；同一条串挂在多个小节下面（每副本 / 每首领各一个 embed）时并成一套，'
      + 'c 记的是有几个小节共用它 —— 不并的话一个专精会列出 9~13 行名字几乎一样的方案，'
      + '点开画的是同一棵树。'
      + 's 是页面里那个 blob，串头第一个字节（序列化版本）是 130，**不能直接粘进游戏**；'
      + 'g 是它改完串头的版本（版本字节 → 2、128 位 treeHash → 全 0），**能粘**。'
      + '这个改写就是 maxroll 每张天赋卡片下面那个 Export 按钮做的事：用户导出一条'
      + '惩戒骑 AOE 给我逐位比过，两串的节点位逐位相同，只有串头那两个字段不同。'
      + 'treeHash 填 0 有两组本机数据作证：raider.io 的 3960 条真实玩家串、本机游戏'
      + '导出的 32 条，treeHash 全是 0，版本全是 2 —— 游戏不校验它。'
      + '为什么是改串头而不是解码后重编：解码器还有一段没建模的位（raider.io 3722 条里'
      + '84 条在节点流之后还有非零位，集中在 6 个专精 65/66/70/252/254/255，'
      + 'leftBits 最多 13，多半是这一版新加的 Apex Talents），重编会把它静默丢掉；'
      + '改串头只动前 152 位，实测 167 条改完之后第 152 位往后一位都没变。'
      + 'h 有两个子树号的是 maxroll 的「一套方案 + 两条英雄树」打包（点数 95 = 68 职业专精 '
      + '+ 13 + 13，而单树的是 82）。**那 82 套的 g 也是 95 点的**，而游戏里一个角色'
      + '只能选一条英雄树 —— maxroll 的 Export 按钮导出来的就是这个样子（实测 raider.io '
      + '3722 条真实串里两条子树的有 299 条，但全部低于 82 点、最高 78，那是没点满的'
      + '角色在换树途中，没有一条是 95 点）。所以面板对这 82 套要说清「这串带着两条'
      + '英雄树，导进去得自己删一条」，而不是假装它和单树那些一样。'
      + '树本身是可信的：职业树 + 专精树点亮的节点和 raider.io 榜一方案的 Jaccard 中位 0.83，'
      + '而 raider.io 榜一 vs 榜二这个对照组是 0.82。',
    fmt: {
      specs: 'specId → {cls, specEn, views}',
      views: 'raid | mplus → {slug, bis 槽位→[itemId…], alt 同, ench 槽位→[itemId…], '
        + 'tiers [[分级, [itemId…]]…], talents [{n 方案名, s 串（画树用，版本 130 不能导入）, '
        + 'p 点数, h [英雄子树id…], c 有几个小节共用这一套, '
        + 'g 能粘进游戏的导入串（s 改了串头：版本 130→2、treeHash→全 0）, '
        + 'sc [场景码…]（可选，st 单体 / aoe / cleave 顺劈 / multi 多目标）}…], '
        + 'boss [{n 首领或副本名, t 说明}…], prio [{n 小节名, s 场景码（可选）, t 正文}…]}',
      note2: 'boss 和 prio 的正文里，**技能 / 天赋名是官方中文，句子是英文原文**。'
        + 'maxroll 给每个技能都标了 data-wow-id，所以中文名是按 ID 查出来的'
        + '（tools/spell-names-zh.json：天赋取 app/talent-tree.js 里暴雪 DB2 的名字，'
        + '基础技能取 Wowhead locale=4），查不到的那几个留英文 —— 不猜译名。'
        + '句子不整段翻译：机翻会把「unless / 除非」这类条件翻反，用户照着打是错的'
        + '而界面上看不出来；名词替换要么换对要么原样不动，不会翻反。'
        + '首领名（boss[].n）也留英文，本机没有它们的官方译名。'
        + 'sc / prio[].s 只在 maxroll 自己按场景分了的时候才有 —— 实测 80 篇里只有 28 篇这么分。',
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
  // 天赋方案。**收了多少、丢了多少都要说**：只报收进去的条数，上游哪天把编码换了，
  // 产物会静默变薄，而这行输出仍然是「一切正常」。
  var tSpecs = Object.keys(specs).filter(function (sid) {
    return Object.keys(specs[sid].views).some(function (k) {
      return (specs[sid].views[k].talents || []).length;
    });
  }).length;
  console.log('  天赋方案 收 ' + tStat.kept + ' 套（其中打包两条英雄树的 ' + tStat.bundle
    + ' 套），覆盖 ' + tSpecs + ' / ' + Object.keys(specs).length + ' 个专精');
  console.log('    丢：解不开 ' + tStat.undecodable + '，串头专精对不上 ' + tStat.wrongSpec
    + '，一条英雄树都没点 ' + tStat.noHero + '，解码抛异常 ' + tStat.threw
    + '；同一条串挂在多个小节下面被并成一套的 ' + tStat.dupe + ' 处');
  console.log('    带游戏导入串（g）的 ' + tStat.game + ' 套'
    + (tStat.gameFail ? '，改写失败 ' + tStat.gameFail + ' 套' : '')
    + ' —— 串头改写：版本字节 130→2、treeHash→全 0（和 Export 按钮一致）');
  console.log('    分了场景（单体/AOE/顺劈/多目标）的 ' + tStat.scen + ' 套'
    + '（同时属于多个场景的 ' + tStat.scenMulti + ' 套）'
    + ' —— maxroll 只有一部分专精按场景分天赋，其余按英雄天赋或副本分');
  console.log('  首领 / 副本说明 ' + nStat.boss + ' 条（重复合并 ' + nStat.bossDupe
    + '），优先级列表 ' + nStat.prio + ' 条（重复合并 ' + nStat.prioDupe
    + '，其中带场景的 ' + nStat.prioScen + '）　句子是英文原文');
  // 技能名替换的账。**必须印出来**：产物里看不出「这段本来没技能名」和
  // 「表里缺这个技能」的区别，只有这一行能。
  (function () {
    var need = Object.keys(subst.refs).length;
    var have = Object.keys(subst.refs).filter(function (id) { return SPELL_ZH[id]; }).length;
    if (!need) { console.log('    技能名：正文里一个带 ID 的技能引用都没扫到（不对，检查一下）'); return; }
    console.log('    技能名换中文 ' + subst.hit + ' 处，留英文 ' + subst.miss + ' 处'
      + '（引用到 ' + need + ' 个技能，表里有 ' + have + ' 个）');
    if (!Object.keys(SPELL_ZH).length) {
      console.log('    ⚠ 没有 tools\\spell-names-zh.json —— 正文全是英文。'
        + '跑 node tools\\fetch-spell-names.js 生成');
    } else if (need > have) {
      var miss = Object.keys(subst.refs).filter(function (id) { return !SPELL_ZH[id]; });
      console.log('    表里缺的 ' + miss.length + ' 个（留英文）：'
        + miss.slice(0, 8).map(function (id) { return subst.refs[id].en; }).join('、')
        + (miss.length > 8 ? ' …' : ''));
    }
    // 清单写给 tools\fetch-spell-names.js —— 它靠这个知道该查哪些 ID，
    // 而不用把「哪几段算出手顺序」的判断再实现一遍。
    fs.writeFileSync(path.join(__dirname, '.maxroll-spell-ids.json'),
      JSON.stringify({ v: 1, updatedAt: new Date().toISOString().slice(0, 10),
        note: '由 tools/fetch-maxroll.js 写出：出手顺序 / 首领说明正文里引用到的技能 ID。'
          + 'tools/fetch-spell-names.js 读它。',
        refs: subst.refs }, null, 1) + '\n');
  }());
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
