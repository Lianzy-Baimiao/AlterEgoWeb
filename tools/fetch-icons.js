/*
 * WowAltBoard - tools/fetch-icons.js
 *
 * 把 app/bis-data.js 里用到的每个 itemId 解析成「图标名 + 品质」，再把图标图片
 * 下载到 app/icons/ 下，让看板离线也能出图。
 *
 * 为什么需要这一步
 * ----------------
 * GearInsight 的 BisData 里 2187 件装备**只有 itemId**，没有图标、没有品质
 * （我在本机全量数过：icon 0 次、quality 0 次、iconFileID 0 次）。游戏内的插件
 * 靠现场调 C_Item 接口取图标，网页没有这些接口，所以必须在打包前把这层查出来。
 *
 * 为什么不直接用游戏目录里的散装图标
 * ----------------------------------
 * 本机 Interface/Icons 下确实有 22786 个 .blp（全部 64×64 DXT5，可以用
 * tools/blp.js 解成 PNG），但那是 2024-08 的旧提取：`inv_10* / inv_11* / inv_12*`
 * 一个都没有，当前赛季的装备图标全不在里面。所以它只能当补充，不能当来源。
 *
 * 两个网络来源，实测结论（这台机器，中国大陆）
 * --------------------------------------------
 *   · nether.wowhead.com/tooltip/item/<id>   直连 403，走代理 200。给 icon + quality。
 *   · render.worldofwarcraft.com/us/icons/56 直连就 200，不需要代理。只收图标名。
 *
 * 所以：图标**名字**从 wowhead 查（要代理），图标**图片**从暴雪 CDN 下（不要代理）。
 * 两边都是公开只读数据，不上传任何本机内容。
 *
 * 断点续传
 * --------
 * 查询结果写在 tools/.icon-cache.json，中断后重跑只补没查到的。删掉它才会全量重查。
 *
 * 用法
 * ----
 *   node tools\fetch-icons.js                    # 查名字 + 下图片
 *   node tools\fetch-icons.js --names-only       # 只查名字
 *   node tools\fetch-icons.js --images-only      # 只下图片（用已有缓存）
 *   node tools\fetch-icons.js --proxy http://127.0.0.1:7897
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');

var ROOT = path.resolve(__dirname, '..');
var CACHE = path.join(__dirname, '.icon-cache.json');
var OUT_JS = path.join(ROOT, 'app', 'item-icons.js');
var ICON_DIR = path.join(ROOT, 'app', 'icons');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

var PROXY = opt('--proxy', 'http://127.0.0.1:7897');
var NAMES_ONLY = flag('--names-only');
var IMAGES_ONLY = flag('--images-only');
var CONCURRENCY = 4;
var ICON_SIZE = 56;   // 实测暴雪 CDN 只开放 18 / 56，64 返回 403

// ---------------------------------------------------------------- 收集 itemId

function collectIds() {
  var g = { AE: {} };
  g.window = g;
  var src = fs.readFileSync(path.join(ROOT, 'app', 'bis-data.js'), 'utf8');
  new Function('global', 'window', src).call(g, g, g);
  var B = g.AE_BIS;
  if (!B) throw new Error('app/bis-data.js 没有赋值 AE_BIS，先跑 node tools\\gen-bis.js');

  var ids = Object.create(null);
  var kinds = Object.create(null);

  function add(id, kind) {
    if (!id) return;
    id = String(id);
    ids[id] = 1;
    kinds[id] = kinds[id] || kind;
  }

  Object.keys(B.items).forEach(function (id) { add(id, 'gear'); });
  Object.keys(B.specs).forEach(function (key) {
    var s = B.specs[key];
    (s.gems || []).forEach(function (row) { add(row[0], 'gem'); });
    Object.keys(s.ench || {}).forEach(function (slot) {
      (s.ench[slot] || []).forEach(function (row) { add(row[3], 'enchant'); });
    });
  });
  // 键叫 id，不是 itemId（gen-bis.js 里压缩过字段名）。第一版写成 c.itemId，
  // 结果 35 个消耗品全被静默漏掉，而覆盖率还报 100% —— 漏掉的东西不在分母里。
  (B.consumables || []).forEach(function (c) { add(c.id, 'consumable'); });

  // BisData 自己带的图标名（只有消耗品有）。这个比 wowhead 查来的**更权威** ——
  // 它是插件从游戏客户端读出来的，而 wowhead 会给出带后缀的变体名
  // （实测 241324 → `..._white-`、241326 → `..._red--`，都是 zamimg 上真实存在
  // 的另一张图，不是坏数据，但不是客户端在用的那张）。所以有它就用它。
  var ownIcon = Object.create(null);
  (B.consumables || []).forEach(function (c) {
    if (c.id && c.icon) ownIcon[String(c.id)] = c.icon;
  });

  // raider.io 那份产物（app/rio-data.js）里每件装备**自带图标名**，所以这批
  // 不需要去 wowhead 查名字，只需要下图。实测 2432 件里 1042 个图标名在
  // app/icons/ 下没有文件 —— 面板换到「实战分布」视角后，那 1042 行全是占位块。
  //
  // 为什么不把它们塞进 ids：ids 是「要去 wowhead 查图标名的 itemId」，而这批
  // 名字已经是现成的。混进去等于白跑 2432 次网络请求，而且 wowhead 给的变体名
  // （实测 `..._white-`）还会盖掉 raider.io 从游戏客户端拿到的那个正确名字。
  var rioNames = Object.create(null);
  var rioFile = path.join(ROOT, 'app', 'rio-data.js');
  if (fs.existsSync(rioFile)) {
    var rg = { AE: {} };
    rg.window = rg;
    new Function('global', 'window', fs.readFileSync(rioFile, 'utf8')).call(rg, rg, rg);
    var R = rg.AE_RIO;
    if (!R || !R.items) throw new Error('app/rio-data.js 没有赋值 AE_RIO 或缺 items');
    Object.keys(R.items).forEach(function (id) {
      var nm = R.items[id] && R.items[id].i;
      if (nm) rioNames[nm] = 1;
    });
  }

  // maxroll 那份产物（app/maxroll-data.js）里有一批**只在 maxroll 出现**的物品
  // （实测 357 件里 36 件不在 rio 池里，多是附魔和可刷替代件）。它们的中文名已经
  // 由生成器从 DB2 补上了，但**图标名 DB2 里没有** —— 所以这批要走 wowhead
  // 查图标名，跟 BisData 那批同一条路，进 ids。
  //
  // 不这么做的后果是实测过的：面板「最佳推荐」视角里出现占位块（渲染检查报
  // 「出现 3 个占位块」）。
  var mrFile = path.join(ROOT, 'app', 'maxroll-data.js');
  var mrNeed = 0;
  if (fs.existsSync(mrFile)) {
    var mg = { AE: {} };
    mg.window = mg;
    new Function('global', 'window', fs.readFileSync(mrFile, 'utf8')).call(mg, mg, mg);
    var MR = mg.AE_MAXROLL;
    if (!MR || !MR.items) throw new Error('app/maxroll-data.js 没有赋值 AE_MAXROLL 或缺 items');
    Object.keys(MR.items).forEach(function (id) {
      var it = MR.items[id];
      if (it && it.i) { rioNames[it.i] = 1; return; }   // 自带图标名的直接下图
      ids[id] = 1;                                       // 没有图标名的去 wowhead 查
      mrNeed++;
    });
  }

  var extra = Object.create(null);
  Object.keys(ownIcon).forEach(function (id) { extra[ownIcon[id]] = 1; });
  Object.keys(rioNames).forEach(function (n) { extra[n] = 1; });

  return {
    ids: Object.keys(ids), kinds: kinds, bis: B,
    ownIcon: ownIcon,
    rioNames: Object.keys(rioNames),
    extraNames: Object.keys(extra),
    mrNeed: mrNeed
  };
}

// ------------------------------------------------------------------ HTTP 小工具

/**
 * 走 CONNECT 隧道的 https GET。Node 自带的 https 不认 http_proxy，所以自己建隧道。
 * proxy 为空时直连。
 */
function get(url, proxy, cb) {
  var u = new URL(url);
  if (!proxy) {
    var req = https.get({
      host: u.hostname, path: u.pathname + u.search, port: 443,
      headers: { 'user-agent': 'WowAltBoard-icon-fetch', 'accept': '*/*' },
      timeout: 20000
    }, collect(cb));
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { cb(e); });
    return;
  }

  var p = new URL(proxy);
  var creq = http.request({
    host: p.hostname, port: p.port || 80, method: 'CONNECT',
    path: u.hostname + ':443', timeout: 20000
  });
  creq.on('connect', function (res, socket) {
    if (res.statusCode !== 200) { cb(new Error('CONNECT ' + res.statusCode)); return; }
    var req2 = https.get({
      socket: socket, agent: false, servername: u.hostname,
      host: u.hostname, path: u.pathname + u.search,
      headers: { 'user-agent': 'WowAltBoard-icon-fetch', 'accept': '*/*' },
      timeout: 20000
    }, collect(cb));
    req2.on('timeout', function () { req2.destroy(new Error('timeout')); });
    req2.on('error', function (e) { cb(e); });
  });
  creq.on('timeout', function () { creq.destroy(new Error('proxy timeout')); });
  creq.on('error', function (e) { cb(e); });
  creq.end();
}

function collect(cb) {
  return function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(chunks)); });
    res.on('error', function (e) { cb(e); });
  };
}

/** 有限并发地跑一批任务，每个任务是 fn(item, done)。 */
function pool(items, n, fn, done) {
  var i = 0, active = 0, finished = 0;
  if (!items.length) { done(); return; }
  function next() {
    while (active < n && i < items.length) {
      var it = items[i++];
      active++;
      fn(it, function () {
        active--; finished++;
        if (finished === items.length) { done(); return; }
        next();
      });
    }
  }
  next();
}

var lastLine = 0;
function progress(done, total, extra) {
  var now = Date.now();
  if (now - lastLine < 400 && done < total) return;
  lastLine = now;
  var pct = Math.round(done / total * 100);
  process.stdout.write('\r  ' + done + '/' + total + ' (' + pct + '%) ' + (extra || '') + '   ');
  if (done >= total) process.stdout.write('\n');
}

// ------------------------------------------------------------- 第一步：查名字

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return {}; }
}

function fetchNames(ids, cache, cb) {
  var need = ids.filter(function (id) { return !cache[id] || !cache[id].icon; });
  console.log('查图标名：共 ' + ids.length + ' 个，缓存里已有 ' + (ids.length - need.length) +
              '，需要查 ' + need.length);
  if (!need.length) { cb(0); return; }

  var done = 0, failed = [];
  pool(need, CONCURRENCY, function (id, next) {
    var url = 'https://nether.wowhead.com/tooltip/item/' + id + '?dataEnv=1&locale=0';
    var tries = 0;
    (function attempt() {
      tries++;
      get(url, PROXY, function (err, code, body) {
        if (!err && code === 200) {
          try {
            var j = JSON.parse(body.toString('utf8'));
            if (j && j.icon) {
              cache[id] = { icon: j.icon, quality: j.quality, en: j.name || '' };
              done++; progress(done, need.length, 'ok');
              next(); return;
            }
          } catch (e) { /* 落到下面的重试 */ }
        }
        if (tries < 3) { setTimeout(attempt, 600 * tries); return; }
        failed.push(id);
        done++; progress(done, need.length, '失败 ' + failed.length);
        next();
      });
    })();
  }, function () {
    progress(need.length, need.length, failed.length ? '失败 ' + failed.length : '全部拿到');
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0), 'utf8');
    if (failed.length) {
      console.log('  查不到的 itemId（' + failed.length + ' 个）：' +
                  failed.slice(0, 20).join(', ') + (failed.length > 20 ? ' …' : ''));
    }
    cb(failed.length);
  });
}

// ------------------------------------------------------------- 第二步：下图片

function fetchImages(cache, extraNames, cb) {
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

  var names = Object.create(null);
  Object.keys(cache).forEach(function (id) {
    if (cache[id] && cache[id].icon) names[cache[id].icon] = 1;
  });
  // BisData 自带的那批图标名也要下。面板查不到 itemId 时会退回用它们，
  // 那条退路必须真的有文件，否则「有退路」只是句话。
  (extraNames || []).forEach(function (n) { if (n) names[n] = 1; });
  var list = Object.keys(names).filter(function (n) {
    var f = path.join(ICON_DIR, n + '.jpg');
    return !fs.existsSync(f) || fs.statSync(f).size < 300;
  });
  console.log('下图标：共 ' + Object.keys(names).length + ' 个不同图标，需要下 ' + list.length);
  if (!list.length) { cb(0); return; }

  // 图片源按顺序试。为什么需要两个源（本机 2026-08 实测）：
  //   · 暴雪 CDN 有绝大多数图标，直连可达，不用代理；
  //   · 但**当前赛季**的新图标它还没上（烈毒之渊那批 *_ulatek_d_01 全 403，
  //     us / eu / tw / cn 四个区都一样），这 158 个只有 zamimg 有。
  //   · zamimg 直连 403，必须走代理。
  var SOURCES = [
    { name: '暴雪CDN', proxy: '',
      url: function (n) {
        return 'https://render.worldofwarcraft.com/us/icons/' + ICON_SIZE + '/' + n + '.jpg';
      } },
    { name: 'zamimg', proxy: PROXY,
      url: function (n) {
        // large = 56×56，和暴雪 CDN 的 56 一致。medium 只有 36×36，混用会一大一小。
        return 'https://wow.zamimg.com/images/wow/icons/large/' + n + '.jpg';
      } }
  ];

  var done = 0, failed = [], bySource = {};
  pool(list, CONCURRENCY, function (name, next) {
    // 每个源最多重试 2 次，失败就换下一个源。
    (function trySource(si) {
      if (si >= SOURCES.length) {
        failed.push(name);
        done++; progress(done, list.length, '失败 ' + failed.length);
        next(); return;
      }
      var src = SOURCES[si];
      var tries = 0;
      (function attempt() {
        tries++;
        get(src.url(name), src.proxy, function (err, code, body) {
          if (!err && code === 200 && body.length > 300) {
            fs.writeFileSync(path.join(ICON_DIR, name + '.jpg'), body);
            bySource[src.name] = (bySource[src.name] || 0) + 1;
            done++; progress(done, list.length, 'ok');
            next(); return;
          }
          // 404 / 403 是「这个源没有」，重试没意义，直接换源。
          if (code === 403 || code === 404) { trySource(si + 1); return; }
          if (tries < 2) { setTimeout(attempt, 400 * tries); return; }
          trySource(si + 1);
        });
      })();
    })(0);
  }, function () {
    progress(list.length, list.length, failed.length ? '失败 ' + failed.length : '全部下好');
    Object.keys(bySource).forEach(function (k) {
      console.log('  来自 ' + k + '：' + bySource[k] + ' 个');
    });
    if (failed.length) {
      console.log('  下不到的图标（' + failed.length + ' 个）：' +
                  failed.slice(0, 20).join(', ') + (failed.length > 20 ? ' …' : ''));
    }
    cb(failed.length);
  });
}

// -------------------------------------------------------------- 第三步：出文件

function writeJs(info, cache) {
  // --limit 是给试跑用的，只查了一部分 id。这时候写出去会得到一份缺了大半的
  // item-icons.js，而它看起来是「正常的一份」—— 下次谁也分不清。所以直接不写。
  if (LIMIT) {
    console.log('');
    console.log('--limit 试跑，不写 app/item-icons.js（缓存已更新，去掉 --limit 重跑即可）');
    return { missing: 0, noImage: 0 };
  }
  var ids = info.ids;
  var icons = {}, quals = {};
  var missing = [];
  var preferOwn = 0;
  ids.forEach(function (id) {
    var c = cache[id];
    // BisData 自带的图标名优先。它是插件作者从游戏客户端抄的，wowhead 那边同一件
    // 东西可能给出一个后缀带 `-` 的变体名（实测 241324 给 `..._white-`、241326 给
    // `..._red--`，两张图 zamimg 上都真实存在、md5 不同，都是合法的合剂图标）。
    // 既然客户端那份更权威，就用它 —— 顺带让「图标名只含小写字母数字下划线」这条
    // 断言保持严格，那条断言拦的是路径注入，不该为了迁就变体名而放宽。
    var own = info.ownIcon[id];
    if (own) {
      icons[id] = own;
      if (c && c.quality != null) quals[id] = c.quality;
      preferOwn++;
      return;
    }
    if (!c || !c.icon) { missing.push(id); return; }
    icons[id] = c.icon;
    if (c.quality != null) quals[id] = c.quality;
  });

  var haveImage = 0, noImage = [];
  Object.keys(icons).forEach(function (id) {
    var f = path.join(ICON_DIR, icons[id] + '.jpg');
    if (fs.existsSync(f) && fs.statSync(f).size > 300) haveImage++;
    else if (noImage.indexOf(icons[id]) < 0) noImage.push(icons[id]);
  });

  var head = [
    '/*',
    ' * app/item-icons.js —— 自动生成，不要手改。',
    ' *',
    ' * 生成命令：node tools\\fetch-icons.js',
    ' *',
    ' * itemId -> 图标名，以及 itemId -> 品质。两者都不在 GearInsight 的 BisData 里，',
    ' * 是按 itemId 从 wowhead 的 tooltip 接口查出来的；图标图片在 app/icons/ 下，',
    ' * 来自暴雪自己的 CDN（render.worldofwarcraft.com，本机实测直连可达）。',
    ' *',
    ' * 覆盖情况（生成时实测）：',
    ' *   需要图标的 itemId  ' + ids.length,
    ' *   查到图标名的        ' + Object.keys(icons).length,
    ' *   用 BisData 自带名的 ' + preferOwn + '（消耗品，客户端那份比 wowhead 权威）',
    ' *   本地有图片的        ' + haveImage,
    ' *   查不到名字的        ' + missing.length + (missing.length ? '（' + missing.slice(0, 10).join(',') + '）' : ''),
    ' */'
  ].join('\n');

  var body = 'window.AE_ITEM_ICONS = ' + JSON.stringify(icons) + ';\n' +
             'window.AE_ITEM_QUALITY = ' + JSON.stringify(quals) + ';\n';

  fs.writeFileSync(OUT_JS, head + '\n' + body, 'utf8');

  console.log('');
  console.log('写出 app/item-icons.js');
  console.log('  itemId 总数      ' + ids.length);
  console.log('  查到图标名       ' + Object.keys(icons).length);
  console.log('  用自带图标名     ' + preferOwn);
  console.log('  本地有图片       ' + haveImage);
  console.log('  查不到名字       ' + missing.length);
  if (noImage.length) console.log('  有名字但缺图片   ' + noImage.length + '：' + noImage.slice(0, 10).join(', '));

  var bytes = 0, n = 0;
  if (fs.existsSync(ICON_DIR)) {
    fs.readdirSync(ICON_DIR).forEach(function (f) {
      if (/\.jpg$/i.test(f)) { bytes += fs.statSync(path.join(ICON_DIR, f)).size; n++; }
    });
  }
  console.log('  app/icons/       ' + n + ' 个文件，' + (bytes / 1024).toFixed(1) + ' KB');
  console.log('  item-icons.js    ' + (fs.statSync(OUT_JS).size / 1024).toFixed(1) + ' KB');

  return { missing: missing.length, noImage: noImage.length };
}

// ------------------------------------------------------------------------ main

var info = collectIds();
var cache = loadCache();

// --limit N：只处理前 N 个 id。用来先小跑一遍确认流程，不要用它出正式产物。
var LIMIT = parseInt(opt('--limit', ''), 10);
if (LIMIT > 0) {
  info.ids = info.ids.slice(0, LIMIT);
  console.log('!! --limit ' + LIMIT + '：这次只处理前 ' + LIMIT + ' 个 id，产物不完整');
}

console.log('代理 ' + (PROXY || '(不用)') + '　图标尺寸 ' + ICON_SIZE);
console.log('itemId ' + info.ids.length + '　额外图标名 ' + info.extraNames.length
  + '（其中 raider.io ' + info.rioNames.length + ' 个）');
console.log('');

function step2() {
  if (NAMES_ONLY) { writeJs(info, cache); return; }
  fetchImages(cache, info.extraNames, function () {
    var r = writeJs(info, cache);
    if (r.missing > info.ids.length * 0.05) {
      console.log('');
      console.log('!! 有超过 5% 的 itemId 查不到图标名，先别提交，重跑一次补齐。');
      process.exit(1);
    }
  });
}

if (IMAGES_ONLY) step2();
else fetchNames(info.ids, cache, step2);
