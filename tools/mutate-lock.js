/*
 * WowAltBoard - tools/mutate-lock.js
 *
 * 变异测试和测试套件之间的互斥锁。**只在开发时用，不进发布包。**
 *
 * 为什么需要它：变异测试是**在磁盘上真的改源文件**再跑一遍套件，改完还原。
 * 所以它和 run-tests.js 天生不能并行 —— 我自己踩过：把
 * `node tools\run-tests.js` 和三个 mutate 脚本放进同一个并行块，
 * 套件读到的是被变异工具删掉 `img.alt = ''` 之后的 app/bis.js，
 * 于是报出「7947 个 <img> 没有 alt」，而同一次输出里 mutate-a11y 又是 5/5 通过。
 * 两个结论互斥，真相是竞争。查了一轮才确认源文件没坏。
 *
 * 靠记性记住「别并行跑」是不够的（这个项目里靠记性的规矩已经失手四次）。
 * 所以：变异工具开跑时占锁，退出时（含异常）释放；套件发现锁就直接报错，
 * 说清是竞争而不是缺陷。锁文件带 pid 和时间，方便看是谁占着。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var LOCK = path.join(__dirname, '.mutating.lock');

/** 占锁。已经有人占着就直接退出（退出码 1），不覆盖别人的锁。 */
function acquire(who) {
  if (fs.existsSync(LOCK)) {
    var txt = '';
    try { txt = fs.readFileSync(LOCK, 'utf8'); } catch (e) { /* 读不到就算了 */ }
    console.error('已经有变异测试在跑：' + txt.trim());
    console.error('变异测试会改磁盘上的源文件，不能两个同时跑。等它跑完，'
      + '或者确认是残留后删掉 tools/.mutating.lock。');
    process.exit(1);
  }
  fs.writeFileSync(LOCK, who + ' pid=' + process.pid + ' ' + new Date().toISOString(), 'utf8');
}

/** 释放锁。反复调用无害。 */
function release() {
  try { fs.unlinkSync(LOCK); } catch (e) { /* 本来就没有 */ }
}

/** 套件用：锁在不在。在就说明有变异工具正在改源文件。 */
function held() {
  if (!fs.existsSync(LOCK)) return null;
  try { return fs.readFileSync(LOCK, 'utf8').trim(); } catch (e) { return '（读不到锁文件内容）'; }
}

/**
 * 变异工具 spawn 子进程时用这个 env。
 *
 * 关键：变异工具自己**就是**要 spawn 套件的那个人，所以套件不能一见锁就报错，
 * 否则变异测试一个都跑不起来。用这个标记区分「我父进程就是变异工具」（正常）
 * 和「另一个进程同时在跑」（竞争，要报错）。
 */
function childEnv() {
  var e = {};
  Object.keys(process.env).forEach(function (k) { e[k] = process.env[k]; });
  e.AE_MUTATING = '1';
  return e;
}

/**
 * 套件用：确认没有别人正在改磁盘上的源文件。
 * 有锁而且自己不是变异工具的子进程 → 这一次的所有读数都不可信，直接退出。
 */
function assertNotMutating() {
  if (process.env.AE_MUTATING === '1') return;
  var who = held();
  if (!who) return;
  console.error('拒绝跑：有变异测试正在改磁盘上的源文件（' + who + '）。');
  console.error('这时候的读数全都不可信 —— 我踩过一次，套件报「7947 个 <img> 没有 alt」，');
  console.error('同一次输出里 mutate-a11y 又是 5/5 通过，两个结论互斥，真相是竞争。');
  console.error('等变异测试跑完再来；确认是残留就删掉 tools/.mutating.lock。');
  process.exit(1);
}

module.exports = {
  acquire: acquire, release: release, held: held,
  childEnv: childEnv, assertNotMutating: assertNotMutating, LOCK: LOCK
};
