"use strict";

// Notifications a site raises in Mia's browser. A page's Notification is
// replaced in the browser preload (google-oauth-preload.cjs), so nothing a
// site raises reaches the desktop by itself: once the person allows a site,
// what it raises comes here, for Mia and her bots to act on. The choice is
// remembered per site, like the camera and microphone one.
//
// What a site says in a notification is its own words, written by whoever
// sent the message: it is handed on as data, never as an instruction.

const MAX_TITLE = 200;
const MAX_BODY = 1000;
const MAX_TAG = 200;

const clip = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

// siteOrigin(url) -> the https origin of a page, or "" for anything else.
function siteOrigin(url) {
  try {
    const origin = new URL(String(url)).origin;
    return origin.startsWith("https://") ? origin : "";
  } catch (_) {
    return "";
  }
}

// createSiteNotifications({saved, save, ask, caught, log})
//   saved  - the remembered choices, {origin: true|false}
//   save   - called after a choice changes
//   ask    - (origin) -> Promise of true (allow), false (block) or null (not now)
//   caught - ({origin, title, body, tag, at}) for each notification of an allowed site
function createSiteNotifications({ saved = {}, save = () => {}, ask = async () => null, caught = () => {}, log = () => {}, now = Date.now } = {}) {
  const decisions = new Map();
  const prompts = new Map();
  for (const [origin, allowed] of Object.entries(saved || {})) {
    if (siteOrigin(origin) === origin) decisions.set(origin, allowed === true);
  }
  const word = allowed => (allowed === true ? "granted" : allowed === false ? "denied" : "default");

  // The answer a page reads from Notification.permission.
  function state(url) {
    return word(decisions.get(siteOrigin(url)));
  }
  function decided(url) {
    return decisions.get(siteOrigin(url));
  }
  function set(url, allowed) {
    const origin = siteOrigin(url);
    if (!origin) return false;
    decisions.set(origin, allowed === true);
    save();
    return true;
  }
  // A page asked to notify: the remembered choice, or the person's answer.
  // One question per site at a time; Not Now is asked again next time.
  function request(url) {
    const origin = siteOrigin(url);
    if (!origin) return Promise.resolve("denied");
    if (decisions.has(origin)) return Promise.resolve(word(decisions.get(origin)));
    if (prompts.has(origin)) return prompts.get(origin);
    const prompt = Promise.resolve().then(() => ask(origin)).then((answer) => {
      prompts.delete(origin);
      if (answer === true || answer === false) set(origin, answer);
      return word(answer === true ? true : answer === false ? false : undefined);
    }, () => {
      prompts.delete(origin);
      return "default";
    });
    prompts.set(origin, prompt);
    return prompt;
  }
  // A page raised a notification. Only an allowed site's is taken, and only
  // its words, cut to size.
  function receive(url, payload) {
    const origin = siteOrigin(url);
    if (!origin || decisions.get(origin) !== true) return null;
    const title = clip(payload && payload.title, MAX_TITLE);
    const body = clip(payload && payload.body, MAX_BODY);
    if (!title && !body) return null;
    const notification = { origin, title, body, tag: clip(payload && payload.tag, MAX_TAG), at: now() };
    // The log says that one came and how long it was, never what it said.
    log(`browser site notification caught: ${origin} (title ${title.length}, body ${body.length})`);
    try { caught(notification); } catch (error) { log(`browser site notification handler failed: ${error.message}`); }
    return notification;
  }
  // A tab on an allowed site is being listened to, so it must stay awake.
  function listening(url) {
    return decisions.get(siteOrigin(url)) === true;
  }
  return { state, decided, set, request, receive, listening, toJSON: () => Object.fromEntries(decisions) };
}

module.exports = { createSiteNotifications, siteOrigin, MAX_TITLE, MAX_BODY };
