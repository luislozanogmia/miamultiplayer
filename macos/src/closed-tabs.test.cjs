"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClosedTabs, CLOSED_TABS_MAX } = require("./closed-tabs.cjs");

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-closed-tabs-")), "tabs-closed.json");

test("the newest closed page comes back first, and only once", () => {
  const closed = createClosedTabs();
  closed.remember({ url: "https://a.test/", title: "A" });
  closed.remember({ url: "https://b.test/", title: "B", groupId: "g1", afterId: 3 });
  const entry = closed.take();
  assert.equal(entry.url, "https://b.test/");
  assert.equal(entry.groupId, "g1");
  assert.equal(entry.afterId, 3);
  assert.equal(closed.take().url, "https://a.test/");
  assert.equal(closed.take(), null);
});

test("only web pages are kept, without repeats, up to the limit", () => {
  const closed = createClosedTabs();
  for (const url of ["", "file:///etc/passwd", "javascript:alert(1)", "about:blank"]) closed.remember({ url });
  assert.equal(closed.list().length, 0);
  closed.remember({ url: "https://a.test/" });
  closed.remember({ url: "https://b.test/" });
  closed.remember({ url: "https://a.test/" });
  assert.deepEqual(closed.list().map(entry => entry.url), ["https://a.test/", "https://b.test/"]);
  for (let index = 0; index < CLOSED_TABS_MAX + 5; index += 1) closed.remember({ url: `https://n${index}.test/` });
  assert.equal(closed.list().length, CLOSED_TABS_MAX);
});

test("the list survives a restart, stays per workspace, and can be cleared", () => {
  const one = file(), two = file();
  const closed = createClosedTabs();
  closed.open(one);
  closed.remember({ url: "https://a.test/", title: "A" });
  closed.open(two);
  assert.equal(closed.list().length, 0);
  const again = createClosedTabs();
  again.open(one);
  assert.equal(again.list()[0].title, "A");
  assert.equal(fs.statSync(one).mode & 0o777, 0o600);
  again.clear();
  assert.equal(fs.existsSync(one), false);
  assert.equal(again.list().length, 0);
});

test("a damaged or hostile saved list is not trusted", () => {
  const target = file();
  fs.writeFileSync(target, JSON.stringify({ entries: [{ url: "file:///etc/passwd" }, { url: "https://ok.test/", groupId: 7 }] }));
  const closed = createClosedTabs();
  closed.open(target);
  assert.deepEqual(closed.list().map(entry => [entry.url, entry.groupId]), [["https://ok.test/", null]]);
  fs.writeFileSync(target, "not json");
  closed.open(target);
  assert.equal(closed.list().length, 0);
});

test("the browser records people's closes and offers them back", () => {
  const source = fs.readFileSync(path.join(__dirname, "browser.cjs"), "utf8");
  assert.match(source, /if \(byUser && !tab\.private\) closedTabs\.remember\(/);
  assert.match(source, /label: "Reopen Closed Tab"/);
  assert.match(source, /key === "T"\) reopenClosedTab\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), /\["Reopen Closed Tab", "CommandOrControl\+Shift\+T", "T"\]/);
});
