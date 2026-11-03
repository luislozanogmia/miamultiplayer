const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { cleanAnchor, readScript, scrollScript } = require("./space-anchor.cjs");

// A tall page whose heading sits at a different height on each computer.
function page({ headingTop, width = 1000, innerHeight = 800, scrollY = 0, headerOnTop = false }) {
  const c = { innerWidth: width, innerHeight, scrollX: 0, scrollY, scrolledBy: 0 };
  const box = top => ({ left: 100, top: top - c.scrollY, width: 400, height: 50 });
  const heading = { tagName: "H2", getBoundingClientRect: () => box(headingTop) };
  const body = { tagName: "BODY", children: [{ tagName: "P" }, heading] };
  const root = { tagName: "HTML", children: [{ tagName: "HEAD" }, body], scrollWidth: width, scrollHeight: 4000 };
  heading.parentElement = body; body.parentElement = root; root.parentElement = null;
  const header = { tagName: "HEADER", parentElement: body, sticky: true, getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 150 }) };
  c.document = { documentElement: root, elementFromPoint: () => heading, elementsFromPoint: () => (headerOnTop ? [header, heading, body, root] : [heading, body, root]) };
  c.getComputedStyle = el => ({ position: el.sticky ? "sticky" : "static" });
  c.scrollBy = (_x, y) => { c.scrolledBy += y; c.scrollY += y; };
  c.scrollTo = (_x, y) => { c.scrollY = y; };
  return vm.createContext(c);
}

test("a followed view lands on the same element even when the layouts differ", () => {
  const sender = page({ headingTop: 1000, scrollY: 800 });
  const { view } = vm.runInContext(readScript(null), sender);
  assert.deepEqual([...view.a.p], [1, 1]);
  const receiver = page({ headingTop: 1500 });
  vm.runInContext(scrollScript(JSON.parse(JSON.stringify(view))), receiver);
  // The anchored spot sits at the same height in the window on both computers.
  const senderSpot = 1000 - 800 + view.a.fy * 50, receiverSpot = 1500 - receiver.scrollY + view.a.fy * 50;
  assert.ok(Math.abs(senderSpot - receiverSpot) < 0.01);
});

test("a bar pinned to the window never marks how far down the page someone is", () => {
  const { view } = vm.runInContext(readScript(null), page({ headingTop: 1000, scrollY: 800, headerOnTop: true }));
  assert.equal(view.a.t, "H2");
});

test("the top of the page stays the top of the page", () => {
  const receiver = page({ headingTop: 1500, scrollY: 900 });
  vm.runInContext(scrollScript({ a: { p: [1, 1], t: "H2" }, top: true }), receiver);
  assert.equal(receiver.scrollY, 0);
});

test("a pointer records which element it is over and where inside it", () => {
  const read = vm.runInContext(readScript({ x: 300, y: 225 }), page({ headingTop: 200 }));
  assert.equal(read.pointer.t, "H2");
  assert.equal(read.pointer.fx, 0.5);
  assert.equal(read.pointer.fy, 0.5);
});

test("anchors from a teammate can only carry plain numbers into a page", () => {
  assert.equal(cleanAnchor("x"), null);
  const clean = cleanAnchor({ p: [1, "2);alert(1"], t: "H2);alert(1", fx: "9", fy: -2, dx: 0.5, dy: "x", extra: "no" });
  assert.deepEqual(clean, { p: null, t: "", fx: 1, fy: 0, dx: 0.5, dy: 0 });
  assert.equal(scrollScript({ a: null }), null);
});
