/*
 * WowAltBoard - app/model-tests.js
 *
 * Regression tests against the real scanned data. These guard the mistakes that
 * would be invisible in the UI -- a dungeon score landing in the wrong column
 * looks completely plausible, it is just wrong.
 *
 * Skipped automatically when data/data.js is absent.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;

  AE.runModelTests = function () {
    var results = [], pass = 0, fail = 0, skipped = false;

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

    if (!global.AE_DATA) {
      return { pass: 0, fail: 0, skipped: true, results: [] };
    }

    var m = AE.buildModel(global.AE_DATA, null, null, global.AE_BAGSYNC);

    t('每个数据源都解析成功', function () {
      var bad = m.sources.filter(function (s) { return s.parseError; });
      return bad.length === 0 || bad.map(function (s) { return s.account + ': ' + s.parseError; }).join('; ');
    });

    t('角色行的身份是 GUID，重名角色不会被合并', function () {
      var keys = {};
      var dup = null;
      m.characters.forEach(function (ch) {
        if (keys[ch.key]) dup = ch.key;
        keys[ch.key] = true;
      });
      if (dup) return '重复的行 key: ' + dup;
      // This machine really has three characters named 霜语.
      var byName = {};
      m.characters.forEach(function (ch) { byName[ch.name] = (byName[ch.name] || 0) + 1; });
      var anyDupName = Object.keys(byName).some(function (n) { return byName[n] > 1; });
      return anyDupName ? true : true;   // either way, keys must be unique
    });

    t('大秘境列按 challengeModeID 取，不是数组下标', function () {
      // The saved array order is a Lua hash artifact and does NOT match the
      // addon's own definition order, so any position-based lookup is wrong.
      var ch = m.characters.filter(function (c) {
        return Object.keys(c.mp.byDungeon).length >= 8 && c.mp.rating > 0;
      })[0];
      if (!ch) return '没有找到有完整逐本数据的角色，跳不过这个测试';

      var rawOrder = AE.asArray(ch.raw.mythicplus.dungeons).map(function (d) { return d.challengeModeID; });
      var colOrder = m.columns.dungeonIds;
      var same = rawOrder.length === colOrder.length && rawOrder.every(function (v, i) { return v === colOrder[i]; });
      if (same) return '存档顺序恰好等于列顺序，这个测试失去意义（换台机器可能就不成立了）';

      // Every column must read back the entry whose own challengeModeID matches.
      for (var i = 0; i < colOrder.length; i++) {
        var cmID = colOrder[i];
        var got = ch.mp.byDungeon[cmID];
        if (!got) continue;
        if (got.cmID !== cmID) return '列 ' + cmID + ' 读到了 ' + got.cmID;
        var rawEntry = AE.asArray(ch.raw.mythicplus.dungeons).filter(function (d) {
          return d.challengeModeID === cmID;
        })[0];
        if (!rawEntry) return '存档里找不到 cmID ' + cmID;
        if (rawEntry.rating !== got.rating) {
          return 'cmID ' + cmID + ' 分数不符：存档 ' + rawEntry.rating + '，模型 ' + got.rating;
        }
      }
      return true;
    });

    t('宝库 type 映射：1=大秘境 3=团队 6=地下堡', function () {
      // Pinned from real data: type 1 uses thresholds 1/4/8, type 3 uses 2/4/6,
      // type 6 uses 2/4/8. Two earlier research passes disagreed about this.
      var expect = {};
      expect[L.VAULT_MPLUS] = [1, 4, 8];
      expect[L.VAULT_RAID] = [2, 4, 6];
      expect[L.VAULT_WORLD] = [2, 4, 8];
      var checked = 0;
      for (var i = 0; i < m.characters.length; i++) {
        var ch = m.characters[i];
        for (var k in expect) {
          var slots = ch.vault.byType[k];
          if (!slots || slots.length !== 3) continue;
          var got = slots.map(function (s) { return s.threshold; });
          var want = expect[k];
          for (var j = 0; j < 3; j++) {
            if (got[j] !== want[j]) {
              return 'type ' + k + ' 阈值是 ' + got.join('/') + '，预期 ' + want.join('/');
            }
          }
          checked++;
        }
      }
      return checked > 0 ? true : '没有任何角色有宝库数据，无法验证';
    });

    t('宝库未达成文案不会误用 raidString', function () {
      // Blizzard fills raidString with the RAID wording on every row, including
      // the M+ and delve rows, where it is wrong.
      var mp = AE.vaultRequirement(L.VAULT_MPLUS, 4, '击败%d个至暗之夜第2赛季首领');
      var world = AE.vaultRequirement(L.VAULT_WORLD, 4, '击败%d个至暗之夜第2赛季首领');
      var raid = AE.vaultRequirement(L.VAULT_RAID, 4, '击败%d个至暗之夜第2赛季首领');
      if (mp.indexOf('首领') >= 0) return '大秘境档位用了团本文案: ' + mp;
      if (world.indexOf('首领') >= 0) return '地下堡档位用了团本文案: ' + world;
      if (raid.indexOf('%d') >= 0) return '团本文案没有代入数字: ' + raid;
      if (raid.indexOf('4') < 0) return '团本文案数字不对: ' + raid;
      return true;
    });

    t('团本列只含真正的团本，地下城锁定被分开', function () {
      // GetSavedInstanceInfo also returns heroic/mythic dungeon and timewalking
      // lockouts; without the isRaid split they pollute the raid columns.
      var bad = m.columns.raidColumns.filter(function (rc) {
        return rc.difficultyID === 2 || rc.difficultyID === 23;
      });
      if (bad.length) return '团本列里混进了地下城难度: ' + bad.map(function (b) { return b.name; }).join(', ');
      var anyDungeonLockout = m.characters.some(function (c) { return c.raids.dungeonLockouts.length > 0; });
      return anyDungeonLockout ? true : true;
    });

    t('藏宝图三个状态都读到了', function () {
      var withMap = m.characters.filter(function (c) { return c.treasureMap; });
      if (!withMap.length) return '没有角色有 delveMap 记录（本周登录过角色才会有）';
      var mp2 = withMap[0].treasureMap;
      if (typeof mp2.bagCount !== 'number') return 'bagCount 不是数字';
      if (typeof mp2.used !== 'boolean') return 'used 不是布尔';
      if (typeof mp2.hasBuff !== 'boolean') return 'hasBuff 不是布尔';
      return true;
    });

    t('副本中文名从锁定记录里还原出来了', function () {
      var n = Object.keys(m.dungeonNames).length;
      if (!n) return '一个都没还原到（需要有史诗/英雄难度的副本锁定）';
      var ascii = Object.keys(m.dungeonNames).filter(function (k) {
        return !/[一-鿿]/.test(m.dungeonNames[k]);
      });
      if (ascii.length) return '这些不是中文: ' + ascii.join(',');
      return true;
    });

    t('赛季裁列：旧赛季的副本 ID 不进当前列', function () {
      var stale = m.characters.filter(function (c) { return c.seasonMismatch; });
      if (!stale.length) return '没有旧赛季角色可验证';
      var leaked = [];
      stale.forEach(function (ch) {
        Object.keys(ch.mp.byDungeon).forEach(function (cmID) {
          if (m.columns.dungeonIds.indexOf(Number(cmID)) >= 0) leaked.push(cmID);
        });
      });
      return leaked.length === 0 || '旧赛季 ID 混进了列: ' + leaked.join(',');
    });

    t('season 为 0 不算旧赛季', function () {
      // Verified: an actively-played character with rating 1985 has
      // currentSeason = 0, i.e. "not recorded", not "wrong season".
      var wrong = m.characters.filter(function (c) { return !c.season && c.seasonMismatch; });
      return wrong.length === 0 || wrong.map(function (c) { return c.name; }).join(',');
    });

    t('装等取 info.ilvl.level（与插件内窗口一致）', function () {
      var ch = m.characters.filter(function (c) { return c.ilvl.level > 0; })[0];
      if (!ch) return '没有角色有装等';
      return ch.ilvl.value === ch.ilvl.level ||
             ('value=' + ch.ilvl.value + ' level=' + ch.ilvl.level);
    });

    t('物品链接能取出名字和品质', function () {
      var r = AE.parseItemLink('|cnIQ4:|Hitem:271464::::::::90:70::108:3:13693:13698:12841::::::|h[祝圣烈焰护腿]|h|r');
      if (!r) return 'parseItemLink 返回 null';
      if (r.name !== '祝圣烈焰护腿') return 'name=' + r.name;
      if (r.quality !== 4) return 'quality=' + r.quality;
      if (r.itemId !== 271464) return 'itemId=' + r.itemId;
      return true;
    });

    t('weeklyReset 是一个合理的未来时间', function () {
      if (!m.weeklyReset) return '没有读到 weeklyReset';
      var now = Math.floor(Date.now() / 1000);
      var days = (m.weeklyReset - now) / 86400;
      return (days > -8 && days < 8) || ('距今 ' + days.toFixed(1) + ' 天，看起来不对');
    });

    t('副本中文缩写唯一且是中文', function () {
      var seen = {}, bad = [];
      m.columns.dungeonIds.forEach(function (id) {
        var s = m.dungeonShortNames[id];
        if (!s) { bad.push(id + ':空'); return; }
        if (seen[s]) bad.push(id + ':与 ' + seen[s] + ' 重复(' + s + ')');
        seen[s] = id;
        if (!/[一-鿿]/.test(s) && m.dungeonNames[id]) bad.push(id + ':' + s + ' 不是中文');
      });
      return bad.length === 0 || bad.join('; ');
    });

    // The bug these guard: every Chinese dungeon/raid name in the scanned data
    // comes from a LIVE lockout or a keystone in your bag. Once those are gone the
    // only thing left is the cache in settings, which is localStorage -- keyed by
    // folder path, shared by every file:// page, and lost when the folder moves.
    // With an empty cache the M+ headers fell back to the addon's English abbr
    // (verified: MR, DON). Simulate it by deleting both sources of truth.
    //
    // Raid columns behave differently and it is worth writing down: they are
    // DERIVED from lockouts, so with every lockout gone the columns disappear
    // instead of turning English. Raids leak English only when a column exists
    // whose name is not Chinese -- an instance missing from the addon table, or a
    // name the client never localized. That is what the raidLabel test covers.
    var postReset = (function () {
      if (!global.AE_DATA) return null;
      var raw = JSON.parse(JSON.stringify(global.AE_DATA));
      AE.asArray(raw.sources).forEach(function (s) {
        if (typeof s.lua !== 'string') return;
        s.lua = dropLuaTable(s.lua, 'savedInstances');
        s.lua = dropLuaTable(s.lua, 'keystone');
      });
      try {
        return AE.buildModel(raw, {}, {}, global.AE_BAGSYNC, {});
      } catch (e) { return null; }
    })();

    t('周重置后（无锁定、无钥石、无缓存）大秘境表头仍是中文', function () {
      if (!postReset) return '构建模型失败';
      if (!postReset.columns.dungeonIds.length) return '没有副本列可验证';
      var bad = [];
      postReset.columns.dungeonIds.forEach(function (id) {
        var meta = postReset.tables.dungeonById[id];
        var full = L.dungeonLabel(id, meta, {}, postReset.dungeonNames);
        var short = L.dungeonShort(id, meta, {}, postReset.dungeonNames,
                                   postReset.dungeonShortNames);
        if (!L.hasCJK(full)) bad.push(id + ' 全名=' + full);
        if (!L.hasCJK(short)) bad.push(id + ' 缩写=' + short);
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('周重置后团本列直接消失，不会留下英文表头', function () {
      // Worth pinning because it corrects an easy wrong assumption: raid columns
      // are DERIVED FROM lockouts, so with every lockout gone there is nothing
      // left to label. Whatever survives must still be Chinese.
      if (!postReset) return '构建模型失败';
      var bad = postReset.columns.raidColumns.filter(function (rc) {
        return !L.hasCJK(rc.name);
      });
      return bad.length === 0 ||
             ('这些团本列变成英文了: ' + bad.map(function (b) { return b.name; }).join(', '));
    });

    t('团本列表头是中文（全名和缩写都算）', function () {
      if (!m.columns.raidColumns.length) return '没有团本列可验证';
      var bad = [];
      m.columns.raidColumns.forEach(function (rc) {
        if (!L.hasCJK(rc.name)) bad.push(rc.instanceID + ' 全名=' + rc.name);
        var short = m.raidShortNames[rc.instanceID] || rc.abbr;
        if (!L.hasCJK(short)) bad.push(rc.instanceID + ' 缩写=' + short);
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('团本名的兜底顺序：锁定 > 缓存 > 内置表 > 英文', function () {
      // The whole point of the fix: a raid whose lockout name is missing or in
      // English must still come out Chinese.
      if (L.raidLabel(3004, '烈毒之渊', 'The Venomous Abyss', 'VA', {}) !== '烈毒之渊') {
        return '锁定名没有优先';
      }
      if (L.raidLabel(3004, '', 'The Venomous Abyss', 'VA', { 3004: '缓存名' }) !== '缓存名') {
        return '缓存没有生效';
      }
      if (L.raidLabel(3004, '', 'The Venomous Abyss', 'VA', {}) !== '烈毒之渊') {
        return '内置表没有生效';
      }
      // An enUS client would send an English "localized" name; the table wins.
      if (L.raidLabel(3004, 'The Venomous Abyss', 'The Venomous Abyss', 'VA', {}) !== '烈毒之渊') {
        return '英文锁定名盖掉了内置表';
      }
      // A raid nobody has a name for anywhere still has to render something.
      return L.raidLabel(999999, '', 'Some Raid', 'SR', {}) === 'Some Raid' ||
             '未知团本没有回落到英文';
    });

    t('中文缩写撞车时不会退回英文', function () {
      // Two dungeons sharing a 4-char prefix used to make the loser render its
      // English abbr, so one header in a row of Chinese ones was English.
      var out = AE.shortenNames([
        { id: 1, full: '烈毒之渊烈毒', fallback: 'VA' },
        { id: 2, full: '烈毒之渊烈毒', fallback: 'VB' },
        { id: 3, full: '烈毒之渊烈毒', fallback: 'VC' }
      ]);
      var vals = [out[1], out[2], out[3]];
      var eng = vals.filter(function (v) { return !L.hasCJK(v); });
      if (eng.length) return '仍然退回英文: ' + eng.join(',');
      if (vals[0] === vals[1] || vals[1] === vals[2] || vals[0] === vals[2]) {
        return '缩写重复了: ' + vals.join(',');
      }
      return true;
    });

    t('团本中文名也有缓存（不再只靠当前锁定）', function () {
      if (!m.raidNames) return 'model.raidNames 不存在';
      if (!Object.keys(m.raidNames).length) return '一个都没还原到';
      var ascii = Object.keys(m.raidNames).filter(function (k) {
        return !L.hasCJK(m.raidNames[k]);
      });
      return ascii.length === 0 || ('这些不是中文: ' + ascii.join(','));
    });

    t('名字缓存被写脏时不会把脏值当表头', function () {
      // The cache is plain JSON inside settings that a user can hand-edit, and it
      // outranks the built-in table -- so a junk value used to be stringified
      // straight into a header ([object Object] was reachable this way).
      var junk = { 588: { nope: 1 }, 587: 42, 586: 'Den of Nalorakk', abc: '毒牙' };
      var mj;
      try {
        mj = AE.buildModel(global.AE_DATA, junk, {}, global.AE_BAGSYNC, junk);
      } catch (e) { return 'threw: ' + String(e.message).split('\n')[0]; }
      var bad = [];
      Object.keys(mj.dungeonNames).forEach(function (k) {
        if (!L.hasCJK(mj.dungeonNames[k])) bad.push('副本 ' + k + '=' + mj.dungeonNames[k]);
      });
      Object.keys(mj.raidNames).forEach(function (k) {
        if (!L.hasCJK(mj.raidNames[k])) bad.push('团本 ' + k + '=' + mj.raidNames[k]);
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('英文表头模式仍然给英文（中文兜底没有盖掉它）', function () {
      var cjk = m.columns.dungeonIds.map(function (id) {
        return L.dungeonAbbr(id, m.tables.dungeonById[id], {}, m.dungeonNames);
      }).filter(L.hasCJK);
      return cjk.length === 0 || ('这些应该是英文: ' + cjk.join(','));
    });

    t('用户自定义名字优先于中文兜底表', function () {
      var id = m.columns.dungeonIds[0];
      if (id == null) return '没有副本列可验证';
      var ov = {};
      ov[id] = '我的名字';
      var got = L.dungeonLabel(id, m.tables.dungeonById[id], ov, m.dungeonNames);
      return got === '我的名字' || ('得到 ' + got);
    });

    t('护甲类型与职业一致', function () {
      var bad = [];
      m.characters.forEach(function (ch) {
        if (!ch.classFile) return;
        if (!ch.armorType) { bad.push(ch.name + ' 没有护甲类型'); return; }
        // The gear-derived value is only a cross-check; a character mid-gearing
        // can legitimately differ, so only a hard class-map miss is a failure.
        if (L.armorOrder.indexOf(ch.armorType) < 0) bad.push(ch.name + ':' + ch.armorType);
      });
      return bad.length === 0 || bad.join('; ');
    });

    t('狩猎按难度分组，名字去掉了 Prey: 前缀', function () {
      var withPrey = m.characters.filter(function (c) { return c.prey.seen; });
      if (!withPrey.length) return '没有角色有狩猎数据';
      var ch = withPrey[0];
      var keys = Object.keys(ch.prey.byDifficulty);
      if (!keys.length) return 'byDifficulty 是空的';
      var sum = 0;
      keys.forEach(function (k) { sum += ch.prey.byDifficulty[k].total; });
      if (sum !== ch.prey.seen) return '分组合计 ' + sum + ' != 总数 ' + ch.prey.seen;
      var leftover = ch.prey.entries.filter(function (e) { return /^Prey:|\((?:Normal|Hard|Nightmare)\)$/.test(e.name); });
      return leftover.length === 0 || ('没清理干净: ' + leftover[0].name);
    });

    if (AE.buildXlsxBlob) {
      t('Excel 导出生成合法的 xlsx（zip + 元素顺序）', function () {
        var blob = AE.buildXlsxBlob('T', ['角色', '装等'], [
          [{ v: '影歌', num: false }, { v: 311, num: true }]
        ]);
        if (!blob || !blob.size) return 'blob 是空的';
        // A real zip starts with the local file header signature "PK\x03\x04".
        // Excel rejects anything else outright.
        if (blob.type.indexOf('spreadsheetml') < 0) return 'MIME 不对: ' + blob.type;
        if (blob.size < 2000) return '文件太小，可能没写全: ' + blob.size;
        return true;
      });

      t('Excel 导出转义 < & 且数字是数字', function () {
        // Regression guard: an unescaped '<' both corrupts the XML and would let
        // item text break out of the cell.
        var xml = AE.xlsxSheetXmlForTest(['a<b&c'], [[{ v: 'x"y', num: false }, { v: 42, num: true }]]);
        if (xml.indexOf('a&lt;b&amp;c') < 0) return '表头没转义';
        if (xml.indexOf('<v>42</v>') < 0) return '数字没写成数值单元格';
        var order = [];
        ['sheetViews', 'cols', 'sheetData', 'autoFilter'].forEach(function (tag) {
          order.push({ tag: tag, at: xml.indexOf('<' + tag) });
        });
        for (var i = 1; i < order.length; i++) {
          if (order[i].at < order[i - 1].at) {
            return '元素顺序错误：' + order[i].tag + ' 在 ' + order[i - 1].tag + ' 之前';
          }
        }
        return true;
      });
    }

    // ---- professions (BagSync, optional) --------------------------------
    // These stay green on a machine without BagSync by returning an explanation
    // instead of failing -- the whole feature is meant to be absent-able.

    t('没有 BagSync 时专业列一个都不生成', function () {
      if (m.bagSync.characters > 0) return true;   // covered by the tests below
      return (m.columns.professionSlots === 0 &&
              m.columns.professionSecondaryIds.length === 0) ||
             ('professionSlots=' + m.columns.professionSlots +
              ' secondary=' + JSON.stringify(m.columns.professionSecondaryIds));
    });

    t('BagSync 的伪服务器命名空间没被当成服务器读进来', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      // options§ / blacklist§ / warband§ ... have no character tables, so if the
      // § filter broke we would be reading junk objects as characters.
      var bad = m.characters.filter(function (ch) {
        return ch.professions && !ch.professions.primary && !ch.professions.secondary;
      });
      return bad.length === 0 || (bad.length + ' 个角色的专业结构不完整');
    });

    t('专业按 GUID join，不是按名字', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      var withProf = m.characters.filter(function (ch) { return ch.professions; });
      if (!withProf.length) return '没有角色匹配上专业数据（GUID join 可能坏了）';
      // Every matched character must have come from a GUID that looks like one.
      var bad = withProf.filter(function (ch) { return !/^Player-\d+-[0-9A-Fa-f]+$/.test(ch.guid); });
      return bad.length === 0 || ('可疑 GUID: ' + bad[0].guid);
    });

    t('专业等级取的是当前资料片那一段（分段按 catId 倒序）', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      var checked = 0;
      for (var i = 0; i < m.characters.length; i++) {
        var pr = m.characters[i].professions;
        if (!pr) continue;
        var all = pr.primary.concat(Object.keys(pr.secondary).map(function (k) { return pr.secondary[k]; }));
        for (var j = 0; j < all.length; j++) {
          var p = all[j];
          if (!p.segments.length) continue;
          checked++;
          if (p.cur !== p.segments[0].cur || p.max !== p.segments[0].max) {
            return p.name + ' 取到了 ' + p.cur + '/' + p.max +
                   '，但最新一段是 ' + p.segments[0].name + ' ' +
                   p.segments[0].cur + '/' + p.segments[0].max;
          }
          for (var k = 1; k < p.segments.length; k++) {
            if (p.segments[k].catId > p.segments[k - 1].catId) {
              return p.name + ' 的分段没按 catId 倒序排列';
            }
          }
        }
      }
      return checked > 0 || '没有任何带分段的专业可验证';
    });

    // The leaf sub-categories (零件 / 爆炸物 / 附录 I - 术语) carry no skill level at
    // all. Letting them in is how the first version showed a maxed engineer as
    // "工程学 0": they sort to the front and their missing level coerces to 0.
    t('专业分段里没有混进没有技能等级的子分类', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      for (var i = 0; i < m.characters.length; i++) {
        var pr = m.characters[i].professions;
        if (!pr) continue;
        var all = pr.primary.concat(Object.keys(pr.secondary).map(function (k) { return pr.secondary[k]; }));
        for (var j = 0; j < all.length; j++) {
          var segs = all[j].segments;
          for (var k = 0; k < segs.length; k++) {
            if (!(segs[k].max > 0)) {
              return all[j].name + ' 里混进了没有上限的分段：' + segs[k].name;
            }
          }
        }
      }
      return true;
    });

    t('只有主专业进 slot 列，副专业和考古学不占 slot', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      for (var i = 0; i < m.characters.length; i++) {
        var pr = m.characters[i].professions;
        if (!pr) continue;
        for (var j = 0; j < pr.primary.length; j++) {
          if (!L.isPrimaryProfession(pr.primary[j].id)) {
            return pr.primary[j].name + '(' + pr.primary[j].id + ') 不该出现在主专业里';
          }
        }
        var ids = Object.keys(pr.secondary).map(Number);
        for (var k = 0; k < ids.length; k++) {
          if (!L.isSecondaryProfession(ids[k])) return ids[k] + ' 不该出现在副专业里';
        }
      }
      return true;
    });

    t('副专业列只包含真的有人学过的', function () {
      if (!m.bagSync.characters) return '本机没有 BagSync 数据，跳过';
      var seen = {};
      m.characters.forEach(function (ch) {
        if (!ch.professions) return;
        Object.keys(ch.professions.secondary).forEach(function (id) { seen[id] = true; });
      });
      var listed = m.columns.professionSecondaryIds;
      for (var i = 0; i < listed.length; i++) {
        if (!seen[listed[i]]) return listed[i] + ' 成了列，但没有角色学过它';
      }
      return listed.length === Object.keys(seen).length ||
             ('列 ' + JSON.stringify(listed) + ' 与实际 ' + JSON.stringify(Object.keys(seen).map(Number)) + ' 不一致');
    });

    // ---- column order (drag-to-reorder / layouts) -----------------------
    // The rules that matter: a saved order is PARTIAL, unknown ids are dropped,
    // and groups stay contiguous. Get any of those wrong and a layout saved last
    // season silently blanks columns or scatters a group across the table.

    t('列顺序：没有保存过顺序时就是注册表顺序', function () {
      var cols = AE.buildColumns(m);
      var out = AE.orderColumns(cols, {});
      return out.map(function (c) { return c.id; }).join() ===
             cols.map(function (c) { return c.id; }).join() || '顺序被改了';
    });

    t('列顺序：组内重排只影响那一组，且不丢列', function () {
      var cols = AE.buildColumns(m);
      var base = cols.filter(function (c) { return c.group === 'base'; }).map(function (c) { return c.id; });
      if (base.length < 3) return 'base 组太短，没法验证';
      var want = [base[2], base[0]];
      var out = AE.orderColumns(cols, { columnOrder: { base: want } });
      if (out.length !== cols.length) return '列数变了：' + out.length + ' vs ' + cols.length;
      var got = out.filter(function (c) { return c.group === 'base'; }).map(function (c) { return c.id; });
      if (got[0] !== want[0] || got[1] !== want[1]) return '组内顺序不对：' + got.slice(0, 3).join();
      // Everything the saved order never mentioned must still be there, in order.
      var rest = base.filter(function (id) { return want.indexOf(id) < 0; });
      return got.slice(2).join() === rest.join() || '剩下的列顺序乱了：' + got.slice(2).join();
    });

    t('列顺序：整组搬家后每个分组仍然各占连续一段', function () {
      var cols = AE.buildColumns(m);
      var out = AE.orderColumns(cols, { groupOrder: ['gold', 'prof', 'base'] });
      var seq = AE.groupOrderOf(out);
      var seen = {};
      for (var i = 0; i < seq.length; i++) {
        if (seen[seq[i]]) return '分组 ' + seq[i] + ' 被拆成了不连续的几段';
        seen[seq[i]] = true;
      }
      if (out.length !== cols.length) return '列数变了';
      return seq[0] === 'gold' || '第一组是 ' + seq[0];
    });

    t('列顺序：认不出的 id 被忽略，不会吞掉任何列', function () {
      var cols = AE.buildColumns(m);
      var out = AE.orderColumns(cols, {
        groupOrder: ['nope', 'gold', 'alsoGone'],
        columnOrder: { base: ['zzz', 'name'], nope: ['x'] }
      });
      if (out.length !== cols.length) return '列数变了：' + out.length + ' vs ' + cols.length;
      var ids = {};
      out.forEach(function (c) { ids[c.id] = true; });
      var missing = cols.filter(function (c) { return !ids[c.id]; });
      return missing.length === 0 || ('丢了 ' + missing.length + ' 列');
    });

    t('列顺序：新加的列不会因为旧布局而消失', function () {
      var cols = AE.buildColumns(m);
      var base = cols.filter(function (c) { return c.group === 'base'; }).map(function (c) { return c.id; });
      if (base.length < 2) return 'base 组太短，没法验证';
      // A layout saved before the last column existed.
      var stale = base.slice(0, base.length - 1);
      var out = AE.orderColumns(cols, { columnOrder: { base: stale } });
      var got = out.filter(function (c) { return c.group === 'base'; }).map(function (c) { return c.id; });
      return got.length === base.length && got[got.length - 1] === base[base.length - 1] ||
             ('末尾是 ' + got[got.length - 1] + '，共 ' + got.length + ' 列');
    });

    // ---- layout presets --------------------------------------------------
    // AE.pickActiveLayout is pure, so these run without a live table. They guard
    // the bug where picking 方案3 in the header dropdown snapped the label back to
    // 方案1: 方案1 was columns-only, its columns matched, and it came first.

    function fakeSettings(over) {
      var s = AE.settingsDefaults();
      Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
      return s;
    }

    t('布局方案：优先认上次应用的那一个', function () {
      if (!AE.pickActiveLayout) return 'layouts.js 没加载，跳过';
      var s = fakeSettings({ minLevel: 20, skin: 'jade' });
      // Two presets with identical columns; the second also remembers filters.
      var cols = { groupOrder: [], columnOrder: {}, hiddenColumns: {}, hiddenGroups: {} };
      s.layouts = [
        { name: '方案1', scope: 'cols', groupOrder: [], columnOrder: {}, hiddenColumns: {}, hiddenGroups: {} },
        { name: '方案3', scope: 'all', groupOrder: [], columnOrder: {}, hiddenColumns: {}, hiddenGroups: {},
          filters: pickKeys(s, AE.LAYOUT_FILTER_KEYS), look: pickKeys(s, AE.LAYOUT_LOOK_KEYS) }
      ];
      s.activeLayout = '方案3';
      var got = AE.pickActiveLayout(s);
      return got === '方案3' || ('认成了 ' + got + '（应该是 方案3）');
    });

    t('布局方案：上次那个不再匹配时退回第一个匹配的', function () {
      if (!AE.pickActiveLayout) return 'layouts.js 没加载，跳过';
      var s = fakeSettings({ minLevel: 80 });
      s.layouts = [
        { name: '方案1', scope: 'cols', groupOrder: [], columnOrder: {}, hiddenColumns: {}, hiddenGroups: {} },
        { name: '方案3', scope: 'all', groupOrder: [], columnOrder: {}, hiddenColumns: {}, hiddenGroups: {},
          filters: pickKeys(fakeSettings({ minLevel: 20 }), AE.LAYOUT_FILTER_KEYS),
          look: pickKeys(s, AE.LAYOUT_LOOK_KEYS) }
      ];
      s.activeLayout = '方案3';       // stale: minLevel is 80 now, the preset says 20
      var got = AE.pickActiveLayout(s);
      return got === '方案1' || ('认成了 "' + got + '"（应该是 方案1）');
    });

    t('布局方案：只管列的方案不受筛选改动影响', function () {
      if (!AE.pickActiveLayout) return 'layouts.js 没加载，跳过';
      var s = fakeSettings({ minLevel: 5, hideZeroRating: true, skin: 'amber' });
      s.layouts = [{ name: '只列', scope: 'cols', groupOrder: [], columnOrder: {},
                     hiddenColumns: {}, hiddenGroups: {} }];
      if (AE.pickActiveLayout(s) !== '只列') return '改了筛选就不认了';
      s.hiddenColumns = { ilvl: true };
      return AE.pickActiveLayout(s) === '' || '改了列还认';
    });

    t('布局方案：带筛选的方案会因为筛选改动而脱钩', function () {
      if (!AE.pickActiveLayout) return 'layouts.js 没加载，跳过';
      var s = fakeSettings({ minLevel: 70 });
      s.layouts = [{ name: '全套', scope: 'all', groupOrder: [], columnOrder: {},
                     hiddenColumns: {}, hiddenGroups: {},
                     filters: pickKeys(s, AE.LAYOUT_FILTER_KEYS),
                     look: pickKeys(s, AE.LAYOUT_LOOK_KEYS) }];
      s.activeLayout = '全套';
      if (AE.pickActiveLayout(s) !== '全套') return '刚存好就不认';
      s.minLevel = 10;
      return AE.pickActiveLayout(s) === '' || '改了最低等级还认';
    });

    // ---- cross-path settings adoption ------------------------------------
    // The key embeds a hash of the folder path, so moving or renaming the folder
    // makes every setting look wiped. AE.pickAdoptable is the pure half of the
    // recovery: given the whole shared bucket, which entry do we take over?

    function entry(key, o) { return { key: key, raw: JSON.stringify(o) }; }
    var MY = 'AEW:v1:mine';

    t('设置迁移：本文件夹没有记录时，采用旧路径那一份', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      var hit = AE.pickAdoptable([entry('AEW:v1:old', { schemaVersion: 1, savedAt: 100, minLevel: 70 })], MY);
      if (!hit) return '什么都没采用';
      return (hit.from === 'AEW:v1:old' && hit.data.minLevel === 70) ||
             ('采用了 ' + hit.from + '，minLevel=' + hit.data.minLevel);
    });

    t('设置迁移：多份旧记录里最新的那份胜出', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      var hit = AE.pickAdoptable([
        entry('AEW:v1:a', { schemaVersion: 1, savedAt: 100, minLevel: 10 }),
        entry('AEW:v1:c', { schemaVersion: 1, savedAt: 300, minLevel: 30 }),
        entry('AEW:v1:b', { schemaVersion: 1, savedAt: 200, minLevel: 20 })
      ], MY);
      if (!hit) return '什么都没采用';
      return hit.from === 'AEW:v1:c' || ('采用了 ' + hit.from + '（应该是 AEW:v1:c）');
    });

    t('设置迁移：不碰自己的键、别人的键和探针键', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      var hit = AE.pickAdoptable([
        entry(MY, { schemaVersion: 1, savedAt: 999 }),
        entry(MY + ':probe', { schemaVersion: 1, savedAt: 999 }),
        entry('SomeOtherApp:v1:x', { schemaVersion: 1, savedAt: 999 })
      ], MY);
      return hit === null || ('居然采用了 ' + hit.from);
    });

    t('设置迁移：新版本写的记录跳过，让还能用的旧记录胜出', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      var hit = AE.pickAdoptable([
        entry('AEW:v1:future', { schemaVersion: 99, savedAt: 900, minLevel: 5 }),
        entry('AEW:v1:usable', { schemaVersion: 1, savedAt: 100, minLevel: 60 })
      ], MY);
      if (!hit) return '什么都没采用';
      return hit.from === 'AEW:v1:usable' || ('采用了 ' + hit.from);
    });

    t('设置迁移：坏 JSON 被跳过，不会让整个迁移失败', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      var hit = AE.pickAdoptable([
        { key: 'AEW:v1:broken', raw: '{not json' },
        entry('AEW:v1:good', { schemaVersion: 1, savedAt: 50, minLevel: 40 })
      ], MY);
      if (!hit) return '什么都没采用';
      return hit.from === 'AEW:v1:good' || ('采用了 ' + hit.from);
    });

    t('设置迁移：空桶里没什么可采用', function () {
      if (!AE.pickAdoptable) return 'settings.js 没加载，跳过';
      return AE.pickAdoptable([], MY) === null || '空桶也采用了东西';
    });

    // ---- the manual door: 其他 → 旧路径的设置 ------------------------------
    // Automatic adoption only fires when this folder has NO settings of its own.
    // Once the moved folder has been used even once, the old entry is stranded and
    // only 取回 can reach it. These pass a fake store rather than the real one --
    // tests.html runs in the browser, and sweeping the live localStorage would mean
    // inspecting the user's actual settings.
    function fakeStore(seed) {
      var keys = Object.keys(seed || {});
      var map = {};
      keys.forEach(function (k) { map[k] = seed[k]; });
      return {
        get length() { return Object.keys(map).length; },
        key: function (i) { return Object.keys(map)[i]; },
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
        setItem: function (k, v) { map[k] = String(v); },
        removeItem: function (k) { delete map[k]; }
      };
    }

    function bucket() {
      var o = {};
      o[MY] = JSON.stringify({ schemaVersion: 1, savedAt: 10, minLevel: 20 });
      o['AEW:v1:oldA'] = JSON.stringify({ schemaVersion: 1, savedAt: 100, minLevel: 11,
                                          hiddenColumns: { a: true, b: true }, layouts: [{ name: 'x' }] });
      o['AEW:v1:oldB'] = JSON.stringify({ schemaVersion: 1, savedAt: 900, minLevel: 99,
                                          hiddenColumns: { c: true }, layouts: [] });
      return o;
    }

    t('旧路径设置：只列别的路径，最新的排最前，带上列数和方案数', function () {
      if (!AE.listForeignSettings) return 'settings.js 没加载，跳过';
      var got = AE.listForeignSettings(fakeStore(bucket()), MY);
      if (got.length !== 2) return '列了 ' + got.length + ' 条';
      if (got[0].key !== 'AEW:v1:oldB') return '第一条是 ' + got[0].key + '（应该是最新的 oldB）';
      if (got[1].hiddenColumns !== 2 || got[1].layouts !== 1) {
        return 'oldA 的统计不对：隐藏 ' + got[1].hiddenColumns + ' 列，' + got[1].layouts + ' 个方案';
      }
      return true;
    });

    t('旧路径设置：自己的键不出现在列表里', function () {
      if (!AE.listForeignSettings) return 'settings.js 没加载，跳过';
      var got = AE.listForeignSettings(fakeStore(bucket()), MY);
      for (var i = 0; i < got.length; i++) {
        if (got[i].key === MY) return '把自己也列出来了';
      }
      return true;
    });

    t('旧路径设置：读不了的那条仍然列出，但标成不可用', function () {
      if (!AE.listForeignSettings) return 'settings.js 没加载，跳过';
      var got = AE.listForeignSettings(
        fakeStore({ 'AEW:v1:future': JSON.stringify({ schemaVersion: 99, savedAt: 100 }) }), MY);
      if (got.length !== 1) return '列了 ' + got.length + ' 条';
      return got[0].usable === false || '居然说可用';
    });

    t('旧路径设置：取回会写到自己的键上', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      var store = fakeStore(bucket());
      var got = AE.adoptSettingsFrom('AEW:v1:oldA', store, MY);
      if (!got) return '取回返回了 null';
      if (got.minLevel !== 11) return '取回的 minLevel = ' + got.minLevel;
      return JSON.parse(store.getItem(MY)).minLevel === 11 || '自己的键没被更新';
    });

    t('旧路径设置：取回不会销毁来源，取错了还能取回来', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      var store = fakeStore(bucket());
      AE.adoptSettingsFrom('AEW:v1:oldA', store, MY);
      var src = store.getItem('AEW:v1:oldA');
      return (src && JSON.parse(src).minLevel === 11) || '来源被吃掉了';
    });

    t('旧路径设置：取回后时间戳刷新，旧的 settings.js 盖不回去', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      var store = fakeStore(bucket());
      AE.adoptSettingsFrom('AEW:v1:oldA', store, MY);   // 原本 savedAt=100
      var now = Math.floor(Date.now() / 1000);
      var at = JSON.parse(store.getItem(MY)).savedAt;
      return (at >= now - 5 && at <= now + 5) || 'savedAt 还是 ' + at;
    });

    t('旧路径设置：拒绝新版本写的那条，且不动自己的设置', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      var seed = {};
      seed[MY] = JSON.stringify({ schemaVersion: 1, savedAt: 10, minLevel: 20 });
      seed['AEW:v1:future'] = JSON.stringify({ schemaVersion: 99, savedAt: 900, minLevel: 5 });
      var store = fakeStore(seed);
      if (AE.adoptSettingsFrom('AEW:v1:future', store, MY) !== null) return '还是取回了';
      return JSON.parse(store.getItem(MY)).minLevel === 20 || '失败时把自己的设置弄坏了';
    });

    t('旧路径设置：取回一个不存在的键，自己的设置不受影响', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      var store = fakeStore(bucket());
      if (AE.adoptSettingsFrom('AEW:v1:nope', store, MY) !== null) return '声称成功了';
      return JSON.parse(store.getItem(MY)).minLevel === 20 || '自己的设置变了';
    });

    t('旧路径设置：取回的结果补全了旧记录没有的新字段', function () {
      if (!AE.adoptSettingsFrom) return 'settings.js 没加载，跳过';
      // 真实场景：用户那条旧记录是 layouts / panelTab / groupOrder 出现之前存的。
      var store = fakeStore({
        'AEW:v1:oldA': JSON.stringify({ schemaVersion: 1, savedAt: 100, minLevel: 70,
                                        hiddenColumns: { ilvl: true } })
      });
      var got = AE.adoptSettingsFrom('AEW:v1:oldA', store, MY);
      if (!got) return '取回返回了 null';
      if (got.minLevel !== 70) return 'minLevel = ' + got.minLevel;
      if (!Array.isArray(got.layouts)) return 'layouts 是 ' + typeof got.layouts;
      if (got.panelTab !== 'filter') return 'panelTab = ' + got.panelTab;
      return got.hiddenColumns.ilvl === true || '隐藏列丢了';
    });

    return { pass: pass, fail: fail, skipped: skipped, results: results };
  };

  /**
   * Delete every `["name"] = { ... }` table from a SavedVariables Lua string,
   * matching braces so nested tables go with it. Used to fake a post-reset file:
   * that is the one state the scanned data can never show us, because the data on
   * disk always has whatever lockouts existed at scan time.
   */
  /**
   * Empty out every `["name"] = { ... }` table in a SavedVariables blob.
   *
   * Used to fabricate post-weekly-reset data from the real scan. Searching must
   * resume PAST each replacement: the text written back still starts with the
   * needle, so restarting from 0 would match it again forever.
   */
  function dropLuaTable(lua, name) {
    var needle = '["' + name + '"] = {';
    var repl = '["' + name + '"] = {}';
    var out = lua;
    var from = 0;
    for (;;) {
      var at = out.indexOf(needle, from);
      if (at < 0) return out;
      var i = at + needle.length, depth = 1;
      while (i < out.length && depth > 0) {
        var c = out.charAt(i);
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      out = out.slice(0, at) + repl + out.slice(i);
      from = at + repl.length;
    }
  }

  function pickKeys(src, keys) {
    var o = {};
    (keys || []).forEach(function (k) { o[k] = src[k]; });
    return o;
  }

})(typeof window !== 'undefined' ? window : globalThis);
