/*
 * WowAltBoard - app/bis.js
 *
 * 毕业装备 / 天赋面板。数据来自 GearInsight 插件自带的静态参照表，由
 * tools\gen-bis.js 和 tools\gen-talents.js 预转换成 app/bis-data.js 与
 * app/talent-data.js，随发布包一起发 —— 用户不用另外下载，也不必装插件。
 *
 * 三份数据都是按需加载：装备表 ~200 KB，天赋表 ~520 KB，天赋树 ~415 KB，大多数人
 * 开表格是来看角色进度的，不该为这个面板付启动成本。和 data/backups.js 同一个套路。
 *
 * 关于天赋树：树的结构（坐标 / 连线 / 中文名 / 点数上限）**不在插件里** —— 插件
 * 自己显示天赋时是调游戏运行时的 C_Traits API 现查的，网页没有这些 API，插件文件
 * 里能找到的只有 entryID + 点数。所以结构另外来一份：
 *   · tools\fetch-talent-tree.js 从 raidbots 取结构、从暴雪 DB2 取中文名，
 *     生成 app/talent-tree.js（window.AE_TALENT_TREE）；
 *   · 有它    → 画出三棵树（职业 / 专精 / 英雄），高亮某一套天赋点了哪些节点；
 *   · 没有它  → 退化成「热门套路 + 点数分布 + 来源玩家」，并在界面上说清楚怎么补。
 * AE_TALENT_TREE 的格式见本文件末尾 TREE_FORMAT_DOC，权威定义在
 * tools\verify-talent-tree.js（可执行的那种）。
 *
 * 天赋导入串（那串粘到游戏里的 base64）：**不自己编，直接用现成的。**
 * 以前这里写的是「做不到，要 treeHash 和 serialVersion，只有游戏运行时才有」——
 * 那句话对「自己编一串」是对的，但问题问错了。app/rio-data.js 里每个专精都躺着
 * 94~100 条**真实玩家的官方串**（raider.io 的 talentLoadoutText），照原样显示、
 * 照原样复制就行。自己编一串反而是最坏的选择：编错了游戏只会说「无效」，
 * 而现成的串是从能进排行榜的角色身上抄来的，本来就能导入。
 * 面板只做两件事：按「多少人用同一串」聚合，和一字不改地交给剪贴板。
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;
  var L = AE.Labels;

  // 部位显示顺序。slotId 来自 GearInsight 的 GearReader.lua（4 = 衬衣，数据里没有）。
  var SLOT_ORDER = [1, 2, 3, 15, 5, 9, 10, 6, 7, 8, 11, 12, 13, 14, 16, 17];

  // 职业 -> 该职业的专精 key 列表，第一次渲染时从数据里建。
  var byClass = null;

  var state = {
    tab: 'gear',        // 'gear' | 'talents'
    key: '',            // 'DEATHKNIGHT/BLOOD/Deathbringer'
    // 'maxroll' | 'rio'（第 16 轮：GearInsight 那两个视角撤了，见 renderGear 的 VIEWS）
    //   maxroll = maxroll.gg 的编辑推荐（**默认视角**，用户第 15 轮定的）
    //   rio = raider.io 实战分布
    //
    // 界面上只有这两个按钮，但 effectiveView() 还会返回 'raid' / 'mplus' ——
    // 那是 **GearInsight 兜底**，不是用户能选的视角：app/maxroll-data.js 是
    // 懒加载的，首屏那一瞬间 mrPick() 还是 null，得有东西画。
    view: 'maxroll',
    tcat: 'raid',       // 'raid' | 'mplusHigh' | 'mplusFarm'
    charKey: '',        // 对照哪个角色的实际装备，'' = 不对照
    build: -1,          // 天赋树画哪一套，-1 = 该类别里用得最多的那套
    loadout: 0,         // 显示第几条官方导入串（rioLoadouts 排序后的下标）
    // 「榜上热门天赋串」看团本还是大秘境（第 20 轮）。
    // **持久化**，和 mrKind 同一个道理：它是两个固定的字，而且一个人在准备打
    // 团本的话每次打开都要看团本那份。两份数据来源不同 ——
    // 大秘境是 raider.io，团本是 Warcraft Logs（见 loKinds()）。
    loKind: 'mplus',
    // 天赋页的 maxroll 那一路（第 15 轮：天赋也按 maxroll 来）。
    // mrKind 是 'mplus' | 'raid'，mrBuild 是该类型里第几套方案，
    // mrSub 是「打包了两条英雄树」时画哪一条（0 = 用方案里第一条）。
    //
    // **mrKind 持久化，mrBuild / mrSub 不。** 两者性质不同：
    //   · mrKind 是 'raid' / 'mplus' 两个**固定的字**，重抓数据也还是这两个。
    //     一个人在准备打团本，那他每次打开天赋页要看的都是团本那一份 ——
    //     不存的话每次都跳回大秘境，他得手动点回去（换个专精也要再点一次）。
    //   · mrBuild / mrSub 是**数组下标**，重抓数据后会指向另一套方案。
    //     存下来只会让用户下次打开看到一套他没选过的天赋，而界面上完全看不出来。
    mrKind: '',
    mrBuild: 0,
    mrSub: 0
  };

  var gearLoaded = false, gearLoading = false;
  var talLoaded = false, talLoading = false;
  var rioLoaded = false, rioLoading = false;
  var mrLoaded = false, mrLoading = false;

  // ------------------------------------------------------------------ 小工具

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls || null, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function pct(n) {
    if (n == null) return '';
    return (Math.round(n * 10) / 10) + '%';
  }

  function settings() {
    return (AE.state && AE.state.settings) || {};
  }

  function persist(patch) {
    var s = settings();
    var changed = false;
    Object.keys(patch).forEach(function (k) {
      if (s[k] !== patch[k]) { s[k] = patch[k]; changed = true; }
    });
    if (changed && AE.saveSettings) AE.saveSettings(s);
  }

  /**
   * 按需加载一个「赋值到 window 上的 js 数据文件」。
   * file:// 下 fetch() 不可用，<script src> 是唯一能跑的办法 —— index.html
   * 顶部的注释已经记了这件事。远端地址（设置里可配）优先，失败退回包内的那份。
   */
  function loadDataFile(fileName, globalName, done) {
    if (global[globalName]) { done(null); return; }

    var base = String(settings().remoteDataUrl || '').trim();
    var tried = [];
    if (base) {
      tried.push(base.replace(/\/+$/, '') + '/' + fileName);
    }
    tried.push('app/' + fileName);

    (function attempt(i) {
      if (i >= tried.length) { done(fileName + ' 读取失败'); return; }
      var s = doc.createElement('script');
      s.src = tried[i];
      s.async = false;
      s.charset = 'utf-8';
      s.onload = function () {
        if (global[globalName]) done(null);
        else attempt(i + 1);   // 加载成功但没赋值 = 文件内容不对，试下一个
      };
      s.onerror = function () { attempt(i + 1); };
      doc.head.appendChild(s);
    })(0);
  }

  // --------------------------------------------------------------- 数据整理

  function bis() { return global.AE_BIS || null; }

  /**
   * raider.io 的实战装备分布（app/rio-data.js，实测 849.3 KB）。
   *
   * **和 BisData 是并存关系，不是替换。** 两边各有对方没有的东西，实测过：
   *   · rio 独有：**每个部位自己的样本量**（BisData 一个样本量字段都没有）、
   *     **不截断的完整分布**（实测覆盖率中位数 100%，BisData 只有 69.7%/75.2%）、
   *     物品图标名 + 品质 + 插槽标记。
   *   · BisData 独有：属性权重、单体/多目标、武器类型、宝石、附魔、掉落来源、
   *     升级轨道、团本视角 —— raider.io 的 profile 里没有这些。
   * 所以面板给 rio 单独开一个视角，而不是把 BisData 拆了。
   */
  function rio() { return global.AE_RIO || null; }

  /** specId -> rio 里那个专精的数据。rio 的 specs 是**纯 specId 键**（BisData 是三段键）。 */
  function rioSpec(specId) {
    var R = rio();
    if (!R || !R.specs) return null;
    return R.specs[String(specId)] || null;
  }

  /**
   * maxroll 的编辑推荐（app/maxroll-data.js，实测 98.4 KB / 40 个专精 / 80 篇指南）。
   *
   * **和上面两份都不是同一个东西。** 三份数据回答的是三个不同的问题：
   *   · BisData（GearInsight）：顶尖玩家的使用率，带属性权重 / 宝石附魔 / 掉落来源；
   *   · rio（raider.io）：榜上真实角色的分布，**带每个部位的真实样本量**；
   *   · maxroll：**编辑给出的排序**（Best in Slot / Farmable Alternatives 两张表）。
   *
   * maxroll 这份**没有样本量也没有使用率** —— 它不是统计，是推荐。
   * 所以它的行不能画使用率条：那会凭空造出一个没人算过的百分比。
   * 取而代之画名次（#1 / #2 …），并把 BiS 和「可刷替代」分开标。
   */
  function maxroll() { return global.AE_MAXROLL || null; }

  /** specId + 类型 -> maxroll 里那个视角。kind 是 'raid' | 'mplus'。 */
  function mrView(specId, kind) {
    var M = maxroll();
    if (!M || !M.specs) return null;
    var s = M.specs[String(specId)];
    if (!s || !s.views) return null;
    return s.views[kind] || null;
  }

  /**
   * maxroll 的一个专精挑一个视角出来。团本和大秘境两篇指南都可能有，
   * 优先给大秘境（面板别处的锁定/进度也是以大秘境为主），没有再退到团本。
   * 返回 {v 视角, kind 实际用的类型} 或 null。
   */
  function mrPick(specId) {
    var mp = mrView(specId, 'mplus');
    if (mp) return { v: mp, kind: 'mplus' };
    var rd = mrView(specId, 'raid');
    if (rd) return { v: rd, kind: 'raid' };
    return null;
  }

  /** maxroll 的物品元数据 {n 中文名, i 图标名, q 品质}。 */
  function mrItem(itemId) {
    var M = maxroll();
    if (!M || !M.items) return null;
    return M.items[String(itemId)] || null;
  }

  /**
   * itemId → 实测装等 + 升级轨道。**maxroll 自己两样都不给。**
   *
   * 为什么要另找来源：maxroll 的 BiS 表只有「部位 / 物品名 / 掉落位置」三列，
   * 装等是他们前端拿 `data-wow-item` 那个 blob 现算的，抓下来的 HTML 里没有
   * （实测：81 篇缓存里 `Item Level` 只出现 2 次，都是一句提醒的正文；
   * 那个 blob 里 97% 的串在 offset 2 处有个 9~11 位的字段落在装等区间，
   * 但只有 16 个不同取值、257/259/261 占绝大多数 —— 那是标志位不是装等；
   * 他们的 backend embed 接口要 OAuth，302 到 /oauth2/start，走不通）。
   *
   * 本机有两份**实测**值，都不用联网：
   *   · GearInsight（app/bis-data.js）：顶尖玩家身上这件的装等 + 升级轨道，
   *     实测覆盖 maxroll 的 1337/1358 次引用。同一件在不同专精 / 视角下
   *     不一定一样（498 件里 274 件有分歧 —— 升级等级不同），这里取**最高**那条，
   *     轨道和可升级上限跟着那条一起拿，免得三个数字来自三次不同的测量。
   *   · raider.io（app/rio-data.js 的 slots[*].d[*][2]）：榜上玩家穿这件时的
   *     **平均**装等，再补 15 次引用。
   * 两边都有的 497 件里，GearInsight 的最高值比 rio 的均值中位高 10 点（p95 +23）
   * —— 一个是「顶尖玩家升满的样子」，一个是「榜上平均的样子」，不是同一个量，
   * 所以**不混着平均**：只记是哪个来源给的，界面上说清。
   * 剩下 6 次引用两边都没有，那就不显示装等 —— 不猜。
   */
  var measuredCache = null;
  function measuredGear() {
    if (measuredCache) return measuredCache;
    var out = {};
    var B = bis();
    if (B && B.specs) {
      Object.keys(B.specs).forEach(function (k) {
        var sp = B.specs[k];
        ['raid', 'mplus'].forEach(function (v) {
          var slots = sp[v] || {};
          Object.keys(slots).forEach(function (sn) {
            (slots[sn] || []).forEach(function (r) {
              var iv = r[1];
              if (!iv) return;
              var cur = out[r[0]];
              if (cur && cur.v >= iv) return;
              out[r[0]] = { v: iv, mx: r[4] || 0, trk: r[5] || 0, src: 'g' };
            });
          });
        });
      });
    }
    var R = rio();
    if (R && R.specs) {
      var acc = {};
      Object.keys(R.specs).forEach(function (sid) {
        var slots = R.specs[sid].slots || {};
        Object.keys(slots).forEach(function (sn) {
          (slots[sn].d || []).forEach(function (r) {
            if (!r[2]) return;
            var a = acc[r[0]] || (acc[r[0]] = { w: 0, n: 0 });
            a.w += r[2] * r[1];
            a.n += r[1];
          });
        });
      });
      Object.keys(acc).forEach(function (id) {
        if (out[id]) return;            // GearInsight 已经给了，不覆盖
        out[id] = { v: Math.round(acc[id].w / acc[id].n), mx: 0, trk: 0, src: 'r' };
      });
    }
    measuredCache = out;
    return out;
  }

  /**
   * maxroll 的一个视角 -> 面板要的行形状。
   *
   * 产物里每个槽位是 `bis: [itemId…]` 和 `alt: [itemId…]` 两个**有序**列表
   * （顺序就是 maxroll 表里的顺序）。这里拼成面板的行形状：
   *   `[itemId, 装等, 使用率, 来源下标, 可升级上限, 轨道码, 人数, 名次, 是不是替代件,
   *     装等是谁测的]`
   *
   * 最后三位是 maxroll 独有的（rio 的行到第 7 位，BisData 的行到第 6 位）。
   * 装等 / 可升级上限 / 轨道码来自 measuredGear() —— maxroll 自己不给，见那个函数的注释。
   *
   * 来源下标写 **-2** 当标记（rio 用 -1）。为什么不用 undefined：0 是合法下标，
   * 拿假值判断会把「来源下标为 0 的 BisData 行」一起吞掉 —— rio 那边就是这么定的，
   * 这里沿用同一套约定。
   *
   * 使用率一律写 **null**，不是 0 也不是 100。maxroll 没有这个量，
   * 写 0 会画出一条空条，写 100 会画满 —— 两个都是在编数字。renderItem 见到
   * null 就不画那条，改画名次徽章。
   */
  function mrSlots(v) {
    var rows = {};
    // n 是**空表**，而且必须存在。maxroll 没有样本量，但调用点会读 conv.n[slotId] ——
    // 不给这个字段就是 TypeError（第一版就这么炸的：加了视角之后渲染检查直接崩）。
    // 空表的语义正好对：查任何部位都得到 undefined，renderSlot 于是不画 N 徽章。
    var ns = {};
    if (!v) return { rows: rows, n: ns };
    var ITEMS = (maxroll() || {}).items || {};
    var MEAS = measuredGear();
    // 装等 / 可升级上限 / 轨道码都从 measuredGear() 借，第 10 位记**是谁给的**
    // （'g' = GearInsight 顶尖玩家实测最高，'r' = raider.io 榜上均值，'' = 两边都没有）。
    // 不记来源的话界面上「703」和「312」看着是同一种数，其实一个是升满的样子、
    // 一个是榜上平均的样子。
    function meas(id) { return MEAS[id] || { v: 0, mx: 0, trk: 0, src: '' }; }
    Object.keys(v.bis || {}).forEach(function (k) {
      var list = v.bis[k] || [];
      rows[k] = list.map(function (id, i) {
        var m = meas(id);
        return [id, m.v, null, -2, m.mx, m.trk, null, i + 1, false, m.src];
      });
    });
    // 可刷替代接在后面，标上 alt 位。同一件已经在 BiS 里就不重复列。
    Object.keys(v.alt || {}).forEach(function (k) {
      var list = v.alt[k] || [];
      var into = rows[k] = rows[k] || [];
      var seen = {};
      into.forEach(function (r) { seen[r[0]] = 1; });
      list.forEach(function (id, i) {
        if (seen[id]) return;
        var m = meas(id);
        into.push([id, m.v, null, -2, m.mx, m.trk, null, i + 1, true, m.src]);
      });
    });
    // ITEMS 只是拿来确认物品池在（校验器已经验过引用完整性），这里不再逐行查。
    void ITEMS;
    return { rows: rows, n: ns };
  }

  /**
   * rio 的一个专精 -> 面板要的形状。
   *
   * rio 的行是 `[itemId, 人数, 平均装等]`，面板原有的行是
   * `[itemId, 装等, 使用率, 来源下标, 可升级上限, 轨道码]`。这里转成后者的形状，
   * 好让 renderItem 只有一套：**使用率由「人数 / 该部位样本量」算出来**，
   * 来源下标写 -1 当标记（rio 没有掉落来源），并把原始人数放在第 6 位。
   *
   * 为什么不在生成器里存百分比：百分比是**导出量**，人数和样本量才是原始量。
   * 存原始量的好处是校验器能验「人数之和 == 样本量」这条恒等式 —— 存百分比就验不了了。
   */
  function rioSlots(rs) {
    var rows = {}, ns = {};
    if (!rs || !rs.slots) return { rows: rows, n: ns };
    Object.keys(rs.slots).forEach(function (k) {
      var b = rs.slots[k];
      if (!b || !b.n || !b.d) return;
      ns[k] = b.n;
      rows[k] = b.d.map(function (r) {
        return [r[0], r[2], r[1] * 100 / b.n, -1, 0, 0, r[1]];
      });
    });
    return { rows: rows, n: ns };
  }

  /** rio 的物品元数据 {n 中文名, i 图标名, q 品质, sock 插槽数}。 */
  function rioItem(itemId) {
    var R = rio();
    if (!R || !R.items) return null;
    return R.items[String(itemId)] || null;
  }

  /**
   * 一个专精的天赋导入串列表，**两家共用一个读法**。
   *
   * app/rio-data.js（大秘境）和 app/wcl-data.js（团本）现在是同一个形状：
   * `loadouts: [[串, 多少人用]…]`，人数降序、同人数按串本身，各专精最多 30 种。
   *
   * 为什么产物里就聚合好、面板不自己数：第 20 轮把 rio 的采样从 100 人提到
   * 500 人，一人一条地存 19908 条串是 2 MB、占产物 90%，而这里只画前 6 种。
   * 聚合放在生成器里，产物 2319 KB → 359 KB。
   *
   * **面板不重排。** 顺序是产物的责任，重排一遍等于把「产物排错了」这件事
   * 藏起来 —— 那是校验器该报的，不是面板该兜的。
   *
   * total 用 n（真实采样人数），不是 count 之和：只留了前 30 种，
   * 拿截断后的和当分母，百分比会偏高。
   */
  function loadoutsOf(sp) {
    if (!sp || !sp.loadouts || !sp.loadouts.length) return null;
    var count = Object.create(null), list = [];
    sp.loadouts.forEach(function (row) {
      var str = row && row[0];
      if (!str) return;
      count[str] = row[1] || 1;
      list.push(str);
    });
    if (!list.length) return null;
    return {
      list: list, count: count,
      total: sp.n || list.length,
      uniq: sp.loUniq || sp.uniq || list.length
    };
  }

  function rioLoadouts(specId) {
    return loadoutsOf(rioSpec(specId));
  }
  function talents() { return global.AE_TALENTS || null; }
  function tree() { return global.AE_TALENT_TREE || null; }

  // 图标默认从包里的 app/icons/ 取 —— 那是打包前用 tools\fetch-icons.js 下好的，
  // 469 个文件约 1 MB，离线可用。国内访问不到 wowhead 的图床（实测直连 403），
  // 所以不能在运行时去拉图；iconBaseUrl 只是留给想换成自己图床的人。
  var ICON_DIR = 'app/icons';

  /** 图标名 -> 图片地址。名字为空才返回 null（那时候画占位块）。 */
  function iconUrl(name) {
    if (!name) return null;
    var base = String(settings().iconBaseUrl || '').trim() || ICON_DIR;
    return base.replace(/\/+$/, '') + '/' + name + '.jpg';
  }

  // 天赋图标是另一批文件（app/talent-icons/，2094 张 56×56 约 5.1 MB），
  // 由 tools\fetch-talent-icons.js 在打包前下好。**故意不走 iconBaseUrl** ——
  // 那个设置是给装备图标换图床用的，两批图不在同一个目录下，
  // 拿它拼天赋图标的地址会得到一堆 404。
  var TALENT_ICON_DIR = 'app/talent-icons';

  /**
   * 天赋图标名 -> 图片地址。
   *
   * 文件名就是 app/talent-tree.js 里 icons 字典的那个名字，即使那个名字是
   * **raidbots 规范化坏了的**（比如 spell_frost_ring_of_frost，真名是
   * ...ring-of-frost）。抓取工具按坏名字存盘，就是为了让这里不需要映射表 ——
   * 否则 app/ 会多出第二个需要跟着上游维护的真相来源。
   */
  function talentIconUrl(name) {
    if (!name) return null;
    return TALENT_ICON_DIR + '/' + name + '.jpg';
  }

  /**
   * 一个 entry -> 它的图标 <img>，取不到就返回 null（那时候节点只有文字，和以前一样）。
   *
   * entryFormat = [entryId, nameIdx, iconIdx, spellId, maxRanks]，图标名在 icons 字典里。
   *
   * alt 故意是空串：节点方块里图标**旁边就是天赋的中文名**，读屏软件念完名字
   * 再念一遍图标文件名是纯噪音。空 alt 是「装饰图」的正确写法 —— 缺 alt 属性
   * 才是问题（那会让读屏去念 src）。run-tests.js 的无障碍断言查的正是「有没有
   * alt 属性」，不是「alt 非空」。
   */
  function talentIconImg(ent, size) {
    if (!ent) return null;
    var TR = tree();
    if (!TR || !TR.icons) return null;
    var url = talentIconUrl(TR.icons[ent[2]] || '');
    if (!url) return null;
    var img = doc.createElement('img');
    // class 必须是 ti —— app/style.css 里 .tnode .ti 管尺寸和「没点的压暗」。
    // 忘了设这一行的话图会按原始 56px 铺满整个节点框，而且压暗全部落空。
    img.className = 'ti';
    img.src = url;
    img.alt = '';
    img.width = size;
    img.height = size;
    // 懒加载 + 异步解码。天赋页一次要造 **99 个**这样的图标（三棵树各 ~33 个），
    // 而面板每点一下都是整块重建 —— 三棵树里通常只有第一棵在视口内，
    // 剩下的都在滚动区外。不加这两句的话每次重建都要把 99 张全处理一遍
    // （file:// 下每张都是一次单独的文件读取 + 解码）。
    //
    // 用 setAttribute 而不是 img.loading = ... ：两者在浏览器里等价，但属性赋值
    // 在测试脚手架里**看不见**（桩只记 setAttribute），那样这条改动就没法写断言。
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    // 缺一张图不该让整个节点塌掉，也不该留一个碎图标记。
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    return img;
  }

  /** itemId -> 图标名。来自 app/item-icons.js，没加载就返回空。 */
  function itemIcon(itemId) {
    var m = global.AE_ITEM_ICONS;
    if (!m) return '';
    return m[itemId] || '';
  }

  /**
   * itemId -> 品质。BisData 里**没有**品质字段（我在本机 2187 件上数过是 0 次），
   * 这份是按 itemId 查出来的，和图标一起放在 app/item-icons.js。
   * 实测分布 {1:14, 3:54, 4:500} —— 所以「BiS 一定是紫装」是错的，附魔卷轴是蓝的、
   * 合剂是白的，硬写成紫色会把这三类都染错。
   */
  function itemQuality(itemId) {
    var m = global.AE_ITEM_QUALITY;
    if (!m) return null;
    var q = m[itemId];
    return q == null ? null : q;
  }

  /**
   * 轨道码 → 「英雄 6/6」。轨道码 = (轨道下标+1)*10 + 升级等级，0 = 解不出来。
   *
   * 这个字段是 tools\gen-bis.js 从 BisData 的 bonusIDs 解出来的：插件存 bonusIDs
   * 只为了在游戏里拼 |Hitem: 链接让 tooltip 显示对的装等，网页没这个机制，所以
   * 生成器把它解成轨道 + 等级再存，比原样存那串数字省，而且是能直接显示的东西。
   * 3963 行里 3601 行解得出（90.9%），解不出的多是旧赛季物品和套装坯子。
   */
  function trackLabel(code) {
    var B = bis();
    if (!code || !B || !B.tracks) return '';
    var idx = Math.floor(code / 10) - 1;
    var lv = code % 10;
    var t = B.tracks[idx];
    if (!t) return '';
    return (t[1] || t[0]) + ' ' + lv + '/6';
  }

  /** 按 itemId 出一个 <img>，没有图标数据就返回 null。size 是显示边长。 */
  function iconImg(itemId, size, fallbackName) {
    var name = itemIcon(itemId) || fallbackName || '';
    var url = iconUrl(name);
    if (!url) return null;
    var img = doc.createElement('img');
    img.src = url;
    img.alt = '';
    img.width = size;
    img.height = size;
    // **懒加载 + 异步解码。** 面板每次点击都是整块重建，而一次天赋页要造 99 个
    // 图标 <img>（三棵树各 ~33 个）—— 其中只有第一棵树的那些在视口里，剩下的
    // 都在下面滚动区外。不加这两个属性的话，浏览器每次重建都要把 99 个全处理
    // 一遍（file:// 下每个都是一次单独的文件读取 + 解码），点一下就能感觉到卡。
    //
    // 这两个属性都是浏览器原生的、不支持也只是没效果，所以不用探测特性。
    // width/height 上面已经写死了，所以懒加载不会引起布局跳动。
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    // 图标文件缺一个不该让整行塌掉，也不该留一个碎图标记。
    //
    // 换到 rio 视角后这条分支**经常走到**：rio 有 2432 件物品，而包里
    // app/icons/ 只有 462 张图（实测能对上文件的 966/2432 = 39.7%）。
    // 所以图没了以后要把外面那个格子变回占位块，否则会留一个空洞。
    img.addEventListener('error', function () {
      var p = img.parentNode;
      if (!p) return;
      p.removeChild(img);
      if (p.className === 'icon') { p.className = 'icon ph'; p.textContent = '?'; }
    });
    return img;
  }

  function buildClassIndex() {
    var B = bis();
    byClass = {};
    Object.keys(B.specs).forEach(function (key) {
      var s = B.specs[key];
      (byClass[s.cls] = byClass[s.cls] || []).push(key);
    });
    // 专精内部按 specId 稳定排序，免得每次渲染顺序不一样
    Object.keys(byClass).forEach(function (c) {
      byClass[c].sort(function (a, b) {
        return (B.specs[a].specId || 0) - (B.specs[b].specId || 0);
      });
    });
  }

  function firstKey() {
    var B = bis();
    var keys = Object.keys(B.specs);
    return keys.length ? keys[0] : '';
  }

  function currentSpec() {
    var B = bis();
    if (!B) return null;
    if (!B.specs[state.key]) state.key = firstKey();
    return B.specs[state.key] || null;
  }

  /**
   * 专精中文名：用户覆盖 > labels.js 内置 > 数据自带（GearInsight 的表）> 英文原样。
   *
   * 数据自带的那份有两处已实测的问题（见 labels.js 里 L.specZh 的说明）：
   * DEATHKNIGHT/FROST 被写成「冰法」，PRESERVATION / DISCIPLINE 根本没有行。
   * 所以这里过一遍 L.specLabel，让覆盖表能压过它。
   */
  function specLabel(s) {
    if (!s) return '';
    return L.specLabel(s.specId, s.specCn, settings().specNameOverrides, s.spec) || s.spec;
  }

  /**
   * 本机角色列表，用于「和我的装备对照」。
   *
   * 装等在 model.js 里是 ch.ilvl.value（一个对象，不是数字）—— 早先这里写的是
   * ch.itemLevel，那个字段不存在，于是排序整个是空转，下拉里也全是「?」。
   *
   * 传了 cls 就把同职业的排到前面：对照一个圣骑士和死骑的毕业表毫无意义，
   * 但下拉里如果按装等排，最上面那个大概率就是别的职业。
   */
  function characters(cls) {
    var m = AE.state && AE.state.model;
    if (!m || !m.characters) return [];
    return m.characters.slice().sort(function (a, b) {
      if (cls) {
        var am = a.classFile === cls ? 1 : 0;
        var bm = b.classFile === cls ? 1 : 0;
        if (am !== bm) return bm - am;
      }
      return charIlvl(b) - charIlvl(a);
    });
  }

  function charIlvl(ch) {
    return (ch && ch.ilvl && ch.ilvl.value) || 0;
  }

  /**
   * 对照哪个角色。**职业对不上就当没选**（返回 null）。
   *
   * 为什么不是「照算 + 给个警告」（上一版就是）：bisChar 是持久化的，
   * 选完死骑再切到法师专精，整页会拿死骑的装备去比法师的毕业表 ——
   * 「对上 0 件 / 差 13 件」，再加一行跨护甲类型算出来的「装等差距」。
   * 那几个数字没有任何意义，但它们和真数字长得一模一样、位置一样显眼，
   * 而警告只有一行、在最下面。一个错到没意义的数比不给数更糟。
   *
   * 下拉里那个角色**仍然列着**（带 ≠ 标记），选中状态也还在 —— 切回他自己的
   * 职业就自动恢复。这里只是不把他喂给对照逻辑。
   */
  /** 下拉里选中的那个角色，**不看职业**。界面上要说「他是法师」时用这个。 */
  function pickedChar() {
    if (!state.charKey) return null;
    var list = characters();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === state.charKey) return list[i];
    }
    return null;
  }

  function currentChar() {
    var found = pickedChar();
    if (!found) return null;
    var s = currentSpec();
    if (s && found.classFile !== s.cls) return null;
    return found;
  }

  /** slotId -> 角色身上那件的 {itemId, name, itemLevel, quality}，没有就 null。 */
  function equippedAt(ch, slotId) {
    if (!ch || !ch.equipment) return null;
    var slotKey = SLOT_KEY[slotId];
    if (!slotKey) return null;
    var it = ch.equipment[slotKey];
    if (!it) return null;
    var parsed = it.link ? AE.parseItemLink(it.link) : null;
    return {
      itemId: parsed ? parsed.itemId : null,
      name: it.name || (parsed ? parsed.name : ''),
      itemLevel: it.itemLevel,
      quality: it.quality != null ? it.quality : (parsed ? parsed.quality : null)
    };
  }

  // BisData 的 slotId -> 我这边 ch.equipment 的键。两边都对着游戏的
  // INVSLOT_* 编号，来源分别是 GearInsight/core/GearReader.lua 和
  // AlterEgo 存的 itemSlotName。
  var SLOT_KEY = {
    1: 'HEADSLOT', 2: 'NECKSLOT', 3: 'SHOULDERSLOT', 5: 'CHESTSLOT',
    6: 'WAISTSLOT', 7: 'LEGSSLOT', 8: 'FEETSLOT', 9: 'WRISTSLOT',
    10: 'HANDSSLOT', 11: 'FINGER0SLOT', 12: 'FINGER1SLOT',
    13: 'TRINKET0SLOT', 14: 'TRINKET1SLOT', 15: 'BACKSLOT',
    16: 'MAINHANDSLOT', 17: 'SECONDARYHANDSLOT'
  };

  // ------------------------------------------------------------------ 渲染

  function body() { return doc.getElementById('bis-body'); }

  function setSub(text) {
    var n = doc.getElementById('bis-sub');
    if (n) n.textContent = text || '';
  }

  /**
   * 面板标题。以前是写死在 index.html 里的「毕业装备」——
   * 于是切到天赋页之后，标题还写着「毕业装备」而下面是一堆天赋树，
   * 看起来像是点错了地方。
   */
  function setTitle() {
    var n = doc.getElementById('bis-title');
    if (n) n.textContent = state.tab === 'talents' ? '天赋' : '毕业装备';
  }

  /**
   * 展开着的折叠块（`<details>`）。键是 secKey()，跨重建活着。
   *
   * 为什么需要它：render() 是**整块重建**（textContent = '' 再画一遍），
   * 所以每次点击都会把所有 `<details>` 打回默认的折叠状态。用户展开
   * 「各首领说明」看到一半，点一下别的方案，那一块就合上了 —— 而他点那一下
   * 要的只是换个方案，没让面板把他刚打开的东西收起来。
   */
  var openSecs = {};

  /**
   * 一个折叠块的稳定标识。**不能用下标** —— 换专精 / 换视角之后块的数量和顺序
   * 都会变，下标会指向另一块（用户展开「宝石」，切个专精变成「附魔」是开的）。
   * 用 class 加标题文字里那段固定的前缀，两者都跟着内容走。
   */
  function secKey(node) {
    var title = '';
    // 走 children（元素）而不是 childNodes（含文本节点）：我只要 <summary>，
    // 而且 children 在浏览器和测试脚手架里都在 —— 用 childNodes 的话在脚手架里
    // 是 undefined，整个函数会静默变成空转（写完第一版就是这样，测试一片绿
    // 而这个功能根本没被跑到）。
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].tagName === 'SUMMARY') { title = kids[i].textContent || ''; break; }
    }
    // 标题里带条数（「各首领说明　9 条」），条数会变而块还是同一块，所以切掉数字。
    return (node.className || '') + '|' + title.replace(/[0-9]+/g, '#');
  }

  /** 记住这一块的展开状态，并接上 toggle 事件。renderSec 之后调用。 */
  function trackSec(node) {
    var k = secKey(node);
    if (openSecs[k]) node.setAttribute('open', 'open');
    node.addEventListener('toggle', function () {
      // 读 open 状态要两条路都走：浏览器给 node.open（布尔属性），
      // 测试脚手架只有 getAttribute。少一条这段在其中一边就是空转。
      var isOpen = (node.open !== undefined)
        ? node.open
        : (node.getAttribute && node.getAttribute('open') != null);
      if (isOpen) openSecs[k] = 1;
      else delete openSecs[k];
    });
  }

  /** 把这一次画出来的所有 <details> 都接上（render 末尾统一做，不用逐处改）。 */
  function trackAllSecs(host) {
    (function walk(n) {
      if (n.tagName === 'DETAILS') trackSec(n);
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(host);
  }

  function render() {
    var host = body();
    if (!host) return;
    // **重建前记住滚动位置。** #bis-body 是滚动容器，textContent = '' 会把
    // scrollTop 打回 0 —— 面板很长（三棵天赋树 + 两块说明），用户在底下点一个
    // 方案按钮，视线会被扔回顶部，然后得重新滚下来找刚点的那个。
    var scroll = host.scrollTop || 0;
    host.textContent = '';

    var B = bis();
    if (!B) {
      host.appendChild(el('p', 'note', '装备数据还没加载。'));
      return;
    }
    if (!byClass) buildClassIndex();

    setTitle();
    host.appendChild(renderTabs());
    host.appendChild(renderPicker());

    if (state.tab === 'gear') renderGear(host);
    else renderTalents(host);

    trackAllSecs(host);
    // 还原滚动位置。**必须在内容画完之后** —— 空容器的 scrollTop 只能是 0，
    // 先赋值会被静默丢掉。
    if (scroll) host.scrollTop = scroll;
  }

  /**
   * 换专精 / 换职业时，把「第几套」这类**下标型**状态归零。
   *
   * 为什么必须做：mrBuild / mrSub / build / loadout 都是数组下标，而每个专精的
   * 数组是各自的。不归零的话，在 A 专精选了第 6 套，切到 B 专精会**落在 B 的
   * 第 6 套**上 —— 那是一套用户没选过的天赋，而界面上完全看不出异常
   * （高亮、点数、树全都自洽，只是这套不是他挑的）。实测毁灭术士和射击猎人
   * 的团本方案都有 10 套，切过去正好命中一套按首领分的方案。
   *
   * mrKind 不在这里归零：它是 raid / mplus 两个**固定的字**，不是下标，
   * 换专精之后含义不变（见 state 那段注释）。
   */
  function resetPicks() {
    state.mrBuild = 0;
    state.mrSub = 0;
    state.loadout = 0;
    state.build = -1;   // -1 = 该类别里用得最多的那套（插件那条路的默认）
  }

  function renderTabs() {
    var wrap = el('div', 'bis-tabs');
    [['gear', '毕业装备'], ['talents', '天赋']].forEach(function (t) {
      var b = button(t[1], 'tab' + (state.tab === t[0] ? ' on' : ''), function () {
        state.tab = t[0];
        persist({ bisTab: t[0] });
        if (t[0] === 'talents') ensureTalents(render);
        else render();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function renderPicker() {
    var B = bis();
    var wrap = el('div', 'bis-pick');

    // 职业一行，按职业色。没有中文名的用英文 token（见 labels.js 的说明）。
    var classRow = el('div', 'bis-row');
    var cur = currentSpec();
    Object.keys(byClass).sort().forEach(function (cls) {
      var on = cur && cur.cls === cls;
      var b = button(L.classLabel(cls, settings().learnedClassNames), 'cls' + (on ? ' on' : ''), function () {
        state.key = byClass[cls][0];
        resetPicks();
        persist({ bisSpec: state.key });
        render();
      });
      b.style.borderColor = L.classColor(cls);
      if (on) {
        b.style.background = L.classColor(cls);
        b.style.color = '#12161c';
      } else {
        b.style.color = L.classColor(cls);
      }
      classRow.appendChild(b);
    });
    wrap.appendChild(classRow);

    // 该职业的专精
    if (cur) {
      var specRow = el('div', 'bis-row');
      byClass[cur.cls].forEach(function (key) {
        var s = B.specs[key];
        var on = key === state.key;
        var label = specLabel(s);
        var b = button(label, 'spec' + (on ? ' on' : ''), function () {
          state.key = key;
          resetPicks();
          persist({ bisSpec: key });
          render();
        });
        b.setAttribute('data-tip', s.cls + '/' + s.spec +
          '　英雄天赋 ' + (s.hero ? heroName(s.hero) : '(无)') +
          '　specID ' + (s.specId || '?'));
        specRow.appendChild(b);
      });
      wrap.appendChild(specRow);
    }
    return wrap;
  }

  // ------------------------------------------------------------ 装备页

  /**
   * 当前视角的数据还没到（或这个专精没有）时该退到哪个视角。
   *
   * 为什么需要它：默认视角是 maxroll，但 app/maxroll-data.js 是**懒加载**的，
   * 首屏那一瞬间 mrPick() 恒为 null。不兜底的话面板会空着一下，
   * 而「空一下」和「这个专精真的没数据」在界面上长得一模一样。
   *
   * **只改这一次渲染用哪个视角，不动 state.view** —— 数据到了会重画（见
   * ensureMaxroll 的回调），那时候就该自动回到用户选的 maxroll 视角。
   * 把 state.view 改掉的话用户的选择就被我悄悄覆盖了。
   */
  function effectiveView(s) {
    var v = state.view;
    if (v === 'maxroll' && !mrPick(s.specId)) {
      // maxroll 还没到：退到 BisData 的大秘境视角（它是随包同步加载的，一定在）
      return s.mplus && Object.keys(s.mplus).length ? 'mplus' : 'raid';
    }
    if (v === 'rio' && !rioSpec(s.specId)) return 'mplus';
    return v;
  }

  function renderGear(host) {
    var B = bis();
    var s = currentSpec();
    if (!s) { host.appendChild(el('p', 'note', '没有这个专精的数据。')); return; }

    // 这一次渲染真正用的视角。和 state.view 可能不同 —— 见 effectiveView。
    var view = effectiveView(s);

    // 副标题要说清「你现在看的是哪份数据」——两份数据的日期和范围都不一样，
    // 混着显示一个日期是在撒谎。
    var subRs = view === 'rio' ? rioSpec(s.specId) : null;
    var subMr = view === 'maxroll' ? mrPick(s.specId) : null;
    if (subRs) {
      var R = rio();
      setSub('数据 ' + ((R && R.updatedAt) || '?') + '　raider.io '
        + ((R && R.season) || '?') + '　样本 ' + (subRs.nGear || 0) + ' 人');
    } else if (subMr) {
      // 这里**不写样本量**，因为 maxroll 没有。写来源指南的 slug ——
      // 那是可追溯的东西：照着它能翻到原页面自己核对。
      var M = maxroll();
      setSub('数据 ' + ((M && M.updatedAt) || '?') + '　maxroll.gg　'
        + (subMr.kind === 'mplus' ? '大秘境指南' : '团本指南')
        + '　编辑推荐，无样本量');
    } else {
      setSub('数据 ' + (B.updatedAt || '?') + '　' + (s.zone || ''));
    }

    // ---- 视角 + 角色对照
    var bar = el('div', 'bis-bar');
    var viewWrap = el('span', 'seg');
    // 第 16 轮撤掉了 GearInsight 的「团本视角 / 大秘境视角」两个按钮（用户定的）。
    // **数据文件 app/bis-data.js 留着**：它还喂着装等、升级轨道、掉落来源、
    // 属性目标、宝石 / 附魔 / 消耗品，以及 maxroll 没加载时的兜底渲染 ——
    // 删文件会让这些静默变空，而 maxroll 只能补回其中一部分。
    var VIEWS = [
      ['maxroll', '最佳推荐', 'maxroll.gg 的职业指南：编辑给出的 Best in Slot 排序 '
        + '+ 可刷替代。没有样本量也没有使用率 —— 它是推荐，不是统计'],
      ['rio', '实战分布', 'raider.io 大秘境排行榜上真实角色的装备统计，每个部位都带样本量']
    ];
    VIEWS.forEach(function (v) {
      // rio 视角只有在 app/rio-data.js 真的加载进来、而且这个专精有数据时才给。
      // 画一个点不下去的按钮比不画更糟。
      if (v[0] === 'rio' && !rioSpec(s.specId)) return;
      if (v[0] === 'maxroll' && !mrPick(s.specId)) return;
      var b = button(v[1], state.view === v[0] ? 'on' : null, function () {
        state.view = v[0];
        persist({ bisView: v[0] });
        render();
      });
      b.setAttribute('data-tip', v[2]);
      viewWrap.appendChild(b);
    });
    bar.appendChild(viewWrap);

    var chars = characters(s.cls);
    if (chars.length) {
      var pick = el('span', 'pick');
      pick.appendChild(el('label', null, '对照角色'));
      var sel = el('select');
      var none = el('option', null, '不对照');
      none.value = '';
      sel.appendChild(none);
      chars.forEach(function (ch) {
        // 职业写在名字后面，因为对着别的职业的毕业表看是没有意义的，
        // 而光看名字分不出职业。不同职业的加个 ≠ 直接标出来。
        var iv = charIlvl(ch);
        var same = ch.classFile === s.cls;
        var o = el('option', null,
          (same ? '' : '≠ ') + ch.name + '　' +
          L.classLabel(ch.classFile, settings().learnedClassNames) + '　' +
          (iv ? iv.toFixed(1) : '?'));
        o.value = ch.key;
        if (ch.key === state.charKey) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        state.charKey = sel.value;
        persist({ bisChar: sel.value });
        render();
      });
      pick.appendChild(sel);
      bar.appendChild(pick);
    }
    host.appendChild(bar);

    // rio 视角走另一份数据：它的行形状不同（人数而不是百分比），所以先转一次。
    var rs = view === 'rio' ? rioSpec(s.specId) : null;
    var mr = view === 'maxroll' ? mrPick(s.specId) : null;
    var conv = rs ? rioSlots(rs) : (mr ? mrSlots(mr.v) : null);

    host.appendChild(renderSpecMeta(s, mr ? mr.kind : null));
    // 属性权重 / 达成度是 **GearInsight 独有的**，raider.io 的角色档案里没有，
    // 所以 rio 视角下不画 —— 脚注明写了「这个视角没有属性权重」，一边这么写一边
    // 把另一个数据源的权重摆在上面，那句话就成了假话。
    //
    // maxroll 视角**改成画**（第 16 轮）。上一版不画，理由是「maxroll 的属性
    // 优先级是正文文字，产物里没抓，不能借别的来源的数字充」。但第 16 轮撤掉了
    // GearInsight 那两个视角，于是这一块在界面上**一次都不会出现**了 ——
    // 用「宁缺毋滥」换来的是整块功能消失。现在画出来，并在标题里写明是谁给的：
    // 说清来源的借用不是撒谎，静默消失才是。
    if (!rs) host.appendChild(renderStatTargets(s, mr ? mr.kind : null, !!mr));

    // ---- 部位
    var slots = conv ? conv.rows : (s[view] || {});
    var ch = currentChar();
    var list = el('div', 'bis-slots');
    var missing = 0, matched = 0, unknown = 0;
    // 装等差距的汇总：能比的部位数、总差值、差最多的那个部位。
    // 「能比的部位数」要单独记 —— 不记的话「差 168 装等」这个数没有分母，
    // 而分母会变（存档稀疏、6 件推荐装两份实测数据都查不到装等）。
    var gapN = 0, gapSum = 0, gapWorst = null;
    // 两边的装等分别累加。只有汇总里给出**这两个原始数**，用户才能自己验算 ——
    // 光给一个「合计差 168」是个无法核对的断言（分母和两边的基数都看不见）。
    var gapMine = 0, gapWant = 0;

    SLOT_ORDER.forEach(function (slotId) {
      var rows = slots[slotId];
      if (!rows || !rows.length) return;
      var mine = equippedAt(ch, slotId);
      var hit = false;
      if (mine && mine.itemId) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i][0] === mine.itemId) { hit = true; break; }
        }
      }
      // 「没有记录」和「不匹配」得分开算。AlterEgo 存的 equipment 是稀疏的
      // （本机实测：一个角色 16 个部位齐全，另一个只有 7 个），把没记录的
      // 算成「差一件」会凭空多出十几件根本没查过的装备。
      if (ch) {
        if (!mine || !mine.itemId) unknown++;
        else if (hit) matched++;
        else missing++;
      }
      var g = slotGap(rows, mine);
      if (g) {
        gapN++;
        gapSum += g.d;
        gapMine += g.mine;
        gapWant += g.want;
        if (!gapWorst || g.d > gapWorst.d) gapWorst = { d: g.d, slot: slotId };
      }
      // conv.n 可能整个不存在（maxroll 那份没有样本量），所以这里不假设它在。
      list.appendChild(renderSlot(slotId, rows, mine, hit,
        conv && conv.n ? conv.n[slotId] : null));
    });
    host.appendChild(list);

    // 选了个别的职业的角色：currentChar() 已经把他挡在对照之外（见那里的说明），
    // 所以这里 ch 是 null，上面一件都没比。**必须说出来**，不然界面上只是
    // 「对照角色」下拉里挂着一个名字、而所有对照痕迹凭空消失，看着像功能坏了。
    var picked = pickedChar();
    if (!ch && picked) {
      var mm = el('p', 'bis-sum');
      mm.appendChild(el('b', null, picked.name));
      mm.appendChild(el('b', 'warn', '　是' + L.classLabel(picked.classFile, settings().learnedClassNames)
        + '，不是' + specLabel(s) + '所属职业 —— 没有拿他对照'));
      mm.appendChild(el('span', 'note',
        '　跨职业比装备算不出有意义的数（护甲类型和属性都不一样）。'
        + '换个下拉里没有 ≠ 标记的角色，或者切回他自己的专精。'));
      host.appendChild(mm);
    }

    if (ch) {
      var sum = el('p', 'bis-sum');
      sum.appendChild(el('b', null, ch.name));
      sum.appendChild(doc.createTextNode('　对上 ' + matched + ' 件，差 ' + missing + ' 件'
        + (unknown ? '，' + unknown + ' 个部位存档里没记录' : '') + '。'));
      sum.appendChild(el('span', 'note',
        '　「对上」= 身上这件正好在该部位的推荐列表里。装等更高的同名替代品不算。'));
      // ---- 装等差距汇总。「差 13 件」说不出**差多远**，这一行说。
      // 分母写出来：能比的只有 gapN 个部位（存档没记的、推荐件查不到装等的都比不了）。
      if (gapN) {
        var gsum = el('p', 'bis-sum gap-sum');
        var avg = Math.round(gapSum * 10 / gapN) / 10;
        var avgMine = Math.round(gapMine * 10 / gapN) / 10;
        var avgWant = Math.round(gapWant * 10 / gapN) / 10;
        gsum.appendChild(el('b', null, '装等对比'));
        // **两个原始平均值摆出来**，再给差值。只给「合计差 168」的话，那是个
        // 无法核对的数：分母是几个部位、两边各自多少，用户都看不见。
        gsum.appendChild(doc.createTextNode('　你 '));
        gsum.appendChild(el('b', 'iv-mine', String(avgMine)));
        gsum.appendChild(doc.createTextNode('　这套推荐 '));
        gsum.appendChild(el('b', 'iv-want', String(avgWant)));
        gsum.appendChild(doc.createTextNode('　（能比的 ' + gapN + ' 个部位的平均）'));
        gsum.appendChild(doc.createTextNode('　合计 '
          + (gapSum > 0 ? '差 ' + gapSum : gapSum < 0 ? '高 ' + (-gapSum) : '持平 0')
          + ' 装等，平均每件 ' + avg + '。'));
        if (gapWorst && gapWorst.d > 0) {
          gsum.appendChild(doc.createTextNode('　差最多的是'
            + (B.slotNames[gapWorst.slot] || ('部位 ' + gapWorst.slot))
            + ' ' + gapWorst.d + ' 点。'));
        }
        gsum.appendChild(el('span', 'note',
          '　比的是你身上这件和这个部位首选那一件。推荐件的装等取自本机两份实测数据'
          + '（见每一行的提示），是个参考量级。'));
        // **属性为什么只有一边。** 推荐件的属性有（下面每一行都印着），
        // 而你身上那件的属性**存档里没有** —— AlterEgo 存的是名字 / 装等 / 品质 /
        // 物品链接，没有属性字段；链接里的 bonusID 理论上能推出属性，但那要一张
        // bonusID→属性的对照表，本机没有，猜出来的属性比不给更糟。
        // 实测：身上 224 件里只有 52 件能在 GearInsight 的物品池里查到（23.2%），
        // 靠那个补等于四分之三的部位空着，界面上会像是数据坏了。
        // class 不能沿用 gap-sum —— 那个类被「每次对照渲染恰好一条汇总」
        // 那条断言数着，共用会让计数翻倍（写完第一版就被它抓了）。
        var stNote = el('p', 'bis-sum stat-note');
        stNote.appendChild(el('b', null, '属性'));
        stNote.appendChild(doc.createTextNode(
          '　推荐件的属性印在下面每一行上（暴击 / 急速 / 精通 / 全能），'
          + '你身上那件的属性存档里没有，所以这一栏只有一边。'));
        stNote.appendChild(el('span', 'note',
          '　想看这个专精该堆什么，展开上面的「属性目标」。'));
        stNote.setAttribute('data-tip',
          'AlterEgo 存的装备只有名字 / 装等 / 品质 / 物品链接，没有属性字段。\n'
          + '链接里的 bonusID 能推出属性，但要一张 bonusID→属性的对照表，本机没有。\n'
          + '拿随包那份物品池去查，身上 224 件只对上 52 件，四分之三的部位会空着。');
        host.insertBefore(stNote, list);
        host.insertBefore(gsum, list);
      }
      host.insertBefore(sum, list);
    }

    // 宝石 / 附魔同理，只有 GearInsight 有。
    if (!rs) host.appendChild(renderExtras(s));
    host.appendChild(renderFootnote(s));
  }

  /**
   * 专精那一行小字（毕业装等 / 英雄天赋 / 武器搭配）。
   *
   * kind 是当前看的是哪一篇 maxroll 指南（'raid' | 'mplus'），null = 不是 maxroll 视角。
   * **武器分布按它取**，而不是按 state.view —— 第 16 轮撤掉「团本视角」按钮之后
   * state.view 再也不会等于 'raid'，那个三元表达式于是恒取大秘境那一份，
   * 看团本指南的人会拿到大秘境的武器搭配，界面上分不出来。
   */
  function renderSpecMeta(s, kind) {
    var wrap = el('div', 'bis-meta');
    function cell(k, v, tip) {
      var c = el('span', 'mcell');
      c.appendChild(el('label', null, k));
      c.appendChild(el('b', null, v));
      if (tip) c.setAttribute('data-tip', tip);
      return c;
    }
    wrap.appendChild(cell('毕业装等', String(s.ilvl || '?'),
      '这个专精的毕业装等参照值，来自 WarcraftLogs 顶尖玩家的装备统计'));
    // heroName() 查表换中文。**不换的话装备页写 San'layn、天赋页写萨莱因** ——
    // 同一个英雄天赋在两页上是两个名字，用户会以为是两个东西。
    // 那张表是 app/talent-tree.js 里子树的暴雪 DB2 名，查不到就原样留英文。
    wrap.appendChild(cell('英雄天赋', s.hero ? heroName(s.hero) : '(无)',
      '这套推荐是按这个英雄天赋统计的'));

    var w = s.weapon && s.weapon[kind === 'raid' ? 'raid' : 'mplusHigh'];
    if (w) {
      var parts = Object.keys(w).sort(function (a, b) { return w[b] - w[a]; })
        .map(function (k) { return (WEAPON_ZH[k] || k) + ' ' + pct(w[k]); });
      if (parts.length) {
        wrap.appendChild(cell('武器', parts.join('　'),
          '顶尖玩家的武器搭配分布'));
      }
    }
    return wrap;
  }

  var WEAPON_ZH = {
    '2h': '双手', 'dualWield': '双持', '1hShield': '单手+盾',
    '1hOff': '单手+副手', 'ranged': '远程', 'titansGrip': '泰坦之握'
  };

  function renderStatTargets(s, kind, borrowed) {
    var B = bis();
    var wrap = el('details', 'sec bis-stats');
    var sum = el('summary', null, '属性目标');
    wrap.appendChild(sum);

    var which = kind === 'raid' ? 'raid' : 'high';
    var t = (s.target && s.target[which]) || {};
    var keys = ['crit', 'haste', 'mastery', 'versatility'];
    var total = 0;
    keys.forEach(function (k) { total += t[k] || 0; });
    if (!total) {
      wrap.appendChild(el('p', 'note', '这个专精没有属性目标数据。'));
      return wrap;
    }

    sum.textContent = '属性目标　' + keys.filter(function (k) { return t[k]; })
      .map(function (k) { return (B.statNames[k] || k) + ' ' + pct(t[k]); }).join('　');
    if (borrowed) {
      // 借来的数字必须自己说明是借来的，否则在「最佳推荐」这个标题下面，
      // 它看起来就是 maxroll 给的。
      //
      // 这句话原来有 40 多个字，塞在折叠标题那一行里会换行、把百分比顶下去。
      // 折叠标题应该一眼扫过，长解释放 tooltip。
      // 顺便修一处**说错的事实**：原来写「maxroll 的属性优先级写在正文里」——
      // 不对。第 19 轮实测过：那是页面里一串编码（data-wow-data），
      // 后端接口要 Discord 登录，用户实测 403。所以是「抓不到」，不是「在正文里」。
      var from = el('span', 'note', '　本机实测数据，非 maxroll');
      from.setAttribute('data-tip',
        '这一组是顶尖玩家的属性统计值（' + (kind === 'raid' ? '团本' : '大秘境')
        + '），来自本机两份实测数据，不是 maxroll 给的。\n'
        + 'maxroll 的属性优先级在页面里是一串编码，后端接口要登录且实测 403，'
        + '所以抓不到 —— 与其猜一个顺序，不如摆出这份能追溯的。');
      sum.appendChild(from);
    }

    var bars = el('div', 'bis-bars');
    keys.forEach(function (k) {
      if (!t[k]) return;
      var row = el('div', 'bar-row');
      row.appendChild(el('label', null, B.statNames[k] || k));
      var track = el('span', 'track');
      var fill = el('span', 'fill');
      fill.style.width = Math.min(100, (t[k] / total) * 100) + '%';
      fill.style.background = statColor(k);
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('b', null, pct(t[k])));
      bars.appendChild(row);
    });
    wrap.appendChild(bars);

    if (s.tol != null) {
      wrap.appendChild(el('p', 'note', '容差 ±' + s.tol + '%　'
        + '（属性达成度在这个范围内就算达标）'));
    }

    var weights = s.weights || {};
    var wk = Object.keys(weights);
    if (wk.length) {
      wrap.appendChild(el('p', 'note', '属性权重　' + wk.map(function (k) {
        return (B.statNames[k] || k) + ' ' + weights[k];
      }).join('　')));
    }
    return wrap;
  }

  function statColor(k) {
    var B = bis();
    var m = B.statMeta && B.statMeta[k];
    if (!m || !m.color) return 'var(--acc)';
    var c = m.color;
    function b(x) { return Math.round(Math.max(0, Math.min(1, x || 0)) * 255); }
    return 'rgb(' + b(c.r) + ',' + b(c.g) + ',' + b(c.b) + ')';
  }

  /**
   * 这个部位的装等差距：`{d 差几点（正 = 你低）, mine 你的, want 首选那件的, srcText 谁测的}`
   * 或 null（你没穿 / 存档没记 / 首选那件查不到装等）。
   *
   * **两边都得是真数字才算。** 缺一边就返回 null，界面上于是不画这个徽章 ——
   * 把缺的一边当 0 会算出「差 689 装等」这种数，比不画糟得多。
   */
  function slotGap(rows, mine) {
    if (!mine || !mine.itemLevel || !rows || !rows.length) return null;
    var top = rows[0];
    var want = top[1];
    if (!want) return null;
    var srcText = top[3] === -2
      ? (top[9] === 'r' ? 'raider.io 榜上均值' : '顶尖玩家实测最高')
      : (top[3] === -1 ? 'raider.io 榜上均值' : '顶尖玩家实测');
    return { d: Math.round(want - mine.itemLevel), mine: mine.itemLevel, want: want, srcText: srcText };
  }

  /**
   * 一个部位。sampleN 是**真实样本量**，只有 rio 视角给得出来。
   *
   * 这两种数据的诚实说法不一样，所以徽章分两种：
   *   · rio：直接显示 `N=97` —— 这是 G3 换数据源要解决的核心问题。
   *     BisData 一个样本量字段都没有（原始 Lua 就没有，不是转换时丢的），
   *     「81%」背后是 5 个人还是 500 个人查不到。
   *   · BisData：只能显示覆盖率（列出来那几件的使用率之和），并说明列表被截断了。
   *     本机实测 1264 个部位组里，覆盖率中位数只有 72.9%，206 组不到 50%。
   */
  function renderSlot(slotId, rows, mine, hit, sampleN) {
    var B = bis();
    var wrap = el('div', 'slot');

    var head = el('div', 'slot-head');
    head.appendChild(el('b', null, B.slotNames[slotId] || ('部位 ' + slotId)));

    var sum = 0;
    rows.forEach(function (r) { sum += (typeof r[2] === 'number' ? r[2] : 0); });
    sum = Math.round(sum * 10) / 10;

    // maxroll 的行认自己：来源下标 -2。判据放在数据上而不是外面传进来的参数上，
    // 是因为这个函数已经有 5 个参数了，再加一个「视角」很容易和 sampleN 打架。
    var mrRows = rows.length && rows[0][3] === -2;

    if (mrRows) {
      // **既没有样本量也没有覆盖率。** 上面那个 sum 在这里恒等于 0
      // （使用率全是 null），所以走原来那条分支会画出「记录 0.0%」——
      // 一个完全编出来的数字。这里改成报「几件首选 + 几件替代」，都是真的。
      var nBis = 0, nAlt = 0;
      rows.forEach(function (r) { if (r[8]) nAlt++; else nBis++; });
      var mb2 = el('span', 'tag cov mr', '首选 ' + nBis + (nAlt ? ' ・替代 ' + nAlt : ''));
      mb2.setAttribute('data-tip',
        'maxroll 这个部位给了 ' + nBis + ' 件首选'
        + (nAlt ? '、' + nAlt + ' 件可刷替代' : '') + '。\n'
        + '这份数据没有样本量也没有使用率 —— 它是编辑的推荐排序，不是统计。\n'
        + '想看「多少人真的这么穿」，切到「实战分布」视角。');
      head.appendChild(mb2);
    } else if (sampleN) {
      // 有真实样本量：显示 N，并按统计学的老规矩提醒 N 太小的时候别当结论。
      // 30 这个界不是我拍的 —— 比例统计在 N=100 时 95% 置信区间约 ±10%，
      // N<30 时宽到没法给结论，校验器里用的也是同一个界。
      // class 里带 sn（sample N）：run-tests.js 靠它区分两种徽章该用哪条格式断言。
      // 只留 cov 的话，「N=97」会被当成不合格的「记录 xx%」，或者反过来 ——
      // 两种文字共用一条正则，等于两边都验不住。
      var nb = el('span', 'tag cov sn' + (sampleN < 30 ? ' no' : ''), 'N=' + sampleN);
      nb.setAttribute('data-tip',
        '这个部位是从 ' + sampleN + ' 个玩家身上数出来的，列出了全部 '
        + rows.length + ' 种（百分比之和 ' + pct(sum) + '）。'
        + (sampleN < 30
          ? '\n样本不到 30，百分比只能当参考。'
          : '\n每个部位的样本量是各自算的 —— 有人没副手，各部位人数本来就不一样。'));
      head.appendChild(nb);
    } else {
      var cov = el('span', 'tag cov' + (sum < 50 ? ' no' : ''), '记录 ' + pct(sum));
      cov.setAttribute('data-tip',
        '这 ' + rows.length + ' 件加起来占顶尖玩家的 ' + pct(sum) + '。'
        + (sum < 99.5 ? '\n剩下的 ' + pct(Math.round((100 - sum) * 10) / 10)
                        + ' 穿的是什么，数据里没有。' : '')
        + '\n另外：这份数据不带样本量，所以百分比背后是几个人也查不到。'
        + '\n换到「实战分布」视角能看到真实样本量。');
      head.appendChild(cov);
    }

    if (mine) {
      var m = el('span', 'mine' + (hit ? ' ok' : ''));
      m.appendChild(doc.createTextNode(hit ? '✓ ' : '· '));
      var nm = el('span', null, mine.name || '(未知)');
      if (mine.quality != null && L.qualityColors[mine.quality]) {
        nm.style.color = L.qualityColors[mine.quality];
      }
      m.appendChild(nm);
      if (mine.itemLevel) m.appendChild(el('span', 'sub', ' ' + mine.itemLevel));
      m.setAttribute('data-tip', hit
        ? '你身上这件就在推荐列表里'
        : '你身上这件不在推荐列表里');
      head.appendChild(m);

      // ---- 装等差距。「对上 / 没对上」只说了款式，说不了**差多远** ——
      // 身上这件正好是推荐的第 3 选择、装等却低 20，界面上和「完全穿对了」长得一样。
      // 判据用这个部位**首选那一件**的装等（rows[0]），因为那是「换到最好」要走的距离。
      var gap = slotGap(rows, mine);
      if (gap) {
        // 徽章上**同时给出两个原始装等**，不只给差值。
        // 只给「差 14」的话，那个数要靠悬停提示才能核对，而这一格恰恰是用户
        // 做决定要看的（换不换这个部位）—— 关键数字不该藏在鼠标后面。
        var gb = el('span', 'tag gap' + (gap.d > 0 ? ' behind' : (gap.d < 0 ? ' ahead' : ' even')),
          gap.mine + ' → ' + gap.want + '　'
          + (gap.d > 0 ? '差 ' + gap.d : (gap.d < 0 ? '高 ' + (-gap.d) : '持平')));
        gb.setAttribute('data-tip',
          '你 ' + gap.mine + '　首选那件 ' + gap.want + '（' + gap.srcText + '）\n'
          + (gap.d > 0 ? '换上去等于这个部位 +' + gap.d + ' 装等'
            : gap.d < 0 ? '你这件装等更高 —— 但款式不是推荐的那件，属性搭配可能不一样'
              : '装等一样'));
        head.appendChild(gb);
      }
    } else if (currentChar()) {
      // 不能写「空着」——AlterEgo 的 equipment 是稀疏的，这里分不出
      // 「真没穿」和「插件没记这个部位」。本机实测有角色只存了 7 个部位。
      var e = el('span', 'mine empty', '· 存档里没这个部位');
      e.setAttribute('data-tip',
        'AlterEgo 只记它抓到的部位，缺格子不代表你没穿。登录一次那个角色就会补上');
      head.appendChild(e);
    }
    wrap.appendChild(head);

    rows.forEach(function (r, i) {
      wrap.appendChild(renderItem(r, i === 0, mine));
    });
    return wrap;
  }

  // 部位条目：[itemId, ilvl, 使用率, 来源下标, 可升级上限, 轨道码]
  // 后两位可能被生成器省掉（末尾的 0 会被去掉），但不会跳着省。
  //
  // **rio 视角多一位**：`[…, 轨道码, 人数]`，而且来源下标固定是 **-1**。
  // 用 -1 当标记而不是 undefined，是为了让「rio 的行」和「BisData 里来源下标为 0
  // 的行」区分得开 —— 0 是一个合法下标（srcs[0] 是真的来源），拿假值判断会把它吞掉。
  function renderItem(r, isTop, mine) {
    var B = bis();
    var itemId = r[0], ilvl = r[1], usage = r[2], srcIdx = r[3], mx = r[4], trk = r[5];
    var isRio = srcIdx === -1, people = r[6];
    // maxroll 视角：来源下标 -2，使用率恒为 null（它不是统计，没有这个量），
    // 第 7 位是名次，第 8 位标它是不是「可刷替代」。
    var isMr = srcIdx === -2, rank = r[7], isAlt = r[8], ivSrc = r[9] || '';

    // 物品元数据两边都有，但**各有各的洞**，所以按视角取，取不到再退到另一边：
    //   · rio 自带中文名 / 图标名 / 品质（2432 件，实测中文名 100%）；
    //   · BisData 只有中文名 + 属性，图标和品质要另查 app/item-icons.js。
    // 实测两边都有的 497 件里，品质一致 494（99.4%）、图标名一致 496（99.8%），
    // 所以混用不会打架；不一致的那几件按当前视角自己的数据显示。
    // maxroll 的物品池也自带中文名 / 图标名 / 品质（36 件 rio 里没有的从 DB2 补过），
    // 所以它和 rio 走同一条路：优先用自己那份，缺了再退到 BisData。
    var ri = isRio ? rioItem(itemId) : (isMr ? mrItem(itemId) : null);
    var it = B.items[itemId] || {};
    var src = (isRio || isMr) ? [] : (B.srcs[srcIdx] || []);
    var srcText = src[0] || '', cat = src[1] || '', boss = src[2] || '';

    var row = el('div', 'item' + (isTop ? ' top' : ''));
    if (mine && mine.itemId === itemId) row.classList.add('have');

    // 图标：包里有图就出图，没有就出一个占位块。
    // rio 的物品自带图标名，所以这里把它当 fallback 传进去 —— app/item-icons.js
    // 只覆盖了 rio 物品的 20.4%（497/2432），不传的话大部分行都会是占位块。
    var icon = el('span', 'icon');
    var img = iconImg(itemId, 24, ri ? ri.i : '');
    if (img) {
      icon.appendChild(img);
    } else {
      icon.classList.add('ph');
      icon.style.borderColor = catColor(cat);
      icon.textContent = CAT_GLYPH[cat] || '?';
    }
    row.appendChild(icon);

    var main = el('span', 'im');
    var name = el('b', null, (ri && ri.n) || it.n || ('物品 ' + itemId));
    // 品质：rio 自带 q；BisData 没有这个字段，要查 app/item-icons.js。
    // 查不到就不上色，而不是默认紫色 —— 默认紫会把蓝色附魔和白色合剂都染错。
    var q = ri && ri.q != null ? ri.q : itemQuality(itemId);
    if (q != null && L.qualityColors[q]) name.style.color = L.qualityColors[q];
    main.appendChild(name);

    // 插槽标记。这是 B6 卡了很久的东西：BisData 只存 bonusIDs，要判断「这件有没有
    // 插槽」得拿 raidbots 的 116 个插槽 bonusID 清单去比。rio 的 profile 直接给
    // bonuses，生成器已经解成 sock（实测 494 件带插槽），所以这里白拿。
    if (ri && ri.sock) {
      var sk = el('span', 'tag sock', ri.sock > 1 ? '插槽 ×' + ri.sock : '插槽');
      sk.setAttribute('data-tip', '这件装备带 ' + ri.sock + ' 个插槽'
        + '（从 raider.io 给的 bonusID 解出来的）');
      main.appendChild(sk);
    }

    // 装等。**0 不能印出来** —— 上一版直接 String(ilvl)，maxroll 视角每一行
    // 都写着「0」，因为那时候装等是从 rio 的物品池里取 ri.ilvl，而那个字段
    // 根本不存在（物品池只有 {n, i, q, sock}）。现在装等从 measuredGear() 来，
    // 真查不到就**什么都不写**，而不是写一个 0 让人以为这件装备装等是 0。
    if (ilvl) {
      var sub = el('span', 'sub2');
      sub.textContent = String(ilvl) + (mx && mx > ilvl ? '→' + mx : '');
      if (isMr) {
        // maxroll 视角的装等是借来的，得说清是谁测的 —— 两个来源不是同一个量。
        sub.classList.add(ivSrc === 'r' ? 'iv-rio' : 'iv-gi');
        sub.setAttribute('data-tip', ivSrc === 'r'
          ? '装等 ' + ilvl + '：maxroll 不给装等，这是 raider.io 榜上玩家'
            + '穿这件时的「平均」装等'
          : '装等 ' + ilvl + '：maxroll 不给装等，这是顶尖玩家身上'
            + '这件的「最高」装等'
            + (mx && mx > ilvl ? '，还能升到 ' + mx : ''));
      }
      main.appendChild(sub);
    } else if (isMr) {
      var noiv = el('span', 'sub2 iv-none', '装等 ?');
      noiv.setAttribute('data-tip',
        'maxroll 不给装等，而这一件在本机两份实测数据里都没出现'
        + '（实测 1358 次引用里有 6 次这样）—— 所以这里不填，不猜一个数字上去');
      main.appendChild(noiv);
    }

    var tl = trackLabel(trk);
    if (tl) {
      var tb = el('span', 'tag trk', tl);
      tb.setAttribute('data-tip', '升级轨道，从装备的 bonusID 解出来的\n'
        + '（' + tl + ' = 这条轨道的第 ' + (trk % 10) + ' 级，满级 6 级）'
        + (isMr ? '\nmaxroll 不给轨道，这一条和左边的装等出自同一次测量' : ''));
      main.appendChild(tb);
    }

    if (it.st) {
      var sp = el('span', 'stats');
      Object.keys(it.st).forEach(function (k) {
        var t = el('span', null, (B.statNames[k] || k) + ' ' + it.st[k]);
        t.style.color = statColor(k);
        sp.appendChild(t);
      });
      main.appendChild(sp);
    }
    if (it.h) main.appendChild(el('span', 'sub', WEAPON_ZH[it.h] || it.h));
    if (it.u) {
      var ou = el('span', 'tag use', '使用');
      ou.setAttribute('data-tip', '带使用效果');
      main.appendChild(ou);
    }
    row.appendChild(main);

    // 来源徽章。**rio 没有掉落来源**（profile 只说角色身上穿着什么，不说哪掉的），
    // 所以这里不能编一个「其他」出来 —— 那会让人以为查过了。写「?」并在提示里说清。
    if (!isRio && !isMr) {
      var badge = el('span', 'tag', B.sourceCategories[cat] || cat || '?');
      badge.style.borderColor = catColor(cat);
      badge.style.color = catColor(cat);
      badge.setAttribute('data-tip', srcText || '来源未知');
      row.appendChild(badge);
    }

    if (isMr) {
      // **不画使用率条。** maxroll 没有这个量，画出来的任何宽度都是我编的。
      // 画名次 + 它出自哪张表，这两个都是数据里真有的东西。
      var mb = el('span', 'usage rank');
      var tag = el('span', 'tag ' + (isAlt ? 'alt' : 'bis'),
        (isAlt ? '替代 #' : 'BiS #') + rank);
      tag.setAttribute('data-tip', isAlt
        ? 'maxroll 的「可刷替代」表里排第 ' + rank + '（拿得到的退而求其次的选择）'
        : 'maxroll 的「Best in Slot」表里排第 ' + rank + '（编辑给的首选）');
      mb.appendChild(tag);
      row.appendChild(mb);
    } else {
      var u = el('span', 'usage');
      var track = el('span', 'track');
      var fill = el('span', 'fill');
      fill.style.width = Math.max(2, Math.min(100, usage)) + '%';
      track.appendChild(fill);
      u.appendChild(track);
      u.appendChild(el('span', 'n', pct(usage)));
      // rio 的提示带**分子分母**：「12/97 人」比「12.4%」可查证得多，
      // 而这正是换数据源的理由 —— BisData 那边只能给一个没有分母的百分比。
      u.setAttribute('data-tip', isRio
        ? (people != null ? people + '/' + Math.round(people * 100 / usage) + ' 人这个部位用它'
                          : pct(usage) + ' 的人这个部位用它')
        : '顶尖玩家里有 ' + pct(usage) + ' 的人这个部位用它'
          + (boss ? '\n掉落：' + boss : '')
          + (srcText ? '\n' + srcText : ''));
      row.appendChild(u);
    }

    row.setAttribute('data-tip', ((ri && ri.n) || it.n || '') + '\nitemID ' + itemId
      + (ilvl ? '\n' + (isRio ? '平均装等 ' : '装等 ') + ilvl : '')
      + (mx && mx > ilvl ? '（可升到 ' + mx + '）' : '')
      + (isRio || isMr ? '' : '\n' + (srcText || '来源未知'))
      // maxroll 那行故意不写「使用率」——它没有这个数，写了就是编。
      + (isMr
        ? '\nmaxroll ' + (isAlt ? '可刷替代' : 'Best in Slot') + ' 第 ' + rank
          + '\n这是编辑给的推荐排序，不是使用率统计'
        : '\n使用率 ' + pct(usage)
          + (isRio && people != null ? '（' + people + ' 人）' : '')));
    return row;
  }

  var CAT_GLYPH = {
    raid: '团', mplus: '钥', crafted: '造', tier: '套',
    world: '世', other: '其', delve: '堡'
  };

  function catColor(cat) {
    switch (cat) {
      case 'raid': return '#ff8000';
      case 'mplus': return '#a335ee';
      case 'crafted': return '#1eff00';
      case 'tier': return '#00ccff';
      case 'world': return '#ffd100';
      default: return 'var(--fg2)';
    }
  }

  function renderExtras(s) {
    var B = bis();
    var wrap = el('div', 'bis-extras');

    if (s.gems && s.gems.length) {
      var g = el('details', 'sec');
      g.appendChild(el('summary', null, '宝石　' + s.gems.length + ' 种'));
      var gl = el('div', 'chips');
      s.gems.forEach(function (row) {
        var c = el('span', 'chip');
        var gi = iconImg(row[0], 16);
        if (gi) c.appendChild(gi);
        var gn = el('b', null, row[1] || ('宝石 ' + row[0]));
        var gq = itemQuality(row[0]);
        if (gq != null && L.qualityColors[gq]) gn.style.color = L.qualityColors[gq];
        c.appendChild(gn);
        c.appendChild(el('span', 'n', pct(row[2])));
        c.setAttribute('data-tip', 'itemID ' + row[0] + '　使用率 ' + pct(row[2]));
        gl.appendChild(c);
      });
      g.appendChild(gl);
      wrap.appendChild(g);
    }

    var ek = Object.keys(s.ench || {});
    if (ek.length) {
      var e = el('details', 'sec');
      e.appendChild(el('summary', null, '附魔　' + ek.length + ' 个部位'));
      var et = el('div', 'ench');
      SLOT_ORDER.forEach(function (slotId) {
        var list = s.ench[slotId];
        if (!list || !list.length) return;
        var row = el('div', 'ench-row');
        row.appendChild(el('label', null, B.slotNames[slotId] || ('部位 ' + slotId)));
        var box = el('span', 'chips');
        list.forEach(function (en) {
          var c = el('span', 'chip');
          // en[3] 是附魔卷轴的 itemId；图标查的是它，不是附魔 ID。
          var ei = en[3] ? iconImg(en[3], 16) : null;
          if (ei) c.appendChild(ei);
          var en2 = el('b', null, en[1] || ('附魔 ' + en[0]));
          var eq = en[3] ? itemQuality(en[3]) : null;
          if (eq != null && L.qualityColors[eq]) en2.style.color = L.qualityColors[eq];
          c.appendChild(en2);
          c.appendChild(el('span', 'n', pct(en[2])));
          c.setAttribute('data-tip', '附魔 ID ' + en[0]
            + (en[3] ? '　卷轴 itemID ' + en[3] : '')
            + '　使用率 ' + pct(en[2]));
          box.appendChild(c);
        });
        row.appendChild(box);
        et.appendChild(row);
      });
      e.appendChild(et);
      wrap.appendChild(e);
    }

    if (B.consumables && B.consumables.length) {
      var c2 = el('details', 'sec');
      c2.appendChild(el('summary', null, '消耗品　' + B.consumables.length + ' 种（所有专精通用）'));
      var groups = {};
      B.consumables.forEach(function (it) {
        (groups[it.kind || '其他'] = groups[it.kind || '其他'] || []).push(it);
      });
      Object.keys(groups).forEach(function (kind) {
        var row = el('div', 'ench-row');
        row.appendChild(el('label', null, kind));
        var box = el('span', 'chips');
        groups[kind].forEach(function (it) {
          var chip = el('span', 'chip');
          // 优先按 itemId 查（那是 app/icons/ 里真有的文件名）。BisData 自带的
          // it.icon 是插件在游戏里用的名字，和图床上的名字**不一样** ——
          // 本机 35 个消耗品实测 35 个全不一致，所以它只能当兜底。
          var ci = iconImg(it.id, 16, it.icon);
          if (ci) chip.appendChild(ci);
          var cn = el('b', null, it.n);
          var cq = itemQuality(it.id);
          if (cq != null && L.qualityColors[cq]) cn.style.color = L.qualityColors[cq];
          chip.appendChild(cn);
          if (it.stat) {
            var st = el('span', 'n', B.statNames[it.stat] || it.stat);
            st.style.color = statColor(it.stat);
            chip.appendChild(st);
          }
          chip.setAttribute('data-tip', 'itemID ' + it.id
            + (it.icon ? '\n图标 ' + it.icon : ''));
          box.appendChild(chip);
        });
        row.appendChild(box);
        c2.appendChild(row);
      });
      wrap.appendChild(c2);
    }
    return wrap;
  }

  /**
   * 脚注。**按视角说来源**，不混成一句。
   *
   * 两份数据来路完全不同（一份是插件里的参照表，一份是我自己抓的排行榜），
   * 日期、范围、缺什么都不一样。以前这里硬写「数据来自 GearInsight」，
   * 换到 rio 视角后那句话就成了假话。
   */
  function renderFootnote(s) {
    var B = bis();
    var p = el('p', 'note bis-foot');
    // 用**这次真正渲染的视角**，不是 state.view —— 首屏 maxroll 还没加载时
    // 画的是 mplus，脚注要跟着说 mplus 那份数据的事。
    var view = s ? effectiveView(s) : state.view;
    var rs = view === 'rio' && s ? rioSpec(s.specId) : null;
    var mr = view === 'maxroll' && s ? mrPick(s.specId) : null;

    if (mr) {
      var M = maxroll();
      p.appendChild(doc.createTextNode(
        '数据来自 ' + ((M && M.source) || 'maxroll.gg') + '，'
        + '抓取日期 ' + ((M && M.updatedAt) || '?') + '，'
        + '这个专精用的是' + (mr.kind === 'mplus' ? '大秘境' : '团本') + '指南（'
        + (mr.v.slug || '?') + '）。'));
      p.appendChild(el('br'));
      // 界面上没有百分比，得说一句为什么，否则看起来像数据缺了。
      p.appendChild(doc.createTextNode(
        '这是编辑的推荐排序，不是使用率统计，所以只有名次没有百分比。'
        + '想看多少人这么穿，切到「实战分布」。'));
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '装等来自本机两份实测数据（maxroll 的表里没有），每行的装等上写着是谁测的。'
        + '物品中文名来自暴雪 DB2。'));
      return p;
    }

    if (rs) {
      var R = rio();
      p.appendChild(doc.createTextNode(
        '数据来自 ' + ((R && R.source) || 'raider.io') + '，'
        + '抓取日期 ' + ((R && R.updatedAt) || '?') + '，赛季 ' + ((R && R.season) || '?') + '。'
        + '这个专精统计了 ' + (rs.nGear || 0) + ' 个角色的实际装备'
        + (rs.n && rs.n !== rs.nGear ? '（榜上 ' + rs.n + ' 人，其中 ' + rs.nGear + ' 人拿到了装备）' : '')
        + '。'));
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '百分比 = 该部位穿这件的人数 / 该部位样本量，不截断，所以一个部位加起来是 100%。'
        + '物品中文名来自暴雪 DB2（' + ((R && R.itemNameSource) || '?') + '）。'));
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '属性权重 / 宝石 / 附魔 / 掉落来源在「最佳推荐」里，raider.io 的角色档案没有这些。'));
      return p;
    }

    p.appendChild(doc.createTextNode(
      '随包的静态参照表（' + (B.source || '未知来源') + '），'
      + '统计日期 ' + (B.updatedAt || '?') + '，表版本 ' + (B.addonVersion || '?') + '。'));
    p.appendChild(el('br'));
    p.appendChild(doc.createTextNode(
      '这是顶尖玩家实际在用什么的统计，不是模拟器的理论最优。使用率低也可能只是难拿。'));
    if (!global.AE_ITEM_ICONS) {
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '数据里只有 itemID 没有图标名，配置图标源后才会出图，现在是按来源上色的占位块。'));
    }
    return p;
  }

  // ------------------------------------------------------------ 天赋页

  function ensureTalents(done) {
    if (talLoaded) { done(); return; }
    if (talLoading) return;
    talLoading = true;
    setSub('正在加载天赋数据…');
    // maxroll 的方案也是天赋页要用的（第 15 轮：天赋按 maxroll 来）。
    // 它自己带回调重画，所以这里只是**触发**，不等它 —— 等它的话
    // 天赋页会为了一份可选数据多空一会儿。
    ensureMaxroll();
    // 团本天赋串（第 20 轮）。同上，只触发不等。
    ensureWcl();
    loadDataFile('talent-data.js', 'AE_TALENTS', function (err) {
      if (err && AE.toast) AE.toast(err, 'warn');
      // 树结构是另一个文件（app/talent-tree.js，约 415 KB）。
      // 以前它是**可选的**：加载不到就退回「只有统计、没有树」。
      // 现在 maxroll 那条路要靠它解串，所以加载不到就只剩插件那份统计 ——
      // 仍然不当错误（面板照样能用），但那时 renderTalents 会走 popular 那条。
      if (global.AE_TALENT_TREE) { talLoading = false; talLoaded = true; done(); return; }
      loadDataFile('talent-tree.js', 'AE_TALENT_TREE', function () {
        talLoading = false;
        talLoaded = true;
        done();
        // 天赋说明文字（app/talent-desc.js，约 506 KB）**在树画完之后才拉**：
        // 它只喂悬停提示，不影响任何布局，所以不该让树多等它半秒。
        // 拉到了重画一次，提示里就有说明了；拉不到就一直只有名字。
        ensureTalentDesc();
      });
    });
  }

  /**
   * 天赋说明文字。挂在天赋树每个节点的悬停提示上（见 renderTreeGrid）。
   *
   * 单独一个文件、单独一次懒加载，理由是它**纯粹是锦上添花**：
   * 506 KB 只为了鼠标停下来那一刻多几行字。跟 talent-tree.js 绑在一起加载的话，
   * 天赋页第一次打开要多等它 —— 而树本身不需要它就能画。
   */
  var descLoading = false, descLoaded = false;
  function ensureTalentDesc() {
    if (descLoaded || descLoading) return;
    if (global.AE_TALENT_DESC) { descLoaded = true; return; }
    descLoading = true;
    loadDataFile('talent-desc.js', 'AE_TALENT_DESC', function () {
      descLoading = false;
      descLoaded = true;
      // 拉到了就重画，让已经画出来的那些节点也带上说明。
      // 拉不到也走这条 —— render() 是幂等的，而且提示里少一段说明不算错。
      if (global.AE_TALENT_DESC) render();
    });
  }

  /** 一个 entry 的说明文字，没有就返回空串（**不猜、不兜底**）。 */
  function talentDesc(spellId) {
    if (!spellId) return '';
    var D = global.AE_TALENT_DESC;
    return (D && D.desc && D.desc[spellId]) || '';
  }

  var TCAT = [['raid', '团本'], ['mplusHigh', '冲分'], ['mplusFarm', '割草']];

  /**
   * maxroll 的天赋方案。
   *
   * 产物形状：specs[specId].views[raid|mplus].talents = [{n 方案名, s 导入串,
   * p 点数, h [英雄子树id…]}…]。串是**原样**的（生成器只把 URL-safe base64 换成
   * 标准表），点数和英雄子树是生成时**声明**的 —— 这里解出来的必须和声明一致，
   * 不一致由 tools/verify-maxroll-data.js 判红，面板不负责发现这种事。
   */
  function mrTalents(specId, kind) {
    var v = mrView(specId, kind);
    var list = v && v.talents;
    return (list && list.length) ? list : null;
  }

  /** 这个专精有天赋方案的类型，大秘境在前（面板别处也是以大秘境为主）。 */
  function mrTalentKinds(specId) {
    return ['mplus', 'raid'].filter(function (k) { return mrTalents(specId, k); });
  }

  /**
   * 这次要画哪一套 maxroll 天赋。返回 null = 这个专精没有（实测 3 个：
   * 战士武器、德鲁伊平衡、武僧织雾 —— 它们的串全是照着上一版天赋树编的，
   * 一条都解不开，所以生成器一条都没收）。
   *
   * 下标越界一律**自纠正**回 0，不报错：state.mrKind / mrBuild 不持久化，
   * 但同一次会话里换专精之后旧下标就可能指向不存在的方案。
   */
  function mrTalentPick(specId) {
    var kinds = mrTalentKinds(specId);
    if (!kinds.length) return null;
    var kind = kinds.indexOf(state.mrKind) >= 0 ? state.mrKind : kinds[0];
    var list = mrTalents(specId, kind);
    var i = state.mrBuild;
    if (!(i >= 0) || i >= list.length) i = 0;
    // v 是**整个视角对象**，不只是 talents 数组 —— 出手顺序（prio）和
    // 首领说明（boss）挂在视角上，不在单套方案里。
    return { kinds: kinds, kind: kind, list: list, idx: i, build: list[i],
      v: mrView(specId, kind) || {} };
  }

  /**
   * 把一套方案的点数按英雄树拆开：{base 职业树+专精树, per {子树id: 点数}}。
   *
   * 为什么需要这个：maxroll 有「一套方案打包两条英雄天赋」的（实测去重后 167 套
   * 里 82 套），产物里声明的 p 是两条**加在一起**的（95 = 68 + 13 + 13）。
   * 游戏里一个角色只能选一条，所以 95 这个数字在游戏里配不出来 —— 列表上直接
   * 印 95，就是在给用户一个他永远点不出来的点数。界面上要印的是「选一条之后
   * 真实的总点数」。
   *
   * 白给的节点（out.granted）不算点数，和 app/talent-decode.js 里 out.pts 同一个
   * 判据；否则 82 点会变成 90 多，和游戏里对不上。解不开返回 null。
   */
  function mrSplit(out) {
    var TR = tree();
    if (!TR || !out || out.err || !out.nr) return null;
    var base = 0, per = {};
    Object.keys(out.nr).forEach(function (id) {
      if (out.granted && out.granted[id]) return;
      var row = TR.nodes[id];
      var sub = row && row[6];
      var r = out.nr[id].rank || 0;
      if (sub) per[sub] = (per[sub] || 0) + r;
      else base += r;
    });
    return { base: base, per: per };
  }

  /**
   * 一套方案在界面上该印的点数：选一条英雄树之后真实的总点数。
   * 两条英雄树点数不一样时印两个数（实测都是 13/13，所以基本只会印一个）。
   * 解不开就退回产物声明的 p —— 那时树也画不出来，界面上有单独的警告。
   */
  function mrPtsText(t) {
    var dec = AE.TalentDecode, TR = tree(), o = null;
    if (dec && TR) {
      try { o = dec.decode(t.s, TR); } catch (e) { o = null; }
    }
    var sp = mrSplit(o);
    if (!sp) return t.p + ' 点';
    var seen = {}, vals = [];
    ((t.h && t.h.length) ? t.h : [0]).forEach(function (sid) {
      var v = sp.base + (sp.per[sid] || 0);
      if (!seen[v]) { seen[v] = 1; vals.push(v); }
    });
    return vals.length ? vals.join(' / ') + ' 点' : t.p + ' 点';
  }

  /**
   * 方案列表的短名。**这一组名字唯一的区别在中间**，两头全是重复的。
   *
   * 实测（167 套）：maxroll 的方案名中位 45 字符、最长 72，而一个专精一个类型
   * 下的 9~10 行长这样 ——
   *   Marksmanship Hunter Nek'zali Raid Talents
   *   Marksmanship Hunter Entombed Sentinels Raid Talents
   *   Marksmanship Hunter Vashnik Raid Talents
   * 而它们的点数、英雄天赋标签**全都一样**（都是 82 点 / 同一条英雄树），
   * 于是每一行看上去完全相同，唯一的区别是夹在两段重复短语中间的首领名。
   * 用户要在这十行里选一行，靠的正是那个词。
   *
   * 做法：**按组内词频删共有词**，不写死词表。「Marksmanship」「Hunter」
   * 「Raid」「Talents」这些在组里几乎每行都出现，删掉；剩下的就是那一行
   * 自己的东西。阈值取 2/3（实测中位 45 → 16 字符）：
   *   · 取 1（必须每行都有）漏得掉 —— maxroll 自己有错别字，
   *     「Destruction WarlockTwin Fangs」少一个空格，Warlock 就不再是「每行都有」，
   *     于是整组的 Warlock 一个都删不掉；
   *   · 取 1/2 反而更差（29 组退回全名）—— 半数以上的行会被删到撞车。
   *
   * **删完必须仍然两两不同**，否则整组退回全名：把两行不同的方案显示成同一个
   * 名字，比名字长得多要糟 —— 用户会以为面板重复列了同一套。
   * 全名不丢，挂在 data-tip 上。
   */
  function mrShortNames(list) {
    var full = list.map(function (t) { return t.n || '（这套没写名字）'; });
    if (list.length < 2) return full;
    var cnt = {};
    full.forEach(function (n) {
      var seen = {};
      mrWords(n).forEach(function (w) {
        var k = w.toLowerCase();
        if (!seen[k]) { seen[k] = 1; cnt[k] = (cnt[k] || 0) + 1; }
      });
    });
    var need = Math.ceil(list.length * 2 / 3);
    var out = full.map(function (n) {
      var kept = mrWords(n).filter(function (w) { return cnt[w.toLowerCase()] < need; });
      return kept.length ? kept.join(' ') : null;
    });
    var seen2 = {}, ok = true;
    out.forEach(function (s) {
      if (!s) { ok = false; return; }
      var k = s.toLowerCase();
      if (seen2[k]) ok = false;
      seen2[k] = 1;
    });
    return mrUniqNames(ok ? out : full, list);
  }

  /**
   * 把重名的行改成能分辨的。
   *
   * 为什么需要这一步：**上游自己就有重名**，缩名之前就有，退回全名也躲不掉
   * （实测 167 套里）：
   *   · 13 套**压根没有名字** —— 全都显示「（这套没写名字）」，一个专精能连着三行；
   *   · 4 组不同的串**共用一个名字**，例如冰法团本有两行都叫
   *     「Spellslinger Frost Mage cleave talents in Raids」（一条标 cleave、
   *     一条标 aoe），而元素萨有两行同名却是 75 点和 81 点两套不同的树。
   * 两行印着同一个名字，用户点哪一行都不知道自己点的是什么 —— 而这不是
   * 显示的错，是数据本来就没给出区别。面板能做的是**把区别找出来印上**。
   *
   * 找区别的顺序，按「对用户有多少意义」排：
   *   ① 场景（单体 / AOE / 顺劈 / 多目标）—— maxroll 自己标的，最能说明差别；
   *   ② 英雄天赋名 —— 中文，来自天赋树；
   *   ③ 点数 —— 元素萨那两行真正的区别就是它（75 vs 81）；
   *   ④ 「第 N 套」—— 兜底。前三样都一样时只剩顺序，硬编一个也比两行同名好：
   *      顺序至少和列表上下一致，用户能对上。
   * 只给重名的行加后缀，没重名的一个字都不动。
   */
  function mrUniqNames(names, list) {
    var cnt = {};
    names.forEach(function (n) {
      var k = String(n).toLowerCase();
      cnt[k] = (cnt[k] || 0) + 1;
    });
    var dup = false;
    Object.keys(cnt).forEach(function (k) { if (cnt[k] > 1) dup = true; });
    if (!dup) return names;

    return names.map(function (n, i) {
      if (cnt[String(n).toLowerCase()] < 2) return n;
      var t = list[i] || {};
      var tags = [];
      var sc = t.sc && t.sc.length ? t.sc[0] : null;
      if (sc && SCEN_ZH[sc]) tags.push(SCEN_ZH[sc]);
      if (t.h && t.h.length === 1) {
        var hn = subTreeName(t.h[0]);
        if (hn) tags.push(hn);
      }
      var pts = mrPtsText(t);
      if (pts) tags.push(pts);
      tags.push('第 ' + (i + 1) + ' 套');
      // 逐个往上加，直到这一行和别人不一样了。加到「第 N 套」必然唯一。
      for (var k = 1; k <= tags.length; k++) {
        var cand = n + '（' + tags.slice(0, k).join(' · ') + '）';
        var clash = false;
        names.forEach(function (m, j) {
          if (j !== i && String(m).toLowerCase() === String(cand).toLowerCase()) clash = true;
        });
        if (!clash && k === tags.length) return cand;
        if (!clash) {
          // 还要保证别的重名行加同样多的标签之后不会撞上来
          var same = false;
          names.forEach(function (m, j) {
            if (j === i || cnt[String(m).toLowerCase()] < 2) return;
            if (String(m).toLowerCase() !== String(n).toLowerCase()) return;
            var t2 = list[j] || {};
            var tg2 = [];
            var sc2 = t2.sc && t2.sc.length ? t2.sc[0] : null;
            if (sc2 && SCEN_ZH[sc2]) tg2.push(SCEN_ZH[sc2]);
            if (t2.h && t2.h.length === 1) {
              var hn2 = subTreeName(t2.h[0]);
              if (hn2) tg2.push(hn2);
            }
            var p2 = mrPtsText(t2);
            if (p2) tg2.push(p2);
            tg2.push('第 ' + (j + 1) + ' 套');
            if (tg2.slice(0, k).join(' · ') === tags.slice(0, k).join(' · ')) same = true;
          });
          if (!same) return cand;
        }
      }
      return n + '（第 ' + (i + 1) + ' 套）';
    });
  }

  function mrWords(n) {
    return String(n).split(/[^A-Za-z0-9']+/).filter(Boolean);
  }

  function renderTalents(host) {
    var s = currentSpec();
    if (!s) return;

    // maxroll 优先 —— 第 15 轮定的：天赋页也按 maxroll 来。
    // 它需要两份数据：maxroll 的方案（懒加载）和天赋树（画树用，也是懒加载）。
    // 两份都在才走这条路，否则退回插件那份统计。
    var pick = tree() ? mrTalentPick(s.specId) : null;
    if (pick) { renderMrTalents(host, s, pick); return; }

    // **还在加载就说「在加载」，不要先画一版插件那份统计。**
    //
    // 这两条路画出来的东西**完全不一样**（一边是方案列表 + 三棵树 + 说明，
    // 一边是「热门套路 + 点数分布」）。先画插件那份、等 maxroll 到了再
    // render() 一次的话，用户正在读的整页会在他眼前换掉 ——
    // 他刚点开的折叠块、刚选中的套路全没了。maxroll 那份现在 284 KB，
    // 这个空档是看得见的。
    //
    // 加载**失败**时不留在这个状态：ensureMaxroll 无论成败都会置 mrLoaded,
    // 那时这个分支不成立，自然落到下面插件那条路。
    if (mrLoading || (!mrLoaded && !maxroll())) {
      var wait = el('p', 'note', '正在加载 maxroll 的天赋方案…');
      wait.appendChild(el('span', 'note',
        '　加载不到的话会退回插件自带的天赋统计，功能不受影响。'));
      host.appendChild(wait);
      return;
    }

    renderPopularTalents(host, s);
  }

  /**
   * maxroll 天赋页。
   *
   * 和插件那份统计最大的差别是**选择的粒度**：那边只有「团本 / 冲分 / 割草」
   * 三个笼统类别，选完还要在一堆「#3·5人」里猜；maxroll 每套方案自带名字
   * （「Sunfury Arcane Mage Mythic+ Build in Altar of Fangs」），一眼能选。
   * 方案名**原样显示英文** —— 那是从页面上取下来的字符串，翻译它就得自己编词。
   */
  function renderMrTalents(host, s, pick) {
    var M = maxroll();
    var b = pick.build;
    var dec = AE.TalentDecode;
    var out = dec ? dec.decode(b.s, tree()) : { err: '天赋解码器没加载（app/talent-decode.js）' };

    // 标题（setTitle）在天赋页已经写着「天赋」，副标题**不要再写一遍** ——
    // 两个拼在一起是「天赋　天赋　鲜血　maxroll.gg …」，同一个词连着两遍。
    setSub(specLabel(s) + '　maxroll.gg '
      + ((M && M.updatedAt) || '?') + '　'
      + (pick.kind === 'mplus' ? '大秘境指南' : '团本指南')
      + ' 共 ' + pick.list.length + ' 套');

    // **raider.io 那一块放在最上面**（用户第 18 轮定的）。
    //
    // 它和下面 maxroll 那一整块**不是同一套天赋**，也不是同一个问题的答案：
    // 这块是榜上最多人用的串（验证过能导入，来自能进排行榜的真实角色），
    // 下面那块是 maxroll 编辑推荐的方案。放最上面是因为「照抄一套能用的」
    // 是最常见的来意，而它自成一块、不依赖下面选了哪套方案。
    //
    // 位置换了但内容一字没改 —— 尤其是「这不是上面那套的可导入版本」那句话
    // 还在（见 renderLoadouts）：两块相邻时更容易被读成同一套，那句必须留着。
    var lo = renderLoadouts(s);
    if (lo) host.appendChild(lo);

    // 团本 / 大秘境。只有一种时也画出来 —— 少一个按钮比「为什么没有团本」好解释。
    var bar = el('div', 'bis-bar');
    var seg = el('span', 'seg');
    [['mplus', '大秘境'], ['raid', '团本']].forEach(function (k) {
      if (pick.kinds.indexOf(k[0]) < 0) return;
      var btn = button(k[1], pick.kind === k[0] ? 'on' : null, function () {
        state.mrKind = k[0];
        state.mrBuild = 0;      // 换类型必须归零：两边套数不一样，留着下标会越界
        state.mrSub = 0;
        persist({ bisMrKind: k[0] });
        render();
      });
      btn.setAttribute('data-tip', mrTalents(s.specId, k[0]).length + ' 套方案');
      seg.appendChild(btn);
    });
    bar.appendChild(seg);
    host.appendChild(bar);

    // 方案列表。名字长，所以竖着一行一个，不挤成一排小按钮。
    var pickBox = el('div', 'mr-builds');
    pickBox.setAttribute('role', 'group');
    pickBox.setAttribute('aria-label', '天赋方案，共 ' + pick.list.length + ' 套');
    var shortNames = mrShortNames(pick.list);
    pick.list.forEach(function (t, i) {
      var btn = button('', 'mrb' + (i === pick.idx ? ' on' : ''), function () {
        state.mrBuild = i;
        state.mrSub = 0;        // 换方案，英雄树的选择跟着重置
        render();
      });
      var full = t.n || '（这套没写名字）';
      btn.appendChild(el('span', 'nm', shortNames[i]));
      var meta = el('span', 'mt');
      var ptsText = mrPtsText(t);
      // 印的是「选一条英雄树之后」的点数，不是产物里的 p —— 见 mrSplit 的注释。
      meta.appendChild(el('em', null, ptsText));
      // 一条串在 maxroll 页面上挂在多个小节下面（每副本 / 每首领各一个天赋图）时，
      // 生成器并成一套，c 是共用它的小节数。这里得说出来：名字里只留了第一个
      // 小节（「… in Altar of Fangs」），不说的话会以为这套只适用于那一个副本。
      if (t.c > 1) meta.appendChild(el('em', 'many', '通用 ' + t.c + ' 处'));
      // 场景（单体 / AOE / 顺劈 / 多目标）。**可选字段** —— 实测 maxroll 80 篇里
      // 只有 28 篇按场景分天赋，其余按英雄天赋或副本分。没有就不画这个标签，
      // 而不是默认标成「单体」（那是编的）。
      (t.sc || []).forEach(function (code) {
        var e = el('em', 'scen ' + code, SCEN_ZH[code] || code);
        e.setAttribute('data-tip', SCEN_TIP[code] || '');
        meta.appendChild(e);
      });
      // 英雄天赋名走 subTreeName()：那是 DB2 的中文名，不是我编的译名。
      // 结构是 <em class="hero"><b>名字</b></em>，和插件那条路的 chip 一样 ——
      // run-tests.js 的「英雄天赋名不许是英文」那条断言认的就是这个结构，
      // 换个写法它就悄悄少验 40 个专精。
      t.h.forEach(function (sid) {
        var e = el('em', 'hero');
        e.appendChild(el('b', null, subTreeName(sid)));
        meta.appendChild(e);
      });
      btn.appendChild(meta);
      // 提示的**第一行是全名**，而且是产物里那个 n 一字不改的原文 ——
      // 界面上显示的是删过共有词的短名（见 mrShortNames），全名只剩这一处。
      // run-tests.js 的「名字」那条断言认的就是这一行，换个顺序它会报红。
      btn.setAttribute('data-tip', full + '\n' + ptsText
        + (t.h.length > 1
          ? '（串里两条英雄天赋合计 ' + t.p + ' 点，游戏里只能选一条）' : '')
        + '\n英雄天赋：' + t.h.map(subTreeName).join(' / ')
        + (t.c > 1 ? '\nmaxroll 有 ' + t.c + ' 个小节用的是同一套' : ''));
      pickBox.appendChild(btn);
    });
    host.appendChild(pickBox);


    // 为什么这里**不给** maxroll 的串。
    //
    // 一开始是给的（显示 + 复制 + 一句「没验证过能不能导入」）。后来量过一遍：
    // 串头第一个字节是序列化版本号，maxroll 那批 167 条全是 130，而本机游戏
    // 导出的 103 条、raider.io 的 306 条全是 2。版本对不上游戏会直接拒 ——
    // 那不是「没验证过」，是「确定不能用」。给一个粘进去必然报错的串比不给更糟，
    // 所以现在只用它画树，能导入的串在下面 raider.io 那一块。
    // 这句话的措辞很要紧。上一版写的是「要能一键导入的串，用下面 raider.io 那一块」——
    // 读起来像「下面那串就是上面这套的可导入版本」，而**它们根本不是同一套天赋**：
    // 下面那块是 raider.io 榜上最多人用的串，和你在上面选的这套方案没有关系
    // （实测拿一个专精比过：7 个节点树上有而串里没有，8 个反过来）。
    // 所以这里只说「这套没有可导入的串」，不把用户往一个他会以为等价的地方引。
    // ---- 这一套的导入串。
    //
    // 上一轮这里写的是「maxroll 这套没有可导入的串」，**那个结论是错的**。
    // 我当时只看了页面里 data-wow-data 那个 blob（版本字节 130，游戏确实拒），
    // 没注意每张天赋卡片下面还有一个 Export 按钮 —— 那个按钮给的串版本字节是 2。
    // 用户导出一条惩戒骑 AOE 过来，逐位比完发现两串的节点位逐位相同，
    // 差别只有串头两个字段（版本 130→2、treeHash→全 0）。生成器现在照着做，
    // 产出的 g 和用户那条 Export 串逐字符相同（见 tools/fetch-maxroll.js
    // 的 toGameLoadout）。
    if (b.g) host.appendChild(renderMrLoadout(b, pick));
    else {
      host.appendChild(el('p', 'mr-nostr',
        '这一套没有导入串（生成时串头改写失败）—— 树还是能看的。'));
    }

    // 出手顺序（优先级列表）。见 renderMrNotes 的注释。
    //
    // 「各首领 / 副本说明」第 19 轮**撤掉了**（用户：「这个数据没用，没人看」）。
    // 生成器也不再产出 boss 字段，所以这里没有兜底分支可写 —— 产物里就没有了。
    var pr = renderMrNotes(pick.v.prio, 'mr-prio', '出手顺序',
      'maxroll 指南里的 Priority List —— 就是「技能时间轴」的文字版。');
    if (pr) host.appendChild(pr);

    // ---- 三棵树放**最后**（第 20 轮的易用性调整）。
    //
    // 实测这一页在 1440×900 下高 2494 像素，其中树占 1731 —— 快三屏。
    // 原来的顺序是「方案列表 → 树 → 导入串 → 出手顺序」，也就是要复制那个串、
    // 或者想看一眼出手顺序，都得先滚过一整棵树。而串和出手顺序是**拿来用的**
    // （复制、照着打），树是**拿来看的**（确认这套点了什么）。
    // 所以改成「先给能用的，再给能看的」。
    if (out.err) {
      var w = el('div', 'bis-warn');
      w.appendChild(el('b', null, '这套方案的串解不开'));
      w.appendChild(el('p', null, out.err + ' —— 树画不出来。'));
      host.appendChild(w);
    } else {
      host.appendChild(renderMrTree(s, b, out));
    }
  }

  /**
   * maxroll 这一套的**游戏导入串**。
   *
   * 产物里 g 是页面那个 blob 改完串头的结果（版本 130→2、treeHash 全 0），
   * 和 maxroll 每张卡片下面 Export 按钮给的串逐字符相同。
   *
   * 打包两条英雄天赋那 82 套要**单独说清楚**：它们的串是 95 点的（68 职业专精
   * + 13 + 13），而游戏里一个角色只能选一条英雄树。这不是我们改坏的 ——
   * maxroll 的 Export 按钮导出来就是这个样子。实测 raider.io 3722 条真实玩家串里
   * 点亮两条子树的有 299 条，但**全部低于 82 点**（最高 78），那是没点满的角色
   * 在换树途中，没有一条是 95 点。所以这串导进去之后得自己删掉一条英雄树,
   * 界面上必须说，不能让它看着和单树那些一样。
   */
  function renderMrLoadout(b, pick) {
    var bundled = (b.h || []).length > 1;
    // class **不能沿用 bis-loadout** —— 那个类被「每次渲染恰好一个导入串块」
    // 那条断言数着（它盯的是下面 raider.io 那一块），共用会让计数翻倍。
    // 和 gap-sum 那次是同一个形状，都是断言当场抓出来的。
    var box = el('div', 'mr-loadout');

    // class 是 **mr-lo-head**，不和 raider.io 那一块的 .lo-head 共用 ——
    // 第 20 轮加「标题里的人数必须对得上产物」那条断言时，测试按 .lo-head
    // 找标题，两块共用于是取到了后画的那个（maxroll 这个），
    // 152 次渲染里只核对到 3 次。样式沿用（见 style.css 里那条并列选择器）。
    var head = el('div', 'lo-head mr-lo-head');
    head.appendChild(el('b', null, '这一套的导入串'));
    head.appendChild(el('span', 'n', b.g.length + ' 个字符'));
    if (bundled) {
      var warn = el('span', 'lo-warn', '带着 ' + b.h.length + ' 条英雄天赋');
      warn.setAttribute('data-tip',
        'maxroll 把这一套配了 ' + b.h.length + ' 条英雄天赋打包在一个串里（'
        + b.p + ' 点），而游戏里一个角色只能选一条。\n'
        + '它的 Export 按钮导出来就是这样 —— 不是面板改坏的。\n'
        + '导进游戏之后自己把不要的那条英雄天赋清掉；上面的树已经按你选的那条画了。');
      head.appendChild(warn);
    }
    box.appendChild(head);

    // readOnly 但可选中：复制失败时还能手动选（file:// 下剪贴板 API 不总是可用）。
    // class **不能带 lo-text** —— 那个类被 checkLoadouts 按「每次渲染恰好一个串框」
    // 数着（它盯的是 raider.io 那一块）。这是同一个坑的第三次（前两次是 gap-sum
    // 和 bis-loadout）：复用别人的 class 会把别人的计数弄乱。
    var ta = el('textarea', 'mr-text');
    ta.value = b.g;
    ta.readOnly = true;
    ta.rows = 2;
    ta.setAttribute('aria-label', '天赋导入串，' + b.g.length + ' 个字符，只读');
    box.appendChild(ta);

    var act = el('div', 'lo-act');
    var copy = button('复制', 'primary mr-copy', function () {
      if (AE.copyWithToast) AE.copyWithToast(b.g, '天赋导入串');
      else if (AE.toast) AE.toast({ title: '请手动选中上面的串按 Ctrl+C', kind: 'warn' });
    });
    copy.setAttribute('data-tip',
      '复制后在游戏里打开天赋界面，右下角「导入」粘贴。\n'
      + (bundled
        ? '这一套带着 ' + b.h.length + ' 条英雄天赋，导进去后自己清掉不要的那条。'
        : '这一套只有一条英雄天赋，导进去就是上面画的样子。'));
    act.appendChild(copy);
    act.appendChild(el('span', 'n', mrPtsText(b)
      + (bundled ? '（串里合计 ' + b.p + ' 点）' : '')));
    box.appendChild(act);

    box.appendChild(el('p', 'note',
      '这一串是 maxroll 页面里那个 blob 改了串头得到的（版本字节 130→2、'
      + 'treeHash 全 0），和它每张卡片下面 Export 按钮给的串逐字符相同 —— '
      + '节点位一个都没动。'));
    return box;
  }

  // 场景码 → 中文。这四个词是**通用战斗术语**，不是游戏里的官方译名
  // （不像首领名 / 技能名那样有官方中文），所以可以写。
  var SCEN_ZH = { st: '单体', aoe: 'AOE', cleave: '顺劈', multi: '多目标' };
  var SCEN_TIP = {
    st: 'maxroll 把这套标为单目标（Single Target）场景',
    aoe: 'maxroll 把这套标为 AOE 场景',
    cleave: 'maxroll 把这套标为顺劈（Cleave，少量目标）场景',
    multi: 'maxroll 把这套标为多目标（Multi-Target）场景'
  };

  /**
   * 「出手顺序」和「各首领 / 副本说明」两块。形状一样，所以一个函数。
   *
   * **技能名是中文，句子是英文原文。** 技能 / 天赋名在生成时按 maxroll 标的
   * data-wow-id 换成了官方中文名（见 tools/fetch-maxroll.js 的 substSpells），
   * 所以「Cast Shadow Bolt as your filler」在产物里已经是「Cast 暗影箭 as your
   * filler」—— 名字能直接拿去游戏里搜。句子没翻：整句机翻会把「unless」这类
   * 条件翻反，而界面上看不出来。
   *
   * 面板这一侧**一个字都不加工**：产物给什么就显示什么。截断、去标点、再翻译
   * 都会让它和产物不一致，测试逐字节比对就是在钉这件事。
   *
   * 用 <details> 折叠：实测一个专精有 3~9 条首领说明，全展开会把天赋树顶到屏幕外。
   */
  function renderMrNotes(list, cls, title, tip) {
    if (!list || !list.length) return null;
    var wrap = el('details', 'sec ' + cls);
    // 标题拆成两个 <span>，**不写 summary 自己的文字再往里 appendChild** ——
    // 那样在浏览器里两段都在，而 DOM 里「元素自己的文字 + 子元素」这种混合形状
    // 读 textContent 时行为不一致（测试脚手架里前一半会丢）。
    // 全用子元素，两边读出来的都是同一串字。
    var sum = el('summary');
    sum.appendChild(el('span', 'ttl', title + '　' + list.length + ' 条'));
    sum.appendChild(el('span', 'note', '　技能名中文，句子英文'));
    sum.setAttribute('data-tip', tip
      + '\n技能和天赋名是官方中文（按 maxroll 标的技能 ID 查的，查不到的留英文）。\n'
      + '句子是 maxroll 的英文原文，没翻 —— 整句机翻会把「unless」这种条件翻反，'
      + '照着打就是错的，而界面上看不出来。');
    wrap.appendChild(sum);
    list.forEach(function (r) {
      var row = el('div', 'note-row');
      // 小节名过一遍 heroName()：出手顺序的小节名基本都是英雄天赋名
      // （Sunfury / Hellcaller…），而 app/talent-tree.js 的子树表里有它们的
      // 官方中文名。**这是查表不是翻译** —— 查不到就原样显示英文
      // （首领说明的小节名是首领 / 副本名，本机没有译名，全部走这条）。
      var h = el('b', null, heroName(r.n));
      // 带场景的那几条（实测 183 条优先级列表里有 14 条）在名字后面标出来。
      if (r.s) {
        var sc = el('em', 'scen ' + r.s, SCEN_ZH[r.s] || r.s);
        sc.setAttribute('data-tip', SCEN_TIP[r.s] || '');
        h.appendChild(sc);
      }
      row.appendChild(h);
      row.appendChild(el('p', 'en', r.t));
      wrap.appendChild(row);
    });
    return wrap;
  }

  /**
   * 画 maxroll 这一套的三棵树。
   *
   * 英雄树那一棵有个 maxroll 特有的情况：**一个 embed 里点了两条英雄树**
   * （实测 587 套里 275 套是这样，点数 95 = 68 职业专精 + 13 + 13，而正常的是 82）。
   * 游戏里一个角色只能选一条，所以那是 maxroll 把「同一套配两条英雄树」打包成了
   * 一个串。这里**分开画**并给出选择，而不是把两条挤在一起 —— 挤在一起的话
   * 界面上会出现一个游戏里做不到的形状。
   */
  function renderMrTree(s, b, out) {
    var TR = tree();
    var box = el('div', 'bis-tree');
    var sp = TR.specs[String(s.specId)];
    if (!sp) {
      box.appendChild(el('p', 'note', '天赋树数据里没有 specID ' + s.specId + '。'));
      return box;
    }

    var subs = out.subs.length ? out.subs : b.h;
    var si = (state.mrSub >= 0 && state.mrSub < subs.length) ? state.mrSub : 0;
    var sub = subs[si] || 0;

    if (subs.length > 1) {
      var sbar = el('div', 'tree-pick');
      sbar.appendChild(el('span', 'lb', '英雄天赋'));
      subs.forEach(function (sid, i) {
        var btn = button(subTreeName(sid), i === si ? 'on' : null, function () {
          state.mrSub = i;
          render();
        });
        btn.setAttribute('data-tip',
          '这一套 maxroll 同时给了 ' + subs.length + ' 条英雄天赋。'
          + '游戏里只能选一条，所以这里一条一条画。');
        sbar.appendChild(btn);
      });
      box.appendChild(sbar);
      var sp2 = mrSplit(out);
      var mine = sp2 ? (sp2.base + (sp2.per[sub] || 0)) : null;
      box.appendChild(el('p', 'note',
        '这套方案里 maxroll 把 ' + subs.map(subTreeName).join(' 和 ')
        + ' 两条英雄天赋写在同一个串里（串里合计 ' + out.pts + ' 点 —— '
        + '游戏里配不出这个数，一个角色只能选一条）。上面选哪条，下面就画哪条'
        + (mine ? '：现在这条是 ' + mine + ' 点' : '')
        + '；职业树和专精树两条共用。'));
    } else {
      box.appendChild(el('p', 'note',
        '共 ' + out.pts + ' 点，英雄天赋：' + (sub ? subTreeName(sub) : '这套没点')
        + '。高亮的是点了的节点，鼠标放上去看详情。'));
    }

    // 只画选中那条英雄树的节点。不筛的话两条树的节点会摆在同一张网格上，
    // 坐标是各自树内的 5×5，直接叠成一团（实测）。
    var heroIds = (sp.heroNodes || []).filter(function (id) {
      var n = TR.nodes[id];
      return n && (!sub || n[6] === sub);
    });
    // **英雄天赋排在最前面**（用户第 18 轮定的）。游戏里三棵树是职业 → 专精 →
    // 英雄，但这个面板不是拿来照着点的：英雄天赋是「这套方案是哪一套」的标识
    // （方案列表上的徽章、上面那个选择条、名字里的区分后缀都是它），
    // 而职业树 / 专精树在同一个专精的十套方案之间差别很小。
    // 先给最能区分的那棵，长的两棵往后放。插件那条路同样调了顺序，
    // 两条路的形状必须一致，否则退到插件那份时整页会换个样子。
    var cols = el('div', 'tree-cols');
    [[heroIds, '英雄天赋' + (sub ? '：' + subTreeName(sub) : '')],
     [sp.classNodes, '职业天赋'],
     [sp.specNodes, '专精天赋']
    ].forEach(function (g) {
      var grid = renderTreeGrid(sp, g[0] || [], out.nr, g[1]);
      if (grid) cols.appendChild(grid);
    });
    box.appendChild(cols);
    return box;
  }

  /**
   * 插件那份「顶尖玩家实际在用什么」的统计。
   *
   * maxroll 没有这个专精的方案时走这条（实测 3 个专精），或者 maxroll / 天赋树
   * 还没加载完的首屏那一瞬间。它保留下来不是为了兼容 —— 它回答的是另一个问题
   * （「大家在用什么」而不是「推荐什么」），maxroll 那边没有这个量。
   */
  function renderPopularTalents(host, s) {
    var T = talents();

    if (!T) {
      host.appendChild(el('p', 'note', '天赋数据还没加载好。'));
      return;
    }
    var td = T.specs[state.key] || T.specs[s.cls + '/' + s.spec];
    if (!td) {
      // 天赋数据按「职业/专精」建的键，装备数据按「职业/专精/英雄天赋」。
      var base = s.cls + '/' + s.spec;
      Object.keys(T.specs).forEach(function (k) {
        if (!td && (k === base || k.indexOf(base + '/') === 0)) td = T.specs[k];
      });
    }
    if (!td) {
      host.appendChild(el('p', 'note', '没有这个专精的天赋数据。'));
      return;
    }

    setSub(specLabel(s) + '　共 ' + td.builds.length + ' 套');

    // 为什么这一页长得和别的专精不一样，得说清楚。
    //
    // 两种情况都会落到这条路，而它们对用户的含义完全不同：
    //   · 数据还没加载完 —— 等一下就会自己换过来；
    //   · **maxroll 没有这个专精的天赋方案** —— 换不过来了，这就是最终形态。
    //     实测 3 个专精是这样（它们指南里的天赋图是照上一版天赋树编的，解不开
    //     所以不收）。上一版只写了第一种情况的话，这 3 个专精的用户会一直等一个
    //     永远不会来的东西；而别的专精那一页是「方案列表 + 三棵树」，
    //     他会以为自己这里坏了。
    if (!tree() || !maxroll()) {
      host.appendChild(el('p', 'note',
        '下面是「顶尖玩家实际在用什么」的统计。maxroll 的推荐方案还在加载，'
        + '到了会自动换过来。'));
    } else {
      var why = el('p', 'note');
      why.appendChild(el('b', null, 'maxroll 没有这个专精的天赋方案。'));
      why.appendChild(doc.createTextNode(
        '下面是随包自带的「顶尖玩家实际在用什么」统计 —— 所以这一页和别的专精长得不一样，'
        + '不是坏了。'));
      why.setAttribute('data-tip',
        'maxroll 这个专精的指南里，天赋图是照上一版天赋树编的，解不开所以没收进来'
        + '（实测 40 个专精里有 3 个这样）。\n'
        + '装备页不受影响，maxroll 的「最佳推荐」40 个专精都有。');
      host.appendChild(why);
    }

    // **raider.io 那一块在这条路上也放最上面**（位置和 maxroll 路对齐）。
    // 它不依赖 maxroll，而是从数据包独立解出来的 —— 在这条路上说明
    // 「maxroll 没方案，但你可以抄别的能用的」。上面那段解释已经说了
    // 「这页和别的专精长得不一样」，把两条路形状统一能减少困惑。
    var lo = renderLoadouts(s);
    if (lo) host.appendChild(lo);

    var bar = el('div', 'bis-bar');
    var seg = el('span', 'seg');
    TCAT.forEach(function (c) {
      if (!td.content[c[0]]) return;
      var b = button(c[1], state.tcat === c[0] ? 'on' : null, function () {
        state.tcat = c[0];
        persist({ bisTalentCat: c[0] });
        render();
      });
      b.setAttribute('data-tip', TCAT_TIP[c[0]]);
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    host.appendChild(bar);

    if (tree()) host.appendChild(renderTree(td));
    else host.appendChild(renderTreeMissing());

    host.appendChild(renderBuildStats(td));
    host.appendChild(renderEncounters(T, td));
  }

  /**
   * 官方天赋导入串：显示 + 复制。没有 rio 数据时返回 null（整块不画）。
   *
   * 串是**照原样**从 app/rio-data.js 里取的，一个字符都不改 —— 它们是
   * raider.io 给出的 talentLoadoutText，来自能进大秘境排行榜的真实角色。
   * 面板不做任何编码：编一串出来只会得到游戏说「无效」的东西。
   *
   * 复制走 AE.copyWithToast（app/toast.js，早就有的那个，file:// 下会退到
   * execCommand）。它可能没加载（测试环境就不加载 toast.js），所以先判断再用，
   * 判断不到时退回「选中文本自己按 Ctrl+C」—— 文本框本来就是可选中的。
   */
  /** 团本那半（app/wcl-data.js）。形状和 rio 那半一样，见 loadoutsOf()。 */
  function wclLoadouts(specId) {
    var W = global.AE_WCL;
    return loadoutsOf(W && W.specs ? W.specs[String(specId)] : null);
  }

  /**
   * 「榜上热门天赋串」这一块，分**团本 / 大秘境**两类（第 20 轮用户要的）。
   *
   * 两类的来源不一样，而且不得不不一样：
   *   · 大秘境 = raider.io 每专精排行榜，串在榜页里白送（app/rio-data.js）；
   *   · 团本   = Warcraft Logs，raider.io 的团本榜只有公会没有角色。
   *     WCL 的串在 `ReportFight.talentImportCode(actorID:)` 上（app/wcl-data.js）。
   * 所以这里不是「同一份数据切两半」，是两份数据并排放 —— 样本量、覆盖的专精
   * 都不一样，界面上必须分别写清楚，不能让人以为是一个数的两个视图。
   */
  function loKinds(specId) {
    var out = [];
    var m = rioLoadouts(specId);
    if (m) out.push({ k: 'mplus', label: '大秘境', lo: m, src: 'rio' });
    var r = wclLoadouts(specId);
    if (r) out.push({ k: 'raid', label: '团本', lo: r, src: 'wcl' });
    return out;
  }

  function renderLoadouts(s) {
    if (!s || !s.specId) return null;
    var kinds = loKinds(s.specId);
    if (!kinds.length) return null;

    // 选中哪一类。**默认取第一个存在的**，而不是写死 mplus —— 有些专精
    // 只有一边有数据（团本 39/40，大秘境 40/40），写死会让那一个专精空着。
    var ki = 0;
    for (var q = 0; q < kinds.length; q++) {
      if (kinds[q].k === state.loKind) { ki = q; break; }
    }
    var cur = kinds[ki];
    var lo = cur.lo;

    var idx = state.loadout;
    if (!(idx >= 0) || idx >= lo.list.length) idx = 0;
    var str = lo.list[idx];

    var box = el('div', 'bis-loadout');
    var head = el('div', 'lo-head');
    // 标题里「不是同一套」这句是必需的，而且**方位词跟着版面走**：
    // 第 18 轮把这一块提到了 maxroll 上面，原来写的「和上面的方案不是同一套」
    // 就指向了页面顶端的空白处。这一块现在在上，maxroll 在下。
    head.appendChild(el('b', null, '榜上热门天赋串'));
    head.appendChild(el('span', 'n',
      lo.total + ' 名玩家共 ' + lo.uniq + ' 种，下面是最热门的几种'));
    // **样本太少时说出来。** 团本那一类按专精差别极大（实测奥法 1537 人，
    // 火法 8 人、生存猎 6 人）—— 一队 20 人只有 2~3 个坦克治疗，冷门专精
    // 天然凑不够。8 个人里「#1 有 2 人用」和 500 个人里「#1 有 50 人用」
    // 在界面上长得一模一样，而前者基本等于没有统计意义。
    // 数字本来就摆在那儿，但**数字的分量**得写出来。
    if (lo.total < 20) {
      var thin = el('span', 'lo-warn thin', '样本只有 ' + lo.total + ' 人');
      thin.setAttribute('data-tip',
        '这一类里这个专精只采样到 ' + lo.total + ' 个人，'
        + '所以「最热门」的分量很轻 —— 换个人抓一遍，第一名可能就换了。\n'
        + '团本里一队 20 人只有 2~3 个坦克 / 治疗，冷门专精天然凑不够。\n'
        + '想要样本大的，看另一类。');
      head.appendChild(thin);
    }
    // 「和下面 maxroll 的方案不是同一套」这句**只在下面真的有 maxroll 那一块时才画**。
    //
    // 实测 3 个专精（平衡德 102、织雾僧 270、武器战 71）的 maxroll 天赋图是照
    // 上一版天赋树编的、串解不开，所以不收 —— 那 3 个专精走插件兜底那条路，
    // 页面上根本没有 maxroll 方案列表，而这句话照样画着，指向下面一片空白。
    // 这和用户第 19 轮报的那个 bug 是同一类（那次是版面调过之后「上面」变成了
    // 「下面」）：**方位词和它指的那个东西必须一起判断，不能各写各的。**
    if (tree() && mrTalentPick(s.specId)) {
      var warn = el('span', 'lo-warn', '和下面 maxroll 的方案不是同一套');
      warn.setAttribute('data-tip',
        '这一块是排行榜上真实角色的天赋串，能一键导入。\n'
        + '和下面 maxroll 那些方案不是同一套：拿一个专精逐节点比过，'
        + '一边多 7 个节点，另一边多 8 个。\n'
        + '要 maxroll 那一套，用它自己那一块的复制按钮。');
      head.appendChild(warn);
    }
    box.appendChild(head);

    // 团本 / 大秘境。只有一类时也画 —— 它同时是「这批数据是哪来的」的标签，
    // 不只是开关。少画的话用户不知道自己看的是哪一类。
    var kbar = el('div', 'lo-kind');
    kinds.forEach(function (kd, i) {
      var b = button(kd.label + '　' + kd.lo.total + ' 人',
        i === ki ? 'on' : null, function () {
          state.loKind = kd.k;
          state.loadout = 0;          // 换类之后 #4 指的是另一串，回到 #1
          persist({ bisLoKind: kd.k });
          render();
        });
      b.setAttribute('data-tip', kd.k === 'raid'
        ? '团本（史诗难度）首领榜上玩家的天赋，来自 Warcraft Logs。\n'
          + '样本按专精差别很大：一队 20 人只有 2~3 个坦克 / 治疗。'
        : '大秘境每专精排行榜上玩家的天赋，来自 raider.io。\n'
          + '每个专精的样本量比较均匀。');
      kbar.appendChild(b);
    });
    box.appendChild(kbar);

    // 选串。只列前 6 种 —— 再往后都是 1 人用的，列出来只是噪音。
    var bar = el('div', 'lo-pick');
    lo.list.slice(0, 6).forEach(function (t, i) {
      var b = button('#' + (i + 1) + '·' + lo.count[t] + '人',
        i === idx ? 'on' : null, function () {
          state.loadout = i;
          render();
        });
      b.setAttribute('data-tip', lo.count[t] + ' 名玩家用这一串，占 '
        + pct(lo.count[t] * 100 / lo.total));
      bar.appendChild(b);
    });
    box.appendChild(bar);

    // 串本身放在 textarea 里：readOnly 但可选中，复制不成功时还能手动选。
    var ta = el('textarea', 'lo-text');
    ta.value = str;
    ta.readOnly = true;
    ta.setAttribute('rows', '3');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', '天赋导入串，' + str.length + ' 个字符，只读');
    box.appendChild(ta);

    var act = el('div', 'lo-act');
    var copy = button('复制', 'primary lo-copy', function () {
      if (AE.copyWithToast) AE.copyWithToast(str, '天赋导入串');
      else if (AE.toast) AE.toast({ title: '请手动选中下面的串按 Ctrl+C', kind: 'warn' });
    });
    copy.setAttribute('data-tip', '复制后在游戏里打开天赋界面，右下角「导入」粘贴');
    act.appendChild(copy);
    act.appendChild(el('span', 'n', lo.count[str] + ' 人用这一串　'
      + str.length + ' 个字符'));
    box.appendChild(act);

    box.appendChild(el('p', 'note',
      (cur.k === 'raid'
        ? '这几串取自 Warcraft Logs 上 ' + ((global.AE_WCL && global.AE_WCL.raid) || '当前团本')
          + '（史诗）首领榜玩家的战斗记录，原样转发，面板没有改动一个字符。'
        : '这几串取自 raider.io 大秘境排行榜玩家身上，原样转发，'
          + '面板没有改动一个字符。')
      + '导入的位置：游戏里 N 打开天赋界面，右下角「导入/导出」→「导入」。'
      + '串里带着它自己的专精编号，导错专精游戏会直接拒绝。'));
    return box;
  }

  var TCAT_TIP = {
    raid: '团本：史诗难度首领的前几名',
    mplusHigh: '冲分：高层大秘境（追求层数）',
    mplusFarm: '割草：低层大秘境（追求速度）'
  };

  /** 把一套 build 还原成 {entryID: 点数}。和 tools\gen-talents.js 的 apply() 必须一致。 */
  function decodeBuild(td, idx) {
    var m = Object.create(null);
    var i;
    for (i = 0; i < td.base.length; i += 2) m[td.base[i]] = td.base[i + 1];
    var d = td.builds[idx] || [];
    for (i = 0; i < d.length; i += 2) {
      if (d[i + 1] === 0) delete m[d[i]];
      else m[d[i]] = d[i + 1];
    }
    // dict 下标 -> 真正的 entryID
    var out = Object.create(null);
    Object.keys(m).forEach(function (k) {
      var eid = td.dict[k - 1];
      if (eid != null) out[eid] = m[k];
    });
    return out;
  }
  AE.decodeTalentBuild = decodeBuild;

  function buildPoints(td, idx) {
    var b = decodeBuild(td, idx);
    var n = 0;
    Object.keys(b).forEach(function (k) { n += b[k]; });
    return n;
  }

  function renderTreeMissing() {
    var box = el('div', 'bis-warn');
    box.appendChild(el('b', null, '天赋树数据没加载到'));
    var p = el('p', null,
      '发布包里本来带着 app/talent-tree.js（约 415 KB）。没读到它的话，'
      + '要么文件被删了，要么你是从源码跑的但没生成它 —— 跑 tools\\fetch-talent-tree.js 就行。'
      + '没有它，下面仍然能给出「谁在用哪套、每套多少点、英雄天赋怎么分布」，'
      + '因为那些只需要插件那份数据；但画不出树。');
    box.appendChild(p);
    var p2 = el('p', null,
      '也可以自己做一份放成 app/talent-tree.js。它的格式就是生成器写出来的那个：');
    box.appendChild(p2);
    var pre = el('pre', 'fmt', TREE_FORMAT_DOC);
    box.appendChild(pre);
    return box;
  }



  // ------------------------------------------------------------------ 画天赋树
  //
  // 坐标不能直接当像素用。上游的 posX/posY 最大公约数只有 10，且有
  // “相差 10” 的近重复坐标（本机实测）。直接缩放会把两个节点叠在一起。
  // 实测发现它本质上就是网格：职业树是严格的 600×600，专精树 600 为主，
  // 英雄子树是 5×5。所以把不同坐标值按容差聚成列/行，再按网格摆 ——
  // 容差从 50 到 250 都测过，同一格重叠始终是 0，最大 9 列 × 11 行。
  // 一格的尺寸。节点方块是 62×50，格子比它大 12px 留空隙。
  // CELL_H 从 44 涨到 62 是因为节点里加了 24px 的天赋图标：图标在上、名字在下，
  // 方块高度 32 → 50。不涨格子的话上下两行会贴在一起（实测重叠）。
  var CELL_W = 74, CELL_H = 62, GRID_TOL = 100;

  /** 不同坐标值 -> 列/行下标。相邻差超过 GRID_TOL 才算新一列。 */
  function clusterIndex(vals) {
    var uniq = [];
    vals.forEach(function (v) { if (uniq.indexOf(v) < 0) uniq.push(v); });
    uniq.sort(function (a, b) { return a - b; });
    var map = {}, idx = 0, prev = null;
    uniq.forEach(function (v) {
      if (prev !== null && v - prev > GRID_TOL) idx++;
      map[v] = idx;
      prev = v;
    });
    return { map: map, count: idx + 1 };
  }

  // entryID -> nodeID。建一次就行。
  var entryNodeMap = null;
  function entryToNode(eid) {
    if (!entryNodeMap) {
      entryNodeMap = {};
      var TR = tree();
      if (TR && TR.nodes) {
        Object.keys(TR.nodes).forEach(function (id) {
          (TR.nodes[id][5] || []).forEach(function (e) { entryNodeMap[e[0]] = id; });
        });
      }
    }
    return entryNodeMap[eid];
  }

  /** {entryID: 点数} -> {nodeID: {rank, eid}}。choice 节点靠这个知道选了哪一边。 */
  function nodeRanks(picked) {
    var out = {};
    Object.keys(picked).forEach(function (eid) {
      var nid = entryToNode(Number(eid));
      if (nid === undefined) return;
      if (!out[nid]) out[nid] = { rank: 0, eid: Number(eid) };
      out[nid].rank += picked[eid];
    });
    return out;
  }

  /** 这个类别里每套天赋被多少人用。 */
  function buildUsage(td) {
    var m = {};
    (td.content[state.tcat] || []).forEach(function (enc) {
      (enc.p || []).forEach(function (p) { m[p[0]] = (m[p[0]] || 0) + 1; });
    });
    return m;
  }

  /**
   * 该画哪一套。state.build 在当前类别里真被人用过就用它，否则用最多人用的。
   * 不持久化：套路编号是生成时的数组下标，重新生成数据后就变了，
   * 存下来只会指向另一套天赋。这里的回退是自纠正的。
   */
  function pickBuild(td) {
    var use = buildUsage(td);
    var keys = Object.keys(use);
    if (!keys.length) return -1;
    if (state.build >= 0 && use[state.build]) return state.build;
    keys.sort(function (a, b) { return use[b] - use[a]; });
    return Number(keys[0]);
  }

  /** 这套天赋点的是哪个英雄子树。 */
  function activeSubTree(sp, nr) {
    var TR = tree();
    var count = {};
    (sp.heroNodes || []).forEach(function (id) {
      var n = TR.nodes[id];
      if (!n || !n[6] || !nr[id]) return;
      count[n[6]] = (count[n[6]] || 0) + nr[id].rank;
    });
    var best = 0, bestN = 0;
    Object.keys(count).forEach(function (sid) {
      if (count[sid] > bestN) { bestN = count[sid]; best = Number(sid); }
    });
    return best;
  }

  function subTreeName(sid) {
    var TR = tree();
    var s = TR.subTrees[sid] || TR.subTrees[String(sid)];
    return s ? (TR.names[s[0]] || '?') : '?';
  }

  /**
   * 英雄天赋的英文名 -> 中文名。
   *
   * app/talent-data.js 的 heroes 全是英文（那份数据来自插件，插件存的就是英文），
   * 而 app/talent-tree.js 的子树里既有暴雪 DB2 的中文名、也有英文名，
   * 所以拿英文名当连接键。没加载树、或者对不上，就原样显示英文 —— 不猜。
   */
  /*
   * **建好的表只在树真的加载了之后才缓存。**
   *
   * 原来是 `if (!heroZhMap)` 就建一次并永久留着 —— 而 app/talent-tree.js 是
   * 懒加载的：装备页第一次画的时候它还没到，于是表建成了空的 `{}`，然后被
   * 缓存住，这一整个会话里 heroName() 永远原样返回英文。
   * 症状是装备页写「英雄天赋 San'layn」而天赋页写「萨莱因」—— 同一个东西
   * 在两页上是两个名字。第 20 轮截图对比时才看出来。
   */
  var heroZhMap = null;
  function heroName(en) {
    if (!en) return '?';
    if (!heroZhMap) {
      var TR = tree();
      if (!TR || !TR.subTrees) return en;      // 树还没到，这次先返回英文，别缓存
      var m = {};
      Object.keys(TR.subTrees).forEach(function (sid) {
        var s = TR.subTrees[sid];
        if (s && s[3] && TR.names[s[0]]) m[s[3]] = TR.names[s[0]];
      });
      heroZhMap = m;
    }
    return heroZhMap[en] || en;
  }

  /**
   * 节点显示哪一个 entry：点了就是点中的那一个，没点就是第一个。
   *
   * 名字和图标**必须走同一个函数**。二选一的节点有两个 entry，各自有名字和图标；
   * 名字取「点中的那一边」而图标取「第一个」的话，界面上就会图文不符 ——
   * 这种错看起来像数据坏了，其实是两处各自挑了一次。
   */
  function nodeEntry(n, hit) {
    var ents = n[5] || [];
    if (hit) {
      for (var i = 0; i < ents.length; i++) if (ents[i][0] === hit.eid) return ents[i];
    }
    return ents[0] || null;
  }

  /** 节点上显示的名字：选了哪一边就显那一边。 */
  function nodeLabel(n, hit) {
    var e = nodeEntry(n, hit);
    return e ? (tree().names[e[1]] || '') : '';
  }

  /**
   * 节点上显示的图标名（不带扩展名），取不到就返回空串。
   *
   * 图片在 app/talent-icons/ 下，由 tools/fetch-talent-icons.js 打包前下好（2094 张，
   * 5.14 MB，100% 覆盖）。**文件名就是 app/talent-tree.js 里 icons 字典的那个名字** ——
   * 其中 19 个是 raidbots 规范化坏了的名字（真名带连字符），抓取工具查到真名后
   * 仍然按坏名字存盘，就是为了让这里不需要任何映射表。
   */
  function nodeIcon(n, hit) {
    var e = nodeEntry(n, hit);
    if (!e) return '';
    var nm = tree().icons[e[2]];
    // 名字会拼进 <img src>。只放行小写字母数字下划线，和抓取工具那条断言同一条规矩。
    return (nm && /^[a-z0-9_]+$/.test(nm)) ? nm : '';
  }

  /**
   * 画一棵（职业 / 专精 / 英雄）。
   * ids 里不在本次要画的节点已经筛掉了，连线只在本棵内部画。
   */
  function renderTreeGrid(sp, ids, nr, title) {
    var TR = tree();
    var list = ids.filter(function (id) { return TR.nodes[id]; });
    if (!list.length) return null;

    var cx = clusterIndex(list.map(function (id) { return TR.nodes[id][0]; }));
    var cy = clusterIndex(list.map(function (id) { return TR.nodes[id][1]; }));

    var pts = 0;
    list.forEach(function (id) { if (nr[id]) pts += nr[id].rank; });

    var wrap = el('div', 'tree-grid');
    var head = el('div', 'tree-grid-head');
    head.appendChild(el('b', null, title));
    head.appendChild(el('span', 'n', pts + ' 点'));
    wrap.appendChild(head);

    var canvas = el('div', 'tree-canvas');
    canvas.style.width = (cx.count * CELL_W) + 'px';
    canvas.style.height = (cy.count * CELL_H) + 'px';
    // 这块是一张「用 div 摆出来的图」：位置全靠绝对定位，读屏软件只会读到一串
    // 没有关系的方块。给它一个组名和一句摘要，至少能知道「这是什么、点了多少」。
    // 用 role=group 而不是 role=img —— img 会把里面的节点名全藏起来，
    // 而节点名恰恰是这棵树唯一的文字信息。
    var litCount = list.filter(function (id) { return nr[id]; }).length;
    canvas.setAttribute('role', 'group');
    // title 本身已经是「职业天赋」/「专精天赋」/「英雄天赋：萨莱因」，
    // 后面再接「天赋树」会念成「职业天赋天赋树」—— 实际读出来才发现的。
    canvas.setAttribute('aria-label',
      title + '，共 ' + list.length + ' 个天赋，点了 ' + litCount + ' 个，合计 ' + pts + ' 点');

    var pos = {}, inSet = {};
    list.forEach(function (id) {
      var n = TR.nodes[id];
      pos[id] = {
        x: cx.map[n[0]] * CELL_W + CELL_W / 2,
        y: cy.map[n[1]] * CELL_H + CELL_H / 2
      };
      inSet[id] = 1;
    });

    // 先连线，后节点 —— 线得在下面。用旋转的 <i> 而不是 SVG：
    // 全库没有用过 SVG，测试用的 DOM 桩也没有 createElementNS。
    Object.keys(sp.edges || {}).forEach(function (from) {
      if (!inSet[from]) return;
      sp.edges[from].forEach(function (to) {
        if (!inSet[to]) return;
        var a = pos[from], b = pos[to];
        var dx = b.x - a.x, dy = b.y - a.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (!len) return;
        var lit = nr[from] && nr[to];
        var line = el('i', 'tree-edge' + (lit ? ' on' : ''));
        line.style.left = a.x + 'px';
        line.style.top = a.y + 'px';
        line.style.width = len.toFixed(1) + 'px';
        line.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2) + 'deg)';
        canvas.appendChild(line);
      });
    });

    var freeSet = {};
    (sp.free || []).forEach(function (id) { freeSet[id] = 1; });

    list.forEach(function (id) {
      var n = TR.nodes[id];
      var hit = nr[id];
      var maxR = n[2] || 1;
      var type = TR.types[n[3]] || '?';
      var cls = 'tnode' + (hit ? ' on' : '') + (type === 'choice' ? ' ch' : '');
      var b = el('div', cls);
      // 节点 ID 放进 DOM：一是排查问题时能直接看出画的是哪个节点，
      // 二是测试靠它断言「同一个专精里三棵树的节点不重复」——
      // 只数总数的话，把专精树错画成职业树是数不出来的（实测漏过一次）。
      b.setAttribute('data-node', id);
      b.style.left = (pos[id].x - CELL_W / 2 + 6) + 'px';
      b.style.top = (pos[id].y - CELL_H / 2 + 6) + 'px';
      // 图标在名字上面。游戏里天赋是靠图标认的，纯文字的树跟游戏里对不上。
      // 图标跟名字取**同一个 entry**（nodeEntry），否则二选一节点会图文不符。
      var ent = nodeEntry(n, hit);
      var tico = talentIconImg(ent, 24);
      if (tico) b.appendChild(tico);
      b.appendChild(el('span', 'nm', nodeLabel(n, hit)));
      if (maxR > 1) b.appendChild(el('span', 'r', (hit ? hit.rank : 0) + '/' + maxR));

      var tip = [];
      // 每个 entry 一行：名字 +（有的话）**这个天赋原本的说明**。
      // 说明来自 app/talent-desc.js（第 19 轮用户要的「天赋图标，鼠标指向的提示，
      // 能不能显示天赋原本说明」），键是 entry 的 spellId。
      // 那份文件是**懒加载**的：没加载到就只有名字，不报错也不占位 ——
      // 悬停提示少一段说明，功能不受影响。
      (n[5] || []).forEach(function (e) {
        var sel = hit && e[0] === hit.eid;
        tip.push((sel ? '▸ ' : '· ') + (TR.names[e[1]] || '?'));
        var d = talentDesc(e[3]);
        if (d) {
          // 说明本身可能有换行（主效果 + 一句补充）。缩进两格挂在名字下面，
          // 二选一节点有两段说明时才分得清哪段是哪个。
          d.split('\n').forEach(function (ln) {
            if (ln) tip.push('　　' + ln);
          });
        }
      });
      if (type === 'choice') tip.push('（二选一）');
      if (n[4]) tip.push('本树满 ' + n[4] + ' 点才能点');
      if (freeSet[id]) tip.push('白给的节点（不占点数）');
      tip.push(hit ? '已点 ' + hit.rank + '/' + maxR : '这套没点');
      b.setAttribute('data-tip', tip.join('\n'));
      canvas.appendChild(b);
    });

    wrap.appendChild(canvas);
    return wrap;
  }

  /** 有 AE_TALENT_TREE 时画真正的树。 */
  function renderTree(td) {
    var TR = tree();
    var sp = TR.specs[String(td.specId)] || TR.specs[td.specId];
    if (!sp) {
      return el('p', 'note', '天赋树数据里没有 specID ' + td.specId + '。');
    }

    var box = el('div', 'bis-tree');
    var bi = pickBuild(td);
    if (bi < 0) {
      box.appendChild(el('p', 'note', '这个类别没有天赋记录，所以画不出具体一套。'));
      return box;
    }

    var picked = decodeBuild(td, bi);
    var nr = nodeRanks(picked);
    var use = buildUsage(td);
    var total = 0;
    Object.keys(picked).forEach(function (k) { total += picked[k]; });
    var sub = activeSubTree(sp, nr);

    // 选套路。只列这个类别里真有人用的，按人数排。
    var bar = el('div', 'tree-pick');
    bar.appendChild(el('span', 'lb', '套路'));
    Object.keys(use).sort(function (a, b) { return use[b] - use[a]; })
      .slice(0, 8).forEach(function (k) {
        var idx = Number(k);
        var b = button('#' + idx + '·' + use[k] + '人', idx === bi ? 'on' : null, function () {
          state.build = idx;
          render();
        });
        b.setAttribute('data-tip', use[k] + ' 人用这一套，共 ' + buildPoints(td, idx) + ' 点');
        bar.appendChild(b);
      });
    box.appendChild(bar);

    var info = el('p', 'note',
      '画的是套路 #' + bi + '（' + (use[bi] || 0) + ' 人用，共 ' + total + ' 点）。'
      + '英雄天赋：' + (sub ? subTreeName(sub) : '这套没点') + '。'
      + '高亮的是点了的节点，鼠标放上去看详情。');
    box.appendChild(info);

    var cols = el('div', 'tree-cols');
    var heroIds = (sp.heroNodes || []).filter(function (id) {
      var n = TR.nodes[id];
      return n && (!sub || n[6] === sub);
    });
    // 顺序和 maxroll 那条路一致：英雄天赋在最前。理由见 renderMrTree 的同一处。
    [[heroIds, '英雄天赋' + (sub ? '：' + subTreeName(sub) : '')],
     [sp.classNodes, '职业天赋'],
     [sp.specNodes, '专精天赋']
    ].forEach(function (g) {
      var grid = renderTreeGrid(sp, g[0] || [], nr, g[1]);
      if (grid) cols.appendChild(grid);
    });
    box.appendChild(cols);

    return box;
  }

  function renderBuildStats(td) {
    var T = talents();
    var wrap = el('div', 'bis-bstats');

    // 这个类别里，各英雄天赋 / 各套天赋分别被多少人用
    var list = td.content[state.tcat] || [];
    var heroCount = {}, buildCount = {}, players = 0;
    list.forEach(function (enc) {
      (enc.p || []).forEach(function (p) {
        players++;
        var hero = heroName(T.heroes[p[1]]);
        heroCount[hero] = (heroCount[hero] || 0) + 1;
        buildCount[p[0]] = (buildCount[p[0]] || 0) + 1;
      });
    });
    if (!players) return wrap;

    var h = el('details', 'sec');
    h.setAttribute('open', 'open');
    h.appendChild(el('summary', null, '热门英雄天赋　（' + players + ' 条记录）'));
    var chips = el('div', 'chips');
    Object.keys(heroCount).sort(function (a, b) { return heroCount[b] - heroCount[a]; })
      .forEach(function (hero) {
        var c = el('span', 'chip hero');
        c.appendChild(el('b', null, hero));
        c.appendChild(el('span', 'n', heroCount[hero] + ' 人　'
          + pct(heroCount[hero] / players * 100)));
        chips.appendChild(c);
      });
    h.appendChild(chips);
    wrap.appendChild(h);

    var b = el('details', 'sec');
    b.appendChild(el('summary', null, '热门套路　（同一套天赋被多少人用）'));
    var top = Object.keys(buildCount)
      .sort(function (x, y) { return buildCount[y] - buildCount[x]; })
      .slice(0, 10);
    var tbl = el('table', 'bis-tbl');
    var thead = el('tr');
    ['套路', '人数', '点数'].forEach(function (t) { thead.appendChild(el('th', null, t)); });
    tbl.appendChild(thead);
    top.forEach(function (idx) {
      var tr = el('tr');
      tr.appendChild(el('td', null, '#' + idx));
      tr.appendChild(el('td', null, String(buildCount[idx])));
      tr.appendChild(el('td', null, String(buildPoints(td, Number(idx)))));
      tbl.appendChild(tr);
    });
    b.appendChild(tbl);
    b.appendChild(el('p', 'note', tree()
      ? '「套路」的编号是生成时的数组下标，没有官方名字；'
        + '想看它长什么样，用上面天赋树里的套路按钮切过去。'
      : '「套路」只能给编号 —— 没有天赋树数据的话，一套天赋只是一串 entryID，'
        + '没法起名字，也没法画出来。'));
    wrap.appendChild(b);
    return wrap;
  }

  function renderEncounters(T, td) {
    var wrap = el('div', 'bis-encs');
    var list = td.content[state.tcat] || [];
    if (!list.length) {
      wrap.appendChild(el('p', 'note', '这个类别没有数据。'));
      return wrap;
    }
    list.forEach(function (enc) {
      var d = el('details', 'sec');
      var title = (enc.n || enc.en || '?') + (enc.m ? '　' + enc.m : '');
      d.appendChild(el('summary', null, title + '　' + ((enc.p || []).length) + ' 人'));
      var tbl = el('table', 'bis-tbl');
      var head = el('tr');
      ['#', '玩家', '服务器', '地区', '英雄天赋', '套路', '点数'].forEach(function (t) {
        head.appendChild(el('th', null, t));
      });
      tbl.appendChild(head);
      (enc.p || []).forEach(function (p, i) {
        var tr = el('tr');
        tr.appendChild(el('td', null, String(i + 1)));
        tr.appendChild(el('td', null, p[2] || '?'));
        tr.appendChild(el('td', null, T.servers[p[3]] || '?'));
        tr.appendChild(el('td', null, p[4] || '?'));
        tr.appendChild(el('td', null, heroName(T.heroes[p[1]])));
        tr.appendChild(el('td', null, '#' + p[0]));
        tr.appendChild(el('td', null, String(buildPoints(td, p[0]))));
        tbl.appendChild(tr);
      });
      d.appendChild(tbl);
      wrap.appendChild(d);
    });
    return wrap;
  }

  // --------------------------------------------------------- 天赋树数据格式

  // 这是 tools\fetch-talent-tree.js 实际生成的格式，不是设想的格式。
  // 字段顺序由数据自己带的 nodeFormat / entryFormat 声明，改结构要三处一起改：
  // 生成器、tools\verify-talent-tree.js、本文件。
  var TREE_FORMAT_DOC = [
    '// app/talent-tree.js —— 赋值到一个全局变量，和包里其它数据文件一样',
    'window.AE_TALENT_TREE = {',
    '  v: 1,',
    '  nodeFormat: "[posX, posY, maxRanks, typeIdx, reqPoints, entries[], subTreeId, requiresNode]",',
    '  entryFormat: "[entryId, nameIdx, iconIdx, spellId, maxRanks]",',
    '  types: ["single", "choice", "tiered", "subtree"],   // typeIdx 查这里',
    '  names: ["心脏打击", …],        // 中文名字典，节点里只存下标',
    '  icons: ["spell_deathknight_heartstrike", …],       // 图标名字典（本包没带图）',
    '',
    '  // 节点是全局共享的一张表：同职业不同专精的节点坐标 / 点数 / 条目完全一样，',
    '  // 存一份就够（本机实测 4613 次引用 → 2891 个不同节点）。',
    '  nodes: {',
    '    "96167": [3600, 1500, 1, 0, 0, [[123456, 12, 34, 206930, 1]], 0, 0]',
    '  },',
    '',
    '  // 英雄子树：[中文名下标, atlas, [节点id…], 英文名]',
    '  subTrees: { "33": [7, "talents-heroclass-…", [96170, …], "Deathbringer"] },',
    '',
    '  // 拓扑必须按专精存：同一个职业节点在不同专精下连到不同的下一个节点，',
    '  // 白给（free）与否也不同 —— 本机实测有 133 个节点存在这种差异。',
    '  specs: {',
    '    "250": {                     // 键 = specID（250 = 鲜血死骑）',
    '      treeId: 750, cls: "DEATHKNIGHT", specEn: "BLOOD",',
    '      classNodes: [96167, …], specNodes: [], heroNodes: [], subNodes: [],',
    '      subTreeIds: [33, 31],',
    '      edges: { "96167": [96168, 96170] },   // 画连线用',
    '      free: [96167]                          // 不占点数的节点',
    '    }',
    '  }',
    '};'
  ].join('\n');
  AE.TALENT_TREE_FORMAT = TREE_FORMAT_DOC;

  // ------------------------------------------------------------------ 入口

  AE.openBis = function () {
    AE.openPanel('bis');
    var host = body();

    if (gearLoaded) { render(); return; }
    if (gearLoading) return;
    gearLoading = true;

    if (host) {
      host.textContent = '';
      host.appendChild(el('p', 'note', '正在加载装备数据…'));
    }

    // 上次选的专精 / 视角
    var s = settings();
    if (s.bisSpec) state.key = s.bisSpec;
    // 只认现在还存在的两个视角。'raid' / 'mplus' 是上一版存下来的
    // GearInsight 视角，第 16 轮撤掉了 —— 老设置要**迁到 maxroll**，
    // 不然升级上来的用户会停在一个界面上已经没有按钮的视角里，
    // 而那个视角一切正常地渲染着，谁也看不出为什么切不回去。
    //
    // 迁移要**写回设置**，不能只改 state：state.view 的初值本来就是 'maxroll'，
    // 光不赋值的话这段代码是死的（删掉行为一模一样，任何断言都抓不到）。
    // 写回去才是真做了事 —— 存档里那个不存在的视角名被清掉了。
    if (s.bisView === 'rio' || s.bisView === 'maxroll') state.view = s.bisView;
    else if (s.bisView === 'raid' || s.bisView === 'mplus') {
      state.view = 'maxroll';
      persist({ bisView: 'maxroll' });
    }
    if (s.bisTab === 'gear' || s.bisTab === 'talents') state.tab = s.bisTab;
    if (s.bisTalentCat) state.tcat = s.bisTalentCat;
    // 团本 / 大秘境：只认那两个字，别的一律当没存过（设置文件是用户能手改的）。
    if (s.bisMrKind === 'raid' || s.bisMrKind === 'mplus') state.mrKind = s.bisMrKind;
    if (s.bisLoKind === 'raid' || s.bisLoKind === 'mplus') state.loKind = s.bisLoKind;
    if (s.bisChar) state.charKey = s.bisChar;

    loadDataFile('bis-data.js', 'AE_BIS', function (err) {
      gearLoading = false;
      gearLoaded = true;
      if (err) {
        if (host) {
          host.textContent = '';
          host.appendChild(el('p', 'note', '装备数据读取失败：' + err));
        }
        return;
      }
      // 后面两份都是**可选**数据：加载失败只是少一个视角 / 退化成占位块，
      // 不影响 BisData 那两个视角，所以一律不报错。
      function done() {
        if (state.tab === 'talents') ensureTalents(render);
        else render();
        ensureRio();
        ensureMaxroll();
        // **装备页也要那棵树** —— 不是为了画树，是为了 heroName()：
        // 英雄天赋的中文名在 app/talent-tree.js 的子树表里，没有它装备页那一格
        // 只能显示英文（「英雄天赋 San'layn」），而天赋页写的是「萨莱因」，
        // 同一个东西两个名字。后台拉，到了重画一次，不阻塞首屏。
        if (state.tab !== 'talents' && !global.AE_TALENT_TREE) ensureTree();
      }

      // 图标映射现在是包里自带的，无条件加载；它同时带了品质。
      if (!global.AE_ITEM_ICONS) {
        loadDataFile('item-icons.js', 'AE_ITEM_ICONS', done);
        return;
      }
      done();
    });
  };

  /**
   * 只加载天赋树（app/talent-tree.js）。
   *
   * 装备页要它**只为了英雄天赋的中文名**（heroName），所以不走 ensureTalents()
   * —— 那个会顺带拉 talent-data.js 和 talent-desc.js（506 KB），
   * 装备页一个都用不上。
   */
  var treeLoading = false;
  function ensureTree() {
    if (treeLoading || global.AE_TALENT_TREE) return;
    treeLoading = true;
    loadDataFile('talent-tree.js', 'AE_TALENT_TREE', function () {
      treeLoading = false;
      if (global.AE_TALENT_TREE && gearLoaded) render();
    });
  }

  /**
   * 后台加载 app/rio-data.js（实测 849.3 KB），到了再重画一次。
   *
   * **故意不阻塞首屏**：它是可选数据，只多一个「实战分布」视角，
   * 让 849 KB 拖住面板打开是不划算的。更要紧的是，早先的写法把 render()
   * 放在它的回调里，于是「这份文件根本没被加载」这种情况会让整个面板
   * 一片空白 —— 测试里正是这样炸的（桩没有 <script> 加载机制，回调永不触发，
   * 182 个渲染断言全红）。可选数据的失败必须只影响它自己。
   *
   * 没加载成功的话 renderGear 里那个按钮不会出现（rioSpec() 恒为 null），
   * 而不是出一个点了没反应的按钮。
   */
  function ensureRio() {
    if (rioLoaded || rioLoading) return;
    if (global.AE_RIO) { rioLoaded = true; return; }
    rioLoading = true;
    loadDataFile('rio-data.js', 'AE_RIO', function () {
      rioLoading = false;
      rioLoaded = true;
      // 数据到了才值得重画；没到就保持现状（两个 BisData 视角照常能用）。
      if (global.AE_RIO && gearLoaded) render();
    });
  }

  /**
   * 后台加载 app/maxroll-data.js（实测 98.4 KB）。
   *
   * 跟 ensureRio 同一套规矩，理由也一样：**可选数据的失败只能影响它自己**。
   * 没加载成功的话「最佳推荐」按钮不出现（mrPick() 恒为 null），
   * 而不是出一个点了没反应的按钮。
   *
   * 它比 rio 小得多（98 KB vs 849 KB），但还是不放进 index.html ——
   * 打开面板才需要，跟 bis-data.js 一样按需加载。
   */
  function ensureMaxroll() {
    if (mrLoaded || mrLoading) return;
    if (global.AE_MAXROLL) { mrLoaded = true; return; }
    mrLoading = true;
    loadDataFile('maxroll-data.js', 'AE_MAXROLL', function () {
      mrLoading = false;
      mrLoaded = true;
      if (global.AE_MAXROLL && gearLoaded) render();
    });
  }

  /**
   * 团本天赋串（app/wcl-data.js，约 90 KB）。
   *
   * 单独懒加载，和 maxroll 那份一样只是**触发**、不等它：天赋页有大秘境那半
   * 就能画，团本这半到了再重画一次多一个按钮。加载不到就只有大秘境 ——
   * 那不是错误，界面上那个按钮条本来就是按「有几类数据」画的。
   */
  var wclLoading = false, wclLoaded = false;
  function ensureWcl() {
    if (wclLoaded || wclLoading) return;
    if (global.AE_WCL) { wclLoaded = true; return; }
    wclLoading = true;
    loadDataFile('wcl-data.js', 'AE_WCL', function () {
      wclLoading = false;
      wclLoaded = true;
      if (global.AE_WCL && gearLoaded) render();
    });
  }

  AE.rerenderBis = function () {
    if (gearLoaded) render();
  };

})(typeof window !== 'undefined' ? window : globalThis);
