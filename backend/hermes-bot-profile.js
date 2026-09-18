'use strict';

const fs = require('fs');
const path = require('path');
const { provisionMiaosWorkspace } = require('./miaos-workspace');
const {
  EFFECTIVE_RELEASE_PROFILE,
  FULL_AGENT_TURN_LIMIT,
  MIAOS_AGENT_MAX_TURNS,
  MIAOS_AGENT_SEARCH_ONLY,
  MIAOS_RELEASE_PROFILE,
  SEARCH_ONLY_TURN_LIMIT,
} = require('./release-profile');

const MIAOS_AGENT_HERMES_PROFILE = 'miaos-agent-runtime';
const MIAOS_AGENT_GOOGLE_HERMES_PROFILE = 'miaos-agent-google-runtime';
const MIAOS_BOT_HERMES_PROFILE = 'miaos-bot-worker';
const FULL_AGENT_TOOLSETS = Object.freeze(['file', 'terminal', 'memory', 'session_search', 'todo', 'clarify']);
const SEARCH_ONLY_TOOLSETS = Object.freeze(['web', 'todo', 'clarify']);
const GOOGLE_WORKSPACE_MCP_TOOLS = Object.freeze([
  'google_gmail_list',
  'google_gmail_get',
  'google_gmail_send',
  'google_calendar_list',
  'google_calendar_get',
  'google_calendar_create',
  'google_drive_list',
  'google_drive_get',
  'google_drive_create',
  'google_sheets_get',
  'google_sheets_create',
  'google_sheets_update',
  'google_sheets_append',
  'google_docs_get',
  'google_docs_create',
  'google_docs_append',
  'google_docs_replace',
  'google_slides_get',
  'google_slides_create',
  'google_slides_add_text_slide',
  'google_slides_replace_text',
]);
const MANAGED_MARKER = '# Managed by Mia. Runtime permissions are app-owned.';
const LEGACY_MANAGED_MARKERS = Object.freeze([
  '# Managed by MiaOS. Runtime permissions are app-owned.',
  '# Managed by MiaOS. Bots are bounded task workers, not full agents.',
]);

const SHELL_GUARD = `#!/bin/bash
# Managed by Mia. Keep browser launches inside the app-owned browser.
miaos_block_external_browser() {
  echo "Mia browser policy: external browser launch is disabled. Use ghost-cli and the embedded Mia browser instead." >&2
  return 126
}

if [ -n "\${MIAOS_HERMES_GUARD_BIN:-}" ] && [ -d "\${MIAOS_HERMES_GUARD_BIN}" ]; then
  case ":\${PATH:-}:" in
    *:"\${MIAOS_HERMES_GUARD_BIN}":*) ;;
    *) PATH="\${MIAOS_HERMES_GUARD_BIN}\${PATH:+:\${PATH}}"; export PATH ;;
  esac
fi

open() { miaos_block_external_browser "$@"; }
open_app() { miaos_block_external_browser "$@"; }
osascript() { miaos_block_external_browser "$@"; }
google-chrome() { miaos_block_external_browser "$@"; }
chromium() { miaos_block_external_browser "$@"; }
chromium-browser() { miaos_block_external_browser "$@"; }
firefox() { miaos_block_external_browser "$@"; }
brave() { miaos_block_external_browser "$@"; }
brave-browser() { miaos_block_external_browser "$@"; }
microsoft-edge() { miaos_block_external_browser "$@"; }
microsoft-edge-stable() { miaos_block_external_browser "$@"; }
safari() { miaos_block_external_browser "$@"; }
xdg-open() { miaos_block_external_browser "$@"; }
playwright() { miaos_block_external_browser "$@"; }
`;

function hermesHome() {
  const configured = String(process.env.HERMES_HOME || '').trim();
  if (!configured) throw new Error('Mia requires HERMES_HOME to be configured.');
  return path.resolve(configured);
}

function googleWorkspaceMcpConfig() {
  const python = String(process.env.HERMES_PYTHON || '').trim();
  const gws = String(process.env.HERMES_GWS_BIN || '').trim();
  const userHome = String(process.env.HOME || '').trim();
  if (!python || !gws || !userHome) return [];
  const server = path.join(__dirname, 'mia-google-workspace-mcp.py');
  if (!fs.existsSync(python) || !fs.existsSync(gws) || !fs.existsSync(server)) return [];
  const keyringBackend = process.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND === 'keyring'
    ? 'keyring'
    : 'file';
  return [
    'mcp_servers:',
    '  mia-google-workspace:',
    `    command: ${JSON.stringify(python)}`,
    '    args:',
    `      - ${JSON.stringify(server)}`,
    '    env:',
    `      HERMES_GWS_BIN: ${JSON.stringify(gws)}`,
    `      HOME: ${JSON.stringify(userHome)}`,
    `      GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: ${JSON.stringify(keyringBackend)}`,
    '    tools:',
    '      include:',
    ...GOOGLE_WORKSPACE_MCP_TOOLS.map((name) => `        - ${name}`),
  ];
}

function runtimeProfileConfig({ toolsets, maxTurns, terminal, googleWorkspace = false }) {
  const lines = [
    MANAGED_MARKER,
    // No model block on purpose: every dispatch pins the user's connected
    // provider and model explicitly. A profile-level default would silently
    // route model-less dispatches to a provider the user never connected.
    'toolsets:',
    ...toolsets.map((name) => `  - ${name}`),
    'agent:',
    `  max_turns: ${maxTurns}`,
    '  coding_context: off',
    '  disabled_toolsets: []',
    // Mia has no UI channel to answer Hermes approval prompts yet, so manual
    // mode stalls every gated action until it times out. Hermes's hardline
    // approval floors still block destructive commands unconditionally.
    'approvals:',
    '  mode: "off"',
    'secrets:',
    '  sources: []',
    '  onepassword:',
    '    enabled: false',
  ];
  if (terminal && terminal.cwd) {
    lines.push(
      'terminal:',
      `  cwd: ${JSON.stringify(String(terminal.cwd))}`,
      '  shell_init_files:',
      ...(Array.isArray(terminal.shellInitFiles)
        ? terminal.shellInitFiles.map((file) => `    - ${JSON.stringify(String(file))}`)
        : []),
      `  auto_source_bashrc: ${terminal.autoSourceBashrc === true ? 'true' : 'false'}`,
    );
  }
  if (googleWorkspace) lines.push(...googleWorkspaceMcpConfig());
  lines.push('');
  return lines.join('\n');
}

function writeAtomic(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed or already absent */ }
  }
}

function provisionRuntimeProfile({ profilesRoot, profile, toolsets, maxTurns, terminal, googleWorkspace = false }) {
  const profileDir = path.join(profilesRoot, profile);
  const configPath = path.join(profileDir, 'config.yaml');
  const envPath = path.join(profileDir, '.env');
  const next = runtimeProfileConfig({ toolsets, maxTurns, terminal, googleWorkspace });
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const ownedByMia = existing.startsWith(MANAGED_MARKER)
    || LEGACY_MANAGED_MARKERS.some((marker) => existing.startsWith(marker));
  if (existing && !ownedByMia) {
    throw new Error(`refusing to overwrite unmanaged Hermes profile: ${profile}`);
  }

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  for (const name of ['sessions', 'memories', 'skills', 'cron']) {
    fs.mkdirSync(path.join(profileDir, name), { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(envPath)) {
    writeAtomic(envPath, '# Mia runtime profile uses installation-scoped process credentials.\n', 0o600);
  } else {
    fs.chmodSync(envPath, 0o600);
  }
  if (existing === next) {
    fs.chmodSync(configPath, 0o600);
    return { profile, changed: false };
  }
  writeAtomic(configPath, next, 0o600);
  return { profile, changed: true };
}

// The guarded terminal both profiles share: workspace cwd plus the shell
// guard that keeps browser launches inside the app-owned Mia browser.
// Returns undefined (no terminal toolset) in search-only mode or when no
// workspace is configured.
function guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }) {
  const configuredWorkspace = workspaceDir === undefined
    ? String(process.env.MIAOS_WORKSPACE_DIR || '').trim()
    : String(workspaceDir || '').trim();
  if (!configuredWorkspace || searchOnly) return undefined;
  const workspace = provisionMiaosWorkspace({ workspaceDir: configuredWorkspace });
  const guardPath = path.join(path.dirname(path.resolve(profilesRoot)), 'miaos-shell-guard.sh');
  writeAtomic(guardPath, SHELL_GUARD, 0o700);
  return {
    cwd: workspace.workspaceDir,
    shellInitFiles: [guardPath],
    autoSourceBashrc: false,
  };
}

function provisionHermesBotProfile({
  profilesRoot = path.join(hermesHome(), 'profiles'),
  searchOnly = MIAOS_AGENT_SEARCH_ONLY,
  workspaceDir,
} = {}) {
  // Search-only releases get hosted web tools; full local releases use the
  // guarded terminal/browser bridge. Both receive the same curated Google
  // tool surface for the alpha.
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_BOT_HERMES_PROFILE,
    toolsets: searchOnly ? ['web', 'todo', 'clarify'] : ['todo', 'clarify', 'terminal'],
    maxTurns: 100,
    terminal: guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }),
    // Alpha policy: every Bot receives the same curated, non-destructive
    // Google Workspace tools. The owner connection mediates credentials;
    // raw tokens and delete/clear/trash operations are never exposed.
    googleWorkspace: true,
  });
}

function provisionHermesAgentProfile({
  profilesRoot = path.join(hermesHome(), 'profiles'),
  searchOnly = MIAOS_AGENT_SEARCH_ONLY,
  workspaceDir,
} = {}) {
  if (typeof searchOnly !== 'boolean') {
    throw new Error('Mia agent profile searchOnly must be a boolean');
  }
  if (MIAOS_AGENT_SEARCH_ONLY && !searchOnly) {
    throw new Error(
      `Mia release profile ${MIAOS_RELEASE_PROFILE} cannot disable search-only agent confinement`
    );
  }
  const terminal = guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir });
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_AGENT_HERMES_PROFILE,
    toolsets: searchOnly ? SEARCH_ONLY_TOOLSETS : FULL_AGENT_TOOLSETS,
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal,
  });
}

function provisionHermesGoogleAgentProfile({
  profilesRoot = path.join(hermesHome(), 'profiles'),
  searchOnly = MIAOS_AGENT_SEARCH_ONLY,
  workspaceDir,
} = {}) {
  if (typeof searchOnly !== 'boolean') throw new Error('Mia agent profile searchOnly must be a boolean');
  if (MIAOS_AGENT_SEARCH_ONLY && !searchOnly) {
    throw new Error(`Mia release profile ${MIAOS_RELEASE_PROFILE} cannot disable search-only agent confinement`);
  }
  const terminal = guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir });
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
    toolsets: searchOnly ? SEARCH_ONLY_TOOLSETS : FULL_AGENT_TOOLSETS,
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal,
    googleWorkspace: true,
  });
}

function provisionHermesRuntimeProfiles(options = {}) {
  const agent = provisionHermesAgentProfile(options);
  const googleAgent = provisionHermesGoogleAgentProfile(options);
  const bot = provisionHermesBotProfile(options);
  return { agent, googleAgent, bot, changed: agent.changed || googleAgent.changed || bot.changed };
}

module.exports = {
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  EFFECTIVE_RELEASE_PROFILE,
  MIAOS_RELEASE_PROFILE,
  MIAOS_AGENT_SEARCH_ONLY,
  MIAOS_AGENT_MAX_TURNS,
  FULL_AGENT_TOOLSETS,
  SEARCH_ONLY_TOOLSETS,
  GOOGLE_WORKSPACE_MCP_TOOLS,
  SHELL_GUARD,
  runtimeProfileConfig,
  provisionHermesAgentProfile,
  provisionHermesGoogleAgentProfile,
  provisionHermesBotProfile,
  provisionHermesRuntimeProfiles,
};
