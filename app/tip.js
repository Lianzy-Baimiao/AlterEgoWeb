/*
 * WowAltBoard - app/tip.js
 *
 * Hover tooltips for the whole page.
 *
 * Why not the native title="" attribute, which is what this replaces: the OS
 * tooltip is unusable for a table you sweep across.
 *   - it waits about a second before appearing, so a quick pass shows nothing;
 *   - it hides itself after about five seconds, mid-read, on a 4-line vault cell;
 *   - once it has hidden, it will NOT come back while the pointer stays inside
 *     the same cell -- you have to leave and re-enter. That is exactly the
 *     "not every hover shows one" complaint;
 *   - any DOM rebuild under the cursor kills it silently.
 *
 * So the main table authors the text as a title property (48 call sites in
 * columns.js / render.js), and this module adopts it lazily on first hover:
 * title is moved to data-tip and removed from the node, which is what
 * suppresses the native bubble. That path also mirrors the text into
 * aria-label when the node has no accessible name yet.
 *
 * The BiS panel is different on purpose: it writes data-tip DIRECTLY (16 call
 * sites in bis.js) and never sets title, so the native bubble never appears at
 * all and there is nothing to adopt. That means the title -> aria-label mirror
 * below never runs for panel nodes -- which is fine, because every panel node
 * carrying data-tip has its own visible text, so the tooltip is supplementary
 * detail rather than the element's accessible name. tools/run-tests.js asserts
 * exactly that (26378 data-tip elements, 0 without visible text); if someone
 * ever replaces a visible label with a tooltip-only one, that check fails.
 *
 * Delegated on document, so it survives every AE.rebuild() without rewiring.
 */
(function (global) {
  'use strict';

  var AE = global.AE = global.AE || {};
  var doc = global.document;

  // Short enough to feel instant, long enough that dragging the pointer across
  // twenty columns does not strobe a tooltip per cell.
  var SHOW_MS = 90;
  var GAP = 14;      // clearance from the cursor, so the box never sits under it
  var EDGE = 8;      // minimum distance from the viewport edge

  var box = null;
  var timer = null;
  var current = null;   // element whose tip is showing or scheduled
  var mx = 0, my = 0;

  function host() {
    if (!box) {
      box = doc.createElement('div');
      box.id = 'tip';
      box.setAttribute('role', 'tooltip');
      box.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(box);
    }
    return box;
  }

  /**
   * Tooltip text for a node, adopting title="" on first sight.
   * @returns {string} empty when this node carries no tooltip
   */
  function textOf(node) {
    // title wins when both are present: a long-lived node (the panel reuses
    // some) can have a fresh title assigned after we already cached one, and
    // showing the stale copy would be worse than showing nothing.
    var live = node.getAttribute('title');
    if (live) {
      node.setAttribute('data-tip', live);
      // Removing title is the point: otherwise both bubbles show.
      node.removeAttribute('title');
      if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', live);
      return live;
    }
    var cached = node.getAttribute('data-tip');
    return cached === null ? '' : cached;
  }

  /** Nearest ancestor carrying tooltip text. */
  function owner(node) {
    while (node && node !== doc.body && node.nodeType) {
      if (node.nodeType === 1 && textOf(node)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function place() {
    var b = host();
    var w = b.offsetWidth, h = b.offsetHeight;
    var vw = doc.documentElement.clientWidth;
    var vh = doc.documentElement.clientHeight;

    var x = mx + GAP;
    if (x + w > vw - EDGE) x = mx - GAP - w;       // flip to the left
    if (x < EDGE) x = Math.max(EDGE, vw - EDGE - w);

    var y = my + GAP;
    if (y + h > vh - EDGE) y = my - GAP - h;       // flip above
    if (y < EDGE) y = EDGE;

    b.style.left = Math.round(x) + 'px';
    b.style.top = Math.round(y) + 'px';
  }

  function show(node) {
    var text = textOf(node);
    if (!text) return;
    var b = host();
    b.textContent = '';
    // First line is the heading -- every call site writes "名字\n细节…".
    text.split('\n').forEach(function (line, i) {
      var d = doc.createElement('div');
      if (i === 0) d.className = 'tip-head';
      // A blank line is a paragraph break; keep it from collapsing to 0px.
      d.textContent = line === '' ? '\u00a0' : line;
      b.appendChild(d);
    });
    b.style.display = 'block';
    b.setAttribute('aria-hidden', 'false');
    place();
    // Separate frame, or the transition has nothing to animate from.
    global.requestAnimationFrame(function () {
      if (current === node) b.classList.add('in');
    });
  }

  function hide() {
    if (timer) { global.clearTimeout(timer); timer = null; }
    current = null;
    if (!box) return;
    box.classList.remove('in');
    box.style.display = 'none';
    box.setAttribute('aria-hidden', 'true');
  }

  AE.hideTip = hide;

  function onOver(ev) {
    // A header drag would otherwise drag a tooltip along with it.
    if (doc.body.classList.contains('dragging-header')) return;

    mx = ev.clientX; my = ev.clientY;
    var node = owner(ev.target);
    if (!node) { if (current) hide(); return; }
    if (node === current) return;

    hide();
    current = node;
    timer = global.setTimeout(function () {
      timer = null;
      if (current === node && node.isConnected !== false) show(node);
    }, SHOW_MS);
  }

  function onMove(ev) {
    mx = ev.clientX; my = ev.clientY;
    if (!current) return;
    // Left the owner without a mouseover firing on anything tippable.
    if (!current.contains(ev.target) && owner(ev.target) !== current) { hide(); return; }
    // Reposition only while still waiting; a box that chases the cursor is
    // harder to read than one that stays put.
    if (timer) return;
    if (box && box.style.display === 'block') place();
  }

  AE.wireTips = function () {
    doc.addEventListener('mouseover', onOver, true);
    doc.addEventListener('mousemove', onMove, true);
    // NOT mouseleave in capture: that fires for every child, so sliding from
    // the count onto the bar inside one cell would flicker the box. Leaving the
    // page entirely is what matters here.
    doc.addEventListener('mouseout', function (ev) {
      if (!ev.relatedTarget) hide();
    }, true);
    doc.addEventListener('mousedown', hide, true);
    // Any of these moves the anchor out from under the box.
    doc.addEventListener('wheel', hide, true);
    doc.addEventListener('scroll', hide, true);
    global.addEventListener('blur', hide);
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') hide();
    }, true);
  };

})(typeof window !== 'undefined' ? window : globalThis);
