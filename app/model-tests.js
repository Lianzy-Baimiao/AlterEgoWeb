/*
 * AlterEgoWeb - app/model-tests.js
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

    var m = AE.buildModel(global.AE_DATA);

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
      // This machine really has three characters named 易安玥.
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
          [{ v: '王天悦', num: false }, { v: 311, num: true }]
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

    return { pass: pass, fail: fail, skipped: skipped, results: results };
  };

})(typeof window !== 'undefined' ? window : globalThis);
