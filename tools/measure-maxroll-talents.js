/*
 * WowAltBoard - tools/measure-maxroll-talents.js
 *
 * 一次性量具，但**留成正式文件**：它回答的问题会在每次换赛季重抓时重新出现 ——
 * 「maxroll 这一批天赋串里，有多少条是能直接粘进游戏的？」
 *
 * 背景：第 14 轮拿 8 篇样本量到「11/15 条串同时点亮两条英雄天赋，
 * 所以不能导入」。但那次是把**页面里所有串混在一起**数的。80 篇缓存到手之后
 * 发现结构其实是：每套方案一个独立的 `<div class="wow-embed"
 * data-wow-type="talents" data-wow-data="<串>">`，配一个 figcaption 写方案名。
 * 所以要按「每套方案」重新量，不是按页。
 *
 * 判据（写在跑之前）：
 *   · 能解码       = decode() 不报错，且走完 fullNodeOrder；
 *   · 语义干净     = checkSemantics 的 crossSpec / overMax / badChoice 全 0；
 *   · 英雄树条数   = 点亮的节点里，属于英雄子树（subTreeId）的有几个不同子树。
 *                    游戏里一个角色只能选**一条**，所以 >1 就是不能直接导入。
 *   · specID 对得上 = 串头解出来的 specID 必须等于这篇指南的专精。
 *
 * 用法：node tools\measure-maxroll-talents.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var dec = require('./decode-talent-string.js');

var ROOT = path.join(__dirname, '..');
var CACHE = path.join(__dirname, '.maxroll-raw');

function strip(h) {
  return h.replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/**
 * 从一篇指南里抽出所有天赋方案。
 * 每套方案 = 一个 wow-embed（带串）+ 紧跟其后的 figcaption（方案名）。
 */
function talentBuilds(html) {
  var out = [];
  var re = /<div class="wow-embed"[^>]*data-wow-type="talents"[^>]*data-wow-data="([^"]+)"[^>]*>/g;
  var m;
  while ((m = re.exec(html))) {
    var str = m[1];
    // 方案名在后面最近的 figcaption 里
    var tail = html.slice(m.index, m.index + 3000);
    var cap = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(tail);
    var name = cap ? strip(cap[1]) : '';
    // 英雄天赋的 traitId 也在 figcaption 里（data-wow-id）
    var hero = /<span class="wow-trait"[^>]*data-wow-id="(\d+)"/.exec(cap ? cap[1] : '');
    out.push({ str: str, name: name, heroTraitId: hero ? Number(hero[1]) : 0 });
  }
  return out;
}

// slug -> specId，用 rio 那份产物建（和 fetch-maxroll.js 同一条路）
function specIndex() {
  var win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'rio-data.js'), 'utf8'))(win); // eslint-disable-line no-new-func
  var R = win.AE_RIO;
  var idx = {};
  Object.keys(R.specs).forEach(function (sid) {
    var s = R.specs[sid];
    function sl(x) { return x.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
    idx[sl(s.specEn) + '-' + sl(s.cls)] = Number(sid);
  });
  return idx;
}

function specOfSlug(slug, idx) {
  var stem = slug.replace(/-(raid|mythic-plus|mythic)-guide$/, '');
  return idx[stem];
}

var TREE = dec.loadTree();
var ORDER = dec.loadOrder();
var IDX = specIndex();

/**
 * 英雄子树归属：节点在**顶层** `TREE.nodes`，subTreeId 是第 7 位
 * （`nodeFormat` = "[posX, posY, maxRanks, typeIdx, reqPoints, entries[], subTreeId, requiresNode]"）。
 *
 * 第一版写成 `TREE.specs[specId].nodes[id].sub` —— 那个路径整个不存在，
 * 于是函数恒返回 null，833 套天赋全部报「英雄树 = 0」。
 * 一个新读数对所有对象一致失败时，先怀疑仪器：这就是第 19 次。
 */
function heroSubtreeOf(specId) {
  var t = TREE && TREE.specs ? TREE.specs[String(specId)] : null;
  if (!t || !TREE.nodes) return null;
  var map = {};
  // 只看这个专精自己的节点（英雄 + 子树那两批），别把别的专精的节点算进来
  (t.heroNodes || []).concat(t.subNodes || []).forEach(function (id) {
    var n = TREE.nodes[id];
    var sub = n && n[6];
    if (sub) map[String(id)] = sub;
  });
  return map;
}

/**
 * maxroll 的串用的是 **URL-safe base64**（`-_`），而游戏 / raider.io 用**标准表**（`+/`）。
 * 实测依据：raider.io 那 3960 条官方串里含 `-_` 的是 **0 条**、含 `+/` 的有 7 条；
 * maxroll 这批反过来。所以解码前先换表 —— 这不是「修数据」，是同一串的两种写法。
 */
function normalizeB64(s) {
  return String(s).replace(/-/g, '+').replace(/_/g, '/');
}

var files = fs.readdirSync(CACHE).filter(function (f) {
  return /\.html$/.test(f) && f !== 'class-guides.html';
});

var stat = {
  pages: 0, builds: 0, decoded: 0, failed: 0, clean: 0, dirty: 0,
  specOk: 0, specBad: 0, oneHero: 0, multiHero: 0, noHero: 0, named: 0
};
var samples = [], problems = [];
var perSpec = {};   // specId -> {name, builds, decoded, clean, oneHero, multiHero}

files.forEach(function (f) {
  var slug = f.replace(/\.html$/, '');
  var specId = specOfSlug(slug, IDX);
  if (specId === undefined) return;
  var html = fs.readFileSync(path.join(CACHE, f), 'utf8');
  var builds = talentBuilds(html);
  if (!builds.length) return;
  stat.pages++;

  var subMap = heroSubtreeOf(specId);
  var entry = ORDER[String(specId)];

  var ps = perSpec[specId] = perSpec[specId] || {
    name: (ORDER[String(specId)] && ORDER[String(specId)].t.specName) || '?',
    builds: 0, decoded: 0, clean: 0, oneHero: 0, multiHero: 0
  };

  builds.forEach(function (b) {
    stat.builds++;
    ps.builds++;
    if (b.name) stat.named++;

    var out;
    try {
      out = dec.decode(normalizeB64(b.str), ORDER);
    } catch (e) {
      stat.failed++;
      problems.push(slug + ' 解码抛错：' + e.message);
      return;
    }
    if (!out || out.err) {
      stat.failed++;
      problems.push(slug + ' 解不开：' + ((out && out.err) || '?'));
      return;
    }
    stat.decoded++;
    ps.decoded++;

    // 字段名是 **out.spec**，不是 out.specId。读错的后果是 833 套全报
    // 「spec=undefined」，而解码明明成功了 —— 两个互斥的读数摆在一起才露出来。
    if (out.spec === specId) stat.specOk++;
    else {
      stat.specBad++;
      problems.push(slug + ' 串头 specID ' + out.spec + ' != 指南专精 ' + specId);
    }

    if (entry) {
      try {
        dec.checkSemantics(out, entry);
        if (out.clean) { stat.clean++; ps.clean++; } else stat.dirty++;
      } catch (e) {
        problems.push(slug + ' checkSemantics 抛错：' + e.message);
      }
    }

    // 点亮的节点分别属于哪条英雄子树
    var trees = {};
    if (subMap) {
      out.nodes.forEach(function (n) {
        if (!n.purchased) return;
        var sub = subMap[String(n.id)];
        if (sub) trees[sub] = (trees[sub] || 0) + 1;
      });
    }
    var nTrees = Object.keys(trees).length;
    if (nTrees === 0) stat.noHero++;
    else if (nTrees === 1) { stat.oneHero++; ps.oneHero++; }
    else { stat.multiHero++; ps.multiHero++; }

    if (samples.length < 12) {
      samples.push({
        slug: slug, name: b.name, len: b.str.length,
        clean: !!out.clean, spec: out.spec, trees: nTrees,
        pts: out.nodes.filter(function (n) { return n.purchased; }).length
      });
    }
  });
});

console.log('缓存页 ' + files.length + '，其中有天赋方案的 ' + stat.pages + ' 篇');
console.log('天赋方案共 ' + stat.builds + ' 套（带方案名 ' + stat.named + '）');
console.log('');
console.log('解码       成功 ' + stat.decoded + '，失败 ' + stat.failed);
console.log('语义       干净 ' + stat.clean + '，不干净 ' + stat.dirty);
console.log('串头专精   对上 ' + stat.specOk + '，对不上 ' + stat.specBad);
console.log('英雄树     恰好一条 ' + stat.oneHero + '，两条以上 ' + stat.multiHero
  + '，一条都没点 ' + stat.noHero);
console.log('');
console.log('=== 前 12 套样例 ===');
samples.forEach(function (s) {
  console.log('  ' + (s.clean ? '✓' : '✗') + ' ' + s.slug
    + '\n      方案「' + s.name.slice(0, 50) + '」'
    + ' spec=' + s.spec + ' 串长=' + s.len + ' 点数=' + s.pts + ' 英雄树=' + s.trees);
});

if (problems.length) {
  console.log('');
  console.log('问题 ' + problems.length + ' 条，前 10：');
  problems.slice(0, 10).forEach(function (p) { console.log('  · ' + p); });
}

console.log('');
var canPaste = stat.oneHero;
console.log('结论：' + canPaste + '/' + stat.builds + ' 套天赋（'
  + (stat.builds ? (canPaste * 100 / stat.builds).toFixed(1) : '0')
  + '%）只点亮一条英雄天赋树，形状上可以直接粘进游戏。');

// ---- 专精覆盖：界面能不能用，取决于「每个专精有没有至少一套可用方案」，
// 而不是总数好不好看。40 个专精里缺一个，那个专精的用户就看不到天赋页。
console.log('');
console.log('=== 专精覆盖（决定界面能不能用）===');
var bySpec = {};
Object.keys(perSpec).forEach(function (sid) {
  var p = perSpec[sid];
  bySpec[sid] = p;
});
var nSpec = Object.keys(bySpec).length;
var haveDecoded = 0, haveOneHero = 0, haveClean = 0;
Object.keys(bySpec).forEach(function (sid) {
  var p = bySpec[sid];
  if (p.decoded > 0) haveDecoded++;
  if (p.oneHero > 0) haveOneHero++;
  if (p.clean > 0) haveClean++;
});
console.log('出现过的专精      ' + nSpec + ' / 40');
console.log('有能解开的方案    ' + haveDecoded + ' / ' + nSpec);
console.log('有语义干净的方案  ' + haveClean + ' / ' + nSpec);
console.log('有单英雄树的方案  ' + haveOneHero + ' / ' + nSpec);
var lacking = Object.keys(bySpec).filter(function (sid) { return bySpec[sid].decoded === 0; });
if (lacking.length) {
  console.log('一套都解不开的专精：' + lacking.map(function (sid) {
    return sid + '(' + bySpec[sid].name + ')';
  }).join('，'));
}
// ---- 第二问：293 套「两条英雄树」到底是什么？
//
// 两种可能，结论完全相反：
//   (a) maxroll 把一个 embed 当成「一套方案 + 若干英雄天赋变体」的**打包**，
//       那么点数会明显超过游戏上限，我得从里面挑出 figcaption 点名的那一条；
//   (b) 我的位布局在这些串上错位了，那么读数不可信，整条路要重新想。
// 判据：合法方案的**总点数有上限**。超了就是 (a)，没超就得怀疑 (b)。
console.log('');
console.log('=== 两条英雄树的那 293 套：是打包还是错位？===');
var SUB = TREE.subTrees || {};
function subName(id) { var r = SUB[String(id)]; return r ? r[3] : ('#' + id); }
var ptsHist = {}, capHit = 0, capMiss = 0, capNone = 0, ex = [];
files.forEach(function (f) {
  var slug = f.replace(/\.html$/, '');
  var specId = specOfSlug(slug, IDX);
  if (specId === undefined) return;
  var html = fs.readFileSync(path.join(CACHE, f), 'utf8');
  var subMap = heroSubtreeOf(specId);
  talentBuilds(html).forEach(function (b) {
    var out;
    try { out = dec.decode(normalizeB64(b.str), ORDER); } catch (e) { return; }
    if (!out || out.err) return;
    var trees = {}, pts = 0;
    out.nodes.forEach(function (n) {
      if (!n.purchased) return;
      pts += (typeof n.rank === 'number' ? n.rank : 1);
      var sub = subMap && subMap[String(n.id)];
      if (sub) trees[sub] = (trees[sub] || 0) + (n.rank || 1);
    });
    var names = Object.keys(trees).map(subName);
    if (names.length < 2) return;
    var bucket = Math.floor(pts / 10) * 10;
    ptsHist[bucket] = (ptsHist[bucket] || 0) + 1;
    // figcaption 点名了哪条？名字直接在方案名里找，不靠 id 对表
    var named = names.filter(function (nm) { return b.name.indexOf(nm) >= 0; });
    if (!named.length) capNone++;
    else if (named.length === 1) capHit++;
    else capMiss++;
    if (ex.length < 8) {
      ex.push('  ' + slug + ' 点数=' + pts + ' 英雄树=[' + names.join(', ')
        + '] 方案名点名=[' + named.join(', ') + ']');
    }
  });
});
console.log('总点数分布（10 点一档）：' + Object.keys(ptsHist).sort(function (a, b) {
  return a - b;
}).map(function (k) { return k + '+:' + ptsHist[k]; }).join('  '));
console.log('方案名恰好点名其中一条  ' + capHit);
console.log('方案名点名了两条以上    ' + capMiss);
console.log('方案名一条都没点名      ' + capNone);
ex.forEach(function (l) { console.log(l); });

// ---- 第三问：点数超标，是「maxroll 的串本来就超」还是「我算点数算错了」？
//
// 必须有对照组。raider.io 那批串是**已知能进游戏**的官方串（从排行榜角色身上
// 原样取下来的），用同一个解码器、同一套点数口径去量它们：
//   · 若对照组也给 90 多点 → 是我的点数口径不对，maxroll 没问题；
//   · 若对照组给 70 上下、maxroll 单树的也给 70、只有多树的给 90 多
//     → 那 293 套确实是「一套方案 + 另一条英雄树」的打包，得拆。
// 这一步是这轮里唯一能把「数据问题」和「仪器问题」分开的读数。
console.log('');
console.log('=== 点数口径对照（raider.io 官方串 = 已知能导入的对照组）===');
function ptsOf(out) {
  var n = 0;
  out.nodes.forEach(function (x) {
    if (x.purchased) n += (typeof x.rank === 'number' ? x.rank : 1);
  });
  return n;
}
function summary(list) {
  if (!list.length) return '无样本';
  list.sort(function (a, b) { return a - b; });
  return '样本 ' + list.length + '　最小 ' + list[0]
    + '　中位 ' + list[Math.floor(list.length / 2)]
    + '　最大 ' + list[list.length - 1];
}
var rioPts = [];
(function () {
  var win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'rio-data.js'), 'utf8'))(win); // eslint-disable-line no-new-func
  var R = win.AE_RIO;
  var seen = 0;
  Object.keys(R.specs || {}).forEach(function (sid) {
    var lo = R.specs[sid] && R.specs[sid].loadouts;
    var arr = lo && (lo.list || lo);
    if (!arr || !arr.length) return;
    arr.slice(0, 6).forEach(function (str) {
      if (typeof str !== 'string' || str.length < 40) return;
      var out;
      try { out = dec.decode(str, ORDER); } catch (e) { return; }
      if (!out || out.err) return;
      seen++;
      rioPts.push(ptsOf(out));
    });
  });
  if (!seen) console.log('⚠ 对照组一个串都没取到 —— 先别读下面的结论，是取数路径错了');
})();
console.log('raider.io 官方串    ' + summary(rioPts));

var mrOne = [], mrMulti = [];
files.forEach(function (f) {
  var slug = f.replace(/\.html$/, '');
  var specId = specOfSlug(slug, IDX);
  if (specId === undefined) return;
  var subMap = heroSubtreeOf(specId);
  talentBuilds(fs.readFileSync(path.join(CACHE, f), 'utf8')).forEach(function (b) {
    var out;
    try { out = dec.decode(normalizeB64(b.str), ORDER); } catch (e) { return; }
    if (!out || out.err) return;
    var trees = {};
    out.nodes.forEach(function (n) {
      if (!n.purchased) return;
      var sub = subMap && subMap[String(n.id)];
      if (sub) trees[sub] = 1;
    });
    var k = Object.keys(trees).length;
    if (k === 1) mrOne.push(ptsOf(out));
    else if (k > 1) mrMulti.push(ptsOf(out));
  });
});
console.log('maxroll 单英雄树    ' + summary(mrOne));
console.log('maxroll 多英雄树    ' + summary(mrMulti));

// ---- 第四问：这两批串是不是照着**同一版天赋树**编的？
//
// 串头有 128 位 treeHash，游戏导入时会拿它对表。所以：
//   · maxroll 的 hash 和 raider.io 同专精的 hash 一致 → 同一版树，形状对就能导；
//   · 不一致 → 就算解得开也可能被游戏拒，那 333 套「形状可导」的结论要打折。
// 顺带量一个更硬的证据：有没有 maxroll 的串和排行榜角色身上的串**逐字节相同**。
// 一条都对上，就说明这串本来就是从游戏里导出来的那种。
console.log('');
console.log('=== 树版本对照（treeHash）===');
var rioHash = {}, rioSet = {};
(function () {
  var win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'rio-data.js'), 'utf8'))(win); // eslint-disable-line no-new-func
  var R = win.AE_RIO;
  Object.keys(R.specs || {}).forEach(function (sid) {
    var lo = R.specs[sid] && R.specs[sid].loadouts;
    var arr = lo && (lo.list || lo);
    if (!arr || !arr.length) return;
    arr.forEach(function (str) {
      if (typeof str !== 'string' || str.length < 40) return;
      rioSet[str] = sid;
      var out;
      try { out = dec.decode(str, ORDER); } catch (e) { return; }
      if (!out || !out.hash) return;
      rioHash[sid] = rioHash[sid] || {};
      rioHash[sid][out.hash] = (rioHash[sid][out.hash] || 0) + 1;
    });
  });
})();
var hashSame = 0, hashDiff = 0, hashNoRef = 0, exact = 0, diffEx = [];
var hashByOk = { ok: {}, bad: {} };
files.forEach(function (f) {
  var slug = f.replace(/\.html$/, '');
  var specId = specOfSlug(slug, IDX);
  if (specId === undefined) return;
  talentBuilds(fs.readFileSync(path.join(CACHE, f), 'utf8')).forEach(function (b) {
    var std = normalizeB64(b.str);
    if (rioSet[std]) exact++;
    var out;
    try { out = dec.decode(std, ORDER); } catch (e) { return; }
    if (!out || !out.hash) return;
    // 解得开 / 解不开 两拨的 hash 分开记，看 207 条失败是不是版本旧
    var bag = out.err ? hashByOk.bad : hashByOk.ok;
    bag[out.hash] = (bag[out.hash] || 0) + 1;
    var ref = rioHash[String(specId)];
    if (!ref) { hashNoRef++; return; }
    if (ref[out.hash]) hashSame++;
    else {
      hashDiff++;
      if (diffEx.length < 5) {
        diffEx.push('  ' + slug + ' maxroll hash=' + out.hash.slice(0, 16)
          + '… rio hash=' + Object.keys(ref)[0].slice(0, 16) + '…');
      }
    }
  });
});
console.log('hash 和同专精官方串一致  ' + hashSame);
console.log('hash 不一致              ' + hashDiff);
console.log('该专精没有官方串可比     ' + hashNoRef);
diffEx.forEach(function (l) { console.log(l); });
console.log('逐字节等于某个官方串     ' + exact + ' 条');
console.log('解得开的那批 hash 有 ' + Object.keys(hashByOk.ok).length + ' 种，'
  + '解不开的那批 hash 有 ' + Object.keys(hashByOk.bad).length + ' 种');

var lackHero = Object.keys(bySpec).filter(function (sid) { return bySpec[sid].oneHero === 0; });
if (lackHero.length) {
  console.log('没有单英雄树方案的专精：' + lackHero.map(function (sid) {
    return sid + '(' + bySpec[sid].name + ')';
  }).join('，'));
}
