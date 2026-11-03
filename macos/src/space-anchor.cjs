// A spot on a page that means the same thing on another computer, whatever its
// window size or scroll position: the element under it and where inside that
// element, with the spot's place in the whole document as a fallback.
const MAX_DEPTH = 60;
const VIEW_LINE = 0.3;
const LETTER_REACH = 12;
const ID_PATTERN = "^[A-Za-z0-9_:.-]{1,80}$";

const fraction = value => Math.min(1, Math.max(0, Number(value) || 0));

// Anchors come from teammates and end up in a page script, so only plain numbers pass.
function cleanAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const steps = list => (Array.isArray(list) && list.length <= MAX_DEPTH && list.every(index => Number.isInteger(index) && index >= 0 && index < 100000) ? list : null);
  const path = steps(anchor.p);
  const own = new RegExp(ID_PATTERN).test(anchor.i || "") && steps(anchor.r) ? { i: anchor.i, r: anchor.r } : {};
  const count = value => (Number.isInteger(value) && value >= 0 && value < 10000000 ? value : null);
  const letter = count(anchor.n) === null || count(anchor.o) === null ? {} : { n: anchor.n, o: anchor.o };
  return { p: path, t: /^[A-Za-z0-9-]{1,40}$/.test(anchor.t || "") ? anchor.t : "", fx: fraction(anchor.fx), fy: fraction(anchor.fy), dx: fraction(anchor.dx), dy: fraction(anchor.dy), ...own, ...letter };
}

const PAGE_HELPERS = `
  const pinned = el => {
    for (let node = el; node; node = node.parentElement) {
      const place = getComputedStyle(node).position;
      if (place === 'fixed' || place === 'sticky') return true;
    }
    return false;
  };
  // A bar pinned to the window never moves, so it can't say how far down a page someone is.
  const makeAnchor = (x, y, skipPinned) => {
    const root = document.documentElement;
    const el = skipPinned ? document.elementsFromPoint(x, y).find(item => !pinned(item)) : document.elementFromPoint(x, y);
    const anchor = { p: null, t: '', fx: 0, fy: 0, dx: (x + scrollX) / Math.max(1, root.scrollWidth), dy: (y + scrollY) / Math.max(1, root.scrollHeight) };
    if (!el || el === root) return anchor;
    const path = [];
    for (let node = el; node && node !== root; node = node.parentElement) {
      if (!node.parentElement) return anchor;
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    if (path.length > ${MAX_DEPTH}) return anchor;
    const box = el.getBoundingClientRect();
    return Object.assign(anchor, { p: path, t: el.tagName }, nearestId(el), { fx: box.width ? (x - box.left) / box.width : 0, fy: box.height ? (y - box.top) / box.height : 0 }, textSpot(el, x, y));
  };
  // A page can add a banner on one computer and not the other, which renumbers everything
  // after it. The closest element with its own id is still the same element on both.
  const nearestId = el => {
    const trail = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && /${ID_PATTERN}/.test(node.id) && document.getElementById(node.id) === node) return { i: node.id, r: trail };
      if (!node.parentElement) return {};
      trail.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return {};
  };
  const walk = (node, path) => {
    for (const index of path) node = node && node.children[index];
    return node;
  };
  // Text wraps differently on another window, so a spot inside a paragraph is kept as the
  // letter under it: a share of the paragraph's box would land on some other word.
  const letterBox = (text, at) => {
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, Math.min(text.length, at + 1));
    return range.getBoundingClientRect();
  };
  const textSpot = (el, x, y) => {
    const caret = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    const text = caret && caret.startContainer;
    if (!text || text.nodeType !== 3 || text.parentNode !== el || !text.length) return {};
    const at = Math.min(caret.startOffset, text.length - 1);
    const box = letterBox(text, at);
    if (x < box.left - ${LETTER_REACH} || x > box.right + ${LETTER_REACH} || y < box.top || y > box.bottom) return {};
    return { n: Array.prototype.indexOf.call(el.childNodes, text), o: at };
  };
  const findAnchor = anchor => {
    const root = document.documentElement;
    const byId = anchor.i ? walk(document.getElementById(anchor.i), anchor.r || []) : null;
    const node = byId && byId.tagName === anchor.t ? byId : anchor.p ? walk(root, anchor.p) : null;
    if (node && node.tagName === anchor.t) {
      const text = Number.isInteger(anchor.n) ? node.childNodes[anchor.n] : null;
      if (text && text.nodeType === 3 && anchor.o < text.length) {
        const letter = letterBox(text, anchor.o);
        if (letter.width || letter.height) return { x: letter.left + letter.width / 2, y: letter.top + letter.height / 2 };
      }
      const box = node.getBoundingClientRect();
      if (box.width || box.height) return { x: box.left + anchor.fx * box.width, y: box.top + anchor.fy * box.height };
    }
    return { x: anchor.dx * root.scrollWidth - scrollX, y: anchor.dy * root.scrollHeight - scrollY };
  };`;

// What this person points at and which part of the page they are reading.
function readScript(pointer) {
  return `(() => {${PAGE_HELPERS}
    return {
      pointer: ${pointer ? `makeAnchor(${Number(pointer.x) || 0}, ${Number(pointer.y) || 0})` : "null"},
      view: { a: makeAnchor(innerWidth / 2, innerHeight * ${VIEW_LINE}, true), top: scrollY < 4 },
    };
  })()`;
}

// Brings the same part of the page into view as the person being followed.
function scrollScript(view) {
  const anchor = cleanAnchor(view && view.a);
  if (!anchor) return null;
  return `(() => {${PAGE_HELPERS}
    if (${view.top === true}) { if (scrollY) scrollTo(scrollX, 0); return; }
    const spot = findAnchor(${JSON.stringify(anchor)});
    const change = spot.y - innerHeight * ${VIEW_LINE};
    if (Math.abs(change) > 2) scrollBy(0, change);
  })()`;
}

module.exports = { PAGE_HELPERS, cleanAnchor, readScript, scrollScript };
