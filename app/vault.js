/*
 * AlterEgoWeb - app/vault.js
 *
 * 备份箱: a place to keep the long import/export strings addons produce, outside
 * the game.
 *
 * Three sources, deliberately labelled differently because they are not the same
 * kind of thing:
 *
 *   MySlot     真正的导出串。MySlot stores them verbatim in SavedVariables as
 *              MyslotExports.exports[] = {name, value}, so they are recoverable
 *              with the game closed -- which is exactly when you need them.
 *
 *   EditMode   NOT an import string. edit-mode-cache-account.txt is Blizzard's
 *              own cache format; it cannot be pasted anywhere. Keeping a copy
 *              lets you restore the file, nothing more. Labelled as such rather
 *              than pretending it is shareable.
 *
 *   自定义      Anything the user pastes in (WeakAuras / Plater / ElvUI / ...),
 *              with a name they choose. Stored with the settings so it travels
 *              with the folder.
 *
 * Payloads live in data/backups.js and are loaded on demand -- the MySlot strings
 * alone are ~490 KB here, and most visits never open this panel.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;

  var loaded = false;
  var loading = false;

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls || null, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function kb(n) {
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }

  function loadPayloads(done) {
    if (loaded) { done(null); return; }
    var idx = (global.AE_DATA && global.AE_DATA.backupIndex) || [];
    if (!idx.length) { loaded = true; done(null); return; }

    var s = doc.createElement('script');
    s.src = 'data/backups.js';
    s.async = false;
    s.charset = 'utf-8';
    s.onload = function () { loaded = true; done(null); };
    // onerror does fire for a missing file:// script.
    s.onerror = function () { loaded = true; done('data/backups.js 读取失败'); };
    doc.head.appendChild(s);
  }

  /** MySlot payload (raw Lua) -> [{name, value, time}] */
  function parseMyslot(content) {
    var out = [];
    var db;
    try {
      db = AE.parseLuaGlobals(content).globals.MyslotExports;
    } catch (e) { return out; }
    if (!db) return out;

    ['exports', 'backups'].forEach(function (bucket) {
      AE.asArray(db[bucket]).forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var value = typeof e.value === 'string' ? e.value : '';
        if (!value) return;
        out.push({
          name: typeof e.name === 'string' && e.name ? e.name : '(未命名)',
          bucket: bucket === 'exports' ? '导出' : '自动备份',
          value: value,
          time: typeof e.time === 'number' ? e.time : null
        });
      });
    });
    return out;
  }

  // ------------------------------------------------------------ clipboard UI

  function copyToClipboard(text, feedbackNode) {
    function ok() {
      if (!feedbackNode) return;
      var was = feedbackNode.textContent;
      feedbackNode.textContent = '已复制';
      feedbackNode.classList.add('ok');
      setTimeout(function () {
        feedbackNode.textContent = was;
        feedbackNode.classList.remove('ok');
      }, 1400);
    }
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(ok, function () { fallback(); });
      return;
    }
    fallback();

    // execCommand is deprecated but is the only thing that works when the
    // async clipboard API is unavailable, which does happen on file://.
    function fallback() {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      try { doc.execCommand('copy'); ok(); } catch (e) { /* ignore */ }
      doc.body.removeChild(ta);
    }
  }

  function entryRow(opts) {
    // opts: {title, sub, note, text, filename, onDelete}
    var row = el('div', 'vault-row');

    var head = el('div', 'vault-head');
    head.appendChild(el('b', null, opts.title));
    if (opts.sub) head.appendChild(el('span', 'vault-sub', opts.sub));
    row.appendChild(head);

    if (opts.note) row.appendChild(el('div', 'note', opts.note));

    var pre = el('textarea', 'vault-text');
    pre.value = opts.text;
    pre.readOnly = !opts.editable;
    pre.spellcheck = false;
    if (opts.onEdit) {
      pre.addEventListener('change', function () { opts.onEdit(pre.value); });
    }
    row.appendChild(pre);

    var bar = el('div', 'row-buttons');
    var status = el('span', 'vault-status', kb(opts.text.length));
    bar.appendChild(button('复制', 'mini', function () {
      copyToClipboard(pre.value, status);
    }));
    bar.appendChild(button('保存为文件', 'mini', function () {
      AE.downloadText(opts.filename, pre.value, 'text/plain');
    }));
    if (opts.onDelete) {
      bar.appendChild(button('删除', 'mini danger', function () {
        if (global.confirm('删除「' + opts.title + '」？')) opts.onDelete();
      }));
    }
    bar.appendChild(status);
    row.appendChild(bar);

    return row;
  }

  function safeFileName(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'backup';
  }

  // ----------------------------------------------------------------- render

  function render(err) {
    var body = doc.getElementById('vault-body');
    var s = AE.state.settings;
    body.innerHTML = '';

    if (err) body.appendChild(el('p', 'note', err));

    // ---- custom entries first: this is the part the user controls ---------
    var custom = el('details', 'sec');
    custom.open = true;
    custom.appendChild(el('summary', null, '自定义（' + s.vaultEntries.length + '）'));
    custom.appendChild(el('p', 'note',
      '任何插件的导入/导出串都可以贴在这里，名称和内容都能改。' +
      '内容跟设置一起保存，用「保存设置到文件」可以带走。'));

    var addWrap = el('div', 'vault-add');
    var nameIn = el('input');
    nameIn.type = 'text';
    nameIn.placeholder = '名称，例如「WA-坦克套装」';
    var textIn = el('textarea');
    textIn.placeholder = '把导出串粘贴到这里';
    textIn.spellcheck = false;
    addWrap.appendChild(nameIn);
    addWrap.appendChild(textIn);
    addWrap.appendChild(button('添加', null, function () {
      var name = nameIn.value.trim();
      var text = textIn.value;
      if (!name || !text) { global.alert('名称和内容都要填。'); return; }
      s.vaultEntries.push({ name: name, content: text, savedAt: Math.floor(Date.now() / 1000) });
      AE.saveSettings(s);
      render(null);
    }));
    custom.appendChild(addWrap);

    s.vaultEntries.forEach(function (e, i) {
      custom.appendChild(entryRow({
        title: e.name,
        sub: e.savedAt ? new Date(e.savedAt * 1000).toLocaleString() : '',
        text: e.content,
        editable: true,
        filename: safeFileName(e.name) + '.txt',
        onEdit: function (v) {
          s.vaultEntries[i].content = v;
          s.vaultEntries[i].savedAt = Math.floor(Date.now() / 1000);
          AE.saveSettings(s);
        },
        onDelete: function () {
          s.vaultEntries.splice(i, 1);
          AE.saveSettings(s);
          render(null);
        }
      }));
    });
    body.appendChild(custom);

    // ---- collected payloads ----------------------------------------------
    var payloads = global.AE_BACKUPS || [];
    var idx = (global.AE_DATA && global.AE_DATA.backupIndex) || [];

    if (!payloads.length && !idx.length) {
      body.appendChild(el('p', 'note',
        '没有从游戏目录收集到备份。目前会自动读取 MySlot 的导出串和编辑模式缓存；' +
        '在 tools/config.json 里把 collectBackups 设为 false 可以关掉。'));
      return;
    }

    var myslot = el('details', 'sec');
    myslot.open = true;
    var mySections = [];
    payloads.filter(function (p) { return p.label === 'MySlot'; }).forEach(function (p) {
      var entries = parseMyslot(p.content);
      mySections.push({ p: p, entries: entries });
    });
    var myTotal = 0;
    mySections.forEach(function (m) { myTotal += m.entries.length; });
    myslot.appendChild(el('summary', null, 'MySlot 动作条配置（' + myTotal + '）'));
    myslot.appendChild(el('p', 'note',
      '这些是可以直接粘贴回游戏 MySlot 窗口的导入串，从 SavedVariables 里读出来的，不用开游戏。'));
    mySections.forEach(function (m) {
      if (!m.entries.length) return;
      myslot.appendChild(el('h4', null, m.p.account + '　' + m.p.mtimeLocal));
      m.entries.forEach(function (e) {
        // The header comment block in a MySlot string already says class/spec/
        // date, so show the first few lines as the note instead of duplicating.
        var head = e.value.split(/\r?\n/).filter(function (l) { return /^#/.test(l); })
                    .slice(1, 6).join('　').replace(/#\s*/g, '');
        myslot.appendChild(entryRow({
          title: e.name,
          sub: e.bucket,
          note: head,
          text: e.value,
          filename: 'myslot-' + safeFileName(e.name) + '.txt'
        }));
      });
    });
    if (myTotal) body.appendChild(myslot);

    var editMode = el('details', 'sec');
    editMode.appendChild(el('summary', null, '编辑模式布局缓存'));
    editMode.appendChild(el('p', 'note',
      '⚠ 这不是能粘贴的导入串。它是暴雪自己的缓存格式，只能整份存下来、' +
      '将来把文件放回原路径来恢复。文件路径见下面每一项。'));
    var anyEm = false;
    payloads.filter(function (p) { return p.label === 'EditMode'; }).forEach(function (p) {
      anyEm = true;
      editMode.appendChild(entryRow({
        title: p.account,
        sub: p.mtimeLocal + '　' + kb(p.size),
        note: p.path,
        text: p.content,
        filename: 'edit-mode-cache-account.txt'
      }));
    });
    if (anyEm) body.appendChild(editMode);
  }

  // ------------------------------------------------------------------ entry

  AE.openVault = function () {
    AE.openPanel('vault');
    var body = doc.getElementById('vault-body');
    if (loaded) { render(null); return; }
    if (loading) return;
    loading = true;
    body.innerHTML = '';
    body.appendChild(el('p', 'note', '正在载入备份…'));
    loadPayloads(function (err) {
      loading = false;
      try {
        render(err);
      } catch (e) {
        body.innerHTML = '';
        body.appendChild(el('p', 'note', '备份箱出错：' + e.message));
      }
    });
  };

  AE.closeVault = function () {
    doc.getElementById('vault').classList.remove('open');
    if (AE.updateBackdrop) AE.updateBackdrop();
  };

  AE.vaultCopy = copyToClipboard;

})(typeof window !== 'undefined' ? window : globalThis);
