/*
 * WowAltBoard - app/bis-tests.js
 *
 * 毕业装备 / 天赋数据的回归测试。
 *
 * 单独一套（不塞进 model-tests.js）的原因：这些测的是随包发布的静态数据
 * app/bis-data.js，跟有没有扫到角色无关 —— model-tests.js 没有 data/data.js
 * 就整套跳过，那样这些检查在新机器上永远不会跑。
 *
 * 这里守的是「看起来完全正常、其实是错的」那一类错误：
 *   · 部位表里的来源下标越界 —— 界面上只会显示成空白来源，不会报错；
 *   · 装备池里少了某个 itemId —— 那一行显示成 undefined；
 *   · 天赋差异编码还原错 —— 显示出一套谁都没用过的天赋，而且无从察觉。
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;

  AE.runBisTests = function () {
    var results = [], pass = 0, fail = 0;

    function t(name, fn) {
      var ok = false, detail = '';
      try {
        var v = fn();
        if (v === true) ok = true; else detail = String(v);
      } catch (e) {
        detail = 'threw: ' + String(e.message).split('\n')[0];
      }
      if (ok) pass++; else fail++;
      results.push({ name: name, ok: ok, detail: detail });
    }

    /** 把 40 专精 × 两套视角 × 每个部位的每一行都走一遍。fn(row, where)。 */
    function eachRow(B, fn) {
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          var slots = B.specs[key][view] || {};
          Object.keys(slots).forEach(function (slot) {
            slots[slot].forEach(function (row) {
              fn(row, key + '/' + view + '/' + slot);
            });
          });
        });
      });
    }

    var B = global.AE_BIS;
    if (!B) {
      return { pass: 0, fail: 0, skipped: true, results: [] };
    }

    // ------------------------------------------------------------ 数据完整性

    t('40 个专精都在，13 个职业都有', function () {
      var keys = Object.keys(B.specs);
      if (keys.length !== 40) return '专精数 ' + keys.length;
      var cls = {};
      keys.forEach(function (k) { cls[B.specs[k].cls] = 1; });
      var n = Object.keys(cls).length;
      return n === 13 || '职业数 ' + n;
    });

    t('每个部位条目的 itemId 都能在装备池里查到', function () {
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          var slots = B.specs[key][view] || {};
          Object.keys(slots).forEach(function (slot) {
            slots[slot].forEach(function (row) {
              if (!B.items[row[0]]) bad.push(key + '/' + view + '/' + slot + ' → ' + row[0]);
            });
          });
        });
      });
      return bad.length === 0 || bad.length + ' 个查不到，例如 ' + bad[0];
    });

    t('每个部位条目的来源下标都在 srcs 表范围内', function () {
      // 第一版生成器把来源下标写在了第 3 列（那是使用率），界面上会显示成
      // 空白来源 —— 不报错、也不明显，正是这条测试要拦的东西。
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          var slots = B.specs[key][view] || {};
          Object.keys(slots).forEach(function (slot) {
            slots[slot].forEach(function (row) {
              var si = row[3];
              if (typeof si !== 'number' || !B.srcs[si]) {
                bad.push(key + '/' + view + '/' + slot + ' → ' + si);
              }
            });
          });
        });
      });
      return bad.length === 0 || bad.length + ' 个越界，例如 ' + bad[0];
    });

    t('使用率是 0~100 的数，不是别的列串位了', function () {
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          var slots = B.specs[key][view] || {};
          Object.keys(slots).forEach(function (slot) {
            slots[slot].forEach(function (row) {
              var u = row[2];
              if (typeof u !== 'number' || u < 0 || u > 100) {
                bad.push(key + '/' + view + '/' + slot + ' → ' + u);
              }
            });
          });
        });
      });
      return bad.length === 0 || bad.length + ' 个不合法，例如 ' + bad[0];
    });

    t('装等是三位数，不会和使用率串位', function () {
      // ilvl 和 usagePct 都是数字，串位以后界面照样能显示 —— 只有范围能分辨。
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          var slots = B.specs[key][view] || {};
          Object.keys(slots).forEach(function (slot) {
            slots[slot].forEach(function (row) {
              if (!(row[1] >= 100 && row[1] <= 900)) {
                bad.push(key + '/' + view + '/' + slot + ' → ' + row[1]);
              }
            });
          });
        });
      });
      return bad.length === 0 || bad.length + ' 个可疑，例如 ' + bad[0];
    });

    t('装备池里每件都有名字', function () {
      var bad = Object.keys(B.items).filter(function (id) {
        return !B.items[id].n;
      });
      return bad.length === 0 || bad.length + ' 件没名字，例如 ' + bad[0];
    });

    t('部位号都是游戏的装备槽号，没有 4（衬衣）', function () {
      var seen = {};
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          Object.keys(B.specs[key][view] || {}).forEach(function (s) { seen[s] = 1; });
        });
      });
      var ids = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
      if (ids.indexOf(4) >= 0) return '出现了 4';
      var bad = ids.filter(function (i) { return i < 1 || i > 17; });
      return bad.length === 0 || '范围外: ' + bad.join(',');
    });

    t('部位中文名覆盖了数据里出现的每个部位号', function () {
      // slotNames 是生成时从 GearInsight 的 zhCN.lua 抄的，不是手写的。
      var missing = [];
      Object.keys(B.specs).forEach(function (key) {
        ['raid', 'mplus'].forEach(function (view) {
          Object.keys(B.specs[key][view] || {}).forEach(function (s) {
            if (!B.slotNames[s] && missing.indexOf(s) < 0) missing.push(s);
          });
        });
      });
      return missing.length === 0 || '缺: ' + missing.join(',');
    });

    t('部位名和属性名都是中文', function () {
      if (!L || !L.hasCJK) return 'labels.js 没加载，跳过';
      var bad = [];
      Object.keys(B.slotNames).forEach(function (k) {
        if (!L.hasCJK(B.slotNames[k])) bad.push('slot ' + k + '=' + B.slotNames[k]);
      });
      ['crit', 'haste', 'mastery', 'versatility'].forEach(function (k) {
        if (!L.hasCJK(B.statNames[k] || '')) bad.push('stat ' + k + '=' + B.statNames[k]);
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('每个专精都有毕业装等和属性权重', function () {
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        var s = B.specs[key];
        if (!(s.ilvl > 0)) bad.push(key + ' 无毕业装等');
        if (!s.weights || !Object.keys(s.weights).length) bad.push(key + ' 无属性权重');
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('目标属性百分比加起来接近 100', function () {
      // 四条副属性占比，和应该约等于 100。差太多说明取错了字段。
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        var tg = B.specs[key].target || {};
        Object.keys(tg).forEach(function (which) {
          var o = tg[which];
          if (!o || !Object.keys(o).length) return;
          var sum = 0;
          Object.keys(o).forEach(function (k) { sum += o[k]; });
          if (sum < 90 || sum > 110) bad.push(key + '/' + which + ' = ' + sum.toFixed(1));
        });
      });
      return bad.length === 0 || bad.length + ' 个偏离，例如 ' + bad[0];
    });

    // -------------------------------------------------------- 职业 / 专精名

    t('职业标签：13 个职业全部给中文名', function () {
      if (!L || !L.classLabel) return 'labels.js 没加载，跳过';
      // 以前这一条只查 9 个 —— 另外 4 个（唤魔师/法师/武僧/潜行者）本机存档里
      // 没有可核对的中文名，只能退回英文 token。现在 app/class-names.js 从暴雪
      // DB2 取到了全部 13 个，所以断言收紧成「一个英文都不许剩」。
      var bad = Object.keys(L.classColors).filter(function (c) {
        return !L.hasCJK(L.classLabel(c));
      });
      return bad.length === 0 || '还在显示英文: ' + bad.join(',');
    });

    t('职业标签：DB2 那份和存档收来的 9 个逐字一致', function () {
      if (!L || !L.classLabel || !global.AE_DB2_NAMES) return 'DB2 名字表没加载';
      // 两个独立的暴雪来源：L.classZh 是从运行中的客户端存档里收来的，
      // AE_DB2_NAMES.cls 是 DB2 导出的。它们必须一致 —— 不一致说明有一边
      // 不是我以为的那份数据，那时候「显示的是中文」反而更危险。
      var bad = [];
      Object.keys(L.classZh).forEach(function (k) {
        var db2 = global.AE_DB2_NAMES.cls[k];
        if (db2 && db2 !== L.classZh[k]) bad.push(k + '：DB2「' + db2 + '」≠ 存档「' + L.classZh[k] + '」');
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('职业标签：13 个职业互不重名', function () {
      if (!L || !L.classLabel) return 'labels.js 没加载，跳过';
      var seen = {}, dup = [];
      Object.keys(L.classColors).forEach(function (c) {
        var v = L.classLabel(c);
        if (seen[v]) dup.push(v);
        seen[v] = 1;
      });
      return dup.length === 0 || '重名: ' + dup.join(',');
    });

    t('专精标签：同一个职业内部不重名', function () {
      // GearInsight 的 specRawToCN 是「只按专精名」建的，DK 的 FROST 和法师的
      // FROST 共用一个中文名。真出现同职业重名就说明覆盖表没兜住。
      var bad = [];
      var byCls = {};
      Object.keys(B.specs).forEach(function (key) {
        var s = B.specs[key];
        var label = (L && L.specLabel) ? L.specLabel(s.specId, s.specCn, null, s.spec) : s.specCn;
        byCls[s.cls] = byCls[s.cls] || {};
        if (byCls[s.cls][label]) bad.push(s.cls + ' 里两个「' + label + '」');
        byCls[s.cls][label] = 1;
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('专精标签：每个都非空', function () {
      var bad = [];
      Object.keys(B.specs).forEach(function (key) {
        var s = B.specs[key];
        var label = (L && L.specLabel) ? L.specLabel(s.specId, s.specCn, null, s.spec) : s.specCn;
        if (!label) bad.push(key);
      });
      return bad.length === 0 || bad.join(', ');
    });

    t('死骑的冰霜专精显示「冰霜」，不是「冰法」', function () {
      // GearInsight 自己的表里 DEATHKNIGHT/FROST = 「冰法」。中文客户端里
      // 死骑不可能叫冰法 —— 那是法师的专精名，两边撞在同一个 key 上了。
      // 以前只能断言「不等于冰法」（退回英文 FROST 也算过）；现在 DB2 按 specID
      // 给出了正确答案，所以断言的是**正确的那个名字**。
      if (!L || !L.specLabel) return 'labels.js 没加载，跳过';
      var s = null;
      Object.keys(B.specs).forEach(function (k) {
        if (B.specs[k].cls === 'DEATHKNIGHT' && B.specs[k].spec === 'FROST') s = B.specs[k];
      });
      if (!s) return '找不到 DEATHKNIGHT/FROST';
      var label = L.specLabel(s.specId, s.specCn, null, s.spec);
      return label === '冰霜' || '显示的是「' + label + '」，应该是「冰霜」';
    });

    t('专精标签：40 个专精全是中文名', function () {
      // 以前 DISCIPLINE / PRESERVATION 没有中文名，只能显示英文。
      // DB2 按 specID 建表之后一个都不该剩。
      if (!L || !L.specLabel) return 'labels.js 没加载，跳过';
      var bad = [];
      Object.keys(B.specs).forEach(function (k) {
        var s = B.specs[k];
        var v = L.specLabel(s.specId, s.specCn, null, s.spec);
        if (!L.hasCJK(v)) bad.push(s.cls + '/' + s.spec + ' → ' + v);
      });
      return bad.length === 0 || '还在显示英文: ' + bad.join('，');
    });

    // ------------------------------------------------------------ 天赋编码

    t('天赋差异编码：还原一套手工造的数据', function () {
      if (!AE.decodeTalentBuild) return 'bis.js 没加载，跳过';
      // dict 是 1 基下标；rank 0 表示「基准点了但这套没点」。
      var td = {
        dict: [1001, 1002, 1003, 1004],
        base: [1, 1, 2, 2, 3, 1],          // dict[0]=1点, dict[1]=2点, dict[2]=1点
        builds: [
          [],                              // 第 0 套 = 基准本身
          [2, 1],                          // 把 dict[1] 改成 1 点
          [3, 0],                          // 去掉 dict[2]
          [4, 2]                           // 加上 dict[3] 2 点
        ]
      };
      var b0 = AE.decodeTalentBuild(td, 0);
      if (b0[1001] !== 1 || b0[1002] !== 2 || b0[1003] !== 1) return '基准还原错: ' + JSON.stringify(b0);
      if (Object.keys(b0).length !== 3) return '基准多出了条目: ' + JSON.stringify(b0);

      var b1 = AE.decodeTalentBuild(td, 1);
      if (b1[1002] !== 1) return '改点数没生效: ' + JSON.stringify(b1);

      var b2 = AE.decodeTalentBuild(td, 2);
      if (b2[1003] !== undefined) return 'rank 0 没有删掉条目: ' + JSON.stringify(b2);
      if (b2[1001] !== 1) return '删除影响到了别的条目';

      var b3 = AE.decodeTalentBuild(td, 3);
      return b3[1004] === 2 || '新增条目没生效: ' + JSON.stringify(b3);
    });

    t('天赋差异编码：dict 下标是 1 基，不是 0 基', function () {
      if (!AE.decodeTalentBuild) return 'bis.js 没加载，跳过';
      // 差一位的话每个天赋都会指向邻居 —— 界面照样显示，但全是错的。
      var td = { dict: [7777, 8888], base: [1, 1], builds: [[]] };
      var b = AE.decodeTalentBuild(td, 0);
      if (b[7777] !== 1) return '下标 1 没有映射到 dict 的第一个元素: ' + JSON.stringify(b);
      return b[8888] === undefined || '多映射了一个';
    });

    // 真数据（按需加载，可能还没载入）
    t('天赋真数据：每套的总点数落在合理范围', function () {
      var T = global.AE_TALENTS;
      if (!T) return '天赋数据未加载，跳过';
      if (!AE.decodeTalentBuild) return 'bis.js 没加载，跳过';
      var bad = [];
      Object.keys(T.specs).forEach(function (key) {
        var td = T.specs[key];
        for (var i = 0; i < td.builds.length; i++) {
          var b = AE.decodeTalentBuild(td, i);
          var n = 0;
          Object.keys(b).forEach(function (k) { n += b[k]; });
          // 满级天赋总点数在 80 上下；生成时实测 84~86。
          if (n < 60 || n > 120) bad.push(key + '#' + i + ' = ' + n);
        }
      });
      return bad.length === 0 || bad.length + ' 套异常，例如 ' + bad[0];
    });

    t('天赋真数据：每个 dict 下标都在 dict 范围内', function () {
      // 这一条是被自己抓出来的：我故意把某套改成 [9999, 3]（一个不存在的 dict
      // 下标）来检验测试有没有用，结果「总点数」那条毫无反应 —— 因为 decode 会
      // 把查不到的下标悄悄丢掉，点数反而没变。越界下标必须自己被查。
      var T = global.AE_TALENTS;
      if (!T) return '天赋数据未加载，跳过';
      var bad = [];
      Object.keys(T.specs).forEach(function (key) {
        var td = T.specs[key];
        var n = td.dict.length;
        function check(flat, where) {
          for (var i = 0; i < flat.length; i += 2) {
            var idx = flat[i];
            if (!(idx >= 1 && idx <= n)) bad.push(key + ' ' + where + ' 下标 ' + idx + '（dict 长 ' + n + '）');
          }
        }
        check(td.base, 'base');
        for (var i = 0; i < td.builds.length; i++) check(td.builds[i], '#' + i);
      });
      return bad.length === 0 || bad.length + ' 处越界，例如 ' + bad[0];
    });

    t('天赋真数据：玩家记录引用的 build 下标都存在', function () {
      var T = global.AE_TALENTS;
      if (!T) return '天赋数据未加载，跳过';
      var bad = [];
      Object.keys(T.specs).forEach(function (key) {
        var td = T.specs[key];
        ['raid', 'mplusHigh', 'mplusFarm'].forEach(function (cat) {
          (td.content[cat] || []).forEach(function (enc) {
            (enc.p || []).forEach(function (p) {
              if (!td.builds[p[0]]) bad.push(key + '/' + cat + ' → ' + p[0]);
              if (T.servers[p[3]] === undefined) bad.push(key + '/' + cat + ' 服务器下标 ' + p[3]);
              if (T.heroes[p[1]] === undefined) bad.push(key + '/' + cat + ' 英雄天赋下标 ' + p[1]);
            });
          });
        });
      });
      return bad.length === 0 || bad.length + ' 处越界，例如 ' + bad[0];
    });

    // ------------------------------------------------------------ 图标数据
    // app/item-icons.js 是 tools\fetch-icons.js 生成的：itemId -> 图标名、
    // itemId -> 品质。两样都不在 GearInsight 的 BisData 里。
    // 图片文件本身在不了浏览器里查，那部分由 Node 侧的渲染 harness 断言。

    t('图标数据：装备表里每个 itemId 都有图标名', function () {
      var B = global.AE_BIS, IC = global.AE_ITEM_ICONS;
      if (!B || !IC) return '图标数据未加载，跳过';
      var miss = Object.keys(B.items).filter(function (id) { return !IC[id]; });
      return miss.length === 0 ||
        miss.length + '/' + Object.keys(B.items).length + ' 件没有图标名，例如 ' + miss[0];
    });

    t('图标数据：宝石、附魔卷轴、消耗品也都有图标名', function () {
      var B = global.AE_BIS, IC = global.AE_ITEM_ICONS;
      if (!B || !IC) return '图标数据未加载，跳过';
      var need = {};
      Object.keys(B.specs).forEach(function (key) {
        var s = B.specs[key];
        (s.gems || []).forEach(function (r) { if (r[0]) need[r[0]] = '宝石'; });
        Object.keys(s.ench || {}).forEach(function (slot) {
          (s.ench[slot] || []).forEach(function (r) { if (r[3]) need[r[3]] = '附魔卷轴'; });
        });
      });
      (B.consumables || []).forEach(function (c) { if (c.id) need[c.id] = '消耗品'; });
      var miss = Object.keys(need).filter(function (id) { return !IC[id]; });
      return miss.length === 0 ||
        miss.length + ' 个没有图标名，例如 ' + need[miss[0]] + ' ' + miss[0];
    });

    t('图标数据：图标名只含小写字母数字下划线', function () {
      var IC = global.AE_ITEM_ICONS;
      if (!IC) return '图标数据未加载，跳过';
      // 图标名会直接拼进 URL。出现斜杠、点、大写或中文都说明取错了字段，
      // 而且拼出来的地址还可能跑到 app/icons/ 外面去。
      var bad = Object.keys(IC).filter(function (id) {
        return !/^[a-z0-9_]+$/.test(IC[id]);
      });
      return bad.length === 0 ||
        bad.length + ' 个图标名不合法，例如 ' + IC[bad[0]];
    });

    t('图标数据：品质表覆盖所有装备，且取值在 0..7', function () {
      var B = global.AE_BIS, Q = global.AE_ITEM_QUALITY;
      if (!B || !Q) return '图标数据未加载，跳过';
      var miss = [], bad = [];
      Object.keys(B.items).forEach(function (id) {
        var q = Q[id];
        if (q == null) { miss.push(id); return; }
        if (typeof q !== 'number' || q < 0 || q > 7) bad.push(id + '=' + q);
      });
      if (miss.length) return miss.length + ' 件没有品质，例如 ' + miss[0];
      return bad.length === 0 || '品质越界：' + bad.slice(0, 3).join(', ');
    });

    // ------------------------------------------------------------ 升级轨道
    // 行的第 6 位是轨道码 = (轨道下标+1)*10 + 升级等级，由 tools\gen-bis.js 从
    // BisData 的 bonusIDs 解出来。轨道名是从两处 shipped zhCN locale 抄的。

    t('升级轨道：轨道表结构正确（英文名 / 中文名 / 赛季号）', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      if (!B.tracks || !B.tracks.length) return '没有 tracks 表';
      var bad = [];
      B.tracks.forEach(function (t2, i) {
        if (!Array.isArray(t2) || t2.length !== 3) { bad.push('#' + i + ' 长度 ' + (t2 || []).length); return; }
        if (!/^[A-Za-z]+$/.test(t2[0])) bad.push('#' + i + ' 英文名 ' + t2[0]);
        if (!t2[1] || !L.hasCJK(t2[1])) bad.push('#' + i + ' 中文名 ' + t2[1]);
        if (!(t2[2] > 0)) bad.push('#' + i + ' 赛季 ' + t2[2]);
      });
      return bad.length === 0 || bad.slice(0, 3).join('; ');
    });

    t('升级轨道：每行的轨道码都能解开，等级在 1..6', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      var bad = [];
      eachRow(B, function (row, where) {
        var code = row[5];
        if (!code) return;                  // 0 / 缺省 = 解不出轨道，允许
        var idx = Math.floor(code / 10) - 1;
        var lv = code % 10;
        if (!B.tracks[idx]) bad.push(where + ' 轨道下标 ' + idx);
        else if (!(lv >= 1 && lv <= 6)) bad.push(where + ' 等级 ' + lv);
      });
      return bad.length === 0 || bad.length + ' 处异常，例如 ' + bad[0];
    });

    t('升级轨道：能解出轨道的行占大多数', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      // 本机实测 3601/3963 = 90.9%。解不出的多是上赛季物品和套装坯子。
      // 门槛定在 80%：真掉下去说明 AlterEgo 的轨道表没跟上新赛季，那正是要知道的事。
      var total = 0, ok = 0;
      eachRow(B, function (row) { total++; if (row[5]) ok++; });
      if (!total) return '一行都没有';
      var r = ok / total;
      return r >= 0.8 || '只有 ' + ok + '/' + total + ' 行（' + (r * 100).toFixed(1) + '%）能解出轨道';
    });

    t('升级轨道：mx（可升级上限）不小于当前装等', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      // 行格式改成固定位置之后 mx 缺省写 0（不再是 undefined）。0 表示没有上限信息。
      var bad = [];
      eachRow(B, function (row, where) {
        var ilvl = row[1], mx = row[4];
        if (mx == null || mx === 0) return;
        if (mx < ilvl) bad.push(where + ' ' + ilvl + ' → ' + mx);
      });
      return bad.length === 0 || bad.length + ' 处 mx 小于装等，例如 ' + bad[0];
    });

    t('来源分类：每个用到的分类都有中文标签', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      // 插件自己的 sourceCategories 只列了 5 个，而数据里实际用到 7 个 ——
      // tier（292 行）和 quest（5 行）没有标签，徽章会直接显示英文。
      // 生成器现在从这些行自己的 source 文本补齐；这条测试盯着补齐有没有生效。
      var used = {};
      (B.srcs || []).forEach(function (s) { if (s[1]) used[s[1]] = 1; });
      var miss = Object.keys(used).filter(function (c) { return !B.sourceCategories[c]; });
      return miss.length === 0 || '这些分类会显示英文：' + miss.join(', ');
    });

    t('来源分类：标签是中文，且不长于 6 个字', function () {
      var B = global.AE_BIS;
      if (!B) return '装备数据未加载，跳过';
      // 徽章是定宽行里的一格，标签太长会把使用率进度条挤掉。
      var bad = [];
      Object.keys(B.sourceCategories || {}).forEach(function (c) {
        var v = B.sourceCategories[c];
        if (!/[\u4e00-\u9fa5]/.test(v)) bad.push(c + '=' + v + '（没有中文）');
        else if (v.length > 6) bad.push(c + '=' + v + '（' + v.length + ' 字）');
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('图标数据：品质不是清一色的 4', function () {
      var Q = global.AE_ITEM_QUALITY;
      if (!Q) return '图标数据未加载，跳过';
      // 我一开始按「BiS 必然是紫装」写死了颜色，实测是错的：附魔卷轴是蓝的(3)、
      // 合剂是白的(1)。这条测试盯着这个假设，别让它悄悄回来。
      var dist = {};
      Object.keys(Q).forEach(function (id) { dist[Q[id]] = (dist[Q[id]] || 0) + 1; });
      var kinds = Object.keys(dist).length;
      return kinds >= 2 || '所有物品品质都是 ' + Object.keys(dist)[0] + '，不合理';
    });

    t('图标数据：没有多余条目', function () {
      var B = global.AE_BIS, IC = global.AE_ITEM_ICONS;
      if (!B || !IC) return '图标数据未加载，跳过';
      // 反向检查：item-icons.js 里的每个 id 都应该是数据里真用到的，
      // 否则就是换赛季后没重新生成，图标包里躺着一堆上赛季的东西。
      //
      // **消费者不止 BisData 一家。** app/maxroll-data.js 里有 36 件只在 maxroll
      // 出现的物品（附魔和可刷替代件），它们的图标名是 fetch-icons.js 查来的，
      // 所以也算「用得到」。只数 BisData 的话这条断言会把它们判成上赛季的残留 ——
      // 实测报了「14 个 itemId 用不到」，而那 14 个恰好是新加的那批。
      var used = {};
      Object.keys(B.items).forEach(function (id) { used[id] = 1; });
      Object.keys(B.specs).forEach(function (key) {
        var s = B.specs[key];
        (s.gems || []).forEach(function (r) { used[r[0]] = 1; });
        Object.keys(s.ench || {}).forEach(function (slot) {
          (s.ench[slot] || []).forEach(function (r) { if (r[3]) used[r[3]] = 1; });
        });
      });
      (B.consumables || []).forEach(function (c) { used[c.id] = 1; });
      var MR = global.AE_MAXROLL;
      if (MR && MR.items) Object.keys(MR.items).forEach(function (id) { used[id] = 1; });
      var extra = Object.keys(IC).filter(function (id) { return !used[id]; });
      return extra.length === 0 ||
        extra.length + ' 个 itemId 在数据里用不到，例如 ' + extra[0] + '（该重跑 fetch-icons）';
    });

    return { pass: pass, fail: fail, skipped: false, results: results };
  };

})(typeof window !== 'undefined' ? window : globalThis);
