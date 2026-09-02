/*
 * WowAltBoard - tools/verify-rio-data.js
 *
 * 校验 app/rio-data.js 的格式。**格式说明就写在这个文件里** —— 换数据源的时候，
 * 新生成器只要能过这一关，面板就能直接用，不必去读 fetch-rio.js。
 *
 * 这个校验器和 verify-bis-data.js 的关键区别：rio-data 是**能自洽的**。
 * BisData 只能查「字段在不在」，因为它的列表是截断的、样本量根本不存在；
 * rio-data 每个部位带自己的 N，而分布是从同一批人身上数出来的，
 * 所以「人数之和 == 该部位样本量」是一条**恒等式** —— 它一旦不成立，
 * 就说明聚合算错了，而不是「数据比较少」。这是这里最有价值的一条断言。
 *
 * 格式（v1）
 * ---------
 * window.AE_RIO = {
 *   v: 1,
 *   updatedAt: 'YYYY-MM-DD',
 *   source: '人话说明数据打哪来',
 *   season: 'season-tww-3',
 *   itemNameSource: '中文名打哪来',
 *   note / fmt: 给人看的说明
 *   slotOf: { 'head': 1, … }          rio 的英文槽位名 → 暴雪槽位编号
 *   items:  { itemId: { n 中文名, i 图标名, q 品质, sock 带宝石次数 } }
 *   specs:  { specId: {
 *              cls, specEn,
 *              n      这个专精抓到几个角色
 *              nGear  其中几个真的拿到装备
 *              slots  { 槽位编号: { n 该部位样本量, d: [[itemId, 人数, 平均装等], …] } }
 *              loadouts [[天赋导入串, 多少人用这一套], …]（人数降序，最多 30 套；
 *                       「一套」按解出来的天赋算，不按字节）
 *              loUniq   一共多少套
 *            } }
 *
 * 用法：node tools\verify-rio-data.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.resolve(__dirname, '..');
var dataPath = path.join(BASE, 'app', 'rio-data.js');

var errors = [], warns = [], checks = 0;
function fail(m) { errors.push(m); }
function warn(m) { warns.push(m); }
function ck() { checks++; }

if (!fs.existsSync(dataPath)) {
  console.log('没有 app/rio-data.js —— 先跑 node tools\\fetch-rio.js');
  process.exit(1);
}

var sandbox = { window: {} };
// eslint-disable-next-line no-new-func
new Function('window', fs.readFileSync(dataPath, 'utf8'))(sandbox.window);
var R = sandbox.window.AE_RIO;
if (!R) {
  console.log('app/rio-data.js 没有给 window.AE_RIO 赋值');
  process.exit(1);
}

/*
 * 解码器 + 天赋树。为了验「两行不许是同一套天赋」这一条（第 20 轮加的）。
 *
 * 故意用 **app/talent-decode.js**（面板那份），不用生成器用的
 * tools/decode-talent-string.js，也**不 require tools/group-loadouts.js** ——
 * 归并的键就是那个文件算的，拿它算真值再去验它的产物是个恒等式，永远通过。
 * 下面 buildKey() 是这里独立写的第二份实现。加载方式抄 verify-wcl-data.js。
 */
var DEC = null, TREE = null;
(function () {
  var treeJs = path.join(BASE, 'app', 'talent-tree.js');
  var decJs = path.join(BASE, 'app', 'talent-decode.js');
  if (!fs.existsSync(treeJs) || !fs.existsSync(decJs)) {
    console.log('缺 app/talent-tree.js 或 app/talent-decode.js —— 天赋串没法复核。'
      + '先跑 node tools\\fetch-talent-tree.js');
    process.exit(1);
  }
  var gg = {}; gg.window = gg;
  new Function('window', fs.readFileSync(treeJs, 'utf8'))(gg); // eslint-disable-line no-new-func
  new Function('window', fs.readFileSync(decJs, 'utf8'))(gg);  // eslint-disable-line no-new-func
  TREE = gg.AE_TALENT_TREE;
  DEC = gg.AE && gg.AE.TalentDecode;
  if (!TREE || !TREE.specs || !DEC || !DEC.decode) {
    console.log('加载后拿不到天赋树或解码器 —— 天赋串没法复核');
    process.exit(1);
  }
}());

/**
 * 「这是哪一套天赋」的指纹：专精 + 排序后的「节点:点数:二选一」。
 *
 * 和 tools/group-loadouts.js 里那份是**各写一遍**的（那份读的是生成器解码器的
 * nodes 数组，这份读的是面板解码器的 nr 对象）。解不开返回 null。
 */
function buildKey(str) {
  var d = null;
  try { d = DEC.decode(str, TREE); } catch (e) { return null; }
  if (!d || d.err || !d.nr) return null;
  var parts = Object.keys(d.nr).map(function (id) {
    var v = d.nr[id] || {};
    return id + ':' + (v.rank || 0) + ':' + (v.eid != null ? v.eid : '');
  });
  if (!parts.length) return null;
  return (d.spec != null ? d.spec : '?') + '#' + parts.sort().join('|');
}

// ------------------------------------------------------------------ 顶层字段
(function () {
  ['v', 'updatedAt', 'source', 'season', 'slotOf', 'items', 'specs'].forEach(function (k) {
    ck();
    if (R[k] === undefined) fail('顶层缺 ' + k);
  });
  ck();
  if (R.v !== 1) fail('版本号是 ' + R.v + '，这个校验器只认 v1');
  ck();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(R.updatedAt || ''))) {
    fail('updatedAt 不是 YYYY-MM-DD：' + R.updatedAt);
  }
  // 中文名是内联进产物的，所以来源必须写清楚 —— 否则下次没人知道名字打哪来。
  ck();
  if (!R.itemNameSource) fail('缺 itemNameSource（中文名的出处要写在数据里）');
})();

// ------------------------------------------------------------------ 槽位表
var slotNums = {};
(function () {
  var m = R.slotOf || {};
  var keys = Object.keys(m);
  ck();
  if (keys.length < 16) fail('slotOf 只有 ' + keys.length + ' 项，实测该有 16 个槽位');
  keys.forEach(function (k) {
    ck();
    var v = m[k];
    if (typeof v !== 'number' || v < 1 || v > 17 || v !== Math.floor(v)) {
      fail('slotOf.' + k + ' = ' + v + '，不是 1~17 的槽位编号');
    }
    // 一个编号被两个英文名占用，说明映射表抄错了 —— 戒指 11/12、饰品 13/14
    // 必须各自独立，否则面板上「戒指2」会显示成「戒指1」的分布。
    if (slotNums[v]) fail('槽位编号 ' + v + ' 同时被 ' + slotNums[v] + ' 和 ' + k + ' 占用');
    slotNums[v] = k;
  });
  // 4 是衬衣槽，暴雪的编号里存在但对强度无意义，故意不映射。它出现反而是错。
  ck();
  if (m.shirt !== undefined) warn('slotOf 里映射了 shirt —— BisData 没这个槽，面板用不上');
})();

// ------------------------------------------------------------------ 物品表
var itemIds = {};
// 带插槽的物品数。**不能挂在下面那个 stat 上** —— 它是在这个块之后才声明的，
// var 提升让它在这里是 undefined，赋值当场抛异常。
var gemStat = { gemmed: 0 };
(function () {
  var items = R.items || {};
  var ids = Object.keys(items);
  ck();
  if (!ids.length) fail('items 是空的');
  var noName = [], badQ = 0, noIcon = [], badGmax = [], gemmed = 0;
  ids.forEach(function (id) {
    itemIds[id] = 1;
    ck();
    if (!/^\d+$/.test(id)) fail('items 的键 ' + id + ' 不是数字物品 id');
    var it = items[id] || {};
    if (!it.n) noName.push(id);
    // 品质 0~7（粗糙 … 传家宝）。给 0 说明 raider.io 那边没给，不该发生。
    if (typeof it.q !== 'number' || it.q < 1 || it.q > 7) badQ++;
    if (!it.i) noIcon.push(id);
    /*
     * 宝石那两个字段是**两种东西**，界面上分别用在不同的地方：
     *   · sock = 有多少个采样角色在这件上镶了宝石（热门度那一类的量，可以上千）
     *   · gmax = 单件上见过最多几颗宝石 = **这件至少有几个插槽**（游戏上限 3）
     *
     * 这一条是第 20 轮那次事故的反向守卫：面板拿 sock 当插槽数印出了
     * 「插槽 ×1349」。所以这里钉死 gmax 的上界，并要求两个字段口径一致 ——
     * 宝石只能镶在插槽里，所以「有人镶过」和「见过至少一颗」必须同时成立。
     */
    ck();
    if (typeof it.gmax !== 'number' || it.gmax < 0 || it.gmax > 3
        || it.gmax !== Math.floor(it.gmax)) {
      badGmax.push(id + ':' + it.gmax);
    }
    ck();
    if ((it.sock > 0) !== (it.gmax > 0)) {
      fail('物品 ' + id + ' 的 sock=' + it.sock + ' 和 gmax=' + it.gmax
        + ' 对不上 —— 宝石只能镶在插槽里，两个字段必须同时为 0 或同时非 0');
    }
    if (it.gmax > 0) gemmed++;
  });
  ck();
  if (badGmax.length) {
    fail(badGmax.length + ' 件物品的 gmax 不是 0~3 的整数（' + badGmax.slice(0, 6).join(',')
      + '）—— 它记的是**插槽数**，游戏里上限就是 3。'
      + '超了说明它又变回「镶过宝石的人数」了（那是 sock）');
  }
  ck();
  if (!gemmed) {
    fail('一件带插槽的物品都没有 —— gmax 整列是 0，插槽徽章在界面上会全部消失');
  }
  gemStat.gemmed = gemmed;
  ck();
  // 中文名是换数据源的硬要求：面板现在显示中文，退回英文是功能退化。
  // DB2 对本机实测命中 100%，所以这里要求「一个都不许缺」，不是一个比例。
  if (noName.length) {
    fail(noName.length + ' 件物品没有中文名（前几个：' + noName.slice(0, 6).join(',')
      + '）—— DB2 实测命中率 100%，缺名字说明取名那条链断了');
  }
  ck();
  if (noIcon.length) {
    fail(noIcon.length + ' 件物品没有图标名（raider.io 是白送这个字段的，'
      + '缺了说明聚合把它丢了）');
  }
  ck();
  if (badQ) fail(badQ + ' 件物品的品质不在 1~7');
})();

// ------------------------------------------------------------------ 专精表
var stat = { specs: 0, slots: 0, rows: 0, loadouts: 0, loRows: 0, loKeys: 0,
  minSlotN: Infinity, minSpecN: Infinity,
  minGear: Infinity, gearTotal: 0, zeroGear: [], thinGear: [] };
(function () {
  var specs = R.specs || {};
  var sids = Object.keys(specs);
  ck();
  if (!sids.length) fail('specs 是空的');

  sids.forEach(function (sid) {
    stat.specs++;
    var S = specs[sid] || {};
    ck();
    if (!/^\d+$/.test(sid)) fail('specs 的键 ' + sid + ' 不是数字 specID');
    ck();
    if (!S.cls || !S.specEn) fail('专精 ' + sid + ' 缺 cls / specEn');
    ck();
    if (typeof S.n !== 'number' || S.n < 1) fail('专精 ' + sid + ' 的 n 不是正整数：' + S.n);
    ck();
    if (typeof S.nGear !== 'number' || S.nGear > S.n) {
      fail('专精 ' + sid + ' 的 nGear=' + S.nGear + ' 比 n=' + S.n + ' 还大');
    }
    stat.minSpecN = Math.min(stat.minSpecN, S.n);
    stat.minGear = Math.min(stat.minGear, S.nGear || 0);
    stat.gearTotal += S.nGear || 0;
    // **nGear 才是「这份产物能不能用」的判据。**
    // n 是榜单上滤出来的人数，nGear 是真的把装备抓下来的人数 —— 两者可以差很远：
    // 第 13 轮撞 429 限速那次 n 全是 94~100，而 nGear 有 19 个专精是 0，
    // 校验器却报了「每专精最少 94 人」并放行。一个专精没有装备就没有分布，
    // 拿这种产物画面板等于骗人，所以这里是**硬失败**，不是警告。
    ck();
    if (!S.nGear) {
      stat.zeroGear.push(sid);
      fail('专精 ' + sid + '（' + S.cls + '/' + S.specEn + '）一份装备都没抓到'
        + '（榜上有 ' + S.n + ' 人）—— 这种专精不该出现在产物里');
    } else if (S.nGear < 30) {
      stat.thinGear.push(sid + ':' + S.nGear);
    }

    /*
     * 天赋串。形状 [[串, 多少人用这一套]…]，人数降序，每专精最多 30 套。
     *
     * 「一套」按**解出来的天赋**算，不按字节（生成器那边是 tools/group-loadouts.js）。
     * 实测这两种算法几乎等价（21181 条不同串 → 21173 套），所以第 20 轮用户报的
     * 「标题写 500 名玩家而 #1~#6 加起来 47 人」不是聚合的错 —— 天赋本来就人人不同，
     * 一个专精几百人能有几百套。和 app/wcl-data.js（团本那半）是同一个形状。
     */
    var lo = S.loadouts || [];
    ck();
    if (!Array.isArray(lo)) { fail('专精 ' + sid + ' 的 loadouts 不是数组'); lo = []; }
    stat.loRows += lo.length;
    ck();
    if (typeof S.loUniq !== 'number' || S.loUniq < lo.length) {
      fail('专精 ' + sid + ' 的 loUniq 是 ' + S.loUniq + '，不该小于留下来的 '
        + lo.length + ' 套 —— 它记的是**一共多少套**');
    } else {
      stat.loadouts += S.loUniq;
    }
    var prev = null, seenKey = {};
    lo.forEach(function (row, i) {
      ck();
      if (!Array.isArray(row) || row.length !== 2) {
        fail('专精 ' + sid + ' 的 loadouts[' + i + '] 不是 [串, 人数] 两元组');
        return;
      }
      // 串是标准 base64 字母表。里头出现别的字符说明存的时候被截断或转义了。
      ck();
      if (typeof row[0] !== 'string' || !/^[A-Za-z0-9+/]+$/.test(row[0])) {
        fail('专精 ' + sid + ' 有一个天赋串不是 base64：' + String(row[0]).slice(0, 20));
      }
      ck();
      if (typeof row[1] !== 'number' || row[1] < 1 || row[1] !== Math.floor(row[1])) {
        fail('专精 ' + sid + ' 的 loadouts[' + i + '] 人数不是正整数：' + row[1]);
      }
      // **顺序必须是人数降序。** 面板不重排（重排会把产物排错这件事藏起来），
      // 所以「#1 热门」到底是不是最热门的那条，全靠这一条守着。
      ck();
      if (prev !== null && row[1] > prev) {
        fail('专精 ' + sid + ' 的 loadouts 不是人数降序：第 ' + i + ' 条 '
          + row[1] + ' 人，排在 ' + prev + ' 人后面');
      }
      prev = row[1];
      /*
       * **两行不许是同一套天赋。** 串不同而解出来相同的两行，会把一套的人数
       * 摊到两行里，而按串查重查不出来（字节确实不一样）。
       * 指纹是这里独立算的（见上面 buildKey），不问生成器 —— 生成器的指纹
       * 第 20 轮就退化过一次（字段名写错，把完全不同的天赋并成一套），
       * 而产物看起来非常合理。
       */
      ck();
      var key = buildKey(row[0]);
      if (!key) {
        fail('专精 ' + sid + ' 的 loadouts[' + i + '] 解不开 —— 解不开的串放进产物，'
          + '用户复制粘贴进游戏只会得到「无效」');
      } else if (seenKey[key]) {
        fail('专精 ' + sid + ' 的 loadouts[' + i + '] 和第 ' + seenKey[key]
          + ' 条解出来是同一套天赋（只是字节不同）—— 这一套的人数被摊到了两行里');
      } else {
        seenKey[key] = i + 1;
        stat.loKeys++;
      }
    });
    // 人数之和不该超过榜上人数 —— rio 一个角色只有一条串（profile 里那条），
    // 所以超了说明聚合把同一个人数了两遍。
    ck();
    var sum = lo.reduce(function (a, r) { return a + (Array.isArray(r) ? r[1] : 0); }, 0);
    if (sum > S.n) {
      fail('专精 ' + sid + ' 的 loadouts 人数之和 ' + sum + ' 超过榜上人数 ' + S.n);
    }

    var slots = S.slots || {};
    Object.keys(slots).forEach(function (k) {
      stat.slots++;
      var B = slots[k] || {};
      ck();
      if (!slotNums[Number(k)]) fail('专精 ' + sid + ' 用了槽位 ' + k + '，但 slotOf 里没有');
      ck();
      if (typeof B.n !== 'number' || B.n < 1) {
        fail('专精 ' + sid + ' 槽位 ' + k + ' 的样本量 n 不是正整数：' + B.n);
      }
      stat.minSlotN = Math.min(stat.minSlotN, B.n);
      ck();
      if (!Array.isArray(B.d) || !B.d.length) {
        fail('专精 ' + sid + ' 槽位 ' + k + ' 的分布 d 是空的');
        return;
      }
      // 这是全文件最有价值的一条：**人数之和必须恰好等于该部位样本量**。
      // 分布是从同一批人身上数出来的，所以这是恒等式，不是近似。
      // 它同时挡住三种错：漏计、重复计、把别的专精的人混进来。
      var sum = 0, prev = Infinity, ok = true;
      B.d.forEach(function (row) {
        stat.rows++;
        if (!Array.isArray(row) || row.length !== 3) { ok = false; return; }
        if (!itemIds[String(row[0])]) {
          fail('专精 ' + sid + ' 槽位 ' + k + ' 引用了 items 里没有的物品 ' + row[0]);
        }
        if (typeof row[1] !== 'number' || row[1] < 1) ok = false;
        if (typeof row[2] !== 'number' || row[2] < 1) ok = false;
        sum += row[1] || 0;
        // 按人数降序。面板直接按顺序画，顺序错了「最常用」就不是第一件。
        if (row[1] > prev) {
          fail('专精 ' + sid + ' 槽位 ' + k + ' 的分布没有按人数降序');
        }
        prev = row[1];
      });
      ck();
      if (!ok) fail('专精 ' + sid + ' 槽位 ' + k + ' 有格式不对的行（该是 [itemId, 人数, 平均装等]）');
      ck();
      if (sum !== B.n) {
        fail('专精 ' + sid + ' 槽位 ' + k + ' 人数之和 ' + sum + ' ≠ 样本量 ' + B.n
          + ' —— 分布和样本量必须来自同一批人');
      }
      ck();
      // 每个部位的人数不该超过这个专精的总人数。超了说明同一个人被数了两次。
      if (B.n > S.n) {
        fail('专精 ' + sid + ' 槽位 ' + k + ' 的样本量 ' + B.n + ' 比专精总人数 ' + S.n + ' 还大');
      }
    });

    ck();
    // 一个专精至少该有主要那十来个部位。少太多说明装备没抓全就生成了。
    var nSlot = Object.keys(slots).length;
    if (S.nGear > 0 && nSlot < 10) {
      fail('专精 ' + sid + ' 只有 ' + nSlot + ' 个部位，实测该有 15~16 个');
    }
  });

  // 真空防线：这个校验器的价值全在那条恒等式上。如果一次都没查过，
  // 上面的 0 个问题毫无意义。本机 3 个专精 30 人就有 48 个部位组、300+ 行。
  ck();
  if (stat.slots < 10 || stat.rows < 30) {
    fail('只查了 ' + stat.slots + ' 个部位组 / ' + stat.rows + ' 行，太少 —— '
      + '断言等于没跑（是不是产物只生成了一个专精？）');
  }
  // 同一条防线，管天赋那半：指纹一条都没算过的话，「两行不许是同一套」
  // 这条断言在验空气（解码器加载失败、或者 loadouts 全空都会长这样）。
  ck();
  if (stat.loKeys < stat.loRows) {
    fail('天赋指纹只算出 ' + stat.loKeys + '/' + stat.loRows + ' 条 —— '
      + '剩下的要么解不开要么撞了，「两行不许是同一套天赋」那条没验全');
  }
})();

// ------------------------------------------------------------------ 样本量警告
(function () {
  // 这些不是格式错误，是**数据够不够用**的问题，所以走警告。
  // 比例统计在 N=100 时 95% 置信区间约 ±10%，N<30 时宽到没法给结论。
  if (stat.minGear < 30) {
    warn('装备样本最少的专精只有 ' + stat.minGear + ' 人（N<30 时百分比没有参考价值，'
      + '正式产物该抓够 100 人）');
  }
  if (stat.thinGear.length) {
    warn(stat.thinGear.length + ' 个专精的装备样本不足 30：'
      + stat.thinGear.slice(0, 8).join('，') + (stat.thinGear.length > 8 ? ' …' : ''));
  }
  if (stat.specs < 40) {
    warn('只有 ' + stat.specs + '/40 个专精 —— 是试跑产物吗？');
  }
})();

// ------------------------------------------------------------------ 报告
console.log('校验       ' + path.relative(BASE, dataPath));
console.log('数据       v' + R.v + '   ' + R.updatedAt + '   ' + R.season);
console.log('规模       ' + stat.specs + ' 专精 / ' + Object.keys(R.items || {}).length
  + ' 件 / ' + stat.slots + ' 部位组 / ' + stat.rows + ' 行 / ' + stat.loadouts
  + ' 套天赋（产物里留了 ' + stat.loRows + ' 套，各专精最多 30）');
console.log('天赋复核   ' + stat.loKeys + ' / ' + stat.loRows
  + ' 套独立解开过，没有两套解出来是同一套'
  + '（解码器用 app/talent-decode.js，指纹是这里独立算的，不问生成器）');
// 两个数都打出来。只打 n 会把「榜上有 100 人」说成「有 100 人的装备」——
// 那是第 13 轮真实发生过的误报。
console.log('榜单样本   每专精最少 ' + (stat.minSpecN === Infinity ? '?' : stat.minSpecN) + ' 人');
console.log('装备样本   每专精最少 ' + (stat.minGear === Infinity ? '?' : stat.minGear)
  + ' 人，合计 ' + stat.gearTotal + ' 人，每部位最少 '
  + (stat.minSlotN === Infinity ? '?' : stat.minSlotN) + ' 人');
console.log('插槽       ' + gemStat.gemmed + ' 件物品带插槽（gmax 1~3，即「单件上见过最多几颗宝石」）—— sock 是「多少人镶过」，两回事');
console.log('检查项     ' + checks);

if (warns.length) {
  console.log('');
  console.log('警告 ' + warns.length + ' 条：');
  warns.forEach(function (w) { console.log('  · ' + w); });
}

console.log('');
if (errors.length) {
  console.log('不合格式，' + errors.length + ' 个问题：');
  errors.forEach(function (e) { console.log('  · ' + e); });
  process.exit(1);
}
console.log('格式全部通过。每个部位的「人数之和 == 样本量」是恒等式，这一关能过说明聚合没算错。');
