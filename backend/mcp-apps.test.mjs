import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apps = require('./mcp-apps');
const tempDirectories = [];
const temp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-apps-'));
  tempDirectories.push(directory);
  return directory;
};
test.after(() => { for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true }); });
const PNG = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');

test('an MCP app is a vendor server address or package, a sign-in type and a logo, with no key', () => {
  const app = apps.cleanMcpApp({ name: 'Attio CRM', description: 'Your CRM', url: 'https://mcp.example.test/mcp', auth: 'oauth', docsUrl: 'https://example.test/docs/mcp', logo: PNG });
  assert.equal(app.id, 'attio-crm');
  assert.equal(app.url, 'https://mcp.example.test/mcp');
  assert.equal(app.logo, PNG);
  for (const [input, message] of [
    [{ name: 'X', url: 'http://mcp.example.test' }, /https/],
    [{ name: 'X', url: 'https://user:pw@mcp.example.test' }, /no sign-in/],
    [{ name: 'X' }, /either the hosted server address or the package/],
    [{ name: 'X', package: 'evil; rm -rf /' }, /not a package name/],
    [{ name: 'X', package: 'pkg', runner: 'bash' }, /npx or uvx/],
    [{ name: 'X', package: 'pkg', auth: 'oauth' }, /hosted server address/],
    [{ name: 'X', url: 'https://a.test', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, /PNG, JPEG/],
    [{ name: 'X', url: 'https://a.test', logo: 'data:image/png;base64,' + Buffer.alloc(200 * 1024).toString('base64') }, /under 100 KB/],
  ]) assert.throws(() => apps.cleanMcpApp(input), message);
  assert.equal(apps.cleanMcpApp({ name: 'Attio CRM', url: 'https://a.test' }, ['attio-crm']).id, 'attio-crm-2');
});

test('Hermes gets each app as a server that names its key, never holds it', () => {
  const lines = apps.hermesMcpServerLines([
    apps.cleanMcpApp({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' }),
    apps.cleanMcpApp({ name: 'Linear', url: 'https://mcp.linear.test/sse', auth: 'key' }),
    apps.cleanMcpApp({ name: 'Notes', package: '@vendor/notes-mcp', runner: 'npx', args: ['--stdio'], auth: 'key', keyEnv: 'NOTES_TOKEN' }),
  ]).join('\n');
  assert.match(lines, /  u_attio:\n    url: "https:\/\/mcp\.example\.test\/mcp"\n    auth: oauth/);
  assert.match(lines, /  u_linear:\n    url: "https:\/\/mcp\.linear\.test\/sse"\n    headers:\n      Authorization: "Bearer \$\{MIA_MCP_LINEAR_KEY\}"/);
  assert.match(lines, /  u_notes:\n    command: "npx"\n    args:\n      - "-y"\n      - "@vendor\/notes-mcp"\n      - "--stdio"\n    env:\n      NOTES_TOKEN: "\$\{MIA_MCP_NOTES_KEY\}"/);
});

test('long app names cannot collide in Hermes when their first twelve characters match', () => {
  const first = apps.cleanMcpApp({ name: 'Company Accounting One', package: 'accounting-one' });
  const second = apps.cleanMcpApp({ name: 'Company Accounting Two', package: 'accounting-two' });
  assert.notEqual(apps.serverName(first.id), apps.serverName(second.id));
  const lines = apps.hermesMcpServerLines([first, second]).join('\n');
  assert.match(lines, new RegExp(apps.serverName(first.id) + ':'));
  assert.match(lines, new RegExp(apps.serverName(second.id) + ':'));
});

test('a key goes only into a profile .env, is replaced or removed, and is reported only as present', () => {
  const env = path.join(temp(), '.env');
  fs.writeFileSync(env, '# Mia runtime profile\nOTHER=1\n');
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'lin_abc123');
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'lin_new456');
  const text = fs.readFileSync(env, 'utf8');
  assert.equal(text.match(/MIA_MCP_LINEAR_KEY=/g).length, 1);
  assert.match(text, /OTHER=1/);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(apps.hasProfileKey(env, 'MIA_MCP_LINEAR_KEY'), true);
  assert.throws(() => apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'has space'), /no spaces/);
  assert.throws(() => apps.setProfileKey(env, 'PATH', 'x'), /not an app key name/);
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', null);
  assert.equal(apps.hasProfileKey(env, 'MIA_MCP_LINEAR_KEY'), false);
  const shown = apps.publicMcpApp(apps.cleanMcpApp({ name: 'Linear', url: 'https://mcp.linear.test', auth: 'key' }), false);
  assert.equal(shown.status, 'needs_key');
  assert.doesNotMatch(JSON.stringify(shown), /lin_|KEY|keyHeader/);
});

test('the store keeps apps across reads and refuses an unknown removal', () => {
  const store = apps.createMcpAppsStore(path.join(temp(), 'mcp-apps.json'));
  store.add({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('attio').name, 'Attio');
  assert.throws(() => store.remove('nope'), /no longer in Connected apps/);
  store.remove('attio');
  assert.equal(store.list().length, 0);
});

test('Mia\'s own profiles carry your apps in the one mcp_servers block; bots get none', () => {
  const source = fs.readFileSync(new URL('./hermes-bot-profile.js', import.meta.url), 'utf8');
  assert.match(source, /lines\.push\(\.\.\.google\.slice\(0, tools\), \.\.\.yours, \.\.\.google\.slice\(tools\)\);/);
  assert.equal((source.match(/mcpApps: searchOnly \? \[\] : mcpApps\(\),/g) || []).length, 2, 'Mia\'s two agent profiles only');
});

test('an oauth app shows where its sign-in stands; other apps are untouched by it', () => {
  const oauth = apps.cleanMcpApp({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' });
  assert.equal(apps.publicMcpApp(oauth, true).status, 'needs_sign_in');
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: false, state: 'waiting' }).status, 'signing_in');
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: true, state: null }).status, 'signed_in');
  assert.deepEqual([apps.publicMcpApp(oauth, true, { state: 'error' }).status, apps.publicMcpApp(oauth, true, { state: 'error' }).signInFailed], ['needs_sign_in', true]);
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: true, state: 'error' }).signInFailed, undefined);
  assert.equal(apps.publicMcpApp(apps.cleanMcpApp({ name: 'Wiki', url: 'https://mcp.example.test/mcp' }), true, { state: 'error' }).status, 'ready');
});

test('ElevenLabs is offered to everyone, and a saved key can be read back for Mia\u2019s voice only by name', () => {
  const offered = apps.builtInMcpApp('elevenlabs');
  assert.deepEqual([offered.name, offered.auth, offered.runner, offered.package, offered.keyEnv], ['ElevenLabs', 'key', 'uvx', 'elevenlabs-mcp', 'ELEVENLABS_API_KEY']);
  assert.equal(apps.builtInMcpApp('nope'), null);
  assert.equal(apps.publicMcpApp(offered, false).status, 'needs_key');
  // Its server gets the key by name, never by value.
  assert.match(apps.hermesMcpServerLines([offered]).join('\n'), /ELEVENLABS_API_KEY: "\$\{MIA_MCP_ELEVENLABS_KEY\}"/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-mcp-key-'));
  const env = path.join(dir, '.env');
  assert.equal(apps.readProfileKey(env, apps.keyEnvName('elevenlabs')), '');
  apps.setProfileKey(env, apps.keyEnvName('elevenlabs'), 'a-test-value');
  assert.equal(apps.readProfileKey(env, apps.keyEnvName('elevenlabs')), 'a-test-value');
  assert.equal(apps.readProfileKey(env, 'MIA_MCP_OTHER_KEY'), '');
});

// All credential strings below are synthetic fixtures, never real credentials.
test('OAuth credentials can be validated before any mutation and return only credential fields', () => {
  assert.deepEqual(apps.validateOAuthClientCredentials({ clientId: 'fixture-id', clientSecret: 'fixture-secret', extra: 'ignored' }),
    { clientId: 'fixture-id', clientSecret: 'fixture-secret' });
  for (const value of [null, undefined, [], {}, { clientId: 'fixture-id' },
    { clientId: ' fixture-id', clientSecret: 'fixture-secret' }]) {
    assert.throws(() => apps.validateOAuthClientCredentials(value), error => error instanceof apps.McpAppError && error.code === 'invalid_oauth_client');
  }
});
test('OAuth metadata validates ports and strips credentials from store and public records', () => {
  const input = { name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth',
    oauthClient: { redirectPort: 27890, clientId: 'fixture-id', clientSecret: 'fixture-secret' } };
  const app = apps.cleanMcpApp(input);
  assert.deepEqual(app.oauthClient, { redirectPort: 27890 });
  assert.doesNotMatch(JSON.stringify(app), /fixture-|clientSecret|clientId/);
  for (const value of [{}, [], 'bad', { redirectPort: '27890' }, { redirectPort: 0 },
    { redirectPort: -1 }, { redirectPort: 65536 }, { redirectPort: 1.5 }]) {
    assert.throws(() => apps.cleanMcpApp({ ...input, oauthClient: value }), /redirect port/);
  }
  assert.equal(apps.cleanMcpApp({ ...input, auth: 'none' }).oauthClient, undefined);
  const file = path.join(temp(), 'apps.json');
  const store = apps.createMcpAppsStore(file);
  store.add({ ...input, oauthClient: null });
  assert.deepEqual(store.setOAuthClient('asana', input.oauthClient).oauthClient, { redirectPort: 27890 });
  assert.deepEqual(store.get('asana').oauthClient, { redirectPort: 27890 });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fixture-|clientSecret|clientId/);
  assert.doesNotMatch(JSON.stringify(apps.publicMcpApp(store.get('asana'), false)), /fixture-|clientSecret|clientId/);
  assert.equal(store.setOAuthClient('asana', null).oauthClient, undefined);
  assert.equal(store.get('asana').oauthClient, undefined);
  assert.throws(() => store.setOAuthClient('missing', input.oauthClient), /no longer/);
  store.add({ name: 'Wiki', url: 'https://wiki.example.test' });
  assert.throws(() => store.setOAuthClient('wiki', input.oauthClient), /OAuth app/);
});

test('exact HTTPS Asana hostname or explicit metadata requires an OAuth client before sign-in', () => {
  for (const url of ['https://mcp.asana.com/v2/mcp', 'https://mcp.asana.com:443/sse', 'https://MCP.ASANA.COM/mcp']) {
    assert.equal(apps.requiresOAuthClient({ auth: 'oauth', url }), true);
  }
  for (const url of ['http://mcp.asana.com/mcp', 'https://mcp.asana.com.evil.test/mcp',
    'https://evil.test/mcp.asana.com', 'https://sub.mcp.asana.com/mcp', 'https://mcp.asana.com./mcp', 'invalid']) {
    assert.equal(apps.requiresOAuthClient({ auth: 'oauth', url }), false, url);
  }
  assert.equal(apps.requiresOAuthClient({ auth: 'none', url: 'https://mcp.asana.com/mcp' }), false);
  assert.equal(apps.requiresOAuthClient({ auth: 'oauth', url: 'https://other.test', oauthClient: { redirectPort: 27890 } }), true);
  const app = apps.cleanMcpApp({ name: 'Asana', url: 'https://mcp.asana.com/mcp', auth: 'oauth' });
  for (const options of [{}, { signedIn: true }, { state: 'waiting' }, { state: 'error' }]) {
    const shown = apps.publicMcpApp(app, false, options);
    assert.equal(shown.status, 'needs_oauth_client');
    assert.equal(shown.oauthClientRequired, true);
    assert.equal(shown.oauthClientConfigured, false);
    assert.equal(shown.oauthRedirectUri, 'http://127.0.0.1:27890/callback');
  }
  assert.equal(apps.publicMcpApp(app, false, { oauthClientConfigured: true }).status, 'needs_sign_in');
  assert.equal(apps.publicMcpApp(app, false, { oauthClientConfigured: true, signedIn: true }).status, 'signed_in');
  assert.equal(apps.publicMcpApp({ ...app, oauthClient: { redirectPort: 28000 } }, false).oauthRedirectUri, 'http://127.0.0.1:28000/callback');
});

test('nested Hermes OAuth settings reference env names and preserve automatic OAuth for other apps', () => {
  const app = apps.cleanMcpApp({ name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth',
    oauthClient: { redirectPort: 27890, clientSecret: 'fixture-secret' } });
  const lines = apps.hermesMcpServerLines([app]).join('\n');
  assert.match(lines, /    auth: oauth\n    oauth:\n      client_id: "\$\{MIA_MCP_ASANA_CLIENT_ID\}"\n      client_secret: "\$\{MIA_MCP_ASANA_CLIENT_SECRET\}"\n      redirect_port: 27890\n      token_endpoint_auth_method: client_secret_post\n      cimd: false/);
  assert.doesNotMatch(lines, /fixture-secret/);
  const automatic = apps.cleanMcpApp({ name: 'Other', url: 'https://other.test/mcp', auth: 'oauth' });
  assert.doesNotMatch(apps.hermesMcpServerLines([automatic]).join('\n'), /client_id|cimd|redirect_port/);
  assert.equal(apps.publicMcpApp(automatic, false).status, 'needs_sign_in');
  assert.equal(apps.publicMcpApp(automatic, false).oauthClientRequired, false);
});

test('OAuth profile env helpers replace both values privately and remove both without touching unrelated values', () => {
  const directory = path.join(temp(), 'profile');
  fs.mkdirSync(directory, { mode: 0o755 });
  const env = path.join(directory, '.env');
  const names = apps.oauthClientEnvNames('asana');
  assert.deepEqual(names, { clientId: 'MIA_MCP_ASANA_CLIENT_ID', clientSecret: 'MIA_MCP_ASANA_CLIENT_SECRET' });
  assert.equal(apps.oauthClientEnvNames('other-app').clientId, 'MIA_MCP_OTHER_APP_CLIENT_ID');
  assert.throws(() => apps.oauthClientEnvNames('bad\nname'), /identifier/);
  assert.throws(() => apps.oauthClientEnvNames('asana\n'), /identifier/);
  assert.equal(apps.hasProfileOAuthClient(env, 'asana'), false);
  fs.writeFileSync(env, '# retained\nOTHER=1\nMIA_MCP_ASANA_CLIENT_ID=old\nexport MIA_MCP_ASANA_CLIENT_SECRET=old\n', { mode: 0o644 });
  const credentials = { clientId: 'fixture-id_123', clientSecret: 'fixture-secret._~:/+=-' };
  assert.equal(apps.setProfileOAuthClient(env, 'asana', credentials), undefined);
  assert.equal(apps.hasProfileOAuthClient(env, 'asana'), true);
  const text = fs.readFileSync(env, 'utf8');
  assert.match(text, /# retained\nOTHER=1\n/);
  for (const [field, name] of Object.entries(names)) {
    assert.equal(text.split('\n').filter(line => line.startsWith(name + '=')).length, 1);
    assert.ok(text.includes(`${name}=${credentials[field]}\n`));
  }
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['.env']);
  apps.setProfileOAuthClient(env, 'asana', { clientId: 'fixture-replacement', clientSecret: 'fixture-replacement' });
  assert.doesNotMatch(fs.readFileSync(env, 'utf8'), /fixture-id_123|fixture-secret/);
  apps.setProfileOAuthClient(env, 'asana', null);
  assert.equal(apps.hasProfileOAuthClient(env, 'asana'), false);
  assert.doesNotMatch(fs.readFileSync(env, 'utf8'), /MIA_MCP_ASANA_CLIENT/);
  assert.match(fs.readFileSync(env, 'utf8'), /OTHER=1/);
});

test('failed atomic OAuth env replacement leaves the original intact and removes its private temporary file', (t) => {
  const directory = temp();
  const env = path.join(directory, '.env');
  fs.writeFileSync(env, 'OTHER=preserved\n');
  t.mock.method(fs, 'renameSync', () => { throw new Error('fixture-storage-failure'); });
  assert.throws(() => apps.setProfileOAuthClient(env, 'asana', {
    clientId: 'fixture-id', clientSecret: 'fixture-secret',
  }), error => error.code === 'oauth_client_storage_failed' && !/fixture-/.test(error.message));
  assert.equal(fs.readFileSync(env, 'utf8'), 'OTHER=preserved\n');
  assert.deepEqual(fs.readdirSync(directory), ['.env']);
});

test('unsafe OAuth credentials are rejected without exposing values or changing the environment', () => {
  const env = path.join(temp(), '.env');
  const baseline = 'OTHER=untouched\n';
  fs.writeFileSync(env, baseline);
  const invalid = ['', 'fixture\n', 'fixture\r', 'fixture\nINJECT=value', 'fixture space', 'fixture\t',
    'fixture"', "fixture'", 'fixture\\', 'fixture$EXPAND', 'fixture#comment', 'fixture;command',
    'fixture`command`', 'fixture\0', 'fixtureé', 'x'.repeat(4097), null, 123];
  for (const value of invalid) {
    for (const field of ['clientId', 'clientSecret']) {
      assert.throws(() => apps.setProfileOAuthClient(env, 'asana', {
        clientId: 'fixture-id', clientSecret: 'fixture-secret', [field]: value,
      }), (error) => {
        assert.equal(error.code, 'invalid_oauth_client');
        if (typeof value === 'string' && value) assert.ok(!error.message.includes(value));
        assert.doesNotMatch(error.stack, /fixture-secret|fixture-id/);
        return true;
      });
    }
  }
  assert.equal(fs.readFileSync(env, 'utf8'), baseline);
  for (const body of [
    'MIA_MCP_ASANA_CLIENT_ID=fixture-id\n',
    'MIA_MCP_ASANA_CLIENT_SECRET=fixture-secret\n',
    'MIA_MCP_ASANA_CLIENT_ID=\nMIA_MCP_ASANA_CLIENT_SECRET=fixture-secret\n',
    'MIA_MCP_ASANA_CLIENT_ID=fixture-id\nMIA_MCP_ASANA_CLIENT_SECRET="quoted"\n',
    'MIA_MCP_ASANA_CLIENT_ID=fixture-id\nMIA_MCP_ASANA_CLIENT_SECRET=fixture$EXPAND\n',
    'MIA_MCP_ASANA_CLIENT_ID=fixture-id\nMIA_MCP_ASANA_CLIENT_SECRET=fixture#comment\n',
    'MIA_MCP_ASANA_CLIENT_ID=fixture-id\nMIA_MCP_ASANA_CLIENT_ID=duplicate\nMIA_MCP_ASANA_CLIENT_SECRET=fixture-secret\n',
  ]) {
    fs.writeFileSync(env, body);
    assert.equal(apps.hasProfileOAuthClient(env, 'asana'), false);
  }
  assert.throws(() => apps.setProfileOAuthClient(path.join(env, 'unwritable'), 'asana', {
    clientId: 'fixture-id', clientSecret: 'fixture-secret',
  }), error => error.code === 'oauth_client_storage_failed' && !/fixture-/.test(error.message));
});
