/*
 * WowAltBoard - tools/mutate-names.js
 *
 * 中文职业名 / 专精名断言的变异测试。
 *
 * 为什么需要它：这一组断言守的是「显示的中文名是不是真的来自暴雪的数据」，
 * 而这类断言最容易退化成空测试 —— 旧版本只查「非空」，于是英文 token 也算过，
 * 4 个职业显英文、死骑冰霜显 FROST 整整几轮都没被测出来。
 * 收紧成「必须是中文」「必须等于冰霜」之后，就得证明它们真的会失败。
 *
 * 四个变异都打在 app/class-names.js（自动生成的那份 DB2 名字表）上：
 *   1. 整个文件缺失     → run-tests.js 必须硬失败（它是硬依赖，不是可选项）
 *   2. 某个职业名变英文  → 「13 个职业全部给中文名」必须抓到
 *   3. 死骑冰霜改成冰法  → 「显示「冰霜」」必须抓到
 *   4. DB2 和存档收来的名字冲突 → 交叉校验必须抓到
 *
 * 第 4 条是最重要的：两份独立的暴雪来源（运行中客户端的存档 vs DB2 导出）
 * 一致才说明我拿的是同一份字符串。不一致的时候「显示的是中文」反而更危险。
 *
 * 用法：node tools\mutate-names.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var NAMES = path.join(ROOT, 'app', 'class-names.js');
var RUNNER = path.join(__dirname, 'run-tests.js');

// 变异会改、甚至暂时重命名磁盘上的 app/class-names.js，整个过程要独占。
lock.acquire('mutate-names');
process.on('exit', lock.release);

function run() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

// [说明, 原文, 换成什么, 期望在输出里看到的关键字]
var MUTANTS = [
  ['某个职业名退回英文', 'MAGE: "法师"', 'MAGE: "Mage"', '还在显示英文'],
  ['死骑冰霜改成法师的「冰法」', '251: ["冰霜", 6]', '251: ["冰法", 6]', '应该是「冰霜」'],
  ['DB2 和存档收来的职业名冲突', 'WARRIOR: "战士"', 'WARRIOR: "勇士"', '≠ 存档'],
  // 关键字必须是断言**真的会打印**的那句。第一版我按记忆写了「不是中文名」，
  // 结果这个变异被抓到了、但报的是另一条断言的话 —— 脚本因此报「串了」。
  // 那种情况下目标断言其实没被证明过。
  ['专精名退回英文', '256: ["戒律", 5]', '256: ["Discipline", 5]', '还在显示英文']
];

console.log('=== 中文名断言的变异测试 ===');

if (!fs.existsSync(NAMES)) {
  console.error('没有 app/class-names.js，先跑 node tools\\fetch-class-names.js');
  process.exit(1);
}
var orig = fs.readFileSync(NAMES, 'utf8');

var caught = 0, missed = [], skipped = [];

// 变异 0：文件整个不在。它是硬依赖 —— 缺了会静默退回旧兜底表（4 个职业显英文），
// 而那时候所有断言仍然「通过」，正是最难发现的假绿。
(function () {
  var hidden = NAMES + '.hidden';
  fs.renameSync(NAMES, hidden);
  var r;
  try { r = run(); } finally { fs.renameSync(hidden, NAMES); }
  if (r.status !== 0) { caught++; console.log('  抓到  DB2 名字表整个缺失'); }
  else { missed.push('DB2 名字表整个缺失'); console.log('  漏了  DB2 名字表整个缺失'); }
})();

MUTANTS.forEach(function (m) {
  var from = m[1], to = m[2], want = m[3];
  if (orig.indexOf(from) < 0) {
    skipped.push(m[0]);
    console.log('  锚点失效  ' + m[0] + '（生成的表里找不到：' + from + '）');
    return;
  }
  fs.writeFileSync(NAMES, orig.replace(from, to));
  var r;
  try { r = run(); } finally { fs.writeFileSync(NAMES, orig); }
  if (r.status === 0) {
    missed.push(m[0]);
    console.log('  漏了  ' + m[0]);
  } else if (r.out.indexOf(want) < 0) {
    // 失败了，但不是因为我想测的那条断言 —— 也算没测到。
    missed.push(m[0] + '（失败原因不是目标断言，没看到「' + want + '」）');
    console.log('  串了  ' + m[0] + '（失败了，但报的不是「' + want + '」）');
  } else {
    caught++;
    console.log('  抓到  ' + m[0]);
  }
});

console.log('\n变异 ' + (MUTANTS.length + 1) + '，抓到 ' + caught
  + '，漏 ' + missed.length + '，锚点失效 ' + skipped.length);
missed.forEach(function (s) { console.log('  · 漏：' + s); });
skipped.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + skipped.length ? 1 : 0);
