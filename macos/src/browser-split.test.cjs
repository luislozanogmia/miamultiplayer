"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SPLIT_GAP, splitMode, splitRects, enterSplit, pickSlot, removeFromSlots, refillSlots } = require("./browser-split.cjs");

test("one page is the whole area", () => {
  assert.deepEqual(splitRects({ width: 800, height: 600 }, 1), [{ x: 0, y: 0, width: 800, height: 600 }]);
});

test("two side by side split the width around the gap, with half a gap at the edge", () => {
  assert.equal(SPLIT_GAP, 6);
  assert.deepEqual(splitRects({ width: 806, height: 606 }, 2), [
    { x: 3, y: 3, width: 397, height: 600 },
    { x: 406, y: 3, width: 397, height: 600 },
  ]);
  // An odd pixel goes to the second pane; fractions are dropped.
  assert.deepEqual(splitRects({ width: 807.6, height: 100 }, 2).map(rect => rect.width), [397, 398]);
});

test("four in a grid go top left, top right, bottom left, bottom right", () => {
  const rects = splitRects({ width: 806, height: 606 }, 4);
  assert.deepEqual(rects, [
    { x: 3, y: 3, width: 397, height: 297 },
    { x: 406, y: 3, width: 397, height: 297 },
    { x: 3, y: 306, width: 397, height: 297 },
    { x: 406, y: 306, width: 397, height: 297 },
  ]);
  // Panes never overlap and every gap is the same.
  assert.equal(rects[1].x - (rects[0].x + rects[0].width), SPLIT_GAP);
  assert.equal(rects[2].y - (rects[0].y + rects[0].height), SPLIT_GAP);
});

test("a tiny or missing area gives empty panes, never negative ones", () => {
  for (const rect of [...splitRects({ width: 4, height: 2 }, 4), ...splitRects(null, 2)]) {
    assert.ok(rect.width >= 0 && rect.height >= 0);
  }
});

test("only one, two and four are layouts", () => {
  assert.deepEqual([1, 2, 4, 3, "2", undefined].map(splitMode), [1, 2, 4, 1, 2, 1]);
  assert.equal(splitRects({ width: 100, height: 100 }, 3).length, 1);
});

test("entering puts the active tab first, then recent tabs, then empty panes", () => {
  assert.deepEqual(enterSplit(2, 5, [3, 2, 1]), { slots: [5, 3], focus: 0 });
  assert.deepEqual(enterSplit(4, 5, [3, 5]), { slots: [5, 3, null, null], focus: 0 });
});

test("picking a shown tab focuses it; another fills an empty pane, else the focused one", () => {
  assert.deepEqual(pickSlot([1, 2], 0, 2), { slots: [1, 2], focus: 1 });
  assert.deepEqual(pickSlot([1, null, 3, null], 2, 9), { slots: [1, 9, 3, null], focus: 1 });
  assert.deepEqual(pickSlot([1, 2, 3, 4], 2, 9), { slots: [1, 2, 9, 4], focus: 2 });
});

test("a removed tab leaves its pane empty until another tab refills it", () => {
  assert.deepEqual(removeFromSlots([1, 2, 3], 2), [1, null, 3]);
  assert.deepEqual(refillSlots([1, null, 3, null], [3, 7]), [1, 7, 3, null]);
});
