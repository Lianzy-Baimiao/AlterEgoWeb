/*
 * AlterEgoWeb - app/model.js
 *
 * Turns the raw AlterEgoDB tables from every account into one flat list of
 * character rows plus the column sets the table should show.
 *
 * Two rules this file exists to enforce:
 *
 *  1. COLUMN IDENTITY IS AN ID, NEVER AN ARRAY INDEX.
 *     mythicplus.dungeons is a positional array whose order is a Lua hash
 *     iteration artifact. On this machine it comes out 250,584,587,588,399,
 *     586,585,249 while the addon's own definition order is 588,587,586,584,
 *     585,249,250,399. Keying columns by position puts every dungeon score in
 *     the wrong column, silently. Same for currencies (currencyID) and raids
 *     (instanceID).
 *
 *  2. SEASONS ARE SCOPED, STALE SOURCES ARE FLAGGED, NEITHER IS SILENTLY MERGED.
 *     One account here was last written 155 days ago and carries a previous
 *     expansion's challengeModeIDs. Merging blindly yields 16 dungeon columns,
 *     half permanently blank; hiding it silently loses a real account.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L  = AE.Labels;

  var DAY = 86400;
  var STALE_DAYS = 14;

  // ---------------------------------------------------------------- utilities

  function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : (dflt === undefined ? 0 : dflt);
  }

  function str(v, dflt) {
    return (typeof v === 'string' && v.length) ? v : (dflt === undefined ? '' : dflt);
  }

  /**
   * Extract the display name and quality from a WoW hyperlink.
   *   "|cnIQ4:|Hitem:271468::...|h[祝圣烈焰壁垒]|h|r" -> {name:"祝圣烈焰壁垒", quality:4}
   * Also handles the older "|cffa335ee|Hitem:...|h[Name]|h|r" colour form.
   */
  AE.parseItemLink = function (link) {
    if (!link || typeof link !== 'string') return null;
    var nameMatch = link.match(/\|h\[([^\]]*)\]\|h/);
    var name = nameMatch ? nameMatch[1] : null;

    var quality = null;
    var iq = link.match(/\|cnIQ(\d+):/);
    if (iq) {
      quality = parseInt(iq[1], 10);
    } else {
      var hex = link.match(/\|c([0-9a-fA-F]{8})/);
      if (hex) {
        var rgb = hex[1].slice(2).toLowerCase();
        for (var q in L.qualityColors) {
          if (L.qualityColors[q].slice(1).toLowerCase() === rgb) { quality = parseInt(q, 10); break; }
        }
      }
    }
    var idMatch = link.match(/\|Hitem:(\d+)/);
    return {
      name: name,
      quality: quality,
      itemId: idMatch ? parseInt(idMatch[1], 10) : null,
      color: quality != null ? (L.qualityColors[quality] || null) : null
    };
  };

  /** Strip all WoW escape sequences from a string, leaving plain text. */
  AE.stripWowMarkup = function (s) {
    if (!s || typeof s !== 'string') return '';
    return s
      .replace(/\|c[nN]?[A-Za-z0-9]{0,8}:?/g, '')
      .replace(/\|r/g, '')
      .replace(/\|H[^|]*\|h/g, '')
      .replace(/\|h/g, '')
      .replace(/\|T[^|]*\|t/g, '')
      .replace(/\|A[^|]*\|a/g, '');
  };

  /**
   * Substitute a WoW format string's numeric placeholders.
   * vault.slots[].raidString is "击败%d个至暗之夜第2赛季首领" -- rendering it
   * without substitution literally shows "%d" in the UI.
   */
  AE.formatWowString = function (fmt, value) {
    if (!fmt || typeof fmt !== 'string') return '';
    return fmt.replace(/%(\d+\$)?d/g, String(value));
  };

  // ------------------------------------------------------ addon lookup tables

  function buildTables(addonTables) {
    var t = addonTables || {};
    function ex(file, name) {
      if (!t[file]) return undefined;
      try { return AE.extractLuaAssignment(t[file], name); } catch (e) { return undefined; }
    }

    var dungeons = AE.asArray(ex('MythicPlus.lua', 'Data.dungeons'));
    var raids    = AE.asArray(ex('Raids.lua', 'Data.raids'));
    var currencies = AE.asArray(ex('Currencies.lua', 'Data.currencies'));

    var dungeonById = {};
    dungeons.forEach(function (d) { if (d && d.challengeModeID != null) dungeonById[d.challengeModeID] = d; });

    var raidByInstance = {};
    raids.forEach(function (r) { if (r && r.instanceID != null) raidByInstance[r.instanceID] = r; });

    var currencyById = {};
    currencies.forEach(function (c) { if (c && c.id != null) currencyById[c.id] = c; });

    return {
      dungeons: dungeons,
      dungeonById: dungeonById,
      raids: raids,
      raidByInstance: raidByInstance,
      raidDifficulties: AE.asArray(ex('Raids.lua', 'Data.raidDifficulties')),
      seasons: AE.asArray(ex('Seasons.lua', 'Data.seasons')),
      vaultItemLevels: AE.asMap(ex('Vault.lua', 'Data.mythicPlusVaultItemLevels')),
      inventory: AE.asArray(ex('Inventory.lua', 'Data.inventory')),
      currencies: currencies,
      currencyById: currencyById,
      preyQuests: AE.asArray(ex('Prey.lua', 'Data.preyQuests')),
      upgradeTracks: AE.asArray(ex('UpgradeTracks.lua', 'Data.upgradeTracks'))
    };
  }

  // --------------------------------------------------------- character mapping

  function mapMythicPlus(mp) {
    mp = mp || {};
    var byDungeon = {};
    // NOTE: iterate the array but key by challengeModeID from inside each entry.
    AE.asArray(mp.dungeons).forEach(function (d) {
      if (!d || d.challengeModeID == null) return;
      byDungeon[d.challengeModeID] = {
        cmID: d.challengeModeID,
        level: num(d.level),
        rating: num(d.rating),
        timed: d.finishedSuccess === true,
        bestOverAll: num(d.bestOverAllScore),
        bestTimedRun: d.bestTimedRun || null,
        bestNotTimedRun: d.bestNotTimedRun || null,
        affixScores: AE.asArray(d.affixScores)
      };
    });

    var ks = mp.keystone || {};
    var runs = mp.numCompletedDungeonRuns || {};
    var history = AE.asArray(mp.runHistory);

    return {
      rating: num(mp.rating),
      bestSeasonScore: num(mp.bestSeasonScore),
      bestSeasonNumber: num(mp.bestSeasonNumber, null),
      keystone: AE.isEmptyTable(ks) ? null : {
        cmID: num(ks.challengeModeID, null),
        level: num(ks.level),
        color: str(ks.color),
        itemLink: str(ks.itemLink)
      },
      runsThisWeek: {
        heroic: num(runs.heroic),
        mythic: num(runs.mythic),
        mythicPlus: num(runs.mythicPlus),
        total: num(runs.heroic) + num(runs.mythic) + num(runs.mythicPlus)
      },
      byDungeon: byDungeon,
      history: history,
      historyThisWeek: history.filter(function (r) { return r && r.thisWeek === true; })
    };
  }

  function mapVault(vault) {
    vault = vault || {};
    var byType = {};
    AE.asArray(vault.slots).forEach(function (s) {
      if (!s || s.type == null) return;
      if (!byType[s.type]) byType[s.type] = [];
      byType[s.type].push({
        type: s.type,
        index: num(s.index),
        progress: num(s.progress),
        threshold: num(s.threshold),
        level: num(s.level),
        activityTierID: num(s.activityTierID),
        raidString: str(s.raidString),
        exampleReward: AE.parseItemLink(s.exampleRewardLink),
        unlocked: num(s.progress) >= num(s.threshold) && num(s.threshold) > 0
      });
    });
    Object.keys(byType).forEach(function (k) {
      byType[k].sort(function (a, b) { return a.index - b.index; });
    });

    return {
      hasAvailableRewards: vault.hasAvailableRewards === true,
      byType: byType,
      encounterInfo: AE.asArray(vault.activityEncounterInfo),
      worldActivity: AE.asArray(vault.worldActivityProgress)
    };
  }

  function mapDelves(vault) {
    var tiers = AE.asArray((vault || {}).worldActivityProgress).map(function (w) {
      return {
        activityTierID: num(w.activityTierID),
        difficulty: num(w.difficulty),
        numPoints: num(w.numPoints)
      };
    });
    var maxTier = 0, points = 0;
    tiers.forEach(function (t) {
      if (t.difficulty > maxTier) maxTier = t.difficulty;
      points += t.numPoints;
    });
    return { tiers: tiers, maxTier: maxTier, points: points };
  }

  function mapCurrencies(list) {
    var byId = {}, byType = {}, treasureMap = null;
    AE.asArray(list).forEach(function (c) {
      if (!c) return;
      var type = str(c.currencyType, 'other');

      if (type === 'delveMap') {
        // Synthesized pseudo-currency: `id` is an itemID, not a currencyID.
        treasureMap = {
          itemId: num(c.id, null),
          name: str(c.name),
          bagCount: num(c.bagCount),          // 获取: how many are in the bag
          used: c.questCompleted === true,    // 使用: this week's map spent
          hasBuff: c.hasBuff === true         // 在身: buff currently active
        };
        return;
      }

      var id = num(c.currencyID, num(c.id, null));
      if (id == null) return;
      var rec = {
        id: id,
        name: str(c.name, '#' + id),
        type: type,
        quantity: num(c.quantity),
        totalEarned: num(c.totalEarned),
        trackedQuantity: num(c.trackedQuantity),
        maxQuantity: num(c.maxQuantity),
        maxWeekly: num(c.maxWeeklyQuantity),
        earnedThisWeek: num(c.quantityEarnedThisWeek),
        useTotalEarnedForMaxQty: c.useTotalEarnedForMaxQty === true,
        description: str(c.description)
      };
      byId[id] = rec;
      if (!byType[type]) byType[type] = [];
      byType[type].push(rec);
    });
    return { byId: byId, byType: byType, treasureMap: treasureMap };
  }

  function mapRaids(raids) {
    var byKey = {};          // real raids (isRaid true)
    var dungeonLockouts = [];// heroic/mythic dungeon + timewalking lockouts
    AE.asArray((raids || {}).savedInstances).forEach(function (si) {
      if (!si || si.instanceID == null) return;
      var rec = {
        key: si.instanceID + '/' + num(si.difficultyID),
        instanceID: num(si.instanceID),
        difficultyID: num(si.difficultyID),
        isRaid: si.isRaid === true,
        maxPlayers: num(si.maxPlayers),
        // These arrive already localized from the game.
        name: str(si.name),
        difficultyName: str(si.difficultyName),
        progress: num(si.encounterProgress),
        total: num(si.numEncounters),
        locked: si.locked === true,
        extended: si.extended === true,
        reset: num(si.reset),
        expires: num(si.expires),
        encounters: AE.asArray(si.encounters).map(function (e) {
          return { name: str(e.bossName), killed: e.isKilled === true };
        })
      };
      // GetSavedInstanceInfo returns dungeon lockouts too (difficultyID 2/23 for
      // heroic/mythic dungeons, 33 for timewalking). Without this split the raid
      // columns fill up with dungeon names.
      if (rec.isRaid) byKey[rec.key] = rec;
      else dungeonLockouts.push(rec);
    });
    return { byKey: byKey, dungeonLockouts: dungeonLockouts };
  }

  function mapEquipment(list) {
    var bySlot = {};
    AE.asArray(list).forEach(function (it) {
      if (!it) return;
      var slot = str(it.itemSlotName);
      if (!slot) return;
      bySlot[slot] = {
        slot: slot,
        name: str(it.itemName),
        link: str(it.itemLink),
        quality: num(it.itemQuality, null),
        itemLevel: num(it.itemLevel),
        type: str(it.itemType),
        subType: str(it.itemSubType),
        track: str(it.itemUpgradeTrack),
        upgradeLevel: num(it.itemUpgradeLevel),
        upgradeMax: num(it.itemUpgradeMax)
      };
    });
    return bySlot;
  }

  // Armor slots only: the cloak is always cloth and jewellery reports 其它, so
  // including them would skew the majority vote.
  var ARMOR_SLOTS = ['HEADSLOT', 'SHOULDERSLOT', 'CHESTSLOT', 'WRISTSLOT',
                     'HANDSSLOT', 'WAISTSLOT', 'LEGSSLOT', 'FEETSLOT'];

  /** The dominant localized armor subtype actually worn, or ''. */
  function armorFromGear(bySlot) {
    var tally = {};
    ARMOR_SLOTS.forEach(function (s) {
      var it = bySlot[s];
      if (!it || !it.subType) return;
      if (L.armorOrder.indexOf(it.subType) < 0) return;
      tally[it.subType] = (tally[it.subType] || 0) + 1;
    });
    var best = '', bestN = 0;
    Object.keys(tally).forEach(function (k) {
      if (tally[k] > bestN) { bestN = tally[k]; best = k; }
    });
    return best;
  }

  function mapPrey(prey, tables) {
    var completed = AE.asMap((prey || {}).questsCompleted);
    var nameByQuest = {};
    tables.preyQuests.forEach(function (q) {
      if (q && q.questID != null) nameByQuest[q.questID] = q;
    });

    var done = 0, seen = 0;
    var entries = [];
    var byDifficulty = {};

    Object.keys(completed).forEach(function (qid) {
      seen++;
      var isDone = completed[qid] === true;
      if (isDone) done++;
      var meta = nameByQuest[qid];
      var raw = meta ? str(meta.name, '#' + qid) : '#' + qid;
      var diff = (meta && meta.difficultyID && meta.difficultyID.__sym)
        ? meta.difficultyID.__sym : 'PREY_DIFFICULTY_UNKNOWN';

      // The addon stores "Prey: Kursak the Coiled (Nightmare)". The prefix and
      // the difficulty suffix are redundant once we group by difficulty.
      var short = raw.replace(/^Prey:\s*/, '').replace(/\s*\((?:Normal|Hard|Nightmare)\)\s*$/, '');

      if (!byDifficulty[diff]) byDifficulty[diff] = { done: 0, total: 0, entries: [] };
      byDifficulty[diff].total++;
      if (isDone) byDifficulty[diff].done++;

      var e = { questID: Number(qid), done: isDone, name: short, rawName: raw, difficulty: diff };
      byDifficulty[diff].entries.push(e);
      entries.push(e);
    });

    entries.sort(function (a, b) { return a.questID - b.questID; });
    Object.keys(byDifficulty).forEach(function (k) {
      byDifficulty[k].entries.sort(function (a, b) { return a.questID - b.questID; });
    });

    return { done: done, seen: seen, entries: entries, byDifficulty: byDifficulty };
  }

  /**
   * ilvl carries three numbers that legitimately disagree:
   *   level    = GetAverageItemLevel() overall average
   *   equipped = average counting EMPTY slots as 0, so it is lower whenever a
   *              slot is bare (verified: two characters here have 15/16 items
   *              and correspondingly lower `equipped`)
   *   pvp      = pvp-scaled average
   * We display `level` because that is what AlterEgo's own in-game window shows
   * (it does math.ceil on info.ilvl.level). Matching the addon matters: the
   * in-game window is the reference you would check this page against.
   */
  function mapIlvl(ilvl) {
    ilvl = ilvl || {};
    var level = num(ilvl.level);
    var equipped = num(ilvl.equipped);
    var big = Math.max(level, equipped);
    var suspect = big > 0 && Math.abs(level - equipped) / big > 0.1;
    return {
      value: level || equipped,
      level: level,
      equipped: equipped,
      pvp: num(ilvl.pvp),
      suspect: suspect
    };
  }

  function mapCharacter(guid, c, source, tables, scannedAt) {
    var info = c.info || {};
    var cls = info.class || {};
    var ilvl = mapIlvl(info.ilvl);
    var guild = info.guild || {};
    var currencies = mapCurrencies(c.currencies);
    var equipment = mapEquipment(c.equipment);
    var lastUpdate = num(c.lastUpdate);
    // dbVersion 22 records use currentSeasonID; 38 uses currentSeason.
    var season = num(c.currentSeason, num(c.currentSeasonID, null));

    return {
      key: source.id + '/' + guid,
      guid: guid,
      sourceId: source.id,
      sourceName: source.displayName,

      name: str(info.name, '?'),
      realm: str(info.realm, '?'),
      level: num(info.level),
      classFile: str(cls.file),
      className: str(cls.name),
      classColor: L.classColor(cls.file),
      raceName: str((info.race || {}).name),
      faction: str((info.factionGroup || {}).localized),
      factionEn: str((info.factionGroup || {}).english),

      ilvl: ilvl,
      guildName: guild.isInGuild === true ? str(guild.name) : '',
      guildRank: str(guild.rankName),

      money: num(c.money),
      gold: Math.floor(num(c.money) / 10000),

      lastUpdate: lastUpdate,
      lastUpdateDays: lastUpdate ? Math.floor((scannedAt - lastUpdate) / DAY) : null,

      season: season,
      enabled: c.enabled !== false,
      order: num(c.order),

      mp: mapMythicPlus(c.mythicplus),
      vault: mapVault(c.vault),
      delves: mapDelves(c.vault),
      treasureMap: currencies.treasureMap,
      currencies: currencies,
      raids: mapRaids(c.raids),
      equipment: equipment,
      armorType: L.armorType(cls.file),
      armorFromGear: armorFromGear(equipment),
      prey: mapPrey(c.prey, tables),

      raw: c
    };
  }

  // ------------------------------------------------------------ column sets

  function deriveColumns(characters, tables, activeSeason) {
    // --- Mythic+ dungeons -------------------------------------------------
    // Start from the addon's authoritative order for the active season, then
    // append any challengeModeID seen in data that the table does not know
    // about (so a mid-season addon update never blanks a column).
    var dungeonIds = [];
    var seenDungeon = {};
    tables.dungeons.forEach(function (d) {
      if (!d || d.seasonID !== activeSeason || d.challengeModeID == null) return;
      if (seenDungeon[d.challengeModeID]) return;
      seenDungeon[d.challengeModeID] = true;
      dungeonIds.push(d.challengeModeID);
    });
    characters.forEach(function (ch) {
      // Skip characters pinned to a different season; their challengeModeIDs are
      // from a previous expansion and would add permanently-blank columns.
      if (ch.season && ch.season !== activeSeason) return;
      Object.keys(ch.mp.byDungeon).forEach(function (cmID) {
        var id = Number(cmID);
        if (seenDungeon[id]) return;
        seenDungeon[id] = true;
        dungeonIds.push(id);
      });
    });

    // --- Raid lockouts ----------------------------------------------------
    // Union of (instanceID, difficultyID) actually present, ordered by the
    // addon's raid order then by difficulty.
    var raidKeySet = {};
    characters.forEach(function (ch) {
      Object.keys(ch.raids.byKey).forEach(function (k) { raidKeySet[k] = ch.raids.byKey[k]; });
    });
    var raidKeys = Object.keys(raidKeySet).sort(function (a, b) {
      var ra = raidKeySet[a], rb = raidKeySet[b];
      var ta = tables.raidByInstance[ra.instanceID], tb = tables.raidByInstance[rb.instanceID];
      var oa = ta ? num(ta.order, 99) : 99, ob = tb ? num(tb.order, 99) : 99;
      if (oa !== ob) return oa - ob;
      if (ra.instanceID !== rb.instanceID) return ra.instanceID - rb.instanceID;
      var da = L.raidDifficultyOrder.indexOf(ra.difficultyID);
      var db2 = L.raidDifficultyOrder.indexOf(rb.difficultyID);
      return (da < 0 ? 99 : da) - (db2 < 0 ? 99 : db2);
    });
    var raidColumns = raidKeys.map(function (k) {
      var r = raidKeySet[k];
      var meta = tables.raidByInstance[r.instanceID];
      return {
        key: k,
        instanceID: r.instanceID,
        difficultyID: r.difficultyID,
        // Prefer the localized name straight from the lockout data.
        name: r.name || (meta ? meta.name : '#' + r.instanceID),
        abbr: meta ? meta.abbr : ('#' + r.instanceID),
        difficultyName: r.difficultyName || L.raidDifficultyZh[r.difficultyID] || String(r.difficultyID),
        total: r.total
      };
    });

    // --- Currencies -------------------------------------------------------
    // Ordered by the addon's table (active season first), unknown ids appended.
    var wantedTypes = { crest: 1, catalyst: 1, spark: 1, bonusroll: 1 };
    var present = {};
    characters.forEach(function (ch) {
      Object.keys(ch.currencies.byId).forEach(function (id) {
        present[id] = ch.currencies.byId[id];
      });
    });

    function currencyOrderKey(id) {
      var meta = tables.currencyById[id];
      if (!meta) return [2, 0];
      return [meta.seasonID === activeSeason ? 0 : 1, tables.currencies.indexOf(meta)];
    }

    var currencyIds = Object.keys(present)
      .filter(function (id) { return wantedTypes[present[id].type]; })
      .sort(function (a, b) {
        var ka = currencyOrderKey(a), kb = currencyOrderKey(b);
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        return ka[1] - kb[1];
      })
      .map(Number);

    // Characters still hold currencies from previous expansions (Dragonflight
    // and TWW crests show up here), which is 30+ columns of noise. Flag the
    // off-season ones so the UI can default them to hidden without losing them.
    var offSeasonCurrencies = {};
    currencyIds.concat(Object.keys(present).map(Number)).forEach(function (id) {
      var meta = tables.currencyById[id];
      if (!meta || meta.seasonID !== activeSeason) offSeasonCurrencies[id] = true;
    });

    var delveCurrencyIds = Object.keys(present)
      .filter(function (id) { return present[id].type === 'delve'; })
      .sort(function (a, b) {
        var ka = currencyOrderKey(a), kb = currencyOrderKey(b);
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        return ka[1] - kb[1];
      })
      .map(Number);

    var currencyMeta = {};
    Object.keys(present).forEach(function (id) { currencyMeta[id] = present[id]; });

    return {
      dungeonIds: dungeonIds,
      raidColumns: raidColumns,
      currencyIds: currencyIds,
      delveCurrencyIds: delveCurrencyIds,
      currencyMeta: currencyMeta,
      offSeasonCurrencies: offSeasonCurrencies
    };
  }

  // -------------------------------------------------- localized name harvest
  /**
   * Recover localized dungeon names from the data itself. Two independent
   * sources, because neither alone covers every dungeon:
   *
   *   1. Dungeon lockouts (raids.savedInstances) carry a localized `name`, and
   *      Data.dungeons[].mapId equals savedInstances[].instanceID. Covers any
   *      dungeon you currently hold a heroic/mythic lockout for.
   *
   *   2. The keystone item link:
   *      "|Hkeystone:180653:399:11:...|h[钥石：红玉新生法池 (11)]|h|r"
   *      -- the second link field is the challengeModeID and the bracket text
   *      holds the localized dungeon name. Covers the key you are carrying even
   *      with no lockout.
   *
   * Only current lockouts/keys are present, so `learned` (persisted by
   * settings.js) is merged in to remember names past expiry.
   */
  function harvestDungeonNames(characters, tables, learned) {
    var out = {};
    // Previously learned names first, so a fresh harvest can correct them.
    if (learned) {
      Object.keys(learned).forEach(function (k) {
        if (learned[k]) out[k] = String(learned[k]);
      });
    }

    // --- source 1: dungeon lockouts, joined through mapId
    var nameByInstance = {};
    characters.forEach(function (ch) {
      ch.raids.dungeonLockouts.forEach(function (d) {
        if (d.name && d.instanceID) nameByInstance[d.instanceID] = d.name;
      });
    });
    tables.dungeons.forEach(function (d) {
      if (!d || d.challengeModeID == null || d.mapId == null) return;
      var zh = nameByInstance[d.mapId];
      // Ignore a "localized" name that is just the English one echoed back.
      if (zh && zh !== d.name) out[d.challengeModeID] = zh;
    });

    // --- source 2: keystone item links
    characters.forEach(function (ch) {
      var ks = ch.mp.keystone;
      if (!ks || !ks.itemLink) return;
      var idMatch = ks.itemLink.match(/\|Hkeystone:\d+:(\d+):/);
      var label = ks.itemLink.match(/\|h\[([^\]]*)\]\|h/);
      if (!idMatch || !label) return;
      var cmID = Number(idMatch[1]);
      // "钥石：红玉新生法池 (11)" -> "红玉新生法池"
      var name = label[1].replace(/^[^：:]*[：:]\s*/, '').replace(/\s*\(\d+\)\s*$/, '').trim();
      if (!name || !/[一-鿿]/.test(name)) return;
      var meta = tables.dungeonById[cmID];
      if (meta && name === meta.name) return;
      if (!out[cmID]) out[cmID] = name;
    });

    return out;
  }

  /**
   * The localized season name, harvested from the game's own strings.
   *
   * vault.slots[].raidString is "击败%d个至暗之夜第2赛季首领" -- strip the
   * "击败%d个" prefix and the "首领" suffix and what remains is the localized
   * season name. Nothing else in the saved data carries it, and the addon's own
   * Seasons.lua is English only ("Midnight - Season 2").
   */
  function harvestSeasonName(characters, tables, activeSeason) {
    var meta = null;
    tables.seasons.forEach(function (s) { if (s && s.seasonID === activeSeason) meta = s; });
    var display = meta ? num(meta.seasonDisplayID, null) : null;

    var counts = {};
    characters.forEach(function (ch) {
      if (ch.season && ch.season !== activeSeason) return;
      L.vaultTypeOrder.forEach(function (t) {
        (ch.vault.byType[t] || []).forEach(function (slot) {
          if (!slot.raidString) return;
          var zh = slot.raidString
            .replace(/^[^%]*%(\d+\$)?d\s*个?/, '')
            .replace(/首领\s*$/, '')
            .trim();
          if (!zh || !/[一-鿿]/.test(zh)) return;
          counts[zh] = (counts[zh] || 0) + 1;
        });
      });
    });

    // Take the most common: a stale record can contribute a previous season's
    // wording (this data has both 至暗之夜第2赛季 and 解放安德麦).
    var best = '', bestN = 0;
    Object.keys(counts).forEach(function (k) {
      if (counts[k] > bestN) { bestN = counts[k]; best = k; }
    });

    var short = 'S' + (display || activeSeason);
    var label = '赛季 ' + activeSeason;
    if (best) label = best + '　' + short;
    else if (meta && meta.name) label = meta.name + ' ' + short;

    return {
      localized: best,
      english: meta ? str(meta.name) : '',
      short: short,
      display: display,
      label: label
    };
  }

  /**
   * Shorten a set of CJK names to unique 2-4 char prefixes.
   * @param {Array<{id:*, full:string, fallback:string}>} items
   * @returns {Object} id -> short label
   */
  function shortenNames(items) {
    var out = {};
    var used = {};
    var pending = [];

    items.forEach(function (it) {
      // Only abbreviate CJK; an English name is already short (the addon's abbr).
      if (!/[一-鿿]/.test(it.full || '')) {
        out[it.id] = it.fallback;
        used[it.fallback] = true;
        return;
      }
      pending.push(it);
    });

    pending.forEach(function (it) {
      var short = null;
      for (var len = 2; len <= Math.min(4, it.full.length); len++) {
        var cand = it.full.slice(0, len);
        if (!used[cand]) { short = cand; break; }
      }
      // A duplicate header would be worse than an English one: two columns would
      // look interchangeable.
      if (!short) short = it.fallback;
      used[short] = true;
      out[it.id] = short;
    });

    return out;
  }

  /**
   * Two-character Chinese abbreviations for the dungeon columns.
   * Derived from the localized names rather than hand-curated, so new seasons
   * work without edits.
   */
  function buildShortNames(dungeonIds, tables, dungeonNames, overrides) {
    return shortenNames(dungeonIds.map(function (cmID) {
      var meta = tables.dungeonById[cmID];
      return {
        id: cmID,
        full: (overrides && overrides[cmID]) || dungeonNames[cmID] || '',
        fallback: (meta && meta.abbr) || ('#' + cmID)
      };
    }));
  }

  /** Same treatment for raid columns; names come localized from the lockout. */
  function buildRaidShortNames(raidColumns) {
    var byInstance = {};
    raidColumns.forEach(function (rc) {
      if (!byInstance[rc.instanceID]) {
        byInstance[rc.instanceID] = { id: rc.instanceID, full: rc.name, fallback: rc.abbr };
      }
    });
    var ids = Object.keys(byInstance).map(function (k) { return byInstance[k]; });
    return shortenNames(ids);
  }

  // -------------------------------------------------------- external profiles
  /**
   * Build a Raider.io / Warcraft Logs profile URL for a character.
   *
   * VERIFIED against a real character on a Chinese realm: raider.io accepts
   * BOTH the URL-encoded localized realm name and the English slug (both return
   * 200). The localized form is used here because the English slug is not
   * present anywhere in the saved data.
   *
   * NOT VERIFIED: Warcraft Logs returns 403 to any scripted request (Cloudflare),
   * including for a deliberately bogus name, so its URL shape could not be
   * confirmed from here. The documented pattern is
   * /character/<region>/<realm>/<name>. Both bases and the realm form are
   * settings, so they can be corrected without touching code.
   */
  AE.profileUrls = function (ch, linkCfg) {
    var cfg = linkCfg || {};
    var region = cfg.region || 'cn';
    if (L.isPseudoRealm(ch.realm) || !ch.realm || ch.realm === '?') {
      return { rio: null, wcl: null, reason: '“' + ch.realm + '”不是真实服务器名（跨服大秘境分区），无法拼出主页链接' };
    }
    var realm = cfg.realmForm === 'slug' ? slugify(ch.realm) : encodeURIComponent(ch.realm);
    var name = encodeURIComponent(ch.name);
    var rioBase = cfg.rioBase || 'https://raider.io/characters';
    var wclBase = cfg.wclBase || 'https://www.warcraftlogs.com/character';
    return {
      rio: rioBase + '/' + region + '/' + realm + '/' + name,
      wcl: wclBase + '/' + region + '/' + realm + '/' + name,
      reason: null
    };
  };

  function slugify(s) {
    return String(s).toLowerCase().replace(/\s+/g, '-').replace(/['’]/g, '');
  }

  // ---------------------------------------------------------------- entry point

  /**
   * @param {object} raw  window.AE_DATA as produced by tools/scan.ps1
   * @param {object} [learnedNames]  cached {challengeModeID: localizedName}
   * @returns {object} the view model
   */
  AE.buildModel = function (raw, learnedNames, nameOverrides) {
    if (!raw || !raw.sources) throw new Error('AE_DATA is missing or malformed');

    var tables = buildTables(raw.addonTables);
    var scannedAt = num(raw.scannedAt, Math.floor(Date.now() / 1000));

    var characters = [];
    var sources = [];
    var weeklyReset = 0;
    var globalPrefs = null;

    raw.sources.forEach(function (s) {
      var info = {
        id: s.id,
        account: s.account,
        displayName: s.displayName || s.account,
        flavor: s.flavor,
        path: s.path,
        usedPath: s.usedPath,
        degraded: s.degraded === true,
        size: num(s.size),
        mtime: num(s.mtime),
        mtimeLocal: s.mtimeLocal,
        ageDays: num(s.mtime) ? Math.floor((scannedAt - num(s.mtime)) / DAY) : null,
        dbVersion: null,
        charCount: 0,
        seasons: [],
        parseError: null,
        skippedLines: 0
      };
      info.stale = info.ageDays != null && info.ageDays > STALE_DAYS;

      var db = null;
      try {
        var res = AE.parseLuaGlobals(s.lua || '');
        info.skippedLines = res.skipped.length;
        db = res.globals.AlterEgoDB;
        if (!db) throw new Error('no AlterEgoDB global in this file');
      } catch (e) {
        info.parseError = String(e.message).split('\n')[0];
        sources.push(info);
        return;
      }

      var g = db.global || {};
      info.dbVersion = num(g.dbVersion, null);
      weeklyReset = Math.max(weeklyReset, num(g.weeklyReset));

      // The user already expressed display preferences in-game; use the richest
      // source's as our initial defaults rather than re-asking.
      var chars = AE.asMap(g.characters);
      var charKeys = Object.keys(chars);
      if (!globalPrefs || charKeys.length > globalPrefs.charCount) {
        globalPrefs = {
          charCount: charKeys.length,
          showRealms: g.showRealms !== false,
          showZeroRatedCharacters: g.showZeroRatedCharacters !== false,
          hiddenCurrencies: Object.keys(AE.asMap((g.currencies || {}).hiddenCurrencies))
            .filter(function (k) { return AE.asMap((g.currencies || {}).hiddenCurrencies)[k] === true; })
            .map(Number)
        };
      }

      var seasonSet = {};
      charKeys.forEach(function (guid) {
        var c = chars[guid];
        if (!c || typeof c !== 'object') return;
        var row = mapCharacter(guid, c, info, tables, scannedAt);
        // season 0 means the addon has not recorded one yet -- verified on an
        // actively-played character with rating 1985. Treat it as "unknown",
        // not as a mismatch.
        if (row.season) seasonSet[row.season] = true;
        characters.push(row);
        info.charCount++;
      });
      info.seasons = Object.keys(seasonSet).map(Number).sort(function (a, b) { return a - b; });

      sources.push(info);
    });

    // Active season: the newest one anybody is actually playing, else the newest
    // the addon knows about.
    var activeSeason = 0;
    characters.forEach(function (ch) { if (ch.season && ch.season > activeSeason) activeSeason = ch.season; });
    if (!activeSeason) {
      tables.dungeons.forEach(function (d) { if (d && d.seasonID > activeSeason) activeSeason = d.seasonID; });
    }

    characters.forEach(function (ch) {
      // Only a positive, different season counts as a mismatch. 0 / null means
      // "not recorded", which is common and not a problem.
      ch.seasonMismatch = !!ch.season && activeSeason > 0 && ch.season !== activeSeason;
    });
    sources.forEach(function (s) {
      s.seasonMismatch = s.seasons.length > 0 && s.seasons.indexOf(activeSeason) < 0;
    });

    var columns = deriveColumns(characters, tables, activeSeason);
    var dungeonNames = harvestDungeonNames(characters, tables, learnedNames);
    var season = harvestSeasonName(characters, tables, activeSeason);
    var dungeonShortNames = buildShortNames(columns.dungeonIds, tables, dungeonNames, nameOverrides);
    var raidShortNames = buildRaidShortNames(columns.raidColumns);

    // Realms, for the filter tree. Note some "realms" are cross-realm zone names
    // (e.g. CN史诗地下城) -- we list what the data says and let the user decide.
    var realmSet = {};
    characters.forEach(function (ch) { realmSet[ch.realm] = (realmSet[ch.realm] || 0) + 1; });
    var realms = Object.keys(realmSet).sort().map(function (r) {
      return { name: r, count: realmSet[r] };
    });

    return {
      scannedAt: scannedAt,
      scannedAtLocal: raw.scannedAtLocal || '',
      toolVersion: raw.toolVersion || '',
      author: raw.author || '',
      repo: raw.repo || '',
      update: raw.update || null,
      backupIndex: AE.asArray(raw.backupIndex),
      addonVersion: raw.addonVersion || '',
      wowRoots: AE.asArray(raw.wowRoots),
      scanErrors: AE.asArray(raw.errors),
      tables: tables,
      sources: sources,
      characters: characters,
      realms: realms,
      activeSeason: activeSeason,
      season: season,
      weeklyReset: weeklyReset,
      gamePrefs: globalPrefs || { showRealms: true, showZeroRatedCharacters: true, hiddenCurrencies: [] },
      columns: columns,
      dungeonNames: dungeonNames,
      dungeonShortNames: dungeonShortNames,
      raidShortNames: raidShortNames,
      staleDays: STALE_DAYS
    };
  };

  /**
   * Human text for an unmet vault threshold.
   *
   * Do NOT just substitute slots[].raidString: verified on real data, Blizzard
   * fills that field with the RAID wording ("击败 N 个…首领") on every row,
   * including the Mythic+ and Delve rows, where it is simply wrong. Only the
   * raid row gets to use it.
   */
  AE.vaultRequirement = function (type, threshold, raidString) {
    if (type === L.VAULT_RAID && raidString) {
      return AE.formatWowString(raidString, threshold);
    }
    if (type === L.VAULT_MPLUS) return '完成 ' + threshold + ' 个大秘境';
    if (type === L.VAULT_WORLD) return '完成 ' + threshold + ' 个地下堡';
    if (raidString) return AE.formatWowString(raidString, threshold);
    return '需要 ' + threshold + ' 次';
  };

  /** Vault summary for one type: how many of the three slots are unlocked. */
  AE.vaultSummary = function (ch, type) {
    var slots = (ch.vault.byType[type] || []);
    if (!slots.length) return null;
    var unlocked = 0;
    slots.forEach(function (s) { if (s.unlocked) unlocked++; });
    return { unlocked: unlocked, total: slots.length, slots: slots };
  };

  /** Estimated reward item level for a Mythic+ vault slot. */
  AE.vaultItemLevel = function (model, keystoneLevel) {
    var perSeason = model.tables.vaultItemLevels[String(model.activeSeason)];
    if (!perSeason || !keystoneLevel) return null;
    var lv = Math.min(10, Math.max(2, keystoneLevel));
    // Levels above the table's max clamp to the max entry.
    return perSeason[String(lv)] != null ? perSeason[String(lv)] : null;
  };

})(typeof window !== 'undefined' ? window : globalThis);
