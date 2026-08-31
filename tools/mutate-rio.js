/*
 * WowAltBoard - tools/mutate-rio.js
 *
 * verify-rio-data.js 那几条断言的变异测试。
 *
 * 为什么值得单独一套：这个校验器的全部价值在**三条恒等式**上
 * （人数之和 == 部位样本量、分布按人数降序、每个 itemId 都有中文名和图标名）。
 * 恒等式的麻烦是「看起来总是成立」—— 数据没错的时候它一声不响，
 * 所以必须人为把数据弄坏，看它是不是真的会喊。
 *
 * 契约照 mutate-icons.js 那一档（严的）：**每个变异体必须让指定的那句话出现在输出里**。
 * 只看退出码的话，「被别的断言抓走了」也算过，而被测的那条依然没被证明。
 *
 * 变异打在**产物**上而不是校验器上：产物是 app/rio-data.js，
 * 改完就还原。这比改校验器更接近真实失效模式 —— 真实世界里坏的是数据，不是校验代码。
 *
 * 用法：node tools\mutate-rio.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var DATA = path.join(ROOT, 'app', 'rio-data.js');
var VERIFIER = path.join(__dirname, 'verify-rio-data.js');

lock.acquire('mutate-rio');
process.on('exit', lock.release);

if (!fs.existsSync(DATA)) {
  console.log('缺 app/rio-data.js —— 先跑 node tools\\fetch-rio.js 生成产物。');
  process.exit(1);
}

/** 只跑这个校验器，不跑整套 —— 快，而且被测对象就是它。 */
function run() {
  var r = cp.spawnSync(process.execPath, [VERIFIER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

var ORIG = fs.readFileSync(DATA, 'utf8');

/** 读出产物里的对象，改完再写回去。 */
function load() {
  var sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', ORIG)(sandbox.window);
  return sandbox.window.AE_RIO;
}

function save(obj) {
  fs.writeFileSync(DATA,
    '/* 自动生成，勿手改。生成器：tools/fetch-rio.js */\n'
    + 'window.AE_RIO = ' + JSON.stringify(obj) + ';\n');
}

function restore() { fs.writeFileSync(DATA, ORIG); }

/** 找第一个有分布的部位组，变异都打在它身上。 */
function firstSlot(obj) {
  var sids = Object.keys(obj.specs);
  for (var i = 0; i < sids.length; i++) {
    var S = obj.specs[sids[i]];
    var ks = Object.keys(S.slots || {});
    for (var j = 0; j < ks.length; j++) {
      var B = S.slots[ks[j]];
      if (B && B.d && B.d.length >= 2) return { sid: sids[i], slot: ks[j] };
    }
  }
  return null;
}

/** 变异体：改产物里的对象。返回 null 表示锚点失效（算失败）。 */
function dataMutant(desc, want, fn) {
  return {
    desc: desc, want: want,
    apply: function () {
      var obj = load();
      if (!fn(obj)) return null;
      save(obj);
      return restore;
    }
  };
}

var MUTANTS = [
  // ① 恒等式本身。把一个物品的人数 +1，人数之和就不再等于部位样本量。
  //    这是这套校验器的核心断言：聚合算错了一定会在这里露出来。
  dataMutant('某个部位的人数之和比样本量多 1', '人数之和', function (obj) {
    var at = firstSlot(obj);
    if (!at) return false;
    obj.specs[at.sid].slots[at.slot].d[0][1] += 1;
    return true;
  }),

  // ② 反方向：样本量被抬高，和也就对不上了。
  //    分开两条是因为「和 > N」与「和 < N」在实现里是同一句比较，
  //    但在真实失效里是两种成因（重复计数 vs 漏计数）。
  dataMutant('部位样本量被抬高（漏计数的样子）', '人数之和', function (obj) {
    var at = firstSlot(obj);
    if (!at) return false;
    obj.specs[at.sid].slots[at.slot].n += 5;
    return true;
  }),

  // ③ 排序。面板要靠「第一名就是最常见的那件」直接取 d[0]，顺序坏了 UI 会说谎。
  dataMutant('分布顺序被打乱（不再按人数降序）', '没有按人数降序', function (obj) {
    var at = firstSlot(obj);
    if (!at) return false;
    var d = obj.specs[at.sid].slots[at.slot].d;
    if (d.length < 2 || d[0][1] === d[d.length - 1][1]) return false;  // 人数全相等就没顺序可乱
    var tmp = d[0]; d[0] = d[d.length - 1]; d[d.length - 1] = tmp;
    return true;
  }),

  // ④ 中文名。这是换数据源时最容易悄悄退化的一项 —— raider.io 只给英文，
  //    名字是另一条链（DB2）补上的，那条链断了产物照样「结构完整」。
  dataMutant('一个物品的中文名变成空串', '没有中文名', function (obj) {
    var ids = Object.keys(obj.items);
    if (!ids.length) return false;
    obj.items[ids[0]].n = '';
    return true;
  }),

  // ⑤ 图标名。同理：图标名是 raider.io 白送的，但字段可能改名。
  dataMutant('一个物品的图标名丢了', '没有图标名', function (obj) {
    var ids = Object.keys(obj.items);
    if (!ids.length) return false;
    obj.items[ids[0]].i = '';
    return true;
  }),

  // ⑥ 引用完整性：分布里出现一个 items 表里没有的 itemId。
  //    面板拿它去查名字会得到 undefined，画出一个空格子。
  dataMutant('分布里引用了 items 表里没有的物品', '引用了 items 里没有的物品', function (obj) {
    var at = firstSlot(obj);
    if (!at) return false;
    obj.specs[at.sid].slots[at.slot].d[0][0] = 999999999;
    return true;
  }),

  // ⑦ 槽位编号。SLOT_MAP 是**投票推出来的**（见 fetch-rio.js 的注释），
  //    所以「冒出一个没见过的槽位号」是它最可能的失效方式。
  dataMutant('冒出一个不认识的槽位编号', '但 slotOf 里没有', function (obj) {
    var at = firstSlot(obj);
    if (!at) return false;
    var S = obj.specs[at.sid];
    S.slots['99'] = S.slots[at.slot];
    return true;
  }),

  // ⑧ 空转守卫。把所有部位组清空 —— 结构上完全合法（specs 还在、items 还在），
  //    三条恒等式一条都不会被违反，因为**一次都没检查**。
  //    没有这条下限，一个「什么都没聚合出来」的产物会一路绿灯。
  dataMutant('所有部位组清空（证明「检查数太少」这条下限不是空的）', '断言等于没跑',
    function (obj) {
      Object.keys(obj.specs).forEach(function (sid) { obj.specs[sid].slots = {}; });
      return true;
    })
];

console.log('=== raider.io 产物断言的变异测试 ===');

var base = run();
if (base.status !== 0) {
  console.log('基线就是红的，变异测试没有意义。先把校验修绿。');
  console.log(base.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log('基线通过。');

var caught = 0, missed = [], dead = [], wrong = [];

MUTANTS.forEach(function (m) {
  var undo = m.apply();
  if (!undo) {
    dead.push(m.desc);
    console.log('  锚点失效  ' + m.desc);
    return;
  }
  var r;
  try { r = run(); } finally { undo(); }
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
  + '；还原后校验 ' + (after.status === 0 ? '仍然通过' : '没恢复（有问题）'));
missed.forEach(function (s) { console.log('  · 漏：' + s); });
wrong.forEach(function (s) { console.log('  · 串：' + s); });
dead.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + wrong.length + dead.length || after.status !== 0 ? 1 : 0);
