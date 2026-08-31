/*
 * WowAltBoard - tools/mutate-decode.js
 *
 * 变异测试 tools/verify-talent-decode.js 那组断言。
 *
 * 为什么值得单独一个脚本：这个解码器我前后「验证」过五个错的假设，每一次都拿
 * 自我一致性当证据。现在换成了真值判据（raider.io 同时给串和它自己解出的节点表），
 * 但「有真值」不等于「断言真的在看真值」—— 校验器少写一个字段、或者 forEach
 * 整体跳过，输出照样是「0 处不符」。所以往解码器里注入已知的错，一个都不许漏。
 *
 * 六个变异：
 *   1. LAYOUT_NEST 翻成 false（partial/choice 不再嵌在 purchased 里）—— 整条位流错位
 *   2. RANK_BITS 从 6 改成 4 —— 点数位宽错，rank 和后续全歪
 *   3. granted 不取反（granted = purchased）—— 只有这一个字段错
 *   4. subtree 节点的 rank 兜底从 1 改回 undefined —— 33 个英雄节点的 rank 错
 *   5. entryIndexOf 永远返回 0 —— tiered 节点的 entryIndex 错
 *   6. 真值文件截成 1 条 —— 校验器必须因为「样本太少」拒绝报通过
 *
 * 第 6 个变异守的是真空断言：没有它，一份被截断的真值会让校验器一路绿灯。
 *
 * 用法：node tools\mutate-decode.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var DEC = path.join(__dirname, 'decode-talent-string.js');
var TRUTH = path.join(__dirname, 'talent-truth.json');
var VERIFIER = path.join(__dirname, 'verify-talent-decode.js');

// 变异会改磁盘上的 decode-talent-string.js 和 talent-truth.json，整个过程要独占。
lock.acquire('mutate-decode');
process.on('exit', lock.release);

function runVerifier() {
  var r = cp.spawnSync(process.execPath, [VERIFIER],
    { encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

// [说明, 目标文件, 原文, 换成什么, 期望在输出里看到的关键字]
var MUTANTS = [
  ['布局改成不嵌套（partial/choice 不看 purchased）', DEC,
   'var LAYOUT_NEST = true;', 'var LAYOUT_NEST = false;', '不符'],
  ['点数位宽从 6 改成 4', DEC,
   'var RANK_BITS = 6;', 'var RANK_BITS = 4;', '不符'],
  ['granted 不再取 purchased 的反面', DEC,
   'rec.granted = !rec.purchased;', 'rec.granted = rec.purchased;', 'granted'],
  ['subtree 节点的 rank 兜底去掉', DEC,
   "rec.rank = (typeof rec.maxRanks === 'number') ? rec.maxRanks : 1;",
   'rec.rank = rec.maxRanks;', 'rank'],
  ['entryIndex 永远返回 0', DEC,
   '  if (rec.choice !== null) return rec.choice;',
   '  if (rec.choice !== null) return rec.choice;\n  return 0;', 'entryIndex'],
  ['真值文件截成 1 条', TRUTH, null, null, '样本太少']
];

console.log('=== 天赋串解码断言的变异测试 ===');

[DEC, TRUTH, VERIFIER].forEach(function (f) {
  if (!fs.existsSync(f)) {
    console.error('缺 ' + path.basename(f) + '，跑不了。');
    process.exit(1);
  }
});

// 先确认没变异时是通过的。否则后面每一个「抓到」都可能是别的原因造成的。
var base = runVerifier();
if (base.status !== 0) {
  console.error('没变异时校验器就不通过，先修它：');
  console.error(base.out.trim());
  process.exit(1);
}

var caught = 0, missed = [], deadAnchor = [];
var origDec = fs.readFileSync(DEC, 'utf8');
var origTruth = fs.readFileSync(TRUTH, 'utf8');

try {
  MUTANTS.forEach(function (m) {
    var label = m[0], file = m[1], from = m[2], to = m[3], want = m[4];

    if (file === TRUTH) {
      // 真值截断：留 1 条
      var t = JSON.parse(origTruth);
      t.items = t.items.slice(0, 1);
      fs.writeFileSync(TRUTH, JSON.stringify(t), 'utf8');
    } else {
      var src = fs.readFileSync(file, 'utf8');
      if (src.indexOf(from) < 0) {
        // 锚点失效 = 这个变异根本没打上，等于没测。必须报成问题，不能算通过。
        deadAnchor.push(label);
        console.log('  锚点失效  ' + label + '（在 ' + path.basename(file) + ' 里找不到原文）');
        return;
      }
      fs.writeFileSync(file, src.replace(from, to), 'utf8');
    }

    var r = runVerifier();
    // 还原后再判，免得判定逻辑抛异常时留下脏文件
    fs.writeFileSync(DEC, origDec, 'utf8');
    fs.writeFileSync(TRUTH, origTruth, 'utf8');

    if (r.status !== 0 && r.out.indexOf(want) >= 0) {
      caught++;
      console.log('  抓到  ' + label);
    } else if (r.status !== 0) {
      missed.push(label + '（失败了，但报的不是目标断言，没看到「' + want + '」）');
      console.log('  串了  ' + label);
    } else {
      missed.push(label + '（校验器照样通过）');
      console.log('  漏掉  ' + label);
    }
  });
} finally {
  fs.writeFileSync(DEC, origDec, 'utf8');
  fs.writeFileSync(TRUTH, origTruth, 'utf8');
}

console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught + '，漏 ' + missed.length
  + '，锚点失效 ' + deadAnchor.length);
missed.forEach(function (m) { console.log('  · 漏：' + m); });
deadAnchor.forEach(function (m) { console.log('  · 锚点失效：' + m); });

// 还原后必须仍然通过 —— 证明上面的 finally 真的把文件复原了
var after = runVerifier();
if (after.status !== 0) {
  console.error('\n还原后校验器不通过了，文件可能没复原干净：');
  console.error(after.out.trim());
  process.exit(1);
}

if (missed.length || deadAnchor.length) process.exit(1);
