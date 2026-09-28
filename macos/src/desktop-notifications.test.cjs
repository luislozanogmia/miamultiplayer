"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDesktopNotifications, MAC_NOTIFICATION_SETTINGS, CLICK_CHANNEL } = require("./desktop-notifications.cjs");

// A fake Electron Notification: `outcome` decides what show() emits.
function fakeNotification(outcome) {
  const created = [];
  class FakeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; created.push(this); }
    show() { setImmediate(() => (outcome === "show" ? this.emit("show") : this.emit("failed", {}, outcome))); }
  }
  FakeNotification.isSupported = () => true;
  return { FakeNotification, created };
}
function sender() {
  const sent = [];
  return { sent, isDestroyed: () => false, send: (...args) => sent.push(args) };
}

test("a shown notification clicks through to its chat and brings Mia forward", async () => {
  const { FakeNotification, created } = fakeNotification("show");
  let activated = 0;
  const notifier = createDesktopNotifications({ Notification: FakeNotification, isTrustedSender: () => true, activate: () => { activated += 1; }, openExternal: async () => {} });
  const target = sender();
  assert.equal(await notifier.show({ title: "Writer replied", body: "Draft\n is ready.", tag: "bot-b" }, target), "shown");
  assert.deepEqual(created[0].options, { title: "Writer replied", body: "Draft is ready." });
  assert.equal(notifier.liveCount(), 1, "held until clicked so the click handler survives");
  created[0].emit("click");
  assert.equal(activated, 1);
  assert.deepEqual(target.sent, [[CLICK_CHANNEL, "bot-b"]]);
  assert.equal(notifier.liveCount(), 0);
});

test("macOS refusing notifications reports blocked, other errors report failed", async () => {
  const blocked = fakeNotification("The operation couldn’t be completed. (UNErrorDomain error 1.)");
  const notifier = createDesktopNotifications({ Notification: blocked.FakeNotification, isTrustedSender: () => true, activate() {}, openExternal: async () => {} });
  assert.equal(await notifier.show({ title: "x" }, sender()), "blocked");
  assert.equal(notifier.liveCount(), 0);
  const other = fakeNotification("something else");
  const logs = [];
  const second = createDesktopNotifications({ Notification: other.FakeNotification, isTrustedSender: () => true, activate() {}, openExternal: async () => {}, log: m => logs.push(m) });
  assert.equal(await second.show({ title: "x" }, sender()), "failed");
  assert.equal(logs.length, 1);
});

test("only the main window may show notifications or open System Settings", async () => {
  const { FakeNotification, created } = fakeNotification("show");
  const opened = [];
  const handlers = {};
  createDesktopNotifications({ Notification: FakeNotification, isTrustedSender: event => event.trusted, activate() {}, openExternal: async url => opened.push(url), platform: "darwin" })
    .register({ handle: (channel, fn) => { handlers[channel] = fn; } });
  assert.equal(await handlers["miaos-notification-show"]({ trusted: false, sender: sender() }, { title: "x" }), "refused");
  assert.equal(created.length, 0);
  assert.equal(await handlers["miaos-notification-settings"]({ trusted: false }), false);
  assert.equal(await handlers["miaos-notification-settings"]({ trusted: true }), true);
  assert.deepEqual(opened, [MAC_NOTIFICATION_SETTINGS]);
});
