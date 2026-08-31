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

// 变异测试会**在磁盘上真的改源文件**。它和这个套件并行跑，读数全是垃圾。
// 这一句必须在 makeEnv / load 之前 —— 一旦开始读文件就已经晚了。
require('./mutate-lock.js').assertNotMutating();

// 天赋串解码器。这里只用它的 toBits() 读串头里那 16 位 specID ——
// 用来验「面板显示的串，头里写的专精和当前专精一致」。
// 自己在这里重写一遍 base64→位 的转换是不行的：那样验的是我的第二份实现，
// 而不是产品里那份。
var DEC = require('./decode-talent-string.js');

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
// class-names.js 必须在 labels.js 前面：labels.js 的 classLabel / specLabel
// 读 window.AE_DB2_NAMES。缺了它会静默退回旧的兜底表（4 个职业显英文、
// 死骑冰霜显 FROST），测试照样全绿 —— 所以它是硬依赖，不是可选项。
['app/class-names.js', 'app/lua-parser.js', 'app/parser-tests.js', 'app/labels.js',
 'app/model.js',
 'app/settings.js', 'app/columns.js', 'app/layouts.js', 'app/model-tests.js',
 'app/export.js', 'app/bis.js', 'app/bis-tests.js'].forEach(function (f) {
  if (!load(f)) throw new Error('缺文件：' + f);
});

// 数据文件。bis-data / talent-data / item-icons 在浏览器里是懒加载的，但测试里
// 必须显式加载 —— 「因为没数据所以跳过」的测试报成通过，是最难发现的假绿。
// rio-data.js 也在这里：它是**入库的产物**，不是可选下载物。缺了它就该红，
// 而不是让「实战分布」视角悄悄不渲染 —— 那正是「跳过报成通过」的假绿。
['app/bis-data.js', 'app/talent-data.js', 'app/talent-tree.js',
 'app/item-icons.js', 'app/rio-data.js'].forEach(function (f) {
  if (!load(f)) throw new Error('缺文件：' + f + '（先跑对应的 tools\\gen-*.js / fetch-*.js）');
});
var haveScan = load('data/data.js');
load('data/bagsync.js');

g.AE.openPanel = function () {};
g.AE.closeAllPanels = function () {};
g.AE.saveSettings = function () {};
g.AE.toast = function () {};

// 复制到剪贴板的桩：把真正交出去的那串记下来，而不是丢掉。
// 记下来才能断言「按钮复制的就是屏幕上显示的那串」——这是天赋导入串唯一
// 会致命的失败方式：显示对、复制错，用户粘进游戏得到「无效」，而界面上
// 一切正常。丢掉参数的桩会让这种 bug 永远测不出来。
//
// 这个桩本身也坑过我一次：我一度写了两份声明，后一份只存字符串、把前一份
// 存对象的覆盖掉，于是 copied[0].text 恒为 undefined，43 个专精全报
// 「复制出去的串和框里显示的不是同一串」。看着像面板错了，其实是**桩错了**。
// 所以这里只留一份，字段名写死成 text/label。
var copied = [];
g.AE.copyWithToast = function (text, label) { copied.push({ text: text, label: label }); };

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
              sn: 0, snBad: 0, rioRenders: 0, rioSlots: 0,
              // 天赋树
              tgrids: 0, tnodes: 0, tnodeOn: 0, tedges: 0, tedgeOn: 0,
              tnoName: 0, tnoCJK: 0, tRank: 0, tRankBad: 0, tspecs: 0, tEmpty: 0,
              trenders: 0, tdup: 0, tnoId: 0, tgeo: 0, tSpill: 0, tOverlap: 0, thero: 0, theroEn: 0,
              tico: 0, tnoIco: 0, ticoBad: 0, ticoNoCls: 0, ticoMismatch: 0, ticoPair: 0,
              tmaxCol: 0, tmaxRow: 0, tCluster: 0,
              // 天赋导入串。loSpecs 是**去重后的专精数**，loRenders 是渲染次数 ——
              // 两者不同（40 个专精 + 3 次切类别 = 43 次渲染），混用会得到一条
              // 永远不可能满足的断言。第一版正是把渲染次数当专精数，断言
              // 「=== 40」于是恒报 43。
              loSpecs: 0, loRenders: 0, loBoxes: 0, loCopy: 0, loPicks: 0,
              loSpec: 0, loExact: 0,
              // 无障碍
              a11yImg: 0, a11yBtn: 0, a11yBtnBad: 0, a11yTip: 0, a11yTipBad: 0,
              a11yCanvas: 0, a11yCanvasBad: 0 };
var missingFiles = {};
var loSeen = {};
var body = doc.getElementById('bis-body');

/**
 * 导入串的问题登记，**按种类限流**：同一种问题最多留 2 条。
 *
 * 为什么不直接 problems.push：这一组要跑 43 次渲染，一个真实缺陷会一次性
 * 灌进 43 条同样的消息，而末尾只打印前 20 条 —— 于是**后面所有种类的问题
 * 都被挤出屏幕**。变异测试里这件事真的发生了：「真值恒为空」那个变异体
 * 断言确实触发了，但消息排在第 44 条，输出里看不见，被判成「串了」。
 *
 * 限流按种类而不是按总数，保证每一类至少有一条能被看见。
 */
var loKinds = {};
function loNote(kind, msg) {
  loKinds[kind] = (loKinds[kind] || 0) + 1;
  if (loKinds[kind] <= 2) problems.push(msg);
}

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
  var isRio = /\/rio$/.test(label);
  if (isRio) stats.rioRenders++;
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
    // 部位头上的徽章有**两种**，按 class 分开验，不能共用一条正则：
    //   · cov（BisData 视角）「记录 95.9%」—— 列表被截断，只能说覆盖率；
    //   · cov sn（rio 视角）「N=97」—— 有真实样本量。
    // 共用一条正则的话两边都验不住：要么 N= 被判不合格，要么正则松到什么都能过。
    if (n.classList && n.classList.contains('slot-head')) {
      stats.slots++;
      if (isRio) stats.rioSlots++;
    }
    if (n.classList && n.classList.contains('cov')) {
      var isSn = n.classList.contains('sn');
      if (isSn) {
        stats.sn++;
        if (!/^N=\d+$/.test(n.textContent)) {
          stats.snBad++;
          if (stats.snBad < 4) problems.push(label + ' 样本量徽章文字不对：' + n.textContent);
        }
      } else {
        stats.cov++;
        if (!/^记录 \d+(\.\d)?%$/.test(n.textContent)) {
          stats.covBad++;
          if (stats.covBad < 4) problems.push(label + ' 覆盖率徽章文字不对：' + n.textContent);
        }
      }
    }
  });
  if (!sawItem) problems.push(label + ' 一件装备都没画出来');
}

// openBis() 只在第一次调用时读设置（之后 gearLoaded 为真就直接 render），
// 所以每换一个组合都要重新 eval bis.js，否则 80 次渲染画的是同一个专精。
specKeys.forEach(function (key) {
  ['raid', 'mplus', 'rio'].forEach(function (view) {
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

// ------------------------------------------------------- 天赋导入串（照原样取）

/**
 * app/rio-data.js 里这个专精的官方导入串，按人数聚合降序。
 *
 * 这是**独立算的真值**，不是调 app/bis.js 里的 rioLoadouts() ——
 * 拿被测代码算真值再去验被测代码，是个恒等式，永远通过。
 * 排序规则必须和面板一致（人数降序，同人数按串本身），否则「#1」指的不是同一串。
 */
function rioLoadoutTruth(specId) {
  var R = g.AE_RIO;
  if (!R || !R.specs) return null;
  var rs = R.specs[String(specId)];
  if (!rs || !rs.loadouts || !rs.loadouts.length) return null;
  var count = Object.create(null), total = 0;
  rs.loadouts.forEach(function (s) {
    if (!s) return;
    count[s] = (count[s] || 0) + 1;
    total++;
  });
  var list = Object.keys(count);
  if (!list.length) return null;
  list.sort(function (a, b) {
    if (count[b] !== count[a]) return count[b] - count[a];
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return { list: list, count: count, total: total };
}

/**
 * 串头里的 specID。头是 8 位版本 + 16 位 specID，base64 每字符 6 位、低位在前。
 * 8 个字符 = 48 位，取头 24 位够了。
 */
function headerSpec(s) {
  var bits = DEC.toBits(String(s).slice(0, 8));
  if (!bits) return null;
  var v = 0;
  for (var i = 0; i < 16; i++) v |= (bits[8 + i] || 0) << i;
  return v;
}

/**
 * 导入串这一块。这一组盯的是「显示的串和数据里的串是不是同一串」——
 * 面板不编码、不改字符，所以这里能用最硬的判据：**字节相等**。
 */
function checkLoadouts(label, specId, boxes, texts, copies, picks) {
  var truth = rioLoadoutTruth(specId);
  if (!truth) {
    // 没真值 = rio 里这个专精没有串，那面板就**不该**画这一块。
    // 这一条反着抓：画出一个空框比不画更糟（用户会去复制一个空串）。
    if (boxes.length) loNote('画了空框', label + ' rio 里没有导入串，却画出了导入串块');
    return;
  }
  stats.loRenders++;
  // 按 specId 去重。第一版这里写的是 loSpecs++，然后断言「loSpecs === 40」——
  // 结果报 43，因为天赋树要额外画 3 次「切类别」（同一个专精换 raid/冲分/割草）。
  // 数渲染次数和数专精是两件事，混用会让一条本来正确的断言报假错。
  loSeen[String(specId)] = 1;
  stats.loSpecs = Object.keys(loSeen).length;
  if (boxes.length !== 1 || texts.length !== 1 || copies.length !== 1) {
    loNote('块数不对', label + ' 导入串块 ' + boxes.length + ' 个 / 串框 ' + texts.length
      + ' 个 / 复制按钮 ' + copies.length + ' 个，各应正好 1 个');
    return;
  }
  stats.loBoxes++;

  var shown = texts[0].value;

  // 串头里的 specID 必须就是这个专精。导错专精游戏会直接拒绝，
  // 而这种错在界面上完全看不出来 —— 串长、字符集、人数全都正常。
  //
  // **这一条必须排在「字节相等」之前，而且不能提前 return。**
  // 第一版把它放在后面，于是「显示了另一个专精的串」这个变异体先撞上字节不等、
  // 带着 return 走掉 —— specID 这条一次都没执行过。变异测试报的是「串了」：
  // 抓到了，但不是它抓的。被更强的断言遮住的断言，等于没有被证明。
  var hs = headerSpec(shown);
  if (hs !== Number(specId)) {
    loNote('专精不符', label + ' 导入串头里的 specID 是 ' + hs + '，不是本专精 ' + specId);
  } else {
    stats.loSpec++;
  }

  // 核心断言：显示的串必须和数据里那条**一个字节都不差**。
  if (shown !== truth.list[0]) {
    loNote('串不一致', label + ' 显示的导入串和 rio 数据里的第一条不一致：显示 '
      + shown.length + ' 字符，数据 ' + truth.list[0].length + ' 字符');
  } else {
    stats.loExact++;
  }
  // 只读。用户在框里改一个字符再复制，导进游戏只会说「无效」，
  // 而他会以为是这个面板给错了。
  if (!texts[0].readOnly) {
    loNote('可写', label + ' 导入串框不是只读的');
  }
  // 选串按钮：最多 6 个，有几种就画几个。
  var wantPicks = Math.min(6, truth.list.length);
  if (picks !== wantPicks) {
    loNote('按钮数', label + ' 选串按钮 ' + picks + ' 个，应该是 ' + wantPicks + ' 个');
  } else {
    stats.loPicks += picks;
  }
  // 真点一次「复制」。这一条才是用户实际用到的路径：
  // 前面全都在验 DOM 里的文字，而复制走的是另一个参数。
  copied.length = 0;
  copies[0].click();
  if (copied.length !== 1) {
    loNote('没调用', label + ' 点了复制按钮，copyWithToast 被调用 ' + copied.length + ' 次');
  } else if (copied[0].text !== shown) {
    loNote('复制不符', label + ' 复制出去的串和框里显示的不是同一串');
  } else {
    stats.loCopy++;
  }
}

// 天赋树的渲染检查。以前这里只 renders++、什么都不断言 —— 那是假绿：
// 树画不出来照样通过。现在每个专精都画一遍，并数出节点 / 连线 / 中文名。
function checkTalents(label, specId) {
  // specId 必传：下面要拿它去 AE_RIO 里取「这个专精真实的导入串集合」。
  // 漏传的话每个专精都会取到 undefined，导入串那一组断言会全部静默跳过 ——
  // 而「因为取不到数据所以跳过」报成通过，正是这个项目反复踩的假绿。
  // 所以少参数硬抛：这是调用者的 bug，不是一种数据情况。
  if (specId === undefined) throw new Error('checkTalents(label, specId)：specId 必传');
  stats.renders++;
  stats.trenders++;
  var nodes = 0, grids = 0, seen = {}, dup = 0, canvases = [];
  var loBoxes = [], loTexts = [], loCopies = [], loPicks = 0;
  walk(body, function (n) {
    checkA11y(n, label);
    if (!n.classList) return;
    if (n.classList.contains('tree-canvas')) canvases.push(n);
    if (n.classList.contains('bis-loadout')) loBoxes.push(n);
    if (n.classList.contains('lo-text')) loTexts.push(n);
    if (n.classList.contains('lo-copy')) loCopies.push(n);
    if (n.classList.contains('lo-pick')) loPicks += n.children.length;
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
      // 节点上必须有中文名。图标是认天赋的主要手段，但名字是唯一的**文字**信息，
      // 读屏软件和「图挂了」的情况都只剩它。
      var nm = null, ico = null;
      n.children.forEach(function (c) {
        if (c.classList && c.classList.contains('nm')) nm = c;
        if (c.tagName === 'IMG') ico = c;
      });
      if (!nm || !nm.textContent) {
        stats.tnoName++;
        if (stats.tnoName < 4) problems.push(label + ' 天赋节点没有名字');
      } else if (!/[\u4e00-\u9fff]/.test(nm.textContent)) {
        stats.tnoCJK++;
        if (stats.tnoCJK < 4) problems.push(label + ' 天赋节点名不是中文：' + nm.textContent);
      }
      // 天赋图标。这一段是新加的，而且是**被一次假通过逼出来的**：
      // 图标接上之后套件依然报「7947 个图标」——和一张天赋图都没有的时候一模一样。
      // 原因是天赋渲染走 checkTalents，而数图标的代码只在 checkRender 里。
      // 4304 个节点、2094 张图，全都没有被任何断言看过一眼。
      if (!ico) {
        stats.tnoIco++;
        if (stats.tnoIco < 4) problems.push(label + ' 天赋节点 ' + nid + ' 没有图标');
      } else {
        stats.tico++;
        var isrc = ico.attrs.src || ico.src || '';
        if (isrc.indexOf('app/talent-icons/') !== 0) {
          stats.ticoBad++;
          if (stats.ticoBad < 4) {
            problems.push(label + ' 天赋图标 src 不指向 app/talent-icons/：' + isrc);
          }
        } else if (!fs.existsSync(path.join(ROOT, isrc))) {
          missingFiles[isrc] = 1;
        }
        // 图标必须有 class=ti，否则 style.css 里那一整段（24px、压暗未点的）全落空。
        // 实测漏过一次：img 建出来了、图也在，但没设 class，样式一条没生效。
        if (!ico.classList || !ico.classList.contains('ti')) {
          stats.ticoNoCls++;
          if (stats.ticoNoCls < 4) {
            problems.push(label + ' 天赋图标没有 class=ti，style.css 那段样式会全部落空');
          }
        }
        // **图标和名字必须来自同一个 entry。**
        //
        // 上面三条加起来仍然抓不住「图标取错了 entry」：把 icons[ent[2]] 写成
        // icons[ent[1]]（名字下标当图标下标用）照样得到一个存在的图标名、
        // 存在的文件、正确的路径前缀 —— 三条全过，而二选一节点会图文不符。
        // 所以这里对着上游数据反查：显示的名字属于哪个 entry，图标就必须是
        // 那个 entry 的图标。同名 entry 存在（同一天赋的多个 rank），所以
        // 收成集合再判定。
        var up2 = TREE && TREE.nodes ? TREE.nodes[nid] : null;
        if (up2 && nm && nm.textContent) {
          var wantIco = {}, nWant = 0;
          (up2[5] || []).forEach(function (e) {
            if (TREE.names[e[1]] !== nm.textContent) return;
            var inm = TREE.icons[e[2]];
            if (inm) { wantIco[inm] = 1; nWant++; }
          });
          var got = isrc.replace(/^.*\//, '').replace(/\.jpg$/, '');
          if (nWant && !wantIco[got]) {
            stats.ticoMismatch++;
            if (stats.ticoMismatch < 4) {
              problems.push(label + ' 节点 ' + nid + ' 图文不符：名字「' + nm.textContent
                + '」对应图标 ' + Object.keys(wantIco).join('/') + '，画出来的却是 ' + got);
            }
          } else if (nWant) {
            stats.ticoPair++;
          }
        }
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
  checkLoadouts(label, specId, loBoxes, loTexts, loCopies, loPicks);

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
  checkTalents('天赋 ' + key, B.specs[key].specId);
});

// 三个类别各画一次，确认切类别不会崩
['raid', 'mplusHigh', 'mplusFarm'].forEach(function (cat) {
  settings.bisTab = 'talents';
  settings.bisSpec = specKeys[0];
  settings.bisTalentCat = cat;
  body.children.length = 0;
  load('app/bis.js');
  g.AE.openBis();
  checkTalents('天赋 ' + specKeys[0] + '/' + cat, B.specs[specKeys[0]].specId);
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
// 徽章：每个部位组头上**恰好一个**，两种加起来必须等于部位组数。
// 写成相等而不是「> 0」—— 「至少有一个」那种断言在只有一个部位画出来的时候也能过。
// 两种分开数再求和，才能同时抓住「rio 视角忘了给徽章」和「BisData 视角多给一个」。
if (stats.cov + stats.sn !== stats.slots) {
  problems.push('覆盖率徽章 ' + stats.cov + ' + 样本量徽章 ' + stats.sn
    + ' = ' + (stats.cov + stats.sn) + '，部位组 ' + stats.slots + ' 个，不一一对应');
}
if (stats.covBad > 0) problems.push(stats.covBad + ' 个覆盖率徽章文字不合格式');
if (stats.snBad > 0) problems.push(stats.snBad + ' 个样本量徽章文字不合格式');
if (stats.slots < 1000) problems.push('只画了 ' + stats.slots + ' 个部位组，太少');

// ---- 「实战分布」视角（rio）
// 这一组是**独立的**，不能靠上面的总量断言兜着：rio 视角要是一个部位都没画，
// 总量只会从 1264 掉到 1264 —— 因为它本来就没被算进去过。
// 本轮加这个视角时正是这样：套件全绿，渲染次数一字未变，等于新代码从没跑过。
if (stats.rioRenders !== specKeys.length) {
  problems.push('实战分布视角只渲染了 ' + stats.rioRenders + ' 次，应该是 '
    + specKeys.length + ' 个专精各一次');
}
// rio 的 40 个专精每个 15~17 个部位（副手/衬衫不是人人有），实测 636 组。
if (stats.rioSlots < 600) {
  problems.push('实战分布视角只画了 ' + stats.rioSlots + ' 个部位组，太少');
}
// 样本量徽章只在 rio 视角出，所以它的个数必须**正好等于** rio 的部位组数。
if (stats.sn !== stats.rioSlots) {
  problems.push('样本量徽章 ' + stats.sn + ' 个，实战分布部位组 ' + stats.rioSlots
    + ' 个，不一一对应');
}

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
// 天赋图标。写成「一个都不许少」而不是一个比例：图标名字典是全覆盖的
// （2094/2094 张文件都在），所以每个节点都该有图。
// 这一组的门槛是实测压出来的：4304 个节点 → 4304 张图标。
if (stats.tnoIco > 0) {
  problems.push(stats.tnoIco + ' 个天赋节点没有图标（图标名字典或 nodeEntry 坏了）');
}
if (stats.ticoBad > 0) problems.push(stats.ticoBad + ' 个天赋图标 src 不指向 app/talent-icons/');
// 图文不符一个都不允许。并且要求反查真的跑过足够多次 ——
// 如果 wantIco 永远是空（比如 TREE.names 取不到），上面那条会一直是 0，
// 看起来像「全对」，实际上一次都没比。本机实测能配上名字的节点 4304 中的大部分。
if (stats.ticoPair < 3000) {
  problems.push('图文配对只查了 ' + stats.ticoPair + ' 次，太少（反查没真跑）');
}
if (stats.ticoMismatch > 0) {
  problems.push(stats.ticoMismatch + ' 个天赋节点图文不符（图标和名字取了不同的 entry）');
}
if (stats.ticoNoCls > 0) {
  problems.push(stats.ticoNoCls + ' 个天赋图标没有 class=ti（style.css 那段样式全部落空）');
}
// 数量必须和节点数相等。写成「> 4000」的话，「只有一半节点有图」也能过。
if (stats.tico !== stats.tnodes) {
  problems.push('天赋图标 ' + stats.tico + ' 个，节点 ' + stats.tnodes + ' 个，不一一对应');
}

console.log(pad('渲染检查') + (problems.length ? problems.length + ' 个问题' : '通过')
  + '（' + stats.renders + ' 次渲染，' + stats.imgs + ' 个图标，占位块 ' + stats.ph
  + '，轨道徽章 ' + stats.trk + '，部位组 ' + stats.slots + '）');
console.log(pad('天赋树渲染') + (stats.tEmpty ? stats.tEmpty + ' 个专精是空的' : '通过')
  + '（' + stats.tspecs + ' 个专精，' + stats.tgrids + ' 棵树，节点 ' + stats.tnodes
  + '，点亮 ' + stats.tnodeOn + '，连线 ' + stats.tedges + '，点亮 ' + stats.tedgeOn
  + '，点数徽章 ' + stats.tRank + '，英雄天赋名 ' + stats.thero
  + '，图标 ' + stats.tico + '（没图标 ' + stats.tnoIco + '，路径错 ' + stats.ticoBad
  + '，缺 class ' + stats.ticoNoCls + '，图文配对 ' + stats.ticoPair
  + '，图文不符 ' + stats.ticoMismatch + '）'
  + '，方块 ' + stats.tgeo + '（重叠 ' + stats.tOverlap + '，超出 ' + stats.tSpill + '）'
  + '，方块尺寸 ' + NODE_BOX.w + '×' + NODE_BOX.h + '（读自 style.css）'
  + '，最大 ' + stats.tmaxCol + ' 列 × ' + stats.tmaxRow + ' 行，聚类越界 '
  + stats.tCluster + '）');

// ---- 天赋导入串（rio 的 talentLoadoutText，照原样显示 / 复制）
// 这一组必须有自己的下界，而且必须**打印出来**。上一版我把计数器加好了、
// 断言也写了，但既不打印也没有下界 —— 于是「一个专精都没画出导入串块」
// 会安静地全绿通过，因为 43 条断言全都在 truth 为空时提前 return 了。
// 这就是这个项目反复踩的同一个坑：跳过报成通过。
if (stats.loSpecs !== specKeys.length) {
  problems.push('导入串只检查了 ' + stats.loSpecs + ' 个专精，应该是 '
    + specKeys.length + ' 个（rio 里 40 个专精都有串）');
}
// 每一次渲染都必须真的画出一块，一个不少。基准是**渲染次数**而不是专精数：
// 切类别那三次也各画一次，拿专精数比会差 3。
if (stats.loBoxes !== stats.loRenders) {
  problems.push('导入串块 ' + stats.loBoxes + ' 个，渲染 ' + stats.loRenders
    + ' 次，不一一对应');
}
// 复制按钮必须每次渲染都真被点过一次、并且交出正确的串。
// 写成相等而不是「> 0」：点一个专精成功也能让「> 0」过。
if (stats.loCopy !== stats.loRenders) {
  problems.push('复制按钮验过 ' + stats.loCopy + ' 次，渲染 ' + stats.loRenders
    + ' 次，说明有渲染的复制路径没验到');
}
// 选串按钮：40 个专精 × 最多 6 个。实测每个专精都有 6 种以上不同的串，
// 所以这里是 240。写成下界是为了容忍某个专精种类不足 6。
if (stats.loPicks < specKeys.length * 3) {
  problems.push('选串按钮总共只画了 ' + stats.loPicks + ' 个，太少');
}
// 下面两条是给**打印行里那两句话**做背书的。
// 摘要里写着「复制内容与显示逐字节相同，串头 specID 全部与所属专精一致」——
// 如果这两个计数器没有下界，那两句话就只是我自己写的一句宣传语：
// 判定分支一次都没走到时它们照样是 0，摘要照样这么印。
if (stats.loSpec !== stats.loRenders) {
  problems.push('串头 specID 只验过 ' + stats.loSpec + ' 次，渲染 ' + stats.loRenders
    + ' 次，摘要里「specID 全部一致」这句话没有依据');
}
if (stats.loExact !== stats.loRenders) {
  problems.push('逐字节相等只验过 ' + stats.loExact + ' 次，渲染 ' + stats.loRenders
    + ' 次，摘要里「逐字节相同」这句话没有依据');
}
console.log(pad('天赋导入串') + (stats.loSpecs === specKeys.length
    && stats.loCopy === stats.loRenders && stats.loSpec === stats.loRenders
    && stats.loExact === stats.loRenders ? '通过' : '有问题')
  + '（' + stats.loSpecs + ' 个专精 / ' + stats.loRenders + ' 次渲染，串框 ' + stats.loBoxes
  + '，选串按钮 ' + stats.loPicks + '，复制按钮真点过 ' + stats.loCopy
  + ' 次且复制内容与显示逐字节相同，串头 specID 全部与所属专精一致）');

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
  { label: '天赋树格式', script: 'verify-talent-tree.js', data: 'talent-tree.js' },
  // own=true：这个校验器自己打的那行比通用的「N 项检查」信息量大（它要报少解 /
  // rank / entryIndex / granted 各自的不符数），所以原样透传，不降级成计数。
  { label: '天赋串解码', script: 'verify-talent-decode.js', data: 'talent-tree.js',
    need: 'tools/talent-truth.json', own: true },
  { label: 'rio 装备分布', script: 'verify-rio-data.js', data: 'rio-data.js' }
];
VERIFIERS.forEach(function (v) {
  if (!fs.existsSync(path.join(ROOT, 'app', v.data))) {
    console.log(pad(v.label) + '跳过（没有 app/' + v.data + '）');
    return;
  }
  // 真值文件是提交进仓库的。它不见了不是「这台机器没数据」，是仓库缺东西 ——
  // 那种情况下「跳过」会把一条 2406 项的断言静默变成真空，所以硬失败。
  if (v.need && !fs.existsSync(path.join(ROOT, v.need))) {
    problems.push(v.label + '：缺 ' + v.need + '（它是提交进仓库的，'
      + '不该缺；重新生成跑 node tools\\fetch-talent-truth.js）');
    console.log(pad(v.label) + '缺真值文件');
    return;
  }
  var cp = require('child_process');
  var r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', v.script)],
    { encoding: 'utf8' });
  var out = String(r.stdout || '') + String(r.stderr || '');
  var m = /检查项\s+(\d+)/.exec(out);
  if (r.status === 0) {
    if (v.own) {
      var own = out.split(/\r?\n/).filter(function (ln) { return ln.trim(); })[0] || '';
      console.log(own || (pad(v.label) + '通过'));
    } else {
      console.log(pad(v.label) + '通过（' + (m ? m[1] : '?') + ' 项检查）');
    }
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
// 所以任何**测试专用**的工具都必须写进 build-release.ps1 的 $dropFromPkg，
// 否则用户解开 zip 会拿到一个跑不起来的脚本。这一条以前靠我记着，记漏过。
//
// 判据有两条，缺一不可：
//   1. **真的 require 了**测试脚手架（run-tests.js / dom-stub.js）；
//   2. 文件名是 mutate-*.js —— 变异测试一律是测试专用。
// 第 2 条是补的：mutate-decode.js 跑的是 verify-talent-decode.js，
// 一个字都没提脚手架，于是第 1 条漏掉了它，守卫报「4 个」而实际有 5 个。
// **注意 verify-*.js 不算测试专用** —— 那几个是随包发布的、用户能自己跑的校验器。
//
// 第 1 条原先写的是 indexOf('run-tests.js') >= 0，也就是「源码里提到这个名字」。
// 太松了：我在 decode-talent-string.js 的注释里写了一句「run-tests.js 用它的
// toBits() 读串头」，守卫立刻把它判成测试专用，要求加进 $dropFromPkg。
// 而那是**错的**，加进去会砸掉发布包 —— 见下面「随包工具的依赖不许被丢掉」那条。
// 改成只认真正的 require()：注释怎么写都不影响判定。
(function () {
  var HARNESS = ['run-tests.js', 'dom-stub.js'];
  // require('./x.js') / require("./x") / path.join(__dirname, 'x.js') 都算真依赖；
  // 出现在注释或字符串说明里的不算。
  function requiresHarness(src, self) {
    return HARNESS.some(function (h) {
      if (h === self) return false;
      var base = h.replace(/\.js$/, '');
      var re = new RegExp('require\\(\\s*[\'"]\\./' + base + '(\\.js)?[\'"]\\s*\\)');
      return re.test(src);
    });
  }
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
    var uses = requiresHarness(src, f);
    var isMutant = /^mutate-.*\.js$/.test(f);
    if (!uses && !isMutant && HARNESS.indexOf(f) < 0) return;
    need.push(f);
    if (!listed[f]) miss.push(f);
  });
  if (need.length < 2) problems.push('只找到 ' + need.length + ' 个依赖脚手架的工具，打包一致性检查没跑起来');
  miss.forEach(function (f) {
    problems.push('tools/' + f + ' 依赖测试脚手架，但没写进 build-release.ps1 的 $dropFromPkg，会被打进发布包');
  });

  // 反过来的那一半，比上面那半更危险，所以必须也有断言。
  //
  // 上面只管「该踢的有没有踢」。但**踢错**是静默的：名单里多写一个文件，
  // zip 照样打得出来、测试照样全绿，只有用户解开包去跑校验器时才会
  // 「Cannot find module」。本地永远复现不了，因为本地那个文件在。
  //
  // 实际差点发生：decode-talent-string.js 被 verify-talent-decode.js 和
  // fetch-talent-truth.js 两个**随包发布**的工具 require；守卫（当时判据太松，
  // 连注释里提一句 run-tests.js 都算）把它报成「测试专用」，而顺手加进名单
  // 就会打出一个校验器直接崩掉的发布包。
  //
  // 判据：随包工具 require 的本地文件，一个都不许出现在 $dropFromPkg 里。
  var shipped = [], wrongDrop = [];
  fs.readdirSync(path.join(ROOT, 'tools')).forEach(function (f) {
    if (!/\.js$/.test(f) || need.indexOf(f) >= 0) return;   // need = 测试专用的那批
    shipped.push(f);
    var src = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');
    (src.match(/require\('\.\/([^']+)'\)/g) || []).forEach(function (r) {
      var dep = /require\('\.\/([^']+)'\)/.exec(r)[1];
      if (!/\.js$/.test(dep)) dep += '.js';
      if (listed[dep]) {
        wrongDrop.push('tools/' + dep + ' 被随包发布的 tools/' + f
          + ' require，却写进了 $dropFromPkg —— 发布包里那个校验器会因为找不到它而崩');
      }
    });
  });
  // 缓存**目录**同理，而且更容易漏：文件名单和目录名单是两个变量，
  // 我这一轮加 tools/.rio-raw/（1.9 MB 的角色 profile 缓存）时就只改了 .gitignore。
  // 判据：.gitignore 里每一个 tools/.xxx/ 都必须出现在 $dropDirsFromPkg 里。
  // 用 .gitignore 当事实来源，而不是我在这里再抄一份名单 —— 抄的那份会过期。
  var dirMiss = [], dirNeed = [];
  var gi = path.join(ROOT, '.gitignore');
  var dblk = /\$dropDirsFromPkg\s*=\s*@\(([\s\S]*?)\)/.exec(txt);
  if (!fs.existsSync(gi)) {
    problems.push('找不到 .gitignore，缓存目录的打包检查没跑起来');
  } else if (!dblk) {
    problems.push('build-release.ps1 里找不到 $dropDirsFromPkg，缓存目录的打包检查没跑起来');
  } else {
    var dListed = {};
    (dblk[1].match(/'tools\\([^']+)'/g) || []).forEach(function (s) {
      dListed[/'tools\\([^']+)'/.exec(s)[1]] = 1;
    });
    fs.readFileSync(gi, 'utf8').split(/\r?\n/).forEach(function (ln) {
      var m = /^tools\/(\.[^\/\s]+)\/\s*$/.exec(ln.trim());
      if (!m) return;
      dirNeed.push(m[1]);
      if (!dListed[m[1]]) dirMiss.push(m[1]);
    });
    if (dirNeed.length < 2) {
      problems.push('只从 .gitignore 里认出 ' + dirNeed.length + ' 个 tools/ 缓存目录，这项检查没跑起来');
    }
    dirMiss.forEach(function (d) {
      problems.push('tools/' + d + '/ 在 .gitignore 里，但没写进 build-release.ps1 的 $dropDirsFromPkg'
        + '，会被整个打进发布包（tools/ 是从磁盘递归复制的，.gitignore 管不到）');
    });
  }

  // 反向检查的空转守卫：随包工具一个都没认出来的话，上面那段循环等于没跑。
  // 加这条是因为它的形状和「跳过报成通过」完全一样 —— 判据一写错（比如 need
  // 把整个 tools/ 都算成测试专用），shipped 就会空掉，循环一次不跑却照样全绿。
  if (shipped.length < 3) {
    problems.push('只认出 ' + shipped.length + ' 个随包发布的 tools 脚本，'
      + '「随包依赖不许进 $dropFromPkg」这条检查等于没跑');
  }
  wrongDrop.forEach(function (m2) { problems.push(m2); });

  // 摘要行必须把三类问题都算进去。第一版只看 miss/dirMiss，于是我注入
  // 「把随包依赖加进名单」这个变异体时，problems 里红了两条、这一行却照印
  // 「通过」—— 只看摘要的人会以为没事。摘要和断言必须同源。
  console.log(pad('打包一致性') + (miss.length || dirMiss.length || wrongDrop.length
      ? (miss.length + dirMiss.length + wrongDrop.length) + ' 个会被误打包或误踢出（'
        + miss.length + ' 个脚本漏踢，' + dirMiss.length + ' 个缓存目录漏踢，'
        + wrongDrop.length + ' 个随包依赖被误踢）'
      : '通过（' + need.length + ' 个测试专用脚本 + ' + dirNeed.length
        + ' 个缓存目录全在名单里，' + shipped.length + ' 个随包脚本的依赖没被误踢）'));
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
  ? '全部通过：' + total.pass + ' 项测试 + 装备渲染 + 天赋树渲染 + 无障碍 + 三项格式校验'
    + ' + 天赋串解码对真值 + 打包一致性'
  : '有问题：' + total.fail + ' 项测试失败，' + problems.length + ' 个渲染/格式问题');
process.exit(bad === 0 ? 0 : 1);
