/*
 * WowAltBoard - tools/mutate-pkg.js
 *
 * 变异测试「打包一致性」那条守卫。**只在开发时用，不进发布包。**
 *
 * 为什么单独一套：这条守卫本身就是为了替代「靠我记着」而存在的，
 * 那它自己必须被证明能失败，否则只是换了个地方靠记性。
 * 这一轮它确实两次在真实使用中抓到了漏网的文件（mutate-names.js、
 * mutate-decode.js），但那是**文件**名单；缓存**目录**名单（$dropDirsFromPkg）
 * 是后加的，得单独证。
 *
 * 四个变异，两类：
 *   · $dropFromPkg 里删掉 / 拼错一个测试专用脚本 → 必须报「会被误打包」
 *   · $dropDirsFromPkg 里删掉 / 拼错一个缓存目录 → 同上
 *
 * 注意：不要用 shell 的 sed 做这种替换。名单里全是 'tools\xxx' 这种带反斜杠的
 * 字面量，bash 会把反斜杠吃掉，替换悄悄不命中，于是打出一个**假通过**。
 * 这个坑这一轮踩过一次，所以这里一律用 Node 读写，并且锚点不命中记为失败。
 *
 * 用法：node tools\mutate-pkg.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var PS = path.join(ROOT, 'tools', 'build-release.ps1');
var RUNNER = path.join(__dirname, 'run-tests.js');

function suite() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  var out = String(r.stdout || '') + String(r.stderr || '');
  var line = out.split(/\r?\n/).filter(function (l) { return /打包一致性/.test(l); })[0] || '（没有那一行）';
  return { status: r.status, line: line.trim(), out: out };
}

// [说明, 原文, 换成什么]
var MUTANTS = [
  ['名单里删掉一个变异脚本', "'tools\\mutate-decode.js'", "'tools\\SOMETHING-ELSE.js'"],
  ['名单里把脚手架拼错', "'tools\\dom-stub.js'", "'tools\\dom-stubb.js'"],
  ['缓存目录名单里删掉 .rio-raw', "'tools\\.rio-raw'", "'#'"],
  ['缓存目录名单里把 .db2-names 拼错', "'tools\\.db2-names'", "'tools\\.db2-namez'"]
];

console.log('=== 打包一致性守卫的变异测试 ===');
lock.acquire('mutate-pkg.js');
process.on('exit', lock.release);

var orig = fs.readFileSync(PS, 'utf8');
var base = suite();
if (base.status !== 0) {
  console.error('基线就不通过，先把套件跑绿再来：\n' + base.line);
  process.exit(1);
}
console.log('  基线　' + base.line);

var caught = 0, missed = [], dead = [];
try {
  MUTANTS.forEach(function (m) {
    var label = m[0], from = m[1], to = m[2];
    if (orig.indexOf(from) < 0) {
      dead.push(label);
      console.log('  锚点失效  ' + label + '（找不到 ' + JSON.stringify(from) + '）');
      return;
    }
    fs.writeFileSync(PS, orig.replace(from, to), 'utf8');
    var r;
    try { r = suite(); } finally { fs.writeFileSync(PS, orig, 'utf8'); }
    // 必须是「因为打包一致性」而失败，不是因为别的什么坏了。
    if (r.status !== 0 && /会被误打包/.test(r.out)) {
      caught++;
      console.log('  抓到  ' + label + '　→　' + r.line);
    } else if (r.status !== 0) {
      missed.push(label + '（失败了，但报的不是打包一致性）');
      console.log('  串了  ' + label + '　→　' + r.line);
    } else {
      missed.push(label + '（守卫照样通过）');
      console.log('  漏掉  ' + label);
    }
  });
} finally {
  fs.writeFileSync(PS, orig, 'utf8');
}

console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught + '，漏 ' + missed.length
  + '，锚点失效 ' + dead.length);
missed.forEach(function (s) { console.log('  · 漏：' + s); });
dead.forEach(function (s) { console.log('  · 锚点失效：' + s); });

// 还原后必须仍然通过 —— 证明 finally 真的把文件写回去了
var after = suite();
if (after.status !== 0) {
  console.error('\n还原后套件不通过了，build-release.ps1 可能没复原干净：\n' + after.line);
  process.exit(1);
}

process.exit(missed.length + dead.length ? 1 : 0);
