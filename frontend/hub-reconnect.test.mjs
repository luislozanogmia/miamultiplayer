import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('  function hubUnreachable('), source.indexOf("  window.addEventListener('online'"));

// The retry pieces, run against a fake clock and a Hub that is down, then back.
function harness() {
  const timers = [];
  const env = {
    hubChat: { error: '' }, activeWorkspaceKey: 'hub_team', opened: 0,
    hubWorkspace: () => true,
    hubFeedback: error => { env.hubChat.error = error.message; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  const make = new Function('env', `with (env) { ${block}; return { hubUnreachable, retryHubChat }; }`);
  Object.assign(env, make(env));
  env.initHubChat = () => { env.opened++; };
  return { env, timers };
}

test('a team that opens while the Hub is down keeps retrying with growing waits', () => {
  const { env, timers } = harness();
  const down = Object.assign(new Error('Can’t reach the shared team service right now. Try again in a moment.'), { status: 503 });
  env.retryHubChat(down);
  env.retryHubChat(down);
  env.retryHubChat(down);
  assert.deepEqual(timers.map(t => t.ms), [5000, 10000, 20000]);
  for (let i = 0; i < 6; i++) env.retryHubChat(down);
  assert.equal(timers.at(-1).ms, 60000, 'never waits more than a minute');
  timers.at(-1).fn();
  assert.equal(env.opened, 1, 'the retry opens the team again');
});

test('a refusal or a switched workspace does not retry', () => {
  const { env, timers } = harness();
  env.retryHubChat(Object.assign(new Error('gone'), { status: 403 }));
  assert.equal(timers.length, 0);
  env.retryHubChat(Object.assign(new Error('down'), { status: 503 }));
  env.activeWorkspaceKey = 'solo';
  timers[0].fn();
  assert.equal(env.opened, 0);
});

test('a successful open clears the error and resets the wait', () => {
  const open = source.slice(source.indexOf('  function initHubChat(){'), source.indexOf('  function hubUnreachable('));
  assert.match(open, /hubChat\.error='';hubChat\.retryWait=0;clearTimeout\(hubChat\.retryTimer\);/);
  assert.match(open, /\}\)\.catch\(retryHubChat\);/);
  assert.match(source, /window\.addEventListener\('online'/);
});
