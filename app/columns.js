/*
 * WowAltBoard - app/columns.js
 *
 * The column registry. Every column is declared once here with an id, a group,
 * a sort value, and a renderer. render.js walks this list; the settings panel
 * generates its checkboxes from it. Adding a column means adding one entry.
 *
 * Column ids for per-dungeon / per-raid / per-currency columns embed the real
 * game id (mp:588, raid:3004/15, cur:3445) -- never an array index. See the
 * comment at the top of model.js for why that matters.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;

  AE.GROUPS = [
    { id: 'base',     label: '基础' },
    { id: 'mplus',    label: '大秘境' },
    { id: 'vault',    label: '宝库' },
    { id: 'delve',    label: '地下堡 / 藏宝图' },
    { id: 'raid',     label: '团队副本' },
    { id: 'currency', label: '纹章与货币' },
    { id: 'prof',     label: '专业' },
    { id: 'prey',     label: '狩猎' },
    { id: 'links',    label: '外部主页' },
    { id: 'gold',     label: '金币' }
  ];

  var PREY_DIFFICULTIES = [
    'PREY_DIFFICULTY_NORMAL',
    'PREY_DIFFICULTY_HARD',
    'PREY_DIFFICULTY_NIGHTMARE'
  ];

  // ------------------------------------------------------------------ helpers

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function txt(v) { return (v == null || v === '') ? '' : String(v); }

  function dash(td) { td.className += ' empty'; td.textContent = '·'; }

  /** Thousands separator, for gold and currency totals. */
  function group3(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function relDays(days) {
    if (days == null) return '';
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return days + ' 天前';
    if (days < 365) return Math.floor(days / 30) + ' 个月前';
    return Math.floor(days / 365) + ' 年前';
  }

  AE.fmt = { group3: group3, relDays: relDays };

  /** Header text for a dungeon under the current headerMode. */
  function dungeonHeader(cmID, meta, ctx) {
    var s = ctx.settings, m = ctx.model;
    if (s.headerMode === 'full') {
      return L.dungeonLabel(cmID, meta, s.dungeonNameOverrides, m.dungeonNames);
    }
    if (s.headerMode === 'en') {
      return L.dungeonAbbr(cmID, meta, s.dungeonNameOverrides, m.dungeonNames);
    }
    return L.dungeonShort(cmID, meta, s.dungeonNameOverrides, m.dungeonNames, m.dungeonShortNames);
  }

  AE.dungeonHeader = dungeonHeader;

  // -------------------------------------------------------------- base group

  function baseColumns() {
    return [
      {
        id: 'name', group: 'base', label: '角色', width: 130,
        sort: function (ch) { return ch.name; },
        render: function (td, ch, ctx) {
          var wrap = el('span', 'char-name', ch.name);
          if (ctx.settings.classColors) wrap.style.color = ch.classColor;
          td.appendChild(wrap);
          if (ch.seasonMismatch) {
            var b = el('span', 'badge warn', '旧赛季');
            b.title = '该角色的数据来自赛季 ' + ch.season + '，当前赛季是 ' + ctx.model.activeSeason;
            td.appendChild(b);
          }
          td.title = ch.name + ' - ' + ch.realm + '\n' + ch.className + ' / ' + ch.raceName;
        }
      },
      {
        id: 'realm', group: 'base', label: '服务器', width: 96,
        sort: function (ch) { return ch.realm; },
        render: function (td, ch) { td.textContent = ch.realm; }
      },
      {
        id: 'source', group: 'base', label: '账号', width: 100,
        sort: function (ch) { return ch.sourceName; },
        render: function (td, ch, ctx) {
          var alias = ctx.settings.sourceAliases[ch.sourceId];
          td.textContent = alias || ch.sourceName;
          td.title = '战网账号文件夹: ' + ch.sourceId;
        }
      },
      {
        id: 'faction', group: 'base', label: '阵营', width: 54, align: 'center',
        sort: function (ch) { return ch.faction; },
        render: function (td, ch) {
          if (!ch.faction) return dash(td);
          td.textContent = ch.faction;
          td.className += ch.factionEn === 'Alliance' ? ' alliance' : ' horde';
        }
      },
      {
        id: 'level', group: 'base', label: '等级', width: 50, align: 'right',
        sort: function (ch) { return ch.level; },
        render: function (td, ch) { td.textContent = ch.level || ''; }
      },
      {
        id: 'ilvl', group: 'base', label: '装等', width: 62, align: 'right',
        sort: function (ch) { return ch.ilvl.value; },
        render: function (td, ch) {
          if (!ch.ilvl.value) return dash(td);
          td.textContent = Math.ceil(ch.ilvl.value);
          if (ch.ilvl.suspect) {
            td.appendChild(el('span', 'hint', '?'));
            // level counts all slots; equipped counts empty slots as 0.
            td.title = '平均装等 ' + ch.ilvl.level.toFixed(1) +
                       '，已装备 ' + ch.ilvl.equipped.toFixed(1) +
                       '\n两者差异较大，通常是有空的装备栏位';
          } else {
            td.title = '平均 ' + ch.ilvl.level.toFixed(1) + ' / PvP ' + ch.ilvl.pvp.toFixed(1);
          }
        }
      },
      {
        id: 'guild', group: 'base', label: '公会', width: 110,
        sort: function (ch) { return ch.guildName; },
        render: function (td, ch) {
          if (!ch.guildName) return dash(td);
          td.textContent = ch.guildName;
          if (ch.guildRank) td.title = '职位: ' + ch.guildRank;
        }
      },
      {
        id: 'class', group: 'base', label: '职业', width: 84, defaultHidden: true,
        sort: function (ch) { return ch.className; },
        render: function (td, ch, ctx) {
          td.textContent = ch.className;
          if (ctx.settings.classColors) td.style.color = ch.classColor;
        }
      },
      {
        id: 'race', group: 'base', label: '种族', width: 84, defaultHidden: true,
        sort: function (ch) { return ch.raceName; },
        render: function (td, ch) { td.textContent = ch.raceName; }
      },
      {
        id: 'armor', group: 'base', label: '护甲', width: 56, align: 'center',
        defaultHidden: true,
        sort: function (ch) {
          var i = L.armorOrder.indexOf(ch.armorType);
          return i < 0 ? 99 : i;
        },
        render: function (td, ch) {
          if (!ch.armorType) return dash(td);
          td.textContent = ch.armorType;
          td.className += ' armor-' + L.armorOrder.indexOf(ch.armorType);
          td.title = ch.className + ' 穿' + ch.armorType +
            (ch.armorFromGear && ch.armorFromGear !== ch.armorType
              ? '\n（身上装备以 ' + ch.armorFromGear + ' 为主，可能穿混了）'
              : '');
        }
      },
      {
        id: 'lastUpdate', group: 'base', label: '最后更新', width: 86, align: 'right',
        sort: function (ch) { return ch.lastUpdate; },
        render: function (td, ch) {
          if (!ch.lastUpdate) return dash(td);
          td.textContent = relDays(ch.lastUpdateDays);
          if (ch.lastUpdateDays > 14) td.className += ' stale';
          td.title = new Date(ch.lastUpdate * 1000).toLocaleString();
        }
      }
    ];
  }

  // ------------------------------------------------------------ mythic+ group

  function mplusColumns(model) {
    var cols = [
      {
        id: 'mpRating', group: 'mplus', label: '总评分', width: 68, align: 'right',
        sort: function (ch) { return ch.mp.rating; },
        render: function (td, ch) {
          if (!ch.mp.rating) return dash(td);
          td.textContent = ch.mp.rating;
          td.className += ' num strong';
        }
      },
      {
        id: 'mpBest', group: 'mplus', label: '赛季最佳', width: 74, align: 'right',
        defaultHidden: true,
        sort: function (ch) { return ch.mp.bestSeasonScore; },
        render: function (td, ch) {
          if (!ch.mp.bestSeasonScore) return dash(td);
          td.textContent = ch.mp.bestSeasonScore;
          if (ch.mp.bestSeasonNumber) td.title = '来自第 ' + ch.mp.bestSeasonNumber + ' 赛季';
        }
      },
      {
        id: 'mpKeystone', group: 'mplus', label: '本周钥石', width: 96,
        sort: function (ch) { return ch.mp.keystone ? ch.mp.keystone.level : -1; },
        render: function (td, ch, ctx) {
          var ks = ch.mp.keystone;
          if (!ks) { dash(td); td.title = '本周尚未获得钥石，或已过周重置'; return; }
          var meta = ctx.model.tables.dungeonById[ks.cmID];
          var lv = el('b', null, '+' + ks.level);
          if (ks.color && /^[0-9a-f]{8}$/i.test(ks.color)) lv.style.color = '#' + ks.color.slice(2);
          td.appendChild(lv);
          td.appendChild(document.createTextNode(' ' + dungeonHeader(ks.cmID, meta, ctx)));
          td.title = L.dungeonLabel(ks.cmID, meta, ctx.settings.dungeonNameOverrides, ctx.model.dungeonNames) +
                     ' +' + ks.level;
        }
      },
      {
        id: 'mpRuns', group: 'mplus', label: '本周完成', width: 76, align: 'center',
        // Sorted by the number actually shown. Sorting by .total would order the
        // rows by a number the cell does not display, which looks like a bug.
        // No data at all sinks below a real 0.
        sort: function (ch) {
          var r = ch.mp.runsThisWeek;
          return r.total ? r.mythicPlus : -1;
        },
        render: function (td, ch) {
          var r = ch.mp.runsThisWeek;
          if (!r.total) {
            dash(td);
            td.title = '本周未登录该角色，或已过周重置';
            return;
          }
          // Only the Mythic+ count: 史诗 / 英雄 are the non-keystone difficulties,
          // they answer a different question, and "7 / 0 / 0" made two numbers
          // that are almost always 0 cost as much width as the one that matters.
          // Both still live in the tooltip.
          td.textContent = String(r.mythicPlus);
          if (!r.mythicPlus) td.className += ' empty';
          td.title = '大秘境 ' + r.mythicPlus + '，史诗 ' + r.mythic + '，英雄 ' + r.heroic +
                     '\n合计 ' + r.total + ' 本';
        }
      }
    ];

    // One column per dungeon of the active season, keyed by challengeModeID.
    model.columns.dungeonIds.forEach(function (cmID) {
      var meta = model.tables.dungeonById[cmID];
      cols.push({
        id: 'mp:' + cmID,
        group: 'mplus',
        width: 58,
        align: 'center',
        isDungeon: true,
        cmID: cmID,
        label: function (ctx) { return dungeonHeader(cmID, meta, ctx); },
        headTitle: function (ctx) {
          var full = L.dungeonLabel(cmID, meta, ctx.settings.dungeonNameOverrides, ctx.model.dungeonNames);
          var en = meta && meta.name ? '\n' + meta.name : '';
          return full + en + '\nchallengeModeID ' + cmID;
        },
        sort: function (ch) {
          var d = ch.mp.byDungeon[cmID];
          return d ? d.rating : -1;
        },
        render: function (td, ch) {
          var d = ch.mp.byDungeon[cmID];
          if (!d || (!d.level && !d.rating)) return dash(td);
          var lv = el('b', null, String(d.level || '-'));
          td.appendChild(lv);
          if (d.rating) {
            td.appendChild(el('span', 'sub', String(d.rating)));
          }
          if (!d.timed && d.level) {
            td.className += ' overtime';
            lv.textContent = d.level + '−';
          }
          var bits = ['等级 ' + d.level, '分数 ' + d.rating, d.timed ? '限时内完成' : '超时'];
          var best = d.bestTimedRun || d.bestNotTimedRun;
          if (best) {
            if (best.durationSec) {
              bits.push('用时 ' + Math.floor(best.durationSec / 60) + ':' +
                        String(best.durationSec % 60).padStart(2, '0'));
            }
            var cd = best.completionDate;
            if (cd && cd.year) bits.push(cd.year + '-' + cd.month + '-' + cd.monthDay);
          }
          td.title = bits.join('\n');
        }
      });
    });

    return cols;
  }

  // -------------------------------------------------------------- vault group

  function vaultColumns() {
    return L.vaultTypeOrder.map(function (type) {
      return {
        id: 'vault:' + type,
        group: 'vault',
        label: L.vaultTypeZh[type],
        width: 78,
        align: 'center',
        sort: function (ch) {
          var s = AE.vaultSummary(ch, type);
          return s ? s.unlocked : -1;
        },
        render: function (td, ch, ctx) {
          var s = AE.vaultSummary(ch, type);
          if (!s) { dash(td); td.title = '本周未登录该角色，或已过周重置'; return; }

          // A segmented bar reads as a progress indicator at a glance and scales
          // with the cell, unlike the fixed-size dots it replaces.
          var bar = el('span', 'vbar');
          var lines = [];
          s.slots.forEach(function (slot) {
            var seg = el('i', 'vseg' + (slot.unlocked ? ' on' : ''));
            var pct = slot.threshold > 0
              ? Math.max(0, Math.min(1, slot.progress / slot.threshold))
              : 0;
            if (!slot.unlocked && pct > 0) {
              // Partial fill so "2/4" is visibly closer than "0/4".
              var fill = el('u', 'vfill');
              fill.style.width = (pct * 100).toFixed(0) + '%';
              seg.appendChild(fill);
              seg.className += ' part';
            }
            bar.appendChild(seg);

            var line = '第 ' + slot.index + ' 档　' + slot.progress + ' / ' + slot.threshold;
            if (slot.unlocked) {
              line += '　已解锁';
              if (type === L.VAULT_MPLUS && slot.level) {
                var ilvl = AE.vaultItemLevel(ctx.model, slot.level);
                line += '　钥石 +' + slot.level + (ilvl ? ' → ' + ilvl + ' 装等' : '');
              } else if (type === L.VAULT_RAID && slot.level) {
                line += '　' + (L.raidDifficultyZh[slot.level] || ('难度 ' + slot.level));
              } else if (type === L.VAULT_WORLD && slot.level) {
                line += '　' + slot.level + ' 层';
              }
              // exampleRewardLink is deliberately not shown anywhere. The game
              // returns one sample per activity type (all three raid rows carry
              // the identical item), and it is a preview of the item level, not
              // a drop -- so it only ever added noise to the vault readout.
            } else {
              line += '　还需：' + AE.vaultRequirement(type, slot.threshold, slot.raidString);
            }
            lines.push(line);
          });

          td.appendChild(el('span', 'vault-count', s.unlocked + '/' + s.total));
          td.appendChild(bar);
          if (s.unlocked === s.total) td.className += ' full';
          else if (s.unlocked) td.className += ' partial';
          td.title = L.vaultTypeZh[type] + '\n' + lines.join('\n');
        }
      };
    });
  }

  // ------------------------------------------------- delve + treasure map group

  function delveColumns(model) {
    var cols = [
      {
        id: 'delveTier', group: 'delve', label: '最高层数', width: 74, align: 'center',
        sort: function (ch) { return ch.delves.maxTier; },
        render: function (td, ch) {
          if (!ch.delves.maxTier) return dash(td);
          td.textContent = ch.delves.maxTier + ' 层';
          td.title = ch.delves.tiers.map(function (t) {
            return '难度 ' + t.difficulty + '：' + t.numPoints + ' 分 (tier ' + t.activityTierID + ')';
          }).join('\n');
        }
      },
      {
        id: 'delvePoints', group: 'delve', label: '积分', width: 56, align: 'right',
        sort: function (ch) { return ch.delves.points; },
        render: function (td, ch) {
          if (!ch.delves.points) return dash(td);
          td.textContent = ch.delves.points;
        }
      },
      {
        // 宝图, not 藏宝图: the group band already says 地下堡 / 藏宝图, so the
        // full word was three columns of repetition. Narrower too -- 84 was
        // sized for the longer label.
        id: 'mapBag', group: 'delve', label: '宝图 持有', width: 80, align: 'center',
        sort: function (ch) { return ch.treasureMap ? ch.treasureMap.bagCount : -1; },
        render: function (td, ch) {
          var m = ch.treasureMap;
          if (!m) { dash(td); td.title = '本周未登录该角色'; return; }
          td.textContent = m.bagCount ? (m.bagCount + ' 张') : '0 张';
          if (m.bagCount) td.className += ' good';
          td.title = m.name + '\n背包中持有 ' + m.bagCount + ' 张';
        }
      },
      {
        id: 'mapUsed', group: 'delve', label: '宝图 本周', width: 80, align: 'center',
        sort: function (ch) { return ch.treasureMap ? (ch.treasureMap.used ? 1 : 0) : -1; },
        render: function (td, ch) {
          var m = ch.treasureMap;
          if (!m) { dash(td); td.title = '本周未登录该角色'; return; }
          if (m.used) {
            td.textContent = '已用';
            td.className += ' good';
            td.title = '本周的珍宝猎手奖赏已经领取';
          } else {
            td.textContent = '未用';
            td.className += ' todo';
            td.title = '本周的珍宝猎手奖赏还没有领取';
          }
        }
      },
      {
        id: 'mapBuff', group: 'delve', label: '宝图 在身', width: 80, align: 'center',
        defaultHidden: true,
        sort: function (ch) { return ch.treasureMap ? (ch.treasureMap.hasBuff ? 1 : 0) : -1; },
        render: function (td, ch) {
          var m = ch.treasureMap;
          if (!m) return dash(td);
          td.textContent = m.hasBuff ? '生效中' : '无';
          if (m.hasBuff) td.className += ' good';
        }
      }
    ];

    // Delve-flavoured currencies (coffer key shards, restored keys, mana crystals).
    model.columns.delveCurrencyIds.forEach(function (id) {
      var meta = model.columns.currencyMeta[id];
      cols.push(currencyColumn(id, meta, 'delve'));
    });

    return cols;
  }

  // ---------------------------------------------------------------- raid group

  function raidColumns(model) {
    return model.columns.raidColumns.map(function (rc) {
      return {
        id: 'raid:' + rc.key,
        group: 'raid',
        width: 62,
        align: 'center',
        label: function (ctx) {
          var m = ctx.model;
          if (ctx.settings.headerMode === 'full') {
            return rc.name + ' ' + shortDifficulty(rc.difficultyName);
          }
          if (ctx.settings.headerMode === 'en') {
            return rc.abbr + ' ' + enDifficulty(rc.difficultyName);
          }
          return (m.raidShortNames[rc.instanceID] || rc.abbr) + shortDifficulty(rc.difficultyName);
        },
        headTitle: function () {
          return rc.name + ' - ' + rc.difficultyName + '\n共 ' + rc.total + ' 个首领';
        },
        sort: function (ch) {
          var r = ch.raids.byKey[rc.key];
          return r && r.active ? r.progress : -1;
        },
        render: function (td, ch) {
          var r = ch.raids.byKey[rc.key];
          // 过期残留当成「本周没打」。存档里的锁定快照只在角色上线时更新，
          // 所以上个周期的 8/8 会一直躺在里面。只看 progress 就会把它画成
          // 本周打满了。
          if (!r || !r.active) return dash(td);
          td.textContent = r.progress + '/' + r.total;
          if (r.progress >= r.total && r.total > 0) td.className += ' full';
          else if (r.progress > 0) td.className += ' partial';
          var lines = [r.name + ' - ' + r.difficultyName];
          r.encounters.forEach(function (e) {
            lines.push((e.killed ? '✔ ' : '· ') + e.name);
          });
          td.title = lines.join('\n');
        }
      };
    });
  }

  // Single-character difficulty markers keep a 60-column table readable.
  function shortDifficulty(name) {
    var map = { '随机': '随', '普通': '普', '英雄': '英', '史诗': '史', '时空漫游': '漫', '世界': '世' };
    return map[name] || name;
  }

  function enDifficulty(name) {
    var map = { '随机': 'L', '普通': 'N', '英雄': 'H', '史诗': 'M', '时空漫游': 'TW', '世界': 'W' };
    return map[name] || name;
  }

  // ------------------------------------------------------------ currency group

  /**
   * Which number the cap actually applies to.
   *
   * This is NOT simply quantity/maxQuantity. Crests have
   * useTotalEarnedForMaxQty = true, meaning the cap limits how much you have
   * EVER earned, not how much you are holding. Real data here: 冒险者迷雾纹章
   * quantity=665, totalEarned=205, maxQuantity=300. Rendering "665/300" would
   * look like a bug; the number that answers "how many more can I get" is
   * 205/300, i.e. 95 remaining.
   */
  function currencyCap(c) {
    if (!c) return null;
    if (c.maxQuantity > 0) {
      var basis = c.useTotalEarnedForMaxQty ? c.totalEarned : c.quantity;
      return {
        have: basis,
        max: c.maxQuantity,
        remaining: Math.max(0, c.maxQuantity - basis),
        onEarned: c.useTotalEarnedForMaxQty,
        weekly: false
      };
    }
    if (c.maxWeekly > 0) {
      return {
        have: c.earnedThisWeek,
        max: c.maxWeekly,
        remaining: Math.max(0, c.maxWeekly - c.earnedThisWeek),
        onEarned: true,
        weekly: true
      };
    }
    return null;
  }

  function currencyColumn(id, meta, group) {
    return {
      id: 'cur:' + id,
      group: group,
      // Wide enough for the worst real case, "575(205/300)": 3 bold digits at
      // 12px plus 9 small ones at 10px is ~75px of content, and a clipped
      // number reads as a WRONG number rather than as a narrow cell.
      width: 96,
      align: 'right',
      currencyId: id,
      label: function () { return L.currencyShort(id, meta ? meta.name : ''); },
      headTitle: function () {
        return (meta ? meta.name : '#' + id) + '\ncurrencyID ' + id;
      },
      sort: function (ch) {
        var c = ch.currencies.byId[id];
        return c ? c.quantity : -1;
      },
      render: function (td, ch, ctx) {
        var c = ch.currencies.byId[id];
        if (!c) return dash(td);

        var cap = currencyCap(c);
        var lines = [c.name];

        if (cap && ctx.settings.currencyShowCap) {
          // Crests cap the TOTAL EARNED, not the stack you are holding, so the
          // capped pair on its own hid the number you actually spend:
          // 冒险者迷雾纹章 reads 205/300 while 665 sit in the bag. Show 现有 first,
          // then the capped pair -- but only when they differ, since "5(5/5)"
          // would be three ways of saying the same thing.
          if (cap.have !== c.quantity) {
            td.appendChild(el('b', null, group3(c.quantity)));
            td.appendChild(el('span', 'sub',
                               '(' + group3(cap.have) + '/' + group3(cap.max) + ')'));
          } else {
            td.appendChild(el('b', null, group3(cap.have)));
            td.appendChild(el('span', 'sub', '/ ' + group3(cap.max)));
          }
          if (cap.remaining === 0) td.className += ' full';
          else if (cap.have > 0) td.className += ' partial';
        } else {
          td.textContent = group3(c.quantity);
          if (!c.quantity) td.className += ' empty';
        }

        lines.push('当前持有　' + group3(c.quantity));
        if (c.totalEarned) lines.push('累计获得　' + group3(c.totalEarned));
        if (cap) {
          lines.push((cap.weekly ? '本周上限　' : (cap.onEarned ? '累计上限　' : '持有上限　')) +
                     group3(cap.have) + ' / ' + group3(cap.max));
          lines.push(cap.remaining > 0 ? ('还可获取　' + group3(cap.remaining)) : '已达上限');
          if (cap.onEarned && !cap.weekly) {
            lines.push('（上限算的是累计获得量，不是当前持有量）');
          }
        } else {
          lines.push('没有上限');
        }
        td.title = lines.join('\n');
      }
    };
  }

  function currencyColumns(model) {
    return model.columns.currencyIds.map(function (id) {
      return currencyColumn(id, model.columns.currencyMeta[id], 'currency');
    });
  }

  // ---------------------------------------------------- profession group
  // Fed by BagSync, which is optional -- model.columns.professionSlots is 0 and
  // professionSecondaryIds is empty when it is not installed, so this whole group
  // simply produces no columns and render.js hides the band.
  //
  // The cell shows the CURRENT expansion's segment (卡兹阿加工艺图 100/100 reads as
  // "铭文 100"), because that is the number that decides whether you can craft
  // this tier. Every expansion's segment is in the tooltip.

  /** "铭文 100 / 100" style tooltip block for one profession. */
  function professionTitle(p) {
    var lines = [p.name];
    if (p.recipes) lines.push('已学配方　' + p.recipes + ' 个');
    if (p.segments.length) {
      lines.push('');
      p.segments.forEach(function (s) {
        lines.push(s.name + '　' + s.cur + ' / ' + s.max);
      });
    } else if (p.cur != null) {
      lines.push('技能　' + p.cur + ' / ' + p.max);
    }
    lines.push('');
    lines.push('来自 BagSync（AlterEgo 不记录专业）');
    return lines.join('\n');
  }

  function paintProfession(td, p) {
    td.appendChild(el('span', null, p.name));
    if (p.cur != null) {
      var full = p.max > 0 && p.cur >= p.max;
      td.appendChild(el('span', 'sub', ' ' + p.cur));
      if (full) td.className += ' full';
      else if (p.cur > 1) td.className += ' partial';
    }
    td.title = professionTitle(p);
  }

  /** One of the two primary slots. `slot` is 0-based. */
  function professionSlotColumn(slot) {
    return {
      id: 'prof:' + (slot + 1),
      group: 'prof',
      width: 96,
      professionSlot: slot,
      label: '专业 ' + (slot + 1),
      headTitle: '第 ' + (slot + 1) + ' 个主专业，按 skillLineID 排序（游戏并没有把' +
                 '“第一/第二专业”存进硬盘，所以这只是一个稳定的顺序，不是学习顺序）。' +
                 '数字是当前资料片那一段的技能等级。',
      // A name, so sorting groups everyone who has the same profession together --
      // "我哪个号会附魔" is the question these columns exist to answer. Empty sorts
      // last when descending, like the numeric columns' -1.
      sort: function (ch) {
        var p = ch.professions && ch.professions.primary[slot];
        return p ? p.name : '';
      },
      render: function (td, ch) {
        var p = ch.professions && ch.professions.primary[slot];
        if (!p) return dash(td);
        paintProfession(td, p);
      }
    };
  }

  /** 烹饪 / 钓鱼: one column each, only for the ones somebody actually has. */
  function professionSecondaryColumn(id, name) {
    return {
      id: 'prof:sec:' + id,
      group: 'prof',
      width: 72,
      align: 'right',
      professionId: id,
      label: name || ('#' + id),
      headTitle: (name || ('#' + id)) + '\nskillLineID ' + id +
                 '\n当前资料片那一段的技能等级',
      sort: function (ch) {
        var p = ch.professions && ch.professions.secondary[id];
        return (p && p.cur != null) ? p.cur : -1;
      },
      render: function (td, ch) {
        var p = ch.professions && ch.professions.secondary[id];
        if (!p || p.cur == null) return dash(td);
        td.appendChild(el('b', null, String(p.cur)));
        if (p.max > 0) td.appendChild(el('span', 'sub', '/ ' + p.max));
        if (p.max > 0 && p.cur >= p.max) td.className += ' full';
        else if (p.cur > 1) td.className += ' partial';
        td.title = professionTitle(p);
      }
    };
  }

  function professionColumns(model) {
    var cols = [];
    for (var i = 0; i < model.columns.professionSlots; i++) {
      cols.push(professionSlotColumn(i));
    }
    model.columns.professionSecondaryIds.forEach(function (id) {
      cols.push(professionSecondaryColumn(id, model.columns.professionNames[id]));
    });
    return cols;
  }

  // --------------------------------------------------------------- link group

  function linkColumn(id, label, key, title) {
    return {
      id: id,
      group: 'links',
      label: label,
      width: 52,
      align: 'center',
      sort: function (ch) { return ch.name; },
      render: function (td, ch, ctx) {
        var urls = AE.profileUrls(ch, ctx.settings.links);
        if (!urls[key]) {
          dash(td);
          td.title = urls.reason || '无法生成链接';
          return;
        }
        var a = el('a', 'ext', label);
        a.href = urls[key];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = title + '\n' + decodeURIComponent(urls[key]);
        // The row click opens the detail drawer; a link click must not do both.
        a.addEventListener('click', function (ev) { ev.stopPropagation(); });
        td.appendChild(a);
      }
    };
  }

  function linkColumns() {
    return [
      linkColumn('linkRio', 'RIO', 'rio', 'Raider.IO 角色主页（链接格式已实测可用）'),
      linkColumn('linkWcl', 'WCL', 'wcl', 'Warcraft Logs 角色主页\n' +
        '注意：WCL 拒绝脚本访问，这个链接格式没能在本机验证过。\n' +
        '第一次点击请确认一下，不对就在设置里改「外部主页」的地址。')
    ];
  }

  // ------------------------------------------------------- prey + gold groups

  function preyColumns() {
    var cols = [{
      id: 'prey', group: 'prey', label: '狩猎 合计', width: 78, align: 'center',
      sort: function (ch) { return ch.prey.seen ? ch.prey.done : -1; },
      render: function (td, ch) {
        if (!ch.prey.seen) { dash(td); td.title = '本周未登录该角色，或已过周重置'; return; }
        td.appendChild(el('b', null, String(ch.prey.done)));
        td.appendChild(el('span', 'sub', '/ ' + ch.prey.seen));
        if (ch.prey.done) td.className += ' partial';
        var done = ch.prey.entries.filter(function (e) { return e.done; });
        td.title = done.length
          ? '本周已完成 ' + done.length + ' 个：\n' +
            done.map(function (e) {
              return '✔ ' + e.name + '（' + L.preyDifficultyLabel(e.difficulty) + '）';
            }).join('\n')
          : '本周还没有完成任何狩猎';
      }
    }];

    // One column per difficulty. The interesting question is not "how many of 94"
    // -- it is whether this week's Nightmare hunt is done.
    PREY_DIFFICULTIES.forEach(function (diff) {
      cols.push({
        id: 'prey:' + diff,
        group: 'prey',
        label: L.preyDifficultyZh[diff] || diff,
        width: 62,
        align: 'center',
        sort: function (ch) {
          var d = ch.prey.byDifficulty[diff];
          return d ? d.done : -1;
        },
        render: function (td, ch) {
          var d = ch.prey.byDifficulty[diff];
          if (!d) return dash(td);
          td.textContent = d.done + ' / ' + d.total;
          if (d.done >= d.total && d.total > 0) td.className += ' full';
          else if (d.done) td.className += ' partial';
          var done = d.entries.filter(function (e) { return e.done; });
          td.title = L.preyDifficultyLabel(diff) + ' 难度　' + d.done + ' / ' + d.total +
            (done.length ? '\n\n已完成：\n' + done.map(function (e) { return '✔ ' + e.name; }).join('\n') : '');
        }
      });
    });

    return cols;
  }

  function goldColumns() {
    return [{
      id: 'gold', group: 'gold', label: '金币', width: 92, align: 'right',
      sort: function (ch) { return ch.money; },
      render: function (td, ch) {
        if (!ch.money) return dash(td);
        td.textContent = group3(ch.gold);
        td.title = group3(ch.gold) + ' 金';
      }
    }];
  }

  // ------------------------------------------------------------------ assemble

  /** Build the full ordered column list for a model. */
  AE.buildColumns = function (model) {
    var cols = []
      .concat(baseColumns())
      .concat(mplusColumns(model))
      .concat(vaultColumns())
      .concat(delveColumns(model))
      .concat(raidColumns(model))
      .concat(currencyColumns(model))
      .concat(professionColumns(model))
      .concat(preyColumns())
      .concat(linkColumns())
      .concat(goldColumns());

    cols.forEach(function (c) {
      if (!c.align) c.align = 'left';
      if (!c.width) c.width = 70;
    });
    return cols;
  };

  // ------------------------------------------------------------ column order
  //
  // The order in this file is the DEFAULT, not the truth. The user can drag a
  // column inside its group and drag whole groups left or right; both orders live
  // in settings and are applied here, once, on top of a freshly built list.
  //
  // Deliberate constraint: a column only moves WITHIN its group, and groups move
  // as a block. That keeps every group's columns contiguous, which is the whole
  // reason the band header row can exist -- a group split into three runs needs
  // three band cells and brings back exactly the "宝库 的数据跑到大秘境下面"
  // misreading that the colSpan logic was written to prevent.
  //
  // Both saved orders are PARTIAL. Ids they never mention keep their registry
  // order and land after the ones they do; ids they mention that no longer exist
  // are dropped. So a layout saved last season survives into this one instead of
  // blanking the columns it has never heard of.
  AE.orderColumns = function (cols, s) {
    var byGroup = {};
    var groups = [];
    cols.forEach(function (c) {
      if (!byGroup[c.group]) { byGroup[c.group] = []; groups.push(c.group); }
      byGroup[c.group].push(c);
    });

    var out = [];
    mergeOrder(groups, s && s.groupOrder).forEach(function (gid) {
      var list = byGroup[gid];
      var byId = {};
      var ids = list.map(function (c) { byId[c.id] = c; return c.id; });
      var want = (s && s.columnOrder) ? s.columnOrder[gid] : null;
      mergeOrder(ids, want).forEach(function (id) { out.push(byId[id]); });
    });
    return out;
  };

  /**
   * `have`, reshuffled to follow `want` where the two overlap. Entries of `want`
   * missing from `have` are ignored; entries of `have` that `want` never mentions
   * keep their relative order and go last.
   */
  function mergeOrder(have, want) {
    var present = {};
    have.forEach(function (x) { present[x] = true; });
    var taken = {};
    var out = [];
    (want || []).forEach(function (x) {
      if (present[x] && !taken[x]) { taken[x] = true; out.push(x); }
    });
    have.forEach(function (x) { if (!taken[x]) out.push(x); });
    return out;
  }

  AE.mergeOrder = mergeOrder;

  /** The group ids present in `cols`, in the order they appear. */
  AE.groupOrderOf = function (cols) {
    var seen = {};
    var out = [];
    cols.forEach(function (c) {
      if (!seen[c.group]) { seen[c.group] = true; out.push(c.group); }
    });
    return out;
  };

  AE.groupById = function (id) {
    for (var i = 0; i < AE.GROUPS.length; i++) {
      if (AE.GROUPS[i].id === id) return AE.GROUPS[i];
    }
    return null;
  };

  /** Resolve a column's header text, which may be a function of context. */
  AE.colLabel = function (col, ctx) {    return typeof col.label === 'function' ? col.label(ctx) : txt(col.label);
  };

  AE.colHeadTitle = function (col, ctx) {
    if (typeof col.headTitle === 'function') return col.headTitle(ctx);
    if (col.headTitle) return col.headTitle;
    return AE.colLabel(col, ctx);
  };

})(typeof window !== 'undefined' ? window : globalThis);
