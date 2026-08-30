/*
 * WowAltBoard - app/bis.js
 *
 * 毕业装备 / 天赋面板。数据来自 GearInsight 插件自带的静态参照表，由
 * tools\gen-bis.js 和 tools\gen-talents.js 预转换成 app/bis-data.js 与
 * app/talent-data.js，随发布包一起发 —— 用户不用另外下载，也不必装插件。
 *
 * 两份数据都是按需加载：装备表 ~170 KB，天赋表 ~500 KB，大多数人开表格是来看
 * 角色进度的，不该为这个面板付启动成本。和 data/backups.js 同一个套路。
 *
 * ⚠ 关于「天赋模拟」：天赋树的结构（节点坐标 / 连线 / 图标 / 名称）不在插件里。
 *   插件自己显示天赋时是调游戏运行时的 C_Traits API 现查的，网页没有这些 API。
 *   插件文件里能找到的只有 entryID + 点数，连节点叫什么都没有。
 *   所以：
 *     · 有 window.AE_TALENT_TREE  → 画出真正的天赋树，可点、可模拟；
 *     · 没有                      → 退化成「热门套路 + 点数分布 + 来源玩家」，
 *                                   并在界面上说清楚缺什么、怎么补。
 *   AE_TALENT_TREE 的格式见本文件末尾 TREE_FORMAT_DOC。
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
    charKey: ''         // 对照哪个角色的实际装备，'' = 不对照
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

  /** 图标名 -> 可用的图片地址。没有配置图标源就返回 null（画占位块）。 */
  function iconUrl(name) {
    if (!name) return null;
    var base = String(settings().iconBaseUrl || '').trim();
    if (!base) return null;
    return base.replace(/\/+$/, '') + '/' + name + '.jpg';
  }

  /** itemId -> 图标名。需要另一份映射数据，没有就返回空。 */
  function itemIcon(itemId) {
    var m = global.AE_ITEM_ICONS;
    if (!m) return '';
    return m[itemId] || '';
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

  // 部位条目：[itemId, ilvl, 使用率, 来源下标, 可升级上限?]
  function renderItem(r, isTop, mine) {
    var B = bis();
    var itemId = r[0], ilvl = r[1], usage = r[2], srcIdx = r[3], mx = r[4];
    var it = B.items[itemId] || {};
    var src = B.srcs[srcIdx] || [];
    var srcText = src[0] || '', cat = src[1] || '', boss = src[2] || '';

    var row = el('div', 'item' + (isTop ? ' top' : ''));
    if (mine && mine.itemId === itemId) row.classList.add('have');

    // 图标：有图标源就出图，没有就出一个按来源上色的占位块。
    var icon = el('span', 'icon');
    var iname = itemIcon(itemId);
    var url = iconUrl(iname);
    if (url) {
      var img = doc.createElement('img');
      img.src = url;
      img.alt = '';
      img.width = 24;
      img.height = 24;
      icon.appendChild(img);
    } else {
      icon.classList.add('ph');
      icon.style.borderColor = catColor(cat);
      icon.textContent = CAT_GLYPH[cat] || '?';
    }
    row.appendChild(icon);

    var main = el('span', 'im');
    var name = el('b', null, it.n || ('物品 ' + itemId));
    // BiS 列表里的东西在实际数据里全是紫装（我在本机 2187 件上验过没有 quality
    // 字段，所以这里用装等来源上色，不假装知道品质）。
    name.style.color = L.qualityColors[4];
    main.appendChild(name);

    var sub = el('span', 'sub2');
    sub.textContent = String(ilvl) + (mx && mx > ilvl ? '→' + mx : '');
    main.appendChild(sub);

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
        c.appendChild(el('b', null, row[1] || ('宝石 ' + row[0])));
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
          c.appendChild(el('b', null, en[1] || ('附魔 ' + en[0])));
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
          var url = iconUrl(it.icon);
          if (url) {
            var img = doc.createElement('img');
            img.src = url; img.alt = ''; img.width = 16; img.height = 16;
            chip.appendChild(img);
          }
          chip.appendChild(el('b', null, it.n));
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
      talLoading = false;
      talLoaded = true;
      if (err && AE.toast) AE.toast(err, 'warn');
      done();
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
    box.appendChild(el('b', null, '天赋树画不出来 —— 缺的是「树的结构」，不是天赋本身'));
    var p = el('p', null,
      '插件里存的是「哪个 entryID 点了几点」，没有节点名称、图标、坐标和连线。'
      + '插件自己在游戏里显示天赋时，是调游戏的 C_Traits 接口现查的，网页没有这些接口。'
      + '所以下面能给出「谁在用哪套、每套多少点、英雄天赋怎么分布」，但画不出可点的天赋树。');
    box.appendChild(p);
    var p2 = el('p', null,
      '补上一份天赋树数据（节点坐标 / 图标 / 名称 / 连线）就能画出来并支持模拟。'
      + '把它放成 app/talent-tree.js，或者在设置里配一个远端地址。格式说明：');
    box.appendChild(p2);
    var pre = el('pre', 'fmt', TREE_FORMAT_DOC);
    box.appendChild(pre);
    return box;
  }

  /** 有 AE_TALENT_TREE 时画真正的树。 */
  function renderTree(td) {
    var TR = tree();
    var node = TR[td.specId] || TR[String(td.specId)];
    if (!node) {
      var p = el('p', 'note', '天赋树数据里没有 specID ' + td.specId + '。');
      return p;
    }
    var box = el('div', 'bis-tree');
    box.appendChild(el('p', 'note',
      '天赋树数据已加载（' + (node.nodes ? node.nodes.length : 0) + ' 个节点）。'
      + '点节点可以加减点数，右上角能导出。'));
    // 真正的画树 / 模拟在拿到数据格式后补 —— 现在先把入口和数据通道留好，
    // 不假装画了一棵空树。
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
        var hero = T.heroes[p[1]] || '?';
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
        var c = el('span', 'chip');
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
    b.appendChild(el('p', 'note',
      '「套路」只能给编号 —— 没有天赋树数据的话，一套天赋只是一串 entryID，'
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
        tr.appendChild(el('td', null, T.heroes[p[1]] || '?'));
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

  var TREE_FORMAT_DOC = [
    '// app/talent-tree.js —— 赋值到一个全局变量，和包里其它数据文件一样',
    'window.AE_TALENT_TREE = {',
    '  "250": {                       // 键 = specID（250 = 鲜血死骑）',
    '    treeId: 1234,                // C_Traits 的 treeID',
    '    treeHash: "a1b2c3...",       // 16 字节树哈希的十六进制，导出串要用',
    '    serialVersion: 2,            // C_Traits.GetLoadoutSerializationVersion()',
    '    nodes: [',
    '      {',
    '        id: 96167,               // nodeID',
    '        x: 3, y: 1,              // 网格坐标（或像素坐标，两种都行）',
    '        maxRanks: 1,',
    '        type: "single",          // single | choice | passive',
    '        sub: "class",            // class | spec | hero  —— 分左右/英雄子树',
    '        reqPoints: 0,            // 解锁需要的本树点数',
    '        next: [96168, 96170],    // 连到哪些 nodeID（画连线用）',
    '        entries: [',
    '          { id: 123456,          // entryID —— 和天赋数据里的对得上',
    '            name: "心脏打击",     // 中文名（zhCN 客户端的串）',
    '            icon: "spell_deathknight_heartstrike",',
    '            spellId: 206930,',
    '            desc: "..." }        // 可选',
    '        ]',
    '      }',
    '    ]',
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
      // 图标映射是可选的，有就加载，没有就算了（不报错 —— 包里本来就没有）
      if (String(settings().iconBaseUrl || '').trim() && !global.AE_ITEM_ICONS) {
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
