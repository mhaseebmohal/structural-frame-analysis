// ══════════════════════════════════════════════════════════════════════════════
//  mini-dom.js — just enough DOM to run js/core/a11y-labels.js under Node.
//
//  That module decides what every form control in the app is called. Its worst
//  failure is not leaving a control unnamed — it is giving one a confident,
//  wrong name read off a neighbour, which a screen reader then announces as
//  fact. That is worth a test, and a test of the real module rather than of a
//  re-stated rule, so the shipped code is what runs here.
//
//  Deliberately small: elements, text nodes, attributes, document-order
//  traversal, and the handful of selectors the module actually uses. It is a
//  test fixture, not a DOM — anything beyond that belongs in jsdom.
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const VOID = new Set(['input', 'br', 'hr', 'img']);

class TextNode {
  constructor(text) { this.nodeType = 3; this.data = text; this.parentNode = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.childNodes = [];
    this.parentNode = null;
  }

  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get type() { return this.attrs.type || ''; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }

  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }

  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return this;
  }

  get textContent() {
    return this.childNodes.map(c => c.textContent).join('');
  }

  /** Siblings, as the DOM reports them — text nodes included. */
  _sibling(step) {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + step] || null;
  }
  get previousSibling() { return this._sibling(-1); }
  get nextSibling() { return this._sibling(+1); }

  /** Depth-first, self first — document order. */
  * walk() {
    yield this;
    for (const c of this.childNodes) if (c.nodeType === 1) yield* c.walk();
  }

  contains(n) {
    for (const e of this.walk()) if (e === n) return true;
    return false;
  }

  matches(sel) {
    return String(sel).split(',').some(one => this._matchOne(one.trim()));
  }

  _matchOne(s) {
    if (!s) return false;
    // input:not([type=hidden])
    let m = /^([a-z]+):not\(\[([a-z-]+)=([^\]]+)\]\)$/i.exec(s);
    if (m) return this.tagName === m[1].toUpperCase() && this.getAttribute(m[2]) !== m[3];
    // [role=button]  /  [attr="value"]  /  [attr]
    m = /^\[([a-z-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/i.exec(s);
    if (m) {
      const have = this.getAttribute(m[1]);
      if (have === null) return false;
      const want = m[2] !== undefined ? m[2] : m[3];
      return want === undefined ? true : have === want;
    }
    // tag[attr="value"]
    m = /^([a-z]+)\[([a-z-]+)="([^"]*)"\]$/i.exec(s);
    if (m) return this.tagName === m[1].toUpperCase() && this.getAttribute(m[2]) === m[3];
    // .class
    if (s[0] === '.') return (this.getAttribute('class') || '').split(/\s+/).includes(s.slice(1));
    // tag
    return /^[a-z]+$/i.test(s) && this.tagName === s.toUpperCase();
  }

  querySelectorAll(sel) {
    const out = [];
    for (const e of this.walk()) if (e !== this && e.matches(sel)) out.push(e);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  closest(sel) {
    for (let e = this; e; e = e.parentElement) if (e.matches(sel)) return e;
    return null;
  }

  get outerHTML() {
    const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    const t = this.tagName.toLowerCase();
    if (VOID.has(t)) return `<${t}${a}>`;
    return `<${t}${a}>${this.childNodes.map(c =>
      c.nodeType === 1 ? c.outerHTML : c.data).join('')}</${t}>`;
  }
}

/**
 * Build a tree from nested arrays: ['div', {class:'row'}, 'text', ['label', {}, 'Node']]
 * A bare string is a text node.
 */
function h(spec) {
  if (typeof spec === 'string') return new TextNode(spec);
  const [tag, attrs, ...kids] = spec;
  const el = new Element(tag, attrs || {});
  // Whitespace between elements is what the real markup has, and the module's
  // backward scan has to step over it, so the fixtures get it too.
  kids.forEach(k => el.append(h(k)));
  return el;
}

/** A document root with the few document-level methods the module calls. */
function makeDocument(children) {
  const doc = new Element('body', {});
  children.forEach(c => doc.append(h(c)));
  doc.readyState = 'complete';
  doc.addEventListener = () => {};
  doc.getElementById = id => doc.querySelectorAll('[id]').find(e => e.id === id) || null;
  return doc;
}

module.exports = { Element, TextNode, h, makeDocument };
