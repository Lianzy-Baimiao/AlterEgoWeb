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
 * 天赋导出串（那串复制到游戏里的 base64）**做不到**：它要 treeHash 和
 * serialVersion，两者都只有游戏运行时才有，raidbots 的结构里也没有。
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
    view: 'raid',       // 'raid' | 'mplus'
    tcat: 'raid',       // 'raid' | 'mplusHigh' | 'mplusFarm'
    charKey: '',        // 对照哪个角色的实际装备，'' = 不对照
    build: -1           // 天赋树画哪一套，-1 = 该类别里用得最多的那套
  };

  var gearLoaded = false, gearLoading = false;
  var talLoaded = false, talLoading = false;

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
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.removeChild(img);
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

  function renderGear(host) {
    var B = bis();
    var s = currentSpec();
    if (!s) { host.appendChild(el('p', 'note', '没有这个专精的数据。')); return; }

    setSub('数据 ' + (B.updatedAt || '?') + '　' + (s.zone || ''));

    // ---- 视角 + 角色对照
    var bar = el('div', 'bis-bar');
    var viewWrap = el('span', 'seg');
    [['raid', '团本视角'], ['mplus', '大秘境视角']].forEach(function (v) {
      var b = button(v[1], state.view === v[0] ? 'on' : null, function () {
        state.view = v[0];
        persist({ bisView: v[0] });
        render();
      });
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

    host.appendChild(renderSpecMeta(s));
    host.appendChild(renderStatTargets(s));

    // ---- 部位
    var slots = s[state.view] || {};
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
      list.appendChild(renderSlot(slotId, rows, mine, hit));
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

    host.appendChild(renderExtras(s));
    host.appendChild(renderFootnote());
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

  function renderSlot(slotId, rows, mine, hit) {
    var B = bis();
    var wrap = el('div', 'slot');

    var head = el('div', 'slot-head');
    head.appendChild(el('b', null, B.slotNames[slotId] || ('部位 ' + slotId)));

    // 覆盖率 = 这个部位列出来的几件的使用率之和。
    //
    // 为什么要显示它：数据里**没有任何样本量字段**（原始 Lua 就没有，不是转换时丢的），
    // 所以「81%」背后是 5 个人还是 500 个人，谁也不知道。退一步至少能说清另一件事 ——
    // 列表是被截断的。本机实测 1264 个部位组里，使用率之和的中位数只有 72.9%，
    // 有 206 组不到 50%。也就是说很多部位「剩下一半人穿的是什么」根本没在数据里。
    // 不显示的话，用户看到三件候选很容易以为那就是全部。
    var sum = 0;
    rows.forEach(function (r) { sum += (typeof r[2] === 'number' ? r[2] : 0); });
    sum = Math.round(sum * 10) / 10;
    var cov = el('span', 'tag cov' + (sum < 50 ? ' no' : ''), '记录 ' + pct(sum));
    cov.setAttribute('data-tip',
      '这 ' + rows.length + ' 件加起来占顶尖玩家的 ' + pct(sum) + '。'
      + (sum < 99.5 ? '\n剩下的 ' + pct(Math.round((100 - sum) * 10) / 10)
                      + ' 穿的是什么，数据里没有。' : '')
      + '\n另外：这份数据不带样本量，所以百分比背后是几个人也查不到。');
    head.appendChild(cov);

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
  function renderItem(r, isTop, mine) {
    var B = bis();
    var itemId = r[0], ilvl = r[1], usage = r[2], srcIdx = r[3], mx = r[4], trk = r[5];
    var it = B.items[itemId] || {};
    var src = B.srcs[srcIdx] || [];
    var srcText = src[0] || '', cat = src[1] || '', boss = src[2] || '';

    var row = el('div', 'item' + (isTop ? ' top' : ''));
    if (mine && mine.itemId === itemId) row.classList.add('have');

    // 图标：包里有图就出图，没有就出一个按来源上色的占位块。
    var icon = el('span', 'icon');
    var img = iconImg(itemId, 24);
    if (img) {
      icon.appendChild(img);
    } else {
      icon.classList.add('ph');
      icon.style.borderColor = catColor(cat);
      icon.textContent = CAT_GLYPH[cat] || '?';
    }
    row.appendChild(icon);

    var main = el('span', 'im');
    var name = el('b', null, it.n || ('物品 ' + itemId));
    // 品质来自 app/item-icons.js（BisData 自己没有这个字段）。查不到就不上色，
    // 而不是默认紫色 —— 默认紫会把蓝色附魔和白色合剂都染错。
    var q = itemQuality(itemId);
    if (q != null && L.qualityColors[q]) name.style.color = L.qualityColors[q];
    main.appendChild(name);

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

    var badge = el('span', 'tag', B.sourceCategories[cat] || cat || '?');
    badge.style.borderColor = catColor(cat);
    badge.style.color = catColor(cat);
    badge.setAttribute('data-tip', srcText || '来源未知');
    row.appendChild(badge);

    var u = el('span', 'usage');
    var track = el('span', 'track');
    var fill = el('span', 'fill');
    fill.style.width = Math.max(2, Math.min(100, usage)) + '%';
    track.appendChild(fill);
    u.appendChild(track);
    u.appendChild(el('span', 'n', pct(usage)));
    u.setAttribute('data-tip', '顶尖玩家里有 ' + pct(usage) + ' 的人这个部位用它'
      + (boss ? '\n掉落：' + boss : '')
      + (srcText ? '\n' + srcText : ''));
    row.appendChild(u);

    row.setAttribute('data-tip', (it.n || '') + '\nitemID ' + itemId
      + '\n装等 ' + ilvl + (mx && mx > ilvl ? '（可升到 ' + mx + '）' : '')
      + '\n' + (srcText || '来源未知')
      + '\n使用率 ' + pct(usage));
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

  function renderFootnote() {
    var B = bis();
    var p = el('p', 'note bis-foot');
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

    host.appendChild(renderBuildStats(td));
    host.appendChild(renderEncounters(T, td));
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
  var CELL_W = 74, CELL_H = 44, GRID_TOL = 100;

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

  /** 节点上显示的名字：选了哪一边就显那一边。 */
  function nodeLabel(n, hit) {
    var TR = tree();
    var ents = n[5] || [];
    var e = null;
    if (hit) {
      for (var i = 0; i < ents.length; i++) if (ents[i][0] === hit.eid) e = ents[i];
    }
    if (!e) e = ents[0];
    return e ? (TR.names[e[1]] || '') : '';
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
    canvas.setAttribute('aria-label',
      title + '天赋树，' + list.length + ' 个天赋，点了 ' + litCount + ' 个，共 ' + pts + ' 点');

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

    box.appendChild(el('p', 'note',
      '节点上没有图标是故意的 —— 全部天赋图标要多带 2094 张图（约 4.6 MB，'
      + '是现在整个包的三倍），而坐标 / 连线 / 中文名 / 点数不带图标也能看清楚。'));
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
    if (s.bisView === 'raid' || s.bisView === 'mplus') state.view = s.bisView;
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
      // 图标映射现在是包里自带的，无条件加载；它同时带了品质。
      // 加不到也不报错 —— 那时候退化成占位块，功能不受影响。
      if (!global.AE_ITEM_ICONS) {
        loadDataFile('item-icons.js', 'AE_ITEM_ICONS', function () {
          if (state.tab === 'talents') ensureTalents(render);
          else render();
        });
        return;
      }
      if (state.tab === 'talents') ensureTalents(render);
      else render();
    });
  };

  AE.rerenderBis = function () {
    if (gearLoaded) render();
  };

})(typeof window !== 'undefined' ? window : globalThis);
