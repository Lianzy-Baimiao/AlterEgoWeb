/*
 * WowAltBoard - tools/group-loadouts.js
 *
 * 把一堆天赋导入串按「解出来是同一套天赋」归并。**两个抓取器共用**
 * （tools/fetch-rio.js 的大秘境、tools/fetch-wcl.js 的团本），因为面板把两家
 * 并排放在一个开关下面 —— 「一套天赋」的定义必须是同一个。
 *
 * 实测：归并**几乎不改变任何东西**（数字在下面）。它的价值不是压缩行数，
 * 而是把「一套天赋」这件事定义在**解出来的内容**上，而不是字节上：
 * 上游哪天换个序列化写法，产物也不会把一套拆成两行。
 *
 * 「#1~#6 加起来对不上总人数」不是 bug（第 20 轮查清）
 * ----------------------------------------------
 * 用户报的：惩戒骑大秘境标题写「500 名玩家」，而 #1~#6 加起来只有 47 人。
 * 一开始以为是同一套天赋被不同客户端导出成了几十种串、人数被摊开。
 * **实测不是。** 大秘境缓存里 21181 条解得开的不同串 → 21173 套不同天赋
 * （1.000 种写法/套，最大的一组只有 2 种写法，全部 21173 套里只有 8 套
 * 有第二种写法）。团本那边 7920 条不同串 → 7920 套（1.00 种写法/套）。
 *
 * 也就是说：**天赋本来就人人不同。** 一个专精 1376 个人里有 649 套不同的天赋，
 * 最热门那一套 187 人，前 6 套加起来 300 人；另一个专精 673 人 535 套，
 * 最热门只有 31 人。加起来对不上总人数是真实情况，不是聚合算错了。
 *
 * 顺便记下那次错在哪：第一版这里写的是 `n.node`，而 tools/decode-talent-string.js
 * 返回的节点字段叫 **`n.id`**。于是每个节点都变成 `undefined:点数:二选一`，
 * 指纹退化成「只比点数和二选一的分布」，把**完全不同的天赋并成一套** ——
 * 7920 套并成 558 套，最大的一组塞了 250 套不同的天赋，而产物看起来非常合理
 * （「#1 有 139 人，60 种写法」）。所以下面 buildKey() 里那句 id 缺失就抛异常
 * 不是防御性代码，是**唯一能拦住这种静默退化的东西**：字段名一改，抓取器当场炸，
 * 而不是安安静静地给出一份错的产物。
 *
 * 真值从哪来：WCL 的 talentImportCode 是 WCL 自己从战斗记录生成的，同一套天赋
 * 必然生成同一串。所以「在 WCL 语料上，正确的指纹必须 ≈ 1 种写法/套」——
 * 那是一把独立的尺子，退化的指纹在它下面立刻现形（14.19 种/套）。
 * 这条尺子钉在 tools/run-tests.js 的「天赋归并」一组里。
 *
 * 归并的键：解出来的「节点 + 点数 + 二选一选了哪个」
 * ----------------------------------------------
 * **不是串、不是点数总和、也不是节点集合。** 点数总和一样的两套天赋可以完全
 * 不同；只比节点集合会把「同一个节点点 1 点和点 2 点」当成一套；只比
 * 「节点 + 点数」会把二选一选了另一边当成一套（实测 1.27 种/套，错的）。
 *
 * 代表串取**用得最多的那种写法**（实测基本只有一种）。同样多的时候按串本身排，
 * 保证结果稳定 —— 不然 Object.keys 的顺序一变，界面上「#1」指的就是另一串了。
 */
'use strict';

/**
 * @param rows   [{ ch: 角色身份, str: 导入串 }…]，ch 用来去重（同一个人同一套只算一次）
 * @param decode function(str) → 解码结果 {spec, nodes: [{id, rank, entryIndex}…]}，
 *               或 null / {err}
 * @returns {list, dropped, forms} —— list 是 [{ str 代表串, n 多少个角色, forms 多少种写法 }…]
 *          按 n 降序、同 n 按 str 排；dropped 是解不开的条数；forms 是写法总数
 */
function group(rows, decode) {
  var byBuild = {};
  var dropped = 0, forms = 0;
  (rows || []).forEach(function (row) {
    var str = row && row.str, ch = row && row.ch;
    if (!str) return;
    var key = buildKey(str, decode);
    if (!key) { dropped++; return; }
    var b = byBuild[key] || (byBuild[key] = { chars: {}, forms: {} });
    // 同一个角色 + 同一套天赋，出现多少次都只算一次（换了写法也还是同一套）。
    if (ch) b.chars[ch] = 1;
    else b.chars['#' + (Object.keys(b.chars).length + 1)] = 1;   // 没有身份就每条算一个
    b.forms[str] = (b.forms[str] || 0) + 1;
  });

  var list = Object.keys(byBuild).map(function (key) {
    var b = byBuild[key];
    var fs = Object.keys(b.forms).sort(function (x, y) {
      if (b.forms[y] !== b.forms[x]) return b.forms[y] - b.forms[x];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    forms += fs.length;
    return { str: fs[0], n: Object.keys(b.chars).length, forms: fs.length };
  });
  list.sort(function (a, b2) {
    if (b2.n !== a.n) return b2.n - a.n;
    return a.str < b2.str ? -1 : a.str > b2.str ? 1 : 0;
  });
  return { list: list, dropped: dropped, forms: forms };
}

/**
 * 一条串的「这是哪一套天赋」指纹。解不开返回 null。
 *
 * 节点先排序再拼：位流里节点是按 nodeOrder 走的，同一套天赋不同写法的
 * 遍历顺序理论上一致，但**别赌这个** —— 排一遍的代价是常数，赌错的代价是
 * 把同一套算成两套。
 *
 * 节点没有 id 就**抛异常**，不是返回 null：见文件开头，那正是第一版的错法，
 * 而返回 null 只会让抓取器把所有串都算成「解不开」然后照样写出一份产物。
 */
function buildKey(str, decode) {
  var d;
  try { d = decode(str); } catch (e) { return null; }
  if (!d || d.err) return null;
  var nodes = d.nodes;
  if (!Array.isArray(nodes) || !nodes.length) return null;
  var parts = nodes.map(function (n) {
    if (!n || n.id == null) {
      throw new Error('天赋节点没有 id 字段（拿到的是 ' + Object.keys(n || {}).join(',')
        + '）—— 指纹会退化成「只比点数分布」，把完全不同的天赋并成一套。'
        + '解码器的返回形状变了？见 tools/group-loadouts.js 开头。');
    }
    return n.id + ':' + (n.rank || 0) + ':' + (n.entryIndex != null ? n.entryIndex : '');
  });
  return (d.spec != null ? d.spec : '?') + '#' + parts.sort().join('|');
}

module.exports = { group: group, buildKey: buildKey };
