/*
 * WowAltBoard - tools/verify-talent-decode.js
 *
 * 拿真值校验天赋导入串的解码器。**离线**：只读两份提交进仓库的文件
 * （tools/talent-truth.json + app/talent-tree.js），克隆下来就能跑。
 *
 * 为什么需要它：这个解码器我前后做了十一轮，反复「验证」过五个错的假设，
 * 每次都是拿**自我一致性**当证据（读 n 位写回 n 位、位数刚好用完），
 * 而那种检查字段含义猜错了照样通过。真正把它解开的是找到了
 * **同一个生产者给出的正确解**：raider.io 的角色 profile 里，
 * talentLoadout 既有导入串（loadout_text），又有它自己解出的节点表（loadout）。
 * 串和答案来自同一处，对不上就一定是我错了。
 *
 * 这份校验器就是把那个判据钉死，防止我下一轮又「改进」出一个假的解码器。
 * 真值由 tools/fetch-talent-truth.js 联网抓取，已提交（38 KB，不含角色名）。
 *
 * 检查四项，任一处不符就退出码 1：
 *   1. 真值里的每个节点我都要解出来（少解 = 位流读错）
 *   2. rank 一致（含 subtree 节点没有 maxRanks、真值给 1 这个特例）
 *   3. entryIndex 一致（二选一来自位流；tiered 按 entries[].maxRanks 累加推）
 *   4. granted 一致（= purchased 位的反面）
 *
 * 「我多解出、真值没有」的**不算错**，而且是预期的：raider.io 的 loadout
 * 数组不列 granted 节点。这一项只统计不判错，但会打出来 —— 如果它突然变成 0
 * 或者暴涨，说明上游改了口径。
 *
 * 用法：node tools\verify-talent-decode.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var T = require('./decode-talent-string.js');

var ROOT = path.resolve(__dirname, '..');
var TRUTH = path.join(__dirname, 'talent-truth.json');

function main() {
  if (!fs.existsSync(TRUTH)) {
    console.error('缺 tools/talent-truth.json —— 先跑 node tools\\fetch-talent-truth.js（要联网）');
    process.exit(1);
  }
  var truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  if (!truth.items || !truth.items.length) {
    console.error('talent-truth.json 里一条真值都没有，拒绝报通过。');
    process.exit(1);
  }

  var bySpec = T.loadOrder();
  if (!bySpec) {
    console.error('读不到 app/talent-tree.js 的节点顺序表 —— 先跑 node tools\\fetch-talent-tree.js');
    process.exit(1);
  }

  var tree = T.loadTree();
  var treeAt = tree ? tree.updatedAt : null;
  // 真值是照某一版天赋树抓的。树换版之后旧真值会把「版本漂移」误报成「解码错」——
  // 这不是猜的：同一批角色的赛季历史串干净 3/32，当前串干净 27/32，
  // 「历史脏→当前干净」24 人、反向 0 人。所以版本不一致要显式提醒，而不是默默判错。
  var drift = (truth.treeUpdatedAt && treeAt && truth.treeUpdatedAt !== treeAt);

  var stat = { n: 0, exact: 0, checks: 0, miss: 0, rank: 0, entry: 0, granted: 0, extra: 0 };
  var bad = [];

  truth.items.forEach(function (it) {
    var entry = bySpec[it.spec];
    if (!entry) { bad.push('specID ' + it.spec + ' 在 app/talent-tree.js 里没有'); return; }
    stat.n++;

    var d = T.decode(it.s, bySpec);
    var mine = {};
    d.nodes.forEach(function (x) { mine[x.id] = x; });

    var ok = true;
    it.n.forEach(function (row) {
      var id = row[0], rank = row[1], eidx = row[2], granted = !!row[3];
      var m = mine[id];
      stat.checks++;
      if (!m) {
        stat.miss++; ok = false;
        if (bad.length < 12) bad.push('specID ' + it.spec + ' 少解节点 ' + id);
        return;
      }
      if (m.rank !== rank) {
        stat.rank++; ok = false;
        if (bad.length < 12) bad.push('specID ' + it.spec + ' 节点 ' + id
          + ' rank 我 ' + m.rank + ' / 真值 ' + rank);
      }
      if (m.entryIndex !== eidx) {
        stat.entry++; ok = false;
        if (bad.length < 12) bad.push('specID ' + it.spec + ' 节点 ' + id
          + ' entryIndex 我 ' + m.entryIndex + ' / 真值 ' + eidx);
      }
      if (m.granted !== granted) {
        stat.granted++; ok = false;
        if (bad.length < 12) bad.push('specID ' + it.spec + ' 节点 ' + id
          + ' granted 我 ' + m.granted + ' / 真值 ' + granted);
      }
    });

    var truthIds = {};
    it.n.forEach(function (row) { truthIds[row[0]] = 1; });
    d.nodes.forEach(function (x) { if (!truthIds[x.id]) stat.extra++; });

    if (ok) stat.exact++;
  });

  var line = '天赋串解码　　　　　　';
  if (bad.length) {
    console.log(line + stat.exact + '/' + stat.n + ' 条完全一致，' + bad.length + ' 处不符');
    bad.forEach(function (b) { console.log('  · ' + b); });
    if (drift) {
      console.log('  提示：真值抓于天赋树 ' + truth.treeUpdatedAt + '，当前树是 '
        + treeAt + '。树换版了就重跑 node tools\\fetch-talent-truth.js。');
    }
    process.exit(1);
  }

  // 真空断言防护。真值文件被截短、或者上面那个 forEach 因为 specID 对不上
  // 整体跳过，都会让「0 处不符」变成一句空话。下界是照当前样本（32 条 /
  // 2406 个节点）留出余量写的，不是从测量结果反推的。
  if (stat.n < 20 || stat.checks < 1500) {
    console.log(line + '样本太少，拒绝报通过（' + stat.n + ' 条串 / '
      + stat.checks + ' 个节点，下界 20 / 1500）');
    process.exit(1);
  }

  console.log(line + '通过（' + stat.n + ' 条串 × ' + stat.checks
    + ' 个节点真值：少解 0，rank 0，entryIndex 0，granted 0；'
    + '多解 ' + stat.extra + ' 个是 raider.io 不列的 granted 节点）');
  if (drift) {
    console.log('  注意：真值抓于天赋树 ' + truth.treeUpdatedAt + '，当前树是 ' + treeAt
      + ' —— 版本不同却仍然全对，说明这些节点没被改动。');
  }
  return 0;
}

module.exports = { main: main };
if (require.main === module) main();
