/*
 * WowAltBoard - tools/fetch-talent-icons.js
 *
 * 把 app/talent-tree.js 里用到的 2094 个天赋图标下载到 app/talent-icons/，
 * 让天赋树离线也能出图。
 *
 * 为什么需要这一步
 * ----------------
 * 天赋树画出来之后，每个节点只有一个 62×32 的方块 + 中文名 + 点数徽章，**没有图**。
 * 游戏里天赋是靠图标认的，纯文字的树跟游戏里长得完全不一样，很难对照。
 * 图标**名字**其实早就在数据里了 —— `app/talent-tree.js` 的 `icons` 数组有 2094 个名字
 * （`ability_druid_disembowel` 这种），节点的 `entries[]` 用下标引用它。
 * 缺的只是图片本身。
 *
 * 尺寸为什么选 56
 * ---------------
 * 暴雪 CDN 只开放 18 / 56 两档（64 返回 403，和 fetch-icons.js 那边量到的一样）。
 * 本机实测（40 个样本，两档都 40/40 可得）：56 平均 2626 B、18 平均 996 B，
 * 推算 2094 张分别是 **5.24 MB** 和 1.99 MB。
 * 选 56 的理由：① 装备图标已经是 56（`app/icons/`），混用会一大一小；
 * ② 节点里显示成 24 px 左右，56 缩下去清晰，18 放大到 24 会明显模糊；
 * ③ 高分屏 / 浏览器缩放下 18 更糟。多出来的 3.2 MB 换的是「看得清」。
 *
 * 两个图片源（和 fetch-icons.js 同一套结论，本机 2026-08 实测）
 * ------------------------------------------------------------
 *   · render.worldofwarcraft.com  直连 200，**不要代理**；
 *   · wow.zamimg.com              直连 403，**必须走代理**，用来补 CDN 上没有的。
 * 两边都是公开只读数据，不上传任何本机内容。
 *
 * 上游有 19 个图标名是错的 —— 用 spellId 去查真名
 * ------------------------------------------------
 * 全量下完第一次，2075/2094 成功，**19 个在两个源上都是 404**。查过了：它们不是
 * 「源没有这张图」，而是 **raidbots 给的名字本身不存在**。两种坏法：
 *
 *   1. **连字符被换成了下划线**（16 个）。真名 `spell_frost_ring-of-frost`，
 *      raidbots 写成 `spell_frost_ring_of_frost`。这是个不可逆的规范化：
 *      真名里本来就有下划线（`spell_frost_` 前缀），所以没法从坏名字反推该把
 *      哪个下划线换回连字符 —— `ring_of_frost` 可以是 `ring-of-frost`、
 *      `ring_of-frost`、`ring-of_frost`。猜是不行的。
 *   2. **只有数字 FileDataID**（3 个，都是 11.x 的新图标）：真名就是 `8026697`
 *      这样的纯数字，暴雪 CDN 直接收这个数字。
 *
 * 所以修法是**用 spellId 去 wowhead 查真名**（`nether.wowhead.com/tooltip/spell/<id>`
 * 的 json 里有 `icon` 字段，要走代理）。每个 entry 都带 spellId，天赋树里就有。
 * 实测 **19/19 全部查到真名并下到图**。
 *
 * 关键决定：**存盘时用 raidbots 那个（错的）名字**。这样 `app/` 一侧完全不需要
 * 映射表 —— 节点里的图标名直接当文件名用就行。文件名是我们自己的键，不是上游的名字。
 * 查到的对应关系缓存在 tools/.talent-icon-fix.json（提交进仓库，几 KB），
 * 重跑不必再查一遍 wowhead。
 *
 * 断点续传
 * --------
 * 已经存在且大于 300 B 的文件直接跳过，所以中断后重跑只补缺的。
 * 换赛季重跑 fetch-talent-tree.js 之后再跑一次这个，补上新天赋的图标。
 *
 * 用法
 * ----
 *   node tools\fetch-talent-icons.js
 *   node tools\fetch-talent-icons.js --limit 40          # 试跑
 *   node tools\fetch-talent-icons.js --size 18           # 省空间的那一档
 *   node tools\fetch-talent-icons.js --proxy http://127.0.0.1:7897
 *   node tools\fetch-talent-icons.js --check             # 只查覆盖率，不联网
 *   node tools\fetch-talent-icons.js --refix             # 忽略修复缓存，重查一遍
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');

var ROOT = path.resolve(__dirname, '..');
var TREE_JS = path.join(ROOT, 'app', 'talent-tree.js');
var ICON_DIR = path.join(ROOT, 'app', 'talent-icons');
// 「坏名字 → 真名」的对应关系。提交进仓库：它是查出来的事实，不是缓存的下载数据，
// 而且重查一遍要联网 + 走代理，克隆下来的人不该被迫重跑。
var FIX_JSON = path.join(__dirname, '.talent-icon-fix.json');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

var PROXY = opt('--proxy', 'http://127.0.0.1:7897');
var SIZE = Number(opt('--size', 56)) || 56;
var LIMIT = Number(opt('--limit', 0)) || 0;
var CHECK_ONLY = flag('--check');
var REFIX = flag('--refix');
var CONCURRENCY = 4;

// ------------------------------------------------------------------ 读图标名

/**
 * 从 app/talent-tree.js 里取图标名，**外加每个图标名对应的 spellId 列表**。
 *
 * 只读**提交进仓库的产物**，不读 tools/.talent-raw/ 那份 14 MB 的上游 json ——
 * 那份是 gitignored 的，克隆下来没有它，依赖它的工具会静默少下一批图标。
 *
 * spellId 是**修坏名字用的**：raidbots 有 19 个图标名在两个源上都是 404，
 * 因为它把真名里的连字符换成了下划线（`spell_frost_ring-of-frost` →
 * `..._ring_of_frost`），还有 3 个新图标它给的是旧名、真名是数字 FileDataID。
 * 拿 spellId 去 wowhead 查 tooltip 就能得到真名 —— 详见 repair()。
 */
function loadIconNames() {
  if (!fs.existsSync(TREE_JS)) {
    throw new Error('缺 app/talent-tree.js —— 先跑 node tools\\fetch-talent-tree.js');
  }
  var sandbox = { window: {} };
  var src = fs.readFileSync(TREE_JS, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', src)(sandbox.window);
  var tree = sandbox.window.AE_TALENT_TREE;
  if (!tree || !tree.icons || !tree.icons.length) {
    throw new Error('app/talent-tree.js 里没有 icons 字典，拒绝继续');
  }
  var bad = tree.icons.filter(function (n) { return !/^[a-z0-9_]+$/.test(String(n)); });
  if (bad.length) {
    // 图标名会拼进文件路径和 <img src>。放宽这条断言等于给路径注入开门。
    throw new Error('有 ' + bad.length + ' 个图标名不只含小写字母数字下划线，'
      + '前几个：' + bad.slice(0, 5).join(', '));
  }

  // nodeFormat = [posX, posY, maxRanks, typeIdx, reqPoints, entries[], subTreeId, requiresNode]
  // entryFormat = [entryId, nameIdx, iconIdx, spellId, maxRanks]
  // 下标写死在这里是有意的：格式变了就该在这里炸，而不是静默收集到 0 个 spellId。
  var spells = {};
  var nodeCount = 0, entryCount = 0;
  Object.keys(tree.nodes || {}).forEach(function (id) {
    var n = tree.nodes[id];
    if (!n || !Array.isArray(n)) return;
    nodeCount++;
    (n[5] || []).forEach(function (e) {
      if (!Array.isArray(e)) return;
      entryCount++;
      var ico = tree.icons[e[2]];
      var sid = e[3];
      if (!ico || !sid) return;
      if (!spells[ico]) spells[ico] = [];
      if (spells[ico].indexOf(sid) < 0) spells[ico].push(sid);
    });
  });
  if (!nodeCount || !entryCount) {
    throw new Error('从 app/talent-tree.js 的 nodes 里一个 entry 都没读出来（节点 '
      + nodeCount + '，entry ' + entryCount + '）—— nodeFormat 可能变了，拒绝继续');
  }

  return { icons: tree.icons.slice(), spells: spells };
}

// -------------------------------------------------------------------- 网络

function get(url, proxy, cb) {
  var done = false;
  function fin(err, code, body) { if (!done) { done = true; cb(err, code, body); } }
  var opts, mod;
  if (proxy) {
    var pu = new URL(proxy);
    var tu = new URL(url);
    mod = pu.protocol === 'https:' ? https : http;
    opts = {
      host: pu.hostname, port: pu.port || (pu.protocol === 'https:' ? 443 : 80),
      method: 'GET', path: url,
      headers: { Host: tu.host, 'User-Agent': 'WowAltBoard/1.0', Accept: 'image/jpeg,image/*' }
    };
  } else {
    var u = new URL(url);
    mod = u.protocol === 'https:' ? https : http;
    opts = {
      host: u.hostname, port: u.port || 443, method: 'GET', path: u.pathname + u.search,
      headers: { 'User-Agent': 'WowAltBoard/1.0', Accept: 'image/jpeg,image/*' }
    };
  }
  var req = mod.request(opts, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { fin(null, res.statusCode, Buffer.concat(chunks)); });
  });
  req.on('error', function (e) { fin(e); });
  req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
  req.end();
}

function pool(items, n, worker, done) {
  var i = 0, active = 0, finished = 0;
  function next() {
    while (active < n && i < items.length) {
      var it = items[i++];
      active++;
      worker(it, function () {
        active--; finished++;
        if (finished === items.length) { done(); return; }
        next();
      });
    }
  }
  if (!items.length) { done(); return; }
  next();
}

var lastLine = 0;
function progress(done, total, note) {
  var now = Date.now();
  if (now - lastLine < 500 && done < total) return;
  lastLine = now;
  var pct = total ? Math.round(done * 100 / total) : 100;
  process.stdout.write('\r  ' + done + '/' + total + ' (' + pct + '%) ' + (note || '') + '   ');
  if (done >= total) process.stdout.write('\n');
}

// ---------------------------------------------------------------- 下载图片

function download(names, cb) {
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

  var todo = names.filter(function (n) {
    var f = path.join(ICON_DIR, n + '.jpg');
    return !fs.existsSync(f) || fs.statSync(f).size < 300;
  });
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log('共 ' + names.length + ' 个图标名，需要下 ' + todo.length
    + (LIMIT ? '（--limit ' + LIMIT + '）' : ''));
  if (!todo.length) { cb(0, {}); return; }

  var SOURCES = [
    { name: '暴雪CDN', proxy: '',
      url: function (n) {
        return 'https://render.worldofwarcraft.com/us/icons/' + SIZE + '/' + n + '.jpg';
      } },
    // large = 56×56，和暴雪 CDN 的 56 一致；medium 只有 36×36，混用会一大一小。
    // 18 那一档 zamimg 没有对应目录，所以只有 56 才有这个备用源。
    { name: 'zamimg', proxy: PROXY,
      url: function (n) {
        return 'https://wow.zamimg.com/images/wow/icons/large/' + n + '.jpg';
      } }
  ];

  var done = 0, failed = [], bySource = {}, bytes = 0;
  pool(todo, CONCURRENCY, function (name, next) {
    (function trySource(si) {
      if (si >= SOURCES.length) {
        failed.push(name);
        done++; progress(done, todo.length, '失败 ' + failed.length);
        next(); return;
      }
      var src = SOURCES[si];
      if (SIZE !== 56 && src.name === 'zamimg') { trySource(si + 1); return; }
      var tries = 0;
      (function attempt() {
        tries++;
        get(src.url(name), src.proxy, function (err, code, body) {
          if (!err && code === 200 && body.length > 300) {
            fs.writeFileSync(path.join(ICON_DIR, name + '.jpg'), body);
            bySource[src.name] = (bySource[src.name] || 0) + 1;
            bytes += body.length;
            done++; progress(done, todo.length, 'ok');
            next(); return;
          }
          if (code === 403 || code === 404) { trySource(si + 1); return; }
          if (tries < 2) { setTimeout(attempt, 400 * tries); return; }
          trySource(si + 1);
        });
      })();
    })(0);
  }, function () {
    progress(todo.length, todo.length, failed.length ? '失败 ' + failed.length : '全部下好');
    Object.keys(bySource).forEach(function (k) {
      console.log('  来自 ' + k + '：' + bySource[k] + ' 个');
    });
    if (bytes) console.log('  本次下了 ' + (bytes / 1024 / 1024).toFixed(2) + ' MB');
    if (failed.length) {
      console.log('  下不到的（' + failed.length + ' 个）：'
        + failed.slice(0, 20).join(', ') + (failed.length > 20 ? ' …' : ''));
    }
    cb(failed.length, bySource, failed);
  });
}

// ------------------------------------------------------------ 修坏掉的名字

/**
 * 两个源都 404 的图标名，用 spellId 去 wowhead 查真名，再下回来。
 *
 * 为什么需要这一通道（本机实测，19 个名字全查证过）：raidbots 那份 talents.json
 * 里有一批图标名是**它自己规范化过的**，规范化把真名里的连字符换成了下划线：
 *
 *   raidbots 给                 wowhead 给的真名             CDN 上的状态
 *   spell_frost_ring_of_frost   spell_frost_ring-of-frost    下划线版 404，连字符版 200
 *   warlock__bloodstone         warlock_-bloodstone          同上
 *   spell_priest_power_word     spell_priest_power-word       同上
 *
 * 另有 5 个是**新图标还没有名字**，wowhead 直接给数字 FileDataID（升腾三个变体
 * → 8026696/7/8，瞄准射击 → 8026692，破天投枪 → 8026700），数字这种在暴雪 CDN
 * 上反而是 200。
 *
 * 所以这不是「源上没有图」，是**上游给的名字不存在**。19 个全部能修好。
 *
 * 关键决定：**存盘用 raidbots 那个坏名字**。app/talent-tree.js 的 icons 字典里
 * 就是坏名字，面板按字典取文件名。若按真名存盘，app/ 就得再带一张映射表，
 * 而那张表会变成第二个需要维护的真相来源。让文件名当键，坏名字就只是个键。
 */
function repair(failed, spellsByIcon, cb) {
  if (!failed.length) { cb(0); return; }

  var fix = {};
  if (fs.existsSync(FIX_JSON) && !REFIX) {
    try { fix = JSON.parse(fs.readFileSync(FIX_JSON, 'utf8')).map || {}; } catch (e) { fix = {}; }
  }

  console.log('修坏掉的图标名：' + failed.length + ' 个两个源都没有，拿 spellId 去 wowhead 查真名');
  var done = 0, ok = 0, stillBad = [], learned = 0;

  // 并发 1：wowhead 的 tooltip 端点问快了就 502，见下面 ask() 的说明。
  pool(failed, 1, function (bad, next) {
    function finish(good, why) {
      if (good) ok++; else stillBad.push(bad + (why ? '（' + why + '）' : ''));
      done++; progress(done, failed.length, ok + ' 修好');
      // 每条之间留点间隔，别把端点问出 502 来。
      setTimeout(next, 250);
    }

    function grab(real, then) {
      // 数字 FileDataID 在暴雪 CDN 上有；连字符名只有 zamimg 有。两个都试。
      var tries = [
        ['', 'https://render.worldofwarcraft.com/us/icons/' + SIZE + '/' + real + '.jpg'],
        [PROXY, 'https://wow.zamimg.com/images/wow/icons/large/' + real + '.jpg']
      ];
      (function attempt(i) {
        if (i >= tries.length) { then(false); return; }
        get(tries[i][1], tries[i][0], function (err, code, body) {
          if (!err && code === 200 && body.length > 300) {
            fs.writeFileSync(path.join(ICON_DIR, bad + '.jpg'), body);   // 用坏名字存盘
            then(true); return;
          }
          attempt(i + 1);
        });
      })(0);
    }

    var known = fix[bad];
    if (known) { grab(known, finish); return; }

    var sids = spellsByIcon[bad] || [];
    if (!sids.length) { finish(false); return; }   // 没 spellId 就查不了

    // wowhead 的 spell tooltip 要走代理（直连 403，实测）。
    //
    // **必须退避重试**：第一次写这段时没有重试，19 个里只修好 1 个，看起来像
    // 「wowhead 查不到真名」。实测复现出来是第一条 200、之后全是 **502** ——
    // 查得太快被挡了。502 被我当成了「这个名字修不好」，又一次把仪器故障
    // 读成了数据。所以：并发 1、5xx 退避重试、把「查询失败」和「真的没有
    // 真名」分开报。
    (function ask(tries) {
      get('https://nether.wowhead.com/tooltip/spell/' + sids[0] + '?dataEnv=1&locale=0',
        PROXY, function (err, code, body) {
          // 5xx / 网络错误是「问得太快」，不是「没有」。退避再问。
          if ((err || code >= 500) && tries < 4) {
            setTimeout(function () { ask(tries + 1); }, 600 * tries);
            return;
          }
          if (err || code !== 200) { finish(false, '查询失败 HTTP ' + (code || 'err')); return; }
          var real = null;
          try { real = JSON.parse(body.toString('utf8')).icon || null; } catch (e2) { real = null; }
          if (!real) { finish(false, 'wowhead 没给 icon'); return; }
          grab(real, function (good) {
            if (good) { fix[bad] = real; learned++; }
            finish(good, good ? '' : '真名 ' + real + ' 两个源都下不到');
          });
        });
    })(1);
  }, function () {
    progress(failed.length, failed.length, ok + ' 修好');
    if (learned) {
      fs.writeFileSync(FIX_JSON, JSON.stringify({
        v: 1,
        note: 'raidbots 规范化过的图标名 → wowhead 给的真名。键是 raidbots 的坏名字，'
            + '也是 app/talent-icons/ 下的文件名。由 tools/fetch-talent-icons.js 生成。',
        updatedAt: new Date().toISOString().slice(0, 10),
        map: fix
      }, null, 1) + '\n', 'utf8');
      console.log('  新学到 ' + learned + ' 条对应关系，写进 tools/.talent-icon-fix.json');
    }
    if (stillBad.length) {
      console.log('  还是修不好（' + stillBad.length + ' 个）：');
      stillBad.forEach(function (s) { console.log('    · ' + s); });
    }
    cb(stillBad.length);
  });
}

// ---------------------------------------------------------------- 覆盖率

function coverage(names) {
  var have = 0, missing = [], bytes = 0;
  names.forEach(function (n) {
    var f = path.join(ICON_DIR, n + '.jpg');
    if (fs.existsSync(f) && fs.statSync(f).size >= 300) { have++; bytes += fs.statSync(f).size; }
    else missing.push(n);
  });
  return { have: have, total: names.length, missing: missing, bytes: bytes };
}

// -------------------------------------------------------------------- main

function main() {
  var loaded = loadIconNames();
  var names = loaded.icons;
  console.log('天赋图标：' + names.length + ' 个名字（读自 app/talent-tree.js），'
    + Object.keys(loaded.spells).length + ' 个带 spellId');

  if (CHECK_ONLY) {
    var c0 = coverage(names);
    console.log('已有 ' + c0.have + '/' + c0.total + '，缺 ' + c0.missing.length
      + '，占 ' + (c0.bytes / 1024 / 1024).toFixed(2) + ' MB');
    if (c0.missing.length) {
      console.log('  缺的前几个：' + c0.missing.slice(0, 10).join(', '));
    }
    process.exit(c0.missing.length ? 1 : 0);
  }

  console.log('尺寸 ' + SIZE + '　代理 ' + (PROXY || '(不用)') + '　目录 app/talent-icons/');
  download(names, function (failCount, bySource, failedNames) {
    repair(failedNames || [], loaded.spells, function () {
      var c = coverage(names);
      console.log('');
      console.log('覆盖率 ' + c.have + '/' + c.total
        + '（' + (c.have * 100 / c.total).toFixed(1) + '%），'
        + 'app/talent-icons/ 占 ' + (c.bytes / 1024 / 1024).toFixed(2) + ' MB');
      if (LIMIT) {
        console.log('--limit 试跑，覆盖率当然不满。去掉 --limit 重跑。');
        process.exit(0);
      }
      if (c.missing.length) {
        console.log('还缺 ' + c.missing.length + ' 个 —— 天赋树会有节点没图。');
        console.log('缺的前几个：' + c.missing.slice(0, 10).join(', '));
        process.exit(1);
      }
      console.log('全部齐了。');
      process.exit(0);
    });
  });
}

module.exports = { loadIconNames: loadIconNames, coverage: coverage, ICON_DIR: ICON_DIR };
if (require.main === module) main();
