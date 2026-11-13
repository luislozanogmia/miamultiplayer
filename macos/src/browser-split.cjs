"use strict";

// Split view: the browser area shows one page, two side by side, or four in
// a 2x2 grid. Everything here is plain data, so the native side and its tests
// share one copy of the numbers; the renderer gets the rectangles in the tab
// state and draws its outline and empty panes from them.
const SPLIT_MODES = [1, 2, 4];
// CSS px between panes. The edge keeps half of it, so the focused pane's
// outline has room on every side (native views cover anything under them).
const SPLIT_GAP = 6;

function splitMode(value) {
  const mode = Number(value);
  return SPLIT_MODES.includes(mode) ? mode : 1;
}

// The panes of `area` ({ width, height }), relative to its top left corner,
// in slot order: left then right, or top left, top right, bottom left, bottom
// right. One page is the whole area, exactly as before split view.
function splitRects(area, mode, gap = SPLIT_GAP) {
  const width = Math.max(0, Math.floor(Number(area && area.width) || 0));
  const height = Math.max(0, Math.floor(Number(area && area.height) || 0));
  mode = splitMode(mode);
  if (mode === 1) return [{ x: 0, y: 0, width, height }];
  const edge = Math.floor(gap / 2);
  const inner = { width: Math.max(0, width - 2 * edge), height: Math.max(0, height - 2 * edge) };
  // Split one length in two around the gap; the second part takes any odd pixel.
  const halves = length => {
    const first = Math.max(0, Math.floor((length - gap) / 2));
    return [first, Math.max(0, length - gap - first)];
  };
  const [left, right] = halves(inner.width);
  const columns = [{ x: edge, width: left }, { x: edge + left + gap, width: right }];
  if (mode === 2) return columns.map(column => ({ x: column.x, y: edge, width: column.width, height: inner.height }));
  const [top, bottom] = halves(inner.height);
  const rows = [{ y: edge, height: top }, { y: edge + top + gap, height: bottom }];
  return rows.flatMap(row => columns.map(column => ({ x: column.x, y: row.y, width: column.width, height: row.height })));
}

// Entering two or four: the active tab first, then the tabs used most
// recently (`candidates`, most recent first). Missing tabs leave empty slots.
function enterSplit(mode, activeId, candidates = []) {
  mode = splitMode(mode);
  const slots = [activeId ?? null];
  for (const id of candidates) {
    if (slots.length >= mode) break;
    if (id !== null && id !== undefined && !slots.includes(id)) slots.push(id);
  }
  while (slots.length < mode) slots.push(null);
  return { slots, focus: 0 };
}

// Picking a tab: one already shown just takes the focus. Another fills the
// first empty slot, else replaces the tab in the focused pane.
function pickSlot(slots, focus, id) {
  const shown = slots.indexOf(id);
  if (shown >= 0) return { slots: slots.slice(), focus: shown };
  const empty = slots.indexOf(null);
  const target = empty >= 0 ? empty : Math.min(Math.max(0, focus || 0), slots.length - 1);
  const next = slots.slice();
  next[target] = id;
  return { slots: next, focus: target };
}

// A tab that closes or goes to the dock leaves its pane empty.
function removeFromSlots(slots, id) {
  return slots.map(slot => (slot === id ? null : slot));
}

// Empty panes take the next most recent tabs not already shown.
function refillSlots(slots, candidates = []) {
  const next = slots.slice();
  const spare = candidates.filter(id => id !== null && id !== undefined && !next.includes(id));
  for (let index = 0; index < next.length && spare.length; index++) {
    if (next[index] === null) next[index] = spare.shift();
  }
  return next;
}

module.exports = { SPLIT_MODES, SPLIT_GAP, splitMode, splitRects, enterSplit, pickSlot, removeFromSlots, refillSlots };
