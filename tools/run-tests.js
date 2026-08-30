/*
 * WowAltBoard - tools/run-tests.js
 *
 * 命令行跑全部测试。tests.html 需要开浏览器点一下，这个不用：
 *
 *     node tools\run-tests.js
 *
 * 跑三件事：
 *   1. app/parser-tests.js  解析器
 *   2. app/model-tests.js   数据模型（要 data/data.js，没有就跳过并说明）
 *   3. app/bis-tests.js     毕业装备数据
 *   4. 渲染检查             把每个专精每种视图都真画一遍，检查图标进没进 DOM
 *
 * 第 4 项是命令行独有的 —— 浏览器里没法检查 app/icons/ 下的文件在不在。
 *
 * 退出码非 0 = 有失败。
 *
 * 为什么渲染检查里的断言写得那么死（占位块必须是 0、img 数必须过 5000）
 * ------------------------------------------------------------------
 * 第一版只统计不断言。我把 AE_ITEM_ICONS 换成 {} 做变异测试，占位块从 0 涨到
 * 3963，它照样打印「通过」—— 一个永远通过的检查等于没有检查。所以这些数字是
 * 硬门槛，数据变了要连带改这里，那正是希望发生的事。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var stub = require('./dom-stub.js');

var ROOT = stub.ROOT;
var env = stub.makeEnv(['bis', 'bis-sub', 'bis-body']);
var g = env.g;
var doc = env.doc;

function load(f) {
  var p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return false;
  env.load(f);
  return true;
}

// 顺序照抄 tests.html。data/ 下两个是扫描产物，可能不存在。
['app/lua-parser.js', 'app/parser-tests.js', 'app/labels.js', 'app/model.js',
 'app/settings.js', 'app/columns.js', 'app/layouts.js', 'app/model-tests.js',
 'app/export.js', 'app/bis.js', 'app/bis-tests.js'].forEach(function (f) {
  if (!load(f)) throw new Error('缺文件：' + f);
});

// 数据文件。bis-data / talent-data / item-icons 在浏览器里是懒加载的，但测试里
// 必须显式加载 —— 「因为没数据所以跳过」的测试报成通过，是最难发现的假绿。
['app/bis-data.js', 'app/talent-data.js', 'app/item-icons.js'].forEach(function (f) {
  if (!load(f)) throw new Error('缺文件：' + f + '（先跑对应的 tools\\gen-*.js / fetch-icons.js）');
});
var haveScan = load('data/data.js');
load('data/bagsync.js');

g.AE.openPanel = function () {};
g.AE.closeAllPanels = function () {};
g.AE.saveSettings = function () {};
g.AE.toast = function () {};

var settings = g.AE.defaultSettings ? g.AE.defaultSettings() : {};
var model = { characters: [] };
if (haveScan && g.AE.buildModel && g.AE_DATA) {
  try { model = g.AE.buildModel(g.AE_DATA, settings) || model; } catch (e) { /* 模型测试自己会报 */ }
}
g.AE.state = { settings: settings, model: model };

// ----------------------------------------------------------------- 跑测试套件

var total = { pass: 0, fail: 0 };
var failures = [];

function suite(name, fn) {
  if (!fn) { console.log(pad(name) + '没有这个套件'); return; }
  var r = fn();
  if (r.skipped) {
    console.log(pad(name) + '跳过（' + (r.reason || '缺数据') + '）');
    return;
  }
  total.pass += r.pass;
  total.fail += r.fail;
  console.log(pad(name) + r.pass + ' 通过' + (r.fail ? '，' + r.fail + ' 失败' : ''));
  (r.results || []).forEach(function (x) {
    if (!x.ok) failures.push(name + '：' + x.name + (x.detail ? ' —— ' + x.detail : ''));
  });
}

function pad(s) { return (s + '　　　　　　').slice(0, 12); }

console.log('');
suite('解析器', g.AE.runParserTests);
suite('数据模型', g.AE.runModelTests);
suite('毕业装备', g.AE.runBisTests);

// ------------------------------------------------------------------- 渲染检查

function walk(node, fn) {
  fn(node);
  node.children.forEach(function (c) { walk(c, fn); });
}

var B = g.AE_BIS;
var specKeys = Object.keys(B.specs);
var problems = [];
var stats = { renders: 0, imgs: 0, ph: 0, badSrc: 0 };
var missingFiles = {};
var body = doc.getElementById('bis-body');

function checkRender(label) {
  stats.renders++;
  var sawItem = false;
  walk(body, function (n) {
    if (n.classList && n.classList.contains('item')) sawItem = true;
    if (n.tagName === 'IMG') {
      stats.imgs++;
      var src = n.attrs.src || n.src || '';
      if (!src) { stats.badSrc++; problems.push(label + ' img 没有 src'); return; }
      if (src.indexOf('app/icons/') !== 0) {
        problems.push(label + ' img src 不指向本地图标：' + src);
        return;
      }
      if (!fs.existsSync(path.join(ROOT, src))) missingFiles[src] = 1;
    }
    if (n.classList && n.classList.contains('ph')) stats.ph++;
  });
  if (!sawItem) problems.push(label + ' 一件装备都没画出来');
}

// openBis() 只在第一次调用时读设置（之后 gearLoaded 为真就直接 render），
// 所以每换一个组合都要重新 eval bis.js，否则 80 次渲染画的是同一个专精。
specKeys.forEach(function (key) {
  ['raid', 'mplus'].forEach(function (view) {
    settings.bisTab = 'gear';
    settings.bisSpec = key;
    settings.bisView = view;
    settings.bisChar = '';
    body.children.length = 0;
    load('app/bis.js');
    g.AE.openBis();
    checkRender(key + '/' + view);
  });
});

['raid', 'mplusHigh', 'mplusFarm'].forEach(function (cat) {
  settings.bisTab = 'talents';
  settings.bisSpec = specKeys[0];
  settings.bisTalentCat = cat;
  body.children.length = 0;
  load('app/bis.js');
  g.AE.openBis();
  stats.renders++;
});

var IC = g.AE_ITEM_ICONS || {};
var gearIds = Object.keys(B.items);
var haveIcon = gearIds.filter(function (id) { return IC[id]; });
var haveFile = haveIcon.filter(function (id) {
  return fs.existsSync(path.join(ROOT, 'app', 'icons', IC[id] + '.jpg'));
});

var mf = Object.keys(missingFiles);
if (stats.renders < 80) problems.push('渲染次数只有 ' + stats.renders + '，harness 没跑起来');
if (stats.imgs < 5000) problems.push('<img> 只有 ' + stats.imgs + ' 个，图标没接上');
if (stats.ph > 0) problems.push('出现 ' + stats.ph + ' 个占位块，说明有 itemId 查不到图标');
if (stats.badSrc > 0) problems.push(stats.badSrc + ' 个 <img> 没有 src');
if (mf.length) problems.push('引用了 ' + mf.length + ' 个不存在的图标文件：' + mf.slice(0, 5).join(', '));
if (haveIcon.length !== gearIds.length) {
  problems.push('装备图标名覆盖 ' + haveIcon.length + '/' + gearIds.length + '，不是全覆盖');
}
if (haveFile.length !== gearIds.length) {
  problems.push('装备图标文件覆盖 ' + haveFile.length + '/' + gearIds.length + '，不是全覆盖');
}

console.log(pad('渲染检查') + (problems.length ? problems.length + ' 个问题' : '通过')
  + '（' + stats.renders + ' 次渲染，' + stats.imgs + ' 个图标，占位块 ' + stats.ph + '）');

// ----------------------------------------------------------------------- 汇总

console.log('');
if (failures.length) {
  console.log('失败的测试：');
  failures.forEach(function (f) { console.log('  · ' + f); });
}
if (problems.length) {
  console.log('渲染问题：');
  problems.slice(0, 20).forEach(function (p) { console.log('  · ' + p); });
}

var bad = total.fail + problems.length;
console.log(bad === 0
  ? '全部通过：' + total.pass + ' 项测试 + 渲染检查'
  : '有问题：' + total.fail + ' 项测试失败，' + problems.length + ' 个渲染问题');
process.exit(bad === 0 ? 0 : 1);
