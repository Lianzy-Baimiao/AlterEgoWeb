/*
 * WowAltBoard - tools/dom-stub.js
 *
 * 一个够用的 DOM 桩，专门给 Node 里跑 app/ 下的代码用。
 *
 * 为什么要自己写
 * --------------
 * 这个看板是纯 file:// 的静态页，没有构建、没有 npm 依赖、代码全是 ES5 IIFE。
 * 为了跑测试去装 jsdom 会给一个零依赖的项目引入一整棵依赖树，不值。而这些代码
 * 只用到 DOM 的一小块：createElement / appendChild / classList / textContent /
 * setAttribute / addEventListener，桩掉这些就能无头跑真实渲染。
 *
 * 有几个坑是踩出来的，别删：
 *   · textContent 必须是**会递归拼子节点**的 getter。写成普通字段的话，
 *     所有「渲染出的文字对不对」的断言都会读到空串，测试全部假通过。
 *   · navigator 在 Node 24 上是只读 getter，必须用 defineProperty 覆盖。
 *   · insertBefore / removeChild 得真的维护 children 顺序，bis.js 依赖它。
 *
 * 用法
 * ----
 *   var stub = require('./dom-stub.js');
 *   var env = stub.makeEnv(['bis', 'bis-sub', 'bis-body']);   // 要预建的元素 id
 *   env.load('app/bis.js');
 *   stub.walk(env.byId['bis-body'], function (node) { ... });
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

function makeEl(tag) {
  var e = {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, style: {}, _text: '',
    parentNode: null,
    className: '',
    listeners: {},
    appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
    insertBefore: function (c, ref) {
      c.parentNode = e;
      var i = e.children.indexOf(ref);
      if (i < 0) e.children.push(c); else e.children.splice(i, 0, c);
      return c;
    },
    removeChild: function (c) {
      var i = e.children.indexOf(c);
      if (i >= 0) e.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute: function (k, v) { e.attrs[k] = String(v); },
    getAttribute: function (k) { return e.attrs[k] == null ? null : e.attrs[k]; },
    removeAttribute: function (k) { delete e.attrs[k]; },
    addEventListener: function (t, fn) { (e.listeners[t] = e.listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    dispatch: function (type, ev) {
      (e.listeners[type] || []).forEach(function (f) {
        f(ev || { target: e, preventDefault: function () {}, stopPropagation: function () {} });
      });
    },
    focus: function () {}, blur: function () {}, scrollIntoView: function () {},
    closest: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    contains: function () { return false; }
  };
  e.click = function () { e.dispatch('click'); };
  e.classList = {
    add: function () {
      for (var i = 0; i < arguments.length; i++) {
        if ((' ' + e.className + ' ').indexOf(' ' + arguments[i] + ' ') < 0) {
          e.className = (e.className ? e.className + ' ' : '') + arguments[i];
        }
      }
    },
    remove: function () {
      for (var i = 0; i < arguments.length; i++) {
        e.className = (' ' + e.className + ' ').split(' ' + arguments[i] + ' ').join(' ').trim();
      }
    },
    toggle: function (c, on) { if (on) e.classList.add(c); else e.classList.remove(c); },
    contains: function (c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  };
  // 递归拼接。写成普通字段会让所有文字断言假通过 —— 见文件头。
  Object.defineProperty(e, 'textContent', {
    get: function () {
      if (e.children.length === 0) return e._text;
      return e.children.map(function (c) { return c.textContent; }).join('');
    },
    set: function (v) { e._text = String(v == null ? '' : v); e.children.length = 0; }
  });
  Object.defineProperty(e, 'innerHTML', {
    get: function () { return ''; },
    set: function (v) { if (v === '') { e.children.length = 0; e._text = ''; } }
  });
  return e;
}

/** 深度优先遍历，包括自己。 */
function walk(node, fn) {
  fn(node);
  (node.children || []).forEach(function (c) { walk(c, fn); });
}

/** 收集子树里 class 命中的节点。 */
function findByClass(node, cls) {
  var out = [];
  walk(node, function (n) {
    if (n.classList && n.classList.contains(cls)) out.push(n);
  });
  return out;
}

/**
 * 建一套全局环境。ids 是要预先建好的元素 id（getElementById 能查到）。
 * 返回 { g, doc, byId, load, reset }。
 */
function makeEnv(ids) {
  var byId = {};
  var doc = {
    createElement: makeEl,
    createTextNode: function (t) { var e = makeEl('#text'); e._text = String(t); return e; },
    createDocumentFragment: function () { return makeEl('#fragment'); },
    getElementById: function (id) { return byId[id] || null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {},
    documentElement: makeEl('html')
  };
  doc.head = makeEl('head');
  doc.body = makeEl('body');

  (ids || []).forEach(function (id) {
    var e = makeEl('div');
    e.attrs.id = id;
    byId[id] = e;
  });

  var g = global;
  g.window = g;
  g.document = doc;
  g.AE = {};

  var store = {};
  g.localStorage = {
    getItem: function (k) { return store[k] == null ? null : store[k]; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    clear: function () { store = {}; }
  };
  g.sessionStorage = g.localStorage;
  g.location = { pathname: '/wowaltboard/index.html', href: 'file:///wowaltboard/index.html', search: '', hash: '' };
  g.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  g.cancelAnimationFrame = function (t) { clearTimeout(t); };
  // Node 24 上 navigator 是只读 getter，直接赋值会抛。
  if (!g.navigator) {
    Object.defineProperty(g, 'navigator', {
      value: { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'] },
      configurable: true
    });
  }

  function load(rel) {
    var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('global', 'window', 'document', src).call(g, g, g, doc);
  }

  return { g: g, doc: doc, byId: byId, load: load, root: ROOT };
}

module.exports = {
  ROOT: ROOT,
  makeEl: makeEl,
  makeEnv: makeEnv,
  walk: walk,
  findByClass: findByClass
};
