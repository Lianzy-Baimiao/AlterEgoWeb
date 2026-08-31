/*
 * WowAltBoard - tools/mutate-pool.js
 *
 * 「并发池」那条回归测试的变异测试。**只在开发时用，不进发布包。**
 *
 * 起因（值得记下来）：fetch-rio.js 的 pool() 有一个**只在缓存全命中时才炸**的坑。
 * worker 平时是异步回调（发请求），缓存命中时**同步**就回调了，于是 next() 在同步
 * 回调里再调 next()，栈深度跟条目数同阶。实测 `--offline` 跑 3994 个角色，
 * 到第 1539 个 Maximum call stack size exceeded ——
 * **缓存越全越容易崩**，而「全用缓存」正是这套缓存存在的理由（断点续抓、离线重新产出）。
 * 这个坑在 HEAD 上就有，不是本轮改出来的；它一直没被发现，是因为平时都在联网抓，
 * 每条都走异步分支。
 *
 * 这套变异测试要证明的是：套件里那条「并发池」不是摆设。
 * 和 mutate-icons.js 一样严一档 —— **每个变异体必须让指定的那句话出现在输出里**，
 * 光「退出码非 0」不算抓到（本轮就踩过一次「变异被别的断言抓走」）。
 *
 * 用法：node tools\mutate-pool.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var RIO = path.join(__dirname, 'fetch-rio.js');
var RUNNER = path.join(__dirname, 'run-tests.js');

lock.acquire('mutate-pool');
process.on('exit', lock.release);

function run() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// [说明, 怎么改, 输出里必须出现的那句话]
// 锚点必须**正好出现一次**：出现 0 次是死锚点（改了名还当通过就是假绿），
// 出现多次说明我改的地方不止一处，读数不可信。两种都算失败。
function textMutant(desc, file, from, to, want) {
  return {
    desc: desc, want: want,
    apply: function () {
      var orig = fs.readFileSync(file, 'utf8');
      var hits = orig.split(from).length - 1;
      if (hits !== 1) return { dead: true, hits: hits };
      fs.writeFileSync(file, orig.replace(from, to));
      return { restore: function () { fs.writeFileSync(file, orig); } };
    }
  };
}

var MUTANTS = [
  // 这一条就是那个真实的坑本身：把防递归守卫拿掉，pool 回到 HEAD 的行为。
  textMutant('拿掉防递归守卫（还原成会炸栈的旧实现）', RIO,
    'if (inLoop) { again = true; return; }',
    'if (false) { again = true; return; }',
    '这正是「缓存全命中导致栈溢出」那个坑'),

  // done 提前一条就调 —— 栈没炸、条目也走全了，只有 doneCount 那条断言能抓。
  // 它存在的理由：证明「不炸栈」之外的三条断言不是陪衬。
  textMutant('done 提前一条就调（只有 done 计数能抓）', RIO,
    'if (finished === items.length) { done(); return; }',
    'if (finished >= items.length - 1) { done(); return; }',
    'done 调了'),

  // 并发度不生效：一次全派出去。同步那一路照样绿，只有异步那一路能抓。
  textMutant('并发上限失效（一次全派出去）', RIO,
    'while (active < n && i < items.length) {',
    'while (i < items.length) {',
    '实际派出'),

  // 空转守卫：把 pool 的导出去掉，回归测试就压不到任何东西。
  // 没有这一条，「删掉导出」会让那条测试静默变成一句「没有 pool」而不报错。
  textMutant('不导出 pool（证明「压不到东西」会报错）', RIO,
    '  pool: pool\n};',
    '  poolDisabled: pool\n};',
    '没有导出 pool()'),

  // 下限守卫本身也要被证明：把 N 调到坑够不到的地方。
  // 「不炸栈」在 100 条的时候本来就不炸 —— 这条断言必须自己拦住这种缩水。
  textMutant('把压力条目数调到 100（证明下限守卫不是空的）', RUNNER,
    'var N = 5000, checks = 0;',
    'var N = 100, checks = 0;',
    '压不到那个坑')
];

console.log('=== 并发池断言的变异测试 ===');

// 先确认基线是绿的。基线红的时候，「变异被抓到」什么都不能证明。
var base = run();
if (base.status !== 0) {
  console.log('基线就是红的，变异测试没有意义。先把套件修绿。');
  console.log(base.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log('基线通过。');

var caught = 0, missed = [], dead = [], wrong = [];

MUTANTS.forEach(function (m) {
  var a = m.apply();
  if (a.dead) {
    dead.push(m.desc + '（锚点出现 ' + a.hits + ' 次，必须正好 1 次）');
    console.log('  锚点失效  ' + m.desc + '：出现 ' + a.hits + ' 次');
    return;
  }
  var r;
  try { r = run(); } finally { a.restore(); }
  if (r.status === 0) {
    missed.push(m.desc);
    console.log('  漏了  ' + m.desc);
  } else if (r.out.indexOf(m.want) < 0) {
    // 抓到了，但不是这条断言抓的 —— 被测的那条依然没被证明。
    wrong.push(m.desc + '（没出现「' + m.want + '」）');
    console.log('  串了  ' + m.desc + '：输出里没有「' + m.want + '」');
  } else {
    caught++;
    console.log('  抓到  ' + m.desc + '　→「' + m.want + '」');
  }
});

// 还原干净吗？变异测试自己留下垃圾是最难查的一类问题。
var after = run();
console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught + '，漏 ' + missed.length
  + '，串 ' + wrong.length + '，锚点失效 ' + dead.length
  + '；还原后套件 ' + (after.status === 0 ? '仍然通过' : '没恢复（有问题）'));
missed.forEach(function (s) { console.log('  · 漏：' + s); });
wrong.forEach(function (s) { console.log('  · 串：' + s); });
dead.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + wrong.length + dead.length || after.status !== 0 ? 1 : 0);
