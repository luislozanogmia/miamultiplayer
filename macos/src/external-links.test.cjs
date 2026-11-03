"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_HELD_LINKS, createExternalLinkQueue, isWebLink, webLinksFromArgv } = require("./external-links.cjs");

test("only http and https count as web links", () => {
  assert.equal(isWebLink("https://example.com/a"), true);
  assert.equal(isWebLink("HTTP://example.com"), true);
  for (const value of ["miamultiplayer://auth", "file:///etc/passwd", "javascript:alert(1)", "https://", "httpfoo", "--flag=https://x.com", null]) {
    assert.equal(isWebLink(value), false, String(value));
  }
});

test("command line arguments give only the web links", () => {
  assert.deepEqual(webLinksFromArgv(["/usr/bin/mia", ".", "--no-sandbox", "https://example.com", "miamultiplayer://x"]), ["https://example.com"]);
  assert.deepEqual(webLinksFromArgv(undefined), []);
});

test("a link that arrives before the window is ready opens once it is", () => {
  const opened = [];
  const links = createExternalLinkQueue({ open: url => opened.push(url) });
  links.receive("https://a.example");
  links.receive("https://b.example");
  assert.deepEqual(opened, []);
  links.setReady(true);
  assert.deepEqual(opened, ["https://a.example", "https://b.example"]);
  links.setReady(true);
  assert.equal(opened.length, 2, "a held link opens only once");
});

test("a ready window opens links straight away, and a closed one holds them again", () => {
  const opened = [];
  const links = createExternalLinkQueue({ open: url => opened.push(url) });
  links.setReady(true);
  links.receive("https://a.example");
  assert.deepEqual(opened, ["https://a.example"]);
  links.setReady(false);
  links.receive("https://b.example");
  assert.equal(opened.length, 1);
  links.setReady(true);
  assert.deepEqual(opened, ["https://a.example", "https://b.example"]);
});

test("a flood of links before startup is capped", () => {
  const opened = [];
  const links = createExternalLinkQueue({ open: url => opened.push(url) });
  for (let i = 0; i < MAX_HELD_LINKS + 5; i += 1) links.receive(`https://example.com/${i}`);
  links.setReady(true);
  assert.equal(opened.length, MAX_HELD_LINKS);
});
