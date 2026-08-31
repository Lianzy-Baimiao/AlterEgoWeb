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
 *              loadouts [天赋导入串, …]
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
(function () {
  var items = R.items || {};
  var ids = Object.keys(items);
  ck();
  if (!ids.length) fail('items 是空的');
  var noName = [], badQ = 0, noIcon = [];
  ids.forEach(function (id) {
    itemIds[id] = 1;
    ck();
    if (!/^\d+$/.test(id)) fail('items 的键 ' + id + ' 不是数字物品 id');
    var it = items[id] || {};
    if (!it.n) noName.push(id);
    // 品质 0~7（粗糙 … 传家宝）。给 0 说明 raider.io 那边没给，不该发生。
    if (typeof it.q !== 'number' || it.q < 1 || it.q > 7) badQ++;
    if (!it.i) noIcon.push(id);
  });
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
var stat = { specs: 0, slots: 0, rows: 0, loadouts: 0, minSlotN: Infinity, minSpecN: Infinity,
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

    // 天赋串：榜上实测 98~100% 的人带串，所以串数不该远少于人数。
    var lo = S.loadouts || [];
    stat.loadouts += lo.length;
    ck();
    if (!Array.isArray(lo)) fail('专精 ' + sid + ' 的 loadouts 不是数组');
    lo.forEach(function (s) {
      // 串是标准 base64 字母表。里头出现别的字符说明存的时候被截断或转义了。
      if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+$/.test(s)) {
        fail('专精 ' + sid + ' 有一个天赋串不是 base64：' + String(s).slice(0, 20));
      }
    });

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
  + ' 件 / ' + stat.slots + ' 部位组 / ' + stat.rows + ' 行 / ' + stat.loadouts + ' 条天赋串');
// 两个数都打出来。只打 n 会把「榜上有 100 人」说成「有 100 人的装备」——
// 那是第 13 轮真实发生过的误报。
console.log('榜单样本   每专精最少 ' + (stat.minSpecN === Infinity ? '?' : stat.minSpecN) + ' 人');
console.log('装备样本   每专精最少 ' + (stat.minGear === Infinity ? '?' : stat.minGear)
  + ' 人，合计 ' + stat.gearTotal + ' 人，每部位最少 '
  + (stat.minSlotN === Infinity ? '?' : stat.minSlotN) + ' 人');
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
