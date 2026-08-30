/*
 * WowAltBoard - tools/mutate-a11y.js
 *
 * 无障碍断言的变异测试。
 *
 * 为什么这个文件是永久的、不叫 `_muta11y.js`：变异测试脚本被临时文件清理
 * (`rm -f _*`) 吃掉过三次（第 9 轮丢了 _mutrender / _muthero / _muttree，
 * 第 11 轮丢了 _muta11y）。断言留在 run-tests.js 里，但**证明断言有效的东西**
 * 每次都得重写。改了断言或改了被断言的代码之后必须能立刻重跑，所以它得活下来。
 *
 * 做法：往源码里注入一处坏改动，跑 run-tests.js，它**必须**失败。
 * 不失败就说明那条断言是摆设。
 *
 * 用法：node tools\mutate-a11y.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var BIS = path.join(ROOT, 'app', 'bis.js');

// [说明, 目标文件, 原文, 换成什么]
var MUTANTS = [
  ['图标不写 alt（读屏会去念文件名）', BIS,
   "img.alt = '';",
   "/* mutant: alt 没了 */"],

  ['天赋树画布不给 role', BIS,
   "canvas.setAttribute('role', 'group');",
   "/* mutant: role 没了 */"],

  ['天赋树画布不给说明文字', BIS,
   "canvas.setAttribute('aria-label',",
   "canvas.setAttribute('data-mutant-label',"],

  ['轨道徽章只留 tooltip、去掉可见文字', BIS,
   "var tb = el('span', 'tag trk', tl);",
   "var tb = el('span', 'tag trk', '');"],

  ['来源徽章只留 tooltip、去掉可见文字', BIS,
   "badge.setAttribute('data-tip', srcText || '来源未知');",
   "badge.textContent = ''; badge.setAttribute('data-tip', srcText || '来源未知');"]
];

function run() {
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js')],
    { cwd: ROOT, encoding: 'utf8' });
  return r.status;
}

console.log('=== 无障碍断言的变异测试 ===');
var caught = 0, missed = [], skipped = [];

MUTANTS.forEach(function (m) {
  var file = m[1], from = m[2], to = m[3];
  var orig = fs.readFileSync(file, 'utf8');
  if (orig.indexOf(from) < 0) {
    // 锚点失效也是一种失败：它意味着这个变异什么都没测。
    skipped.push(m[0]);
    console.log('  锚点失效  ' + m[0] + '（源码里找不到：' + from.slice(0, 40) + '）');
    return;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  var status;
  try { status = run(); } finally { fs.writeFileSync(file, orig); }
  if (status !== 0) { caught++; console.log('  抓到  ' + m[0]); }
  else { missed.push(m[0]); console.log('  漏了  ' + m[0]); }
});

console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught
  + '，漏 ' + missed.length + '，锚点失效 ' + skipped.length);
missed.forEach(function (s) { console.log('  · 漏：' + s); });
skipped.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + skipped.length ? 1 : 0);
