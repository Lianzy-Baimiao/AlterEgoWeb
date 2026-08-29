/*
 * WowAltBoard - app/labels.js
 *
 * Display labels and colors that are NOT present in the SavedVariables data.
 *
 * What IS in the data already (and must be preferred over anything here):
 *   info.name / info.realm / info.race.name / info.class.name
 *   info.factionGroup.localized / info.guild.*
 *   currencies[].name                     (localized)
 *   raids.savedInstances[].name           (localized)
 *   raids.savedInstances[].difficultyName (localized)
 *   savedInstances[].encounters[].bossName(localized)
 *   equipment[].itemName / itemType / itemUpgradeTrack
 *
 * What is NOT in the data and therefore lives here:
 *   - class colors      (the addon calls C_ClassColor at runtime)
 *   - item quality colors
 *   - equipment slot names
 *   - group / vault-row / currency-kind headings
 *
 * DUNGEON NAMES ARE *NOT* HARDCODED HERE, ON PURPOSE.
 *   mythicplus.dungeons only persists challengeModeID, and the addon resolves
 *   names at runtime via C_ChallengeMode.GetMapUIInfo without ever saving them.
 *   But the localized name IS recoverable from the data: dungeon lockouts in
 *   raids.savedInstances carry a localized `name`, and Data.dungeons[].mapId
 *   joins to savedInstances[].instanceID. model.js harvests that mapping, and
 *   settings.js caches it so a name stays known after the lockout expires.
 *
 *   I originally hand-wrote a zhCN table here and it was measurably wrong -- I
 *   had "塞泰里斯神庙" where the client actually says "塞塔里斯神庙". Harvesting
 *   from the game's own strings removes that whole class of error, so the guess
 *   table is gone. Resolution order is:
 *       user override > harvested/cached zhCN > addon enUS name > abbr > #id
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels = {};

  // ------------------------------------------------------------ class colors
  // Standard Blizzard class colors, keyed by info.class.file.
  L.classColors = {
    DEATHKNIGHT: '#C41E3A',
    DEMONHUNTER: '#A330C9',
    DRUID:       '#FF7C0A',
    EVOKER:      '#33937F',
    HUNTER:      '#AAD372',
    MAGE:        '#3FC7EB',
    MONK:        '#00FF98',
    PALADIN:     '#F48CBA',
    PRIEST:      '#FFFFFF',
    ROGUE:       '#FFF468',
    SHAMAN:      '#0070DD',
    WARLOCK:     '#8788EE',
    WARRIOR:     '#C69B6D'
  };

  L.classColor = function (classFile) {
    return L.classColors[String(classFile || '').toUpperCase()] || '#B9C4D4';
  };

  // ----------------------------------------------------- item quality colors
  // Indexed by itemQuality / the N in a |cnIQN: link prefix.
  L.qualityColors = {
    0: '#9D9D9D',  // poor
    1: '#FFFFFF',  // common
    2: '#1EFF00',  // uncommon
    3: '#0070DD',  // rare
    4: '#A335EE',  // epic
    5: '#FF8000',  // legendary
    6: '#E6CC80',  // artifact
    7: '#00CCFF',  // heirloom
    8: '#00CCFF'   // wow token
  };

  // ------------------------------------------------------------ dungeon zhCN
  // Deliberately empty -- see the header note. Names are harvested from the
  // game's own localized lockout strings by model.js. This object stays only as
  // a merge target so a future hand-correction has somewhere to live.
  L.dungeonZh = {};

  // Raid instanceID -> zhCN. Also empty by design: a raid you have a lockout on
  // carries its localized name in savedInstances[].name, which the model prefers.
  L.raidZh = {};

  // ------------------------------------------------------- equipment slots
  L.slotZh = {
    HEADSLOT: '头部',
    NECKSLOT: '颈部',
    SHOULDERSLOT: '肩部',
    BACKSLOT: '背部',
    CHESTSLOT: '胸部',
    WRISTSLOT: '手腕',
    HANDSSLOT: '手',
    WAISTSLOT: '腰部',
    LEGSSLOT: '腿部',
    FEETSLOT: '脚',
    FINGER0SLOT: '戒指 1',
    FINGER1SLOT: '戒指 2',
    TRINKET0SLOT: '饰品 1',
    TRINKET1SLOT: '饰品 2',
    MAINHANDSLOT: '主手',
    SECONDARYHANDSLOT: '副手'
  };

  // Display order for the equipment drawer.
  L.slotOrder = [
    'HEADSLOT', 'NECKSLOT', 'SHOULDERSLOT', 'BACKSLOT', 'CHESTSLOT',
    'WRISTSLOT', 'HANDSSLOT', 'WAISTSLOT', 'LEGSSLOT', 'FEETSLOT',
    'FINGER0SLOT', 'FINGER1SLOT', 'TRINKET0SLOT', 'TRINKET1SLOT',
    'MAINHANDSLOT', 'SECONDARYHANDSLOT'
  ];

  // ------------------------------------------------------- raid difficulties
  // The data carries a localized difficultyName, so this is only a fallback and
  // an ordering hint.
  L.raidDifficultyZh = { 17: '随机', 14: '普通', 15: '英雄', 16: '史诗' };
  L.raidDifficultyOrder = [17, 14, 15, 16];

  // -------------------------------------------------------------- vault rows
  // Empirically pinned against real vault.slots data on this machine:
  //   type 1: thresholds 1/4/8, level = keystone level          -> Mythic+
  //   type 3: thresholds 2/4/6, level = raid difficultyID       -> Raid
  //   type 6: thresholds 2/4/8, level = delve tier              -> Delves/World
  //   type 2 / 5: present in the file but ignored by the addon itself
  // Two prior research passes disagreed about these numbers; the values here are
  // what the actual saved data says.
  L.VAULT_MPLUS = 1;
  L.VAULT_RAID  = 3;
  L.VAULT_WORLD = 6;

  L.vaultTypeZh = {};
  L.vaultTypeZh[L.VAULT_MPLUS] = '大秘境';
  L.vaultTypeZh[L.VAULT_RAID]  = '团队副本';
  L.vaultTypeZh[L.VAULT_WORLD] = '地下堡';

  L.vaultTypeOrder = [L.VAULT_MPLUS, L.VAULT_RAID, L.VAULT_WORLD];

  // ------------------------------------------------------------ currency kind
  L.currencyTypeZh = {
    crest:     '纹章',
    catalyst:  '催化剂',
    spark:     '闪光',
    bonusroll: '额外奖励',
    delve:     '地下堡',
    delveMap:  '藏宝图'
  };

  // ------------------------------------------------------------------- prey
  L.preyDifficultyZh = {
    PREY_DIFFICULTY_NORMAL:    '普通',
    PREY_DIFFICULTY_HARD:      '困难',
    PREY_DIFFICULTY_NIGHTMARE: '噩梦'
  };

  // ------------------------------------------------------------------- skins
  // Each skin sets only the hues; light/dark is a separate axis, so 4 skins x 2
  // modes gives 8 looks from one small table.
  AE.SKINS = [
    { id: 'slate',  label: '石板蓝（默认）', accent: '#4aa3ff', dark: '#14161a', light: '#f6f7f9' },
    { id: 'jade',   label: '青玉',           accent: '#2fb886', dark: '#101815', light: '#f2f8f5' },
    { id: 'amber',  label: '琥珀',           accent: '#e0952f', dark: '#191510', light: '#faf6ef' },
    { id: 'violet', label: '紫罗兰',         accent: '#a678f0', dark: '#161320', light: '#f7f5fc' }
  ];

  AE.FONTS = [
    { id: 'system', label: '系统默认',
      css: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif' },
    { id: 'yahei',  label: '微软雅黑',
      css: '"Microsoft YaHei", "Microsoft YaHei UI", sans-serif' },
    { id: 'serif',  label: '宋体 / 衬线',
      css: '"Source Han Serif SC", "Noto Serif CJK SC", SimSun, "Songti SC", serif' },
    { id: 'mono',   label: '等宽',
      css: 'Consolas, "Cascadia Mono", "Sarasa Mono SC", "Courier New", monospace' },
    { id: 'hei',    label: '黑体',
      css: 'SimHei, "Heiti SC", sans-serif' }
  ];

  // ---------------------------------------------------------- external links
  // Realms that are not actually realms. A cross-realm Mythic+ zone name is what
  // the game reports in info.realm, and no profile site will resolve it.
  L.pseudoRealms = ['CN史诗地下城'];

  L.isPseudoRealm = function (realm) {
    return L.pseudoRealms.indexOf(String(realm)) >= 0;
  };

  // ---------------------------------------------------------------- helpers

  /**
   * Best available label for a dungeon.
   * Priority: user override > harvested/cached zhCN > addon enUS name > abbr > #id
   *
   * @param {number} cmID       challengeModeID
   * @param {object} info       the addon's Data.dungeons entry (may be undefined)
   * @param {object} [overrides] user-supplied {cmID: "name"} from settings
   * @param {object} [harvested] {cmID: "localized name"} from model.dungeonNames
   */
  L.dungeonLabel = function (cmID, info, overrides, harvested) {
    if (overrides && overrides[cmID]) return String(overrides[cmID]);
    if (harvested && harvested[cmID]) return String(harvested[cmID]);
    var zh = L.dungeonZh[cmID];
    if (zh && zh.zh) return zh.zh;
    if (info && info.name) return info.name;
    if (info && info.abbr) return info.abbr;
    return '#' + cmID;
  };

  /**
   * Short Chinese header, e.g. 毒牙祭坛 -> 毒牙.
   *
   * Derived from the localized name rather than curated, so it keeps working for
   * future seasons. `shortMap` is precomputed per model (see AE.buildShortNames)
   * because avoiding collisions needs to consider all dungeons at once.
   */
  L.dungeonShort = function (cmID, info, overrides, harvested, shortMap) {
    if (overrides && overrides[cmID]) return String(overrides[cmID]);
    if (shortMap && shortMap[cmID]) return shortMap[cmID];
    return L.dungeonLabel(cmID, info, overrides, harvested);
  };

  /** English abbreviation from the addon's own table (AOF, MR, KR ...). */
  L.dungeonAbbr = function (cmID, info, overrides, harvested) {
    if (overrides && overrides[cmID]) return String(overrides[cmID]);
    if (info && info.abbr) return info.abbr;
    return L.dungeonLabel(cmID, info, overrides, harvested);
  };

  /** True when no Chinese name is available and we are falling back to English. */
  L.dungeonNeedsTranslation = function (cmID, overrides, harvested) {
    if (overrides && overrides[cmID]) return false;
    if (harvested && harvested[cmID]) return false;
    var zh = L.dungeonZh[cmID];
    return !(zh && zh.zh);
  };

  // ------------------------------------------------------------- armor types
  // Not in the saved data as a field, but equipment[].itemSubType carries the
  // localized string (板甲 / 锁甲 / 皮甲 / 布甲) for armor pieces. The class map is
  // the reliable source since it works even for a character with no equipment
  // recorded; the equipment is used only to cross-check.
  L.armorByClass = {
    WARRIOR: '板甲', PALADIN: '板甲', DEATHKNIGHT: '板甲',
    HUNTER: '锁甲', SHAMAN: '锁甲', EVOKER: '锁甲',
    ROGUE: '皮甲', MONK: '皮甲', DRUID: '皮甲', DEMONHUNTER: '皮甲',
    MAGE: '布甲', PRIEST: '布甲', WARLOCK: '布甲'
  };

  L.armorOrder = ['板甲', '锁甲', '皮甲', '布甲'];

  L.armorType = function (classFile) {
    return L.armorByClass[String(classFile || '').toUpperCase()] || '';
  };

  L.slotLabel = function (slotName) {
    return L.slotZh[slotName] || slotName || '?';
  };

  L.preyDifficultyLabel = function (sym) {
    return L.preyDifficultyZh[sym] || String(sym || '').replace('PREY_DIFFICULTY_', '');
  };

  // ------------------------------------------------------------- professions
  // Profession NAMES are not hardcoded: BagSync stores the localized name on
  // every skill line, so the same rule as dungeon names applies -- use the data.
  //
  // What is NOT in the data is which skill lines are primary (you get two) and
  // which are secondary (everyone can have them). Without that split there is no
  // way to fill a 专业1 / 专业2 column, because BagSync keeps a flat hash keyed by
  // skillLineID with no slot order in it.
  //
  // Anything not listed here is deliberately dropped rather than shown. The known
  // case is 794 考古学: removed from retail in 11.0, but BagSync still carries the
  // old record, and a permanently-1/800 考古学 column is pure noise. If Blizzard
  // ever adds a profession, add its skillLineID to one of these two lists.
  L.professionPrimaryIds = [
    171, // 炼金术
    164, // 锻造
    333, // 附魔
    202, // 工程学
    182, // 草药学
    773, // 铭文
    755, // 珠宝加工
    165, // 制皮
    186, // 采矿
    393, // 剥皮
    197  // 裁缝
  ];

  L.professionSecondaryIds = [
    185, // 烹饪
    356  // 钓鱼
  ];

  L.isPrimaryProfession = function (id) {
    return L.professionPrimaryIds.indexOf(Number(id)) >= 0;
  };

  L.isSecondaryProfession = function (id) {
    return L.professionSecondaryIds.indexOf(Number(id)) >= 0;
  };

})(typeof window !== 'undefined' ? window : globalThis);
