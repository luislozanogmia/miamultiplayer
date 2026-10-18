import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = path.join(path.dirname(fileURLToPath(import.meta.url)), 'miaos-ghost-cli.py');

// A stand-in for Ghost's socket transport that echoes the request it would send.
function runGhostCli(args, env) {
  const home = mkdtempSync(path.join(tmpdir(), 'miaos-ghost-cli-'));
  try {
    writeFileSync(path.join(home, 'in_app_browser_transport.py'), [
      'class InAppBrowserTransport:',
      '    def __init__(self, socket_path, token): pass',
      '    def call(self, method, params=None, timeout=None):',
      '        return {"method": method, "params": params or {}}',
      '',
    ].join('\n'));
    writeFileSync(path.join(home, 'token'), 'test-token\n');
    const output = execFileSync('python3', ['-I', adapter, ...args], {
      env: {
        PATH: process.env.PATH,
        GHOST_CLI_HOME: home,
        GHOST_IN_APP_BROWSER_SOCKET: path.join(home, 'bridge.sock'),
        GHOST_IN_APP_BROWSER_TOKEN_FILE: path.join(home, 'token'),
        ...env,
      },
      encoding: 'utf8',
    });
    return JSON.parse(output);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('ghost-cli tells the app which Hermes session sent a browser call', () => {
  const sent = runGhostCli(['call', 'ghost_navigate', '--arguments', '{"url":"example.com"}'],
    { HERMES_UI_SESSION_ID: 'session-123' });
  assert.deepEqual(sent, { method: 'navigate', params: { url: 'example.com', actor_session: 'session-123' } });
});

test('ghost-cli never forwards a session the model wrote into its arguments', () => {
  const forged = runGhostCli(['call', 'ghost_navigate', '--arguments', '{"url":"example.com","actor_session":"other"}'], {});
  assert.deepEqual(forged, { method: 'navigate', params: { url: 'example.com' } });
});

test('ghost-cli lets a bot check its downloads in the app', () => {
  const sent = runGhostCli(['call', 'ghost_downloads', '--arguments', '{"wait_ms":5000}'],
    { HERMES_UI_SESSION_ID: 'session-123' });
  assert.deepEqual(sent, { method: 'downloads', params: { wait_ms: 5000, actor_session: 'session-123' } });
});
