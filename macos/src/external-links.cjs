"use strict";

// Web links the system hands to Mia when it is the default browser. They can
// arrive before the window exists, or while it is still loading, so they wait
// until the renderer can show a tab. URLs are never logged.
const MAX_HELD_LINKS = 20;

function isWebLink(value) {
  if (typeof value !== "string" || !/^https?:/i.test(value)) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch (_) {
    return false;
  }
}

function webLinksFromArgv(argv) {
  return (argv || []).filter(isWebLink);
}

function createExternalLinkQueue({ open }) {
  let held = [];
  let ready = false;
  return {
    receive(url) {
      if (ready) return void open(url);
      if (held.length < MAX_HELD_LINKS) held.push(url);
    },
    setReady(value) {
      ready = !!value;
      if (!ready) return;
      const links = held;
      held = [];
      for (const url of links) open(url);
    },
  };
}

module.exports = { MAX_HELD_LINKS, createExternalLinkQueue, isWebLink, webLinksFromArgv };
