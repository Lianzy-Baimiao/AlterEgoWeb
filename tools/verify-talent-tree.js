/*
 * WowAltBoard - tools/verify-talent-tree.js
 *
 * 校验 app/talent-tree.js 的格式，并用它交叉验证 app/talent-data.js。
 *
 * 为什么 schema 写在这里而不是写成一份 .md
 * ----------------------------------------
 * 和 verify-bis-data.js 一样的理由：另写一份文档迟早和代码脱节，写在校验器里
 * 它每次跑测试都被执行一遍。下面的 SCHEMA / SPEC_SCHEMA / NODE_FORMAT 就是格式说明。
 *
 * 两层职责
 * --------
 *   1. 格式（换数据源时最先崩的东西）：字段在不在、类型对不对、下标越不越界、
 *      连线两端是否都在本专精内、坐标是否在合理范围。
 *   2. 交叉验证：talent-data.js 里每个 entryID 是否真的属于本专精的树。
 *      这一条能抓出上游 WCL 的专精误标 —— 本机实测防战有 1 套其实是武器战的天赋。
 *
 * 用法
 * ----
 *   node tools\verify-talent-tree.js
 *   node tools\verify-talent-tree.js --tree <路径>   # 校验候选文件
 *   node tools\verify-talent-tree.js --quiet
 *
 * 退出码 0 = 通过，1 = 有硬错误。警告不影响退出码。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var argv = process.argv.slice(2);
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }
function flag(n) { return argv.indexOf(n) >= 0; }

var TREE_PATH = opt('--tree', path.join(ROOT, 'app', 'talent-tree.js'));
var DATA_PATH = opt('--data', path.join(ROOT, 'app', 'talent-data.js'));
var QUIET = flag('--quiet');

// ---------------------------------------------------------------- schema

// 顶层字段。'str' / 'int' / 'obj' / 'arr'，后缀 ? = 可选。
var SCHEMA = {
  v:           { type: 'int', desc: '格式版本，改结构必须 +1' },
  updatedAt:   { type: 'str', desc: '生成日期 YYYY-MM-DD' },
  source:      { type: 'str', desc: '数据来源说明（给人看的）' },
  nodeFormat:  { type: 'str', desc: '节点数组的字段顺序说明' },
  entryFormat: { type: 'str', desc: '条目数组的字段顺序说明' },
  types:       { type: 'arr', desc: '节点类型名表，节点里存的是下标' },
  names:       { type: 'arr', desc: '中文名字典，条目里存的是下标' },
  icons:       { type: 'arr', desc: '图标名字典，条目里存的是下标' },
  subTrees:    { type: 'obj', desc: 'subTreeId → [名字下标, atlas, [节点id…]]' },
  nodes:       { type: 'obj', desc: 'nodeId → 节点数组，全局共享一份' },
  specs:       { type: 'obj', desc: 'specId → 专精' }
};

// 每个专精。
var SPEC_SCHEMA = {
  treeId:     { type: 'int', desc: 'C_Traits 的 treeID' },
  cls:        { type: 'str', desc: '职业英文名' },
  specEn:     { type: 'str', desc: '专精英文名' },
  classNodes: { type: 'arr', desc: '职业树的节点 id' },
  specNodes:  { type: 'arr', desc: '专精树的节点 id' },
  heroNodes:  { type: 'arr', desc: '英雄树的节点 id' },
  subNodes:   { type: 'arr', desc: '英雄子树选择节点的 id' },
  subTreeIds: { type: 'arr', desc: '这个专精能选的英雄子树' },
  edges:      { type: 'obj', desc: 'nodeId → [后继 nodeId…]，**按专精存**' },
  free:       { type: 'arr', desc: '不花点数的节点 id，**按专精存**' }
};

// 节点数组的字段顺序。改这里必须同时改生成器和面板。
var NODE_FORMAT = [
  'posX', 'posY', 'maxRanks', 'typeIdx', 'reqPoints', 'entries[]', 'subTreeId', 'requiresNode'
];
var ENTRY_FORMAT = ['entryId', 'nameIdx', 'iconIdx', 'spellId', 'maxRanks'];

// 允许留英文的名字白名单。
//
// 本机实测 3106 / 3106 全部含中文，所以这张表是空的 —— 空表是有意的，不是没写完。
// 规则定成「任何一项不含中文就失败」而不是「允许 5% 英文」，因为后者是我凭空发明的
// 宽容度：一个不存在的情况不需要预留额度，留了反而让真正的连接故障有地方藏。
// 将来暴雪上了没本地化的新天赋，校验器会明确报出是哪一个，那时候确认过是真串再加进来。
var ALLOW_EN = {};

// 坐标的合理范围。本机实测 X 600~17100、Y 300~7650；留一倍余量，
// 越界说明上游换了坐标系，那时候面板的缩放会整个错掉，必须报出来。
var X_MAX = 40000, Y_MAX = 20000;

// 为什么专精数是 40：13 个职业 × 3 专精 + 德鲜血/野性/守护/恢复第 4 个 …
// 实际就是当前版本的专精总数。少了说明上游漏了，多了说明混进了非玩家树。
var SPEC_COUNT = 40;

// ---------------------------------------------------------------- 工具

var errors = [];
var warnings = [];
var checks = 0;

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }
function ck() { checks++; }

function typeOk(v, t) {
  var opt = t.charAt(t.length - 1) === '?';
  var base = opt ? t.slice(0, -1) : t;
  if (v == null) return opt;
  if (base === 'str') return typeof v === 'string';
  if (base === 'int') return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  if (base === 'num') return typeof v === 'number' && isFinite(v);
  if (base === 'arr') return Array.isArray(v);
  if (base === 'obj') return v && typeof v === 'object' && !Array.isArray(v);
  return false;
}

function checkFields(obj, schema, where) {
  Object.keys(schema).forEach(function (k) {
    ck();
    if (!typeOk(obj[k], schema[k].type)) {
      fail(where + ' 的 ' + k + ' 不是 ' + schema[k].type +
           '（' + schema[k].desc + '），实际是 ' + describe(obj[k]));
    }
  });
  Object.keys(obj).forEach(function (k) {
    ck();
    if (!(k in schema)) warn(where + ' 有 schema 里没写的字段 ' + k);
  });
}

function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'arr(' + v.length + ')';
  if (typeof v === 'object') return 'obj(' + Object.keys(v).length + ')';
  if (typeof v === 'string') return 'str "' + v.slice(0, 24) + '"';
  return typeof v + ' ' + v;
}

// 数据文件都是 `window.AE_X = {…}`。用 new Function 求值，不用正则拆 ——
// 正则拆 JS 是错的做法，而且这些文件本来就是我自己生成的。
function loadGlobal(p, name) {
  if (!fs.existsSync(p)) { fail('找不到文件 ' + p); return null; }
  var src = fs.readFileSync(p, 'utf8');
  var win = {};
  try {
    new Function('window', src)(win);
  } catch (e) {
    fail(p + ' 求值失败：' + e.message);
    return null;
  }
  if (!win[name]) { fail(p + ' 里没有 window.' + name); return null; }
  return win[name];
}

function hasCJK(s) { return /[\u4e00-\u9fff]/.test(String(s)); }

// ---------------------------------------------------------------- 校验树

var T = loadGlobal(TREE_PATH, 'AE_TALENT_TREE');

function verifyTree() {
  if (!T) return null;

  checkFields(T, SCHEMA, 'talent-tree.js 顶层');

  ck();
  if (T.nodeFormat !== '[' + NODE_FORMAT.join(', ') + ']') {
    fail('nodeFormat 和校验器里的 NODE_FORMAT 不一致：数据说 ' + T.nodeFormat +
         '，校验器说 [' + NODE_FORMAT.join(', ') + ']');
  }
  ck();
  if (T.entryFormat !== '[' + ENTRY_FORMAT.join(', ') + ']') {
    fail('entryFormat 和校验器里的 ENTRY_FORMAT 不一致：数据说 ' + T.entryFormat);
  }

  var specIds = Object.keys(T.specs || {});
  ck();
  if (specIds.length !== SPEC_COUNT) {
    fail('专精数 ' + specIds.length + '，应该是 ' + SPEC_COUNT);
  }

  // ---- 字典
  ck();
  if (!T.names.length) fail('名字字典是空的');
  var noCJK = 0;
  T.names.forEach(function (n) {
    ck();
    if (typeof n !== 'string' || !n) { fail('名字字典里有空项'); return; }
    if (!hasCJK(n) && !ALLOW_EN[n]) noCJK++;
  });
  ck();
  // 中文名是这个文件存在的理由，所以这里是**零容忍**，不是百分比阈值。
  //
  // 我第一版写的是「允许 5% 英文，新内容可能还没本地化」—— 那是凭想象定的余量：
  // 本机实测 3106 / 3106 全部含中文，一个英文都没有。给一个不存在的情况留余量，
  // 结果就是变异测试里「往字典里塞一个英文名」它只警告不报错，等于漏了。
  //
  // 万一以后暴雪真出了个官方就是英文的天赋名，这里会失败 —— 那时候把它加进
  // ALLOW_EN 并写清为什么，比现在留一个 5% 的口子好：前者是一次有据可查的决定，
  // 后者是长期看不见的沉默。
  if (noCJK) {
    var enList = T.names.filter(function (n) { return typeof n === 'string' && !hasCJK(n); });
    fail('名字字典里有 ' + noCJK + ' / ' + T.names.length + ' 项不含中文：' +
         enList.slice(0, 5).map(function (s) { return JSON.stringify(s); }).join('、') +
         (enList.length > 5 ? ' …' : '') +
         '。要么是 definitionId 连接坏了（最可能），要么上游真出了英文名 —— ' +
         '后者请加进校验器里的 ALLOW_EN 并注明原因');
  }

  T.icons.forEach(function (s) {
    ck();
    // 图标名会直接拼进文件路径，必须是安全字符
    if (!/^[a-z0-9_]+$/.test(s)) fail('图标名不合规：' + s);
  });

  ck();
  if (T.types.join(',') !== 'single,choice,tiered,subtree') {
    warn('节点类型表变了：' + T.types.join(','));
  }

  // ---- 节点
  var nodeIds = Object.keys(T.nodes);
  ck();
  if (nodeIds.length < 2000) fail('只有 ' + nodeIds.length + ' 个节点，太少');

  var stat = { nodes: 0, entries: 0, choice: 0, tiered: 0, subtree: 0, maxX: 0, maxY: 0 };
  var seenEntry = {};
  nodeIds.forEach(function (id) {
    var n = T.nodes[id];
    stat.nodes++;
    ck();
    if (!Array.isArray(n) || n.length !== NODE_FORMAT.length) {
      fail('节点 ' + id + ' 的长度是 ' + (n && n.length) + '，应该是 ' + NODE_FORMAT.length);
      return;
    }
    var posX = n[0], posY = n[1], maxRanks = n[2], typeIdx = n[3],
        reqPoints = n[4], entries = n[5], subTreeId = n[6], requiresNode = n[7];

    ck();
    if (!(typeof posX === 'number' && posX > 0 && posX < X_MAX)) {
      fail('节点 ' + id + ' 的 posX 越界：' + posX);
    }
    ck();
    if (!(typeof posY === 'number' && posY > 0 && posY < Y_MAX)) {
      fail('节点 ' + id + ' 的 posY 越界：' + posY);
    }
    if (posX > stat.maxX) stat.maxX = posX;
    if (posY > stat.maxY) stat.maxY = posY;

    ck();
    if (!(typeIdx >= 0 && typeIdx < T.types.length)) {
      fail('节点 ' + id + ' 的 typeIdx 越界：' + typeIdx);
    }

    // maxRanks == 0 不是「缺数据」，而是子树入口节点的正常取值 ——
    // 那种节点代表「选哪一支英雄天赋」，本身不吃点数。本机实测取值分布
    // {0:40, 1:2593, 2:218, 4:40}，而 0 **恰好且仅**出现在 40 个 subtree 节点上。
    // 所以规则是「不是 subtree 就必须 >= 1」，而不是宽松的 >= 0 ——
    // 后者会让「某个普通节点的点数上限丢了」这种真故障静默通过。
    ck();
    var typeName0 = T.types[typeIdx];
    if (!(maxRanks >= 0 && maxRanks <= 10)) {
      fail('节点 ' + id + ' 的 maxRanks 不合理：' + maxRanks);
    } else if (typeName0 === 'subtree') {
      if (maxRanks !== 0) {
        fail('子树节点 ' + id + ' 的 maxRanks 应该是 0，实际 ' + maxRanks);
      }
    } else if (maxRanks < 1) {
      fail('节点 ' + id + '（' + typeName0 + '）的 maxRanks 是 ' + maxRanks +
           '，非子树节点必须至少 1');
    }
    ck();
    if (!(reqPoints >= 0 && reqPoints <= 40)) fail('节点 ' + id + ' 的 reqPoints 不合理：' + reqPoints);
    ck();
    if (subTreeId && !T.subTrees[subTreeId]) {
      fail('节点 ' + id + ' 指向不存在的子树 ' + subTreeId);
    }
    ck();
    if (requiresNode && !T.nodes[requiresNode]) {
      fail('节点 ' + id + ' 的 requiresNode ' + requiresNode + ' 不存在');
    }

    var tname = T.types[typeIdx];
    if (tname === 'choice') stat.choice++;
    if (tname === 'tiered') stat.tiered++;
    if (tname === 'subtree') stat.subtree++;

    ck();
    if (!Array.isArray(entries) || !entries.length) {
      fail('节点 ' + id + ' 没有任何条目');
      return;
    }
    ck();
    // choice 节点必须有两个以上选项，否则它不是 choice
    if (tname === 'choice' && entries.length < 2) {
      fail('节点 ' + id + ' 是 choice 但只有 ' + entries.length + ' 个条目');
    }

    entries.forEach(function (e) {
      stat.entries++;
      ck();
      if (!Array.isArray(e) || e.length !== ENTRY_FORMAT.length) {
        fail('节点 ' + id + ' 的条目长度是 ' + (e && e.length) +
             '，应该是 ' + ENTRY_FORMAT.length);
        return;
      }
      ck();
      if (!(typeof e[0] === 'number' && e[0] > 0)) fail('节点 ' + id + ' 的 entryId 不合理：' + e[0]);
      ck();
      if (!(e[1] >= 0 && e[1] < T.names.length)) {
        fail('节点 ' + id + ' 的 nameIdx 越界：' + e[1] + '（字典长 ' + T.names.length + '）');
      }
      ck();
      if (!(e[2] === -1 || (e[2] >= 0 && e[2] < T.icons.length))) {
        fail('节点 ' + id + ' 的 iconIdx 越界：' + e[2]);
      }
      ck();
      // 条目的 maxRanks 同样只在 subtree 条目上是 0（本机实测 80 个，正好是 40 个
      // subtree 节点 × 2 个英雄分支）。别处出 0 就是上游少了字段。
      if (tname === 'subtree') {
        if (e[4] !== 0) fail('节点 ' + id + ' 是 subtree，条目 maxRanks 应该是 0，实际 ' + e[4]);
      } else if (!(e[4] >= 1 && e[4] <= 10)) {
        fail('节点 ' + id + ' 的条目 maxRanks 不合理：' + e[4]);
      }
      ck();
      if (seenEntry[e[0]] && seenEntry[e[0]] !== id) {
        fail('entryId ' + e[0] + ' 同时属于节点 ' + seenEntry[e[0]] + ' 和 ' + id);
      }
      seenEntry[e[0]] = id;
    });
  });

  // ---- 子树
  Object.keys(T.subTrees).forEach(function (sid) {
    var s = T.subTrees[sid];
    ck();
    if (!Array.isArray(s) || s.length !== 3) {
      fail('子树 ' + sid + ' 的长度是 ' + (s && s.length) + '，应该是 3');
      return;
    }
    ck();
    if (!(s[0] >= 0 && s[0] < T.names.length)) fail('子树 ' + sid + ' 的名字下标越界：' + s[0]);
    ck();
    if (typeof s[1] !== 'string') fail('子树 ' + sid + ' 的 atlas 不是字符串');
    ck();
    if (!Array.isArray(s[2]) || !s[2].length) fail('子树 ' + sid + ' 没有节点列表');
    else s[2].forEach(function (nid) {
      ck();
      if (!T.nodes[nid]) fail('子树 ' + sid + ' 引用不存在的节点 ' + nid);
    });
  });

  // ---- 每个专精
  var sstat = { edges: 0, free: 0, refs: 0 };
  specIds.forEach(function (sid) {
    var sp = T.specs[sid];
    var where = '专精 ' + sid + '（' + (sp.cls || '?') + '/' + (sp.specEn || '?') + '）';
    checkFields(sp, SPEC_SCHEMA, where);

    ck();
    if (!/^\d+$/.test(sid)) fail('专精键不是数字：' + sid);

    // 本专精能看到的所有节点
    var own = {};
    ['classNodes', 'specNodes', 'heroNodes', 'subNodes'].forEach(function (k) {
      (sp[k] || []).forEach(function (nid) {
        sstat.refs++;
        ck();
        if (!T.nodes[nid]) { fail(where + ' 的 ' + k + ' 引用不存在的节点 ' + nid); return; }
        ck();
        if (own[nid]) fail(where + ' 的节点 ' + nid + ' 出现在两个分组里');
        own[nid] = k;
      });
    });

    ck();
    if ((sp.classNodes || []).length < 20) {
      fail(where + ' 只有 ' + sp.classNodes.length + ' 个职业节点，太少');
    }
    ck();
    if ((sp.specNodes || []).length < 20) {
      fail(where + ' 只有 ' + sp.specNodes.length + ' 个专精节点，太少');
    }
    ck();
    // 每个专精有两支英雄子树可选（当前版本），少了说明数据不全
    if ((sp.subTreeIds || []).length < 2) {
      warn(where + ' 只有 ' + sp.subTreeIds.length + ' 支英雄子树');
    }
    (sp.subTreeIds || []).forEach(function (st) {
      ck();
      if (!T.subTrees[st]) fail(where + ' 指向不存在的子树 ' + st);
    });

    // 连线：两端都必须在本专精内。这是画树最容易出错的地方 ——
    // 全局节点表里存在不代表本专精能看到。
    Object.keys(sp.edges || {}).forEach(function (from) {
      ck();
      if (!own[from]) fail(where + ' 的连线起点 ' + from + ' 不在本专精内');
      (sp.edges[from] || []).forEach(function (to) {
        sstat.edges++;
        ck();
        if (!own[to]) fail(where + ' 的连线 ' + from + '→' + to + ' 终点不在本专精内');
      });
    });

    (sp.free || []).forEach(function (nid) {
      sstat.free++;
      ck();
      if (!own[nid]) fail(where + ' 的白给节点 ' + nid + ' 不在本专精内');
    });

    sp._own = own;   // 给交叉验证用，最后删掉
  });

  return { stat: stat, sstat: sstat, specIds: specIds };
}

// ---------------------------------------------------------------- 交叉验证

// 用树去验 talent-data.js：每套天赋的 entryID 是否真的属于本专精。
// 这一条不是格式检查，是**内容检查** —— 它抓的是上游 WCL 的专精误标。
function crossCheck() {
  var D = loadGlobal(DATA_PATH, 'AE_TALENTS');
  if (!D || !T) return null;

  // 两种毛病要分开报，因为诊断完全不同：
  //   · 越界（dirty）  = entryID 在树里存在，但属于**别的专精**的树。
  //                      本机实测防战有 1 套是武器专精的天赋（WCL 把专精标错了）。
  //   · 查不到（missing）= entryID 在整份 raidbots 数据里都不存在。
  //                      可能是上游还没收录的新节点，也可能是坏记录。
  // 一开始我用一个临时脚本量，把这两类混成了「织雾 4 套越界」——
  // 其实织雾那 4 套不是跨专精污染，而是引用了一个 raidbots 没有的 entryID。
  var out = { specs: 0, builds: 0, dirty: 0, missing: 0,
              dirtySpecs: [], missSpecs: [], unknownIds: {} };

  Object.keys(D.specs).forEach(function (key) {
    var sd = D.specs[key];
    var sp = T.specs[String(sd.specId)];
    ck();
    if (!sp) {
      fail('talent-data.js 的 ' + key + ' specId=' + sd.specId + ' 在树里找不到');
      return;
    }
    out.specs++;

    // dict 是 1-based 的 entryID 表
    var dirtyBuilds = 0, missBuilds = 0;
    (sd.builds || []).forEach(function (b) {
      if (!b || !b.length) return;
      out.builds++;
      var bad = 0, miss = 0;
      b.forEach(function (pair) {
        var idx = Array.isArray(pair) ? pair[0] : pair;
        var entryId = sd.dict[idx - 1];
        if (!entryId) return;
        // entryId → 节点。用树里的反查。
        if (entryToNode[entryId] === undefined) {
          miss++; out.unknownIds[entryId] = 1; return;
        }
        if (!sp._own[entryToNode[entryId]]) bad++;
      });
      if (bad) { dirtyBuilds++; out.dirty++; }
      if (miss) { missBuilds++; out.missing++; }
    });
    if (dirtyBuilds) {
      out.dirtySpecs.push(key + ' ' + dirtyBuilds + '/' + (sd.builds || []).length);
    }
    if (missBuilds) {
      out.missSpecs.push(key + ' ' + missBuilds + '/' + (sd.builds || []).length);
    }
  });

  return out;
}

// entryId → nodeId 的反查表
var entryToNode = {};
if (T && T.nodes) {
  Object.keys(T.nodes).forEach(function (id) {
    var ents = T.nodes[id][5] || [];
    ents.forEach(function (e) { entryToNode[e[0]] = id; });
  });
}

// ---------------------------------------------------------------- 跑

var tr = verifyTree();
var cc = fs.existsSync(DATA_PATH) ? crossCheck() : null;

if (tr) {
  Object.keys(T.specs).forEach(function (sid) { delete T.specs[sid]._own; });
}

if (!QUIET) {
  if (tr) {
    console.log('树：专精 ' + tr.specIds.length + '，节点 ' + tr.stat.nodes +
                '，条目 ' + tr.stat.entries + '，连线 ' + tr.sstat.edges +
                '，白给节点 ' + tr.sstat.free);
    console.log('    节点引用 ' + tr.sstat.refs + '，choice ' + tr.stat.choice +
                '，tiered ' + tr.stat.tiered + '，subtree ' + tr.stat.subtree +
                '，坐标上限 ' + tr.stat.maxX + '×' + tr.stat.maxY);
    console.log('    字典：名字 ' + T.names.length + '，图标 ' + T.icons.length +
                '，子树 ' + Object.keys(T.subTrees).length);
  }
  if (cc) {
    console.log('交叉验证 talent-data.js：专精 ' + cc.specs + '，套路 ' + cc.builds +
                '，跨专精污染 ' + cc.dirty + ' 套，引用未知 entryID ' + cc.missing +
                ' 套（' + Object.keys(cc.unknownIds).length + ' 个 ID）');
    // 两种毛病的病因完全不同，混在一起报会误导：
    //   · 跨专精污染 = 这套天赋根本不是这个专精的（WCL 把专精标错了）
    //   · 未知 entryID = 树里没有这个节点（上游 talents.json 比插件旧，或那条记录是脏的）
    if (cc.dirtySpecs.length) {
      console.log('    跨专精污染：' + cc.dirtySpecs.join('，'));
    }
    if (cc.missSpecs.length) {
      console.log('    引用未知 entryID：' + cc.missSpecs.join('，'));
    }
  }
  warnings.forEach(function (w) { console.log('警告：' + w); });
}

if (errors.length) {
  console.error('\n天赋树校验失败，' + errors.length + ' 个问题：');
  errors.slice(0, 30).forEach(function (e) { console.error('  · ' + e); });
  if (errors.length > 30) console.error('  …还有 ' + (errors.length - 30) + ' 个');
  console.error('检查项 ' + checks);
  process.exit(1);
}

if (!QUIET) console.log('通过，检查项 ' + checks);

module.exports = { checks: checks, warnings: warnings.length, tree: tr, cross: cc };
