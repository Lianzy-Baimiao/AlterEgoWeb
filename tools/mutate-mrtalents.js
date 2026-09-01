/*
 * WowAltBoard - tools/mutate-mrtalents.js
 *
 * maxroll 天赋方案那一组断言的变异测试。
 *
 * 为什么这一组要单独做一份，而不是靠 mutate-loadout.js
 * ---------------------------------------------------
 * 那一组盯的是 raider.io 的导入串（能粘进游戏的那批）：判据是**字节相等**。
 * 这一组盯的是 maxroll 的方案，而 maxroll 的串**不给用户** —— 实测它串头的
 * 序列化版本号是 130，游戏只认 2，粘进去必然被拒。所以这一组的核心判据是
 * 「画出来的那棵树就是高亮那一行的树」，和串没关系；两组混在一起，
 * 哪一块坏了都分不出来。
 *
 * 这一组独有的失败方式，是插件那条路和 rio 那条路上都不存在的：
 *   · 方案列表是竖着一排名字，**高亮错一行**时界面完全自洽（树、点数、名字
 *     各自都对得上），只有「树上点亮的节点 == 高亮那一套解出来的节点」能抓；
 *   · 「换方案 / 换英雄树 / 换团本大秘境」三个开关的 state 都不持久化，
 *     不真去点的话它们在测试里等于不存在；
 *   · maxroll 有「一套方案打包两条英雄天赋」的情况（实测去重后 167 套里 82 套），
 *     游戏里只能选一条：选择条没画出来的话界面会给出一个游戏里做不到的形状，
 *     而点数直接印产物里的 95 会给出一个谁也点不出来的数字；
 *   · 同一条串在 maxroll 页面上挂在多个小节下面（每副本 / 每首领一个天赋图），
 *     并成一套之后要说「通用 N 处」，否则用户会以为只适用于名字里那个副本。
 *
 * 严格程度和 mutate-loadout.js 一档：**每个变异体必须让指定的那句话出现在
 * 输出里**，光「退出码非 0」不算抓到 —— 被别的断言抓走的话，被测的那条依然
 * 可能是摆设。锚点在文件里出现次数不是 1，同样直接算失败。
 *
 * 用法：node tools\mutate-mrtalents.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var BIS = path.join(ROOT, 'app', 'bis.js');
var RUNNER = path.join(__dirname, 'run-tests.js');
// 生成器。串头改写那三行在这里，改坏了产物就带着不能导入的串，
// 而面板照样画得一切正常 —— 所以这一组也要盯生成器，不只盯面板。
var GEN = path.join(__dirname, 'fetch-maxroll.js');
var PROD = path.join(ROOT, 'app', 'maxroll-data.js');

lock.acquire('mutate-mrtalents');
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

/**
 * 生成器侧的变异体。
 *
 * 和上面那些不一样：改 tools/fetch-maxroll.js **不会**让 run-tests.js 变红 ——
 * 套件读的是已经生成好的 app/maxroll-data.js。第一版就是这么写的，三个变异体
 * 全部「漏」，因为它们压根没影响到被测的东西。
 *
 * 所以这一类走另一条路：改完生成器 → 用缓存重新生成产物（--report，不联网）
 * → 跑 tools/verify-maxroll-data.js。校验器拿**面板那份解码器**把串重解一遍对账，
 * 串头改坏了它必报。跑完把产物和源码一起还原。
 */
function genMutant(desc, from, to, want) {
  return {
    desc: desc, want: want, gen: true,
    apply: function () {
      var orig = fs.readFileSync(GEN, 'utf8');
      var n = orig.split(from).length - 1;
      if (n !== 1) {
        console.log('    锚点在文件里出现 ' + n + ' 次（必须正好 1 次）');
        return null;
      }
      var prod = fs.readFileSync(PROD);
      fs.writeFileSync(GEN, orig.replace(from, to));
      return function () {
        fs.writeFileSync(GEN, orig);
        fs.writeFileSync(PROD, prod);
      };
    }
  };
}

/** 重生成产物（只用缓存，不联网），再跑格式校验器。 */
function runGen() {
  var r0 = cp.spawnSync(process.execPath, [GEN, '--report'],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  var out = (r0.stdout || '') + (r0.stderr || '');
  if (r0.status !== 0) return { status: r0.status, out: out };
  var r1 = cp.spawnSync(process.execPath,
    [path.join(__dirname, 'verify-maxroll-data.js')],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r1.status, out: out + (r1.stdout || '') + (r1.stderr || '') };
}

var MUTANTS = [
  // 整块不画。这条抓的是「功能没了但套件不知道」，也就是下界断言的意义。
  textMutant('maxroll 方案列表整块不画', BIS,
    'host.appendChild(pickBox);',
    '/* mutant: 方案列表没挂上去 */',
    'maxroll 方案列表 0 个'),

  // 天赋页整个退回插件那条路。第 15 轮的功能就是「天赋页按 maxroll 来」，
  // 悄悄退回去必须报红，而不是「反正也画了一棵树」。
  textMutant('天赋页退回插件那条统计路', BIS,
    'var pick = tree() ? mrTalentPick(s.specId) : null;',
    'var pick = null;',
    'maxroll 方案列表 0 个'),

  // 「这套串不能导进游戏」这句说明不见了。它是这一轮唯一留给用户的解释 ——
  // 没有它，用户只会觉得「maxroll 这块怎么没有码」。
  // 导入串整块不画。**这一条盯的是本轮推翻的那个决定**：上一版这里只画一句
  // 「不给导入串」的说明，理由是 maxroll 的串版本字节 130、游戏会拒。后来实测：
  // 改写串头（版本 → 2、treeHash → 全 0）之后节点位一位不动，解出来的天赋完全一致，
  // 于是生成器产出 t.g，面板给复制。悄悄退回「不给」必须报红。
  textMutant('导入串整块不画', BIS,
    // 锚点必须**连 else 一起换掉**：只换 if 那一行会留下一个孤立的 else，
    // 文件解析不过 —— 变异体死在加载阶段，套件是报语法错而不是报断言，
    // 那等于什么都没验到（第一版就是这样，被判「串了」）。
    'if (b.g) host.appendChild(renderMrLoadout(b, pick));\n    else {\n'
      + "      host.appendChild(el('p', 'mr-nostr',\n"
      + "        '这一套没有导入串（生成时串头改写失败）—— 树还是能看的。'));\n    }",
    '/* mutant: 导入串块和兜底说明都没挂上去 */',
    '导入串块 0 个'),

  // 复制按钮没了：串在框里但复制不走。那是个 100+ 字符的 base64，
  // 手选很容易漏头漏尾，粘进游戏只会说「无效」。
  textMutant('复制按钮不画', BIS,
    "var copy = button('复制', 'primary mr-copy', function () {",
    "var copy = button('复制', 'primary mr-copy-x', function () {",
    '复制按钮 0 个'),

  // **框里放版本 130 的原始串。** 界面上一切正常，复制也「成功」，
  // 只有粘进游戏那一刻才被拒 —— 那时用户会以为是自己弄错了。
  // t.s 和 t.g 只差串头两个字段，肉眼分不出来。
  textMutant('框里放的是版本 130 的原始串（游戏会拒）', BIS,
    '    ta.value = b.g;',
    '    ta.value = b.s;',
    '版本 130，游戏会拒'),

  // 复制交出去的和框里显示的不是同一条：显示对、复制错。
  // 这是导入串唯一会致命又完全看不出来的失败方式。
  textMutant('复制交出去的是原始串，框里却显示可导入串', BIS,
    "if (AE.copyWithToast) AE.copyWithToast(b.g, '天赋导入串');",
    "if (AE.copyWithToast) AE.copyWithToast(b.s, '天赋导入串');",
    '复制出去的'),

  // 高亮错一行。这是这一组存在的理由：界面完全自洽，用户照着「Sunfury」那一行
  // 点开，得到的却是「Spellslinger」那一套的树。
  textMutant('方案列表高亮错一行', BIS,
    "var btn = button('', 'mrb' + (i === pick.idx ? ' on' : ''), function () {",
    "var btn = button('', 'mrb' + (i === (pick.idx + 1) % pick.list.length ? ' on' : ''), function () {",
    '但画出来的树和它不一致'),

  // 名字取错行。名字是用户唯一用来选方案的信息。
  textMutant('方案名全都取第一套的', BIS,
    "btn.appendChild(el('span', 'nm', t.n || '（这套没写名字）'));",
    "btn.appendChild(el('span', 'nm', pick.list[0].n || '（这套没写名字）'));",
    '产物里是「'),

  // 点数印回产物里声明的 p。打包两条英雄天赋的方案那是 95 点 ——
  // 游戏里一个角色只能选一条，95 点谁也点不出来。这一条就是这一轮那个 bug。
  textMutant('点数印成打包两条的合计（95 点）', BIS,
    "meta.appendChild(el('em', null, ptsText));",
    "meta.appendChild(el('em', null, t.p + ' 点'));",
    '但游戏里配得出来的只有'),

  // 「通用 N 处」不说。名字里只留了第一个小节名，不说的话用户会以为
  // 这套只适用于那一个副本。
  textMutant('「多个小节共用」不说出来', BIS,
    "if (t.c > 1) meta.appendChild",
    "if (false) meta.appendChild",
    '界面上没说'),

  // 换方案的按钮不接线。点了没反应 —— 界面依然自洽，只是按钮是死的。
  textMutant('「换方案」按钮写死成第 0 套', BIS,
    'state.mrBuild = i;',
    'state.mrBuild = 0;',
    '高亮却在第 0 套'),

  // 打包两条英雄天赋的方案不给选择条：界面会画出一个游戏里做不到的形状
  // （两条英雄树叠在同一张网格上）。
  textMutant('打包两条英雄天赋时不画选择条', BIS,
    'if (subs.length > 1) {',
    'if (false) {',
    '英雄天赋选择条画了 0 个按钮'),

  // 反过来：只有一条也画一个「选择器」。一个只有一个选项的选择器是在骗人。
  textMutant('只有一条英雄天赋也画选择条', BIS,
    'if (subs.length > 1) {\n      var sbar',
    'if (subs.length > 0) {\n      var sbar',
    '却画了 1 个选择按钮'),

  // 换英雄树的按钮不接线。
  textMutant('「换英雄树」按钮写死成第 0 条', BIS,
    'state.mrSub = i;',
    'state.mrSub = 0;',
    '它没有变成高亮'),

  // 只画选中那条英雄树的筛子被去掉：两条英雄树的节点会一起点亮，
  // 界面上出现一个游戏里做不到的形状。字节比串的那一版抓不到这个 ——
  // 串是对的，树才是错的。锚点带上前两行：同样的筛子在插件那条路上也有一份。
  textMutant('两条英雄树的节点一起点亮', BIS,
    '（实测）。\n    var heroIds = (sp.heroNodes || []).filter(function (id) {\n'
      + '      var n = TR.nodes[id];\n      return n && (!sub || n[6] === sub);',
    '（实测）。\n    var heroIds = (sp.heroNodes || []).filter(function (id) {\n'
      + '      var n = TR.nodes[id];\n      return n && (!sub || !!n[6]);',
    '和这一套的任一条子树都不吻合'),

  // ---- 空转守卫。下面这些改的是**校验器自己**，用来证明「计数器的下界不是
  // 摆设」：分支一次都没走到时，摘要照样会印那句话。
  textMutant('真值恒为空（证明「跳过」不会报成通过）', RUNNER,
    'function mrTalentTruth(specId) {',
    'function mrTalentTruth(specId) {\n  if (true) return null;',
    '个专精有 maxroll 天赋方案'),

  // 声明复核那条有没有牙：把「只算本专精自己的节点」去掉，点数会多出 6~23 点
  // （实测，正是生成器踩过的那个 bug），必须报「声明 N 点，现解出 M 点」。
  textMutant('声明复核算上别的专精的节点（证明它真的在比）', RUNNER,
    'if (!n.inSpec) return;',
    '/* mutant: 不筛本专精 */',
    '点，现解出'),

  // 去重那条有没有牙：真值里塞一条重复的串，产物层面那条必须报出来。
  textMutant('真值里塞一条重复的串（证明去重断言在看）', RUNNER,
    'out.push({ kind: k, list: v.talents, prio: v.prio || [], boss: v.boss || [] });',
    'out.push({ kind: k, list: v.talents.concat([v.talents[0]]), '
      + 'prio: v.prio || [], boss: v.boss || [] });',
    '去重没生效'),

  // 三个计数器的下界：不真去点 / 不真去比的话它们在测试里等于不存在。
  textMutant('换类型一次都不点（证明 mrtKindSw 下界不是空的）', RUNNER,
    '      stats.mrtKindSw++;',
    '      if (false) stats.mrtKindSw++;',
    '「换团本 / 大秘境」只点过'),

  textMutant('树比对一次都不算（证明 mrtTree 下界不是空的）', RUNNER,
    '    stats.mrtTree++;',
    '    if (false) stats.mrtTree++;',
    '「画出来的树就是高亮那一套」只验过'),

  // ---- 生成器那一侧：串头改写本身 ----

  // 版本字节不改。产物里 167 条全留着 130，面板照样给复制 —— 用户全被拒。
  genMutant('串头版本字节不改（留着 130）',
    '  for (var i = 0; i < 8; i++) bits[i] = (2 >> i) & 1;      // 版本字节 → 2',
    '  /* mutant: 版本不改 */',
    '游戏只认 2'),

  // treeHash 不清零。实测 raider.io 3960 条真实玩家串 + 本机游戏导出 32 条全是 0。
  // 这一条钉的是「改写要改两个字段，不是一个」。
  genMutant('treeHash 不清零',
    '  for (var j = 0; j < 128; j++) bits[24 + j] = 0;          // treeHash → 全 0',
    '  /* mutant: hash 不清零 */',
    'treeHash 不是全 0'),

  // 削尾那道「削完还能解开」的闸去掉。恶魔猎手 Fel-Scarred 和恢复德
  // Keeper of the Grove 的串会被削坏 —— 尾部那串 0 不是填充，是「最后几个节点没选」。
  genMutant('削尾不检查「削完还能不能解开」',
    '      if (probe.err) break;',
    '      if (false) break;',
    '解不开'),

  // ---- 空转守卫 ----

  textMutant('「给了可导入串」一次都不算（证明 mrtCopy 下界不是空的）', RUNNER,
    '      stats.mrtCopy++;',
    '      if (false) stats.mrtCopy++;',
    '只验过'),

  textMutant('「串真的能导入」一次都不算（证明 mrtGameOk 下界不是空的）', RUNNER,
    '          stats.mrtGameOk++;',
    '          if (false) stats.mrtGameOk++;',
    '只验过'),

  // ---- 第 16 轮：场景标签 / 出手顺序 / 各首领·副本说明 ----
  //
  // 这三块回答的是用户第 16 轮那条：「天赋分为单体、AOE」「单体、AOE 不同场景下的
  // 技能时间轴」「团本下甚至还有不同 BOSS 的天赋和说明」。

  // 场景标签整个不画。maxroll 只有一部分专精按场景分（实测 167 套里 51 套），
  // 不画的话那 51 套在界面上和「没分场景」的长得一样。
  textMutant('场景标签（单体 / AOE）不画', BIS,
    "      (t.sc || []).forEach(function (code) {",
    "      (false ? t.sc : []).forEach(function (code) {",
    '次渲染画出了场景标签，太少'),

  // 反过来：没有场景的也标上「单体」。这是**编数据** —— maxroll 没说这套是单体的。
  textMutant('没分场景的方案也标成「单体」', BIS,
    "      (t.sc || []).forEach(function (code) {",
    "      (t.sc || ['st']).forEach(function (code) {",
    '场景标签画了'),

  // 标签的字和 class 对不上：AOE 那套标成单体。用户照着它选，进副本发现打不动。
  textMutant('场景标签的字和场景对不上', BIS,
    "        var e = el('em', 'scen ' + code, SCEN_ZH[code] || code);",
    "        var e = el('em', 'scen ' + code, SCEN_ZH.st);",
    '场景标签 class 是'),

  // 出手顺序整块不画。它就是用户要的「技能时间轴」的文字版。
  textMutant('出手顺序整块不画', BIS,
    "    var pr = renderMrNotes(pick.v.prio, 'mr-prio', '出手顺序',",
    "    var pr = renderMrNotes(null, 'mr-prio', '出手顺序',",
    '出手顺序只逐条对过 0 行'),

  // 各首领 / 副本说明整块不画。这是三块里数据最全的（252 条 / 71 篇）。
  textMutant('各首领 / 副本说明整块不画', BIS,
    "    var bs = renderMrNotes(pick.v.boss, 'mr-boss',",
    "    var bs = renderMrNotes(null, 'mr-boss',",
    '各首领 / 副本说明只逐条对过 0 行'),

  // 两块取反了：出手顺序那一块画的是首领说明。**界面完全自洽** ——
  // 标题写「出手顺序」，下面是一堆首领名 + 正文，条数也对得上自己。
  // 只有「逐行正文 == 产物里那一块」抓得到。
  textMutant('出手顺序和首领说明取反了', BIS,
    "    var pr = renderMrNotes(pick.v.prio, 'mr-prio', '出手顺序',",
    "    var pr = renderMrNotes(pick.v.boss, 'mr-prio', '出手顺序',",
    '正文和产物不一致'),

  // 正文截断。截断是「自作聪明」里最容易发生的一种（怕太长），
  // 而截断之后那句话的后半截意思可能整个反过来（「除非…」都在后半句）。
  textMutant('说明正文被截断', BIS,
    "      row.appendChild(el('p', 'en', r.t));",
    "      row.appendChild(el('p', 'en', r.t.slice(0, 80)));",
    '这一段是英文原文，不许加工'),

  // 标题里的条数写死成 1。标题写「1 条」而下面 9 行，是最容易漏的那种错：
  // 折叠起来的时候用户只看得到标题。
  textMutant('说明标题里的条数写死', BIS,
    "    sum.appendChild(el('span', 'ttl', title + '　' + list.length + ' 条'));",
    "    sum.appendChild(el('span', 'ttl', title + '　1 条'));",
    '的标题里没写'),

  // ---- 空转守卫（校验器自己）----

  textMutant('场景标签一次都不算（证明 mrtScenSeen 下界不是空的）', RUNNER,
    '    if (scenEls.length) stats.mrtScenSeen++;',
    '    if (false) stats.mrtScenSeen++;',
    '次渲染画出了场景标签，太少'),

  textMutant('说明正文一行都不对（证明 mrtPrio / mrtBoss 下界不是空的）', RUNNER,
    '  if (!bad) stats[statKey] += rows.length;',
    '  if (false) stats[statKey] += rows.length;',
    '出手顺序只逐条对过 0 行'),

  // 产物层面：真值里把 prio 清空，面板那一块就该报「产物里没有却画了」。
  // 这一条证明「产物有就必须画」和「产物没有就不许画」两个方向都在看。
  textMutant('真值里把出手顺序清空（证明「没有就不许画」在看）', RUNNER,
    "      out.push({ kind: k, list: v.talents, prio: v.prio || [], boss: v.boss || [] });",
    "      out.push({ kind: k, list: v.talents, prio: [], boss: v.boss || [] });",
    '产物里没有出手顺序，界面却画了这一块')
];

console.log('=== maxroll 天赋方案断言的变异测试 ===');

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
  try { r = m.gen ? runGen() : run(); } finally { restore(); }
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
