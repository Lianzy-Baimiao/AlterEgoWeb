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
 * 物品中文名从**暴雪自己的 DB2** 批量拿，不逐个查
 * ------------------------------------------------
 * raider.io 的 `items[].name` 实测 687/687 全是英文（`Tempered Horns of the Jade Warlord`）。
 * BisData 给的是中文名，直接换过去等于把面板退回英文 —— 那是功能退化。
 * 第一版打算逐个查 wowhead `locale=4`（实测能给「翡翠督军的淬火战角」），
 * 但本机 46 份 profile 里就有 402 个不同 item_id，4000 份会到几千个，
 * 逐个查要二十多分钟还会撞限速。
 * 改用 G1 那条路：`https://wago.tools/db2/ItemSparse/csv?locale=zhCN`
 * —— **一次请求 48 MB / 175164 行**，`ID` + `Display_lang` 两列就是 id → 中文名，
 * 对本机 402 个 id **命中 402（100%）**。直连可达，不用代理。
 *
 * 槽位名这里**一个中文字都不存**。rio 用英文槽位名（head/finger1/…），
 * 面板用暴雪槽位编号（1/11/…）。映射是**从数据里推出来的**：
 * 拿两边都出现的 206 件物品投票，12 个唯一槽位 100% 一致；
 * 戒指 / 饰品 / 主副手三对本来就可互换，按物品分不开，按 rio 的序号定。
 *
 * 用法
 * ----
 *   node tools\fetch-rio.js                      # 全量（约 67 MB / 4100 次请求）
 *   node tools\fetch-rio.js --specs 256,257      # 只抓这几个专精，试跑用
 *   node tools\fetch-rio.js --target 40          # 每专精目标人数（默认 100）
 *   node tools\fetch-rio.js --maxpages 5         # 每专精最多翻几页（默认 6）
 *   node tools\fetch-rio.js --rank-only          # 只抓榜（拿天赋串和名单），不抓装备
 *   node tools\fetch-rio.js --offline            # 只用缓存，一个请求都不发
 *   node tools\fetch-rio.js --keep-names         # 复用已下好的 ItemSparse.csv（默认就复用）
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');

// 「一套天赋」按**解出来的内容**算，不按字节（第 20 轮）。和 fetch-wcl.js 共用
// 同一份实现 —— 面板把两家并排放在一个开关下面，定义必须一样。
// 实测归并几乎不生效（天赋人人不同），那个文件开头有数字和一次误判的记录。
var GROUP = require('./group-loadouts.js');
var DECODE = require('./decode-talent-string.js');
var DEC_ORDER = null;
function decodeOne(str) {
  if (!DEC_ORDER) DEC_ORDER = DECODE.loadOrder();
  return DECODE.decode(str, DEC_ORDER);
}

var ROOT = path.resolve(__dirname, '..');
var TREE_JS = path.join(ROOT, 'app', 'talent-tree.js');
var CACHE = path.join(__dirname, '.rio-raw');
var OUT = path.join(ROOT, 'app', 'rio-data.js');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

/*
 * 赛季。**这个默认值必须是当前赛季**，而且改了之后要能真的重抓 —— 见下面
 * rankFile() 和 checkSeason() 两处，它们合起来是一次真实事故的补丁：
 * 产物一直停在 season-tww-3（上一个资料片 The War Within 第三赛季），
 * 而当时早就是 season-mn-2（Midnight 第二赛季）了。两个赛季都返回 200，
 * 所以什么都没报错，面板上那一整页实战分布是上个资料片的数据。
 */
var SEASON = opt('--season', 'season-mn-2');
// 装备的样本量。每个角色要一次 profile 请求，所以这个数直接决定跑多久。
var TARGET = Number(opt('--target', 100)) || 100;
/*
 * 天赋串的样本量，**和装备分开**。
 *
 * 天赋串在榜页里就有（`character.talentLoadoutText`），一页 100 人白送 100 条；
 * 装备得逐个角色查 profile，一人一次请求还带配额。第 20 轮用户说天赋串
 * 「数量太少了，扩充一下基础数量」—— 那就只扩这一边：榜多翻几页，
 * 装备仍然只取前 TARGET 个人。
 */
var TALENT_TARGET = Number(opt('--talent-target', 500)) || 500;
var MAXPAGES = Number(opt('--maxpages', 15)) || 15;
var ONLY = String(opt('--specs', '')).split(',').filter(Boolean).map(Number);
var RANK_ONLY = flag('--rank-only');
var OFFLINE = flag('--offline');

/*
 * 限速参数。**默认值是撞出来的，不是猜的。**
 *
 * 第一次全量跑（并发 4、无间隔）实测：
 *   请求 5862，200 只有 303，**429 有 5558**，用时 474 秒，最后只拿到 361/3994 份装备。
 * 前 300 份是顺的，之后几乎全被 429 挡掉 —— 说明 raider.io 对 profile 端点有配额，
 * 不是「偶发拥塞」。所以对策不是重试得更凶，而是**慢下来**：
 *   · 并发降到 1（--conc 可调）
 *   · 每个请求之间至少隔 BASE_GAP 毫秒（--gap 可调）
 *   · 碰到 429 就等 RATE_WAIT，并且**不算作失败**，重试次数给足
 *
 * 榜单端点不受影响（98 页全 200），所以只有 profile 段需要这套。
 */
var CONCURRENCY = Number(opt('--conc', 1)) || 1;
var BASE_GAP = Number(opt('--gap', 1100));
var RATE_WAIT = Number(opt('--ratewait', 65000));
var RETRIES = Number(opt('--retries', 8)) || 8;

// DB2 中文名表的路径 / URL 在下面 downloadItemCsv 那一段声明（DB2_DIR / ITEM_CSV /
// ITEM_CSV_URL）。这里原本还有一份一模一样的声明，值相同所以一直没报错，
// 但顶层重复 var 是真缺陷 —— 已删。

/**
 * rio 的英文槽位名 → 暴雪槽位编号。
 *
 * **不是我凭记忆写的**：拿 BisData 里有槽位归属的 498 件和本机 profile 里的 402 件
 * 求交（206 件），按「同一件物品在两边分别落在哪」投票推出来的。
 * 12 个唯一槽位得票 100% 一致（back→15、chest→5、feet→8、hands→10、head→1、
 * legs→7、neck→2、shoulder→3、waist→6、wrist→9，外加 mainhand→16 80%、offhand→17 82%）。
 * 剩下三对 —— 戒指 11/12、饰品 13/14、主副手 16/17 —— 投票只到 50% 上下，
 * 因为**同一枚戒指两个槽都能戴**，按物品根本分不开。这三对按 rio 自己的序号定，
 * finger1→11 / finger2→12 / trinket1→13 / trinket2→14，与 BisData 的编号含义一致。
 * `shirt` 故意不映射：BisData 没有这个槽，衬衣也不影响强度。
 */
var SLOT_MAP = {
  head: 1, neck: 2, shoulder: 3, chest: 5, waist: 6, legs: 7, feet: 8,
  wrist: 9, hands: 10, finger1: 11, finger2: 12, trinket1: 13, trinket2: 14,
  back: 15, mainhand: 16, offhand: 17
};

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
 * 重试的判据是「这次失败是不是我问得太快」：
 *   · **5xx / 网络错误** —— 是。
 *   · **429 Too Many Requests** —— 是，而且是站点**明说**的。
 *   · 其他 4xx —— 不是，是「你问错了」，重试没意义，把状态码交回去让调用方分类报错。
 *
 * 这个区分是踩出来的：把 502 当成「没有数据」会得到一个完全错误的结论，
 * 而且看起来像正常结果。**429 这一条是第二次踩**：抓 3994 份 profile 时
 * 前 300 个 200，之后 5558 次 429，而当时的重试只认 5xx，于是 429 被当成
 * 「这个角色没有装备」直接丢掉 —— 19 个专精拿到 0 份装备，产物照样生成。
 *
 * 429 的退避比 5xx 狠得多（RATE_WAIT 起步、逐次加倍），因为限速是有窗口的，
 * 500ms 级的退避只会继续撞墙。同时**全局降速**：一旦吃到 429，
 * 就把所有后续请求的间隔调大（见 throttle），而不是只让这一个请求慢下来。
 */
var netStat = { req: 0, retry: 0, fail: 0, bytes: 0, codes: {}, rate: 0 };

// 全局节流：gap 是每个请求之间的最小间隔（毫秒）。吃到 429 就往上抬，
// 抬上去之后不再自动降回来 —— 这一轮已经证明「试探性加速」的代价是几千次 429。
var throttle = { gap: BASE_GAP, last: 0 };
function schedule(fn) {
  var now = Date.now();
  var wait = Math.max(0, throttle.last + throttle.gap - now);
  throttle.last = now + wait;
  if (wait) setTimeout(fn, wait); else fn();
}

function getRetry(url, cb) {
  (function attempt(n) {
    schedule(function () {
      netStat.req++;
      get(url, function (e, code, body) {
        netStat.codes[e ? 'ERR' : code] = (netStat.codes[e ? 'ERR' : code] || 0) + 1;
        var tooFast = e || code === 429 || code >= 500;
        if (code === 429) {
          netStat.rate++;
          // 站点明说慢一点，那就真的慢下来 —— 全局间隔加倍，上限 2 秒。
          throttle.gap = Math.min(2000, Math.max(throttle.gap * 2, 200));
        }
        if (tooFast && n < RETRIES) {
          netStat.retry++;
          var wait = code === 429 ? RATE_WAIT * Math.pow(2, n - 1) : 500 * n;
          setTimeout(function () { attempt(n + 1); }, wait);
          return;
        }
        if (e || code !== 200) {
          netStat.fail++;
          cb(e || new Error('HTTP ' + code), code, body);
          return;
        }
        netStat.bytes += body.length;
        cb(null, code, body);
      });
    });
  })(1);
}

/**
 * 并发池。
 *
 * **这里有一个只在「缓存全命中」时才会炸的坑，实测踩到过。**
 * `worker` 平时是异步回调（发请求），但缓存命中时它**同步**就回调了。
 * 同步回调里再调 `next()`，`next()` 又同步启动下一个 —— 栈就一层层往下压，
 * 深度跟条目数同阶。实测 `--offline` 跑 3994 个角色，到第 1539 个
 * `Maximum call stack size exceeded`。也就是说：**缓存越全越容易崩**，
 * 而「全用缓存」正是这套缓存存在的理由（断点续抓、离线重新产出）。
 *
 * 修法不是加大栈，而是**不让嵌套的 next() 递归**：嵌套进来只置一个标记就返回，
 * 由最外层那个 while 继续推进，栈深恒定。
 */
function pool(items, n, worker, done) {
  var i = 0, active = 0, finished = 0, inLoop = false, again = false;
  function next() {
    if (inLoop) { again = true; return; }
    inLoop = true;
    do {
      again = false;
      while (active < n && i < items.length) {
        var it = items[i++];
        active++;
        worker(it, function () {
          active--; finished++;
          if (finished === items.length) { done(); return; }
          next();
        });
      }
    } while (again);
    inLoop = false;
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

/*
 * 榜页的缓存文件名。**必须带赛季**。
 *
 * 第一版是 `rank-mage-arcane-p0.json`，不带赛季 —— 于是把 SEASON 从
 * season-tww-3 改成 season-mn-2 之后，一个请求都不会发：缓存全命中，
 * 拿到的还是上个资料片的榜，而日志会告诉你「已抓完」。
 * 那正是这个仓库反复踩的形状：**没跑，但报成跑过了。**
 * 赛季进文件名之后，换赛季自动等于换一套缓存。
 */
function rankFile(sp, page) {
  return 'rank-' + SEASON + '-' + sp.classSlug + '-' + sp.specSlug + '-p' + page + '.json';
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
    // 抓到**天赋**的目标深度才停（装备只用前 TARGET 个，见下面的 gear 标记）。
    if (p >= MAXPAGES || roster.length >= TALENT_TARGET) {
      cb(null, roster, pages, examined); return;
    }
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
        if (roster.length >= TALENT_TARGET) return;
        // gear = 「这个人要不要去查装备」。榜是按分数降序的，所以前 TARGET 个
        // 就是这个专精分数最高的那批 —— 装备统计取他们，天赋串取全部。
        roster.push({
          name: c.name, realm: realm, altRealm: c.realm.altSlug || null, region: region,
          specId: sp.id, score: r.score || 0, gear: roster.length < TARGET,
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

// --------------------------------------------------------- 中文物品名（DB2）

/*
 * raider.io 的 `items[].name` 实测 687/687 全英文，所以中文名得另外来一份。
 *
 * 走的是 G1 那条已经验证过的路：**暴雪自己的 DB2**，
 * `https://wago.tools/db2/ItemSparse/csv?locale=zhCN`（直连，不用代理）。
 * 实测 48.03 MB / 175164 行，`ID` 在第 0 列、`Display_lang` 在第 5 列，
 * 对本机 402 个不同 item_id **命中 402（100%）**。
 *
 * 为什么不逐个查 wowhead：4000 份 profile 会有几千个不同 id，
 * 而那个端点在并发 2 下就开始 502（本轮实测），一个个问要 20 分钟以上还不稳。
 * DB2 是一次 15 秒拿全表。
 *
 * 为什么 48 MB 不提交、也不做中间产物：**中文名会内联进 app/rio-data.js**，
 * 产物自带名字，所以这个 CSV 是纯下载缓存（放在已 gitignore 的 tools/.db2-names/）。
 */
var DB2_DIR = path.join(__dirname, '.db2-names');
var ITEM_CSV = path.join(DB2_DIR, 'ItemSparse.csv');
var ITEM_CSV_URL = 'https://wago.tools/db2/ItemSparse/csv?locale=zhCN';

function downloadItemCsv(cb) {
  if (!fs.existsSync(DB2_DIR)) fs.mkdirSync(DB2_DIR, { recursive: true });
  var tmp = ITEM_CSV + '.part';
  var u = new URL(ITEM_CSV_URL);
  process.stdout.write('  下 ItemSparse.csv（实测约 48 MB）…');
  var req = https.request({
    host: u.hostname, port: 443, method: 'GET', path: u.pathname + u.search,
    headers: { 'User-Agent': 'WowAltBoard/1.0' }
  }, function (res) {
    if (res.statusCode !== 200) {
      res.resume();
      cb(new Error('ItemSparse.csv HTTP ' + res.statusCode));
      return;
    }
    var out = fs.createWriteStream(tmp), got = 0;
    res.on('data', function (c) { got += c.length; });
    res.pipe(out);
    out.on('finish', function () {
      fs.renameSync(tmp, ITEM_CSV);
      console.log(' 好，' + (got / 1024 / 1024).toFixed(2) + ' MB');
      cb(null);
    });
    out.on('error', cb);
  });
  req.on('error', cb);
  req.setTimeout(120000, function () { req.destroy(new Error('下 ItemSparse.csv 超时')); });
  req.end();
}

/** 拆一行 CSV，认引号里的逗号。列名可能挪位置，所以按表头找列，不写死下标。 */
function splitCsv(line) {
  var out = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 只取需要的那些 id 的中文名。ids 是 Set 一样用的对象。 */
function itemNames(ids, cb) {
  // ids 必须是**数组**。第一版这里当集合对象用（`ids[id]`），而调用方传的是数组，
  // 于是 `ids['25']` 命中的是**下标 25**（一个物品 id 字符串，恰好是真值），
  // 结果把 DB2 里 id 0~174 那些无关物品的名字当成命中存了下来 ——
  // 报出「命中 38/175」，看着像「有些装备没中文名」，其实是**存了别人的名字**。
  // 探针单独跑同一份 CSV 是 499/499，两个互斥读数才让它露出来。
  // 教训还是那条：容易被误用的接口，要让误用**当场炸**，不要让它算出一个像样的错数。
  if (!Array.isArray(ids)) {
    throw new TypeError('itemNames 的第一个参数要 id 数组（Object.keys(...)），不是集合对象');
  }
  var want = {};
  ids.forEach(function (id) { want[String(id)] = 1; });

  function parse() {
    var txt = fs.readFileSync(ITEM_CSV, 'utf8');
    var nl = txt.indexOf('\n');
    var head = splitCsv(txt.slice(0, nl).replace(/\r$/, ''));
    var iId = head.indexOf('ID'), iName = head.indexOf('Display_lang');
    if (iId < 0 || iName < 0) {
      throw new Error('ItemSparse.csv 里找不到 ID / Display_lang 列 —— 上游改了表头');
    }
    var map = {}, hit = 0, rows = 0, pos = nl + 1;
    while (pos < txt.length) {
      var end = txt.indexOf('\n', pos);
      if (end < 0) end = txt.length;
      // 快路：先只看第一个逗号前的 id，绝大多数行会在这里被跳掉。
      var comma = txt.indexOf(',', pos);
      if (comma > pos && comma < end) {
        var id = txt.slice(pos, comma);
        if (want[id]) {
          var f = splitCsv(txt.slice(pos, end).replace(/\r$/, ''));
          if (f[iId] === id && f[iName]) { map[id] = f[iName]; hit++; }
        }
      }
      rows++;
      pos = end + 1;
    }
    var nWant = ids.length;
    var missed = ids.filter(function (id) { return !map[String(id)]; });
    console.log('  DB2 ' + rows + ' 行，要 ' + nWant + ' 个 id，命中 ' + hit
      + '（' + (nWant ? (hit * 100 / nWant).toFixed(1) : '0') + '%）');
    return { map: map, want: nWant, hit: hit, missed: missed };
  }

  if (fs.existsSync(ITEM_CSV) && fs.statSync(ITEM_CSV).size > 1000000) {
    cb(null, parse());
    return;
  }
  if (OFFLINE) {
    cb(new Error('缺 tools/.db2-names/ItemSparse.csv，而且是 --offline'));
    return;
  }
  downloadItemCsv(function (e) {
    if (e) { cb(e); return; }
    cb(null, parse());
  });
}

// -------------------------------------------------------------------- 聚合

/**
 * 把「角色名单 + 每人的装备」聚成「每专精每部位的分布」。
 *
 * 和 BisData 的两个关键区别，也是换数据源的全部理由：
 *   · **每个部位带自己的 N**（`slots[槽位].n`）。不是全专精一个数 —— 有人没副手、
 *     有人没衬衣，各部位人数本来就不同。
 *   · **分布不截断**：出现过的物品全列，所以百分比之和恒为 100%。
 *     BisData 只列 1~7 件，实测 1264 个部位组里使用率之和中位数 72.9%。
 */
function aggregate(roster, gears) {
  var specs = {}, itemMeta = {};

  roster.forEach(function (ch) {
    var g = gears[ch.region + '/' + ch.realm + '/' + ch.name];
    var sid = String(ch.specId);
    if (!specs[sid]) specs[sid] = { n: 0, nGear: 0, slots: {}, loadouts: [] };
    var S = specs[sid];
    S.n++;
    // **带上角色身份** —— 归并要靠它去重（同一个人换了写法还是同一个人）。
    // 键用「大区/服务器/角色名」，那也是上面 collectSpec 去重用的键。
    if (ch.loadout) {
      S.loadouts.push({ ch: ch.region + '/' + ch.realm + '/' + ch.name, str: ch.loadout });
    }
    var items = g && g.gear && g.gear.items;
    if (!items) return;
    S.nGear++;
    Object.keys(items).forEach(function (slotName) {
      var slot = SLOT_MAP[slotName];
      if (!slot) return;            // shirt / tabard 这类不入表
      var it = items[slotName];
      if (!it || !it.item_id) return;
      var k = String(slot);
      if (!S.slots[k]) S.slots[k] = { n: 0, c: {}, il: {} };
      var B = S.slots[k];
      B.n++;
      var id = String(it.item_id);
      B.c[id] = (B.c[id] || 0) + 1;
      B.il[id] = (B.il[id] || 0) + (it.item_level || 0);
      if (!itemMeta[id]) {
        itemMeta[id] = {
          i: it.icon || '', q: it.item_quality || 0,
          sock: 0, seen: 0
        };
      }
      itemMeta[id].seen++;
      if (it.gems && it.gems.length) itemMeta[id].sock++;
    });
  });

  // 收尾：把计数表压成排好序的数组 [itemId, 人数, 平均等级]
  Object.keys(specs).forEach(function (sid) {
    var S = specs[sid];
    Object.keys(S.slots).forEach(function (k) {
      var B = S.slots[k];
      var arr = Object.keys(B.c).map(function (id) {
        return [Number(id), B.c[id], Math.round(B.il[id] / B.c[id])];
      });
      arr.sort(function (a, b) { return b[1] - a[1] || a[0] - b[0]; });
      S.slots[k] = { n: B.n, d: arr };
    });
  });

  return { specs: specs, itemMeta: itemMeta };
}

/**
 * 串 + 角色 → { rows: [[代表串, 多少人]…]（人数降序，最多 keep 套）, uniq 总套数 }。
 *
 * 「一套天赋」按**解出来的内容**算，不按字节 —— 定义在 tools/group-loadouts.js，
 * 和 fetch-wcl.js 共用同一份。实测归并几乎不生效（21181 条不同串 → 21173 套），
 * 也就是说第 20 轮用户报的「500 名玩家而 #1~#6 只有 47 人」**不是聚合的错**，
 * 是天赋本来就人人不同。数字和当时那次误判见那个文件开头。
 */
function groupLoadouts(rows, keep) {
  var g = GROUP.group(rows, decodeOne);
  loStat.dropped += g.dropped;
  loStat.builds += g.list.length;
  loStat.forms += g.forms;
  return {
    rows: g.list.slice(0, keep).map(function (b) { return [b.str, b.n]; }),
    uniq: g.list.length
  };
}

// 归并的账。**必须印出来** —— 「归并到底有没有在干活」只有这里看得见，
// 而一个退化的指纹（第 20 轮踩过）在产物里长得非常合理。
var loStat = { dropped: 0, builds: 0, forms: 0 };

function emit(agg, names, meta) {
  var specTable = {};
  var tree = meta.tree;
  Object.keys(agg.specs).forEach(function (sid) {
    var S = agg.specs[sid];
    var sp = tree.specs[sid] || {};
    var lo = groupLoadouts(S.loadouts, 30);
    specTable[sid] = {
      cls: sp.cls || '', specEn: sp.specEn || '',
      n: S.n, nGear: S.nGear, slots: S.slots,
      // 天赋串**在产物里就聚合成 [[串, 人数]…]，只留前 30 套**。
      //
      // 第 20 轮把每专精的采样从 100 人提到 500 人之后，一人一条地存
      // 19908 条串 = 2091 KB，占整个产物的 90%，而面板每个专精只画前 6 套。
      // 聚合之后形状和 app/wcl-data.js 一致，面板那边一份代码画两家。
      loadouts: lo.rows,
      // loUniq 是**总套数**，不是上面那 30 条的长度 ——
      // 界面上「N 名玩家共 M 套」里的 M 要说真话（实测一个专精几百套）。
      loUniq: lo.uniq
    };
  });

  var items = {};
  Object.keys(agg.itemMeta).forEach(function (id) {
    var m = agg.itemMeta[id];
    items[id] = { n: names.map[id] || '', i: m.i, q: m.q, sock: m.sock };
  });

  var obj = {
    v: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'raider.io（大秘境每专精排行榜 + 角色 profile fields=gear）',
    season: SEASON,
    itemNameSource: 'wago.tools DB2 ItemSparse locale=zhCN',
    note: '每个部位带自己的样本量 slots[槽位].n；分布 d 不截断，百分比之和恒为 100%。'
      + '槽位编号沿用暴雪的 INVSLOT（和 app/bis-data.js 的 slotNames 同一套）。',
    slotOf: SLOT_MAP,
    fmt: {
      specs: 'specId → {cls, specEn, n 榜上人数, nGear 有装备的人数, slots, '
        + 'loadouts [[天赋串, 多少人用这一套]…]（人数降序，最多 30 套；'
        + '「一套」按**解出来的天赋**算，不按字节，见 tools/group-loadouts.js）, '
        + 'loUniq 一共多少套}',
      slots: '槽位编号 → {n 这个部位的样本量, d: [[itemId, 人数, 平均装等], …] 按人数降序}',
      items: 'itemId → {n 中文名, i 图标名, q 品质, sock 带宝石的次数}'
    },
    items: items,
    specs: specTable
  };

  var js = '/* 自动生成，勿手改。生成器：tools/fetch-rio.js */\n'
    + 'window.AE_RIO = ' + JSON.stringify(obj) + ';\n';
  fs.writeFileSync(OUT, js);
  return { bytes: Buffer.byteLength(js, 'utf8'), obj: obj };
}

module.exports = {
  loadSpecs: loadSpecs, collectSpec: collectSpec, profile: profile,
  rankPage: rankPage, netStat: netStat, CACHE: CACHE, OUT: OUT,
  aggregate: aggregate, emit: emit, itemNames: itemNames,
  splitCsv: splitCsv, SLOT_MAP: SLOT_MAP,
  // pool 导出只为一个用途：run-tests.js 要能拿同步 worker 压它，
  // 复现「缓存全命中 → 栈溢出」那个坑。不导出就没法写回归测试。
  pool: pool
};

// ---------------------------------------------------------------------- main

function main() {
  var specs = loadSpecs();
  if (ONLY.length) {
    specs = specs.filter(function (s) { return ONLY.indexOf(s.id) >= 0; });
    if (!specs.length) throw new Error('--specs 过滤后一个专精都不剩');
  }
  console.log('raider.io 抓取：' + specs.length + ' 个专精　赛季 ' + SEASON
    + '\n  天赋串目标 ' + TALENT_TARGET + ' 人/专精（榜里白送），'
    + '装备目标 ' + TARGET + ' 人/专精（一人一次请求），最多翻 ' + MAXPAGES + ' 页'
    + (OFFLINE ? '　（--offline，只用缓存）' : ''));
  checkSeason(function () { run(specs); });
}

/**
 * 开跑之前先问站点「现在是哪个赛季」。
 *
 * 这一条是补一次真实事故：产物里的赛季停在 season-tww-3（上一个资料片），
 * 而当时早就是 season-mn-2 了。**两个赛季都返回 HTTP 200**，榜也都是满的 ——
 * 所以没有任何一处会报错，面板上那一整页实战分布是上个资料片的数据，
 * 而且看不出来。
 *
 * 判据只能是「跟站点对一遍」：赛季表在
 * `/api/v1/mythic-plus/static-data?expansion_id=N`，第一条就是当前赛季。
 * 对不上就**停下来**（不是警告）—— 抓一份错赛季的数据比不抓糟得多，
 * 它会安静地正确运行。真要抓旧赛季，显式写 --season 就是「我知道我在干什么」。
 */
function checkSeason(next) {
  if (OFFLINE || argv.indexOf('--season') >= 0) { next(); return; }
  // expansion_id 也别写死：从赛季 slug 里认（mn = Midnight = 11，tww = 10）。
  var EXP = { mn: 11, tww: 10 };
  var m = /^season-([a-z]+)-/.exec(SEASON);
  var eid = (m && EXP[m[1]]) || 11;
  get('https://raider.io/api/v1/mythic-plus/static-data?expansion_id=' + eid,
    function (e, code, body) {
      if (e || code !== 200) {
        console.log('  ⚠ 赛季核对失败（' + (e ? e.message : 'HTTP ' + code)
          + '）—— 继续用 ' + SEASON + '，但没人替你确认它是当前赛季');
        next();
        return;
      }
      var cur = null, all = [];
      try {
        var j = JSON.parse(body.toString('utf8'));
        all = (j.seasons || []).map(function (x) { return x.slug; });
        // 取**最新的正式赛季**，不是数组第一条。站点会在正式赛季前面塞变体
        // （实测 TWW 那一栏第一条是 season-tww-3-cutoffs，还有
        // -break-the-meta / -legion-remix 这些活动赛季）。正式赛季的 slug
        // 形状固定是 season-<资料片>-<数字>，按这个筛。
        for (var k = 0; k < all.length; k++) {
          if (/^season-[a-z]+-\d+$/.test(all[k])) { cur = all[k]; break; }
        }
      } catch (e2) { /* 解析不了就当核对失败 */ }
      if (!cur) {
        console.log('  ⚠ 赛季表解析不了 —— 继续用 ' + SEASON);
        next();
        return;
      }
      if (cur !== SEASON) {
        console.log('\n站点说当前赛季是 ' + cur + '，而这里要抓 ' + SEASON + '。');
        console.log('  站点认的赛季：' + all.join('、'));
        console.log('  这就是上一次那个 bug 的形状：**旧赛季照样返回 200**，'
          + '抓下来一切正常，只是数据是上个资料片的。');
        console.log('  改 tools/fetch-rio.js 里 SEASON 的默认值，'
          + '或者显式写 --season ' + SEASON + ' 表示你确实要抓旧赛季。');
        process.exit(1);
      }
      console.log('  赛季核对（站点最新的正式赛季）：' + cur + ' ✓（站点第一条就是它）');
      next();
    });
}

function run(specs) {
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
          + (roster.length < TALENT_TARGET ? '　← 不足 ' + TALENT_TARGET : ''));
        // 「不足」按天赋目标算 —— 装备目标本来就只取前 TARGET 个，不算缺。
        if (roster.length < TALENT_TARGET) thin.push(sp.cls + '/' + sp.specEn + ' ' + roster.length);
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
      console.log('天赋样本不足 ' + TALENT_TARGET + ' 的专精（' + thin.length + ' 个）：'
        + thin.join('，'));
      console.log('  这不一定是错：榜是按「用这个专精打出的分」排的，而筛的是'
        + '角色**当前**专精（见文件头 ①），冷门专精本来就凑不够。');
    }
    if (RANK_ONLY) {
      console.log('--rank-only，装备不抓。');
      report(all, {});
      return;
    }

    // **只查前 TARGET 个人的装备。** 榜可能抓了 500 人（为了天赋串），
    // 但装备一人一次请求还带配额，全查等于把跑一次的时间乘五。
    var gearList = all.filter(function (r) { return r.gear; });
    console.log('\n抓装备：' + gearList.length + ' / ' + all.length
      + ' 个角色（每专精分数最高的 ' + TARGET + ' 个），fields=gear（实测 9638 B/人），并发 '
      + CONCURRENCY);
    var gears = {}, okN = 0, failN = 0, hitN = 0, realmFallback = 0;
    var done = 0;
    pool(gearList, CONCURRENCY, function (ch, next) {
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
            done++; progress(done, gearList.length, 'ok ' + okN + '，失败 ' + failN);
            next();
          });
          return;
        } else failN++;
        done++; progress(done, gearList.length, 'ok ' + okN + '，失败 ' + failN);
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

    if (RANK_ONLY) {
      console.log('\n--rank-only：没有装备就没法聚合，不生成 app/rio-data.js。');
      return;
    }
    if (!nGear) {
      throw new Error('一个角色的装备都没拿到 —— 不生成产物。'
        + '（如果是 --offline，先跑一次联网抓取把缓存填上）');
    }

    var agg = aggregate(all, gears);

    /*
     * 发射前守卫：**逐个专精**看装备样本够不够。
     *
     * 这条是撞出来的。上面那句 `if (!nGear)` 只挡「一个都没有」，
     * 而第一次全量跑的真实情况是：总共拿到 361 份装备、看着不为 0，
     * 但 **19 个专精各自是 0**（被 429 挡光了），产物照样写了出来 ——
     * 一份 40 专精的 rio-data.js 里有 19 个专精的分布是凭空的。
     *
     * 「不许静默产出小样本」这条规矩，本来就是我要用 raider.io 换掉
     * BisData 的全部理由。所以它必须是**工具自己的硬失败**，
     * 不能只靠事后跑校验器发现。
     *
     * 缓存是按角色存的，所以「停下来重跑」很便宜：已经拿到的不会再下。
     */
    var MIN_GEAR = Number(opt('--mingear', Math.min(30, TARGET))) || 1;
    var thinGear = [];
    Object.keys(agg.specs).forEach(function (sid) {
      var S = agg.specs[sid];
      if (S.nGear < MIN_GEAR) {
        thinGear.push(sid + ' ' + S.cls + '/' + S.specEn + ' 装备 ' + S.nGear + '/' + S.n);
      }
    });
    if (thinGear.length) {
      console.log('\n装备样本不足 ' + MIN_GEAR + ' 的专精（' + thinGear.length + ' 个）：');
      thinGear.forEach(function (s) { console.log('  · ' + s); });
      throw new Error(thinGear.length + ' 个专精的装备样本不足 ' + MIN_GEAR
        + ' —— 拒绝生成产物。这正是要换掉 BisData 的毛病，不能在新数据源上重演。'
        + '\n  多半是被 429 限速挡掉了（看上面的状态码分布）。直接重跑同一条命令即可：'
        + '\n  已经拿到的角色都在 tools/.rio-raw/ 里，不会重复下载。'
        + '\n  还是不行就再慢一点：--gap 2000 --conc 1');
    }
    var ids = Object.keys(agg.itemMeta);
    console.log('\n聚合：' + Object.keys(agg.specs).length + ' 个专精，'
      + ids.length + ' 个不同物品');

    // 中文名是最后一步：raider.io 只给英文，名字从暴雪 DB2 批量拿。
    itemNames(ids, function (e, names) {
      if (e) throw e;
      console.log('  中文名 ' + names.hit + '/' + ids.length
        + '（' + (ids.length ? (names.hit * 100 / ids.length).toFixed(1) : '0') + '%）'
        + (names.missed.length
          ? '　缺 ' + names.missed.length + ' 个：' + names.missed.slice(0, 6).join(',')
          : ''));
      if (ids.length && names.hit * 100 / ids.length < 95) {
        // DB2 对本机 402 个 id 实测命中 100%。掉到 95% 以下说明取名这条链断了，
        // 而不是「有几件冷门装备没名字」—— 宁可停下来，也别产出一堆空名字。
        throw new Error('中文名命中率只有 '
          + (names.hit * 100 / ids.length).toFixed(1) + '%，低于 95% —— 拒绝生成。'
          + '先检查 wago.tools 的 ItemSparse 是否换了列名');
      }

      var tree = treeOf();
      var res = emit(agg, names, { tree: tree });
      console.log('\n写出 ' + path.relative(ROOT, OUT) + '　'
        + (res.bytes / 1024).toFixed(1) + ' KB');

      // 产物自检：把最该看的三个数打出来，而不是只说「成功」。
      var sids = Object.keys(res.obj.specs);
      var nMin = Infinity, nMax = 0, slotMin = Infinity, loadN = 0;
      sids.forEach(function (sid) {
        var S = res.obj.specs[sid];
        nMin = Math.min(nMin, S.n); nMax = Math.max(nMax, S.n);
        loadN += S.loUniq || 0;
        Object.keys(S.slots).forEach(function (k) {
          slotMin = Math.min(slotMin, S.slots[k].n);
        });
      });
      console.log('  专精 ' + sids.length + '，每专精人数 ' + (nMin === Infinity ? 0 : nMin)
        + '~' + nMax + '，最小部位样本量 ' + (slotMin === Infinity ? 0 : slotMin)
        + '，天赋 ' + loadN + ' 套（各专精只留前 30），物品 ' + Object.keys(res.obj.items).length);
      // 归并的账。**印出来才看得见归并有没有在干活**：实测写法/套 ≈ 1.00
      // （天赋人人不同，不是同一套的多种写法）。这个数明显大于 1 就是指纹退化了 ——
      // 第 20 轮真踩过：字段名写错让它变成 14.19 种/套，产物看起来却很合理。
      if (loStat.builds) {
        console.log('  天赋归并：' + loStat.builds + ' 套，共 ' + loStat.forms
          + ' 种写法（' + (loStat.forms / loStat.builds).toFixed(2) + ' 种/套）'
          + (loStat.dropped ? '，解不开丢掉 ' + loStat.dropped + ' 条' : '')
          + ' —— 「一套」按解出来的天赋算；这个数明显大于 1 说明指纹退化了');
      }
      console.log('\n下一步：node tools\\verify-rio-data.js 校验格式。');
    });
  }
}

/** 产物里要写职业 / 专精英文名，从天赋树读 —— 那份数据已经过校验。 */
function treeOf() {
  var sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', fs.readFileSync(TREE_JS, 'utf8'))(sandbox.window);
  return sandbox.window.AE_TALENT_TREE;
}

if (require.main === module) main();
