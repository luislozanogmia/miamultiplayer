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
const MIAOS_BOT_GOOGLE_HERMES_PROFILE = 'miaos-bot-google-worker';
const CLAUDE_SUBSCRIPTION_PLUGIN = 'claude-subscription-directsdk-experimental';
const CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE = path.join(__dirname, 'hermes-plugins', CLAUDE_SUBSCRIPTION_PLUGIN);
// Refuses Hermes' own browser tools until the session has tried ghost-cli.
const GHOST_FIRST_PLUGIN = 'mia-ghost-first';
const FULL_AGENT_TOOLSETS = Object.freeze(['file', 'terminal', 'memory', 'session_search', 'todo', 'clarify']);
const SEARCH_ONLY_TOOLSETS = Object.freeze(['web', 'todo', 'clarify']);
const GOOGLE_WORKSPACE_MCP_TOOLS = Object.freeze([
  'google_gmail_list',
  'google_gmail_get',
  'google_gmail_send',
  'google_gmail_modify',
  'google_gmail_labels',
  'google_gmail_create_draft',
  'google_calendar_list',
  'google_calendar_get',
  'google_calendar_create',
  'google_drive_list',
  'google_drive_get',
  'google_drive_get_content',
  'google_drive_create',
  'google_drive_update_metadata',
  'google_drive_create_file',
  'google_drive_update_content',
  'google_sheets_get',
  'google_sheets_create',
  'google_sheets_update',
  'google_sheets_append',
  'google_sheets_add_tab',
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
  const brokerUrl = String(process.env.MIA_GOOGLE_BROKER_URL || '').trim();
  const brokerToken = String(process.env.MIA_GOOGLE_BROKER_TOKEN || '').trim();
  if (!python || !/^http:\/\/127\.0\.0\.1:\d+$/.test(brokerUrl)
      || !/^[A-Za-z0-9_-]{43}$/.test(brokerToken)) return [];
  const server = path.join(__dirname, 'mia-google-workspace-mcp.py');
  if (!fs.existsSync(python) || !fs.existsSync(server)) return [];
  return [
    'mcp_servers:',
    '  mia-google-workspace:',
    `    command: ${JSON.stringify(python)}`,
    '    args:',
    `      - ${JSON.stringify(server)}`,
    '    env:',
    `      MIA_GOOGLE_BROKER_URL: ${JSON.stringify(brokerUrl)}`,
    `      MIA_GOOGLE_BROKER_TOKEN: ${JSON.stringify(brokerToken)}`,
    '    tools:',
    '      include:',
    ...GOOGLE_WORKSPACE_MCP_TOOLS.map((name) => `        - ${name}`),
  ];
}

// Hermes' background_review auxiliary (agent/background_review.py) forks a
// second LLM call after every turn to self-improve memory/skills. It reads
// auxiliary.background_review.enabled from whichever config.yaml is active
// for the live session — and Hermes scopes HERMES_HOME to the session's
// profile directory for the turn's whole lifetime (tui_gateway sets a
// context-local override per profile, and the background-review thread
// explicitly carries that context via propagate_context_to_thread), so a
// per-profile config.yaml value is a real per-target switch, not a hack.
// Mia never configured this key before, so every profile silently ran
// Hermes' fail-open default (enabled). MIAOS_BACKGROUND_REVIEW selects the
// policy: 'gateway' (default) keeps it on for Mia's own gateway/agent
// profiles and off for the bounded bot-worker profile; 'all' keeps it on
// everywhere; 'off' disables it everywhere.
function backgroundReviewMode() {
  const raw = String(process.env.MIAOS_BACKGROUND_REVIEW || '').trim().toLowerCase();
  return raw === 'all' || raw === 'off' ? raw : 'gateway';
}

function backgroundReviewEnabledForGateway() {
  return backgroundReviewMode() !== 'off';
}

function backgroundReviewEnabledForBot() {
  return backgroundReviewMode() === 'all';
}

// Every chat or automation turn pins its own model. Hermes work that runs
// outside a turn (goal judge, background review, cron jobs created by the
// agent itself) falls back to the profile's model block, so Mia records the
// model of the latest turn there. Until a turn runs there is no block: a
// guessed default could route to a provider the user never connected.
function profileModelBlock(selection) {
  const model = String((selection && selection.model) || '').trim();
  const provider = String((selection && selection.provider) || '').trim();
  if (!model || !provider || /[\r\n]/.test(model + provider)) return [];
  return ['model:', `  default: ${JSON.stringify(model)}`, `  provider: ${JSON.stringify(provider)}`];
}

// The model block a previous turn wrote, so re-provisioning at boot keeps it.
function existingProfileModel(config) {
  const lines = String(config || '').split('\n');
  const start = lines.indexOf('model:');
  if (start < 0) return null;
  const read = (key) => {
    for (let index = start + 1; index < lines.length && lines[index].startsWith('  '); index += 1) {
      const match = lines[index].match(new RegExp(`^  ${key}: (".*")$`));
      if (match) {
        try { return JSON.parse(match[1]); } catch (_) { return ''; }
      }
    }
    return '';
  };
  const selection = { model: read('default'), provider: read('provider') };
  return selection.model && selection.provider ? selection : null;
}

function runtimeProfileConfig({
  toolsets, maxTurns, terminal, googleWorkspace = false, backgroundReview, editsBots = false, model = null,
}) {
  const lines = [
    MANAGED_MARKER,
    ...profileModelBlock(model),
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
    'auxiliary:',
    '  background_review:',
    `    enabled: ${backgroundReview === true ? 'true' : 'false'}`,
  ];
  if (editsBots) {
    // Mia's own agent creates and edits bots, whose instructions live in
    // each bot's AGENTS.md. Hermes gates every AGENTS.md write behind a
    // human approval that Mia cannot show yet, so the write always failed.
    // Only Mia's agent profiles turn the gate off; the bot-worker profile
    // keeps Hermes' default.
    lines.push(
      'security:',
      '  protected_instruction_files: false',
    );
  }
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
  if (terminal && terminal.cwd) {
    // Only profiles with a terminal can run ghost-cli, so only they get the
    // ghost-first guard; elsewhere it would lock the browser fallback away.
    lines.push(
      'plugins:',
      '  enabled:',
      `    - ${GHOST_FIRST_PLUGIN}`,
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

function provisionBundledPlugin(profileDir, plugin) {
  const source = path.join(__dirname, 'hermes-plugins', plugin);
  if (!fs.existsSync(path.join(source, 'plugin.yaml'))) {
    throw new Error(`Mia bundled Hermes plugin is missing: ${plugin}`);
  }
  const pluginsDir = path.join(profileDir, 'plugins');
  const destination = path.join(pluginsDir, plugin);
  const markerName = 'MIAOS_PLUGIN_PROVENANCE.json';
  const sourceMarker = fs.readFileSync(path.join(source, markerName), 'utf8');
  const destinationMarker = path.join(destination, markerName);
  fs.mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    let installedMarker = '';
    try { installedMarker = fs.readFileSync(destinationMarker, 'utf8'); } catch (_) { /* unmanaged */ }
    if (!installedMarker) {
      throw new Error(`refusing to overwrite unmanaged Hermes plugin: ${plugin}`);
    }
    if (installedMarker === sourceMarker) return destination;
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
  fs.chmodSync(destination, 0o700);
  return destination;
}

function provisionRuntimeProfile({
  profilesRoot, profile, toolsets, maxTurns, terminal, googleWorkspace = false, backgroundReview, editsBots = false,
}) {
  const profileDir = path.join(profilesRoot, profile);
  const configPath = path.join(profileDir, 'config.yaml');
  const envPath = path.join(profileDir, '.env');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = runtimeProfileConfig({
    toolsets, maxTurns, terminal, googleWorkspace, backgroundReview, editsBots,
    model: existing.startsWith(MANAGED_MARKER) ? existingProfileModel(existing) : null,
  });

  const ownedByMia = existing.startsWith(MANAGED_MARKER)
    || LEGACY_MANAGED_MARKERS.some((marker) => existing.startsWith(marker));
  if (existing && !ownedByMia) {
    throw new Error(`refusing to overwrite unmanaged Hermes profile: ${profile}`);
  }

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  provisionBundledPlugin(profileDir, CLAUDE_SUBSCRIPTION_PLUGIN);
  if (terminal && terminal.cwd) provisionBundledPlugin(profileDir, GHOST_FIRST_PLUGIN);
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

// Record the latest turn's model as the profile default. Only Mia-managed
// configs are touched; returns true when the file changed.
function setHermesProfileModel(profile, selection, { profilesRoot = path.join(hermesHome(), 'profiles') } = {}) {
  const block = profileModelBlock(selection);
  if (!block.length || !/^[a-z0-9-]+$/.test(String(profile || ''))) return false;
  const configPath = path.join(profilesRoot, profile, 'config.yaml');
  let existing;
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (_) { return false; }
  if (!existing.startsWith(MANAGED_MARKER)) return false;
  const lines = existing.split('\n');
  const start = lines.indexOf('model:');
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end += 1;
    lines.splice(start, end - start);
  }
  lines.splice(1, 0, ...block);
  const next = lines.join('\n');
  if (next === existing) return false;
  writeAtomic(configPath, next, 0o600);
  return true;
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
  // Ordinary bot work may use the guarded terminal. Google tools live in a
  // separate no-terminal profile so the model cannot bypass their curated
  // MCP surface to inspect or invoke raw credential machinery.
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_BOT_HERMES_PROFILE,
    toolsets: searchOnly ? ['web', 'todo', 'clarify'] : ['todo', 'clarify', 'terminal'],
    maxTurns: 100,
    terminal: guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }),
    backgroundReview: backgroundReviewEnabledForBot(),
  });
}

function provisionHermesGoogleBotProfile({
  profilesRoot = path.join(hermesHome(), 'profiles'),
  searchOnly = MIAOS_AGENT_SEARCH_ONLY,
} = {}) {
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_BOT_GOOGLE_HERMES_PROFILE,
    toolsets: searchOnly ? ['web', 'todo', 'clarify'] : ['memory', 'todo', 'clarify'],
    maxTurns: 100,
    terminal: undefined,
    googleWorkspace: true,
    backgroundReview: backgroundReviewEnabledForBot(),
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
    backgroundReview: backgroundReviewEnabledForGateway(),
    editsBots: !searchOnly,
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
  return provisionRuntimeProfile({
    profilesRoot,
    profile: MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
    toolsets: searchOnly ? SEARCH_ONLY_TOOLSETS : ['memory', 'session_search', 'todo', 'clarify'],
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal: undefined,
    googleWorkspace: true,
    backgroundReview: backgroundReviewEnabledForGateway(),
    editsBots: !searchOnly,
  });
}

function provisionHermesRuntimeProfiles(options = {}) {
  const agent = provisionHermesAgentProfile(options);
  const googleAgent = provisionHermesGoogleAgentProfile(options);
  const bot = provisionHermesBotProfile(options);
  const googleBot = provisionHermesGoogleBotProfile(options);
  return { agent, googleAgent, bot, googleBot,
    changed: agent.changed || googleAgent.changed || bot.changed || googleBot.changed };
}

module.exports = {
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_HERMES_PROFILE,
  EFFECTIVE_RELEASE_PROFILE,
  MIAOS_RELEASE_PROFILE,
  MIAOS_AGENT_SEARCH_ONLY,
  MIAOS_AGENT_MAX_TURNS,
  FULL_AGENT_TOOLSETS,
  SEARCH_ONLY_TOOLSETS,
  GOOGLE_WORKSPACE_MCP_TOOLS,
  CLAUDE_SUBSCRIPTION_PLUGIN,
  CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE,
  SHELL_GUARD,
  backgroundReviewMode,
  backgroundReviewEnabledForGateway,
  backgroundReviewEnabledForBot,
  runtimeProfileConfig,
  setHermesProfileModel,
  GHOST_FIRST_PLUGIN,
  provisionBundledPlugin,
  provisionHermesAgentProfile,
  provisionHermesGoogleAgentProfile,
  provisionHermesBotProfile,
  provisionHermesGoogleBotProfile,
  provisionHermesRuntimeProfiles,
};
