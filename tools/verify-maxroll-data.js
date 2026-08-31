/*
 * WowAltBoard - tools/verify-maxroll-data.js
 *
 * app/maxroll-data.js 的**可执行格式定义**。跟 verify-rio-data.js 同一个位置：
 * 它的价值在「换赛季重抓时能拦住不合格的新产物」，所以平时必须一直是绿的。
 *
 * 判据分两类，分清楚很重要：
 *   · **硬失败**（exit 1）：结构错、槽位编号不认识、itemId 不在物品池里、
 *     引用了不存在的专精 —— 这些是生成器出了 bug，面板一定会画错。
 *   · **警告**：篇数不够 40 个专精、物品缺中文名 —— 这些是「数据还没抓齐」，
 *     不是格式错。试跑产物就该是这样。
 *
 * 为什么不检查「使用率之和 == 100%」那类恒等式：maxroll 给的是**编辑排序**，
 * 没有样本量也没有百分比，所以那种恒等式在这份数据里不存在。
 * 这里能立的最强恒等式是「引用完整性」：每个 itemId 都能在 items 池里查到。
 *
 * 天赋方案（talents）那一段的恒等式强一档，因为串本身就带着答案：把 s 解一遍，
 * 解出来的点数必须等于声明的 p、解出来的英雄子树必须等于声明的 h。
 * 复核**故意用 app/talent-decode.js**，不用生成器用的 tools/decode-talent-string.js
 * —— 两份实现是各写一遍的，拿生成器自己的解码器验生成器的产物等于什么都没验。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.join(__dirname, '..');
var dataPath = path.join(BASE, 'app', 'maxroll-data.js');

if (!fs.existsSync(dataPath)) {
  console.error('没有 app/maxroll-data.js —— 先跑 node tools\\fetch-maxroll.js');
  process.exit(1);
}

var win = {};
new Function('window', fs.readFileSync(dataPath, 'utf8'))(win); // eslint-disable-line no-new-func
var M = win.AE_MAXROLL;

var errors = [], warns = [], checks = 0;
function fail(m) { errors.push(m); }
function warn(m) { warns.push(m); }
function ck() { checks++; }

// 暴雪 INVSLOT。和 app/rio-data.js、app/bis-data.js 是同一套编号。
// 4（衬衣）、18（弹药）、19（挂饰）这些面板不管，所以不在白名单里。
var VALID_SLOTS = {
  1: '头', 2: '颈', 3: '肩', 5: '胸', 6: '腰', 7: '腿', 8: '脚',
  9: '腕', 10: '手', 11: '戒指1', 12: '戒指2', 13: '饰品1', 14: '饰品2',
  15: '背', 16: '主手', 17: '副手'
};

/* ------------------------------------------------------------------ 顶层 */
(function () {
  ck();
  if (!M || typeof M !== 'object') { fail('window.AE_MAXROLL 不是对象'); return; }
  ck(); if (M.v !== 1) fail('v 应该是 1，实际 ' + M.v);
  ck(); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(M.updatedAt))) fail('updatedAt 不是 YYYY-MM-DD：' + M.updatedAt);
  ['source', 'note', 'itemNameSource'].forEach(function (k) {
    ck();
    if (!M[k] || typeof M[k] !== 'string') fail(k + ' 缺失或不是字符串');
  });
  ck(); if (!M.fmt || typeof M.fmt !== 'object') fail('缺 fmt（格式自述）');
  ck(); if (!M.items || typeof M.items !== 'object') fail('缺 items 物品池');
  ck(); if (!M.specs || typeof M.specs !== 'object') fail('缺 specs');
  ck(); if (!M.slotMap || typeof M.slotMap !== 'object') fail('缺 slotMap（槽位名推导结果）');
})();
if (errors.length) { report(); }

/* --------------------------------------------------------------- slotMap */
// 这张表是**推导出来的**（拿 rio 的 itemId→槽位当桥）。它错了不会有人喊，
// 只会让某个部位静默跑到别的部位下面去，所以这里逐条卡死。
(function () {
  var names = Object.keys(M.slotMap);
  ck();
  if (names.length < 14) fail('slotMap 只有 ' + names.length + ' 个名字，'
    + '实测非武器槽位就有 14 个必现名字，太少说明推导没跑全');

  names.forEach(function (nm) {
    var sn = M.slotMap[nm];
    ck();
    if (!VALID_SLOTS[sn]) fail('slotMap["' + nm + '"] = ' + sn + '，不是认识的槽位编号');
    // 判据方向很重要。第一版写的是「名字含 weapon|hand 才准落在 16/17」，
    // 结果把两个**正确**的映射判成错：`Shield`→17（盾牌就是副手）、
    // `Option for Dual Wielding`→17（双持副手，名字里既没 weapon 也没 hand）。
    // 武器那一族的说法太多，白名单列不全。
    //
    // 所以反过来卡：**已知属于非武器部位的词**不许落到 16/17 上。
    // 这才是真正要防的错（投票撞车把 Gloves 推到副手去），而且不会误伤
    // 上游发明的新武器说法。
    var isWeaponSlot = (sn === 16 || sn === 17);
    var w = String(nm).toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
    var NON_WEAPON = {
      head: 1, helm: 1, neck: 1, shoulder: 1, chest: 1, waist: 1, belt: 1,
      leg: 1, foot: 1, boot: 1, wrist: 1, glove: 1, hand: 1, back: 1,
      cloak: 1, ring: 1, finger: 1, trinket: 1
    };
    ck();
    if (isWeaponSlot && NON_WEAPON[w]) {
      fail('slotMap["' + nm + '"] = ' + sn + '（' + VALID_SLOTS[sn] + '），'
        + '这是个非武器部位的名字，不该落在武器槽上');
    }
    // 反向：明确是护甲部位名的，必须落在自己那个编号上（拿暴雪键名规范化对）。
    var BLIZZ = {
      head: 1, helm: 1, neck: 2, shoulder: 3, chest: 5, waist: 6, belt: 6,
      leg: 7, foot: 8, boot: 8, wrist: 9, glove: 10, back: 15, cloak: 15
    };
    ck();
    if (BLIZZ[w] !== undefined && sn !== BLIZZ[w]) {
      fail('slotMap["' + nm + '"] = ' + sn + '（' + VALID_SLOTS[sn] + '），'
        + '按名字该是 ' + BLIZZ[w] + '（' + VALID_SLOTS[BLIZZ[w]] + '）');
    }
  });

  // 戒指/饰品这四个是**按位置**定的，不是投票 —— 投票在它们身上必然是 55~65%。
  // 值写错了面板会把主副戒指画反，所以钉死。
  var POS = { 'Ring 1': 11, 'Ring 2': 12, 'Trinket 1': 13, 'Trinket 2': 14 };
  Object.keys(POS).forEach(function (nm) {
    if (M.slotMap[nm] === undefined) return;   // 这批指南里没出现就算了
    ck();
    if (M.slotMap[nm] !== POS[nm]) {
      fail('slotMap["' + nm + '"] 应该是 ' + POS[nm] + '（按表内位置定），实际 ' + M.slotMap[nm]);
    }
  });
})();

/* ----------------------------------------------------------------- items */
var stat = { specs: 0, views: 0, bisRows: 0, altRows: 0, ench: 0, tiers: 0, noName: 0,
  talents: 0, tDecoded: 0, tSpecs: 0, tBundled: 0, tShared: 0, tMax: 0, tNoTalents: 0,
  tVer2: 0 };
(function () {
  Object.keys(M.items).forEach(function (id) {
    var it = M.items[id];
    ck();
    if (!/^\d+$/.test(id)) { fail('items 的键不是数字 itemId：' + id); return; }
    if (!it || typeof it !== 'object') { fail('items[' + id + '] 不是对象'); return; }
    if (typeof it.n !== 'string') fail('items[' + id + '].n 不是字符串');
    if (typeof it.i !== 'string') fail('items[' + id + '].i 不是字符串');
    if (typeof it.q !== 'number' || it.q < 0 || it.q > 7) {
      fail('items[' + id + '].q = ' + it.q + '，品质应该是 0~7');
    }
    if (!it.n) stat.noName++;
  });
})();

/* ----------------------------------------------------------------- specs */
// 天赋方案要另外两份数据才能复核：天赋树（节点在哪棵子树上）和一份解码器。
// 两份都是提交进仓库的，缺了就是仓库不完整 —— 直接退出，不「跳过天赋检查」：
// 跳过会让一份天赋全错的产物照样打印「格式全部通过」。
var TR = null, DEC = null;
(function () {
  var treeJs = path.join(BASE, 'app', 'talent-tree.js');
  var decJs = path.join(BASE, 'app', 'talent-decode.js');
  if (!fs.existsSync(treeJs) || !fs.existsSync(decJs)) {
    console.error('缺 app/talent-tree.js 或 app/talent-decode.js —— 天赋方案没法复核。'
      + '先跑 node tools\\fetch-talent-tree.js');
    process.exit(1);
  }
  var g = {}; g.window = g;
  new Function('window', fs.readFileSync(treeJs, 'utf8'))(g); // eslint-disable-line no-new-func
  new Function('window', fs.readFileSync(decJs, 'utf8'))(g);  // eslint-disable-line no-new-func
  TR = g.AE_TALENT_TREE;
  DEC = g.AE && g.AE.TalentDecode;
  if (!TR || !TR.specs || !DEC || !DEC.decode) {
    console.error('app/talent-tree.js 或 app/talent-decode.js 加载后拿不到数据/解码器');
    process.exit(1);
  }
})();

(function () {
  Object.keys(M.specs).forEach(function (sid) {
    var s = M.specs[sid];
    stat.specs++;
    ck();
    if (!/^\d+$/.test(sid)) fail('specs 的键不是数字 specId：' + sid);
    if (!s.cls || !s.specEn) fail('specs[' + sid + '] 缺 cls / specEn');
    ck();
    if (!s.views || !Object.keys(s.views).length) {
      fail('specs[' + sid + '] 一个视角都没有');
      return;
    }

    var nT = 0;
    Object.keys(s.views).forEach(function (kind) {
      stat.views++;
      ck();
      if (kind !== 'raid' && kind !== 'mplus') {
        fail('specs[' + sid + '].views 里有未知类型：' + kind);
      }
      var v = s.views[kind];
      ck();
      if (!v.slug || typeof v.slug !== 'string') fail(sid + '/' + kind + ' 缺 slug（追溯来源要用）');

      // bis / alt / ench：键必须是认识的槽位，值必须是 itemId 数组，且每个 id 在池里
      ['bis', 'alt', 'ench'].forEach(function (key) {
        var m = v[key];
        ck();
        if (!m || typeof m !== 'object') { fail(sid + '/' + kind + ' 缺 ' + key); return; }
        Object.keys(m).forEach(function (sn) {
          ck();
          if (!VALID_SLOTS[sn]) {
            fail(sid + '/' + kind + '.' + key + ' 里有不认识的槽位编号 ' + sn);
          }
          var list = m[sn];
          if (!Array.isArray(list) || !list.length) {
            fail(sid + '/' + kind + '.' + key + '[' + sn + '] 不是非空数组');
            return;
          }
          if (key === 'bis') stat.bisRows++;
          else if (key === 'alt') stat.altRows++;
          else stat.ench++;
          list.forEach(function (id) {
            ck();
            if (typeof id !== 'number' || !(id > 0)) {
              fail(sid + '/' + kind + '.' + key + '[' + sn + '] 里有非法 itemId：' + id);
              return;
            }
            // 引用完整性 —— 这份数据能立的最强恒等式
            if (!M.items[id]) {
              fail(sid + '/' + kind + '.' + key + '[' + sn + '] 引用了 items 池里没有的 '
                + id + '（面板会画出空格子）');
            }
          });
          // 同一槽位里不许有重复 id
          ck();
          if (new Set(list).size !== list.length) {
            fail(sid + '/' + kind + '.' + key + '[' + sn + '] 有重复 itemId');
          }
        });
      });

      // tiers：[[分级名, [itemId…]]…]
      ck();
      if (!Array.isArray(v.tiers)) fail(sid + '/' + kind + '.tiers 不是数组');
      else {
        v.tiers.forEach(function (row) {
          stat.tiers++;
          ck();
          if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
            || !Array.isArray(row[1])) {
            fail(sid + '/' + kind + '.tiers 里有畸形行：' + JSON.stringify(row).slice(0, 60));
            return;
          }
          row[1].forEach(function (id) {
            ck();
            if (!M.items[id]) fail(sid + '/' + kind + '.tiers 引用了池外的 ' + id);
          });
        });
      }

      // BiS 表实测 15~17 行，也就是 13 个以上不同槽位。明显少就是解析漏了。
      ck();
      var nBisSlots = Object.keys(v.bis || {}).length;
      if (nBisSlots < 13) {
        fail(sid + '/' + kind + ' 的 BiS 只覆盖 ' + nBisSlots + ' 个槽位，'
          + '实测每篇 15~17 行 → 至少 13 个槽位，这么少说明表没解全（' + v.slug + '）');
      }

      // ---- 天赋方案 talents: [{n 名字, s 串, p 点数, h [英雄子树id…], c 有几个小节共用}…]
      //
      // 这一段的判据是「串里解出来的 == 声明的」，比装备那边的引用完整性强一档：
      // 串本身就带着答案。值得逐条解一遍是因为生成器在这里踩过 bug —— 点数把同职业
      // **别的专精**的节点也算进去了（实测多 6~23 点），而面板按声明值印，
      // 界面上就是一个谁也点不出来的数字。
      ck();
      if (v.talents !== undefined && !Array.isArray(v.talents)) {
        fail(sid + '/' + kind + '.talents 不是数组');
      } else {
        var seen = {};
        (v.talents || []).forEach(function (t, i) {
          var at = sid + '/' + kind + '.talents[' + i + ']';
          stat.talents++; nT++;
          ck();
          if (!t || typeof t !== 'object') { fail(at + ' 不是对象'); return; }
          ck();
          if (typeof t.n !== 'string') fail(at + '.n 不是字符串（方案名）');
          ck();
          if (typeof t.s !== 'string' || !t.s) { fail(at + '.s 不是非空串'); return; }
          // maxroll 页面用的是 URL-safe base64（- _），换回标准表是生成器的活。
          // 没换的话面板那份解码器整条拒掉（它只认标准表，故意不容错）。
          ck();
          if (/[-_]/.test(t.s)) fail(at + '.s 里还有 URL-safe base64 的 - 或 _（该换成 + /）');
          // 同一列表里不许有两条一样的串。这是「天赋页看起来怪怪的」那个 bug：
          // 一套方案在页面里每个副本/首领各挂一个 embed，串却是同一条。
          ck();
          if (seen[t.s]) {
            fail(at + ' 和同列表第 ' + seen[t.s] + ' 条是同一条串 —— 去重没生效，'
              + '面板会列出好几行名字几乎一样的方案，点开画的是同一棵树');
          } else seen[t.s] = i + 1;
          ck();
          if (!(typeof t.c === 'number' && t.c >= 1 && t.c === Math.floor(t.c))) {
            fail(at + '.c = ' + t.c + '，该是 >= 1 的整数（有几个小节共用这一套）');
          } else if (t.c > 1) stat.tShared++;
          checkBuildStr(at, sid, t);
        });
        if ((v.talents || []).length > stat.tMax) stat.tMax = (v.talents || []).length;
      }
    });
    ck();
    if (nT === 0) stat.tNoTalents++;
    else stat.tSpecs++;
  });
})();

/**
 * 把串解一遍，跟声明的 p / h 对账。
 * 解码器用的是 app/talent-decode.js（面板那份），生成器用的是
 * tools/decode-talent-string.js —— 两份实现各写一遍，这里才算「复核」。
 */
function checkBuildStr(at, sid, t) {
  var d = DEC.decode(t.s, TR);
  ck();
  if (d.err) { fail(at + '.s 解不开：' + d.err + '（产物里不该收解不开的串）'); return; }
  ck();
  if (d.spec !== Number(sid)) {
    fail(at + '.s 串头写的是专精 ' + d.spec + '，却挂在专精 ' + sid + ' 下面');
    return;
  }
  stat.tDecoded++;
  ck();
  if (t.p !== d.pts) {
    fail(at + '.p 声明 ' + t.p + ' 点，串里解出 ' + d.pts + ' 点（' + t.n + '）');
  }
  ck();
  if (!Array.isArray(t.h) || !t.h.length) {
    fail(at + '.h 不是非空数组 —— 每套方案都得说清英雄天赋走哪条');
  } else if (t.h.join(',') !== d.subs.join(',')) {
    fail(at + '.h 声明 [' + t.h + ']，串里解出 [' + d.subs + ']');
  } else {
    if (t.h.length > 1) stat.tBundled++;
    var ids = (TR.specs[sid] && TR.specs[sid].subTreeIds) || [];
    t.h.forEach(function (x) {
      ck();
      if (ids.indexOf(x) < 0) {
        fail(at + '.h 里的子树 ' + x + ' 不属于专精 ' + sid + '（它只有 [' + ids + ']）');
      }
    });
  }
  // 串头第一个字节是序列化版本。实测 maxroll 是 130，游戏和 raider.io 是 2 ——
  // 面板据此明说「这套不给导入串」。上游哪天真改成 2 了那是好消息，但那个决定
  // 得重看，所以显式提醒，不让它悄悄过去。
  if (d.ver === 2) stat.tVer2++;
}

/* ------------------------------------------------------------------ 空转守卫 */
// 上面所有断言都建立在「真的有数据」之上。产物是空的时候它们会全部空转变成假绿 ——
// 这个坑在这个项目里踩过好几次，所以显式卡住。
(function () {
  ck();
  if (stat.specs === 0) fail('一个专精都没有，上面所有断言都是空转');
  ck();
  if (stat.bisRows === 0) fail('一行 BiS 都没有，引用完整性那组断言等于没跑');
  ck();
  if (Object.keys(M.items).length === 0) fail('物品池是空的');
  // 天赋那一段同理：一套方案都没有的话，上面「p 对不对、h 对不对、串重不重」
  // 全是空转。这一轮天赋页就是靠这份数据画的，空产物不许报通过。
  ck();
  if (stat.talents === 0) fail('一套天赋方案都没有 —— 天赋页会是空的，而那组断言全在空转');
  ck();
  if (stat.tDecoded === 0) fail('一条天赋串都没解开，「声明的点数/英雄树对不对」这组等于没跑');
})();

/* --------------------------------------------------------------- 警告类 */
(function () {
  if (stat.specs < 40) {
    warn('只有 ' + stat.specs + '/40 个专精 —— 是试跑产物吗？（跑全量：node tools\\fetch-maxroll.js）');
  }
  if (stat.noName) {
    warn(stat.noName + '/' + Object.keys(M.items).length + ' 件物品没有中文名 '
      + '（rio 物品池里查不到，跑 node tools\\fetch-icons.js 补）');
  }
  if (stat.ench === 0) {
    warn('一条附魔都没有 —— 附魔格的 data-wow-item 不带冒号，'
      + '解析正则如果写死了冒号就会全漏（这个坑犯过一次）');
  }
  if (stat.tNoTalents) {
    warn(stat.tNoTalents + '/' + stat.specs + ' 个专精一套天赋方案都没有 '
      + '（那些指南里的天赋图是照上一版天赋树编的，解不开就不收 —— 面板会退回插件那条路）');
  }
  if (stat.tVer2) {
    warn(stat.tVer2 + ' 条 maxroll 串的串头版本号是 2（游戏认这个版本，实测一直是 130）'
      + ' —— 「maxroll 不给导入串」这个决定要重看：app/bis.js 的 mr-nostr 那句说明、'
      + 'tools/run-tests.js 的「mr 又给串了」那条断言都是照 130 写的');
  }
})();

report();

function report() {
  console.log('校验       ' + path.relative(BASE, dataPath));
  console.log('数据       v' + M.v + '   ' + M.updatedAt);
  console.log('规模       ' + stat.specs + ' 专精 / ' + stat.views + ' 个视角 / '
    + Object.keys(M.items || {}).length + ' 件物品');
  console.log('装备       BiS ' + stat.bisRows + ' 个部位组，替代 ' + stat.altRows
    + ' 个，附魔 ' + stat.ench + ' 个，饰品分级 ' + stat.tiers + ' 行');
  console.log('槽位映射   ' + Object.keys(M.slotMap || {}).length + ' 个 maxroll 名字 → INVSLOT');
  console.log('天赋       ' + stat.talents + ' 套 / ' + stat.tSpecs + ' 个专精（单专精最多 '
    + stat.tMax + ' 套），打包两条英雄树 ' + stat.tBundled + ' 套，多小节共用 ' + stat.tShared + ' 套');
  console.log('天赋复核   ' + stat.tDecoded + ' 条串重解一遍对声明的点数 / 英雄树'
    + '（解码器用 app/talent-decode.js，和生成器那份不是同一个实现）');
  console.log('检查项     ' + checks);

  if (warns.length) {
    console.log('');
    console.log('警告 ' + warns.length + ' 条：');
    warns.forEach(function (w) { console.log('  · ' + w); });
  }

  console.log('');
  if (errors.length) {
    console.log('不合格式，' + errors.length + ' 个问题：');
    errors.slice(0, 30).forEach(function (e) { console.log('  · ' + e); });
    if (errors.length > 30) console.log('  … 还有 ' + (errors.length - 30) + ' 个');
    process.exit(1);
  }
  console.log('格式全部通过。每个 itemId 都能在物品池里查到，'
    + '槽位名全部落在认识的 INVSLOT 上 —— 这两关能过说明推导和聚合没错位。');
}
