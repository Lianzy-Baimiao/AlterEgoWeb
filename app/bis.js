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
    // 'maxroll' | 'raid' | 'mplus' | 'rio'
    //   maxroll = maxroll.gg 的编辑推荐（**默认视角**，用户第 15 轮定的）
    //   raid / mplus = GearInsight 的参照表
    //   rio = raider.io 实战分布
    //
    // 默认给 maxroll 而不是 raid：它回答的是「我该穿什么」，那是打开这个面板
    // 最常见的目的。但 app/maxroll-data.js 是**懒加载**的，首屏那一瞬间
    // mrPick() 还是 null —— renderGear 里因此有一条兜底，见下面 fallbackView()。
    view: 'maxroll',
    tcat: 'raid',       // 'raid' | 'mplusHigh' | 'mplusFarm'
    charKey: '',        // 对照哪个角色的实际装备，'' = 不对照
    build: -1,          // 天赋树画哪一套，-1 = 该类别里用得最多的那套
    loadout: 0          // 显示第几条官方导入串（rioLoadouts 排序后的下标）
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
   * maxroll 的一个视角 -> 面板要的行形状。
   *
   * 产物里每个槽位是 `bis: [itemId…]` 和 `alt: [itemId…]` 两个**有序**列表
   * （顺序就是 maxroll 表里的顺序）。这里拼成面板的行形状：
   *   `[itemId, 装等, 使用率, 来源下标, 可升级上限, 轨道码, 人数, 名次, 是不是替代件]`
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
    function ilvlOf(id) {
      // maxroll 不给装等。rio 那边有「平均装等」，能对上就借来显示，
      // 对不上就留 0 —— 不猜。
      var R = rio();
      var ri = R && R.items ? R.items[String(id)] : null;
      return (ri && ri.ilvl) || 0;
    }
    Object.keys(v.bis || {}).forEach(function (k) {
      var list = v.bis[k] || [];
      rows[k] = list.map(function (id, i) {
        return [id, ilvlOf(id), null, -2, 0, 0, null, i + 1, false];
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
        into.push([id, ilvlOf(id), null, -2, 0, 0, null, i + 1, true]);
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
   * rio 里这个专精的官方天赋导入串，按「同一串多少人用」聚合后降序。
   *
   * 返回 {list: [串], count: {串: 人数}, total: 总人数, uniq: 种类数} 或 null。
   * 同人数时按串本身排序 —— 不这样的话 Object.keys 的顺序一变，界面上
   * 「#1 热门」指的就是另一串了，而这种不稳定在测试里表现为偶发失败。
   */
  function rioLoadouts(specId) {
    var rs = rioSpec(specId);
    if (!rs || !rs.loadouts || !rs.loadouts.length) return null;
    var count = Object.create(null);
    var total = 0;
    rs.loadouts.forEach(function (str) {
      if (!str) return;
      count[str] = (count[str] || 0) + 1;
      total++;
    });
    var list = Object.keys(count);
    if (!list.length) return null;
    list.sort(function (a, b) {
      if (count[b] !== count[a]) return count[b] - count[a];
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return { list: list, count: count, total: total, uniq: list.length };
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

  function currentChar() {
    if (!state.charKey) return null;
    var list = characters();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === state.charKey) return list[i];
    }
    return null;
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

  function render() {
    var host = body();
    if (!host) return;
    host.textContent = '';

    var B = bis();
    if (!B) {
      host.appendChild(el('p', 'note', '装备数据还没加载。'));
      return;
    }
    if (!byClass) buildClassIndex();

    host.appendChild(renderTabs());
    host.appendChild(renderPicker());

    if (state.tab === 'gear') renderGear(host);
    else renderTalents(host);
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
          persist({ bisSpec: key });
          render();
        });
        b.setAttribute('data-tip', s.cls + '/' + s.spec +
          '　英雄天赋 ' + (s.hero || '(无)') +
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
    var VIEWS = [
      ['maxroll', '最佳推荐', 'maxroll.gg 的职业指南：编辑给出的 Best in Slot 排序 '
        + '+ 可刷替代。**没有样本量也没有使用率** —— 它是推荐，不是统计'],
      ['raid', '团本视角', '来自 GearInsight 的团本参照表'],
      ['mplus', '大秘境视角', '来自 GearInsight 的大秘境参照表'],
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

    host.appendChild(renderSpecMeta(s));
    // 属性权重 / 达成度是 **GearInsight 独有的**，raider.io 的角色档案里没有。
    // rio 视角下不画它 —— 脚注明写了「这个视角没有属性权重」，一边这么写一边
    // 把另一个数据源的权重摆在上面，那句话就成了假话。
    // maxroll 同理：它的指南页有属性优先级的文字说明，但产物里没抓那部分，
    // 所以这里也不画 —— 没抓到的东西不能借别的数据源的数字充。
    if (!rs && !mr) host.appendChild(renderStatTargets(s));

    // ---- 部位
    var slots = conv ? conv.rows : (s[view] || {});
    var ch = currentChar();
    var list = el('div', 'bis-slots');
    var missing = 0, matched = 0, unknown = 0;

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
      // conv.n 可能整个不存在（maxroll 那份没有样本量），所以这里不假设它在。
      list.appendChild(renderSlot(slotId, rows, mine, hit,
        conv && conv.n ? conv.n[slotId] : null));
    });
    host.appendChild(list);

    if (ch) {
      var sum = el('p', 'bis-sum');
      sum.appendChild(el('b', null, ch.name));
      if (ch.classFile !== s.cls) {
        sum.appendChild(el('b', 'warn', '　职业不是' + specLabel(s) + '所属职业，下面的对照只能当参考'));
      }
      sum.appendChild(doc.createTextNode('　对上 ' + matched + ' 件，差 ' + missing + ' 件'
        + (unknown ? '，' + unknown + ' 个部位存档里没记录' : '') + '。'));
      sum.appendChild(el('span', 'note',
        '　「对上」= 身上这件正好在该部位的推荐列表里。装等更高的同名替代品不算。'));
      host.insertBefore(sum, list);
    }

    // 宝石 / 附魔同理，只有 GearInsight 有。
    if (!rs) host.appendChild(renderExtras(s));
    host.appendChild(renderFootnote(s));
  }

  function renderSpecMeta(s) {
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
    wrap.appendChild(cell('英雄天赋', s.hero || '(无)',
      '这套推荐是按这个英雄天赋统计的'));

    var w = s.weapon && s.weapon[state.view === 'raid' ? 'raid' : 'mplusHigh'];
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

  function renderStatTargets(s) {
    var B = bis();
    var wrap = el('details', 'sec bis-stats');
    var sum = el('summary', null, '属性目标');
    wrap.appendChild(sum);

    var which = state.view === 'raid' ? 'raid' : 'high';
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
        + '这份数据**没有样本量也没有使用率** —— 它是编辑的推荐排序，不是统计。\n'
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
    var isMr = srcIdx === -2, rank = r[7], isAlt = r[8];

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

    var sub = el('span', 'sub2');
    sub.textContent = String(ilvl) + (mx && mx > ilvl ? '→' + mx : '');
    main.appendChild(sub);

    var tl = trackLabel(trk);
    if (tl) {
      var tb = el('span', 'tag trk', tl);
      tb.setAttribute('data-tip', '升级轨道，从装备的 bonusID 解出来的\n'
        + '（' + tl + ' = 这条轨道的第 ' + (trk % 10) + ' 级，满级 6 级）');
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
      // 这一段是这个视角最要紧的一句话。maxroll 给的是排序，不是统计 ——
      // 界面上到处都没有百分比，脚注必须解释为什么没有，否则看起来像是数据缺了。
      p.appendChild(doc.createTextNode(
        '这是 maxroll 编辑给出的**推荐排序**，不是使用率统计：'
        + '它没有样本量，也没有「多少人这么穿」。所以这里画的是名次'
        + '（BiS #1 = 编辑的首选，替代 #1 = 可刷替代表里的第一个），不画使用率条 —— '
        + '那个数没人算过，画出来就是编的。'));
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '想看「榜上的人真的穿什么、多少人这么穿」，切到「实战分布」；'
        + '想看属性权重 / 宝石 / 掉落来源，切到前两个视角。'
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
        '每个部位的百分比 = 该部位穿这件的人数 / 该部位样本量，'
        + '分布不截断，所以同一个部位所有候选加起来正好是 100%。'
        + '物品中文名来自暴雪 DB2（' + ((R && R.itemNameSource) || '?') + '）。'));
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '这个视角没有属性权重 / 宝石 / 附魔 / 掉落来源 —— raider.io 的角色档案里没有这些，'
        + '要看那些切到「团本视角」或「大秘境视角」。'));
      return p;
    }

    p.appendChild(doc.createTextNode(
      '数据来自 GearInsight 插件自带的参照表（' + (B.source || '未知来源') + '），'
      + '统计日期 ' + (B.updatedAt || '?') + '，插件版本 ' + (B.addonVersion || '?') + '。'));
    p.appendChild(el('br'));
    p.appendChild(doc.createTextNode(
      '这是「顶尖玩家实际在用什么」的统计，不是模拟器算出来的理论最优。'
      + '使用率低不代表差 —— 也可能只是难拿。'));
    if (!global.AE_ITEM_ICONS) {
      p.appendChild(el('br'));
      p.appendChild(doc.createTextNode(
        '装备图标：数据里只有 itemID，没有图标名。配置图标源后才会出图，'
        + '现在显示的是按来源上色的占位块。'));
    }
    return p;
  }

  // ------------------------------------------------------------ 天赋页

  function ensureTalents(done) {
    if (talLoaded) { done(); return; }
    if (talLoading) return;
    talLoading = true;
    setSub('正在加载天赋数据…');
    loadDataFile('talent-data.js', 'AE_TALENTS', function (err) {
      if (err && AE.toast) AE.toast(err, 'warn');
      // 树结构是另一个文件（app/talent-tree.js，约 415 KB）。它是**可选的**：
      // 加载不到就退回「只有统计、没有树」的旧样子，功能不受影响。
      // 所以这里不把它的失败当错误，也不弹提示。
      if (global.AE_TALENT_TREE) { talLoading = false; talLoaded = true; done(); return; }
      loadDataFile('talent-tree.js', 'AE_TALENT_TREE', function () {
        talLoading = false;
        talLoaded = true;
        done();
      });
    });
  }

  var TCAT = [['raid', '团本'], ['mplusHigh', '冲分'], ['mplusFarm', '割草']];

  function renderTalents(host) {
    var T = talents();
    var s = currentSpec();
    if (!s) return;

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

    setSub('天赋　' + specLabel(s) + '　共 ' + td.builds.length + ' 套');

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

    // 官方导入串。放在树后面、统计前面 —— 看完树才会想「怎么弄到我号上」。
    var lo = renderLoadouts(s);
    if (lo) host.appendChild(lo);

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
  function renderLoadouts(s) {
    if (!s || !s.specId) return null;
    var lo = rioLoadouts(s.specId);
    if (!lo) return null;

    var idx = state.loadout;
    if (!(idx >= 0) || idx >= lo.list.length) idx = 0;
    var str = lo.list[idx];

    var box = el('div', 'bis-loadout');
    var head = el('div', 'lo-head');
    head.appendChild(el('b', null, '天赋导入串'));
    head.appendChild(el('span', 'n',
      lo.total + ' 名玩家共 ' + lo.uniq + ' 种，下面是最热门的几种'));
    box.appendChild(head);

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
      '这几串是 raider.io 上大秘境排行榜玩家身上原样取下来的官方串，'
      + '面板没有改动一个字符，也没有自己编码 —— 所以它们本来就能导进游戏。'
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
  var heroZhMap = null;
  function heroName(en) {
    if (!en) return '?';
    if (!heroZhMap) {
      heroZhMap = {};
      var TR = tree();
      if (TR && TR.subTrees) {
        Object.keys(TR.subTrees).forEach(function (sid) {
          var s = TR.subTrees[sid];
          if (s && s[3] && TR.names[s[0]]) heroZhMap[s[3]] = TR.names[s[0]];
        });
      }
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
      (n[5] || []).forEach(function (e) {
        tip.push((hit && e[0] === hit.eid ? '▸ ' : '· ') + (TR.names[e[1]] || '?'));
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
    [[sp.classNodes, '职业天赋'],
     [sp.specNodes, '专精天赋'],
     [heroIds, '英雄天赋' + (sub ? '：' + subTreeName(sub) : '')]
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
    if (s.bisView === 'raid' || s.bisView === 'mplus' || s.bisView === 'rio'
      || s.bisView === 'maxroll') state.view = s.bisView;
    if (s.bisTab === 'gear' || s.bisTab === 'talents') state.tab = s.bisTab;
    if (s.bisTalentCat) state.tcat = s.bisTalentCat;
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

  AE.rerenderBis = function () {
    if (gearLoaded) render();
  };

})(typeof window !== 'undefined' ? window : globalThis);
