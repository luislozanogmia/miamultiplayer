'use strict';

// A compact, plain-text map of the whole product — every page and what a
// user does there, plus the platform-level capabilities agents themselves
// have. This rides on every inference call (fast replies AND background
// hermes tasks), so it stays deliberately tight: derived from the real nav
// structure in frontend/app.js (LAYER_PANELS/WORKSPACE_PANELS) rather than
// invented, but described in prose, not dumped as raw route names. Update
// this alongside any nav change in app.js so agents never describe a page
// that no longer exists (or miss one that's new).
//
// This is enforced, not just requested: smoke.sh runs
// verify-platform-map-coverage.js, which pulls every page label straight
// out of frontend/app.js's WORKSPACE_PANELS/LAYER_PANELS definitions and
// fails the suite if any of them has no trace in buildPlatformMap()'s
// output below. Add a page to the nav without describing it here and smoke
// breaks on purpose — that's the whole point of the guard.
const { INSTANCE_NAME, INSTANCE_TEAM_DESCRIPTION } = require('./instance');

// Returns the labeled section (header + tree) as one string — callers just
// drop this in as its own paragraph, no extra wrapping needed. Header is
// parameterized off instance config, never hardcoded to any one client's
// vertical (this template runs as a generic operating system by default).
function buildPlatformMap() {
  return [
    `${INSTANCE_NAME} — an operating system for ${INSTANCE_TEAM_DESCRIPTION}. Product map, every page of the platform:`,
    'Chat',
    '  Conversations — talk with Mia, bots, and people; conversations persist across restarts',
    'Bots',
    '  Manage Bots — describe a recurring or on-demand job in plain language, then edit its instructions and schedule',
    'Connected apps',
    '  Plugins — connect user-owned services; authoritative connection state is supplied separately to Mia',
    'Elsewhere',
    '  Settings drawer — display name, personal API key, data-sharing toggles, replay the first-run tour',
    '  Login — email + password, gated to configured company domains',
    'Platform capabilities every agent has:',
    '  TASK: handoff — routes a request to a real background run with browsing/email/terminal tools; live progress relays into the room\'s thread',
    '  @-mention handoffs — Mia routes work to the right named bot by @-mentioning it',
    '  Per-user workspaces — each user\'s bots, departments, and conversations remain scoped to their workspace',
    '  Live refresh — every session polls for updates every few seconds, so all views stay current without a manual reload',
  ].join('\n');
}

module.exports = { buildPlatformMap };
