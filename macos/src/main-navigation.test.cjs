"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mainWindowLinkAction } = require("./main-navigation.cjs");

const BACKEND = "http://localhost:4871";

test("Mia's own pages load in Mia's window", () => {
  for (const url of [`${BACKEND}/`, `${BACKEND}/admin?workspace=solo#/users`, `${BACKEND}/invite.html`]) {
    assert.equal(mainWindowLinkAction(url, BACKEND).action, "allow", url);
  }
});

test("an attachment link opens its preview in a Mia browser tab", () => {
  assert.deepEqual(mainWindowLinkAction(`${BACKEND}/api/conversations/r1/attachments/page.html`, BACKEND),
    { action: "attachment", url: `${BACKEND}/api/conversations/r1/attachments/page.html?preview=true` });
  assert.deepEqual(mainWindowLinkAction(`${BACKEND}/api/conversations/r1/attachments/page.html?preview=true&workspace=multiplayer_test&x=1`, BACKEND),
    { action: "attachment", url: `${BACKEND}/api/conversations/r1/attachments/page.html?preview=true&workspace=multiplayer_test` });
  assert.equal(new URL(mainWindowLinkAction(`${BACKEND}/api/conversations/r1/attachments/a?workspace=evil`, BACKEND).url).searchParams.has("workspace"), false);
});

test("web pages go to a Mia browser tab; Mia's API and other schemes never load", () => {
  assert.deepEqual(mainWindowLinkAction("https://www.linkedin.com/login", BACKEND), { action: "browser", url: "https://www.linkedin.com/login" });
  assert.equal(mainWindowLinkAction("http://localhost:5173/", BACKEND).action, "browser", "another local app is a web page");
  for (const url of [`${BACKEND}/api/settings`, `${BACKEND}/api`, "file:///etc/hosts", "javascript:alert(1)", "https://user:pw@example.com/", "not a url"]) {
    assert.equal(mainWindowLinkAction(url, BACKEND).action, "block", url);
  }
});
