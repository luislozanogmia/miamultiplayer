"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CALLBACK_URL, FLOW_TTL_MS, parseCallback, createClerkDesktopFlow } = require("./clerk-desktop-flow.cjs");
const state = "a".repeat(64);
const callback = `${CALLBACK_URL}?state=${state}&rotating_token_nonce=${"n".repeat(32)}`;
test("opaque nonce grammar is bounded and shared with the auth exchange", () => {
  for (const nonce of ['nonce.fixture~' + 'x'.repeat(600), 'n'.repeat(4096)]) {
    assert.deepEqual(parseCallback(`${CALLBACK_URL}?state=${state}&rotating_token_nonce=${encodeURIComponent(nonce)}`, state), { nonce });
  }
  for (const nonce of ['n'.repeat(4097), 'short', 'has spaces in nonce', 'a'.repeat(20) + '\n']) {
    assert.equal(parseCallback(`${CALLBACK_URL}?state=${state}&rotating_token_nonce=${encodeURIComponent(nonce)}`, state), null);
  }
});
test("callback requires exact scheme, host, path, state and a single nonce", () => {
  assert.ok(parseCallback(callback, state));
  assert.equal(parseCallback(callback.replace(state, "é".repeat(64)), state), null);
  for (const bad of [callback.replace("miamultiplayer:", "https:"), callback.replace("auth/", "evil/"), callback.replace("/clerk?", "/clerk/other?"), callback + "#fragment", callback + "&state=" + state, callback + "&rotating_token_nonce=other", callback.replace(state, "b".repeat(64)), "bad-url"]) {
    assert.equal(parseCallback(bad, state), null);
  }
});
test("system browser handoff completes only once and binds original flow", async () => {
  const notifications = []; let completed = 0; let opened = 0;
  const client = { startGoogle: async ({ redirectUrl }) => { assert.equal(new URL(redirectUrl).searchParams.get("state"), state); return { url: "https://accounts.google.com/o/oauth2/v2/auth" }; }, completeGoogle: async () => { completed++; return { status: "active" }; }, cancel: async () => {} };
  const flow = createClerkDesktopFlow({ client, openExternal: async () => opened++, notify: value => notifications.push(value.status), randomState: () => state });
  await flow.startGoogle();
  assert.equal(flow.status().status, "waiting", "a refreshed UI can restore its cancelable pending flow");
  await assert.rejects(flow.startGoogle(), /already open/);
  assert.equal(await flow.acceptCallback(callback.replace(state, "b".repeat(64))), false);
  assert.equal(await flow.acceptCallback(callback), true);
  assert.equal(await flow.acceptCallback(callback), false);
  assert.equal(completed, 1); assert.equal(opened, 1);
  assert.deepEqual(notifications, ["waiting", "active"]);
});
test("expired, cancelled and cold-start callbacks never authenticate", async () => {
  let clock = 1; let completed = 0;
  const client = { startGoogle: async () => ({ url: "https://accounts.google.com/o/oauth2/auth" }), completeGoogle: async () => completed++, cancel: async () => {} };
  const flow = createClerkDesktopFlow({ client, openExternal: async () => {}, now: () => clock, randomState: () => state });
  assert.equal(await flow.acceptCallback(callback), false);
  await flow.startGoogle(); clock += FLOW_TTL_MS;
  assert.equal(await flow.acceptCallback(callback), false);
  await flow.startGoogle(); await flow.cancel();
  assert.equal(await flow.acceptCallback(callback), false);
  assert.equal(completed, 0);
});
test("a returned arbitrary URL is never opened", async () => {
  let opened = false;
  const flow = createClerkDesktopFlow({ client: { startGoogle: async () => ({ url: "https://attacker.example/login" }) }, openExternal: async () => { opened = true; } });
  await assert.rejects(flow.startGoogle(), /unsupported/);
  assert.equal(opened, false);
});
