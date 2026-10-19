import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');
const {
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_HERMES_PROFILE,
  CLAUDE_SUBSCRIPTION_PLUGIN,
  CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE,
  GHOST_FIRST_PLUGIN,
  GOOGLE_WORKSPACE_MCP_SERVER,
  GOOGLE_WORKSPACE_MCP_TOOLS,
  googleWorkspaceToolsConfigured,
  provisionHermesRuntimeProfiles,
  setHermesProfileModel,
} = require('./hermes-bot-profile');

test('Claude DirectSDK is provisioned unchanged for agent, Google-agent, and bot profiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-claude-plugin-'));
  const profilesRoot = path.join(root, 'profiles');
  try {
    provisionHermesRuntimeProfiles({ profilesRoot });
    for (const profile of [MIAOS_AGENT_HERMES_PROFILE, MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
      MIAOS_BOT_HERMES_PROFILE, MIAOS_BOT_GOOGLE_HERMES_PROFILE]) {
      const installed = path.join(profilesRoot, profile, 'plugins', CLAUDE_SUBSCRIPTION_PLUGIN);
      for (const file of ['plugin.yaml', '__init__.py', 'directsdk.py', 'directsdk_setup.py', 'LICENSE']) {
        assert.equal(
          fs.readFileSync(path.join(installed, file), 'utf8'),
          fs.readFileSync(path.join(CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE, file), 'utf8'),
          `${profile}/${file}`
        );
      }
    }

    const agentPlugin = path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'plugins', CLAUDE_SUBSCRIPTION_PLUGIN);
    const before = fs.statSync(path.join(agentPlugin, 'plugin.yaml')).mtimeMs;
    provisionHermesRuntimeProfiles({ profilesRoot });
    assert.equal(fs.statSync(path.join(agentPlugin, 'plugin.yaml')).mtimeMs, before);

    const unmanagedRoot = path.join(root, 'unmanaged-profiles');
    const unmanaged = path.join(unmanagedRoot, MIAOS_AGENT_HERMES_PROFILE, 'plugins', CLAUDE_SUBSCRIPTION_PLUGIN);
    fs.mkdirSync(unmanaged, { recursive: true });
    fs.writeFileSync(path.join(unmanaged, 'plugin.yaml'), 'user-owned');
    assert.throws(
      () => provisionHermesRuntimeProfiles({ profilesRoot: unmanagedRoot }),
      /refusing to overwrite unmanaged Hermes plugin/
    );
    assert.equal(fs.readFileSync(path.join(unmanaged, 'plugin.yaml'), 'utf8'), 'user-owned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Mia provisions agent and bot configurations in the shared Hermes runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bot-'));
  const profileRoot = path.join(root, 'profiles');
  const result = provisionHermesRuntimeProfiles({ profilesRoot: profileRoot });

  assert.equal(result.agent.profile, MIAOS_AGENT_HERMES_PROFILE);
  assert.equal(result.bot.profile, MIAOS_BOT_HERMES_PROFILE);
  assert.equal(result.changed, true);
  const agentConfig = fs.readFileSync(
    path.join(profileRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );
  assert.match(agentConfig, /toolsets:\n  - file\n  - terminal\n  - memory\n  - session_search\n  - todo\n  - clarify/);
  assert.match(agentConfig, /coding_context: off/);
  assert.doesNotMatch(agentConfig, /\n  - web\n|onepassword:\n    enabled: true|op:\/\//);
  const profileDir = path.join(profileRoot, MIAOS_BOT_HERMES_PROFILE);
  const config = fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8');
  // Full-mode bots drive the local browser through the guarded terminal, but
  // do not share the hosted-web credential scope with that terminal.
  assert.match(config, /toolsets:\n  - todo\n  - clarify\n  - terminal/);
  assert.doesNotMatch(config, /  - web\n/);
  assert.match(config, /coding_context: off/);
  assert.match(config, /max_turns: 100/);
  assert.match(agentConfig, /approvals:\n  mode: "off"/);
  assert.match(config, /approvals:\n  mode: "off"/);
  assert.match(config, /onepassword:\n    enabled: false/);
  assert.doesNotMatch(config, /file|memory|skills|op:\/\//);
  // Only Mia's own agent may write bot instructions (AGENTS.md); bot workers
  // keep Hermes' protected-instruction gate.
  assert.match(agentConfig, /security:\n  protected_instruction_files: false/);
  assert.match(
    fs.readFileSync(path.join(profileRoot, MIAOS_AGENT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8'),
    /security:\n  protected_instruction_files: false/
  );
  assert.doesNotMatch(config, /security:|protected_instruction/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(profileRoot, MIAOS_BOT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8'),
    /security:|protected_instruction/
  );
  assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(profileDir, 'config.yaml')).mode & 0o777, 0o600);

  const unchanged = provisionHermesRuntimeProfiles({ profilesRoot: profileRoot });
  assert.equal(unchanged.changed, false);
});

test('background_review defaults to enabled for gateway/agent profiles and disabled for the bot-worker profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bg-review-'));
  const profilesRoot = path.join(root, 'profiles');
  const previous = process.env.MIAOS_BACKGROUND_REVIEW;
  try {
    delete process.env.MIAOS_BACKGROUND_REVIEW;
    provisionHermesRuntimeProfiles({ profilesRoot });
    const agent = fs.readFileSync(path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const googleAgent = fs.readFileSync(path.join(profilesRoot, MIAOS_AGENT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const bot = fs.readFileSync(path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const googleBot = fs.readFileSync(path.join(profilesRoot, MIAOS_BOT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8');
    assert.match(agent, /auxiliary:\n  background_review:\n    enabled: true/);
    assert.match(googleAgent, /auxiliary:\n  background_review:\n    enabled: true/);
    assert.match(bot, /auxiliary:\n  background_review:\n    enabled: false/);
    assert.match(googleBot, /auxiliary:\n  background_review:\n    enabled: false/);
  } finally {
    if (previous === undefined) delete process.env.MIAOS_BACKGROUND_REVIEW;
    else process.env.MIAOS_BACKGROUND_REVIEW = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MIAOS_BACKGROUND_REVIEW=all enables background_review everywhere, =off disables it everywhere', () => {
  const previous = process.env.MIAOS_BACKGROUND_REVIEW;
  try {
    const allRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bg-review-all-'));
    const allProfilesRoot = path.join(allRoot, 'profiles');
    process.env.MIAOS_BACKGROUND_REVIEW = 'all';
    provisionHermesRuntimeProfiles({ profilesRoot: allProfilesRoot });
    const allBot = fs.readFileSync(path.join(allProfilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    assert.match(allBot, /auxiliary:\n  background_review:\n    enabled: true/);
    fs.rmSync(allRoot, { recursive: true, force: true });

    const offRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bg-review-off-'));
    const offProfilesRoot = path.join(offRoot, 'profiles');
    process.env.MIAOS_BACKGROUND_REVIEW = 'off';
    provisionHermesRuntimeProfiles({ profilesRoot: offProfilesRoot });
    const offAgent = fs.readFileSync(path.join(offProfilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const offBot = fs.readFileSync(path.join(offProfilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    assert.match(offAgent, /auxiliary:\n  background_review:\n    enabled: false/);
    assert.match(offBot, /auxiliary:\n  background_review:\n    enabled: false/);
    fs.rmSync(offRoot, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.MIAOS_BACKGROUND_REVIEW;
    else process.env.MIAOS_BACKGROUND_REVIEW = previous;
  }
});

test('Mia registers its bundled Google Workspace MCP tool list for Mia and all Bots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-google-'));
  const profilesRoot = path.join(root, 'profiles');
  const python = path.join(root, 'python');
  fs.writeFileSync(python, 'python');
  const previous = {
    HERMES_PYTHON: process.env.HERMES_PYTHON,
    MIA_GOOGLE_BROKER_URL: process.env.MIA_GOOGLE_BROKER_URL,
    MIA_GOOGLE_BROKER_TOKEN: process.env.MIA_GOOGLE_BROKER_TOKEN,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR,
  };
  try {
    process.env.HERMES_PYTHON = python;
    process.env.MIA_GOOGLE_BROKER_URL = 'http://127.0.0.1:54321';
    process.env.MIA_GOOGLE_BROKER_TOKEN = 't'.repeat(43);
    process.env.HOME = root;
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = path.join(root, 'google-profile');
    assert.equal(googleWorkspaceToolsConfigured(), true);
    const configuredBrokerUrl = process.env.MIA_GOOGLE_BROKER_URL;
    delete process.env.MIA_GOOGLE_BROKER_URL;
    assert.equal(googleWorkspaceToolsConfigured(), false);
    process.env.MIA_GOOGLE_BROKER_URL = configuredBrokerUrl;
    provisionHermesRuntimeProfiles({ profilesRoot });
    const agent = fs.readFileSync(path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const googleAgent = fs.readFileSync(path.join(profilesRoot, MIAOS_AGENT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const bot = fs.readFileSync(path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'), 'utf8');
    const googleBot = fs.readFileSync(path.join(profilesRoot, MIAOS_BOT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8');
    assert.doesNotMatch(agent, /mcp_servers|google_sheets_get|google_docs_create|google_slides/);
    assert.match(googleAgent, /mcp_servers:\n  google:/);
    assert.match(googleAgent, /google_sheets_get/);
    assert.match(googleAgent, /google_docs_create/);
    assert.match(googleAgent, /google_slides_add_text_slide/);
    assert.doesNotMatch(bot, /mcp_servers|MIA_GOOGLE_BROKER_URL|MIA_GOOGLE_BROKER_TOKEN/);
    assert.match(googleBot, /mcp_servers:\n  google:/);
    assert.match(googleBot, /google_gmail_list/);
    assert.match(googleBot, /google_calendar_create/);
    assert.match(googleBot, /google_drive_create/);
    assert.match(googleBot, /google_drive_update_metadata/);
    assert.match(googleBot, /google_drive_create_file/);
    assert.match(googleBot, /google_drive_update_content/);
    assert.match(googleBot, /google_drive_get_content/);
    assert.doesNotMatch(googleBot, /google_drive_trash_file/);
    assert.match(googleAgent, /google_drive_get_content/);
    for (const profile of [googleAgent, googleBot]) {
      assert.ok(profile.includes('MIA_GOOGLE_BROKER_URL: "http://127.0.0.1:54321"'));
      assert.ok(profile.includes(`MIA_GOOGLE_BROKER_TOKEN: ${JSON.stringify('t'.repeat(43))}`));
      assert.doesNotMatch(profile, /HERMES_GWS_BIN|GOOGLE_WORKSPACE_CLI_CONFIG_DIR/);
      assert.doesNotMatch(profile, /\nterminal:/, 'without a configured workspace there is no terminal setup');
      assert.match(profile, /\ntools:\n  tool_search:\n    enabled: "off"\n/, 'Google tools are shown directly, not behind tool_search');
    }
    assert.doesNotMatch(bot, /tool_search/);
    // Hermes exposes mcp__<server>__<tool>; Claude refuses names over 50.
    for (const name of GOOGLE_WORKSPACE_MCP_TOOLS) {
      const exposed = `mcp__${GOOGLE_WORKSPACE_MCP_SERVER.replace(/-/g, '_')}__${name}`;
      assert.ok(exposed.length <= 50, `${exposed} is ${exposed.length} characters`);
    }
    assert.match(googleBot, /google_sheets_get/);
    assert.match(googleBot, /google_docs_create/);
    assert.match(googleBot, /google_slides_add_text_slide/);
    // Registration is broker-based and does not inherit HOME/USERPROFILE.
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    provisionHermesRuntimeProfiles({ profilesRoot });
    const windowsBot = fs.readFileSync(path.join(profilesRoot, MIAOS_BOT_GOOGLE_HERMES_PROFILE, 'config.yaml'), 'utf8');
    assert.match(windowsBot, /mcp_servers:\n  google:/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('search-only profile configuration omits terminal setup and retains its advisory tool list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-search-only-'));
  const profilesRoot = path.join(root, 'profiles');
  const result = provisionHermesRuntimeProfiles({ profilesRoot, searchOnly: true });
  const config = fs.readFileSync(
    path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );

  assert.equal(result.changed, true);
  assert.match(config, /toolsets:\n  - web\n  - todo\n  - clarify/);
  assert.match(config, /max_turns: 200/);
  assert.doesNotMatch(config, /terminal|file|memory|session_search/);

  const botConfig = fs.readFileSync(
    path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );
  assert.doesNotMatch(botConfig, /terminal|file|memory|session_search/);
});

test('full Mia profile binds terminal work to the app workspace and shell browser guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-workspace-'));
  const profilesRoot = path.join(root, 'profiles');
  const workspaceDir = path.join(root, 'Documents', 'mia');
  try {
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir });
    const config = fs.readFileSync(
      path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
      'utf8'
    );
    const guardPath = path.join(root, 'miaos-shell-guard.sh');
    const guard = fs.readFileSync(guardPath, 'utf8');
    assert.match(config, /terminal:\n  cwd: .*Documents[\\/]mia/);
    assert.match(config, /shell_init_files:\n    - .*miaos-shell-guard\.sh/);
    assert.match(config, /auto_source_bashrc: false/);
    assert.match(guard, /open\(\) \{ miaos_block_external_browser/);
    assert.match(guard, /osascript\(\) \{ miaos_block_external_browser/);
    assert.match(guard, /firefox\(\) \{ miaos_block_external_browser/);
    assert.equal(fs.statSync(guardPath).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'AGENTS.md')), true);

    const searchOnlyRoot = path.join(root, 'search-only');
    const searchOnly = provisionHermesRuntimeProfiles({
      profilesRoot: searchOnlyRoot,
      workspaceDir: path.join(root, 'Documents', 'search-only'),
      searchOnly: true,
    });
    const searchConfig = fs.readFileSync(
      path.join(searchOnlyRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
      'utf8'
    );
    assert.equal(searchOnly.agent.changed, true);
    assert.doesNotMatch(searchConfig, /terminal:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shell browser guard blocks the reported external open command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-guard-'));
  try {
    const profilesRoot = path.join(root, 'profiles');
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir: path.join(root, 'Documents', 'mia') });
    const guardPath = path.join(root, 'miaos-shell-guard.sh');
    const result = spawnSync(
      '/bin/bash',
      ['-lc', `. "${guardPath}"; open "${path.join(root, 'report.html')}"`],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', MIAOS_HERMES_GUARD_BIN: path.join(root, 'missing') } },
    );
    assert.equal(result.status, 126);
    assert.match(result.stderr, /external browser launch is disabled/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Mia upgrades its earlier managed bot profile without blocking startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bot-upgrade-'));
  const profilesRoot = path.join(root, 'profiles');
  const botDir = path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE);
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(botDir, 'config.yaml'),
    '# Managed by MiaOS. Bots are bounded task workers, not full agents.\ntoolsets:\n  - web\n'
  );

  const result = provisionHermesRuntimeProfiles({ profilesRoot });
  assert.equal(result.changed, true);
  assert.match(
    fs.readFileSync(path.join(botDir, 'config.yaml'), 'utf8'),
    /^# Managed by Mia\. Runtime permissions are app-owned\./
  );
});

test('default runtime profiles follow HERMES_HOME for isolated installations', () => {
  const previous = process.env.HERMES_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-home-'));
  process.env.HERMES_HOME = root;
  try {
    provisionHermesRuntimeProfiles();
    assert.equal(
      fs.existsSync(path.join(root, 'profiles', MIAOS_AGENT_HERMES_PROFILE, 'config.yaml')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(root, 'profiles', MIAOS_BOT_HERMES_PROFILE, 'config.yaml')),
      true
    );
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
  }
});

test('full workspace profiles all receive the Ghost-first plugin; search-only profiles do not enable it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-ghost-first-'));
  const profiles = [MIAOS_AGENT_HERMES_PROFILE, MIAOS_BOT_HERMES_PROFILE,
    MIAOS_AGENT_GOOGLE_HERMES_PROFILE, MIAOS_BOT_GOOGLE_HERMES_PROFILE];
  try {
    const profilesRoot = path.join(root, 'profiles');
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir: path.join(root, 'Documents', 'mia') });
    for (const profile of profiles) {
      const config = YAML.parse(fs.readFileSync(path.join(profilesRoot, profile, 'config.yaml'), 'utf8'));
      assert.ok(config.plugins.enabled.includes(GHOST_FIRST_PLUGIN), profile);
      assert.ok(fs.existsSync(path.join(profilesRoot, profile, 'plugins', GHOST_FIRST_PLUGIN, '__init__.py')), profile);
      assert.equal(config.platform_toolsets, undefined, 'does not introduce a gateway CLI toolset override');
    }
    for (const [label, options] of [['search-only', { searchOnly: true, workspaceDir: path.join(root, 'search-workspace') }],
      ['no-workspace', { workspaceDir: '' }]]) {
      const profilesRoot = path.join(root, label, 'profiles');
      provisionHermesRuntimeProfiles({ profilesRoot, ...options });
      for (const profile of profiles) {
        const config = YAML.parse(fs.readFileSync(path.join(profilesRoot, profile, 'config.yaml'), 'utf8'));
        assert.equal(config.terminal, undefined, profile);
        assert.equal(config.plugins, undefined, profile);
        assert.equal(fs.existsSync(path.join(profilesRoot, profile, 'plugins', GHOST_FIRST_PLUGIN)), false, profile);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ghost-first guard refuses Hermes browser tools until ghost-cli has run in the session', (t) => {
  const plugin = path.join(path.dirname(new URL(import.meta.url).pathname), 'hermes-plugins', GHOST_FIRST_PLUGIN);
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ghost_first", sys.argv[1] + "/__init__.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
m.register(Ctx())
h = hooks["pre_tool_call"]
post = hooks["post_tool_call"]
def ran(command, session_id, status="ok"):
    h(tool_name="terminal", args={"command": command}, session_id=session_id)
    post(tool_name="terminal", args={"command": command}, session_id=session_id, status=status)
browse = lambda sid: h(tool_name="browser_navigate", args={"url": "https://linkedin.com"}, session_id=sid)
out = [
  browse("s1"),
  h(tool_name="tool_call", args={"name": "browser_exec"}, session_id="s1"),
  h(tool_name="web_search", args={"query": "x"}, session_id="s1"),
  h(tool_name="terminal", args={"command": "ghost-cli call ghost_instance_create"}, session_id="s1"),
  browse("s1"),
]
post(tool_name="terminal", args={"command": "ghost-cli call ghost_instance_create"}, session_id="s1", status="ok")
out += [browse("s1"), h(tool_name="browser_exec", args={}, session_id="s2")]
for sid, command in [("m1", "echo ghost-cli"), ("m2", "cat ~/ghost-cli.md"), ("m3", "grep -r 'ghost-cli call' ."),
                     ("m4", "true || ghost-cli call x"), ("m5", "false && ghost-cli call x"),
                     ("m6", "if false; then ghost-cli call x; fi"), ("m7", "exit 0; ghost-cli call x"),
                     ("m8", "ghost-cli() { :; }; ghost-cli"), ("m9", "true # ghost-cli call x")]:
    ran(command, sid)
    out.append(browse(sid))
ran("ghost-cli call ghost_instance_create", "b1", status="blocked")
out.append(browse("b1"))
for sid, command in [("r1", "cd /tmp; ghost-cli call x"), ("r2", "GHOST_TIMEOUT=5 /usr/local/bin/ghost-cli call x"), ("r3", "ghost-cli call x | head")]:
    ran(command, sid)
    out.append(browse(sid))
ran("ghost-cli call ghost_instance_create", "f1", status="error")
out.append(browse("f1"))
print(json.dumps(out))
`;
  const run = spawnSync('python3', ['-c', script, plugin], { encoding: 'utf8' });
  if (run.error && run.error.code === 'ENOENT') return t.skip('python3 is not installed');
  assert.equal(run.status, 0, run.stderr);
  const [first, bridged, other, ghost, beforeItRan, afterGhost, otherSession, ...rest] = JSON.parse(run.stdout);
  assert.equal(first.action, 'block');
  assert.match(first.message, /There is no ghost-cli call in this session yet\. Use ghost-cli first/);
  assert.equal(bridged.action, 'block', 'the tool_call bridge cannot reach a browser tool either');
  assert.equal(other, null);
  assert.equal(ghost, null);
  assert.equal(beforeItRan.action, 'block', 'a ghost-cli command counts only once it has run');
  assert.equal(afterGhost, null, 'after ghost-cli the built-in browser is the fallback');
  assert.equal(otherSession.action, 'block', 'each session tries ghost-cli first');
  const [echo, cat, grep, orElse, andThen, inIf, afterExit, asFunction, inComment, blocked, chained, prefixed, piped, failed] = rest;
  for (const [label, result] of [['echo', echo], ['cat', cat], ['grep', grep], ['a comment', inComment]]) {
    assert.equal(result.action, 'block', `${label} only mentions ghost-cli`);
  }
  for (const [label, result] of [['after ||', orElse], ['after &&', andThen], ['inside if', inIf], ['after exit', afterExit], ['a function named ghost-cli', asFunction]]) {
    assert.equal(result.action, 'block', `ghost-cli ${label} may never have run`);
  }
  assert.equal(blocked.action, 'block', 'a blocked ghost-cli call never ran');
  for (const [label, result] of [['after cd ;', chained], ['with env and full path', prefixed], ['piped', piped]]) {
    assert.equal(result, null, `ghost-cli ${label} is a real attempt`);
  }
  assert.equal(failed, null, 'a ghost-cli run that failed still unlocks the fallback');
});

test('the latest turn model becomes the profile default and survives re-provisioning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-profile-model-'));
  const profilesRoot = path.join(root, 'profiles');
  try {
    provisionHermesRuntimeProfiles({ profilesRoot });
    const agentConfig = path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml');
    const botConfig = path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml');
    // No turn yet: no guessed default.
    assert.doesNotMatch(fs.readFileSync(agentConfig, 'utf8'), /^model:/m);

    assert.equal(setHermesProfileModel(MIAOS_AGENT_HERMES_PROFILE,
      { provider: 'openai-codex', model: 'gpt-5.6-luna' }, { profilesRoot }), true);
    let config = fs.readFileSync(agentConfig, 'utf8');
    assert.match(config, /^# Managed by Mia[^\n]*\nmodel:\n  default: "gpt-5\.6-luna"\n  provider: "openai-codex"\ntoolsets:/);
    // Only the turn's own profile changes.
    assert.doesNotMatch(fs.readFileSync(botConfig, 'utf8'), /^model:/m);
    // The same model again is a no-op; a new pick replaces the block.
    assert.equal(setHermesProfileModel(MIAOS_AGENT_HERMES_PROFILE,
      { provider: 'openai-codex', model: 'gpt-5.6-luna' }, { profilesRoot }), false);
    assert.equal(setHermesProfileModel(MIAOS_AGENT_HERMES_PROFILE,
      { provider: 'deepseek', model: 'deepseek-flash' }, { profilesRoot }), true);
    config = fs.readFileSync(agentConfig, 'utf8');
    assert.equal(config.match(/^model:/gm).length, 1);
    assert.match(config, /default: "deepseek-flash"\n  provider: "deepseek"/);

    // Boot-time provisioning keeps the recorded model.
    provisionHermesRuntimeProfiles({ profilesRoot });
    assert.match(fs.readFileSync(agentConfig, 'utf8'), /default: "deepseek-flash"\n  provider: "deepseek"/);

    // Incomplete or unsafe selections and unmanaged configs are ignored.
    assert.equal(setHermesProfileModel(MIAOS_AGENT_HERMES_PROFILE, { model: 'x' }, { profilesRoot }), false);
    assert.equal(setHermesProfileModel(MIAOS_AGENT_HERMES_PROFILE,
      { provider: 'deepseek', model: 'a\nmodel: evil' }, { profilesRoot }), false);
    assert.equal(setHermesProfileModel('../escape', { provider: 'p', model: 'm' }, { profilesRoot }), false);
    fs.writeFileSync(botConfig, 'model: mine\n');
    assert.equal(setHermesProfileModel(MIAOS_BOT_HERMES_PROFILE, { provider: 'p', model: 'm' }, { profilesRoot }), false);
    assert.equal(fs.readFileSync(botConfig, 'utf8'), 'model: mine\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('Google workspace profiles keep browser guards and MCP registration through provider switches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-google-browser-switch-'));
  const profilesRoot = path.join(root, 'profiles'), workspaceDir = path.join(root, 'workspace');
  const profiles = [MIAOS_AGENT_GOOGLE_HERMES_PROFILE, MIAOS_BOT_GOOGLE_HERMES_PROFILE];
  const previous = new Map(['HERMES_PYTHON', 'MIA_GOOGLE_BROKER_URL', 'MIA_GOOGLE_BROKER_TOKEN'].map(key => [key, process.env[key]]));
  const python = path.join(root, 'fixture-python'); fs.writeFileSync(python, 'fixture only');
  process.env.HERMES_PYTHON = python;
  process.env.MIA_GOOGLE_BROKER_URL = 'http://127.0.0.1:54321';
  process.env.MIA_GOOGLE_BROKER_TOKEN = 't'.repeat(43);
  try {
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir });
    for (const selection of [{ provider: 'openai-codex', model: 'gpt-5.6-luna' }, { provider: 'deepseek', model: 'deepseek-flash' }]) {
      for (const profile of profiles) assert.equal(setHermesProfileModel(profile, selection, { profilesRoot }), true);
      provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir });
      for (const profile of profiles) {
        const config = YAML.parse(fs.readFileSync(path.join(profilesRoot, profile, 'config.yaml'), 'utf8'));
        assert.deepEqual(config.model, { default: selection.model, provider: selection.provider });
        assert.equal(config.terminal.cwd, workspaceDir);
        assert.equal(config.terminal.auto_source_bashrc, false);
        assert.equal(config.terminal.shell_init_files.length, 1);
        const guardPath = config.terminal.shell_init_files[0];
        const guard = spawnSync('/bin/bash', ['-c', '. "$1"; open "$2"', 'mia-guard-test', guardPath, path.join(workspaceDir, 'report.html')],
          { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
        assert.equal(guard.status, 126, profile);
        assert.match(guard.stderr, /external browser launch is disabled/i);
        assert.ok(config.plugins.enabled.includes(GHOST_FIRST_PLUGIN), profile);
        assert.ok(config.mcp_servers.google.tools.include.includes('google_sheets_get'), 'MCP registration survives model/provider changes');
        assert.equal(config.platform_toolsets, undefined, 'top-level lists do not change the approved gateway defaults');
        const plugin = path.join(profilesRoot, profile, 'plugins', GHOST_FIRST_PLUGIN, '__init__.py');
        const check = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("installed_ghost_guard", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
m.register(Ctx())
result = hooks["pre_tool_call"](tool_name="browser_navigate", args={"url":"https://example.test"}, session_id="fixture-session")
print(json.dumps({"blocked":result.get("action") == "block"}))
`, plugin], { encoding: 'utf8' });
        assert.equal(check.status, 0, 'installed Google-profile plugin runs');
        assert.equal(JSON.parse(check.stdout).blocked, true);
      }
    }
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
