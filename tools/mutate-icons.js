/*
 * WowAltBoard - tools/mutate-icons.js
 *
 * 天赋图标那 5 条断言的变异测试。
 *
 * 起因（值得记下来）：图标接进天赋树之后，套件报的是「7947 个图标」——
 * 和一张天赋图都没有的时候**一模一样**。4304 个节点、2094 张图，没有被任何
 * 断言看过一眼。原因是天赋树走 checkTalents，而数图标的代码只在 checkRender 里。
 * 「加了功能、套件照样绿」不是好消息，是断言没覆盖到。
 *
 * 这个套件比其他三个严一档：**每个变异体必须让指定的那句话出现在输出里**，
 * 光「退出码非 0」不算抓到。理由是本轮踩过一次「变异被别的断言抓走了」——
 * 那种情况下被测的那条断言依然可能是摆设。
 *
 * 用法：node tools\mutate-icons.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var BIS = path.join(ROOT, 'app', 'bis.js');
var RUNNER = path.join(__dirname, 'run-tests.js');
var ICON_DIR = path.join(ROOT, 'app', 'talent-icons');

lock.acquire('mutate-icons');
process.on('exit', lock.release);

function run() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 挑一个「肯定被画出来」的图标名：在所有节点的 entries 里出现次数最多的那个。
 * 写死一个名字会在换赛季后变成锚点失效，而失效被我算作失败。
 */
function busiestIcon() {
  var sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'talent-tree.js'), 'utf8'))(sandbox.window);
  var TR = sandbox.window.AE_TALENT_TREE;
  var cnt = {};
  Object.keys(TR.nodes).forEach(function (id) {
    (TR.nodes[id][5] || []).forEach(function (e) {
      var nm = TR.icons[e[2]];
      if (nm) cnt[nm] = (cnt[nm] || 0) + 1;
    });
  });
  var best = null;
  Object.keys(cnt).forEach(function (k) { if (!best || cnt[k] > cnt[best]) best = k; });
  return best;
}

// [说明, 怎么改, 怎么还原, 输出里必须出现的那句话]
function textMutant(desc, file, from, to, want) {
  return {
    desc: desc, want: want,
    apply: function () {
      var orig = fs.readFileSync(file, 'utf8');
      if (orig.indexOf(from) < 0) return null;          // 锚点失效 = 失败
      fs.writeFileSync(file, orig.replace(from, to));
      return function () { fs.writeFileSync(file, orig); };
    }
  };
}

var MUTANTS = [
  textMutant('节点不挂图标', BIS,
    'if (tico) b.appendChild(tico);',
    '/* mutant: 图标没挂上去 */',
    '没有图标'),

  // 这个变异体是这套断言存在的**理由**：它给出的是一个真实存在的图标名、
  // 真实存在的文件、正确的路径前缀 —— 前三条断言全过，只有「图文同源」能抓。
  textMutant('图标固定取第一个 entry（二选一节点会图文不符）', BIS,
    'var ent = nodeEntry(n, hit);\n      var tico = talentIconImg(ent, 24);',
    'var ent = (n[5] || [])[0];\n      var tico = talentIconImg(ent, 24);',
    '图文不符'),

  textMutant('图标不设 class=ti（style.css 那段全落空）', BIS,
    "img.className = 'ti';",
    '/* mutant: class 没设 */',
    'class=ti'),

  textMutant('天赋图标去装备图标目录里找', BIS,
    "var TALENT_ICON_DIR = 'app/talent-icons';",
    "var TALENT_ICON_DIR = 'app/icons';",
    '不指向 app/talent-icons/'),

  // 空转守卫：把反查的计数分支关掉，配对数变成 0。
  // 没有这条下限，「图文不符 0」在一次配对都没做的情况下也是 0。
  textMutant('反查一次都不做（证明「配对数太少」这条下限不是空的）', RUNNER,
    '} else if (nWant) {\n            stats.ticoPair++;',
    '} else if (false) {\n            stats.ticoPair++;',
    '图文配对只查了'),

  // 文件真的少一张。前四条都在看 DOM，这条看的是磁盘。
  {
    desc: '删掉一张真的在用的图标文件',
    want: '不存在的图标文件',
    apply: function () {
      var nm = busiestIcon();
      if (!nm) return null;
      var f = path.join(ICON_DIR, nm + '.jpg');
      if (!fs.existsSync(f)) return null;
      var bak = f + '.bak';
      fs.renameSync(f, bak);
      return function () { if (fs.existsSync(bak)) fs.renameSync(bak, f); };
    }
  }
];

console.log('=== 天赋图标断言的变异测试 ===');

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
