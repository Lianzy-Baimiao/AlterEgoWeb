/*
 * WowAltBoard - tools/fetch-talent-truth.js
 *
 * 造「天赋导入串 → 正确解」的判据文件 tools/talent-truth.json（要联网，只跑一次）。
 *
 * 为什么需要它：解码器写出来之后，我一直没有办法证明它对。往返测试（读 n 位写回
 * n 位）几乎测不出东西，语义检查只能证伪不能证实。真正缺的是**同一个生产者同时
 * 给出「串」和「这串的正确解」**。raider.io 的角色 profile 正好给：
 *   talentLoadout.loadout_text  → 官方导入串
 *   talentLoadout.loadout[]     → 它自己解出来的节点表（node.id / rank / entryIndex / grantedNode）
 *
 * 拿它比过之后，之前那五条「反面结论」的成因也清楚了：串没解错，是**串和天赋树
 * 版本不匹配**。同一批角色，赛季历史串干净 3/32，当前串干净 27/32，
 * 「历史脏→当前干净」24 人、反向 0 人。
 *
 * 存进文件的东西刻意精简：只有 specID + 串 + 节点真值。**不存角色名 / 服务器**
 * —— 判据要的是串和它的解，玩家身份不是判据的一部分。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var T = require('./decode-talent-string.js');

var ROOT = path.resolve(__dirname, '..');
var RAW = path.join(__dirname, '.rio-raw');
var OUT = path.join(__dirname, 'talent-truth.json');
var RUNS_URL = 'https://raider.io/api/v1/mythic-plus/runs'
  + '?season=season-tww-3&region=world&affixes=fortified&page=0';

function curl(url, file) {
  var r = cp.spawnSync('curl', ['-s', '--max-time', '40', '-o', file, url], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(file);
}

function main() {
  if (!fs.existsSync(RAW)) fs.mkdirSync(RAW, { recursive: true });
  var runsFile = path.join(RAW, 'runs.json');
  if (!fs.existsSync(runsFile) || process.argv.indexOf('--refresh') >= 0) {
    console.log('下载排行榜（为了拿到一批角色名）…');
    if (!curl(RUNS_URL, runsFile)) throw new Error('下载排行榜失败');
  }
  var runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'));

  // 收角色。排行榜里 realm/region 是**对象**（.slug），profile 里是**字符串** ——
  // 这个差别害我量出过一次 0/0 的假结论，所以这里只用排行榜那份的 slug。
  var chars = [], seen = {};
  runs.rankings.forEach(function (r) {
    (r.run.roster || []).forEach(function (m) {
      var c = m.character;
      var k = c.region.slug + '/' + c.realm.slug + '/' + c.name;
      if (seen[k]) return;
      seen[k] = 1;
      chars.push({ name: c.name, realm: c.realm.slug, region: c.region.slug });
    });
  });

  var want = Number(process.argv[2]) || 40;
  chars = chars.slice(0, want);
  console.log('准备取 ' + chars.length + ' 个角色的 profile（缓存命中的不重下）');

  var bySpec = T.loadOrder();
  var items = [], stat = { got: 0, clean: 0, exact: 0 };

  chars.forEach(function (c) {
    var f = path.join(RAW, 'prof-' + c.region + '-' + c.realm + '-'
      + Buffer.from(c.name).toString('hex') + '.json');
    if (!fs.existsSync(f)) {
      var url = 'https://raider.io/api/v1/characters/profile?region=' + c.region
        + '&realm=' + encodeURIComponent(c.realm)
        + '&name=' + encodeURIComponent(c.name) + '&fields=gear,talents';
      if (!curl(url, f)) return;
    }
    var p;
    try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
    var tl = p.talentLoadout;
    if (!tl || !tl.loadout_text || !Array.isArray(tl.loadout) || !tl.loadout.length) return;
    stat.got++;

    var d = T.decode(tl.loadout_text, bySpec);
    // 只收「干净」的。脏的那些是照旧版天赋树编的串，它们的真值对不上现在这棵树，
    // 当判据会把版本漂移误判成解码错误。
    if (!d.clean) return;
    stat.clean++;

    var truth = tl.loadout.map(function (e) {
      return [e.node.id, e.rank, e.entryIndex, e.grantedNode ? 1 : 0];
    }).sort(function (a, b) { return a[0] - b[0]; });

    items.push({ spec: d.spec, s: tl.loadout_text, n: truth });
  });

  var out = {
    v: 1,
    source: 'raider.io /api/v1/characters/profile?fields=talents 的 talentLoadout',
    note: '每项 = {spec, s: 导入串, n: [[节点id, rank, entryIndex, granted], …]}。'
      + '只收在当前 app/talent-tree.js 这棵树下语义干净的串。不含角色名/服务器。',
    fetchedAt: new Date().toISOString().slice(0, 10),
    treeUpdatedAt: (function () {
      try {
        var g = {}; g.window = g;
        new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'talent-tree.js'), 'utf8'))(g);
        return g.AE_TALENT_TREE ? g.AE_TALENT_TREE.updatedAt : null;
      } catch (e) { return null; }
    })(),
    items: items
  };
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  var kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('读到 profile ' + stat.got + ' 份，其中语义干净 ' + stat.clean + ' 份');
  console.log('写出 ' + path.relative(ROOT, OUT) + '（' + kb + ' KB，'
    + items.length + ' 条串，' + items.reduce(function (a, x) { return a + x.n.length; }, 0)
    + ' 个节点真值）');
  console.log('接着跑：node tools\\verify-talent-decode.js');
}

module.exports = { main: main };
if (require.main === module) main();
