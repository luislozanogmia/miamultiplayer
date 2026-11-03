// A spot on a page that means the same thing on another computer, whatever its
// window size or scroll position: the element under it and where inside that
// element, with the spot's place in the whole document as a fallback.
const MAX_DEPTH = 60;
const VIEW_LINE = 0.3;

const fraction = value => Math.min(1, Math.max(0, Number(value) || 0));

// Anchors come from teammates and end up in a page script, so only plain numbers pass.
function cleanAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const path = Array.isArray(anchor.p) && anchor.p.length <= MAX_DEPTH && anchor.p.every(index => Number.isInteger(index) && index >= 0 && index < 100000) ? anchor.p : null;
  return { p: path, t: /^[A-Za-z0-9-]{1,40}$/.test(anchor.t || "") ? anchor.t : "", fx: fraction(anchor.fx), fy: fraction(anchor.fy), dx: fraction(anchor.dx), dy: fraction(anchor.dy) };
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
    return Object.assign(anchor, { p: path, t: el.tagName, fx: box.width ? (x - box.left) / box.width : 0, fy: box.height ? (y - box.top) / box.height : 0 });
  };
  const findAnchor = anchor => {
    const root = document.documentElement;
    let node = anchor.p ? root : null;
    for (const index of anchor.p || []) { node = node && node.children[index]; }
    if (node && node.tagName === anchor.t) {
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
