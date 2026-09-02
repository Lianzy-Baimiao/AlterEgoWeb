/*
 * WowAltBoard - tools/check-lazyload.js
 *
 * 按**真实的点击顺序**走一遍面板的懒加载，看该拉的文件有没有真的被拉。
 *
 * 为什么要单独一个脚本
 * ------------------
 * tools/run-tests.js 那个 env 把 8 个数据文件全部**预载**了（那是故意的：
 * 「因为没数据所以跳过」的测试报成通过，是最难发现的假绿）。代价是它**看不见
 * 「该拉的没拉」**这一类洞 —— 文件早就在内存里，谁都不用请求。
 * 而 dom-stub 的 env 共用同一个 global，没法在同一个进程里再开一个干净的，
 * 所以这一关单独一个进程跑。
 *
 * 第 21 轮它对应的真 bug
 * --------------------
 * 用户报「天赋图标的鼠标指向没有说明信息了」。真因在 app/bis.js 的 ensureTalents()：
 * 装备页（**默认那一页**）自己会拉 talent-tree.js，等用户切到天赋页时
 * AE_TALENT_TREE 已经在内存里，那条早退直接 return —— 而 ensureTalentDesc()
 * 只写在下面那个 loadDataFile 的回调里，于是 app/talent-desc.js 一次都不会被请求，
 * 99 个天赋节点的提示里只剩名字。
 * 「先开天赋页」那条路一直是好的，所以怎么点决定了会不会踩到。
 *
 * 用法：node tools\check-lazyload.js        （退出码非 0 = 有问题）
 */
'use strict';

var path = require('path');
var fs = require('fs');
var stub = require('./dom-stub.js');

var ROOT = stub.ROOT;
var problems = [];

if (!fs.existsSync(path.join(ROOT, 'data', 'data.js'))) {
  console.log('没有 data/data.js —— 跳过（这一关要真实角色数据）');
  console.log('合计 请求 0 组，问题 0');
  process.exit(0);
}

var env = stub.makeEnv(['bis', 'bis-sub', 'bis-body']);
var g = env.g, doc = env.doc;

// index.html 里**同步加载**的那一批。数据文件一个都不预载 —— 那正是重点。
['app/class-names.js', 'app/lua-parser.js', 'app/labels.js', 'app/model.js',
 'app/settings.js', 'app/columns.js', 'app/layouts.js', 'app/export.js',
 'app/talent-decode.js', 'app/history.js', 'app/bis.js'].forEach(function (f) {
  env.load(f);
});
env.load('data/data.js');
g.AE.openPanel = function () {}; g.AE.closeAllPanels = function () {};
g.AE.saveSettings = function () {}; g.AE.toast = function () {};

// 把 <script src> 真的接上：加载文件 + 触发 onload —— 也就是浏览器干的事。
var reqs = [];
var head = doc.head, origAppend = head.appendChild.bind(head);
head.appendChild = function (n) {
  if (n && n.src) {
    reqs.push(n.src);
    try { env.load(n.src); } catch (e) { /* 让 onload 里「没赋值」那支去处理 */ }
    if (typeof n.onload === 'function') n.onload();
  }
  return origAppend(n);
};

function walk(n, fn) { fn(n); (n.children || []).forEach(function (c) { walk(c, fn); }); }

var settings = {};
var model = g.AE.buildModel(g.AE_DATA, settings) || { characters: [] };
g.AE.state = { settings: settings, model: model };
var B = g.AE_BIS;

// ---- 第一次点开：默认是**装备页**。
settings.bisTab = 'gear';
g.AE.openBis();
// bis-data.js 得先到，否则拿不到专精列表（面板自己也要它）
if (!g.AE_BIS) {
  problems.push('开装备页之后 app/bis-data.js 还没到 —— 面板的第一份数据都没拉');
}
B = g.AE_BIS || { specs: {} };
settings.bisSpec = Object.keys(B.specs)[0] || '';
g.AE.openBis();
var gearReqs = reqs.slice();
reqs.length = 0;

// 装备页**本来就会**把 talent-tree.js 拉下来（maxroll 那一路要它解串）。
// 这是下面那条断言的前提，所以钉住它：哪天装备页不再拉树，这一关就该重新想判据，
// 而不是默默变成空转。
if (gearReqs.indexOf('app/talent-tree.js') < 0) {
  problems.push('装备页没有拉 app/talent-tree.js —— 这一关的前提变了'
    + '（它验的是「树已经在内存里时，说明文字还会不会拉」）。装备页拉的是：'
    + gearReqs.join(', '));
}

// ---- 点「天赋」页签。**不是改 settings 再 openBis()** —— gearLoaded 之后
// openBis 直接 render()，不会重读 bisTab，那条路测不到切页。
var body = doc.getElementById('bis-body');
var tabBtn = null;
walk(body, function (n) {
  if (!tabBtn && n.tagName === 'BUTTON' && /^天赋$/.test(String(n.textContent || '').trim())) {
    tabBtn = n;
  }
});
if (!tabBtn) {
  problems.push('装备页上找不到「天赋」页签按钮 —— 这一关跑不动');
} else {
  tabBtn.click();
}

if (reqs.indexOf('app/talent-desc.js') < 0) {
  problems.push('先开装备页再切天赋页，app/talent-desc.js **一次都没被请求** ——'
    + ' 天赋图标的悬停提示里就只有名字，没有天赋原本的说明。'
    + '切页后请求的是：' + (reqs.join(', ') || '无'));
}

var nodes = 0, withDesc = 0;
walk(body, function (n) {
  if (!n.classList || !n.classList.contains('tnode')) return;
  nodes++;
  // 说明是缩两个全角空格挂在名字下面的（见 app/bis.js 的 renderTreeGrid）。
  if (/　　/.test((n.attrs || {})['data-tip'] || '')) withDesc++;
});
if (nodes < 50) {
  problems.push('切到天赋页后只画出 ' + nodes + ' 个天赋节点，太少 —— 树没画出来？');
} else if (withDesc !== nodes) {
  problems.push(nodes + ' 个天赋节点里只有 ' + withDesc + ' 个的悬停提示带说明');
}

console.log('');
console.log('装备页拉了 ' + gearReqs.length + ' 个文件：' + gearReqs.join(', '));
console.log('切到天赋页又拉了 ' + reqs.length + ' 个：' + (reqs.join(', ') || '无'));
console.log('天赋节点 ' + nodes + ' 个，悬停提示带说明的 ' + withDesc + ' 个');
console.log('');
if (problems.length) {
  console.log('有问题 ' + problems.length + ' 条：');
  problems.forEach(function (p) { console.log('  · ' + p); });
}
console.log('合计 请求 ' + (gearReqs.length + reqs.length) + ' 组，问题 ' + problems.length);
process.exit(problems.length ? 1 : 0);
