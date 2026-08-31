/*
 * WowAltBoard - tools/fetch-talent-tree.js
 *
 * 产出 app/talent-tree.js（window.AE_TALENT_TREE）：40 个专精的天赋树**结构**
 * ——节点坐标、连线、点数上限、中文名、图标名。有了它，天赋页才能真的画出一棵树，
 * 而不是只列「谁点了哪些 entryID」。
 *
 * 为什么必须联网取
 * ----------------
 * 插件里存的天赋只有 `entryID + 点数`。树的结构（坐标 / 连线 / 名称 / 图标）在
 * 两个插件的所有文件里**都不存在** —— 插件是游戏内现场调 C_Traits 拿的，
 * 那些接口网页里没有。本机磁盘上也没有任何一份树结构表（全盘搜过）。
 *
 * 三个来源，本机实测（中国大陆）
 * ------------------------------
 *   · raidbots.com/static/data/live/talents.json      直连 200，3.2 MB。
 *     树结构（posX/posY/next/prev/maxRanks/entries/subTree），英文名。
 *   · wago.tools/db2/TraitDefinition/csv?locale=zhCN  直连 200，0.8 MB。
 *     definitionId → SpellID，以及少数节点的 OverrideName_lang。
 *   · wago.tools/db2/SpellName/csv?locale=zhCN        直连 200，10.0 MB。
 *     SpellID → 中文法术名。
 *
 * 三个都**不需要代理**。都是公开只读数据，不上传任何本机内容。
 *
 * 中文名不是我翻的
 * ----------------
 * 后两个源是暴雪自己的 DB2 表（wago.tools 只是把它导成 CSV），也就是游戏客户端
 * 里的同一份字符串。本机实测 3334 个 definitionId **100% 拿到中文名**
 * （6 个走 OverrideName_lang，3328 个走 SpellName）。
 * 这比插件 locale 更权威，所以「不许手写中文」这条规矩在这里是满足的。
 *
 * 缓存
 * ----
 *   tools/.talent-raw/     三个原始文件，14 MB，**不进仓库**（.gitignore）。
 *   tools/.talent-names.json  连接后的 definitionId → 中文名，**进仓库**。
 *
 * 分这两层是有意的：有了名字缓存，以后重新生成不必再下那 10 MB 的 SpellName，
 * 也不必联网。删掉 .talent-raw/ 随时可以重下。
 *
 * 用法
 * ----
 *   node tools\fetch-talent-tree.js            # 缺什么下什么，然后生成
 *   node tools\fetch-talent-tree.js --refresh  # 强制重下三个源
 *   node tools\fetch-talent-tree.js --offline  # 只用现有缓存，不联网
 *   node tools\fetch-talent-tree.js --proxy http://127.0.0.1:7897
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');

var ROOT = path.resolve(__dirname, '..');
var RAW_DIR = path.join(__dirname, '.talent-raw');
var NAME_CACHE = path.join(__dirname, '.talent-names.json');
var OUT_JS = path.join(ROOT, 'app', 'talent-tree.js');

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf(n) >= 0; }
function opt(n, d) { var i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }

var PROXY = opt('--proxy', '');
var REFRESH = flag('--refresh');
var OFFLINE = flag('--offline');

var SOURCES = [
  { file: 'talents.json',
    url: 'https://www.raidbots.com/static/data/live/talents.json' },
  { file: 'TraitDefinition.csv',
    url: 'https://wago.tools/db2/TraitDefinition/csv?locale=zhCN' },
  { file: 'SpellName.csv',
    url: 'https://wago.tools/db2/SpellName/csv?locale=zhCN' },
  // 英雄子树名（「艾露恩钦选者」那一层）。TraitDefinition 里没有它们 ——
  // subtree 类型的 entry 根本没有 definitionId，所以必须单独取这张表。
  { file: 'TraitSubTree.csv',
    url: 'https://wago.tools/db2/TraitSubTree/csv?locale=zhCN' }
];

// ------------------------------------------------------------------ 下载

function get(url, cb) {
  var u = new URL(url);
  var opts, mod;
  if (PROXY) {
    var p = new URL(PROXY);
    mod = p.protocol === 'https:' ? https : http;
    opts = {
      host: p.hostname, port: p.port || 80, path: url, method: 'GET',
      headers: { Host: u.hostname, 'User-Agent': 'WowAltBoard/1.0', Accept: '*/*' }
    };
  } else {
    mod = u.protocol === 'https:' ? https : http;
    opts = {
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'WowAltBoard/1.0', Accept: '*/*' }
    };
  }
  var req = mod.request(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(new URL(res.headers.location, url).href, cb);
    }
    var bufs = [];
    res.on('data', function (d) { bufs.push(d); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(bufs)); });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(120000, function () { req.destroy(new Error('超时')); });
  req.end();
}

function ensureSources(cb) {
  if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });
  var todo = SOURCES.filter(function (s) {
    return REFRESH || !fs.existsSync(path.join(RAW_DIR, s.file));
  });
  if (!todo.length) { console.log('三个源都已缓存在 tools/.talent-raw/'); return cb(null); }
  if (OFFLINE) {
    return cb(new Error('--offline 但缺少缓存：' +
      todo.map(function (s) { return s.file; }).join('、')));
  }
  var i = 0;
  (function next() {
    if (i >= todo.length) return cb(null);
    var s = todo[i++];
    process.stdout.write('  下载 ' + s.file + ' … ');
    get(s.url, function (err, code, buf) {
      if (err) return cb(new Error(s.file + ' 下载失败：' + err.message));
      if (code !== 200) return cb(new Error(s.file + ' HTTP ' + code));
      fs.writeFileSync(path.join(RAW_DIR, s.file), buf);
      console.log((buf.length / 1024).toFixed(1) + ' KB');
      next();
    });
  })();
}

// ------------------------------------------------------------------ CSV

// wago 的 CSV 是标准的 RFC4180（字段可带引号、引号内可有逗号和换行）。
// 只取需要的两三列，所以按行手写一个够用的解析器，不引依赖。
function parseCsv(text, wanted) {
  var rows = [];
  var head = null;
  var field = '';
  var row = [];
  var inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field); field = '';
      if (!head) head = row;
      else if (row.length > 1) {
        var o = {};
        for (var k = 0; k < wanted.length; k++) {
          var idx = head.indexOf(wanted[k]);
          o[wanted[k]] = idx >= 0 ? row[idx] : '';
        }
        rows.push(o);
      }
      row = [];
      continue;
    }
    field += c;
  }
  return rows;
}

// definitionId → 中文名。优先 OverrideName_lang，否则查 SpellName。
function buildNameMap() {
  if (!REFRESH && fs.existsSync(NAME_CACHE)) {
    var cached = JSON.parse(fs.readFileSync(NAME_CACHE, 'utf8'));
    console.log('中文名缓存 ' + Object.keys(cached.names || {}).length + ' 条（tools/.talent-names.json）');
    return cached;
  }
  console.log('  连接 TraitDefinition × SpellName …');
  var td = parseCsv(fs.readFileSync(path.join(RAW_DIR, 'TraitDefinition.csv'), 'utf8'),
    ['ID', 'SpellID', 'OverrideName_lang', 'OverrideIcon']);
  var sn = parseCsv(fs.readFileSync(path.join(RAW_DIR, 'SpellName.csv'), 'utf8'),
    ['ID', 'Name_lang']);
  var spell = {};
  sn.forEach(function (r) { if (r.Name_lang) spell[r.ID] = r.Name_lang; });

  var names = {};
  var from = { override: 0, spell: 0, miss: 0 };
  td.forEach(function (r) {
    var n = r.OverrideName_lang;
    if (n) { names[r.ID] = n; from.override++; return; }
    var s = spell[r.SpellID];
    if (s) { names[r.ID] = s; from.spell++; return; }
    from.miss++;
  });
  // 英雄子树名是另一张表。这 41 个名字不走 definitionId ——
  // subtree 类型的 entry 根本没有 definitionId（本机实测 80 个条目全都没有），
  // 所以必须按 TraitSubTree.ID 单独查。
  var st = parseCsv(fs.readFileSync(path.join(RAW_DIR, 'TraitSubTree.csv'), 'utf8'),
    ['ID', 'Name_lang']);
  var subs = {};
  st.forEach(function (r) { if (r.Name_lang) subs[r.ID] = r.Name_lang; });

  var out = { builtAt: new Date().toISOString().slice(0, 10), from: from,
              names: names, subs: subs };
  fs.writeFileSync(NAME_CACHE, JSON.stringify(out), 'utf8');
  console.log('  中文名 ' + Object.keys(names).length + ' 条（OverrideName ' + from.override +
              ' / SpellName ' + from.spell + ' / 查不到 ' + from.miss + '）');
  console.log('  英雄子树中文名 ' + Object.keys(subs).length + ' 条（TraitSubTree）');
  return out;
}

// ------------------------------------------------------------------ 生成

var NODE_TYPES = ['single', 'choice', 'tiered', 'subtree'];
var GROUPS = [
  ['classNodes', 'class'],
  ['specNodes', 'spec'],
  ['heroNodes', 'hero'],
  ['subTreeNodes', 'sub']
];

function build(raw, nameMap) {
  var names = [];      // 名字字典
  var nameIdx = {};
  var icons = [];      // 图标名字典
  var iconIdx = {};
  function internName(s) {
    if (!s) return -1;
    if (!(s in nameIdx)) { nameIdx[s] = names.length; names.push(s); }
    return nameIdx[s];
  }
  function internIcon(s) {
    if (!s) return -1;
    // 上游有个别图标名带扩展名（本机实测只有 ability_druid_mangle.tga 一个，被 4 个
    // 条目引用）。图标名后面要拼成 <名>.jpg 的 URL，带着 .tga 会拼出取不到的地址，
    // 所以在这里剥掉。不放宽 ^[a-z0-9_]+$ 的断言 —— 那条断言正是发现这个的原因。
    var m = /^(.*)\.(tga|blp|png|jpg)$/i.exec(s);
    if (m) { s = m[1]; stat.iconExt++; }
    s = s.toLowerCase();
    if (!(s in iconIdx)) { iconIdx[s] = icons.length; icons.push(s); }
    return iconIdx[s];
  }

  var nodes = {};        // nodeID → 节点数组
  var subTrees = {};     // subTreeId → [中文名下标, atlas, [nodeID…], 英文名]
  var specs = {};
  // 职业名 → 导入串里节点的**排列顺序**（raidbots 的 fullNodeOrder）。
  //
  // 为什么必须带上：官方天赋导入串是一串**没有 nodeID 的位流** —— 第 n 个节点是谁，
  // 完全由这张顺序表决定。少了它，串只能解出串头（版本 + specID + treeHash），
  // 后面的位一个都对不上。
  //
  // 为什么按**职业**存而不是按专精：实测 13 个职业内部各专精的 fullNodeOrder
  // **完全一致，0 分歧**，按职业存 2896 个 id（18.2 KB），按专精存 8970 个（3.1 倍）。
  // 下面那条守卫盯着这个前提：真出现分歧就直接报错，而不是随便留一份。
  var nodeOrder = {};
  var stat = {
    specs: 0, nodeRefs: 0, distinctNodes: 0, entries: 0,
    zh: 0, en: 0, noEntryId: 0, dropped: 0, conflicts: 0, edges: 0,
    iconExt: 0, orderIds: 0
  };

  raw.forEach(function (t) {
    stat.specs++;
    var spec = {
      treeId: t.traitTreeId,
      cls: t.className,
      specEn: t.specName,
      classNodes: [], specNodes: [], heroNodes: [], subNodes: [],
      subTreeIds: [],
      // 连线和「免费节点」是**按专精**不同的，不能进全局节点表 —— 见下面的注释。
      edges: {}, free: []
    };
    var keyFor = { class: 'classNodes', spec: 'specNodes', hero: 'heroNodes', sub: 'subNodes' };

    // 顺序表：同职业各专精必须给出一模一样的一份。
    var ord = t.fullNodeOrder || [];
    if (!ord.length) throw new Error(t.className + '/' + t.specName + ' 没有 fullNodeOrder');
    if (!nodeOrder[t.className]) {
      nodeOrder[t.className] = ord.slice();
    } else if (nodeOrder[t.className].join(',') !== ord.join(',')) {
      throw new Error(t.className + ' 各专精的 fullNodeOrder 不一致（' + t.specName
        + ' 和先前的专精对不上）—— 顺序表不能按职业存一份了，得改成按专精存');
    }

    GROUPS.forEach(function (g) {
      var arr = t[g[0]] || [];
      arr.forEach(function (n) {
        stat.nodeRefs++;

        // entries 里有 10 个是空对象 {}（未上线的占位节点，本机实测）。
        // 全空的节点画出来是个无名圆圈，直接丢掉。
        var ents = (n.entries || []).filter(function (e) { return e && e.id; });
        if (!ents.length) { stat.dropped++; return; }

        var rowEnts = ents.map(function (e) {
          stat.entries++;
          // 英雄子树入口那 80 个 entry 没有 definitionId（本机实测），
          // 它们的名字在 TraitSubTree 里，键是 traitSubTreeId。
          var zh = e.traitSubTreeId
            ? nameMap.subs[String(e.traitSubTreeId)]
            : nameMap.names[String(e.definitionId)];
          if (zh) stat.zh++; else stat.en++;
          return [
            e.id,
            internName(zh || e.name || ''),
            internIcon(e.icon || ''),
            e.spellId || 0,
            e.maxRanks || 0
          ];
        });

        var row = [
          n.posX, n.posY,
          n.maxRanks || 0,
          NODE_TYPES.indexOf(n.type),
          n.reqPoints || 0,
          rowEnts,
          n.subTreeId || 0,
          n.requiresNode || 0
        ];

        // 连线 / 免费节点按专精存。
        //
        // 一开始我把 next 和 freeNode 也放进全局节点表，理由是「同职业的专精共享职业树」。
        // 生成时的一致性守卫立刻否掉了这个想法：**133 个共享节点的字段不一致**，
        // 差的正是 next(55) / prev(90) / freeNode(30)。例如同一个法师职业节点，
        // 奥法连到 108664、火法连到 108656、冰法连到 108655 —— 那是三个按专精门控的
        // 变体节点。freeNode 同理：鲜血死骑有个职业节点是免费的，冰霜/邪恶不是。
        // 所以：静态字段（坐标 / 上限 / 类型 / 条目 / 前置）全局共享一份，
        // 拓扑（连线 / 免费）按专精各存一份。
        if ((n.next || []).length) spec.edges[n.id] = (n.next || []).slice();
        if (n.freeNode) spec.free.push(n.id);

        // 同一个节点会出现在同职业的多个专精里。静态字段实测完全一致，
        // 所以全局只存一份 —— 但要真的验一遍，不然「实测一致」会变成假设。
        var prev = nodes[n.id];
        if (prev) {
          if (JSON.stringify(prev) !== JSON.stringify(row)) {
            stat.conflicts++;
            if (stat.conflicts <= 5) {
              console.error('  节点 ' + n.id + ' 在不同专精里字段不一致：' +
                            t.className + '/' + t.specName);
            }
          }
        } else {
          nodes[n.id] = row;
          stat.distinctNodes++;
        }
        spec[keyFor[g[1]]].push(n.id);

        // 英雄子树：subtree 类型的节点里带着「这一支包含哪些节点」
        if (n.type === 'subtree') {
          ents.forEach(function (e) {
            if (!e.traitSubTreeId) return;
            if (!subTrees[e.traitSubTreeId]) {
              // 第 4 个字段是英文名。留着是因为 app/talent-data.js 里的英雄天赋只有
              // 英文名（那份数据来自插件，插件存的就是英文），面板得靠「英文名 →
              // 子树」这一跳才能显示成中文。本机实测 39/39 对得上。
              subTrees[e.traitSubTreeId] = [
                internName(nameMap.subs[String(e.traitSubTreeId)] || e.name || ''),
                e.atlasMemberName || '',
                (e.nodes || []).slice(),
                e.name || ''
              ];
            }
            if (spec.subTreeIds.indexOf(e.traitSubTreeId) < 0) {
              spec.subTreeIds.push(e.traitSubTreeId);
            }
          });
        }
      });
    });

    specs[t.specId] = spec;
  });

  // 连线完整性：next 指向的节点必须存在（丢掉占位节点后重新验一遍）。
  // 顺便清掉指向被丢弃占位节点的边 —— 留着的话画线时会指向空气。
  var dangling = 0;
  Object.keys(specs).forEach(function (sid) {
    var e = specs[sid].edges;
    Object.keys(e).forEach(function (id) {
      var nx = e[id];
      for (var i = nx.length - 1; i >= 0; i--) {
        stat.edges++;
        if (!nodes[nx[i]]) { nx.splice(i, 1); dangling++; }
      }
      if (!nx.length) delete e[id];
    });
  });
  stat.dangling = dangling;

  Object.keys(nodeOrder).forEach(function (c) { stat.orderIds += nodeOrder[c].length; });

  return { names: names, icons: icons, nodes: nodes, subTrees: subTrees,
           specs: specs, nodeOrder: nodeOrder, stat: stat };
}

// ------------------------------------------------------------------ 写文件

function writeJs(b, nameMap) {
  var meta = {
    v: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'raidbots talents.json（树结构） + 暴雪 DB2 TraitDefinition/SpellName zhCN（中文名）',
    nodeFormat: '[posX, posY, maxRanks, typeIdx, reqPoints, entries[], subTreeId, requiresNode]',
    entryFormat: '[entryId, nameIdx, iconIdx, spellId, maxRanks]',
    types: NODE_TYPES
  };
  var out = [];
  out.push('/* 由 tools/fetch-talent-tree.js 生成，不要手改。');
  out.push(' * 来源：' + meta.source);
  out.push(' * 节点：' + meta.nodeFormat);
  out.push(' * 条目：' + meta.entryFormat);
  out.push(' */');
  out.push('window.AE_TALENT_TREE = {');
  out.push('v:' + meta.v + ',');
  out.push('updatedAt:' + JSON.stringify(meta.updatedAt) + ',');
  out.push('source:' + JSON.stringify(meta.source) + ',');
  out.push('nodeFormat:' + JSON.stringify(meta.nodeFormat) + ',');
  out.push('entryFormat:' + JSON.stringify(meta.entryFormat) + ',');
  out.push('types:' + JSON.stringify(meta.types) + ',');
  out.push('names:' + JSON.stringify(b.names) + ',');
  out.push('icons:' + JSON.stringify(b.icons) + ',');
  out.push('subTrees:' + JSON.stringify(b.subTrees) + ',');
  out.push('nodes:' + JSON.stringify(b.nodes) + ',');
  out.push('nodeOrder:' + JSON.stringify(b.nodeOrder) + ',');
  out.push('specs:' + JSON.stringify(b.specs));
  out.push('};');
  var src = out.join('\n') + '\n';
  fs.writeFileSync(OUT_JS, src, 'utf8');
  return Buffer.byteLength(src, 'utf8');
}

// ------------------------------------------------------------------ 主流程

ensureSources(function (err) {
  if (err) { console.error('错误：' + err.message); process.exit(1); }

  var nameMap = buildNameMap();
  if (!nameMap.names || !Object.keys(nameMap.names).length) {
    console.error('错误：中文名表是空的，拒绝生成一份全英文的树。');
    process.exit(1);
  }

  var raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'talents.json'), 'utf8'));
  if (!Array.isArray(raw) || raw.length < 30) {
    console.error('错误：talents.json 结构不对（不是数组或专精数 < 30）');
    process.exit(1);
  }

  var b = build(raw, nameMap);
  var s = b.stat;

  if (s.conflicts) {
    console.error('错误：' + s.conflicts + ' 个节点在不同专精里字段不一致，' +
                  '全局去重的前提不成立，拒绝生成。');
    process.exit(1);
  }

  var zhPct = s.entries ? (s.zh / s.entries * 100) : 0;
  var bytes = writeJs(b, nameMap);

  console.log('');
  // 两个数的口径不一样，对不上不等于出错：
  //   节点引用 / 条目引用 = 按「专精 × 节点」数，同职业共享的节点会被数多次
  //   去重          = 全局节点表里实际存了多少条
  // 本机实测 4613 引用 → 2891 节点，5387 条目引用 → 3414 个不同 entryID。
  console.log('专精 ' + s.specs + '，节点引用 ' + s.nodeRefs +
              ' → 去重 ' + s.distinctNodes + '，条目引用 ' + s.entries);
  console.log('中文名 ' + s.zh + ' / ' + s.entries + ' 条目引用 = ' + zhPct.toFixed(1) +
              '%（剩下 ' + s.en + ' 个留英文）');
  console.log('英雄子树 ' + Object.keys(b.subTrees).length +
              '，名字字典 ' + b.names.length + '，图标字典 ' + b.icons.length);
  console.log('丢掉的占位节点 ' + s.dropped + '，清掉的悬空连线 ' + s.dangling +
              '，连线总数 ' + s.edges +
              '，剥掉扩展名的图标 ' + s.iconExt);
  console.log('节点顺序表 ' + Object.keys(b.nodeOrder).length + ' 个职业，共 ' +
              Object.keys(b.nodeOrder).reduce(function (a, k) {
                return a + b.nodeOrder[k].length; }, 0) + ' 个 id' +
              '（解导入串要用它，同职业各专精一致已在生成时校验）');
  console.log('app/talent-tree.js  ' + (bytes / 1024).toFixed(1) + ' KB（' + bytes + ' 字节）');

  // 中文名覆盖率是这份数据的核心价值。低了就是join 出了问题，不能默默通过。
  if (zhPct < 95) {
    console.error('错误：中文名覆盖率只有 ' + zhPct.toFixed(1) + '%，低于 95%，' +
                  '八成是 definitionId 对不上。请检查 TraitDefinition.csv。');
    process.exit(1);
  }
});
