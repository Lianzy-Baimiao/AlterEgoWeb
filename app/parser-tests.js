/*
 * WowAltBoard - app/parser-tests.js
 *
 * Test cases for lua-parser.js. Runs in the browser via tests.html and in node.
 * Every case here came from something actually observed in the SavedVariables
 * corpus on this machine (2186 .lua files), not from imagination.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var J = JSON.stringify;

  // Each case: [name, luaSource, predicate(globals, skipped) -> true | reason]
  var CASES = [
    ['bare `true` in the array part (global.prey.hiddenDifficulties)',
      'X = {\ntrue,\n}',
      function (g) { return J(g.X) === '[true]' || J(g.X); }],

    // NOTE: source order here is [17] then [14], but JS objects reorder
    // integer-like keys into ascending numeric order per the language spec. That
    // is unavoidable and harmless -- these tables are lookup maps, never
    // sequences. Assert on values, not on key order. (Non-integer string keys,
    // e.g. the GUIDs in global.characters, DO keep insertion order.)
    ['sparse out-of-order int keys (global.raids.hiddenDifficulties)',
      'X = {\n[17] = true,\n[14] = false,\n}',
      function (g) {
        return (g.X['17'] === true && g.X['14'] === false &&
                Object.keys(g.X).length === 2) || J(g.X);
      }],

    ['contiguous int keys collapse to an array',
      'X = {\n[2] = "b",\n[1] = "a",\n}',
      function (g) { return J(g.X) === '["a","b"]' || J(g.X); }],

    ['empty table',
      'X = {\n}',
      function (g) { return J(g.X) === '[]' || J(g.X); }],

    ['negative int key (BagSync.lua)',
      'X = {\n[-1] = 5,\n}',
      function (g) { return J(g.X) === '{"-1":5}' || J(g.X); }],

    ['boolean key (RareScanner.lua)',
      'X = {\n[true] = -1,\n}',
      function (g) { return J(g.X) === '{"true":-1}' || J(g.X); }],

    ['float key (AddOnSkinsDS)',
      'X = {\n[4.73] = { ["Clique"] = true },\n}',
      function (g) { return J(g.X) === '{"4.73":{"Clique":true}}' || J(g.X); }],

    ['scientific notation, both signs (WeakAuras.lua)',
      'X = {\n["y"] = 1.1444091796875e-05,\n["x"] = -1.52587890625e-05,\n}',
      function (g) { return (g.X.y === 1.1444091796875e-05 && g.X.x === -1.52587890625e-05) || J(g.X); }],

    ['`nil` followed by a block comment (how WoW serializes functions)',
      'X = {\n[10] = nil --[[ skipped inline function ]],\n[11] = 1,\n}',
      function (g) { return (g.X['10'] === null && g.X['11'] === 1) || J(g.X); }],

    ['item link stuffed with | [ ] :',
      'X = {\n["l"] = "|cnIQ2:|Hitem:240232::::::::10:102::75:5:12615:2:28:2905:9:10:::::|h[林地奇兵的胸甲]|h|r",\n}',
      function (g) { return g.X.l.indexOf('[林地奇兵的胸甲]') > 0 || J(g.X); }],

    ['\\r\\n escapes plus CJK full-width punctuation in one string',
      'X = {\n["d"] = "用于升级\\r\\n\\r\\n- 地下堡（难度5-6）",\n}',
      function (g) {
        return (g.X.d.split('\n').length === 3 && g.X.d.indexOf('地下堡') > 0) || J(g.X);
      }],

    ['%d printf token survives (vault.slots[].raidString)',
      'X = {\n["r"] = "击败%d个至暗之夜第2赛季首领",\n}',
      function (g) { return g.X.r === '击败%d个至暗之夜第2赛季首领' || J(g.X); }],

    ['multiple top-level globals (446 files in the corpus)',
      'A = 1\nB = true\nC = {\n["k"] = 2,\n}',
      function (g) { return (g.A === 1 && g.B === true && g.C.k === 2) || J(g); }],

    ['non-table global float (Blizzard_CombatLog_Filter_Version)',
      'Blizzard_CombatLog_Filter_Version = 4.3',
      function (g) { return g.Blizzard_CombatLog_Filter_Version === 4.3 || J(g); }],

    ['nil global (TomTomWaypoints)',
      'TomTomWaypoints = nil',
      function (g) { return g.TomTomWaypoints === null || J(g); }],

    ['long base64 string global (HEYBOX_SAVED_PER_PLAYER_INFOS)',
      'H = "eyJDaGFyYWN0ZXJJbmZvIjp7"',
      function (g) { return g.H === 'eyJDaGFyYWN0ZXJJbmZvIjp7' || J(g); }],

    ['no spaces around `=` (AddOnSkins.lua, HandyNotes_*)',
      'X = {\n["某角色 - 某服务器"]="Default",\n}',
      function (g) { return g.X['某角色 - 某服务器'] === 'Default' || J(g.X); }],

    ['tab indentation (Details.lua, Plater.lua)',
      'X = {\n\t["a"] = 1,\n\t\t["b"] = 2,\n}',
      function (g) { return (g.X.a === 1 && g.X.b === 2) || J(g.X); }],

    ['mixed array and hash parts in one table',
      'X = {\n"first",\n["k"] = 1,\n"second",\n}',
      function (g) {
        return (g.X['1'] === 'first' && g.X['2'] === 'second' && g.X.k === 1) || J(g.X);
      }],

    ['decimal escape \\000 (Auctionator.lua binary blobs)',
      'X = {\n["b"] = "a\\000b",\n}',
      function (g) { return (g.X.b.length === 3 && g.X.b.charCodeAt(1) === 0) || J(g.X); }],

    ['escaped backslash in a Windows path, and escaped quotes',
      'X = {\n["p"] = "Interface\\\\AddOns\\\\x",\n["q"] = "say \\"hi\\"",\n}',
      function (g) {
        return (g.X.p === 'Interface\\AddOns\\x' && g.X.q === 'say "hi"') || J(g.X);
      }],

    ['leading blank line + CRLF (exactly how AlterEgo.lua starts)',
      '\r\nX = {\r\n["a"] = 1,\r\n}',
      function (g) { return g.X.a === 1 || J(g.X); }],

    ['line comments',
      '-- header\nX = {\n-- inner\n["a"] = 1,\n}',
      function (g) { return g.X.a === 1 || J(g.X); }],

    ['long-bracket string [[...]]',
      'X = {\n["s"] = [[hello\nworld]],\n}',
      function (g) { return g.X.s === 'hello\nworld' || J(g.X); }],

    ['long-bracket string with level, [==[...]==]',
      'X = {\n["s"] = [==[a]]b]==],\n}',
      function (g) { return g.X.s === 'a]]b' || J(g.X); }],

    ['backslash-newline continuation inside a string (ElvUI.lua)',
      'X = {\n["s"] = "one\\\ntwo",\n}',
      function (g) { return g.X.s === 'one\ntwo' || J(g.X); }],

    ['unparseable statement is skipped, parsing continues',
      'local addon = select(2, ...)\nX = {\n["a"] = 1,\n}',
      function (g, sk) {
        return (g.X && g.X.a === 1 && sk.length === 1) || J({ g: g, skipped: sk });
      }],

    ['nesting depth 10 with bare identifier keys',
      'X = {a={b={c={d={e={f={g={h={i={j=1}}}}}}}}}}',
      function (g) { return g.X.a.b.c.d.e.f.g.h.i.j === 1 || J(g.X); }],

    ['key names that repeat at different depths stay distinct',
      'X = {\n["info"] = {\n["name"] = "影歌",\n["level"] = 80,\n' +
      '["race"] = {\n["name"] = "暗夜精灵",\n},\n' +
      '["ilvl"] = {\n["level"] = 288.125,\n},\n},\n}',
      function (g) {
        return (g.X.info.name === '影歌' &&
                g.X.info.race.name === '暗夜精灵' &&
                g.X.info.level === 80 &&
                g.X.info.ilvl.level === 288.125) || J(g.X);
      }],

    ['table with `;` separators instead of `,`',
      'X = {\n1;\n2;\n}',
      function (g) { return J(g.X) === '[1,2]' || J(g.X); }],

    ['hex number literal',
      'X = {\n["a"] = 0xFF,\n}',
      function (g) { return g.X.a === 255 || J(g.X); }],

    // skillLineIDs are large sparse integers. If they ever collapsed into an
    // array the profession lookup would silently read the wrong entries.
    ['BagSync profession table keeps sparse int keys as an object',
      'BagSyncDB = {\n["白银之手"] = {\n["沈怡"] = {\n' +
      '["guid"] = "Player-707-06692A3F",\n["professions"] = {\n' +
      '[773] = {\n["name"] = "铭文",\n["recipeCount"] = 99,\n["categories"] = {\n' +
      '[1912] = {\n["name"] = "卡兹阿加工艺图",\n["orderIndex"] = 1,\n' +
      '["skillLineCurrentLevel"] = 100,\n["skillLineMaxLevel"] = 100,\n},\n},\n},\n},\n},\n},\n}',
      function (g) {
        var c = g.BagSyncDB['白银之手']['沈怡'];
        var p = c.professions['773'];
        return (!Array.isArray(c.professions) &&
                !Array.isArray(p.categories) &&
                p.name === '铭文' &&
                p.categories['1912'].orderIndex === 1 &&
                p.categories['1912'].skillLineCurrentLevel === 100) || J(g.BagSyncDB);
      }],

    // BagSync stores its own settings in the same table as the realms. Their
    // trailing § is what model.js filters on, so it has to survive parsing.
    ['BagSync pseudo-realm keys keep their § suffix',
      'BagSyncDB = {\n["options§"] = {\n["enableBagSync"] = true,\n},\n' +
      '["warband§"] = {\n},\n}',
      function (g) {
        var keys = Object.keys(g.BagSyncDB).sort();
        return (keys.length === 2 && keys[0] === 'options§' && keys[1] === 'warband§') || J(keys);
      }]
  ];

  /**
   * Run every case. Returns {pass, fail, results:[{name, ok, detail}]}.
   */
  AE.runParserTests = function () {
    var results = [], pass = 0, fail = 0;
    for (var i = 0; i < CASES.length; i++) {
      var name = CASES[i][0], src = CASES[i][1], check = CASES[i][2];
      var ok = false, detail = '';
      try {
        var r = AE.parseLuaGlobals(src);
        var verdict = check(r.globals, r.skipped);
        if (verdict === true) { ok = true; }
        else { detail = 'got ' + verdict; }
      } catch (e) {
        detail = 'threw: ' + String(e.message).split('\n')[0];
      }
      if (ok) pass++; else fail++;
      results.push({ name: name, ok: ok, detail: detail });
    }
    return { pass: pass, fail: fail, results: results };
  };

  AE.parserTestCount = CASES.length;

})(typeof window !== 'undefined' ? window : globalThis);
