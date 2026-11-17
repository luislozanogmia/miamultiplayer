"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { createSiteNotifications, siteOrigin, MAX_BODY } = require("./site-notifications.cjs");

const SITE = "https://chat.example.test";

test("a site's notifications are taken only after the person allows that site", async () => {
  const caught = [], asked = [], logs = [];
  let saves = 0, answer = null;
  const notes = createSiteNotifications({
    save: () => { saves++; }, ask: async (origin) => { asked.push(origin); return answer; },
    caught: note => caught.push(note), log: line => logs.push(line), now: () => 5,
  });
  assert.equal(notes.state(`${SITE}/inbox`), "default");
  assert.equal(notes.receive(`${SITE}/inbox`, { title: "Ana", body: "Hi" }), null);
  // Not Now is not remembered, so the next request asks again.
  assert.equal(await notes.request(`${SITE}/inbox`), "default");
  answer = { mode: "desktop" };
  assert.equal(await notes.request(`${SITE}/inbox`), "granted");
  assert.equal(await notes.request(`${SITE}/other`), "granted");
  assert.deepEqual(asked, [SITE, SITE]);
  assert.equal(saves, 1);
  assert.equal(notes.listening(`${SITE}/inbox`), true);
  assert.deepEqual(notes.receive(`${SITE}/inbox`, { title: "  Ana\n", body: "x".repeat(MAX_BODY + 50), tag: 7 }),
    { origin: SITE, title: "Ana", body: "x".repeat(MAX_BODY), tag: "7", at: 5 });
  assert.equal(caught.length, 1);
  assert.equal(notes.receive(`${SITE}/inbox`, { title: " ", body: "" }), null, "an empty one is nothing to act on");
  // The log says one came, never what it said.
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /Ana|xxx/);
  assert.deepEqual(notes.toJSON(), { [SITE]: { mode: "desktop", workspace: "solo" } });
});

test("a blocked site, another site and a page that is not https are never taken", async () => {
  const caught = [];
  const notes = createSiteNotifications({ saved: { [SITE]: false, "http://plain.example.test": true, "not a site": true }, caught: note => caught.push(note) });
  assert.equal(notes.state(SITE), "denied");
  assert.equal(await notes.request(SITE), "denied");
  assert.equal(await notes.request("http://plain.example.test"), "denied");
  assert.equal(await notes.request("about:blank"), "denied");
  for (const url of [SITE, "https://other.example.test", "http://plain.example.test", "file:///tmp/a.html", ""]) {
    assert.equal(notes.receive(url, { title: "Hi" }), null);
    assert.equal(notes.listening(url), false);
  }
  assert.deepEqual(caught, []);
  assert.deepEqual(notes.toJSON(), { [SITE]: { mode: "block", workspace: "solo" } });
  assert.equal(siteOrigin(`${SITE}/a?b`), SITE);
  // The right-click menu turns a site on, and one question is asked at a time.
  assert.equal(notes.set(SITE, { mode: "desktop" }), true);
  assert.equal(notes.receive(SITE, { title: "Hi" }).title, "Hi");
  let asks = 0, settle;
  const slow = createSiteNotifications({ ask: () => { asks++; return new Promise((resolve) => { settle = resolve; }); } });
  const both = [slow.request(SITE), slow.request(SITE)];
  await Promise.resolve();
  settle({ mode: "block" });
  assert.deepEqual(await Promise.all(both), ["denied", "denied"]);
  assert.equal(asks, 1);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test("Send to Mia and Send to Bot hand each notification over for that chat, not the desktop", async () => {
  const caught = [], delivered = [], logs = [];
  let answer = { mode: "mia" };
  const notes = createSiteNotifications({
    ask: async () => answer, caught: note => caught.push(note), log: line => logs.push(line),
    deliver: async (note, decision) => { delivered.push([note.title, decision.mode, decision.botId || ""]); },
  });
  assert.equal(await notes.request(SITE), "granted");
  notes.receive(SITE, { title: "Ana", body: "Lunch?" });
  await tick();
  assert.deepEqual(delivered, [["Ana", "mia", ""]]);
  assert.deepEqual(caught, [], "a notification sent to Mia is not also shown on the desktop");
  assert.doesNotMatch(logs.join("\n"), /Ana|Lunch/);
  answer = { mode: "bot", botId: "bot-7", botName: "Admin Bot" };
  const other = "https://mail.example.test";
  assert.equal(await notes.request(other), "granted");
  assert.equal(notes.listening(other), true);
  notes.receive(other, { title: "Invoice" });
  await tick();
  assert.deepEqual(delivered[1], ["Invoice", "bot", "bot-7"]);
  assert.deepEqual(notes.toJSON()[other], { mode: "bot", workspace: "solo", botId: "bot-7", botName: "Admin Bot" });
  // A bot choice that names no bot, or an unknown mode, is Not Now.
  const third = "https://third.example.test";
  answer = { mode: "bot" };
  assert.equal(await notes.request(third), "default");
  answer = { mode: "everywhere" };
  assert.equal(await notes.request(third), "default");
  assert.equal(notes.toJSON()[third], undefined);
});

test("when the chosen bot is no longer there, sending stops as if the person had answered Not Now", async () => {
  let saves = 0, asks = 0;
  const notes = createSiteNotifications({
    saved: { [SITE]: { mode: "bot", workspace: "solo", botId: "gone" } },
    save: () => { saves++; }, ask: async () => { asks++; return null; },
    deliver: async () => { throw Object.assign(new Error("bot unavailable"), { code: "BOT_UNAVAILABLE" }); },
  });
  assert.equal(notes.state(SITE), "granted");
  notes.receive(SITE, { title: "Ana" });
  await tick();
  assert.equal(saves, 1);
  assert.equal(notes.state(SITE), "default");
  assert.equal(notes.listening(SITE), false);
  assert.equal(notes.receive(SITE, { title: "Ana again" }), null, "nothing more is sent");
  assert.equal(await notes.request(SITE), "default");
  assert.equal(asks, 1, "the site is asked again, as after Not Now");
  // Any other failure keeps the choice: the next notification tries again.
  const flaky = createSiteNotifications({
    saved: { [SITE]: { mode: "mia", workspace: "solo" } },
    deliver: async () => { throw new Error("offline"); },
  });
  flaky.receive(SITE, { title: "Ana" });
  await tick();
  assert.equal(flaky.state(SITE), "granted");
});

test("a site's notifications are on in one workspace only; elsewhere it acts as Not Now without asking", async () => {
  let key = "hub_" + "a".repeat(32), asks = 0;
  const delivered = [];
  const notes = createSiteNotifications({
    workspace: () => key, ask: async () => { asks++; return { mode: "mia" }; },
    deliver: async (note, decision) => { delivered.push(decision.workspace); },
  });
  assert.equal(await notes.request(SITE), "granted");
  assert.equal(notes.toJSON()[SITE].workspace, key);
  const company = key;
  key = "solo";
  assert.equal(notes.state(SITE), "default");
  assert.equal(notes.elsewhere(SITE), true);
  assert.equal(notes.decided(SITE), undefined);
  assert.equal(await notes.request(SITE), "default");
  assert.equal(asks, 1, "Solo does not ask while the company has the site");
  assert.equal(notes.receive(SITE, { title: "Ana" }), null);
  assert.equal(notes.listening(SITE), false);
  key = company;
  notes.receive(SITE, { title: "Ana" });
  await tick();
  assert.deepEqual(delivered, [company]);
  // A question still open when the person switches workspace counts as Not Now.
  let settle;
  const later = createSiteNotifications({ workspace: () => key, ask: () => new Promise((resolve) => { settle = resolve; }) });
  const asked = later.request(SITE);
  await tick();
  key = "solo";
  settle({ mode: "mia" });
  assert.equal(await asked, "default");
  assert.deepEqual(later.toJSON(), {});
});

// The preload's page script, run in a made-up page.
function page({ protocol = "https:", answers = {} } = {}) {
  const sent = [], invoked = [];
  const listeners = { preload: [], page: [] };
  let script = "";
  const electron = {
    webFrame: { executeJavaScript: (code) => { script = code; return Promise.resolve(); } },
    ipcRenderer: {
      send: (channel, payload) => sent.push([channel, payload]),
      invoke: (channel) => { invoked.push(channel); return Promise.resolve(answers[channel]); },
    },
  };
  const location = { protocol, origin: `${protocol}//chat.example.test` };
  let side = "preload";
  const window = {
    addEventListener: (name, fn) => { if (name === "message") listeners[side].push(fn); },
    postMessage: (data) => { for (const fn of [...listeners.preload, ...listeners.page]) fn({ source: window, data }); },
    dispatchEvent: () => true,
  };
  window.top = window;
  // The preload reads these after it loads, so they stay for the test's page.
  global.window = window; global.location = location;
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
  const file = path.join(__dirname, "google-oauth-preload.cjs");
  delete require.cache[file];
  try { require(file); } finally {
    Module._load = load; delete require.cache[file];
  }
  side = "page";
  const context = vm.createContext({ window, location, navigator: { userAgent: "Chrome/132", permissions: { query: async () => ({ state: "other" }) } },
    Navigator: function Navigator() {}, EventTarget, Event, setTimeout, Promise, Object, Date, TypeError, String });
  vm.runInContext(script, context);
  return { window, sent, invoked, navigator: context.navigator };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("a page reads the person's choice as its notification permission, and what it raises after Allow goes to Mia", async () => {
  const p = page({ answers: { "miaos-browser-site-notification-state": "granted" } });
  await settle();
  const Notification = p.window.Notification;
  assert.equal(Notification.name, "Notification");
  assert.equal(Notification.permission, "granted");
  assert.equal(await Notification.requestPermission(), "granted");
  assert.equal((await p.navigator.permissions.query({ name: "notifications" })).state, "granted");
  assert.equal((await p.navigator.permissions.query({ name: "camera" })).state, "other");
  let shown = 0;
  const note = new Notification("Ana", { body: "Lunch?", tag: "t1" });
  note.onshow = () => { shown++; };
  await settle();
  assert.equal(shown, 1);
  assert.deepEqual(p.sent, [["miaos-browser-site-notification", { title: "Ana", body: "Lunch?", tag: "t1" }]]);
  assert.throws(() => new Notification(), TypeError);
});

test("an undecided page asks the person once, and a page that was not allowed raises nothing", async () => {
  const p = page({ answers: { "miaos-browser-site-notification-ask": "denied" } });
  await settle();
  const Notification = p.window.Notification;
  assert.equal(Notification.permission, "default");
  assert.equal((await p.navigator.permissions.query({ name: "notifications" })).state, "prompt");
  let failed = 0;
  new Notification("Ana").onerror = () => { failed++; };
  const answers = await Promise.all([Notification.requestPermission(), Notification.requestPermission()]);
  assert.deepEqual(answers, ["denied", "denied"]);
  assert.equal(p.invoked.filter(channel => channel.endsWith("-ask")).length, 1);
  new Notification("Ana");
  await settle();
  assert.equal(failed, 1);
  assert.deepEqual(p.sent, []);
  // A page that is not https keeps the browser's own Notification, which stays refused.
  assert.equal(page({ protocol: "http:" }).window.Notification, undefined);
});
