/*
 * WowAltBoard - tools/fetch-wcl.js
 *
 * 从 Warcraft Logs 抓**团本**里真实玩家的天赋导入串，产出 app/wcl-data.js。
 * 面板天赋页那一块因此能分「团本 / 大秘境」两类：大秘境那半来自 raider.io
 * （app/rio-data.js），团本这半来自这里。
 *
 * 为什么团本要换一家（raider.io 那两个端点只有大秘境）
 * --------------------------------------------------
 * raider.io 用的是 `/api/mythic-plus/rankings/specs`，名字里就写着 mythic-plus。
 * 团本它只有公会榜，没有「按角色 + 带天赋串」的榜。WCL 有。
 *
 * **凭证是用户给的，不入库。** 读 tools/.wcl-auth.json（已进 .gitignore）
 * 或环境变量 WCL_CLIENT_ID / WCL_CLIENT_SECRET。丢了就重新在 WCL 网站建一个
 * 应用；token 拿到之后有效期实测 360 天，缓存在 tools/.wcl-raw/.token.json。
 *
 * 导入串藏在哪（这是这个工具能成立的关键，找了两轮）
 * ------------------------------------------------
 * 一开始查的是 `playerDetails` 里的 combatantInfo —— 那里只有
 * `talentTree: [{id, rank, nodeID}]`，**没有串**。照那个自己编码是能编，
 * 但解码器有一段没建模的位（3722 条真实串里 84 条节点流之后还有非零位），
 * 重编会把它静默丢掉，产出一个游戏可能拒、也可能导成别的天赋的串。
 *
 * 后来用户提醒「WCL 页面上有复制按钮」，去翻 GraphQL schema 才找到：
 *
 *     ReportFight.talentImportCode(actorID: Int)
 *     "The import/export code for a Retail Dragonflight talent build."
 *
 * 它挂在**战斗**上、按 actorID 取，所以之前按「角色」找根本找不到。
 * 实测拿本机解码器解开：版本字节 2、treeHash 全 0、specID 对得上、
 * 74~76 个节点、84 点、剩余位 0~2 —— 和 raider.io 那批串一个成色。
 * **所以不需要编码器**，原样转发就行。
 *
 * 专精从**串头**认，不问 WCL
 * ------------------------
 * 串头 8 位版本 + 16 位 specID，解一下就知道是谁的。这样每场战斗只要一次
 * 请求拿 20 条串，不用再为「这人是什么专精」多问一次；而且 specID 来自串本身，
 * 比另一个字段更可信（rio 那边就是拿它做一致性校验的）。
 *
 * 配额（实测）
 * -----------
 * `rateLimitData` 说每小时 3600 点，一次查询约 1.7 点 —— 大约 2100 次/小时。
 * 所以这个工具**每次请求前看一眼余量**，不够就停下并告诉你几分钟后重置，
 * 已经抓到的都在缓存里，重跑接着抓。
 *
 * 用法
 * ----
 *   node tools\fetch-wcl.js                 抓（有缓存的跳过）
 *   node tools\fetch-wcl.js --bosses 3      只用前 3 个首领的榜找报告（默认全部）
 *   node tools\fetch-wcl.js --pages 2       每个首领翻几页榜（默认 1，一页 100 条）
 *   node tools\fetch-wcl.js --report        只用缓存重算，不联网
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var DEC = require('./decode-talent-string.js');
// 按「解出来是同一套天赋」归并。和 tools/fetch-rio.js 共用同一份实现 ——
// 面板把两家并排放在一个开关下面，「一套天赋」的定义必须一样。
var GROUP = require('./group-loadouts.js');

var ROOT = path.join(__dirname, '..');
var CACHE = path.join(__dirname, '.wcl-raw');
var OUT = path.join(ROOT, 'app', 'wcl-data.js');
var TOKEN_FILE = path.join(CACHE, '.token.json');
var AUTH_FILE = path.join(__dirname, '.wcl-auth.json');

var argv = process.argv.slice(2);
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }
function flag(n) { return argv.indexOf(n) >= 0; }

var PROXY = opt('--proxy', '');
var BOSSES = Number(opt('--bosses', 0)) || 0;
var PAGES = Number(opt('--pages', 1)) || 1;
var REPORT_ONLY = flag('--report');
// 配额下限：剩这么多点就停手，留点余量给别的用途。
var QUOTA_FLOOR = Number(opt('--quota-floor', 200)) || 200;

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

var net = { q: 0, cacheHit: 0, bytes: 0, errors: 0 };

/* --------------------------------------------------------------- 凭证 / 网络 */

function auth() {
  if (process.env.WCL_CLIENT_ID && process.env.WCL_CLIENT_SECRET) {
    return { clientId: process.env.WCL_CLIENT_ID, clientSecret: process.env.WCL_CLIENT_SECRET };
  }
  if (fs.existsSync(AUTH_FILE)) {
    var j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (j.clientId && j.clientSecret) return j;
  }
  console.error('没有 WCL 凭证。放一份 tools/.wcl-auth.json：');
  console.error('  { "clientId": "…", "clientSecret": "…" }');
  console.error('或者设环境变量 WCL_CLIENT_ID / WCL_CLIENT_SECRET。');
  console.error('（那个文件已在 .gitignore 里 —— 凭证不许入库。）');
  process.exit(1);
  return null;
}

function post(host, pathname, headers, body, cb) {
  var opts = {
    host: host, port: 443, method: 'POST', path: pathname,
    headers: headers, timeout: 90000
  };
  function go(sock) {
    if (sock) { opts.socket = sock; opts.agent = false; opts.servername = host; }
    var req = https.request(opts, function (res) {
      var cs = [];
      res.on('data', function (c) { cs.push(c); });
      res.on('end', function () {
        var buf = Buffer.concat(cs);
        net.bytes += buf.length;
        cb(null, res.statusCode, buf.toString('utf8'));
      });
      res.on('error', function (e) { cb(e); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { cb(e); });
    req.end(body);
  }
  if (!PROXY) { go(null); return; }
  var p = new URL(PROXY);
  var creq = http.request({
    host: p.hostname, port: p.port || 80, method: 'CONNECT',
    path: host + ':443', timeout: 30000
  });
  creq.on('connect', function (res, socket) {
    if (res.statusCode !== 200) { cb(new Error('CONNECT ' + res.statusCode)); return; }
    go(socket);
  });
  creq.on('error', function (e) { cb(e); });
  creq.end();
}

/* ------------------------------------------------------------------ token */

function getToken(cb) {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      var t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      // 留一天余量，别在边界上失效
      if (t.token && t.expiresAt > Date.now() + 86400000) { cb(null, t.token); return; }
    } catch (e) { /* 坏了就重新取 */ }
  }
  if (REPORT_ONLY) { cb(new Error('--report 模式下没有可用 token')); return; }
  var a = auth();
  var basic = Buffer.from(a.clientId + ':' + a.clientSecret).toString('base64');
  post('www.warcraftlogs.com', '/oauth/token', {
    'Authorization': 'Basic ' + basic,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': 29
  }, 'grant_type=client_credentials', function (e, code, body) {
    if (e) { cb(e); return; }
    if (code !== 200) { cb(new Error('取 token HTTP ' + code + '：' + body.slice(0, 200))); return; }
    var j;
    try { j = JSON.parse(body); } catch (e2) { cb(e2); return; }
    if (!j.access_token) { cb(new Error('返回里没有 access_token')); return; }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      token: j.access_token,
      expiresAt: Date.now() + (j.expires_in || 0) * 1000
    }));
    console.log('  取到新 token，有效期 ' + Math.round((j.expires_in || 0) / 86400) + ' 天');
    cb(null, j.access_token);
  });
}

/* ---------------------------------------------------- GraphQL（带缓存和配额） */

var TOKEN = null;
var quota = { left: null, resetIn: null };

/**
 * 一次 GraphQL 查询。
 *
 * key 是缓存文件名（不带扩展名）。**给了 key 就一定先查缓存** —— 这个工具
 * 会发上千次请求，中断重跑必须能接着抓，而不是从头再来一遍。
 */
function gql(key, query, cb) {
  var file = key ? path.join(CACHE, key + '.json') : null;
  if (file && fs.existsSync(file)) {
    net.cacheHit++;
    // **try 只包 JSON.parse，不许包 cb()。**
    // 原来写的是 `try { cb(null, JSON.parse(...)); return; } catch (e) {}` ——
    // 回调里抛出的任何异常都会被这个 catch 吞掉，然后往下走到「缓存里没有」那支
    // **再调一次 cb**。一次请求两次回调，于是 harvest 的循环会双进：
    // 实测打出 `harvest 850/831`（计数超过总数），聚合拿到的 rows 也跟着乱。
    var data = null, ok = false;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); ok = true; }
    catch (e) { ok = false; }        // 缓存坏了就往下重抓
    if (ok) { cb(null, data); return; }
  }
  if (REPORT_ONLY) { cb(new Error('--report：缓存里没有 ' + key)); return; }
  if (quota.left !== null && quota.left < QUOTA_FLOOR) {
    cb(new Error('QUOTA'));
    return;
  }
  post('www.warcraftlogs.com', '/api/v2/client', {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + TOKEN
  }, JSON.stringify({ query: query }), function (e, code, body) {
    net.q++;
    if (e) { net.errors++; cb(e); return; }
    if (code !== 200) { net.errors++; cb(new Error('HTTP ' + code + '：' + body.slice(0, 160))); return; }
    var j;
    try { j = JSON.parse(body); } catch (e2) { net.errors++; cb(e2); return; }
    if (j.errors) { net.errors++; cb(new Error(JSON.stringify(j.errors).slice(0, 200))); return; }
    if (file) fs.writeFileSync(file, JSON.stringify(j));
    cb(null, j);
  });
}

/** 问一次配额。**不缓存** —— 缓存一个「还剩多少点」毫无意义。 */
function refreshQuota(cb) {
  gql(null, '{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }',
    function (e, j) {
      if (e) { cb(); return; }
      var r = j.data.rateLimitData;
      quota.left = r.limitPerHour - r.pointsSpentThisHour;
      quota.resetIn = r.pointsResetIn;
      cb();
    });
}

/* ------------------------------------------------------------ 找当前团本 */

/**
 * 当前团本是哪个 zone。**不写死 ID。**
 *
 * 写死会在下个团本上线那天静默指着旧团本（和 raider.io 那个赛季 bug 一样的
 * 形状：旧数据照样返回 200）。所以按三个条件筛：
 *   · `frozen: false`（还在收数据）；
 *   · 难度里有 id 5（史诗）—— 大秘境那些 zone 只有 id 10（Dungeon）；
 *   · 名字里不带 PTR / Complete / Dummy —— 实测同时存在
 *     「The Venomous Abyss」和「The Venomous Abyss Complete Raid」，
 *     后者是整本合并榜，按首领取数据要用前者。
 * 剩下多于一个就取 id 最大的（最新）。
 */
function findRaid(cb) {
  gql('zones', '{ worldData { expansions { id name } } }', function (e, j) {
    if (e) { cb(e); return; }
    var exps = j.data.worldData.expansions || [];
    if (!exps.length) { cb(new Error('一个资料片都没列出来')); return; }
    var eid = exps[0].id;                       // 站点把最新的排在最前
    gql('zones-' + eid,
      '{ worldData { expansion(id: ' + eid + ') { name zones { id name frozen '
        + 'difficulties { id name } encounters { id name } } } } }',
      function (e2, j2) {
        if (e2) { cb(e2); return; }
        var exp = j2.data.worldData.expansion;
        var cands = (exp.zones || []).filter(function (z) {
          if (z.frozen) return false;
          if (!(z.difficulties || []).some(function (d) { return d.id === 5; })) return false;
          if (/PTR|Complete|Dummy/i.test(z.name)) return false;
          return (z.encounters || []).length > 1;
        });
        if (!cands.length) { cb(new Error('筛不出在用的团本 zone —— 上游改了？')); return; }
        cands.sort(function (a, b) { return b.id - a.id; });
        cb(null, { expansion: exp.name, zone: cands[0] });
      });
  });
}

/* ------------------------------------------------------- 找报告：谁打得好 */

/**
 * 每个首领的榜（不筛职业）。只为了**找报告**，不为了取名次。
 *
 * 为什么不按专精筛：一场团本 20 个人，下面 harvest 会把这 20 条串全拿走。
 * 所以「发现报告」和「覆盖专精」是两件事 —— 按专精筛榜只会让同一批报告
 * 被重复发现 40 次。实测不筛的话一页 100 条只覆盖 9 个专精（榜首被几个
 * 强势专精占满），但那 100 条落在 95 场不同的战斗里，harvest 完就是
 * 95 × 20 ≈ 1900 条串，专精分布跟着团本阵容走。
 */
function findFights(zone, cb) {
  var encs = zone.encounters || [];
  if (BOSSES) encs = encs.slice(0, BOSSES);
  var fights = {};                      // 'code#fightID' → {code, fightID}
  var i = 0, p = 1;
  (function step() {
    if (i >= encs.length) { cb(null, fights); return; }
    var e = encs[i];
    gql('rank-' + e.id + '-p' + p,
      '{ worldData { encounter(id: ' + e.id + ') { characterRankings('
        + 'difficulty: 5, metric: dps, page: ' + p + ') } } }',
      function (err, j) {
        if (err) {
          if (err.message === 'QUOTA') { cb(err); return; }
          console.log('  ' + e.name + ' p' + p + ' 榜抓不到：' + err.message.slice(0, 80));
        } else {
          var cr = j.data.worldData.encounter.characterRankings || {};
          (cr.rankings || []).forEach(function (r) {
            if (!r.report || !r.report.code) return;
            fights[r.report.code + '#' + r.report.fightID] =
              { code: r.report.code, fightID: r.report.fightID };
          });
        }
        p++;
        if (p > PAGES) { p = 1; i++; }
        step();
      });
  })();
}

/* ------------------------------------------------- harvest：一场战斗的全部串 */

/**
 * 一场战斗里所有友方玩家的导入串。
 *
 * **两次请求**，不是一次：`talentImportCode(actorID:)` 的别名必须写死在查询
 * 文本里，所以得先知道有哪些 actorID。第一次问 friendlyPlayers，第二次按那份
 * 名单生成 20 个别名。两次都进缓存，中断重跑不会重复问。
 *
 * 专精不问 WCL，从串头解（见文件头）。所以第二次请求只要串本身。
 *
 * 返回 `[{ ch: 角色身份, str: 导入串 }…]`。**必须带角色身份** ——
 * 见 aggregate() 上面那段：不带的话同一个人会被数几十次。
 */
function harvest(f, cb) {
  var key = 'fight-' + f.code + '-' + f.fightID;
  // 报告里每个 actorID 是谁。**按报告缓存，不按战斗** —— 一个报告里 actorID
  // 是稳定的，而一个报告通常有好几场被榜收录的战斗（一晚打 9 个首领）。
  // 实测 831 场战斗只落在 710 个报告里，按报告缓存省下 120 次请求。
  actors(f.code, function (ea, byId) {
    if (ea) { cb(ea); return; }
    gql(key + '-a',
      '{ reportData { report(code: "' + f.code + '") { fights(fightIDs: ['
        + f.fightID + ']) { id friendlyPlayers } } } }',
      function (e, j) {
        if (e) { cb(e); return; }
        var rep = j.data && j.data.reportData && j.data.reportData.report;
        var fi = rep && rep.fights && rep.fights[0];
        var ids = (fi && fi.friendlyPlayers) || [];
        if (!ids.length) { cb(null, []); return; }
        var aliases = ids.map(function (id, k) {
          return 'p' + k + ': talentImportCode(actorID: ' + id + ')';
        }).join(' ');
        gql(key + '-b',
          '{ reportData { report(code: "' + f.code + '") { fights(fightIDs: ['
            + f.fightID + ']) { ' + aliases + ' } } } }',
          function (e2, j2) {
            if (e2) { cb(e2); return; }
            var fr = j2.data.reportData.report.fights[0] || {};
            var out = [];
            // 别名是按 ids 的下标生成的（p0、p1…），所以 pN ↔ ids[N]。
            // 这个对应关系是这里唯一把「串」和「人」连起来的东西，别改顺序。
            Object.keys(fr).forEach(function (k) {
              if (!fr[k]) return;
              var idx = Number(String(k).slice(1));
              var who = byId[ids[idx]];
              if (!who) return;              // 认不出是谁的串就不要 —— 没法去重
              out.push({ ch: who, str: fr[k] });
            });
            cb(null, out);
          });
      });
  });
}

/**
 * 一个报告里 actorID → 角色身份。
 *
 * 身份优先用 `gameID`（角色在游戏里的唯一 ID），拿不到才退回 `名字@服务器`。
 * 为什么不直接用名字：跨服重名是真的（而且团本榜是全球的）。
 */
var actorCache = {};
function actors(code, cb) {
  if (actorCache[code]) { cb(null, actorCache[code]); return; }
  gql('actors-' + code,
    '{ reportData { report(code: "' + code + '") { masterData '
      + '{ actors(type: "Player") { id gameID name server } } } } }',
    function (e, j) {
      if (e) { cb(e); return; }
      var rep = j.data && j.data.reportData && j.data.reportData.report;
      var list = (rep && rep.masterData && rep.masterData.actors) || [];
      var byId = {};
      list.forEach(function (a) {
        if (!a || a.id == null) return;
        byId[a.id] = a.gameID ? ('g' + a.gameID)
          : ((a.name || '?') + '@' + (a.server || '?'));
      });
      actorCache[code] = byId;
      cb(null, byId);
    });
}

/* ------------------------------------------------------------------- 聚合 */

/**
 * 一堆 {ch 角色, str 串} → 每个专精按**人数**降序的天赋列表（不是串列表）。
 *
 * 专精从**串头**解（8 位版本 + 16 位 specID）。解不开、版本不是 2、
 * specID 不认识的**全部丢掉并计数** —— 一条解不开的串放进产物，
 * 用户复制粘贴进游戏得到「无效」，而界面上看不出来。
 *
 * **按角色去重，不是按出场次数。** 这是第 20 轮用户报出来的 bug：
 * 采样是按「战斗」走的（831 场），而一个团队一晚要打 9 个首领、还有多次尝试 ——
 * 同一个角色带着同一套天赋会在几十场战斗里被数几十次。于是：
 *   · 产物里的 n 是**出场次数**，而面板上写的是「N 名玩家」，那是假话；
 *   · 排名前几条被同一批人反复顶高，分布看起来假的集中。
 * 实测神圣骑 n=807 而前 6 条占 485（60%），敬效贼 677 里前 6 占 532（79%），
 * 而鲜血 DK 是 8% —— 后者才是真实的多样性（大秘境那半也是 8% 这个量级）。
 *
 * 所以计数单位是「多少个**不同的角色**用过这一串」，n 是「多少个不同的角色」。
 * 同一个角色在不同夜晚换过天赋的话，他在每一套里各算一次 —— 那是真实情况
 * （他确实用过两套），而不是把他按最后一次覆盖掉。
 *
 * 排序规则和 app/bis.js 的 loadoutsOf() 一致（人数降序，同人数按串本身），
 * 否则同一个「#1 热门」在两块里指的不是同一串。
 */
function aggregate(rows, ORDER, TREE) {
  var bySpec = {}, stat = { total: 0, ok: 0, badDecode: 0, badVer: 0, badSpec: 0,
    builds: 0, forms: 0 };
  rows.forEach(function (row) {
    var s = row && row.str, ch = row && row.ch;
    if (!s || !ch) return;
    stat.total++;
    var r;
    try { r = DEC.decode(s, ORDER); } catch (e) { stat.badDecode++; return; }
    if (!r || r.err) { stat.badDecode++; return; }
    if (r.ver !== 2) { stat.badVer++; return; }
    var sp = TREE.specs[String(r.spec)];
    if (!sp) { stat.badSpec++; return; }
    stat.ok++;
    (bySpec[r.spec] || (bySpec[r.spec] = [])).push(row);
  });
  var out = {};
  Object.keys(bySpec).forEach(function (sid) {
    // 「一套天赋」按解出来的内容算，交给 tools/group-loadouts.js —— 和 fetch-rio.js
    // 用的是**同一份实现**，不然两家的定义会慢慢跑偏，而面板把它们并排放在一个
    // 开关下面。WCL 的串是它自己从战斗记录生成的，同一套必然同一串，所以这边
    // 实测 1.00 种写法/套 —— 那正好是验「指纹没退化」的一把独立尺子。
    var g = GROUP.group(bySpec[sid], function (str) { return DEC.decode(str, ORDER); });
    stat.builds += g.list.length;
    stat.forms += g.forms;
    var chars = {};
    bySpec[sid].forEach(function (row) { chars[row.ch] = 1; });
    out[sid] = {
      cls: TREE.specs[sid].cls, specEn: TREE.specs[sid].specEn,
      // n = **多少个不同的角色**（不是出场次数，见上面那段）
      n: Object.keys(chars).length,
      // uniq = 一共多少套不同的天赋
      uniq: g.list.length,
      // 只留前 30 套。全存下来产物会膨胀，而面板只画前几套。
      loadouts: g.list.slice(0, 30).map(function (b2) { return [b2.str, b2.n]; })
    };
  });
  return { specs: out, stat: stat };
}

/* ------------------------------------------------------------------- 主流程 */

function main() {
  var g = {};
  var tp = path.join(ROOT, 'app', 'talent-tree.js');
  if (!fs.existsSync(tp)) {
    console.error('缺 app/talent-tree.js —— 先跑 node tools\\fetch-talent-tree.js');
    process.exit(1);
  }
  (new Function('window', fs.readFileSync(tp, 'utf8') + ';return window;'))(g);
  var TREE = g.AE_TALENT_TREE;
  var ORDER = DEC.loadOrder();

  console.log('Warcraft Logs 团本天赋抓取');
  getToken(function (e, tok) {
    if (e && !REPORT_ONLY) { console.error('取 token 失败：' + e.message); process.exit(1); }
    TOKEN = tok;
    refreshQuota(function () {
      if (quota.left !== null) {
        console.log('  配额：本小时还剩 ' + Math.round(quota.left) + ' 点，'
          + Math.round((quota.resetIn || 0) / 60) + ' 分钟后重置');
      }
      findRaid(function (e2, raid) {
        if (e2) { console.error('找不到当前团本：' + e2.message); process.exit(1); }
        console.log('  当前团本：' + raid.zone.name + '（zone ' + raid.zone.id + '，'
          + raid.expansion + '，' + (raid.zone.encounters || []).length + ' 个首领）');
        findFights(raid.zone, function (e3, fights) {
          if (e3 && e3.message === 'QUOTA') { quotaStop(); return; }
          var list = Object.keys(fights).map(function (k) { return fights[k]; });
          console.log('  榜里找到 ' + list.length + ' 场不同的战斗');
          run(raid, list, ORDER, TREE);
        });
      });
    });
  });
}

function quotaStop() {
  console.log('\n配额快用完了（剩 ' + Math.round(quota.left) + ' 点，门槛 ' + QUOTA_FLOOR + '）。');
  console.log('  ' + Math.round((quota.resetIn || 0) / 60) + ' 分钟后重置，'
    + '已经抓到的都在 tools/.wcl-raw/ 里，重跑接着抓。');
  process.exit(0);
}

function run(raid, list, ORDER, TREE) {
  // rows 是 {ch 角色, str 串}，不是裸串 —— 去重要靠 ch，见 aggregate()。
  var rows = [], done = 0, failed = 0, i = 0;
  var t0 = Date.now();

  (function step() {
    if (i >= list.length) { finish(); return; }
    // 每 40 场问一次配额。问得太勤是浪费点数，太疏会冲过门槛。
    if (done && done % 40 === 0 && net.q > 0) {
      refreshQuota(function () {
        if (quota.left !== null && quota.left < QUOTA_FLOOR) { finish(true); return; }
        go();
      });
      return;
    }
    go();

    function go() {
      var f = list[i++];
      harvest(f, function (e, arr) {
        done++;
        if (e) {
          if (e.message === 'QUOTA') { finish(true); return; }
          failed++;
          if (failed < 4) console.log('  ' + f.code + '#' + f.fightID + ' 取不到：'
            + e.message.slice(0, 70));
        } else {
          arr.forEach(function (r2) { rows.push(r2); });
        }
        if (done % 25 === 0 || done === list.length) {
          process.stdout.write('\r  harvest ' + done + '/' + list.length
            + '，串 ' + rows.length + '，失败 ' + failed
            + '，缓存命中 ' + net.cacheHit + '   ');
        }
        step();
      });
    }
  })();

  function finish(hitQuota) {
    console.log('');
    if (hitQuota) {
      console.log('  配额到门槛了，先聚合已经抓到的这些。');
    }
    var agg = aggregate(rows, ORDER, TREE);
    var st = agg.stat;
    console.log('\n串 ' + st.total + ' 条（按出场算）：能用 ' + st.ok
      + '，解不开 ' + st.badDecode + '，版本不是 2 的 ' + st.badVer
      + '，specID 不认识的 ' + st.badSpec);
    console.log('  天赋归并：' + st.builds + ' 套，共 ' + st.forms + ' 种写法'
      + (st.builds ? '（' + (st.forms / st.builds).toFixed(2) + ' 种/套）' : '')
      + ' —— WCL 的串是它自己生成的，同一套必然同一串，所以这边该是 1.00 种/套；'
      + '明显大于 1 说明指纹退化了（第 20 轮踩过）。'
      + '计数单位是「多少个不同的角色用过这一套」，同一个人在多场战斗里反复采到只算一次');
    var sids = Object.keys(agg.specs);
    console.log('覆盖 ' + sids.length + ' / ' + Object.keys(TREE.specs).length + ' 个专精');
    var thin = sids.filter(function (s) { return agg.specs[s].n < 20; });
    sids.sort(function (a, b) { return agg.specs[b].n - agg.specs[a].n; });
    console.log('  最多：' + sids.slice(0, 3).map(function (s) {
      return agg.specs[s].cls + '/' + agg.specs[s].specEn + ' ' + agg.specs[s].n;
    }).join('，'));
    console.log('  最少：' + sids.slice(-3).map(function (s) {
      return agg.specs[s].cls + '/' + agg.specs[s].specEn + ' ' + agg.specs[s].n;
    }).join('，'));
    if (thin.length) {
      console.log('  样本不到 20 人的 ' + thin.length + ' 个专精 —— 团本阵容里'
        + '一队 20 人只有 2~3 个坦克 / 治疗，冷门专精天然就少');
    }

    var obj = {
      v: 1,
      updatedAt: new Date().toISOString().slice(0, 10),
      source: 'Warcraft Logs（团本首领榜 → 报告 → ReportFight.talentImportCode）',
      raid: raid.zone.name,
      raidId: raid.zone.id,
      difficulty: '史诗',
      note: '团本里真实玩家的官方天赋导入串，**原样转发**，面板没有改动一个字符。'
        + '专精是从串头（8 位版本 + 16 位 specID）解出来的，不是问 WCL 要的 —— '
        + '串本身就是答案，比另一个字段更可信。'
        + '**n 和每条串的计数都是「多少个不同的角色」，不是出场次数。** '
        + '采样是按战斗走的，而一个团队一晚要打 9 个首领还有多次尝试，'
        + '同一个角色带着同一套天赋会在几十场战斗里被采到 —— 不去重的话 n 会'
        + '虚高好几倍，而且排名前几条被同一批人反复顶高，分布看起来假的集中'
        + '（第 20 轮的真 bug：神圣骑 n=807 而前 6 条占 485）。'
        + '去重用 WCL 的 gameID（角色在游戏里的唯一 ID），拿不到才退回 名字@服务器。'
        + '同一个角色在不同夜晚换过天赋的话，他在每一套里各算一次 —— 他确实用过两套。'
        + '每个专精只留前 30 套（人人都有点微调，全存下来产物会膨胀到几 MB，'
        + '而面板只画前几套）。'
        + '样本量按专精差别很大：一队 20 人只有 2~3 个坦克 / 治疗。',
      fmt: {
        specs: 'specId → {cls, specEn, n 多少个不同的角色, uniq 一共多少套天赋, '
          + 'loadouts [[串, 多少个不同的角色用这一套]…]（人数降序，最多 30 套；'
          + '「一套」按**解出来的天赋**算，不按字节，见 tools/group-loadouts.js）}'
      },
      fights: done,
      specs: agg.specs
    };
    var js = '/* 自动生成，勿手改。生成器：tools/fetch-wcl.js */\n'
      + 'window.AE_WCL = ' + JSON.stringify(obj) + ';\n';
    // **一个专精都没有就不许写盘。**
    // 第 20 轮真踩了：加了 actors 那一步之后 --report 因为缓存里没有 actors-*
    // 全军覆没，然后它照样把一个 2 KB 的空产物写了上去，把好的那份冲掉。
    // 「跑失败了」和「结果是空的」必须是两件事 —— 后者不该覆盖前一份好数据。
    if (!sids.length) {
      console.log('\n一个专精都没聚合出来 —— **不写盘**，保住原来那份 app/wcl-data.js。');
      console.log('  ' + (REPORT_ONLY
        ? '--report 只用缓存：缺的那些请求先跑一次不带 --report 的完整抓取。'
        : '看上面的失败原因。'));
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(OUT, js);
    console.log('\n产物 app/wcl-data.js  ' + Math.round(Buffer.byteLength(js) / 1024) + ' KB');
    console.log('网络：查询 ' + net.q + '，缓存命中 ' + net.cacheHit
      + '，失败 ' + net.errors + '，流量 ' + (net.bytes / 1024 / 1024).toFixed(1) + ' MB，'
      + (((Date.now() - t0) / 1000) | 0) + ' 秒');
  }
}

if (require.main === module) main();
module.exports = { aggregate: aggregate, OUT: OUT, CACHE: CACHE };
