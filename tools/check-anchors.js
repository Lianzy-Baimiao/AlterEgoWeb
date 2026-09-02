/*
 * WowAltBoard - tools/check-anchors.js
 *
 * 静态检查所有 tools/mutate-*.js 的锚点：在目标文件里是不是**正好出现一次**。
 *
 * 为什么值得单独有这么个东西
 * ------------------------
 * 跑一轮变异测试要十几分钟（每个变异体都要跑一遍全套件），而「锚点烂了」是纯
 * 文本问题 —— 不跑就能查出来。而锚点烂掉的后果很重：**那条断言根本没被验过**，
 * 变异测试还会安静地报「抓到」（触发的是别的断言）。
 *
 * 第 20 轮第一次跑它，当场抓到两类：
 *   · mutate-loadout 有两条锚点匹配 0 次 —— 版面动过、排序搬进了生成器，
 *     那两条断言已经空转了一整轮；
 *   · mutate-a11y 的 `img.alt = '';` 匹配**两次**（天赋图标 460 行 + 装备图标
 *     524 行），而那个套件当时只判「找不到」不判「出现几次」，于是装备图标
 *     那半边从来没被变异过。
 *
 * 这只是**静态**检查，管不了「锚点在、但断言是摆设」—— 那还得真跑变异测试。
 *
 * 用法：node tools\check-anchors.js        （退出码非 0 = 有坏锚点）
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var TOOLS = path.join(ROOT, 'tools');

var cache = {};
function read(p) {
  if (!(p in cache)) {
    try { cache[p] = fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null; }
    catch (e) { cache[p] = null; }
  }
  return cache[p];
}

/** 从套件源码里扒出「变量名 → 文件路径」。各套件的命名不统一，所以按形状认。 */
function targetsOf(src) {
  var out = {};
  var re = /var\s+([A-Za-z_][A-Za-z_0-9]*)\s*=\s*path\.join\(([^)]*)\)/g, m;
  while ((m = re.exec(src))) {
    var e = m[2], p = null, mm;
    if ((mm = /'app',\s*'([^']+)'/.exec(e))) p = path.join(ROOT, 'app', mm[1]);
    else if ((mm = /__dirname,\s*'([^']+)'/.exec(e))) p = path.join(TOOLS, mm[1]);
    else if ((mm = /ROOT,\s*'tools',\s*'([^']+)'/.exec(e))) p = path.join(TOOLS, mm[1]);
    else if ((mm = /ROOT,\s*'([^'/]+)'\s*\)/.exec(e))) p = path.join(ROOT, mm[1]);
    if (p) out[m[1]] = p;
  }
  return out;
}

/**
 * 抽出这个套件的锚点列表。两种写法都要认：
 *   · `textMutant(desc, FILE, from, to, want)` / `genMutant(desc, from, to, want)`
 *   · 数组字面量 `[desc, FILE, from, to]`
 * 认不出来的返回 null —— **不当成「0 个锚点」**，那会把「没查」报成「全对」。
 */
function anchorsOf(src, targets) {
  var i = src.indexOf('var MUTANTS');
  if (i < 0) return null;
  var j = src.indexOf('\n];', i);
  if (j < 0) return null;
  var body = src.slice(i, j + 3);
  var decl = Object.keys(targets).map(function (k) { return k + ' = ' + JSON.stringify(k); });
  var head = decl.length ? 'var ' + decl.join(', ') + ';\n' : '';
  var out = [];
  var stub = ''
    + 'function textMutant(d, f, from) { __A.push({ d: d, f: f, from: from }); return 0; }\n'
    // genMutant / dataMutant / jsonMutant 的第二个参数不是文件名：
    // genMutant 是 from（目标写死在套件里），dataMutant 是 want（改的是对象，没有文本锚点）。
    + 'function genMutant(d, from) { __A.push({ d: d, f: null, from: from }); return 0; }\n'
    + 'function dataMutant(d) { return 0; }\n'
    + 'function jsonMutant(d) { return 0; }\n';
  try {
    (new Function('__A', head + stub + body + '\nreturn MUTANTS;'))(out);
  } catch (e) {
    return { err: e.message };
  }
  // 数组字面量那一族：MUTANTS 里是数组，从里面认 [desc, FILE, from, …]
  var arr = null;
  try {
    arr = (new Function('__A', head + stub + body + '\nreturn MUTANTS;'))([]);
  } catch (e) { arr = null; }
  if (Array.isArray(arr)) {
    arr.forEach(function (row) {
      if (!Array.isArray(row)) return;
      var fk = null;
      row.forEach(function (v) { if (typeof v === 'string' && targets[v]) fk = v; });
      var fi = row.indexOf(fk);
      // 数组字面量有**两种排法**，得分开处理：
      //   · [desc, FILE, from, to]  —— a11y / decode / icons：锚点在文件名后面
      //   · [desc, from, to]        —— pkg / names：没有文件名那一项，
      //                                目标写死在套件的模块变量里（PS / NAMES）
      // 认错会两边都报假的坏锚点：按第一种读第二种，会把「换成什么」当锚点；
      // 按第二种读第一种，会把文件变量名当锚点。两种我都踩过一次。
      //
      // from 不是字符串就说明这条没有文本锚点（mutate-decode 的「真值文件截成
      // 1 条」是 from = null，它直接截 JSON 文件），跳过而不是当成坏锚点。
      var from = (fi >= 0) ? row[fi + 1] : row[1];
      if (typeof from === 'string' && from) out.push({ d: row[0], f: fk, from: from });
    });
  }
  return out;
}

/**
 * genMutant 改的是哪个文件。签名里没有文件名（`genMutant(desc, from, to, want)`），
 * 目标写死在套件的函数体里 —— 从 `fs.readFileSync(XXX` 里把那个变量名扒出来。
 *
 * 为什么值得专门认一下：不认的话只能退回「所有目标文件里有一个正好 1 次就算好」，
 * 而那条规则第 20 轮放过了一个真的坏锚点 —— mutate-loadout 的排序变异体改的是
 * tools/fetch-rio.js，那句代码早就搬走了（0 次），但 tools/run-tests.js 里恰好有
 * 一句一模一样的（独立算真值那份排序，1 次），于是报「全对」。
 * 认不出来就返回 null，退回旧规则。
 */
function genTargetOf(src, targets) {
  var i = src.indexOf('function genMutant');
  if (i < 0) return null;
  var body = src.slice(i, i + 1200);
  var m = /readFileSync\(([A-Za-z_][A-Za-z_0-9]*)/.exec(body);
  return (m && targets[m[1]]) ? targets[m[1]] : null;
}

var files = fs.readdirSync(TOOLS)
  .filter(function (f) { return /^mutate-.*\.js$/.test(f) && f !== 'mutate-lock.js'; });

var totalBad = 0, totalAnchors = 0, unread = [];
files.forEach(function (f) {
  var src = fs.readFileSync(path.join(TOOLS, f), 'utf8');
  var targets = targetsOf(src);
  var all = Object.keys(targets).map(function (k) { return targets[k]; })
    .filter(function (p) { return read(p) != null; });
  var genTarget = genTargetOf(src, targets);
  var list = anchorsOf(src, targets);
  if (!list) { unread.push(f + '（找不到 MUTANTS 数组）'); console.log(pad(f) + '认不出结构'); return; }
  if (list.err) { unread.push(f + '（' + list.err.slice(0, 50) + '）'); console.log(pad(f) + '抽不出：' + list.err.slice(0, 50)); return; }

  var bad = [];
  list.forEach(function (c) {
    // 目标明确 → 就查那个文件；genMutant → 查它函数体里读的那个文件；
    // 都认不出来 → 只要有一个文件正好 1 次就算好（最后的退路）。
    var cands = (c.f ? [targets[c.f]] : (genTarget ? [genTarget] : all))
      .filter(function (p) { return p && read(p) != null; });
    if (!cands.length) {
      // 目标文件不存在（比如 tools/talent-truth.json 那种缓存产物）—— 不算坏锚点，
      // 但要说出来：那条变异体在这台机器上跑不了。
      unread.push(f + ' / ' + c.d + '（目标文件不在）');
      return;
    }
    var hits = cands.map(function (p) { return read(p).split(c.from).length - 1; });
    if (hits.indexOf(1) < 0) {
      bad.push(c.d + '  [' + cands.map(function (p, k) {
        return path.basename(p) + '×' + hits[k];
      }).join(' ') + ']');
    }
  });
  totalAnchors += list.length;
  totalBad += bad.length;
  console.log(pad(f) + String(list.length).padStart(3) + ' 个锚点，坏 ' + bad.length);
  bad.forEach(function (b) { console.log('     ✗ ' + b); });
});

function pad(s) { while (s.length < 24) s += ' '; return s; }

console.log('');
if (unread.length) {
  console.log('没查到的 ' + unread.length + ' 条（目标文件不在 / 结构认不出）：');
  unread.slice(0, 8).forEach(function (u) { console.log('  · ' + u); });
}
console.log('合计 ' + totalAnchors + ' 个锚点，坏 ' + totalBad);
if (totalBad) {
  console.log('\n坏锚点 = 那条断言根本没在验。修锚点，或者把那条变异体删掉。');
  process.exit(1);
}
