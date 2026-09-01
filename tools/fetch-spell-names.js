/*
 * WowAltBoard - tools/fetch-spell-names.js
 *
 * 产出 tools/spell-names-zh.json：maxroll 指南正文里引用到的每个技能 / 天赋的
 * **官方中文名**（技能 ID → 中文名）。给 tools/fetch-maxroll.js 用，它拿这张表
 * 把正文里的英文技能名换成中文。
 *
 * 为什么需要这一张表（而不是直接翻译正文）
 * --------------------------------------
 * 「不凭记忆手打中文游戏名词」是硬约束：手打「痛苦无常」这种译名，打错了用户
 * 会照着一个游戏里不存在的名字去搜。所以中文名只能从**官方来源**取。
 * 本机翻遍 5339 个插件文件，能找到的英中对照 1929 条里**一条技能名都没有**
 * （全是职业名 / 专精名 / 首领名 / 副本小怪名）—— 所以本机不够，得有这张表。
 *
 * maxroll 的正文把每个技能都标了 ID，这是整件事能成立的前提：
 *
 *     <span class="wow-spell" data-wow-id="686">Shadow Bolt</span>
 *     <span class="wow-trait" data-wow-id="126519:AJAC">Arcane Surge</span>
 *
 * 所以不需要按英文名去猜是哪个技能 —— 按 ID 查，查不到就留英文。
 *
 * 两个来源，先本地后联网（实测 577 个不同 ID）
 * -------------------------------------------
 *  ① **app/talent-tree.js，一个字节都不用联网。** wow-trait 那 483 处引用的
 *     data-wow-id **不是 spellId，是天赋的 entryId** —— 正好是 talent-tree.js
 *     里 entryFormat「[entryId, nameIdx, iconIdx, spellId, maxRanks]」的第一项，
 *     而 names 那张表就是暴雪 DB2 的中文名。实测这样白拿 159 个。
 *     一开始没注意这件事，把它们全当 spellId 丢给 Wowhead，160 个全报
 *     「Entity not found」，白跑一趟网络。
 *  ② 剩下 417 个是基础技能（暗影箭 / 痛楚 / 斩杀这些，不是天赋节点），
 *     talent-tree.js 里没有，只能联网。走 Wowhead 的 tooltip 接口 + locale=4：
 *
 *         https://nether.wowhead.com/tooltip/spell/686?locale=4
 *         → {"name":"暗影箭","icon":"spell_shadow_shadowbolt",...}
 *
 *     只读公开数据，不上传任何本机内容。**必须走代理**（默认
 *     http://127.0.0.1:7897），直连不通。
 *
 * 实测覆盖 576/577。唯一查不到的是 Unstable Affliction（316099，Wowhead 报
 * Entity not found）—— 它就留英文。**留英文是正确行为，不是缺陷**：
 * 猜一个译名比留英文糟得多。
 *
 * 产物为什么进 git（而不是像 .maxroll-raw 那样只当缓存）
 * ----------------------------------------------------
 * tools/fetch-maxroll.js --report 要能**离线**重算产物 —— tools/mutate-mrtalents.js
 * 的生成器变异体就是这么跑的。这张表要是只在某台机器的缓存里，别人重算一遍
 * 就会静默得到一份全英文的产物，而套件不会红。所以它入库。
 *
 * 用法
 * ----
 *   node tools\fetch-spell-names.js                     补齐缺的（已有的跳过）
 *   node tools\fetch-spell-names.js --proxy http://…    换代理
 *   node tools\fetch-spell-names.js --local             只用 talent-tree.js，不联网
 *   node tools\fetch-spell-names.js --report            只报覆盖率，什么都不写
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var ROOT = path.join(__dirname, '..');
var CACHE = path.join(__dirname, '.maxroll-raw');
var OUT = path.join(__dirname, 'spell-names-zh.json');

var argv = process.argv.slice(2);
function opt(name, dflt) {
  var i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
var PROXY = opt('--proxy', 'http://127.0.0.1:7897');
var LOCAL_ONLY = argv.indexOf('--local') >= 0;
var REPORT_ONLY = argv.indexOf('--report') >= 0;

/* ------------------------------------------------------ maxroll 引用到哪些 ID */

/**
 * 要查哪些 ID。**优先读 tools/fetch-maxroll.js 留下的清单**，那是唯一准的来源。
 *
 * 为什么不自己扫全篇：一篇指南整页有 3497 个不同的技能引用，而**真正会被替换的
 * 只有出手顺序 / 首领说明那两块正文里的 577 个**。按全篇扫要多联网抓 1000 多次，
 * 抓回来的名字大半永远用不上，还要一直躺在入库的表里。
 *
 * 而「哪几段算出手顺序 / 首领说明」这件事只有 fetch-maxroll.js 的 walkGuide
 * 知道（它走的是 __remixContext 里的块树、按祖先链认小节）。在这里再实现一遍
 * 等于把那套判断复制两份，迟早对不上。所以让它跑的时候把 ID 清单顺手写出来，
 * 这边读。**两遍跑**（先 fetch-maxroll 出清单，再补名字，再 fetch-maxroll 替换）
 * 是这个依赖关系的代价，比复制一份提取逻辑便宜。
 */
function scanRefs() {
  var listFile = path.join(__dirname, '.maxroll-spell-ids.json');
  if (fs.existsSync(listFile)) {
    try {
      var j = JSON.parse(fs.readFileSync(listFile, 'utf8'));
      if (j && j.refs && Object.keys(j.refs).length) {
        console.log('读 tools/.maxroll-spell-ids.json（'
          + Object.keys(j.refs).length + ' 个 ID，由 fetch-maxroll.js 写出）');
        return j.refs;
      }
    } catch (e) { /* 坏了就退回下面全篇扫 */ }
  }
  console.log('没有 tools/.maxroll-spell-ids.json —— 先跑 node tools\\fetch-maxroll.js --report');
  console.log('（现在退回「扫全篇」，会多抓上千个用不到的名字）');
  return scanAll();
}

/**
 * 兜底：扫整篇 HTML 里所有 `<span class="wow-spell|wow-trait" data-wow-id="N">`。
 *
 * ID 后面可能挂后缀（实测 139 处，形如 `126519:AJAC`），**必须切掉**：
 * 带着后缀去查一定查不到，而那看起来会像「这个技能没有中文名」。
 */
function scanAll() {
  var refs = {};
  if (!fs.existsSync(CACHE)) return refs;
  fs.readdirSync(CACHE).forEach(function (f) {
    if (!/\.html$/.test(f)) return;
    var html = fs.readFileSync(path.join(CACHE, f), 'utf8');
    var re = /<span class="wow-(spell|trait)" data-wow-id="(\d+)(?::[A-Za-z0-9]+)?"[^>]*>([^<]{1,80})<\/span>/g;
    var m;
    while ((m = re.exec(html))) {
      var en = m[3].replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
      if (en) refs[m[2]] = { en: en, kind: m[1] };
    }
  });
  return refs;
}

/* ------------------------------------------ 来源 ①：app/talent-tree.js（本地） */

/**
 * 天赋树里的中文名。**两张表都建**：
 *   · entryId → 中文名（wow-trait 用的就是这个）；
 *   · spellId → 中文名（少数 wow-spell 恰好是天赋，实测 3 个）。
 * 顺序上先查 entryId：wow-trait 的 ID 是 entryId，先查 spellId 会张冠李戴。
 */
function localNames() {
  var p = path.join(ROOT, 'app', 'talent-tree.js');
  if (!fs.existsSync(p)) return { entry: {}, spell: {} };
  var g = {};
  (new Function('window', fs.readFileSync(p, 'utf8') + ';return window;'))(g);
  var T = g.AE_TALENT_TREE;
  var entry = {}, spell = {};
  if (T && T.nodes && T.names) {
    Object.keys(T.nodes).forEach(function (nid) {
      (T.nodes[nid][5] || []).forEach(function (e) {
        var nm = T.names[e[1]];
        if (!nm) return;
        entry[e[0]] = nm;
        if (e[3]) spell[e[3]] = nm;
      });
    });
  }
  return { entry: entry, spell: spell };
}

/* ------------------------------------------------ 来源 ②：Wowhead（走代理） */

/**
 * 走 CONNECT 隧道的 https GET。抄 tools/fetch-icons.js 的同名函数 ——
 * Node 自带的 https 不认 http_proxy 环境变量，隧道得自己建。
 */
function get(url, cb) {
  var u = new URL(url);
  if (!PROXY) {
    var direct = https.get({
      host: u.hostname, path: u.pathname + u.search, port: 443,
      headers: { 'user-agent': 'Mozilla/5.0', 'accept': '*/*' }, timeout: 20000
    }, collect(cb));
    direct.on('timeout', function () { direct.destroy(new Error('timeout')); });
    direct.on('error', function (e) { cb(e); });
    return;
  }
  var p = new URL(PROXY);
  var creq = http.request({
    host: p.hostname, port: p.port || 80, method: 'CONNECT',
    path: u.hostname + ':443', timeout: 20000
  });
  creq.on('connect', function (res, socket) {
    if (res.statusCode !== 200) { cb(new Error('CONNECT ' + res.statusCode)); return; }
    var req = https.get({
      socket: socket, agent: false, servername: u.hostname,
      host: u.hostname, path: u.pathname + u.search,
      headers: { 'user-agent': 'Mozilla/5.0', 'accept': '*/*' }, timeout: 20000
    }, collect(cb));
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { cb(e); });
  });
  creq.on('timeout', function () { creq.destroy(new Error('proxy timeout')); });
  creq.on('error', function (e) { cb(e); });
  creq.end();
}

function collect(cb) {
  return function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(chunks).toString('utf8')); });
    res.on('error', function (e) { cb(e); });
  };
}

/**
 * 一个技能的中文名。取不到返回 null —— **不返回英文名兜底**：
 * 兜底会让「查不到」和「查到了但恰好是英文」混在一起，后面统计覆盖率时分不开。
 */
function fetchOne(id, cb) {
  get('https://nether.wowhead.com/tooltip/spell/' + id + '?locale=4', function (err, code, body) {
    if (err || code !== 200) { cb(null); return; }
    var name = null;
    try {
      var j = JSON.parse(body);
      // 只认带汉字的名字。locale=4 偶尔回英文（那条目没有中文翻译），
      // 那种存下来等于用英文冒充中文名，覆盖率就成了假数。
      if (j && j.name && /[一-鿿]/.test(j.name)) name = j.name;
    } catch (e) { /* 不是 JSON 就当查不到 */ }
    cb(name);
  });
}

/** 有限并发跑一批。抄 fetch-icons.js 的 pool()。 */
function pool(items, n, fn, done) {
  var i = 0, active = 0, finished = 0;
  if (!items.length) { done(); return; }
  function next() {
    while (active < n && i < items.length) {
      active++;
      fn(items[i++], function () {
        active--; finished++;
        if (finished === items.length) done();
        else next();
      });
    }
  }
  next();
}

/* --------------------------------------------------------------------- 主流程 */

var refs = scanRefs();
var refIds = Object.keys(refs);
if (!refIds.length) {
  console.log('tools/.maxroll-raw 里一个技能引用都没扫到 —— 先跑 tools\\fetch-maxroll.js。');
  process.exit(1);
}

var have = {};
if (fs.existsSync(OUT)) {
  try { have = JSON.parse(fs.readFileSync(OUT, 'utf8')).names || {}; } catch (e) { have = {}; }
}

var loc = localNames();
console.log('maxroll 正文引用了 ' + refIds.length + ' 个不同的技能 / 天赋 ID');
console.log('  已入库 ' + Object.keys(have).length + ' 个');

// 先用本地那份填。每次都重填一遍（不跳过已有的）：talent-tree.js 换一版之后，
// 之前从 Wowhead 抓的名字应该让位给暴雪 DB2 的那份 —— 那才是权威来源。
var fromLocal = 0;
refIds.forEach(function (id) {
  var nm = loc.entry[id] || loc.spell[id];
  if (nm) { have[id] = nm; fromLocal++; }
});
console.log('  app/talent-tree.js 给出 ' + fromLocal + ' 个（不用联网）');

var todo = refIds.filter(function (id) { return !have[id]; });
console.log('  还缺 ' + todo.length + ' 个');

function finish() {
  var hit = refIds.filter(function (id) { return have[id]; });
  var miss = refIds.filter(function (id) { return !have[id]; });
  console.log('\n覆盖 ' + hit.length + '/' + refIds.length
    + '（' + Math.round(hit.length / refIds.length * 100) + '%），缺 ' + miss.length);
  if (miss.length) {
    console.log('缺的这些会在正文里**留英文**（猜译名比留英文糟）：');
    miss.slice(0, 20).forEach(function (id) {
      console.log('  ' + refs[id].en + '（' + id + '，' + refs[id].kind + '）');
    });
    if (miss.length > 20) console.log('  …… 还有 ' + (miss.length - 20) + ' 个');
  }
  if (REPORT_ONLY) { console.log('\n--report：没有写文件。'); return; }

  // **只合并，从不删。** 第一版这里按「当前引用清单」裁剪过一遍，理由是
  // 「别让表随着别的用途无限长大」—— 那是个错误的设计：清单是
  // fetch-maxroll.js 当前行为的产物，所以生成器一改，这张**入库的**表就会
  // 静默丢名字。真踩到了：给 walkGuide 加了「Priority 后面是分页容器」那条路
  // 之后，防护骑那两个英雄天赋 ID（123358 / 123361）不再出现在清单里，
  // 跑一次这个脚本就把它们从表里删掉了 —— 然后 tools/mutate-mrtalents.js
  // 那个变异体变成「漏」，因为退回旧路径时那两个名字已经没有中文了。
  // 多留几个用不上的名字（几百字节）比这种耦合便宜得多。
  var out = {};
  Object.keys(have).sort(function (a, b) { return Number(a) - Number(b); })
    .forEach(function (id) { out[id] = have[id]; });
  fs.writeFileSync(OUT, JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'app/talent-tree.js 的 entryId → 暴雪 DB2 中文名（天赋）'
      + ' + Wowhead tooltip locale=4（基础技能）',
    note: '键是 maxroll 正文里 data-wow-id 的值：wow-trait 是天赋 entryId，'
      + 'wow-spell 是 spellId。tools/fetch-maxroll.js 拿它替换正文里的英文技能名，'
      + '查不到的留英文。',
    names: out
  }, null, 1) + '\n');
  console.log('\n已写 ' + path.relative(ROOT, OUT) + '（' + Object.keys(out).length + ' 条）');
}

if (LOCAL_ONLY || REPORT_ONLY || !todo.length) {
  if (todo.length && (LOCAL_ONLY || REPORT_ONLY)) {
    console.log('  （' + (LOCAL_ONLY ? '--local' : '--report') + '：不联网，这些就缺着）');
  }
  finish();
} else {
  console.log('  联网补齐，代理 ' + (PROXY || '（直连）') + '…');
  var done = 0, got = 0;
  pool(todo, 4, function (id, next) {
    fetchOne(id, function (nm) {
      done++;
      if (nm) { have[id] = nm; got++; }
      if (done % 100 === 0) console.log('    ' + done + '/' + todo.length + '，拿到 ' + got);
      next();
    });
  }, function () {
    console.log('    抓完 ' + done + ' 个，拿到 ' + got);
    finish();
  });
}
