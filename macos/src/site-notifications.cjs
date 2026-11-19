"use strict";

// Notifications a site raises in Mia's browser. A page's Notification is
// replaced in the browser preload (google-oauth-preload.cjs), so nothing a
// site raises reaches the desktop by itself. Once the person chooses for a
// site, what it raises goes where they said:
//   mia     - posted in Mia's chat in that workspace
//   bot     - posted in the chosen bot's chat in that workspace
//   desktop - shown on the desktop only (Allow)
//   block   - dropped, and the page is told it may not notify
// The choice is remembered per site, like the camera and microphone one, and
// belongs to the workspace it was made in: for now a site's notifications are
// on in one workspace only, so in any other workspace the site acts as if the
// person had answered Not Now, without being asked.
//
// What a site says in a notification is its own words, written by whoever
// sent the message: it is handed on as data, never as an instruction.

const MAX_TITLE = 200;
const MAX_BODY = 1000;
const MAX_TAG = 200;
const MODES = new Set(["mia", "bot", "desktop", "block"]);

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

const validWorkspace = value => typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value);

// A saved or answered choice, checked; null for anything else. Choices saved
// before they named a mode or a workspace (true/false) were Solo's.
function normalizeDecision(value) {
  if (value === true) return { mode: "desktop", workspace: "solo" };
  if (value === false) return { mode: "block", workspace: "solo" };
  if (!value || typeof value !== "object" || !MODES.has(value.mode)) return null;
  const workspace = validWorkspace(value.workspace) ? value.workspace : "solo";
  if (value.mode !== "bot") return { mode: value.mode, workspace };
  const botId = clip(value.botId, 200);
  if (!botId) return null;
  return { mode: "bot", workspace, botId, botName: clip(value.botName, 120) };
}

// createSiteNotifications({saved, save, ask, caught, deliver, workspace, log})
//   saved     - the remembered choices, {origin: decision}
//   save      - called after a choice changes
//   workspace - () -> the workspace the browser shows now ("solo" or a company's key)
//   ask       - (origin, workspace) -> Promise of {mode, botId?, botName?}, or null (Not Now)
//   caught    - ({origin, title, body, tag, at}) for each notification shown on the desktop
//   deliver   - (notification, decision) -> Promise, posting it in Mia's or a bot's chat;
//               a rejection with code BOT_UNAVAILABLE forgets the choice (as Not Now)
function createSiteNotifications({
  saved = {}, save = () => {}, ask = async () => null, caught = () => {}, deliver = async () => {},
  workspace = () => "solo", log = () => {}, now = Date.now,
} = {}) {
  const decisions = new Map();
  const prompts = new Map();
  for (const [origin, value] of Object.entries(saved || {})) {
    const decision = normalizeDecision(value);
    if (siteOrigin(origin) === origin && decision) decisions.set(origin, decision);
  }
  const current = () => {
    try { const key = workspace(); return validWorkspace(key) ? key : "solo"; } catch (_) { return "solo"; }
  };
  // The site's choice when it was made in the workspace on screen.
  function here(origin) {
    const decision = decisions.get(origin);
    return decision && decision.workspace === current() ? decision : undefined;
  }
  // A choice made in another workspace: this one acts as Not Now.
  function elsewhere(origin) {
    const decision = decisions.get(origin);
    return Boolean(decision && decision.workspace !== current());
  }
  const word = decision => (!decision ? "default" : decision.mode === "block" ? "denied" : "granted");

  // The answer a page reads from Notification.permission.
  function state(url) {
    return word(here(siteOrigin(url)));
  }
  function decided(url) {
    return here(siteOrigin(url));
  }
  function setElsewhere(url) {
    return elsewhere(siteOrigin(url));
  }
  // set(url, choice) remembers a choice for this workspace; null forgets it.
  function set(url, choice) {
    const origin = siteOrigin(url);
    if (!origin) return false;
    if (choice == null) {
      if (!decisions.delete(origin)) return true;
    } else {
      const decision = normalizeDecision({ ...choice, workspace: current() });
      if (!decision) return false;
      decisions.set(origin, decision);
    }
    save();
    return true;
  }
  // A page asked to notify: the remembered choice, or the person's answer.
  // One question per site at a time; Not Now is asked again next time. A site
  // whose notifications are on in another workspace is not asked here.
  function request(url) {
    const origin = siteOrigin(url);
    if (!origin) return Promise.resolve("denied");
    if (elsewhere(origin)) return Promise.resolve("default");
    const known = here(origin);
    if (known) return Promise.resolve(word(known));
    if (prompts.has(origin)) return prompts.get(origin);
    const asked = current();
    const prompt = Promise.resolve().then(() => ask(origin, asked)).then((answer) => {
      prompts.delete(origin);
      // The person switched workspace while the question was open: Not Now.
      if (!answer || asked !== current()) return "default";
      return set(origin, answer) ? word(here(origin)) : "default";
    }, () => {
      prompts.delete(origin);
      return "default";
    });
    prompts.set(origin, prompt);
    return prompt;
  }
  // A page raised a notification. Only a site chosen in this workspace is
  // taken, and only its words, cut to size.
  function receive(url, payload) {
    const origin = siteOrigin(url);
    const decision = origin ? here(origin) : undefined;
    if (!decision || decision.mode === "block") return null;
    const title = clip(payload && payload.title, MAX_TITLE);
    const body = clip(payload && payload.body, MAX_BODY);
    if (!title && !body) return null;
    const notification = { origin, title, body, tag: clip(payload && payload.tag, MAX_TAG), at: now() };
    // The log says that one came, how long it was and where it went, never what it said.
    log(`browser site notification caught: ${origin} (title ${title.length}, body ${body.length}) -> ${decision.mode}`);
    if (decision.mode === "desktop") {
      try { caught(notification); } catch (error) { log(`browser site notification handler failed: ${error.message}`); }
      return notification;
    }
    Promise.resolve().then(() => deliver(notification, decision)).catch((error) => {
      if (error && error.code === "BOT_UNAVAILABLE") {
        // The bot is gone: stop sending, as if the person had answered Not Now.
        if (decisions.get(origin) === decision) {
          decisions.delete(origin);
          save();
        }
        log(`browser site notification stopped: ${origin} bot no longer available`);
        return;
      }
      log(`browser site notification delivery failed: ${origin} ${error && error.message ? error.message : error}`);
    });
    return notification;
  }
  // A tab on a site whose notifications go somewhere is listened to, so it
  // must stay awake.
  function listening(url) {
    const decision = here(siteOrigin(url));
    return Boolean(decision && decision.mode !== "block");
  }
  return {
    state, decided, elsewhere: setElsewhere, set, request, receive, listening,
    toJSON: () => Object.fromEntries(decisions),
  };
}

module.exports = { createSiteNotifications, siteOrigin, normalizeDecision, MAX_TITLE, MAX_BODY };
