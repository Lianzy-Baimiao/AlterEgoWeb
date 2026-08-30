/*
 * WowAltBoard - tools/run-tests.js
 *
 * 命令行跑全部测试。tests.html 需要开浏览器点一下，这个不用：
 *
 *     node tools\run-tests.js
 *
 * 跑五件事：
 *   1. app/parser-tests.js  解析器
 *   2. app/model-tests.js   数据模型（要 data/data.js，没有就跳过并说明）
 *   3. app/bis-tests.js     毕业装备数据
 *   4. 渲染检查             把每个专精每种视图都真画一遍，检查图标进没进 DOM
 *   5. 数据格式             跑两个校验器：
 *                             tools\verify-bis-data.js    验 app/bis-data.js
 *                             tools\verify-talent-tree.js 验 app/talent-tree.js
 *                             （后者顺带交叉验证 app/talent-data.js）
 *
 * 第 4、5 项是命令行独有的 —— 浏览器里没法检查 app/icons/ 下的文件在不在，
 * 也没法跑另一个 Node 脚本。
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
['app/bis-data.js', 'app/talent-data.js', 'app/talent-tree.js',
 'app/item-icons.js'].forEach(function (f) {
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
var stats = { renders: 0, imgs: 0, ph: 0, badSrc: 0, trk: 0, trkBad: 0, cov: 0, covBad: 0, slots: 0,
              // 天赋树
              tgrids: 0, tnodes: 0, tnodeOn: 0, tedges: 0, tedgeOn: 0,
              tnoName: 0, tnoCJK: 0, tRank: 0, tRankBad: 0, tspecs: 0, tEmpty: 0,
              trenders: 0, tdup: 0, tnoId: 0, tgeo: 0, tSpill: 0, tOverlap: 0, thero: 0, theroEn: 0,
              tmaxCol: 0, tmaxRow: 0, tCluster: 0,
              // 无障碍
              a11yImg: 0, a11yBtn: 0, a11yBtnBad: 0, a11yTip: 0, a11yTipBad: 0,
              a11yCanvas: 0, a11yCanvasBad: 0 };
var missingFiles = {};
var body = doc.getElementById('bis-body');

// 无障碍检查。这一组和渲染检查分开数，因为它们盯的是不同的东西：
// 渲染检查问「画出来了吗」，这一组问「画出来的东西，看不见屏幕的人能不能用」。
//
// 之前这里一条都没有，而且我第一次量的时候被自己的桩骗了：
// `img.alt = ''` 是**属性赋值**，桩当时不把属性映射到 attrs，于是 621 张图
// 全被报成「没有 alt」。桩已经补上映射（见 dom-stub.js 的 REFLECT），
// 这几条断言才有意义 —— 否则它们量的是桩，不是应用。
function checkA11y(n, label) {
  if (n.tagName === 'IMG') {
    // 装备图标是装饰性的（旁边就是装备中文名），所以正确写法是 alt=""，
    // 也就是「有这个属性、值为空」。缺属性和 alt="" 是两件事：
    // 缺属性时读屏软件会去念文件名。
    if (n.attrs.alt == null) {
      stats.a11yImg++;
      if (stats.a11yImg < 4) problems.push(label + ' <img> 没有 alt 属性：' + (n.attrs.src || '?'));
    }
  }
  if (n.tagName === 'BUTTON') {
    stats.a11yBtn++;
    if (!n.textContent && !n.attrs['aria-label']) {
      stats.a11yBtnBad++;
      if (stats.a11yBtnBad < 4) problems.push(label + ' <button> 既没文字也没 aria-label');
    }
  }
  // data-tip 是补充信息，不是元素的名字 —— 所以带 data-tip 的元素自己必须有
  // 可见文字。实测 2386/2386 都有，写成硬断言把这一点钉住：
  // 哪天有人把某处的可见文字换成「只有 tooltip」，读屏用户就什么都读不到。
  if (n.attrs['data-tip'] != null) {
    stats.a11yTip++;
    if (!n.textContent && !n.attrs['aria-label']) {
      stats.a11yTipBad++;
      if (stats.a11yTipBad < 4) {
        problems.push(label + ' 带 data-tip 但自己没有可见文字：' + n.attrs['data-tip'].split('\n')[0]);
      }
    }
  }
  // 天赋树画布是一堆绝对定位的 div 拼出来的图。没有 role 和说明的话，
  // 读屏软件只会念到一串互不相干的天赋名，读不出「这是一棵树、点了多少」。
  if (n.classList && n.classList.contains('tree-canvas')) {
    stats.a11yCanvas++;
    if (n.attrs.role !== 'group' || !n.attrs['aria-label']) {
      stats.a11yCanvasBad++;
      if (stats.a11yCanvasBad < 4) {
        problems.push(label + ' 天赋树画布没有 role=group + aria-label');
      }
    }
  }
}

function checkRender(label) {
  stats.renders++;
  var sawItem = false;
  walk(body, function (n) {
    checkA11y(n, label);
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
    // 轨道徽章。数据里有轨道码不等于画出来了 —— 这一条盯的是渲染。
    if (n.classList && n.classList.contains('trk')) {
      stats.trk++;
      // 形如「英雄 6/6」：中文轨道名 + 空格 + 等级/6
      if (!/^\S+ [1-6]\/6$/.test(n.textContent)) {
        stats.trkBad++;
        if (stats.trkBad < 4) problems.push(label + ' 轨道徽章文字不对：' + n.textContent);
      }
    }
    // 覆盖率徽章。每个部位组都该有一个，形如「记录 95.9%」。
    if (n.classList && n.classList.contains('slot-head')) stats.slots++;
    if (n.classList && n.classList.contains('cov')) {
      stats.cov++;
      if (!/^记录 \d+(\.\d)?%$/.test(n.textContent)) {
        stats.covBad++;
        if (stats.covBad < 4) problems.push(label + ' 覆盖率徽章文字不对：' + n.textContent);
      }
    }
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

// .tnode 的方块尺寸从 style.css 里读，不写死在这里。
// 写死的话改了 CSS 而忘了改这里，几何检查就会拿着旧尺寸算，算出来的「不重叠」
// 是假的。从样式表里读等于让这一条自动跟着 CSS 走。
var NODE_BOX = (function () {
  var css = fs.readFileSync(path.join(ROOT, 'app', 'style.css'), 'utf8');
  var m = /\.tnode\s*\{[^}]*?width:\s*(\d+)px;\s*height:\s*(\d+)px/.exec(css);
  if (!m) throw new Error('style.css 里读不到 .tnode 的宽高，几何检查没法做');
  return { w: Number(m[1]), h: Number(m[2]) };
})();

// 聚类容差。bis.js 里是 GRID_TOL = 100，这里**独立写一遍**而不是从那边读 ——
// 从被测代码里读参数，等于用被测代码验证自己，改成 0 也照样「一致」。
// 写死在这里的效果是：谁改了 bis.js 的容差，这一条就会红，逼他明确决定。
var GRID_TOL_EXPECT = 100;
var TREE = g.AE_TALENT_TREE || null;

// 天赋树的渲染检查。以前这里只 renders++、什么都不断言 —— 那是假绿：
// 树画不出来照样通过。现在每个专精都画一遍，并数出节点 / 连线 / 中文名。
function checkTalents(label) {
  stats.renders++;
  stats.trenders++;
  var nodes = 0, grids = 0, seen = {}, dup = 0, canvases = [];
  walk(body, function (n) {
    checkA11y(n, label);
    if (!n.classList) return;
    if (n.classList.contains('tree-canvas')) canvases.push(n);
    if (n.classList.contains('tree-grid')) { grids++; stats.tgrids++; }
    if (n.classList.contains('tree-edge')) {
      stats.tedges++;
      if (n.classList.contains('on')) stats.tedgeOn++;
    }
    if (n.classList.contains('tnode')) {
      nodes++;
      stats.tnodes++;
      if (n.classList.contains('on')) stats.tnodeOn++;
      // 三棵树的节点必须互不相同。这一条比数总数强：把专精树错画成职业树时
      // 总数依然合理（职业树画了两遍），但节点 ID 会重复。
      var nid = n.attrs['data-node'];
      if (!nid) { stats.tnoId++; }
      else if (seen[nid]) { dup++; stats.tdup++; }
      else seen[nid] = 1;
      // 节点上必须有中文名 —— 没有图标的树全靠名字读，名字空了等于白画。
      var nm = null;
      n.children.forEach(function (c) {
        if (c.classList && c.classList.contains('nm')) nm = c;
      });
      if (!nm || !nm.textContent) {
        stats.tnoName++;
        if (stats.tnoName < 4) problems.push(label + ' 天赋节点没有名字');
      } else if (!/[\u4e00-\u9fff]/.test(nm.textContent)) {
        stats.tnoCJK++;
        if (stats.tnoCJK < 4) problems.push(label + ' 天赋节点名不是中文：' + nm.textContent);
      }
    }
    // 英雄天赋名。talent-data.js 里存的是英文（那份数据来自插件），面板要靠
    // 子树表的「英文名 → 中文名」翻过来。这里盯的就是那一跳有没有生效。
    if (n.classList.contains('hero')) {
      n.children.forEach(function (c) {
        if (c.tagName !== 'B') return;
        stats.thero++;
        if (!/[\u4e00-\u9fff]/.test(c.textContent)) {
          stats.theroEn++;
          if (stats.theroEn < 4) problems.push(label + ' 英雄天赋名还是英文：' + c.textContent);
        }
      });
    }
    // 点数徽章，形如「2/3」
    if (n.classList.contains('r') && n.parentNode
        && n.parentNode.classList && n.parentNode.classList.contains('tnode')) {
      stats.tRank++;
      if (!/^\d+\/\d+$/.test(n.textContent)) {
        stats.tRankBad++;
        if (stats.tRankBad < 4) problems.push(label + ' 点数徽章文字不对：' + n.textContent);
      }
    }
  });
  // 一个专精应该画出三棵（职业 / 专精 / 英雄）
  if (grids !== 3) problems.push(label + ' 只画出 ' + grids + ' 棵树，应该是 3 棵');
  if (!nodes) { stats.tEmpty++; problems.push(label + ' 一个天赋节点都没画出来'); }

  // 几何检查。上面那些断言全是「DOM 里有没有这个元素」，而这棵树的位置完全靠
  // CSS 绝对定位 —— 方块两两叠在一起、或者跑到画布外面，上面每一条都照样通过。
  // 桩不算布局，所以按 CSS 的尺寸自己算。
  canvases.forEach(function (cv) {
    var boxes = [];
    cv.children.forEach(function (c) {
      if (!c.classList || !c.classList.contains('tnode')) return;
      var up = TREE && TREE.nodes ? TREE.nodes[c.attrs['data-node']] : null;
      boxes.push({
        id: c.attrs['data-node'],
        x: parseFloat(c.style.left), y: parseFloat(c.style.top),
        ux: up ? up[0] : null, uy: up ? up[1] : null
      });
    });
    var cw = parseFloat(cv.style.width), chh = parseFloat(cv.style.height);
    // 列数 / 行数。这一条抓的是「不重叠但摆错」：把聚类容差调成 0，
    // 相差 10 的近重复坐标会各占一列，树被拉宽、节点整体错位 —— 没有重叠、
    // 没有溢出，前面每条断言都过。本机实测最多 9 列 × 11 行（容差 50~250 都一样）。
    var xs = {}, ys = {};
    boxes.forEach(function (b) { xs[b.x] = 1; ys[b.y] = 1; });
    var nc = Object.keys(xs).length, nr2 = Object.keys(ys).length;
    if (nc > stats.tmaxCol) stats.tmaxCol = nc;
    if (nr2 > stats.tmaxRow) stats.tmaxRow = nr2;

    // 聚类契约，直接对着**上游坐标**验，而不是重复面板的算法：
    // 上游相差 ≤ GRID_TOL 的两个节点必须落在同一列（行），相差更多必须落在不同列。
    // 这一条才是把容差调成 0 时唯一会破的东西 —— 那时相差 10 的近重复坐标
    // 各占一列，既不重叠也不溢出，列数也还是 ≤ 9，前面每条断言都过。
    // 本机实测同一棵树内相邻坐标差要么 ≤20 要么 ≥250，所以不存在
    // 「链式合并」的歧义（100 + 100 + 100 连成一片）。
    for (var gi = 0; gi < boxes.length; gi++) {
      for (var gj = gi + 1; gj < boxes.length; gj++) {
        var p = boxes[gi], q = boxes[gj];
        if (p.ux === null || q.ux === null) continue;
        [['列', Math.abs(p.ux - q.ux), p.x === q.x],
         ['行', Math.abs(p.uy - q.uy), p.y === q.y]].forEach(function (t) {
          var gap = t[1], same = t[2];
          if (gap <= GRID_TOL_EXPECT && !same) {
            stats.tCluster++;
            if (stats.tCluster < 4) {
              problems.push(label + ' 节点 ' + p.id + ' 和 ' + q.id + ' 上游' + t[0]
                + '坐标只差 ' + gap + '，却被摆进了不同' + t[0]);
            }
          } else if (gap > GRID_TOL_EXPECT && same) {
            stats.tCluster++;
            if (stats.tCluster < 4) {
              problems.push(label + ' 节点 ' + p.id + ' 和 ' + q.id + ' 上游' + t[0]
                + '坐标差 ' + gap + '，却被摆进了同一' + t[0]);
            }
          }
        });
      }
    }
    boxes.forEach(function (b) {
      stats.tgeo++;
      if (!(b.x >= 0 && b.y >= 0 && b.x + NODE_BOX.w <= cw && b.y + NODE_BOX.h <= chh)) {
        stats.tSpill++;
        if (stats.tSpill < 4) {
          problems.push(label + ' 节点 ' + b.id + ' 超出画布：' + b.x + ',' + b.y
            + ' 方块 ' + NODE_BOX.w + '×' + NODE_BOX.h + '，画布 ' + cw + '×' + chh);
        }
      }
    });
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], b2 = boxes[j];
        if (Math.abs(a.x - b2.x) < NODE_BOX.w && Math.abs(a.y - b2.y) < NODE_BOX.h) {
          stats.tOverlap++;
          if (stats.tOverlap < 4) {
            problems.push(label + ' 节点 ' + a.id + ' 和 ' + b2.id + ' 重叠');
          }
        }
      }
    }
  });
  if (dup && stats.tdup <= 3) {
    problems.push(label + ' 有 ' + dup + ' 个节点被画了两次（哪棵树取错了节点集合？）');
  }
}

// 每个专精都画一次天赋树（团本类别）
specKeys.forEach(function (key) {
  settings.bisTab = 'talents';
  settings.bisSpec = key;
  settings.bisTalentCat = 'raid';
  body.children.length = 0;
  load('app/bis.js');
  g.AE.openBis();
  stats.tspecs++;
  checkTalents('天赋 ' + key);
});

// 三个类别各画一次，确认切类别不会崩
['raid', 'mplusHigh', 'mplusFarm'].forEach(function (cat) {
  settings.bisTab = 'talents';
  settings.bisSpec = specKeys[0];
  settings.bisTalentCat = cat;
  body.children.length = 0;
  load('app/bis.js');
  g.AE.openBis();
  checkTalents('天赋 ' + specKeys[0] + '/' + cat);
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
// 轨道徽章：数据里有 3601 行能解出轨道，但「数据对」不等于「画出来了」。
// 80 次渲染只画每个专精的前几件，所以这里不按 3601 算，只要求量级对。
if (stats.trk < 500) problems.push('轨道徽章只画了 ' + stats.trk + ' 个，太少');
if (stats.trkBad > 0) {
  problems.push(stats.trkBad + ' 个轨道徽章文字不合格式，例如 ' + stats.trkSample);
}
// 覆盖率徽章：每个部位组一个，不多不少。写成相等而不是「> 0」——
// 「至少有一个」那种断言在只有一个部位画出来的时候也能过。
if (stats.cov !== stats.slots) {
  problems.push('覆盖率徽章 ' + stats.cov + ' 个，部位组 ' + stats.slots + ' 个，不一一对应');
}
if (stats.covBad > 0) problems.push(stats.covBad + ' 个覆盖率徽章文字不合格式');
if (stats.slots < 1000) problems.push('只画了 ' + stats.slots + ' 个部位组，太少');

// ---- 天赋树渲染的总量断言
// 本机实测（40 个专精 + 3 个类别 = 43 次渲染）：树 129，节点 4304，点亮 3198，
// 连线 6377，点亮 3990，点数徽章 412。下面的门槛都是从这些数压出来的。
if (stats.tspecs !== specKeys.length) {
  problems.push('天赋树只画了 ' + stats.tspecs + ' 个专精，应该是 ' + specKeys.length + ' 个');
}
// 每次渲染必须是三棵（职业 / 专精 / 英雄），不多不少。和「覆盖率徽章 === 部位组」
// 一个套路：写成相等，才能同时抓住「少画一棵」和「多画一棵」。
if (stats.tgrids !== stats.trenders * 3) {
  problems.push('天赋树 ' + stats.tgrids + ' 棵，渲染 ' + stats.trenders
    + ' 次，不是每次 3 棵');
}
if (stats.tEmpty > 0) problems.push(stats.tEmpty + ' 个专精一个天赋节点都没画出来');
if (stats.tnodes < 4000) problems.push('天赋节点只画了 ' + stats.tnodes + ' 个，太少');
if (stats.tedges < 6000) problems.push('天赋连线只画了 ' + stats.tedges + ' 条，太少');
// 名字是这棵树的全部可读性 —— 不带图标，名字空一个都不行。
if (stats.tnoName > 0) problems.push(stats.tnoName + ' 个天赋节点没有名字');
if (stats.tnoCJK > 0) problems.push(stats.tnoCJK + ' 个天赋节点名不是中文（中文名连接坏了）');
if (stats.tRankBad > 0) problems.push(stats.tRankBad + ' 个点数徽章文字不合格式');
// 英雄天赋名：不允许任何一个是英文。本机实测 39/39 都能从 TraitSubTree
// 拉到中文名，所以这里写成 0 而不是一个比例。
if (stats.theroEn > 0) {
  problems.push(stats.theroEn + ' 个英雄天赋名没翻成中文');
}
if (stats.thero < 40) problems.push('只画了 ' + stats.thero + ' 个英雄天赋名，太少');
if (stats.tnoId > 0) problems.push(stats.tnoId + ' 个天赋节点没有 data-node');
if (stats.tdup > 0) problems.push('天赋节点重复画了 ' + stats.tdup + ' 次');
if (stats.tRank < 200) problems.push('点数徽章只画了 ' + stats.tRank + ' 个，太少');
// 点亮的比例。全灭 = 套路没解开；全亮 = 高亮逻辑失效，两种都是真 bug，
// 而它们都能在「节点数够多」的断言下蒙混过关。
var litPct = stats.tnodes ? stats.tnodeOn / stats.tnodes * 100 : 0;
if (litPct < 40 || litPct > 95) {
  problems.push('点亮的天赋节点占 ' + litPct.toFixed(1) + '%（' + stats.tnodeOn + '/'
    + stats.tnodes + '），不在 40~95% 之间');
}
if (stats.tedgeOn < 1000) problems.push('点亮的连线只有 ' + stats.tedgeOn + ' 条，太少');
// 列数 / 行数的上界。这一条不是为了「好看」，是为了抓住聚类容差被改坏：
// 上游坐标里有「相差 10」的近重复值，容差调成 0 会让它们各占一列 ——
// 那样既不重叠也不出界（画布跟着变宽），只是网格被悄悄拉歪了。
// 本机独立量过两次（tools 外的一次性脚本 + 这里）：最大 9 列 × 11 行，
// 且容差 50~250 之间结果不变，所以这个界是稳的。
// 聚类契约：上游坐标相差 <= 100 的两个节点必须落在同一列/行，> 100 必须不同。
// 这一条比「列数不超过 9」强 —— 容差被改成 0 时列数依然 <= 9（不同坐标值本来
// 就只有 9 种），但相差 10 的近重复坐标会各占一列，整棵树错位。
if (stats.tCluster > 0) {
  problems.push('天赋树有 ' + stats.tCluster + ' 处不满足聚类契约（容差 '
    + GRID_TOL_EXPECT + '），坐标摆错了');
}
if (stats.tmaxCol > 9 || stats.tmaxRow > 11) {
  problems.push('天赋树网格最大 ' + stats.tmaxCol + ' 列 × ' + stats.tmaxRow
    + ' 行，超出实测上界 9 × 11（坐标聚类的容差是不是被改了？）');
}
// 几何：这三条是 CSS 独有的失效模式。上面所有断言都只看「DOM 里有没有这个元素」，
// 而节点位置全靠绝对定位 —— 两个方块叠在一起、或者跑到画布外面，DOM 结构完全正常。
// 本机实测 4007 个方块（40 个专精）重叠 0、超出 0、最小间隙 12px。
if (stats.tgeo < 4000) problems.push('只量到 ' + stats.tgeo + ' 个节点方块，几何检查没跑起来');
if (stats.tSpill > 0) problems.push(stats.tSpill + ' 个天赋节点跑到画布外面了');
if (stats.tOverlap > 0) problems.push(stats.tOverlap + ' 对天赋节点互相重叠（网格算错了）');

console.log(pad('渲染检查') + (problems.length ? problems.length + ' 个问题' : '通过')
  + '（' + stats.renders + ' 次渲染，' + stats.imgs + ' 个图标，占位块 ' + stats.ph
  + '，轨道徽章 ' + stats.trk + '，部位组 ' + stats.slots + '）');
console.log(pad('天赋树渲染') + (stats.tEmpty ? stats.tEmpty + ' 个专精是空的' : '通过')
  + '（' + stats.tspecs + ' 个专精，' + stats.tgrids + ' 棵树，节点 ' + stats.tnodes
  + '，点亮 ' + stats.tnodeOn + '，连线 ' + stats.tedges + '，点亮 ' + stats.tedgeOn
  + '，点数徽章 ' + stats.tRank + '，英雄天赋名 ' + stats.thero
  + '，方块 ' + stats.tgeo + '（重叠 ' + stats.tOverlap + '，超出 ' + stats.tSpill + '）'
  + '，方块尺寸 ' + NODE_BOX.w + '×' + NODE_BOX.h + '（读自 style.css）'
  + '，最大 ' + stats.tmaxCol + ' 列 × ' + stats.tmaxRow + ' 行，聚类越界 '
  + stats.tCluster + '）');

// ---- 无障碍
// 这一组全是「实测已经是 0，写成硬断言钉住」，不是给未来留的余量。
// 加这一组的起因是：我先量出「621 个 <img> 全都没有 alt」，差点当成 bug 去改 ——
// 实际是**桩不反射属性**（app 里写的是 img.alt = ''，属性写法，桩只认 setAttribute）。
// 修好桩之后才看出真实情况：alt 全都有，缺的是天赋树画布的 role 和说明。
if (stats.a11yImg > 0) {
  problems.push(stats.a11yImg + ' 个 <img> 没有 alt 属性（装饰图也要写 alt=""，'
    + '否则读屏软件会念文件名）');
}
if (stats.a11yBtnBad > 0) {
  problems.push(stats.a11yBtnBad + ' 个 <button> 既没有可见文字也没有 aria-label');
}
if (stats.a11yTipBad > 0) {
  problems.push(stats.a11yTipBad + ' 个元素只有 data-tip、没有可见文字'
    + '（tooltip 是补充说明，不能当成元素的名字）');
}
if (stats.a11yCanvasBad > 0) {
  problems.push(stats.a11yCanvasBad + ' 个天赋树画布没有 role=group + aria-label');
}
// 数量下界：断言本身有没有跑到。全是 0 也可能是「一个都没数到」。
if (stats.a11yTip < 2000) problems.push('只数到 ' + stats.a11yTip + ' 个 data-tip 元素，无障碍检查没跑起来');
if (stats.a11yBtn < 200) problems.push('只数到 ' + stats.a11yBtn + ' 个 <button>，无障碍检查没跑起来');
if (stats.a11yCanvas < 100) problems.push('只数到 ' + stats.a11yCanvas + ' 个天赋树画布，无障碍检查没跑起来');

console.log(pad('无障碍') + (stats.a11yImg + stats.a11yBtnBad + stats.a11yTipBad
    + stats.a11yCanvasBad ? '有问题' : '通过')
  + '（' + stats.imgs + ' 个图标全有 alt，' + stats.a11yBtn + ' 个按钮全有名字，'
  + stats.a11yTip + ' 个 data-tip 元素全有可见文字，'
  + stats.a11yCanvas + ' 个天赋树画布全有 role=group + 说明）');

// ----------------------------------------------------------------------- 格式校验
// 两个校验器分别是 app/bis-data.js 和 app/talent-tree.js 的格式定义（可执行的那种）。
// 在这里连带跑一遍，免得它们自己烂掉都没人知道 —— 它们的价值全在「换数据源时能拦住
// 不合格的新生成器」，那意味着平时必须一直是绿的。
//
// 数据文件不在就跳过，但**跳过要说出来**（打「跳过」而不是「通过」）——
// 一个没跑的检查报成通过，就是我在别处反复踩过的「空测试」。
var VERIFIERS = [
  { label: '数据格式', script: 'verify-bis-data.js', data: 'bis-data.js' },
  { label: '天赋树格式', script: 'verify-talent-tree.js', data: 'talent-tree.js' }
];
VERIFIERS.forEach(function (v) {
  if (!fs.existsSync(path.join(ROOT, 'app', v.data))) {
    console.log(pad(v.label) + '跳过（没有 app/' + v.data + '）');
    return;
  }
  var cp = require('child_process');
  var r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', v.script)],
    { encoding: 'utf8' });
  var out = String(r.stdout || '') + String(r.stderr || '');
  var m = /检查项\s+(\d+)/.exec(out);
  if (r.status === 0) {
    console.log(pad(v.label) + '通过（' + (m ? m[1] : '?') + ' 项检查）');
    return;
  }
  console.log(pad(v.label) + '不合格式');
  var found = 0;
  out.split(/\r?\n/).forEach(function (ln) {
    if (/^\s+·/.test(ln)) { problems.push(v.label + '：' + ln.replace(/^\s+·\s*/, '')); found++; }
  });
  if (!found) problems.push(v.label + '校验失败（退出码 ' + r.status + '）');
});

// ------------------------------------------------------------------- 打包一致性
// tools/ 是被**整个目录递归复制**进发布包的，.gitignore 管不到它。
// 所以任何依赖测试脚手架（run-tests.js / dom-stub.js）的工具，都必须写进
// build-release.ps1 的 $dropFromPkg，否则用户解开 zip 会拿到一个跑不起来的脚本。
// 这一条以前靠我记着，记漏过 —— 现在让它自己查。
(function () {
  var HARNESS = ['run-tests.js', 'dom-stub.js'];
  var ps = path.join(ROOT, 'tools', 'build-release.ps1');
  if (!fs.existsSync(ps)) { console.log(pad('打包一致性') + '跳过（没有 build-release.ps1）'); return; }
  var txt = fs.readFileSync(ps, 'utf8');
  var blk = /\$dropFromPkg\s*=\s*@\(([\s\S]*?)\)/.exec(txt);
  if (!blk) { problems.push('build-release.ps1 里找不到 $dropFromPkg，打包一致性检查没跑起来'); return; }
  var listed = {};
  (blk[1].match(/'tools\\([^']+)'/g) || []).forEach(function (s) {
    listed[/'tools\\([^']+)'/.exec(s)[1]] = 1;
  });
  var need = [], miss = [];
  fs.readdirSync(path.join(ROOT, 'tools')).forEach(function (f) {
    if (!/\.js$/.test(f)) return;
    var src = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');
    var uses = HARNESS.some(function (h) { return h !== f && src.indexOf(h) >= 0; });
    if (!uses && HARNESS.indexOf(f) < 0) return;
    need.push(f);
    if (!listed[f]) miss.push(f);
  });
  if (need.length < 2) problems.push('只找到 ' + need.length + ' 个依赖脚手架的工具，打包一致性检查没跑起来');
  miss.forEach(function (f) {
    problems.push('tools/' + f + ' 依赖测试脚手架，但没写进 build-release.ps1 的 $dropFromPkg，会被打进发布包');
  });
  console.log(pad('打包一致性') + (miss.length
      ? miss.length + ' 个工具会被误打包（共 ' + need.length + ' 个依赖脚手架）'
      : '通过（' + need.length + ' 个依赖脚手架的工具全在 $dropFromPkg 里）'));
})();

// ----------------------------------------------------------------------- 汇总

console.log('');
if (failures.length) {
  console.log('失败的测试：');
  failures.forEach(function (f) { console.log('  · ' + f); });
}
if (problems.length) {
  console.log('渲染 / 格式问题：');
  problems.slice(0, 20).forEach(function (p) { console.log('  · ' + p); });
}

var bad = total.fail + problems.length;
console.log(bad === 0
  ? '全部通过：' + total.pass + ' 项测试 + 装备渲染 + 天赋树渲染 + 无障碍 + 两项格式校验 + 打包一致性'
  : '有问题：' + total.fail + ' 项测试失败，' + problems.length + ' 个渲染/格式问题');
process.exit(bad === 0 ? 0 : 1);
