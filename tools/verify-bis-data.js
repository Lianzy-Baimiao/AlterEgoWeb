/*
 * WowAltBoard - tools/verify-bis-data.js
 *
 * 校验 app/bis-data.js 是否符合面板要求的格式。**这个文件就是那份格式说明** ——
 * 下面的 SCHEMA 是可执行的文档，不会像另写一份 .md 那样跟代码脱节。
 *
 * 为什么需要它：装备数据现在来自 GearInsight 插件，将来可能换成别的来源
 * （archon.gg / bloodmallet / 自己抓 WCL…）。换来源时**只应该换生成器**，
 * app/bis.js 不动。要做到这一点，中间那层格式必须有一份说得清、且机器能验的定义。
 * 新生成器只要能过这个校验，面板就能直接用。
 *
 * 用法：
 *   node tools\verify-bis-data.js
 *   node tools\verify-bis-data.js --data path\to\bis-data.js
 *
 * 退出码：0 = 全部通过，1 = 有硬错误。警告不影响退出码。
 *
 * 和 app/bis-tests.js 的分工：
 *   · 这里管**格式**（字段在不在、类型对不对、下标越不越界）——换数据源时最容易踩的坑；
 *   · bis-tests.js 管**内容合理性**（40 个专精、使用率不超 100、图标覆盖率…）。
 *   两边有意有重叠，重叠的部分坏了会被抓两次，比漏掉好。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ 参数
var argv = process.argv.slice(2);
var dataPath = path.join(BASE, 'app', 'bis-data.js');
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--data' && argv[i + 1]) dataPath = argv[++i];
}

// ------------------------------------------------------------------ 加载
// bis-data.js 是给浏览器用的 `window.AE_BIS = {...}`，不是 CommonJS 模块。
// 这里造一个 window 让它自己赋值，而不是用正则去抠 JSON —— 抠正则的话
// 一旦文件里出现别的内容就会静默取错。
function loadData(p) {
  var src = fs.readFileSync(p, 'utf8');
  var win = {};
  var fn = new Function('window', src);
  fn(win);
  if (!win.AE_BIS) throw new Error('文件里没有给 window.AE_BIS 赋值');
  return win.AE_BIS;
}

// ------------------------------------------------------------------ 格式定义
//
// 类型记法：
//   'str'      非空字符串        'str?'   可以是空串
//   'num'      有限数字          'int'    整数
//   'obj'      普通对象          'arr'    数组
//
var SCHEMA = {
  // ---- 元信息。换数据源时这几个字段的**含义**必须保持：面板会把它们直接显示给用户，
  //      让人知道自己看的是哪一份数据、什么时候的。
  bisVersion:  { type: 'str',  desc: '数据版本号，面板页脚显示' },
  updatedAt:   { type: 'str',  desc: '数据日期（YYYY-MM-DD），面板页脚显示' },
  source:      { type: 'str',  desc: '数据出处的人类可读说明，必须写清是谁的成果' },
  addonVersion: { type: 'str?', desc: '上游插件版本，没有插件的来源可以留空' },

  // ---- 显示用的字典
  statMeta:         { type: 'obj', desc: '副属性键 -> {label, color}，决定属性显示顺序和颜色' },
  sourceCategories: { type: 'obj', desc: '来源分类键 -> 中文标签，必须覆盖 srcs 里出现的所有分类' },
  slotNames:        { type: 'obj', desc: '部位 ID -> 中文部位名' },
  statNames:        { type: 'obj', desc: '副属性键 -> 中文属性名' },
  specRawToCN:      { type: 'obj', desc: '专精英文名 -> 中文名（允许不全，面板有兜底）' },

  // ---- 三个池子 + 专精
  items:       { type: 'obj', desc: 'itemId -> 装备静态信息' },
  srcs:        { type: 'arr', desc: '来源组合池，行里存下标' },
  tracks:      { type: 'arr', desc: '升级轨道池，行里存 (下标+1)*10+等级' },
  specs:       { type: 'obj', desc: '专精键 -> 该专精的全部推荐' },
  consumables: { type: 'arr', desc: '消耗品清单' }
};

// specs[key] 的字段
var SPEC_SCHEMA = {
  cls:     { type: 'str', desc: '职业英文名（DEATHKNIGHT…），面板据此归组' },
  spec:    { type: 'str', desc: '专精英文名（BLOOD…）' },
  hero:    { type: 'str?', desc: '英雄天赋英文名，可空' },
  specId:  { type: 'int', desc: '暴雪专精 ID，面板用它查中文名' },
  specCn:  { type: 'str?', desc: '上游给的中文专精名，可空也可能是错的（面板有拒绝名单）' },
  ilvl:    { type: 'int', desc: '毕业装等' },
  zone:    { type: 'str', desc: '赛季/团本名' },
  tol:     { type: 'num', desc: '属性目标的容差（百分点）' },
  weights: { type: 'obj', desc: '属性权重' },
  target:  { type: 'obj', desc: '{raid, high, farm} 三套属性目标' },
  weapon:  { type: 'obj', desc: '{raid, mplusHigh, mplusFarm} 武器形态占比' },
  armor:   { type: 'str', desc: '甲片类型（PLATE/MAIL/LEATHER/CLOTH）' },
  raid:    { type: 'obj', desc: '团本视角：部位 ID -> 行数组' },
  mplus:   { type: 'obj', desc: '大秘境视角：部位 ID -> 行数组' },
  gems:    { type: 'arr', desc: '宝石：[itemId, 中文名, 使用率]' },
  ench:    { type: 'obj', desc: '附魔：部位 ID -> [[附魔 ID, 中文名, 使用率, itemId]]' }
};

/*
 * 部位条目（行）的格式 —— 这是整份数据里最要紧的一条约定：
 *
 *   [0] itemId    int  必填，必须能在 items 里查到
 *   [1] ilvl      int  必填，装等
 *   [2] usagePct  num  必填，0..100，顶尖玩家里用它的比例
 *   [3] srcIdx    int  必填，srcs 的下标
 *   [4] mx        int  可选，可升级到的上限装等；没有信息写 0
 *   [5] trk       int  可选，轨道码 =(tracks 下标+1)*10+等级(1..6)；解不出写 0
 *
 * 尾部的 0 可以省略，但**不许跳着省**：要写 [5] 就必须先写 [4]（哪怕是 0）。
 * 否则 r[4] 到底是 mx 还是轨道码得靠数组长度猜，那种格式迟早出错。
 */
var ROW_MIN = 4, ROW_MAX = 6;

/*
 * 嵌套对象必须有哪些键。
 *
 * 这几条本来只写在 SPEC_SCHEMA 的 desc 里（「{raid, high, farm} 三套属性目标」），
 * 而 desc 是给人看的，机器不认。变异测试里删掉 target.farm 一个键，校验器照样
 * 报「全部通过」—— 面板那一栏会直接空掉。**写在注释里的约束等于没有约束**，
 * 所以搬到这里变成可执行的。
 */
var SUB_KEYS = [
  { field: 'target', keys: ['raid', 'high', 'farm'],
    desc: '属性目标：团本 / 冲分 / 割草' },
  { field: 'weapon', keys: ['raid', 'mplusHigh', 'mplusFarm'],
    desc: '武器形态占比：团本 / 冲分 / 割草（注意键名和 target 不一样）' }
];

// ------------------------------------------------------------------ 校验框架
var errors = [], warns = [], checks = 0;

function fail(msg) { errors.push(msg); }
function warn(msg) { warns.push(msg); }

function typeOk(v, type) {
  switch (type) {
    case 'str':  return typeof v === 'string' && v.length > 0;
    case 'str?': return typeof v === 'string';
    case 'num':  return typeof v === 'number' && isFinite(v);
    case 'int':  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
    case 'obj':  return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'arr':  return Array.isArray(v);
  }
  return false;
}

function checkFields(obj, schema, where) {
  Object.keys(schema).forEach(function (k) {
    checks++;
    var spec = schema[k];
    if (!(k in obj)) { fail(where + ' 缺字段 ' + k + '（' + spec.desc + '）'); return; }
    if (!typeOk(obj[k], spec.type)) {
      fail(where + '.' + k + ' 类型不对，要 ' + spec.type +
           '，实际是 ' + describe(obj[k]) + '（' + spec.desc + '）');
    }
  });
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (typeof v === 'object') return 'object';
  return typeof v + ' ' + JSON.stringify(v);
}

// ------------------------------------------------------------------ 开跑
var B;
try {
  B = loadData(dataPath);
} catch (e) {
  console.error('读不出数据：' + e.message);
  console.error('文件：' + dataPath);
  process.exit(1);
}

checkFields(B, SCHEMA, 'AE_BIS');

// ---- items：itemId -> {n, st, h?, u?}
(function () {
  var ids = Object.keys(B.items || {});
  checks++;
  if (!ids.length) { fail('items 是空的'); return; }
  var noName = [], badId = [], badStats = [];
  ids.forEach(function (id) {
    if (!/^\d+$/.test(id)) badId.push(id);
    var it = B.items[id];
    if (!it || typeof it.n !== 'string' || !it.n) noName.push(id);
    // st 可以没有（有些饰品没副属性），有就必须是 键->数字
    if (it && it.st != null) {
      if (!typeOk(it.st, 'obj')) badStats.push(id);
      else {
        Object.keys(it.st).forEach(function (k) {
          if (typeof it.st[k] !== 'number') badStats.push(id + '.' + k);
        });
      }
    }
  });
  if (badId.length) fail('items 的键必须是纯数字 itemId，' + badId.length + ' 个不是，例如 ' + badId[0]);
  if (noName.length) fail(noName.length + ' 件装备没有名字（items[].n），例如 ' + noName[0]);
  if (badStats.length) fail(badStats.length + ' 件装备的 st 不是「属性键 -> 数字」，例如 ' + badStats[0]);
})();

// ---- srcs：[来源文本, 分类, boss名, instanceId, encounterId, 是否套装]
(function () {
  checks++;
  if (!Array.isArray(B.srcs) || !B.srcs.length) { fail('srcs 是空的'); return; }
  var bad = [];
  B.srcs.forEach(function (s, i) {
    if (!Array.isArray(s) || s.length !== 6) { bad.push('#' + i + ' 长度 ' + (s && s.length)); return; }
    if (typeof s[0] !== 'string') bad.push('#' + i + ' 来源文本不是字符串');
    if (typeof s[1] !== 'string' || !s[1]) bad.push('#' + i + ' 分类为空');
    if (typeof s[2] !== 'string') bad.push('#' + i + ' boss 名不是字符串');
    if (!typeOk(s[3], 'int') || !typeOk(s[4], 'int')) bad.push('#' + i + ' instanceId/encounterId 不是整数');
    if (s[5] !== 0 && s[5] !== 1) bad.push('#' + i + ' isTier 不是 0/1');
  });
  if (bad.length) fail('srcs 有 ' + bad.length + ' 处不合格式，例如 ' + bad[0]);

  // 分类必须都有中文标签，否则面板会把英文键直接画在徽章上
  checks++;
  var cats = {}, noLabel = [];
  B.srcs.forEach(function (s) { if (s && s[1]) cats[s[1]] = 1; });
  Object.keys(cats).forEach(function (c) {
    var lab = (B.sourceCategories || {})[c];
    if (typeof lab !== 'string' || !lab || lab === c) noLabel.push(c);
  });
  if (noLabel.length) {
    fail('这些来源分类没有中文标签，面板会显示英文键：' + noLabel.join(', '));
  }
})();

// ---- tracks：[英文名, 中文名, 赛季号]
(function () {
  checks++;
  if (!Array.isArray(B.tracks)) { fail('tracks 不是数组'); return; }
  if (!B.tracks.length) { warn('tracks 是空的，行里就不该出现轨道码（面板会不显示轨道徽章）'); return; }
  var bad = [];
  B.tracks.forEach(function (t, i) {
    if (!Array.isArray(t) || t.length !== 3) { bad.push('#' + i + ' 长度 ' + (t && t.length)); return; }
    if (typeof t[0] !== 'string' || !t[0]) bad.push('#' + i + ' 英文名为空');
    if (typeof t[1] !== 'string' || !t[1]) bad.push('#' + i + ' 中文名为空');
    if (!typeOk(t[2], 'int')) bad.push('#' + i + ' 赛季号不是整数');
  });
  if (bad.length) fail('tracks 有 ' + bad.length + ' 处不合格式，例如 ' + bad[0]);
})();

// ---- specs + 行
(function () {
  var keys = Object.keys(B.specs || {});
  checks++;
  if (!keys.length) { fail('specs 是空的'); return; }

  var nRows = 0, nSlots = 0, withMx = 0, withTrk = 0;
  var badRow = [], badSlotKey = [], badSrcIdx = [], badTrk = [], unknownItem = [], badUsage = [];
  var badSub = [];
  // 属性名不写死：以数据自己的 statMeta 为准（换数据源可能换属性集）。
  var statKeys = Object.keys(B.statMeta || {});

  keys.forEach(function (key) {
    var s = B.specs[key];
    checkFields(s, SPEC_SCHEMA, 'specs[' + key + ']');

    // target / weapon 的子键必须齐。上面 SPEC_SCHEMA 里只写了 type: 'obj'，
    // 那只保证「是个对象」—— 变异测试删掉 target.farm 时它照样过，而面板要画三套，
    // 少一套就是空白。所以子键在这里逐个验。
    SUB_KEYS.forEach(function (spec) {
      var o = s[spec.field];
      if (!typeOk(o, 'obj')) return;               // checkFields 已经报过
      spec.keys.forEach(function (k) {
        checks++;
        if (!typeOk(o[k], 'obj')) badSub.push(key + '.' + spec.field + ' 缺 ' + k);
      });
    });

    // 属性目标里的属性名必须是 statMeta 那四个，且值是数字。
    var tg = typeOk(s.target, 'obj') ? s.target : {};
    Object.keys(tg).forEach(function (which) {
      if (!typeOk(tg[which], 'obj')) return;
      statKeys.forEach(function (k) {
        checks++;
        if (typeof tg[which][k] !== 'number') {
          badSub.push(key + '.target.' + which + ' 缺属性 ' + k);
        }
      });
    });

    ['raid', 'mplus'].forEach(function (view) {
      var slots = s[view];
      if (!typeOk(slots, 'obj')) return;   // checkFields 已经报过
      Object.keys(slots).forEach(function (slot) {
        if (!/^\d+$/.test(slot)) badSlotKey.push(key + '/' + view + '/' + slot);
        var list = slots[slot];
        if (!Array.isArray(list)) { badRow.push(key + '/' + view + '/' + slot + ' 不是数组'); return; }
        nSlots++;
        list.forEach(function (r, ri) {
          nRows++;
          var at = key + '/' + view + '/' + slot + '#' + ri;
          if (!Array.isArray(r) || r.length < ROW_MIN || r.length > ROW_MAX) {
            badRow.push(at + ' 长度 ' + (r && r.length) + '（要 ' + ROW_MIN + '..' + ROW_MAX + '）');
            return;
          }
          for (var i2 = 0; i2 < r.length; i2++) {
            if (typeof r[i2] !== 'number' || !isFinite(r[i2])) {
              badRow.push(at + ' 第 ' + i2 + ' 位不是数字'); return;
            }
          }
          if (!B.items[r[0]]) unknownItem.push(at + ' → itemId ' + r[0]);
          if (r[2] < 0 || r[2] > 100) badUsage.push(at + ' → ' + r[2]);
          if (r[3] < 0 || r[3] >= (B.srcs || []).length) badSrcIdx.push(at + ' → ' + r[3]);
          if (r.length > 4 && r[4] !== 0) {
            withMx++;
            if (r[4] < r[1]) badRow.push(at + ' mx ' + r[4] + ' 小于装等 ' + r[1]);
          }
          if (r.length > 5 && r[5] !== 0) {
            withTrk++;
            var idx = Math.floor(r[5] / 10) - 1, lv = r[5] % 10;
            if (idx < 0 || idx >= (B.tracks || []).length) badTrk.push(at + ' 轨道下标 ' + idx + ' 越界');
            else if (lv < 1 || lv > 6) badTrk.push(at + ' 轨道等级 ' + lv + ' 不在 1..6');
          }
          // 尾部 0 应该被省掉。留着不算错（面板读得对），但说明生成器没修剪。
          if (r.length > ROW_MIN && r[r.length - 1] === 0) {
            badRow.push(at + ' 尾部是 0，应该省掉');
          }
        });
      });
    });
  });

  if (badSub.length) fail('专精的 target/weapon 子键有 ' + badSub.length + ' 处缺失，例如 ' + badSub[0]);
  if (badSlotKey.length) fail('部位键必须是数字，' + badSlotKey.length + ' 个不是，例如 ' + badSlotKey[0]);
  if (badRow.length) fail('行格式有 ' + badRow.length + ' 处问题，例如 ' + badRow[0]);
  if (unknownItem.length) fail(unknownItem.length + ' 行引用了 items 里没有的装备，例如 ' + unknownItem[0]);
  if (badUsage.length) fail(badUsage.length + ' 行的使用率不在 0..100，例如 ' + badUsage[0]);
  if (badSrcIdx.length) fail(badSrcIdx.length + ' 行的来源下标越界，例如 ' + badSrcIdx[0]);
  if (badTrk.length) fail(badTrk.length + ' 行的轨道码解不开，例如 ' + badTrk[0]);
  if (badSub.length) fail(badSub.length + ' 处子键缺失，例如 ' + badSub[0]);

  module.exports.stat = { specs: keys.length, slots: nSlots, rows: nRows, withMx: withMx, withTrk: withTrk };
})();

// ---- gems / ench / consumables
(function () {
  var badGem = [], badEnch = [], badCons = [];
  Object.keys(B.specs || {}).forEach(function (key) {
    var s = B.specs[key];
    (Array.isArray(s.gems) ? s.gems : []).forEach(function (g, i) {
      checks++;
      if (!Array.isArray(g) || g.length < 3) { badGem.push(key + '#' + i + ' 长度不足 3'); return; }
      if (!typeOk(g[0], 'int')) badGem.push(key + '#' + i + ' itemId 不是整数');
      if (typeof g[1] !== 'string') badGem.push(key + '#' + i + ' 中文名不是字符串');
      if (typeof g[2] !== 'number') badGem.push(key + '#' + i + ' 使用率不是数字');
    });
    var ench = typeOk(s.ench, 'obj') ? s.ench : {};
    Object.keys(ench).forEach(function (slot) {
      if (!/^\d+$/.test(slot)) badEnch.push(key + ' 附魔部位键 ' + slot + ' 不是数字');
      (Array.isArray(ench[slot]) ? ench[slot] : []).forEach(function (e, i) {
        checks++;
        if (!Array.isArray(e) || e.length < 4) { badEnch.push(key + '/' + slot + '#' + i + ' 长度不足 4'); return; }
        if (!typeOk(e[0], 'int')) badEnch.push(key + '/' + slot + '#' + i + ' 附魔 ID 不是整数');
        if (typeof e[1] !== 'string') badEnch.push(key + '/' + slot + '#' + i + ' 中文名不是字符串');
        if (typeof e[2] !== 'number') badEnch.push(key + '/' + slot + '#' + i + ' 使用率不是数字');
        if (!typeOk(e[3], 'int')) badEnch.push(key + '/' + slot + '#' + i + ' 卷轴 itemId 不是整数');
      });
    });
  });
  (Array.isArray(B.consumables) ? B.consumables : []).forEach(function (c, i) {
    checks++;
    // 字段名是 id，不是 itemId —— 生成器压过键名。fetch-icons.js 第一版就是
    // 读成 itemId，35 个消耗品被静默漏掉，所以这里明确验一遍。
    if (!c || !typeOk(c.id, 'int')) { badCons.push('#' + i + ' 缺 id（注意不叫 itemId）'); return; }
    if (typeof c.n !== 'string' || !c.n) badCons.push('#' + i + ' 缺中文名 n');
    if (typeof c.kind !== 'string' || !c.kind) badCons.push('#' + i + ' 缺分类 kind');
  });
  if (badGem.length) fail('宝石有 ' + badGem.length + ' 处不合格式，例如 ' + badGem[0]);
  if (badEnch.length) fail('附魔有 ' + badEnch.length + ' 处不合格式，例如 ' + badEnch[0]);
  if (badCons.length) fail('消耗品有 ' + badCons.length + ' 处不合格式，例如 ' + badCons[0]);
})();

// ---- 部位名 / 属性名覆盖
(function () {
  checks++;
  var used = {};
  Object.keys(B.specs || {}).forEach(function (key) {
    ['raid', 'mplus'].forEach(function (view) {
      var slots = B.specs[key][view];
      if (typeOk(slots, 'obj')) Object.keys(slots).forEach(function (s) { used[s] = 1; });
    });
  });
  var noName = Object.keys(used).filter(function (s) { return !(B.slotNames || {})[s]; });
  if (noName.length) fail('这些部位没有中文名：' + noName.join(', '));

  checks++;
  var usedStat = {};
  Object.keys(B.items || {}).forEach(function (id) {
    var st = B.items[id].st;
    if (st) Object.keys(st).forEach(function (k) { usedStat[k] = 1; });
  });
  var noStat = Object.keys(usedStat).filter(function (k) { return !(B.statNames || {})[k]; });
  if (noStat.length) fail('这些属性没有中文名：' + noStat.join(', '));
})();

// ------------------------------------------------------------------ 报告
var st = module.exports.stat || {};
console.log('校验       ' + path.relative(BASE, dataPath));
console.log('数据       ' + (B.bisVersion || '?') + '   ' + (B.updatedAt || '?'));
console.log('规模       ' + (st.specs || 0) + ' 专精 / ' + Object.keys(B.items || {}).length +
            ' 件 / ' + (st.slots || 0) + ' 部位 / ' + (st.rows || 0) + ' 行');
console.log('可选字段   有 mx ' + (st.withMx || 0) + ' 行，有轨道 ' + (st.withTrk || 0) + ' 行');
console.log('检查项     ' + checks);

if (warns.length) {
  console.log('');
  console.log('警告 ' + warns.length + ' 条：');
  warns.forEach(function (w) { console.log('  · ' + w); });
}

console.log('');
if (errors.length) {
  console.log('不合格式，' + errors.length + ' 个问题：');
  errors.forEach(function (e) { console.log('  · ' + e); });
  process.exit(1);
}
console.log('格式全部通过。换数据源时，新生成器只要能过这一关，面板就能直接用。');
