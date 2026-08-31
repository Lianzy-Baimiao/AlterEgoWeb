/*
 * WowAltBoard - tools/fetch-class-names.js
 *
 * 产出 app/class-names.js（window.AE_DB2_NAMES）：13 个职业 + 40 个专精的**中文名**，
 * 来源是暴雪自己的 DB2 表，按 **ID** 建键。
 *
 * 为什么要有这个文件
 * ------------------
 * 一直缺 4 个职业中文名（EVOKER / MAGE / MONK / ROGUE）和 3 个专精中文名
 * （死骑冰霜 / 牧师戒律 / 唤魔师恩护），因为：
 *
 *   · 本机 7895 个 SavedVariables 文件里**没有**本地化职业表 —— 已有的 9 个职业名
 *     是从存档里各职业角色身上一个个收来的，账号里没有的职业就收不到；
 *   · 专精名原来取自 GearInsight 的 `BisData.specRawToCN`，那张表是**按专精英文名**
 *     建键的，于是 `FROST` 一个键对两个专精，死骑的冰霜继承了法师的名字，
 *     显示成「冰法」—— 那是别的职业的专精名，不是翻译粗糙。
 *     `PRESERVATION` / `DISCIPLINE` 干脆没有行。
 *
 * 病根是「按英文名建键」。DB2 两张表都带 **ID**，所以换成按 ID 建键就没有撞车的可能。
 *
 * 两个源，本机实测（中国大陆，**都不需要代理**）
 * ----------------------------------------------
 *   · wago.tools/db2/ChrClasses/csv?locale=zhCN         200，约 7 KB
 *     ID → Name_lang（「死亡骑士」）+ Filename（`DeathKnight`，转大写就是 classFile）
 *   · wago.tools/db2/ChrSpecialization/csv?locale=zhCN  200，约 8 KB
 *     ID → Name_lang（「冰霜」）+ ClassID
 *
 * 这是游戏客户端里的同一份字符串，比任何插件 locale 都权威 ——
 * 「不许凭记忆手写中文」这条规矩在这里是满足的：本文件一个中文名都没有硬编码。
 *
 * 交叉校验（这个工具会**硬失败**的地方）
 * --------------------------------------
 * `app/labels.js` 的 `L.classZh` 里有 9 个从**运行中的客户端**收来的职业名。
 * 它和 DB2 是两条独立的路径，两边必须一字不差 —— 不一致就说明其中一条错了，
 * 这种时候正确的做法是停下来而不是二选一。所以本工具会解析 labels.js 取出那 9 条比对，
 * 有出入直接非零退出、不写文件。
 *
 * 缓存
 * ----
 *   tools/.db2-names/   两个原始 CSV，约 15 KB，**不进仓库**（.gitignore 的 `.*` 规则外，
 *                       所以显式加进了 .gitignore）。删掉随时可以重下。
 *   app/class-names.js  产物，**进仓库**（约 2 KB，比联网可靠）。
 *
 * 用法
 * ----
 *   node tools\fetch-class-names.js            # 缺缓存就下，然后生成
 *   node tools\fetch-class-names.js --refresh   # 强制重下
 *   node tools\fetch-class-names.js --offline   # 只用缓存
 *   node tools\fetch-class-names.js --proxy http://127.0.0.1:7897
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');

var ROOT = path.resolve(__dirname, '..');
var RAW_DIR = path.join(__dirname, '.db2-names');
var OUT_JS = path.join(ROOT, 'app', 'class-names.js');
var LABELS = path.join(ROOT, 'app', 'labels.js');
var TREE_JS = path.join(ROOT, 'app', 'talent-tree.js');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

var PROXY = opt('--proxy', '');
var REFRESH = flag('--refresh');
var OFFLINE = flag('--offline');

var SOURCES = [
  { file: 'ChrClasses.csv',
    url: 'https://wago.tools/db2/ChrClasses/csv?locale=zhCN' },
  { file: 'ChrSpecialization.csv',
    url: 'https://wago.tools/db2/ChrSpecialization/csv?locale=zhCN' }
];

// ------------------------------------------------------------------ 下载
// 和 fetch-talent-tree.js 的 get() 是同一套（代理走 absolute-URI，跟随重定向）。

function get(url, cb) {
  var u = new URL(url);
  var opts, mod;
  if (PROXY) {
    var p = new URL(PROXY);
    mod = p.protocol === 'https:' ? https : http;
    opts = {
      host: p.hostname, port: p.port || 80, path: url, method: 'GET',
      headers: { Host: u.hostname, 'User-Agent': 'WowAltBoard/1.0', Accept: '*/*' }
    };
  } else {
    mod = u.protocol === 'https:' ? https : http;
    opts = {
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'WowAltBoard/1.0', Accept: '*/*' }
    };
  }
  var req = mod.request(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(new URL(res.headers.location, url).href, cb);
    }
    var bufs = [];
    res.on('data', function (d) { bufs.push(d); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(bufs)); });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(60000, function () { req.destroy(new Error('超时')); });
  req.end();
}

function ensureSources(cb) {
  if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });
  var todo = SOURCES.filter(function (s) {
    return REFRESH || !fs.existsSync(path.join(RAW_DIR, s.file));
  });
  if (!todo.length) { console.log('两个源都已缓存在 tools/.db2-names/'); return cb(null); }
  if (OFFLINE) {
    return cb(new Error('--offline 但缺少缓存：' +
      todo.map(function (s) { return s.file; }).join('、')));
  }
  var i = 0;
  (function next() {
    if (i >= todo.length) return cb(null);
    var s = todo[i++];
    process.stdout.write('  下载 ' + s.file + ' … ');
    get(s.url, function (err, code, buf) {
      if (err) return cb(new Error(s.file + ' 下载失败：' + err.message));
      if (code !== 200) return cb(new Error(s.file + ' HTTP ' + code));
      fs.writeFileSync(path.join(RAW_DIR, s.file), buf);
      console.log((buf.length / 1024).toFixed(1) + ' KB');
      next();
    });
  })();
}

// ------------------------------------------------------------------ CSV
// RFC4180。DB2 的 Description_lang 里有逗号和换行，所以不能按行 split。

function parseCsv(text) {
  var rows = [], head = null, field = '', row = [], inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field); field = '';
      if (!head) head = row;
      else if (row.length > 1) {
        var o = {};
        for (var k = 0; k < head.length; k++) o[head[k]] = row[k];
        rows.push(o);
      }
      row = [];
      continue;
    }
    field += c;
  }
  return rows;
}

function hasCJK(s) { return /[\u4e00-\u9fff]/.test(String(s || '')); }

// ------------------------------------------------------------------ 交叉校验

/**
 * 从 app/labels.js 里抠出 L.classZh 的 9 条。
 * 用正则而不是 require —— labels.js 是浏览器用的 IIFE，且这里只要那一段字面量。
 */
function classZhFromLabels() {
  var txt = fs.readFileSync(LABELS, 'utf8');
  var m = /L\.classZh\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(txt);
  if (!m) throw new Error('labels.js 里找不到 L.classZh —— 交叉校验没法做');
  var out = {};
  var re = /([A-Z]+)\s*:\s*'([^']+)'/g, g;
  while ((g = re.exec(m[1]))) out[g[1]] = g[2];
  return out;
}

/** app/talent-tree.js 里的 40 个 specID —— 产物必须把它们全覆盖。 */
function specIdsFromTree() {
  if (!fs.existsSync(TREE_JS)) return null;
  var g = { };
  g.window = g;
  new Function('window', fs.readFileSync(TREE_JS, 'utf8'))(g);
  var t = g.AE_TALENT_TREE;
  return t && t.specs ? Object.keys(t.specs) : null;
}

// ------------------------------------------------------------------ 生成

function build() {
  var classes = parseCsv(fs.readFileSync(path.join(RAW_DIR, 'ChrClasses.csv'), 'utf8'));
  var specs = parseCsv(fs.readFileSync(path.join(RAW_DIR, 'ChrSpecialization.csv'), 'utf8'));

  // ---- 职业：ID → {classFile, zh}
  // Filename 是 `DeathKnight` 这种驼峰，游戏里的 classFile 是全大写 `DEATHKNIGHT`。
  var byId = {}, byFile = {};
  classes.forEach(function (r) {
    var id = Number(r.ID);
    var zh = String(r.Name_lang || '').trim();
    var file = String(r.Filename || '').trim().toUpperCase();
    if (!id || !zh || !file) return;
    // ChrClasses 里有「冒险者」/「旅行者」这种非玩家职业（ID 14/15），
    // 它们没有专精，下面按「有专精的职业」过滤，不在这里凭名字判断。
    byId[id] = { file: file, zh: zh };
    byFile[file] = zh;
  });

  // ---- 专精：ID → {classId, zh}
  var specOut = {}, specCount = {}, dropped = 0;
  specs.forEach(function (r) {
    var id = Number(r.ID);
    var cid = Number(r.ClassID);
    var zh = String(r.Name_lang || '').trim();
    if (!id || !zh) return;
    if (!cid) { dropped++; return; }   // ClassID 0 = 宠物/非玩家专精
    specOut[id] = { c: cid, zh: zh };
    specCount[cid] = (specCount[cid] || 0) + 1;
  });

  // 「玩家职业」得有个可测的定义，不能靠名字猜（也不能用「有专精」——
  // ChrClasses 里 ID 14「冒险者」有一个专精 1478，实测会混进来）。
  // 用两条**互相独立**的定义，并要求它们给出同一个集合：
  //   ① 专精数 >= 3。实测 13 个真职业各有 4~5 个（含一个「初始」起始专精），
  //      冒险者只有 1 个。
  //   ② app/talent-tree.js 那 40 个专精所跨的职业。
  // 单用①会依赖「专精数」这个数字，单用②会依赖树数据存在；两条对上才生成。
  var clsById = {};
  Object.keys(byId).forEach(function (id) {
    if ((specCount[id] || 0) >= 3) clsById[id] = 1;
  });
  var treeSpecs = specIdsFromTree();
  if (treeSpecs) {
    var byTree = {};
    treeSpecs.forEach(function (sid) {
      if (specOut[sid]) byTree[specOut[sid].c] = 1;
    });
    var onlyA = Object.keys(clsById).filter(function (k) { return !byTree[k]; });
    var onlyB = Object.keys(byTree).filter(function (k) { return !clsById[k]; });
    if (onlyA.length || onlyB.length) {
      throw new Error('两条「玩家职业」定义不一致：只满足「专精>=3」的 '
        + (onlyA.map(function (k) { return byId[k] ? byId[k].file : k; }).join('、') || '无')
        + '，只被天赋树覆盖的 '
        + (onlyB.map(function (k) { return byId[k] ? byId[k].file : k; }).join('、') || '无'));
    }
    console.log('职业集合：两条独立定义（专精数>=3 / 天赋树覆盖）给出同一个 '
      + Object.keys(byTree).length + ' 职业集合');
  }
  var clsOut = {};
  Object.keys(clsById).forEach(function (id) { clsOut[byId[id].file] = byId[id].zh; });

  // ---- 硬校验 1：13 个玩家职业
  var nCls = Object.keys(clsOut).length;
  if (nCls !== 13) {
    throw new Error('玩家职业数是 ' + nCls + '，不是 13 —— DB2 结构变了，先看清楚再生成');
  }
  // ---- 硬校验 2：每个名字都得是中文
  Object.keys(clsOut).forEach(function (k) {
    if (!hasCJK(clsOut[k])) throw new Error('职业 ' + k + ' 的名字不是中文：' + clsOut[k]);
  });
  Object.keys(specOut).forEach(function (k) {
    if (!hasCJK(specOut[k].zh)) {
      throw new Error('专精 ' + k + ' 的名字不是中文：' + specOut[k].zh);
    }
  });

  // ---- 硬校验 3：和 labels.js 里那 9 条（来自运行中的客户端）逐字比
  var harvested = classZhFromLabels();
  var conflict = [];
  Object.keys(harvested).forEach(function (k) {
    if (clsOut[k] && clsOut[k] !== harvested[k]) {
      conflict.push(k + '：DB2 说「' + clsOut[k] + '」，存档收来的是「' + harvested[k] + '」');
    }
  });
  if (conflict.length) {
    throw new Error('两个独立来源的职业名不一致，先查清楚是哪边错了：\n  · '
      + conflict.join('\n  · '));
  }
  console.log('交叉校验：存档收来的 ' + Object.keys(harvested).length
    + ' 个职业名和 DB2 **逐字一致**');

  // ---- 硬校验 4：talent-tree.js 的 40 个专精必须全覆盖
  if (treeSpecs) {
    var miss = treeSpecs.filter(function (id) { return !specOut[id]; });
    if (miss.length) {
      throw new Error('talent-tree.js 里有 ' + miss.length + ' 个专精在 DB2 里查不到中文名：'
        + miss.join('、'));
    }
    console.log('覆盖校验：talent-tree.js 的 ' + treeSpecs.length + ' 个专精**全部**有中文名');
  } else {
    console.log('（没有 app/talent-tree.js，跳过覆盖校验）');
  }

  return { cls: clsOut, spec: specOut, dropped: dropped };
}

function write(data) {
  var lines = [];
  lines.push('/*');
  lines.push(' * WowAltBoard - app/class-names.js  —— 自动生成，别手改');
  lines.push(' *');
  lines.push(' * 生成者：tools/fetch-class-names.js');
  lines.push(' * 来源：暴雪 DB2 的 ChrClasses / ChrSpecialization（wago.tools 导出，locale=zhCN）');
  lines.push(' *');
  lines.push(' * 职业按 classFile 建键，专精按 **specID** 建键 —— 按英文专精名建键会撞车');
  lines.push(' * （FROST 同时是死骑和法师的专精，那正是「冰法」那个 bug 的来历）。');
  lines.push(' */');
  lines.push('window.AE_DB2_NAMES = {');
  lines.push('  v: 1,');
  lines.push('  updatedAt: ' + JSON.stringify(new Date().toISOString().slice(0, 10)) + ',');
  lines.push('  source: \'Blizzard DB2 ChrClasses / ChrSpecialization (wago.tools, locale=zhCN)\',');
  lines.push('  cls: {');
  var ck = Object.keys(data.cls).sort();
  ck.forEach(function (k, i) {
    lines.push('    ' + k + ': ' + JSON.stringify(data.cls[k]) + (i < ck.length - 1 ? ',' : ''));
  });
  lines.push('  },');
  lines.push('  // specID: [中文名, classID]');
  lines.push('  spec: {');
  var sk = Object.keys(data.spec).sort(function (a, b) { return a - b; });
  sk.forEach(function (k, i) {
    lines.push('    ' + k + ': [' + JSON.stringify(data.spec[k].zh) + ', ' + data.spec[k].c + ']'
      + (i < sk.length - 1 ? ',' : ''));
  });
  lines.push('  }');
  lines.push('};');
  lines.push('');
  var out = lines.join('\n');
  fs.writeFileSync(OUT_JS, out, 'utf8');
  console.log('写出 app/class-names.js　' + (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)
    + ' KB　职业 ' + ck.length + '　专精 ' + sk.length
    + '（另有 ' + data.dropped + ' 个 ClassID=0 的非玩家专精被丢掉）');
}

ensureSources(function (err) {
  if (err) { console.error('失败：' + err.message); process.exit(1); }
  var data;
  try { data = build(); }
  catch (e) { console.error('失败：' + e.message); process.exit(1); }
  write(data);
});
