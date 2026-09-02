/*
 * WowAltBoard - tools/mutate-ilvlgap.js
 *
 * 「装等 / 装等差距 / 撤掉的两个视角」那一组断言的变异测试。
 *
 * 为什么这一组要单独一份
 * ---------------------
 * 这一轮改的东西横跨三件事，而它们的失败方式互不相同：
 *   · **装等**：maxroll 自己不给装等（实测 81 篇缓存里 `Item Level` 只出现 2 次，
 *     都是正文提醒；`data-wow-item` 那个 blob 里 offset 2 的字段只有 16 个取值、
 *     257/259/261 占绝大多数，是标志位不是装等；backend 的 embed 接口要 OAuth）。
 *     所以装等是从本机两份**实测**数据借的。上一版从 rio 的物品池取 `ilvl` ——
 *     那个字段根本不存在，于是每一行都印着「0」，而套件全绿。
 *   · **装等差距**：它是个**算出来的数**，有符号。符号反了界面完全自洽
 *     （「高 14」配淡色，一致），只有拿提示里的原始两个数自己减一遍才抓得到。
 *   · **撤掉的视角**：删按钮很容易，难的是「存档里还留着那个视角名」——
 *     不迁移的话面板停在一个渲染一切正常、却切不回去的视角里。
 *     而迁移这段代码**天然容易写成死代码**（state.view 初值本来就是 maxroll），
 *     所以有一条专门盯「有没有写回存档」。
 *
 * 严格程度和别的 mutate-*.js 一档：**每个变异体必须让指定的那句话出现在输出里**，
 * 光「退出码非 0」不算抓到。锚点在文件里出现次数不是 1，同样直接算失败。
 *
 * 用法：node tools\mutate-ilvlgap.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var BIS = path.join(ROOT, 'app', 'bis.js');
var RUNNER = path.join(__dirname, 'run-tests.js');

lock.acquire('mutate-ilvlgap');
process.on('exit', lock.release);

function run() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 见 mutate-loadout.js 的同名函数：锚点必须正好出现一次，否则算锚点失效。 */
function textMutant(desc, file, from, to, want) {
  return {
    desc: desc, want: want,
    apply: function () {
      var orig = fs.readFileSync(file, 'utf8');
      var n = orig.split(from).length - 1;
      if (n !== 1) {
        console.log('    锚点在文件里出现 ' + n + ' 次（必须正好 1 次）');
        return null;
      }
      fs.writeFileSync(file, orig.replace(from, to));
      return function () { fs.writeFileSync(file, orig); };
    }
  };
}

var MUTANTS = [
  // ---- 装等那一格 ----

  // 退回上一版：从 rio 的物品池取 ilvl。那个字段不存在，于是每行都是 0。
  // 这一条就是这一轮修的那个 bug 的回归。
  textMutant('装等退回「从 rio 物品池取 ilvl」（上一版那个 bug）', BIS,
    '    var MEAS = measuredGear();',
    '    var MEAS = {};',
    '行装等标着 GearInsight 来源，太少'),

  // 只去掉「0 不印」那道闸：查不到的行会印出 0 来。
  textMutant('装等为 0 也照印', BIS,
    '    if (ilvl) {\n      var sub = el(\'span\', \'sub2\');',
    '    if (true) {\n      var sub = el(\'span\', \'sub2\');',
    '装等该是正整数'),

  // 装等来源标记丢掉：界面上「703」和「312」看着是同一种数。
  textMutant('装等不标是谁测的', BIS,
    "        sub.classList.add(ivSrc === 'r' ? 'iv-rio' : 'iv-gi');",
    '        /* mutant: 不标来源 */',
    '行装等标着 GearInsight 来源，太少'),

  // rio 那条兜底分支去掉：15 行装等会变成「装等 ?」。
  textMutant('装等不退到 raider.io 的榜上均值', BIS,
    '      Object.keys(acc).forEach(function (id) {\n        if (out[id]) return;',
    '      Object.keys(acc).forEach(function (id) {\n        if (true) return;',
    '没有一行装等来自 raider.io'),

  // 反过来：让 rio 覆盖 GearInsight。两个来源不是同一个量（中位差 10 点），
  // 混着用等于把「升满的样子」和「榜上平均的样子」当成一个数。
  textMutant('raider.io 的均值盖掉 GearInsight 的实测值', BIS,
    '        if (out[id]) return;            // GearInsight 已经给了，不覆盖',
    '        /* mutant: 覆盖 */',
    '行装等标着 GearInsight 来源，太少'),

  // 查不到时不画「装等 ?」，静默留空 —— 用户分不出「没查到」和「没这一格」。
  textMutant('查不到装等时什么都不画', BIS,
    "    } else if (isMr) {\n      var noiv = el('span', 'sub2 iv-none', '装等 ?');",
    "    } else if (false) {\n      var noiv = el('span', 'sub2 iv-none', '装等 ?');",
    '没有一行画出「装等 ?」'),

  // ---- 装等差距 ----

  // 整块不画。下界断言的意义就在这里。
  textMutant('装等差距徽章整块不画', BIS,
    // 锚点跟着代码走：slotGap 第 21 轮多了一个参数（成对去重之后，比的是这一格
    // 推荐的那件，不一定是 rows[0]）。
    '      var gap = slotGap(rows, mine, pi);\n      if (gap) {',
    '      var gap = slotGap(rows, mine, pi);\n      if (false) {',
    '装等差距徽章只画了 0 个'),

  // **符号反过来。** 文字和 class 会一起翻，两者依然一致 ——
  // 只有「拿提示里的两个数自己减一遍」抓得到。这是这一组存在的主要理由。
  textMutant('差距符号反了（你落后说成你领先）', BIS,
    '    return { d: Math.round(want - mine.itemLevel),',
    '    return { d: Math.round(mine.itemLevel - want),',
    '符号或算式反了'),

  // 颜色和数字对不上：落后画成淡色，领先画成警告色。
  // 用户照着颜色做的决定正好是反的。
  textMutant('差距的颜色和数字对不上', BIS,
    "        var gb = el('span', 'tag gap' + (gap.d > 0 ? ' behind' : (gap.d < 0 ? ' ahead' : ' even')),",
    "        var gb = el('span', 'tag gap' + (gap.d > 0 ? ' ahead' : (gap.d < 0 ? ' behind' : ' even')),",
    '配的是 class'),

  // 比的对象错了：拿列表里最后一件（往往是「可刷替代」的末位）当首选。
  // 差距会凭空变小，用户以为自己已经很接近毕业了。
  //
  // **这一条处处自洽**：徽章文字、颜色、提示里的两个数全都出自同一个 top，
  // 三者一致，连「拿提示里的两个数自己减一遍」也照样过 —— 那条只能验算术。
  // 抓它必须从 DOM 里另找一个来源：这个部位**第一行**画出来的装等
  // （见 run-tests.js 的 checkSlotGapTarget）。
  textMutant('差距拿列表最后一件比，而不是首选那件', BIS,
    '    var top = rows[pickIdx > 0 && rows[pickIdx] ? pickIdx : 0];\n    var want = top[1];',
    '    var top = rows[rows.length - 1];\n    var want = top[1];',
    '比的不是首选那一件'),

  // 提示里不写原始的两个数 —— 差值就没法独立复核了。
  // 这一条盯的是「可核对性」本身：徽章上那个数变成了无法验证的断言。
  textMutant('提示里不写「你 X　首选那件 Y」', BIS,
    "          '你 ' + gap.mine + '　首选那件 ' + gap.want + '（' + gap.srcText + '）\\n'",
    "          '装等差距\\n'",
    '差值就没法独立复核了'),

  // 缺一边也照算。这一条的后果比「数字错」更直接：身上没穿 / 存档没记这个部位时
  // mine 是 null，`mine.itemLevel` 当场 TypeError，整个面板渲染崩掉。
  // 所以 want 盯的是崩溃栈里的函数名 —— 这是这一组里唯一一个「炸出来」的变异体，
  // 写成别的句子会被判「串了」，而它其实是抓到了。
  textMutant('装等缺一边也照算差距（会崩）', BIS,
    '    if (!mine || !mine.itemLevel || !rows || !rows.length) return null;',
    '    if (!rows || !rows.length) return null;',
    'at slotGap'),

  // 汇总行不画。它是唯一说清「分母是几个部位」的地方。
  textMutant('装等差距汇总行不画', BIS,
    '      if (gapN) {\n        var gsum = el(\'p\', \'bis-sum gap-sum\');',
    '      if (false) {\n        var gsum = el(\'p\', \'bis-sum gap-sum\');',
    '汇总行 0 条'),

  // ---- 撤掉的两个视角 ----

  // 按钮加回来。这一轮的决定是「只留两个视角」，悄悄加回来必须报红。
  textMutant('把撤掉的「团本视角」按钮加回来', BIS,
    "      ['rio', '实战分布',",
    "      ['raid', '团本视角', '来自 GearInsight 的团本参照表'],\n      ['rio', '实战分布',",
    '第 16 轮撤掉了它'),

  // 迁移不写回存档。**这一条盯的是死代码**：state.view 初值本来就是 maxroll，
  // 光不写回的话界面表现一模一样，只有「下次打开」才看得出区别。
  textMutant('旧视角只改内存不写回存档', BIS,
    "      state.view = 'maxroll';\n      persist({ bisView: 'maxroll' });",
    "      state.view = 'maxroll';",
    '迁移没写回存档'),

  // 迁到 rio 而不是 maxroll。用户选的是「团本毕业装」，给他一份实战分布统计。
  textMutant('旧视角迁到「实战分布」而不是「最佳推荐」', BIS,
    "      state.view = 'maxroll';\n      persist({ bisView: 'maxroll' });",
    "      state.view = 'rio';\n      persist({ bisView: 'rio' });",
    '迁移没写回存档'),

  // 旧值原样保留（连迁移都没有）。面板会停在一个没有按钮的视角里。
  textMutant('旧视角原样保留，不迁移', BIS,
    "    if (s.bisView === 'rio' || s.bisView === 'maxroll') state.view = s.bisView;",
    "    if (s.bisView) state.view = s.bisView;",
    '迁移没写回存档'),

  // ---- 第 16 轮友好度修复：点一下别把用户的位置弄丢 ----

  // 滚动位置不还原。面板很长（三棵天赋树 + 两块说明），在底下点一个方案按钮
  // 会被扔回顶部，然后得重新滚下来找刚点的那个。
  textMutant('点一下之后滚动位置回到顶部', BIS,
    '    if (scroll) host.scrollTop = scroll;',
    '    /* mutant: 不还原滚动 */',
    '面板重建时没还原，用户会被扔回顶部'),

  // 折叠块的展开状态不还原。展开「各首领说明」看到一半，点个别的方案就合上了。
  textMutant('折叠块点一下就合上', BIS,
    "    if (openSecs[k]) node.setAttribute('open', 'open');",
    '    /* mutant: 不还原展开状态 */',
    '展开的折叠块在点了一下方案之后合上了'),

  // 换专精不归零下标：会落在「别人的第 6 套」上，而界面完全自洽。
  textMutant('换专精后落在别人的第 N 套上', BIS,
    '    state.mrBuild = 0;\n    state.mrSub = 0;\n    state.loadout = 0;',
    '    /* mutant: 不归零 */',
    '换专精没把「第几套」归零'),

  // 团本 / 大秘境的选择不写回设置：换个专精又跳回大秘境，得重新点。
  textMutant('「团本 / 大秘境」的选择不存', BIS,
    "        persist({ bisMrKind: k[0] });",
    '        /* mutant: 不存 */',
    '换个专精或重开面板又会跳回大秘境'),

  // ---- 第 16 轮：卡顿 + 「比对要带上装等」 ----

  // 图标不懒加载。一次天赋页 99 个图标 + 装备页 79 个，而每点一下都整块重建 ——
  // 这正是「好卡」的来源，而它在测试里没有任何别的表现（渲染逻辑本身只要 2.6 ms）。
  textMutant('图标不懒加载（点一下就卡的来源）', BIS,
    "    img.setAttribute('loading', 'lazy');\n"
      + "    img.setAttribute('decoding', 'async');\n"
      + "    // 缺一张图不该让整个节点塌掉",
    "    // 缺一张图不该让整个节点塌掉",
    '没写 loading="lazy"'),

  // 徽章退回「只给差值」，两个原始装等藏回悬停提示里。
  // 这一格是用户做决定要看的（换不换这个部位），关键数字不该藏在鼠标后面。
  textMutant('差距徽章不给两边的装等，只给差值', BIS,
    "          gap.mine + ' → ' + gap.want + '　'\n          + (gap.d > 0",
    "          (gap.d > 0",
    '配的是 class'),

  // ---- 空转守卫。下面这些改的是**校验器自己**，用来证明计数器的下界不是摆设。 ----

  textMutant('对照角色一个都不选（证明差距那一组的下界不是空的）', RUNNER,
    '      settings.bisChar = c.key;',
    "      settings.bisChar = '';",
    '装等差距徽章只画了 0 个'),

  textMutant('差值复核一次都不算（证明 gapMath 下界不是空的）', RUNNER,
    '          stats.gapMath++;',
    '          if (false) stats.gapMath++;',
    '差值独立复核过的只有 0 个'),

  textMutant('视角迁移一次都不验（证明 vmChecked 下界不是空的）', RUNNER,
    '    stats.vmChecked++;',
    '    if (false) stats.vmChecked++;',
    '视角迁移只验了 0 个存档值')
];

console.log('=== 装等 / 装等差距 / 撤掉的视角，这三组断言的变异测试 ===');

var base = run();
if (base.status !== 0) {
  console.log('基线就是红的，变异测试没有意义。先把套件修绿。');
  console.log(base.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log('基线通过。');

var caught = 0, missed = [], dead = [], wrong = [];

MUTANTS.forEach(function (m) {
  var restore = m.apply();
  if (!restore) {
    dead.push(m.desc);
    console.log('  锚点失效  ' + m.desc);
    return;
  }
  var r;
  try { r = run(); } finally { restore(); }
  if (r.status === 0) {
    missed.push(m.desc);
    console.log('  漏了  ' + m.desc);
  } else if (r.out.indexOf(m.want) < 0) {
    wrong.push(m.desc + '（没出现「' + m.want + '」）');
    console.log('  串了  ' + m.desc + '：输出里没有「' + m.want + '」');
  } else {
    caught++;
    console.log('  抓到  ' + m.desc + '　→「' + m.want + '」');
  }
});

var after = run();
console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught + '，漏 ' + missed.length
  + '，串 ' + wrong.length + '，锚点失效 ' + dead.length
  + '；还原后套件 ' + (after.status === 0 ? '仍然通过' : '没恢复（有问题）'));
missed.forEach(function (s) { console.log('  · 漏：' + s); });
wrong.forEach(function (s) { console.log('  · 串：' + s); });
dead.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + wrong.length + dead.length || after.status !== 0 ? 1 : 0);
