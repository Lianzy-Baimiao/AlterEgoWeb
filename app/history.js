/*
 * AlterEgoWeb - app/history.js
 *
 * The weekly trend view. Snapshots are stored as raw Lua (so the same parser
 * serves both views) and are loaded ONLY when this view is first opened -- at
 * ~0.5 MB per week, eagerly loading a year of them would make the page slow to
 * open for a feature most visits never use.
 *
 * The reason this feature has to exist: AlterEgo stores only the CURRENT state.
 * "How many treasure maps did I get and use each week" is not in the saved data
 * at all, and can only be reconstructed by comparing snapshots over time. The
 * first run therefore shows a single week; the view fills in as weeks pass.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var L = AE.Labels;
  var doc = global.document;

  var loaded = false;
  var loading = false;
  var weeks = [];       // [{week, label, characters: {key: distilled}}]

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * Load the snapshot scripts in manifest order.
   *
   * script.async = false is MANDATORY. Dynamically inserted scripts default to
   * async, which means they execute in completion order, not insertion order --
   * and every snapshot does AE_HISTORY.push(), so async ordering would scramble
   * the weekly sequence and silently corrupt every delta.
   */
  function loadSnapshots(done) {
    var manifest = (global.AE_MANIFEST && global.AE_MANIFEST.history) || [];
    if (!manifest.length) { done([]); return; }

    global.AE_HISTORY = [];
    var remaining = manifest.length;
    var failed = [];

    manifest.forEach(function (entry) {
      var s = doc.createElement('script');
      s.src = 'data/' + entry.file;
      s.async = false;
      s.charset = 'utf-8';
      s.onload = function () { if (--remaining === 0) done(failed); };
      s.onerror = function () {
        // onerror does fire for a missing file:// script, so a manifest entry
        // whose file was deleted is a real, handleable case.
        failed.push(entry.file);
        if (--remaining === 0) done(failed);
      };
      doc.head.appendChild(s);
    });
  }

  /** Reduce one snapshot to the handful of numbers a trend view needs. */
  function distill(snapshot) {
    var out = {};
    (snapshot.sources || []).forEach(function (src) {
      var db;
      try {
        db = AE.parseLuaGlobals(src.lua).globals.AlterEgoDB;
      } catch (e) { return; }
      if (!db || !db.global) return;

      var chars = AE.asMap(db.global.characters);
      Object.keys(chars).forEach(function (guid) {
        var c = chars[guid];
        if (!c || typeof c !== 'object') return;
        var info = c.info || {};
        var mp = c.mythicplus || {};
        var vault = c.vault || {};
        var ilvl = info.ilvl || {};

        var perDungeon = {};
        AE.asArray(mp.dungeons).forEach(function (d) {
          // Keyed by challengeModeID, never by position.
          if (d && d.challengeModeID != null) perDungeon[d.challengeModeID] = d.rating || 0;
        });

        var vaultUnlocked = {};
        AE.asArray(vault.slots).forEach(function (s) {
          if (!s || s.type == null) return;
          if (!vaultUnlocked[s.type]) vaultUnlocked[s.type] = 0;
          if ((s.progress || 0) >= (s.threshold || 0) && (s.threshold || 0) > 0) {
            vaultUnlocked[s.type]++;
          }
        });

        var map = null;
        AE.asArray(c.currencies).forEach(function (cur) {
          if (cur && cur.currencyType === 'delveMap') {
            map = {
              bag: cur.bagCount || 0,
              used: cur.questCompleted === true,
              buff: cur.hasBuff === true
            };
          }
        });

        var runs = mp.numCompletedDungeonRuns || {};

        out[src.id + '/' + guid] = {
          name: info.name || '?',
          realm: info.realm || '?',
          classFile: (info.class || {}).file || '',
          level: info.level || 0,
          ilvl: ilvl.level || 0,
          rating: mp.rating || 0,
          runs: (runs.mythicPlus || 0) + (runs.mythic || 0) + (runs.heroic || 0),
          perDungeon: perDungeon,
          vault: vaultUnlocked,
          map: map,
          money: c.money || 0
        };
      });
    });
    return out;
  }

  function buildWeeks(failed) {
    var manifest = (global.AE_MANIFEST && global.AE_MANIFEST.history) || [];
    var byWeek = {};
    (global.AE_HISTORY || []).forEach(function (snap) {
      byWeek[snap.week] = snap;
    });

    weeks = manifest
      .filter(function (m) { return byWeek[m.week]; })
      .sort(function (a, b) { return a.week - b.week; })
      .map(function (m) {
        return {
          week: m.week,
          label: m.label,
          characters: distill(byWeek[m.week])
        };
      });

    loaded = true;
    return failed;
  }

  // ------------------------------------------------------------------ render

  function delta(cur, prev) {
    if (prev == null || cur == null) return null;
    var d = cur - prev;
    if (!d) return null;
    return d;
  }

  function deltaSpan(d, suffix) {
    if (d == null) return null;
    var s = el('span', d > 0 ? 'delta up' : 'delta down',
               (d > 0 ? '+' : '') + d + (suffix || ''));
    return s;
  }

  function render(body, failedFiles) {
    body.innerHTML = '';

    if (failedFiles && failedFiles.length) {
      body.appendChild(el('p', 'note',
        '有 ' + failedFiles.length + ' 个快照文件读取失败：' + failedFiles.join('、')));
    }

    if (!weeks.length) {
      body.appendChild(el('p', 'note',
        '还没有历史快照。每次运行启动脚本都会按“游戏周”存一份，' +
        '所以下一次周重置之后这里才会出现第二行数据。'));
      return;
    }

    body.appendChild(el('p', 'note',
      '共 ' + weeks.length + ' 个游戏周的快照。按 WoW 周重置时间分桶，不是自然周。' +
      (weeks.length === 1 ? '目前只有本周，等下周重置后就能看到变化。' : '')));

    // Union of characters across all weeks, ordered by their latest rating.
    var keys = {};
    weeks.forEach(function (w) {
      Object.keys(w.characters).forEach(function (k) { keys[k] = true; });
    });
    var last = weeks[weeks.length - 1];
    var order = Object.keys(keys).sort(function (a, b) {
      var ra = (last.characters[a] || {}).rating || 0;
      var rb = (last.characters[b] || {}).rating || 0;
      if (ra !== rb) return rb - ra;
      var na = (last.characters[a] || {}).name || '';
      var nb = (last.characters[b] || {}).name || '';
      return String(na).localeCompare(String(nb), 'zh-Hans-CN');
    });

    var metrics = [
      { id: 'rating', label: '大秘境评分', get: function (r) { return r.rating; } },
      { id: 'ilvl', label: '装等', get: function (r) { return r.ilvl ? Math.ceil(r.ilvl) : 0; } },
      { id: 'runs', label: '本周完成本数', get: function (r) { return r.runs; } },
      {
        id: 'vault', label: '宝库解锁', text: function (r) {
          return L.vaultTypeOrder.map(function (t) {
            return (r.vault[t] || 0);
          }).join('/');
        }
      },
      {
        id: 'map', label: '藏宝图', text: function (r) {
          if (!r.map) return '·';
          return (r.map.bag ? r.map.bag + ' 张' : '0 张') + ' · ' + (r.map.used ? '已用' : '未用');
        }
      },
      { id: 'gold', label: '金币', get: function (r) { return Math.floor(r.money / 10000); } }
    ];

    var sel = doc.getElementById('trend-metric');
    var active = metrics[0];
    for (var i = 0; i < metrics.length; i++) {
      if (metrics[i].id === sel.value) active = metrics[i];
    }

    var table = el('table', 'mini-table trend');
    var hr = el('tr');
    hr.appendChild(el('th', null, '角色'));
    weeks.forEach(function (w) { hr.appendChild(el('th', 'num', w.label)); });
    table.appendChild(hr);

    var s = AE.state.settings;
    order.forEach(function (k) {
      var tr = el('tr');
      var latest = null;
      for (var wi = weeks.length - 1; wi >= 0; wi--) {
        if (weeks[wi].characters[k]) { latest = weeks[wi].characters[k]; break; }
      }
      var nameTd = el('td', null, latest ? latest.name : k);
      if (latest && s.classColors) nameTd.style.color = L.classColor(latest.classFile);
      nameTd.title = latest ? (latest.name + ' - ' + latest.realm) : k;
      tr.appendChild(nameTd);

      var prevVal = null;
      weeks.forEach(function (w) {
        var r = w.characters[k];
        var td = el('td', 'num');
        if (!r) {
          td.className += ' empty';
          td.textContent = '·';
          td.title = '这一周该数据源里没有这个角色';
          tr.appendChild(td);
          return;
        }
        if (active.text) {
          td.textContent = active.text(r);
        } else {
          var v = active.get(r);
          td.appendChild(doc.createTextNode(v ? AE.fmt.group3(v) : '·'));
          var dd = deltaSpan(delta(v, prevVal));
          if (dd) td.appendChild(dd);
          prevVal = v;
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    body.appendChild(table);
  }

  // ------------------------------------------------------------------- entry

  AE.openTrends = function () {
    var view = doc.getElementById('trend');
    var body = doc.getElementById('trend-body');
    AE.openPanel('trend');

    if (loaded) { render(body, null); return; }
    if (loading) return;

    loading = true;
    body.innerHTML = '';
    body.appendChild(el('p', 'note', '正在载入历史快照…'));
    loadSnapshots(function (failed) {
      loading = false;
      try {
        buildWeeks(failed);
        render(body, failed);
      } catch (e) {
        body.innerHTML = '';
        body.appendChild(el('p', 'note', '历史数据处理失败：' + e.message));
      }
    });
  };

  AE.closeTrends = function () {
    doc.getElementById('trend').classList.remove('open');
    if (AE.updateBackdrop) AE.updateBackdrop();
  };

  AE.rerenderTrends = function () {
    if (!loaded) return;
    render(doc.getElementById('trend-body'), null);
  };

})(typeof window !== 'undefined' ? window : globalThis);
