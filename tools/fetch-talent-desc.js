/*
 * WowAltBoard - tools/fetch-talent-desc.js
 *
 * 产出 app/talent-desc.js：天赋节点的**官方中文说明文字**（spellId → 说明）。
 * 面板把它挂在天赋树每个图标的悬停提示上（第 19 轮用户要的
 * 「天赋图标，鼠标指向的提示，能不能显示天赋原本说明」）。
 *
 * 为什么要单独抓
 * -------------
 * app/talent-tree.js 里每个 entry 是 `[entryId, nameIdx, iconIdx, spellId, maxRanks]`
 * —— 有名字、有图标、有 spellId，**没有说明文字**。上游那份 raidbots talents.json
 * 也不带说明。所以要么不显示，要么另抓一份。
 *
 * 来源：Wowhead 的 tooltip 接口 + locale=4（简体中文）。只读公开数据，
 * 不上传任何本机内容，**必须走代理**（默认 http://127.0.0.1:7897）。
 *
 * 说明文字在返回的 HTML 里的位置（实测）
 * -----------------------------------
 * 返回是 JSON，`tooltip` 字段里是两张 table：第一张是名字 / 消耗 / 距离 /
 * 施法时间 / 职业要求，第二张里的 `<div class="q">` **才是说明本身**。
 * 所以只取 `div class="q"`，不要整段扒 —— 整段扒会把「需要 术士」「40 码范围」
 * 这些混进说明里，悬停提示会变成一大坨。
 *
 * `<br />` 保留成换行（说明经常分两段：主效果 + 一句补充），面板那边按行画。
 *
 * 关于 `([9.31297% of Spell Power])` 这种括号公式
 * ---------------------------------------------
 * **原样保留，不动它。** 游戏里这些会按你的属性算成具体数字，而 Wowhead 在没有
 * 角色上下文时就给公式。想把它变成数字得知道角色属性，那是面板拿不到的；
 * 编一个数字上去就是假的。留着公式至少还能看出「伤害随法强走」。
 *
 * 用法
 * ----
 *   node tools\fetch-talent-desc.js                  补齐缺的（已有的跳过）
 *   node tools\fetch-talent-desc.js --proxy http://… 换代理
 *   node tools\fetch-talent-desc.js --limit 50       只抓前 50 个（开发用）
 *   node tools\fetch-talent-desc.js --report         只报覆盖率，什么都不写
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'app', 'talent-desc.js');

var argv = process.argv.slice(2);
function opt(name, dflt) {
  var i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
var PROXY = opt('--proxy', 'http://127.0.0.1:7897');
var LIMIT = Number(opt('--limit', 0)) || 0;
var REPORT_ONLY = argv.indexOf('--report') >= 0;

/* ------------------------------------------------- 要抓哪些 spellId */

function wantSpells() {
  var p = path.join(ROOT, 'app', 'talent-tree.js');
  if (!fs.existsSync(p)) {
    console.error('没有 app/talent-tree.js —— 先跑 node tools\\fetch-talent-tree.js');
    process.exit(1);
  }
  var g = {};
  (new Function('window', fs.readFileSync(p, 'utf8') + ';return window;'))(g);
  var T = g.AE_TALENT_TREE;
  var ids = {};
  Object.keys(T.nodes).forEach(function (nid) {
    (T.nodes[nid][5] || []).forEach(function (e) {
      // e = [entryId, nameIdx, iconIdx, spellId, maxRanks]
      if (e[3]) ids[e[3]] = T.names[e[1]] || '';
    });
  });
  return ids;
}

/* ------------------------------------------------------- 网络（走代理） */

/** 走 CONNECT 隧道的 https GET。和 tools/fetch-spell-names.js 里那份一样。 */
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

/* ------------------------------------------------------------- 说明的提取 */

/**
 * 从 tooltip HTML 里取说明。取不到返回 null（**不拿别的字段兜底** ——
 * 兜底会让「没有说明」和「说明抓歪了」混在一起，覆盖率就成了假数）。
 */
function pickDesc(tooltip) {
  var m = /<div class="q">([\s\S]*?)<\/div>/.exec(String(tooltip || ''));
  if (!m) return null;
  var t = m[1]
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(function (l) { return l.trim(); }).join('\n')
    .trim();
  return t || null;
}

function fetchOne(id, cb) {
  get('https://nether.wowhead.com/tooltip/spell/' + id + '?locale=4', function (err, code, body) {
    if (err || code !== 200) { cb(null); return; }
    try {
      var j = JSON.parse(body);
      cb(pickDesc(j.tooltip));
    } catch (e) { cb(null); }
  });
}

/** 有限并发跑一批。 */
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

var want = wantSpells();
var ids = Object.keys(want);
console.log('app/talent-tree.js 里有 ' + ids.length + ' 个不同的 spellId');

// 已有的接着用（可续跑）。产物本身就是缓存 —— 3000 多次请求不该重来一遍。
var have = {};
if (fs.existsSync(OUT)) {
  try {
    var g2 = {};
    (new Function('window', fs.readFileSync(OUT, 'utf8') + ';return window;'))(g2);
    have = (g2.AE_TALENT_DESC && g2.AE_TALENT_DESC.desc) || {};
  } catch (e) { have = {}; }
}
console.log('  已有说明 ' + Object.keys(have).length + ' 条');

var todo = ids.filter(function (id) { return !have[id]; });
if (LIMIT) todo = todo.slice(0, LIMIT);
console.log('  待抓 ' + todo.length + (LIMIT ? '（--limit ' + LIMIT + '）' : ''));

function finish() {
  var hit = ids.filter(function (id) { return have[id]; });
  console.log('\n覆盖 ' + hit.length + '/' + ids.length
    + '（' + Math.round(hit.length / ids.length * 100) + '%）');
  var miss = ids.filter(function (id) { return !have[id]; });
  if (miss.length) {
    console.log('没有说明的 ' + miss.length + ' 个（面板上那些节点只显示名字）：');
    miss.slice(0, 10).forEach(function (id) {
      console.log('  ' + (want[id] || '?') + '（' + id + '）');
    });
    if (miss.length > 10) console.log('  …… 还有 ' + (miss.length - 10) + ' 个');
  }
  if (REPORT_ONLY) { console.log('\n--report：没有写文件。'); return; }

  var out = {};
  Object.keys(have).sort(function (a, b) { return Number(a) - Number(b); })
    .forEach(function (id) { out[id] = have[id]; });
  var body = 'window.AE_TALENT_DESC = ' + JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'Wowhead tooltip 接口 locale=4（简体中文），只取 div.q 那一段说明',
    note: '键是 spellId（app/talent-tree.js 里 entry 的第 4 项）。'
      + '括号里的 ([xx% of Spell Power]) 是上游给的公式，原样保留 —— '
      + '游戏里会按角色属性算成数字，面板拿不到那些属性，编一个上去就是假的。',
    desc: out
  }) + ';\n';
  fs.writeFileSync(OUT, '/* 自动生成，勿手改。生成器：tools/fetch-talent-desc.js */\n' + body);
  console.log('\n已写 app/talent-desc.js（' + Object.keys(out).length + ' 条，'
    + Math.round(fs.statSync(OUT).size / 1024) + ' KB）');
}

if (REPORT_ONLY || !todo.length) {
  finish();
} else {
  console.log('  联网抓取，代理 ' + (PROXY || '（直连）') + '…');
  var done = 0, got = 0;
  pool(todo, 4, function (id, next) {
    fetchOne(id, function (d) {
      done++;
      if (d) { have[id] = d; got++; }
      if (done % 200 === 0) {
        console.log('    ' + done + '/' + todo.length + '，拿到 ' + got);
        finish.partial = true;                      // 中途也落一次盘，断了能续
        var tmp = {};
        Object.keys(have).sort(function (a, b) { return Number(a) - Number(b); })
          .forEach(function (k) { tmp[k] = have[k]; });
        fs.writeFileSync(OUT, '/* 自动生成，勿手改。生成器：tools/fetch-talent-desc.js */\n'
          + 'window.AE_TALENT_DESC = ' + JSON.stringify({ v: 1,
            updatedAt: new Date().toISOString().slice(0, 10),
            source: 'Wowhead tooltip 接口 locale=4（简体中文），只取 div.q 那一段说明',
            note: '抓取中途的快照', desc: tmp }) + ';\n');
      }
      next();
    });
  }, function () {
    console.log('    抓完 ' + done + ' 个，拿到 ' + got);
    finish();
  });
}
