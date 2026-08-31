/*
 * WowAltBoard - tools/fetch-rio.js
 *
 * 从 raider.io 抓**真实**的大秘境榜数据，产出 app/rio-data.js。
 *
 * 为什么要换掉 GearInsight
 * ------------------------
 * 现在面板里的毕业装备来自 GearInsight 插件那份 BisData.lua，它有两个说不清的地方：
 *   ① **一个样本量都没有**。「81% 的人穿这件」背后是 5 个人还是 500 个人，
 *      原始 Lua 里查不到 —— 这个字段根本不存在。
 *   ② **列表是截断的**。每个部位只列 1~7 件，实测 1264 个部位组里使用率之和
 *      中位数只有 72.9%，有 206 组不到 50%。剩下那些人穿的是什么，数据里没有。
 * raider.io 给的是**能数出人头的原始数据**：榜上每个角色是一条记录，
 * 装备是逐件列出来的。样本量因此是算出来的，不是猜的。
 *
 * 两个端点，分工（本机 2026-08 实测，**都不用代理**）
 * ---------------------------------------------------
 *   · 每专精排行榜  GET /api/mythic-plus/rankings/specs?region=world&season=&class=&spec=&page=N
 *     → 200，约 290 KB，**100 人/页**，页与页之间 0 重复（实测 6 页 600 人去重 600）。
 *       98~100% 的人带 `talentLoadoutText`（官方天赋导入串，103 字符）。
 *       翻页没看到上界（p60 照样 200 满 100 人）。**没有任何装备字段。**
 *   · 角色 profile   GET /api/v1/characters/profile?region=&realm=&name=&fields=gear
 *     → 200，**9638 B**（要 `gear,talents` 是 38381 B，4 倍，天赋榜上已经有了，别重复要）。
 *       16 个槽位，每件带 item_id / item_level / icon / item_quality / bonuses / gems / enchants。
 *
 * 三个会咬人的地方，都是实测踩出来的
 * ----------------------------------
 *   ① **`spec` 参数会过滤，但过滤得松。** 请求 priest/discipline 那一页里，
 *      `character.spec.id` 是戒律的只有 39/100，神圣反而 53 —— 因为榜是「用这个专精打出的分」，
 *      而 `character.spec` 是这个角色**当前**的专精。要「他现在穿的装备」就得按
 *      `character.spec.id` 筛，不能拿请求参数当结论。
 *      实测命中率：holy 90、shadow 79、balance 79、**discipline 39**（最低）。
 *   ② **`realm` / `region` 在两个端点里类型不同。** 榜里是**对象**（取 `.slug`），
 *      profile 里是**字符串**。第 12 轮我按对象取，配对键成了 `undefined/undefined/名字`，
 *      统计出 0 份 —— 一次完整的假测量。
 *   ③ **502 / 连接错是「问得太快」，不是「没有数据」。** 本轮修天赋图标名时，
 *      同一个端点第一条 200、后面全 502，我把它读成了「查不到」，19 个里只修好 1 个。
 *      所以这里所有 5xx / status 0 都退避重试，且「请求失败」和「确实没有」分开计数。
 *
 * 还有一件事这个工具**不做**：物品的中文名。
 * raider.io 的 `items[].name` 实测 687/687 全是英文（`Tempered Horns of the Jade Warlord`）。
 * 中文名要另外查（wowhead `locale=4` 实测给「翡翠督军的淬火战角」）。
 * 这里只存 item_id / icon / item_quality / bonuses —— 那三样 raider.io 白送，
 * 正好是 fetch-icons.js 现在要逐个查 wowhead 才拿到的。名字留给后续那一步。
 *
 * 用法
 * ----
 *   node tools\fetch-rio.js                      # 全量（约 67 MB / 4100 次请求）
 *   node tools\fetch-rio.js --specs 256,257      # 只抓这几个专精，试跑用
 *   node tools\fetch-rio.js --target 40          # 每专精目标人数（默认 100）
 *   node tools\fetch-rio.js --maxpages 5         # 每专精最多翻几页（默认 6）
 *   node tools\fetch-rio.js --rank-only          # 只抓榜（拿天赋串和名单），不抓装备
 *   node tools\fetch-rio.js --offline            # 只用缓存，一个请求都不发
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');

var ROOT = path.resolve(__dirname, '..');
var TREE_JS = path.join(ROOT, 'app', 'talent-tree.js');
var CACHE = path.join(__dirname, '.rio-raw');
var OUT = path.join(ROOT, 'app', 'rio-data.js');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

var SEASON = opt('--season', 'season-tww-3');
var TARGET = Number(opt('--target', 100)) || 100;
var MAXPAGES = Number(opt('--maxpages', 6)) || 6;
var ONLY = String(opt('--specs', '')).split(',').filter(Boolean).map(Number);
var RANK_ONLY = flag('--rank-only');
var OFFLINE = flag('--offline');
var CONCURRENCY = 4;

// ------------------------------------------------------------------ 专精名单

/**
 * 40 个专精的 [specId, 职业slug, 专精slug]。
 *
 * slug 是**机械推导**的：`app/talent-tree.js` 里每个专精带 `cls`（"Death Knight"）
 * 和 `specEn`（"Beast Mastery"），小写 + 空格转连字符就是 raider.io 的 slug。
 * 这不是我凭记忆写的表 —— 40 对全部拿那个端点验过（合法 200 / 非法 400，
 * 实测 `spec=all` 会得到「could not find requested class/spec combo」），**40/40 全认**。
 * 所以这里不留静态表：留了就会跟上游脱节，推导 + 站点校验才是可自愈的。
 */
function loadSpecs() {
  if (!fs.existsSync(TREE_JS)) {
    throw new Error('缺 app/talent-tree.js —— 先跑 node tools\\fetch-talent-tree.js');
  }
  var sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', fs.readFileSync(TREE_JS, 'utf8'))(sandbox.window);
  var tree = sandbox.window.AE_TALENT_TREE;
  if (!tree || !tree.specs) throw new Error('app/talent-tree.js 里没有 specs');

  function slug(s) {
    return String(s).toLowerCase().replace(/'/g, '').replace(/\s+/g, '-');
  }
  var out = [];
  Object.keys(tree.specs).forEach(function (sid) {
    var sp = tree.specs[sid];
    if (!sp || !sp.cls || !sp.specEn) return;
    out.push({
      id: Number(sid), cls: sp.cls, specEn: sp.specEn,
      classSlug: slug(sp.cls), specSlug: slug(sp.specEn)
    });
  });
  if (out.length !== 40) {
    // 40 是实测值。变了就该在这里停下来看一眼，而不是默默少抓一批。
    throw new Error('专精数是 ' + out.length + '，不是 40 —— 上游改了？拒绝继续');
  }
  return out;
}

// -------------------------------------------------------------------- 网络

function get(url, cb) {
  var done = false;
  function fin(e, c, b) { if (!done) { done = true; cb(e, c, b); } }
  var u = new URL(url);
  var req = https.request({
    host: u.hostname, port: 443, method: 'GET', path: u.pathname + u.search,
    headers: { 'User-Agent': 'WowAltBoard/1.0', Accept: 'application/json' }
  }, function (res) {
    var cs = [];
    res.on('data', function (c) { cs.push(c); });
    res.on('end', function () { fin(null, res.statusCode, Buffer.concat(cs)); });
  });
  req.on('error', function (e) { fin(e); });
  req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
  req.end();
}

/**
 * 带退避重试的 GET。
 *
 * 只对 **5xx / 网络错误**重试 —— 那是「问得太快」。4xx 是「你问错了」，重试没意义，
 * 直接把状态码交回去让调用方分类报错。这个区分是本轮踩出来的：
 * 把 502 当成「没有数据」会得到一个完全错误的结论，而且看起来像正常结果。
 */
var netStat = { req: 0, retry: 0, fail: 0, bytes: 0, codes: {} };
function getRetry(url, cb) {
  (function attempt(n) {
    netStat.req++;
    get(url, function (e, code, body) {
      netStat.codes[e ? 'ERR' : code] = (netStat.codes[e ? 'ERR' : code] || 0) + 1;
      if ((e || code >= 500) && n < 5) {
        netStat.retry++;
        setTimeout(function () { attempt(n + 1); }, 500 * n);
        return;
      }
      if (e || code !== 200) { netStat.fail++; cb(e || new Error('HTTP ' + code), code, body); return; }
      netStat.bytes += body.length;
      cb(null, code, body);
    });
  })(1);
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
  process.stdout.write('\r  ' + done + '/' + total + ' (' + pct + '%) ' + (note || '') + '      ');
  if (done >= total) process.stdout.write('\n');
}

// ---------------------------------------------------------------- 缓存读写

function cached(name) {
  var f = path.join(CACHE, name);
  if (fs.existsSync(f) && fs.statSync(f).size > 300) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  }
  return null;
}
function store(name, body) {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, name), body);
}

// -------------------------------------------------------------------- 抓榜

function rankFile(sp, page) {
  return 'rank-' + sp.classSlug + '-' + sp.specSlug + '-p' + page + '.json';
}

function rankPage(sp, page, cb) {
  var name = rankFile(sp, page);
  var hit = cached(name);
  if (hit) { cb(null, hit, true); return; }
  if (OFFLINE) { cb(new Error('缓存里没有 ' + name + '，而且是 --offline')); return; }
  var url = 'https://raider.io/api/mythic-plus/rankings/specs?region=world&season='
    + SEASON + '&class=' + sp.classSlug + '&spec=' + sp.specSlug + '&page=' + page;
  getRetry(url, function (e, code, body) {
    if (e) { cb(e); return; }
    store(name, body);
    var j = null;
    try { j = JSON.parse(body.toString('utf8')); } catch (e2) { cb(e2); return; }
    cb(null, j, false);
  });
}

/**
 * 一个专精抓够 TARGET 个人。
 *
 * 按 `character.spec.id === sp.id` 筛，**不是**按请求参数认。见文件头 ①。
 * 翻到 MAXPAGES 还不够就停下，并把实际人数交回去 —— 由调用方显式报出来。
 */
function collectSpec(sp, cb) {
  var roster = [], seen = {}, pages = 0, examined = 0;
  (function nextPage(p) {
    if (p >= MAXPAGES || roster.length >= TARGET) { cb(null, roster, pages, examined); return; }
    rankPage(sp, p, function (e, j) {
      if (e) { cb(e, roster, pages, examined); return; }
      pages++;
      var arr = (j && j.rankings && j.rankings.rankedCharacters) || [];
      arr.forEach(function (r) {
        var c = r && r.character;
        if (!c || !c.spec || c.spec.id !== sp.id) return;
        examined++;
        // 榜里 realm / region 是**对象**。见文件头 ②。
        var realm = c.realm && (c.realm.slug || c.realm.altSlug);
        var region = c.region && c.region.slug;
        if (!realm || !region || !c.name) return;
        var key = region + '/' + realm + '/' + c.name;
        if (seen[key]) return;
        seen[key] = 1;
        if (roster.length >= TARGET) return;
        roster.push({
          name: c.name, realm: realm, altRealm: c.realm.altSlug || null, region: region,
          specId: sp.id, score: r.score || 0,
          loadout: c.talentLoadoutText || null
        });
      });
      nextPage(p + 1);
    });
  })(0);
}

// ----------------------------------------------------------------- 抓装备

function profFile(ch) {
  return 'prof-' + ch.region + '-' + ch.realm + '-'
    + Buffer.from(ch.name, 'utf8').toString('hex') + '.json';
}

function profile(ch, cb) {
  var name = profFile(ch);
  var hit = cached(name);
  if (hit) { cb(null, hit, true); return; }
  if (OFFLINE) { cb(new Error('no-cache')); return; }
  // fields=gear 而不是 gear,talents —— 天赋串榜上已经有了，多要一份是 4 倍流量。
  var url = 'https://raider.io/api/v1/characters/profile?region=' + encodeURIComponent(ch.region)
    + '&realm=' + encodeURIComponent(ch.realm)
    + '&name=' + encodeURIComponent(ch.name) + '&fields=gear';
  getRetry(url, function (e, code, body) {
    if (e) { cb(e, null, false, code); return; }
    store(name, body);
    var j = null;
    try { j = JSON.parse(body.toString('utf8')); } catch (e2) { cb(e2); return; }
    cb(null, j, false);
  });
}

module.exports = {
  loadSpecs: loadSpecs, collectSpec: collectSpec, profile: profile,
  rankPage: rankPage, netStat: netStat, CACHE: CACHE, OUT: OUT
};

// ---------------------------------------------------------------------- main

function main() {
  var specs = loadSpecs();
  if (ONLY.length) {
    specs = specs.filter(function (s) { return ONLY.indexOf(s.id) >= 0; });
    if (!specs.length) throw new Error('--specs 过滤后一个专精都不剩');
  }
  console.log('raider.io 抓取：' + specs.length + ' 个专精，目标 ' + TARGET
    + ' 人/专精，最多翻 ' + MAXPAGES + ' 页　赛季 ' + SEASON
    + (OFFLINE ? '　（--offline，只用缓存）' : ''));

  var t0 = Date.now();
  var rosters = {}, thin = [], pagesUsed = 0;

  // 榜是串行抓的：一页 290 KB，并发意义不大，而且这一步本来就只有几十次请求。
  var i = 0;
  (function step() {
    if (i >= specs.length) { afterRank(); return; }
    var sp = specs[i++];
    collectSpec(sp, function (e, roster, pages) {
      pagesUsed += pages;
      if (e) {
        console.log('  ' + sp.cls + '/' + sp.specEn + ' 抓榜失败：' + e.message);
      } else {
        rosters[sp.id] = roster;
        var withStr = roster.filter(function (r) { return r.loadout; }).length;
        console.log('  ' + pad(sp.cls + '/' + sp.specEn, 26) + ' ' + pages + ' 页 → '
          + roster.length + ' 人，带串 ' + withStr
          + (roster.length < TARGET ? '　← 不足 ' + TARGET : ''));
        if (roster.length < TARGET) thin.push(sp.cls + '/' + sp.specEn + ' ' + roster.length);
      }
      step();
    });
  })();

  function pad(s, n) {
    var w = s;
    while (w.length < n) w += ' ';
    return w;
  }

  function afterRank() {
    var all = [];
    Object.keys(rosters).forEach(function (sid) {
      rosters[sid].forEach(function (r) { all.push(r); });
    });
    console.log('\n榜抓完：' + pagesUsed + ' 页，' + all.length + ' 个角色，'
      + '带天赋串 ' + all.filter(function (r) { return r.loadout; }).length
      + '，流量 ' + (netStat.bytes / 1024 / 1024).toFixed(2) + ' MB，'
      + (((Date.now() - t0) / 1000) | 0) + ' 秒');
    if (thin.length) {
      console.log('样本不足 ' + TARGET + ' 的专精（' + thin.length + ' 个）：' + thin.join('，'));
    }
    if (RANK_ONLY) {
      console.log('--rank-only，装备不抓。');
      report(all, {});
      return;
    }

    console.log('\n抓装备：' + all.length + ' 个角色，fields=gear（实测 9638 B/人），并发 '
      + CONCURRENCY);
    var gears = {}, okN = 0, failN = 0, hitN = 0, realmFallback = 0;
    var done = 0;
    pool(all, CONCURRENCY, function (ch, next) {
      profile(ch, function (e, j, wasCached) {
        if (!e && j) {
          if (wasCached) hitN++;
          okN++;
          gears[ch.region + '/' + ch.realm + '/' + ch.name] = j;
        } else if (!OFFLINE && ch.altRealm && ch.altRealm !== ch.realm) {
          // realm slug 有 slug / altSlug 两个。哪个能用由站点说，不由我猜。
          var alt = { name: ch.name, realm: ch.altRealm, region: ch.region };
          profile(alt, function (e2, j2) {
            if (!e2 && j2) {
              realmFallback++; okN++;
              gears[ch.region + '/' + ch.realm + '/' + ch.name] = j2;
            } else failN++;
            done++; progress(done, all.length, 'ok ' + okN + '，失败 ' + failN);
            next();
          });
          return;
        } else failN++;
        done++; progress(done, all.length, 'ok ' + okN + '，失败 ' + failN);
        next();
      });
    }, function () {
      progress(all.length, all.length, 'ok ' + okN + '，失败 ' + failN);
      console.log('  命中缓存 ' + hitN + '，新下 ' + (okN - hitN)
        + '，altSlug 救回 ' + realmFallback + '，失败 ' + failN);
      report(all, gears);
    });
  }

  function report(all, gears) {
    console.log('\n网络统计：请求 ' + netStat.req + '，重试 ' + netStat.retry
      + '，失败 ' + netStat.fail + '，流量 ' + (netStat.bytes / 1024 / 1024).toFixed(2) + ' MB');
    console.log('  状态码分布 ' + JSON.stringify(netStat.codes));
    console.log('  用时 ' + (((Date.now() - t0) / 1000) | 0) + ' 秒');
    var nGear = Object.keys(gears).length;
    console.log('角色 ' + all.length + '，拿到装备 ' + nGear);
    console.log('\n下一步（还没写）：把这些聚合成 app/rio-data.js。');
  }
}

if (require.main === module) main();
