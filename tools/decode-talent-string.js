// 解官方天赋导入串（就是你在游戏里「复制导入串」拿到的那一长串 base64）。
//
// 这个工具是研究性质的，不进发布包，也不被面板调用 —— 它的用处是回答一个问题：
// 「我们到底能不能自己生成游戏认的天赋串？」答案和每个实测数字都记在 计划.md 里。
//
// 结论：不需要自己生成。面板显示的串是从 raider.io 排行榜上原样取来的现成串
// （见 app/bis.js 的 renderLoadouts）。这个解码器只用来**验证**那些串 ——
// tools/verify-talent-decode.js 拿它对 tools/talent-truth.json 逐节点复核，
// run-tests.js 用它的 toBits() 读串头里的 specID。
//
// 串的结构（实测，不是抄来的）：
//   头部  8 位版本 + 16 位 specID + 128 位 treeHash
//   然后按 fullNodeOrder 逐个节点：
//     1 位 选没选；选了则
//       1 位 是不是花点买的（不是就是白给的，白给的不再读任何位）；买了则
//         1 位 是不是没点满；没点满则 6 位 实际点数
//         1 位 是不是二选一；是则 2 位 选了哪个
//   末尾补 0 到 6 的整数倍。
// 字母表是标准 base64（无 padding），每个字符 6 位，**位序是低位在前**。
//
// 上面这套布局不是猜的，是往返测出来的：解开再按同样规则装回去，和原串逐字符比。
// 54 个真串里 28 个原样往返（--verify 会重新算一遍这个数）。
// 位宽用 6 不用 4/5，理由同样是往返数最高（28 > 27 > 27）。
//
// 用法：
//   node tools\decode-talent-string.js <串>        解一个串并打印中文名
//   node tools\decode-talent-string.js --scan      扫本机存档里的串，逐个报状态
//   node tools\decode-talent-string.js --verify    往返自测，打印一致率
//   --wtf <目录>   指定 WTF 目录（默认 E:\World of Warcraft\_retail_\WTF）
//   --limit <n>    --scan / --verify 时只看前 n 个
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var RAW = path.join(__dirname, '.talent-raw', 'talents.json');
var TREE_JS = path.join(ROOT, 'app', 'talent-tree.js');
var DEFAULT_WTF = 'E:/World of Warcraft/_retail_/WTF';

// base64 标准表。**不要**换成 URL-safe 的那套，官方串里 + 和 / 都会出现。
var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var RANK_BITS = 6;
// 二选一下标（和 partial 标记）是嵌在 purchased 里，还是和 purchased 平级？
// 这两种布局都能逐位往返一致 —— 只有语义检查能分辨。默认值是实测选出来的。
var LAYOUT_NEST = true;

function toBits(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var v = ALPHA.indexOf(s[i]);
    if (v < 0) return null;
    for (var b = 0; b < 6; b++) out.push((v >> b) & 1);
  }
  return out;
}

function fromBits(arr) {
  var s = '';
  for (var i = 0; i < arr.length; i += 6) {
    var v = 0;
    for (var b = 0; b < 6; b++) v |= (arr[i + b] || 0) << b;
    s += ALPHA[v];
  }
  return s;
}

function reader(arr) {
  var p = 0;
  return {
    read: function (n) {
      var v = 0;
      for (var i = 0; i < n; i++) { v |= (arr[p] || 0) << i; p++; }
      return v;
    },
    left: function () { return arr.length - p; }
  };
}

function writer() {
  var a = [];
  return {
    write: function (v, n) { for (var i = 0; i < n; i++) a.push((v >> i) & 1); },
    bits: a
  };
}

/**
 * 解码要的两样东西：每个职业的节点顺序，和每个专精自己的节点表。
 *
 * 读的是**提交进仓库的** app/talent-tree.js，不是 14 MB 的 raidbots 原始缓存。
 * 这一点是有意的：解码器和它的校验器必须在「刚克隆完、还没联网」的机器上能跑，
 * 否则校验器只会静默跳过 —— 而「因为没数据所以跳过」的测试报成通过，是这个项目
 * 反复踩到的那种假绿。
 *
 * 返回 {specId: {t: {className, specName, fullNodeOrder}, nodes: {id: 节点}}}。
 * 形状故意和以前读原始文件时一致，调用方不用改。
 */
function loadOrder() {
  var tree = loadTree();
  if (!tree || !tree.nodeOrder) return null;
  var SUBTREE = tree.types.indexOf('subtree');
  var bySpec = {};
  Object.keys(tree.specs).forEach(function (sid) {
    var sp = tree.specs[sid];
    var order = tree.nodeOrder[sp.cls];
    if (!order) return;
    var nodes = {};
    ['classNodes', 'specNodes', 'heroNodes', 'subNodes'].forEach(function (g) {
      (sp[g] || []).forEach(function (id) {
        var row = tree.nodes[id];
        if (!row) return;
        // row = [posX, posY, maxRanks, typeIdx, reqPoints, entries[], subTreeId, requiresNode]
        // entry = [entryId, nameIdx, iconIdx, spellId, maxRanks]
        //
        // maxRanks 那一格：生成器写的是 `n.maxRanks || 0`，而英雄天赋选择节点
        // （type=subtree）在 raidbots 里根本没有这个字段。所以 0 要还原成 null，
        // 不然 rank 的兜底会把「没有上限」当成「上限 0」。这不是猜的：实测
        // maxRanks=0 的节点恰好是那 40 个 subtree 节点，两个数字对得上。
        var isSub = row[3] === SUBTREE;
        nodes[id] = {
          maxRanks: (row[2] === 0 && isSub) ? null : row[2],
          type: tree.types[row[3]],
          entries: (row[5] || []).map(function (e) { return { id: e[0], maxRanks: e[4] }; })
        };
      });
    });
    bySpec[sid] = {
      t: { className: sp.cls, specName: sp.specEn, fullNodeOrder: order },
      nodes: nodes
    };
  });
  return bySpec;
}

/** app/talent-tree.js 里的中文名。它是提交进仓库的，所以中文名总是有的。 */
function loadTree() {
  if (!fs.existsSync(TREE_JS)) return null;
  var g = {};
  g.window = g;
  var fn = new Function('window', fs.readFileSync(TREE_JS, 'utf8'));
  fn(g);
  return g.AE_TALENT_TREE || null;
}

/**
 * 解一个串。返回 {ver, spec, hash, nodes[], err, leftBits, tailNonZero}
 * nodes[i] = {id, purchased, rank, choice}
 */
function decode(S, bySpec) {
  // bySpec 必传。漏传过一次，后果是每个串都解出 0 个节点、err 写着「没有 specID
  // xxx」—— 看上去像「数据对不上」，其实是调用错了，我照着这个假读数写了一整轮
  // 结论。所以这里硬抛：少参数是调用者的 bug，不是一种数据情况。
  if (bySpec === undefined) throw new Error('decode(S, bySpec)：bySpec 必传，用 loadOrder() 取');
  var arr = toBits(S);
  if (!arr) return { err: '串里有 base64 表外的字符' };
  var r = reader(arr);
  var out = { ver: r.read(8), spec: r.read(16), nodes: [] };
  var hash = [];
  for (var i = 0; i < 16; i++) hash.push(r.read(8));
  out.hash = hash.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  var entry = bySpec ? bySpec[out.spec] : null;
  if (!entry) { out.err = 'raidbots 数据里没有 specID ' + out.spec; return out; }
  out.cls = entry.t.className;
  out.specName = entry.t.specName;
  var order = entry.t.fullNodeOrder || [];
  out.orderLen = order.length;
  var w = writer();
  w.write(out.ver, 8); w.write(out.spec, 16);
  hash.forEach(function (b) { w.write(b, 8); });
  for (var k = 0; k < order.length; k++) {
    if (r.left() < 1) {
      out.err = '位读完了但节点还剩 ' + (order.length - k) + ' 个没走到'
        + '（这串大概是照着另一版天赋树编的）';
      out.stoppedAt = k;
      break;
    }
    var sel = r.read(1); w.write(sel, 1);
    if (!sel) continue;
    var pur = r.read(1); w.write(pur, 1);
    var rec = { id: order[k], purchased: !!pur, rank: null, choice: null };
    // 两种布局。nest=Y：partial / choice 只在 purchased=1 时才有；
    // nest=N：不管买没买都读。哪个对由语义检查判，不是我说了算。
    if (LAYOUT_NEST ? pur : true) {
      var part = r.read(1); w.write(part, 1);
      if (part) { rec.rank = r.read(RANK_BITS); w.write(rec.rank, RANK_BITS); }
      var ch = r.read(1); w.write(ch, 1);
      if (ch) { rec.choice = r.read(2); w.write(rec.choice, 2); }
    }
    var n = entry.nodes[rec.id];
    rec.maxRanks = n ? n.maxRanks : null;
    rec.inSpec = !!n;
    // 没读到 partial 位时，点数就是该节点的上限。但**英雄天赋的选择节点
    // （type='subtree'）在 raidbots 里根本没有 maxRanks 字段**，直接赋值会得到
    // undefined。这不是我猜的默认值：raider.io 的真值对这 33 个节点一致给 1
    // （英雄树只有「选了 / 没选」两种状态），改成退到 1 之后 rank 不符从 33 → 0。
    if (rec.rank === null) {
      rec.rank = (typeof rec.maxRanks === 'number') ? rec.maxRanks : 1;
    }
    // purchased 位的反面就是「系统白给的」。这不是推测：拿 raider.io 的
    // grantedNode 真值比过 32 份 profile，干净串上 0 处不符。
    rec.granted = !rec.purchased;
    rec.entryIndex = entryIndexOf(rec, n);
    out.nodes.push(rec);
  }
  // 末尾应该只剩补的 0
  out.tailNonZero = 0;
  var left = r.left();
  for (var j = 0; j < left; j++) if (r.read(1)) out.tailNonZero++;
  out.leftBits = left;
  // 往返：装回去和原串比。
  // **这一条是弱检查**，别拿它当「布局解对了」的证据 —— 我是读 n 位再写回 n 位，
  // 本质上是逐位抄一遍，字段含义猜错了照样一致。实测把点数位宽从 6 改成 4，
  // 一致率只从 28 掉到 27，就是因为它几乎测不出东西。留着它只为一个用途：
  // 确认「总位数对齐、尾部只有补的 0」。真正能否证布局的是下面 checkSemantics。
  var pad = Math.max(0, arr.length - w.bits.length);
  for (var q = 0; q < pad; q++) w.bits.push(0);
  out.reencoded = fromBits(w.bits);
  out.roundTrip = out.reencoded === S;
  checkSemantics(out, entry);
  return out;
}

/**
 * 位流里没有「用了哪个 entry」这个字段，只有二选一节点带 2 位下标。
 * 其余多 entry 的节点（raidbots 的 type='tiered'，界面上是同名的三档）
 * 靠 rank 推：按 entries[].maxRanks 累加，rank 落在哪一档就是那个下标。
 *
 * **这条规则的验证是不完整的**，别把它当已证实的。32 份 raider.io profile 里
 * tiered 节点只出现过满级一种情况（31/31 都是 rank=4 → entryIndex=2，
 * 而 maxRanks 是 1/2/1，累加恰好落在下标 2），所以「累加」和「永远取最后一档」
 * 在现有样本上给出同样的答案，分不开。要分开得有一份没点满 tiered 的样本。
 * 二选一节点那一路是真验证过的：下标直接来自位流，309 个样本 0 处不符。
 */
function entryIndexOf(rec, def) {
  if (rec.choice !== null) return rec.choice;
  var ents = (def && def.entries) || [];
  if (ents.length < 2) return 0;
  if (typeof rec.rank !== 'number') return 0;
  var acc = 0;
  for (var i = 0; i < ents.length; i++) {
    acc += (typeof ents[i].maxRanks === 'number' ? ents[i].maxRanks : 1);
    if (rec.rank <= acc) return i;
  }
  return ents.length - 1;
}

/**
 * 语义检查 —— 这才是能证伪布局的那一半。
 *
 * 三条都是「游戏里结构上不可能」的事，跟点数上限那种我猜的数字无关：
 *   1. 买下的节点必须属于本专精。fullNodeOrder 是**整个职业**的顺序，
 *      里面有别的专精的节点；一个复原萨满不可能点出增强专属的节点。
 *      位错一格，选中位就会落到别的专精的节点上 —— 这一条抓的就是错位。
 *   2. rank 不能超过该节点的 maxRanks。
 *   3. 只有真有两个 entry 的节点才能带「二选一下标」。
 */
function checkSemantics(out, entry) {
  // 第二个参数是**单个专精的条目**（loadOrder()[specId]），不是整张表。
  // 传错了会让 entry.nodes 是 undefined。以前这里会当场崩在 entry.nodes[id]
  // 上，堆栈指向本文件，看着像解码器的 bug —— 实际是调用方传错。
  // 我自己在探针里连着传错两次（decode 少传 bySpec、这里传整张表），
  // 两次都得到「0 个节点、全不干净」这种看起来像数据结论的输出。
  if (!entry || !entry.nodes) {
    throw new Error('checkSemantics 的第二个参数要 loadOrder()[specId]（单个专精），'
      + '不是整张表，也不能省');
  }
  out.crossSpec = 0; out.overMax = 0; out.badChoice = 0;
  out.nodes.forEach(function (n) {
    var def = entry.nodes[n.id];
    if (n.purchased && !def) { out.crossSpec++; return; }
    if (!def) return;
    if (typeof n.rank === 'number' && typeof def.maxRanks === 'number'
        && n.rank > def.maxRanks) out.overMax++;
    var nEnt = (def.entries || []).length;
    if (n.choice !== null && nEnt < 2) out.badChoice++;
  });
  // 「干净」= 走完了整个 fullNodeOrder，而且三条语义检查都是 0。
  out.clean = !out.err && !out.crossSpec && !out.overMax && !out.badChoice;
  return out;
}

/** 扫存档目录，收集所有像导入串的字符串。 */
function scanWtf(wtf) {
  var names = ['TalentLoadoutsEx.lua', 'BtWLoadouts.lua'];
  var found = [], seen = {};
  function walk(dir) {
    var ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (names.indexOf(e.name) >= 0) {
        var txt = fs.readFileSync(p, 'utf8');
        var re = /"([A-Za-z0-9+/]{60,})"/g, m;
        while ((m = re.exec(txt))) {
          if (!seen[m[1]]) { seen[m[1]] = 1; found.push({ s: m[1], file: e.name }); }
        }
      }
    });
  }
  walk(wtf);
  return found;
}

// ------------------------------------------------------------------ 对外接口
// 被 require 时只给函数，不跑命令行。CommonJS 的模块体本身就是个函数，
// 所以这里的顶层 return 是合法的。
module.exports = {
  decode: decode,
  checkSemantics: checkSemantics,
  loadOrder: loadOrder,
  loadTree: loadTree,
  scanWtf: scanWtf,
  toBits: toBits,
  fromBits: fromBits,
  DEFAULT_WTF: DEFAULT_WTF,
  setLayout: function (nest, rankBits) {
    if (typeof nest === 'boolean') LAYOUT_NEST = nest;
    if (rankBits) RANK_BITS = rankBits;
  }
};
if (require.main !== module) return;

// ------------------------------------------------------------------ 命令行
var argv = process.argv.slice(2);
function flag(name, def) {
  var i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
var WTF = flag('--wtf', DEFAULT_WTF);
RANK_BITS = Number(flag('--rankbits', RANK_BITS)) || RANK_BITS;
if (argv.indexOf('--flat') >= 0) LAYOUT_NEST = false;
var LIMIT = Number(flag('--limit', 0)) || 0;
var doScan = argv.indexOf('--scan') >= 0;
var doVerify = argv.indexOf('--verify') >= 0;
var positional = argv.filter(function (a, i) {
  if (a.indexOf('--') === 0) return false;
  return !(i > 0 && (argv[i - 1] === '--wtf' || argv[i - 1] === '--limit'
    || argv[i - 1] === '--rankbits'));
});

var bySpec = loadOrder();
if (!bySpec) {
  console.log('没有 tools\\.talent-raw\\talents.json，解不了节点。');
  console.log('先跑：node tools\\fetch-talent-tree.js --refresh');
  process.exit(1);
}
var tree = loadTree();
var nameOf = function (nodeId) {
  if (!tree || !tree.nodes) return null;
  var n = tree.nodes[nodeId];
  if (!n) return null;
  var ents = n[5] || [];
  if (!ents.length) return null;
  var idx = ents[0][1];
  return tree.names[idx] || null;
};

if (doScan || doVerify) {
  var all = scanWtf(WTF);
  if (LIMIT) all = all.slice(0, LIMIT);
  console.log('存档里的导入串 ' + all.length + ' 个（' + WTF + '）');
  var clean = 0, rt = 0, unknown = 0, cross = 0, over = 0, badCh = 0, short_ = 0, groups = {};
  all.forEach(function (item) {
    var d = decode(item.s, bySpec);
    if (!d.cls) { unknown++; return; }
    var key = d.cls + '/' + d.specName + ' ' + d.hash.slice(0, 12);
    groups[key] = groups[key] || { clean: 0, n: 0 };
    groups[key].n++;
    if (d.clean) { clean++; groups[key].clean++; }
    if (d.roundTrip) rt++;
    if (d.crossSpec) cross++;
    if (d.overMax) over++;
    if (d.badChoice) badCh++;
    if (d.err) short_++;
    if (doScan) {
      var pur = d.nodes.filter(function (x) { return x.purchased; }).length;
      var grant = d.nodes.length - pur;
      console.log('  ' + (d.clean ? '干净' : '有问题') + '  '
        + d.cls + '/' + d.specName + '  v' + d.ver
        + '  节点 ' + d.nodes.length + '（买 ' + pur + '，白给 ' + grant + '）'
        + (d.crossSpec ? '  别的专精的节点 ' + d.crossSpec : '')
        + (d.overMax ? '  点数超上限 ' + d.overMax : '')
        + (d.badChoice ? '  二选一下标落在非二选一节点上 ' + d.badChoice : '')
        + (d.err ? '  ' + d.err : ''));
    }
  });
  console.log('\n干净 ' + clean + '/' + (all.length - unknown)
    + '（走完整个 fullNodeOrder 且三条语义检查全 0）');
  console.log('  位不够提前停 ' + short_ + '，买到别的专精的节点 ' + cross
    + '，点数超上限 ' + over + '，二选一下标放错 ' + badCh
    + '，认不出专精 ' + unknown);
  console.log('  逐位往返一致 ' + rt + '（弱检查，见源码注释：读 n 位写 n 位，几乎测不出东西）');
  console.log('按「专精 + treeHash」分组（干净数 / 总数）：');
  Object.keys(groups).sort().forEach(function (k) {
    var g2 = groups[k];
    console.log('  ' + k + '  ' + g2.clean + '/' + g2.n
      + (g2.clean === g2.n ? '  全过' : g2.clean === 0 ? '  全不过' : '  混合'));
  });
  process.exit(0);
}

if (!positional.length) {
  console.log('用法：node tools\\decode-talent-string.js <串> | --scan | --verify');
  process.exit(1);
}

var d = decode(positional[0], bySpec);
if (d.err && !d.cls) { console.log('解不开：' + d.err); process.exit(1); }
console.log('序列化版本 ' + d.ver + '，专精 ' + d.spec
  + (d.cls ? '（' + d.cls + '/' + d.specName + '）' : ''));
console.log('treeHash ' + d.hash);
console.log('fullNodeOrder ' + d.orderLen + ' 个节点，选中 ' + d.nodes.length
  + '，往返' + (d.roundTrip ? '一致' : '不一致')
  + '，尾部非 0 位 ' + d.tailNonZero);
if (d.err) console.log('注意：' + d.err);
var pts = 0;
d.nodes.forEach(function (n) { if (n.purchased && typeof n.rank === 'number') pts += n.rank; });
console.log('花掉的点数 ' + pts);
console.log('');
d.nodes.forEach(function (n) {
  var zh = nameOf(n.id);
  console.log('  ' + n.id + '  ' + (zh || '（本机数据里没有这个节点的名字）')
    + '  ' + (n.rank === null ? '?' : n.rank) + '/' + (n.maxRanks === null ? '?' : n.maxRanks)
    + (n.purchased ? '' : '  白给')
    + (n.choice !== null ? '  二选一取 ' + n.choice : '')
    + (n.inSpec ? '' : '  ←不属于本专精'));
});
