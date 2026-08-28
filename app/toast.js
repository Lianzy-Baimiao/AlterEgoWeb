/*
 * AlterEgoWeb - app/toast.js
 *
 * Transient corner notifications. Used for the things that otherwise happen
 * invisibly: an export lands in the browser's download folder with no feedback
 * at all, which reads as "the button did nothing".
 *
 * A toast, not a dialog: nothing here needs an answer, and a modal on every
 * export would be worse than no message.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;

  function host() {
    var h = doc.getElementById('toasts');
    if (!h) {
      h = doc.createElement('div');
      h.id = 'toasts';
      doc.body.appendChild(h);
    }
    return h;
  }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * @param {object} o
   *   title    {string}
   *   body     {string=}
   *   kind     {'info'|'good'|'bad'=}
   *   ms       {number=}  auto-dismiss delay; 0 keeps it until clicked
   *   actions  {Array<{label, onClick, keepOpen}>=}
   */
  AE.toast = function (o) {
    var box = el('div', 'toast' + (o.kind && o.kind !== 'info' ? ' ' + o.kind : ''));
    box.appendChild(el('div', 't-title', o.title));
    if (o.body) box.appendChild(el('div', 't-body', o.body));

    var timer = null;
    function close() {
      if (timer) { global.clearTimeout(timer); timer = null; }
      box.classList.remove('in');
      // Let the fade finish before removing, or it vanishes abruptly.
      global.setTimeout(function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      }, 200);
    }

    if (o.actions && o.actions.length) {
      var bar = el('div', 't-actions');
      o.actions.forEach(function (a) {
        var b = el('button', null, a.label);
        b.type = 'button';
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          try { a.onClick(box); } catch (e) { /* ignore */ }
          if (!a.keepOpen) close();
        });
        bar.appendChild(b);
      });
      box.appendChild(bar);
    }

    box.addEventListener('click', close);

    host().appendChild(box);
    // Force a reflow so the transition actually runs on first paint.
    void box.offsetWidth;
    box.classList.add('in');

    var ms = o.ms === undefined ? 3000 : o.ms;
    if (ms > 0) {
      timer = global.setTimeout(close, ms);
      // Hovering pauses the countdown; a 3 s toast you are still reading is
      // annoying.
      box.addEventListener('mouseenter', function () {
        if (timer) { global.clearTimeout(timer); timer = null; }
      });
      box.addEventListener('mouseleave', function () {
        if (!timer) timer = global.setTimeout(close, 1200);
      });
    }

    return { close: close };
  };

  /** Copy text, with a toast either way. */
  AE.copyWithToast = function (text, label) {
    function ok() {
      AE.toast({ title: '已复制' + (label ? '：' + label : ''), kind: 'good', ms: 2000 });
    }
    function fail() {
      AE.toast({ title: '复制失败', body: '可以手动选中文本后按 Ctrl+C。', kind: 'bad', ms: 4000 });
    }
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(ok, function () { legacy(); });
      return;
    }
    legacy();

    // execCommand is deprecated but is the only thing that works when the async
    // clipboard API is unavailable, which does happen on file://.
    function legacy() {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      var done = false;
      try { done = doc.execCommand('copy'); } catch (e) { done = false; }
      doc.body.removeChild(ta);
      if (done) ok(); else fail();
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
