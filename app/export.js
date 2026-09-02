/*
 * WowAltBoard - app/export.js
 *
 * Excel and CSV export of whatever the table is currently showing.
 *
 * The .xlsx is written by hand. An xlsx is a ZIP of XML parts, and the ZIP
 * format permits STORED (uncompressed) entries -- so all this needs is CRC32
 * plus the local/central directory records, no deflate and no library. That
 * keeps the folder dependency-free, which is the whole point of this tool.
 * Files come out ~3x larger than a compressed xlsx; at a few hundred rows that
 * is tens of KB, so it does not matter.
 *
 * Text is written as inline strings (no shared string table) -- simpler, and
 * Excel accepts it. Numbers are written as numbers so sorting and formulas work
 * on the result, which is the main reason to want Excel over a screenshot.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};

  // ------------------------------------------------------------------- CRC32

  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ -1) >>> 0;
  }

  function utf8(str) {
    // TextEncoder is available in every browser that can run this page.
    return new TextEncoder().encode(str);
  }

  // --------------------------------------------------------------- ZIP writer

  function zip(entries) {
    var chunks = [];
    var central = [];
    var offset = 0;

    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

    entries.forEach(function (e) {
      var nameBytes = utf8(e.name);
      var data = e.data;
      var crc = crc32(data);

      var local = [].concat(
        u32(0x04034b50),
        u16(20),          // version needed
        u16(0x0800),      // flags: UTF-8 filenames
        u16(0),           // method 0 = stored
        u16(0), u16(0),   // dos time/date (zero is legal)
        u32(crc),
        u32(data.length), // compressed size == uncompressed size
        u32(data.length),
        u16(nameBytes.length),
        u16(0)
      );
      chunks.push(new Uint8Array(local), nameBytes, data);

      central.push({
        name: nameBytes,
        crc: crc,
        size: data.length,
        offset: offset
      });
      offset += local.length + nameBytes.length + data.length;
    });

    var centralStart = offset;
    var centralSize = 0;
    central.forEach(function (c) {
      var rec = [].concat(
        u32(0x02014b50),
        u16(20), u16(20),
        u16(0x0800),
        u16(0),
        u16(0), u16(0),
        u32(c.crc),
        u32(c.size), u32(c.size),
        u16(c.name.length),
        u16(0), u16(0),
        u16(0), u16(0),
        u32(0),
        u32(c.offset)
      );
      chunks.push(new Uint8Array(rec), c.name);
      centralSize += rec.length + c.name.length;
    });

    chunks.push(new Uint8Array([].concat(
      u32(0x06054b50),
      u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(centralSize),
      u32(centralStart),
      u16(0)
    )));

    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // --------------------------------------------------------------- xlsx parts

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Control characters are illegal in XML 1.0 and Excel rejects the file.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - m) / 26);
    }
    return s;
  }

  /**
   * @param {string[]} headers
   * @param {Array<Array<{v:*, num:boolean}>>} rows
   * @param {string} sheetName
   */
  function sheetXml(headers, rows) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');

    // ELEMENT ORDER IS PART OF THE SCHEMA. CT_Worksheet requires
    // sheetViews -> cols -> sheetData -> autoFilter; emitting <cols> first makes
    // Excel declare the whole workbook corrupt.
    out.push('<sheetViews><sheetView workbookViewId="0">');
    // Freeze the header row and the character-name column.
    out.push('<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>');
    out.push('</sheetView></sheetViews>');

    var widths = headers.map(function (h) {
      // Rough: CJK glyphs are about twice as wide as Excel's default character.
      var w = 0;
      String(h).split('').forEach(function (c) { w += /[一-鿿]/.test(c) ? 2 : 1; });
      return Math.min(40, Math.max(8, w + 3));
    });
    out.push('<cols>');
    widths.forEach(function (w, i) {
      out.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
    });
    out.push('</cols>');

    out.push('<sheetData>');
    out.push('<row r="1">');
    headers.forEach(function (h, i) {
      out.push('<c r="' + colName(i + 1) + '1" t="inlineStr" s="1"><is><t>' +
               xmlEscape(h) + '</t></is></c>');
    });
    out.push('</row>');

    rows.forEach(function (row, ri) {
      var r = ri + 2;
      out.push('<row r="' + r + '">');
      row.forEach(function (cell, ci) {
        var ref = colName(ci + 1) + r;
        if (cell == null || cell.v === '' || cell.v == null) return;
        if (cell.num) {
          out.push('<c r="' + ref + '"><v>' + cell.v + '</v></c>');
        } else {
          out.push('<c r="' + ref + '" t="inlineStr"><is><t>' +
                   xmlEscape(cell.v) + '</t></is></c>');
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');

    out.push('<autoFilter ref="A1:' + colName(headers.length) + (rows.length + 1) + '"/>');
    out.push('</worksheet>');
    return out.join('');
  }

  function buildXlsx(sheetName, headers, rows) {
    var parts = [];

    parts.push({
      name: '[Content_Types].xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>')
    });

    parts.push({
      name: '_rels/.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>')
    });

    parts.push({
      name: 'xl/workbook.xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + xmlEscape(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
        '</workbook>')
    });

    parts.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>')
    });

    // Two styles: default, and a bold header.
    parts.push({
      name: 'xl/styles.xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '</cellXfs>' +
        // Without a named "Normal" style, strict readers warn about a missing
        // default style. Excel tolerates its absence; this makes it clean.
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>')
    });

    parts.push({
      name: 'xl/worksheets/sheet1.xml',
      data: utf8(sheetXml(headers, rows))
    });

    return zip(parts);
  }

  // ----------------------------------------------------------- table snapshot

  /**
   * Snapshot the visible columns x visible rows, in the order shown on screen.
   * Exporting what is on screen (not everything) is the point: the user has
   * already curated the view with the settings panel.
   */
  function snapshot() {
    var st = AE.state;
    var s = st.settings;
    var ctx = st.ctx;

    var cols = st.columns.filter(function (c) {
      return !s.hiddenGroups[c.group] && !s.hiddenColumns[c.id];
    });

    var headers = cols.map(function (c) {
      var group = '';
      for (var i = 0; i < AE.GROUPS.length; i++) {
        if (AE.GROUPS[i].id === c.group) group = AE.GROUPS[i].label;
      }
      var label = AE.colLabel(c, ctx);
      // Prefix the group so a 60-column sheet is still readable out of context.
      return c.group === 'base' ? label : group + ' · ' + label;
    });

    // Read the rows in their current on-screen order.
    var trs = document.querySelectorAll('#tbody tr');
    var byGuidKey = {};
    st.rows.forEach(function (r) { byGuidKey[r.tr.getAttribute('data-rowkey')] = r.ch; });

    var rows = [];
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].style.display === 'none') continue;
      var ch = byGuidKey[trs[i].getAttribute('data-rowkey')];
      if (!ch) continue;
      rows.push(cols.map(function (c) {
        return exportCell(c, ch, ctx);
      }));
    }

    return { headers: headers, rows: rows, cols: cols };
  }

  /**
   * Export value for one cell.
   *
   * Deliberately does NOT reuse the DOM renderer's text: on screen a cell may be
   * "11 341" (level plus score packed together) or a coloured bar, neither of
   * which is useful in a spreadsheet. Numeric columns are emitted as real
   * numbers so Excel can sort and chart them.
   */
  function exportCell(col, ch, ctx) {
    var L = AE.Labels;

    if (col.isDungeon) {
      var d = ch.mp.byDungeon[col.cmID];
      if (!d || (!d.level && !d.rating)) return { v: '', num: false };
      return { v: d.rating, num: true };
    }

    if (col.currencyId) {
      var c = ch.currencies.byId[col.currencyId];
      return c ? { v: c.quantity, num: true } : { v: '', num: false };
    }

    // Professions. The slot columns carry a name, so they export as text like
    // "铭文 100"; the secondaries are a bare level and export as a number.
    if (col.professionSlot != null) {
      var ps = ch.professions && ch.professions.primary[col.professionSlot];
      if (!ps) return { v: '', num: false };
      return { v: ps.cur != null ? (ps.name + ' ' + ps.cur) : ps.name, num: false };
    }

    if (col.professionId) {
      var sec = ch.professions && ch.professions.secondary[col.professionId];
      return (sec && sec.cur != null) ? { v: sec.cur, num: true } : { v: '', num: false };
    }

    switch (col.id) {
      case 'name':       return { v: ch.name, num: false };
      case 'realm':      return { v: ch.realm, num: false };
      case 'source':     return { v: ctx.settings.sourceAliases[ch.sourceId] || ch.sourceName, num: false };
      case 'faction':    return { v: ch.faction, num: false };
      case 'level':      return { v: ch.level, num: true };
      case 'ilvl':       return ch.ilvl.value ? { v: Math.ceil(ch.ilvl.value), num: true } : { v: '', num: false };
      case 'guild':      return { v: ch.guildName, num: false };
      case 'class':      return { v: ch.className, num: false };
      case 'race':       return { v: ch.raceName, num: false };
      case 'armor':      return { v: ch.armorType, num: false };
      case 'lastUpdate': return ch.lastUpdate
        ? { v: new Date(ch.lastUpdate * 1000).toLocaleString(), num: false }
        : { v: '', num: false };

      case 'mpRating':   return ch.mp.rating ? { v: ch.mp.rating, num: true } : { v: '', num: false };
      case 'mpBest':     return ch.mp.bestSeasonScore ? { v: ch.mp.bestSeasonScore, num: true } : { v: '', num: false };
      case 'mpKeystone': {
        var ks = ch.mp.keystone;
        if (!ks) return { v: '', num: false };
        var meta = ctx.model.tables.dungeonById[ks.cmID];
        return {
          v: '+' + ks.level + ' ' + L.dungeonLabel(ks.cmID, meta,
             ctx.settings.dungeonNameOverrides, ctx.model.dungeonNames),
          num: false
        };
      }
      // The number the cell shows, which is the Mythic+ count -- exporting
      // .total instead would put a 5 in the spreadsheet next to a 4 on screen.
      case 'mpRuns':     return ch.mp.runsThisWeek.total ? { v: ch.mp.runsThisWeek.mythicPlus, num: true } : { v: '', num: false };

      case 'delveTier':  return ch.delves.maxTier ? { v: ch.delves.maxTier, num: true } : { v: '', num: false };
      case 'delvePoints':return ch.delves.points ? { v: ch.delves.points, num: true } : { v: '', num: false };
      case 'mapBag':     return ch.treasureMap ? { v: ch.treasureMap.bagCount, num: true } : { v: '', num: false };
      case 'mapUsed':    return ch.treasureMap ? { v: ch.treasureMap.used ? '已用' : '未用', num: false } : { v: '', num: false };
      case 'mapBuff':    return ch.treasureMap ? { v: ch.treasureMap.hasBuff ? '生效中' : '无', num: false } : { v: '', num: false };

      case 'prey':       return ch.prey.seen ? { v: ch.prey.done, num: true } : { v: '', num: false };
      case 'gold':       return ch.money ? { v: ch.gold, num: true } : { v: '', num: false };
    }

    if (col.id.indexOf('vault:') === 0) {
      var type = Number(col.id.slice(6));
      var vs = AE.vaultSummary(ch, type);
      return vs ? { v: vs.unlocked, num: true } : { v: '', num: false };
    }

    if (col.id.indexOf('raid:') === 0) {
      var r = ch.raids.byKey[col.id.slice(5)];
      // **过期残留要和格子一样过滤掉。** 存档里的锁定快照只在角色上线时更新，
      // 所以上个周期的 8/8 会一直躺在里面；app/columns.js 那边画格子时有
      // `if (!r || !r.active) return dash(td)`，这里原来没有 —— 界面上是「·」，
      // 导出的 Excel / CSV 里却是个真数字。而导出正是拿去核对「哪个号本周还没
      // 清本」的地方，看不到界面可以对照，错得更贵。
      return r && r.active ? { v: r.progress, num: true } : { v: '', num: false };
    }

    if (col.id.indexOf('prey:') === 0) {
      var pd = ch.prey.byDifficulty[col.id.slice(5)];
      return pd ? { v: pd.done, num: true } : { v: '', num: false };
    }

    return { v: '', num: false };
  }

  // ------------------------------------------------------------------ public

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /**
   * Tell the user where the file went.
   *
   * A download from a file:// page lands in the browser's download folder and
   * nothing on the page can open it -- file:// navigation from a file:// page is
   * blocked and there is no "reveal in folder" API. So the toast shows the full
   * path (scan.ps1 resolves it from the shell folder registry) and offers to copy
   * it, which is the most that can honestly be done from here.
   */
  function exportedToast(filename, rows, cols) {
    var dir = (AE.state && AE.state.model && AE.state.model.downloadsDir) || '';
    var full = dir ? (dir.replace(/[\\/]+$/, '') + '\\' + filename) : filename;
    AE.toast({
      title: '已导出 ' + filename,
      body: (dir ? full : '在浏览器的下载文件夹里') + '　·　' + rows + ' 行 × ' + cols + ' 列',
      kind: 'good',
      ms: 3000,
      actions: [{
        label: '复制路径',
        onClick: function () { AE.copyWithToast(full, filename); },
        keepOpen: true
      }]
    });
  }

  function nothingToExport() {
    AE.toast({
      title: '没有可导出的内容',
      body: '当前筛选下一行都没有显示。',
      kind: 'bad',
      ms: 3000
    });
  }

  AE.exportXlsx = function () {
    var snap = snapshot();
    if (!snap.rows.length) { nothingToExport(); return; }
    var blob = buildXlsx('AlterEgo', snap.headers, snap.rows);
    var url = URL.createObjectURL(blob);
    var name = 'AlterEgo-' + stamp() + '.xlsx';
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    exportedToast(name, snap.rows.length, snap.headers.length);
  };

  AE.exportCsv = function () {
    var snap = snapshot();
    if (!snap.rows.length) { nothingToExport(); return; }
    function q(v) {
      var s = (v == null) ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [snap.headers.map(q).join(',')];
    snap.rows.forEach(function (row) {
      lines.push(row.map(function (c) { return q(c ? c.v : ''); }).join(','));
    });
    var name = 'AlterEgo-' + stamp() + '.csv';
    // The BOM is what makes Excel open a UTF-8 CSV without mojibaking the
    // Chinese; without it Excel assumes the system codepage.
    AE.downloadText(name, '﻿' + lines.join('\r\n'), 'text/csv');
    exportedToast(name, snap.rows.length, snap.headers.length);
  };

  AE.exportSnapshot = snapshot;  // Exposed so tests.html can exercise the writer without a rendered table.
  AE.buildXlsxBlob = buildXlsx;
  AE.xlsxSheetXmlForTest = sheetXml;
  // 单个格子也导出来。snapshot() 要一张**已经渲染好**的表（它读 #tbody tr 的
  // 顺序），而「导出的这一格和界面上那一格是不是同一个意思」这件事不需要整张表。
  // 第 20 轮真踩过：团本列的过期锁定在格子里被过滤成「·」，在导出里是个真数字。
  AE.exportCellForTest = exportCell;

})(typeof window !== 'undefined' ? window : globalThis);
