'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
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
// The same two bot profiles plus the owner's own MCP apps (Asana, Attio, ...).
// A bot's turn uses one of these only when the installation owner, who added
// and signed in to those apps, is the one asking (server.js botProfileFor), so
// a teammate in a company chat never reaches the owner's sign-ins.
const MIAOS_BOT_APPS_HERMES_PROFILE = 'miaos-bot-apps-worker';
const MIAOS_BOT_GOOGLE_APPS_HERMES_PROFILE = 'miaos-bot-google-apps-worker';
const BOT_HERMES_PROFILES = Object.freeze([MIAOS_BOT_HERMES_PROFILE, MIAOS_BOT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_APPS_HERMES_PROFILE, MIAOS_BOT_GOOGLE_APPS_HERMES_PROFILE]);
// The bot profile for a turn: with Google when the asker's Google is
// connected, with MCP apps when the asker owns them.
function botProfileFor({ google = false, apps = false } = {}) {
  if (apps) return google ? MIAOS_BOT_GOOGLE_APPS_HERMES_PROFILE : MIAOS_BOT_APPS_HERMES_PROFILE;
  return google ? MIAOS_BOT_GOOGLE_HERMES_PROFILE : MIAOS_BOT_HERMES_PROFILE;
}
// Every profile that runs the owner's MCP apps, so each gets their keys and
// sign-ins: Mia's two first (the first holds the sign-ins), then the bots'.
const MCP_APP_PROFILES = Object.freeze([MIAOS_AGENT_HERMES_PROFILE, MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_APPS_HERMES_PROFILE, MIAOS_BOT_GOOGLE_APPS_HERMES_PROFILE]);
const CLAUDE_SUBSCRIPTION_PLUGIN = 'claude-subscription-directsdk-experimental';
const CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE = path.join(__dirname, 'hermes-plugins', CLAUDE_SUBSCRIPTION_PLUGIN);
// Refuses Hermes' own browser tools until the session has tried ghost-cli.
const GHOST_FIRST_PLUGIN = 'mia-ghost-first';
const ASK_BEFORE_DO_PLUGIN = 'mia-ask-before-do';
const PROVIDER_LIMITS_PLUGIN = 'mia-provider-limits';
const ASK_BEFORE_DO_TOOLSET = 'mia_ask_before_do';
// These top-level lists describe profile intent; the pinned gateway uses its
// full CLI defaults because Mia does not set platform_toolsets.cli. Google
// MCP tools are additive, not a confinement boundary for other runtime tools.
const FULL_AGENT_TOOLSETS = Object.freeze(['file', 'terminal', 'memory', 'session_search', 'todo', 'clarify']);
const SEARCH_ONLY_TOOLSETS = Object.freeze(['web', 'todo', 'clarify']);
// A bot's tools, the same in its chat and in its scheduled automations (see
// cron-sync.js scheduledBotToolsets, which adds only artifacts and step
// reports). One list, so the two can't drift apart. It names what bots use
// in chat: web search (their prompt sends them to it), files and the guarded
// terminal. No memory or session search: scheduled runs share one Hermes
// home, so those would reach other bots' notes and runs.
const BOT_FULL_TOOLSETS = Object.freeze(['web', 'file', 'terminal', 'todo', 'clarify']);
// Hermes gives every profile its full default tools (toolsets are not
// enforced), so the one tool bots must not have is taken away here: bots
// don't hand work to background subagents. Mia keeps delegation.
const BOT_DISABLED_TOOLSETS = Object.freeze(['delegation']);
function botToolsets({ searchOnly = MIAOS_AGENT_SEARCH_ONLY } = {}) {
  return [...(searchOnly ? SEARCH_ONLY_TOOLSETS : BOT_FULL_TOOLSETS)];
}
const GOOGLE_WORKSPACE_MCP_SERVER = 'google';
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
const isManagedProfileConfig = text => typeof text === 'string' && (
  text.startsWith(MANAGED_MARKER)
  || LEGACY_MANAGED_MARKERS.some(marker => text.startsWith(marker))
);
// Hermes rewrites config.yaml when it enables a plugin and drops YAML comments.
// Keep a separate, profile-specific ownership record so the next launch does
// not mistake a profile Mia just provisioned for somebody's personal profile.
const PROFILE_PROVENANCE_FILE = 'MIAOS_PROFILE_PROVENANCE.json';
const profileProvenance = profile => `${JSON.stringify({ managedBy: 'Mia', profile, schema: 1 })}\n`;

function hasProfileProvenance(profileDir) {
  const marker = path.join(profileDir, PROFILE_PROVENANCE_FILE);
  try {
    const stat = fs.lstatSync(marker);
    return stat.isFile() && stat.nlink === 1
      && fs.readFileSync(marker, 'utf8') === profileProvenance(path.basename(profileDir));
  } catch (_) { return false; }
}

function isManagedProfileDirectory(profileDir, config) {
  try {
    if (!fs.lstatSync(profileDir).isDirectory()) return false;
  } catch (_) { return false; }
  return isManagedProfileConfig(config) || hasProfileProvenance(profileDir);
}

// A separate marker proves origin, but must not make a replaced or weakened
// config safe to overwrite. Hermes' serializer retains these Mia-owned guards.
function retainsManagedProfilePosture(config, profileDir, { terminalRequired = false } = {}) {
  let parsed;
  try { parsed = YAML.parse(config); } catch (_) { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const enabled = parsed.plugins?.enabled;
  if (!Array.isArray(enabled) || ![ASK_BEFORE_DO_PLUGIN, PROVIDER_LIMITS_PLUGIN].every(name => enabled.includes(name))) return false;
  if (path.basename(profileDir).startsWith('miaos-bot-')
    && (!Array.isArray(parsed.agent?.disabled_toolsets)
      || !parsed.agent.disabled_toolsets.includes('delegation'))) return false;
  if (terminalRequired && !parsed.terminal) return false;
  if (parsed.terminal) {
    const guard = path.join(path.dirname(path.dirname(profileDir)), 'miaos-shell-guard.sh');
    if (parsed.terminal.auto_source_bashrc !== false
      || !Array.isArray(parsed.terminal.shell_init_files)
      || !parsed.terminal.shell_init_files.includes(guard)) return false;
  }
  return true;
}

function ensureProfileProvenance(profileDir) {
  const marker = path.join(profileDir, PROFILE_PROVENANCE_FILE);
  if (fs.existsSync(marker) || fs.lstatSync(marker, { throwIfNoEntry: false })) {
    if (!hasProfileProvenance(profileDir)) throw new Error(`refusing to replace unexpected Hermes profile provenance: ${path.basename(profileDir)}`);
    fs.chmodSync(marker, 0o600);
    return;
  }
  writeAtomic(marker, profileProvenance(path.basename(profileDir)), 0o600);
}

const SHELL_GUARD = `#!/bin/bash
# Managed by Mia. Keep browser launches inside the app-owned browser.
miaos_block_external_browser() {
  echo "Mia browser policy: external browser launch is disabled. Use ghost-cli and the embedded Mia browser instead. To show a folder in Finder or the file manager, use: ghost-cli call ghost_folder_open --arguments '{\\"instance_id\\":\\"miaos\\",\\"path\\":\\"/full/path\\"}'" >&2
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
  const brokerToken = String(process.env.MIA_GOOGLE_BROKER_RUN_TOKEN || '').trim();
  if (!python || !/^http:\/\/127\.0\.0\.1:\d+$/.test(brokerUrl)
      || !/^[A-Za-z0-9_-]{43}$/.test(brokerToken)) return [];
  const server = path.join(__dirname, 'mia-google-workspace-mcp.py');
  if (!fs.existsSync(python) || !fs.existsSync(server)) return [];
  return [
    'mcp_servers:',
    // Hermes names each tool mcp__<server>__<tool>, and Claude rejects tool
    // names over 50 characters, so the server name stays short.
    `  ${GOOGLE_WORKSPACE_MCP_SERVER}:`,
    `    command: ${JSON.stringify(python)}`,
    '    args:',
    `      - ${JSON.stringify(server)}`,
    // The trusted gateway recognizes this exact adapter path. Its credential
    // arrives over the private MCP pipe before initialization, never in config.
    '    tools:',
    '      include:',
    ...GOOGLE_WORKSPACE_MCP_TOOLS.map((name) => `        - ${name}`),
    // Hermes hides MCP tools behind tool_search by default, so a bot asked
    // to triage the inbox saw no Gmail tool and said it had none. Mia's
    // Google tools are a short fixed list; show them directly.
    'tools:',
    '  tool_search:',
    '    enabled: "off"',
  ];
}

// The same Google server as an object, for scheduled runs, which read it from
// the Hermes home's config.yaml (cron-sync.js). null when Google's broker is
// not running. It carries no credential: the gateway sends that over the MCP
// pipe to this exact adapter path only.
function googleWorkspaceMcpServer() {
  if (!googleWorkspaceMcpConfig().length) return null;
  return {
    command: String(process.env.HERMES_PYTHON).trim(),
    args: [path.join(__dirname, 'mia-google-workspace-mcp.py')],
    tools: { include: [...GOOGLE_WORKSPACE_MCP_TOOLS] },
  };
}

// Capability only: callers must never expose the generated config or broker
// credentials when describing available connected-app tools to a model.
function googleWorkspaceToolsConfigured() {
  return googleWorkspaceMcpConfig().length > 0;
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
//
// Every block also turns off Hermes' large-context switch confirmation: Mia
// has no way to answer it, so a chat over 100k tokens failed every turn after
// its model changed. Choosing the model is the consent. Hermes reads this key
// only from model:, which is why it is written even before a model is known.
const SWITCH_CONFIRM_OFF = '  switch_context_confirm_tokens: 0';
function validProfileModel(selection) {
  const model = String((selection && selection.model) || '').trim();
  const provider = String((selection && selection.provider) || '').trim();
  return model && provider && !/[\r\n]/.test(model + provider) ? { model, provider } : null;
}
// The helpers a turn hands work to carry most of the tokens, so on a Claude
// sign-in they run on the small model while the turn keeps its own. They stay
// on the turn's provider (Hermes inherits it when only the model is set); on
// any other provider they inherit the turn's model as before.
const CLAUDE_WORKER_MODEL = 'claude-haiku-5-5';
function profileWorkerBlock(valid) {
  return valid && valid.provider === CLAUDE_SUBSCRIPTION_PLUGIN
    ? ['delegation:', `  model: ${JSON.stringify(CLAUDE_WORKER_MODEL)}`]
    : [];
}
function profileModelBlock(selection) {
  const valid = validProfileModel(selection);
  if (!valid) return ['model:', SWITCH_CONFIRM_OFF];
  return ['model:', `  default: ${JSON.stringify(valid.model)}`, `  provider: ${JSON.stringify(valid.provider)}`, SWITCH_CONFIRM_OFF,
    ...profileWorkerBlock(valid)];
}

// The model block a previous turn wrote, so re-provisioning at boot keeps it.
function existingProfileModel(config) {
  try {
    const model = YAML.parse(String(config || ''))?.model;
    const selection = { model: model?.default, provider: model?.provider };
    return validProfileModel(selection) ? selection : null;
  } catch (_) { return null; }
}

// Every Mia profile (Mia, bots, private agents, scheduled runs) compresses at
// the same point, so a long chat behaves the same wherever it runs. This is a
// ceiling: Hermes compresses sooner for a model whose window calls for less.
const COMPRESSION_THRESHOLD_TOKENS = 300000;
function runtimeProfileConfig({
  toolsets, maxTurns, terminal, googleWorkspace = false, backgroundReview, editsBots = false, model = null, mcpApps = [],
  disabledToolsets = [],
}) {
  const lines = [
    MANAGED_MARKER,
    ...profileModelBlock(model),
    'toolsets:',
    ...toolsets.map((name) => `  - ${name}`),
    `  - ${ASK_BEFORE_DO_TOOLSET}`,
    'agent:',
    `  max_turns: ${maxTurns}`,
    '  coding_context: off',
    ...(disabledToolsets.length
      ? ['  disabled_toolsets:', ...disabledToolsets.map((name) => `    - ${name}`)]
      : ['  disabled_toolsets: []']),
    // Mia has no UI channel to answer Hermes approval prompts yet, so manual
    // mode stalls every gated action until it times out. Hermes's hardline
    // approval floors still block destructive commands unconditionally.
    'approvals:',
    '  mode: "off"',
    ...require('./hermes-runtime-secret-source').runtimeSecretSourceLines(),
    '  onepassword:',
    '    enabled: false',
    'auxiliary:',
    '  background_review:',
    `    enabled: ${backgroundReview === true ? 'true' : 'false'}`,
    // Mia compacts a chat herself, in the background while it is quiet, once
    // it has used 70% of this size (hermes-gateway-client.js). Hermes' own
    // compaction in the middle of a turn stays off: it made the person wait
    // for a summary and cut into a turn that was still working. The size and
    // the tail settings still shape the summary Mia asks Hermes for.
    // The last turns stay word for word, including the last few requests.
    // Scheduled runs keep Hermes' own compaction (cron-sync.js): a run is
    // one long turn with no quiet moment to compact in.
    'compression:',
    '  enabled: false',
    `  threshold_tokens: ${COMPRESSION_THRESHOLD_TOKENS}`,
    '  protect_last_n: 20',
    '  min_tail_user_messages: 3',
    // Mia owns what happens to work cut off by a close: it holds the message
    // and asks the person (interrupted-work.js). Hermes' own resume would
    // also re-run the turn as soon as the chat's session reopens, collide
    // with the person's next message, end at once and leave "Your request
    // was not processed" behind for a request that did run.
    'desktop:',
    '  auto_continue:',
    '    enabled: false',
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
  // Only profiles with a terminal can run ghost-cli, so only they get the
  // ghost-first guard; elsewhere it would lock the browser fallback away.
  lines.push(
    'plugins:',
    '  enabled:',
    `    - ${ASK_BEFORE_DO_PLUGIN}`,
    `    - ${PROVIDER_LIMITS_PLUGIN}`,
    ...(terminal && terminal.cwd ? [`    - ${GHOST_FIRST_PLUGIN}`] : []),
  );
  // Google's server and your own MCP apps share one mcp_servers block.
  const google = googleWorkspace ? googleWorkspaceMcpConfig() : [];
  const yours = require('./mcp-apps').hermesMcpServerLines(mcpApps);
  if (google.length) {
    const tools = google.indexOf('tools:');
    lines.push(...google.slice(0, tools), ...yours, ...google.slice(tools));
  } else if (yours.length) {
    lines.push('mcp_servers:', ...yours);
  }
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
  profilesRoot, profile, toolsets, maxTurns, terminal, googleWorkspace = false, backgroundReview, editsBots = false, mcpApps = [],
  disabledToolsets = [],
}) {
  const profileDir = path.join(profilesRoot, profile);
  const configPath = path.join(profileDir, 'config.yaml');
  const envPath = path.join(profileDir, '.env');
  const profileStat = fs.lstatSync(profileDir, { throwIfNoEntry: false });
  if (profileStat && !profileStat.isDirectory()) {
    throw new Error(`refusing non-directory Hermes profile: ${profile}`);
  }
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ownedByMia = isManagedProfileDirectory(profileDir, existing);
  if (existing && (!ownedByMia
    || (!isManagedProfileConfig(existing)
      && !retainsManagedProfilePosture(existing, profileDir, { terminalRequired: !!terminal?.cwd })))) {
    throw new Error(`refusing to overwrite unmanaged Hermes profile: ${profile}`);
  }
  const next = runtimeProfileConfig({
    toolsets, maxTurns, terminal, googleWorkspace, backgroundReview, editsBots, mcpApps, disabledToolsets,
    model: ownedByMia ? existingProfileModel(existing) : null,
  });

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  ensureProfileProvenance(profileDir);
  provisionBundledPlugin(profileDir, CLAUDE_SUBSCRIPTION_PLUGIN);
  provisionBundledPlugin(profileDir, ASK_BEFORE_DO_PLUGIN);
  provisionBundledPlugin(profileDir, PROVIDER_LIMITS_PLUGIN);
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
  if (!validProfileModel(selection) || !/^[a-z0-9-]+$/.test(String(profile || ''))) return false;
  const block = profileModelBlock(selection);
  const configPath = path.join(profilesRoot, profile, 'config.yaml');
  const profileDir = path.dirname(configPath);
  let existing;
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (_) { return false; }
  if (!isManagedProfileDirectory(profileDir, existing)
    || (!isManagedProfileConfig(existing) && !retainsManagedProfilePosture(existing, profileDir))) return false;
  const lines = (isManagedProfileConfig(existing) ? existing : `${MANAGED_MARKER}\n${existing}`).split('\n');
  const start = lines.indexOf('model:');
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end += 1;
    // The worker model written with the last pick goes with it.
    if (lines[end] === 'delegation:') {
      end += 1;
      while (end < lines.length && lines[end].startsWith('  ')) end += 1;
    }
    lines.splice(start, end - start);
  }
  lines.splice(1, 0, ...block);
  const next = lines.join('\n');
  if (next === existing) return false;
  writeAtomic(configPath, next, 0o600);
  return true;
}

// The guarded terminal all full-mode profiles share: workspace cwd plus the shell
// guard that keeps browser launches inside the app-owned Mia browser.
// Returns undefined (no workspace terminal configuration) in search-only mode or when no
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

// The same shell guard for scheduled runs, which run from the Hermes home
// rather than a profile (cron-sync.js ensureCronGuards). Search-only bots
// have no terminal, so they get none.
function cronShellGuard(home, { searchOnly = MIAOS_AGENT_SEARCH_ONLY } = {}) {
  if (searchOnly || !home) return '';
  const guardPath = path.join(path.resolve(home), 'miaos-shell-guard.sh');
  writeAtomic(guardPath, SHELL_GUARD, 0o700);
  return guardPath;
}

function provisionHermesBotProfile({
  profilesRoot = path.join(hermesHome(), 'profiles'),
  searchOnly = MIAOS_AGENT_SEARCH_ONLY,
  workspaceDir,
  google = false,
  apps = false,
} = {}) {
  // Every bot profile shares the same full-mode guarded terminal posture; the
  // Google ones add the app's Google tools, the apps ones the owner's MCP
  // apps. Search-only bots get no MCP apps, like Mia.
  return provisionRuntimeProfile({
    profilesRoot,
    profile: botProfileFor({ google, apps }),
    toolsets: botToolsets({ searchOnly }),
    disabledToolsets: [...BOT_DISABLED_TOOLSETS],
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal: guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }),
    googleWorkspace: google === true,
    backgroundReview: backgroundReviewEnabledForBot(),
    mcpApps: apps && !searchOnly ? mcpApps() : [],
  });
}

function provisionHermesGoogleBotProfile(options = {}) {
  return provisionHermesBotProfile({ ...options, google: true, apps: false });
}

// The MCP apps Mia added for you; a missing or unreadable list is none.
function mcpApps() {
  try { return require('./mcp-apps').defaultStore.list(); } catch (_) { return []; }
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
    // Your own MCP apps reach Mia's agent only, never bots.
    mcpApps: searchOnly ? [] : mcpApps(),
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
    toolsets: searchOnly ? SEARCH_ONLY_TOOLSETS : FULL_AGENT_TOOLSETS,
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal: guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }),
    googleWorkspace: true,
    backgroundReview: backgroundReviewEnabledForGateway(),
    editsBots: !searchOnly,
    // Your own MCP apps reach Mia's agent only, never bots.
    mcpApps: searchOnly ? [] : mcpApps(),
  });
}

// Personal agents (see private-agents.js) each get their own pair of Hermes
// profiles, so memory, sessions and skills are separate from Mia's and from
// every other agent. The names are derived from the agent id and can never
// equal one of the four fixed profiles above.
const PRIVATE_AGENT_ID_PATTERN = /^agent_[a-f0-9]{24}$/;
const PRIVATE_AGENT_PROFILE_PATTERN = /^miaos-agent-[a-f0-9]{24}(-google)?$/;

function privateAgentProfileName(agentId, google = false) {
  if (!PRIVATE_AGENT_ID_PATTERN.test(String(agentId || ''))) {
    throw new Error('invalid personal agent id');
  }
  return 'miaos-' + String(agentId).replace(/_/g, '-') + (google ? '-google' : '');
}

// Same posture as Mia's own agent profiles (full tools, the shared guarded
// workspace terminal, background review on) except that a personal agent does
// not edit bots, so the instruction-file guard stays on. It reads the same
// toolset lists as Mia; platform_toolsets is deliberately not set.
function provisionHermesPrivateAgentProfile({
  agentId,
  google = false,
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
    profile: privateAgentProfileName(agentId, google),
    toolsets: searchOnly ? SEARCH_ONLY_TOOLSETS : FULL_AGENT_TOOLSETS,
    maxTurns: searchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    terminal: guardedWorkspaceTerminal({ profilesRoot, searchOnly, workspaceDir }),
    googleWorkspace: google === true,
    backgroundReview: backgroundReviewEnabledForGateway(),
    editsBots: false,
  });
}

function provisionHermesRuntimeProfiles(options = {}) {
  // Scheduled jobs run from the Hermes home itself, not from a profile, so a
  // job pinned to the Claude subscription needs the provider there as well.
  provisionBundledPlugin(options.profilesRoot ? path.dirname(options.profilesRoot) : hermesHome(), CLAUDE_SUBSCRIPTION_PLUGIN);
  const agent = provisionHermesAgentProfile(options);
  const googleAgent = provisionHermesGoogleAgentProfile(options);
  const bot = provisionHermesBotProfile(options);
  const googleBot = provisionHermesGoogleBotProfile(options);
  const appsBot = provisionHermesBotProfile({ ...options, google: false, apps: true });
  const googleAppsBot = provisionHermesBotProfile({ ...options, google: true, apps: true });
  return { agent, googleAgent, bot, googleBot, appsBot, googleAppsBot,
    changed: agent.changed || googleAgent.changed || bot.changed || googleBot.changed
      || appsBot.changed || googleAppsBot.changed };
}

module.exports = {
  COMPRESSION_THRESHOLD_TOKENS,
  isManagedProfileConfig,
  isManagedProfileDirectory,
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_APPS_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_APPS_HERMES_PROFILE,
  BOT_HERMES_PROFILES,
  MCP_APP_PROFILES,
  botProfileFor,
  EFFECTIVE_RELEASE_PROFILE,
  MIAOS_RELEASE_PROFILE,
  MIAOS_AGENT_SEARCH_ONLY,
  MIAOS_AGENT_MAX_TURNS,
  FULL_AGENT_TOOLSETS,
  SEARCH_ONLY_TOOLSETS,
  BOT_FULL_TOOLSETS,
  BOT_DISABLED_TOOLSETS,
  botToolsets,
  cronShellGuard,
  GOOGLE_WORKSPACE_MCP_SERVER,
  GOOGLE_WORKSPACE_MCP_TOOLS,
  googleWorkspaceToolsConfigured,
  googleWorkspaceMcpServer,
  CLAUDE_SUBSCRIPTION_PLUGIN,
  CLAUDE_SUBSCRIPTION_PLUGIN_SOURCE,
  SHELL_GUARD,
  backgroundReviewMode,
  backgroundReviewEnabledForGateway,
  backgroundReviewEnabledForBot,
  runtimeProfileConfig,
  setHermesProfileModel,
  GHOST_FIRST_PLUGIN,
  ASK_BEFORE_DO_PLUGIN,
  ASK_BEFORE_DO_TOOLSET,
  PROVIDER_LIMITS_PLUGIN,
  provisionBundledPlugin,
  provisionHermesAgentProfile,
  provisionHermesGoogleAgentProfile,
  provisionHermesBotProfile,
  provisionHermesGoogleBotProfile,
  provisionHermesRuntimeProfiles,
  PRIVATE_AGENT_PROFILE_PATTERN,
  privateAgentProfileName,
  provisionHermesPrivateAgentProfile,
};
