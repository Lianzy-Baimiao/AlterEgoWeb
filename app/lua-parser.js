/*
 * WowAltBoard - app/lua-parser.js
 *
 * A real tokenizer + recursive-descent parser for WoW SavedVariables Lua.
 *
 * WHY NOT REGEX: key names repeat at different depths in this data. "name" is
 * info.name, info.race.name, info.class.name, info.guild.name AND
 * raids.savedInstances[].name. "level" is the character level, the (float) item
 * level, a keystone level AND a raid difficulty id depending on where it sits.
 * "rating" is both mythicplus.rating and a per-dungeon score. A flat scrape
 * silently returns the wrong field -- verified the hard way during research.
 *
 * WHY NOT LINE-BASED: AlterEgo.lua has ZERO indentation. All 10,000+ lines start
 * at column 0, so visual nesting carries no information whatsoever.
 *
 * Table representation:
 *   - keys exactly 1..n (contiguous, no gaps) -> JS Array
 *   - anything else                           -> plain object with String keys
 *   - empty table                             -> [] (use AE.asArray/asMap to
 *                                                normalize; empty is ambiguous
 *                                                between array and map in Lua)
 *
 * NOTE: classic script, global namespace, no ES modules. ES modules are fetched
 * with CORS semantics and are hard-blocked on file:// -- see index.html header.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};

  // ---------------------------------------------------------------- charclass
  function isDigit(c)      { return c >= 48 && c <= 57; }                 // 0-9
  function isHexDigit(c)   { return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); }
  function isNameStart(c)  { return c === 95 || (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
  function isNameChar(c)   { return isNameStart(c) || isDigit(c); }
  function isSpace(c)      { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }

  var SHORT_ESCAPES = {
    97: '\x07',  // \a bell
    98: '\b',    // \b
    102: '\f',   // \f
    110: '\n',   // \n
    114: '\r',   // \r
    116: '\t',   // \t
    118: '\v',   // \v
    92: '\\',    // \\
    34: '"',     // \"
    39: "'",     // \'
    10: '\n'     // backslash-newline -> literal newline (real, seen in ElvUI)
  };

  // ------------------------------------------------------------------- parser
  function Parser(text) {
    this.s = text;
    this.i = 0;
    this.n = text.length;
  }

  Parser.prototype.err = function (msg) {
    // Give a locatable message: line number plus a short window of context.
    var upto = this.s.slice(0, this.i);
    var line = 1;
    for (var k = 0; k < upto.length; k++) { if (upto.charCodeAt(k) === 10) line++; }
    var ctx = this.s.slice(Math.max(0, this.i - 40), this.i + 40).replace(/[\r\n]/g, '↵');
    var e = new Error('Lua parse error at line ' + line + ' (offset ' + this.i + '): ' + msg +
                      '\n  near: ' + ctx);
    e.luaOffset = this.i;
    e.luaLine = line;
    throw e;
  };

  Parser.prototype.peek = function () { return this.i < this.n ? this.s.charCodeAt(this.i) : -1; };
  Parser.prototype.at   = function (k) { var j = this.i + k; return j < this.n ? this.s.charCodeAt(j) : -1; };

  // Skip whitespace and comments (line and long-bracket block).
  Parser.prototype.skipTrivia = function () {
    var s = this.s;
    for (;;) {
      while (this.i < this.n && isSpace(s.charCodeAt(this.i))) this.i++;
      // comment?
      if (this.i + 1 < this.n && s.charCodeAt(this.i) === 45 && s.charCodeAt(this.i + 1) === 45) {
        this.i += 2;
        // --[[ ... ]] or --[==[ ... ]==]  (WoW writes `nil --[[ skipped inline function ]]`)
        var lvl = this.longBracketLevel();
        if (lvl >= 0) { this.readLongBracket(lvl); continue; }
        while (this.i < this.n && s.charCodeAt(this.i) !== 10) this.i++;
        continue;
      }
      return;
    }
  };

  // If positioned at `[`, `[=`, `[==` ... followed by `[`, return the level.
  // Otherwise return -1 and leave the position untouched.
  Parser.prototype.longBracketLevel = function () {
    if (this.peek() !== 91) return -1;              // '['
    var j = this.i + 1, lvl = 0;
    while (j < this.n && this.s.charCodeAt(j) === 61) { lvl++; j++; }  // '='
    if (j < this.n && this.s.charCodeAt(j) === 91) return lvl;
    return -1;
  };

  Parser.prototype.readLongBracket = function (lvl) {
    this.i += 2 + lvl;                              // past  [==[
    // Lua skips a single immediately-following newline.
    if (this.peek() === 13) this.i++;
    if (this.peek() === 10) this.i++;
    var close = ']' + new Array(lvl + 1).join('=') + ']';
    var end = this.s.indexOf(close, this.i);
    if (end < 0) { this.i = this.n; return this.s.slice(this.i); }
    var out = this.s.slice(this.i, end);
    this.i = end + close.length;
    return out;
  };

  Parser.prototype.readShortString = function () {
    var quote = this.peek();
    this.i++;
    var out = '';
    var s = this.s;
    var chunkStart = this.i;
    for (;;) {
      if (this.i >= this.n) { this.err('unterminated string'); }
      var c = s.charCodeAt(this.i);
      if (c === quote) {
        out += s.slice(chunkStart, this.i);
        this.i++;
        return out;
      }
      if (c === 92) {                               // backslash
        out += s.slice(chunkStart, this.i);
        this.i++;
        out += this.readEscape();
        chunkStart = this.i;
        continue;
      }
      // Unescaped newline is illegal in Lua short strings, but WoW data has
      // never contained one and being strict here would only cause spurious
      // failures on third-party addon files. Accept it.
      this.i++;
    }
  };

  Parser.prototype.readEscape = function () {
    var c = this.peek();
    if (c < 0) this.err('unterminated escape');

    // \ddd  -- up to three decimal digits (this is how WoW writes \000)
    if (isDigit(c)) {
      var num = 0, cnt = 0;
      while (cnt < 3 && isDigit(this.peek())) { num = num * 10 + (this.peek() - 48); this.i++; cnt++; }
      return String.fromCharCode(num & 0xff);
    }
    // \xXX
    if (c === 120) {
      this.i++;
      var hex = '';
      while (hex.length < 2 && isHexDigit(this.peek())) { hex += this.s[this.i]; this.i++; }
      return String.fromCharCode(parseInt(hex || '0', 16));
    }
    // \u{XXXX}
    if (c === 117 && this.at(1) === 123) {
      this.i += 2;
      var h = '';
      while (isHexDigit(this.peek())) { h += this.s[this.i]; this.i++; }
      if (this.peek() === 125) this.i++;
      var cp = parseInt(h || '0', 16);
      try { return String.fromCodePoint(cp); } catch (e) { return '�'; }
    }
    // \z  -- skip following whitespace
    if (c === 122) {
      this.i++;
      while (this.i < this.n && isSpace(this.s.charCodeAt(this.i))) this.i++;
      return '';
    }
    var simple = SHORT_ESCAPES[c];
    if (simple !== undefined) { this.i++; return simple; }
    // Unknown escape: keep the character verbatim rather than failing.
    this.i++;
    return String.fromCharCode(c);
  };

  Parser.prototype.readNumber = function () {
    var start = this.i;
    if (this.peek() === 45 || this.peek() === 43) this.i++;              // sign
    if (this.peek() === 48 && (this.at(1) === 120 || this.at(1) === 88)) { // 0x
      this.i += 2;
      while (isHexDigit(this.peek()) || this.peek() === 46) this.i++;
      // hex float exponent p+N
      if (this.peek() === 112 || this.peek() === 80) {
        this.i++;
        if (this.peek() === 43 || this.peek() === 45) this.i++;
        while (isDigit(this.peek())) this.i++;
      }
      return Number(this.s.slice(start, this.i));
    }
    while (isDigit(this.peek())) this.i++;
    if (this.peek() === 46) { this.i++; while (isDigit(this.peek())) this.i++; }
    if (this.peek() === 101 || this.peek() === 69) {                     // e/E
      var save = this.i;
      this.i++;
      if (this.peek() === 43 || this.peek() === 45) this.i++;
      if (isDigit(this.peek())) { while (isDigit(this.peek())) this.i++; }
      else { this.i = save; }
    }
    var raw = this.s.slice(start, this.i);
    if (raw === '' || raw === '-' || raw === '+') this.err('malformed number');
    return Number(raw);
  };

  Parser.prototype.readName = function () {
    var start = this.i;
    if (!isNameStart(this.peek())) this.err('expected a name');
    this.i++;
    while (isNameChar(this.peek())) this.i++;
    return this.s.slice(start, this.i);
  };

  // Foo, Foo.bar, Foo.bar.baz  (also tolerates Foo:baz)
  Parser.prototype.readDottedName = function () {
    var name = this.readName();
    for (;;) {
      var save = this.i;
      this.skipTrivia();
      if (this.peek() === 46 || this.peek() === 58) {                    // . or :
        this.i++;
        this.skipTrivia();
        if (!isNameStart(this.peek())) { this.i = save; return name; }
        name += '.' + this.readName();
        continue;
      }
      this.i = save;
      return name;
    }
  };

  Parser.prototype.parseValue = function () {
    this.skipTrivia();
    var c = this.peek();
    if (c < 0) this.err('unexpected end of input');

    if (c === 123) return this.parseTable();                             // {
    if (c === 34 || c === 39) return this.readShortString();             // " '
    var lvl = this.longBracketLevel();
    if (lvl >= 0) return this.readLongBracket(lvl);                      // [[ ]]
    if (isDigit(c)) return this.readNumber();
    if (c === 46 && isDigit(this.at(1))) return this.readNumber();       // .5
    if (c === 45 || c === 43) {                                         // -1  +1
      if (isDigit(this.at(1)) || (this.at(1) === 46 && isDigit(this.at(2)))) return this.readNumber();
      // unary minus on a name: -math.huge
      if (c === 45 && isNameStart(this.at(1))) {
        this.i++;
        var inner = this.parseValue();
        if (typeof inner === 'number') return -inner;
        return { __expr: '-' + JSON.stringify(inner) };
      }
      this.err('unexpected "' + this.s[this.i] + '"');
    }
    if (isNameStart(c)) {
      // IMPORTANT: keywords must be tested BEFORE the identifier branch.
      // `{ true, }` is real data (global.prey.hiddenDifficulties) and an
      // identifier-first parser swallows it.
      var save = this.i;
      var word = this.readName();
      if (word === 'true')  return true;
      if (word === 'false') return false;
      if (word === 'nil')   return null;
      if (word === 'inf')   return Infinity;
      if (word === 'nan')   return NaN;
      this.i = save;
      return this.parseSymbol();
    }
    this.err('unexpected "' + this.s[this.i] + '"');
  };

  // A bare identifier used as a value: `RAIDS`, `Enum.Foo.Bar`, `select(2, ...)`.
  // Only appears in the addon's own Data/*.lua, never in SavedVariables. We
  // record it rather than failing, so consumers can ignore it.
  Parser.prototype.parseSymbol = function () {
    var name = this.readDottedName();
    var save = this.i;
    this.skipTrivia();
    if (this.peek() === 40) {                                           // call
      var depth = 0;
      var start = this.i;
      while (this.i < this.n) {
        var c = this.s.charCodeAt(this.i);
        if (c === 34 || c === 39) { this.readShortString(); continue; }
        if (c === 40) depth++;
        else if (c === 41) { depth--; this.i++; if (depth === 0) break; continue; }
        this.i++;
      }
      return { __call: name + this.s.slice(start, this.i) };
    }
    this.i = save;
    return { __sym: name };
  };

  Parser.prototype.parseTable = function () {
    this.i++;                                                           // past {
    var entries = [];
    var autoIndex = 0;
    var sawExplicit = false;

    for (;;) {
      this.skipTrivia();
      var c = this.peek();
      if (c < 0) this.err('unterminated table');
      if (c === 125) { this.i++; break; }                               // }

      // [key] = value  -- but NOT a long-bracket string, which also starts '['
      if (c === 91 && this.longBracketLevel() < 0) {
        this.i++;
        var key = this.parseValue();
        this.skipTrivia();
        if (this.peek() !== 93) this.err('expected "]" after table key');
        this.i++;
        this.skipTrivia();
        if (this.peek() !== 61) this.err('expected "=" after table key');
        this.i++;
        entries.push({ k: normalizeKey(key), v: this.parseValue() });
        sawExplicit = true;
      } else {
        // bare-identifier key?  `seasonID = 18` in the addon's Data tables.
        var handled = false;
        if (isNameStart(c)) {
          var save = this.i;
          var word = this.readName();
          var afterWord = this.i;
          this.skipTrivia();
          // '=' but not '==' (which would make it a comparison, i.e. a value)
          if (this.peek() === 61 && this.at(1) !== 61) {
            this.i++;
            entries.push({ k: word, v: this.parseValue() });
            sawExplicit = true;
            handled = true;
          } else {
            this.i = save;
            void afterWord;
          }
        }
        if (!handled) {
          entries.push({ k: ++autoIndex, v: this.parseValue() });
        }
      }

      this.skipTrivia();
      var sep = this.peek();
      if (sep === 44 || sep === 59) { this.i++; continue; }             // , ;
      if (sep === 125) { this.i++; break; }                             // }
      this.err('expected "," or "}" in table');
    }

    return finalizeTable(entries, sawExplicit);
  };

  function normalizeKey(key) {
    if (typeof key === 'number') return key;
    if (typeof key === 'string') return key;
    if (typeof key === 'boolean') return key ? 'true' : 'false';
    if (key === null) return 'nil';
    return String(key);
  }

  function finalizeTable(entries, sawExplicit) {
    if (entries.length === 0) return [];

    if (!sawExplicit) {
      // Pure positional: keys are 1..n by construction.
      var arr = new Array(entries.length);
      for (var i = 0; i < entries.length; i++) arr[i] = entries[i].v;
      return arr;
    }

    // Mixed or keyed. Collapse to an array only when the keys are exactly 1..n.
    var allInt = true, max = 0, count = 0, seen = Object.create(null);
    for (var j = 0; j < entries.length; j++) {
      var k = entries[j].k;
      if (typeof k !== 'number' || k < 1 || Math.floor(k) !== k || seen[k]) { allInt = false; break; }
      seen[k] = true;
      count++;
      if (k > max) max = k;
    }
    if (allInt && count === entries.length && max === entries.length) {
      var out = new Array(max);
      for (var m = 0; m < entries.length; m++) out[entries[m].k - 1] = entries[m].v;
      return out;
    }

    var obj = {};
    for (var p = 0; p < entries.length; p++) obj[String(entries[p].k)] = entries[p].v;
    return obj;
  }

  // ------------------------------------------------------------- public entry
  /**
   * Parse a SavedVariables file: a sequence of `Name = value` statements.
   * Statements it cannot understand (e.g. `local x = require(...)`) are skipped
   * line-by-line rather than aborting the whole file.
   *
   * @returns {{globals: Object, skipped: string[]}}
   */
  AE.parseLuaGlobals = function (text) {
    var p = new Parser(text);
    var globals = {};
    var skipped = [];
    var guard = 0;

    for (;;) {
      if (++guard > 500000) break;
      p.skipTrivia();
      if (p.i >= p.n) break;

      var stmtStart = p.i;
      var ok = false;
      try {
        if (isNameStart(p.peek())) {
          var name = p.readDottedName();
          p.skipTrivia();
          if (p.peek() === 61 && p.at(1) !== 61) {
            p.i++;
            globals[name] = p.parseValue();
            ok = true;
          }
        }
      } catch (e) {
        // fall through to resync
      }

      if (!ok) {
        p.i = stmtStart;
        var eol = text.indexOf('\n', p.i);
        skipped.push(text.slice(p.i, eol < 0 ? Math.min(p.n, p.i + 120) : eol).trim());
        p.i = eol < 0 ? p.n : eol + 1;
      }
    }

    return { globals: globals, skipped: skipped };
  };

  /**
   * Pull one assignment out of a Lua source file without parsing the rest of it.
   * Used for the addon's own Data/*.lua lookup tables, which are real code
   * (locals, annotations, function calls) wrapped around the tables we want.
   *
   * @param {string} text  Lua source
   * @param {string} name  e.g. "Data.dungeons"
   * @returns {*} the parsed value, or undefined if not found
   */
  AE.extractLuaAssignment = function (text, name) {
    var from = 0;
    for (;;) {
      var at = text.indexOf(name, from);
      if (at < 0) return undefined;
      from = at + name.length;

      // Must not be part of a longer identifier or a different path.
      var before = at > 0 ? text.charCodeAt(at - 1) : -1;
      if (before >= 0 && (isNameChar(before) || before === 46)) continue;   // '.'
      var afterCode = text.charCodeAt(from);
      if (isNameChar(afterCode)) continue;

      var p = new Parser(text);
      p.i = from;
      try {
        p.skipTrivia();
        if (p.peek() !== 61 || p.at(1) === 61) continue;                     // need a plain '='
        p.i++;
        return p.parseValue();
      } catch (e) {
        continue;
      }
    }
  };

  // ----------------------------------------------------------------- helpers
  // An empty Lua table is ambiguous between array and map, and AlterEgo wipes
  // sub-tables to {} on weekly reset instead of removing them. These normalize
  // so callers never have to care.

  /** Anything -> array of values. */
  AE.asArray = function (v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v !== 'object') return [];
    var out = [];
    for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) out.push(v[k]); }
    return out;
  };

  /** Anything -> plain object keyed by string. */
  AE.asMap = function (v) {
    if (v == null) return {};
    if (Array.isArray(v)) {
      var o = {};
      for (var i = 0; i < v.length; i++) o[String(i + 1)] = v[i];
      return o;
    }
    if (typeof v !== 'object') return {};
    return v;
  };

  /** Number of entries in a parsed Lua table. */
  AE.tableSize = function (v) {
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v !== 'object') return 0;
    return Object.keys(v).length;
  };

  /** True when a parsed table has no entries. */
  AE.isEmptyTable = function (v) { return AE.tableSize(v) === 0; };

})(typeof window !== 'undefined' ? window : globalThis);
