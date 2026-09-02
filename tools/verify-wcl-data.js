/*
 * WowAltBoard - tools/verify-wcl-data.js
 *
 * app/wcl-data.js 的**可执行格式定义**。和 verify-rio-data.js / verify-maxroll-data.js
 * 同一个位置：价值在「换团本重抓时能拦住不合格的新产物」，所以平时必须一直是绿的。
 *
 * 这份数据的判据比另外两家强一档，因为**串本身就带着答案**：
 * 串头是 8 位版本 + 16 位 specID，所以「这条串是不是这个专精的」不用信任任何
 * 别的字段，解一遍就知道。生成器就是靠这个给串分专精的（不问 WCL），
 * 那这里就必须独立再解一遍 —— 拿生成器的判断验生成器的产物等于什么都没验。
 *
 * 解码器故意用 **app/talent-decode.js**（面板那份），不用生成器用的
 * tools/decode-talent-string.js —— 两份实现是各写一遍的。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.join(__dirname, '..');
var dataPath = path.join(BASE, 'app', 'wcl-data.js');

if (!fs.existsSync(dataPath)) {
  console.error('没有 app/wcl-data.js —— 先跑 node tools\\fetch-wcl.js');
  process.exit(1);
}

var win = {};
new Function('window', fs.readFileSync(dataPath, 'utf8'))(win); // eslint-disable-line no-new-func
var W = win.AE_WCL;

// 面板那份解码器 + 树。加载方式抄 verify-maxroll-data.js：
// talent-decode.js 挂的是 window.AE.TalentDecode，不是 window.AE_TALENT_DECODE，
// 而且它要 window 自引用（g.window = g）才能拿到 AE 这个命名空间。
var DEC = null, TREE = null;
(function () {
  var treeJs = path.join(BASE, 'app', 'talent-tree.js');
  var decJs = path.join(BASE, 'app', 'talent-decode.js');
  if (!fs.existsSync(treeJs) || !fs.existsSync(decJs)) {
    console.error('缺 app/talent-tree.js 或 app/talent-decode.js —— 串没法复核。'
      + '先跑 node tools\fetch-talent-tree.js');
    process.exit(1);
  }
  var gg = {}; gg.window = gg;
  new Function('window', fs.readFileSync(treeJs, 'utf8'))(gg); // eslint-disable-line no-new-func
  new Function('window', fs.readFileSync(decJs, 'utf8'))(gg);  // eslint-disable-line no-new-func
  TREE = gg.AE_TALENT_TREE;
  DEC = gg.AE && gg.AE.TalentDecode;
  if (!TREE || !TREE.specs || !DEC || !DEC.decode) {
    console.error('加载后拿不到天赋树或解码器');
    process.exit(1);
  }
}());

var errors = [], warns = [], checks = 0;
function fail(m) { errors.push(m); }
function warn(m) { warns.push(m); }
function ck() { checks++; }

var stat = { specs: 0, rows: 0, people: 0, decoded: 0, thin: [] };

/* ------------------------------------------------------------------ 顶层 */
(function () {
  ck();
  if (!W || typeof W !== 'object') { fail('window.AE_WCL 不是对象'); return; }
  ck(); if (W.v !== 1) fail('v 应该是 1，实际 ' + W.v);
  ck(); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(W.updatedAt))) {
    fail('updatedAt 不是 YYYY-MM-DD：' + W.updatedAt);
  }
  ['source', 'note', 'raid'].forEach(function (k) {
    ck();
    if (!W[k] || typeof W[k] !== 'string') fail(k + ' 缺失或不是字符串');
  });
  ck(); if (!W.fmt || typeof W.fmt !== 'object') fail('缺 fmt（格式自述）');
  ck(); if (!W.specs || typeof W.specs !== 'object') fail('缺 specs');
  ck();
  if (typeof W.fights !== 'number' || W.fights < 1) {
    fail('fights 不是正整数：' + W.fights + ' —— 它记的是采样了多少场战斗');
  }
}());
if (errors.length) report();

/* ------------------------------------------------------------------ 每个专精 */
Object.keys(W.specs || {}).forEach(function (sid) {
  var S = W.specs[sid];
  var at = '专精 ' + sid;
  stat.specs++;
  ck();
  if (!TREE.specs[sid]) {
    fail(at + ' 在 app/talent-tree.js 里不存在 —— specID 从哪来的？');
    return;
  }
  ck(); if (typeof S.cls !== 'string' || !S.cls) fail(at + '.cls 不是非空串');
  ck(); if (typeof S.specEn !== 'string' || !S.specEn) fail(at + '.specEn 不是非空串');
  // cls / specEn 必须和树里那份一致。不一致说明产物是拿别处的名字拼的，
  // 面板按它显示就会张冠李戴。
  ck();
  if (S.cls !== TREE.specs[sid].cls || S.specEn !== TREE.specs[sid].specEn) {
    fail(at + ' 的职业/专精名是「' + S.cls + '/' + S.specEn + '」，'
      + '树里是「' + TREE.specs[sid].cls + '/' + TREE.specs[sid].specEn + '」');
  }
  ck();
  if (typeof S.n !== 'number' || S.n < 1) fail(at + '.n 不是正整数：' + S.n);
  else stat.people += S.n;
  if (S.n < 20) stat.thin.push(S.cls + '/' + S.specEn + ':' + S.n);

  var lo = S.loadouts;
  ck();
  if (!Array.isArray(lo) || !lo.length) { fail(at + '.loadouts 是空的'); return; }
  ck();
  if (lo.length > 30) fail(at + '.loadouts 有 ' + lo.length + ' 条，超过 30 的上限');
  ck();
  if (typeof S.uniq !== 'number' || S.uniq < lo.length) {
    fail(at + '.uniq 是 ' + S.uniq + '，不该小于留下来的 ' + lo.length
      + ' 种 —— 它记的是去重前的真实种类数');
  }

  var prev = null, seen = {};
  lo.forEach(function (row, i) {
    var where = at + '.loadouts[' + i + ']';
    stat.rows++;
    ck();
    if (!Array.isArray(row) || row.length !== 2) {
      fail(where + ' 不是 [串, 人数] 两元组');
      return;
    }
    var str = row[0], cnt = row[1];
    ck();
    if (typeof str !== 'string' || !/^[A-Za-z0-9+/]+$/.test(str)) {
      fail(where + ' 的串不是标准 base64：' + String(str).slice(0, 24));
      return;
    }
    ck();
    if (typeof cnt !== 'number' || cnt < 1 || cnt !== Math.floor(cnt)) {
      fail(where + ' 的人数不是正整数：' + cnt);
    }
    // 顺序：人数降序。面板不重排，所以「#1 热门」是不是真的最热门全靠这里。
    ck();
    if (prev !== null && cnt > prev) {
      fail(where + ' 破了人数降序：' + cnt + ' 人排在 ' + prev + ' 人后面');
    }
    prev = cnt;
    // 同一个专精里不许有重复的串 —— 重复说明聚合的键写错了。
    ck();
    if (seen[str]) fail(where + ' 和第 ' + seen[str] + ' 条是同一串 —— 聚合没生效');
    else seen[str] = i + 1;

    // ---- 最硬的一条：把串解开，串头里的 specID 必须就是这个专精。
    //
    // 生成器就是靠解串头给串分专精的，所以这里独立解一遍才有意义。
    // 版本必须是 2 —— 游戏只认 2，别的版本粘进去必然被拒，而界面上看不出来。
    ck();
    var d = null;
    try { d = DEC.decode(str, TREE); } catch (e) { /* 下面统一报 */ }
    if (!d || d.err) {
      fail(where + ' 解不开：' + ((d && d.err) || '解码器抛异常')
        + ' —— 解不开的串放进产物，用户复制粘贴进游戏只会得到「无效」');
      return;
    }
    ck();
    if (d.ver !== 2) {
      fail(where + ' 串头版本是 ' + d.ver + '，不是 2 —— 游戏只认 2');
    }
    ck();
    if (Number(d.spec) !== Number(sid)) {
      fail(where + ' 串头里的 specID 是 ' + d.spec + '，不是 ' + sid
        + ' —— 导错专精游戏会直接拒绝');
    } else {
      stat.decoded++;
    }
    /*
     * 节点数和点数的下界。
     *
     * **字段名是 nr（node→{rank,eid}）不是 nodes**，而且是个对象不是数组 ——
     * 第一版按 `d.nodes.length` 判，每条都得 0，1100 多条全报「串是空的」。
     * 那是仪器错，不是数据错：面板那份解码器（app/talent-decode.js）和
     * 生成器那份（tools/decode-talent-string.js）返回的形状不一样，
     * 前者给 {ver, spec, pts, nr, subs, granted, hash, cls}。
     *
     * 满级天赋实测 74~78 个节点、82 点（含白给的能到 84）。解出个位数说明
     * 串虽然能解但内容是空的（比如全 A 的占位串）。
     */
    ck();
    var nn = Object.keys(d.nr || {}).length;
    if (nn < 20) {
      fail(where + ' 只解出 ' + nn + ' 个节点 —— 实测满级天赋是 74~78 个，'
        + '这条串大概是空的');
    }
    ck();
    if (typeof d.pts !== 'number' || d.pts < 40) {
      fail(where + ' 解出来只有 ' + d.pts + ' 点 —— 满级是 82 点上下，'
        + '这条串大概是没点满的角色（团本榜上不该有）');
    }
  });

  /*
   * 单条的人数不该超过采样人数 —— 那才是真正不可能的事。
   *
   * **不能拿「人数之和 ≤ n」当判据**，第 20 轮改成按角色去重之后这条就错了：
   * 计数单位是「多少个不同的角色用过这一串」，而同一个角色在不同夜晚换过天赋时
   * 会在两套里各算一次（那是真实情况，他确实用过两套）。所以之和**可以**大于 n。
   * 原来那条断言是按「出场次数」写的，而出场次数正是这一轮要修掉的东西。
   */
  ck();
  var maxCnt = lo.reduce(function (a, r) {
    return Math.max(a, Array.isArray(r) ? (r[1] || 0) : 0);
  }, 0);
  if (maxCnt > S.n) {
    fail(at + ' 有一条串写着 ' + maxCnt + ' 个角色在用，而这个专精总共只采样到 '
      + S.n + ' 个角色');
  }
  // 之和的上界放宽但不取消：一个角色平均换三套以上天赋是不合理的，
  // 那更像是去重的键出了问题（比如 gameID 取不到、退回名字时跨服重名）。
  ck();
  var sum = lo.reduce(function (a, r) { return a + (Array.isArray(r) ? r[1] : 0); }, 0);
  if (sum > S.n * 3) {
    fail(at + ' 的人数之和 ' + sum + ' 是采样角色数 ' + S.n + ' 的三倍以上 ——'
      + '一个人平均换了三套天赋？更像是去重的键坏了');
  }
});

/* -------------------------------------------------------------------- 总量 */
(function () {
  ck();
  if (stat.specs < 30) {
    warn('只覆盖 ' + stat.specs + ' 个专精（共 ' + Object.keys(TREE.specs).length
      + ' 个）。团本阵容里一队 20 人只有 2~3 个坦克 / 治疗，冷门专精天然少 ——'
      + '但少于 30 个说明采样的战斗数不够，多翻几页榜（--pages）');
  }
  // 空转守卫：解码那一条必须真的跑过。
  ck();
  if (!stat.decoded) {
    fail('一条串都没解开过 —— 这一组在验空气（解码器加载失败？）');
  } else if (stat.decoded !== stat.rows) {
    fail('解码复核只过了 ' + stat.decoded + '/' + stat.rows + ' 条');
  }
  if (stat.thin.length) {
    warn('采样不到 20 人的 ' + stat.thin.length + ' 个专精：' + stat.thin.join('，'));
  }
}());

report();

function report() {
  console.log('');
  console.log('来源       ' + (W && W.source));
  console.log('团本       ' + (W && W.raid) + '（' + (W && W.difficulty) + '），'
    + '采样 ' + (W && W.fights) + ' 场战斗');
  console.log('规模       ' + stat.specs + ' 个专精 / ' + stat.people + ' 人次 / '
    + stat.rows + ' 条串（各专精最多 30 种）');
  console.log('串头复核   ' + stat.decoded + ' / ' + stat.rows
    + ' 条：版本 2 + specID 与所属专精一致 + 节点数 ≥ 20'
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
  console.log('格式全部通过。每条串都独立解开过，串头的 specID 和它所在的专精一致 ——'
    + '这一关能过说明「按串头分专精」这件事没错位。');
}
