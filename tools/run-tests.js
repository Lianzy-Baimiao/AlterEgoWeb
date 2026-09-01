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
 'app/export.js', 'app/talent-decode.js', 'app/bis.js', 'app/bis-tests.js'].forEach(function (f) {
  if (!load(f)) throw new Error('缺文件：' + f);
});

// 数据文件。bis-data / talent-data / item-icons 在浏览器里是懒加载的，但测试里
// 必须显式加载 —— 「因为没数据所以跳过」的测试报成通过，是最难发现的假绿。
// rio-data.js 也在这里：它是**入库的产物**，不是可选下载物。缺了它就该红，
// 而不是让「实战分布」视角悄悄不渲染 —— 那正是「跳过报成通过」的假绿。
// maxroll-data.js 同理。加视角那一轮它**没**在这个名单里，于是「最佳推荐」
// 视角在测试里从来没被画过，而套件照样全绿（渲染次数 163 一个都没涨）——
// 又一次「跳过报成通过」。数字没动就是没跑，这条读数救了一次。
['app/bis-data.js', 'app/talent-data.js', 'app/talent-tree.js',
 'app/item-icons.js', 'app/rio-data.js', 'app/maxroll-data.js'].forEach(function (f) {
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
              // rioRenders 数的是**所有**画过 rio 视角的渲染（专精循环 + 视角迁移
              // + 对照角色那三组都算），mainRio 只数专精循环那一轮。
              // 下面「每个专精各一次」那条断言必须用 mainRio：用总数的话，
              // 后面任何一组多画一次 rio 都会把它顶红，而那不是缺陷。
              sn: 0, snBad: 0, rioRenders: 0, mainRio: 0, rioSlots: 0,
              mr: 0, mrBad: 0,
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
              // maxroll 天赋方案（第 15 轮：天赋页也按 maxroll 来）。和上面那组
              // 分开数：那组盯 raider.io 的官方串（能导入的那批），这组盯 maxroll
              // 的方案 —— maxroll 的串不给用户（版本号 130，游戏会拒），
              // 所以这组的核心是「画出来的树 == 高亮那一套」，不是串。
              mrtSpecs: 0, mrtRenders: 0, mrtBox: 0, mrtTree: 0, mrtBtns: 0,
              mrtName: 0, mrtSpec: 0, mrtDecl: 0, mrtNoStr: 0,
              mrtPts: 0, mrtPtsSplit: 0, mrtMany: 0, mrtManySeen: 0,
              mrtSubBar: 0, mrtBundle: 0, mrtKindSw: 0, mrtBuildSw: 0, mrtSubSw: 0,
              // 第 16 轮：场景标签 / 出手顺序 / 各首领·副本说明
              mrtScen: 0, mrtScenSeen: 0, mrtScenBad: 0, mrtPrio: 0, mrtBoss: 0,
              // 视角迁移（第 16 轮撤掉 GearInsight 那两个视角）
              vmChecked: 0, vmMigrated: 0, vmWrote: 0,
              // 装等差距（第 16 轮：maxroll 不给装等，从本机两份实测数据借）
              ivGi: 0, ivRio: 0, ivNone: 0, ivZero: 0,
              gapBadge: 0, gapBad: 0, gapMath: 0, gapTop: 0, gapTopBad: 0,
              gapSum: 0, gapChars: 0, gapSlots: 0,
              // 无障碍
              a11yImg: 0, a11yBtn: 0, a11yBtnBad: 0, a11yTip: 0, a11yTipBad: 0,
              a11yCanvas: 0, a11yCanvasBad: 0 };
var missingFiles = {};
var loSeen = {};
var mrSeen = {};
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
    // 部位头上的徽章有**三种**，按 class 分开验，不能共用一条正则：
    //   · cov（BisData 视角）「记录 95.9%」—— 列表被截断，只能说覆盖率；
    //   · cov sn（rio 视角）「N=97」—— 有真实样本量；
    //   · cov mr（maxroll 视角）「首选 1 ・替代 1」—— **既没有样本量也没有覆盖率**，
    //     它是编辑推荐，那两个量在这份数据里不存在。
    // 共用一条正则的话三边都验不住：要么 N= 被判不合格，要么正则松到什么都能过。
    if (n.classList && n.classList.contains('slot-head')) {
      stats.slots++;
      if (isRio) stats.rioSlots++;
    }
    // ---- 装等那一格（.sub2）。**这一条是这一轮那个 bug 的回归。**
    //
    // 上一版 maxroll 视角每一行的装等都写着「0」：mrSlots 从 rio 的物品池里取
    // ri.ilvl，而那个池子只有 {n, i, q, sock}，没有 ilvl 这个字段 —— 取到
    // undefined，`(undefined) || 0` 得 0，然后 String(0) 印成「0」。
    // 判据是「装等那一格不许出现 0 或空」：装等是正整数，或者干脆不画那一格
    // （查不到时画的是「装等 ?」，走 iv-none 那一支）。
    if (n.classList && n.classList.contains('sub2')
      && n.parentNode && n.parentNode.classList
      && n.parentNode.classList.contains('im')) {
      var t = n.textContent;
      if (n.classList.contains('iv-none')) {
        stats.ivNone++;
        if (t !== '装等 ?') {
          problems.push(label + ' 查不到装等那一格的文字是「' + t + '」，该是「装等 ?」');
        }
      } else {
        if (n.classList.contains('iv-rio')) stats.ivRio++;
        else if (n.classList.contains('iv-gi')) stats.ivGi++;
        // 形如「703」或「690→703」。0 一律不合格 —— 那正是上一版的样子。
        if (!/^[1-9]\d{1,3}(→[1-9]\d{1,3})?$/.test(t)) {
          stats.ivZero++;
          if (stats.ivZero < 4) {
            problems.push(label + ' 装等那一格是「' + t + '」—— 装等该是正整数，'
              + '查不到就别画（0 是「取了个不存在的字段」的样子）');
          }
        }
      }
    }
    // ---- 装等差距徽章。形如「差 14」「高 3」「持平」，三种状态各有 class。
    if (n.classList && n.classList.contains('gap')
      && n.classList.contains('tag')) {
      stats.gapBadge++;
      var gt = n.textContent;
      var okTxt = /^(差|高) [1-9]\d{0,2}$/.test(gt) || gt === '持平';
      // 文字和 class 必须**互相对得上**。只验文字的话「差 14」配 ahead 这种
      // 反着来的组合照样过 —— 而那正是「颜色对不上数字」的样子：
      // 落后画成淡色、领先画成警告色，用户会照着颜色做反的决定。
      var cls = n.classList.contains('behind') ? 'behind'
        : n.classList.contains('ahead') ? 'ahead'
          : n.classList.contains('even') ? 'even' : '';
      var wantCls = gt.indexOf('差 ') === 0 ? 'behind'
        : gt.indexOf('高 ') === 0 ? 'ahead' : 'even';
      if (!okTxt || cls !== wantCls) {
        stats.gapBad++;
        if (stats.gapBad < 4) {
          problems.push(label + ' 装等差距徽章「' + gt + '」配的是 class「' + cls
            + '」，该是「' + wantCls + '」');
        }
      }
      // ---- 差值本身对不对：**拿提示里的两个数自己减一遍**。
      //
      // 上面那条只验「文字和颜色一致」，抓不到**符号反了**：把 want - mine 写成
      // mine - want，文字变「高 14」、class 跟着变 ahead，两者依然一致 ——
      // 而界面上「你落后 14」就变成了「你领先 14」，正好指向反的行动。
      // 提示里写的是「你 689.4　首选那件 703（…）」，两个数都是原始量，
      // 所以这里能独立算出差值，再和徽章上那个数比。
      var tip = n.attrs && n.attrs['data-tip'] || '';
      var nums = tip.match(/你 ([\d.]+)　首选那件 (\d+)/);
      if (!nums) {
        stats.gapBad++;
        if (stats.gapBad < 4) {
          problems.push(label + ' 装等差距徽章的提示里没有「你 X　首选那件 Y」，'
            + '差值就没法独立复核了：' + tip.slice(0, 60));
        }
      } else {
        var want = Math.round(Number(nums[2]) - Number(nums[1]));
        var shown = gt === '持平' ? 0
          : (gt.indexOf('差 ') === 0 ? 1 : -1) * Number(gt.slice(2));
        if (want !== shown) {
          stats.gapBad++;
          if (stats.gapBad < 4) {
            problems.push(label + ' 装等差距徽章写「' + gt + '」，但提示里两个数（你 '
              + nums[1] + '，首选 ' + nums[2] + '）算出来是 ' + want
              + ' —— 符号或算式反了');
          }
        } else {
          stats.gapMath++;
        }
      }
    }
    if (n.classList && n.classList.contains('gap-sum')) stats.gapSum++;
    if (n.classList && n.classList.contains('cov')) {
      if (n.classList.contains('mr')) {
        stats.mr++;
        if (!/^首选 \d+( ・替代 \d+)?$/.test(n.textContent)) {
          stats.mrBad++;
          if (stats.mrBad < 4) problems.push(label + ' maxroll 徽章文字不对：' + n.textContent);
        }
      } else if (n.classList.contains('sn')) {
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
  checkSlotGapTarget(label);
}

/**
 * 装等差距**比的是哪一件**：必须是这个部位画在最前面的那一件。
 *
 * 为什么单独一条：徽章文字、颜色、提示里的两个数全都出自同一个 `top`，
 * 所以「把 rows[0] 写成 rows[rows.length-1]」这种改动**处处自洽** ——
 * 提示里写「首选那件 312」，徽章按 312 算，三者一致，只是那 312 是列表末尾
 * 那件「可刷替代」的装等。实测这么改一下差距会凭空缩小，用户以为自己快毕业了。
 *
 * 判据只能从 DOM 里另找一个来源：这个部位**第一行**画出来的装等。
 * 它和提示里的「首选那件 X」必须是同一个数。
 */
function checkSlotGapTarget(label) {
  walk(body, function (n) {
    if (!n.classList || !n.classList.contains('slot')) return;
    var head = null, firstItem = null;
    n.children.forEach(function (c) {
      if (!c.classList) return;
      if (!head && c.classList.contains('slot-head')) head = c;
    });
    // 部位组里的装备行：.slot > .item（渲染时是平铺的兄弟节点）
    for (var i = 0; i < n.children.length && !firstItem; i++) {
      if (n.children[i].classList && n.children[i].classList.contains('item')) {
        firstItem = n.children[i];
      }
    }
    if (!head || !firstItem) return;

    var tip = '';
    walk(head, function (h) {
      if (h.classList && h.classList.contains('gap') && h.classList.contains('tag')) {
        tip = (h.attrs && h.attrs['data-tip']) || '';
      }
    });
    if (!tip) return;                       // 这个部位没画差距徽章
    var m = tip.match(/首选那件 (\d+)/);
    if (!m) return;                         // 提示格式那条断言已经在管了

    var shownIlvl = null;
    walk(firstItem, function (x) {
      if (shownIlvl === null && x.classList && x.classList.contains('sub2')
        && !x.classList.contains('iv-none')) {
        var t = (x.textContent || '').match(/^(\d+)/);
        if (t) shownIlvl = Number(t[1]);
      }
    });
    if (shownIlvl === null) return;         // 第一行没画装等（查不到那 3 行）

    stats.gapTop++;
    if (Number(m[1]) !== shownIlvl) {
      stats.gapTopBad++;
      if (stats.gapTopBad < 4) {
        problems.push(label + ' 装等差距说「首选那件 ' + m[1]
          + '」，但这个部位第一行画的是 ' + shownIlvl
          + ' —— 比的不是首选那一件');
      }
    }
  });
}

// openBis() 只在第一次调用时读设置（之后 gearLoaded 为真就直接 render），
// 所以每换一个组合都要重新 eval bis.js，否则 80 次渲染画的是同一个专精。
//
// **只走界面上真有的两个视角。** 第 16 轮撤掉了 GearInsight 的「团本视角 /
// 大秘境视角」两个按钮，而上一版这个循环还在跑 'raid' / 'mplus' ——
// openBis() 现在把这两个旧值迁到 maxroll，于是那两轮画的都是 maxroll，
// 渲染次数一字不差、套件全绿，**但等于同一个视角画了三遍**。
// 旧视角迁移单独验（见下面 checkViewMigration），不混在这里。
specKeys.forEach(function (key) {
  ['maxroll', 'rio'].forEach(function (view) {
    settings.bisTab = 'gear';
    settings.bisSpec = key;
    settings.bisView = view;
    settings.bisChar = '';
    body.children.length = 0;
    load('app/bis.js');
    g.AE.openBis();
    checkRender(key + '/' + view);
    if (view === 'rio') stats.mainRio++;
  });
});

// ---- 撤掉的两个视角：按钮没了，老设置要迁走
//
// 这一条盯的是**升级上来的用户**：设置里存着 bisView='raid'，而界面上已经没有
// 那个按钮了。不迁的话面板会停在一个渲染一切正常、却切不回去的视角里 ——
// 界面自洽，谁也看不出为什么。所以判据有两条，都得成立：
//   · 视角按钮**正好两个**，且没有「团本视角 / 大秘境视角」；
//   · 存着旧值进来，画出来的必须是 maxroll（认 maxroll 的徽章「首选 N」）。
(function checkViewMigration() {
  var VIEW_LABELS = ['最佳推荐', '实战分布'];
  var GONE = ['团本视角', '大秘境视角'];
  ['raid', 'mplus', 'maxroll', 'rio'].forEach(function (saved) {
    settings.bisTab = 'gear';
    settings.bisSpec = specKeys[0];
    settings.bisView = saved;
    settings.bisChar = '';
    body.children.length = 0;
    load('app/bis.js');
    g.AE.openBis();

    var labels = [], mrBadge = 0, snBadge = 0, on = [];
    walk(body, function (n) {
      if (n.tagName === 'BUTTON' && n.parentNode && n.parentNode.classList
        && n.parentNode.classList.contains('seg')
        && n.parentNode.parentNode && n.parentNode.parentNode.classList
        && n.parentNode.parentNode.classList.contains('bis-bar')) {
        labels.push(n.textContent);
        if (n.classList.contains('on')) on.push(n.textContent);
      }
      if (n.classList && n.classList.contains('cov')) {
        if (n.classList.contains('mr')) mrBadge++;
        else if (n.classList.contains('sn')) snBadge++;
      }
    });
    stats.vmChecked++;

    GONE.forEach(function (t) {
      if (labels.indexOf(t) >= 0) {
        problems.push('视角切换器里还有「' + t + '」按钮 —— 第 16 轮撤掉了它');
      }
    });
    if (labels.length !== VIEW_LABELS.length) {
      problems.push('视角按钮 ' + labels.length + ' 个（' + labels.join('/')
        + '），应该正好 ' + VIEW_LABELS.length + ' 个：' + VIEW_LABELS.join('/'));
    }
    // 迁移：旧值和 maxroll 都该落在 maxroll 上（高亮 + maxroll 的徽章）。
    var wantMr = (saved !== 'rio');
    if (wantMr) {
      if (on.indexOf('最佳推荐') < 0) {
        problems.push('设置里存着 bisView=' + saved + '，高亮却在「' + on.join('/')
          + '」—— 撤掉的视角没迁到「最佳推荐」，用户会卡在一个没有按钮的视角里');
      }
      if (!mrBadge) {
        problems.push('设置里存着 bisView=' + saved + '，但一个 maxroll 徽章都没画出来');
      }
      stats.vmMigrated++;
    } else if (!snBadge) {
      problems.push('设置里存着 bisView=rio，却没画出样本量徽章');
    }
    // 迁移必须**写回设置**。只改 state.view 的话那段代码是死的：state.view 的
    // 初值本来就是 'maxroll'，删掉整段行为一模一样 —— 没有这一条，
    // 「迁移」这个功能是不是真的存在，测试分不出来。
    if (saved === 'raid' || saved === 'mplus') {
      if (settings.bisView !== 'maxroll') {
        problems.push('设置里存着 bisView=' + saved + '（已撤掉的视角），'
          + '读完设置后它还是「' + settings.bisView + '」—— 迁移没写回存档，'
          + '下次打开又是这个不存在的视角');
      } else {
        stats.vmWrote++;
      }
    }
  });
})();

// ---- 对照角色：装等差距那一组只有选了角色才画得出来
//
// 上面那些渲染全是 bisChar='' —— **一个装等差距徽章都不会出现**。
// 这一组真的选上本机存档里的角色，按「职业对得上」挑，因为对着别的职业的
// 毕业表比装等没有意义（面板自己也会画一条「职业不是本专精所属职业」的警告）。
//
// 判据分两层：徽章本身的文字/class 在 checkRender 里逐个验；这里验**下界** ——
// 一个都没画出来说明这条路没走到，而上面那条「文字必须合格」在 0 个徽章的
// 情况下照样成立（空集合上的全称命题恒真，这是本仓库反复踩到的假绿形状）。
(function checkGearGap() {
  var chars = (model.characters || []).filter(function (c) {
    return c.equipment && Object.keys(c.equipment).length >= 10
      && c.ilvl && c.ilvl.value > 50;
  });
  if (!chars.length) {
    // 没有可用存档不算失败（克隆下来没有 data/data.js 的人也要能跑），
    // 但要显式记 0，让摘要里那句「对照过 0 个角色」自己说出来。
    stats.gapChars = 0;
    return;
  }
  // 每个职业挑一个装备最全的，最多 6 个 —— 再多只是重复同一条路。
  var byCls = {};
  chars.forEach(function (c) {
    var cur = byCls[c.classFile];
    if (!cur || Object.keys(c.equipment).length > Object.keys(cur.equipment).length) {
      byCls[c.classFile] = c;
    }
  });
  var picks = Object.keys(byCls).map(function (k) { return byCls[k]; }).slice(0, 6);

  picks.forEach(function (c) {
    // 找一个同职业的专精 key，这样对照才有意义。
    var key = null;
    for (var i = 0; i < specKeys.length; i++) {
      if (specKeys[i].split('/')[0] === c.classFile) { key = specKeys[i]; break; }
    }
    if (!key) return;
    ['maxroll', 'rio'].forEach(function (view) {
      settings.bisTab = 'gear';
      settings.bisSpec = key;
      settings.bisView = view;
      settings.bisChar = c.key;
      body.children.length = 0;
      load('app/bis.js');
      g.AE.openBis();
      checkRender('对照/' + c.name + '/' + view);
      stats.gapSlots++;
    });
    stats.gapChars++;
  });
})();

// ---- 首屏兜底：默认视角是 maxroll，而 app/maxroll-data.js 是**懒加载**的。
//
// 上面那 203 次渲染全是「数据已经在」的情况，所以它们**验不到**这条路。
// 真实首屏是另一回事：state.view 已经是 'maxroll'，但 AE_MAXROLL 还没到，
// mrPick() 恒为 null。没有 effectiveView() 兜底的话面板会空一下，
// 而「空一下」和「这个专精真没数据」在界面上分不出来。
//
// 这里把 AE_MAXROLL 临时藏起来，重新走一次完整渲染，要求**照样画出装备**。
(function checkFirstPaintFallback() {
  var saved = g.AE_MAXROLL;
  delete g.AE_MAXROLL;
  var before = problems.length;
  var sample = specKeys.slice(0, 3);
  sample.forEach(function (key) {
    settings.bisTab = 'gear';
    settings.bisSpec = key;
    settings.bisView = 'maxroll';   // 用户选的是 maxroll
    settings.bisChar = '';
    body.children.length = 0;
    load('app/bis.js');
    g.AE.openBis();
    // checkRender 里那条「一件装备都没画出来」就是这次要验的东西
    checkRender('首屏兜底/' + key);
  });
  g.AE_MAXROLL = saved;
  if (problems.length > before) {
    problems.push('maxroll 数据没加载时首屏画不出装备 —— effectiveView() 的兜底失效了');
  }
  stats.fallbackChecked = sample.length;
})();

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

// maxroll 那批天赋方案的真值：产物里 specs[specId].views[kind].talents。
// 面板的类型顺序是**大秘境在前**（app/bis.js 的 mrTalentKinds），这里照抄 ——
// 顺序不一致的话下面「第几套」的下标就对不上，而错位的下标看起来像数据错。
var MR = g.AE_MAXROLL;
var MR_ORDER = DEC.loadOrder();
function mrTalentTruth(specId) {
  var sp = MR && MR.specs ? MR.specs[String(specId)] : null;
  if (!sp || !sp.views) return null;
  var out = [];
  ['mplus', 'raid'].forEach(function (k) {
    var v = sp.views[k];
    // prio / boss 也带上：它们挂在**视角**上，不在单套方案里，而面板要按当前
    // 类型画对应那一份。不带的话「换类型之后说明也跟着换」就没法验。
    if (v && v.talents && v.talents.length) {
      out.push({ kind: k, list: v.talents, prio: v.prio || [], boss: v.boss || [] });
    }
  });
  return out.length ? out : null;
}

/**
 * 独立解一遍这条串，返回验证用的一切：{err} 或
 * {pts, subs, base, per, sel}。
 *
 * 用 tools/decode-talent-string.js 而不是 app/talent-decode.js：那份是面板正在用的，
 * 拿它来验自己等于什么都没验。两份实现互相对账在 tools/verify-talent-decode.js
 * 里已经做过，这里要的是「产物里那两个**声明**字段和串本身一致」，以及
 * 「画出来的那棵树点亮的就是这条串点的节点」——
 * 面板的方案列表直接显示 p 和 h，它们错了界面上完全看不出来。
 *
 * 只算**本专精自己的**节点（rec.inSpec）：nodeOrder 是按整个职业排的，
 * 位流里混着同职业别的专精的节点，算进去点数会多 6~23 点（实测）。
 *
 * sel 收的是「位流里选了的」节点（买的 + 系统白给的），因为面板画高亮
 * 用的就是这个集合（app/talent-decode.js 的 out.nr 也包含白给的）；
 * base / per 只算买的，那是点数的判据。
 */
function mrDecode(specId, t) {
  var out;
  try { out = DEC.decode(t.s, MR_ORDER); } catch (e) { return { err: '解码抛错：' + e.message }; }
  if (!out || out.err) return { err: '解不开：' + ((out && out.err) || '?') };
  if (out.spec !== Number(specId)) {
    return { err: '串头 specID ' + out.spec + ' != ' + specId };
  }
  var pts = 0, subs = {}, base = 0, per = {}, sel = {};
  out.nodes.forEach(function (n) {
    if (!n.inSpec) return;
    sel[String(n.id)] = 1;
    if (!n.purchased) return;              // 白给的不占点数
    var r = (typeof n.rank === 'number' ? n.rank : 1);
    pts += r;
    var row = TREE && TREE.nodes ? TREE.nodes[n.id] : null;
    var sub = row && row[6];
    if (sub) { subs[sub] = 1; per[sub] = (per[sub] || 0) + r; }
    else base += r;
  });
  return {
    pts: pts, base: base, per: per, sel: sel,
    subs: Object.keys(subs).map(Number).sort(function (a, b) { return a - b; })
  };
}

/** 产物里声明的 p / h 和独立解码一致吗？不一致返回一句话。 */
function mrDeclaredOk(t, d) {
  if (d.err) return d.err;
  if (d.pts !== t.p) return '声明 ' + t.p + ' 点，现解出 ' + d.pts + ' 点';
  var got = d.subs.join(',');
  var want = (t.h || []).slice().sort(function (a, b) { return a - b; }).join(',');
  if (got !== want) return '声明英雄子树 [' + want + ']，现解出 [' + got + ']';
  return null;
}

/**
 * maxroll 天赋这一块。
 *
 * 判据换过一次，值得写清楚。第一版这里有个串框（显示 + 复制），核心断言是
 * 「框里的串和产物里那条字节相等」。后来量出 maxroll 的串版本号是 130、
 * 游戏只认 2，串块整块删了 —— 那条断言跟着没了着落，而它守的东西还在：
 * **高亮的那一行和画出来的那棵树必须是同一套**。方案列表是竖着一排名字，
 * 高亮错一行，用户就在照着别的方案点天赋，而树、点数、名字各自都自洽。
 *
 * 所以现在对着**树上点亮的节点**验：拿独立解码器解高亮那一套的串，
 * 职业树 + 专精树点亮的节点必须和它**完全相同**（多一个少一个都算错），
 * 英雄树点亮的必须恰好是「这一套点的某一条子树」的全部节点。
 * 这比字节比串更贴近用户看到的东西 —— 他看的是树，不是串。
 *
 * 顺带守住「不给串」这个决定本身：页面上任何一个输入框里都不许出现这条串。
 */
function checkMrTalents(label, specId, boxes, notes, btns, subBtns, lit, taVals,
  scenEls, prioBox, bossBox) {
  var truth = mrTalentTruth(specId);
  if (!truth) {
    // 没方案（实测 3 个专精：战士武器、德鲁伊平衡、武僧织雾，它们的串全解不开）
    // 就该整块不画，退回插件那份统计。画个空框比不画更糟。
    if (boxes.length) loNote('mr 空框', label + ' maxroll 没有天赋方案，却画出了 maxroll 方案列表');
    return;
  }
  stats.mrtRenders++;
  mrSeen[String(specId)] = 1;
  stats.mrtSpecs = Object.keys(mrSeen).length;
  if (boxes.length !== 1 || notes.length !== 1) {
    loNote('mr 块数', label + ' maxroll 方案列表 ' + boxes.length + ' 个 / 「不给导入串」'
      + '说明 ' + notes.length + ' 个，各应正好 1 个');
    return;
  }
  stats.mrtBox++;

  // 现在画的是哪个类型？**从副标题读**，不从串反推。
  //
  // 第一版是「拿显示的串去两个类型的列表里找，找到就算」—— 那是错的判据：
  // 同一条串在 mplus 和 raid 里都可能有（maxroll 两篇指南给同一套方案）。
  // 于是「按钮 10 个 / 列表 9 套」「高亮第 1 个 / 串是第 0 套」这类假错各报了 2 条，
  // 全是定位错，不是面板错。副标题里写着「大秘境指南 / 团本指南」，那是唯一的
  // 权威读数。
  var subText = (doc.getElementById('bis-sub') || {}).textContent || '';
  var wantKind = subText.indexOf('大秘境指南') >= 0 ? 'mplus'
    : (subText.indexOf('团本指南') >= 0 ? 'raid' : null);
  if (!wantKind) {
    loNote('mr 副标题', label + ' 副标题里看不出画的是团本还是大秘境：' + subText);
    return;
  }
  var kind = null;
  truth.forEach(function (kb) { if (kb.kind === wantKind) kind = kb; });
  if (!kind) {
    loNote('mr 类型不符', label + ' 副标题说画的是 ' + wantKind + '，但产物里这个专精没有这个类型');
    return;
  }

  // 方案按钮：这个类型有几套就画几个，高亮的必须正好一个。
  if (btns.length !== kind.list.length) {
    loNote('mr 按钮数', label + ' 方案按钮 ' + btns.length + ' 个，'
      + kind.kind + ' 有 ' + kind.list.length + ' 套');
    return;
  }
  stats.mrtBtns += btns.length;
  var on = [];
  btns.forEach(function (b, i) { if (b.classList.contains('on')) on.push(i); });
  if (on.length !== 1) {
    loNote('mr 高亮', label + ' 高亮的方案有 ' + on.length + ' 个（' + on.join('/')
      + '），应该正好 1 个');
    return;
  }
  var idx = on[0];
  var t = kind.list[idx];
  var d = mrDecode(specId, t);

  // 串头里的 specID。串虽然不给用户，但它决定了解出来的是谁的树。
  var hs = headerSpec(t.s);
  if (hs !== Number(specId)) {
    loNote('mr 专精不符', label + ' maxroll 串头里的 specID 是 ' + hs + '，不是本专精 ' + specId);
  } else {
    stats.mrtSpec++;
  }

  // 产物声明的点数 / 英雄子树 vs 独立解码
  var bad = mrDeclaredOk(t, d);
  if (bad) loNote('mr 声明不符', label + ' 第 ' + idx + ' 套：' + bad);
  else stats.mrtDecl++;

  // 核心断言：画出来的树点亮的就是**高亮那一套**点的节点。
  var why = d.err ? d.err : mrTreeLitOk(specId, t, d, lit);
  if (why) {
    loNote('mr 树不符', label + ' 高亮的是第 ' + idx + ' 套「' + (t.n || '(无名)') + '」，'
      + '但画出来的树和它不一致：' + why);
  } else {
    stats.mrtTree++;
  }

  // 高亮那一行的名字也必须是这一套的。名字是用户唯一用来选的信息。
  var nm = null, ems = [];
  btns[idx].children.forEach(function (c) {
    if (!c.classList) return;
    if (c.classList.contains('nm')) nm = c;
    if (c.classList.contains('mt')) {
      c.children.forEach(function (e) { if (e.tagName === 'EM') ems.push(e); });
    }
  });
  var wantNm = t.n || '（这套没写名字）';
  if (!nm || nm.textContent !== wantNm) {
    loNote('mr 名字', label + ' 高亮方案的名字是「' + (nm ? nm.textContent : '(没画)')
      + '」，产物里是「' + wantNm + '」');
  } else {
    stats.mrtName++;
  }

  // 印出来的点数必须是**游戏里配得出来的**那个数。
  //
  // 这一条是这一轮的第二个真 bug 变成的断言：打包两条英雄天赋的方案，
  // 产物里 p 是两条加起来的 95，而游戏里一个角色只能选一条 —— 列表上印 95
  // 等于给了一个用户永远点不出来的点数。所以印的必须是「职业+专精 + 某一条
  // 英雄树」的合计，而 95 这个数**恰好不在**允许的集合里。
  var legal = {};
  if (!d.err) {
    (t.h && t.h.length ? t.h : [0]).forEach(function (sid) {
      legal[d.base + (d.per[sid] || 0)] = 1;
    });
  }
  var ptsEm = null;
  ems.forEach(function (e) {
    if (ptsEm || (e.classList && (e.classList.contains('hero') || e.classList.contains('many')))) return;
    if (/^\d+( \/ \d+)* 点$/.test(e.textContent)) ptsEm = e;
  });
  if (!Object.keys(legal).length) {
    // 解不开的串没有「合法点数」可言，跳过（上面 mr 声明不符 已经报过）
  } else if (!ptsEm) {
    loNote('mr 点数没画', label + ' 高亮那一行没印点数');
  } else {
    var shownPts = ptsEm.textContent.replace(' 点', '').split(' / ');
    var bad2 = shownPts.filter(function (x) { return !legal[Number(x)]; });
    if (bad2.length) {
      loNote('mr 点数不合法', label + ' 印的是 ' + ptsEm.textContent
        + '，但游戏里配得出来的只有 ' + Object.keys(legal).join(' / ')
        + ' 点（产物声明 ' + t.p + ' 点）');
    } else {
      stats.mrtPts++;
      if ((t.h || []).length > 1) stats.mrtPtsSplit++;
    }
  }

  // 「通用 N 处」：同一条串在 maxroll 页面上挂在 N 个小节下面，生成器并成一套。
  // 名字里只留了第一个小节，不说出来会以为这套只适用于那一个副本。
  var many = null;
  ems.forEach(function (e) { if (e.classList && e.classList.contains('many')) many = e; });
  if (t.c > 1) {
    stats.mrtManySeen++;
    if (!many) loNote('mr 通用没画', label + ' 这套有 ' + t.c + ' 个小节共用，界面上没说');
    else if (many.textContent !== '通用 ' + t.c + ' 处') {
      loNote('mr 通用不符', label + ' 界面上写「' + many.textContent + '」，产物里 c = ' + t.c);
    } else {
      stats.mrtMany++;
    }
  } else if (many) {
    loNote('mr 通用多画', label + ' 这套只有 1 个小节，却写了「' + many.textContent + '」');
  }

  // 打包了两条英雄天赋的方案必须给出选择条（游戏里只能选一条）。
  // 只有一条的**不该**画那一条 —— 一个只有一个选项的选择器是在骗人。
  if ((t.h || []).length > 1) {
    stats.mrtBundle++;
    if (subBtns !== t.h.length) {
      loNote('mr 英雄条', label + ' 这套打包了 ' + t.h.length
        + ' 条英雄天赋，英雄天赋选择条画了 ' + subBtns + ' 个按钮');
    } else {
      stats.mrtSubBar++;
    }
  } else if (subBtns) {
    loNote('mr 英雄条', label + ' 这套只有 1 条英雄天赋，却画了 ' + subBtns + ' 个选择按钮');
  }

  // 「不给 maxroll 的串」这个决定本身。串版本号 130 游戏必拒，给出来就是害人；
  // 所以页面上任何输入框里都不许出现它。这一条钉的是决定，不是实现。
  if (taVals.indexOf(t.s) >= 0) {
    loNote('mr 又给串了', label + ' 页面上又出现了 maxroll 的串（版本号 130，游戏会拒）');
  } else {
    stats.mrtNoStr++;
  }

  // ---- 第 16 轮：场景标签 / 出手顺序 / 各首领·副本说明 ----
  //
  // 三块的判据都是「面板画出来的 == 产物里声明的」。产物是真值，面板是被测的。

  // 场景标签（单体 / AOE / 顺劈 / 多目标）。**可选字段** —— 实测 167 套里只有
  // 51 套有，因为 maxroll 只有一部分专精按场景分天赋。所以判据不是「必须有」，
  // 而是**个数必须正好等于产物里声明的**：多画一个是编的，少画一个是丢了。
  var wantScen = 0;
  kind.list.forEach(function (x) { wantScen += (x.sc || []).length; });
  // 出手顺序里也会画场景标签（实测 183 条里 14 条带场景），那些也在 scenEls 里。
  var wantPrioScen = (kind.prio || []).filter(function (r) { return r.s; }).length;
  var wantScenTotal = wantScen + wantPrioScen;
  if (scenEls.length !== wantScenTotal) {
    loNote('mr 场景标签', label + ' 场景标签画了 ' + scenEls.length + ' 个，'
      + '产物里声明的是 ' + wantScenTotal + ' 个（方案 ' + wantScen
      + ' + 出手顺序 ' + wantPrioScen + '）');
  } else {
    stats.mrtScen += scenEls.length;
    if (scenEls.length) stats.mrtScenSeen++;
  }
  // 标签的字必须是那四个词之一，且和 class 对得上。写错了界面上就是把 AOE
  // 那套标成单体 —— 用户照着它选，进副本发现打不动。
  var SCEN_ZH = { st: '单体', aoe: 'AOE', cleave: '顺劈', multi: '多目标' };
  scenEls.forEach(function (e) {
    var code = ['st', 'aoe', 'cleave', 'multi'].filter(function (c) {
      return e.classList.contains(c);
    })[0];
    if (!code) {
      stats.mrtScenBad++;
      loNote('mr 场景码', label + ' 场景标签「' + e.textContent + '」没有场景 class');
    } else if (e.textContent !== SCEN_ZH[code]) {
      stats.mrtScenBad++;
      loNote('mr 场景字', label + ' 场景标签 class 是 ' + code + '，字却是「'
        + e.textContent + '」，该是「' + SCEN_ZH[code] + '」');
    }
  });

  // 出手顺序 / 各首领·副本说明：**产物里有就必须画，没有就不许画**。
  // 「没有就不许画」这一半同样重要 —— 画一个空的 <details> 会让人以为
  // maxroll 没写，而其实是面板取错了字段。
  checkNoteBlock(label, '出手顺序', prioBox, kind.prio || [], 'mrtPrio');
  checkNoteBlock(label, '各首领/副本说明', bossBox, kind.boss || [], 'mrtBoss');
}

/**
 * 一块说明（出手顺序 / 首领说明）画得对不对。
 *
 * 判据三条：
 *   · 产物里有几条，界面上就该有几行（`.note-row`）；
 *   · 标题里的条数必须和行数一致 —— 标题写「9 条」而下面 3 行，是最容易漏的错；
 *   · 每行的正文**必须原样等于产物里的字符串**。这一条盯的是「别自作聪明」：
 *     截断、去标点、翻译，任何加工都会让它和产物不一致。这些正文是英文原文，
 *     而本机没有首领名 / 技能名的中英对照表，翻译只能靠编。
 */
function checkNoteBlock(label, what, box, want, statKey) {
  if (!want.length) {
    if (box) loNote('mr 空说明', label + ' 产物里没有' + what + '，界面却画了这一块');
    return;
  }
  if (!box) {
    loNote('mr 缺说明', label + ' 产物里有 ' + want.length + ' 条' + what
      + '，界面上一块都没画');
    return;
  }
  var rows = [];
  walk(box, function (n) {
    if (n.classList && n.classList.contains('note-row')) rows.push(n);
  });
  if (rows.length !== want.length) {
    loNote('mr 说明行数', label + ' ' + what + '画了 ' + rows.length + ' 行，'
      + '产物里是 ' + want.length + ' 条');
    return;
  }
  // 标题里的条数
  var sum = '';
  box.children.forEach(function (c) { if (c.tagName === 'SUMMARY') sum = c.textContent; });
  if (sum.indexOf(String(want.length) + ' 条') < 0) {
    loNote('mr 说明标题', label + ' ' + what + '的标题里没写「' + want.length
      + ' 条」：' + sum.slice(0, 60));
  }
  // 逐行对正文
  var bad = 0;
  rows.forEach(function (row, i) {
    var txt = '';
    walk(row, function (n) {
      if (n.classList && n.classList.contains('en')) txt = n.textContent;
    });
    if (txt !== want[i].t) {
      bad++;
      if (bad < 2) {
        loNote('mr 说明正文', label + ' ' + what + '第 ' + (i + 1)
          + ' 行的正文和产物不一致（产物 ' + want[i].t.length + ' 字，界面 '
          + txt.length + ' 字）—— 这一段是英文原文，不许加工');
      }
    }
  });
  if (!bad) stats[statKey] += rows.length;
}

/**
 * 「画出来的树 == 高亮那一套」的判据。lit = 树上点亮节点的 id 集合。
 *
 * 分三段，各有各的判法：
 *   · 职业树 + 专精树：两条英雄树共用，所以必须**完全等于**串里选中的那些；
 *   · 英雄树：面板只画选中的那一条，所以点亮的必须恰好是「某一条子树 ∩ 串」；
 *   · 多余的：既不在这三棵树的节点集合里，又亮着 —— 那是取错了节点集合。
 * 「选中」包含系统白给的节点（app/talent-decode.js 的 out.nr 也包含），
 * 点数才只算买的 —— 两个集合不是一回事，混用会得到 8 个左右的差（实测）。
 */
function mrTreeLitOk(specId, t, d, lit) {
  var sp = TREE && TREE.specs ? TREE.specs[String(specId)] : null;
  if (!sp) return '天赋树数据里没有这个专精';
  var cs = {}, hero = {};
  (sp.classNodes || []).forEach(function (id) { cs[String(id)] = 1; });
  (sp.specNodes || []).forEach(function (id) { cs[String(id)] = 1; });
  (sp.heroNodes || []).forEach(function (id) { hero[String(id)] = 1; });

  var litCs = [], litHero = [], litElse = [];
  Object.keys(lit).forEach(function (id) {
    if (cs[id]) litCs.push(id);
    else if (hero[id]) litHero.push(id);
    else litElse.push(id);
  });
  if (litElse.length) {
    return '有 ' + litElse.length + ' 个点亮的节点不属于这个专精的三棵树（'
      + litElse.slice(0, 3).join(',') + '）';
  }

  var wantCs = Object.keys(cs).filter(function (id) { return d.sel[id]; });
  var missCs = wantCs.filter(function (id) { return !lit[id]; });
  var extraCs = litCs.filter(function (id) { return !d.sel[id]; });
  if (missCs.length || extraCs.length) {
    return '职业树 + 专精树点亮 ' + litCs.length + ' 个，串里是 ' + wantCs.length
      + ' 个（少 ' + missCs.length + '，多 ' + extraCs.length + '）';
  }

  // 英雄树：点亮的必须恰好是 t.h 里某一条子树在串里选中的全部节点。
  var ok = false, want = [];
  (t.h || []).forEach(function (sid) {
    var ids = Object.keys(hero).filter(function (id) {
      var row = TREE.nodes[id];
      return row && row[6] === sid && d.sel[id];
    });
    want.push(sid + ' 条 ' + ids.length + ' 个');
    if (ids.length !== litHero.length) return;
    var all = true;
    ids.forEach(function (id) { if (!lit[id]) all = false; });
    if (all) ok = true;
  });
  if (!ok) {
    return '英雄树点亮 ' + litHero.length + ' 个，和这一套的任一条子树都不吻合（'
      + want.join('、') + '）';
  }
  return null;
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
  // maxroll 那一块的元素。类名故意和 lo-* 分开（.mr-builds / .mrb / .mr-nostr），
  // 共用的话「导入串块正好 1 个」那条断言会被两块互相喂饱。
  // mrLit 是树上点亮的节点，checkMrTalents 拿它验「画的树就是高亮那一套」；
  // taVals 是页面上所有输入框里的字，用来钉住「不给 maxroll 的串」这个决定。
  var mrBoxes = [], mrNotes = [], mrBtns = [], mrSubBtns = 0, mrLit = {}, taVals = [];
  // 第 16 轮：场景标签（可选）、出手顺序、各首领/副本说明
  var mrScen = [], mrPrio = null, mrBoss = null;
  walk(body, function (n) {
    checkA11y(n, label);
    if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') taVals.push(n.value);
    if (!n.classList) return;
    if (n.classList.contains('tree-canvas')) canvases.push(n);
    if (n.classList.contains('bis-loadout')) loBoxes.push(n);
    if (n.classList.contains('lo-text')) loTexts.push(n);
    if (n.classList.contains('lo-copy')) loCopies.push(n);
    if (n.classList.contains('lo-pick')) loPicks += n.children.length;
    if (n.classList.contains('mr-builds')) mrBoxes.push(n);
    if (n.classList.contains('mr-nostr')) mrNotes.push(n);
    if (n.classList.contains('mrb')) mrBtns.push(n);
    if (n.classList.contains('scen')) mrScen.push(n);
    // 两块说明：按 class 认，各只该有一个（<details>）。
    if (n.classList.contains('mr-prio')) mrPrio = n;
    if (n.classList.contains('mr-boss')) mrBoss = n;
    // 英雄天赋选择条。.tree-pick 这个类名两条路都在用（插件那条是「套路」），
    // 所以按 .lb 的字认，不按类名 —— 认错的话「只有一条也画了选择条」那条
    // 断言会被插件那条路的按钮喂饱，永远不报。
    if (n.classList.contains('tree-pick')) {
      var lb = null;
      n.children.forEach(function (c) {
        if (c.classList && c.classList.contains('lb')) lb = c;
      });
      if (lb && lb.textContent === '英雄天赋') mrSubBtns += n.children.length - 1;
    }
    if (n.classList.contains('tree-grid')) { grids++; stats.tgrids++; }
    if (n.classList.contains('tree-edge')) {
      stats.tedges++;
      if (n.classList.contains('on')) stats.tedgeOn++;
    }
    if (n.classList.contains('tnode')) {
      nodes++;
      stats.tnodes++;
      if (n.classList.contains('on')) stats.tnodeOn++;
      if (n.classList.contains('on') && n.attrs['data-node']) {
        mrLit[String(n.attrs['data-node'])] = 1;
      }
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
  checkMrTalents(label, specId, mrBoxes, mrNotes, mrBtns, mrSubBtns, mrLit, taVals,
    mrScen, mrPrio, mrBoss);

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

// ---- maxroll 天赋页的三个开关：换类型 / 换方案 / 换英雄树 --------------------
//
// 上面那 43 次渲染**一次都没按过它们**：state.mrKind / mrBuild / mrSub 都不持久化，
// 每次 load 都从「大秘境 第 0 套 第 0 条英雄树」开始。于是「换方案」这条路
// 在测试里从来没被走过，而套件照样全绿 —— 又一次「没跑报成通过」。
// 所以这里真去点：点完重新走一遍 checkTalents，让上面每条断言在**换过之后**
// 的界面上再验一次（尤其是「高亮那一行和显示的串是同一套」）。
function findBtns(cls) {
  var out = [];
  walk(body, function (n) {
    if (n.classList && n.classList.contains(cls)) out.push(n);
  });
  return out;
}
function findSubPickBtns() {
  var out = [];
  walk(body, function (n) {
    if (!n.classList || !n.classList.contains('tree-pick')) return;
    var lb = null;
    n.children.forEach(function (c) {
      if (c.classList && c.classList.contains('lb')) lb = c;
    });
    if (lb && lb.textContent === '英雄天赋') {
      n.children.forEach(function (c) { if (c !== lb) out.push(c); });
    }
  });
  return out;
}
function findKindBtn(text) {
  var out = null;
  walk(body, function (n) {
    if (out || !n.classList || !n.classList.contains('seg')) return;
    n.children.forEach(function (c) {
      if (!out && c.textContent === text && !c.classList.contains('on')) out = c;
    });
  });
  return out;
}
specKeys.forEach(function (key) {
  var specId = B.specs[key].specId;
  if (!mrTalentTruth(specId)) return;
  settings.bisTab = 'talents';
  settings.bisSpec = key;
  settings.bisTalentCat = 'raid';
  body.children.length = 0;
  load('app/bis.js');
  g.AE.openBis();
  if (!findBtns('mr-builds').length) return;   // 这个专精没走 maxroll 那条路

  // 换方案：点第 2 套。只有 1 套的跳过（没有第 2 套可点，不是缺陷）。
  //
  // 点完必须**确认高亮真的挪过去了**。只点不看的话「按钮的 onClick 写死成
  // state.mrBuild = 0」这种接线错完全测不出来：界面自洽（高亮第 0 套、串是第 0 套），
  // 只是按钮不管用 —— 而按钮不管用正是用户第一眼就会撞上的东西。
  var bs = findBtns('mrb');
  if (bs.length > 1) {
    bs[1].click();
    var on2 = -1;
    findBtns('mrb').forEach(function (b, i) { if (b.classList.contains('on')) on2 = i; });
    if (on2 !== 1) {
      loNote('mr 换方案没生效', '天赋 ' + key + ' 点了第 2 套，高亮却在第 ' + on2 + ' 套');
    } else {
      stats.mrtBuildSw++;
    }
    checkTalents('天赋 ' + key + '/第2套', specId);
  }
  // 换英雄树：打包了两条的才有这一条。
  var subs = findSubPickBtns();
  if (subs.length > 1) {
    subs[1].click();
    var sub2 = findSubPickBtns();
    if (!sub2[1] || !sub2[1].classList.contains('on')) {
      loNote('mr 换英雄树没生效', '天赋 ' + key + ' 点了第 2 条英雄天赋，它没有变成高亮');
    } else {
      stats.mrtSubSw++;
    }
    checkTalents('天赋 ' + key + '/换英雄树', specId);
  }
  // 换类型：默认是大秘境，点「团本」。两种都有的专精才点得到。
  var kb = findKindBtn('团本');
  if (kb) {
    kb.click();
    var st = (doc.getElementById('bis-sub') || {}).textContent || '';
    if (st.indexOf('团本指南') < 0) {
      loNote('mr 换类型没生效', '天赋 ' + key + ' 点了「团本」，副标题还是：' + st);
    } else {
      stats.mrtKindSw++;
    }
    checkTalents('天赋 ' + key + '/团本', specId);
  }
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
if (stats.cov + stats.sn + stats.mr !== stats.slots) {
  problems.push('覆盖率徽章 ' + stats.cov + ' + 样本量徽章 ' + stats.sn
    + ' + maxroll 徽章 ' + stats.mr + ' = ' + (stats.cov + stats.sn + stats.mr)
    + '，部位组 ' + stats.slots + ' 个，不一一对应');
}
if (stats.covBad > 0) problems.push(stats.covBad + ' 个覆盖率徽章文字不合格式');
if (stats.snBad > 0) problems.push(stats.snBad + ' 个样本量徽章文字不合格式');
if (stats.mrBad > 0) problems.push(stats.mrBad + ' 个 maxroll 徽章文字不合格式');
// 空转守卫：三种徽章都必须真的出现过。少了一种说明那条路没被画到，
// 而上面那条求和等式在「某条路整个缺席」时照样成立 —— 加视角那一轮
// 就是这么假绿的（渲染次数一个都没涨，套件却全绿）。
if (stats.mr < 1) problems.push('一个 maxroll 徽章都没画出来，「最佳推荐」视角没被渲染');
if (stats.sn < 1) problems.push('一个样本量徽章都没画出来，「实战分布」视角没被渲染');
// 覆盖率徽章现在**只**出自 GearInsight 兜底那条路（第 16 轮撤掉了那两个视角按钮，
// 但 maxroll 懒加载没到时还得靠它画）。所以这一条不再是「BisData 视角没渲染」，
// 而是「首屏兜底没被走到」—— 实测 46 个，全部来自下面那 3 次兜底渲染。
if (stats.cov < 1) {
  problems.push('一个覆盖率徽章都没画出来 —— GearInsight 兜底那条路没被渲染'
    + '（它只在 maxroll 数据还没加载时出现，见 checkFirstPaintFallback）');
}
if (stats.slots < 1000) problems.push('只画了 ' + stats.slots + ' 个部位组，太少');

// ---- 视角迁移（第 16 轮撤掉 GearInsight 那两个视角按钮）
if (stats.vmChecked !== 4) {
  problems.push('视角迁移只验了 ' + stats.vmChecked + ' 个存档值，应该是 4 个'
    + '（raid / mplus / maxroll / rio）');
}
if (stats.vmMigrated < 3) {
  problems.push('只有 ' + stats.vmMigrated + ' 个存档值落在「最佳推荐」上，'
    + '应该是 3 个（raid / mplus 迁过来，加上 maxroll 自己）');
}
if (stats.vmWrote !== 2) {
  problems.push('只有 ' + stats.vmWrote + ' 个撤掉的视角名被写回成 maxroll，'
    + '应该是 2 个（raid / mplus）—— 迁移只改了内存没落盘');
}

// ---- 装等那一格：这一轮那个 bug 的回归
//
// maxroll 不给装等，装等是从本机两份实测数据借的（见 app/bis.js 的 measuredGear）。
// 三条路都必须真的画出来过，否则「文字必须合格」那条在空集合上恒真。
// 实测：GearInsight 给出 1393 行、raider.io 补 15 行、两边都没有 3 行。
if (stats.ivZero > 0) {
  problems.push(stats.ivZero + ' 行装等印成了 0 或别的非正整数 —— '
    + '上一版就是这样（从 rio 物品池取 ilvl，而那个字段不存在）');
}
if (stats.ivGi < 1000) {
  problems.push('只有 ' + stats.ivGi + ' 行装等标着 GearInsight 来源，太少'
    + '（实测 1393 行）—— 装等那一格没画出来，或者来源标记丢了');
}
// 下面两条是**小样本下界**。它们盯的是「另外两条分支真的会被画到」：
// raider.io 补的那 15 行画的是虚下划线，两边都没有的 3 行画的是「装等 ?」。
// 换赛季重抓后如果 GearInsight 恰好覆盖了全部引用，这两条会误红 ——
// 那时把数字改成 0 并在这里记一句「本赛季没有这种物品」，别把断言删掉。
if (stats.ivRio < 1) {
  problems.push('没有一行装等来自 raider.io —— 那条兜底分支没被画到'
    + '（实测有 15 行：GearInsight 里查不到、榜上有人穿过的物品）');
}
if (stats.ivNone < 1) {
  problems.push('没有一行画出「装等 ?」—— 两份实测数据都查不到的物品那条分支没被画到'
    + '（实测有 3 行）');
}

// ---- 装等差距
//
// 这一组只有**选了对照角色**才画得出来，所以下界是必须的：上面所有渲染
// bisChar 都是空的，一个差距徽章都不会出现，而「徽章文字必须合格」那条
// 在 0 个徽章时照样成立。
if (stats.gapBad > 0) {
  problems.push(stats.gapBad + ' 个装等差距徽章的文字和 class 对不上'
    + '（「差 N」必须配 behind、「高 N」配 ahead、「持平」配 even）');
}
if (stats.gapChars > 0) {
  // 有存档的机器上才验下界。克隆下来没有 data/data.js 的人跑到的是 0，
  // 那不是缺陷 —— 摘要里会写「对照过 0 个角色」，看得见。
  if (stats.gapBadge < 100) {
    problems.push('装等差距徽章只画了 ' + stats.gapBadge + ' 个，太少'
      + '（实测 ' + stats.gapChars + ' 个角色 × 2 个视角 = 183 个）');
  }
  // 复核过的必须**等于**画出来的：写成「> 0」的话，183 个徽章里只有 1 个
  // 被复核也能过，而那意味着另外 182 个的差值从没验过。
  if (stats.gapMath !== stats.gapBadge) {
    problems.push('装等差距徽章 ' + stats.gapBadge + ' 个，差值独立复核过的只有 '
      + stats.gapMath + ' 个，不一一对应');
  }
  if (stats.gapTopBad > 0) {
    problems.push(stats.gapTopBad + ' 个装等差距比的不是这个部位首选那一件');
  }
  if (stats.gapTop < 100) {
    problems.push('只有 ' + stats.gapTop + ' 个装等差距复核过「比的是首选那一件」，太少');
  }
  if (stats.gapSum !== stats.gapSlots) {
    problems.push('装等差距汇总行 ' + stats.gapSum + ' 条，对照渲染 ' + stats.gapSlots
      + ' 次，不一一对应 —— 每次对照渲染都该有一条汇总');
  }
}

// ---- 「实战分布」视角（rio）
// 这一组是**独立的**，不能靠上面的总量断言兜着：rio 视角要是一个部位都没画，
// 总量只会从 1264 掉到 1264 —— 因为它本来就没被算进去过。
// 本轮加这个视角时正是这样：套件全绿，渲染次数一字未变，等于新代码从没跑过。
if (stats.mainRio !== specKeys.length) {
  problems.push('实战分布视角在专精循环里只渲染了 ' + stats.mainRio + ' 次，应该是 '
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
// 这一行必须打印：装等和差距是第 16 轮加的，而「加了计数器、写了断言、
// 既不打印也没下界」在本仓库出过一次 —— 那次整块功能没被画过，套件照样全绿。
console.log(pad('装等 / 差距') + '通过（视角按钮 2 个，旧视角 '
  + stats.vmMigrated + ' 个存档值迁到「最佳推荐」；装等来源 GearInsight '
  + stats.ivGi + ' 行、raider.io ' + stats.ivRio + ' 行、查不到 ' + stats.ivNone
  + ' 行、印成 0 的 ' + stats.ivZero + ' 行；对照 ' + stats.gapChars
  + ' 个角色 × 2 个视角，差距徽章 ' + stats.gapBadge + ' 个（文字与颜色不符 '
  + stats.gapBad + '，差值拿提示里的两个数独立复核 ' + stats.gapMath
  + '，比的是首选那一件 ' + stats.gapTop + '（不符 ' + stats.gapTopBad
  + '）），汇总行 ' + stats.gapSum + '）');
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

// ---- maxroll 天赋方案（第 15 轮：天赋页改成以 maxroll 为主）
// 门槛全部写成「和渲染次数相等」，不是「> 0」：这一组的每条断言都在
// truth 为空时提前 return，只要一个下界写松，「整块没画出来」就会安静地全绿。
// 专精数写成实测的 37（40 个里战士武器 / 德鲁伊平衡 / 武僧织雾一条串都解不开，
// 生成器一条都没收）—— 换赛季重抓之后这个数会变，那时该连带改这里，
// 正是希望发生的事。
var MRT_SPECS = 0;
specKeys.forEach(function (k) {
  if (mrTalentTruth(B.specs[k].specId)) MRT_SPECS++;
});
// 产物层面的去重：同一个类型的列表里不许有两条一样的串。
//
// 这一条是这一轮那个 bug 的直接封条：maxroll 每个副本 / 每个首领的小节各带一个
// 天赋图，第一版生成器按「串 + 名字」去重，于是同一套方案照着 9~13 个小节名
// 各留了一行 —— 界面上就是一排名字几乎一样的按钮，点开画的是同一棵树。
// 现在按**串本身**去重，共用的小节数记进 c。这里对着产物再验一遍。
var mrDup = 0, mrMax = 0, mrTotal = 0;
specKeys.forEach(function (k) {
  var truth = mrTalentTruth(B.specs[k].specId);
  if (!truth) return;
  truth.forEach(function (kb) {
    var seen = {};
    if (kb.list.length > mrMax) mrMax = kb.list.length;
    mrTotal += kb.list.length;
    kb.list.forEach(function (t) {
      if (seen[t.s]) {
        mrDup++;
        if (mrDup < 4) {
          problems.push('maxroll 产物里 ' + k + '/' + kb.kind + ' 有两套方案的串一样（「'
            + t.n + '」）—— 去重没生效，界面上会出现一排点开是同一棵树的按钮');
        }
      }
      seen[t.s] = 1;
      if (!(t.c >= 1)) {
        problems.push('maxroll 产物里 ' + k + '/' + kb.kind + '「' + t.n + '」没有 c（共用小节数）');
      }
    });
  });
});
if (mrTotal < 100) problems.push('maxroll 产物里只有 ' + mrTotal + ' 套方案，取数路径不对');
// 绝对下界。上面每条断言都是「和渲染次数相等」——**真值恒为空的时候它们全是
// 0 = 0**，整组会安静地全绿，正是这个项目反复踩的那种假绿。所以先钉死
// 「产物里确实有这么多专精有方案」和「确实画了这么多次」。
if (MRT_SPECS < 30) {
  problems.push('产物里只有 ' + MRT_SPECS + ' 个专精有 maxroll 天赋方案（实测 37），取数路径不对');
}
if (stats.mrtRenders < MRT_SPECS) {
  problems.push('maxroll 天赋只渲染了 ' + stats.mrtRenders + ' 次，少于有方案的专精数 '
    + MRT_SPECS);
}
if (stats.mrtSpecs !== MRT_SPECS) {
  problems.push('maxroll 天赋只检查了 ' + stats.mrtSpecs + ' 个专精，产物里有 '
    + MRT_SPECS + ' 个（有方案的专精必须都走到 maxroll 那条路）');
}
if (stats.mrtBox !== stats.mrtRenders) {
  problems.push('maxroll 方案列表 + 说明只对上 ' + stats.mrtBox + ' 次，渲染 '
    + stats.mrtRenders + ' 次，不一一对应');
}
if (stats.mrtTree !== stats.mrtRenders) {
  problems.push('「画出来的树就是高亮那一套」只验过 ' + stats.mrtTree + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
if (stats.mrtSpec !== stats.mrtRenders) {
  problems.push('maxroll 串头 specID 只验过 ' + stats.mrtSpec + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
if (stats.mrtName !== stats.mrtRenders) {
  problems.push('「高亮方案的名字和产物一致」只验过 ' + stats.mrtName + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
if (stats.mrtDecl !== stats.mrtRenders) {
  problems.push('产物声明的点数 / 英雄子树只独立解码复核过 ' + stats.mrtDecl + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
if (stats.mrtPts !== stats.mrtRenders) {
  problems.push('「印出来的点数是游戏里配得出来的」只验过 ' + stats.mrtPts + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
// 打包两条英雄天赋的方案：那才是「印 95 点」这个 bug 的现场，一次都没走到
// 等于这条断言不存在。
if (stats.mrtPtsSplit < 10) {
  problems.push('打包两条英雄天赋的方案里，点数只复核过 ' + stats.mrtPtsSplit + ' 次，太少');
}
if (stats.mrtNoStr !== stats.mrtRenders) {
  problems.push('「页面上没有 maxroll 的串」只验过 ' + stats.mrtNoStr + ' 次，渲染 '
    + stats.mrtRenders + ' 次');
}
// 「通用 N 处」：去重之后大部分方案都挂在多个小节下面（实测 167 套里绝大多数），
// 一次都没遇到说明取的不是去重后的产物。
if (stats.mrtMany !== stats.mrtManySeen) {
  problems.push('有 ' + stats.mrtManySeen + ' 套方案是多个小节共用的，界面上只说对了 '
    + stats.mrtMany + ' 次');
}
if (stats.mrtManySeen < 10) {
  problems.push('只遇到 ' + stats.mrtManySeen + ' 套「多个小节共用」的方案，太少');
}
// 打包两条英雄天赋的方案：实测去重后 167 套里 82 套是这样，所以「一次都没遇到」
// 说明这条路没走到，而它恰恰是 maxroll 独有、最容易画错的那一条。
if (stats.mrtSubBar !== stats.mrtBundle) {
  problems.push('打包多条英雄天赋的方案遇到 ' + stats.mrtBundle + ' 次，选择条只对上 '
    + stats.mrtSubBar + ' 次');
}
if (stats.mrtBundle < 10) {
  problems.push('只遇到 ' + stats.mrtBundle + ' 套「打包两条英雄天赋」的方案，太少');
}
// 三个开关必须真被按过。不按的话它们在测试里等于不存在（state 不持久化，
// 每次渲染都是「大秘境 第 0 套 第 0 条」）。
// ---- 第 16 轮：场景标签 / 出手顺序 / 各首领·副本说明 ----
//
// 三条都是**下界**，因为逐条的「等于产物」那些断言在数据为空时全是恒真的
// （空集合上的全称命题）。产物里的真值：51 套方案带场景、183 条出手顺序、
// 252 条首领说明 —— 渲染只走每个专精的一个类型，所以界面上遇到的是其中一部分。
if (stats.mrtScenBad > 0) {
  problems.push(stats.mrtScenBad + ' 个场景标签的字和 class 对不上'
    + '（把 AOE 那套标成单体，用户照着它选会进副本发现打不动）');
}
if (stats.mrtScenSeen < 10) {
  problems.push('只有 ' + stats.mrtScenSeen + ' 次渲染画出了场景标签，太少'
    + ' —— 产物里 51 套方案带场景（单体 / AOE / 顺劈 / 多目标），'
    + '一次都不画说明 sc 那个字段没接上');
}
if (stats.mrtPrio < 50) {
  problems.push('出手顺序只逐条对过 ' + stats.mrtPrio + ' 行，太少'
    + '（产物里 183 条）—— 那一块没画，或者正文被加工过');
}
if (stats.mrtBoss < 50) {
  problems.push('各首领 / 副本说明只逐条对过 ' + stats.mrtBoss + ' 行，太少'
    + '（产物里 252 条）—— 那一块没画，或者正文被加工过');
}

if (stats.mrtBuildSw < 20) problems.push('「换方案」只点过 ' + stats.mrtBuildSw + ' 次，太少');
if (stats.mrtSubSw < 5) problems.push('「换英雄树」只点过 ' + stats.mrtSubSw + ' 次，太少');
if (stats.mrtKindSw < 5) problems.push('「换团本 / 大秘境」只点过 ' + stats.mrtKindSw + ' 次，太少');
console.log(pad('maxroll 天赋') + (stats.mrtSpecs === MRT_SPECS
    && stats.mrtBox === stats.mrtRenders && stats.mrtTree === stats.mrtRenders
    && stats.mrtPts === stats.mrtRenders && stats.mrtDecl === stats.mrtRenders
    && stats.mrtNoStr === stats.mrtRenders ? '通过' : '有问题')
  + '（' + stats.mrtSpecs + '/' + specKeys.length + ' 个专精 / ' + stats.mrtRenders
  + ' 次渲染，方案按钮 ' + stats.mrtBtns + '，画出来的树和高亮那一套同一套 '
  + stats.mrtTree
  + '，点数与英雄子树独立解码复核 ' + stats.mrtDecl
  + '，印的点数游戏里配得出来 ' + stats.mrtPts + '（其中打包两条的 '
  + stats.mrtPtsSplit + '）'
  + '，多个小节共用说清楚 ' + stats.mrtMany
  + '，产物里 ' + mrTotal + ' 套方案无重复串（一个专精最多 ' + mrMax + ' 套）'
  + '，打包多条英雄树 ' + stats.mrtBundle + ' 套都给了选择条'
  + '，真点过：换方案 ' + stats.mrtBuildSw + '、换英雄树 ' + stats.mrtSubSw
  + '、换类型 ' + stats.mrtKindSw + '）');
// 单独一行：第 16 轮加的三块。**必须打印** —— 「加了计数器、写了断言、
// 既不打印也没下界」在这个仓库出过一次，那次整块功能从没被画过而套件全绿。
console.log(pad('　场景 / 说明') + (stats.mrtScenBad ? '有问题' : '通过')
  + '（场景标签 ' + stats.mrtScen + ' 个（字与 class 不符 ' + stats.mrtScenBad
  + '），出手顺序逐条对过 ' + stats.mrtPrio + ' 行，各首领 / 副本说明 '
  + stats.mrtBoss + ' 行　正文与产物逐字节相同，英文原文不加工）');

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
  { label: 'rio 装备分布', script: 'verify-rio-data.js', data: 'rio-data.js' },
  { label: 'maxroll 推荐', script: 'verify-maxroll-data.js', data: 'maxroll-data.js' }
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

// ----------------------------------------------------------------------- 并发池
// fetch-rio.js 的 pool() 有一个**只在缓存全命中时才炸**的坑，本轮实测踩到：
// worker 平时异步回调（发请求），缓存命中时**同步**回调，于是 next() 在同步回调里
// 再调 next()，栈深度跟条目数同阶。`--offline` 跑 3994 个角色到第 1539 个就
// Maximum call stack size exceeded —— 也就是**缓存越全越容易崩**，
// 而「全用缓存」正是这套缓存存在的理由（断点续抓、离线重新产出）。
//
// 这条测试用的条目数 5000 是有来由的：修复前实测崩在第 3384 条，
// 取一个明显超过它的数，才能保证这条断言真的压得到那个坑。
(function () {
  var RIO;
  try { RIO = require('./fetch-rio.js'); } catch (e) {
    problems.push('并发池：require fetch-rio.js 失败：' + e.message);
    console.log(pad('并发池') + '加载失败');
    return;
  }
  if (typeof RIO.pool !== 'function') {
    problems.push('并发池：fetch-rio.js 没有导出 pool()，回归测试压不到东西');
    console.log(pad('并发池') + '没有 pool');
    return;
  }
  // 状态行必须和断言看同一份数据。第一版只看 crashed，结果「done 多调一次」
  // 这个变异明明被 doneCount 断言抓到了（problems 里有、退出码 1），
  // 这一行却照样印「通过」—— 状态行说的和断言查的不是一回事，就是假绿。
  var before = problems.length;
  var N = 5000, checks = 0;

  // 这条测试的力量全在 N 上：修复前实测崩在第 3384 条，N 必须明显超过它。
  // 没有这条下限，以后谁把 N 调小一点，这条断言就会变成一个永远绿的空测试 ——
  // 「不炸栈」在 100 条的时候本来就不炸。
  if (N <= 3384) {
    problems.push('并发池：条目数太少（' + N + '），压不到那个坑'
      + '（修复前实测崩在第 3384 条，N 必须明显大于它）');
  }

  // 甲：同步 worker（= 缓存全命中）。要求走完、顺序不重不漏、done 只调一次。
  var seen = [], doneCount = 0, crashed = null;
  try {
    RIO.pool(new Array(N).join(',').split(',').map(function (_, i) { return i; }),
      1,
      function (it, cb) { seen.push(it); cb(); },
      function () { doneCount++; });
  } catch (e) { crashed = e; }

  if (crashed) {
    problems.push('并发池：同步 worker 跑 ' + N + ' 条崩了（'
      + crashed.message + '），走到第 ' + seen.length + ' 条。'
      + '这正是「缓存全命中导致栈溢出」那个坑');
  } else {
    checks++;
    if (seen.length !== N) {
      problems.push('并发池：同步 worker 只走了 ' + seen.length + ' 条，应该是 ' + N);
    }
    checks++;
    var ordered = true;
    for (var i = 0; i < seen.length; i++) if (seen[i] !== i) { ordered = false; break; }
    if (!ordered) problems.push('并发池：同步 worker 的条目重了或漏了');
    checks++;
    if (doneCount !== 1) {
      problems.push('并发池：同步 worker 的 done 调了 ' + doneCount + ' 次，应该正好 1 次');
    }
  }

  // 乙：异步 worker（= 真发请求）。同一份实现两条路都得对，
  // 否则「修好同步那条、弄坏异步那条」会静默通过。
  var aSeen = 0, aDone = 0;
  RIO.pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3,
    function (it, cb) { aSeen++; setTimeout(cb, 0); },
    function () { aDone++; });
  // setTimeout 还没跑完，这里只能断言「已经派出去了并发上限那么多」——
  // 派出 3 个正是并发度 3 的意思，派出 10 个就说明并发限制没生效。
  checks++;
  if (aSeen !== 3) {
    problems.push('并发池：并发度 3 应该先派出 3 个 worker，实际派出 ' + aSeen);
  }

  if (checks < 4) problems.push('并发池：只跑到 ' + checks + ' 项检查，测试没跑起来');
  // 括号里印**实测到的数**，不是「应该怎样」的口号。
  // 上一版写死了「不炸栈，done 一次，并发度生效」，结果 done 被调两次时
  // 这行照样自夸「done 一次」—— 断言红了、自述还在说好话，两边数据不同源。
  console.log(pad('并发池')
    + (crashed ? '崩了' : (problems.length > before ? '有问题' : '通过'))
    + '（同步 worker ' + N + ' 条走完 ' + seen.length + '，顺序'
    + (ordered ? '不重不漏' : '有重漏') + '，done ' + doneCount + ' 次，'
    + '并发度 3 实际派出 ' + aSeen + '）');
})();

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
  ? '全部通过：' + total.pass + ' 项测试 + 装备渲染 + 天赋树渲染 + maxroll 天赋方案'
    + ' + 无障碍 + 三项格式校验 + 天赋串解码对真值 + 并发池 + 打包一致性'
  : '有问题：' + total.fail + ' 项测试失败，' + problems.length + ' 个渲染/格式问题');
process.exit(bad === 0 ? 0 : 1);
